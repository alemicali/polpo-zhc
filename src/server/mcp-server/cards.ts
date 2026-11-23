/**
 * The task and mission cards: MCP Apps (interactive UI in Claude, ChatGPT…; text elsewhere).
 * One widget document (widgets/work-card) shows both; each card has one show tool, which its UI
 * also calls to refresh (fewer tools in the list).
 */
import { z } from "zod";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildMissionCard, buildTaskCard, missionCardText, taskCardText, type MissionCard, type TaskCard } from "../mcp-work-card.js";
import { WORK_CARD_HTML } from "../mcp-widgets.generated.js";
import { cardAppearance } from "./card-appearance.js";
import { READ, allowed, enc, fail, looseObject, unwrap, type McpDeps, type McpPrincipal, type ToolScope, type ToolsetName } from "./kit.js";

/** The task and mission cards' UI: one HTML document, served as a ui:// resource. */
export const WORK_CARD_URI = "ui://polpo/work-card.html";
let seq = 0;
const key = () => ({ createdAt: Date.now(), seq: ++seq });

type Loaded<T> = { ok: true; card: T } | { ok: false; error: string };
type AnyTask = Parameters<typeof buildTaskCard>[0]["task"];

async function allTasks(deps: McpDeps): Promise<AnyTask[]> {
  const r = unwrap(await deps.api("GET", "/api/v1/tasks"));
  return r.ok && Array.isArray(r.data) ? (r.data as AnyTask[]) : [];
}

async function loadTaskCard(deps: McpDeps, id: string): Promise<Loaded<TaskCard>> {
  const r = unwrap(await deps.api("GET", `/api/v1/tasks/${enc(id)}`));
  if (!r.ok) return { ok: false, error: r.status === 404 ? `There is no task ${id}. Find the id with polpo_tasks_list.` : r.error };
  const task = r.data as AnyTask;
  const [tasks, connectors, appearance] = await Promise.all([
    task.dependsOn?.length ? allTasks(deps) : Promise.resolve([]),
    // a tool scope names connectors: their names and accounts
    task.toolScope ? deps.api("GET", "/api/v1/connectors").then(unwrap).then((c) => (c.ok ? (c.data as { connectors?: Array<{ id: string; name: string; account?: string }> })?.connectors ?? [] : [])) : Promise.resolve([]),
    cardAppearance(deps),
  ]);
  const card = buildTaskCard({ task, tasks, connectors, now: new Date(), key: key() });
  return { ok: true, card: appearance ? { ...card, appearance } : card };
}

async function loadMissionCard(deps: McpDeps, id: string): Promise<Loaded<MissionCard>> {
  const r = unwrap(await deps.api("GET", `/api/v1/missions/${enc(id)}`));
  if (!r.ok) return { ok: false, error: r.status === 404 ? `There is no mission ${id}. Find the id with polpo_missions_list.` : r.error };
  const mission = r.data as Parameters<typeof buildMissionCard>[0]["mission"];
  const [all, appearance] = await Promise.all([allTasks(deps), cardAppearance(deps)]);
  const tasks = all
    .filter((t) => t.missionId === mission.id)
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  const card = buildMissionCard({ mission, tasks, now: new Date(), key: key() });
  return { ok: true, card: appearance ? { ...card, appearance } : card };
}

/** Every field declared and open to new ones (clients validate structuredContent with Ajv: a closed schema breaks them). */
const keyShape = z.object({ createdAt: z.number(), seq: z.number() }).passthrough().optional().describe("Orders the cards of one task or mission: a newer card supersedes older ones");
const failureShape = z.object({ reason: z.string(), retryable: z.boolean(), kind: z.string() }).passthrough();

const taskCardOutput = z.object({
  kind: z.literal("task").optional(),
  key: keyShape,
  generatedAt: z.string().optional(),
  task: z.object({ id: z.string(), title: z.string(), status: z.string(), failure: failureShape.optional() }).passthrough()
    .describe("The task; failure: why it failed (the labelled reason) and whether it was retried"),
  toolScope: z.object({ label: z.string(), stale: z.array(z.string()).optional() }).passthrough().optional()
    .describe("The tools its runs get when the task narrows the agent's (Task.toolScope), and what of it the agent no longer has"),
  runs: z.array(looseObject).optional().describe("Its runs, newest first: engine, model, auth, computer, egress, session, cost"),
  costUsd: z.number().optional().describe("Every recorded run's cost, USD"),
  dependencies: z.array(looseObject).optional().describe("The tasks it depends on, with their status"),
  result: looseObject.optional(),
  outcomes: z.array(looseObject).optional(),
}).passthrough();

const missionCardOutput = z.object({
  kind: z.literal("mission").optional(),
  key: keyShape,
  generatedAt: z.string().optional(),
  mission: z.object({ id: z.string(), name: z.string(), status: z.string(), pauseReason: z.string().optional() }).passthrough(),
  cost: looseObject.optional().describe("What it cost so far against its budget: usd, budgetUsd, budgetUsed, overBudget, byAgent, byEngine"),
  counts: z.record(z.string(), z.number()).optional(),
  tasks: z.array(looseObject).optional().describe("Its tasks with their latest run (engine, model, computer), cost and failure"),
}).passthrough();

const taskResult = (card: TaskCard) => ({ content: [{ type: "text" as const, text: taskCardText(card) }], structuredContent: card as unknown as Record<string, unknown> });
const missionResult = (card: MissionCard) => ({ content: [{ type: "text" as const, text: missionCardText(card) }], structuredContent: card as unknown as Record<string, unknown> });

export function registerWorkCards(server: McpServer, deps: McpDeps, enabled: ReadonlySet<ToolsetName>, principal: McpPrincipal, catalog?: ToolScope[]): void {
  // the card refreshes itself through the same tools (visible to the model and to the app)
  const tasks = allowed(enabled, principal, "tasks", READ, catalog, ["polpo_task_show"]);
  const missions = allowed(enabled, principal, "missions", READ, catalog, ["polpo_mission_show"]);
  if (!tasks && !missions) return;

  registerAppResource(server, "Task and mission card", WORK_CARD_URI, {
    description: "A task's card (status, why it failed, where and with what each run executed, cost, dependencies, result) "
      + "or a mission's (cost against its budget, cost by agent and engine, its tasks).",
  }, async () => ({
    contents: [{
      uri: WORK_CARD_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: WORK_CARD_HTML,
      // everything is in the document (brand marks inline); the host's font (Claude) is the only origin it loads from
      _meta: { ui: { prefersBorder: false, csp: { resourceDomains: ["https://assets.claude.ai"] } } },
    }],
  }));

  if (tasks) {
    registerAppTool(server, "polpo_task_show", {
      title: "Show a task",
      description: "Show one task's card: its status, why it failed (and whether it was retried), where and with what each run executed "
        + "(engine and model, authentication, computer, egress, cost), its tool scope when it narrows the agent's tools, the tasks it depends on and its result. "
        + "Use it when the person asks how a task went (polpo_tasks_list for ids; polpo_task_get for the full record).",
      inputSchema: { id: z.string().min(1).describe("The task's id") },
      annotations: { title: "Show a task", ...READ },
      outputSchema: taskCardOutput,
      _meta: { ui: { resourceUri: WORK_CARD_URI } },
    }, async ({ id }) => {
      const r = await loadTaskCard(deps, id);
      return r.ok ? taskResult(r.card) : fail(r.error);
    });
  }

  if (missions) {
    registerAppTool(server, "polpo_mission_show", {
      title: "Show a mission",
      description: "Show one mission's card: its status, what it cost so far against its budget (paused when over), the cost by agent and engine, "
        + "and its tasks with their latest run and failure. Use it when the person asks how a mission is going (polpo_missions_list for ids).",
      inputSchema: { id: z.string().min(1).describe("The mission's id") },
      annotations: { title: "Show a mission", ...READ },
      outputSchema: missionCardOutput,
      _meta: { ui: { resourceUri: WORK_CARD_URI } },
    }, async ({ id }) => {
      const r = await loadMissionCard(deps, id);
      return r.ok ? missionResult(r.card) : fail(r.error);
    });
  }
}
