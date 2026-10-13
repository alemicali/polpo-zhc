/**
 * Drive REST API — what an agent pursues on its own initiative, and what it plans.
 *
 *   GET  /drive/:agent                          its drive, self-portrait, plan, intentions and latest reflections
 *   PUT  /drive/:agent/self                     rewrite its self-portrait { portrait }
 *   POST /drive/:agent/reflect                  have it reflect now
 *   PATCH /drive/:agent/plan/:id                change a goal or step of its plan { status?, progress?, notes? }
 *   POST /drive/:agent/intentions/:id/confirm   say yes to a proposed intention
 *   POST /drive/:agent/intentions/:id/cancel    drop an intention
 *
 * The drive itself changes with the agent (PATCH /agents/:name { drive }).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import type { AgentConfig } from "@polpo-ai/core";
import type { DriveManager } from "../../core/drive.js";
import type { ConversationCheckManager } from "../../core/conversation-check-manager.js";

export interface DriveRoutesDeps {
  manager?: DriveManager;
  checks?: ConversationCheckManager;
  getAgents: () => Promise<AgentConfig[]>;
}

export function driveRoutes(getDeps: () => DriveRoutesDeps): OpenAPIHono {
  const app = new OpenAPIHono();
  const fail = (c: any, status: number, error: string) => c.json({ ok: false, error }, status);
  const agentOf = async (name: string) => (await getDeps().getAgents()).find((a) => a.name === name);

  app.get("/:agent", async (c) => {
    const agent = await agentOf(c.req.param("agent"));
    if (!agent) return fail(c, 404, "Agent not found");
    const manager = getDeps().manager;
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 30, 1), 200);
    return c.json({
      ok: true,
      data: {
        drive: agent.drive ?? { enabled: false },
        self: manager?.getSelf(agent.name) ?? "",
        selfHistory: manager?.listSelfHistory(agent.name).slice(0, 10) ?? [],
        plan: manager?.listPlan(agent.name) ?? [],
        intentions: await manager?.intentions(agent.name) ?? [],
        journal: manager?.listJournal(agent.name, limit) ?? [],
        lastReflectionAt: manager?.lastReflectionAt(agent.name) ?? null,
      },
    });
  });

  app.put("/:agent/self", async (c) => {
    const agent = await agentOf(c.req.param("agent"));
    if (!agent) return fail(c, 404, "Agent not found");
    const manager = getDeps().manager;
    if (!manager) return fail(c, 503, "Drives are not available on this instance");
    const body = await c.req.json().catch(() => ({})) as { portrait?: unknown };
    if (typeof body.portrait !== "string") return fail(c, 400, "portrait must be a string");
    return c.json({ ok: true, data: { revision: manager.setSelf(agent.name, body.portrait, "person") } });
  });

  app.patch("/:agent/plan/:id", async (c) => {
    const agent = await agentOf(c.req.param("agent"));
    if (!agent) return fail(c, 404, "Agent not found");
    const manager = getDeps().manager;
    if (!manager) return fail(c, 503, "Drives are not available on this instance");
    const body = await c.req.json().catch(() => ({})) as { status?: unknown; progress?: unknown; notes?: unknown };
    const statuses = ["todo", "doing", "done", "dropped"];
    if (body.status !== undefined && !statuses.includes(String(body.status))) return fail(c, 400, `status must be one of ${statuses.join(", ")}`);
    try {
      const item = manager.updatePlanItem(agent.name, c.req.param("id"), {
        ...(body.status !== undefined ? { status: body.status as "todo" } : {}),
        ...(body.progress !== undefined ? { progress: Number(body.progress) } : {}),
        ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
      });
      return c.json({ ok: true, data: { item } });
    } catch (err) {
      return fail(c, 404, err instanceof Error ? err.message : String(err));
    }
  });

  app.post("/:agent/reflect", async (c) => {
    const agent = await agentOf(c.req.param("agent"));
    if (!agent) return fail(c, 404, "Agent not found");
    const manager = getDeps().manager;
    if (!manager) return fail(c, 503, "Drives are not available on this instance");
    if (!agent.drive?.enabled) return fail(c, 409, "The agent has no drive: turn it on first");
    const entry = await manager.reflect(agent.name, "manual");
    if (!entry) return fail(c, 409, "The agent is already reflecting, or could not reflect now");
    return c.json({ ok: true, data: { entry } });
  });

  for (const action of ["confirm", "cancel"] as const) {
    app.post(`/:agent/intentions/:id/${action}`, async (c) => {
      const agent = await agentOf(c.req.param("agent"));
      if (!agent) return fail(c, 404, "Agent not found");
      const checks = getDeps().checks;
      if (!checks) return fail(c, 503, "Scheduled checks are not available on this instance");
      const id = c.req.param("id");
      const [check] = (await checks.list({ agent: agent.name })).filter((x) => x.id === id);
      if (!check) return fail(c, 404, "Intention not found");
      const updated = action === "confirm" ? await checks.confirm(id) : await checks.cancel(id);
      return c.json({ ok: true, data: { intention: updated } });
    });
  }

  return app;
}
