/**
 * Missions (plans of tasks run together) and playbooks (reusable mission templates): list, read,
 * create, update, run, abort and wait for.
 */
import { z } from "zod";
import { parseMissionDocument } from "../../core/schemas.js";
import {
  BAD_CURSOR, DESTRUCTIVE, MAX_WAIT_SECONDS, READ, UPDATE, WRITE, apiError, apiGet, apiSend, confirmParam, cursorParam, enc, fail,
  limitParam, looseObject, ok, page, pageOutput, progress, short, sleep,
  type McpDeps, type Register,
} from "./kit.js";
import { taskLine, taskSummary, unknownAgents } from "./tasks.js";
import { describeMissionCost, type MissionCost, type MissionCostSummary } from "@polpo-ai/core/mission-cost";

export const MISSION_STATUSES = ["draft", "scheduled", "recurring", "active", "paused", "completed", "failed", "cancelled"] as const;
/** A mission that is over, or waits for a person: what polpo_mission_wait waits for. */
const MISSION_SETTLED = ["completed", "failed", "cancelled", "paused"];
/** Statuses of a scheduled or recurring mission between runs: it never "completes", each run finishes. */
const BETWEEN_RUNS = ["recurring", "scheduled"];
const TASK_FINISHED = ["done", "failed"];
const EXECUTABLE = ["draft", "scheduled", "recurring", "failed", "cancelled"];
/** Statuses where the plan may still change. */
const EDITABLE = ["draft", "scheduled", "recurring", "paused", "failed", "cancelled"];

const missionSummary = z.object({
  id: z.string(), name: z.string(), status: z.string(), taskCount: z.number().optional(), updatedAt: z.string().optional(),
  cost_usd: z.number().optional().describe("What its tasks' runs cost so far, USD"),
  budget_usd: z.number().optional().describe("Its spending limit, USD"),
  over_budget: z.boolean().optional(),
}).passthrough();

type Mission = {
  id: string; name: string; status: string; data?: string; prompt?: string; updatedAt?: string; createdAt?: string; taskCount?: number; executionCount?: number; schedule?: string;
  budgetUsd?: number; pauseReason?: string; cost?: MissionCost | MissionCostSummary;
};

const usd = (v: number) => (v === 0 ? "$0" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);

/** " · $1.24 of $5" / " · $1.24" for list lines. */
function costTag(spent: number | undefined, budget: number | undefined): string {
  if (spent === undefined) return budget !== undefined ? ` · budget ${usd(budget)}` : "";
  return ` · ${usd(spent)}${budget !== undefined ? ` of ${usd(budget)}${spent >= budget ? " (over budget)" : ""}` : ""}`;
}

const budgetParam = () => z.number().positive().max(1_000_000).optional()
  .describe("Spending limit in USD for the whole mission (all its tasks' runs, retries included): when reached, no new task starts and the mission pauses until it is raised or cleared");
type TaskRow = { id: string; title: string; status: string; assignTo?: string; group?: string; missionId?: string; updatedAt?: string };

/**
 * The latest run of a scheduled or recurring mission: its run number and its tasks (a run's task
 * group is the mission's name, then "<name> #N" from the second run on), and whether it finished
 * (every task done or failed). undefined: it never ran.
 */
function latestRun(m: Mission, tasks: TaskRow[]): { number: number; tasks: TaskRow[]; finished: boolean } | undefined {
  const n = m.executionCount ?? 0;
  if (n < 1) return undefined;
  const group = n > 1 ? `${m.name} #${n}` : m.name;
  const own = tasks.filter((t) => t.group === group);
  // no task of that run yet (it is starting): not finished; tasks without groups (older data): all of them
  const run = own.length ? own : tasks.some((t) => t.group) ? [] : tasks;
  return { number: n, tasks: run, finished: run.length > 0 && run.every((t) => TASK_FINISHED.includes(t.status)) };
}

// ── The plan, as the mission executor validates it ──

const planTask = z.object({
  title: z.string().min(1).describe("Unique title within the mission; other tasks depend on it by this title"),
  description: z.string().min(1).describe("What to do and what a good result looks like"),
  assignTo: z.string().min(1).optional().describe("The agent that does it (polpo_agents_list); omit to let Polpo choose"),
  dependsOn: z.array(z.string().min(1)).optional().describe("Titles of tasks of this mission that must finish first"),
  expectations: z.array(z.record(z.string(), z.unknown())).optional().describe("How the result is checked, e.g. [{ type: 'llm_review', criteria: '…' }]"),
  maxRetries: z.number().int().min(0).max(10).optional().describe("Retries after a failure"),
  maxDuration: z.number().positive().optional().describe("Stop it after this many milliseconds"),
  sideEffects: z.boolean().optional().describe("true if it does something irreversible: never retried automatically"),
}).passthrough();

const flowControl = z.object({
  name: z.string().min(1).describe("Its name"),
  afterTasks: z.array(z.string().min(1)).min(1).describe("Titles of the tasks it comes after"),
  blocksTasks: z.array(z.string().min(1)).min(1).describe("Titles of the tasks it holds (they must also list the afterTasks in dependsOn)"),
  message: z.string().optional().describe("What to tell the person"),
}).passthrough();

const planShape = {
  tasks: z.array(planTask).min(1).describe("The tasks, in any order; dependsOn sets the order"),
  checkpoints: z.array(flowControl).optional().describe("Pauses for a person to review before the blocked tasks start"),
  delays: z.array(flowControl.extend({ duration: z.string().describe("ISO 8601 duration, e.g. PT2H, P1D") })).optional().describe("Waits before the blocked tasks start"),
  qualityGates: z.array(flowControl.extend({ minScore: z.number().min(1).max(5).optional().describe("Lowest assessment score to pass (1-5)") })).optional()
    .describe("Assessment thresholds the afterTasks must pass"),
};

/** Validate a plan as the executor will; an error says which task or checkpoint to fix. */
function validatePlan(plan: Record<string, unknown>): { ok: true; data: string } | { ok: false; error: string } {
  const doc = Object.fromEntries(Object.entries(plan).filter(([, v]) => v !== undefined));
  try {
    parseMissionDocument(doc);
  } catch (err) {
    return { ok: false, error: `${err instanceof Error ? err.message : String(err)}. Fix the plan and call again.` };
  }
  return { ok: true, data: JSON.stringify(doc) };
}

async function loadMission(deps: McpDeps, id: string): Promise<{ ok: true; mission: Mission } | { ok: false; status: number; error: string }> {
  const r = await apiGet(deps, `/missions/${enc(id)}`);
  return r.ok ? { ok: true, mission: r.data as Mission } : r;
}

const notFound = (id: string) => fail(`There is no mission ${id}. Find the id with polpo_missions_list.`);

async function missionTasks(deps: McpDeps, missionId: string): Promise<TaskRow[]> {
  const r = await apiGet(deps, "/tasks?slim=true");
  if (!r.ok || !Array.isArray(r.data)) return [];
  return (r.data as TaskRow[]).filter((t) => t.missionId === missionId);
}

function counts(tasks: TaskRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tasks) out[t.status] = (out[t.status] ?? 0) + 1;
  return out;
}

const countText = (c: Record<string, number>) => Object.entries(c).map(([k, v]) => `${v} ${k}`).join(", ") || "no tasks yet";

function planOf(m: Mission): Record<string, unknown> | undefined {
  if (!m.data) return undefined;
  try { return JSON.parse(m.data) as Record<string, unknown>; } catch { return undefined; }
}

export function registerMissionTools(tool: Register, deps: McpDeps): void {
  tool("missions", "polpo_missions_list", {
    title: "List missions",
    description: "Missions (plans of tasks run together), most recently updated first: id, name, status, number of tasks, what they cost so far and their budget. "
      + "polpo_mission_get reads one with its plan and its tasks' progress.",
    inputSchema: {
      status: z.enum(MISSION_STATUSES).optional().describe("Only missions in this status"),
      text: z.string().optional().describe("Words in the name"),
      limit: limitParam(),
      cursor: cursorParam(),
    },
    outputSchema: pageOutput(missionSummary),
    annotations: READ,
  }, async ({ status, text, limit, cursor }) => {
    const r = await apiGet(deps, "/missions?slim=true");
    if (!r.ok) return apiError(r, "Listing missions");
    const words = (text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const all = ((r.data as Mission[]) ?? [])
      .filter((m) => (!status || m.status === status) && words.every((w) => m.name.toLowerCase().includes(w)))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .map((m) => ({
        id: m.id, name: m.name, status: m.status, ...(m.taskCount !== undefined ? { taskCount: m.taskCount } : {}), ...(m.updatedAt ? { updatedAt: m.updatedAt } : {}),
        ...(m.cost ? { cost_usd: m.cost.usd } : {}),
        ...(m.budgetUsd !== undefined ? { budget_usd: m.budgetUsd, over_budget: (m.cost?.usd ?? 0) >= m.budgetUsd } : {}),
        ...(m.pauseReason ? { pause_reason: m.pauseReason } : {}),
      }));
    const p = page(all, limit ?? 20, cursor);
    if (!p) return fail(BAD_CURSOR);
    const lines = p.items.map((m) => `- ${m.id} [${m.status}${m.pause_reason ? `: ${m.pause_reason}` : ""}] ${short(m.name, 100)}${m.taskCount !== undefined ? ` (${m.taskCount} tasks)` : ""}${costTag(m.cost_usd, m.budget_usd)}`);
    return ok(`${lines.join("\n") || "No missions match."}${p.next_cursor ? `\n(more: cursor ${p.next_cursor})` : ""}`, p);
  });

  tool("missions", "polpo_mission_get", {
    title: "Get a mission",
    description: "A mission with its plan (tasks, dependencies, checkpoints, delays, quality gates), its status, the status of the tasks it started, "
      + "and what it cost so far (every run of its tasks, retries included: USD, tokens, by agent and engine) against its budget.",
    inputSchema: { id: z.string().min(1).describe("The mission's id (polpo_missions_list)") },
    outputSchema: { mission: looseObject, plan: looseObject.optional(), tasks: z.array(taskSummary), task_counts: z.record(z.string(), z.number()), cost: looseObject.optional() },
    annotations: READ,
  }, async ({ id }) => {
    const m = await loadMission(deps, id);
    if (!m.ok) return m.status === 404 ? notFound(id) : apiError(m, `Reading mission ${id}`);
    const tasks = await missionTasks(deps, id);
    const plan = planOf(m.mission);
    const planTasks = (plan?.tasks as Array<{ title: string; assignTo?: string; dependsOn?: string[] }> | undefined) ?? [];
    const { data: _d, cost, ...mission } = m.mission;
    const full = cost && "byAgent" in cost ? cost : undefined;
    const text = [
      `${m.mission.id} [${m.mission.status}${m.mission.pauseReason === "budget" ? ": over budget" : ""}] ${m.mission.name}${m.mission.prompt ? `\ngoal: ${short(m.mission.prompt, 400)}` : ""}`,
      ...(full ? [describeMissionCost(full)] : m.mission.budgetUsd !== undefined ? [`budget: ${usd(m.mission.budgetUsd)}`] : []),
      "", "plan:",
      ...planTasks.map((t, i) => `${i + 1}. ${t.title}${t.assignTo ? ` → ${t.assignTo}` : ""}${t.dependsOn?.length ? ` (after ${t.dependsOn.join(", ")})` : ""}`),
      ...(tasks.length ? ["", `tasks: ${countText(counts(tasks))}`, ...tasks.map(taskLine)] : []),
    ].join("\n");
    return ok(text, { mission: mission as Record<string, unknown>, ...(plan ? { plan } : {}), tasks, task_counts: counts(tasks), ...(cost ? { cost: cost as unknown as Record<string, unknown> } : {}) });
  });

  tool("missions", "polpo_mission_create", {
    title: "Create a mission",
    description: "Create a mission from a structured plan: tasks (with assignTo and dependsOn by title), and optional checkpoints, delays and quality gates. "
      + "The plan is validated as the executor will; an error says what to fix. It is saved as a draft: run it with polpo_mission_run "
      + "(or run: true here). To have Polpo draft the plan from a goal, use polpo_ask instead.",
    inputSchema: {
      name: z.string().min(1).max(120).describe("The mission's name (made unique if taken)"),
      goal: z.string().optional().describe("What the mission is for, in a sentence or two"),
      ...planShape,
      budget_usd: budgetParam(),
      run: z.boolean().optional().describe("true to start it right away (default false: a draft)"),
    },
    outputSchema: { mission: looseObject, started: z.boolean() },
    annotations: WRITE,
  }, async ({ name, goal, run, budget_usd, ...plan }) => {
    const valid = validatePlan(plan);
    if (!valid.ok) return fail(valid.error);
    const missing = await unknownAgents(deps, plan.tasks.map((t) => t.assignTo));
    if (missing) return fail(missing);
    const r = await apiSend(deps, "POST", "/missions", { data: valid.data, name, ...(goal ? { prompt: goal } : {}), status: "draft", ...(budget_usd !== undefined ? { budgetUsd: budget_usd } : {}) });
    if (!r.ok) return apiError(r, "Creating the mission");
    const mission = r.data as Mission;
    if (run) {
      const ex = await apiSend(deps, "POST", `/missions/${enc(mission.id)}/execute`);
      if (!ex.ok) return fail(`Saved mission ${mission.id} ("${mission.name}") as a draft, but it did not start: ${ex.error}. Fix it with polpo_mission_update, then polpo_mission_run.`);
      return ok(`Created and started mission ${mission.id} ("${mission.name}", ${plan.tasks.length} tasks). Follow it with polpo_mission_wait.`, { mission: { ...mission, status: "active" } as Record<string, unknown>, started: true });
    }
    return ok(`Created mission ${mission.id} ("${mission.name}", ${plan.tasks.length} tasks) as a draft: run it with polpo_mission_run.`, { mission: mission as Record<string, unknown>, started: false });
  });

  tool("missions", "polpo_mission_update", {
    title: "Update a mission",
    description: "Rename a mission, set or clear its budget, or replace parts of its plan: tasks, checkpoints, delays or quality gates (each one given replaces that list: "
      + "read the plan with polpo_mission_get, change it, send it back). The plan cannot change while it runs (abort it first); the budget can, "
      + "and raising or clearing it lets a mission paused by its budget go on. The new plan is validated; the result lists what changed.",
    inputSchema: {
      id: z.string().min(1).describe("The mission's id"),
      name: z.string().min(1).max(120).optional().describe("A new name"),
      tasks: planShape.tasks.optional(),
      checkpoints: planShape.checkpoints,
      delays: planShape.delays,
      qualityGates: planShape.qualityGates,
      budget_usd: z.number().positive().max(1_000_000).nullable().optional()
        .describe("Spending limit in USD for the whole mission; null clears it. Raising or clearing it lets a mission paused by its budget go on"),
    },
    outputSchema: { mission: looseObject, changed: z.array(z.string()) },
    annotations: UPDATE,
  }, async ({ id, name, tasks, checkpoints, delays, qualityGates, budget_usd }) => {
    const m = await loadMission(deps, id);
    if (!m.ok) return m.status === 404 ? notFound(id) : apiError(m, `Reading mission ${id}`);
    const planChange = tasks !== undefined || checkpoints !== undefined || delays !== undefined || qualityGates !== undefined;
    if (planChange && !EDITABLE.includes(m.mission.status)) return fail(`Mission ${id} is ${m.mission.status}: its plan cannot change now. Abort it first (polpo_mission_abort) if the person wants to change it.`);
    const body: Record<string, unknown> = {};
    const changed: string[] = [];
    if (name !== undefined && name !== m.mission.name) { body.name = name; changed.push("name"); }
    if (budget_usd !== undefined && (budget_usd ?? undefined) !== m.mission.budgetUsd) { body.budgetUsd = budget_usd; changed.push("budget"); }
    if (planChange) {
      const current = planOf(m.mission) ?? {};
      const next = { ...current, ...(tasks ? { tasks } : {}), ...(checkpoints ? { checkpoints } : {}), ...(delays ? { delays } : {}), ...(qualityGates ? { qualityGates } : {}) };
      const valid = validatePlan(next);
      if (!valid.ok) return fail(valid.error);
      const missing = await unknownAgents(deps, ((next.tasks as Array<{ assignTo?: string }>) ?? []).map((t) => t.assignTo));
      if (missing) return fail(missing);
      if (valid.data !== JSON.stringify(current)) { body.data = valid.data; changed.push(...["tasks", "checkpoints", "delays", "qualityGates"].filter((k) => JSON.stringify((next as Record<string, unknown>)[k]) !== JSON.stringify(current[k]))); }
    }
    let mission = m.mission;
    if (Object.keys(body).length) {
      const r = await apiSend(deps, "PATCH", `/missions/${enc(id)}`, body);
      if (!r.ok) return apiError(r, `Updating mission ${id}`);
      mission = r.data as Mission;
    }
    const { data: _d, ...rest } = mission;
    const budgetNote = changed.includes("budget") && m.mission.pauseReason === "budget"
      ? " If it is now under its budget, it goes on by itself within seconds." : "";
    return ok(changed.length ? `Updated mission ${id}: ${changed.join(", ")}.${budgetNote}` : `Nothing changed on mission ${id}.`, { mission: rest as Record<string, unknown>, changed });
  });

  tool("missions", "polpo_mission_run", {
    title: "Run a mission",
    description: "Start a mission: a draft, scheduled or recurring one runs now; a failed or cancelled one runs again; a paused one resumes "
      + "(retry_failed also reruns its failed tasks). Its tasks then run on their own: follow it with polpo_mission_wait.",
    inputSchema: {
      id: z.string().min(1).describe("The mission's id"),
      retry_failed: z.boolean().optional().describe("For a paused mission: also run its failed tasks again"),
    },
    outputSchema: { id: z.string(), action: z.enum(["execute", "resume"]), result: z.unknown() },
    annotations: { ...WRITE, openWorldHint: true },
  }, async ({ id, retry_failed }) => {
    const m = await loadMission(deps, id);
    if (!m.ok) return m.status === 404 ? notFound(id) : apiError(m, `Reading mission ${id}`);
    const s = m.mission.status;
    if (s === "active") return fail(`Mission ${id} is already running: follow it with polpo_mission_wait.`);
    if (s === "completed") return fail(`Mission ${id} is completed. To run it again, create a new mission with the same plan (polpo_mission_get, then polpo_mission_create).`);
    const action = s === "paused" ? "resume" : "execute";
    if (action === "execute" && !EXECUTABLE.includes(s)) return fail(`Mission ${id} is ${s} and cannot be started.`);
    const r = action === "resume"
      ? await apiSend(deps, "POST", `/missions/${enc(id)}/resume`, { retryFailed: retry_failed === true })
      : await apiSend(deps, "POST", `/missions/${enc(id)}/execute`);
    if (!r.ok) return apiError(r, `Starting mission ${id}`, /invalid mission document/i.test(r.error) ? "Fix the plan with polpo_mission_update." : undefined);
    return ok(`Mission ${id} ${action === "resume" ? "resumed" : "started"}: follow it with polpo_mission_wait.`, { id, action, result: r.data });
  });

  tool("missions", "polpo_mission_abort", {
    title: "Abort a mission",
    description: "Stop a running mission: its unfinished tasks are stopped and fail, and its schedule is removed. It cannot be undone "
      + "(polpo_mission_run runs it again from the start). Needs confirm: true after the person agreed.",
    inputSchema: {
      id: z.string().min(1).describe("The mission's id"),
      confirm: confirmParam("abort the mission"),
    },
    outputSchema: { id: z.string(), aborted_tasks: z.number() },
    annotations: DESTRUCTIVE,
  }, async ({ id, confirm }) => {
    const m = await loadMission(deps, id);
    if (!m.ok) return m.status === 404 ? notFound(id) : apiError(m, `Reading mission ${id}`);
    if (confirm !== true) {
      const tasks = await missionTasks(deps, id);
      const open = tasks.filter((t) => t.status !== "done" && t.status !== "failed");
      return fail(`Aborting "${m.mission.name}" (${m.mission.status}) stops ${open.length} unfinished task(s)${open.length ? `: ${open.slice(0, 5).map((t) => t.title).join(", ")}${open.length > 5 ? "…" : ""}` : ""}. Ask the person, then call again with confirm: true.`);
    }
    const r = await apiSend(deps, "POST", `/missions/${enc(id)}/abort`);
    if (!r.ok) return apiError(r, `Aborting mission ${id}`);
    const n = Number((r.data as { aborted?: number })?.aborted ?? 0);
    return ok(`Aborted mission ${id}: ${n} task(s) stopped.`, { id, aborted_tasks: n });
  });

  tool("missions", "polpo_mission_delete", {
    title: "Delete a mission",
    description: "Delete a mission: its plan, its schedule and its tasks. A running mission must be aborted first (polpo_mission_abort). "
      + "It cannot be undone. Needs confirm: true after the person agreed.",
    inputSchema: {
      id: z.string().min(1).describe("The mission's id"),
      confirm: confirmParam("delete the mission"),
    },
    outputSchema: { deleted: z.string() },
    annotations: DESTRUCTIVE,
  }, async ({ id, confirm }) => {
    const m = await loadMission(deps, id);
    if (!m.ok) return m.status === 404 ? notFound(id) : apiError(m, `Reading mission ${id}`);
    if (m.mission.status === "active") return fail(`Mission ${id} is running: abort it first with polpo_mission_abort (confirm: true), then delete it.`);
    if (confirm !== true) {
      const tasks = await missionTasks(deps, id);
      return fail(`Deleting "${m.mission.name}" (${m.mission.status}${tasks.length ? `, ${tasks.length} tasks` : ""}) removes it for good: ask the person, then call again with confirm: true.`);
    }
    const r = await apiSend(deps, "DELETE", `/missions/${enc(id)}`);
    if (!r.ok) return r.status === 404 ? notFound(id) : apiError(r, `Deleting mission ${id}`);
    return ok(`Deleted mission ${id} ("${m.mission.name}").`, { deleted: id });
  });

  tool("missions", "polpo_mission_wait", {
    title: "Wait for a mission",
    description: `Wait until a mission is completed, failed, cancelled or paused (a checkpoint waits for a person), or the timeout passes `
      + `(at most ${MAX_WAIT_SECONDS} s); returns its status and its tasks' progress. If it timed out, call again. A scheduled or recurring `
      + `mission never completes: it is reached when its current (or latest) run has finished, and run says how that run went `
      + `(completed: every task done; failed: some failed); one that never ran waits for its first run. Sends progress notifications when the client asks.`,
    inputSchema: {
      id: z.string().min(1).describe("The mission's id"),
      timeout_seconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).optional().describe(`How long to wait at most (default 30, max ${MAX_WAIT_SECONDS})`),
    },
    outputSchema: {
      mission: missionSummary, task_counts: z.record(z.string(), z.number()), reached: z.boolean(), timed_out: z.boolean(), waited_seconds: z.number(),
      run: z.object({ number: z.number(), outcome: z.enum(["completed", "failed"]), task_counts: z.record(z.string(), z.number()) }).passthrough().optional()
        .describe("A scheduled or recurring mission: its latest run, finished"),
    },
    annotations: READ,
  }, async ({ id, timeout_seconds }, extra) => {
    const timeout = (timeout_seconds ?? 30) * 1000;
    const started = Date.now();
    const interval = deps.pollIntervalMs ?? 1000;
    let last = "";
    for (;;) {
      const m = await loadMission(deps, id);
      if (!m.ok) return m.status === 404 ? notFound(id) : apiError(m, `Reading mission ${id}`);
      const tasks = await missionTasks(deps, id);
      const c = counts(tasks);
      const done = c.done ?? 0;
      const waited = Math.round((Date.now() - started) / 100) / 10;
      const state = `${m.mission.status} ${JSON.stringify(c)}`;
      if (state !== last) { await progress(extra, done, tasks.length || undefined, `${m.mission.name}: ${m.mission.status}, ${countText(c)}`); last = state; }
      // a scheduled or recurring mission between runs: its latest run finished is what is waited for
      const run = BETWEEN_RUNS.includes(m.mission.status) ? latestRun(m.mission, tasks) : undefined;
      const runDone = !!run?.finished;
      const reached = MISSION_SETTLED.includes(m.mission.status) || runDone;
      if (reached || Date.now() - started >= timeout || extra.signal.aborted) {
        const summary = { id: m.mission.id, name: m.mission.name, status: m.mission.status, taskCount: tasks.length, ...(m.mission.updatedAt ? { updatedAt: m.mission.updatedAt } : {}) };
        if (runDone) {
          const rc = counts(run!.tasks);
          const outcome = (rc.failed ?? 0) > 0 ? "failed" as const : "completed" as const;
          // what comes next depends on the schedule: paused, ended, or its next run
          const sched = await apiGet(deps, `/schedules/${enc(id)}`);
          const s = sched.ok ? sched.data as { enabled?: boolean; nextRunAt?: string; recurring?: boolean } : undefined;
          const expr = m.mission.schedule ? ` (${m.mission.schedule})` : "";
          const next = !s
            ? `It has no schedule now`
            : s.enabled === false && s.nextRunAt
              ? `Its schedule${expr} is paused: it does not run again until resumed (polpo_schedule_update enabled: true)`
              : s.enabled === false
                ? `Its schedule${expr} is done: it does not run again`
                : s.nextRunAt
                ? `It runs again on its schedule${expr}, next at ${s.nextRunAt}`
                : `Its schedule${expr} has no next run`;
          return ok(`Mission ${id} (${m.mission.status}): its run #${run!.number} ${outcome === "completed" ? "completed" : "failed"} (${countText(rc)}). `
            + `${next}; read the results with polpo_mission_get.`,
            { mission: summary, task_counts: c, reached: true, timed_out: false, waited_seconds: waited, run: { number: run!.number, outcome, task_counts: rc } });
        }
        let between = "";
        if (BETWEEN_RUNS.includes(m.mission.status)) {
          const sched = run ? undefined : await apiGet(deps, `/schedules/${enc(id)}`);
          const paused = sched?.ok && (sched.data as { enabled?: boolean; nextRunAt?: string }).enabled === false && !!(sched.data as { nextRunAt?: string }).nextRunAt;
          between = ` It has ${run ? "a run in progress" : paused
            ? "not run yet, and its schedule is paused: resume it with polpo_schedule_update enabled: true, or run it now with polpo_schedule_run"
            : "not run yet: it runs on its schedule, or now with polpo_schedule_run"}.`;
        }
        return ok(reached
          ? `Mission ${id} is ${m.mission.status} (${countText(c)}).${m.mission.status === "paused" ? " It waits at a checkpoint or for a person: polpo_approvals_list, then polpo_mission_run to resume." : ""}`
          : `Mission ${id} is still ${m.mission.status} after ${waited} s (${countText(c)}).${between} Call polpo_mission_wait again to keep waiting.`,
          { mission: summary, task_counts: c, reached, timed_out: !reached, waited_seconds: waited });
      }
      await sleep(Math.min(interval, Math.max(0, timeout - (Date.now() - started))), extra.signal);
    }
  });

  // ── Playbooks: reusable mission templates ──

  const playbookItem = z.object({ name: z.string(), description: z.string().optional(), parameters: z.array(looseObject).optional() }).passthrough();

  tool("missions", "polpo_playbooks_list", {
    title: "List playbooks",
    description: "Playbooks: reusable mission templates with parameters. polpo_playbook_run starts one as a new mission.",
    inputSchema: { limit: limitParam(), cursor: cursorParam() },
    outputSchema: pageOutput(playbookItem),
    annotations: READ,
  }, async ({ limit, cursor }) => {
    const r = await apiGet(deps, "/playbooks");
    if (!r.ok) return apiError(r, "Listing playbooks");
    const all = ((r.data as Array<{ name: string; description?: string; parameters?: Array<Record<string, unknown>> }>) ?? [])
      .map((p) => ({ name: p.name, ...(p.description ? { description: p.description } : {}), parameters: (p.parameters ?? []).map(({ name, description, type, required, default: def, enum: values }) => ({ name, description, type, required, default: def, enum: values })) }));
    const p = page(all, limit ?? 20, cursor);
    if (!p) return fail(BAD_CURSOR);
    const lines = p.items.map((pb) => `- ${pb.name}${pb.description ? `: ${short(pb.description, 160)}` : ""}${pb.parameters.length ? `\n  params: ${pb.parameters.map((x) => `${String(x.name)}${x.required ? "*" : ""}`).join(", ")}` : ""}`);
    return ok(`${lines.join("\n") || "No playbooks."}${p.next_cursor ? `\n(more: cursor ${p.next_cursor})` : ""}`, p);
  });

  tool("missions", "polpo_playbook_run", {
    title: "Run a playbook",
    description: "Start a playbook (polpo_playbooks_list) with its parameters: it becomes a new mission that runs now. "
      + "A missing or invalid parameter is reported with the valid ones.",
    inputSchema: {
      name: z.string().min(1).describe("The playbook's name"),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Parameter values by name (required ones are marked * in the list)"),
    },
    outputSchema: { playbook: z.string(), result: z.unknown() },
    annotations: { ...WRITE, openWorldHint: true },
  }, async ({ name, params }) => {
    const res = await deps.api("POST", `/api/v1/playbooks/${enc(name)}/run`, { params: params ?? {} });
    const body = res.body as { ok?: boolean; data?: unknown; error?: string; details?: unknown } | null;
    if (res.status === 404) return fail(`There is no playbook "${name}". Find the name with polpo_playbooks_list.`);
    if (res.status >= 400 || body?.ok === false) return fail(`The playbook did not start: ${body?.error ?? `HTTP ${res.status}`}${body?.details ? ` (${JSON.stringify(body.details)})` : ""}. Fix the params and call again.`);
    const data = body?.data as { mission?: { id?: string; name?: string } } | undefined;
    return ok(`Started playbook ${name}${data?.mission?.id ? ` as mission ${data.mission.id}: follow it with polpo_mission_wait` : ""}.`, { playbook: name, result: body?.data });
  });
}
