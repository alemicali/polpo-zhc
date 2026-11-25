import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import {
  SUITE_MOCK_MODES,
  type AgentSuite, type BenchmarkCaseComparison, type BenchmarkDefinition, type BenchmarkEstimate, type BenchmarkLeaderboard, type BenchmarkMatrix,
  type BenchmarkRun, type BenchmarkVariantStats, type BenchmarkWeights, type PlaygroundExchange, type PlaygroundPane, type PlaygroundSession,
  type SuiteCase, type SuiteMockMode, type SuiteVariantOverrides,
} from "@polpo-ai/core/agent-suites";

/** A pane's live event while it answers (text deltas, model turns, tool calls, the finished exchange). */
export type PlaygroundRouteEvent = { type: string; [k: string]: unknown };

/** What the benchmark and Playground routes need from the host (src/server/agent-benchmarks.ts). */
export interface BenchmarkRouteDeps {
  list: () => Promise<BenchmarkDefinition[]>;
  get: (id: string) => Promise<BenchmarkDefinition>;
  save: (input: unknown, opts: { actor: string; revision?: number; create?: boolean; id?: string }) => Promise<BenchmarkDefinition>;
  remove: (id: string) => Promise<void>;
  estimate: (req: { benchmarkId?: string; benchmark?: unknown }) => Promise<BenchmarkEstimate>;
  start: (req: { benchmarkId?: string; benchmark?: unknown }, opts: { actor: string; allowRealTools: boolean; confirm: boolean; budgetUsd?: number; source?: string }) => Promise<{ run: BenchmarkRun; done: Promise<BenchmarkRun> }>;
  listRuns: (opts: { benchmarkId?: string; limit?: number }) => Promise<BenchmarkRun[]>;
  report: (id: string, weights?: BenchmarkWeights) => Promise<{ run: BenchmarkRun; stats: BenchmarkVariantStats[]; leaderboard: BenchmarkLeaderboard; matrix: BenchmarkMatrix }>;
  cancel: (id: string) => Promise<BenchmarkRun>;
  compare: (id: string, caseKey: string, opts: { variants?: string[]; repetition?: number }) => Promise<BenchmarkCaseComparison>;
  // ── Playground ──
  sessions: (actor: string) => PlaygroundSession[];
  createSession: (panes: unknown, opts: { actor: string }) => Promise<PlaygroundSession>;
  getSession: (id: string) => PlaygroundSession;
  updateSession: (id: string, panes: unknown) => Promise<PlaygroundSession>;
  deleteSession: (id: string) => void;
  resetSession: (id: string, paneId?: string) => PlaygroundSession;
  send: (id: string, req: { message: string; paneIds?: string[]; allowRealTools?: boolean }, onEvent?: (paneId: string, e: PlaygroundRouteEvent) => void, signal?: AbortSignal) => Promise<{ session: PlaygroundSession; exchanges: Record<string, PlaygroundExchange> }>;
  sendOnce: (panes: unknown, req: { message: string; allowRealTools?: boolean }, opts: { actor: string }) => Promise<{ panes: PlaygroundPane[]; exchanges: Record<string, PlaygroundExchange> }>;
  caseFromExchange: (id: string, req: { paneId: string; exchange?: number; name?: string; mockModel?: boolean; save?: { agent: string; suite: string } }, opts: { actor: string }) => Promise<{ case: SuiteCase; suite?: AgentSuite }>;
  promote: (req: { agent: string; version?: string; overrides?: SuiteVariantOverrides; note?: string }, opts: { actor: string }) => Promise<{ agent: string; fields: Record<string, unknown>; draftChanged: boolean }>;
  actor: (c: Context) => string;
  /** An admin (real tools; promoting a variant writes an agent's draft). */
  isAdmin: (c: Context) => boolean;
}

const errorSchema = z.object({ ok: z.boolean(), error: z.string(), code: z.string(), data: z.any().optional() });
const okAny = z.object({ ok: z.boolean(), data: z.any() });
const modeEnum = z.enum(SUITE_MOCK_MODES as unknown as [SuiteMockMode, ...SuiteMockMode[]]);

const overridesSchema = z.object({
  model: z.string().optional(), reasoning: z.string().optional(), engine: z.any().optional(),
  instructions: z.string().optional(), instructionsAppend: z.string().optional(),
  allowedTools: z.array(z.string()).optional(), maxTurns: z.number().int().positive().optional(),
}).strict();

const variantSchema = z.object({
  id: z.string().optional(), label: z.string().optional(),
  agent: z.string().describe("Any agent: the suites' cases run against it"),
  version: z.string().optional().describe("production (default), draft or a published version"),
  overrides: overridesSchema.optional().describe("This variant only: model, reasoning, engine, instructions (replace) / instructionsAppend, allowedTools, maxTurns"),
});

const benchmarkSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  description: z.string().optional(),
  suites: z.array(z.object({
    agent: z.string().describe("The agent the suite belongs to"), suite: z.string(),
    caseIds: z.array(z.string()).optional(), dataset: z.string().optional().describe("Only the cases that use this dataset (a benchmark over a dataset)"),
  })).min(1).max(20),
  variants: z.array(variantSchema).min(1).max(8),
  repetitions: z.number().int().min(1).max(10).optional(),
  mode: modeEnum.optional().describe("Every case in this mode (all: offline and free)"),
  concurrency: z.number().int().min(1).max(4).optional(),
  budgetUsd: z.number().min(0).optional().describe("Stop once it has spent this much (USD)"),
  weights: z.object({ quality: z.number().min(0).optional(), cost: z.number().min(0).optional(), latency: z.number().min(0).optional() }).optional(),
  revision: z.number().int().optional(),
}).passthrough();

const paneSchema = z.object({
  id: z.string().optional(), label: z.string().optional(),
  variant: z.object({ agent: z.string(), version: z.string().optional(), overrides: overridesSchema.optional() }),
  mockTools: z.boolean().optional().describe("Answer tool calls with the mocks (default true)"),
  mockModel: z.boolean().optional().describe("Script the model from mocks.model (offline)"),
  realTools: z.boolean().optional().describe("Calls no mock answers run for real (admins, with allowRealTools: true); off: they are blocked"),
  mocks: z.object({
    suite: z.object({ agent: z.string().optional(), suite: z.string(), caseId: z.string().optional() }).optional().describe("A suite's mocks (its shared ones and a case's)"),
    tools: z.array(z.any()).optional(), model: z.any().optional(),
  }).optional(),
});

function errorResponse(c: Context, err: unknown): never {
  const e = err as Error & { code?: string; reason?: string; estimate?: unknown };
  if (e?.name === "AgentSuiteError" || e?.name === "AgentVersionError") {
    const status = e.code === "NOT_FOUND" ? 404 : e.code === "CONFLICT" ? 409 : e.code === "FORBIDDEN" ? 403 : 400;
    const code = e.reason ?? (e.code === "INVALID" || !e.code ? "VALIDATION_ERROR" : e.code);
    return c.json({ ok: false, error: e.message, code, ...(e.estimate ? { data: { estimate: e.estimate } } : {}) }, status) as never;
  }
  throw err;
}

function weightsFrom(q: { quality?: string; cost?: string; latency?: string }): BenchmarkWeights | undefined {
  if (q.quality === undefined && q.cost === undefined && q.latency === undefined) return undefined;
  const n = (v: string | undefined) => { const x = Number(v ?? 0); return Number.isFinite(x) && x >= 0 ? x : 0; };
  const w = { quality: n(q.quality), cost: n(q.cost), latency: n(q.latency) };
  return w.quality + w.cost + w.latency > 0 ? w : undefined;
}

/**
 * Benchmarks (/benchmarks, /benchmark-runs) and the Playground (/playground): agent suites phase 5
 * (docs/agent-suites.md). Mounted at the API root.
 */
export function benchmarkRoutes(getDeps: () => BenchmarkRouteDeps | undefined): OpenAPIHono {
  const app = new OpenAPIHono();
  const d = () => {
    const deps = getDeps();
    if (!deps) throw Object.assign(new Error("Benchmarks are not available on this server"), { name: "AgentSuiteError", code: "CONFLICT" });
    return deps;
  };
  const tags = ["Benchmarks"];
  const ptags = ["Playground"];
  const r = {
    200: { content: { "application/json": { schema: okAny } }, description: "OK" },
    400: { content: { "application/json": { schema: errorSchema } }, description: "Invalid request" },
    403: { content: { "application/json": { schema: errorSchema } }, description: "Real tools need an admin and allowRealTools: true" },
    404: { content: { "application/json": { schema: errorSchema } }, description: "Not found" },
    409: { content: { "application/json": { schema: errorSchema } }, description: "Changed meanwhile, the cost not confirmed (CONFIRM_COST, with the estimate), over the budget cap (OVER_BUDGET), or busy" },
  };
  const idParam = z.object({ id: z.string() });
  const runParam = z.object({ runId: z.string() });
  const body = async (c: Context) => (await c.req.json().catch(() => ({}))) ?? {};

  // ── definitions ──

  app.openapi(createRoute({ method: "get", path: "/benchmarks", tags, summary: "Benchmarks", description: "The saved benchmarks: suites × variants × repetitions.", responses: { 200: r[200] } }), async (c) => {
    try { return c.json({ ok: true, data: await d().list() }, 200); } catch (err) { return errorResponse(c, err); }
  });

  app.openapi(createRoute({
    method: "post", path: "/benchmarks", tags, summary: "Create a benchmark",
    description: "Saves a benchmark: { name, suites: [{ agent, suite, caseIds?, dataset? }], variants: [{ agent (any agent), version?, label?, overrides? }], repetitions? (1–10), mode?, concurrency?, budgetUsd?, weights?: { quality, cost, latency } }. Its id is made from the name.",
    request: { body: { content: { "application/json": { schema: benchmarkSchema } } } },
    responses: { 200: r[200], 400: r[400], 404: r[404], 409: r[409] },
  }), async (c) => {
    try { const deps = d(); return c.json({ ok: true, data: await deps.save(await body(c), { actor: deps.actor(c), create: true }) }, 200); } catch (err) { return errorResponse(c, err); }
  });

  app.openapi(createRoute({ method: "get", path: "/benchmarks/{id}", tags, summary: "One benchmark", request: { params: idParam }, responses: { 200: r[200], 404: r[404] } }), async (c) => {
    try { return c.json({ ok: true, data: await d().get(c.req.valid("param").id) }, 200); } catch (err) { return errorResponse(c, err); }
  });

  app.openapi(createRoute({
    method: "put", path: "/benchmarks/{id}", tags, summary: "Save a benchmark",
    description: "Replaces (or creates) the benchmark. `revision`: the one you edited (409 when it changed meanwhile).",
    request: { params: idParam, body: { content: { "application/json": { schema: benchmarkSchema } } } },
    responses: { 200: r[200], 400: r[400], 404: r[404], 409: r[409] },
  }), async (c) => {
    try {
      const deps = d();
      const b = await body(c) as Record<string, unknown>;
      return c.json({ ok: true, data: await deps.save(b, { actor: deps.actor(c), id: c.req.valid("param").id, ...(typeof b.revision === "number" ? { revision: b.revision } : {}) }) }, 200);
    } catch (err) { return errorResponse(c, err); }
  });

  app.openapi(createRoute({ method: "delete", path: "/benchmarks/{id}", tags, summary: "Delete a benchmark", description: "Deletes the definition (its past runs stay).", request: { params: idParam }, responses: { 200: r[200], 404: r[404] } }), async (c) => {
    try { const { id } = c.req.valid("param"); await d().remove(id); return c.json({ ok: true, data: { deleted: id } }, 200); } catch (err) { return errorResponse(c, err); }
  });

  const runRef = z.object({ benchmarkId: z.string().optional().describe("A saved benchmark"), benchmark: benchmarkSchema.optional().describe("Or an inline one (not saved)") });

  app.openapi(createRoute({
    method: "post", path: "/benchmarks/estimate", tags, summary: "Estimate a benchmark's cost",
    description: "What a benchmark would cost before it runs: per suite and variant the cases, those calling a real model and the judges, priced from the suite's past runs on that model, else from the prompt size and the model's price; `offline` when nothing costs. Also checks every run can start.",
    request: { body: { content: { "application/json": { schema: runRef } } } },
    responses: { 200: r[200], 400: r[400], 404: r[404] },
  }), async (c) => {
    try { return c.json({ ok: true, data: await d().estimate(await body(c) as { benchmarkId?: string; benchmark?: unknown }) }, 200); } catch (err) { return errorResponse(c, err); }
  });

  app.openapi(createRoute({
    method: "post", path: "/benchmarks/runs", tags, summary: "Run a benchmark",
    description: "Starts a benchmark (a saved one, or inline): one suite run per suite × variant × repetition, all within the instance's limits (two runs at a time; the others wait), tagged with the benchmark. "
      + "A benchmark that calls a real model needs `confirm: true` (409 CONFIRM_COST with the estimate otherwise); one whose estimate is above the budget cap is refused (409 OVER_BUDGET); the cap stops it once spent. "
      + "Real tools need `allowRealTools: true` and an admin (403). Progress: GET /benchmark-runs/{runId}, the `benchmark:progress` event. `wait: true` answers when it finishes.",
    request: { body: { content: { "application/json": { schema: runRef.extend({
      confirm: z.boolean().optional().describe("The cost estimate was seen and accepted"),
      allowRealTools: z.boolean().optional(),
      budgetUsd: z.number().min(0).optional().describe("The budget cap for this run (default the benchmark's)"),
      wait: z.boolean().optional(),
      source: z.string().max(40).optional().describe("Where it was started from (suites, benchmarks, playground, cli…)"),
    }) } } } },
    responses: { 200: r[200], 400: r[400], 403: r[403], 404: r[404], 409: r[409] },
  }), async (c) => {
    try {
      const deps = d();
      const b = await body(c) as { benchmarkId?: string; benchmark?: unknown; confirm?: boolean; allowRealTools?: boolean; budgetUsd?: number; wait?: boolean; source?: string };
      const started = await deps.start({ ...(b.benchmarkId ? { benchmarkId: b.benchmarkId } : {}), ...(b.benchmark !== undefined ? { benchmark: b.benchmark } : {}) }, {
        actor: deps.actor(c), allowRealTools: b.allowRealTools === true && deps.isAdmin(c), confirm: b.confirm === true,
        ...(typeof b.budgetUsd === "number" ? { budgetUsd: b.budgetUsd } : {}), ...(typeof b.source === "string" ? { source: b.source.slice(0, 40) } : {}),
      });
      return c.json({ ok: true, data: b.wait ? await started.done : started.run }, 200);
    } catch (err) { return errorResponse(c, err); }
  });

  // ── runs ──

  app.openapi(createRoute({
    method: "get", path: "/benchmark-runs", tags, summary: "Benchmark runs",
    description: "Benchmark runs, newest first (?benchmark= one benchmark's): status, progress, spent, the leaderboard when finished.",
    request: { query: z.object({ benchmark: z.string().optional(), limit: z.string().optional() }) }, responses: { 200: r[200] },
  }), async (c) => {
    const q = c.req.valid("query");
    try { return c.json({ ok: true, data: await d().listRuns({ ...(q.benchmark ? { benchmarkId: q.benchmark } : {}), ...(Number(q.limit) > 0 ? { limit: Number(q.limit) } : {}) }) }, 200); } catch (err) { return errorResponse(c, err); }
  });

  const weightQuery = z.object({ quality: z.string().optional(), cost: z.string().optional(), latency: z.string().optional() });

  app.openapi(createRoute({
    method: "get", path: "/benchmark-runs/{runId}", tags, summary: "One benchmark run (the comparison)",
    description: "{ run, stats, leaderboard, matrix }: per variant the pass rate, score and per-scorer means (± stddev over repetitions), cost, latency p50 / p95, tokens and flakiness; the leaderboard ranked with ?quality=&cost=&latency= weights (default the benchmark's), its Pareto front and notes on differences within noise; the case × variant matrix.",
    request: { params: runParam, query: weightQuery }, responses: { 200: r[200], 404: r[404] },
  }), async (c) => {
    try { return c.json({ ok: true, data: await d().report(c.req.valid("param").runId, weightsFrom(c.req.valid("query"))) }, 200); } catch (err) { return errorResponse(c, err); }
  });

  app.openapi(createRoute({
    method: "get", path: "/benchmark-runs/{runId}/leaderboard", tags, summary: "A benchmark's leaderboard",
    description: "The variants ranked by a weighted composite of quality (score, else pass rate), cost and latency (?quality=&cost=&latency=), the Pareto front, and statistical notes.",
    request: { params: runParam, query: weightQuery }, responses: { 200: r[200], 404: r[404] },
  }), async (c) => {
    try { const rep = await d().report(c.req.valid("param").runId, weightsFrom(c.req.valid("query"))); return c.json({ ok: true, data: { ...rep.leaderboard, stats: rep.stats } }, 200); } catch (err) { return errorResponse(c, err); }
  });

  app.openapi(createRoute({
    method: "get", path: "/benchmark-runs/{runId}/matrix", tags, summary: "A benchmark's case × variant matrix",
    description: "One row per case (dataset rows apart), one cell per variant: attempts, pass rate, score, cost, latency and its results (run, key) to open the traces.",
    request: { params: runParam }, responses: { 200: r[200], 404: r[404] },
  }), async (c) => {
    try { return c.json({ ok: true, data: (await d().report(c.req.valid("param").runId)).matrix }, 200); } catch (err) { return errorResponse(c, err); }
  });

  app.openapi(createRoute({
    method: "get", path: "/benchmark-runs/{runId}/compare", tags, summary: "One case side by side",
    description: "A case (?case= its matrix key, or its id) for 2–4 variants (?variants=a,b; default every variant, at most four) side by side: each one's trace, the tool calls aligned and diffed (names, arguments), the final answers diffed word by word against the first column.",
    request: { params: runParam, query: z.object({ case: z.string(), variants: z.string().optional(), repetition: z.string().optional() }) },
    responses: { 200: r[200], 404: r[404] },
  }), async (c) => {
    const q = c.req.valid("query");
    try {
      return c.json({ ok: true, data: await d().compare(c.req.valid("param").runId, q.case, {
        ...(q.variants ? { variants: q.variants.split(",").map((x) => x.trim()).filter(Boolean) } : {}), ...(Number(q.repetition) > 0 ? { repetition: Number(q.repetition) } : {}),
      }) }, 200);
    } catch (err) { return errorResponse(c, err); }
  });

  app.openapi(createRoute({
    method: "post", path: "/benchmark-runs/{runId}/cancel", tags, summary: "Cancel a benchmark",
    description: "Stops the benchmark: its suite runs not finished are cancelled (cases not started skipped). Answers when it has stopped.",
    request: { params: runParam }, responses: { 200: r[200], 404: r[404] },
  }), async (c) => {
    try { return c.json({ ok: true, data: await d().cancel(c.req.valid("param").runId) }, 200); } catch (err) { return errorResponse(c, err); }
  });

  // ── Playground ──

  const sendBody = z.object({
    message: z.string().min(1).max(50_000),
    paneIds: z.array(z.string()).optional().describe("Only these panes (default every pane)"),
    allowRealTools: z.boolean().optional().describe("Confirm panes with real tools (admins)"),
    stream: z.boolean().optional().describe("Answer as text/event-stream: start, text, turn, tool and done events per pane (paneId in each), then end with the session"),
  });

  app.openapi(createRoute({ method: "get", path: "/playground/sessions", tags: ptags, summary: "Playground sessions", description: "The open Playground sessions (ephemeral: they end after two idle hours or a restart).", responses: { 200: r[200] } }), async (c) => {
    try { const deps = d(); return c.json({ ok: true, data: deps.sessions(deps.actor(c)) }, 200); } catch (err) { return errorResponse(c, err); }
  });

  app.openapi(createRoute({
    method: "post", path: "/playground/sessions", tags: ptags, summary: "Open a Playground session",
    description: "1–4 chat panes side by side, each bound to a variant (agent, version, overrides) with its own mocks: mockTools (default on), mockModel (scripted turns), realTools (admins).",
    request: { body: { content: { "application/json": { schema: z.object({ panes: z.array(paneSchema).min(1).max(4) }) } } } },
    responses: { 200: r[200], 400: r[400], 404: r[404] },
  }), async (c) => {
    try { const deps = d(); const b = await body(c) as { panes?: unknown }; return c.json({ ok: true, data: await deps.createSession(b.panes, { actor: deps.actor(c) }) }, 200); } catch (err) { return errorResponse(c, err); }
  });

  app.openapi(createRoute({ method: "get", path: "/playground/sessions/{id}", tags: ptags, summary: "One Playground session", description: "Its panes and each pane's exchanges (traces, cost, latency, tokens).", request: { params: idParam }, responses: { 200: r[200], 404: r[404] } }), async (c) => {
    try { return c.json({ ok: true, data: d().getSession(c.req.valid("param").id) }, 200); } catch (err) { return errorResponse(c, err); }
  });

  app.openapi(createRoute({
    method: "put", path: "/playground/sessions/{id}", tags: ptags, summary: "Change the panes",
    description: "Replaces the panes; a pane whose variant and toggles are unchanged keeps its conversation.",
    request: { params: idParam, body: { content: { "application/json": { schema: z.object({ panes: z.array(paneSchema).min(1).max(4) }) } } } },
    responses: { 200: r[200], 400: r[400], 404: r[404] },
  }), async (c) => {
    try { const b = await body(c) as { panes?: unknown }; return c.json({ ok: true, data: await d().updateSession(c.req.valid("param").id, b.panes) }, 200); } catch (err) { return errorResponse(c, err); }
  });

  app.openapi(createRoute({ method: "delete", path: "/playground/sessions/{id}", tags: ptags, summary: "Close a Playground session", request: { params: idParam }, responses: { 200: r[200], 404: r[404] } }), async (c) => {
    try { const { id } = c.req.valid("param"); d().deleteSession(id); return c.json({ ok: true, data: { deleted: id } }, 200); } catch (err) { return errorResponse(c, err); }
  });

  app.openapi(createRoute({
    method: "post", path: "/playground/sessions/{id}/reset", tags: ptags, summary: "Clear the conversations",
    request: { params: idParam, body: { content: { "application/json": { schema: z.object({ paneId: z.string().optional() }) } }, required: false } },
    responses: { 200: r[200], 404: r[404] },
  }), async (c) => {
    try { const b = await body(c) as { paneId?: string }; return c.json({ ok: true, data: d().resetSession(c.req.valid("param").id, typeof b.paneId === "string" ? b.paneId : undefined) }, 200); } catch (err) { return errorResponse(c, err); }
  });

  app.openapi(createRoute({
    method: "post", path: "/playground/sessions/{id}/send", tags: ptags, summary: "Send a message to the panes",
    description: "Sends the message to every pane (or `paneIds`) at once; each pane continues its conversation as a test chat (deleted afterwards, like a suite case). Returns { session, exchanges } (each pane's trace, cost, latency, tokens); with `stream: true`, server-sent events as the panes answer. Panes with real tools need `allowRealTools: true` and an admin (403).",
    request: { params: idParam, body: { content: { "application/json": { schema: sendBody } } } },
    responses: { 200: { content: { "application/json": { schema: okAny }, "text/event-stream": { schema: z.string() } }, description: "The exchanges, or a stream" }, 400: r[400], 403: r[403], 404: r[404], 409: r[409] },
  }), async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    try {
      const deps = d();
      const session = deps.getSession(id);
      const allow = b.allowRealTools === true && deps.isAdmin(c);
      const panes = b.paneIds?.length ? session.panes.filter((p) => b.paneIds!.includes(p.id)) : session.panes;
      if (panes.some((p) => p.realTools) && !allow) {
        return c.json({ ok: false, error: "A pane runs real tools (side effects possible): it needs an admin and allowRealTools: true", code: "FORBIDDEN" }, 403);
      }
      const req = { message: b.message, ...(b.paneIds ? { paneIds: b.paneIds } : {}), allowRealTools: allow };
      if (!b.stream) return c.json({ ok: true, data: await deps.send(id, req) }, 200);
      return streamSSE(c, async (stream) => {
        let chain = Promise.resolve();
        const write = (event: string, data: unknown) => { chain = chain.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(() => undefined); return chain; };
        const ac = new AbortController();
        stream.onAbort(() => ac.abort());
        try {
          const out = await deps.send(id, req, (paneId, e) => { void write(e.type, { paneId, ...e }); }, ac.signal);
          await write("end", out);
        } catch (err) {
          const e = err as Error & { code?: string };
          await write("error", { error: e.message, code: e.code ?? "ERROR" });
        }
        await chain;
      });
    } catch (err) { return errorResponse(c, err); }
  });

  app.openapi(createRoute({
    method: "post", path: "/playground/sessions/{id}/case", tags: ptags, summary: "Save an exchange as a test case",
    description: "A pane's exchange (default its last) as a suite case: the observed tool calls become mocks (their observed results) and checks (same tools, same arguments, in order); `mockModel` also scripts the model turns (an offline contract case). "
      + "Without `save` the case is returned for review (add it with POST /agents/{name}/suites/{id}/cases); with `save: { agent, suite }` it is added to that suite.",
    request: { params: idParam, body: { content: { "application/json": { schema: z.object({
      paneId: z.string(), exchange: z.number().int().min(0).optional(), name: z.string().max(200).optional(), mockModel: z.boolean().optional(),
      save: z.object({ agent: z.string(), suite: z.string() }).optional(),
    }) } } } },
    responses: { 200: r[200], 400: r[400], 404: r[404], 409: r[409] },
  }), async (c) => {
    try { const deps = d(); return c.json({ ok: true, data: await deps.caseFromExchange(c.req.valid("param").id, c.req.valid("json"), { actor: deps.actor(c) }) }, 200); } catch (err) { return errorResponse(c, err); }
  });

  app.openapi(createRoute({
    method: "post", path: "/playground/send", tags: ptags, summary: "Compare variants on one message (headless)",
    description: "One message to 1–4 panes at once without keeping a session: each pane's reply, tool calls, cost, latency and tokens.",
    request: { body: { content: { "application/json": { schema: z.object({ panes: z.array(paneSchema).min(1).max(4), message: z.string().min(1).max(50_000), allowRealTools: z.boolean().optional() }) } } } },
    responses: { 200: r[200], 400: r[400], 403: r[403], 404: r[404] },
  }), async (c) => {
    try {
      const deps = d();
      const b = c.req.valid("json");
      return c.json({ ok: true, data: await deps.sendOnce(b.panes, { message: b.message, allowRealTools: b.allowRealTools === true && deps.isAdmin(c) }, { actor: deps.actor(c) }) }, 200);
    } catch (err) { return errorResponse(c, err); }
  });

  app.openapi(createRoute({
    method: "post", path: "/playground/promote", tags: ptags, summary: "Promote a variant to the agent's draft",
    description: "Writes a variant's overrides (model, reasoning, engine, instructions, tools, max turns), applied to the agent at the variant's version, into the agent's draft. Never deploys: publish and deploy the draft as usual (through its required suites). Admins.",
    request: { body: { content: { "application/json": { schema: z.object({ agent: z.string(), version: z.string().optional(), overrides: overridesSchema, note: z.string().max(500).optional() }) } } } },
    responses: { 200: r[200], 400: r[400], 403: r[403], 404: r[404] },
  }), async (c) => {
    try {
      const deps = d();
      if (!deps.isAdmin(c)) return c.json({ ok: false, error: "Promoting a variant writes the agent's draft: it needs an admin", code: "FORBIDDEN" }, 403);
      return c.json({ ok: true, data: await deps.promote(c.req.valid("json"), { actor: deps.actor(c) }) }, 200);
    } catch (err) { return errorResponse(c, err); }
  });

  return app;
}
