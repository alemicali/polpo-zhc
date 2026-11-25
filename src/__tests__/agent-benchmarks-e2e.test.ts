/**
 * Agent suites phase 5 end to end, through the REST API and the MCP server of a real instance:
 * benchmarks (an offline one across two agents and an instructions override; a real-model one that
 * needs the cost confirmed), the report (leaderboard, matrix, side by side), progress events, the
 * Playground (mocks per pane, streaming, save as a test case, promote a variant to the draft, real
 * tools refused without the admin's confirmation) and the MCP tools and card. The model provider
 * is mocked: nothing leaves the process.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Orchestrator } from "../core/orchestrator.js";
import { handleMcpRequest, type McpDeps } from "../server/mcp.js";

let streamSimpleImpl: (...args: unknown[]) => unknown;
let providerCalls = 0;

async function buildMockPiModule(importOriginal: () => Promise<unknown>) {
  const { buildPiAiMock, mockTextStream } = await import("./helpers/mock-llm.js");
  streamSimpleImpl ??= () => mockTextStream("Default mock response.");
  const base = buildPiAiMock((...args: unknown[]) => streamSimpleImpl(...args) as any);
  const { validateToolArguments } = await importOriginal() as { validateToolArguments: unknown };
  return { ...base, validateToolArguments, streamSimple: (...args: unknown[]) => streamSimpleImpl(...args) };
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
    resolveModelSpec: (spec: unknown) => spec ?? "anthropic:mock-model",
    resolveApiKeyAsync: async () => "mock-api-key",
    streamSimpleWithAuth: (...args: unknown[]) => { providerCalls++; return streamSimpleImpl(...args); },
    completeSimpleWithAuth: async () => { throw new Error("completeSimple must not be called in these tests"); },
    buildStreamOpts: () => undefined,
  };
});
// Polpo's model (judges, reviews): never called here
vi.mock("../llm/query.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/query.js")>();
  return { ...actual, queryOrchestratorText: async () => { throw new Error("Polpo's model must not be called in these tests"); } };
});

import { mockTextResponse, mockToolCallResponse, mockTurnSequence } from "./helpers/mock-llm.js";

let tmpDir: string;
let app: any;
let orchestrator: Orchestrator;
const AGENTS = [
  { name: "shop", role: "Shop agent", model: "anthropic:mock-model", systemPrompt: "You quote shipping.", allowedTools: ["read", "mcp__printful__*"] },
  { name: "helper", role: "Helper", model: "anthropic:mock-model", allowedTools: ["read", "mcp__printful__*"] },
];

const api = (path: string, init?: { method?: string; body?: unknown }) => app.request(`/api/v1${path}`, {
  method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
  headers: { "content-type": "application/json" },
  ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
});
const json = async (res: Response) => (await res.json()) as { ok: boolean; data: any; error?: string; code?: string };

const SCRIPT = { turns: [{ toolCalls: [{ name: "mcp__printful__shipping_rates", args: { country: "IT" } }] }, { text: "Standard shipping to Italy costs 4.99 EUR." }] };
const SUITE = {
  name: "Quotes", defaultMode: "all",
  mocks: { tools: [{ id: "rates", tool: "mcp__printful__shipping_rates", response: { rate: "4.99" } }] },
  cases: [
    { id: "italy", name: "Italy", input: { message: "Shipping to Italy?" }, mocks: { model: SCRIPT }, assertions: [{ type: "tool_called", tool: "mcp__printful__shipping_rates" }, { type: "text_contains", value: "4.99" }],
      scorers: [{ id: "price", type: "numeric", expected: 4.99 }] },
    { id: "hello", name: "Hello", input: { message: "Hi" }, mocks: { model: { turns: [{ text: "Hello! I quote shipping." }] } }, assertions: [{ type: "text_contains", value: "shipping" }] },
  ],
};

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-bench-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({ project: "bench", team: { name: "t", agents: AGENTS }, settings: { logLevel: "quiet" } }));
  const { Orchestrator: O } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");
  orchestrator = new O(tmpDir);
  await orchestrator.initInteractive("bench", { name: "t", agents: AGENTS });
  const bridge = new SSEBridge(orchestrator);
  bridge.start();
  app = createApp(orchestrator, bridge);
  expect((await json(await api("/agents/shop/suites", { body: SUITE }))).ok).toBe(true);
}, 60_000);

afterAll(async () => { if (tmpDir) await rm(tmpDir, { recursive: true, force: true }); });

beforeEach(() => {
  providerCalls = 0;
  streamSimpleImpl = () => { throw new Error("the model provider was called"); };
});

describe("benchmarks over REST", () => {
  test("an offline benchmark across two agents and an override: estimate, run, leaderboard, matrix, side by side, progress events", async () => {
    const events: Array<{ status: string; runsDone: number }> = [];
    const listener = (e: { status: string; progress: { runsDone: number } }) => events.push({ status: e.status, runsDone: e.progress.runsDone });
    orchestrator.on("benchmark:progress", listener as never);
    const saved = await json(await api("/benchmarks", { body: {
      name: "Shop vs helper", suites: [{ agent: "shop", suite: "quotes" }], repetitions: 2, weights: { quality: 1, cost: 0, latency: 0 },
      variants: [{ agent: "shop", label: "Shop" }, { agent: "shop", label: "Shop terse", overrides: { instructionsAppend: "Be terse." } }, { agent: "helper", label: "Helper" }],
    } }));
    expect(saved.ok, saved.error).toBe(true);
    expect(saved.data).toMatchObject({ id: "shop-vs-helper", revision: 1 });
    expect((await json(await api("/benchmarks"))).data.map((b: any) => b.id)).toEqual(["shop-vs-helper"]);

    const est = await json(await api("/benchmarks/estimate", { body: { benchmarkId: "shop-vs-helper" } }));
    expect(est.data).toMatchObject({ offline: true, runs: 6, cases: 12, costUsd: 0 });

    const run = await json(await api("/benchmarks/runs", { body: { benchmarkId: "shop-vs-helper", wait: true, source: "benchmarks" } }));
    expect(run.ok, run.error).toBe(true);
    expect(run.data).toMatchObject({ status: "completed", source: "benchmarks", progress: { runsDone: 6, runsTotal: 6 } });
    expect(providerCalls).toBe(0);
    orchestrator.off("benchmark:progress", listener as never);
    expect(events.at(-1)).toEqual({ status: "completed", runsDone: 6 });
    expect(events.length).toBeGreaterThan(2);

    const id = run.data.id;
    const report = await json(await api(`/benchmark-runs/${id}`));
    expect(report.data.stats.map((s: any) => [s.label, s.agent, s.repetitions, s.passRate.mean])).toEqual([["Shop", "shop", 2, 1], ["Shop terse", "shop", 2, 1], ["Helper", "helper", 2, 1]]);
    expect(report.data.leaderboard.entries).toHaveLength(3);
    expect(report.data.leaderboard.notes.join(" ")).toMatch(/within the noise/);
    expect(report.data.matrix.rows.map((r: any) => r.key)).toEqual(["shop/quotes/italy", "shop/quotes/hello"]);
    expect(report.data.matrix.rows[0].cells.helper).toMatchObject({ attempts: 2, passed: 2, status: "passed" });
    // the suite runs are the suite's, tagged with the benchmark (the suite's own trend leaves them out)
    const tagged = await json(await api(`/agents/shop/suite-runs?benchmark=${id}`));
    expect(tagged.data).toHaveLength(6);
    expect(tagged.data.filter((r: any) => r.variant.agent === "helper")).toHaveLength(2);
    expect((await json(await api("/agents/shop/suites/quotes/trend"))).data.points).toHaveLength(0);

    const lb = await json(await api(`/benchmark-runs/${id}/leaderboard?quality=1&cost=1&latency=1`));
    expect(lb.data.weights).toEqual({ quality: 1, cost: 1, latency: 1 });
    const matrix = await json(await api(`/benchmark-runs/${id}/matrix`));
    expect(matrix.data.variants.map((v: any) => v.label)).toEqual(["Shop", "Shop terse", "Helper"]);
    const cmp = await json(await api(`/benchmark-runs/${id}/compare?case=${encodeURIComponent("shop/quotes/italy")}&variants=shop,helper`));
    expect(cmp.ok, cmp.error).toBe(true);
    expect(cmp.data.columns.map((c: any) => c.variantId)).toEqual(["shop", "helper"]);
    expect(cmp.data.columns[1].toolCalls[0]).toMatchObject({ name: "mcp__printful__shipping_rates", diff: "same" });
    expect(cmp.data.columns[1].sameAsReference).toEqual({ tools: true, text: true });
    expect((await api(`/benchmark-runs/${id}/compare?case=nope`)).status).toBe(404);
    // the finished run's cancel is harmless; a stale revision is refused
    expect((await json(await api(`/benchmark-runs/${id}/cancel`, { body: {} }))).data.status).toBe("completed");
    expect((await api("/benchmarks/shop-vs-helper", { method: "PUT", body: { ...saved.data, revision: 0 } })).status).toBe(409);
  }, 60_000);

  test("a benchmark that calls a real model needs the cost confirmed; then it runs", async () => {
    const inline = { name: "Real", suites: [{ agent: "shop", suite: "quotes", caseIds: ["hello"] }], mode: "tools", variants: [{ agent: "shop" }] };
    const refused = await api("/benchmarks/runs", { body: { benchmark: inline } });
    expect(refused.status).toBe(409);
    const body = await json(refused);
    expect(body.code).toBe("CONFIRM_COST");
    expect((body as any).data.estimate).toMatchObject({ offline: false, realModelCases: 1 });
    expect(providerCalls).toBe(0);
    streamSimpleImpl = mockTurnSequence([mockTextResponse("Hi, I quote shipping.")]);
    const run = await json(await api("/benchmarks/runs", { body: { benchmark: inline, confirm: true, wait: true } }));
    expect(run.data.status).toBe("completed");
    expect(providerCalls).toBeGreaterThan(0);
    // live tools: refused without the admin's confirmation
    const live = await api("/benchmarks/runs", { body: { benchmark: { ...inline, mode: "none" }, confirm: true } });
    expect(live.status).toBe(403);
  }, 60_000);
});

describe("the Playground over REST", () => {
  test("panes with their own mocks; streaming; save as a test case; promote to the draft; real tools need the confirmation", async () => {
    const before = (await orchestrator.getSessionStore()!.listSessions()).length;
    const created = await json(await api("/playground/sessions", { body: { panes: [
      { label: "Scripted", variant: { agent: "shop" }, mockModel: true, mocks: { suite: { agent: "shop", suite: "quotes" }, model: SCRIPT } },
      { label: "Real model", variant: { agent: "helper", overrides: { instructionsAppend: "Answer in one line." } }, mocks: { suite: { agent: "shop", suite: "quotes" }, tools: [{ id: "notes", tool: "read", response: "Italy: 4.99" }] } },
    ] } }));
    expect(created.ok, created.error).toBe(true);
    const sid = created.data.id;
    streamSimpleImpl = mockTurnSequence([mockToolCallResponse("read", { path: "rates.txt" }), mockTextResponse("4.99 EUR to Italy.")]);
    const sent = await json(await api(`/playground/sessions/${sid}/send`, { body: { message: "Shipping to Italy?" } }));
    expect(sent.ok, sent.error).toBe(true);
    const [a, b] = [sent.data.exchanges["pane-1"], sent.data.exchanges["pane-2"]];
    expect(a).toMatchObject({ mode: "all", status: "done", costUsd: 0 });
    expect(a.trace.toolCalls[0]).toMatchObject({ mocked: "mock", mockId: "rates" });
    expect(a.trace.text).toContain("4.99");
    expect(b.mode).toBe("tools");
    expect(b.trace.toolCalls[0]).toMatchObject({ name: "read", mocked: "mock", mockId: "notes", result: "Italy: 4.99" });
    expect(b.trace.text).toBe("4.99 EUR to Italy.");
    // ephemeral: the test chats are deleted like a suite case's
    expect((await orchestrator.getSessionStore()!.listSessions()).length).toBe(before);

    // streamed: events per pane, then the end with the session
    const res = await api(`/playground/sessions/${sid}/send`, { body: { message: "And to Germany?", paneIds: ["pane-1"], stream: true } });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const events = [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    expect(events[0]).toBe("start");
    expect(events).toEqual(expect.arrayContaining(["tool", "done", "end"]));
    const session = await json(await api(`/playground/sessions/${sid}`));
    expect(session.data.exchanges["pane-1"]).toHaveLength(2);
    expect(session.data.exchanges["pane-2"]).toHaveLength(1);

    // save as a test case: proposed, then saved into the suite; it replays offline
    const proposed = await json(await api(`/playground/sessions/${sid}/case`, { body: { paneId: "pane-1", exchange: 0, mockModel: true } }));
    expect(proposed.data.case).toMatchObject({ mode: "all", input: { message: "Shipping to Italy?" } });
    expect(proposed.data.suite).toBeUndefined();
    const saved = await json(await api(`/playground/sessions/${sid}/case`, { body: { paneId: "pane-1", exchange: 0, mockModel: true, name: "From the playground", save: { agent: "shop", suite: "quotes" } } }));
    expect(saved.data.suite.cases.map((c: any) => c.name)).toContain("From the playground");
    providerCalls = 0;
    const replay = await json(await api("/agents/shop/suites/quotes/runs", { body: { caseIds: [saved.data.case.id], wait: true } }));
    expect(replay.data.status).toBe("passed");
    expect(providerCalls).toBe(0);

    // promote: the helper's override goes into its draft; production is unchanged
    const prodBefore = (await orchestrator.getAgentVersioning().state("helper")).production;
    const promoted = await json(await api("/playground/promote", { body: { agent: "helper", overrides: { instructionsAppend: "Answer in one line." } } }));
    expect(promoted.ok, promoted.error).toBe(true);
    expect(promoted.data.fields).toEqual({ systemPrompt: "Answer in one line." });
    const draft = await orchestrator.getAgentVersioning().draftConfig("helper");
    expect((draft.config as { systemPrompt?: string }).systemPrompt).toBe("Answer in one line.");
    expect((await orchestrator.getAgentVersioning().state("helper")).production).toBe(prodBefore);

    // real tools: refused without allowRealTools
    const real = await json(await api("/playground/sessions", { body: { panes: [{ variant: { agent: "shop" }, mockTools: false, realTools: true }] } }));
    expect((await api(`/playground/sessions/${real.data.id}/send`, { body: { message: "x" } })).status).toBe(403);
    expect((await api(`/playground/sessions/${sid}`, { method: "DELETE" })).status).toBe(200);
    expect((await api(`/playground/sessions/${sid}`)).status).toBe(404);
  }, 60_000);
});

function mcp(scopes: string[]) {
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
  return { call: (name: string, args: Record<string, unknown>) => rpc("tools/call", { name, arguments: args }), list: () => rpc("tools/list", {}) };
}

describe("benchmarks and the Playground over MCP", () => {
  test("scopes: read sees reports and the card, work runs, admin promotes", async () => {
    const names = async (scopes: string[]) => ((await mcp(scopes).list()).tools as Array<{ name: string }>).map((t) => t.name);
    const read = await names(["polpo:read"]);
    expect(read).toEqual(expect.arrayContaining(["polpo_benchmark_get", "polpo_benchmark_leaderboard", "polpo_benchmark_compare", "polpo_benchmark_show"]));
    expect(read).not.toContain("polpo_benchmark_run");
    const work = await names(["polpo:work"]);
    expect(work).toEqual(expect.arrayContaining(["polpo_benchmark_save", "polpo_benchmark_delete", "polpo_benchmark_run", "polpo_playground_send"]));
    expect(work).not.toContain("polpo_playground_promote");
    expect(await names(["polpo:admin"])).toContain("polpo_playground_promote");
  }, 30_000);

  test("run (estimate first for a real model), get, leaderboard, compare, the card, the Playground with save_case", async () => {
    const work = mcp(["polpo:work"]);
    const saved = await work.call("polpo_benchmark_save", { benchmark: { name: "MCP bench", suites: [{ agent: "shop", suite: "quotes", caseIds: ["italy", "hello"] }], variants: [{ agent: "shop" }, { agent: "helper" }] } });
    expect(saved.isError, saved.content?.[0]?.text).toBeFalsy();
    // a real model: the estimate, not started
    const est = await work.call("polpo_benchmark_run", { inline: { name: "Real", suites: [{ agent: "shop", suite: "quotes", caseIds: ["hello"] }], mode: "tools", variants: [{ agent: "shop" }] } });
    expect(est.content[0].text).toContain("Not started: this benchmark calls real models");
    expect(providerCalls).toBe(0);
    const run = await work.call("polpo_benchmark_run", { benchmark: "mcp-bench", wait_seconds: 30 });
    expect(run.isError, run.content?.[0]?.text).toBeFalsy();
    expect(run.content[0].text).toContain("Leaderboard");
    expect(run.content[0].text).toContain("case × variant");
    const runId = (run.structuredContent.run as { id: string }).id;

    const read = mcp(["polpo:read"]);
    const got = await read.call("polpo_benchmark_get", { run: runId });
    expect(got.content[0].text).toContain("Variants:");
    expect((await read.call("polpo_benchmark_get", {})).content[0].text).toContain("mcp-bench");
    const lb = await read.call("polpo_benchmark_leaderboard", { run: runId, quality: 1, cost: 0, latency: 0 });
    expect(lb.structuredContent.leaderboard.weights).toEqual({ quality: 1, cost: 0, latency: 0 });
    const cmp = await read.call("polpo_benchmark_compare", { run: runId, case: "italy" });
    expect(cmp.content[0].text).toContain("side by side");
    expect(cmp.structuredContent.comparison.columns[0].result).toBeUndefined();

    // the card: the benchmark (leaderboard, matrix), then a case side by side
    const card = await read.call("polpo_benchmark_show", { run: runId });
    expect(card.structuredContent).toMatchObject({ kind: "benchmark", run: { id: runId, status: "completed" } });
    expect(card.structuredContent.leaderboard).toHaveLength(2);
    expect(card.structuredContent.rows.length).toBe(2);
    const side = await read.call("polpo_benchmark_show", { run: runId, case: "shop/quotes/italy" });
    expect(side.structuredContent).toMatchObject({ kind: "compare", caseKey: "shop/quotes/italy" });
    expect(side.structuredContent.columns).toHaveLength(2);

    // the Playground, headless, with a case saved
    const pg = await work.call("polpo_playground_send", {
      panes: [{ label: "A", variant: { agent: "shop" }, mockModel: true, mocks: { suite: { agent: "shop", suite: "quotes" }, model: SCRIPT } }, { label: "B", variant: { agent: "helper" }, mockModel: true, mocks: { model: { turns: [{ text: "No idea." }] } } }],
      message: "Shipping to Italy?", save_case: { pane: 0, agent: "shop", suite: "quotes", name: "MCP playground case", mock_model: true },
    });
    expect(pg.isError, pg.content?.[0]?.text).toBeFalsy();
    expect(pg.content[0].text).toContain("── A");
    expect(pg.content[0].text).toContain("Saved as the case");
    expect(Object.keys(pg.structuredContent.exchanges)).toEqual(["pane-1", "pane-2"]);
    // real tools need the admin scope
    const refused = await work.call("polpo_playground_send", { panes: [{ variant: { agent: "shop" }, realTools: true }], message: "x" });
    expect(refused.isError).toBe(true);

    const admin = mcp(["polpo:admin"]);
    const promoted = await admin.call("polpo_playground_promote", { agent: "shop", overrides: { instructionsAppend: "Quote in EUR." } });
    expect(promoted.isError, promoted.content?.[0]?.text).toBeFalsy();
    expect(promoted.content[0].text).toContain("Not deployed");
    const del = await work.call("polpo_benchmark_delete", { benchmark: "mcp-bench" });
    expect(del.isError).toBeFalsy();
  }, 60_000);
});
