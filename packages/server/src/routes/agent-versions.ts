import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  AgentVersionError,
  type AgentDeployEntry, type AgentVersion, type AgentVersionBump, type AgentVersioning,
} from "@polpo-ai/core/agent-versions";
import type { AgentDeployGate, AgentDeployOutcome, AgentDeployRequest, AgentVersionGateStatus } from "@polpo-ai/core/agent-suites";

/** Deploy gates: the agent's required suites run before a version reaches production (docs/agent-suites.md). */
export interface AgentDeployGateDeps {
  list: (name: string, opts: { version?: string; limit?: number }) => Promise<AgentDeployGate[]>;
  get: (name: string, id: string) => Promise<AgentDeployGate>;
  /** Stop a verification (nothing is deployed). */
  cancel: (name: string, id: string, actor: string) => Promise<AgentDeployGate>;
  /** Deploy a gate's version anyway: admins, with a reason. */
  override: (name: string, id: string, req: { actor: string; reason: string; admin: boolean; note?: string }) => Promise<AgentDeployOutcome>;
  /** Each version's latest gate. */
  versionStatuses: (name: string) => Promise<Record<string, AgentVersionGateStatus>>;
  /** The deploy being verified now. */
  pending: (name: string) => Promise<AgentDeployGate | undefined>;
  /** The deploy history with each entry's gate. */
  attach: <E extends AgentDeployEntry>(name: string, entries: E[]) => Promise<E[]>;
  /** A version was published (not deployed): its publish checks. */
  published: (name: string, version: string, actor: string) => Promise<AgentDeployGate | undefined>;
  /** Wait up to ms for a gate; then the gate's outcome. */
  wait: (name: string, id: string, ms: number) => Promise<AgentDeployGate>;
  outcome: (gate: AgentDeployGate) => Promise<AgentDeployOutcome>;
  /** The suites that gate the agent's deploys. */
  required: (name: string) => Promise<Array<{ id: string; name: string; onPublish: boolean; allowRealTools: boolean }>>;
}

/** What the versioning routes need from the host. */
export interface AgentVersionDeps {
  versioning: () => AgentVersioning;
  /** Deploy a published version to production through the deploy gate (written live and recorded when it passes). */
  deploy: (name: string, version: string, req: AgentDeployRequest) => Promise<AgentDeployOutcome>;
  rollback: (name: string, opts: { actor: string; note?: string; to?: string }) => Promise<AgentDeployEntry>;
  /** Who makes the request: "person:<email>", "polpo", "mcp:<client>", an agent's name. */
  actor: (c: Context) => string;
  /** May the caller override a deploy gate (an admin: an instance member, the owner's key, an MCP client with polpo:admin, Polpo)? */
  isAdmin?: (c: Context) => boolean;
  /** Called after a publish/deploy/discard so live clients refresh. */
  changed?: (agentName: string, what: "draft" | "published" | "deployed") => void;
  /** Deploy gates (required agent suites). Absent: deploys are immediate. */
  gates?: AgentDeployGateDeps;
}

/** Longest a request may wait for a deploy gate (wait: true). */
export const DEPLOY_GATE_MAX_WAIT_MS = 10 * 60_000;

/** A deploy request's outcome as an HTTP response: 200 deployed, 202 pending (verifying), 409 blocked. */
export function deployOutcomeResponse(c: Context, outcome: AgentDeployOutcome): Response {
  if (outcome.status === "pending") return c.json({ ok: true, data: { status: "pending", gate: outcome.gate, message: outcome.message } }, 202);
  if (outcome.status === "blocked") {
    const blocked = { status: "blocked", gate: outcome.gate, ...(outcome.entry ? { entry: outcome.entry } : {}) };
    return c.json({ ok: false, error: outcome.message, code: "GATE_BLOCKED", data: blocked, details: blocked }, 409);
  }
  return c.json({ ok: true, data: { ...(outcome.entry ?? {}), status: "deployed", ...(outcome.gate ? { gate: outcome.gate } : {}), message: outcome.message } }, 200);
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
  if ((err as Error)?.name === "AgentSuiteError") {
    // the deploy gate: an override without admin rights (403), a verification in flight (409)…
    const code = (err as { code?: string }).code;
    const status = code === "NOT_FOUND" ? 404 : code === "CONFLICT" ? 409 : code === "FORBIDDEN" ? 403 : 400;
    return c.json({ ok: false, error: (err as Error).message, code: code === "INVALID" || !code ? "VALIDATION_ERROR" : code }, status) as never;
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
      const deps = v();
      const versioning = deps.versioning();
      const [versions, state, gates, pending, required] = await Promise.all([
        versioning.listVersions(name), versioning.state(name),
        deps.gates?.versionStatuses(name).catch(() => ({} as Record<string, AgentVersionGateStatus>)),
        deps.gates?.pending(name).catch(() => undefined),
        deps.gates?.required(name).catch(() => []),
      ]);
      const sorted = [...versions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return c.json({ ok: true, data: {
        state: { ...state, ...(deps.gates ? { gate: { requiredSuites: required ?? [], ...(pending ? { pending } : {}) } } : {}) },
        versions: sorted.map((x) => ({ ...versionSummary(x), ...(gates?.[x.version] ? { gate: gates[x.version] } : {}) })),
      } }, 200);
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

  // POST /agents/{name}/draft/rebase
  app.openapi(createRoute({
    method: "post", path: "/{name}/draft/rebase", tags: ["Agent versions"], summary: "Rebase the draft onto production",
    description: "A draft is based on the version production ran when it started. After a rollback or deploy moved production elsewhere the draft is stale "
      + "(`versioning.draft.stale`): this applies its own changes over what production runs now (or drops it when nothing is left to change).",
    request: { params: nameParam },
    responses: {
      200: { content: { "application/json": { schema: okAny } }, description: "Rebased (from → to, dropped)" },
      404: { content: { "application/json": { schema: errorSchema } }, description: "Agent or draft not found" },
    },
  }), async (c) => {
    const { name } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    try {
      const deps = v();
      const r = await deps.versioning().rebaseDraft(name, deps.actor(c));
      deps.changed?.(name, "draft");
      return c.json({ ok: true, data: { from: r.from, to: r.to, dropped: r.dropped, ...(r.draft ? { draft: r.draft } : {}) } }, 200);
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
        deploy: z.boolean().optional().describe("Also deploy it to production (through the deploy gate when the agent has required suites)"),
        wait: z.boolean().optional().describe("With deploy: wait for the required suites to finish (default: the deploy is returned pending)"),
      }) } } },
    },
    responses: {
      200: { content: { "application/json": { schema: okAny } }, description: "Published (and deployed, or its deploy pending / blocked by the required suites: `deployStatus`, `gate`; without deploy, `check`: the publish checks started)" },
      404: { content: { "application/json": { schema: errorSchema } }, description: "Agent not found" },
      409: { content: { "application/json": { schema: errorSchema } }, description: "No draft changes, the version exists, or the draft is stale (rebase or discard it)" },
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
      if (!body.deploy) {
        // publish checks (required suites with gate.onPublish): non-blocking, the version shows the result
        const check = await deps.gates?.published(name, published.version, actor).catch(() => undefined);
        return c.json({ ok: true, data: { version: published, ...(check ? { check } : {}) } }, 200);
      }
      const outcome = await deps.deploy(name, published.version, {
        actor, admin: deps.isAdmin?.(c) ?? false, ...(body.note ? { note: body.note } : {}), ...(body.wait ? { waitMs: DEPLOY_GATE_MAX_WAIT_MS } : {}),
      });
      if (outcome.status === "deployed") deps.changed?.(name, "deployed");
      return c.json({ ok: true, data: {
        version: published, deployStatus: outcome.status, message: outcome.message,
        ...(outcome.status === "deployed" && outcome.entry ? { deploy: outcome.entry } : {}),
        ...(outcome.gate ? { gate: outcome.gate } : {}),
      } }, 200);
    } catch (err) { return versionErrorResponse(c, err); }
  });

  // POST /agents/{name}/deploy
  app.openapi(createRoute({
    method: "post", path: "/{name}/deploy", tags: ["Agent versions"], summary: "Deploy a version to production",
    description: "Move the production pointer to a published version: everything that runs the agent without a pinned version (chats, tasks, missions, schedules, channels, MCP, Polpo) uses it from its next run; runs in flight keep theirs. Recorded in the deploy history with who, when, from → to and the note.\n\n"
      + "**Deploy gate**: when the agent has required suites (`gate.required`), they run against the version first (trigger `deploy`) and the request answers `202` with the gate pending (`GET …/deploy-gates/{id}`, events `agent:gate`): production moves only when every one passes; otherwise the deploy is blocked and recorded in the history (`action: blocked`). `wait: true` waits for the verdict (`200` deployed, `409` `GATE_BLOCKED`). "
      + "`override: { reason }` (admins only) deploys at once anyway, recording which gates had failed.",
    request: {
      params: nameParam,
      body: { content: { "application/json": { schema: z.object({
        version: z.string().regex(SEMVER, "a version: major.minor.patch"),
        note: z.string().max(2000).optional(),
        override: z.object({ reason: z.string().min(3).max(2000) }).strict().optional().describe("Deploy even if the required suites fail (or without running them): admins only, the reason is recorded"),
        wait: z.boolean().optional().describe("Wait for the required suites (default: return the deploy pending, 202)"),
      }) } } },
    },
    responses: {
      200: { content: { "application/json": { schema: okAny } }, description: "Deployed: the history entry, `status: deployed`, its `gate` when the suites verified it (or an override)" },
      202: { content: { "application/json": { schema: okAny } }, description: "Pending: the required suites are running (`status: pending`, `gate`)" },
      403: { content: { "application/json": { schema: errorSchema } }, description: "An override by someone who is not an admin" },
      404: { content: { "application/json": { schema: errorSchema } }, description: "Agent or version not found" },
      409: { content: { "application/json": { schema: errorSchema } }, description: "Blocked by the required suites (`GATE_BLOCKED`, with `data.gate`), or another version is being verified" },
    },
  }), async (c) => {
    const { name } = c.req.valid("param");
    const body = c.req.valid("json");
    if (!(await exists(name))) return notFound(c, name);
    try {
      const deps = v();
      const outcome = await deps.deploy(name, body.version, {
        actor: deps.actor(c), admin: deps.isAdmin?.(c) ?? false,
        ...(body.note ? { note: body.note } : {}), ...(body.override ? { override: body.override } : {}),
        ...(body.wait ? { waitMs: DEPLOY_GATE_MAX_WAIT_MS } : {}),
      });
      if (outcome.status === "deployed") deps.changed?.(name, "deployed");
      return deployOutcomeResponse(c, outcome) as never;
    } catch (err) { return versionErrorResponse(c, err); }
  });

  // ── Deploy gates ──

  const gates = () => {
    const g = v().gates;
    if (!g) throw new AgentVersionError("Deploy gates are not available on this server", "INVALID");
    return g;
  };
  const gateParam = z.object({ name: z.string(), id: z.string() });

  // GET /agents/{name}/deploy-gates
  app.openapi(createRoute({
    method: "get", path: "/{name}/deploy-gates", tags: ["Agent versions"], summary: "Deploy gates",
    description: "The agent's deploy gates, newest first: the required suites run against a version before a deploy (trigger deploy / api-update) or when it is published (publish). "
      + "Each: status (running — in verifica —, passed, blocked, failed, override, cancelled, errored), progress, each suite's run, pass rate, score, the reasons it failed and its failed cases, the override.",
    request: { params: nameParam, query: z.object({ version: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }) },
    responses: { 200: { content: { "application/json": { schema: okAny } }, description: "Gates" }, 404: { content: { "application/json": { schema: errorSchema } }, description: "Agent not found" } },
  }), async (c) => {
    const { name } = c.req.valid("param");
    const { version, limit } = c.req.valid("query");
    if (!(await exists(name))) return notFound(c, name);
    try {
      return c.json({ ok: true, data: await gates().list(name, { ...(version ? { version } : {}), limit: limit ?? 50 }) }, 200);
    } catch (err) { return versionErrorResponse(c, err); }
  });

  // GET /agents/{name}/deploy-gates/{id}
  app.openapi(createRoute({
    method: "get", path: "/{name}/deploy-gates/{id}", tags: ["Agent versions"], summary: "One deploy gate",
    description: "A gate with its progress (while running), each required suite's run and verdict, the deploy (or block) it led to. `wait` (seconds, up to 55): wait for it to finish first.",
    request: { params: gateParam, query: z.object({ wait: z.coerce.number().int().min(0).max(55).optional() }) },
    responses: { 200: { content: { "application/json": { schema: okAny } }, description: "The gate" }, 404: { content: { "application/json": { schema: errorSchema } }, description: "Not found" } },
  }), async (c) => {
    const { name, id } = c.req.valid("param");
    const { wait } = c.req.valid("query");
    if (!(await exists(name))) return notFound(c, name);
    try {
      const g = gates();
      return c.json({ ok: true, data: wait ? await g.wait(name, id, wait * 1000) : await g.get(name, id) }, 200);
    } catch (err) { return versionErrorResponse(c, err); }
  });

  // POST /agents/{name}/deploy-gates/{id}/cancel
  app.openapi(createRoute({
    method: "post", path: "/{name}/deploy-gates/{id}/cancel", tags: ["Agent versions"], summary: "Cancel a verification",
    description: "Stop a gate that is running: its suite runs are cancelled and nothing is deployed (production is unchanged).",
    request: { params: gateParam },
    responses: {
      200: { content: { "application/json": { schema: okAny } }, description: "Cancelled" },
      404: { content: { "application/json": { schema: errorSchema } }, description: "Not found" },
      409: { content: { "application/json": { schema: errorSchema } }, description: "Not running" },
    },
  }), async (c) => {
    const { name, id } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    try {
      const deps = v();
      const gate = await gates().cancel(name, id, deps.actor(c));
      deps.changed?.(name, "draft");
      return c.json({ ok: true, data: gate }, 200);
    } catch (err) { return versionErrorResponse(c, err); }
  });

  // POST /agents/{name}/deploy-gates/{id}/override
  app.openapi(createRoute({
    method: "post", path: "/{name}/deploy-gates/{id}/override", tags: ["Agent versions"], summary: "Deploy anyway (override)",
    description: "Deploy a gate's version although its required suites did not pass (or are still running: they are cancelled). Admins only; the reason is mandatory. "
      + "The deploy history records the override: who, when, the reason and which gates had failed.",
    request: { params: gateParam, body: { content: { "application/json": { schema: z.object({
      reason: z.string().min(3).max(2000),
      note: z.string().max(2000).optional(),
    }).strict() } } } },
    responses: {
      200: { content: { "application/json": { schema: okAny } }, description: "Deployed with an override" },
      403: { content: { "application/json": { schema: errorSchema } }, description: "Not an admin" },
      404: { content: { "application/json": { schema: errorSchema } }, description: "Not found" },
      409: { content: { "application/json": { schema: errorSchema } }, description: "Already deployed" },
    },
  }), async (c) => {
    const { name, id } = c.req.valid("param");
    const body = c.req.valid("json");
    if (!(await exists(name))) return notFound(c, name);
    try {
      const deps = v();
      const outcome = await gates().override(name, id, { actor: deps.actor(c), reason: body.reason, admin: deps.isAdmin?.(c) ?? false, ...(body.note ? { note: body.note } : {}) });
      deps.changed?.(name, "deployed");
      return deployOutcomeResponse(c, outcome) as never;
    } catch (err) { return versionErrorResponse(c, err); }
  });

  // POST /agents/{name}/rollback
  app.openapi(createRoute({
    method: "post", path: "/{name}/rollback", tags: ["Agent versions"], summary: "Roll production back",
    description: "Deploy the version production ran before the current one (or `to`). A rollback is a deploy: it appears in the history with its diff. It is never gated by the required suites (it must always work); a verification in flight is cancelled.",
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
    description: "Every move of the production pointer, newest first: when, who, from → to, note, rollback marker; deploys the required suites blocked (`action: blocked`). Each entry verified by a deploy gate carries `gate` (status, the suites and their runs, what failed, the override). `diff=true` adds each deploy's diff (per-field changes and a unified diff of the config).",
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
      const deps = v();
      const entries = await deps.versioning().deploys(name, { limit: limit ?? 100, withDiff: diff === "true" });
      return c.json({ ok: true, data: deps.gates ? await deps.gates.attach(name, entries).catch(() => entries) : entries }, 200);
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
      const deps = v();
      const versioning = deps.versioning();
      const found = (await versioning.deploys(name)).find((d) => d.id === id);
      if (!found) return c.json({ ok: false, error: `${name} has no deploy ${id}`, code: "NOT_FOUND" }, 404) as never;
      const [entry] = deps.gates ? await deps.gates.attach(name, [found]).catch(() => [found]) : [found];
      return c.json({ ok: true, data: { ...entry, diff: await versioning.deployDiff(name, entry) } }, 200);
    } catch (err) { return versionErrorResponse(c, err); }
  });
}
