/**
 * Agent suites end to end: suites saved and run through the REST API, each case a real chat turn
 * through the in-process completions pipeline (the agent's own path) with the case's hooks.
 * The model provider is mocked (pi-ai): in modes "all" and "model" it must never be called.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { vi } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Orchestrator } from "../core/orchestrator.js";
import { handleMcpRequest, type McpDeps } from "../server/mcp.js";

let streamSimpleImpl: (...args: unknown[]) => unknown;
const providerCalls: Array<{ systemPrompt?: string }> = [];

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
    streamSimpleWithAuth: (model: unknown, ctx: { systemPrompt?: string }, ...rest: unknown[]) => {
      providerCalls.push({ systemPrompt: ctx?.systemPrompt });
      return streamSimpleImpl(model, ctx, ...rest);
    },
    completeSimpleWithAuth: async () => { throw new Error("completeSimple must not be called in these tests"); },
    buildStreamOpts: () => undefined,
  };
});

import { mockTextStream, mockTurnSequence, mockToolCallResponse, mockTextResponse } from "./helpers/mock-llm.js";

let tmpDir: string;
let app: any;
let orchestrator: Orchestrator;

const api = (path: string, init?: { method?: string; body?: unknown }) => app.request(`/api/v1${path}`, {
  method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
  headers: { "content-type": "application/json" },
  ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
});
const json = async (res: Response) => (await res.json()) as { ok: boolean; data: any; error?: string; code?: string };

/** The Printful "shipping rates" contract suite: scripted model, mocked connector tools. */
const shippingSuite = {
  name: "Shipping rates",
  defaultMode: "all",
  mocks: {
    tools: [{ id: "rates", tool: "mcp__printful__*", when: { args: { country: "IT" } }, response: { rates: [{ id: "STANDARD", rate: "4.99", currency: "EUR" }] } }],
  },
  cases: [{
    name: "Quote Italy",
    input: { kind: "chat", message: "How much is shipping a t-shirt to Italy?" },
    mocks: { model: { turns: [
      { toolCalls: [{ name: "mcp__printful__shipping_rates", args: { country: "IT", items: [{ variant_id: 4012, quantity: 1 }] } }] },
      { text: "Standard shipping to Italy costs 4.99 EUR." },
    ] } },
    assertions: [
      { type: "tool_called", tool: "mcp__printful__shipping_rates", args: { country: "IT" }, times: 1 },
      { type: "tool_args", tool: "mcp__printful__shipping_rates", match: "schema", value: { type: "object", required: ["country", "items"], properties: { country: { type: "string", pattern: "^[A-Z]{2}$" } } } },
      { type: "text_contains", value: "4.99" },
      { type: "tool_not_called", tool: "mcp__printful__create_order" },
      { type: "max_turns", value: 3 },
    ],
  }],
};

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-suites-e2e-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({
    project: "suites-e2e", team: { name: "t", agents: [{ name: "shop", role: "Shop agent", allowedTools: ["read", "write", "bash", "mcp__printful__*"] }] },
    settings: { logLevel: "quiet" },
  }));
  const { Orchestrator: O } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");
  orchestrator = new O(tmpDir);
  await orchestrator.initInteractive("suites-e2e", { name: "t", agents: [{ name: "shop", role: "Shop agent", allowedTools: ["read", "write", "bash", "mcp__printful__*"] }] });
  const bridge = new SSEBridge(orchestrator);
  bridge.start();
  app = createApp(orchestrator, bridge);
}, 60_000);

afterAll(async () => { if (tmpDir) await rm(tmpDir, { recursive: true, force: true }); });

beforeEach(() => {
  providerCalls.length = 0;
  streamSimpleImpl = () => { throw new Error("the model provider was called"); };
});

describe("agent suites end to end", () => {
  test("mode all runs offline: scripted model, mocked connector tool, assertions pass; the test chat is removed", async () => {
    const created = await json(await api("/agents/shop/suites", { body: shippingSuite }));
    expect(created.ok).toBe(true);
    expect(created.data).toMatchObject({ id: "shipping-rates", revision: 1, cases: [{ id: "quote-italy" }] });
    const sessionsBefore = (await orchestrator.getSessionStore()!.listSessions()).length;

    const res = await json(await api("/agents/shop/suites/shipping-rates/runs", { body: { wait: true } }));
    expect(res.ok).toBe(true);
    const run = res.data;
    expect(run.status).toBe("passed");
    expect(providerCalls).toHaveLength(0);
    const [result] = run.results;
    expect(result.status).toBe("passed");
    expect(result.engine).toBe("native");
    expect(result.trace.turns.map((t: any) => t.mocked)).toEqual([true, true]);
    expect(result.trace.toolCalls).toEqual([expect.objectContaining({ name: "mcp__printful__shipping_rates", mocked: "mock", mockId: "rates", isError: false })]);
    expect(result.trace.toolCalls[0].result).toContain("STANDARD");
    expect(result.trace.text).toContain("4.99");
    expect(run.variant).toMatchObject({ agent: "shop", version: "production" });
    expect(result.variantId).toBe(run.variant.id);
    // the chat turn is a test, not a conversation
    expect((await orchestrator.getSessionStore()!.listSessions()).length).toBe(sessionsBefore);

    // the run is kept and listed without traces
    const list = await json(await api("/agents/shop/suite-runs?suite=shipping-rates"));
    expect(list.data[0]).toMatchObject({ id: run.id, status: "passed" });
    expect(list.data[0].results[0].trace).toBeUndefined();
    const one = await json(await api(`/agents/shop/suite-runs/${run.id}`));
    expect(one.data.results[0].trace.toolCalls).toHaveLength(1);
  });

  test("a failing assertion fails the case with a diff of the arguments", async () => {
    const suite = { ...shippingSuite, id: "shipping-de", name: "Shipping DE", cases: [{ ...shippingSuite.cases[0], assertions: [{ type: "tool_called", tool: "mcp__printful__shipping_rates", args: { country: "DE" } }] }] };
    await api("/agents/shop/suites", { body: suite });
    const run = (await json(await api("/agents/shop/suites/shipping-de/runs", { body: { wait: true } }))).data;
    expect(run.status).toBe("failed");
    const a = run.results[0].assertions[0];
    expect(a.passed).toBe(false);
    expect(a.message).toContain("never with the expected arguments");
    expect(a.diff).toContain('-  "country": "DE"');
    expect(a.diff).toContain('+  "country": "IT"');
  });

  test("tool mocks intercept native tools before they run; unmocked tools are blocked (no side effect)", async () => {
    const target = join(tmpDir, "should-not-exist.txt");
    const blocked = join(tmpDir, "blocked.txt");
    await api("/agents/shop/suites", { body: {
      name: "Native tools", defaultMode: "all",
      cases: [{
        name: "Writes",
        input: { kind: "task", message: "Write the report" },
        mocks: {
          tools: [{ tool: "write", when: { args: { path: target } }, response: "Wrote 12 bytes" }],
          model: { turns: [
            { toolCalls: [{ name: "write", args: { path: target, content: "hello" } }] },
            { toolCalls: [{ name: "write", args: { path: blocked, content: "nope" } }, { name: "bash", args: { command: `touch ${blocked}` } }] },
            { toolCalls: [{ name: "register_outcome", args: { label: "report", type: "text", value: "done" } }] },
            { text: "Done." },
          ] },
        },
        assertions: [
          { type: "tool_order", tools: ["write", "write", "bash"] },
          { type: "outcome_registered", label: "report" },
          { type: "no_tool_errors" },
        ],
      }],
    } });
    const run = (await json(await api("/agents/shop/suites/native-tools/runs", { body: { wait: true } }))).data;
    const r = run.results[0];
    expect(existsSync(target)).toBe(false);
    expect(existsSync(blocked)).toBe(false);
    expect(r.trace.toolCalls.map((c: any) => [c.name, c.mocked])).toEqual([["write", "mock"], ["write", "blocked"], ["bash", "blocked"], ["register_outcome", "stub"]]);
    expect(r.trace.input[0].content).toContain("## Task");
    // blocked calls are errors: no_tool_errors fails, the others pass
    expect(r.assertions.map((a: any) => a.passed)).toEqual([true, true, false]);
    expect(r.status).toBe("failed");
    expect(r.trace.notes.join(" ")).toContain("blocked");
  });

  test("a gated send stops for a person: approval requested, never given, the mock never consulted", async () => {
    await api("/agents/shop/suites", { body: {
      name: "Approvals", defaultMode: "all",
      cases: [{
        name: "Email",
        input: { kind: "chat", message: "Email the quote to Ann" },
        mocks: {
          tools: [{ tool: "email_send", response: "sent" }],
          model: { turns: [{ text: "Sending it.", toolCalls: [{ name: "email_send", args: { to: "ann@example.com", subject: "Quote", body: "4.99" } }] }] },
        },
        assertions: [{ type: "approval_requested", tool: "email_send" }],
      }],
    } });
    const run = (await json(await api("/agents/shop/suites/approvals/runs", { body: { wait: true } }))).data;
    const r = run.results[0];
    expect(r.status).toBe("passed");
    expect(r.trace.finishReason).toBe("email_preview");
    expect(r.trace.toolCalls).toEqual([expect.objectContaining({ name: "email_send", approval: "interactive", mocked: false })]);
    expect(r.trace.toolCalls[0].result).not.toBe("sent");
  });

  test("datasets template the input, the mocks and the assertions; one result per row", async () => {
    await api("/agents/shop/suites", { body: {
      name: "Rates by country", defaultMode: "all",
      datasets: [{ name: "Countries", rows: [{ country: "IT", rate: "4.99" }, { country: "FR", rate: "5.49" }] }],
      cases: [{
        name: "Quote", dataset: "countries",
        input: { kind: "chat", message: "Shipping to {{row.country}}?" },
        mocks: {
          tools: [{ tool: "mcp__printful__shipping_rates", when: { args: { country: "{{row.country}}" } }, response: { rate: "{{row.rate}}" } }],
          model: { turns: [
            { toolCalls: [{ name: "mcp__printful__shipping_rates", args: { country: "{{row.country}}" } }] },
            { text: "It costs {{row.rate}} EUR" },
          ] },
        },
        assertions: [{ type: "text_contains", value: "{{row.rate}}" }, { type: "tool_args", tool: "mcp__printful__shipping_rates", value: { country: "{{row.country}}" }, match: "exact" }],
      }],
    } });
    const run = (await json(await api("/agents/shop/suites/rates-by-country/runs", { body: { wait: true } }))).data;
    expect(run.planned).toEqual(["quote#1", "quote#2"]);
    expect(run.results.map((r: any) => [r.key, r.status, r.row.values.country])).toEqual([["quote#1", "passed", "IT"], ["quote#2", "passed", "FR"]]);
    expect(run.results[1].trace.toolCalls[0].result).toBe('{"rate":"5.49"}');
    expect(run.stats).toMatchObject({ total: 2, passed: 2, passRate: 1 });
  });

  test("budgets stop a case before the next model call", async () => {
    await api("/agents/shop/suites", { body: {
      name: "Budget", defaultMode: "all", budgets: { maxTurns: 1 },
      cases: [{
        name: "Loops",
        input: { kind: "chat", message: "go" },
        mocks: { tools: [{ tool: "read", response: "x" }], model: { turns: [
          { toolCalls: [{ name: "read", args: { path: "a" } }] },
          { toolCalls: [{ name: "read", args: { path: "b" } }] },
          { text: "never" },
        ] } },
        assertions: [{ type: "tool_called", tool: "read", times: 1 }],
      }],
    } });
    const r = (await json(await api("/agents/shop/suites/budget/runs", { body: { wait: true } }))).data.results[0];
    expect(r.trace.turns).toHaveLength(1);
    expect(r.trace.finishReason).toBe("budget");
    expect(r.trace.notes.join(" ")).toContain("1 model turns");
    expect(r.status).toBe("passed");
  });

  test("real tools need an explicit confirmation (403 without)", async () => {
    await api("/agents/shop/suites", { body: { name: "Live", defaultMode: "model", cases: [{ name: "L", input: { kind: "chat", message: "hi" }, mocks: { model: { turns: [{ text: "hello" }] } }, assertions: [] }] } });
    const denied = await api("/agents/shop/suites/live/runs", { body: { wait: true } });
    expect(denied.status).toBe(403);
    expect((await json(denied)).code).toBe("FORBIDDEN");
    const ok = (await json(await api("/agents/shop/suites/live/runs", { body: { wait: true, allowRealTools: true } }))).data;
    expect(ok.status).toBe("passed");
    expect(providerCalls).toHaveLength(0);
  });

  test("mode tools: the real model (observed) with mocked tools, and the variant's overrides applied for this run only", async () => {
    streamSimpleImpl = mockTurnSequence([
      mockToolCallResponse("mcp__printful__shipping_rates", { country: "IT", items: [{ variant_id: 4012, quantity: 1 }] }),
      mockTextResponse("4.99 EUR", { usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } } as any }),
    ]) as any;
    await api("/agents/shop/suites", { body: { ...shippingSuite, id: "shipping-live-model", name: "Shipping live model", defaultMode: "tools",
      cases: [{ ...shippingSuite.cases[0], mocks: undefined }] } });
    const run = (await json(await api("/agents/shop/suites/shipping-live-model/runs", { body: { wait: true, overrides: { instructionsAppend: "SUITE-OVERRIDE-MARKER" }, variant: { label: "marker" } } }))).data;
    expect(run.status).toBe("passed");
    expect(providerCalls.length).toBeGreaterThanOrEqual(2);
    expect(providerCalls[0].systemPrompt).toContain("SUITE-OVERRIDE-MARKER");
    const r = run.results[0];
    expect(r.trace.turns.every((t: any) => t.mocked === false)).toBe(true);
    expect(r.costUsd).toBeCloseTo(0.01);
    expect(run.variant).toMatchObject({ label: "marker", overrides: { instructionsAppend: "SUITE-OVERRIDE-MARKER" } });
    // the agent itself is untouched
    const agent = (await orchestrator.getAgents()).find((a) => a.name === "shop")!;
    expect(agent.systemPrompt ?? "").not.toContain("SUITE-OVERRIDE-MARKER");
  });

  test("YAML view, revisions, CSV import, validation and delete", async () => {
    const y = await json(await api("/agents/shop/suites/shipping-rates?format=yaml"));
    expect(y.data.yaml).toContain("name: Shipping rates");
    const saved = await json(await api("/agents/shop/suites/shipping-rates", { method: "PUT", body: { yaml: y.data.yaml.replace("name: Shipping rates", "name: Shipping rates (EU)"), revision: y.data.revision } }));
    expect(saved.data).toMatchObject({ name: "Shipping rates (EU)", revision: 2 });
    const stale = await api("/agents/shop/suites/shipping-rates", { method: "PUT", body: { yaml: y.data.yaml, revision: 1 } });
    expect(stale.status).toBe(409);
    const imported = await json(await api("/agents/shop/suites/shipping-rates/datasets/import", { body: { format: "csv", name: "Countries", text: 'country,rate\nIT,4.99\n"DE",5\n' } }));
    expect(imported.data.datasets[0]).toMatchObject({ id: "countries", columns: ["country", "rate"], rows: [{ country: "IT", rate: 4.99 }, { country: "DE", rate: 5 }] });
    const bad = await api("/agents/shop/suites", { body: { name: "Bad", cases: [{ name: "x", input: { message: "m" }, assertions: [{ type: "tool_called" }] }] } });
    expect((await json(bad)).error).toContain("cases[0].assertions[0].tool is required");
    expect((await api("/agents/shop/suites/shipping-rates", { method: "DELETE" })).status).toBe(200);
    expect((await api("/agents/shop/suites/shipping-rates")).status).toBe(404);
    expect((await api("/agents/nobody/suites")).status).toBe(404);
  });
});

describe("agent suites over MCP (on the real instance)", () => {
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
    return { call: (name: string, args: Record<string, unknown>) => rpc("tools/call", { name, arguments: args }), list: () => rpc("tools/list", {}) };
  };

  test("work scope saves and runs offline suites, reads reports and traces; real tools need admin; read scope only reads", async () => {
    const work = mcp(["polpo:work"]);
    const saved = await work.call("polpo_agent_suite_save", { agent: "shop", suite: { ...shippingSuite, id: "mcp-shipping", name: "MCP shipping" } });
    expect(saved.isError).toBeFalsy();
    expect(saved.content[0].text).toContain("Saved MCP shipping [mcp-shipping] rev 1");
    const run = await work.call("polpo_agent_suite_run", { agent: "shop", suite: "mcp-shipping" });
    expect(run.isError).toBeFalsy();
    expect(run.content[0].text).toMatch(/✓ shop · MCP shipping @ production \(v1\.0\.0\) · passed · 1\/1 passed/);
    expect(run.content[0].text).toContain("mcp__printful__shipping_rates(mock)");
    const id = run.structuredContent.run.id;
    const trace = await work.call("polpo_agent_suite_run_get", { agent: "shop", run: id, case: "quote-italy" });
    expect(trace.content[0].text).toContain("tool mcp__printful__shipping_rates [mock rates]");
    expect(trace.content[0].text).toContain("turn 1 (scripted)");
    const list = await work.call("polpo_agent_suite_list", { agent: "shop" });
    expect(list.content[0].text).toMatch(/MCP shipping \[mcp-shipping\] · 1 case\(s\).*last run ✓ passed 1\/1/);
    const live = await work.call("polpo_agent_suite_run", { agent: "shop", suite: "mcp-shipping", mode: "none" });
    expect(live.isError).toBe(true);
    expect(live.content[0].text).toContain("admin scope");

    const admin = mcp(["polpo:admin"]);
    const modelRun = await admin.call("polpo_agent_suite_run", { agent: "shop", suite: "mcp-shipping", mode: "model", label: "real tools" });
    expect(modelRun.isError).toBeFalsy();
    expect(modelRun.structuredContent.run.variant.label).toBe("real tools");

    const read = mcp(["polpo:read"]);
    const names = ((await read.list()).tools as Array<{ name: string }>).map((t) => t.name).filter((n) => n.startsWith("polpo_agent_suite"));
    expect(names.sort()).toEqual(["polpo_agent_suite_cassette", "polpo_agent_suite_get", "polpo_agent_suite_list", "polpo_agent_suite_run_get", "polpo_agent_suite_show", "polpo_agent_suite_trend"]);
  });
});
