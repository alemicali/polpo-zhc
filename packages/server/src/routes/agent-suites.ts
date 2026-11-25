import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  SUITE_MOCK_MODES, summarizeSuiteRun,
  type AgentSuite, type SuiteMockMode, type SuiteRun, type SuiteRunListOptions, type SuiteRunRequest,
} from "@polpo-ai/core/agent-suites";

/** What the agent suite routes need from the host (src/server/agent-suites.ts). */
export interface AgentSuiteRouteDeps {
  list: (agent: string) => Promise<AgentSuite[]>;
  get: (agent: string, id: string) => Promise<AgentSuite>;
  save: (agent: string, input: unknown, opts: { actor: string; revision?: number; create?: boolean }) => Promise<AgentSuite>;
  remove: (agent: string, id: string) => Promise<void>;
  importDataset: (agent: string, id: string, req: { format: "csv" | "json"; text: string; id?: string; name?: string; mode?: "replace" | "append"; coerce?: boolean }, opts: { actor: string }) => Promise<AgentSuite>;
  /** Start a run; `done` resolves when it finishes. */
  startRun: (agent: string, id: string, req: SuiteRunRequest, opts: { actor: string; allowRealTools: boolean }) => Promise<{ run: SuiteRun; done: Promise<SuiteRun> }>;
  listRuns: (agent: string, opts: SuiteRunListOptions) => Promise<SuiteRun[]>;
  getRun: (agent: string, runId: string) => Promise<SuiteRun>;
  cancelRun: (agent: string, runId: string) => Promise<SuiteRun>;
  /** YAML ⇄ objects (the suite's YAML view). */
  toYaml: (value: unknown) => string;
  fromYaml: (text: string) => unknown;
  actor: (c: Context) => string;
}

const errorSchema = z.object({ ok: z.boolean(), error: z.string(), code: z.string() });
const okAny = z.object({ ok: z.boolean(), data: z.any() });
const modeEnum = z.enum(SUITE_MOCK_MODES as unknown as [SuiteMockMode, ...SuiteMockMode[]]);

const overridesSchema = z.object({
  model: z.string().optional(),
  reasoning: z.string().optional(),
  engine: z.any().optional(),
  instructions: z.string().optional(),
  instructionsAppend: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  maxTurns: z.number().int().positive().optional(),
}).strict();

const runBody = z.object({
  target: z.string().optional().describe("production (default), draft, or a published version (1.2.0)"),
  caseIds: z.array(z.string()).optional().describe("Only these cases"),
  mode: modeEnum.optional().describe("Run every case in this mode (default: each case's own): none, tools, model, all"),
  concurrency: z.number().int().min(1).max(4).optional(),
  overrides: overridesSchema.optional().describe("Per-run changes to the agent (model, reasoning, engine, instructions, allowedTools, maxTurns): this run only"),
  variant: z.object({ id: z.string().optional(), label: z.string().optional() }).strict().optional(),
  benchmarkRunId: z.string().optional(),
  repetition: z.number().int().min(0).optional(),
  trigger: z.enum(["manual", "publish", "schedule", "ci", "benchmark"]).optional(),
  wait: z.boolean().optional().describe("Wait for the run to finish (default false: the run is returned running)"),
  allowRealTools: z.boolean().optional().describe("Confirm a run that uses real tools (modes none / model, or unmocked tools run for real): side effects are possible; approvals are never given"),
}).strict();

const importBody = z.object({
  format: z.enum(["csv", "json"]),
  text: z.string().min(1).max(5_000_000),
  id: z.string().optional(),
  name: z.string().optional(),
  mode: z.enum(["replace", "append"]).optional(),
  coerce: z.boolean().optional().describe("CSV: numbers and booleans from text (default true)"),
}).strict();

function errorResponse(c: Context, err: unknown): never {
  const name = (err as Error)?.name;
  if (name === "AgentSuiteError" || name === "AgentVersionError") {
    const code = (err as { code?: string }).code;
    const status = code === "NOT_FOUND" ? 404 : code === "CONFLICT" ? 409 : code === "FORBIDDEN" ? 403 : 400;
    return c.json({ ok: false, error: (err as Error).message, code: code === "INVALID" || !code ? "VALIDATION_ERROR" : code }, status) as never;
  }
  throw err;
}

/** The suite from a body: the suite itself, or { yaml } (the YAML view), with an optional revision. */
function suiteFromBody(deps: AgentSuiteRouteDeps, body: unknown): { input: unknown; revision?: number } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.yaml === "string") {
    let parsed: unknown;
    try { parsed = deps.fromYaml(b.yaml); } catch (err) {
      throw Object.assign(new Error(`YAML: ${(err as Error).message}`), { name: "AgentSuiteError", code: "INVALID" });
    }
    return { input: parsed, ...(typeof b.revision === "number" ? { revision: b.revision } : {}) };
  }
  return { input: b, ...(typeof b.revision === "number" ? { revision: b.revision } : {}) };
}

/**
 * Agent suites under /agents/{name}/suites and /agents/{name}/suite-runs: suites (cases, datasets,
 * mocks), dataset imports, runs against a version with per-case traces. Registered before /agents/{name}.
 */
export function registerAgentSuiteRoutes(app: OpenAPIHono, getDeps: () => { suites?: AgentSuiteRouteDeps; getAgents: () => Promise<any[]> }): void {
  const s = () => {
    const deps = getDeps().suites;
    if (!deps) throw Object.assign(new Error("Agent suites are not available on this server"), { name: "AgentSuiteError", code: "CONFLICT" });
    return deps;
  };
  const exists = async (name: string) => (await getDeps().getAgents()).some((a) => a.name === name);
  const notFound = (c: Context, name: string): never => c.json({ ok: false, error: `Agent "${name}" not found`, code: "NOT_FOUND" }, 404) as never;
  const nameParam = z.object({ name: z.string() });
  const suiteParam = z.object({ name: z.string(), id: z.string() });
  const runParam = z.object({ name: z.string(), runId: z.string() });
  const tags = ["Agent suites"];
  const r = {
    200: { content: { "application/json": { schema: okAny } }, description: "OK" },
    400: { content: { "application/json": { schema: errorSchema } }, description: "Invalid request" },
    404: { content: { "application/json": { schema: errorSchema } }, description: "Not found" },
  };
  const invalid = (c: Context, issues: Array<{ path: PropertyKey[]; message: string }>) =>
    c.json({ ok: false, error: issues.map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`).join("; "), code: "VALIDATION_ERROR" }, 400);

  // GET /agents/{name}/suites
  app.openapi(createRoute({
    method: "get", path: "/{name}/suites", tags, summary: "An agent's suites",
    description: "The agent's test and eval suites (cases, datasets, mocks), by name.",
    request: { params: nameParam }, responses: { 200: r[200], 404: r[404] },
  }), async (c) => {
    const { name } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    try { return c.json({ ok: true, data: await s().list(name) }, 200); } catch (err) { return errorResponse(c, err); }
  });

  // POST /agents/{name}/suites
  app.openapi(createRoute({
    method: "post", path: "/{name}/suites", tags, summary: "Create a suite",
    description: "Creates a suite: { name, description?, defaultMode (none | tools | model | all, default all), mocks?, cases: [{ name, input: { kind: chat | task, message, history?, context? }, "
      + "mode?, mocks?: { tools?: [{ tool, when?, response?, error?, delayMs?, times? }], model?: { turns: [{ text?, toolCalls? }] }, unmockedTools? }, assertions: [...], dataset?, budgets? }], datasets?: [{ name, rows }] }, "
      + "or { yaml } with the same in YAML. Ids are made from names when missing.",
    request: { params: nameParam, body: { content: { "application/json": { schema: z.any() } } } },
    responses: { 200: r[200], 400: r[400], 404: r[404], 409: { content: { "application/json": { schema: errorSchema } }, description: "A suite with this id exists" } },
  }), async (c) => {
    const { name } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    try {
      const deps = s();
      const { input } = suiteFromBody(deps, await c.req.json().catch(() => ({})));
      return c.json({ ok: true, data: await deps.save(name, input, { actor: deps.actor(c), create: true }) }, 200);
    } catch (err) { return errorResponse(c, err); }
  });

  // GET /agents/{name}/suites/{id}
  app.openapi(createRoute({
    method: "get", path: "/{name}/suites/{id}", tags, summary: "One suite",
    description: "The suite; ?format=yaml returns { yaml, revision } (the YAML view).",
    request: { params: suiteParam, query: z.object({ format: z.enum(["json", "yaml"]).optional() }) },
    responses: { 200: r[200], 404: r[404] },
  }), async (c) => {
    const { name, id } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    try {
      const deps = s();
      const suite = await deps.get(name, id);
      if (c.req.valid("query").format === "yaml") {
        const { agent: _a, createdAt: _c, updatedAt: _u, updatedBy: _b, revision, ...rest } = suite;
        return c.json({ ok: true, data: { yaml: deps.toYaml(rest), revision } }, 200);
      }
      return c.json({ ok: true, data: suite }, 200);
    } catch (err) { return errorResponse(c, err); }
  });

  // PUT /agents/{name}/suites/{id}
  app.openapi(createRoute({
    method: "put", path: "/{name}/suites/{id}", tags, summary: "Save a suite",
    description: "Replaces the suite (validated), or creates it. Send `revision` (the one you edited) to refuse the save when someone changed it meanwhile (409). Body: the suite, or { yaml, revision? }.",
    request: { params: suiteParam, body: { content: { "application/json": { schema: z.any() } } } },
    responses: { 200: r[200], 400: r[400], 404: r[404], 409: { content: { "application/json": { schema: errorSchema } }, description: "Changed meanwhile" } },
  }), async (c) => {
    const { name, id } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    try {
      const deps = s();
      const { input, revision } = suiteFromBody(deps, await c.req.json().catch(() => ({})));
      const body = input && typeof input === "object" ? { ...(input as Record<string, unknown>), id } : input;
      return c.json({ ok: true, data: await deps.save(name, body, { actor: deps.actor(c), ...(revision !== undefined ? { revision } : {}) }) }, 200);
    } catch (err) { return errorResponse(c, err); }
  });

  // DELETE /agents/{name}/suites/{id}
  app.openapi(createRoute({
    method: "delete", path: "/{name}/suites/{id}", tags, summary: "Delete a suite",
    description: "Deletes the suite (its past runs stay in the history).",
    request: { params: suiteParam }, responses: { 200: r[200], 404: r[404] },
  }), async (c) => {
    const { name, id } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    try { await s().remove(name, id); return c.json({ ok: true, data: { deleted: id } }, 200); } catch (err) { return errorResponse(c, err); }
  });

  // POST /agents/{name}/suites/{id}/datasets/import
  app.openapi(createRoute({
    method: "post", path: "/{name}/suites/{id}/datasets/import", tags, summary: "Import a dataset",
    description: "Imports rows from CSV (first line: the column names; quotes, comma, semicolon or tab) or JSON (a list of objects, or { rows }) into a new dataset, "
      + "or replaces / appends the rows of the dataset `id`. Cases use a dataset with `dataset: <id>` and {{row.column}} in their input, mocks and assertions.",
    request: { params: suiteParam, body: { content: { "application/json": { schema: importBody } } } },
    responses: { 200: r[200], 400: r[400], 404: r[404] },
  }), async (c) => {
    const { name, id } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    try {
      const deps = s();
      return c.json({ ok: true, data: await deps.importDataset(name, id, c.req.valid("json"), { actor: deps.actor(c) }) }, 200);
    } catch (err) { return errorResponse(c, err); }
  });

  // POST /agents/{name}/suites/{id}/runs
  app.openapi(createRoute({
    method: "post", path: "/{name}/suites/{id}/runs", tags, summary: "Run a suite",
    description: "Runs the suite (or `caseIds`) against the agent at `target` (production, draft, 1.2.0), each case a real chat turn through the agent's own path with its mocks: "
      + "mode all runs offline (scripted model, mocked tools), tools mocks the tools (real model), model scripts the model (real tools), none is live. "
      + "A run that uses real tools needs `allowRealTools: true` (403 otherwise); approvals are never given. `overrides` change the agent for this run only. "
      + "Returns the run (running, or finished with `wait: true`); poll GET /agents/{name}/suite-runs/{runId}.",
    request: { params: suiteParam, body: { content: { "application/json": { schema: runBody } }, required: false } },
    responses: { 200: r[200], 400: r[400], 403: { content: { "application/json": { schema: errorSchema } }, description: "Real tools not confirmed" }, 404: r[404] },
  }), async (c) => {
    const { name, id } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    const parsed = runBody.safeParse((await c.req.json().catch(() => ({}))) ?? {});
    if (!parsed.success) return invalid(c, parsed.error.issues);
    const { wait, allowRealTools, ...req } = parsed.data;
    try {
      const deps = s();
      const started = await deps.startRun(name, id, req, { actor: deps.actor(c), allowRealTools: allowRealTools === true });
      return c.json({ ok: true, data: wait ? await started.done : started.run }, 200);
    } catch (err) { return errorResponse(c, err); }
  });

  // GET /agents/{name}/suite-runs
  app.openapi(createRoute({
    method: "get", path: "/{name}/suite-runs", tags, summary: "An agent's suite runs",
    description: "Runs, newest first, without traces (each case's status, failed assertions, cost, duration); ?suite= one suite, ?benchmark= one benchmark, ?full=true with traces.",
    request: { params: nameParam, query: z.object({ suite: z.string().optional(), benchmark: z.string().optional(), limit: z.string().optional(), full: z.string().optional() }) },
    responses: { 200: r[200], 404: r[404] },
  }), async (c) => {
    const { name } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    const q = c.req.valid("query");
    try {
      const runs = await s().listRuns(name, { ...(q.suite ? { suiteId: q.suite } : {}), ...(q.benchmark ? { benchmarkRunId: q.benchmark } : {}), ...(Number(q.limit) ? { limit: Number(q.limit) } : {}) });
      return c.json({ ok: true, data: q.full === "true" ? runs : runs.map(summarizeSuiteRun) }, 200);
    } catch (err) { return errorResponse(c, err); }
  });

  // GET /agents/{name}/suite-runs/{runId}
  app.openapi(createRoute({
    method: "get", path: "/{name}/suite-runs/{runId}", tags, summary: "One suite run",
    description: "The run with each case's assertions (pass / fail, message, expected, actual, diff) and trace (model turns, tool calls with arguments and results, mocks hit, approvals, usage).",
    request: { params: runParam }, responses: { 200: r[200], 404: r[404] },
  }), async (c) => {
    const { name, runId } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    try { return c.json({ ok: true, data: await s().getRun(name, runId) }, 200); } catch (err) { return errorResponse(c, err); }
  });

  // POST /agents/{name}/suite-runs/{runId}/cancel
  app.openapi(createRoute({
    method: "post", path: "/{name}/suite-runs/{runId}/cancel", tags, summary: "Cancel a suite run",
    description: "Stops a running run: cases not started are skipped; running ones stop before their next model call or tool.",
    request: { params: runParam }, responses: { 200: r[200], 404: r[404] },
  }), async (c) => {
    const { name, runId } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    try { return c.json({ ok: true, data: await s().cancelRun(name, runId) }, 200); } catch (err) { return errorResponse(c, err); }
  });
}
