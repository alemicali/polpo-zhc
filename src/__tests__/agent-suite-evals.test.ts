/**
 * Agent suite evals (packages/core/src/agent-suite-evals.ts): each scorer passing and failing,
 * the LLM judge and custom scorers with mocks (no model, no sandbox), aggregates, repetitions,
 * baseline deltas, trends, the review prompt, and the runner (repetitions, baselines, reviews)
 * with an in-memory store and a fake chat turn.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  InMemoryAgentSuiteStore, caseOverallScore, compareSuiteRuns, evaluateScorer, extractNumber, judgePrompt, parseAgentSuite, parseJudgeResponse,
  pickSuiteBaseline, planSuiteCases, readCustomScore, readPath, scoreSuiteCase, suiteRunAggregates, suiteRunReviewPrompt, suiteTrend, textSimilarity,
  type AgentConfig, type SuiteCaseResult, type SuiteRun, type SuiteScorer, type SuiteTrace,
} from "@polpo-ai/core";
import { AgentSuiteRunner, type AgentSuiteDeps } from "../server/agent-suites.js";
import { customScorerModule } from "../server/agent-suite-scorers.js";

function trace(over: Partial<SuiteTrace> = {}): SuiteTrace {
  return {
    input: [{ role: "user", content: "How much is shipping to Italy?" }],
    turns: [{ index: 0, text: "", toolCalls: [], mocked: true, durationMs: 1 }],
    toolCalls: [],
    text: "Standard shipping to Italy costs 4,99 EUR.",
    approvals: [],
    usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.002 },
    durationMs: 1200,
    notes: [],
    ...over,
  };
}
const call = (name: string, args: Record<string, unknown>, result = "OK", isError = false) => ({ id: `c-${name}-${Math.random()}`, turn: 0, name, args, result, isError, mocked: "mock" as const, durationMs: 1 });

const score = (s: SuiteScorer, t: SuiteTrace = trace(), deps = {}) => evaluateScorer(s, { trace: t }, deps);

describe("deterministic scorers: pass and fail", () => {
  it("exact: trimmed, case-insensitive by default; a tool argument by path; objects deeply", async () => {
    expect((await score({ type: "exact", expected: " standard shipping to italy costs 4,99 eur. " })).passed).toBe(true);
    const cs = await score({ type: "exact", expected: "standard shipping to italy costs 4,99 eur.", caseSensitive: true });
    expect(cs.passed).toBe(false);
    expect(cs.reason).toContain("expected");
    const t = trace({ toolCalls: [call("mcp__printful__rates", { recipient: { country_code: "IT" }, items: [{ variant_id: 4012 }] })] });
    expect((await score({ type: "exact", expected: "IT", from: "tool_args", tool: "mcp__printful__*", path: "recipient.country_code" }, t)).passed).toBe(true);
    expect((await score({ type: "exact", expected: 4012, from: "tool_args", tool: "mcp__printful__rates", path: "$.items[0].variant_id" }, t)).score).toBe(1);
    const missing = await score({ type: "exact", expected: "IT", from: "tool_args", tool: "mcp__other__x" }, t);
    expect(missing).toMatchObject({ passed: false, score: 0 });
    expect(missing.reason).toContain("not found");
  });

  it("numeric: first number in the text (decimal comma), tolerance absolute or relative, partial credit when outside", async () => {
    expect(extractNumber("costs 1.234,56 EUR")).toBe(1234.56);
    expect(extractNumber("total: 12,000")).toBe(12000);
    const ok = await score({ type: "numeric", expected: 4.99, tolerance: 0.01 });
    expect(ok).toMatchObject({ passed: true, score: 1, actual: 4.99 });
    const off = await score({ type: "numeric", expected: "5.49" });
    expect(off.passed).toBe(false);
    expect(off.score).toBeGreaterThan(0.9);
    expect(off.score).toBeLessThan(1);
    expect((await score({ type: "numeric", expected: 5, tolerance: 0.001, relative: true })).passed).toBe(false);
    expect((await score({ type: "numeric", expected: 5, tolerance: 0.01, relative: true })).passed).toBe(true);
    expect((await score({ type: "numeric", expected: 4.99, extract: "costs ([\\d,]+)" })).passed).toBe(true);
    expect((await score({ type: "numeric", expected: 1 }, trace({ text: "no numbers" }))).reason).toContain("no number");
  });

  it("contains_all gives partial credit, contains_any is all or nothing; regex", async () => {
    const all = await score({ type: "contains_all", values: ["italy", "4,99", "express"] });
    expect(all.score).toBeCloseTo(2 / 3, 3);
    expect(all.passed).toBe(false);
    expect(all.reason).toContain('missing "express"');
    expect((await score({ type: "contains_all", values: ["Italy", "EUR"] })).passed).toBe(true);
    expect((await score({ type: "contains_any", values: ["express", "standard"] })).passed).toBe(true);
    expect((await score({ type: "contains_any", values: ["express", "overnight"] })).score).toBe(0);
    expect((await score({ type: "regex", pattern: "\\d+,\\d{2} EUR" })).passed).toBe(true);
    expect((await score({ type: "regex", pattern: "^Express" })).passed).toBe(false);
  });

  it("similarity: normalized levenshtein (default threshold 0.8) and token dice", async () => {
    expect(textSimilarity("Hello, World!", "hello world")).toBe(1);
    const close = await score({ type: "similarity", expected: "Standard shipping to Italy costs 4.99 EUR" });
    expect(close.passed).toBe(true);
    expect(close.threshold).toBe(0.8);
    const far = await score({ type: "similarity", expected: "We do not ship there" });
    expect(far.passed).toBe(false);
    const tokens = await score({ type: "similarity", expected: "EUR 4,99 costs shipping Italy to standard", method: "tokens" });
    expect(tokens.score).toBe(1);
  });

  it("json_schema on the reply's JSON (a ```json block), with the problems when invalid", async () => {
    const t = trace({ text: 'Here it is:\n```json\n{"rate": 4.99, "currency": "EUR"}\n```' });
    const schema = { type: "object", required: ["rate", "currency"], properties: { rate: { type: "number" }, currency: { enum: ["EUR", "USD"] } } };
    expect((await score({ type: "json_schema", schema }, t)).passed).toBe(true);
    const bad = await score({ type: "json_schema", schema: { ...schema, required: ["rate", "carrier"] } }, t);
    expect(bad.passed).toBe(false);
    expect(bad.reason).toContain("carrier: required");
    expect((await score({ type: "json_schema", schema }, trace())).reason).toContain("not found");
  });

  it("tool_trajectory: in order (extra calls allowed), exact, any order — with partial credit", async () => {
    const t = trace({ toolCalls: [call("search", {}), call("mcp__printful__rates", {}), call("log", {}), call("register_outcome", {})] });
    expect((await score({ type: "tool_trajectory", expected: ["search", "mcp__printful__*", "register_outcome"] }, t)).score).toBe(1);
    const exact = await score({ type: "tool_trajectory", expected: ["search", "mcp__printful__*", "register_outcome"], order: "exact" }, t);
    expect(exact.score).toBe(0.75);
    expect(exact.passed).toBe(false);
    const wrongOrder = await score({ type: "tool_trajectory", expected: ["register_outcome", "search"] }, t);
    expect(wrongOrder.score).toBe(0.5);
    expect((await score({ type: "tool_trajectory", expected: ["register_outcome", "search"], order: "any" }, t)).score).toBe(1);
    expect((await score({ type: "tool_trajectory", expected: ["email_send"], order: "any" }, t)).score).toBe(0);
  });

  it("cost and latency: 1 within the target, then target / actual", async () => {
    expect((await score({ type: "cost", maxUsd: 0.01 })).passed).toBe(true);
    const over = await score({ type: "cost", maxUsd: 0.001 });
    expect(over).toMatchObject({ passed: false, score: 0.5 });
    expect((await score({ type: "latency", maxMs: 2000 })).passed).toBe(true);
    const slow = await score({ type: "latency", maxMs: 600, threshold: 0.5 });
    expect(slow).toMatchObject({ score: 0.5, passed: true });
  });
});

describe("the LLM judge (G-Eval) with a mocked model", () => {
  const judgeScorer: SuiteScorer = {
    type: "llm_judge", rubric: "A correct, polite shipping quote", expected: "4.99 EUR",
    criteria: [{ name: "correctness", description: "The price is right", weight: 3 }, { name: "tone", description: "Polite", weight: 1 }],
  };

  it("the prompt has the rubric, weighted criteria, the reply, the tools and the reference answer", () => {
    const p = judgePrompt(judgeScorer as Extract<SuiteScorer, { type: "llm_judge" }>, { trace: trace({ toolCalls: [call("mcp__printful__rates", { country: "IT" }, '{"rate":"4.99"}')] }) });
    expect(p).toContain("A correct, polite shipping quote");
    expect(p).toContain("1. correctness (weight 3): The price is right");
    expect(p).toContain("costs 4,99 EUR");
    expect(p).toContain('mcp__printful__rates({"country":"IT"})');
    expect(p).toContain("## Reference answer\n4.99 EUR");
    expect(p).toContain('"criteria"');
  });

  it("scores the weighted criteria (1–5 → 0..1), keeps the reasoning, the model and the cost; passes at 0.6 by default", async () => {
    const judge = vi.fn(async () => ({
      text: '```json\n{"criteria":[{"name":"correctness","reasoning":"4,99 EUR is right","score":5},{"name":"tone","reasoning":"curt","score":1}],"summary":"Right price, curt."}\n```',
      model: "anthropic:judge", costUsd: 0.001,
    }));
    const r = await score(judgeScorer, trace(), { judge, judgeModel: "anthropic:suite-judge" });
    expect(judge).toHaveBeenCalledWith(expect.objectContaining({ model: "anthropic:suite-judge" }));
    expect(r.score).toBe(0.75);
    expect(r.passed).toBe(true);
    expect(r.reason).toBe("Right price, curt.");
    expect(r.judge).toMatchObject({ model: "anthropic:judge", costUsd: 0.001, criteria: [{ name: "correctness", score: 5, weight: 3, reasoning: "4,99 EUR is right" }, { name: "tone", score: 1 }] });
    // the scorer's own model wins over the suite's
    await score({ ...judgeScorer, model: "openai:own" } as SuiteScorer, trace(), { judge, judgeModel: "anthropic:suite-judge" });
    expect(judge).toHaveBeenLastCalledWith(expect.objectContaining({ model: "openai:own" }));
  });

  it("a low score fails; an unreadable answer or no judge is an error (the case errors)", async () => {
    const low = await score(judgeScorer, trace(), { judge: async () => ({ text: '{"criteria":[{"name":"correctness","score":2,"reasoning":"wrong"},{"name":"tone","score":3,"reasoning":"ok"}]}' }) });
    expect(low.passed).toBe(false);
    expect(low.score).toBeCloseTo((3 * 0.25 + 0.5) / 4, 4);
    const garbled = await score(judgeScorer, trace(), { judge: async () => ({ text: "I think it is fine" }) });
    expect(garbled.error).toContain("did not answer with JSON");
    const partial = await score(judgeScorer, trace(), { judge: async () => ({ text: '{"criteria":[{"name":"tone","score":4}]}' }) });
    expect(partial.error).toContain('did not score "correctness"');
    expect((await score(judgeScorer)).error).toContain("No LLM judge");
    // a rubric without criteria: one "overall" criterion; a bare { score } is accepted
    const overall = parseJudgeResponse('{"score": 4, "reasoning": "good"}', { type: "llm_judge", rubric: "good" });
    expect(overall).toMatchObject({ score: 0.75, criteria: [{ name: "overall", score: 4, reasoning: "good" }] });
  });
});

describe("custom scorers (sandbox mocked)", () => {
  it("get the reply, tool calls, row and expected; return a number, a boolean or { score, reason }", async () => {
    const custom = vi.fn(async ({ input }: { input: Record<string, unknown> }) => ({ score: String(input.reply).includes(String(input.expected)) ? 1 : 0, reason: "checked" }));
    const r = await evaluateScorer({ type: "custom", code: "return 1", expected: "4,99" }, { trace: trace(), row: { country: "IT" } }, { custom });
    expect(r).toMatchObject({ passed: true, score: 1, reason: "checked" });
    expect(custom.mock.calls[0][0].input).toMatchObject({ reply: expect.stringContaining("4,99"), expected: "4,99", row: { country: "IT" }, toolCalls: [] });
    expect(readCustomScore(true)).toEqual({ score: 1 });
    expect(readCustomScore({ result: 0.4 })).toEqual({ score: 0.4 });
    expect(readCustomScore(7)).toEqual({ score: 1 });
    expect(() => readCustomScore("yes")).toThrow(/must return/);
    const failing = await evaluateScorer({ type: "custom", code: "x" }, { trace: trace() }, { custom: async () => { throw new Error("ReferenceError: x is not defined"); } });
    expect(failing.error).toContain("ReferenceError");
    expect((await evaluateScorer({ type: "custom", code: "1" }, { trace: trace() })).error).toContain("sandboxed code worker");
  });

  it("the module wraps the code as a function body (an expression is returned)", () => {
    expect(customScorerModule("return reply.length > 3")).toContain("return reply.length > 3");
    expect(customScorerModule("reply.includes(expected);")).toContain("return (reply.includes(expected));");
    expect(customScorerModule("x")).toContain("export async function handler(input)");
  });
});

describe("validation, defaults and dataset expected values", () => {
  it("parses every scorer type, makes ids, refuses bad ones", () => {
    const s = parseAgentSuite({
      name: "e", scorers: [{ type: "cost", maxUsd: 0.1 }],
      evals: { judgeModel: "anthropic:x", repetitions: 3, regressionTolerance: 0.1, baseline: "production" },
      cases: [{ name: "c", input: { message: "m" }, scorers: [
        { type: "exact", expected: "a" }, { type: "exact", expected: "b" }, { type: "numeric", expected: "{{row.x}}", tolerance: 0.5 },
        { type: "contains_all", values: "one" }, { type: "llm_judge", rubric: "r", criteria: [{ name: "a", description: "d" }] },
        { type: "tool_trajectory", expected: ["a", "b"] }, { type: "json_schema", schema: { type: "object" } }, { type: "custom", code: "return 1" },
      ] }],
    }, "a");
    expect(s.cases[0].scorers!.map((x) => x.id)).toEqual(["exact", "exact-2", "numeric", "contains-all", "llm-judge", "tool-trajectory", "json-schema", "custom"]);
    expect(s.cases[0].scorers![3]).toMatchObject({ values: ["one"] });
    expect(s.evals).toEqual({ judgeModel: "anthropic:x", repetitions: 3, regressionTolerance: 0.1, baseline: "production" });
    const bad = (scorers: unknown[]) => () => parseAgentSuite({ name: "x", cases: [{ name: "c", input: { message: "m" }, scorers }] }, "a");
    expect(bad([{ type: "nope" }])).toThrow(/scorers\[0\]\.type must be one of/);
    expect(bad([{ type: "exact" }])).toThrow(/expected is required/);
    expect(bad([{ type: "regex", pattern: "(" }])).toThrow(/not a valid regular expression/);
    expect(bad([{ type: "similarity", expected: "a", threshold: 2 }])).toThrow(/threshold must be at most 1/);
    expect(bad([{ type: "exact", expected: "a", from: "tool_args" }])).toThrow(/tool is required/);
    expect(bad([{ type: "exact", expected: 1, id: "a" }, { type: "exact", expected: 2, id: "a" }])).toThrow(/used by another scorer/);
    expect(() => parseAgentSuite({ name: "x", evals: { repetitions: 11 } }, "a")).toThrow(/repetitions must be at most 10/);
  });

  it("plans: suite default scorers merged (same id replaced), {{row.expected}} filled, repetitions as ~attempt keys", () => {
    const suite = parseAgentSuite({
      name: "e", scorers: [{ id: "price", type: "numeric", expected: 0 }, { type: "cost", maxUsd: 1 }],
      datasets: [{ name: "d", rows: [{ q: "IT", expected: 4.99 }, { q: "DE", expected: 5.49 }] }],
      cases: [{ name: "c", dataset: "d", input: { message: "ship to {{row.q}}" }, scorers: [{ id: "price", type: "numeric", expected: "{{row.expected}}" }] }],
    }, "a");
    const planned = planSuiteCases(suite);
    expect(planned.map((p) => p.key)).toEqual(["c#1", "c#2"]);
    expect(planned[1].case.scorers).toEqual([{ id: "cost", type: "cost", maxUsd: 1 }, { id: "price", type: "numeric", expected: 5.49 }]);
    const reps = planSuiteCases(suite, { repetitions: 3 });
    expect(reps.map((p) => p.key)).toEqual(["c#1~1", "c#1~2", "c#1~3", "c#2~1", "c#2~2", "c#2~3"]);
    expect(reps[4]).toMatchObject({ baseKey: "c#2", attempt: 2 });
  });

  it("the evals example of docs/agent-suites.md is a valid suite (with a rates dataset)", () => {
    const doc = readFileSync(join(process.cwd(), "docs", "agent-suites.md"), "utf-8");
    const section = doc.slice(doc.indexOf("## Evals: scorers, baselines, trends"));
    const raw = parseYaml(/```yaml\n([\s\S]*?)```/.exec(section)![1]!) as Record<string, unknown>;
    const s = parseAgentSuite({ name: "Evals", ...raw, datasets: [{ id: "rates", name: "Rates", rows: [{ country: "IT", expected: 4.99 }] }] }, "shop");
    expect(s.evals).toEqual({ judgeModel: "anthropic:claude-sonnet-5-5", repetitions: 3, regressionTolerance: 0.05, baseline: "previous" });
    const [p] = planSuiteCases(s, { repetitions: 1 });
    expect(p.case.scorers!.map((x) => x.id)).toEqual(["cost", "price", "country", "judge"]);
    expect(p.case.scorers![1]).toMatchObject({ expected: 4.99 });
    expect(p.case.scorers![2]).toMatchObject({ expected: "IT", path: "recipient.country_code" });
  });

  it("readPath handles $., dots, [n] and JSON text on the way", () => {
    expect(readPath({ a: { b: [{ c: 1 }] } }, "$.a.b[0].c")).toBe(1);
    expect(readPath({ a: '{"b": 2}' }, "a.b")).toBe(2);
    expect(readPath({ a: 1 }, "a.b")).toBeUndefined();
  });
});

// ── Aggregates, repetitions, baselines, trends ──

type R = Pick<SuiteCaseResult, "key" | "caseId" | "caseName" | "status" | "costUsd" | "durationMs"> & Partial<SuiteCaseResult>;
const res = (key: string, status: SuiteCaseResult["status"], scores: Record<string, number> = {}, extra: Partial<R> = {}): R => {
  const sc = Object.entries(scores).map(([id, v]) => ({ scorer: { type: "exact", expected: 1 } as SuiteScorer, id, description: id, score: v, threshold: 0.5, weight: id === "judge" ? 3 : 1, passed: v >= 0.5 }));
  return { key, caseId: key.split(/[#~]/)[0], caseName: key, status, costUsd: 0.01, durationMs: 1000, scores: sc, score: caseOverallScore(sc), ...extra };
};
const runOf = (id: string, results: R[], over: Partial<SuiteRun> = {}): SuiteRun => ({
  id, agent: "a", suiteId: "s", suiteName: "S", suiteRevision: 1, target: "production", variant: { id: "v", agent: "a", version: "production" },
  trigger: "manual", status: results.some((r) => r.status === "failed") ? "failed" : "passed", startedAt: `2026-11-2${id.slice(-1)}T10:00:00.000Z`, planned: results.map((r) => r.key),
  results: results as SuiteCaseResult[], stats: { total: results.length, passed: results.filter((r) => r.status === "passed").length, failed: 0, errored: 0, skipped: 0, passRate: results.filter((r) => r.status === "passed").length / results.length, costUsd: 0.02, durationMs: 2000, inputTokens: 0, outputTokens: 0, turns: 0, toolCalls: 0 },
  notes: [], ...over,
});

describe("aggregates and repetitions", () => {
  it("per scorer mean / median / p10 / pass rate; the case score weighted; the run score the mean of cases", () => {
    const a = suiteRunAggregates([res("a", "passed", { exact: 1, judge: 0.5 }), res("b", "failed", { exact: 0, judge: 0.25 }), res("c", "skipped", { exact: 1 })]);
    expect(a.scorers.find((x) => x.id === "exact")).toMatchObject({ count: 2, mean: 0.5, median: 0.5, p10: 0.1, min: 0, max: 1, passRate: 0.5 });
    expect(a.cases.find((c) => c.key === "a")!.score).toBe(0.625);
    expect(a.score).toBeCloseTo((0.625 + 0.1875) / 2, 4);
    expect(a.passRate).toBe(0.5);
    expect(a.costUsd).toBe(0.02);
    expect(a.latencyP50Ms).toBe(1000);
  });

  it("attempts of a case: mean and stddev; mixed results or a wide spread are flaky", () => {
    const a = suiteRunAggregates([
      res("a~1", "passed", { exact: 1 }, { attempt: 1 }), res("a~2", "failed", { exact: 0 }, { attempt: 2 }), res("a~3", "passed", { exact: 1 }, { attempt: 3 }),
      res("b~1", "passed", { exact: 0.9 }, { attempt: 1 }), res("b~2", "passed", { exact: 0.9 }, { attempt: 2 }), res("b~3", "passed", { exact: 0.92 }, { attempt: 3 }),
    ]);
    expect(a.repetitions).toBe(3);
    const ca = a.cases.find((c) => c.key === "a")!;
    expect(ca).toMatchObject({ attempts: 3, passed: 2, flaky: true, status: "failed" });
    expect(ca.passRate).toBeCloseTo(0.6667, 3);
    expect(ca.score).toBeCloseTo(0.6667, 3);
    expect(ca.scoreStddev).toBeCloseTo(0.4714, 3);
    expect(a.cases.find((c) => c.key === "b")).toMatchObject({ flaky: false, status: "passed" });
    expect(a.flaky).toEqual(["a"]);
    // a stricter flaky threshold catches a small spread
    expect(suiteRunAggregates([res("b~1", "passed", { exact: 0.5 }, { attempt: 1 }), res("b~2", "passed", { exact: 0.9 }, { attempt: 2 })], { flakyStddev: 0.1 }).flaky).toEqual(["b"]);
  });
});

describe("baselines: deltas per case and per scorer", () => {
  const base = runOf("r1", [res("a", "passed", { exact: 1, judge: 0.8 }), res("b", "failed", { exact: 0, judge: 0.3 }), res("c", "passed", { exact: 1 }), res("gone", "passed")]);
  const now = runOf("r2", [res("a", "failed", { exact: 0, judge: 0.8 }), res("b", "passed", { exact: 1, judge: 0.6 }), res("c", "passed", { exact: 1 }), res("new", "passed")]);

  it("pass → fail and score drops are regressions, fail → pass and score rises improvements; unchanged within tolerance; new / removed cases", () => {
    const cmp = compareSuiteRuns(now, base, { source: "marked" });
    expect(cmp).toMatchObject({ runId: "r1", source: "marked", tolerance: 0.05, regressions: 1, improvements: 1, passRateDelta: 0 });
    const byKey = Object.fromEntries(cmp.cases.map((c) => [c.key, c]));
    expect(byKey.a).toMatchObject({ change: "regressed", baselineStatus: "passed", status: "failed" });
    expect(byKey.a.reasons).toContain("was passed, now failed");
    expect(byKey.a.scorers.find((x) => x.id === "exact")).toMatchObject({ baseline: 1, current: 0, delta: -1, change: "regressed" });
    expect(byKey.b).toMatchObject({ change: "improved" });
    expect(byKey.b.reasons[0]).toBe("was failed, now passes");
    expect(byKey.c.change).toBe("unchanged");
    expect(byKey.new.change).toBe("new");
    expect(byKey.gone.change).toBe("removed");
    expect(cmp.scorers.find((x) => x.id === "judge")).toMatchObject({ baseline: 0.55, current: 0.7, change: "improved" });
  });

  it("the tolerance absorbs small score changes", () => {
    const b = runOf("r1", [res("a", "passed", { judge: 0.8 })]);
    const n = runOf("r2", [res("a", "passed", { judge: 0.77 })]);
    expect(compareSuiteRuns(n, b).cases[0].change).toBe("unchanged");
    expect(compareSuiteRuns(n, b, { tolerance: 0.01 }).cases[0].change).toBe("regressed");
  });

  it("picks the baseline: the marked run, else the previous finished run (or production's), never itself or an unfinished one", () => {
    const runs = [
      { id: "r4", status: "running", target: "draft", startedAt: "2026-11-24" },
      { id: "r3", status: "cancelled", target: "draft", startedAt: "2026-11-23" },
      { id: "r2", status: "failed", target: "draft", startedAt: "2026-11-22" },
      { id: "r1", status: "passed", target: "production", startedAt: "2026-11-21" },
    ] as SuiteRun[];
    const cur = { id: "r4", startedAt: "2026-11-24" };
    expect(pickSuiteBaseline(runs, cur)).toMatchObject({ run: { id: "r2" }, source: "previous" });
    expect(pickSuiteBaseline(runs, cur, "production")).toMatchObject({ run: { id: "r1" }, source: "production" });
    expect(pickSuiteBaseline(runs, cur, "none")).toBeUndefined();
    expect(pickSuiteBaseline([...runs.slice(0, 3), { ...runs[3], isBaseline: true }], cur, "none")).toMatchObject({ run: { id: "r1" }, source: "marked" });
  });
});

describe("trends and the review prompt", () => {
  it("finished runs oldest first, with means per scorer; by version", () => {
    const r1 = runOf("r1", [res("a", "passed", { exact: 1 })], { version: "1.0.0" });
    const r2 = runOf("r2", [res("a", "failed", { exact: 0 })], { target: "draft", isBaseline: true });
    const r3 = runOf("r3", [res("a", "passed", { exact: 1 })], { version: "1.0.0" });
    const running = runOf("r4", [], { status: "running" });
    const t = suiteTrend("s", [running, r3, r2, r1]);
    expect(t.points.map((p) => p.runId)).toEqual(["r1", "r2", "r3"]);
    expect(t.points[1]).toMatchObject({ target: "draft", score: 0, scorers: { exact: 0 }, isBaseline: true });
    expect(t.byVersion).toEqual([
      expect.objectContaining({ version: "1.0.0", runs: 2, score: 1 }),
      expect.objectContaining({ version: "draft", runs: 1, score: 0 }),
    ]);
    expect(t.scorers).toEqual([{ id: "exact", label: "exact" }]);
  });

  it("the review prompt has the failures with their checks, the regressions and the agent's instructions", () => {
    const failed = { ...res("a", "failed", { exact: 0 }), mode: "all", assertions: [{ assertion: { type: "text_contains", value: "x" }, description: "reply contains \"x\"", passed: false, message: "missing x" }], trace: trace() } as unknown as R;
    const run = runOf("r2", [failed]);
    run.aggregates = suiteRunAggregates(run.results);
    run.baseline = compareSuiteRuns(run, runOf("r1", [res("a", "passed", { exact: 1 })]), { source: "previous" });
    const p = suiteRunReviewPrompt(run, { name: "shop", instructions: "Quote shipping politely.", tools: ["mcp__printful__*"] }, { language: "Italian" });
    expect(p).toContain('reply contains "x": missing x');
    expect(p).toContain("scorer ✗ exact");
    expect(p).toContain("regressed: a [a]");
    expect(p).toContain("Quote shipping politely.");
    expect(p).toContain("Tools: mcp__printful__*");
    expect(p).toContain("Answer in Italian");
  });
});

// ── The runner: scorers, repetitions, baselines and the review (fake chat turn, in-memory store) ──

function runnerWith(reply: (msg: string, attempt: number) => string, extra: Partial<AgentSuiteDeps> = {}) {
  const store = new InMemoryAgentSuiteStore();
  const agent: AgentConfig = { name: "shop", role: "Shop", systemPrompt: "Quote shipping." } as AgentConfig;
  let n = 0;
  const deps: AgentSuiteDeps = {
    store,
    agents: async () => [agent],
    resolveAgent: async () => agent,
    turn: async (_ref, messages) => {
      n++;
      const msg = messages[messages.length - 1].content;
      return { text: reply(msg, n), toolCalls: [] };
    },
    ...extra,
  };
  return { runner: new AgentSuiteRunner(deps), store };
}

describe("the runner with evals", () => {
  const suite = {
    name: "Quotes", defaultMode: "all" as const,
    datasets: [{ name: "rates", rows: [{ country: "IT", expected: 4.99 }, { country: "DE", expected: 5.49 }] }],
    cases: [{
      name: "Quote", dataset: "rates", input: { kind: "chat" as const, message: "Shipping to {{row.country}}?" },
      mocks: { model: { turns: [{ text: "scripted" }] } }, assertions: [],
      scorers: [{ id: "price", type: "numeric", expected: "{{row.expected}}", tolerance: 0.01 }, { id: "judge", type: "llm_judge", rubric: "polite" }],
    }],
  };
  const judge = async () => ({ text: '{"score": 5, "reasoning": "polite"}', model: "m" });

  it("scores each row against its expected value; a failing scorer fails the case; aggregates and a baseline comparison are stored", async () => {
    const { runner } = runnerWith((m) => (m.includes("IT") ? "It costs 4.99 EUR" : "It costs 9.99 EUR"), { judge });
    await runner.saveSuite("shop", suite);
    const run = await runner.run("shop", "quotes");
    expect(run.results.map((r) => [r.key, r.status, r.score])).toEqual([["quote#1", "passed", 1], ["quote#2", "failed", expect.any(Number)]]);
    expect(run.results[1].scores!.find((x) => x.id === "price")).toMatchObject({ passed: false, expected: 5.49, actual: 9.99 });
    expect(run.aggregates!.scorers.map((x) => x.id)).toEqual(["price", "judge"]);
    expect(run.aggregates!.scorers[1]).toMatchObject({ mean: 1, passRate: 1 });
    expect(run.baseline).toBeUndefined();
    expect(run.notes.join(" ")).not.toContain("phase 2");

    // a second run compares with the previous one
    const again = await runner.run("shop", "quotes");
    expect(again.baseline).toMatchObject({ runId: run.id, source: "previous", regressions: 0, improvements: 0 });
  });

  it("no judge on the server: the judge scorer errors the case, with a note", async () => {
    const { runner } = runnerWith(() => "It costs 4.99 EUR");
    await runner.saveSuite("shop", suite);
    const run = await runner.run("shop", "quotes");
    expect(run.status).toBe("errored");
    expect(run.results[0].error).toContain("Scorer judge: No LLM judge");
    expect(run.notes).toContain("No LLM judge on this server: llm_judge scorers error.");
  });

  it("repetitions: every case N times, flaky cases flagged; bad repetitions refused", async () => {
    const { runner } = runnerWith((m, n) => (m.includes("IT") && n % 2 === 0 ? "It costs 7 EUR" : m.includes("IT") ? "4.99" : "5.49"), { judge });
    await runner.saveSuite("shop", suite);
    const run = await runner.run("shop", "quotes", { repetitions: 2 });
    expect(run.repetitions).toBe(2);
    expect(run.planned).toEqual(["quote#1~1", "quote#1~2", "quote#2~1", "quote#2~2"]);
    expect(run.results.map((r) => r.attempt)).toEqual([1, 2, 1, 2]);
    expect(run.aggregates!.flaky).toEqual(["quote#1"]);
    expect(run.aggregates!.cases.find((c) => c.key === "quote#2")).toMatchObject({ attempts: 2, passRate: 1, flaky: false });
    await expect(runner.startRun("shop", "quotes", { repetitions: 11 })).rejects.toThrow(/repetitions must be/);
  });

  it("a marked baseline: deltas against it, kept, cleared; trend and the stored AI review", async () => {
    let good = true;
    const review = vi.fn(async (prompt: string) => ({ text: `## Summary\n${prompt.includes("regressed") ? "It regressed." : "Fine."}`, model: "anthropic:polpo", costUsd: 0.01 }));
    const { runner, store } = runnerWith((m) => (good || m.includes("DE") ? (m.includes("IT") ? "4.99" : "5.49") : "9.99"), { judge, review });
    await runner.saveSuite("shop", suite);
    const first = await runner.run("shop", "quotes");
    await expect(runner.setBaseline("shop", "quotes", "sr-nope")).rejects.toThrow(/no suite run/);
    await runner.setBaseline("shop", "quotes", first.id);
    expect((await runner.getBaseline("shop", "quotes"))!.id).toBe(first.id);
    good = false;
    const second = await runner.run("shop", "quotes");
    const third = await runner.run("shop", "quotes");
    // compared with the marked run, not the previous one
    expect(third.baseline).toMatchObject({ runId: first.id, source: "marked", regressions: 1 });
    expect(third.baseline!.cases.find((c) => c.key === "quote#1")).toMatchObject({ change: "regressed", baselineStatus: "passed", status: "failed" });
    expect(third.baseline!.scorers.find((x) => x.id === "price")!.change).toBe("regressed");
    // on demand, against any run
    expect(await runner.compareRuns("shop", third.id, { baselineRunId: second.id })).toMatchObject({ runId: second.id, regressions: 0 });
    // marking another run moves the mark
    await runner.setBaseline("shop", "quotes", second.id);
    expect((await store.getRun("shop", first.id))!.isBaseline).toBeUndefined();
    await runner.setBaseline("shop", "quotes", undefined);
    expect(await runner.getBaseline("shop", "quotes")).toBeUndefined();

    const trend = await runner.trend("shop", "quotes");
    expect(trend.points.map((p) => p.runId)).toEqual([first.id, second.id, third.id]);
    expect(trend.points.map((p) => p.passRate)).toEqual([1, 0.5, 0.5]);

    const reviewed = await runner.reviewRun("shop", third.id, { actor: "ada", language: "Italian" });
    expect(reviewed.review).toMatchObject({ text: "## Summary\nIt regressed.", model: "anthropic:polpo", by: "ada", costUsd: 0.01 });
    expect(review.mock.calls[0][0]).toContain("Quote shipping.");
    expect(review.mock.calls[0][0]).toContain("Answer in Italian");
    expect((await store.getRun("shop", third.id))!.review!.text).toContain("It regressed.");
  });

  it("the store keeps a marked baseline when older runs are dropped", async () => {
    const store = new InMemoryAgentSuiteStore();
    const old = runOf("r0", [res("a", "passed")], { startedAt: "2026-01-01T00:00:00.000Z", isBaseline: true });
    await store.saveRun(old);
    for (let i = 0; i < 101; i++) await store.saveRun(runOf(`n${i}`, [res("a", "passed")], { id: `n${i}`, startedAt: `2026-11-01T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z` }));
    expect((await store.listRuns("a", { limit: 1000 })).some((r) => r.id === "r0")).toBe(true);
    expect(await store.getRun("a", "r0")).toBeDefined();
  });

  it("scoreSuiteCase runs every scorer in order", async () => {
    const out = await scoreSuiteCase([{ type: "regex", pattern: "EUR" }, { type: "cost", maxUsd: 1 }], { trace: trace() });
    expect(out.map((x) => [x.id, x.passed])).toEqual([["regex", true], ["cost-2", true]]);
  });
});
