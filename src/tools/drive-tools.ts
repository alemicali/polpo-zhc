/**
 * The tools of an agent with a drive: keeping its self-portrait (who it is, the people that matter,
 * its open threads), which it carries from one conversation to the next, and its own plan (the steps
 * toward its goals).
 */
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { DriveManager } from "../core/drive.js";

export const UPDATE_SELF_DESCRIPTION = "Rewrite your self-portrait, the whole text: your personality (character, voice, what you care about, quirks), "
  + "the people who matter to you and how they like to be treated, and your open threads. It is part of every conversation you have, "
  + "so keep it current and concise; stay true to who you are while growing with experience.";

export const UpdateSelfSchema = Type.Object({
  portrait: Type.String({ description: "The whole self-portrait (Markdown), replacing the previous one" }),
});

const statusParam = Type.Union([Type.Literal("todo"), Type.Literal("doing"), Type.Literal("done"), Type.Literal("dropped")]);
const horizonParam = Type.Union([Type.Literal("long"), Type.Literal("quarter"), Type.Literal("month"), Type.Literal("week"), Type.Literal("day")], {
  description: "A goal's horizon: long (6–12 months), quarter, month, week, day. Omit for a step (something to do)",
});

export const ADD_PLAN_ITEM_DESCRIPTION = "Add a goal or a step to your own plan. Goals cascade from your purpose: long-term (6–12 months) → quarter → "
  + "month → week → day, each under the one it serves (parent); steps are the things to do under a goal. Give goals a measure. "
  + "Goals can be someone else's that you support (owner: a person or a group). Your open plan is part of every conversation.";
export const AddPlanItemSchema = Type.Object({
  title: Type.String({ description: "The goal or step, concrete (e.g. \"Alessio trains 3 times this week\", \"Learn sports nutrition basics and write a skill\")" }),
  horizon: Type.Optional(horizonParam),
  parent: Type.Optional(Type.String({ description: "Id of the goal it serves (pln_…)" })),
  measure: Type.Optional(Type.String({ description: "How you will know it is done: a number, a date, a yes/no" })),
  owner: Type.Optional(Type.String({ description: "Whose goal: \"me\" (default), or the person or group you support" })),
  why: Type.Optional(Type.String({ description: "Why it matters for your purpose" })),
  goal: Type.Optional(Type.String({ description: "The configured goal it serves" })),
  due: Type.Optional(Type.String({ description: "By when (date or time)" })),
  status: Type.Optional(statusParam),
});
export const UPDATE_PLAN_ITEM_DESCRIPTION = "Move a goal or step of your plan forward: status (todo, doing, done, dropped), progress (0–100), "
  + "notes (progress, findings, what is left), measure, title, due date, horizon or parent.";
export const UpdatePlanItemSchema = Type.Object({
  id: Type.String({ description: "Item id (pln_…)" }),
  status: Type.Optional(statusParam),
  progress: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  notes: Type.Optional(Type.String({ description: "Progress, findings, what is left (replaces the previous notes)" })),
  measure: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  due: Type.Optional(Type.String()),
  horizon: Type.Optional(horizonParam),
  parent: Type.Optional(Type.String({ description: "Id of the goal it serves; empty to detach" })),
});

type Result = { content: { type: "text"; text: string }[]; details: Record<string, unknown> };
const text = (t: string): Result => ({ content: [{ type: "text", text: t }], details: {} });

export function createDriveTools(agent: string, manager: DriveManager): AgentTool<any>[] {
  return [
    {
      name: "update_self",
      label: "Update self-portrait",
      description: UPDATE_SELF_DESCRIPTION,
      parameters: UpdateSelfSchema,
      execute: async (_id, params) => {
        const portrait = String((params as { portrait?: unknown }).portrait ?? "").trim();
        if (!portrait) return text("Error: the portrait is empty");
        const revision = manager.setSelf(agent, portrait, manager.isReflecting(agent) ? "reflection" : "chat");
        return text(`Self-portrait saved (${revision.after.length} characters).`);
      },
    },
    {
      name: "add_plan_item",
      label: "Add to my plan",
      description: ADD_PLAN_ITEM_DESCRIPTION,
      parameters: AddPlanItemSchema,
      execute: async (_id, params) => {
        try {
          const { parent, ...rest } = params as { title: string; parent?: string };
          const item = manager.addPlanItem(agent, { ...rest, ...(parent ? { parentId: parent } : {}) });
          return text(`Added ${item.id} to your plan [${item.horizon ? `${item.horizon} goal` : "step"}, ${item.status}]: ${item.title}`);
        } catch (err) {
          return text(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
    {
      name: "update_plan_item",
      label: "Update my plan",
      description: UPDATE_PLAN_ITEM_DESCRIPTION,
      parameters: UpdatePlanItemSchema,
      execute: async (_id, params) => {
        const { id, parent, ...patch } = params as { id: string; parent?: string };
        try {
          const item = manager.updatePlanItem(agent, id, { ...patch, ...(parent !== undefined ? { parentId: parent } : {}) });
          return text(`${item.id} [${item.status}${item.progress !== undefined ? `, ${item.progress}%` : ""}]: ${item.title}${item.notes ? ` — ${item.notes.slice(0, 200)}` : ""}`);
        } catch (err) {
          return text(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
  ];
}
