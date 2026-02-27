import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { ServerEnv } from "../app.js";
import { AddAgentSchema, RenameTeamSchema, AddTeamSchema } from "../schemas.js";
import { redactAgentConfig, redactTeam, sanitizeTranscriptEntry } from "../security.js";

/**
 * Agent/team management routes.
 */
export function agentRoutes(): OpenAPIHono<ServerEnv> {
  const app = new OpenAPIHono<ServerEnv>();

  // GET /agents — list agents
  const listAgentsRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Agents"],
    summary: "List agents",
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } },
        description: "List of agents",
      },
    },
  });

  app.openapi(listAgentsRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    return c.json({ ok: true, data: orchestrator.getAgents().map(redactAgentConfig) });
  });

  // POST /agents — add agent
  const addAgentRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Agents"],
    summary: "Add an agent",
    request: {
      body: { content: { "application/json": { schema: AddAgentSchema } } },
    },
    responses: {
      201: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ added: z.boolean() }) }) } },
        description: "Agent added",
      },
    },
  });

  app.openapi(addAgentRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const body = c.req.valid("json");
    const teamName = c.req.query("team");

    orchestrator.addAgent({
      name: body.name,
      role: body.role,
      model: body.model,
      allowedTools: body.allowedTools,
      systemPrompt: body.systemPrompt,
      skills: body.skills,
      maxTurns: body.maxTurns,
      identity: body.identity,
      vault: body.vault as any,
      reportsTo: body.reportsTo,
      enableBrowser: body.enableBrowser,
      browserEngine: body.browserEngine,
      browserProfile: body.browserProfile,
      enableHttp: body.enableHttp,
      enableGit: body.enableGit,
      enableMultifile: body.enableMultifile,
      enableDeps: body.enableDeps,
      enableExcel: body.enableExcel,
      enablePdf: body.enablePdf,
      enableDocx: body.enableDocx,
      enableEmail: body.enableEmail,
      enableAudio: body.enableAudio,
      enableImage: body.enableImage,
    }, teamName);

    return c.json({ ok: true, data: { added: true } }, 201);
  });

  // DELETE /agents/:name — remove agent
  const deleteAgentRoute = createRoute({
    method: "delete",
    path: "/{name}",
    tags: ["Agents"],
    summary: "Remove an agent",
    request: {
      params: z.object({ name: z.string() }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ removed: z.boolean() }) }) } },
        description: "Agent removed",
      },
      404: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Agent not found",
      },
    },
  });

  app.openapi(deleteAgentRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { name } = c.req.valid("param");
    const removed = orchestrator.removeAgent(name);
    if (!removed) {
      return c.json({ ok: false, error: "Agent not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { removed: true } }, 200);
  });

  // GET /teams — get all teams
  const getTeamsRoute = createRoute({
    method: "get",
    path: "/teams",
    tags: ["Agents"],
    summary: "List all teams",
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } },
        description: "All teams",
      },
    },
  });

  app.openapi(getTeamsRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const teams = orchestrator.getTeams();
    return c.json({ ok: true, data: teams.map(redactTeam) });
  });

  // GET /team — get single team (default or by ?name= query)
  const getTeamRoute = createRoute({
    method: "get",
    path: "/team",
    tags: ["Agents"],
    summary: "Get team info",
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
        description: "Team info",
      },
    },
  });

  app.openapi(getTeamRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const name = c.req.query("name");
    const team = orchestrator.getTeam(name);
    return c.json({ ok: true, data: team ? redactTeam(team) : null });
  });

  // POST /teams — add a new team
  const addTeamRoute = createRoute({
    method: "post",
    path: "/teams",
    tags: ["Agents"],
    summary: "Add a team",
    request: {
      body: { content: { "application/json": { schema: AddTeamSchema } } },
    },
    responses: {
      201: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ added: z.boolean() }) }) } },
        description: "Team added",
      },
    },
  });

  app.openapi(addTeamRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const body = c.req.valid("json");
    orchestrator.addTeam({ name: body.name, description: body.description, agents: [] });
    return c.json({ ok: true, data: { added: true } }, 201);
  });

  // DELETE /teams/:name — remove a team
  const deleteTeamRoute = createRoute({
    method: "delete",
    path: "/teams/{name}",
    tags: ["Agents"],
    summary: "Remove a team",
    request: {
      params: z.object({ name: z.string() }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ removed: z.boolean() }) }) } },
        description: "Team removed",
      },
      404: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Team not found",
      },
    },
  });

  app.openapi(deleteTeamRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { name } = c.req.valid("param");
    const removed = orchestrator.removeTeam(name);
    if (!removed) {
      return c.json({ ok: false, error: "Team not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { removed: true } }, 200);
  });

  // PATCH /team — rename team
  const renameTeamRoute = createRoute({
    method: "patch",
    path: "/team",
    tags: ["Agents"],
    summary: "Rename team",
    request: {
      body: { content: { "application/json": { schema: RenameTeamSchema } } },
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
        description: "Team renamed",
      },
    },
  });

  app.openapi(renameTeamRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const body = c.req.valid("json");
    orchestrator.renameTeam(body.oldName, body.name);
    const updatedTeam = orchestrator.getTeam(body.name);
    return c.json({ ok: true, data: updatedTeam ? redactTeam(updatedTeam) : null });
  });

  // GET /processes — active agent processes
  const listProcessesRoute = createRoute({
    method: "get",
    path: "/processes",
    tags: ["Agents"],
    summary: "List active agent processes",
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } },
        description: "Active processes",
      },
    },
  });

  app.openapi(listProcessesRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const state = orchestrator.getStore().getState();
    return c.json({ ok: true, data: state.processes || [] });
  });

  // GET /processes/:taskId/activity — activity history for a task (from run JSONL)
  const getActivityRoute = createRoute({
    method: "get",
    path: "/processes/{taskId}/activity",
    tags: ["Agents"],
    summary: "Get activity history for a task",
    request: {
      params: z.object({ taskId: z.string() }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } },
        description: "Activity entries",
      },
    },
  });

  app.openapi(getActivityRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { taskId } = c.req.valid("param");
    const logsDir = join(orchestrator.getPolpoDir(), "logs");

    if (!existsSync(logsDir)) {
      return c.json({ ok: true, data: [] });
    }

    // Strategy: first check active RunStore for the runId, otherwise scan JSONL headers
    let runId: string | undefined;
    const run = orchestrator.getRunStore().getRunByTaskId(taskId);
    if (run) {
      runId = run.id;
    } else {
      // Scan run-*.jsonl files for matching taskId in the header line
      const files = readdirSync(logsDir).filter(f => f.startsWith("run-") && f.endsWith(".jsonl"));
      for (const file of files) {
        try {
          const firstLine = readFileSync(join(logsDir, file), "utf-8").split("\n")[0];
          const header = JSON.parse(firstLine);
          if (header._run && header.taskId === taskId) {
            runId = header.runId;
            break;
          }
        } catch { /* skip malformed files */ }
      }
    }

    if (!runId) {
      return c.json({ ok: true, data: [] });
    }

    const logPath = join(logsDir, `run-${runId}.jsonl`);
    if (!existsSync(logPath)) {
      return c.json({ ok: true, data: [] });
    }

    try {
      const lines = readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
      const entries = lines
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean)
        .map(sanitizeTranscriptEntry);
      return c.json({ ok: true, data: entries });
    } catch {
      return c.json({ ok: true, data: [] });
    }
  });

  // GET /agents/:name — single agent detail (registered after static routes to avoid conflicts)
  const getAgentRoute = createRoute({
    method: "get",
    path: "/{name}",
    tags: ["Agents"],
    summary: "Get single agent detail",
    request: {
      params: z.object({ name: z.string() }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
        description: "Agent detail",
      },
      404: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Agent not found",
      },
    },
  });

  app.openapi(getAgentRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { name } = c.req.valid("param");
    const agent = orchestrator.getAgents().find(a => a.name === name);
    if (!agent) {
      return c.json({ ok: false, error: "Agent not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: redactAgentConfig(agent) }, 200);
  });

  return app;
}
