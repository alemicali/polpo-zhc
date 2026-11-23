/**
 * A task run as the MCP cards show it (task, mission and agent cards): the engine and its mark,
 * a readable model, how the harness authenticated, the computer, the egress, the session and the
 * cost. The same labels as the dashboard (ui/src/lib/run-context.ts).
 *
 * Pure, and type-only imports: the widgets (widgets/*) bundle it for the browser.
 */
import type { TaskRunContext } from "@polpo-ai/core/run-context";

/** The marks the widgets draw (widgets/shared/brand.ts). */
export type BrandMark =
  | "polpo" | "claude-code" | "codex" | "opencode" | "anthropic" | "openai" | "bedrock" | "vertex" | "api-key"
  | "daytona" | "e2b" | "host" | "ephemeral" | "tailscale";

export interface RunView {
  runId: string;
  status: TaskRunContext["status"];
  startedAt: string;
  endedAt?: string;
  continuation?: boolean;
  agent?: string;
  engine: TaskRunContext["engine"];
  /** "Claude Code", "Codex", "OpenCode", "Polpo". */
  engineLabel: string;
  engineMark: BrandMark;
  model?: string;
  /** "Sonnet 4.5", "gpt-5-codex". */
  modelLabel?: string;
  /** How the harness authenticated (the kind only, never a secret). */
  auth?: { kind: string; label: string; mark: BrandMark; region?: string; provider?: string };
  computer: { id: string; name?: string; label: string; kindLabel: string; mark: BrandMark; remoteId?: string };
  egress: { mode: "direct" | "proxy"; label: string; tailscale?: boolean };
  session?: { resumed: boolean; bootstrapMs?: number };
  /** USD: the harness estimate, else the model cost. */
  costUsd?: number;
  tokens?: number;
  budgetUsd?: number;
  durationMs?: number;
}

export const ENGINE_LABELS: Record<string, string> = { polpo: "Polpo", "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode" };
const AUTH_LABELS: Record<string, string> = { bedrock: "Bedrock", vertex: "Vertex AI", "api-key": "API key", "ai-gateway": "Vercel AI Gateway", gateway: "model gateway" };
const isHarness = (x: unknown): x is "claude-code" | "codex" | "opencode" => x === "claude-code" || x === "codex" || x === "opencode";

export function engineMark(engine: string | undefined): BrandMark {
  return isHarness(engine) ? engine : "polpo";
}

/** The engine of an agent's config ("polpo" or { harness }). */
export function agentEngine(engine: unknown): { id: TaskRunContext["engine"]; model?: string } {
  if (isHarness(engine)) return { id: engine };
  if (engine && typeof engine === "object") {
    const e = engine as { harness?: unknown; model?: unknown };
    if (isHarness(e.harness)) return { id: e.harness, ...(typeof e.model === "string" && e.model ? { model: e.model } : {}) };
  }
  return { id: "polpo" };
}

/** "us.anthropic.claude-haiku-4-5-20251001-v1:0" → "Haiku 4.5"; "anthropic:claude-sonnet-4-5" → "Sonnet 4.5". */
export function modelLabel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const m = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:[-.](\d{1,2}))?(?![\d])/i.exec(model)
    ?? /claude-(\d+)(?:[-.](\d{1,2}))?-(opus|sonnet|haiku)/i.exec(model);
  if (m) {
    const [family, major, minor] = /^\d/.test(m[1]!) ? [m[3]!, m[1]!, m[2]] : [m[1]!, m[2]!, m[3]];
    return `${family[0]!.toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? `.${minor}` : ""}`;
  }
  return model.includes(":") && !/^[a-z]+\.anthropic\./.test(model) ? model.slice(model.indexOf(":") + 1) : model;
}

export function authMark(kind: string | undefined, engine?: string, provider?: string): BrandMark {
  if (kind === "bedrock") return "bedrock";
  if (kind === "vertex") return "vertex";
  if (engine === "opencode") return kind === "api-key" && provider === "anthropic" ? "anthropic" : kind === "api-key" && provider === "openai" ? "openai" : "api-key";
  if (kind === "ai-gateway" || kind === "gateway") return "api-key";
  return engine === "codex" ? "openai" : engine === "claude-code" ? "anthropic" : "api-key";
}

type ComputerLike = { id?: string; name?: string; kind?: string; provider?: string; daytonaApi?: string };

export function computerMark(c: ComputerLike | undefined): BrandMark {
  const p = c?.provider ?? (c?.kind === "daytona" || c?.kind === "e2b" ? c.kind : undefined);
  if (p === "daytona") return "daytona";
  if (p === "e2b") return "e2b";
  return c?.kind === "ephemeral" ? "ephemeral" : "host";
}

/** "Daytona v2", "E2B", "Host", "Ephemeral · Daytona". */
export function computerKindLabel(c: ComputerLike | undefined): string {
  if (!c) return "Host";
  const provider = c.provider === "daytona" || c.kind === "daytona"
    ? `Daytona${c.daytonaApi ? ` ${c.daytonaApi}` : ""}`
    : c.provider === "e2b" || c.kind === "e2b" ? "E2B" : undefined;
  if (c.kind === "ephemeral") return provider ? `Ephemeral · ${provider}` : "Ephemeral";
  return provider ?? "Host";
}

/** "this server", the computer's name or id, "ephemeral sandbox". */
export function computerLabel(c: ComputerLike | undefined): string {
  if (!c || (c.kind === "host" && (c.id ?? "host") === "host")) return "this server";
  if (c.kind === "ephemeral") return "ephemeral sandbox";
  return c.name ?? c.id ?? "computer";
}

export function formatUsd(v: number | undefined): string | undefined {
  if (v === undefined || !Number.isFinite(v)) return undefined;
  return v === 0 ? "$0" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

export function formatMs(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

/** A run's cost in USD (the harness estimate plus the model cost), undefined when none was recorded. */
export function runCostUsd(run: Pick<TaskRunContext, "cost">): number | undefined {
  const h = run.cost?.harnessUsd;
  const m = run.cost?.modelUsd;
  if (h === undefined && m === undefined) return undefined;
  return (Number.isFinite(h) ? h! : 0) + (Number.isFinite(m) ? m! : 0);
}

export function runView(run: TaskRunContext): RunView {
  const cost = runCostUsd(run);
  const label = modelLabel(run.model);
  return {
    runId: run.runId,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    ...(run.continuation ? { continuation: true } : {}),
    ...(run.agent ? { agent: run.agent } : {}),
    engine: run.engine,
    engineLabel: ENGINE_LABELS[run.engine] ?? run.engine,
    engineMark: engineMark(run.engine),
    ...(run.model ? { model: run.model } : {}),
    ...(label ? { modelLabel: label } : {}),
    ...(run.auth ? {
      auth: {
        kind: run.auth.kind, label: `${AUTH_LABELS[run.auth.kind] ?? run.auth.kind}${run.auth.provider && run.auth.kind === "api-key" ? ` (${run.auth.provider})` : ""}`,
        mark: authMark(run.auth.kind, run.engine, run.auth.provider), ...(run.auth.region ? { region: run.auth.region } : {}), ...(run.auth.provider ? { provider: run.auth.provider } : {}),
      },
    } : {}),
    computer: {
      id: run.computer.id,
      ...(run.computer.name ? { name: run.computer.name } : {}),
      label: computerLabel(run.computer),
      kindLabel: computerKindLabel(run.computer),
      mark: computerMark(run.computer),
      ...(run.computer.remoteId ? { remoteId: run.computer.remoteId } : {}),
    },
    egress: run.egress.mode === "proxy"
      ? { mode: "proxy", label: run.egress.proxy ?? "proxy", ...(run.egress.tailscale ? { tailscale: true } : {}) }
      : { mode: "direct", label: "direct" },
    ...(run.session ? { session: { resumed: run.session.resumed, ...(run.session.bootstrapMs !== undefined ? { bootstrapMs: run.session.bootstrapMs } : {}) } } : {}),
    ...(cost !== undefined ? { costUsd: cost } : {}),
    ...(run.cost?.tokens !== undefined ? { tokens: run.cost.tokens } : {}),
    ...(run.budgetUsd !== undefined ? { budgetUsd: run.budgetUsd } : {}),
    ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
  };
}

/** "Claude Code · Sonnet 4.5 via Bedrock · on gpu-box (Daytona v2) · $0.42" */
export function runViewLine(r: RunView): string {
  const cost = formatUsd(r.costUsd);
  return [
    `${r.engineLabel}${r.modelLabel ? ` · ${r.modelLabel}` : ""}${r.auth ? ` via ${r.auth.label}` : ""}`,
    `on ${r.computer.label}${r.computer.kindLabel !== "Host" ? ` (${r.computer.kindLabel})` : ""}`,
    cost ? `${cost}${r.budgetUsd ? ` of $${r.budgetUsd}` : ""}` : "",
  ].filter(Boolean).join(" · ");
}
