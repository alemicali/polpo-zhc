import { normalizeSandboxSettings } from "@polpo-ai/core/sandbox";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { join, extname } from "node:path";
import { agentLinesChart, normalizeConnectorTools, normalizeTalksTo, unknownComputersProblem, type FileSystem } from "@polpo-ai/core";
import { AddAgentSchema, UpdateAgentSchema, RenameTeamSchema, AddTeamSchema } from "../schemas.js";
import { redactAgentConfig, redactTeam, sanitizeTranscriptEntry } from "../security.js";
import { buildETag, contentFingerprint, handleConditional } from "../etag.js";
import { DEPLOY_GATE_MAX_WAIT_MS, registerAgentVersionRoutes, versionErrorResponse, type AgentVersionDeps } from "./agent-versions.js";
import { deployGateFailures } from "@polpo-ai/core/agent-suites";
import { registerAgentTestRoutes, type AgentTestRouteDeps } from "./agent-tests.js";
import { registerAgentSuiteRoutes, type AgentSuiteRouteDeps } from "./agent-suites.js";
import { AGENT_FIELD_CLASSIFICATION } from "@polpo-ai/core/agent-versions";

interface IndexedRunLog {
  file: string;
  runId: string;
  taskId: string;
  startedAt?: string;
}

interface ActivityLogIndex {
  signature: string;
  byTaskId: Map<string, IndexedRunLog[]>;
}

const activityLogIndexes = new Map<string, ActivityLogIndex>();

async function indexActivityLogs(fs: FileSystem, logsDir: string): Promise<ActivityLogIndex> {
  const files = (await fs.readdir(logsDir))
    .filter((file) => file.startsWith("run-") && file.endsWith(".jsonl"))
    .sort();
  const signature = files.join("\0");
  const cached = activityLogIndexes.get(logsDir);
  if (cached?.signature === signature) return cached;

  const byTaskId = new Map<string, IndexedRunLog[]>();
  await Promise.all(files.map(async (file) => {
    try {
      const content = await fs.readFile(join(logsDir, file));
      const newline = content.indexOf("\n");
      const firstLine = newline >= 0 ? content.slice(0, newline) : content;
      const header = JSON.parse(firstLine);
      if (!header?._run || typeof header.taskId !== "string") return;
      const runId = typeof header.runId === "string"
        ? header.runId
        : file.slice("run-".length, -".jsonl".length);
      const runs = byTaskId.get(header.taskId) ?? [];
      runs.push({
        file,
        runId,
        taskId: header.taskId,
        startedAt: typeof header.startedAt === "string" ? header.startedAt : undefined,
      });
      byTaskId.set(header.taskId, runs);
    } catch {
      // A runner may have created the file but not written its header yet.
    }
  }));

  const index = { signature, byTaskId };
  activityLogIndexes.set(logsDir, index);
  return index;
}

function compareRunLogs(a: IndexedRunLog, b: IndexedRunLog): number {
  const aTime = a.startedAt ? Date.parse(a.startedAt) : Number.NaN;
  const bTime = b.startedAt ? Date.parse(b.startedAt) : Number.NaN;
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return aTime - bTime;
  if (a.startedAt && b.startedAt && a.startedAt !== b.startedAt) return a.startedAt.localeCompare(b.startedAt);
  return a.runId.localeCompare(b.runId);
}

/**
 * Agent/team management routes.
 */
export function agentRoutes(getDeps: () => {
  getAgents: () => Promise<any[]>;
  addAgent: (agent: any, teamName?: string) => Promise<void>;
  removeAgent: (name: string) => Promise<boolean>;
  updateAgent: (name: string, updates: any) => Promise<any>;
  getTeams: () => Promise<any[]>;
  getTeam: (name?: string) => Promise<any>;
  addTeam: (team: any) => Promise<void>;
  removeTeam: (name: string) => Promise<boolean>;
  renameTeam: (oldName: string, newName: string) => Promise<void>;
  taskStore: any;
  runStore: any;
  polpoDir: string;
  fs?: FileSystem;
  /** The instance's computer ids (settings.computers), to check agents' computers and defaultComputer. */
  computerIds?: () => string[];
  /**
   * Agent versioning (draft → publish → deploy). Absent: updates are written live as before.
   */
  versions?: AgentVersionDeps & {
    /** Change the draft and, as asked, publish and deploy (see Orchestrator.updateAgentVersioned). */
    update: (name: string, updates: any, opts: { actor: string; mode: "draft" | "publish" | "deploy"; bump?: "major" | "minor" | "patch"; version?: string; note?: string; gateWaitMs?: number }) => Promise<{
      agent: any; draftChanged: boolean; published?: any; deployed?: any;
      /** mode deploy through the deploy gate (required suites): deployed, pending or blocked. */
      deploy?: { status: "deployed" | "pending" | "blocked"; message: string; gate?: any };
      /** mode publish: the publish checks started (suites with gate.onPublish). */
      check?: any;
    }>;
    /** settings.agents.versioning.autoDeployApiUpdates (default true). */
    autoDeploy: () => boolean;
  };
  /** Agent tests (POST/GET /agents/:name/tests, …/fix). Absent: the routes answer 409. */
  tests?: AgentTestRouteDeps;
  /** Agent suites (/agents/:name/suites…, /agents/:name/suite-runs…). Absent: the routes answer 409. */
  suites?: AgentSuiteRouteDeps;
}): OpenAPIHono {
  const app = new OpenAPIHono();

  /** The update mode a PATCH asks for (publish / deploy flags, else the instance setting). */
  const updateMode = (deps: { versions?: { autoDeploy: () => boolean } }, body: { publish?: boolean; deploy?: boolean }): "draft" | "publish" | "deploy" => {
    if (body.deploy === true) return "deploy";
    if (body.publish === true) return "publish";
    if (body.publish === false) return "draft";
    return deps.versions?.autoDeploy() === false ? "draft" : "deploy";
  };

  /** The versioning state shown with an agent (production version, latest, draft). */
  const versionState = async (deps: { versions?: AgentVersionDeps }, agent: any) => {
    if (!deps.versions || agent?.volatile) return undefined;
    try {
      const st = await deps.versions.versioning().state(agent.name);
      return {
        production: st.production, latest: st.latest, pointers: st.pointers, versions: st.versions,
        draft: { exists: st.draft.exists, hasChanges: st.draft.hasChanges, changedFields: st.draft.changes.map((c) => c.field),
          ...(st.draft.baseVersion ? { baseVersion: st.draft.baseVersion } : {}), stale: st.draft.stale, ...(st.draft.warning ? { warning: st.draft.warning } : {}),
          ...(st.draft.updatedAt ? { updatedAt: st.draft.updatedAt, updatedBy: st.draft.updatedBy } : {}),
          ...(st.draft.suggestedBump ? { suggestedBump: st.draft.suggestedBump, nextVersion: st.draft.nextVersion } : {}) },
      };
    } catch { return undefined; }
  };

  /** An error for computers/defaultComputer naming a computer the instance does not have, else null. */
  const badComputers = (deps: { computerIds?: () => string[] }, body: { computers?: string[]; defaultComputer?: string }): string | null => {
    const problem = unknownComputersProblem(deps.computerIds?.() ?? [], body);
    return problem ? problem.replace(/ first\)$/, " first: POST /computers)") : null;
  };

  // GET /agents — list agents
  const listAgentsRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Agents"],
    summary: "List agents",
    request: {
      query: z.object({
        summary: z.union([z.literal("true"), z.literal("false")]).optional().openapi({
          description: "If `true`, returns a slim projection: only the identity bits the list rows render (displayName, title, avatar, company, email) plus pre-computed `capabilities` counts. Drops `allowedTools`, `allowedPaths`, `skills`, `mcpServers`, `systemPrompt`, `reasoning`, `browserProfile`, `emailAllowedDomains`, `suggestions`, and the bulky `identity.responsibilities/bio/personality/tone/timezone`. Default `false` for backwards compat.",
        }),
      }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } },
        description: "List of agents",
      },
      304: {
        description: "Not modified — client has the current list per ETag",
      },
    },
  });

  app.openapi(listAgentsRoute, async (c) => {
    const deps = getDeps();
    const agents = await deps.getAgents();
    const redacted = agents.map(redactAgentConfig);
    const { summary } = c.req.valid("query");

    if (summary === "true") {
      const slim = redacted.map((a: any) => {
        const id = a.identity && typeof a.identity === "object" ? a.identity : null;
        const slimIdentity = id ? {
          ...(id.displayName ? { displayName: id.displayName } : {}),
          ...(id.title ? { title: id.title } : {}),
          ...(id.avatar ? { avatar: id.avatar } : {}),
          ...(id.company ? { company: id.company } : {}),
          ...(id.email ? { email: id.email } : {}),
        } : undefined;
        return {
          name: a.name,
          role: a.role,
          model: a.model,
          team: a.team,
          reportsTo: a.reportsTo,
          ...(a.talksTo ? { talksTo: a.talksTo } : {}),
          volatile: a.volatile,
          createdAt: a.createdAt,
          ...(slimIdentity && Object.keys(slimIdentity).length > 0 ? { identity: slimIdentity } : {}),
          capabilities: {
            tools: Array.isArray(a.allowedTools) ? a.allowedTools.length : 0,
            skills: Array.isArray(a.skills) ? a.skills.length : 0,
            mcpServers: a.mcpServers && typeof a.mcpServers === "object"
              ? Object.keys(a.mcpServers).length
              : 0,
          },
        };
      });
      const etag = buildETag(contentFingerprint(slim));
      if (handleConditional(c, etag)) return c.body(null, 304);
      return c.json({ ok: true, data: slim });
    }

    const etag = buildETag(contentFingerprint(redacted));
    if (handleConditional(c, etag)) return c.body(null, 304);
    return c.json({ ok: true, data: redacted });
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
      400: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Invalid input (e.g. an unknown computer)",
      },
    },
  });

  app.openapi(addAgentRoute, async (c) => {
    const deps = getDeps();
    const body = c.req.valid("json");
    const computersError = badComputers(deps, body);
    if (computersError) return c.json({ ok: false, error: computersError, code: "VALIDATION_ERROR" }, 400);
    const teamName = c.req.query("team");

    try {
      await deps.addAgent({
        name: body.name,
        role: body.role,
        model: body.model,
        allowedTools: body.allowedTools,
        systemPrompt: body.systemPrompt,
        skills: body.skills,
        suggestions: body.suggestions,
        maxTurns: body.maxTurns,
        runtime: body.runtime,
        loops: body.loops,
        pipeline: body.pipeline,
        identity: body.identity,
        reportsTo: body.reportsTo,
        ...(body.talksTo ? { talksTo: normalizeTalksTo(body.talksTo) } : {}),
        browserProfile: body.browserProfile,
        browserEgress: body.browserEgress,
        ...(body.computers !== undefined && { computers: body.computers }),
        ...(body.defaultComputer ? { defaultComputer: body.defaultComputer } : {}),
        ...(body.engine && body.engine !== "polpo" ? { engine: body.engine } : {}),
        ...(body.voiceReplies !== undefined && { voiceReplies: body.voiceReplies }),
        ...(body.progressiveTools !== undefined && { progressiveTools: body.progressiveTools }),
        ...(normalizeConnectorTools(body.connectorTools) ? { connectorTools: normalizeConnectorTools(body.connectorTools) } : {}),
        ...(body.learning !== undefined && { learning: body.learning }),
        ...(body.drive !== undefined && { drive: body.drive }),
      }, teamName);
    } catch (err) {
      // an engine the settings do not allow (harness not enabled, no computer that can run it)
      if ((err as Error)?.name === "HarnessConfigError") return c.json({ ok: false, error: (err as Error).message, code: "VALIDATION_ERROR" }, 400);
      throw err;
    }

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
    const deps = getDeps();
    const { name } = c.req.valid("param");
    const removed = await deps.removeAgent(name);
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
    const deps = getDeps();
    const teams = await deps.getTeams();
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
    const deps = getDeps();
    const name = c.req.query("name");
    const team = await deps.getTeam(name);
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
    const deps = getDeps();
    const body = c.req.valid("json");
    await deps.addTeam({ name: body.name, description: body.description, agents: [] });
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
    const deps = getDeps();
    const { name } = c.req.valid("param");
    const removed = await deps.removeTeam(name);
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
    const deps = getDeps();
    const body = c.req.valid("json");
    await deps.renameTeam(body.oldName, body.name);
    const updatedTeam = await deps.getTeam(body.name);
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
    const deps = getDeps();
    const state = await deps.taskStore.getState();
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
    const deps = getDeps();
    const { taskId } = c.req.valid("param");
    const fs = deps.fs;
    const logsDir = join(deps.polpoDir, "logs");

    if (!fs || !(await fs.exists(logsDir))) {
      return c.json({ ok: true, data: [] });
    }

    const index = await indexActivityLogs(fs, logsDir);
    const runLogs = [...(index.byTaskId.get(taskId) ?? [])];

    // The file can briefly exist without a header while a runner starts. The
    // RunStore lets us include that active log on the next poll without
    // waiting for another file to invalidate the directory index.
    const activeRun = await deps.runStore.getRunByTaskId(taskId);
    if (activeRun && !runLogs.some((item) => item.runId === activeRun.id)) {
      const file = `run-${activeRun.id}.jsonl`;
      if (await fs.exists(join(logsDir, file))) {
        const activeRunLog = {
          file,
          runId: activeRun.id,
          taskId,
          startedAt: activeRun.startedAt,
        };
        runLogs.push(activeRunLog);
        index.byTaskId.set(taskId, [...(index.byTaskId.get(taskId) ?? []), activeRunLog]);
      }
    }

    runLogs.sort(compareRunLogs);
    const entries: any[] = [];
    for (const runLog of runLogs) {
      try {
        const parsed = (await fs.readFile(join(logsDir, runLog.file)))
          .split("\n")
          .filter(Boolean)
          .map((line: string) => { try { return JSON.parse(line); } catch { return null; } })
          .filter(Boolean)
          .map(sanitizeTranscriptEntry);
        entries.push(...parsed);
      } catch {
        // Keep other attempts visible if one log is temporarily unreadable.
      }
    }
    return c.json({ ok: true, data: entries });
  });

  // /agents/:name/versions, /diff, /draft, /publish, /deploy, /rollback, /deploys (after the static routes)
  registerAgentVersionRoutes(app, () => getDeps());
  // /agents/:name/tests (run, history, one run, fix)
  registerAgentTestRoutes(app, () => getDeps());
  // /agents/:name/suites (suites, dataset import, runs) and /agents/:name/suite-runs
  registerAgentSuiteRoutes(app, () => getDeps());

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
      400: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Invalid input (e.g. an unknown computer)",
      },
      404: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Agent not found",
      },
    },
  });

  app.openapi(updateAgentRoute, async (c) => {
    const deps = getDeps();
    const { name } = c.req.valid("param");
    const existing = (await deps.getAgents()).find(a => a.name === name);
    if (!existing) {
      return c.json({ ok: false, error: "Agent not found", code: "NOT_FOUND" }, 404);
    }

    const body = c.req.valid("json");
    // identity changes merge into the draft's identity when the update goes to the draft
    const identityBase = deps.versions && !existing.volatile && body.identity
      ? ((await deps.versions.versioning().draftConfig(name).catch(() => undefined))?.config.identity ?? existing.identity)
      : existing.identity;
    const computersError = badComputers(deps, { computers: body.computers ?? undefined, defaultComputer: body.defaultComputer || undefined });
    if (computersError) return c.json({ ok: false, error: computersError, code: "VALIDATION_ERROR" }, 400);

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
      ...(body.suggestions !== undefined && { suggestions: body.suggestions }),
      ...(body.allowedPaths !== undefined && { allowedPaths: body.allowedPaths }),
      ...(body.allowedTools !== undefined && { allowedTools: body.allowedTools }),
      ...(typeof body.reportsTo === "string" && { reportsTo }),
      // null: no lines (talks to anyone)
      ...(body.talksTo !== undefined && { talksTo: body.talksTo ? normalizeTalksTo(body.talksTo) : undefined }),
      ...(body.reasoning !== undefined && { reasoning: body.reasoning }),
      ...(body.sandbox !== undefined && { sandbox: normalizeSandboxSettings(body.sandbox) }),
      ...(body.compaction !== undefined && { compaction: body.compaction ?? undefined }),
      ...(body.progressiveTools !== undefined && { progressiveTools: body.progressiveTools ?? undefined }),
      ...(body.connectorTools !== undefined && { connectorTools: normalizeConnectorTools(body.connectorTools) }),
      ...(body.voiceReplies !== undefined && { voiceReplies: body.voiceReplies }),
      ...(body.learning !== undefined && { learning: body.learning }),
      ...(body.drive !== undefined && { drive: body.drive }),
      ...(body.maxTurns !== undefined && { maxTurns: body.maxTurns }),
      ...(body.maxConcurrency !== undefined && { maxConcurrency: body.maxConcurrency }),
      ...(body.runtime !== undefined && { runtime: body.runtime }),
      ...(body.loops !== undefined && { loops: body.loops }),
      ...(body.pipeline !== undefined && { pipeline: body.pipeline }),
      ...(body.browserProfile !== undefined && { browserProfile: body.browserProfile }),
      ...(body.browserEgress !== undefined && { browserEgress: body.browserEgress }),
      // null or [] clears the list (the field goes: only "host" and its default)
      ...(body.computers !== undefined && { computers: body.computers?.length ? body.computers : undefined }),
      // "" clears it (back to this server)
      ...(body.defaultComputer !== undefined && { defaultComputer: body.defaultComputer || undefined }),
      // "polpo" or null: back to Polpo's own engine
      ...(body.engine !== undefined && { engine: body.engine && body.engine !== "polpo" ? body.engine : undefined }),
      ...(body.emailAllowedDomains !== undefined && { emailAllowedDomains: body.emailAllowedDomains }),
      ...(body.identity && { identity: { ...(identityBase ?? {}), ...body.identity } }),
      ...(body.team !== undefined && { team: body.team }),
    };

    let versioning: Record<string, unknown> | undefined;
    try {
      if (deps.versions && !existing.volatile) {
        // draft → (publish) → (deploy): the flags, else settings.agents.versioning.autoDeployApiUpdates
        const mode = updateMode(deps, body);
        const result = await deps.versions.update(name, updates, {
          actor: deps.versions.actor(c), mode,
          ...(body.bump ? { bump: body.bump } : {}), ...(body.version ? { version: body.version } : {}), ...(body.note ? { note: body.note } : {}),
          ...(body.wait ? { gateWaitMs: DEPLOY_GATE_MAX_WAIT_MS } : {}),
        });
        const gate = result.deploy?.gate;
        versioning = {
          mode, draftChanged: result.draftChanged,
          ...(result.published ? { published: { version: result.published.version, bump: result.published.bump, changedFields: result.published.changes.map((ch: { field: string }) => ch.field) } } : {}),
          ...(result.deployed ? { deployed: result.deployed } : {}),
          // the agent's required suites decide the deploy: pending ("in verifica") or blocked → published, not deployed
          ...(result.deploy ? { deployStatus: result.deploy.status, deployMessage: result.deploy.message } : {}),
          ...(gate ? { gate: { id: gate.id, status: gate.status, version: gate.version, progress: gate.progress, failed: deployGateFailures(gate), suites: gate.suites.map((s: any) => ({ suiteId: s.suiteId, suiteName: s.suiteName, status: s.status, runId: s.runId, reasons: s.reasons })) } } : {}),
          ...(result.deploy && result.deploy.status !== "deployed" && result.published ? { warning: `Published as ${result.published.version} but not deployed: ${result.deploy.message}` } : {}),
          ...(result.check ? { check: { id: result.check.id, status: result.check.status, version: result.check.version } } : {}),
        };
      } else {
        await deps.updateAgent(name, updates);
      }
    } catch (err) {
      return versionErrorResponse(c, err);
    }

    const updated = (await deps.getAgents()).find(a => a.name === name);
    const state = updated ? await versionState(deps, updated) : undefined;
    return c.json({ ok: true, data: updated ? { ...redactAgentConfig(updated), ...(state ? { versioning: { ...state, ...versioning } } : {}) } : null }, 200);
  });

  // GET /agents/lines — the org chart and the communication lines between agents
  const getLinesRoute = createRoute({
    method: "get",
    path: "/lines",
    tags: ["Agents"],
    summary: "Org chart and communication lines",
    description: "Every agent's communication lines (mode, manager, direct reports, extra agents, who it can reach) and the directed edges "
      + "between agents (from may talk to to). `unrestricted`: agents with no lines set (from before the lines): they talk to anyone. Polpo talks to every agent.",
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({
          agents: z.array(z.object({
            agent: z.string(), mode: z.enum(["org", "list", "anyone", "none"]), explicit: z.boolean(), manager: z.string().optional(),
            reports: z.array(z.string()), agents: z.array(z.string()), acceptFrom: z.enum(["anyone", "lines"]), reachable: z.array(z.string()),
          })),
          edges: z.array(z.object({ from: z.string(), to: z.string(), kind: z.enum(["manager", "report", "extra", "open"]) })),
          unrestricted: z.array(z.string()),
        }) }) } },
        description: "The team's lines",
      },
    },
  });

  app.openapi(getLinesRoute, async (c) => {
    const deps = getDeps();
    const agents = (await deps.getAgents()).filter((a) => !a.volatile);
    return c.json({ ok: true, data: agentLinesChart(agents) }, 200);
  });

  // GET /agents/:name — single agent detail (registered after static routes to avoid conflicts)
  const getAgentRoute = createRoute({
    method: "get",
    path: "/{name}",
    tags: ["Agents"],
    summary: "Get agent",
    description: "The agent as production runs it, with `versioning` (production version, latest, draft state). `view=draft`: its draft (working copy) instead, as the dashboard edits it.",
    request: {
      params: z.object({ name: z.string() }),
      query: z.object({ view: z.enum(["production", "draft"]).optional() }),
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
    const deps = getDeps();
    const { name } = c.req.valid("param");
    const { view } = c.req.valid("query");
    let agent = (await deps.getAgents()).find(a => a.name === name);
    if (!agent) {
      return c.json({ ok: false, error: "Agent not found", code: "NOT_FOUND" }, 404);
    }
    // the production config (or the draft's), with its version, the pointers and the draft's state
    const versioning = await versionState(deps, agent);
    if (view === "draft" && versioning && deps.versions) {
      const { config } = await deps.versions.versioning().draftConfig(name);
      // the draft's versioned fields over the agent's own (name, createdAt, mission fields)
      const own = Object.fromEntries(Object.entries(agent).filter(([k]) => AGENT_FIELD_CLASSIFICATION[k as keyof typeof AGENT_FIELD_CLASSIFICATION] !== "versioned"));
      agent = { ...own, ...config, name };
    }
    return c.json({ ok: true, data: { ...redactAgentConfig(agent), ...(versioning ? { versioning: { ...versioning, ...(view === "draft" ? { view: "draft" } : {}) } } : {}) } }, 200);
  });

  // ── POST /agents/:name/avatar — upload agent avatar ──
  app.post("/:name/avatar", async (c) => {
    const deps = getDeps();
    const name = c.req.param("name");
    const agent = (await deps.getAgents()).find(a => a.name === name);
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
    const polpoDir = deps.polpoDir;
    const avatarsDir = join(polpoDir, "avatars");
    const fs = deps.fs;
    if (!fs) return c.json({ ok: false, error: "Filesystem not available" }, 501);

    await fs.mkdir(avatarsDir);

    const ext = extname(file.name || "avatar.png") || ".png";
    const filename = `${name}${ext}`;
    const avatarPath = join(avatarsDir, filename);
    const relativePath = `.polpo/avatars/${filename}`;

    // The image's bytes as they are: a text write would store base64 text, not a picture.
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!fs.writeFileBuffer) return c.json({ ok: false, error: "This filesystem cannot store binary files" }, 501);
    await fs.writeFileBuffer(avatarPath, bytes);

    // Update agent identity with avatar path (a versioned change: the same rules as PATCH)
    const identity = { ...(agent.identity ?? {}), avatar: relativePath };
    if (deps.versions && !agent.volatile) {
      await deps.versions.update(name, { identity }, { actor: deps.versions.actor(c), mode: updateMode(deps, {}), note: "Avatar changed" });
    } else {
      await deps.updateAgent(name, { identity });
    }

    return c.json({ ok: true, data: { avatar: relativePath } }, 200);
  });

  // ── DELETE /agents/:name/avatar — remove agent avatar ──
  app.delete("/:name/avatar", async (c) => {
    const deps = getDeps();
    const name = c.req.param("name");
    const agent = (await deps.getAgents()).find(a => a.name === name);
    if (!agent) return c.json({ ok: false, error: "Agent not found" }, 404);

    if (agent.identity?.avatar) {
      const identity = { ...agent.identity, avatar: undefined };
      if (deps.versions && !agent.volatile) {
        await deps.versions.update(name, { identity }, { actor: deps.versions.actor(c), mode: updateMode(deps, {}), note: "Avatar removed" });
      } else {
        await deps.updateAgent(name, { identity });
      }
    }

    return c.json({ ok: true }, 200);
  });

  return app;
}
