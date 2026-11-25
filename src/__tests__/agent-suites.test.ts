/**
 * Agent suites: the pure model (validation, templating, mock matching, assertions, datasets,
 * recorded exchanges) and the runner with fake turns (cancel, concurrency, CLI engine limits,
 * connector / hosted / CLI tool interception without side effects).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSuiteError, InMemoryAgentSuiteStore, argsMatch, caseFromTrace, evaluateAssertion, findToolMock, parseAgentSuite, parseCsvDataset,
  parseJsonDataset, planSuiteCases, planUsesRealTools, renderSuiteTemplate, suiteToolMatches, validateJsonSchema,
  type AgentConfig, type SuiteAssertion, type SuiteTrace,
} from "@polpo-ai/core";
import { AgentSuiteRunner, type AgentSuiteDeps } from "../server/agent-suites.js";
import { FileAgentSuiteStore } from "../stores/file-agent-suite-store.js";
import { captureSuiteToolHook, currentSuiteCase, runAsSuiteCase, suiteStreamLLM, suiteToolExecutor, type SuiteCaseHooks } from "../core/agent-suite-context.js";

function trace(over: Partial<SuiteTrace> = {}): SuiteTrace {
  return {
    input: [{ role: "user", content: "hi" }], turns: [], toolCalls: [], text: "", approvals: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, durationMs: 100, notes: [], ...over,
  };
}
const call = (name: string, args: Record<string, unknown>, extra: Partial<SuiteTrace["toolCalls"][number]> = {}) =>
  ({ id: `${name}-${Math.random()}`, turn: 0, name, args, result: "ok", isError: false, mocked: "mock" as const, durationMs: 1, ...extra });

describe("assertions: each type passes and fails with a clear message", () => {
  const t = trace({
    text: "Shipping to Italy costs 4.99 EUR.",
    toolCalls: [
      call("mcp__printful__shipping_rates", { country: "IT", items: [{ id: 1 }] }),
      call("register_outcome", { label: "quote", type: "text", value: "4.99 EUR" }),
      call("artifact_create", { kind: "document", title: "Quote for Ann" }),
      call("email_send", { to: "ann@example.com" }, { approval: "interactive", mocked: false }),
    ],
    approvals: [{ tool: "email_send", kind: "interactive" }],
    turns: [{ index: 0, text: "", toolCalls: [], mocked: true, durationMs: 0 }, { index: 1, text: "x", toolCalls: [], mocked: true, durationMs: 0 }],
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.02 },
  });
  const cases: Array<[SuiteAssertion, boolean, string?]> = [
    [{ type: "tool_called", tool: "mcp__printful__*" }, true],
    [{ type: "tool_called", tool: "mcp__printful__shipping_rates", args: { country: "IT" } }, true],
    [{ type: "tool_called", tool: "mcp__printful__shipping_rates", args: { country: "FR" } }, false, "never with the expected arguments"],
    [{ type: "tool_called", tool: "web_search" }, false, "got 0"],
    [{ type: "tool_called", tool: "mcp__printful__shipping_rates", times: 2 }, false, "exactly 2"],
    [{ type: "tool_not_called", tool: "mcp__printful__create_order" }, true],
    [{ type: "tool_not_called", tool: "email_send" }, false, "was called 1×"],
    [{ type: "tool_order", tools: ["mcp__printful__shipping_rates", "email_send"] }, true],
    [{ type: "tool_order", tools: ["email_send", "register_outcome"] }, false, "expected email_send → register_outcome"],
    [{ type: "tool_order", tools: ["register_outcome", "artifact_create"], strict: true }, true],
    [{ type: "tool_order", tools: ["mcp__printful__shipping_rates", "artifact_create"], strict: true }, false],
    [{ type: "tool_args", tool: "mcp__printful__shipping_rates", value: { country: "IT", items: [{ id: 1 }] }, match: "exact" }, true],
    [{ type: "tool_args", tool: "mcp__printful__shipping_rates", value: { country: "IT" }, match: "exact" }, false, "do not match (exact)"],
    [{ type: "tool_args", tool: "mcp__printful__shipping_rates", value: { country: "^(IT|FR)$" }, match: "regex" }, true],
    [{ type: "tool_args", tool: "mcp__printful__shipping_rates", value: { type: "object", required: ["zip"] }, match: "schema" }, false, "$.zip: required"],
    [{ type: "tool_args", tool: "nothing", value: {} }, false, "never called"],
    [{ type: "no_tool_errors" }, true],
    [{ type: "outcome_registered", label: "quote", valueContains: "4.99" }, true],
    [{ type: "outcome_registered", label: "invoice" }, false, "none matching"],
    [{ type: "artifact_created", kind: "document", titleContains: "ann" }, true],
    [{ type: "artifact_created", kind: "sheet" }, false],
    [{ type: "approval_requested", tool: "email_*" }, true],
    [{ type: "approval_requested", tool: "whatsapp_send" }, false, "only for email_send"],
    [{ type: "text_contains", value: ["italy", "4.99"] }, true],
    [{ type: "text_contains", value: "Italy", caseSensitive: true }, true],
    [{ type: "text_contains", value: "germany" }, false, '"germany"'],
    [{ type: "text_not_contains", value: "error" }, true],
    [{ type: "text_not_contains", value: "EUR" }, false],
    [{ type: "text_regex", pattern: "\\d+\\.\\d{2} EUR" }, true],
    [{ type: "text_regex", pattern: "^Sorry" }, false, "does not match"],
    [{ type: "max_turns", value: 2 }, true],
    [{ type: "max_turns", value: 1 }, false, "2 model turns (max 1)"],
    [{ type: "max_cost", usd: 0.05 }, true],
    [{ type: "max_cost", usd: 0.01 }, false, "max $0.01"],
    [{ type: "max_duration", ms: 1000 }, true],
    [{ type: "max_duration", ms: 10 }, false, "max 10 ms"],
  ];
  it.each(cases.map(([a, passed, msg], i) => [i, a.type, a, passed, msg] as const))("#%i %s", (_i, _type, a, passed, msg) => {
    const r = evaluateAssertion(a, t);
    expect(r.passed, r.message).toBe(passed);
    if (msg) expect(r.message).toContain(msg);
    expect(r.description.length).toBeGreaterThan(3);
  });
  it("no_tool_errors fails on an error result", () => {
    const r = evaluateAssertion({ type: "no_tool_errors" }, trace({ toolCalls: [call("read", {}, { isError: true, result: "Error: ENOENT" })] }));
    expect(r.passed).toBe(false);
    expect(r.message).toContain("ENOENT");
  });
});

describe("model", () => {
  it("validates with the path of the problem and makes ids from names", () => {
    const s = parseAgentSuite({ name: "Shipping Rates!", cases: [{ name: "Quote IT", input: { message: "x" } }, { name: "Quote IT", input: { message: "y" } }] }, "shop");
    expect(s).toMatchObject({ id: "shipping-rates", agent: "shop", defaultMode: "all", revision: 1, target: { kind: "agent" } });
    expect(s.cases.map((c) => c.id)).toEqual(["quote-it", "quote-it-2"]);
    expect(() => parseAgentSuite({ name: "x", cases: [{ name: "c", input: { message: "m" }, mocks: { tools: [{ tool: "a", response: 1, error: "e" }] } }] }, "a")).toThrow("cases[0].mocks.tools[0]: give response or error, not both");
    expect(() => parseAgentSuite({ name: "x", cases: [{ name: "c", input: { message: "m" }, dataset: "nope" }] }, "a")).toThrow('there is no dataset "nope"');
    expect(() => parseAgentSuite({ name: "x", defaultMode: "live" }, "a")).toThrow("defaultMode must be one of none, tools, model, all");
    expect(() => parseAgentSuite({ name: "x", cases: [{ name: "c", input: { message: "m" }, mocks: { model: { turns: [{}] } } }] }, "a")).toThrow("needs text or toolCalls");
    expect(() => parseAgentSuite({ name: "x", cases: [{ name: "c", input: { message: "m" }, assertions: [{ type: "text_regex", pattern: "(" }] }] }, "a")).toThrow("not a valid regular expression");
    // reserved fields of later phases are kept
    const later = parseAgentSuite({ name: "g", gate: { required: true, minPassRate: 0.9 }, cases: [{ name: "c", input: { message: "m" }, scorers: [{ type: "llm_judge", rubric: "polite", threshold: 0.8 }] }] }, "a");
    expect(later.gate).toEqual({ required: true, minPassRate: 0.9 });
    expect(later.cases[0].scorers).toHaveLength(1);
    expect(parseAgentSuite({ name: "x" }, "a", later).revision).toBe(2);
  });

  it("templates deeply, keeps types for whole placeholders, leaves unknown ones", () => {
    expect(renderSuiteTemplate({ a: "{{row.n}}", b: "n={{row.n}} {{row.o}}", c: ["{{row.missing}}"] }, { row: { n: 3, o: { x: 1 } } }))
      .toEqual({ a: 3, b: 'n=3 {"x":1}', c: ["{{row.missing}}"] });
  });

  it("plans one case per dataset row, merges mocks, flags real tools", () => {
    const s = parseAgentSuite({
      name: "x", defaultMode: "tools", mocks: { tools: [{ tool: "b", response: "suite" }], unmockedTools: "real" },
      datasets: [{ name: "D", rows: [{ q: "a" }, { q: "b" }] }],
      cases: [{ name: "c", dataset: "d", input: { message: "{{row.q}}" }, mocks: { tools: [{ tool: "b", response: "case" }] } }, { name: "e", mode: "all", input: { message: "m" } }],
    }, "a");
    const plan = planSuiteCases(s);
    expect(plan.map((p) => [p.key, p.case.input.message, p.mode])).toEqual([["c#1", "a", "tools"], ["c#2", "b", "tools"], ["e", "m", "all"]]);
    expect(plan[0].mocks.tools!.map((m) => m.response)).toEqual(["case", "suite"]);
    expect(planUsesRealTools(plan)).toBe(true);
    expect(planUsesRealTools(planSuiteCases(s, { caseIds: ["e"] }))).toBe(false);
    expect(() => planSuiteCases(s, { caseIds: ["zz"] })).toThrow(AgentSuiteError);
  });

  it("matches tool mocks by glob, call number, arguments and times", () => {
    const used = new Map<number, number>();
    const mocks = [
      { tool: "mcp__printful__*", when: { args: { country: "IT" } }, response: "it", times: 1 },
      { tool: "mcp__printful__shipping_?ates", when: { call: 2 }, response: "second" },
      { tool: "mcp__printful__*", response: "any" },
    ];
    expect(findToolMock(mocks, "mcp__printful__shipping_rates", { country: "IT" }, 1, used)?.mock.response).toBe("it");
    expect(findToolMock(mocks, "mcp__printful__shipping_rates", { country: "IT" }, 2, used)?.mock.response).toBe("second");
    expect(findToolMock(mocks, "mcp__printful__shipping_rates", { country: "IT" }, 3, used)?.mock.response).toBe("any");
    expect(findToolMock(mocks, "email_send", {}, 1, used)).toBeUndefined();
    expect(suiteToolMatches("email_*", "email_send")).toBe(true);
    expect(suiteToolMatches("email_*", "xemail_send")).toBe(false);
    expect(argsMatch({ items: [{ id: 1 }] }, { items: [{ id: 1, q: 2 }], x: 1 }, "partial")).toBe(true);
    expect(argsMatch({ n: 5 }, { n: "5" }, "exact")).toBe(true);
    expect(validateJsonSchema({ type: "object", properties: { n: { type: "integer", minimum: 1 } }, additionalProperties: false }, { n: 0, x: 1 })).toEqual(["$.n: must be ≥ 1", "$.x: not allowed"]);
  });

  it("imports CSV (quotes, separators, coercion) and JSON datasets", () => {
    expect(parseCsvDataset('id,name,note\n1,"Rossi, Ann","said ""hi""\nthen"\n02,Bob,\n')).toEqual({
      columns: ["id", "name", "note"],
      rows: [{ id: 1, name: "Rossi, Ann", note: 'said "hi"\nthen' }, { id: "02", name: "Bob", note: "" }],
    });
    expect(parseCsvDataset("a;b\n1;true\n").rows).toEqual([{ a: 1, b: true }]);
    expect(parseCsvDataset("a,b\n1,2\n", { coerce: false }).rows).toEqual([{ a: "1", b: "2" }]);
    expect(() => parseCsvDataset('a\n"open')).toThrow("not closed");
    expect(() => parseCsvDataset("a,a\n1,2")).toThrow("unique");
    expect(parseJsonDataset('[{"a":1},{"b":2}]')).toEqual({ columns: ["a", "b"], rows: [{ a: 1 }, { b: 2 }] });
    expect(() => parseJsonDataset('{"x":1}')).toThrow("list of objects");
  });

  it("turns a recorded exchange into a case (observed calls become mocks and expectations)", () => {
    const c = caseFromTrace({
      input: [{ role: "user", content: "earlier" }, { role: "assistant", content: "ok" }, { role: "user", content: "rates to IT?" }],
      toolCalls: [call("mcp__printful__shipping_rates", { country: "IT" }, { result: '{"rate":"4.99"}' }), call("read", { path: "x" }, { isError: true, result: "Error: nope" })],
      turns: [{ index: 0, text: "", toolCalls: [{ id: "1", name: "mcp__printful__shipping_rates", args: { country: "IT" } }], mocked: false, durationMs: 1 }, { index: 1, text: "4.99", toolCalls: [], mocked: false, durationMs: 1 }],
      text: "4.99",
    }, { name: "Recorded quote", mockModel: true });
    expect(c.input).toEqual({ kind: "chat", message: "rates to IT?", history: [{ role: "user", content: "earlier" }, { role: "assistant", content: "ok" }] });
    expect(c.mode).toBe("all");
    expect(c.mocks!.tools).toEqual([
      expect.objectContaining({ tool: "mcp__printful__shipping_rates", when: { args: { country: "IT" }, match: "exact" }, response: '{"rate":"4.99"}' }),
      expect.objectContaining({ tool: "read", error: "nope" }),
    ]);
    expect(c.mocks!.model!.turns).toHaveLength(2);
    expect(c.assertions.map((a) => a.type)).toEqual(["tool_called", "tool_called", "tool_order"]);
    // and it is a valid case
    expect(parseAgentSuite({ name: "s", cases: [c] }, "a").cases[0].id).toBe("recorded-quote");
  });
});

describe("interception seams", () => {
  const hooks = (over: Partial<SuiteCaseHooks> = {}): SuiteCaseHooks => ({
    mocksModel: false, budgetExceeded: () => undefined, nextScriptedTurn: () => undefined, recordTurn: () => undefined,
    toolCall: async (_n, _a, run) => run(), ...over,
  });

  it("connector and hosted MCP server tools are answered by the case before their executor runs", async () => {
    const sideEffects: string[] = [];
    const executor = suiteToolExecutor(async (name: string) => { sideEffects.push(name); return "real"; });
    const h = hooks({ toolCall: async (name, _args, run) => (name.startsWith("mcp__") ? `mocked ${name}` : run()) });
    const out = await runAsSuiteCase(h, async () => [
      await executor("mcp__printful__create_order", { draft: true }, { toolCallId: "c1" }),
      await executor("mcp__my-hosted-server__refund", { id: 1 }),
      await executor("read", {}),
    ]);
    expect(out).toEqual(["mocked mcp__printful__create_order", "mocked mcp__my-hosted-server__refund", "real"]);
    expect(sideEffects).toEqual(["read"]);
    // outside a suite case nothing changes
    expect(await executor("mcp__printful__create_order", {})).toBe("real");
    expect(currentSuiteCase()).toBeUndefined();
  });

  it("the CLI engine's tool server keeps the hooks of the case that opened it", async () => {
    let hook: ReturnType<typeof captureSuiteToolHook>;
    await runAsSuiteCase(hooks({ toolCall: async (name) => `mock:${name}` }), async () => { hook = captureSuiteToolHook(); });
    // a later request, outside the case's async context
    expect(await hook!("mcp__polpo__register_outcome", {}, async () => "real")).toBe("mock:mcp__polpo__register_outcome");
    expect(captureSuiteToolHook()).toBeUndefined();
  });

  it("the model is not called once a budget is spent, nor under a model mock", async () => {
    let calls = 0;
    const stream = suiteStreamLLM(() => { calls++; return { async *[Symbol.asyncIterator]() { /* nothing */ }, result: async () => ({ content: [] }) }; });
    const over = await runAsSuiteCase(hooks({ budgetExceeded: () => "budget: 1 model turns" }), async () => (await stream({}, {}, {}).result()).content);
    expect(over).toEqual([]);
    const turns: unknown[] = [];
    const scripted = await runAsSuiteCase(hooks({ mocksModel: true, nextScriptedTurn: () => ({ text: "hi", toolCalls: [{ name: "read", args: { path: "a" } }] }), recordTurn: (t) => turns.push(t) }),
      async () => (await stream({}, {}, {}).result()).content);
    expect(scripted).toEqual([{ type: "text", text: "hi" }, expect.objectContaining({ type: "toolCall", name: "read", arguments: { path: "a" } })]);
    expect(turns).toHaveLength(1);
    expect(calls).toBe(0);
  });
});

describe("runner", () => {
  const agent = (over: Partial<AgentConfig> = {}): AgentConfig => ({ name: "shop", role: "r", ...over } as AgentConfig);
  const deps = (over: Partial<AgentSuiteDeps> = {}): AgentSuiteDeps => ({
    store: new InMemoryAgentSuiteStore(),
    agents: async () => [agent()],
    resolveAgent: async () => agent(),
    turn: async () => ({ text: "ok", toolCalls: [] }),
    ...over,
  });
  const suite = (cases = 3) => ({ name: "S", cases: Array.from({ length: cases }, (_, i) => ({ name: `c${i}`, input: { message: `m${i}` }, mocks: { model: { turns: [{ text: "ok" }] } }, assertions: [{ type: "text_contains", value: "ok" }] })) });

  it("cancel skips cases not started and stops the running one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const runner = new AgentSuiteRunner(deps({ turn: async () => { await gate; return { text: "ok", toolCalls: [] }; } }));
    await runner.saveSuite("shop", suite(3));
    const { run } = await runner.startRun("shop", "s");
    await new Promise((r) => setTimeout(r, 10));
    const cancelling = runner.cancelRun("shop", run.id);
    release();
    const done = await cancelling;
    expect(done.status).toBe("cancelled");
    expect(done.results.map((r) => r.status)).toEqual(["passed", "skipped", "skipped"]);
    expect((await runner.getRun("shop", run.id)).status).toBe("cancelled");
  });

  it("runs cases with bounded concurrency and keeps their order", async () => {
    let live = 0, peak = 0;
    const runner = new AgentSuiteRunner(deps({ turn: async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 15)); live--; return { text: "ok", toolCalls: [] }; } }));
    await runner.saveSuite("shop", { ...suite(5), concurrency: 2 });
    const run = await runner.run("shop", "s");
    expect(peak).toBe(2);
    expect(run.results.map((r) => r.key)).toEqual(["c0", "c1", "c2", "c3", "c4"]);
    expect(run.stats).toMatchObject({ total: 5, passed: 5, passRate: 1 });
  });

  it("the CLI engine refuses scripted models and needs the admin for its own tools", async () => {
    const cli = agent({ engine: { type: "cli", cli: "claude" } } as Partial<AgentConfig>);
    const runner = new AgentSuiteRunner(deps({ resolveAgent: async () => cli }));
    await runner.saveSuite("shop", { name: "C", cases: [{ name: "a", input: { message: "x" }, mocks: { model: { turns: [{ text: "x" }] } } }] });
    const run = await runner.run("shop", "c");
    expect(run.results[0]).toMatchObject({ status: "errored", engine: "cli" });
    expect(run.results[0].error).toContain("CLI engine cannot");
    await runner.saveSuite("shop", { name: "T", defaultMode: "tools", cases: [{ name: "a", input: { message: "x" } }] });
    await expect(runner.startRun("shop", "t")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const ok = await runner.run("shop", "t", {}, { allowRealTools: true });
    expect(ok.notes.join(" ")).toContain("CLI engine");
  });

  it("an errored turn errors the case; an exhausted script with onExhausted error too", async () => {
    const runner = new AgentSuiteRunner(deps({ turn: async (_ref, _m, h) => { h.nextScriptedTurn(); h.nextScriptedTurn(); return { text: "", toolCalls: [] }; } }));
    await runner.saveSuite("shop", { name: "E", cases: [{ name: "a", input: { message: "x" }, mocks: { model: { turns: [{ text: "x" }], onExhausted: "error" } } }] });
    expect((await runner.run("shop", "e")).results[0].error).toContain("script ended");
    const failing = new AgentSuiteRunner(deps({ turn: async () => { throw new Error("HTTP 502"); } }));
    await failing.saveSuite("shop", suite(1));
    const run = await failing.run("shop", "s");
    expect(run).toMatchObject({ status: "errored", results: [{ status: "errored", error: "HTTP 502" }] });
  });

  it("file store keeps suites and runs per agent and forgets an agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suite-store-"));
    try {
      const store = new FileAgentSuiteStore(dir);
      const runner = new AgentSuiteRunner(deps({ store }));
      await runner.saveSuite("shop", suite(1));
      const run = await runner.run("shop", "s");
      expect((await store.listSuites("shop")).map((s) => s.id)).toEqual(["s"]);
      expect((await store.listRuns("shop", { suiteId: "s" }))[0].id).toBe(run.id);
      await expect(runner.saveSuite("shop", { ...suite(1), revision: 0 }, { revision: 0 })).rejects.toMatchObject({ code: "CONFLICT" });
      await runner.forget("shop");
      expect(await store.listSuites("shop")).toEqual([]);
      expect(await store.listRuns("shop")).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
