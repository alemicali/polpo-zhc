/**
 * Agent suites, phase 4 — with mocks only (no model, no connector, no API is ever called):
 * redaction, cassette matching, record → replay through the runner, the cassette editor, cases
 * from real chats and task runs, simulated and scripted users, AI case generation (reviewed, never
 * saved by itself), hosted MCP server suites (HTTP mocks, the deploy gate), mission suites (mocks per
 * agent) and the CI reports (JUnit, Markdown, exit codes).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryAgentSuiteStore, REDACTED, cassetteArgsMatch, cassetteFromTrace, editCassette, hostedServerStorage, hostedServerSuite, hostedTestToCase,
  caseToHostedTest, matchCassetteCall, parseAgentSuite, parseGeneratedCases, parseSimulatedUserReply, redactCassetteSecrets, simulatedUserPrompt, suiteReportExitCode,
  suiteRunsJunit, suiteRunsMarkdown, suiteRunsText, traceFromChat, traceFromTaskActivity,
  type AgentConfig, type CassetteCall, type ScriptedTurn, type SuiteRun,
} from "@polpo-ai/core";
import { AgentSuiteRunner, type AgentSuiteDeps, type SuiteTurnResult } from "../server/agent-suites.js";
import type { SuiteCaseHooks } from "../core/agent-suite-context.js";
import { McpServerService } from "../mcp-servers/service.js";
import { normalizeSpec } from "../mcp-servers/validate.js";

const SECRET = "sk-live-0123456789abcdefghijkl";

/**
 * A stand-in for the chat pipeline: under a model mock it plays the case's script; otherwise it asks
 * `realModel` (a fake "real" model) for each turn. Every tool call goes through the case's hooks.
 */
function pipeline(opts: { realModel?: (messages: Array<{ role: string; content: string }>, turn: number) => ScriptedTurn; tools?: Record<string, (args: Record<string, unknown>) => string>; calls?: { model: number; tools: string[] } } = {}) {
  return async (_ref: string, messages: Array<{ role: string; content: string }>, hooks: SuiteCaseHooks): Promise<SuiteTurnResult> => {
    let text = "";
    for (let i = 0; i < 20; i++) {
      if (hooks.budgetExceeded()) break;
      let turn: ScriptedTurn | undefined;
      if (hooks.mocksModel) turn = hooks.nextScriptedTurn();
      else {
        turn = opts.realModel?.(messages, i);
        if (opts.calls) opts.calls.model++;
      }
      if (!turn) break;
      const toolCalls = (turn.toolCalls ?? []).map((c, j) => ({ id: c.id ?? `t${i}-${j}`, name: c.name, args: c.args ?? {} }));
      hooks.recordTurn({ text: turn.text ?? "", toolCalls, mocked: hooks.mocksModel, durationMs: 0, ...(turn.usage ? { usage: { inputTokens: turn.usage.inputTokens ?? 0, outputTokens: turn.usage.outputTokens ?? 0, costUsd: turn.usage.costUsd ?? 0 } } : {}) });
      if (turn.text) text = turn.text;
      if (!toolCalls.length) break;
      for (const c of toolCalls) {
        await hooks.toolCall(c.name, c.args, async () => {
          opts.calls?.tools.push(c.name);
          return opts.tools?.[c.name]?.(c.args) ?? `real ${c.name}`;
        }, c.id);
      }
    }
    return { text, toolCalls: [] };
  };
}

const agent = (over: Partial<AgentConfig> = {}): AgentConfig => ({ name: "shop", role: "Shop agent", ...over } as AgentConfig);
const deps = (over: Partial<AgentSuiteDeps> = {}): AgentSuiteDeps => ({
  store: new InMemoryAgentSuiteStore(),
  agents: async () => [agent(), agent({ name: "writer" }), agent({ name: "checker" })],
  resolveAgent: async (name) => agent({ name }),
  turn: pipeline(),
  ...over,
});

describe("redaction", () => {
  it("redacts secret keys, the vault's values and credential shapes, deeply, and counts them", () => {
    const { value, count } = redactCassetteSecrets({
      headers: { Authorization: "Bearer abcdefghijklmnop", "x-trace": "ok" },
      args: { apiKey: "k-123", query: `token is ${SECRET} and vault value hunter2-pass` },
      result: '{"access_token":"abc.def","name":"Ann"} Authorization: Basic Zm9vOmJhcg==',
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      list: ["ghp_abcdefghijklmnopqrstuvwx1234"],
    }, ["hunter2-pass"]);
    expect(value.headers).toEqual({ Authorization: REDACTED, "x-trace": "ok" });
    expect(value.args.apiKey).toBe(REDACTED);
    expect(value.args.query).toBe(`token is ${REDACTED} and vault value ${REDACTED}`);
    expect(value.result).toContain(`"access_token":"${REDACTED}"`);
    expect(value.result).toContain('"name":"Ann"');
    expect(value.result).not.toContain("Zm9vOmJhcg");
    expect(value.jwt).toBe(REDACTED);
    expect(value.list).toEqual([REDACTED]);
    expect(count).toBeGreaterThanOrEqual(7);
    // nothing to redact: unchanged
    expect(redactCassetteSecrets({ a: "plain text", n: 3 })).toEqual({ value: { a: "plain text", n: 3 }, count: 0 });
  });
});

describe("cassette matching", () => {
  const calls: CassetteCall[] = [
    { id: "a", turn: 0, tool: "rates", args: { country: "IT", key: REDACTED }, response: "4.99", isError: false },
    { id: "b", turn: 0, tool: "rates", args: { country: "DE" }, response: "5.49", isError: false },
    { id: "c", turn: 1, tool: "order", args: { id: 1 }, response: "nope", isError: true },
    { id: "d", turn: 1, tool: "pinned", args: {}, response: "x", isError: false, mock: true },
  ];
  it("a redacted value matches anything; exact, partial, tool and sequence", () => {
    expect(cassetteArgsMatch({ key: REDACTED, n: 1 }, { key: "real", n: "1" })).toBe(true);
    expect(cassetteArgsMatch({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(cassetteArgsMatch({ a: 1 }, { a: 1, b: 2 }, true)).toBe(true);
    expect(cassetteArgsMatch("Bearer [REDACTED]", "Bearer xyz")).toBe(true);
    const used = new Set<string>();
    expect(matchCassetteCall(calls, "rates", { country: "DE" }, { used, callIndex: 0 })?.id).toBe("b");
    expect(matchCassetteCall(calls, "rates", { country: "IT", key: "secret" }, { used, callIndex: 1 })?.id).toBe("a");
    expect(matchCassetteCall(calls, "rates", { country: "IT", key: "secret" }, { used, callIndex: 2 })).toBeUndefined();
    expect(matchCassetteCall(calls, "rates", { country: "FR", extra: 1 }, { used: new Set(), callIndex: 0, match: "tool" })?.id).toBe("a");
    expect(matchCassetteCall(calls, "rates", { country: "DE", extra: 1 }, { used: new Set(), callIndex: 0, match: "partial" })?.id).toBe("b");
    expect(matchCassetteCall(calls, "order", { id: 9 }, { used: new Set(), callIndex: 2, match: "sequence" })?.id).toBe("c");
    expect(matchCassetteCall(calls, "rates", {}, { used: new Set(), callIndex: 2, match: "sequence" })).toBeUndefined();
    // calls turned into mocks are not replayed
    expect(matchCassetteCall(calls, "pinned", {}, { used: new Set(), callIndex: 3 })).toBeUndefined();
  });

  it("edits a call's response, deletes one, turns one into a mock; an old revision is refused", () => {
    const c = cassetteFromTrace({ input: [{ role: "user", content: "hi" }], turns: [], toolCalls: [
      { id: "x", turn: 0, name: "rates", args: { country: "IT" }, result: "4.99", isError: false, mocked: false, durationMs: 1 },
      { id: "y", turn: 0, name: "order", args: {}, result: "ok", isError: false, mocked: false, durationMs: 1 },
    ], text: "4.99" }, { id: "cas", agent: "shop", name: "Quote", source: { kind: "run" } });
    const { cassette, mocks } = editCassette(c, [{ callId: "x", response: "5.99" }, { callId: "y", markAsMock: true }], { revision: 1 });
    expect(cassette.calls.find((x) => x.id === "x")).toMatchObject({ response: "5.99", edited: true });
    expect(mocks.map((m) => m.id)).toEqual(["y"]);
    expect(cassette.revision).toBe(2);
    expect(() => editCassette(cassette, [{ callId: "x", delete: true }], { revision: 1 })).toThrow("changed since");
    expect(editCassette(cassette, [{ callId: "x", delete: true }]).cassette.calls.map((x) => x.id)).toEqual(["y"]);
    expect(() => editCassette(cassette, [{ callId: "nope", delete: true }])).toThrow('no call "nope"');
  });
});

describe("record → replay", () => {
  it("records live (admins only), saves a redacted cassette, then replays offline and deterministically", async () => {
    const calls = { model: 0, tools: [] as string[] };
    const realModel = (_m: unknown, turn: number): ScriptedTurn => turn === 0
      ? { toolCalls: [{ name: "mcp__shop__rates", args: { country: "IT", apiKey: SECRET } }] }
      : { text: "Shipping to Italy costs 4.99 EUR.", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 } };
    const runner = new AgentSuiteRunner(deps({
      turn: pipeline({ realModel, calls, tools: { mcp__shop__rates: () => `{"rate":"4.99","debug":"Authorization: Bearer ${SECRET}"}` } }),
      secrets: async () => [SECRET],
    }));
    await runner.saveSuite("shop", { name: "Quotes", cases: [{ name: "Quote IT", input: { message: "Shipping to Italy?" }, assertions: [{ type: "text_contains", value: "4.99" }, { type: "tool_called", tool: "mcp__shop__rates" }] }] });

    await expect(runner.startRun("shop", "quotes", { record: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const rec = await runner.run("shop", "quotes", { record: true }, { allowRealTools: true });
    expect(rec).toMatchObject({ status: "passed", trigger: "record", record: true });
    expect(rec.results[0].mode).toBe("none");
    expect(rec.results[0].trace.recorded).toMatchObject({ cassetteId: "quote-it-rec", calls: 1, turns: 2 });
    expect(calls).toEqual({ model: 2, tools: ["mcp__shop__rates"] });

    const cassette = await runner.getCassette("shop", "quote-it-rec");
    expect(JSON.stringify(cassette)).not.toContain(SECRET);
    expect(cassette.calls[0]).toMatchObject({ tool: "mcp__shop__rates", args: { country: "IT", apiKey: REDACTED } });
    expect(cassette.calls[0].response).toContain(REDACTED);
    expect(cassette.redactions).toBeGreaterThanOrEqual(2);
    // the case now replays its cassette
    const suite = await runner.getSuite("shop", "quotes");
    expect(suite.cases[0].mocks?.cassette).toEqual({ id: "quote-it-rec" });

    calls.model = 0; calls.tools.length = 0;
    const replay = await runner.run("shop", "quotes", { mode: "all" });
    expect(replay.status).toBe("passed");
    expect(calls).toEqual({ model: 0, tools: [] });
    const r = replay.results[0];
    expect(r.trace.toolCalls[0]).toMatchObject({ mocked: "cassette", mockId: expect.stringContaining("quote-it-rec#") });
    expect(r.trace.cassette).toMatchObject({ id: "quote-it-rec", replayedCalls: 1, replayedTurns: 2, unmatched: [] });
    expect(r.trace.text).toContain("4.99");
    // a recording run is not a baseline for replays
    expect(replay.baseline).toBeUndefined();
  });

  it("an unmatched call is blocked, or fails the case with onUnmatched: fail; a missing cassette is noted", async () => {
    const store = new InMemoryAgentSuiteStore();
    await store.saveCassette(cassetteFromTrace({
      input: [], text: "",
      turns: [{ index: 0, text: "", toolCalls: [{ id: "1", name: "rates", args: { country: "FR" } }], mocked: false, durationMs: 0 }, { index: 1, text: "done", toolCalls: [], mocked: false, durationMs: 0 }],
      toolCalls: [{ id: "1", turn: 0, name: "rates", args: { country: "IT" }, result: "4.99", isError: false, mocked: false, durationMs: 0 }],
    }, { id: "cas", agent: "shop", name: "x", source: { kind: "run" } }));
    const runner = new AgentSuiteRunner(deps({ store }));
    await runner.saveSuite("shop", { name: "R", cases: [
      { name: "block", input: { message: "x" }, mocks: { cassette: { id: "cas" } } },
      { name: "fail", input: { message: "x" }, mocks: { cassette: { id: "cas", onUnmatched: "fail" } } },
      { name: "tool match", input: { message: "x" }, mocks: { cassette: { id: "cas", match: "tool" } }, assertions: [{ type: "no_tool_errors" }] },
      { name: "missing", input: { message: "x" }, mocks: { cassette: { id: "nope" }, model: { turns: [{ text: "hi" }] } } },
    ] });
    const run = await runner.run("shop", "r");
    const [block, fail, tool, missing] = run.results;
    expect(block.status).toBe("passed");
    expect(block.trace.toolCalls[0]).toMatchObject({ mocked: "blocked", isError: true });
    expect(block.trace.cassette?.unmatched).toEqual(["rates"]);
    expect(fail.status).toBe("failed");
    expect(fail.assertions[0]).toMatchObject({ passed: false, message: "no recording for: rates" });
    expect(tool.status).toBe("passed");
    expect(tool.trace.toolCalls[0]).toMatchObject({ mocked: "cassette", result: "4.99" });
    expect(missing.trace.notes.join(" ")).toContain("was not found");
  });

  it("the cassette editor: a new response is replayed, a call turned into a mock lands in the case", async () => {
    const runner = new AgentSuiteRunner(deps({ turn: pipeline({ realModel: (_m, i) => (i === 0 ? { toolCalls: [{ name: "rates", args: { c: "IT" } }] } : { text: "ok" }) }) }));
    await runner.saveSuite("shop", { name: "E", cases: [{ name: "q", input: { message: "x" } }] });
    await runner.run("shop", "e", { record: true }, { allowRealTools: true });
    const cas = await runner.getCassette("shop", "q-rec");
    const edited = await runner.editCassette("shop", "q-rec", [{ callId: cas.calls[0].id, response: "7.77" }], { revision: cas.revision });
    expect(edited.calls[0].response).toBe("7.77");
    const replay = await runner.run("shop", "e", { mode: "all" });
    expect(replay.results[0].trace.toolCalls[0].result).toBe("7.77");
    await runner.editCassette("shop", "q-rec", [{ callId: cas.calls[0].id, markAsMock: true }]);
    const suite = await runner.getSuite("shop", "e");
    expect(suite.cases[0].mocks?.tools?.[0]).toMatchObject({ tool: "rates", when: { args: { c: "IT" }, match: "exact" }, response: "7.77" });
    const again = await runner.run("shop", "e", { mode: "all" });
    expect(again.results[0].trace.toolCalls[0]).toMatchObject({ mocked: "mock" });
    expect(await runner.caseCassette("shop", "e", "q")).toMatchObject({ id: "q-rec" });
    await runner.deleteCassette("shop", "q-rec");
    expect(await runner.caseCassette("shop", "e", "q")).toBeNull();
  });
});

describe("cases from real chats and task runs", () => {
  it("a chat's last exchange becomes a case and a redacted cassette, added to the suite", async () => {
    const messages = [
      { role: "user", content: "hello" }, { role: "assistant", content: "hi" },
      { role: "user", content: `Quote Italy, my key is ${SECRET}` },
      { role: "assistant", content: "Italy: 4.99", toolCalls: [{ id: "c1", name: "rates", arguments: { country: "IT" }, result: "4.99" }] },
    ];
    const trace = traceFromChat(messages);
    expect(trace.input.map((m) => m.content)).toEqual(["hello", "hi", `Quote Italy, my key is ${SECRET}`]);
    expect(trace.turns.map((t) => [t.text, t.toolCalls.length])).toEqual([["", 1], ["Italy: 4.99", 0]]);
    const runner = new AgentSuiteRunner(deps({
      sessionMessages: async (id) => (id === "s1" ? { agent: "shop", title: "Italy quote", messages } : undefined),
      secrets: async () => [SECRET],
    }));
    await runner.saveSuite("shop", { name: "C", cases: [] });
    const out = await runner.caseFromRecording("shop", "c", { sessionId: "s1" });
    expect(out.case).toMatchObject({ name: "Italy quote", mode: "all", mocks: { cassette: { id: out.cassette.id } }, source: { kind: "recorded", sessionId: "s1" } });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.suite.cases).toHaveLength(1);
    const run = await runner.run("shop", "c");
    expect(run.status).toBe("passed");
    expect(run.results[0].trace.toolCalls[0]).toMatchObject({ name: "rates", mocked: "cassette", result: "4.99" });
    await expect(runner.caseFromRecording("shop", "c", { sessionId: "nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a task run's activity becomes a task case", async () => {
    const entries = [
      { type: "tool_use", id: "u1", name: "read", input: { path: "a.md" } },
      { type: "tool_result", toolUseId: "u1", content: "file text" },
      { type: "assistant", text: "Summarized a.md" },
    ];
    expect(traceFromTaskActivity({ title: "Sum", description: "Summarize a.md" }, entries)).toMatchObject({ text: "Summarized a.md", toolCalls: [{ name: "read", result: "file text" }] });
    const runner = new AgentSuiteRunner(deps({ taskActivity: async () => ({ title: "Sum", description: "Summarize a.md", assignTo: "shop", entries }) }));
    await runner.saveSuite("shop", { name: "T", cases: [] });
    const out = await runner.caseFromRecording("shop", "t", { taskId: "task-1" });
    expect(out.case.input).toMatchObject({ kind: "task" });
    expect(out.case.source).toMatchObject({ kind: "recorded", taskId: "task-1" });
    expect((await runner.run("shop", "t")).status).toBe("passed");
  });
});

describe("simulated and scripted users", () => {
  const agentTurn = pipeline({ realModel: (messages) => ({ text: `reply to: ${messages[messages.length - 1]!.content}` }) });

  it("a model plays the user until it says the goal is reached; assertions read the whole conversation", async () => {
    const prompts: Array<{ prompt: string; model?: string }> = [];
    const answers = ['{"done": false, "message": "My order is 123"}', '{"done": true, "goalReached": true, "reason": "refund confirmed"}'];
    const runner = new AgentSuiteRunner(deps({
      turn: agentTurn,
      simulate: async (req) => { prompts.push(req); return { text: answers.shift()!, model: "sim-model", costUsd: 0.002 }; },
    }));
    await runner.saveSuite("shop", { name: "Sim", simulatorModel: "anthropic:sim", cases: [{
      name: "refund", mode: "tools", input: { message: "I want a refund" },
      mocks: { simulatedUser: { persona: "An annoyed customer", goal: "Get a refund for order 123", constraints: ["never shouts"], maxTurns: 4 } },
      assertions: [{ type: "text_contains", value: ["reply to: I want a refund", "reply to: My order is 123"] }],
    }] });
    const run = await runner.run("shop", "sim", {}, { allowRealTools: true });
    const r = run.results[0];
    expect(r.status).toBe("passed");
    expect(r.trace.transcript!.map((m) => [m.role, m.content])).toEqual([
      ["user", "I want a refund"], ["assistant", "reply to: I want a refund"], ["user", "My order is 123"], ["assistant", "reply to: My order is 123"],
    ]);
    expect(r.trace.transcript![2].simulated).toBe(true);
    expect(r.trace.simulator).toMatchObject({ model: "sim-model", calls: 2, costUsd: 0.004, stoppedBy: "goal", goalReached: true });
    expect(r.trace.finalText).toBe("reply to: My order is 123");
    expect(prompts[0].model).toBe("anthropic:sim");
    expect(prompts[0].prompt).toContain("An annoyed customer");
    expect(prompts[0].prompt).toContain("never shouts");
    // the simulator's cost is not the agent's
    expect(r.costUsd).toBe(0);
  });

  it("a scripted user plays fixed turns (no simulator); a scorer can stop the conversation", async () => {
    const runner = new AgentSuiteRunner(deps({ turn: agentTurn }));
    await runner.saveSuite("shop", { name: "Script", cases: [
      { name: "scripted", mode: "tools", input: { message: "one" }, mocks: { simulatedUser: { script: ["two", "three"] } } },
      { name: "stop on scorer", mode: "tools", input: { message: "one" },
        mocks: { simulatedUser: { script: ["two", "three", "four"], stop: "scorer", stopScorer: "said-two" } },
        scorers: [{ id: "said-two", type: "contains_all", values: ["reply to: two"] }] },
    ] });
    const run = await runner.run("shop", "script", {}, { allowRealTools: true });
    expect(run.results[0].trace.transcript!.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["one", "two", "three"]);
    expect(run.results[0].trace.simulator).toMatchObject({ calls: 0, stoppedBy: "script" });
    expect(run.results[1].trace.transcript!.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["one", "two"]);
    expect(run.results[1].trace.simulator?.stoppedBy).toBe("scorer");
    expect(run.results[1].status).toBe("passed");
  });

  it("works with tool mocks and a scripted model (offline); without a simulator a model-played user errors", async () => {
    const runner = new AgentSuiteRunner(deps());
    await runner.saveSuite("shop", { name: "Off", cases: [
      { name: "offline", input: { message: "rates?" }, mocks: {
        simulatedUser: { script: ["and to DE?"] },
        model: { turns: [{ toolCalls: [{ name: "rates", args: { c: "IT" } }] }, { text: "IT 4.99" }, { toolCalls: [{ name: "rates", args: { c: "DE" } }] }, { text: "DE 5.49" }] },
        tools: [{ tool: "rates", response: "{{args.c}} ok" }],
      }, assertions: [{ type: "tool_called", tool: "rates", times: 2 }, { type: "text_contains", value: ["IT 4.99", "DE 5.49"] }] },
      { name: "no simulator", input: { message: "x" }, mocks: { simulatedUser: { persona: "p", goal: "g" }, model: { turns: [{ text: "a" }] } } },
    ] });
    const run = await runner.run("shop", "off");
    expect(run.results[0].status).toBe("passed");
    expect(run.results[1]).toMatchObject({ status: "errored", error: expect.stringContaining("No simulated user") });
  });

  it("parses the simulator's answers leniently", () => {
    expect(parseSimulatedUserReply('```json\n{"done":false,"message":"hi"}\n```')).toEqual({ done: false, message: "hi" });
    expect(parseSimulatedUserReply('{"done":true,"goalReached":false,"reason":"stuck"}')).toEqual({ done: true, goalReached: false, reason: "stuck" });
    expect(parseSimulatedUserReply("plain next message")).toEqual({ done: false, message: "plain next message" });
    expect(() => parseAgentSuite({ name: "x", cases: [{ name: "c", input: { message: "m" }, mocks: { simulatedUser: {} } }] }, "a")).toThrow("needs a persona or a goal");
    expect(() => parseAgentSuite({ name: "x", cases: [{ name: "c", input: { message: "m" }, mocks: { simulatedUser: { goal: "g", stop: "scorer" } } }] }, "a")).toThrow("stopScorer is required");
  });

  it("the simulator's prompt: persona, goal, constraints, the conversation; it may stop unless every turn must run", () => {
    const transcript = [{ role: "user" as const, content: "I want a refund" }, { role: "assistant" as const, content: "Which order?" }];
    const goal = simulatedUserPrompt({ persona: "annoyed customer", goal: "a refund for order 123", constraints: ["answers in Italian"] }, transcript, { turn: 2, maxTurns: 6 });
    expect(goal).toContain("annoyed customer");
    expect(goal).toContain("- answers in Italian");
    expect(goal).toContain("ASSISTANT: Which order?");
    expect(goal).toContain('"done": true');
    const all = simulatedUserPrompt({ goal: "g", stop: "max_turns" }, transcript, { turn: 2, maxTurns: 6 });
    expect(all).toContain("Keep the conversation going");
    expect(all).not.toContain('"done": true');
  });
});

describe("AI case generation (reviewed, never saved by itself)", () => {
  const answer = JSON.stringify({ cases: [
    { name: "Quote Italy", category: "happy", rationale: "the main job", input: { kind: "chat", message: "Rates to {{row.country}}?" }, mode: "all",
      mocks: { tools: [{ tool: "mcp__printful__shipping_rates", response: { rate: "4.99" } }], model: { turns: [{ toolCalls: [{ name: "mcp__printful__shipping_rates", args: { country: "{{row.country}}" } }] }, { text: "4.99" }] } },
      assertions: [{ type: "tool_called", tool: "mcp__printful__shipping_rates" }], dataset: { name: "Countries", rows: [{ country: "IT" }, { country: "DE" }] } },
    { name: "Injection in a tool result", category: "adversarial", input: { kind: "chat", message: "Read the note" }, assertions: [{ type: "tool_not_called", tool: "email_send" }] },
    { name: "Broken", input: { kind: "chat" }, assertions: [] },
  ] });

  it("proposes validated cases with their rationale; nothing is saved until accepted", async () => {
    const prompts: string[] = [];
    const runner = new AgentSuiteRunner(deps({
      generate: async ({ prompt }) => { prompts.push(prompt); return { text: answer, model: "gen-model", costUsd: 0.01 }; },
      agentInfo: async (a) => ({ name: a.name, instructions: "Quote shipping with Printful", tools: [{ name: "mcp__printful__shipping_rates", description: "Rates" }] }),
      sessionMessages: async () => ({ title: "Sample", messages: [{ role: "user", content: `rates please ${SECRET}` }] }),
      secrets: async () => [SECRET],
    }));
    await runner.saveSuite("shop", { name: "Gen", cases: [{ name: "Quote Italy", input: { message: "x" } }] });
    const before = await runner.getSuite("shop", "gen");
    const out = await runner.generateCases("shop", { suiteId: "gen", count: 3, brief: "shipping", sessionIds: ["s1"] });
    expect(out).toMatchObject({ model: "gen-model", costUsd: 0.01 });
    expect(prompts[0]).toContain("Quote shipping with Printful");
    expect(prompts[0]).toContain("mcp__printful__shipping_rates: Rates");
    expect(prompts[0]).toContain("prompt injection");
    expect(prompts[0]).not.toContain(SECRET);
    const [a, b, c] = out.proposals;
    expect(a.case).toMatchObject({ id: "quote-italy-2", dataset: "countries", source: { kind: "generated", category: "happy", rationale: "the main job" } });
    expect(a.dataset).toMatchObject({ id: "countries", rows: [{ country: "IT" }, { country: "DE" }] });
    expect(b.case?.name).toBe("Injection in a tool result");
    expect(c.error).toContain("message is required");
    // not saved
    expect((await runner.getSuite("shop", "gen")).revision).toBe(before.revision);
    // the person accepts one (with its dataset)
    const saved = await runner.acceptCases("shop", "gen", { cases: [a.case], datasets: [a.dataset] });
    expect(saved.cases.map((x) => x.id)).toEqual(["quote-italy", "quote-italy-2"]);
    expect(saved.datasets.map((d) => d.id)).toEqual(["countries"]);
    expect((await runner.run("shop", "gen", { caseIds: ["quote-italy-2"] })).results.map((r) => r.status)).toEqual(["passed", "passed"]);
  });

  it("proposes dataset rows for a case (not saved); no model: a clear error", async () => {
    const runner = new AgentSuiteRunner(deps({ generate: async () => ({ text: '{"rows":[{"country":"FR","x":1},{"country":"ES"}]}' }) }));
    await runner.saveSuite("shop", { name: "D", datasets: [{ name: "C", rows: [{ country: "IT" }] }], cases: [{ name: "q", dataset: "c", input: { message: "to {{row.country}}" } }] });
    expect(await runner.generateDatasetRows("shop", "d", { caseId: "q", count: 2 })).toMatchObject({ datasetId: "c", columns: ["country"], rows: [{ country: "FR" }, { country: "ES" }] });
    const none = new AgentSuiteRunner(deps());
    await none.saveSuite("shop", { name: "D", cases: [{ name: "q", input: { message: "x" } }] });
    await expect(none.generateCases("shop", {})).rejects.toMatchObject({ code: "CONFLICT" });
    expect(() => parseGeneratedCases("no json here")).toThrow("no cases");
  });
});

describe("hosted MCP server suites", () => {
  const spec = normalizeSpec({
    name: "Shop", baseUrl: "https://api.shop.test", allowedDomains: ["api.shop.test"],
    secrets: { token: { owner: "infra", service: "shop", key: "token" } }, auth: { type: "bearer", secret: "token" },
    tools: [
      { name: "get_item", description: "One item", kind: "http", annotations: { readOnlyHint: true },
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        http: { method: "GET", url: "/items/{{input.id}}", response: { pick: "data", fields: ["id", "name"] }, errors: [{ status: 404, message: "No such item" }] } },
      { name: "delete_item", description: "Delete", kind: "http", requiresApproval: true, annotations: { destructiveHint: true },
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, http: { method: "DELETE", url: "/items/{{input.id}}" } },
    ],
  });

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "hosted-suite-"));
    let runner!: AgentSuiteRunner;
    const realFetches: string[] = [];
    const service = new McpServerService({
      polpoDir: dir, vault: () => undefined, runtime: () => ({ fetch: async (u: string) => { realFetches.push(u); return new Response("{}"); } }),
      suiteGate: () => (id, version, opts) => runner.hostedGate(id, version, opts),
      suiteCheck: () => (id, ref, opts) => runner.hostedCheck(id, ref, opts),
    });
    runner = new AgentSuiteRunner(deps({
      targets: { mcpServer: {
        exists: (id) => service.store.exists(id),
        readSuite: (id) => { const s = service.suiteStorage(id); return hostedServerSuite({ id, name: s.name, createdAt: s.createdAt }, s.tests, s.settings); },
        writeSuite: (suite) => { const { tests, settings } = hostedServerStorage(suite); service.saveSuiteStorage(suite.agent.replace(/^mcp-server:/, ""), tests, settings); },
        production: (id) => service.store.production(id),
        tools: (id, ref) => service.toolKinds(id, ref),
        call: (id, req) => service.suiteCall(id, req),
      } },
    }));
    const { id } = service.create({ id: "shop", spec }, "tester");
    return { dir, service, runner, id, realFetches };
  }

  it("the saved tests are the suite (one storage, both ways); HTTP is mocked; destructive tools run safely", async () => {
    const { dir, service, runner, realFetches } = setup();
    try {
      // a legacy saved test is a case
      service.saveTests("shop", [{ id: "t1", tool: "get_item", input: { id: "1" }, contains: "Lamp" }]);
      const s = (await runner.listSuites("mcp-server:shop"))[0];
      expect(s).toMatchObject({ id: "saved-tests", target: { kind: "mcp-server", server: "shop" }, cases: [{ id: "t1", input: { kind: "tool", tool: "get_item", args: { id: "1" } } }] });
      expect(caseToHostedTest(hostedTestToCase({ id: "t1", tool: "get_item", input: { id: "1" }, expect: "error", contains: "x" }))).toEqual({ id: "t1", tool: "get_item", input: { id: "1" }, expect: "error", contains: "x" });
      await runner.saveSuite("mcp-server:shop", {
        ...s,
        mocks: { http: [{ method: "GET", url: "https://api.shop.test/items/1", body: { data: { id: "1", name: "Lamp", secret: "x" } } }] },
        cases: [
          ...s.cases,
          { id: "missing", name: "404", input: { kind: "tool", tool: "get_item", args: { id: "9" } },
            mocks: { http: [{ url: "/items/9", status: 404, body: { error: "nope" } }] },
            assertions: [{ type: "tool_failed", contains: "No such item" }, { type: "http_called", method: "GET", url: "*/items/9", times: 1 }] },
          { id: "delete", name: "Delete", input: { kind: "tool", tool: "delete_item", args: { id: "1" } }, mocks: { http: [{ method: "DELETE", url: "/items/1", status: 204 }] }, assertions: [{ type: "http_called", method: "DELETE", url: "/items/1" }] },
          { id: "unmocked", name: "Unmocked", input: { kind: "tool", tool: "get_item", args: { id: "5" } }, assertions: [{ type: "tool_failed", contains: "no HTTP mock" }] },
        ],
      });
      // stored back in tests.json, the suite settings in server.json
      expect(service.store.tests("shop").map((t) => t.id)).toEqual(["t1", "missing", "delete", "unmocked"]);
      expect(service.store.meta("shop")?.suite?.http).toHaveLength(1);
      const run = await runner.run("mcp-server:shop", "saved-tests");
      expect(run.targetKind).toBe("mcp-server");
      expect(run.target).toBe("draft");
      expect(run.results.map((r) => [r.key, r.status])).toEqual([["t1", "passed"], ["missing", "passed"], ["delete", "passed"], ["unmocked", "passed"]]);
      expect(run.results[0].trace.http).toEqual([expect.objectContaining({ method: "GET", url: "https://api.shop.test/items/1", status: 200, mocked: "mock" })]);
      expect(run.results[0].trace.text).toContain("Lamp");
      expect(run.results[3].trace.http?.[0]).toMatchObject({ mocked: "blocked" });
      // nothing reached the network
      expect(realFetches).toEqual([]);
      // real HTTP needs the admin
      await expect(runner.startRun("mcp-server:shop", "saved-tests", { mode: "none" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(runner.saveSuite("mcp-server:shop", { name: "Other", cases: [] , id: "other" })).rejects.toThrow("one suite");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a required suite gates the server's deploys: blocked, an admin's override with a reason, rollbacks never gated", async () => {
    const { dir, service, runner, realFetches } = setup();
    try {
      const s = (await runner.listSuites("mcp-server:shop"))[0];
      await runner.saveSuite("mcp-server:shop", { ...s, gate: { required: true }, cases: [
        { id: "item", name: "Item", input: { kind: "tool", tool: "get_item", args: { id: "1" } }, mocks: { http: [{ url: "/items/1", body: { data: { id: "1", name: "Lamp" } } }] }, assertions: [{ type: "text_contains", value: "Lamp" }] },
      ] });
      const first = await service.publish("shop", {}, "tester");
      expect(first.deployed?.gate).toMatchObject({ decision: "pass", runId: expect.stringMatching(/^sr-/) });
      const gateRun = await runner.getRun("mcp-server:shop", first.deployed!.gate!.runId!);
      expect(gateRun).toMatchObject({ trigger: "deploy", target: "1.0.0", gate: { decision: "pass" } });
      // publish's check is the suite too (on the draft, HTTP mocked): nothing reached the network
      expect(first.tests).toEqual({ passed: 1, failed: 0, skipped: 0, runId: expect.stringMatching(/^sr-/) });
      expect((await runner.listRuns("mcp-server:shop")).map((r) => r.trigger).sort()).toEqual(["deploy", "publish"]);
      expect(realFetches).toEqual([]);

      // a draft whose test fails: published, not deployed
      service.updateDraft("shop", { ...spec, tools: spec.tools.map((t) => (t.name === "get_item" ? { ...t, http: { ...t.http!, response: { pick: "data", fields: ["id"] } } } : t)) }, "tester");
      const second = await service.publish("shop", { deploy: true }, "tester");
      expect(second.deployed).toBeUndefined();
      expect(second.deployBlocked?.reason).toContain("Blocked by the suite");
      expect(second.tests).toMatchObject({ passed: 0, failed: 1 });
      expect(service.store.production("shop")).toBe("1.0.0");
      await expect(service.deploy("shop", second.version, { actor: "member", override: { reason: "hotfix" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
      const forced = await service.deploy("shop", second.version, { actor: "admin", override: { reason: "hotfix" }, admin: true });
      expect(forced.gate).toEqual({ decision: "override", reason: "hotfix", by: "admin" });
      const back = await service.rollback("shop", { actor: "admin" });
      expect(back.gate).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("mission suites", () => {
  const tasks = [
    { title: "Research", description: "Find three facts", assignTo: "writer" },
    { title: "Write", description: "Write the post", assignTo: "writer", dependsOn: ["Research"] },
    { title: "Check", description: "Check the post", assignTo: "checker", dependsOn: ["Write"] },
  ];
  const missionDeps = (over: Partial<AgentSuiteDeps> = {}) => deps({
    targets: { mission: { exists: async (id) => id === "m1", document: async (id) => (id === "m1" ? { name: "Blog post", tasks, notes: ["1 checkpoint(s) not run in test mode"] } : undefined), defaultAgent: async () => "writer" } },
    ...over,
  });

  it("runs the tasks in dependency order, each agent with its own mocks; asserts outcomes, order, who did what", async () => {
    const seen: Array<{ ref: string; message: string }> = [];
    const base = pipeline();
    const runner = new AgentSuiteRunner(missionDeps({ turn: async (ref, messages, hooks) => { seen.push({ ref, message: messages[0]!.content }); return base(ref, messages, hooks); } }));
    await expect(runner.saveSuite("mission:m1", { name: "Bad", cases: [{ name: "x", input: { message: "x" } }] })).rejects.toThrow("kind: mission");
    await runner.saveSuite("mission:m1", { name: "Blog", cases: [{
      name: "happy path", input: { kind: "mission", message: "Topic: octopuses" },
      mocks: { agents: {
        writer: { model: { turns: [{ toolCalls: [{ name: "web_search", args: { q: "octopus" } }] }, { text: "3 facts" }, { toolCalls: [{ name: "artifact_create", args: { kind: "document", title: "Octopus post" } }] }, { text: "post written" }] }, tools: [{ tool: "web_search", response: "facts" }] },
        checker: { model: { turns: [{ text: "looks good" }] } },
      } },
      assertions: [
        { type: "task_order", tasks: ["Research", "Write", "Check"] },
        { type: "task_status", task: "Check", status: "done" },
        { type: "task_agent", task: "Check", agent: "checker" },
        { type: "tool_called", tool: "web_search", agent: "writer", times: 1 },
        { type: "tool_not_called", tool: "web_search", agent: "checker" },
        { type: "artifact_created", titleContains: "octopus" },
      ],
    }] });
    const run = await runner.run("mission:m1", "blog");
    const r = run.results[0];
    expect(r.status, JSON.stringify(r.assertions.filter((a) => !a.passed))).toBe("passed");
    expect(run.targetKind).toBe("mission");
    expect(r.trace.tasks!.map((t) => [t.title, t.agent, t.status])).toEqual([["Research", "writer", "done"], ["Write", "writer", "done"], ["Check", "checker", "done"]]);
    expect(seen.map((s) => s.ref)).toEqual(["writer", "writer", "checker"]);
    expect(seen[1].message).toContain("3 facts");
    expect(seen[0].message).toContain("Topic: octopuses");
    expect(r.trace.toolCalls.map((c) => [c.name, c.agent])).toEqual([["web_search", "writer"], ["artifact_create", "writer"]]);
    expect(r.trace.notes.join(" ")).toContain("checkpoint");
  });

  it("a failed task skips the ones that depend on it; with no checks every task must be done", async () => {
    const runner = new AgentSuiteRunner(missionDeps({ turn: async (ref, messages, hooks) => { if (ref === "writer" && messages[0]!.content.includes("Write the post")) throw new Error("model down"); return pipeline()(ref, messages, hooks); } }));
    await runner.saveSuite("mission:m1", { name: "Fail", cases: [{ name: "x", input: { kind: "mission" }, mocks: { agents: { writer: { model: { turns: [{ text: "ok" }, { text: "ok" }] } }, checker: { model: { turns: [{ text: "ok" }] } } } } }] });
    const run = await runner.run("mission:m1", "fail");
    const r = run.results[0];
    expect(r.trace.tasks!.map((t) => t.status)).toEqual(["done", "failed", "skipped"]);
    expect(r.status).toBe("failed");
    expect(r.assertions[0]).toMatchObject({ description: "every task done", passed: false });
    await expect(runner.listSuites("mission:nope").then(() => runner.saveSuite("mission:nope", { name: "x" }))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("CI reports", () => {
  const run = (over: Partial<SuiteRun> = {}): SuiteRun => ({
    id: "sr-1", agent: "shop", suiteId: "s", suiteName: "Quotes <&>", suiteRevision: 1, target: "draft", variant: { id: "v", agent: "shop", version: "draft" },
    trigger: "ci", status: "failed", startedAt: "2026-11-25T10:00:00.000Z", planned: ["a", "b", "c"], notes: [],
    stats: { total: 3, passed: 1, failed: 1, errored: 0, skipped: 1, passRate: 0.5, costUsd: 0.0123, durationMs: 2500, inputTokens: 0, outputTokens: 0, turns: 0, toolCalls: 0 },
    results: [
      { key: "a", caseId: "a", caseName: "Good", status: "passed", mode: "all", engine: "native", assertions: [], trace: {} as never, startedAt: "", durationMs: 1000, costUsd: 0, variantId: "v" },
      { key: "b", caseId: "b", caseName: "Bad", status: "failed", mode: "all", engine: "native", assertions: [{ assertion: { type: "no_tool_errors" }, description: "no tool call failed", passed: false, message: "rates: Error <boom>" }], trace: {} as never, startedAt: "", durationMs: 1500, costUsd: 0.0123, variantId: "v" },
      { key: "c", caseId: "c", caseName: "Skipped", status: "skipped", mode: "all", engine: "native", assertions: [], trace: {} as never, startedAt: "", durationMs: 0, costUsd: 0, variantId: "v" },
    ],
    ...over,
  } as SuiteRun);

  it("JUnit XML with failures and skipped cases, escaped", () => {
    const xml = suiteRunsJunit([run()]);
    expect(xml).toContain('<testsuites name="Polpo suites" tests="3" failures="1" errors="0" skipped="1" time="2.500">');
    expect(xml).toContain('name="shop/Quotes &lt;&amp;&gt; @ draft"');
    expect(xml).toContain('<failure message="no tool call failed: rates: Error &lt;boom&gt;" type="assertion">');
    expect(xml).toContain("<skipped/>");
    expect(xml).toContain('name="Good [a]" time="1.000"/>');
  });

  it("exit codes, text and Markdown (regressions fail with failOnRegression)", () => {
    const passed = run({ status: "passed", baseline: { regressions: 1, improvements: 0, runId: "sr-0", cases: [] } as never });
    expect(suiteReportExitCode([run()])).toBe(1);
    expect(suiteReportExitCode([passed])).toBe(0);
    expect(suiteReportExitCode([passed], { failOnRegression: true })).toBe(1);
    expect(suiteReportExitCode([])).toBe(1);
    expect(suiteRunsText([run()])).toContain("FAILED");
    const md = suiteRunsMarkdown([run(), passed], { failOnRegression: true, links: (r) => `https://polpo.test/runs/${r.id}` });
    expect(md).toContain("## ❌ Polpo suites");
    expect(md).toContain("[shop · Quotes <&>](https://polpo.test/runs/sr-1)");
    expect(md).toContain("**Quotes <&> › Bad**");
    expect(md).toContain("1 regression(s) versus sr-0");
  });
});
