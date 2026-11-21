/**
 * Tasks: list, read and create.
 */
import { z } from "zod";
import {
  BAD_CURSOR, READ, WRITE, apiError, apiGet, apiSend, cursorParam, decodeCursor, encodeCursor, enc, fail, limitParam, looseObject,
  ok, pageOutput, qs, short,
  type McpDeps, type Register,
} from "./kit.js";

export const TASK_STATUSES = ["draft", "pending", "awaiting_approval", "assigned", "in_progress", "review", "done", "failed"] as const;

export const taskSummary = z.object({
  id: z.string(), title: z.string(), status: z.string(), assignTo: z.string().optional(),
  group: z.string().optional(), missionId: z.string().optional(), updatedAt: z.string().optional(),
}).passthrough();

type TaskRow = { id: string; title: string; status: string; assignTo?: string; group?: string; missionId?: string; updatedAt?: string };

export const taskLine = (t: TaskRow) => `- ${t.id} [${t.status}] ${short(t.title, 100)}${t.assignTo ? ` → ${t.assignTo}` : ""}${t.group ? ` (${t.group})` : ""}`;

export function registerTaskTools(tool: Register, deps: McpDeps): void {
  tool("tasks", "polpo_tasks_list", {
    title: "List tasks",
    description: "Tasks, most recently updated first: id, title, status, agent, mission. Filter by status, agent or words; "
      + "page with cursor. polpo_task_get reads one in full.",
    inputSchema: {
      status: z.enum(TASK_STATUSES).optional().describe("Only tasks in this status"),
      agent: z.string().optional().describe("Only tasks assigned to this agent"),
      text: z.string().optional().describe("Words in the title or description"),
      limit: limitParam(20, 100),
      cursor: cursorParam(),
    },
    outputSchema: pageOutput(taskSummary),
    annotations: READ,
  }, async ({ status, agent, text, limit, cursor }) => {
    const c = decodeCursor(cursor);
    if (!c) return fail(BAD_CURSOR);
    const n = limit ?? 20;
    const r = await apiGet(deps, `/tasks${qs({ slim: "true", status, assignTo: agent, limit: n, ...(text ? { q: text } : { cursor: c.u }) })}`);
    if (!r.ok) return apiError(r, "Listing tasks");
    const data = r.data as { tasks?: TaskRow[]; nextCursor?: string | null; hasMore?: boolean };
    const items = (data.tasks ?? []).map((t) => ({ id: t.id, title: t.title, status: t.status, assignTo: t.assignTo, group: t.group, missionId: t.missionId, updatedAt: t.updatedAt }));
    const next = !text && data.hasMore && data.nextCursor ? encodeCursor({ u: data.nextCursor }) : null;
    return ok(`${items.map(taskLine).join("\n") || "No tasks match."}${next ? `\n(more: cursor ${next})` : ""}`, { items, next_cursor: next });
  });

  tool("tasks", "polpo_task_get", {
    title: "Get a task",
    description: "A task in full: description, status, agent, dependencies, result and assessment, timestamps.",
    inputSchema: { id: z.string().min(1).describe("The task's id (polpo_tasks_list)") },
    outputSchema: { task: looseObject },
    annotations: READ,
  }, async ({ id }) => {
    const r = await apiGet(deps, `/tasks/${enc(id)}`);
    if (!r.ok) return apiError(r, `Reading task ${id}`, r.status === 404 ? "Check the id with polpo_tasks_list." : undefined);
    const t = r.data as Record<string, unknown>;
    return ok(JSON.stringify(t, null, 1), { task: t });
  });

  tool("tasks", "polpo_task_create", {
    title: "Create a task",
    description: "Give an agent a task: it runs on its own and is assessed when done (polpo_task_get to follow it). "
      + "Each call creates a new task.",
    inputSchema: {
      title: z.string().min(1).describe("Short title"),
      description: z.string().min(1).describe("What to do and what a good result looks like"),
      assignTo: z.string().min(1).describe("The agent's name (polpo_agents_list)"),
      dependsOn: z.array(z.string()).optional().describe("Ids of tasks that must finish first"),
    },
    outputSchema: { task: looseObject },
    annotations: WRITE,
  }, async (args) => {
    const r = await apiSend(deps, "POST", "/tasks", args);
    if (!r.ok) return apiError(r, "Creating the task");
    const t = r.data as { id?: string; title?: string; status?: string };
    return ok(`Created task ${t.id} [${t.status}] ${t.title} → ${args.assignTo}.`, { task: r.data as Record<string, unknown> });
  });
}
