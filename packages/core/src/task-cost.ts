/**
 * What a task cost: the sum of every recorded run of it (Task.runs: the first run, retries,
 * continuations, the runs a direction or "continue" started), in USD and tokens, by engine, with
 * each run's own cost — the same numbers a mission's cost adds up (mission-cost.ts builds on it).
 *
 * A run's cost is the harness runtime's own estimate (`harnessUsd`, Claude Code / Codex) or the
 * model cost the provider reports (`modelUsd`, Polpo's engine). A task keeps at most
 * MAX_TASK_RUNS runs: when it has that many, older ones may have been dropped. Its harness cost
 * then comes back from the token-usage records (`agent_harness`, the task id as session; they are
 * not capped) when the caller passes them (`harnessUsage`); a task that also ran on Polpo's engine
 * stays partial (`partial: true`): its total may be higher than shown.
 *
 * Pure (type-only imports apart from MAX_TASK_RUNS): the dashboard imports it too.
 */
import { MAX_TASK_RUNS, type RunContextStatus, type RunCostContext, type RunEngine, type TaskRunContext } from "./run-context.js";

/** USD, split by source, tokens and runs. */
export interface CostBucket {
  /** USD: the harness estimate plus the model cost. */
  usd: number;
  /** The harness runtimes' own estimate (Claude Code, Codex), USD. */
  harnessUsd: number;
  /** The model cost the provider reported (Polpo's engine), USD. */
  modelUsd: number;
  tokens: number;
  runs: number;
}

/** One run in a task's cost breakdown (oldest first, like Task.runs). */
export interface TaskCostRun {
  runId: string;
  startedAt: string;
  endedAt?: string;
  status: RunContextStatus;
  continuation?: boolean;
  agent?: string;
  engine: RunEngine;
  model?: string;
  durationMs?: number;
  /** USD (harness estimate plus model cost); absent when the run recorded none (yet). */
  usd?: number;
  tokens?: number;
  costSource?: RunCostContext["costSource"];
}

export interface TaskCost extends CostBucket {
  currency: "USD";
  /** Runs that recorded no cost (yet: a run starting, or an engine that reports none). */
  unpricedRuns: number;
  runsActive: number;
  byEngine: Array<CostBucket & { engine: RunEngine }>;
  /** Every recorded run with its cost, oldest first. */
  perRun: TaskCostRun[];
  /** The latest run's cost, USD (absent when it recorded none). */
  lastRunUsd?: number;
  /** Older runs were dropped (MAX_TASK_RUNS) and not recovered: the total may be higher. */
  partial: boolean;
  /** Harness cost taken from token-usage records for runs that were dropped, USD. */
  recoveredUsd?: number;
  /** Where the recovered cost is counted (the latest harness run's agent and engine). */
  recovered?: { usd: number; tokens: number; agent: string; engine: RunEngine };
}

/** A compact view for lists (`GET /tasks?slim=true` → `cost`). */
export interface TaskCostSummary {
  usd: number;
  tokens: number;
  runs: number;
  partial?: boolean;
}

export interface TaskCostOptions {
  /** The task's harness cost and tokens from token-usage records (`agent_harness`): used only when runs may have been dropped. */
  harnessUsage?: { usd: number; tokens: number };
}

/** A run's cost in USD (the harness estimate plus the model cost), undefined when none recorded. */
export function runUsd(run: Pick<TaskRunContext, "cost">): number | undefined {
  const h = run.cost?.harnessUsd;
  const m = run.cost?.modelUsd;
  const hOk = Number.isFinite(h);
  const mOk = Number.isFinite(m);
  if (!hOk && !mOk) return undefined;
  return (hOk ? h! : 0) + (mOk ? m! : 0);
}

export const emptyCostBucket = (): CostBucket => ({ usd: 0, harnessUsd: 0, modelUsd: 0, tokens: 0, runs: 0 });

export function addToCostBucket(b: CostBucket, harness: number, model: number, tokens: number, runs: number): void {
  b.harnessUsd += harness;
  b.modelUsd += model;
  b.usd += harness + model;
  b.tokens += tokens;
  b.runs += runs;
}

export const roundUsd = (v: number) => Math.round(v * 1e6) / 1e6;
export function roundedBucket<T extends CostBucket>(b: T): T {
  return { ...b, usd: roundUsd(b.usd), harnessUsd: roundUsd(b.harnessUsd), modelUsd: roundUsd(b.modelUsd) };
}

const fin = (v: number | undefined) => (Number.isFinite(v) ? v! : 0);

/** What the cost reads of a run (Task.runs entries; the SDK's TaskRunContext fits too). */
export type CostRun = Pick<TaskRunContext, "runId" | "startedAt" | "endedAt" | "status" | "continuation" | "agent" | "engine" | "model" | "durationMs" | "cost">;

/** The task's cost from its recorded runs (see the file comment). */
export function computeTaskCost(task: { assignTo?: string; runs?: CostRun[] }, opts: TaskCostOptions = {}): TaskCost {
  const runs = task.runs ?? [];
  const total = emptyCostBucket();
  const byEngine = new Map<RunEngine, CostBucket>();
  const engineBucket = (e: RunEngine) => {
    let b = byEngine.get(e);
    if (!b) { b = emptyCostBucket(); byEngine.set(e, b); }
    return b;
  };
  let unpricedRuns = 0;
  let runsActive = 0;
  let harness = 0;
  let harnessTokens = 0;
  let lastHarness: CostRun | undefined;
  const perRun: TaskCostRun[] = [];

  for (const run of runs) {
    const h = fin(run.cost?.harnessUsd);
    const m = fin(run.cost?.modelUsd);
    const tokens = fin(run.cost?.tokens);
    const usd = runUsd(run);
    if (usd === undefined) unpricedRuns++;
    if (run.status === "running") runsActive++;
    const engine = run.engine ?? "polpo";
    addToCostBucket(total, h, m, tokens, 1);
    addToCostBucket(engineBucket(engine), h, m, tokens, 1);
    if (engine !== "polpo") {
      harness += h;
      harnessTokens += tokens;
      lastHarness = run;
    }
    perRun.push({
      runId: run.runId, startedAt: run.startedAt, status: run.status, engine,
      ...(run.endedAt ? { endedAt: run.endedAt } : {}),
      ...(run.continuation ? { continuation: true } : {}),
      ...(run.agent ?? task.assignTo ? { agent: run.agent ?? task.assignTo } : {}),
      ...(run.model ? { model: run.model } : {}),
      ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
      ...(usd !== undefined ? { usd: roundUsd(usd) } : {}),
      ...(run.cost?.tokens !== undefined && Number.isFinite(run.cost.tokens) ? { tokens: run.cost.tokens } : {}),
      ...(run.cost?.costSource ? { costSource: run.cost.costSource } : {}),
    });
  }

  let partial = false;
  let recovered: TaskCost["recovered"];
  if (runs.length >= MAX_TASK_RUNS) {
    // older runs may have been dropped: the harness part can come back from the usage records
    const usage = opts.harnessUsage;
    const allHarness = runs.every((r) => r.engine && r.engine !== "polpo");
    if (usage && lastHarness && usage.usd > harness) {
      const extraUsd = usage.usd - harness;
      const extraTokens = Math.max(0, usage.tokens - harnessTokens);
      recovered = { usd: roundUsd(extraUsd), tokens: extraTokens, agent: lastHarness.agent ?? task.assignTo ?? "unassigned", engine: lastHarness.engine };
      addToCostBucket(total, extraUsd, 0, extraTokens, 0);
      addToCostBucket(engineBucket(lastHarness.engine), extraUsd, 0, extraTokens, 0);
      partial = !allHarness;
    } else {
      // with usage records and only harness runs, nothing was lost
      partial = !(usage && allHarness);
    }
  }

  const last = perRun.at(-1);
  return {
    currency: "USD",
    ...roundedBucket(total),
    unpricedRuns,
    runsActive,
    byEngine: [...byEngine].map(([engine, b]) => ({ engine, ...roundedBucket(b) })).sort((a, b) => b.usd - a.usd || b.runs - a.runs),
    perRun,
    ...(last?.usd !== undefined ? { lastRunUsd: last.usd } : {}),
    partial,
    ...(recovered ? { recoveredUsd: recovered.usd, recovered } : {}),
  };
}

export function summarizeTaskCost(cost: TaskCost): TaskCostSummary {
  return { usd: cost.usd, tokens: cost.tokens, runs: cost.runs, ...(cost.partial ? { partial: true } : {}) };
}

/** A task's harness cost per task id from token-usage records (`agent_harness`, the task id as session). */
export function harnessUsageByTask(
  records: Iterable<{ source?: string; sessionId?: string; cost?: number; totalTokens?: number }>,
  taskIds: Iterable<string>,
): Record<string, { usd: number; tokens: number }> {
  const ids = new Set(taskIds);
  const out: Record<string, { usd: number; tokens: number }> = {};
  for (const r of records) {
    if (r.source !== "agent_harness" || !r.sessionId || !ids.has(r.sessionId)) continue;
    const u = (out[r.sessionId] ??= { usd: 0, tokens: 0 });
    u.usd += fin(r.cost);
    u.tokens += fin(r.totalTokens);
  }
  return out;
}

/** The task may have lost runs (it holds MAX_TASK_RUNS): usage records can fill its harness cost in. */
export function taskMayHaveDroppedRuns(task: { runs?: unknown[] }): boolean {
  return (task.runs?.length ?? 0) >= MAX_TASK_RUNS;
}

const ENGINE_NAMES: Record<string, string> = { polpo: "Polpo", "claude-code": "Claude Code", codex: "Codex" };
export const usdText = (v: number) => (v === 0 ? "$0" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
export const engineName = (e: string) => ENGINE_NAMES[e] ?? e;

/** The task's cost in a few lines, for text outputs (MCP, Polpo's tools). */
export function describeTaskCost(cost: TaskCost, opts: { perRun?: boolean } = {}): string {
  if (!cost.runs) return "cost: not run yet";
  const head = `cost: ${usdText(cost.usd)}${cost.partial ? " (partial: older runs dropped)" : ""} in all`
    + ` · ${cost.runs} run${cost.runs === 1 ? "" : "s"}`
    + (cost.runs > 1 && cost.lastRunUsd !== undefined ? ` · latest ${usdText(cost.lastRunUsd)}` : "")
    + ` · ${cost.tokens.toLocaleString("en-US")} tokens`
    + (cost.recoveredUsd ? ` (${usdText(cost.recoveredUsd)} of dropped runs from usage records)` : "");
  const lines = [head];
  if (cost.byEngine.length > 1) lines.push(`by engine: ${cost.byEngine.map((e) => `${engineName(e.engine)} ${usdText(e.usd)} (${e.runs})`).join(", ")}`);
  if (opts.perRun && cost.perRun.length > 1) {
    lines.push("per run (oldest first):", ...cost.perRun.map((r, i) =>
      `  ${i + 1}. ${r.runId} [${r.status}]${r.continuation ? " continuation" : ""} ${engineName(r.engine)}${r.model ? ` ${r.model}` : ""}`
      + ` · ${r.usd !== undefined ? usdText(r.usd) : "no cost recorded"}${r.tokens ? ` · ${r.tokens.toLocaleString("en-US")} tokens` : ""}`
      + `${r.durationMs !== undefined ? ` · ${Math.round(r.durationMs / 1000)} s` : ""}`));
  }
  return lines.join("\n");
}
