/**
 * decide(): typed decisions with probabilities, for every surface (REST POST /api/v1/decide, MCP
 * polpo_decide, Polpo's chat, the agents' decide tool, missions' decision nodes, the suites'
 * decision scorer).
 *
 * - With a decision model (settings.decisionModel, or the request's): its gateway is resolved by the
 *   shared gateway resolver (@polpo-ai/core gateways.ts: base URL, the key from the vault entry or
 *   the gateway's env var, the hosts the key may go to) and asked through its Decisions API.
 * - Without one: settings.decisions.unconfigured "error" (default) refuses with a link to Settings;
 *   "orchestrator" lets Polpo's own chat answer through the chat pipeline (no tools, its usage
 *   tracked there), flagged `calibrated: false`.
 *
 * Every call that reaches a model is recorded in the decision log (store.ts) and announced
 * (decision:made); the gateway's usage and cost go to the token usage like other model calls.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  DECISION_LIMITS, DecisionError, GatewayError, buildAnswers, decisionStateText, decisionsRequestBody, describeGatewayKey, expandQuestions,
  fallbackDecisionPrompt, formatDecisionModel, gatewayDefinition, gatewayUrl, gatewaysWith, normalizeDecisionSettings, parseDecisionModel,
  parseDecisionsResponse, parseFallbackDecision, resolveGateway, validateDecideInput,
  type DecisionAnswer, type DecisionModelConfig, type DecisionSettings, type DecisionUsage, type PolpoSettings, type ValidDecideInput, type VaultStore,
} from "@polpo-ai/core";
import { FileDecisionLogStore, type DecisionCaller, type DecisionLogEntry } from "./store.js";

export { DecisionError };

export interface DecideResult {
  /** The decision log entry. */
  id: string;
  answers: DecisionAnswer[];
  model: string;
  gateway?: string;
  usage: DecisionUsage;
  costUsd: number;
  /** false: the uncalibrated fallback (Polpo's chat model) answered, not a decision model. */
  calibrated: boolean;
  latencyMs: number;
  /** Some answer is below its threshold. */
  uncertain: boolean;
}

export interface DecisionStatus {
  configured: boolean;
  /** "gateway:model". */
  model?: string;
  gateway?: { id: string; label: string };
  fallback?: { model: string; confidenceBelow?: number };
  zeroDataRetention?: boolean;
  /** Where the key comes from (never the key): ok, or why it cannot be used. */
  key?: { ok: boolean; source?: "vault" | "env"; detail: string };
  /** A configuration problem (an invalid decisionModel). */
  error?: string;
  unconfigured: "error" | "orchestrator";
  retention: number;
  retentionDays: number;
  storeInputs: "capped" | "hash";
  /** Gateways that offer decisions. */
  gateways: Array<{ id: string; label: string; envVar: string; docsUrl?: string }>;
}

export interface DecisionServiceDeps {
  polpoDir: () => string;
  settings: () => PolpoSettings | undefined;
  vault: () => VaultStore | undefined;
  env?: () => Record<string, string | undefined>;
  fetch?: typeof fetch;
  /**
   * Polpo's own chat, without tools, through the chat pipeline: the uncalibrated fallback. `check`
   * reads an answer (undefined: readable): an unreadable one gets one corrective follow-up turn.
   */
  chatTurn?: (prompt: string, check: (text: string) => string | undefined) => Promise<{ text: string; model?: string; costUsd?: number }>;
  /** The gateway call's usage and cost, recorded like other model usage. */
  recordUsage?: (u: { provider: string; model: string; inputTokens: number; outputTokens: number; cost: number }) => Promise<void>;
  emit?: (payload: { id: string; caller: string; callerId?: string; model: string; calibrated: boolean; uncertain: boolean; costUsd: number; status: "ok" | "error"; error?: string }) => void;
  /** A gateway call's longest wait (default 60 s). */
  timeoutMs?: number;
}

/** Where the dashboard sets the decision model. */
export const DECISION_SETTINGS_PATH = "/config?section=decisions";

const newId = () => `dec_${randomBytes(9).toString("hex")}`;
const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

/** Never let a key leak through an upstream error message. */
function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("[redacted]");
  return out;
}

export class DecisionService {
  readonly store: FileDecisionLogStore;

  constructor(private readonly deps: DecisionServiceDeps) {
    this.store = new FileDecisionLogStore(deps.polpoDir);
  }

  private decisionSettings(): DecisionSettings {
    return normalizeDecisionSettings(this.deps.settings()?.decisions) ?? {};
  }

  /** The configured decision model (throws a 409 DecisionError when settings.decisionModel is invalid). */
  configuredModel(): DecisionModelConfig | undefined {
    try {
      return parseDecisionModel(this.deps.settings()?.decisionModel);
    } catch (err) {
      throw new DecisionError(`settings.decisionModel is invalid: ${(err as Error).message}. Fix it in Settings → Decisions (${DECISION_SETTINGS_PATH}).`, 409, "NOT_CONFIGURED");
    }
  }

  /** What is configured, for Settings and the playground (never a key). */
  async status(): Promise<DecisionStatus> {
    const ds = this.decisionSettings();
    const base = {
      unconfigured: ds.unconfigured ?? "error",
      retention: ds.retention ?? DECISION_LIMITS.defaultRetention,
      retentionDays: ds.retentionDays ?? DECISION_LIMITS.defaultRetentionDays,
      storeInputs: ds.storeInputs ?? "capped",
      gateways: gatewaysWith("decisions").map((g) => ({ id: g.id, label: g.label, envVar: g.envVar, ...(g.docsUrl ? { docsUrl: g.docsUrl } : {}) })),
    } as const;
    let cfg: DecisionModelConfig | undefined;
    try { cfg = parseDecisionModel(this.deps.settings()?.decisionModel); } catch (err) { return { configured: false, error: (err as Error).message, ...base }; }
    if (!cfg) return { configured: false, ...base };
    const def = gatewayDefinition(cfg.gateway);
    let key: DecisionStatus["key"];
    try {
      const g = await resolveGateway(cfg.gateway, cfg, { vault: this.deps.vault(), env: this.deps.env?.(), capability: "decisions" });
      key = { ok: true, source: g.keySource.kind, detail: describeGatewayKey(g.keySource) };
    } catch (err) {
      key = { ok: false, detail: (err as Error).message };
    }
    return {
      configured: true, model: formatDecisionModel(cfg), ...(def ? { gateway: { id: def.id, label: def.label } } : {}),
      ...(cfg.fallback ? { fallback: cfg.fallback } : {}), ...(cfg.zeroDataRetention ? { zeroDataRetention: true } : {}), key, ...base,
    };
  }

  /** Take a decision. Throws DecisionError (400 invalid, 409 not configured, 502 the model, 504 too slow). */
  async decide(input: unknown, caller: DecisionCaller): Promise<DecideResult> {
    const valid = validateDecideInput(input);
    const configured = this.configuredModel();
    // the request's model on the configured gateway uses the configured key
    let model = valid.model;
    if (model && !model.credentialRef && configured?.gateway === model.gateway && configured.credentialRef) {
      model = { ...model, credentialRef: configured.credentialRef, ...(configured.credentialField ? { credentialField: configured.credentialField } : {}) };
    }
    model ??= configured;
    const wire = expandQuestions(valid.questions);
    const stateText = decisionStateText(valid.state);
    const t0 = Date.now();
    const ds = this.decisionSettings();
    const entryBase = {
      id: newId(), at: new Date().toISOString(), caller, questions: valid.questions,
      stateHash: hashOf(stateText), stateChars: stateText.length,
      ...(ds.storeInputs === "hash" ? {} : { state: stateText.slice(0, DECISION_LIMITS.storedStateChars), ...(stateText.length > DECISION_LIMITS.storedStateChars ? { stateTruncated: true } : {}) }),
    };

    if (!model && (ds.unconfigured ?? "error") === "error") {
      throw new DecisionError(
        `No decision model is configured. Set one in Settings → Decisions (${DECISION_SETTINGS_PATH}), e.g. vercel-ai-gateway:typesafe-ai/jev, `
        + "or allow the uncalibrated fallback to Polpo's own model there.", 409, "NOT_CONFIGURED",
      );
    }

    let label = model ? formatDecisionModel(model) : "Polpo";
    try {
      let answers: DecisionAnswer[];
      let usage: DecisionUsage = {};
      let costUsd = 0;
      let calibrated = true;
      let gateway: string | undefined;
      if (model) {
        gateway = model.gateway;
        const r = await this.callGateway(model, valid, wire);
        answers = buildAnswers(valid.questions, wire, r.answers, valid.thresholds);
        usage = r.usage;
        costUsd = r.costUsd ?? 0;
        label = `${model.gateway}:${r.model ?? model.model}`;
        await this.deps.recordUsage?.({
          provider: model.gateway, model: r.model ?? model.model,
          inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, cost: costUsd,
        }).catch(() => undefined);
      } else {
        if (!this.deps.chatTurn) throw new DecisionError("The uncalibrated fallback needs Polpo's chat, which is not available here", 503, "UNAVAILABLE");
        const check = (text: string): string | undefined => { try { parseFallbackDecision(text, wire); return undefined; } catch (err) { return (err as Error).message; } };
        const reply = await this.deps.chatTurn(fallbackDecisionPrompt(valid.state, wire), check);
        let parsed;
        try { parsed = parseFallbackDecision(reply.text, wire); } catch (err) {
          throw new DecisionError(`Polpo's model did not answer the decision in the expected shape: ${(err as Error).message}`, 502, "BAD_ANSWER");
        }
        answers = buildAnswers(valid.questions, wire, parsed, valid.thresholds);
        costUsd = reply.costUsd ?? 0;
        calibrated = false;
        label = reply.model ?? "Polpo";
      }
      const result: DecideResult = {
        id: entryBase.id, answers, model: label, ...(gateway ? { gateway } : {}), usage, costUsd: Math.round(costUsd * 1e8) / 1e8, calibrated,
        latencyMs: Date.now() - t0, uncertain: answers.some((a) => a.uncertain),
      };
      this.record({ ...entryBase, status: "ok", model: label, ...(gateway ? { gateway } : {}), calibrated, latencyMs: result.latencyMs, costUsd: result.costUsd, usage, answers, uncertain: result.uncertain });
      return result;
    } catch (err) {
      const e = err instanceof DecisionError ? err : err instanceof GatewayError
        ? new DecisionError(`${err.message} (Settings → Decisions: ${DECISION_SETTINGS_PATH})`, 409, "NOT_CONFIGURED")
        : new DecisionError(`The decision failed: ${err instanceof Error ? err.message : String(err)}`, 502, "UPSTREAM");
      this.record({ ...entryBase, status: "error", error: e.message, model: label, ...(model ? { gateway: model.gateway } : {}), calibrated: !!model, latencyMs: Date.now() - t0, costUsd: 0, usage: {}, answers: [], uncertain: false });
      throw e;
    }
  }

  private record(entry: DecisionLogEntry): void {
    const ds = this.decisionSettings();
    try {
      this.store.add(entry, { count: ds.retention ?? DECISION_LIMITS.defaultRetention, days: ds.retentionDays ?? DECISION_LIMITS.defaultRetentionDays });
    } catch { /* the log is best-effort: the decision stands */ }
    this.deps.emit?.({
      id: entry.id, caller: entry.caller.kind, ...(entry.caller.id ? { callerId: entry.caller.id } : {}), model: entry.model, calibrated: entry.calibrated,
      uncertain: entry.uncertain, costUsd: entry.costUsd, status: entry.status, ...(entry.error ? { error: entry.error } : {}),
    });
  }

  /** POST {gateway}/decisions with the gateway's key, to its allowed hosts only. */
  private async callGateway(model: DecisionModelConfig, valid: ValidDecideInput, wire: ReturnType<typeof expandQuestions>) {
    const g = await resolveGateway(model.gateway, model, { vault: this.deps.vault(), env: this.deps.env?.(), capability: "decisions" });
    const url = gatewayUrl(g, "decisions");
    const body = decisionsRequestBody(model.model, valid.state, wire, {
      ...(valid.fallback ?? model.fallback ? { fallback: valid.fallback ?? model.fallback } : {}),
      ...(model.zeroDataRetention ? { zeroDataRetention: true } : {}),
    });
    const doFetch = this.deps.fetch ?? fetch;
    const timeoutMs = this.deps.timeoutMs ?? 60_000;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        headers: { ...g.headers, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const timedOut = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
      throw new DecisionError(timedOut ? `${g.label} did not answer within ${Math.round(timeoutMs / 1000)} s` : `${g.label} could not be reached: ${scrub((err as Error).message, [g.key])}`, timedOut ? 504 : 502, "UPSTREAM");
    }
    const raw = await res.text().catch(() => "");
    let json: unknown;
    try { json = raw ? JSON.parse(raw) : undefined; } catch { json = undefined; }
    if (!res.ok) {
      const e = json && typeof json === "object" ? (json as { error?: { message?: string } | string; message?: string }) : undefined;
      const message = typeof e?.error === "string" ? e.error : e?.error?.message ?? e?.message ?? raw.slice(0, 300);
      throw new DecisionError(`${g.label} refused the decision (HTTP ${res.status}): ${scrub(String(message || res.statusText), [g.key]).slice(0, 500)}`, res.status === 429 ? 429 : 502, "UPSTREAM");
    }
    return parseDecisionsResponse(json, wire);
  }
}


// ── The instance's service (the agents' decide tool reaches it by .polpo directory) ──

const services = new Map<string, DecisionService>();

export function registerDecisionService(polpoDir: string, service: DecisionService): void {
  services.set(polpoDir, service);
}

export function decisionServiceFor(polpoDir: string): DecisionService | undefined {
  return services.get(polpoDir);
}
