/**
 * Where and with what a task run executed: its engine (Polpo's own or an agent harness), the model,
 * the harness authentication (its kind only, never a secret), the computer or sandbox, the browser
 * egress, the harness session (new or resumed, bootstrap time), cost and budget.
 *
 * The orchestrator records the part it knows when it spawns the run (`buildRunContext`) on the
 * task (`Task.runs`, newest last); the engine reports the rest while it runs
 * (`AgentActivity.runContext`), and the orchestrator merges it into the same entry
 * (`mergeRunContext`) and closes the entry when the run ends (`finishRunContext`).
 */
// Type-only imports: computers.ts and sandbox.ts import each other, and a value import from here
// (loaded early by the index) would change their evaluation order.
import type { AgentHarnessEngine, HarnessId } from "./harnesses.js";
import type { ComputerConfig, ComputerKind } from "./computers.js";
import type { SandboxProviderId } from "./sandbox.js";
import type { TaskToolScope } from "./task-tool-scope.js";

export type RunEngine = "polpo" | HarnessId;
export type RunContextStatus = "running" | "completed" | "failed" | "killed";
/** How the harness authenticates (the kind only). */
export type RunAuthKind = "api-key" | "bedrock" | "vertex";

export interface RunComputerContext {
  /** "host" (this server), a computer id, or "ephemeral" (a sandbox made for this run). */
  id: string;
  name?: string;
  kind: ComputerKind | "ephemeral";
  /** Remote kinds: the provider service (Daytona v0 / v2, E2B). */
  provider?: "daytona" | "e2b";
  daytonaApi?: "v0" | "v2";
  /** The provider's machine id (sandbox / VM id), when known. */
  remoteId?: string;
}

export interface RunEgressContext {
  /** "direct": the run's own network; "proxy": the browser goes out through an egress proxy. */
  mode: "direct" | "proxy";
  /** The egress proxy's name (settings.egressProxies). */
  proxy?: string;
  /** The proxy is reached through Tailscale (a remote computer's VM, or a tailnet address). */
  tailscale?: boolean;
}

export interface RunSessionContext {
  /** The harness conversation was resumed (a continuation) instead of started fresh. */
  resumed: boolean;
  /** Time to create (or resume) the harness session, bootstrap included. */
  bootstrapMs?: number;
  sessionId?: string;
}

export interface RunCostContext {
  /** The harness runtime's own spend estimate (Claude Code), USD. */
  harnessUsd?: number;
  /** The model cost reported by the provider (Polpo's engine), USD. */
  modelUsd?: number;
  tokens?: number;
}

/** What the engine reports while the run goes (AgentActivity.runContext). */
export interface RunContextRuntime {
  model?: string;
  remoteId?: string;
  session?: RunSessionContext;
  cost?: RunCostContext;
}

export interface TaskRunContext {
  runId: string;
  startedAt: string;
  endedAt?: string;
  status: RunContextStatus;
  /** The run continues the previous one (a "continue" direction). */
  continuation?: boolean;
  /** The agent that ran it (the task's assignee at the time; reassignments change it). */
  agent?: string;
  engine: RunEngine;
  /** Model id (the agent's for Polpo's engine; the harness model for a harness). */
  model?: string;
  auth?: { kind: RunAuthKind; region?: string };
  permissionMode?: string;
  effort?: string;
  computer: RunComputerContext;
  /** The sandbox provider the run used (local, bwrap, docker, daytona, e2b). */
  sandbox?: { provider: SandboxProviderId | string; ephemeral: boolean; fallbackFrom?: string };
  egress: RunEgressContext;
  session?: RunSessionContext;
  cost?: RunCostContext;
  /** The harness budget (maxBudgetUsd). */
  budgetUsd?: number;
  durationMs?: number;
  exitCode?: number;
  /** The task's tool scope this run had (absent: everything its agent has). */
  toolScope?: TaskToolScope;
}

/** Runs kept on a task (newest last). */
export const MAX_TASK_RUNS = 20;

const TAILNET_HOST = /^(?:100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|[^/:]+\.ts\.net)$/i;

function proxyOnTailnet(url: string | undefined): boolean {
  if (!url) return false;
  try { return TAILNET_HOST.test(new URL(url).hostname); } catch { return false; }
}

export interface BuildRunContextInput {
  runId: string;
  startedAt?: string;
  agent: { name: string; model?: string; engine?: unknown };
  settings?: { harnesses?: unknown; sandbox?: unknown; egressProxies?: Record<string, string> } | undefined;
  sandbox?: { provider: SandboxProviderId | string; computer?: Pick<ComputerConfig, "id" | "name" | "kind">; fallback?: { from: string } };
  browserEgress?: { name: string; url: string; tailnet?: unknown };
  continuation?: boolean;
  /** The task's tool scope (Task.toolScope), recorded as the run had it. */
  toolScope?: TaskToolScope;
}

/** The agent's harness engine (lenient: the engine was validated when the agent was saved). */
function harnessOf(engine: unknown): AgentHarnessEngine | undefined {
  if (engine === "claude-code" || engine === "codex") return { harness: engine };
  if (!engine || typeof engine !== "object") return undefined;
  const e = engine as Record<string, unknown>;
  if (e.harness !== "claude-code" && e.harness !== "codex") return undefined;
  return {
    harness: e.harness,
    ...(typeof e.model === "string" && e.model ? { model: e.model } : {}),
    ...(typeof e.permissionMode === "string" ? { permissionMode: e.permissionMode as AgentHarnessEngine["permissionMode"] } : {}),
    ...(typeof e.effort === "string" ? { effort: e.effort as AgentHarnessEngine["effort"] } : {}),
    ...(typeof e.maxBudgetUsd === "number" && e.maxBudgetUsd > 0 ? { maxBudgetUsd: e.maxBudgetUsd } : {}),
  };
}

/** The harness setting's authentication kind, region and default model (never the credential). */
function harnessSetting(settings: BuildRunContextInput["settings"], harness: HarnessId): { auth?: RunAuthKind; region?: string; model?: string } | undefined {
  const all = settings?.harnesses;
  if (!all || typeof all !== "object") return undefined;
  const h = (all as Record<string, unknown>)[harness];
  if (!h || typeof h !== "object") return undefined;
  const r = h as { auth?: unknown; model?: unknown; bedrock?: { region?: unknown }; vertex?: { region?: unknown } };
  const auth = r.auth === "api-key" || r.auth === "bedrock" || r.auth === "vertex" ? r.auth : undefined;
  const region = auth === "bedrock" ? r.bedrock?.region : auth === "vertex" ? r.vertex?.region : undefined;
  return {
    ...(auth ? { auth } : {}),
    ...(typeof region === "string" && region ? { region } : {}),
    ...(typeof r.model === "string" && r.model ? { model: r.model } : {}),
  };
}

function daytonaApi(settings: BuildRunContextInput["settings"]): "v0" | "v2" {
  const d = (settings?.sandbox as { providers?: { daytona?: { api?: unknown } } } | undefined)?.providers?.daytona;
  return d?.api === "v2" ? "v2" : "v0";
}

/** The context the orchestrator knows when it spawns a run (no secrets). */
export function buildRunContext(i: BuildRunContextInput): TaskRunContext {
  const harness = harnessOf(i.agent.engine);
  const provider = i.sandbox?.provider ?? "local";
  const c = i.sandbox?.computer;
  const remote = provider === "daytona" || provider === "e2b";
  const computer: RunComputerContext = c
    ? { id: c.id, ...(c.name ? { name: c.name } : {}), kind: c.kind }
    : remote ? { id: "ephemeral", kind: "ephemeral" } : { id: "host", kind: "host" };
  if (remote) {
    computer.provider = provider as "daytona" | "e2b";
    if (provider === "daytona") computer.daytonaApi = daytonaApi(i.settings);
  }
  const egress: RunEgressContext = i.browserEgress
    ? { mode: "proxy", proxy: i.browserEgress.name, ...(i.browserEgress.tailnet || proxyOnTailnet(i.browserEgress.url) ? { tailscale: true } : {}) }
    : { mode: "direct" };
  const ctx: TaskRunContext = {
    runId: i.runId,
    startedAt: i.startedAt ?? new Date().toISOString(),
    status: "running",
    ...(i.continuation ? { continuation: true } : {}),
    agent: i.agent.name,
    engine: harness ? harness.harness : "polpo",
    computer,
    sandbox: { provider, ephemeral: !c && remote, ...(i.sandbox?.fallback ? { fallbackFrom: i.sandbox.fallback.from } : {}) },
    egress,
    ...(i.toolScope ? { toolScope: i.toolScope } : {}),
  };
  if (harness) {
    const h = harnessSetting(i.settings, harness.harness);
    const model = harness.model ?? h?.model;
    if (model) ctx.model = model;
    if (h?.auth) ctx.auth = { kind: h.auth, ...(h.region ? { region: h.region } : {}) };
    ctx.permissionMode = harness.permissionMode ?? "allow-all";
    if (harness.effort) ctx.effort = harness.effort;
    if (harness.maxBudgetUsd) ctx.budgetUsd = harness.maxBudgetUsd;
  } else if (i.agent.model) {
    ctx.model = i.agent.model;
  }
  return ctx;
}

/** The entry with what the engine reported (later values win; the start fields stay). */
export function mergeRunContext(ctx: TaskRunContext, rt: RunContextRuntime | undefined): TaskRunContext {
  if (!rt) return ctx;
  return {
    ...ctx,
    ...(rt.model ? { model: rt.model } : {}),
    ...(rt.remoteId ? { computer: { ...ctx.computer, remoteId: rt.remoteId } } : {}),
    ...(rt.session ? { session: { ...ctx.session, ...rt.session } } : {}),
    ...(rt.cost ? { cost: { ...ctx.cost, ...rt.cost } } : {}),
  };
}

/** The entry closed with the run's end. */
export function finishRunContext(
  ctx: TaskRunContext,
  end: { status: Exclude<RunContextStatus, "running">; endedAt?: string; exitCode?: number; durationMs?: number },
  rt?: RunContextRuntime,
): TaskRunContext {
  const merged = mergeRunContext(ctx, rt);
  const endedAt = end.endedAt ?? new Date().toISOString();
  const duration = end.durationMs ?? Math.max(0, Date.parse(endedAt) - Date.parse(ctx.startedAt));
  return {
    ...merged,
    status: end.status,
    endedAt,
    ...(Number.isFinite(duration) ? { durationMs: duration } : {}),
    ...(end.exitCode !== undefined ? { exitCode: end.exitCode } : {}),
  };
}

/** The task's runs with `ctx` added or replaced (by runId), newest last, at most MAX_TASK_RUNS. */
export function upsertTaskRun(runs: TaskRunContext[] | undefined, ctx: TaskRunContext, max = MAX_TASK_RUNS): TaskRunContext[] {
  const list = (runs ?? []).filter((r) => r.runId !== ctx.runId);
  const at = (runs ?? []).findIndex((r) => r.runId === ctx.runId);
  if (at >= 0) list.splice(Math.min(at, list.length), 0, ctx);
  else list.push(ctx);
  return list.slice(-max);
}

/** A compact view of a run for lists (badges). */
export interface TaskRunSummary {
  engine: RunEngine;
  model?: string;
  computerId: string;
  computerName?: string;
  computerKind: RunComputerContext["kind"];
  provider?: string;
  status: RunContextStatus;
}

export function summarizeTaskRun(ctx: TaskRunContext | undefined): TaskRunSummary | undefined {
  if (!ctx) return undefined;
  return {
    engine: ctx.engine,
    ...(ctx.model ? { model: ctx.model } : {}),
    computerId: ctx.computer.id,
    ...(ctx.computer.name ? { computerName: ctx.computer.name } : {}),
    computerKind: ctx.computer.kind,
    ...(ctx.computer.provider ? { provider: ctx.computer.provider } : {}),
    status: ctx.status,
  };
}

function describeScopeShort(scope: TaskToolScope): string {
  const parts: string[] = [];
  if (scope.connectors === "none") parts.push("no connectors");
  else if (Array.isArray(scope.connectors)) parts.push(`connectors ${scope.connectors.join(", ")}`);
  const picked = Object.entries(scope.connectorTools ?? {}).filter(([, t]) => Array.isArray(t));
  if (picked.length) parts.push(picked.map(([id, t]) => `${id}: ${(t as string[]).length}`).join(", "));
  if (scope.allowedTools) parts.push(`built-in ${scope.allowedTools.join(", ") || "none"}`);
  return `restricted (${parts.join("; ")})`;
}

/** One line describing a run, for text outputs (MCP). */
export function describeTaskRun(ctx: TaskRunContext): string {
  const engine = ctx.engine === "polpo" ? "Polpo" : ctx.engine === "claude-code" ? "Claude Code" : "Codex";
  const auth = ctx.auth ? ` via ${ctx.auth.kind === "bedrock" ? "Bedrock" : ctx.auth.kind === "vertex" ? "Vertex" : "API key"}${ctx.auth.region ? ` (${ctx.auth.region})` : ""}` : "";
  const where = ctx.computer.kind === "host" && ctx.computer.id === "host"
    ? "this server"
    : ctx.computer.kind === "ephemeral"
      ? `an ephemeral ${ctx.sandbox?.provider ?? "sandbox"} sandbox`
      : `computer ${ctx.computer.id} (${ctx.computer.kind}${ctx.computer.daytonaApi ? ` ${ctx.computer.daytonaApi}` : ""})`;
  const egress = ctx.egress.mode === "proxy" ? `egress ${ctx.egress.proxy}${ctx.egress.tailscale ? " via Tailscale" : ""}` : "egress direct";
  const session = ctx.session ? `${ctx.session.resumed ? "resumed" : "new"} session${ctx.session.bootstrapMs !== undefined ? ` (${(ctx.session.bootstrapMs / 1000).toFixed(1)} s)` : ""}` : "";
  const usd = ctx.cost?.harnessUsd ?? ctx.cost?.modelUsd;
  const cost = usd !== undefined ? `$${usd.toFixed(4)}${ctx.budgetUsd ? ` of $${ctx.budgetUsd}` : ""}` : ctx.budgetUsd ? `budget $${ctx.budgetUsd}` : "";
  return [
    `${ctx.runId} [${ctx.status}]${ctx.continuation ? " continuation" : ""} ${engine}${ctx.model ? ` ${ctx.model}` : ""}${auth}`,
    `on ${where}`, egress, session, cost,
    ctx.toolScope ? `tools ${describeScopeShort(ctx.toolScope)}` : "",
    ctx.durationMs !== undefined ? `${Math.round(ctx.durationMs / 1000)} s` : "",
  ].filter(Boolean).join(" · ");
}
