import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  SUITE_MOCK_MODES, summarizeCassette, summarizeSuiteRun,
  type AgentSuite, type CaseGenerationRequest, type CassetteCallEdit, type GeneratedCaseProposal, type SuiteBaselineComparison, type SuiteCase,
  type SuiteCassetteRecord, type SuiteMockMode, type SuiteRole, type SuiteRun, type SuiteRunListOptions, type SuiteRunRequest, type SuiteTrend,
} from "@polpo-ai/core/agent-suites";

/** What the agent suite routes need from the host (src/server/agent-suites.ts). */
export interface AgentSuiteRouteDeps {
  list: (agent: string) => Promise<AgentSuite[]>;
  get: (agent: string, id: string) => Promise<AgentSuite>;
  save: (agent: string, input: unknown, opts: { actor: string; revision?: number; create?: boolean; admin?: boolean }) => Promise<AgentSuite>;
  remove: (agent: string, id: string) => Promise<void>;
  importDataset: (agent: string, id: string, req: { format: "csv" | "json"; text: string; id?: string; name?: string; mode?: "replace" | "append"; coerce?: boolean }, opts: { actor: string }) => Promise<AgentSuite>;
  /** Start a run; `done` resolves when it finishes. */
  startRun: (agent: string, id: string, req: SuiteRunRequest, opts: { actor: string; allowRealTools: boolean }) => Promise<{ run: SuiteRun; done: Promise<SuiteRun> }>;
  listRuns: (agent: string, opts: SuiteRunListOptions) => Promise<SuiteRun[]>;
  getRun: (agent: string, runId: string) => Promise<SuiteRun>;
  cancelRun: (agent: string, runId: string) => Promise<SuiteRun>;
  /** Evals: mark (runId) or clear (undefined) a suite's baseline run. */
  setBaseline: (agent: string, suiteId: string, runId: string | undefined) => Promise<SuiteRun | undefined>;
  getBaseline: (agent: string, suiteId: string) => Promise<SuiteRun | undefined>;
  /** Compare a run with another, or with its suite's baseline now. */
  compareRuns: (agent: string, runId: string, opts: { baselineRunId?: string; tolerance?: number }) => Promise<SuiteBaselineComparison | undefined>;
  trend: (agent: string, suiteId: string, opts: { limit?: number }) => Promise<SuiteTrend>;
  /** "Explain this run": an AI review stored on the run. */
  reviewRun: (agent: string, runId: string, opts: { actor: string; language?: string; reviewer?: SuiteRole }) => Promise<SuiteRun>;
  /** YAML ⇄ objects (the suite's YAML view). */
  toYaml: (value: unknown) => string;
  fromYaml: (text: string) => unknown;
  actor: (c: Context) => string;
  /** An admin (may turn on gate.allowRealTools: deploy gates that run real tools). */
  isAdmin?: (c: Context) => boolean;
  // ── phase 4: cassettes, recordings, generation ──
  listCassettes?: (agent: string) => Promise<SuiteCassetteRecord[]>;
  getCassette?: (agent: string, id: string) => Promise<SuiteCassetteRecord>;
  caseCassette?: (agent: string, suiteId: string, caseId: string) => Promise<SuiteCassetteRecord | null>;
  editCassette?: (agent: string, id: string, edits: CassetteCallEdit[], opts: { actor: string; revision?: number }) => Promise<SuiteCassetteRecord>;
  deleteCassette?: (agent: string, id: string) => Promise<void>;
  /** Record (or re-record) one case live: its exchange becomes its cassette. */
  recordCase?: (agent: string, suiteId: string, caseId: string, req: { target?: string }, opts: { actor: string; allowRealTools: boolean }) => Promise<{ run: SuiteRun; done: Promise<SuiteRun> }>;
  /** A case (and its cassette) from a real chat session or a task run, added to the suite. */
  caseFromRecording?: (agent: string, suiteId: string, req: { sessionId?: string; taskId?: string; messageIndex?: number; name?: string }, opts: { actor: string }) => Promise<{ suite: AgentSuite; case: SuiteCase; cassette: SuiteCassetteRecord }>;
  /** Proposed cases (validated, not saved). */
  generateCases?: (agent: string, req: CaseGenerationRequest & { suiteId?: string; sessionIds?: string[] }) => Promise<{ proposals: GeneratedCaseProposal[]; model?: string; costUsd?: number }>;
  /** Add the cases a person accepted. */
  acceptCases?: (agent: string, suiteId: string, req: { cases: unknown[]; datasets?: unknown[]; revision?: number }, opts: { actor: string }) => Promise<AgentSuite>;
  /** Proposed dataset rows for a case (not saved). */
  generateDatasetRows?: (agent: string, suiteId: string, req: { caseId: string; count?: number; brief?: string; generator?: SuiteRole }) => Promise<{ datasetId?: string; columns: string[]; rows: Array<Record<string, unknown>>; model?: string; costUsd?: number }>;
}

/** Suites of a target other than an agent (a hosted MCP server, a mission): the same routes under that target's path. */
export interface SuiteRouteTarget {
  /** The owner key of `{name}` (`mcp-server:<id>`, `mission:<id>`). */
  owner: (name: string) => string;
  /** Does the target exist? (404 otherwise) */
  exists: (name: string) => Promise<boolean>;
  /** OpenAPI tag. */
  tag: string;
  /** What `{name}` is, in words ("hosted server", "mission"). */
  noun: string;
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

/** Who plays a suite role (the judge, the simulated user, the generator, the reviewer): an agent, or a model + engine block; empty: Polpo. */
export const suiteRoleSchema = z.object({
  agent: z.string().max(170).optional().describe("An existing agent plays the role: its name, optionally @version or @draft (judge-bot@1.2.0)"),
  model: z.string().max(200).optional().describe("Or a model + engine block, as an agent's (run as an ephemeral agent): the model (provider:id)"),
  reasoning: z.string().max(20).optional().describe("The block's reasoning level"),
  engine: z.any().optional().describe('The block\'s engine, as agent.engine: "polpo", { harness, … } or { type: "cli", cli, account?, model? }'),
}).strict().openapi("SuiteRole");

const runBody = z.object({
  target: z.string().optional().describe("production (default), draft, or a published version (1.2.0)"),
  caseIds: z.array(z.string()).optional().describe("Only these cases"),
  mode: modeEnum.optional().describe("Run every case in this mode (default: each case's own): none, tools, model, all"),
  concurrency: z.number().int().min(1).max(4).optional(),
  overrides: overridesSchema.optional().describe("Per-run changes to the agent (model, reasoning, engine, instructions, allowedTools, maxTurns): this run only"),
  variant: z.object({ id: z.string().optional(), label: z.string().optional() }).strict().optional(),
  benchmarkRunId: z.string().optional(),
  repetition: z.number().int().min(0).optional(),
  trigger: z.enum(["manual", "publish", "deploy", "schedule", "ci", "benchmark"]).optional(),
  wait: z.boolean().optional().describe("Wait for the run to finish (default false: the run is returned running)"),
  repetitions: z.number().int().min(1).max(10).optional().describe("Run every case this many times (mean, stddev and flakiness per case; default the suite's evals.repetitions, 1)"),
  baselineRunId: z.string().optional().describe("Compare with this run instead of the suite's baseline"),
  regressionTolerance: z.number().min(0).max(1).optional().describe("A score or pass-rate change within this is not a regression (default the suite's, 0.05)"),
  allowRealTools: z.boolean().optional().describe("Confirm a run that uses real tools (modes none / model, or unmocked tools run for real): side effects are possible; approvals are never given"),
  record: z.boolean().optional().describe("Record: run the cases live (real model and tools; needs allowRealTools and an admin) and save each one's exchange as its cassette (secrets redacted); the cases replay it from then on"),
}).strict();

const editCassetteBody = z.object({
  edits: z.array(z.object({
    callId: z.string().min(1),
    response: z.string().max(200_000).optional(),
    isError: z.boolean().optional(),
    delete: z.boolean().optional(),
    markAsMock: z.boolean().optional().describe("Turn the call into a tool mock of its case (a re-recording keeps it pinned)"),
  }).strict()).min(1).max(500),
  revision: z.number().int().optional(),
}).strict();

const generateBody = z.object({
  suiteId: z.string().optional().describe("The suite the cases are for (ids kept unique)"),
  count: z.number().int().min(1).max(20).optional(),
  brief: z.string().max(4000).optional().describe("What to focus on"),
  sessionIds: z.array(z.string()).max(5).optional().describe("Real chats with the agent to draw from"),
  include: z.array(z.enum(["happy", "edge", "adversarial"])).optional(),
  style: z.enum(["contract", "tools"]).optional().describe("contract (default): scripted model turns and tool mocks (offline); tools: the real model with mocked tools"),
  generator: suiteRoleSchema.optional().describe("Who writes them (default the suite's generator, else Polpo): a chat turn of that agent or model + engine block"),
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
export function registerAgentSuiteRoutes(app: OpenAPIHono, getDeps: () => { suites?: AgentSuiteRouteDeps; getAgents: () => Promise<any[]> }, target?: SuiteRouteTarget): void {
  const s = () => {
    const deps = getDeps().suites;
    if (!deps) throw Object.assign(new Error("Agent suites are not available on this server"), { name: "AgentSuiteError", code: "CONFLICT" });
    return deps;
  };
  // an agent's suites are kept under its name; a target's under its owner key (mcp-server:<id>, mission:<id>)
  const own = (name: string) => (target ? target.owner(name) : name);
  const exists = async (name: string) => (target ? target.exists(name) : (await getDeps().getAgents()).some((a) => a.name === name));
  const notFound = (c: Context, name: string): never => c.json({ ok: false, error: `${target ? `The ${target.noun}` : "Agent"} "${name}" not found`, code: "NOT_FOUND" }, 404) as never;
  const nameParam = z.object({ name: z.string() });
  const suiteParam = z.object({ name: z.string(), id: z.string() });
  const runParam = z.object({ name: z.string(), runId: z.string() });
  const tags = [target?.tag ?? "Agent suites"];
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
    try { return c.json({ ok: true, data: await s().list(own(name)) }, 200); } catch (err) { return errorResponse(c, err); }
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
      return c.json({ ok: true, data: await deps.save(own(name), input, { actor: deps.actor(c), create: true, admin: deps.isAdmin?.(c) ?? false }) }, 200);
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
      const suite = await deps.get(own(name), id);
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
      return c.json({ ok: true, data: await deps.save(own(name), body, { actor: deps.actor(c), admin: deps.isAdmin?.(c) ?? false, ...(revision !== undefined ? { revision } : {}) }) }, 200);
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
    try { await s().remove(own(name), id); return c.json({ ok: true, data: { deleted: id } }, 200); } catch (err) { return errorResponse(c, err); }
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
      return c.json({ ok: true, data: await deps.importDataset(own(name), id, c.req.valid("json"), { actor: deps.actor(c) }) }, 200);
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
      const started = await deps.startRun(own(name), id, req, { actor: deps.actor(c), allowRealTools: allowRealTools === true });
      return c.json({ ok: true, data: wait ? await started.done : started.run }, 200);
    } catch (err) { return errorResponse(c, err); }
  });

  // GET /agents/{name}/suites/{id}/trend
  app.openapi(createRoute({
    method: "get", path: "/{name}/suites/{id}/trend", tags, summary: "A suite's trend",
    description: "The suite's finished runs over time, oldest first: pass rate, overall score, mean per scorer, cost, latency, regressions versus the baseline; and the same by version (production's version, a published one, or draft).",
    request: { params: suiteParam, query: z.object({ limit: z.string().optional() }) },
    responses: { 200: r[200], 404: r[404] },
  }), async (c) => {
    const { name, id } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    const limit = Number(c.req.valid("query").limit);
    try { return c.json({ ok: true, data: await s().trend(own(name), id, Number.isFinite(limit) && limit > 0 ? { limit } : {}) }, 200); } catch (err) { return errorResponse(c, err); }
  });

  // GET /agents/{name}/suites/{id}/baseline
  app.openapi(createRoute({
    method: "get", path: "/{name}/suites/{id}/baseline", tags, summary: "A suite's baseline run",
    description: "The run marked as the suite's baseline (summary, without traces), or null. Without a marked baseline, a new run is compared with the suite's policy (evals.baseline: previous — default —, production or none).",
    request: { params: suiteParam }, responses: { 200: r[200], 404: r[404] },
  }), async (c) => {
    const { name, id } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    try { const b = await s().getBaseline(own(name), id); return c.json({ ok: true, data: b ? summarizeSuiteRun(b) : null }, 200); } catch (err) { return errorResponse(c, err); }
  });

  // PUT /agents/{name}/suites/{id}/baseline
  app.openapi(createRoute({
    method: "put", path: "/{name}/suites/{id}/baseline", tags, summary: "Mark a run as the baseline",
    description: "Marks a finished run of the suite as its baseline: every new run is compared with it (deltas per case and per scorer, regressions and improvements). The previous mark is removed; a marked run is never dropped from the history.",
    request: { params: suiteParam, body: { content: { "application/json": { schema: z.object({ runId: z.string().min(1) }).strict() } } } },
    responses: { 200: r[200], 400: r[400], 404: r[404] },
  }), async (c) => {
    const { name, id } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    try { const run = await s().setBaseline(own(name), id, c.req.valid("json").runId); return c.json({ ok: true, data: run ? summarizeSuiteRun(run) : null }, 200); } catch (err) { return errorResponse(c, err); }
  });

  // DELETE /agents/{name}/suites/{id}/baseline
  app.openapi(createRoute({
    method: "delete", path: "/{name}/suites/{id}/baseline", tags, summary: "Clear the baseline",
    description: "Removes the suite's baseline mark: new runs are compared by the suite's policy (the previous run by default).",
    request: { params: suiteParam }, responses: { 200: r[200], 404: r[404] },
  }), async (c) => {
    const { name, id } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    try { await s().setBaseline(own(name), id, undefined); return c.json({ ok: true, data: null }, 200); } catch (err) { return errorResponse(c, err); }
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
      const runs = await s().listRuns(own(name), { ...(q.suite ? { suiteId: q.suite } : {}), ...(q.benchmark ? { benchmarkRunId: q.benchmark } : {}), ...(Number(q.limit) ? { limit: Number(q.limit) } : {}) });
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
    try { return c.json({ ok: true, data: await s().getRun(own(name), runId) }, 200); } catch (err) { return errorResponse(c, err); }
  });

  // GET /agents/{name}/suite-runs/{runId}/compare
  app.openapi(createRoute({
    method: "get", path: "/{name}/suite-runs/{runId}/compare", tags, summary: "Compare a run with a baseline",
    description: "The run compared with ?baseline=<runId>, or with its suite's baseline now (the marked run, else the suite's policy): pass rate, score, cost and duration deltas; per case and per scorer the change (regressed, improved, unchanged, new, removed) beyond ?tolerance= (default the suite's, 0.05). null when there is nothing to compare with.",
    request: { params: runParam, query: z.object({ baseline: z.string().optional(), tolerance: z.string().optional() }) },
    responses: { 200: r[200], 404: r[404] },
  }), async (c) => {
    const { name, runId } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    const q = c.req.valid("query");
    const tolerance = q.tolerance !== undefined ? Number(q.tolerance) : undefined;
    try {
      return c.json({ ok: true, data: (await s().compareRuns(own(name), runId, { ...(q.baseline ? { baselineRunId: q.baseline } : {}), ...(tolerance !== undefined && Number.isFinite(tolerance) ? { tolerance } : {}) })) ?? null }, 200);
    } catch (err) { return errorResponse(c, err); }
  });

  // POST /agents/{name}/suite-runs/{runId}/review
  app.openapi(createRoute({
    method: "post", path: "/{name}/suite-runs/{runId}/review", tags, summary: "Explain a run (AI review)",
    description: "Asks the suite's reviewer (evals.reviewer, or `reviewer` here: an agent or a model + engine block; default Polpo) to explain a finished run, in a chat turn without tools: a summary, what failed or regressed and why, and suggested fixes (instruction and tool changes, or the test itself). Stored on the run as `review` (Markdown); costs tokens.",
    request: { params: runParam, body: { content: { "application/json": { schema: z.object({ language: z.string().max(40).optional(), reviewer: suiteRoleSchema.optional() }).strict() } }, required: false } },
    responses: { 200: r[200], 400: r[400], 404: r[404], 409: { content: { "application/json": { schema: errorSchema } }, description: "No model, or the review failed" } },
  }), async (c) => {
    const { name, runId } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    const body = (await c.req.json().catch(() => ({}))) as { language?: unknown; reviewer?: unknown };
    const reviewer = body?.reviewer === undefined ? undefined : suiteRoleSchema.safeParse(body.reviewer);
    if (reviewer && !reviewer.success) return invalid(c, reviewer.error.issues);
    try {
      const deps = s();
      return c.json({ ok: true, data: await deps.reviewRun(own(name), runId, {
        actor: deps.actor(c), ...(typeof body?.language === "string" && body.language ? { language: body.language.slice(0, 40) } : {}),
        ...(reviewer?.data ? { reviewer: reviewer.data as SuiteRole } : {}),
      }) }, 200);
    } catch (err) { return errorResponse(c, err); }
  });

  // POST /agents/{name}/suite-runs/{runId}/cancel
  app.openapi(createRoute({
    method: "post", path: "/{name}/suite-runs/{runId}/cancel", tags, summary: "Cancel a suite run",
    description: "Stops a running run: cases not started are skipped; running ones stop before their next model call or tool.",
    request: { params: runParam }, responses: { 200: r[200], 404: r[404] },
  }), async (c) => {
    const { name, runId } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    try { return c.json({ ok: true, data: await s().cancelRun(own(name), runId) }, 200); } catch (err) { return errorResponse(c, err); }
  });

  const caseParam = z.object({ name: z.string(), id: z.string(), caseId: z.string() });
  const unavailable = (what: string) => Object.assign(new Error(`${what} is not available on this server`), { name: "AgentSuiteError", code: "CONFLICT" });
  const need = <K extends keyof AgentSuiteRouteDeps>(k: K, what: string): NonNullable<AgentSuiteRouteDeps[K]> => {
    const fn = s()[k];
    if (!fn) throw unavailable(what);
    return fn as NonNullable<AgentSuiteRouteDeps[K]>;
  };

  // POST /{name}/suites/{id}/cases — add cases (the generated ones a person accepted)
  app.openapi(createRoute({
    method: "post", path: "/{name}/suites/{id}/cases", tags, summary: "Add cases to a suite",
    description: "Appends cases (validated like a saved suite's; an id already used gets a new one) and the datasets they use: e.g. the generated cases a person accepted. `revision` refuses the save when the suite changed meanwhile (409).",
    request: { params: suiteParam, body: { content: { "application/json": { schema: z.object({ cases: z.array(z.any()).min(1).max(200), datasets: z.array(z.any()).optional(), revision: z.number().int().optional() }).strict() } } } },
    responses: { 200: r[200], 400: r[400], 404: r[404] },
  }), async (c) => {
    const { name, id } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    try { return c.json({ ok: true, data: await need("acceptCases", "Adding cases")(own(name), id, c.req.valid("json"), { actor: s().actor(c) }) }, 200); } catch (err) { return errorResponse(c, err); }
  });

  // POST /{name}/suites/{id}/datasets/generate — proposed rows (not saved)
  app.openapi(createRoute({
    method: "post", path: "/{name}/suites/{id}/datasets/generate", tags, summary: "Generate dataset rows",
    description: "The suite's generator (or `generator` here; default Polpo) proposes rows for a case's dataset (its columns kept; edge and adversarial values included), or a first dataset for a case that uses {{row.x}}, in a chat turn without tools. Nothing is saved: add the rows you keep (datasets/import or a save). Costs tokens.",
    request: { params: suiteParam, body: { content: { "application/json": { schema: z.object({ caseId: z.string().min(1), count: z.number().int().min(1).max(50).optional(), brief: z.string().max(2000).optional(), generator: suiteRoleSchema.optional() }).strict() } } } },
    responses: { 200: r[200], 400: r[400], 404: r[404], 409: { content: { "application/json": { schema: errorSchema } }, description: "No model" } },
  }), async (c) => {
    const { name, id } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    try { return c.json({ ok: true, data: await need("generateDatasetRows", "Generation")(own(name), id, c.req.valid("json") as { caseId: string; count?: number; brief?: string; generator?: SuiteRole }) }, 200); } catch (err) { return errorResponse(c, err); }
  });

  // the rest is for agents: cassettes (record / replay) and case generation
  if (target) return;

  // POST /agents/{name}/suites/generate-cases — proposed cases (not saved)
  app.openapi(createRoute({
    method: "post", path: "/{name}/suites/generate-cases", tags, summary: "Generate cases (AI)",
    description: "The suite's generator (or `generator` here: an agent or a model + engine block; default Polpo, in a chat turn without tools) proposes cases from the agent's instructions, tools, skills and connectors (and a brief, sample chats): input, mocks, assertions, scorers and dataset rows, "
      + "including edge cases and adversarial / prompt-injection ones. Each proposal is validated and returned with its rationale; nothing is saved — accept the ones you keep with POST …/suites/{id}/cases. Costs tokens.",
    request: { params: nameParam, body: { content: { "application/json": { schema: generateBody } }, required: false } },
    responses: { 200: r[200], 400: r[400], 404: r[404], 409: { content: { "application/json": { schema: errorSchema } }, description: "No model, or the generation failed" } },
  }), async (c) => {
    const { name } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    const parsed = generateBody.safeParse((await c.req.json().catch(() => ({}))) ?? {});
    if (!parsed.success) return invalid(c, parsed.error.issues);
    try { return c.json({ ok: true, data: await need("generateCases", "Case generation")(name, parsed.data as CaseGenerationRequest & { suiteId?: string; sessionIds?: string[] }) }, 200); } catch (err) { return errorResponse(c, err); }
  });

  // POST /agents/{name}/suites/{id}/cases/from-recording — a case from a real chat or task run
  app.openapi(createRoute({
    method: "post", path: "/{name}/suites/{id}/cases/from-recording", tags, summary: "A case from a real chat or task",
    description: "Turns a chat session with the agent (`sessionId`, the user message at `messageIndex`, default the last one) or a task run (`taskId`, its activity) into a case and its cassette: "
      + "the exchange is replayed offline (mode all) and the same tool calls are checked in order. Secrets are redacted from the cassette. The case is added to the suite.",
    request: { params: suiteParam, body: { content: { "application/json": { schema: z.object({ sessionId: z.string().optional(), taskId: z.string().optional(), messageIndex: z.number().int().min(0).optional(), name: z.string().max(200).optional() }).strict() } } } },
    responses: { 200: r[200], 400: r[400], 404: r[404] },
  }), async (c) => {
    const { name, id } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    try { return c.json({ ok: true, data: await need("caseFromRecording", "Recording from chats")(name, id, c.req.valid("json"), { actor: s().actor(c) }) }, 200); } catch (err) { return errorResponse(c, err); }
  });

  // GET /agents/{name}/suites/{id}/cases/{caseId}/cassette
  app.openapi(createRoute({
    method: "get", path: "/{name}/suites/{id}/cases/{caseId}/cassette", tags, summary: "A case's cassette",
    description: "The recording a case replays (every model turn and tool call with its arguments and result, secrets redacted), or null when it was never recorded.",
    request: { params: caseParam }, responses: { 200: r[200], 404: r[404] },
  }), async (c) => {
    const { name, id, caseId } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    try { return c.json({ ok: true, data: await need("caseCassette", "Cassettes")(name, id, caseId) }, 200); } catch (err) { return errorResponse(c, err); }
  });

  // POST /agents/{name}/suites/{id}/cases/{caseId}/record
  app.openapi(createRoute({
    method: "post", path: "/{name}/suites/{id}/cases/{caseId}/record", tags, summary: "Record (or re-record) a case",
    description: "Runs the case live — the agent's real model and real tools: side effects are possible, so it needs `allowRealTools: true` and an admin (403 otherwise) — and saves its exchange as the case's cassette (secrets redacted: vault values, auth headers, tokens). "
      + "The case then replays it offline. Calls turned into mocks stay pinned. Returns the recording run (finished with `wait: true`).",
    request: { params: caseParam, body: { content: { "application/json": { schema: z.object({ target: z.string().optional(), allowRealTools: z.boolean().optional(), wait: z.boolean().optional() }).strict() } }, required: false } },
    responses: { 200: r[200], 400: r[400], 403: { content: { "application/json": { schema: errorSchema } }, description: "Not confirmed, or not an admin" }, 404: r[404] },
  }), async (c) => {
    const { name, id, caseId } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    const b = (await c.req.json().catch(() => ({}))) as { target?: string; allowRealTools?: boolean; wait?: boolean };
    try {
      const deps = s();
      const allowed = b?.allowRealTools === true && (deps.isAdmin?.(c) ?? true);
      const started = await need("recordCase", "Recording")(name, id, caseId, { ...(typeof b?.target === "string" ? { target: b.target } : {}) }, { actor: deps.actor(c), allowRealTools: allowed });
      return c.json({ ok: true, data: b?.wait ? await started.done : started.run }, 200);
    } catch (err) { return errorResponse(c, err); }
  });

  // GET /agents/{name}/cassettes
  app.openapi(createRoute({
    method: "get", path: "/{name}/cassettes", tags, summary: "An agent's cassettes",
    description: "The recordings its cases replay, newest first, without their calls (tools, how many calls and turns, redactions, where they were recorded).",
    request: { params: nameParam }, responses: { 200: r[200], 404: r[404] },
  }), async (c) => {
    const { name } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    try { return c.json({ ok: true, data: (await need("listCassettes", "Cassettes")(name)).map(summarizeCassette) }, 200); } catch (err) { return errorResponse(c, err); }
  });

  // GET /agents/{name}/cassettes/{cassetteId}
  const cassetteParam = z.object({ name: z.string(), cassetteId: z.string() });
  app.openapi(createRoute({
    method: "get", path: "/{name}/cassettes/{cassetteId}", tags, summary: "One cassette",
    description: "A recording with every model turn and tool call (arguments, result, error, edited, turned into a mock).",
    request: { params: cassetteParam }, responses: { 200: r[200], 404: r[404] },
  }), async (c) => {
    const { name, cassetteId } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    try { return c.json({ ok: true, data: await need("getCassette", "Cassettes")(name, cassetteId) }, 200); } catch (err) { return errorResponse(c, err); }
  });

  // PATCH /agents/{name}/cassettes/{cassetteId}
  app.openapi(createRoute({
    method: "patch", path: "/{name}/cassettes/{cassetteId}", tags, summary: "Edit a cassette",
    description: "Per recorded call: a new `response` (and `isError`), `delete`, or `markAsMock` (the call becomes a tool mock of its case, kept on re-recording). `revision` refuses an edit over a newer one (409).",
    request: { params: cassetteParam, body: { content: { "application/json": { schema: editCassetteBody } } } },
    responses: { 200: r[200], 400: r[400], 404: r[404], 409: { content: { "application/json": { schema: errorSchema } }, description: "Changed meanwhile" } },
  }), async (c) => {
    const { name, cassetteId } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    const b = c.req.valid("json");
    try { return c.json({ ok: true, data: await need("editCassette", "Cassettes")(name, cassetteId, b.edits, { actor: s().actor(c), ...(b.revision !== undefined ? { revision: b.revision } : {}) }) }, 200); } catch (err) { return errorResponse(c, err); }
  });

  // DELETE /agents/{name}/cassettes/{cassetteId}
  app.openapi(createRoute({
    method: "delete", path: "/{name}/cassettes/{cassetteId}", tags, summary: "Delete a cassette",
    description: "Deletes the recording: the cases pointing at it block their tool calls until they are recorded again.",
    request: { params: cassetteParam }, responses: { 200: r[200], 404: r[404] },
  }), async (c) => {
    const { name, cassetteId } = c.req.valid("param");
    if (!(await exists(name))) return notFound(c, name);
    try { await need("deleteCassette", "Cassettes")(name, cassetteId); return c.json({ ok: true, data: { deleted: cassetteId } }, 200); } catch (err) { return errorResponse(c, err); }
  });
}
