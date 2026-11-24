import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  AgentVersionError,
  type AgentDeployEntry, type AgentVersion, type AgentVersionBump, type AgentVersioning,
} from "@polpo-ai/core/agent-versions";

/** What the versioning routes need from the host. */
export interface AgentVersionDeps {
  versioning: () => AgentVersioning;
  /** Deploy a published version to production (written live, recorded in the history). */
  deploy: (name: string, version: string, opts: { actor: string; note?: string }) => Promise<AgentDeployEntry>;
  rollback: (name: string, opts: { actor: string; note?: string; to?: string }) => Promise<AgentDeployEntry>;
  /** Who makes the request: "person:<email>", "polpo", "mcp:<client>", an agent's name. */
  actor: (c: Context) => string;
  /** Called after a publish/deploy/discard so live clients refresh. */
  changed?: (agentName: string, what: "draft" | "published" | "deployed") => void;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const errorSchema = z.object({ ok: z.boolean(), error: z.string(), code: z.string() });
const okAny = z.object({ ok: z.boolean(), data: z.any() });

/** An AgentVersionError as an HTTP response. */
export function versionErrorResponse(c: Context, err: unknown): never {
  if (err instanceof AgentVersionError || (err as Error)?.name === "AgentVersionError") {
    const e = err as AgentVersionError;
    const status = e.code === "NOT_FOUND" ? 404 : e.code === "INVALID" ? 400 : 409;
    return c.json({ ok: false, error: e.message, code: e.code === "INVALID" ? "VALIDATION_ERROR" : e.code }, status) as never;
  }
  if ((err as Error)?.name === "HarnessConfigError") return c.json({ ok: false, error: (err as Error).message, code: "VALIDATION_ERROR" }, 400) as never;
  throw err;
}

/** A version without its config (lists). */
function versionSummary(v: AgentVersion) {
  const { config: _config, ...rest } = v;
  return { ...rest, changedFields: v.changes.map((ch) => ch.field) };
}

/**
 * Agent versioning routes, under /agents/{name}/…: versions, diff, draft, publish, deploy,
 * rollback and the deploy history. Registered before /agents/{name}.
 */
export function registerAgentVersionRoutes(app: OpenAPIHono, getDeps: () => { versions?: AgentVersionDeps; getAgents: () => Promise<any[]> }): void {
  const v = () => {
    const deps = getDeps().versions;
    if (!deps) throw new AgentVersionError("Agent versioning is not available on this server", "INVALID");
    return deps;
  };
  const exists = async (name: string) => (await getDeps().getAgents()).some((a) => a.name === name && !a.volatile);
  const notFound = (c: Context, name: string): never => c.json({ ok: false, error: `Agent "${name}" not found`, code: "NOT_FOUND" }, 404) as never;
  const nameParam = z.object({ name: z.string() });

  // GET /agents/{name}/versions
  app.openapi(createRoute({
    method: "get", path: "/{name}/versions", tags: ["Agent versions"], summary: "List an agent's versions",
    description: "Published versions, newest first (without their config: GET …/versions/{version} has it), with the production pointer and the draft's state.",
    request: { params: nameParam },
    responses: { 200: { content: { "application/json": { schema: okAny } }, description: "Versions and state" }, 404: { content: { "application/json": { schema: errorSchema } }, description: "Agent not found" } },
  }), async (c) => {
    const { name } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    try {
      const versioning = v().versioning();
      const [versions, state] = await Promise.all([versioning.listVersions(name), versioning.state(name)]);
      const sorted = [...versions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return c.json({ ok: true, data: { state, versions: sorted.map(versionSummary) } }, 200);
    } catch (err) { return versionErrorResponse(c, err); }
  });

  // GET /agents/{name}/versions/{version}
  app.openapi(createRoute({
    method: "get", path: "/{name}/versions/{version}", tags: ["Agent versions"], summary: "Get one version",
    description: "A published version with its full config snapshot (read-only). `draft` and `production` are accepted too.",
    request: { params: z.object({ name: z.string(), version: z.string() }) },
    responses: { 200: { content: { "application/json": { schema: okAny } }, description: "The version" }, 404: { content: { "application/json": { schema: errorSchema } }, description: "Not found" } },
  }), async (c) => {
    const { name, version } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    try {
      const versioning = v().versioning();
      if (version === "draft") {
        const { config, draft } = await versioning.draftConfig(name);
        return c.json({ ok: true, data: { agent: name, version: "draft", config, ...(draft ? { updatedAt: draft.updatedAt, updatedBy: draft.updatedBy, baseVersion: draft.baseVersion } : {}) } }, 200);
      }
      const target = version === "production" || version === "latest" ? await versioning.pointer(name) : version;
      const found = target ? await versioning.getVersion(name, target) : undefined;
      if (!found) return c.json({ ok: false, error: `${name} has no version ${version}`, code: "NOT_FOUND" }, 404) as never;
      return c.json({ ok: true, data: found }, 200);
    } catch (err) { return versionErrorResponse(c, err); }
  });

  // GET /agents/{name}/diff?from=&to=
  app.openapi(createRoute({
    method: "get", path: "/{name}/diff", tags: ["Agent versions"], summary: "Diff two versions",
    description: "Per-field changes and a git-style unified diff of the serialized config between two refs: a version (1.2.0), `production` or `draft`. "
      + "`to` defaults to `draft`; `from` defaults to the latest version for the draft, else the version before `to`.",
    request: { params: nameParam, query: z.object({ from: z.string().optional(), to: z.string().optional() }) },
    responses: { 200: { content: { "application/json": { schema: okAny } }, description: "The diff" }, 404: { content: { "application/json": { schema: errorSchema } }, description: "Not found" } },
  }), async (c) => {
    const { name } = c.req.valid("param");
    const { from, to } = c.req.valid("query");
    if (!(await exists(name))) return notFound(c, name);
    try {
      return c.json({ ok: true, data: await v().versioning().diff(name, to ?? "draft", from) }, 200);
    } catch (err) { return versionErrorResponse(c, err); }
  });

  // DELETE /agents/{name}/draft
  app.openapi(createRoute({
    method: "delete", path: "/{name}/draft", tags: ["Agent versions"], summary: "Discard the draft",
    description: "Throw away the draft's unpublished changes (production is not touched).",
    request: { params: nameParam },
    responses: { 200: { content: { "application/json": { schema: okAny } }, description: "Discarded" }, 404: { content: { "application/json": { schema: errorSchema } }, description: "Agent not found" } },
  }), async (c) => {
    const { name } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    try {
      const discarded = await v().versioning().discardDraft(name);
      v().changed?.(name, "draft");
      return c.json({ ok: true, data: { discarded } }, 200);
    } catch (err) { return versionErrorResponse(c, err); }
  });

  // POST /agents/{name}/publish
  app.openapi(createRoute({
    method: "post", path: "/{name}/publish", tags: ["Agent versions"], summary: "Publish the draft",
    description: "Publish the draft as a new immutable version: the suggested bump (patch for text/prompt/identity, minor for added tools/skills/connectors/settings, "
      + "major for an engine or model change or removed tools/skills/connectors) unless `bump` or `version` says otherwise. Publishing does not deploy: `deploy: true` also deploys it to production.",
    request: {
      params: nameParam,
      body: { content: { "application/json": { schema: z.object({
        bump: z.enum(["major", "minor", "patch"]).optional(),
        version: z.string().regex(SEMVER, "a version: major.minor.patch").optional(),
        note: z.string().max(2000).optional(),
        deploy: z.boolean().optional(),
      }) } } },
    },
    responses: {
      200: { content: { "application/json": { schema: okAny } }, description: "Published (and deployed)" },
      404: { content: { "application/json": { schema: errorSchema } }, description: "Agent not found" },
      409: { content: { "application/json": { schema: errorSchema } }, description: "No draft changes, or the version exists" },
    },
  }), async (c) => {
    const { name } = c.req.valid("param");
    const body = c.req.valid("json");
    if (!(await exists(name))) return notFound(c, name);
    try {
      const deps = v();
      const actor = deps.actor(c);
      const published = await deps.versioning().publish(name, { actor, bump: body.bump as AgentVersionBump | undefined, version: body.version, note: body.note });
      deps.changed?.(name, "published");
      const deployed = body.deploy ? await deps.deploy(name, published.version, { actor, note: body.note }) : undefined;
      if (deployed) deps.changed?.(name, "deployed");
      return c.json({ ok: true, data: { version: published, ...(deployed ? { deploy: deployed } : {}) } }, 200);
    } catch (err) { return versionErrorResponse(c, err); }
  });

  // POST /agents/{name}/deploy
  app.openapi(createRoute({
    method: "post", path: "/{name}/deploy", tags: ["Agent versions"], summary: "Deploy a version to production",
    description: "Move the production pointer to a published version: everything that runs the agent without a pinned version (chats, tasks, missions, schedules, channels, MCP, Polpo) uses it from its next run; runs in flight keep theirs. Recorded in the deploy history with who, when, from → to and the note.",
    request: {
      params: nameParam,
      body: { content: { "application/json": { schema: z.object({
        version: z.string().regex(SEMVER, "a version: major.minor.patch"),
        note: z.string().max(2000).optional(),
      }) } } },
    },
    responses: {
      200: { content: { "application/json": { schema: okAny } }, description: "Deployed" },
      404: { content: { "application/json": { schema: errorSchema } }, description: "Agent or version not found" },
    },
  }), async (c) => {
    const { name } = c.req.valid("param");
    const body = c.req.valid("json");
    if (!(await exists(name))) return notFound(c, name);
    try {
      const deps = v();
      const entry = await deps.deploy(name, body.version, { actor: deps.actor(c), note: body.note });
      deps.changed?.(name, "deployed");
      return c.json({ ok: true, data: entry }, 200);
    } catch (err) { return versionErrorResponse(c, err); }
  });

  // POST /agents/{name}/rollback
  app.openapi(createRoute({
    method: "post", path: "/{name}/rollback", tags: ["Agent versions"], summary: "Roll production back",
    description: "Deploy the version production ran before the current one (or `to`). A rollback is a deploy: it appears in the history with its diff.",
    request: {
      params: nameParam,
      body: { content: { "application/json": { schema: z.object({
        to: z.string().regex(SEMVER, "a version: major.minor.patch").optional(),
        note: z.string().max(2000).optional(),
      }) } } },
    },
    responses: {
      200: { content: { "application/json": { schema: okAny } }, description: "Rolled back" },
      404: { content: { "application/json": { schema: errorSchema } }, description: "Agent or version not found" },
      409: { content: { "application/json": { schema: errorSchema } }, description: "Nothing to roll back to" },
    },
  }), async (c) => {
    const { name } = c.req.valid("param");
    const body = c.req.valid("json");
    if (!(await exists(name))) return notFound(c, name);
    try {
      const deps = v();
      const entry = await deps.rollback(name, { actor: deps.actor(c), note: body.note, to: body.to });
      deps.changed?.(name, "deployed");
      return c.json({ ok: true, data: entry }, 200);
    } catch (err) { return versionErrorResponse(c, err); }
  });

  // GET /agents/{name}/deploys
  app.openapi(createRoute({
    method: "get", path: "/{name}/deploys", tags: ["Agent versions"], summary: "Deploy history",
    description: "Every move of the production pointer, newest first: when, who, from → to, note, rollback marker. `diff=true` adds each deploy's diff (per-field changes and a unified diff of the config).",
    request: { params: nameParam, query: z.object({
      limit: z.coerce.number().int().min(1).max(500).optional(),
      diff: z.union([z.literal("true"), z.literal("false")]).optional(),
    }) },
    responses: { 200: { content: { "application/json": { schema: okAny } }, description: "Deploys" }, 404: { content: { "application/json": { schema: errorSchema } }, description: "Agent not found" } },
  }), async (c) => {
    const { name } = c.req.valid("param");
    const { limit, diff } = c.req.valid("query");
    if (!(await exists(name))) return notFound(c, name);
    try {
      return c.json({ ok: true, data: await v().versioning().deploys(name, { limit: limit ?? 100, withDiff: diff === "true" }) }, 200);
    } catch (err) { return versionErrorResponse(c, err); }
  });

  // GET /agents/{name}/deploys/{id}
  app.openapi(createRoute({
    method: "get", path: "/{name}/deploys/{id}", tags: ["Agent versions"], summary: "One deploy with its diff",
    description: "A deploy (or rollback) and the git-style diff between the version it replaced and the one it deployed.",
    request: { params: z.object({ name: z.string(), id: z.string() }) },
    responses: { 200: { content: { "application/json": { schema: okAny } }, description: "The deploy" }, 404: { content: { "application/json": { schema: errorSchema } }, description: "Not found" } },
  }), async (c) => {
    const { name, id } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    try {
      const versioning = v().versioning();
      const entry = (await versioning.deploys(name)).find((d) => d.id === id);
      if (!entry) return c.json({ ok: false, error: `${name} has no deploy ${id}`, code: "NOT_FOUND" }, 404) as never;
      return c.json({ ok: true, data: { ...entry, diff: await versioning.deployDiff(name, entry) } }, 200);
    } catch (err) { return versionErrorResponse(c, err); }
  });
}
