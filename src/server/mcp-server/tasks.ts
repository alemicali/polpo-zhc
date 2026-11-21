/**
 * Tasks: list, read, create, update, retry, kill, direct, wait for and read the activity of.
 */
import { z } from "zod";
import {
  BAD_CURSOR, DESTRUCTIVE, MAX_WAIT_SECONDS, READ, UPDATE, WRITE, apiError, apiGet, apiSend, confirmParam, cursorParam, decodeCursor,
  encodeCursor, enc, fail, limitParam, looseObject, ok, pageOutput, progress, qs, short, sleep,
  type McpDeps, type Register,
} from "./kit.js";

export const TASK_STATUSES = ["draft", "pending", "awaiting_approval", "assigned", "in_progress", "review", "done", "failed"] as const;
type TaskStatus = (typeof TASK_STATUSES)[number];
/** Where a task waits for someone or is finished: what polpo_task_wait waits for by default. */
const SETTLED: TaskStatus[] = ["done", "failed", "review", "awaiting_approval"];

export const taskSummary = z.object({
  id: z.string(), title: z.string(), status: z.string(), assignTo: z.string().optional(),
  group: z.string().optional(), missionId: z.string().optional(), updatedAt: z.string().optional(),
}).passthrough();

type TaskRow = { id: string; title: string; status: string; assignTo?: string; group?: string; missionId?: string; updatedAt?: string; phase?: string };
type FullTask = TaskRow & {
  description?: string; dependsOn?: string[]; retries?: number; maxRetries?: number; createdAt?: string;
  result?: { exitCode?: number; duration?: number; stdout?: string; stderr?: string; assessment?: { passed?: boolean; globalScore?: number; feedback?: string } };
  outcomes?: Array<{ type?: string; label?: string; path?: string; url?: string; text?: string }>;
  sideEffects?: boolean;
};

export const taskLine = (t: TaskRow) => `- ${t.id} [${t.status}] ${short(t.title, 100)}${t.assignTo ? ` → ${t.assignTo}` : ""}${t.group ? ` (${t.group})` : ""}`;

const summarize = (t: TaskRow) => ({
  id: t.id, title: t.title, status: t.status,
  ...(t.assignTo ? { assignTo: t.assignTo } : {}), ...(t.group ? { group: t.group } : {}),
  ...(t.missionId ? { missionId: t.missionId } : {}), ...(t.updatedAt ? { updatedAt: t.updatedAt } : {}),
  ...(t.phase ? { phase: t.phase } : {}),
});

/** One activity entry of a run log as a line. */
function activityLine(e: Record<string, unknown>): string {
  const ts = typeof e.ts === "string" ? e.ts.slice(11, 19) : typeof e.timestamp === "string" ? (e.timestamp as string).slice(11, 19) : "";
  const type = String(e.type ?? e.event ?? "entry");
  const body = e.type === "tool_use" ? `${String(e.name ?? e.tool ?? "tool")} ${short(JSON.stringify(e.input ?? {}), 160)}`
    : short(e.text ?? e.content ?? e.message ?? e.summary ?? e.result ?? e.output ?? "", 240);
  return `${ts ? `${ts} ` : ""}${type}${body ? `: ${body}` : ""}`;
}

async function loadTask(deps: McpDeps, id: string): Promise<{ ok: true; task: FullTask } | { ok: false; status: number; error: string }> {
  const r = await apiGet(deps, `/tasks/${enc(id)}`);
  return r.ok ? { ok: true, task: r.data as FullTask } : r;
}

const notFound = (id: string) => fail(`There is no task ${id}. Find the id with polpo_tasks_list.`);

/** An error when an agent does not exist (with the names), else null. */
export async function unknownAgents(deps: McpDeps, names: Array<string | undefined>): Promise<string | null> {
  const wanted = [...new Set(names.filter((n): n is string => !!n))];
  if (wanted.length === 0) return null;
  const r = await apiGet(deps, "/agents");
  if (!r.ok) return null; // the API decides
  const known = new Set(((r.data as Array<{ name: string }>) ?? []).map((a) => a.name));
  const missing = wanted.filter((n) => !known.has(n));
  return missing.length ? `No agent ${missing.map((m) => `"${m}"`).join(", ")}. Agents: ${[...known].join(", ") || "none"}.` : null;
}

export function registerTaskTools(tool: Register, deps: McpDeps): void {
  tool("tasks", "polpo_tasks_list", {
    title: "List tasks",
    description: "Tasks, most recently updated first: id, title, status, agent, mission. Filter by status, agent, mission or words; "
      + "page with cursor. Use polpo_task_get for one task in full.",
    inputSchema: {
      status: z.enum(TASK_STATUSES).optional().describe("Only tasks in this status"),
      agent: z.string().optional().describe("Only tasks assigned to this agent"),
      mission_id: z.string().optional().describe("Only the tasks of this mission (polpo_missions_list)"),
      group: z.string().optional().describe("Only tasks of this group (a mission's tasks are grouped by its name)"),
      text: z.string().optional().describe("Words in the title or description"),
      limit: limitParam(20, 100),
      cursor: cursorParam(),
    },
    outputSchema: pageOutput(taskSummary),
    annotations: READ,
  }, async ({ status, agent, mission_id, group, text, limit, cursor }) => {
    const c = decodeCursor(cursor);
    if (!c) return fail(BAD_CURSOR);
    const n = limit ?? 20;
    // a mission's tasks: all of them (one mission's runs), filtered here
    if (mission_id) {
      const r = await apiGet(deps, `/tasks${qs({ slim: "true", status, assignTo: agent })}`);
      if (!r.ok) return apiError(r, "Listing tasks");
      const words = (text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const all = ((r.data as TaskRow[]) ?? [])
        .filter((t) => t.missionId === mission_id && (!group || t.group === group) && words.every((w) => t.title.toLowerCase().includes(w)))
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
      const start = c.o ?? 0;
      const items = all.slice(start, start + n).map(summarize);
      const next = start + n < all.length ? encodeCursor({ o: start + n }) : null;
      return ok(`${items.map(taskLine).join("\n") || `No tasks for mission ${mission_id}.`}${next ? `\n(more: cursor ${next})` : ""}`, { items, next_cursor: next, total: all.length });
    }
    const r = await apiGet(deps, `/tasks${qs({ slim: "true", status, assignTo: agent, group, limit: n, ...(text ? { q: text } : { cursor: c.u }) })}`);
    if (!r.ok) return apiError(r, "Listing tasks");
    const data = r.data as { tasks?: TaskRow[]; nextCursor?: string | null; hasMore?: boolean };
    const items = (data.tasks ?? []).map(summarize);
    const next = !text && data.hasMore && data.nextCursor ? encodeCursor({ u: data.nextCursor }) : null;
    return ok(`${items.map(taskLine).join("\n") || "No tasks match."}${next ? `\n(more: cursor ${next})` : ""}`, { items, next_cursor: next });
  });

  tool("tasks", "polpo_task_get", {
    title: "Get a task",
    description: "One task in full: description, status, agent, dependencies, retries, result (exit code, duration, assessment), outcomes, "
      + "timestamps and the last entries of its activity. Use polpo_task_logs for more activity.",
    inputSchema: {
      id: z.string().min(1).describe("The task's id (polpo_tasks_list)"),
      activity: z.number().int().min(0).max(50).optional().describe("How many recent activity entries to include (default 10, 0 for none)"),
    },
    outputSchema: { task: looseObject, recent_activity: z.array(looseObject).optional() },
    annotations: READ,
  }, async ({ id, activity }) => {
    const loaded = await loadTask(deps, id);
    if (!loaded.ok) return loaded.status === 404 ? notFound(id) : apiError(loaded, `Reading task ${id}`);
    const t = loaded.task;
    const n = activity ?? 10;
    let recent: Array<Record<string, unknown>> = [];
    if (n > 0) {
      const a = await apiGet(deps, `/agents/processes/${enc(id)}/activity`);
      if (a.ok && Array.isArray(a.data)) recent = (a.data as Array<Record<string, unknown>>).slice(-n);
    }
    const res = t.result;
    const lines = [
      `${t.id} [${t.status}${t.phase ? `/${t.phase}` : ""}] ${t.title}`,
      `agent: ${t.assignTo ?? "-"}${t.group ? ` · group: ${t.group}` : ""}${t.missionId ? ` · mission: ${t.missionId}` : ""}`,
      `retries: ${t.retries ?? 0}/${t.maxRetries ?? "-"}${t.dependsOn?.length ? ` · depends on: ${t.dependsOn.join(", ")}` : ""}${t.sideEffects ? " · side effects" : ""}`,
      `created ${t.createdAt ?? "?"} · updated ${t.updatedAt ?? "?"}`,
      "",
      short(t.description, 2000),
      ...(res ? ["", `result: exit ${res.exitCode ?? "?"}${res.duration !== undefined ? `, ${Math.round(res.duration / 1000)} s` : ""}`
        + `${res.assessment ? ` · assessment: ${res.assessment.passed ? "passed" : "not passed"}${res.assessment.globalScore !== undefined ? ` (${res.assessment.globalScore})` : ""}` : ""}`,
      ...(res.assessment?.feedback ? [`feedback: ${short(res.assessment.feedback, 600)}`] : []),
      ...(res.stdout ? [`output: ${short(res.stdout, 1500)}`] : [])] : []),
      ...(t.outcomes?.length ? ["", "outcomes:", ...t.outcomes.map((o) => `- ${o.type ?? "?"}: ${o.label ?? ""} ${o.path ?? o.url ?? short(o.text, 120)}`)] : []),
      ...(recent.length ? ["", "recent activity:", ...recent.map(activityLine)] : []),
    ];
    return ok(lines.join("\n"), { task: t as Record<string, unknown>, ...(n > 0 ? { recent_activity: recent } : {}) });
  });

  tool("tasks", "polpo_task_create", {
    title: "Create a task",
    description: "Give an agent a task: it runs on its own and is assessed when done (follow it with polpo_task_wait or polpo_task_get). "
      + "Each call creates a new task; a task with the same title among active ones is refused. For several related tasks, prefer polpo_mission_create.",
    inputSchema: {
      title: z.string().min(1).describe("Short title, unique among active tasks"),
      description: z.string().min(1).describe("What to do and what a good result looks like"),
      assignTo: z.string().min(1).describe("The agent that does it (polpo_agents_list)"),
      dependsOn: z.array(z.string()).optional().describe("Ids of tasks that must finish first"),
      group: z.string().optional().describe("A group name to keep related tasks together"),
      expectations: z.array(z.record(z.string(), z.unknown())).optional()
        .describe("How the result is checked, e.g. [{ type: 'llm_review', criteria: '…' }], [{ type: 'file_exists', paths: ['out.md'] }], [{ type: 'test', command: 'npm test' }]"),
      max_retries: z.number().int().min(0).max(10).optional().describe("Retries after a failure (default the project's setting)"),
      max_duration_minutes: z.number().positive().max(24 * 60).optional().describe("Stop it after this many minutes"),
      side_effects: z.boolean().optional().describe("true if it does something irreversible (sends, pays, deletes): it is then never retried automatically"),
      draft: z.boolean().optional().describe("true to create it without starting it (polpo_task_update with start: true starts it)"),
    },
    outputSchema: { task: looseObject },
    annotations: WRITE,
  }, async ({ max_retries, max_duration_minutes, side_effects, ...rest }) => {
    const missing = await unknownAgents(deps, [rest.assignTo]);
    if (missing) return fail(missing);
    const r = await apiSend(deps, "POST", "/tasks", {
      ...rest,
      ...(max_retries !== undefined ? { maxRetries: max_retries } : {}),
      ...(max_duration_minutes !== undefined ? { maxDuration: Math.round(max_duration_minutes * 60_000) } : {}),
      ...(side_effects !== undefined ? { sideEffects: side_effects } : {}),
    });
    if (!r.ok) {
      if (r.status === 409) return fail(`${r.error}: give it another title, or use the existing task (polpo_tasks_list with text).`);
      if (/agent/i.test(r.error)) return apiError(r, "Creating the task", "Check the agent's name with polpo_agents_list.");
      return apiError(r, "Creating the task");
    }
    const t = r.data as FullTask;
    return ok(`Created task ${t.id} [${t.status}] ${t.title} → ${t.assignTo}. Follow it with polpo_task_wait.`, { task: r.data as Record<string, unknown> });
  });

  tool("tasks", "polpo_task_update", {
    title: "Update a task",
    description: "Change a task's description, agent, retries or side-effects flag, or start a draft. Only the fields given change; "
      + "the result lists what changed. A running task keeps its current run: use polpo_task_direct to steer it.",
    inputSchema: {
      id: z.string().min(1).describe("The task's id"),
      description: z.string().min(1).optional().describe("The new description"),
      assignTo: z.string().min(1).optional().describe("Another agent (polpo_agents_list)"),
      max_retries: z.number().int().min(0).max(10).optional().describe("Retries after a failure"),
      side_effects: z.boolean().optional().describe("Whether it does something irreversible"),
      start: z.boolean().optional().describe("true to start a draft task (it becomes pending)"),
    },
    outputSchema: { task: looseObject, changed: z.array(z.string()) },
    annotations: UPDATE,
  }, async ({ id, description, assignTo, max_retries, side_effects, start }) => {
    const before = await loadTask(deps, id);
    if (!before.ok) return before.status === 404 ? notFound(id) : apiError(before, `Reading task ${id}`);
    if (start && before.task.status !== "draft") return fail(`Task ${id} is ${before.task.status}, not a draft: only drafts can be started (polpo_task_retry runs a failed one again).`);
    const body = {
      ...(description !== undefined ? { description } : {}),
      ...(assignTo !== undefined ? { assignTo } : {}),
      ...(max_retries !== undefined ? { maxRetries: max_retries } : {}),
      ...(side_effects !== undefined ? { sideEffects: side_effects } : {}),
      ...(start ? { status: "pending" } : {}),
    };
    if (Object.keys(body).length === 0) return fail("Nothing to change: give at least one of description, assignTo, max_retries, side_effects, start.");
    const missing = await unknownAgents(deps, [assignTo]);
    if (missing) return fail(missing);
    const r = await apiSend(deps, "PATCH", `/tasks/${enc(id)}`, body);
    if (!r.ok) return apiError(r, `Updating task ${id}`, /agent/i.test(r.error) ? "Check the agent's name with polpo_agents_list." : undefined);
    const after = (r.data ?? {}) as FullTask;
    const fields: Array<[string, unknown, unknown]> = [
      ["description", before.task.description, after.description], ["assignTo", before.task.assignTo, after.assignTo],
      ["maxRetries", before.task.maxRetries, after.maxRetries], ["sideEffects", before.task.sideEffects, after.sideEffects],
      ["status", before.task.status, after.status],
    ];
    const changed = fields.filter(([, a, b]) => b !== undefined && JSON.stringify(a) !== JSON.stringify(b)).map(([k]) => k);
    return ok(changed.length ? `Updated ${id}: ${changed.join(", ")}.` : `Nothing changed on ${id} (the values were the same).`, { task: after as Record<string, unknown>, changed });
  });

  tool("tasks", "polpo_task_retry", {
    title: "Retry a task",
    description: "Run a failed task again (it goes back to pending and an agent picks it up). Only failed tasks can be retried; "
      + "change the description or agent first with polpo_task_update if the failure needs it.",
    inputSchema: { id: z.string().min(1).describe("The failed task's id") },
    outputSchema: { id: z.string(), status: z.string() },
    annotations: WRITE,
  }, async ({ id }) => {
    const t = await loadTask(deps, id);
    if (!t.ok) return t.status === 404 ? notFound(id) : apiError(t, `Reading task ${id}`);
    if (t.task.status !== "failed") return fail(`Task ${id} is ${t.task.status}: only failed tasks can be retried${t.task.status === "in_progress" ? " (polpo_task_direct steers a running one)" : ""}.`);
    const r = await apiSend(deps, "POST", `/tasks/${enc(id)}/retry`);
    if (!r.ok) return apiError(r, `Retrying ${id}`);
    return ok(`Task ${id} is pending again: follow it with polpo_task_wait.`, { id, status: "pending" });
  });

  tool("tasks", "polpo_task_kill", {
    title: "Stop a task",
    description: "Stop a running or waiting task: its agent's run is ended and the task fails. It cannot be undone (polpo_task_retry starts it over). "
      + "Needs confirm: true after the person agreed.",
    inputSchema: {
      id: z.string().min(1).describe("The task's id"),
      confirm: confirmParam("stop the task"),
    },
    outputSchema: { id: z.string(), killed: z.boolean(), previous_status: z.string() },
    annotations: DESTRUCTIVE,
  }, async ({ id, confirm }) => {
    const t = await loadTask(deps, id);
    if (!t.ok) return t.status === 404 ? notFound(id) : apiError(t, `Reading task ${id}`);
    if (t.task.status === "done" || t.task.status === "failed") return fail(`Task ${id} is already ${t.task.status}: there is nothing to stop.`);
    if (confirm !== true) return fail(`Stopping "${t.task.title}" (${t.task.status}, ${t.task.assignTo}) ends its run and fails it: ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "POST", `/tasks/${enc(id)}/kill`);
    if (!r.ok) return apiError(r, `Stopping ${id}`);
    return ok(`Stopped task ${id} (was ${t.task.status}).`, { id, killed: true, previous_status: t.task.status });
  });

  tool("tasks", "polpo_task_direct", {
    title: "Send a direction to a task",
    description: "Tell a task's agent something: steer a running task (it reads it at its next step), add a follow-up, or continue a finished one "
      + "with a new instruction. mode auto picks the right one from the task's state.",
    inputSchema: {
      id: z.string().min(1).describe("The task's id"),
      message: z.string().min(1).max(8000).describe("The direction, as you would tell the agent"),
      mode: z.enum(["auto", "steer", "follow_up", "continue"]).optional().describe("auto (default), steer a running task, follow_up after the current step, continue a finished task"),
      confirm_side_effects: z.boolean().optional().describe("For a task with side effects: true to allow continuing it, after the person agreed"),
    },
    outputSchema: { action: z.string(), direction: looseObject },
    annotations: WRITE,
  }, async ({ id, message, mode, confirm_side_effects }) => {
    const r = await apiSend(deps, "POST", `/tasks/${enc(id)}/directions`, { message, mode: mode ?? "auto", ...(confirm_side_effects !== undefined ? { confirmSideEffects: confirm_side_effects } : {}) });
    if (!r.ok) {
      if (r.status === 404) return notFound(id);
      if (r.status === 409) return fail(`The task cannot take this direction now: ${r.error}.${/side.?effect/i.test(r.error) ? " Ask the person, then call again with confirm_side_effects: true." : " Check its status with polpo_task_get."}`);
      return apiError(r, `Sending the direction to ${id}`);
    }
    const d = r.data as { action: string; direction: Record<string, unknown> };
    return ok(`Direction sent to ${id} (${d.action}).`, { action: d.action, direction: d.direction });
  });

  tool("tasks", "polpo_task_wait", {
    title: "Wait for a task",
    description: `Wait until a task reaches one of the given statuses (default: done, failed, review or awaiting_approval) or the timeout passes `
      + `(at most ${MAX_WAIT_SECONDS} s), then return its state. If it timed out, call again to keep waiting. Sends progress notifications when the client asks.`,
    inputSchema: {
      id: z.string().min(1).describe("The task's id"),
      until: z.array(z.enum(TASK_STATUSES)).min(1).optional().describe("Statuses to wait for (default done, failed, review, awaiting_approval)"),
      timeout_seconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).optional().describe(`How long to wait at most (default 30, max ${MAX_WAIT_SECONDS})`),
    },
    outputSchema: { task: taskSummary, reached: z.boolean(), timed_out: z.boolean(), waited_seconds: z.number() },
    annotations: READ,
  }, async ({ id, until, timeout_seconds }, extra) => {
    const targets = new Set<string>(until ?? SETTLED);
    const timeout = (timeout_seconds ?? 30) * 1000;
    const started = Date.now();
    const interval = deps.pollIntervalMs ?? 1000;
    let last: string | undefined;
    for (;;) {
      const t = await loadTask(deps, id);
      if (!t.ok) return t.status === 404 ? notFound(id) : apiError(t, `Reading task ${id}`);
      const s = t.task.status;
      const waited = Math.round((Date.now() - started) / 100) / 10;
      if (s !== last) { await progress(extra, waited, timeout / 1000, `${id}: ${s}`); last = s; }
      const reached = targets.has(s);
      if (reached || Date.now() - started >= timeout || extra.signal.aborted) {
        const out = { task: summarize(t.task), reached, timed_out: !reached, waited_seconds: waited };
        return ok(reached
          ? `Task ${id} is ${s} (after ${waited} s).${s === "failed" ? " polpo_task_get shows why; polpo_task_retry runs it again." : ""}`
          : `Task ${id} is still ${s} after ${waited} s: call polpo_task_wait again to keep waiting.`, out);
      }
      await sleep(Math.min(interval, Math.max(0, timeout - (Date.now() - started))), extra.signal);
    }
  });

  tool("tasks", "polpo_task_logs", {
    title: "Read a task's activity",
    description: "The activity of a task's runs (what its agent did: messages, tool calls, results), newest last. Returns the latest entries; "
      + "page backwards to older ones with cursor.",
    inputSchema: {
      id: z.string().min(1).describe("The task's id"),
      limit: limitParam(30, 200),
      cursor: cursorParam(),
    },
    outputSchema: { ...pageOutput(looseObject) },
    annotations: READ,
  }, async ({ id, limit, cursor }) => {
    const c = decodeCursor(cursor);
    if (!c) return fail(BAD_CURSOR);
    const r = await apiGet(deps, `/agents/processes/${enc(id)}/activity`);
    if (!r.ok) return apiError(r, `Reading the activity of ${id}`);
    const all = (Array.isArray(r.data) ? r.data : []) as Array<Record<string, unknown>>;
    if (all.length === 0) {
      const t = await loadTask(deps, id);
      if (!t.ok && t.status === 404) return notFound(id);
      return ok(`No activity yet for ${id}.`, { items: [], next_cursor: null, total: 0 });
    }
    const n = limit ?? 30;
    // cursor.o = how many of the newest entries were already returned
    const skip = c.o ?? 0;
    const end = Math.max(0, all.length - skip);
    const start = Math.max(0, end - n);
    const items = all.slice(start, end);
    const next = start > 0 ? encodeCursor({ o: all.length - start }) : null;
    return ok(`${items.map(activityLine).join("\n")}${next ? `\n(older entries: cursor ${next})` : ""}`, { items, next_cursor: next, total: all.length });
  });
}
