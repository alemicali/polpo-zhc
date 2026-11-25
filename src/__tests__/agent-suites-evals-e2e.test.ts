/**
 * Agent suite evals end to end: scorers (dataset expected values, an LLM judge), repetitions,
 * baselines and deltas, trends and "explain this run" through the REST API on a real instance, and
 * the same over MCP (text tools and the suite card widget). Every model is mocked: the agent's
 * turns are scripted (mode all), the judge and the reviewer answer from the pi-client mock.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { vi } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Orchestrator } from "../core/orchestrator.js";
import { handleMcpRequest, type McpDeps } from "../server/mcp.js";

const judgeCalls: Array<{ prompt: string; options: unknown }> = [];
const reviewCalls: string[] = [];
let judgeAnswer = '{"criteria":[{"name":"overall","reasoning":"Polite and correct","score":5}],"summary":"Polite and correct."}';

async function buildMockPiModule(importOriginal: () => Promise<unknown>) {
  const { buildPiAiMock, mockTextStream } = await import("./helpers/mock-llm.js");
  const base = buildPiAiMock(() => { throw new Error("the model provider was called"); });
  const { validateToolArguments } = await importOriginal() as { validateToolArguments: unknown };
  return { ...base, validateToolArguments, streamSimple: () => mockTextStream("unexpected") };
}
vi.mock("@earendil-works/pi-ai", (importOriginal) => buildMockPiModule(importOriginal));
vi.mock("@earendil-works/pi-ai/compat", (importOriginal) => buildMockPiModule(importOriginal));
vi.mock("@earendil-works/pi-ai/providers/all", async () => {
  const { mockModel } = await import("./helpers/mock-llm.js");
  return { getBuiltinModel: () => mockModel(), getBuiltinModels: () => [mockModel()], getBuiltinProviders: () => ["anthropic"] };
});
vi.mock("../llm/pi-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/pi-client.js")>();
  const { mockModel } = await import("./helpers/mock-llm.js");
  return {
    ...actual,
    resolveModel: () => mockModel(),
    resolveModelSpec: (spec: unknown) => (typeof spec === "object" && spec ? (spec as { primary: string }).primary : spec) ?? "anthropic:mock-model",
    resolveApiKeyAsync: async () => "mock-api-key",
    streamSimpleWithAuth: () => { throw new Error("the agent's model was called (the cases are scripted)"); },
    // the LLM judge
    completeSimpleWithAuth: async (_m: unknown, ctx: { messages: Array<{ content: string }> }, options: unknown) => {
      judgeCalls.push({ prompt: ctx.messages[0].content, options });
      return { role: "assistant", content: [{ type: "text", text: judgeAnswer }], stopReason: "stop", usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    },
    // "explain this run" (queryOrchestratorText)
    queryText: async (prompt: string) => {
      reviewCalls.push(prompt);
      return { text: "## Summary\nThe German quote regressed: the reply says 9.99.\n\n## Suggested fixes\nRead the rate from the tool result.", model: mockModel() };
    },
    buildStreamOpts: () => undefined,
  };
});

let tmpDir: string;
let app: any;
let orchestrator: Orchestrator;

const api = (path: string, init?: { method?: string; body?: unknown }) => app.request(`/api/v1${path}`, {
  method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
  headers: { "content-type": "application/json" },
  ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
});
const json = async (res: Response) => (await res.json()) as { ok: boolean; data: any; error?: string; code?: string };

/** A contract eval: two countries, the expected rate per row, a numeric scorer and an LLM judge. */
const evalSuite = (deRate = "5.49") => ({
  id: "quotes", name: "Quotes", defaultMode: "all",
  datasets: [{ id: "rates", name: "Rates", rows: [{ country: "IT", expected: 4.99, rate: "4.99" }, { country: "DE", expected: 5.49, rate: deRate }] }],
  scorers: [{ type: "cost", maxUsd: 0.01 }],
  evals: { judgeModel: "anthropic:judge-model" },
  cases: [{
    name: "Quote", dataset: "rates",
    input: { kind: "chat", message: "How much is shipping to {{row.country}}?" },
    mocks: { model: { turns: [{ text: "Standard shipping to {{row.country}} costs {{row.rate}} EUR." }] } },
    assertions: [{ type: "text_contains", value: "{{row.country}}" }],
    scorers: [
      { id: "price", type: "numeric", expected: "{{row.expected}}", tolerance: 0.01 },
      { id: "judge", type: "llm_judge", rubric: "A polite, correct shipping quote" },
    ],
  }],
});

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-suite-evals-e2e-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  const team = { name: "t", agents: [{ name: "shop", role: "Shop agent", systemPrompt: "Quote shipping from the Printful rates.", allowedTools: ["mcp__printful__*"] }] };
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({ project: "evals-e2e", team, settings: { logLevel: "quiet", orchestratorModel: "anthropic:polpo-model" } }));
  const { Orchestrator: O } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");
  orchestrator = new O(tmpDir);
  await orchestrator.initInteractive("evals-e2e", team);
  const cfg = orchestrator.getConfig();
  if (cfg) cfg.settings = { ...cfg.settings, orchestratorModel: "anthropic:polpo-model" };
  const bridge = new SSEBridge(orchestrator);
  bridge.start();
  app = createApp(orchestrator, bridge);
}, 60_000);

afterAll(async () => { if (tmpDir) await rm(tmpDir, { recursive: true, force: true }); });

beforeEach(() => {
  judgeCalls.length = 0;
  reviewCalls.length = 0;
  judgeAnswer = '{"criteria":[{"name":"overall","reasoning":"Polite and correct","score":5}],"summary":"Polite and correct."}';
});

describe("agent suite evals over REST", () => {
  let firstRun: string;

  test("scorers: expected values from the dataset, an LLM judge at temperature 0 with the suite's judge model; aggregates", async () => {
    expect((await json(await api("/agents/shop/suites", { body: evalSuite() }))).ok).toBe(true);
    const res = await json(await api("/agents/shop/suites/quotes/runs", { body: { wait: true } }));
    expect(res.ok).toBe(true);
    const run = res.data;
    expect(run.status).toBe("passed");
    expect(run.results.map((r: any) => r.key)).toEqual(["quote#1", "quote#2"]);
    const it = run.results[0];
    expect(it.scores.map((x: any) => [x.id, x.passed])).toEqual([["cost", true], ["price", true], ["judge", true]]);
    expect(it.scores.find((x: any) => x.id === "price")).toMatchObject({ expected: 4.99, actual: 4.99, score: 1 });
    expect(it.scores.find((x: any) => x.id === "judge")).toMatchObject({ score: 1, reason: "Polite and correct.", judge: { model: "anthropic:judge-model", criteria: [{ name: "overall", score: 5 }] } });
    expect(it.score).toBe(1);
    // the judge: one call per case, deterministic, with the reply
    expect(judgeCalls).toHaveLength(2);
    expect(judgeCalls[0].options).toMatchObject({ temperature: 0 });
    expect(judgeCalls[0].prompt).toContain("Standard shipping to IT costs 4.99 EUR.");
    expect(run.aggregates).toMatchObject({ score: 1, passRate: 1, repetitions: 1, flaky: [] });
    expect(run.aggregates.scorers.map((x: any) => x.id)).toEqual(["cost", "price", "judge"]);
    expect(run.baseline).toBeUndefined();
    firstRun = run.id;
    // the list keeps the scores without the judge's reasoning
    const list = await json(await api("/agents/shop/suite-runs?suite=quotes"));
    expect(list.data[0].results[0].scores[2].judge).toBeUndefined();
    expect(list.data[0].aggregates.score).toBe(1);
  }, 30_000);

  test("repetitions: each row N times, aggregated per case", async () => {
    const run = (await json(await api("/agents/shop/suites/quotes/runs", { body: { wait: true, repetitions: 2 } }))).data;
    expect(run.planned).toEqual(["quote#1~1", "quote#1~2", "quote#2~1", "quote#2~2"]);
    expect(run.repetitions).toBe(2);
    expect(run.aggregates.cases).toEqual([
      expect.objectContaining({ key: "quote#1", attempts: 2, passRate: 1, flaky: false }),
      expect.objectContaining({ key: "quote#2", attempts: 2, passRate: 1, flaky: false }),
    ]);
    const tooMany = await api("/agents/shop/suites/quotes/runs", { body: { repetitions: 11 } });
    expect(tooMany.status).toBe(400);
    expect(JSON.stringify(await tooMany.json())).toContain("repetitions");
  }, 30_000);

  test("baseline: mark a run, a regression shows per case and per scorer; compare on demand; clear", async () => {
    const marked = await json(await api("/agents/shop/suites/quotes/baseline", { method: "PUT", body: { runId: firstRun } }));
    expect(marked.data).toMatchObject({ id: firstRun, isBaseline: true });
    expect((await json(await api("/agents/shop/suites/quotes/baseline"))).data.id).toBe(firstRun);

    // the German quote is now wrong; the judge is less happy
    const current = (await json(await api("/agents/shop/suites/quotes"))).data;
    await json(await api("/agents/shop/suites/quotes", { method: "PUT", body: { ...evalSuite("9.99"), revision: current.revision } }));
    judgeAnswer = '{"criteria":[{"name":"overall","reasoning":"Less clear","score":4}],"summary":"Less clear."}';
    const run = (await json(await api("/agents/shop/suites/quotes/runs", { body: { wait: true } }))).data;
    expect(run.status).toBe("failed");
    expect(run.baseline).toMatchObject({ runId: firstRun, source: "marked", regressions: 2, improvements: 0, passRateDelta: -0.5 });
    const de = run.baseline.cases.find((c: any) => c.key === "quote#2");
    expect(de).toMatchObject({ change: "regressed", baselineStatus: "passed", status: "failed" });
    expect(de.scorers.find((x: any) => x.id === "price")).toMatchObject({ baseline: 1, change: "regressed" });
    expect(run.baseline.scorers.find((x: any) => x.id === "judge")).toMatchObject({ baseline: 1, current: 0.75, delta: -0.25, change: "regressed" });

    // on demand: against the second (repetitions) run, with a tolerance
    const runs = (await json(await api("/agents/shop/suite-runs?suite=quotes"))).data;
    const cmp = await json(await api(`/agents/shop/suite-runs/${run.id}/compare?baseline=${runs[1].id}&tolerance=0.6`));
    expect(cmp.data).toMatchObject({ runId: runs[1].id, source: "request", tolerance: 0.6 });

    expect((await json(await api("/agents/shop/suites/quotes/baseline", { method: "PUT", body: { runId: "sr-nope" } }))).code).toBe("NOT_FOUND");
    expect((await json(await api("/agents/shop/suites/quotes/baseline", { method: "DELETE" }))).ok).toBe(true);
    expect((await json(await api("/agents/shop/suites/quotes/baseline"))).data).toBeNull();
  }, 30_000);

  test("trend: the runs over time and by version; explain this run: stored on the run", async () => {
    const trend = (await json(await api("/agents/shop/suites/quotes/trend"))).data;
    expect(trend.points).toHaveLength(3);
    expect(trend.points.map((p: any) => p.passRate)).toEqual([1, 1, 0.5]);
    expect(trend.points[0].isBaseline).toBeUndefined();
    expect(trend.points[2].regressions).toBe(2);
    // production's version (the agent's first published one)
    expect(trend.byVersion).toEqual([expect.objectContaining({ version: trend.points[0].version ?? "production", runs: 3 })]);

    const last = trend.points[2].runId;
    const reviewed = await json(await api(`/agents/shop/suite-runs/${last}/review`, { body: { language: "Italian" } }));
    expect(reviewed.ok).toBe(true);
    expect(reviewed.data.review).toMatchObject({ text: expect.stringContaining("The German quote regressed"), model: "anthropic:polpo-model" });
    expect(reviewCalls[0]).toContain("Quote shipping from the Printful rates.");
    expect(reviewCalls[0]).toContain("regressed: Quote [quote#2]");
    expect(reviewCalls[0]).toContain("Answer in Italian");
    expect((await json(await api(`/agents/shop/suite-runs/${last}`))).data.review.text).toContain("Suggested fixes");
  }, 30_000);
});

describe("agent suite evals over MCP", () => {
  const mcp = (scopes: string[]) => {
    const deps: McpDeps = {
      version: "x", toolsets: ["all"], principal: { kind: "oauth", actor: "ada@example.com via Claude", scopes },
      api: async (method, path, body) => {
        const res = await app.request(path, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
        return { status: res.status, body: await res.json(), headers: res.headers };
      },
    };
    const rpc = (method: string, params: Record<string, unknown>) => handleMcpRequest(new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }), deps).then(async (res) => (await res.json()).result);
    return {
      call: (name: string, args: Record<string, unknown>) => rpc("tools/call", { name, arguments: args }),
      list: () => rpc("tools/list", {}),
      resources: () => rpc("resources/list", {}),
      read: (uri: string) => rpc("resources/read", { uri }),
    };
  };

  test("run with repetitions and a baseline; the report has scores and deltas; trend, baseline and review tools", async () => {
    const work = mcp(["polpo:work"]);
    const saved = await work.call("polpo_agent_suite_save", { agent: "shop", suite: { ...evalSuite(), id: "mcp-quotes", name: "MCP quotes" } });
    expect(saved.isError).toBeFalsy();
    const first = await work.call("polpo_agent_suite_run", { agent: "shop", suite: "mcp-quotes" });
    expect(first.isError).toBeFalsy();
    expect(first.content[0].text).toContain("score 1.00");
    expect(first.content[0].text).toMatch(/scores \(overall 1\.00\): cost mean 1\.00 .*price mean 1\.00/);
    const firstId = first.structuredContent.run.id;

    const marked = await work.call("polpo_agent_suite_baseline", { agent: "shop", suite: "mcp-quotes", run: firstId });
    expect(marked.content[0].text).toContain(`Marked ${firstId} as mcp-quotes's baseline`);
    const shown = await work.call("polpo_agent_suite_baseline", { agent: "shop", suite: "mcp-quotes" });
    expect(shown.content[0].text).toContain("★ baseline");

    judgeAnswer = '{"score": 2, "reasoning": "meh"}';
    const second = await work.call("polpo_agent_suite_run", { agent: "shop", suite: "mcp-quotes", repetitions: 2 });
    const text = second.content[0].text;
    expect(text).toContain("repetitions: 2 per case");
    expect(text).toContain(`baseline ${firstId} (marked`);
    expect(text).toMatch(/▼ scorer judge: 1\.00 → 0\.25/);
    expect(text).toContain("✗ judge: 0.25 < 0.6");
    const secondId = second.structuredContent.run.id;

    const cmp = await work.call("polpo_agent_suite_baseline", { agent: "shop", suite: "mcp-quotes", compare: secondId });
    expect(cmp.structuredContent.comparison).toMatchObject({ runId: firstId, regressions: 2 });

    const trend = await work.call("polpo_agent_suite_trend", { agent: "shop", suite: "mcp-quotes" });
    expect(trend.content[0].text).toMatch(/mcp-quotes: 2 run\(s\)/);
    expect(trend.content[0].text).toContain("★ baseline");
    expect(trend.structuredContent.trend.points).toHaveLength(2);

    const review = await work.call("polpo_agent_suite_review", { agent: "shop", run: secondId });
    expect(review.isError).toBeFalsy();
    expect(review.content[0].text).toContain("The German quote regressed");
    // a second call returns the stored review without a new model call
    reviewCalls.length = 0;
    const again = await work.call("polpo_agent_suite_review", { agent: "shop", run: secondId });
    expect(again.content[0].text).toContain("The German quote regressed");
    expect(reviewCalls).toHaveLength(0);

    const cleared = await work.call("polpo_agent_suite_baseline", { agent: "shop", suite: "mcp-quotes", clear: true });
    expect(cleared.content[0].text).toContain("has no marked baseline now");
  }, 30_000);

  test("the suite card (MCP App): the resource, and the suites, run and trend views", async () => {
    const read = mcp(["polpo:read"]);
    const names = ((await read.list()).tools as Array<{ name: string; _meta?: { ui?: { resourceUri?: string } } }>);
    const show = names.find((t) => t.name === "polpo_agent_suite_show")!;
    expect(show._meta?.ui?.resourceUri).toBe("ui://polpo/suite-card.html");
    // read scope: no baseline or review tools
    expect(names.map((t) => t.name)).not.toContain("polpo_agent_suite_baseline");
    expect(names.map((t) => t.name)).not.toContain("polpo_agent_suite_review");
    const resources = (await read.resources()).resources as Array<{ uri: string }>;
    expect(resources.map((r) => r.uri)).toContain("ui://polpo/suite-card.html");
    const html = (await read.read("ui://polpo/suite-card.html")).contents[0].text as string;
    expect(html).toContain("polpo-suite-card");

    const suites = await read.call("polpo_agent_suite_show", { agent: "shop" });
    expect(suites.isError).toBeFalsy();
    expect(suites.structuredContent).toMatchObject({ kind: "suites", agent: "shop" });
    expect(suites.structuredContent.suites.find((s: any) => s.id === "mcp-quotes")).toMatchObject({ cases: 1, scorers: 3, lastRun: { status: "failed" } });

    const run = await read.call("polpo_agent_suite_show", { agent: "shop", suite: "mcp-quotes", view: "run" });
    expect(run.structuredContent.kind).toBe("run");
    expect(run.structuredContent.run).toMatchObject({ suiteId: "mcp-quotes", repetitions: 2 });
    expect(run.structuredContent.cases.map((c: any) => c.key)).toEqual(["quote#1", "quote#2"]);
    expect(run.structuredContent.cases[0]).toMatchObject({ attempts: 2, change: "regressed" });
    expect(run.structuredContent.scorers.find((x: any) => x.id === "judge")).toMatchObject({ mean: 0.25, delta: -0.75, change: "regressed" });
    expect(run.structuredContent.baseline).toMatchObject({ regressions: 2 });
    expect(run.structuredContent.review.text).toContain("The German quote regressed");
    expect(run.content[0].text).toContain("vs sr-");

    const trend = await read.call("polpo_agent_suite_show", { agent: "shop", suite: "mcp-quotes", view: "trend" });
    expect(trend.structuredContent).toMatchObject({ kind: "trend", suiteId: "mcp-quotes", suiteName: "MCP quotes" });
    expect(trend.structuredContent.points).toHaveLength(2);

    const missing = await read.call("polpo_agent_suite_show", { agent: "shop", view: "trend" });
    expect(missing.isError).toBe(true);
  }, 30_000);
});
