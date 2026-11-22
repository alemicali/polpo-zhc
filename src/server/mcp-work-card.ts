/**
 * The task and mission cards: what the `polpo_task_show` and `polpo_mission_show` MCP Apps show,
 * built from the instance's API data.
 *
 * - Task card: status, agent, why it failed (the labelled reason, and whether it was retried),
 *   what every run cost in all (retries, continuations; by engine; the latest run's), where and
 *   with what each run executed (engine and model with their marks, auth, computer, egress,
 *   session, cost), the tasks it depends on, its result and outcomes.
 * - Mission card: status, what it cost against its budget (a bar; paused when over), cost by agent
 *   and engine, and its tasks with their latest run and failure.
 *
 * Pure (no I/O): the widget in widgets/work-card imports the types, the MCP server builds the cards.
 */
import type { TaskRunContext } from "@polpo-ai/core/run-context";
import type { MissionCost, MissionCostSummary } from "@polpo-ai/core/mission-cost";
import { taskFailure, type TaskFailure } from "@polpo-ai/core/task-failure";
import { computeTaskCost, type TaskCost } from "@polpo-ai/core/task-cost";
import { describeTaskToolScope, type TaskToolScope } from "@polpo-ai/core/task-tool-scope";
import { ENGINE_LABELS, engineMark, formatMs, formatUsd, runView, runViewLine, type BrandMark, type RunView } from "./mcp-run-view.js";

export interface CardKey { createdAt: number; seq: number }

export interface CardTaskRef {
  id: string;
  title: string;
  status: string;
  assignTo?: string;
  failure?: TaskFailure;
  /** Its runs get only part of the agent's tools (Task.toolScope). */
  toolScoped?: boolean;
}

export interface TaskCard {
  kind: "task";
  key: CardKey;
  generatedAt: string;
  task: CardTaskRef & {
    phase?: string;
    group?: string;
    missionId?: string;
    description?: string;
    retries: number;
    maxRetries?: number;
    sideEffects?: boolean;
    createdAt?: string;
    updatedAt?: string;
  };
  /** The tools its runs get, when the task narrows the agent's (Task.toolScope): a label, and what the agent no longer has. */
  toolScope?: { label: string; stale?: string[] };
  /** Its runs, newest first (at most 10). */
  runs: RunView[];
  /** Every recorded run's cost, USD (cost.usd). */
  costUsd?: number;
  /** What every run cost in all (retries, continuations, directions), when it ran. */
  cost?: TaskCardCost;
  /** The tasks it depends on, in its order (missing ones: status "missing"). */
  dependencies: CardTaskRef[];
  result?: { exitCode?: number; durationMs?: number; passed?: boolean; score?: number; text?: string };
  outcomes: Array<{ type: string; label: string; ref?: string }>;
}

export interface TaskCardCost {
  usd: number;
  tokens: number;
  /** Every recorded run (the card lists at most 10). */
  runs: number;
  /** The latest run's cost, USD. */
  lastRunUsd?: number;
  /** Older runs were dropped (a task keeps its latest 20): the total may be higher. */
  partial: boolean;
  byEngine: Array<{ engine: string; label: string; mark: BrandMark; usd: number; runs: number }>;
}

export interface MissionCardTask extends CardTaskRef {
  lastRun?: Pick<RunView, "engine" | "engineLabel" | "engineMark" | "modelLabel" | "computer">;
  costUsd?: number;
}

export interface MissionCard {
  kind: "mission";
  key: CardKey;
  generatedAt: string;
  mission: { id: string; name: string; status: string; pauseReason?: string; goal?: string; updatedAt?: string };
  cost?: {
    usd: number;
    tokens: number;
    runs: number;
    partial: boolean;
    budgetUsd?: number;
    remainingUsd?: number;
    /** usd / budgetUsd (0..n). */
    budgetUsed?: number;
    overBudget?: boolean;
    byAgent: Array<{ agent: string; usd: number; runs: number }>;
    byEngine: Array<{ engine: string; label: string; mark: BrandMark; usd: number; runs: number }>;
  };
  counts: Record<string, number>;
  tasks: MissionCardTask[];
}

export type WorkCard = TaskCard | MissionCard;

type InTask = {
  id: string; title: string; status: string; assignTo?: string; group?: string; missionId?: string; phase?: string; description?: string;
  dependsOn?: string[]; retries?: number; maxRetries?: number; sideEffects?: boolean; createdAt?: string; updatedAt?: string;
  result?: { exitCode?: number; duration?: number; stdout?: string; stderr?: string; retryable?: boolean; assessment?: { passed?: boolean; globalScore?: number } };
  outcomes?: Array<{ type?: string; label?: string; path?: string; url?: string; text?: string }>;
  runs?: TaskRunContext[];
  failure?: TaskFailure;
  toolScope?: TaskToolScope;
  toolScopeStale?: string[];
  /** GET /tasks/:id: every run's cost in all (it recovers runs dropped past the latest 20). */
  cost?: Partial<TaskCost>;
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

const ref = (t: InTask): CardTaskRef => {
  const failure = t.failure ?? taskFailure(t as Parameters<typeof taskFailure>[0]);
  return {
    id: t.id, title: t.title, status: t.status,
    ...(t.assignTo ? { assignTo: t.assignTo } : {}),
    ...(failure ? { failure } : {}),
    ...(t.toolScope ? { toolScoped: true } : {}),
  };
};

/** Every run's cost in all (task-cost.ts, like the mission's): the API's when it has the breakdown, else from the runs. */
function taskCost(t: InTask): TaskCost | undefined {
  if (!t.runs?.length) return undefined;
  return t.cost && Array.isArray(t.cost.perRun) ? t.cost as TaskCost : computeTaskCost(t);
}

/** The total in USD, undefined when no run recorded a cost. */
function totalCost(t: InTask): number | undefined {
  const c = taskCost(t);
  return c && (c.unpricedRuns < c.runs || c.recoveredUsd) ? c.usd : undefined;
}

/** A dependency entry: an id, else a title among the same mission's tasks. */
function resolveDependency(entry: string, task: InTask, all: InTask[]): InTask | undefined {
  return all.find((t) => t.id === entry)
    ?? all.find((t) => t.title === entry && (task.missionId ? t.missionId === task.missionId : t.group === task.group));
}

export function buildTaskCard(input: {
  task: InTask; tasks: InTask[]; now: Date; key: CardKey;
  /** The connectors, to name the ones a tool scope lists (with their accounts). */
  connectors?: Array<{ id: string; name: string; account?: string }>;
}): TaskCard {
  const t = input.task;
  const runs = [...(t.runs ?? [])].reverse().slice(0, 10).map(runView);
  const tc = taskCost(t);
  const cost = totalCost(t);
  const res = t.result;
  const text = res?.stdout?.trim();
  return {
    kind: "task",
    key: input.key,
    generatedAt: input.now.toISOString(),
    task: {
      ...ref(t),
      ...(t.phase ? { phase: t.phase } : {}),
      ...(t.group ? { group: t.group } : {}),
      ...(t.missionId ? { missionId: t.missionId } : {}),
      ...(t.description ? { description: clip(t.description.trim(), 1200) } : {}),
      retries: t.retries ?? 0,
      ...(t.maxRetries !== undefined ? { maxRetries: t.maxRetries } : {}),
      ...(t.sideEffects ? { sideEffects: true } : {}),
      ...(t.createdAt ? { createdAt: t.createdAt } : {}),
      ...(t.updatedAt ? { updatedAt: t.updatedAt } : {}),
    },
    ...(t.toolScope ? { toolScope: { label: describeTaskToolScope(t.toolScope, input.connectors ?? []), ...(t.toolScopeStale?.length ? { stale: t.toolScopeStale } : {}) } } : {}),
    runs,
    ...(cost !== undefined ? { costUsd: cost } : {}),
    ...(tc && cost !== undefined ? {
      cost: {
        usd: tc.usd, tokens: tc.tokens, runs: tc.runs, partial: tc.partial,
        ...(tc.lastRunUsd !== undefined ? { lastRunUsd: tc.lastRunUsd } : {}),
        byEngine: tc.byEngine.map((e) => ({ engine: e.engine, label: ENGINE_LABELS[e.engine] ?? e.engine, mark: engineMark(e.engine), usd: e.usd, runs: e.runs })),
      },
    } : {}),
    dependencies: (t.dependsOn ?? []).map((d) => {
      const found = resolveDependency(d, t, input.tasks);
      return found ? ref(found) : { id: d, title: d, status: "missing" };
    }),
    ...(res ? {
      result: {
        ...(res.exitCode !== undefined ? { exitCode: res.exitCode } : {}),
        ...(res.duration !== undefined ? { durationMs: res.duration } : {}),
        ...(res.assessment?.passed !== undefined ? { passed: res.assessment.passed } : {}),
        ...(res.assessment?.globalScore !== undefined ? { score: res.assessment.globalScore } : {}),
        ...(text ? { text: clip(text, 1500) } : {}),
      },
    } : {}),
    outcomes: (t.outcomes ?? []).slice(0, 20).map((o) => ({
      type: o.type ?? "file", label: o.label ?? o.path ?? o.url ?? "outcome",
      ...(o.path || o.url ? { ref: o.path ?? o.url } : o.text ? { ref: clip(o.text, 160) } : {}),
    })),
  };
}

export function buildMissionCard(input: {
  mission: { id: string; name: string; status: string; pauseReason?: string; prompt?: string; updatedAt?: string; budgetUsd?: number; cost?: MissionCost | MissionCostSummary };
  tasks: InTask[];
  now: Date;
  key: CardKey;
}): MissionCard {
  const m = input.mission;
  const c = m.cost;
  const full = c && "byAgent" in c ? c : undefined;
  const counts: Record<string, number> = {};
  for (const t of input.tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
  const budget = m.budgetUsd ?? c?.budgetUsd;
  return {
    kind: "mission",
    key: input.key,
    generatedAt: input.now.toISOString(),
    mission: {
      id: m.id, name: m.name, status: m.status,
      ...(m.pauseReason ? { pauseReason: m.pauseReason } : {}),
      ...(m.prompt?.trim() ? { goal: clip(m.prompt.trim(), 400) } : {}),
      ...(m.updatedAt ? { updatedAt: m.updatedAt } : {}),
    },
    ...(c ? {
      cost: {
        usd: c.usd, tokens: c.tokens, runs: c.runs, partial: !!c.partial,
        ...(budget !== undefined ? {
          budgetUsd: budget,
          remainingUsd: full?.remainingUsd ?? budget - c.usd,
          budgetUsed: full?.budgetUsed ?? (budget > 0 ? c.usd / budget : 0),
          overBudget: full?.overBudget ?? c.usd >= budget,
        } : {}),
        byAgent: (full?.byAgent ?? []).map((a) => ({ agent: a.agent, usd: a.usd, runs: a.runs })).sort((a, b) => b.usd - a.usd),
        byEngine: (full?.byEngine ?? []).map((e) => ({ engine: e.engine, label: ENGINE_LABELS[e.engine] ?? e.engine, mark: engineMark(e.engine), usd: e.usd, runs: e.runs })).sort((a, b) => b.usd - a.usd),
      },
    } : {}),
    counts,
    tasks: input.tasks.slice(0, 60).map((t) => {
      const last = t.runs?.at(-1);
      const v = last ? runView(last) : undefined;
      const cost = totalCost(t);
      return {
        ...ref(t),
        ...(v ? { lastRun: { engine: v.engine, engineLabel: v.engineLabel, engineMark: v.engineMark, ...(v.modelLabel ? { modelLabel: v.modelLabel } : {}), computer: v.computer } } : {}),
        ...(cost !== undefined ? { costUsd: cost } : {}),
      };
    }),
  };
}

const failureText = (f: TaskFailure) => `${f.reason}${f.retryable ? "" : " (not retried: a re-run would fail the same way)"}`;

/** The task card as text, for the model and for clients that do not show apps. */
export function taskCardText(card: TaskCard): string {
  const t = card.task;
  const lines = [`${t.id} [${t.status}${t.phase ? `/${t.phase}` : ""}] ${t.title}${t.assignTo ? ` → ${t.assignTo}` : ""}`];
  if (card.task.failure) lines.push(`Failed: ${failureText(card.task.failure)}`);
  if (card.toolScope) lines.push(`Tools: ${card.toolScope.label}${card.toolScope.stale?.length ? ` (the agent no longer has: ${card.toolScope.stale.join("; ")})` : ""}`);
  const c = card.cost;
  if (c) {
    lines.push(`Cost: ${formatUsd(c.usd)}${c.partial ? "+" : ""} in all over ${c.runs} run${c.runs === 1 ? "" : "s"}`
      + `${c.runs > 1 && c.lastRunUsd !== undefined ? ` · latest ${formatUsd(c.lastRunUsd)}` : ""}`
      + `${c.byEngine.length > 1 ? ` (${c.byEngine.map((e) => `${e.label} ${formatUsd(e.usd)}`).join(", ")})` : ""}${c.partial ? " — older runs dropped, not counted" : ""}`);
  }
  if (card.runs.length) lines.push(`Runs (${c?.runs ?? card.runs.length}${card.runs.length < (c?.runs ?? 0) ? `, latest ${card.runs.length}` : ""}):`, ...card.runs.slice(0, 5).map((r) => `- ${r.runId} [${r.status}] ${runViewLine(r)}${r.durationMs !== undefined ? ` · ${formatMs(r.durationMs)}` : ""}`));
  if (card.dependencies.length) lines.push(`Depends on: ${card.dependencies.map((d) => `${d.title} [${d.status}]`).join(", ")}`);
  if (card.result?.text) lines.push(`Result: ${clip(card.result.text, 400)}`);
  if (card.outcomes.length) lines.push(`Outcomes: ${card.outcomes.map((o) => o.label).join(", ")}`);
  return lines.join("\n");
}

/** The mission card as text. */
export function missionCardText(card: MissionCard): string {
  const m = card.mission;
  const lines = [`${m.id} [${m.status}${m.pauseReason === "budget" ? ", over budget" : ""}] ${m.name}`];
  const c = card.cost;
  if (c) {
    lines.push(`Cost: ${formatUsd(c.usd)}${c.partial ? "+" : ""}${c.budgetUsd !== undefined ? ` of ${formatUsd(c.budgetUsd)} budget (${Math.round((c.budgetUsed ?? 0) * 100)}%${c.overBudget ? ", over budget" : ""})` : ""}, ${c.runs} runs, ${c.tokens} tokens`);
    if (c.byEngine.length) lines.push(`By engine: ${c.byEngine.map((e) => `${e.label} ${formatUsd(e.usd)}`).join(", ")}`);
    if (c.byAgent.length) lines.push(`By agent: ${c.byAgent.map((a) => `${a.agent} ${formatUsd(a.usd)}`).join(", ")}`);
  }
  const counts = Object.entries(card.counts).map(([k, v]) => `${v} ${k}`).join(", ");
  lines.push(`Tasks: ${counts || "none yet"}`);
  for (const t of card.tasks.slice(0, 20)) {
    lines.push(`- ${t.id} [${t.status}] ${t.title}${t.assignTo ? ` → ${t.assignTo}` : ""}${t.toolScoped ? " · tools restricted" : ""}${t.lastRun ? ` (${t.lastRun.engineLabel}${t.lastRun.modelLabel ? ` ${t.lastRun.modelLabel}` : ""})` : ""}${t.failure ? `: ${failureText(t.failure)}` : ""}`);
  }
  return lines.join("\n");
}
