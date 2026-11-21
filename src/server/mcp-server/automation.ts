/**
 * Automation: mission schedules (cron or a time; run now, pause, resume), recurring checks and
 * reminders (an agent or Polpo does something on a schedule and reports in a chat), and watchers
 * (act when a task reaches a status).
 */
import { z } from "zod";
import {
  BAD_CURSOR, DESTRUCTIVE, READ, UPDATE, WRITE, apiError, apiGet, apiSend, confirmParam, cursorParam, enc, fail, limitParam, looseObject,
  ok, page, pageOutput, qs, short,
  type McpDeps, type Register,
} from "./kit.js";
import { TASK_STATUSES, taskLine, unknownAgents } from "./tasks.js";

type Schedule = { id: string; missionId: string; expression: string; recurring: boolean; enabled: boolean; lastRunAt?: string; nextRunAt?: string; createdAt?: string };
type MissionRow = { id: string; name: string; status: string };

const scheduleItem = z.object({
  mission_id: z.string(), mission: z.string().optional(), expression: z.string(), recurring: z.boolean(), enabled: z.boolean(),
  last_run_at: z.string().optional(), next_run_at: z.string().optional(),
});
const scheduleView = (s: Schedule, missions: Map<string, MissionRow>) => ({
  mission_id: s.missionId, ...(missions.get(s.missionId) ? { mission: missions.get(s.missionId)!.name } : {}),
  expression: s.expression, recurring: s.recurring, enabled: s.enabled,
  ...(s.lastRunAt ? { last_run_at: s.lastRunAt } : {}), ...(s.nextRunAt ? { next_run_at: s.nextRunAt } : {}),
});
const scheduleLine = (s: ReturnType<typeof scheduleView>) => `- ${s.mission_id}${s.mission ? ` "${s.mission}"` : ""}: ${s.expression} (${s.recurring ? "recurring" : "once"}${s.enabled ? "" : ", paused"})`
  + `${s.next_run_at ? ` · next ${s.next_run_at.slice(0, 16).replace("T", " ")}` : ""}${s.last_run_at ? ` · last ${s.last_run_at.slice(0, 16).replace("T", " ")}` : ""}`;

async function loadSchedules(deps: McpDeps) {
  const [s, m] = await Promise.all([apiGet(deps, "/schedules"), apiGet(deps, "/missions")]);
  if (!s.ok) return s;
  const missions = new Map(((m.ok ? m.data as MissionRow[] : []) ?? []).map((x) => [x.id, x]));
  return { ok: true as const, schedules: (s.data as Schedule[]) ?? [], missions };
}

const noSchedule = (id: string) => fail(`Mission ${id} has no schedule. List them with polpo_schedules_list, or add one with polpo_schedule_create.`);

export function registerAutomationTools(tool: Register, deps: McpDeps): void {
  tool("automation", "polpo_schedules_list", {
    title: "List schedules",
    description: "Missions that run on a schedule: cron or time, recurring or once, paused or not, next and last run. "
      + "With mission_id, that schedule and the tasks of its runs (newest first).",
    inputSchema: {
      mission_id: z.string().optional().describe("One mission's schedule, with its recent runs"),
      enabled: z.boolean().optional().describe("true: only active ones; false: only paused ones"),
      limit: limitParam(30, 100),
      cursor: cursorParam(),
    },
    outputSchema: { ...pageOutput(scheduleItem), runs: z.array(looseObject).optional() },
    annotations: READ,
  }, async ({ mission_id, enabled, limit, cursor }) => {
    const r = await loadSchedules(deps);
    if (!r.ok) return apiError(r, "Listing schedules");
    if (mission_id) {
      const s = r.schedules.find((x) => x.missionId === mission_id);
      if (!s) return noSchedule(mission_id);
      const view = scheduleView(s, r.missions);
      const t = await apiGet(deps, `/tasks${qs({ slim: "true" })}`);
      const runs = (t.ok ? (t.data as Array<{ id: string; title: string; status: string; missionId?: string; assignTo?: string; updatedAt?: string }>) : [])
        .filter((x) => x.missionId === mission_id).sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")).slice(0, limit ?? 30);
      return ok(`${scheduleLine(view).slice(2)}\n${runs.length ? `recent tasks:\n${runs.map(taskLine).join("\n")}` : "No runs yet."}`,
        { items: [view], next_cursor: null, total: 1, runs: runs as Array<Record<string, unknown>> });
    }
    const all = r.schedules.filter((s) => enabled === undefined || s.enabled === enabled).map((s) => scheduleView(s, r.missions));
    const p = page(all, limit ?? 30, cursor);
    if (!p) return fail(BAD_CURSOR);
    return ok(`${p.items.map(scheduleLine).join("\n") || "No schedules."}${p.next_cursor ? `\n(more: cursor ${p.next_cursor})` : ""}`, p);
  });

  tool("automation", "polpo_schedule_create", {
    title: "Schedule a mission",
    description: "Run a mission on a schedule: a cron expression (e.g. '0 9 * * 1-5', recurring) or a time (ISO, once). "
      + "The mission must exist (polpo_mission_create with run: false makes one).",
    inputSchema: {
      mission_id: z.string().min(1).describe("The mission's id (polpo_missions_list)"),
      expression: z.string().min(1).describe("A cron expression (5 fields) or an ISO time for a single run"),
      recurring: z.boolean().optional().describe("true to run every time the cron matches (default: once)"),
      end_date: z.string().datetime({ offset: true }).optional().describe("Stop after this time (ISO)"),
    },
    outputSchema: { schedule: scheduleItem },
    annotations: WRITE,
  }, async ({ mission_id, expression, recurring, end_date }) => {
    const r = await apiSend(deps, "POST", "/schedules", { missionId: mission_id, expression, ...(recurring !== undefined ? { recurring } : {}), ...(end_date ? { endDate: end_date } : {}) });
    if (!r.ok) {
      if (r.status === 404) return fail(`There is no mission ${mission_id}. Find the id with polpo_missions_list.`);
      return apiError(r, `Scheduling mission ${mission_id}`, /expression|past/i.test(r.error) ? "Use a 5-field cron (e.g. '0 9 * * 1-5') or a future ISO time." : undefined);
    }
    const s = r.data as Schedule;
    const view = scheduleView(s, new Map());
    return ok(`Scheduled ${mission_id}: ${s.expression}${s.recurring ? " (recurring)" : ""}${s.nextRunAt ? `, next run ${s.nextRunAt}` : ""}.`, { schedule: view });
  });

  tool("automation", "polpo_schedule_update", {
    title: "Change a schedule",
    description: "Change a mission's schedule: its expression, recurring or not, end date; pause it (enabled: false) or resume it (enabled: true). "
      + "Only the fields given change.",
    inputSchema: {
      mission_id: z.string().min(1).describe("The mission's id"),
      expression: z.string().min(1).optional().describe("A new cron expression or ISO time"),
      recurring: z.boolean().optional().describe("Recurring or once"),
      enabled: z.boolean().optional().describe("false pauses it, true resumes it"),
      end_date: z.string().datetime({ offset: true }).nullable().optional().describe("Stop after this time; null removes the end"),
    },
    outputSchema: { schedule: scheduleItem, changed: z.array(z.string()) },
    annotations: UPDATE,
  }, async ({ mission_id, expression, recurring, enabled, end_date }) => {
    const body = { ...(expression !== undefined ? { expression } : {}), ...(recurring !== undefined ? { recurring } : {}), ...(enabled !== undefined ? { enabled } : {}), ...(end_date !== undefined ? { endDate: end_date } : {}) };
    if (Object.keys(body).length === 0) return fail("Nothing to change: give expression, recurring, enabled or end_date.");
    const before = await loadSchedules(deps);
    if (!before.ok) return apiError(before, "Listing schedules");
    const prev = before.schedules.find((s) => s.missionId === mission_id);
    if (!prev) return noSchedule(mission_id);
    const r = await apiSend(deps, "PATCH", `/schedules/${enc(mission_id)}`, body);
    if (!r.ok) return r.status === 404 ? noSchedule(mission_id) : apiError(r, `Updating the schedule of ${mission_id}`);
    const s = r.data as Schedule;
    const changed: string[] = (["expression", "recurring", "enabled"] as const).filter((k) => body[k] !== undefined && prev[k] !== s[k]);
    if (end_date !== undefined) changed.push("endDate");
    const view = scheduleView(s, before.missions);
    return ok(changed.length ? `Updated the schedule of ${mission_id}: ${changed.join(", ")}.${enabled === false ? " It is paused." : enabled === true ? " It is active." : ""}` : "Nothing changed (the values were the same).",
      { schedule: view, changed });
  });

  tool("automation", "polpo_schedule_delete", {
    title: "Remove a schedule",
    description: "Stop running a mission on a schedule (the mission stays, as a draft). Needs confirm: true.",
    inputSchema: { mission_id: z.string().min(1).describe("The mission's id"), confirm: confirmParam("remove the schedule") },
    outputSchema: { mission_id: z.string(), deleted: z.boolean() },
    annotations: DESTRUCTIVE,
  }, async ({ mission_id, confirm }) => {
    const before = await loadSchedules(deps);
    if (!before.ok) return apiError(before, "Listing schedules");
    const s = before.schedules.find((x) => x.missionId === mission_id);
    if (!s) return noSchedule(mission_id);
    if (confirm !== true) return fail(`Removing the schedule ${s.expression} of ${mission_id} stops its future runs: ask the person, then call again with confirm: true (polpo_schedule_update enabled: false only pauses it).`);
    const r = await apiSend(deps, "DELETE", `/schedules/${enc(mission_id)}`);
    if (!r.ok) return apiError(r, `Removing the schedule of ${mission_id}`);
    return ok(`Removed the schedule of ${mission_id}; the mission is a draft again.`, { mission_id, deleted: true });
  });

  tool("automation", "polpo_schedule_run", {
    title: "Run a scheduled mission now",
    description: "Run a scheduled mission now, out of turn; its next scheduled run stays as it is. Follow it with polpo_mission_wait.",
    inputSchema: { mission_id: z.string().min(1).describe("The mission's id") },
    outputSchema: { schedule: scheduleItem },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ mission_id }) => {
    const r = await apiSend(deps, "POST", `/schedules/${enc(mission_id)}/run`);
    if (!r.ok) return r.status === 404 ? noSchedule(mission_id) : apiError(r, `Running ${mission_id}`);
    const view = scheduleView(r.data as Schedule, new Map());
    return ok(`Started ${mission_id} now. Follow it with polpo_mission_wait { id: "${mission_id}" }.`, { schedule: view });
  });

  // ── Recurring checks and reminders ──

  type Check = {
    id: string; sessionId: string; agent?: string; prompt: string; message?: string; everyMinutes: number; cron?: string; timezone?: string;
    target?: { name?: string; chatId?: string }; state: string; nextRunAt: string; runs: number; lastRunAt?: string; lastReport?: string; lastError?: string;
    maxRuns?: number; endsAt?: string; why?: string;
  };
  const checkItem = z.object({
    id: z.string(), state: z.string(), agent: z.string().optional(), schedule: z.string(), what: z.string(), session_id: z.string(),
    to: z.string().optional(), next_run_at: z.string().optional(), runs: z.number().int(), last_report: z.string().optional(), last_error: z.string().optional(),
  });
  const checkView = (c: Check) => ({
    id: c.id, state: c.state, ...(c.agent ? { agent: c.agent } : {}),
    schedule: c.cron ? `cron ${c.cron}${c.timezone ? ` (${c.timezone})` : ""}` : c.everyMinutes > 0 ? `every ${c.everyMinutes} min` : "once",
    what: c.message ? `message: ${c.message}` : c.prompt, session_id: c.sessionId,
    ...(c.target ? { to: c.target.name ?? c.target.chatId } : {}),
    ...(c.state === "active" || c.state === "proposed" ? { next_run_at: c.nextRunAt } : {}), runs: c.runs,
    ...(c.lastReport ? { last_report: short(c.lastReport, 500) } : {}), ...(c.lastError ? { last_error: c.lastError } : {}),
  });
  const checkLine = (c: ReturnType<typeof checkView>) => `- ${c.id} [${c.state}] ${c.schedule}${c.agent ? ` by ${c.agent}` : ""}${c.to ? ` → ${c.to}` : ""}: ${short(c.what, 120)}`
    + `${c.next_run_at ? ` · next ${c.next_run_at.slice(0, 16).replace("T", " ")}` : ""} · ${c.runs} runs`;
  const notFoundCheck = (id: string) => fail(`There is no check ${id}. List them with polpo_checks_list.`);

  tool("automation", "polpo_checks_list", {
    title: "List recurring checks",
    description: "Recurring checks and reminders: what Polpo or an agent does on a schedule (every N minutes, a cron, or once) and reports in a chat. "
      + "Proposed ones are an agent's own plans waiting for a yes (polpo_check_update confirm: true).",
    inputSchema: {
      state: z.enum(["active", "proposed", "ended", "cancelled"]).optional().describe("Only checks in this state"),
      agent: z.string().optional().describe("Only this agent's checks"),
      session_id: z.string().optional().describe("Only the checks of this chat session"),
      limit: limitParam(30, 100),
      cursor: cursorParam(),
    },
    outputSchema: pageOutput(checkItem),
    annotations: READ,
  }, async ({ state, agent, session_id, limit, cursor }) => {
    const r = await apiGet(deps, `/checks${qs({ state, agent, session: session_id })}`);
    if (!r.ok) return apiError(r, "Listing checks");
    const p = page(((r.data as Check[]) ?? []).map(checkView), limit ?? 30, cursor);
    if (!p) return fail(BAD_CURSOR);
    return ok(`${p.items.map(checkLine).join("\n") || "No checks."}${p.next_cursor ? `\n(more: cursor ${p.next_cursor})` : ""}`, p);
  });

  tool("automation", "polpo_check_create", {
    title: "Create a recurring check",
    description: "Have Polpo or an agent do something on a schedule and report: instructions run at every time (runs with nothing to report stay silent), "
      + "or a fixed message (a reminder). When: every_minutes, a cron (in timezone), or once at a time. Reports go to a chat session "
      + "(a new one unless session_id) and, with to, a Telegram chat (polpo_channels_list lists them).",
    inputSchema: {
      agent: z.string().optional().describe("The agent that runs it (polpo_agents_list); omit for Polpo"),
      instructions: z.string().max(20_000).optional().describe("What to do at every run, e.g. 'check the open PRs and list the stale ones'"),
      message: z.string().max(20_000).optional().describe("Or: a message sent as it is (a reminder), without running the agent"),
      every_minutes: z.number().int().min(1).optional().describe("Run every N minutes"),
      cron: z.string().optional().describe("Or: a 5-field cron, e.g. '0 9 * * 1-5'"),
      timezone: z.string().optional().describe("IANA timezone of the cron or time, e.g. Europe/Rome"),
      at: z.string().optional().describe("The first (or only) run: ISO, or a local time like 2026-10-14T09:00 in timezone"),
      to: z.string().optional().describe("A Telegram group, topic or person (name or id) to post the reports to"),
      session_id: z.string().optional().describe("The chat session the reports are added to (default: a new one)"),
      max_runs: z.number().int().min(1).optional().describe("Stop after this many runs"),
      ends_at: z.string().optional().describe("Stop after this time (ISO)"),
    },
    outputSchema: { check: checkItem },
    annotations: WRITE,
  }, async ({ agent, instructions, message, every_minutes, cron, timezone, at, to, session_id, max_runs, ends_at }) => {
    if (!instructions?.trim() && !message?.trim()) return fail("Give instructions (what to do at every run) or message (a reminder to send).");
    if (!every_minutes && !cron && !at) return fail("Say when it runs: every_minutes, cron, or at (once).");
    const missing = await unknownAgents(deps, [agent]);
    if (missing) return fail(missing);
    const r = await apiSend(deps, "POST", "/checks", {
      ...(agent ? { agent } : {}), ...(instructions ? { prompt: instructions } : {}), ...(message ? { message } : {}),
      ...(every_minutes ? { everyMinutes: every_minutes } : {}), ...(cron ? { cron } : {}), ...(timezone ? { timezone } : {}), ...(at ? { at } : {}),
      ...(to ? { to } : {}), ...(session_id ? { sessionId: session_id } : {}), ...(max_runs ? { maxRuns: max_runs } : {}), ...(ends_at ? { endsAt: ends_at } : {}),
      createdBy: deps.principal?.actor ?? "mcp",
    });
    if (!r.ok) return apiError(r, "Creating the check", r.status === 404 ? "Check the session_id with polpo_chat_sessions_list." : undefined);
    const c = checkView(r.data as Check);
    return ok(`Created check ${c.id}: ${c.schedule}${c.next_run_at ? `, first run ${c.next_run_at}` : ""}. Reports go to chat session ${c.session_id}${c.to ? ` and ${c.to}` : ""}.`, { check: c });
  });

  tool("automation", "polpo_check_update", {
    title: "Change a recurring check",
    description: "Change an active or proposed check: its instructions or message, its schedule (every_minutes or cron: the next run is computed again), "
      + "its limits; confirm: true says yes to a proposed one (it starts running). Only the fields given change.",
    inputSchema: {
      id: z.string().min(1).describe("The check's id"),
      instructions: z.string().min(1).max(20_000).optional().describe("New instructions"),
      message: z.string().max(20_000).nullable().optional().describe("A new fixed message; null to run the instructions instead"),
      every_minutes: z.number().int().min(1).optional().describe("Run every N minutes (replaces a cron)"),
      cron: z.string().nullable().optional().describe("A new cron; null to go back to every_minutes"),
      timezone: z.string().nullable().optional().describe("The cron's timezone"),
      max_runs: z.number().int().min(1).nullable().optional().describe("Stop after this many runs; null for no limit"),
      ends_at: z.string().nullable().optional().describe("Stop after this time; null for no end"),
      confirm: z.boolean().optional().describe("true: say yes to a proposed check, after the person agreed"),
    },
    outputSchema: { check: checkItem },
    annotations: UPDATE,
  }, async ({ id, instructions, message, every_minutes, cron, timezone, max_runs, ends_at, confirm }) => {
    const body = {
      ...(instructions !== undefined ? { prompt: instructions } : {}), ...(message !== undefined ? { message } : {}),
      ...(every_minutes !== undefined ? { everyMinutes: every_minutes, ...(cron === undefined ? { cron: null } : {}) } : {}),
      ...(cron !== undefined ? { cron } : {}), ...(timezone !== undefined ? { timezone } : {}),
      ...(max_runs !== undefined ? { maxRuns: max_runs } : {}), ...(ends_at !== undefined ? { endsAt: ends_at } : {}), ...(confirm ? { confirm: true } : {}),
    };
    if (Object.keys(body).length === 0) return fail("Nothing to change: give instructions, message, every_minutes, cron, timezone, max_runs, ends_at or confirm.");
    const r = await apiSend(deps, "PATCH", `/checks/${enc(id)}`, body);
    if (!r.ok) return r.status === 404 ? notFoundCheck(id) : apiError(r, `Updating check ${id}`);
    const c = checkView(r.data as Check);
    return ok(`Updated check ${c.id} [${c.state}]: ${c.schedule}${c.next_run_at ? `, next run ${c.next_run_at}` : ""}.`, { check: c });
  });

  tool("automation", "polpo_check_cancel", {
    title: "Cancel a recurring check",
    description: "Stop a check or reminder for good, or drop a proposed one. It cannot be resumed (create a new one). Needs confirm: true.",
    inputSchema: { id: z.string().min(1).describe("The check's id"), confirm: confirmParam("cancel the check") },
    outputSchema: { check: checkItem },
    annotations: DESTRUCTIVE,
  }, async ({ id, confirm }) => {
    if (confirm !== true) {
      const all = await apiGet(deps, "/checks");
      const c = all.ok ? ((all.data as Check[]) ?? []).find((x) => x.id === id) : undefined;
      if (all.ok && !c) return notFoundCheck(id);
      return fail(`Cancelling ${c ? `"${short(c.message ?? c.prompt, 80)}"` : id} stops it for good: ask the person, then call again with confirm: true.`);
    }
    const r = await apiSend(deps, "DELETE", `/checks/${enc(id)}`);
    if (!r.ok) return r.status === 404 ? notFoundCheck(id) : apiError(r, `Cancelling check ${id}`);
    const c = checkView(r.data as Check);
    return ok(`Check ${id} is ${c.state}.`, { check: c });
  });
}

// ── Watchers ──

type Watcher = { id: string; taskId: string; targetStatus: string; action: { type: string; [k: string]: unknown }; fired: boolean; createdAt?: string; firedAt?: string };

export function registerWatcherTools(tool: Register, deps: McpDeps): void {
  const watcherItem = z.object({ id: z.string(), task_id: z.string(), target_status: z.string(), action: looseObject, fired: z.boolean(), fired_at: z.string().optional() });
  const view = (w: Watcher) => ({ id: w.id, task_id: w.taskId, target_status: w.targetStatus, action: w.action, fired: w.fired, ...(w.firedAt ? { fired_at: w.firedAt } : {}) });
  const describeAction = (a: Watcher["action"]) => a.type === "create_task" ? `create task "${String(a.title)}" for ${String(a.assignTo)}`
    : a.type === "execute_mission" ? `run mission ${String(a.missionId)}` : a.type === "send_notification" ? `notify ${String(a.channel)}: ${String(a.title)}` : a.type;

  tool("watchers", "polpo_watchers_list", {
    title: "List watchers",
    description: "Watchers: when a task reaches a status, they create a task, run a mission or send a notification (once).",
    inputSchema: { active: z.boolean().optional().describe("true: only those that have not fired yet") },
    outputSchema: { items: z.array(watcherItem) },
    annotations: READ,
  }, async ({ active }) => {
    const r = await apiGet(deps, `/watchers${active ? "?active=true" : ""}`);
    if (!r.ok) return apiError(r, "Listing watchers");
    const items = ((r.data as Watcher[]) ?? []).map(view);
    return ok(items.map((w) => `- ${w.id}: when ${w.task_id} is ${w.target_status} → ${describeAction(w.action as Watcher["action"])}${w.fired ? " (fired)" : ""}`).join("\n") || "No watchers.", { items });
  });

  tool("watchers", "polpo_watcher_create", {
    title: "Create a watcher",
    description: "When a task reaches a status, do something once: create a task (create_task), run a mission (execute_mission) or send a notification "
      + "on a channel (send_notification).",
    inputSchema: {
      task_id: z.string().min(1).describe("The task to watch (polpo_tasks_list)"),
      target_status: z.enum(TASK_STATUSES).describe("The status that sets it off"),
      action: z.discriminatedUnion("type", [
        z.object({ type: z.literal("create_task"), title: z.string().min(1), description: z.string().min(1), assignTo: z.string().min(1) }),
        z.object({ type: z.literal("execute_mission"), missionId: z.string().min(1) }),
        z.object({ type: z.literal("send_notification"), channel: z.string().min(1), title: z.string().min(1), body: z.string().min(1), severity: z.enum(["info", "warning", "critical"]).optional() }),
      ]).describe("What to do"),
    },
    outputSchema: { watcher: watcherItem },
    annotations: WRITE,
  }, async ({ task_id, target_status, action }) => {
    if (action.type === "create_task") {
      const missing = await unknownAgents(deps, [action.assignTo]);
      if (missing) return fail(missing);
    }
    const r = await apiSend(deps, "POST", "/watchers", { taskId: task_id, targetStatus: target_status, action });
    if (!r.ok) return apiError(r, "Creating the watcher", /not found/i.test(r.error) ? "Check the task id with polpo_tasks_list." : undefined);
    const w = view(r.data as Watcher);
    return ok(`Created watcher ${w.id}: when ${task_id} is ${target_status} → ${describeAction(action as Watcher["action"])}.`, { watcher: w });
  });

  tool("watchers", "polpo_watcher_delete", {
    title: "Delete a watcher",
    description: "Delete a watcher so it does not fire. Needs confirm: true.",
    inputSchema: { id: z.string().min(1).describe("The watcher's id"), confirm: confirmParam("delete the watcher") },
    outputSchema: { id: z.string(), deleted: z.boolean() },
    annotations: DESTRUCTIVE,
  }, async ({ id, confirm }) => {
    if (confirm !== true) return fail(`Deleting watcher ${id} means it will not fire: ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "DELETE", `/watchers/${enc(id)}`);
    if (!r.ok) return r.status === 404 ? fail(`There is no watcher ${id}. List them with polpo_watchers_list.`) : apiError(r, `Deleting watcher ${id}`);
    return ok(`Deleted watcher ${id}.`, { id, deleted: true });
  });
}
