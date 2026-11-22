/**
 * What a mission cost: the sum of every recorded run of every task of the mission (retries and
 * continuations included), in USD and tokens, by agent and by engine, and against the mission's
 * optional budget (Mission.budgetUsd).
 *
 * The source is Task.runs (run-context.ts): every run, on Polpo's engine or on an agent harness,
 * records its cost there — the harness runtime's own estimate (`harnessUsd`, Claude Code / Codex)
 * or the model cost the provider reports (`modelUsd`, Polpo's engine). It is in every store and
 * cheap to read, and the orchestrator enforces the budget from it on every tick.
 *
 * Token-usage records (GET /token-usage) carry no mission id, and only harness runs write them
 * (`agent_harness`, the task id as their session): they repeat, turn by turn, what Task.runs
 * already holds, so adding them would count twice. They are used for one thing: a task keeps at
 * most MAX_TASK_RUNS runs, and when older ones were dropped the task's harness cost is taken from
 * its usage records (uncapped) instead — `harnessUsage` below. A task that also ran on Polpo's
 * engine and lost runs stays partial (`partial: true`): its total may be higher than shown.
 */
import { MAX_TASK_RUNS, type RunEngine, type TaskRunContext } from "./run-context.js";
import type { Task } from "./types.js";

export interface MissionCostBucket {
  /** USD: the harness estimate plus the model cost. */
  usd: number;
  /** The harness runtimes' own estimate (Claude Code, Codex), USD. */
  harnessUsd: number;
  /** The model cost the provider reported (Polpo's engine), USD. */
  modelUsd: number;
  tokens: number;
  runs: number;
}

export interface MissionCost extends MissionCostBucket {
  currency: "USD";
  /** Tasks with at least one recorded run. */
  tasks: number;
  /** Runs that recorded no cost (yet: a run starting, or an engine that reports none). */
  unpricedRuns: number;
  runsActive: number;
  byAgent: Array<MissionCostBucket & { agent: string }>;
  byEngine: Array<MissionCostBucket & { engine: RunEngine }>;
  /** Some task reached MAX_TASK_RUNS and older runs were dropped: the total may be higher. */
  partial: boolean;
  /** The tasks whose older runs were dropped (and not recovered from usage records). */
  partialTaskIds?: string[];
  /** Harness cost taken from token-usage records for tasks whose older runs were dropped, USD. */
  recoveredUsd?: number;
  /** The mission's budget (Mission.budgetUsd). */
  budgetUsd?: number;
  /** budgetUsd - usd (negative when over). */
  remainingUsd?: number;
  /** usd / budgetUsd, 0..n. */
  budgetUsed?: number;
  overBudget?: boolean;
  /**
   * Informational, when the mission has no budget: the sum of the per-run harness budgets
   * (maxBudgetUsd) of the agents of its tasks, one run each — only when every task's agent has one.
   */
  agentBudgetCapUsd?: number;
}

/** A compact view for lists. */
export interface MissionCostSummary {
  usd: number;
  tokens: number;
  runs: number;
  partial?: boolean;
  budgetUsd?: number;
  overBudget?: boolean;
}

/** A run's cost in USD (the harness estimate, else the model cost), undefined when none recorded. */
export function runUsd(run: Pick<TaskRunContext, "cost">): number | undefined {
  const h = run.cost?.harnessUsd;
  const m = run.cost?.modelUsd;
  if (h === undefined && m === undefined) return undefined;
  return (Number.isFinite(h) ? h! : 0) + (Number.isFinite(m) ? m! : 0);
}

/** The tasks of a mission: by mission id, else (older tasks without one) by its group name. */
export function tasksOfMission<T extends Pick<Task, "missionId" | "group">>(mission: { id: string; name: string }, tasks: T[]): T[] {
  const group = mission.name;
  return tasks.filter((t) => t.missionId === mission.id
    || (!t.missionId && (t.group === group || (t.group?.startsWith(`${group} #`) ?? false))));
}

const emptyBucket = (): MissionCostBucket => ({ usd: 0, harnessUsd: 0, modelUsd: 0, tokens: 0, runs: 0 });

function add(b: MissionCostBucket, harness: number, model: number, tokens: number, runs: number): void {
  b.harnessUsd += harness;
  b.modelUsd += model;
  b.usd += harness + model;
  b.tokens += tokens;
  b.runs += runs;
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;
function rounded<T extends MissionCostBucket>(b: T): T {
  return { ...b, usd: round(b.usd), harnessUsd: round(b.harnessUsd), modelUsd: round(b.modelUsd) };
}

export interface MissionCostOptions {
  budgetUsd?: number;
  /**
   * Harness cost and tokens per task id from token-usage records (`agent_harness`): used only for
   * tasks whose older runs were dropped (MAX_TASK_RUNS).
   */
  harnessUsage?: Record<string, { usd: number; tokens: number }>;
  /** The per-run harness budget of each agent (maxBudgetUsd), for agentBudgetCapUsd. */
  agentBudgets?: Record<string, number | undefined>;
  /** The agents of the mission's planned tasks (assignTo), when no task ran yet (a draft). */
  plannedAgents?: Array<string | undefined>;
}

/** The mission's cost from its tasks' recorded runs (see the file comment). */
export function computeMissionCost(tasks: Array<Pick<Task, "id" | "assignTo" | "runs">>, opts: MissionCostOptions = {}): MissionCost {
  const total = emptyBucket();
  const byAgent = new Map<string, MissionCostBucket>();
  const byEngine = new Map<RunEngine, MissionCostBucket>();
  let unpricedRuns = 0;
  let runsActive = 0;
  let withRuns = 0;
  let recovered = 0;
  const partialTaskIds: string[] = [];
  const bucket = <K>(m: Map<K, MissionCostBucket>, k: K) => {
    let b = m.get(k);
    if (!b) { b = emptyBucket(); m.set(k, b); }
    return b;
  };

  for (const task of tasks) {
    const runs = task.runs ?? [];
    if (runs.length) withRuns++;
    let taskHarness = 0;
    let taskHarnessTokens = 0;
    let lastHarness: TaskRunContext | undefined;
    for (const run of runs) {
      const h = Number.isFinite(run.cost?.harnessUsd) ? run.cost!.harnessUsd! : 0;
      const m = Number.isFinite(run.cost?.modelUsd) ? run.cost!.modelUsd! : 0;
      const tokens = Number.isFinite(run.cost?.tokens) ? run.cost!.tokens! : 0;
      if (runUsd(run) === undefined) unpricedRuns++;
      if (run.status === "running") runsActive++;
      const agent = run.agent ?? task.assignTo ?? "unassigned";
      add(total, h, m, tokens, 1);
      add(bucket(byAgent, agent), h, m, tokens, 1);
      add(bucket(byEngine, run.engine ?? "polpo"), h, m, tokens, 1);
      if (run.engine && run.engine !== "polpo") {
        taskHarness += h;
        taskHarnessTokens += tokens;
        lastHarness = run;
      }
    }
    if (runs.length < MAX_TASK_RUNS) continue;
    // older runs may have been dropped: the harness part can come back from the usage records
    const usage = opts.harnessUsage?.[task.id];
    const allHarness = runs.every((r) => r.engine && r.engine !== "polpo");
    if (usage && lastHarness && usage.usd > taskHarness) {
      const extraUsd = usage.usd - taskHarness;
      const extraTokens = Math.max(0, usage.tokens - taskHarnessTokens);
      recovered += extraUsd;
      const agent = lastHarness.agent ?? task.assignTo ?? "unassigned";
      add(total, extraUsd, 0, extraTokens, 0);
      add(bucket(byAgent, agent), extraUsd, 0, extraTokens, 0);
      add(bucket(byEngine, lastHarness.engine), extraUsd, 0, extraTokens, 0);
      if (allHarness) continue;
    } else if (usage && allHarness) {
      continue; // the usage records hold nothing more: nothing was lost
    }
    partialTaskIds.push(task.id);
  }

  const cost: MissionCost = {
    currency: "USD",
    ...rounded(total),
    tasks: withRuns,
    unpricedRuns,
    runsActive,
    byAgent: [...byAgent].map(([agent, b]) => ({ agent, ...rounded(b) })).sort((a, b) => b.usd - a.usd || b.runs - a.runs),
    byEngine: [...byEngine].map(([engine, b]) => ({ engine, ...rounded(b) })).sort((a, b) => b.usd - a.usd || b.runs - a.runs),
    partial: partialTaskIds.length > 0,
    ...(partialTaskIds.length ? { partialTaskIds } : {}),
    ...(recovered > 0 ? { recoveredUsd: round(recovered) } : {}),
  };

  const budget = opts.budgetUsd;
  if (budget !== undefined && budget > 0) {
    cost.budgetUsd = budget;
    cost.remainingUsd = round(budget - cost.usd);
    cost.budgetUsed = round(cost.usd / budget);
    cost.overBudget = cost.usd >= budget;
  } else if (opts.agentBudgets) {
    const agents = tasks.length ? tasks.map((t) => t.assignTo) : (opts.plannedAgents ?? []);
    if (agents.length) {
      let cap = 0;
      let complete = true;
      for (const a of agents) {
        const b = a ? opts.agentBudgets[a] : undefined;
        if (!b || !(b > 0)) { complete = false; break; }
        cap += b;
      }
      if (complete) cost.agentBudgetCapUsd = round(cap);
    }
  }
  return cost;
}

/** The USD a mission's tasks spent so far (what the budget is checked against). */
export function missionSpentUsd(tasks: Array<Pick<Task, "runs">>): number {
  let usd = 0;
  for (const t of tasks) for (const r of t.runs ?? []) usd += runUsd(r) ?? 0;
  return round(usd);
}

export function summarizeMissionCost(cost: MissionCost): MissionCostSummary {
  return {
    usd: cost.usd, tokens: cost.tokens, runs: cost.runs,
    ...(cost.partial ? { partial: true } : {}),
    ...(cost.budgetUsd !== undefined ? { budgetUsd: cost.budgetUsd, overBudget: !!cost.overBudget } : {}),
  };
}

/** A valid mission budget: a positive, finite number of USD. */
export function isValidBudgetUsd(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

const ENGINE_NAMES: Record<string, string> = { polpo: "Polpo", "claude-code": "Claude Code", codex: "Codex" };
const usdText = (v: number) => (v === 0 ? "$0" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);

/** The cost in a few lines, for text outputs (MCP, Polpo's tools). */
export function describeMissionCost(cost: MissionCost): string {
  const head = `cost: ${usdText(cost.usd)}${cost.partial ? " (partial: older runs dropped)" : ""}`
    + ` · ${cost.tokens.toLocaleString("en-US")} tokens · ${cost.runs} run${cost.runs === 1 ? "" : "s"} over ${cost.tasks} task${cost.tasks === 1 ? "" : "s"}`
    + (cost.harnessUsd > 0 && cost.modelUsd > 0 ? ` (harness estimate ${usdText(cost.harnessUsd)}, model cost ${usdText(cost.modelUsd)})` : cost.harnessUsd > 0 ? " (harness estimate)" : "");
  const budget = cost.budgetUsd !== undefined
    ? `budget: ${usdText(cost.budgetUsd)} · ${Math.round((cost.budgetUsed ?? 0) * 100)}% used${cost.overBudget ? " · OVER BUDGET: no new tasks start" : ` · ${usdText(Math.max(0, cost.remainingUsd ?? 0))} left`}`
    : cost.agentBudgetCapUsd !== undefined ? `no budget (the agents' harness budgets cap one run of each task at ${usdText(cost.agentBudgetCapUsd)})` : "no budget";
  const lines = [head, budget];
  if (cost.byEngine.length > 1 || cost.byAgent.length > 1) {
    lines.push(`by engine: ${cost.byEngine.map((e) => `${ENGINE_NAMES[e.engine] ?? e.engine} ${usdText(e.usd)} (${e.runs})`).join(", ")}`);
    lines.push(`by agent: ${cost.byAgent.map((a) => `${a.agent} ${usdText(a.usd)} (${a.runs})`).join(", ")}`);
  }
  return lines.join("\n");
}

/** An agent's per-run harness budget (engine.maxBudgetUsd), when its engine is a harness with one. */
export function agentHarnessBudgetUsd(agent: { engine?: unknown }): number | undefined {
  const e = agent.engine;
  if (!e || typeof e !== "object") return undefined;
  const b = (e as { maxBudgetUsd?: unknown }).maxBudgetUsd;
  return isValidBudgetUsd(b) ? b : undefined;
}

/** The planned tasks' agents (assignTo) of a mission document (its `data` JSON). */
export function plannedAgentsOf(missionData: string | undefined): Array<string | undefined> {
  if (!missionData) return [];
  try {
    const doc = JSON.parse(missionData) as { tasks?: Array<{ assignTo?: unknown }> };
    return Array.isArray(doc.tasks) ? doc.tasks.map((t) => (typeof t?.assignTo === "string" ? t.assignTo : undefined)) : [];
  } catch { return []; }
}
