/**
 * The engine marker shown after every model: which engine runs it (Polpo's own loop, an official
 * harness, an official CLI), its mark and a tooltip with the details (engine, runtime, how it
 * authenticates). Agents resolve it from their config (`engine`; absent → Polpo), runs from what
 * the run recorded (`TaskRunContext.engine/auth`), so history shows what actually ran.
 *
 * The tooltip carries kinds, providers, regions, gateway names and account labels only: never a key.
 */
import {
  agentEffectiveModel, agentEngineIdOf, engineKindOf, engineMarkLabel, ENGINE_KIND_LABELS, ENGINE_PRODUCTS, normalizeEngineId,
  type EngineId, type EngineKind,
} from "@polpo-ai/core/engine-label";
import type { BrandName } from "@/lib/brand-icons";
import { AUTH_LABELS, engineBrand } from "@/lib/run-context";

export type { EngineId, EngineKind };
export { agentEffectiveModel, agentEngineIdOf };

/** How the engine authenticates (labels only). */
export interface EngineAuthInfo {
  kind?: string;
  /** The model provider (OpenCode: anthropic, openai, moonshot…). */
  provider?: string;
  region?: string;
  /** A gateway's name (Vercel AI Gateway, LiteLLM…). */
  gateway?: string;
  /** A CLI account's label or id (a personal plan). */
  account?: string;
}

export interface EngineInfo {
  id: EngineId;
  kind: EngineKind;
  /** "Polpo", "Claude Code", "Codex", "OpenCode". */
  product: string;
  /** "Polpo", "Harness", "CLI". */
  typeLabel: string;
  /** "Polpo", "Claude Code Harness", "Codex CLI". */
  label: string;
  brand: BrandName;
  auth?: EngineAuthInfo;
}

export function engineInfo(id: unknown, auth?: EngineAuthInfo): EngineInfo {
  const e = normalizeEngineId(id);
  const kind = engineKindOf(e);
  return {
    id: e, kind, product: ENGINE_PRODUCTS[e], typeLabel: ENGINE_KIND_LABELS[kind], label: engineMarkLabel(e),
    brand: engineBrand(e),
    ...(auth && (auth.kind || auth.account || auth.gateway || auth.provider) ? { auth } : {}),
  };
}

/** An agent's engine (from its config) and the model it runs. */
export function agentEngineInfo(agent: { model?: unknown; engine?: unknown } | undefined): { engine: EngineInfo; model?: string } {
  const id = agentEngineIdOf(agent?.engine);
  const account = id === "claude-cli" || id === "codex-cli" ? (agent?.engine as { account?: unknown } | undefined)?.account : undefined;
  const model = agentEffectiveModel(agent);
  return {
    engine: engineInfo(id, id === "claude-cli" || id === "codex-cli" ? { kind: "subscription", ...(typeof account === "string" && account ? { account } : {}) } : undefined),
    ...(model ? { model } : {}),
  };
}

/** A run's engine and model, as recorded (TaskRunContext or the slim TaskRunSummary). */
export function runEngineInfo(run: { engine?: unknown; model?: string; auth?: { kind?: string; provider?: string; region?: string } }): { engine: EngineInfo; model?: string } {
  const id = normalizeEngineId(run.engine);
  const auth = run.auth ? { ...(run.auth.kind ? { kind: run.auth.kind } : {}), ...(run.auth.provider ? { provider: run.auth.provider } : {}), ...(run.auth.region ? { region: run.auth.region } : {}) }
    : id === "claude-cli" || id === "codex-cli" ? { kind: "subscription" } : undefined;
  return { engine: engineInfo(id, auth), ...(run.model ? { model: run.model } : {}) };
}

const RUNTIMES: Record<EngineKind, (product: string, id: EngineId) => string> = {
  polpo: () => "Polpo's built-in agent loop (any provider)",
  harness: (product) => `${product} in the Vercel AI SDK harness`,
  cli: (_p, id) => `the official \`${id === "codex-cli" ? "codex" : "claude"}\` program`,
};

/** "API key · anthropic", "Bedrock · us-east-1", "personal plan · work account", "model gateway · LiteLLM". */
export function authText(auth: EngineAuthInfo | undefined): string | undefined {
  if (!auth) return undefined;
  const parts = [
    auth.kind ? AUTH_LABELS[auth.kind] ?? auth.kind : undefined,
    auth.gateway, auth.provider && auth.provider !== auth.gateway ? auth.provider : undefined, auth.region, auth.account,
  ].filter((x): x is string => !!x);
  return parts.length ? parts.join(" · ") : undefined;
}

/** The tooltip: model, engine, runtime and authentication, one per line. */
export function engineTooltip(engine: EngineInfo, model?: string): string {
  const auth = authText(engine.auth);
  return [
    model ? `Model: ${model}` : undefined,
    `Engine: ${engine.label}`,
    `Runtime: ${RUNTIMES[engine.kind](engine.product, engine.id)}`,
    auth ? `Auth: ${auth}` : undefined,
  ].filter(Boolean).join("\n");
}
