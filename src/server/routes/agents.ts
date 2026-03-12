import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { join, extname } from "node:path";
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import type { ServerEnv } from "../app.js";
import { AddAgentSchema, UpdateAgentSchema, RenameTeamSchema, AddTeamSchema } from "../schemas.js";
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

  app.openapi(listAgentsRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const agents = await orchestrator.getAgents();
    return c.json({ ok: true, data: agents.map(redactAgentConfig) });
  });

  // POST /agents — add agent
  const addAgentRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Agents"],
    summary: "Add agent",
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

  app.openapi(addAgentRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = c.req.valid("json");
    const teamName = c.req.query("team");

    await orchestrator.addAgent({
      name: body.name,
      role: body.role,
      model: body.model,
      allowedTools: body.allowedTools,
      systemPrompt: body.systemPrompt,
      skills: body.skills,
      maxTurns: body.maxTurns,
      identity: body.identity,
      reportsTo: body.reportsTo,
      browserProfile: body.browserProfile,
    }, teamName);

    return c.json({ ok: true, data: { added: true } }, 201);
  });

  // DELETE /agents/:name — remove agent
  const deleteAgentRoute = createRoute({
    method: "delete",
    path: "/{name}",
    tags: ["Agents"],
    summary: "Remove agent",
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

  app.openapi(deleteAgentRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const { name } = c.req.valid("param");
    const removed = await orchestrator.removeAgent(name);
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
    summary: "List teams",
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } },
        description: "All teams",
      },
    },
  });

  app.openapi(getTeamsRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const teams = await orchestrator.getTeams();
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

  app.openapi(getTeamRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const name = c.req.query("name");
    const team = await orchestrator.getTeam(name);
    return c.json({ ok: true, data: team ? redactTeam(team) : null });
  });

  // POST /teams — add a new team
  const addTeamRoute = createRoute({
    method: "post",
    path: "/teams",
    tags: ["Agents"],
    summary: "Add team",
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

  app.openapi(addTeamRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = c.req.valid("json");
    await orchestrator.addTeam({ name: body.name, description: body.description, agents: [] });
    return c.json({ ok: true, data: { added: true } }, 201);
  });

  // DELETE /teams/:name — remove a team
  const deleteTeamRoute = createRoute({
    method: "delete",
    path: "/teams/{name}",
    tags: ["Agents"],
    summary: "Remove team",
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

  app.openapi(deleteTeamRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const { name } = c.req.valid("param");
    const removed = await orchestrator.removeTeam(name);
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

  app.openapi(renameTeamRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = c.req.valid("json");
    await orchestrator.renameTeam(body.oldName, body.name);
    const updatedTeam = await orchestrator.getTeam(body.name);
    return c.json({ ok: true, data: updatedTeam ? redactTeam(updatedTeam) : null });
  });

  // GET /processes — active agent processes
  const listProcessesRoute = createRoute({
    method: "get",
    path: "/processes",
    tags: ["Agents"],
    summary: "List processes",
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } },
        description: "Active processes",
      },
    },
  });

  app.openapi(listProcessesRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const state = await orchestrator.getStore().getState();
    return c.json({ ok: true, data: state.processes || [] });
  });

  // GET /processes/:taskId/activity — activity history for a task (from run JSONL)
  const getActivityRoute = createRoute({
    method: "get",
    path: "/processes/{taskId}/activity",
    tags: ["Agents"],
    summary: "Get task activity",
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

  app.openapi(getActivityRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const { taskId } = c.req.valid("param");
    const logsDir = join(orchestrator.getPolpoDir(), "logs");

    if (!existsSync(logsDir)) {
      return c.json({ ok: true, data: [] });
    }

    // Strategy: first check active RunStore for the runId, otherwise scan JSONL headers
    let runId: string | undefined;
    const run = await orchestrator.getRunStore().getRunByTaskId(taskId);
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

  // PATCH /agents/:name — update agent (registered after static routes to avoid conflicts with /team)
  const updateAgentRoute = createRoute({
    method: "patch",
    path: "/{name}",
    tags: ["Agents"],
    summary: "Update agent",
    request: {
      params: z.object({ name: z.string() }),
      body: { content: { "application/json": { schema: UpdateAgentSchema } } },
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
        description: "Agent updated",
      },
      404: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Agent not found",
      },
    },
  });

  app.openapi(updateAgentRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const { name } = c.req.valid("param");
    const existing = (await orchestrator.getAgents()).find(a => a.name === name);
    if (!existing) {
      return c.json({ ok: false, error: "Agent not found", code: "NOT_FOUND" }, 404);
    }

    const body = c.req.valid("json");

    // Handle reportsTo: empty string clears it
    let reportsTo: string | undefined = undefined;
    if (typeof body.reportsTo === "string") {
      reportsTo = body.reportsTo.trim() || undefined;
    }

    const updates: Record<string, unknown> = {
      ...(body.role !== undefined && { role: body.role }),
      ...(body.model !== undefined && { model: body.model }),
      ...(body.systemPrompt !== undefined && { systemPrompt: body.systemPrompt }),
      ...(body.skills !== undefined && { skills: body.skills }),
      ...(body.allowedPaths !== undefined && { allowedPaths: body.allowedPaths }),
      ...(body.allowedTools !== undefined && { allowedTools: body.allowedTools }),
      ...(typeof body.reportsTo === "string" && { reportsTo }),
      ...(body.reasoning !== undefined && { reasoning: body.reasoning }),
      ...(body.maxTurns !== undefined && { maxTurns: body.maxTurns }),
      ...(body.maxConcurrency !== undefined && { maxConcurrency: body.maxConcurrency }),
      ...(body.browserProfile !== undefined && { browserProfile: body.browserProfile }),
      ...(body.emailAllowedDomains !== undefined && { emailAllowedDomains: body.emailAllowedDomains }),
      ...(body.identity && { identity: { ...(existing.identity ?? {}), ...body.identity } }),
      ...(body.team !== undefined && { team: body.team }),
    };

    await orchestrator.updateAgent(name, updates);

    const updated = (await orchestrator.getAgents()).find(a => a.name === name);
    return c.json({ ok: true, data: updated ? redactAgentConfig(updated) : null }, 200);
  });

  // GET /agents/:name — single agent detail (registered after static routes to avoid conflicts)
  const getAgentRoute = createRoute({
    method: "get",
    path: "/{name}",
    tags: ["Agents"],
    summary: "Get agent",
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

  app.openapi(getAgentRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const { name } = c.req.valid("param");
    const agent = (await orchestrator.getAgents()).find(a => a.name === name);
    if (!agent) {
      return c.json({ ok: false, error: "Agent not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: redactAgentConfig(agent) }, 200);
  });

  // ── POST /agents/:name/avatar — upload agent avatar ──
  app.post("/:name/avatar", async (c) => {
    const orchestrator = c.get("orchestrator");
    const name = c.req.param("name");
    const agent = (await orchestrator.getAgents()).find(a => a.name === name);
    if (!agent) return c.json({ ok: false, error: "Agent not found" }, 404);

    const body = await c.req.parseBody();
    const file = body["file"];
    if (!file || !(file instanceof File)) {
      return c.json({ ok: false, error: "Missing file upload (field: file)" }, 400);
    }

    // Validate image type
    const allowed = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]);
    if (!allowed.has(file.type)) {
      return c.json({ ok: false, error: `Unsupported image type: ${file.type}. Allowed: png, jpg, webp, gif, svg` }, 400);
    }

    // Save to .polpo/avatars/<name>.<ext>
    const polpoDir = orchestrator.getPolpoDir();
    const avatarsDir = join(polpoDir, "avatars");
    if (!existsSync(avatarsDir)) mkdirSync(avatarsDir, { recursive: true });

    const ext = extname(file.name || "avatar.png") || ".png";
    const filename = `${name}${ext}`;
    const avatarPath = join(avatarsDir, filename);
    const relativePath = `.polpo/avatars/${filename}`;

    const buffer = Buffer.from(await file.arrayBuffer());
    writeFileSync(avatarPath, buffer);

    // Update agent identity with avatar path
    const identity = { ...(agent.identity ?? {}), avatar: relativePath };
    await orchestrator.updateAgent(name, { identity });

    return c.json({ ok: true, data: { avatar: relativePath } }, 200);
  });

  // ── DELETE /agents/:name/avatar — remove agent avatar ──
  app.delete("/:name/avatar", async (c) => {
    const orchestrator = c.get("orchestrator");
    const name = c.req.param("name");
    const agent = (await orchestrator.getAgents()).find(a => a.name === name);
    if (!agent) return c.json({ ok: false, error: "Agent not found" }, 404);

    if (agent.identity?.avatar) {
      const identity = { ...agent.identity, avatar: undefined };
      await orchestrator.updateAgent(name, { identity });
    }

    return c.json({ ok: true }, 200);
  });

  return app;
}
