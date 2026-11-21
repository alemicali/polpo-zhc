/**
 * Missions: list and read.
 */
import { z } from "zod";
import {
  BAD_CURSOR, READ, apiError, apiGet, cursorParam, enc, fail, limitParam, looseObject, ok, page, pageOutput, short,
  type McpDeps, type Register,
} from "./kit.js";

export const MISSION_STATUSES = ["draft", "scheduled", "recurring", "active", "paused", "completed", "failed", "cancelled"] as const;

const missionSummary = z.object({
  id: z.string(), name: z.string(), status: z.string(), taskCount: z.number().optional(), updatedAt: z.string().optional(),
}).passthrough();

export function registerMissionTools(tool: Register, deps: McpDeps): void {
  tool("missions", "polpo_missions_list", {
    title: "List missions",
    description: "Missions (plans of tasks run together), most recently updated first: id, name, status, number of tasks. "
      + "polpo_mission_get reads one with its plan.",
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
    const all = ((r.data as Array<{ id: string; name: string; status: string; taskCount?: number; updatedAt?: string }>) ?? [])
      .filter((m) => (!status || m.status === status) && words.every((w) => m.name.toLowerCase().includes(w)))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .map((m) => ({ id: m.id, name: m.name, status: m.status, ...(m.taskCount !== undefined ? { taskCount: m.taskCount } : {}), ...(m.updatedAt ? { updatedAt: m.updatedAt } : {}) }));
    const p = page(all, limit ?? 20, cursor);
    if (!p) return fail(BAD_CURSOR);
    const lines = p.items.map((m) => `- ${m.id} [${m.status}] ${short(m.name, 100)}${m.taskCount !== undefined ? ` (${m.taskCount} tasks)` : ""}`);
    return ok(`${lines.join("\n") || "No missions match."}${p.next_cursor ? `\n(more: cursor ${p.next_cursor})` : ""}`, p);
  });

  tool("missions", "polpo_mission_get", {
    title: "Get a mission",
    description: "A mission with its plan (tasks, dependencies, checkpoints) and status.",
    inputSchema: { id: z.string().min(1).describe("The mission's id (polpo_missions_list)") },
    outputSchema: { mission: looseObject },
    annotations: READ,
  }, async ({ id }) => {
    const r = await apiGet(deps, `/missions/${enc(id)}`);
    if (!r.ok) return apiError(r, `Reading mission ${id}`, r.status === 404 ? "Check the id with polpo_missions_list." : undefined);
    return ok(JSON.stringify(r.data, null, 1), { mission: r.data as Record<string, unknown> });
  });
}
