import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  AGENT_TEST_CHECKS,
  type AgentTestCheckId, type AgentTestFixAction, type AgentTestRun, type AgentTestRunRequest,
} from "@polpo-ai/core/agent-tests";

/** What the agent test routes need from the host (src/server/agent-tests.ts). */
export interface AgentTestRouteDeps {
  /** Run the checks (all but the smoke run by default) and keep the run in the agent's history. */
  run: (name: string, req: AgentTestRunRequest, opts: { actor: string; member?: string }) => Promise<AgentTestRun>;
  /** Newest first. */
  history: (name: string, limit?: number) => Promise<AgentTestRun[]>;
  get: (name: string, id: string) => Promise<AgentTestRun | undefined>;
  /** Apply a one-click fix a check offered (e.g. grant a connector's access to the agent). */
  fix: (name: string, action: AgentTestFixAction, opts: { actor: string }) => Promise<{ message: string }>;
  actor: (c: Context) => string;
  /** The member signed in (the CLI engine's policy guard is checked for them). */
  member?: (c: Context) => string | undefined;
}

/** A failure the routes turn into 400 (bad input) or 409 (cannot be done now). */
export class AgentTestError extends Error {
  constructor(message: string, readonly code: "INVALID" | "CONFLICT" | "NOT_FOUND") {
    super(message);
    this.name = "AgentTestError";
  }
}

const errorSchema = z.object({ ok: z.boolean(), error: z.string(), code: z.string() });
const okAny = z.object({ ok: z.boolean(), data: z.any() });
const checkId = z.enum(AGENT_TEST_CHECKS as unknown as [AgentTestCheckId, ...AgentTestCheckId[]]);

const runBody = z.object({
  checks: z.array(checkId).optional().describe("Which checks (default: all but smoke, the live run that costs a real turn)"),
  target: z.string().optional().describe("production (default), draft, or a published version (1.2.0)"),
  startComputer: z.boolean().optional().describe("Start a stopped remote computer to test it (it may cost)"),
  smokePrompt: z.string().max(4000).optional().describe("The smoke run's message (default: call one harmless tool)"),
}).strict();

const fixBody = z.object({
  type: z.literal("grant-connector-access"),
  connector: z.string().min(1),
}).strict();

function errorResponse(c: Context, err: unknown): never {
  if (err instanceof AgentTestError || (err as Error)?.name === "AgentTestError") {
    const e = err as AgentTestError;
    const status = e.code === "NOT_FOUND" ? 404 : e.code === "INVALID" ? 400 : 409;
    return c.json({ ok: false, error: e.message, code: e.code === "INVALID" ? "VALIDATION_ERROR" : e.code }, status) as never;
  }
  if ((err as Error)?.name === "AgentVersionError") {
    const code = (err as { code?: string }).code;
    return c.json({ ok: false, error: (err as Error).message, code: code === "NOT_FOUND" ? "NOT_FOUND" : "VALIDATION_ERROR" }, code === "NOT_FOUND" ? 404 : 400) as never;
  }
  throw err;
}

/**
 * Agent tests under /agents/{name}/tests: run all or some checks, the history, one run, and the
 * one-click fixes. Registered before /agents/{name}.
 */
export function registerAgentTestRoutes(app: OpenAPIHono, getDeps: () => { tests?: AgentTestRouteDeps; getAgents: () => Promise<any[]> }): void {
  const t = () => {
    const deps = getDeps().tests;
    if (!deps) throw new AgentTestError("Agent tests are not available on this server", "CONFLICT");
    return deps;
  };
  const exists = async (name: string) => (await getDeps().getAgents()).some((a) => a.name === name);
  const notFound = (c: Context, name: string): never => c.json({ ok: false, error: `Agent "${name}" not found`, code: "NOT_FOUND" }, 404) as never;
  const nameParam = z.object({ name: z.string() });
  const tags = ["Agent tests"];

  // POST /agents/{name}/tests
  app.openapi(createRoute({
    method: "post", path: "/{name}/tests", tags, summary: "Test an agent",
    description: "Runs checks of everything the agent has at its disposal: engine and model (a minimal real request, a few tokens), tools, connectors, "
      + "vault references (names only), skills, computer and sandbox, channels, versioning; `smoke` (only when listed) runs a tiny real chat turn "
      + "that calls one harmless tool. Each check returns pass / warn / fail with its items and a fix when there is one. The run is kept in the agent's history.",
    request: { params: nameParam, body: { content: { "application/json": { schema: runBody } }, required: false } },
    responses: {
      200: { content: { "application/json": { schema: okAny } }, description: "The run" },
      400: { content: { "application/json": { schema: errorSchema } }, description: "Invalid request" },
      404: { content: { "application/json": { schema: errorSchema } }, description: "Agent or version not found" },
    },
  }), async (c) => {
    const { name } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    const raw = await c.req.json().catch(() => ({}));
    const parsed = runBody.safeParse(raw ?? {});
    if (!parsed.success) return c.json({ ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), code: "VALIDATION_ERROR" }, 400);
    try {
      const deps = t();
      const run = await deps.run(name, parsed.data, { actor: deps.actor(c), member: deps.member?.(c) });
      return c.json({ ok: true, data: run }, 200);
    } catch (err) { return errorResponse(c, err); }
  });

  // GET /agents/{name}/tests
  app.openapi(createRoute({
    method: "get", path: "/{name}/tests", tags, summary: "An agent's test history",
    description: "The agent's test runs, newest first, with each check's result, the target and version tested and when.",
    request: { params: nameParam, query: z.object({ limit: z.string().optional() }) },
    responses: { 200: { content: { "application/json": { schema: okAny } }, description: "Runs" }, 404: { content: { "application/json": { schema: errorSchema } }, description: "Agent not found" } },
  }), async (c) => {
    const { name } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    const limit = Number(c.req.valid("query").limit) || undefined;
    try { return c.json({ ok: true, data: await t().history(name, limit) }, 200); } catch (err) { return errorResponse(c, err); }
  });

  // GET /agents/{name}/tests/{id}
  app.openapi(createRoute({
    method: "get", path: "/{name}/tests/{id}", tags, summary: "One test run",
    request: { params: z.object({ name: z.string(), id: z.string() }) },
    responses: { 200: { content: { "application/json": { schema: okAny } }, description: "The run" }, 404: { content: { "application/json": { schema: errorSchema } }, description: "Not found" } },
  }), async (c) => {
    const { name, id } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    try {
      const run = await t().get(name, id);
      if (!run) return c.json({ ok: false, error: `${name} has no test run ${id}`, code: "NOT_FOUND" }, 404);
      return c.json({ ok: true, data: run }, 200);
    } catch (err) { return errorResponse(c, err); }
  });

  // POST /agents/{name}/tests/fix
  app.openapi(createRoute({
    method: "post", path: "/{name}/tests/fix", tags, summary: "Apply a test's fix",
    description: "Applies a one-click fix a check offered: `grant-connector-access` adds the agent to the connector's access list "
      + "(the agent names the connector's tools in allowedTools but cannot see them).",
    request: { params: nameParam, body: { content: { "application/json": { schema: fixBody } } } },
    responses: {
      200: { content: { "application/json": { schema: okAny } }, description: "Done" },
      400: { content: { "application/json": { schema: errorSchema } }, description: "Invalid fix" },
      404: { content: { "application/json": { schema: errorSchema } }, description: "Agent or connector not found" },
    },
  }), async (c) => {
    const { name } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    const action = c.req.valid("json");
    try {
      const deps = t();
      return c.json({ ok: true, data: await deps.fix(name, action, { actor: deps.actor(c) }) }, 200);
    } catch (err) { return errorResponse(c, err); }
  });
}
