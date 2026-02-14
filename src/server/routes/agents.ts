import { Hono } from "hono";
import type { ServerEnv } from "../app.js";
import { AddAgentSchema, RenameTeamSchema, parseBody } from "../schemas.js";

/**
 * Agent/team management routes.
 */
export function agentRoutes(): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();

  // GET /agents — list agents
  app.get("/", (c) => {
    const orchestrator = c.get("orchestrator");
    return c.json({ ok: true, data: orchestrator.getAgents() });
  });

  // POST /agents — add agent
  app.post("/", async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = parseBody(AddAgentSchema, await c.req.json());

    orchestrator.addAgent({
      name: body.name,
      adapter: body.adapter,
      role: body.role,
      command: body.command,
      model: body.model,
      allowedTools: body.allowedTools,
      systemPrompt: body.systemPrompt,
      skills: body.skills,
      maxTurns: body.maxTurns,
    });

    return c.json({ ok: true, data: { added: true } }, 201);
  });

  // DELETE /agents/:name — remove agent
  app.delete("/:name", (c) => {
    const orchestrator = c.get("orchestrator");
    const removed = orchestrator.removeAgent(c.req.param("name"));
    if (!removed) {
      return c.json({ ok: false, error: "Agent not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { removed: true } });
  });

  // GET /team — get team info
  app.get("/team", (c) => {
    const orchestrator = c.get("orchestrator");
    return c.json({ ok: true, data: orchestrator.getTeam() });
  });

  // PATCH /team — rename team
  app.patch("/team", async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = parseBody(RenameTeamSchema, await c.req.json());
    orchestrator.renameTeam(body.name);
    return c.json({ ok: true, data: orchestrator.getTeam() });
  });

  // GET /processes — active agent processes
  app.get("/processes", (c) => {
    const orchestrator = c.get("orchestrator");
    const state = orchestrator.getStore().getState();
    return c.json({ ok: true, data: state.processes || [] });
  });

  return app;
}
