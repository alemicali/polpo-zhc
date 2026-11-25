/**
 * Agent suites phase 5 (packages/core/src/agent-suite-bench.ts, src/server/agent-benchmarks.ts):
 * benchmark specs, per-variant stats, the leaderboard (weights, Pareto front, noise notes), the
 * case × variant matrix, the side-by-side comparison and its diffs; the orchestration (variants ×
 * repetitions within the runner's limits, cancel, the budget cap, the cost confirmation, the
 * estimate) and the Playground (mocks per pane, real tools, streaming events, save as a case,
 * promote a variant) with an in-memory store and a fake chat pipeline: no model, no tool runs.
 */
import { describe, expect, it } from "vitest";
import {
  InMemoryAgentSuiteStore, argChanges, benchmarkLeaderboard, benchmarkMatrix, benchmarkVariantStats, compareBenchmarkCase, heuristicCaseCostUsd,
  parseBenchmarkSpec, playgroundCase, promotionFields, summarizeBenchmarkEstimate, wordDiff,
  type AgentConfig, type BenchmarkSuiteRun, type BenchmarkVariantSpec, type SuiteCaseResult, type SuiteTrace,
} from "@polpo-ai/core";
import { AgentSuiteRunner, type AgentSuiteDeps } from "../server/agent-suites.js";
import { AgentBenchmarks } from "../server/agent-benchmarks.js";
import { InMemoryBenchmarkStore } from "../stores/file-benchmark-store.js";
import type { SuiteCaseHooks } from "../core/agent-suite-context.js";

const V = (id: string, agent = "shop", over: Partial<BenchmarkVariantSpec> = {}): BenchmarkVariantSpec => ({ id, agent, version: "production", ...over });

function result(key: string, status: "passed" | "failed" | "errored", over: Partial<SuiteCaseResult> = {}): BenchmarkSuiteRun["results"][number] {
  return { key, caseId: key.split("#")[0].split("~")[0], caseName: key, status, costUsd: 0.01, durationMs: 1000, trace: { usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.01 } }, ...over } as BenchmarkSuiteRun["results"][number];
}
function srun(id: string, variant: string, rep: number, results: BenchmarkSuiteRun["results"]): BenchmarkSuiteRun {
  return { id, agent: "shop", suiteId: "s", suiteName: "S", status: "passed", repetition: rep, variant: { id: variant }, results };
}

describe("benchmark specs", () => {
  it("validates suites, variants (unique ids from agent, version, label), repetitions, weights", () => {
    const spec = parseBenchmarkSpec({
      name: "Models", suites: [{ agent: "shop", suite: "quotes" }],
      variants: [{ agent: "shop" }, { agent: "shop", version: "draft", overrides: { model: "openai:gpt-x" } }, { agent: "shop" }, { agent: "helper", label: "Helper agent" }],
      repetitions: 3, weights: { quality: 1, cost: 0.5 },
    });
    expect(spec.variants.map((v) => v.id)).toEqual(["shop@production", "shop@draft+model", "shop@production-2", "helper-agent"]);
    expect(spec.weights).toEqual({ quality: 1, cost: 0.5, latency: 0 });
    expect(() => parseBenchmarkSpec({ name: "x", suites: [], variants: [{ agent: "a" }] })).toThrow(/suites/);
    expect(() => parseBenchmarkSpec({ name: "x", suites: [{ agent: "a", suite: "s" }], variants: Array.from({ length: 9 }, () => ({ agent: "a" })) })).toThrow(/at most 8/);
    expect(() => parseBenchmarkSpec({ name: "x", suites: [{ agent: "a", suite: "s" }], variants: [{ agent: "a" }], repetitions: 11 })).toThrow(/repetitions/);
    expect(() => parseBenchmarkSpec({ name: "x", suites: [{ agent: "a", suite: "s" }], variants: [{ agent: "a", overrides: { temperature: 1 } }] })).toThrow(/unknown field/);
    expect(() => parseBenchmarkSpec({ name: "x", suites: [{ agent: "a", suite: "s" }], variants: [{ agent: "a" }], weights: { quality: 0 } })).toThrow(/above 0/);
  });

  it("estimates: heuristic cost grows with turns and prompt; offline when nothing calls a model", () => {
    const price = { input: 3, output: 15 };
    expect(heuristicCaseCostUsd({ promptChars: 4000, turns: 3, price })).toBeGreaterThan(heuristicCaseCostUsd({ promptChars: 400, turns: 1, price }));
    const off = summarizeBenchmarkEstimate([{ suite: "s", owner: "shop", variantId: "a", cases: 3, realModelCases: 0, judgeCalls: 0, costUsd: 0, basis: "offline", realTools: false }], 2);
    expect(off).toMatchObject({ offline: true, runs: 2, cases: 6, costUsd: 0 });
    const real = summarizeBenchmarkEstimate([{ suite: "s", owner: "shop", variantId: "a", cases: 3, realModelCases: 3, judgeCalls: 0, costUsd: 0.3, basis: "heuristic", realTools: false }], 1);
    expect(real.offline).toBe(false);
    expect(real.maxCostUsd).toBeCloseTo(0.45, 6);
  });
});

describe("stats, leaderboard, Pareto, noise", () => {
  // three variants, three repetitions: "good" passes everything (slow, expensive), "cheap" is cheaper and fast but flaky, "bad" fails
  const runs: BenchmarkSuiteRun[] = [];
  for (let rep = 1; rep <= 3; rep++) {
    runs.push(srun(`g${rep}`, "good", rep, [result("a", "passed", { score: 0.9, costUsd: 0.05, durationMs: 4000 }), result("b", "passed", { score: 0.95, costUsd: 0.05, durationMs: 4000 })]));
    runs.push(srun(`c${rep}`, "cheap", rep, [result("a", "passed", { score: 0.88, costUsd: 0.01, durationMs: 1000 }), result("b", rep === 2 ? "failed" : "passed", { score: rep === 2 ? 0.5 : 0.9, costUsd: 0.01, durationMs: 1000 })]));
    runs.push(srun(`b${rep}`, "bad", rep, [result("a", "failed", { score: 0.2, costUsd: 0.06, durationMs: 5000 }), result("b", "failed", { score: 0.1, costUsd: 0.06, durationMs: 5000 })]));
  }
  const variants = [V("good"), V("cheap"), V("bad")];

  it("per variant: pass rate and score mean ± stddev over repetitions, cost, latency, tokens, flakiness", () => {
    const [good, cheap, bad] = benchmarkVariantStats(runs, variants);
    expect(good).toMatchObject({ repetitions: 3, cases: 2, passRate: { mean: 1, stddev: 0 }, flakiness: 0, complete: true });
    expect(good.score!.mean).toBeCloseTo(0.925, 3);
    expect(good.costUsd.mean).toBeCloseTo(0.1, 6);
    expect(good.latency).toMatchObject({ p50Ms: 4000, p95Ms: 4000 });
    expect(good.tokens).toMatchObject({ input: 600, output: 60, perCase: 110 });
    expect(cheap.passRate.mean).toBeCloseTo(5 / 6, 3);
    expect(cheap.passRate.stddev).toBeGreaterThan(0);
    expect(cheap.flakyCases).toEqual(["shop/s/b"]);
    expect(cheap.flakiness).toBe(0.5);
    expect(bad.passRate.mean).toBe(0);
  });

  it("ranks by weights; the Pareto front leaves out the dominated variant; quality-only weights", () => {
    const stats = benchmarkVariantStats(runs, variants);
    const quality = benchmarkLeaderboard(stats, { quality: 1, cost: 0, latency: 0 });
    expect(quality.entries.map((e) => e.variantId)).toEqual(["good", "cheap", "bad"]);
    expect(quality.qualityMetric).toBe("score");
    expect(quality.paretoFront.sort()).toEqual(["cheap", "good"]);
    expect(quality.entries.find((e) => e.variantId === "bad")!.dominatedBy.sort()).toEqual(["cheap", "good"]);
    expect(quality.notes.join(" ")).toContain("quality only");
    const thrifty = benchmarkLeaderboard(stats, { quality: 1, cost: 1, latency: 1 });
    expect(thrifty.entries[0].variantId).toBe("cheap");
    expect(thrifty.entries.map((e) => e.rank)).toEqual([1, 2, 3]);
  });

  it("says when two variants are within the noise; a single repetition is flagged", () => {
    const close = [srun("x1", "x", 1, [result("a", "passed", { score: 0.8 }), result("b", "passed", { score: 0.7 })]), srun("y1", "y", 1, [result("a", "passed", { score: 0.78 }), result("b", "passed", { score: 0.71 })])];
    const lb = benchmarkLeaderboard(benchmarkVariantStats(close, [V("x"), V("y")]));
    expect(lb.notes.join("\n")).toMatch(/One repetition per variant/);
    expect(lb.notes.join("\n")).toMatch(/"x" and "y".*within the noise/);
    // clearly apart over three repetitions: no noise note for good vs bad
    const far = benchmarkLeaderboard(benchmarkVariantStats(runs.filter((r) => r.variant.id !== "cheap"), [V("good"), V("bad")]));
    expect(far.notes.join("\n")).not.toMatch(/within the noise/);
  });

  it("the matrix: one row per case, a cell per variant (mixed when attempts disagree), spread rows", () => {
    const m = benchmarkMatrix(runs, variants);
    expect(m.rows.map((r) => r.key)).toEqual(["shop/s/a", "shop/s/b"]);
    const b = m.rows[1];
    expect(b.cells.good).toMatchObject({ attempts: 3, passed: 3, status: "passed" });
    expect(b.cells.cheap).toMatchObject({ attempts: 3, passed: 2, status: "mixed" });
    expect(b.cells.bad.status).toBe("failed");
    expect(b.cells.good.results).toHaveLength(3);
    expect(b.cells.good.results[0]).toMatchObject({ runId: "g1", owner: "shop", key: "b", repetition: 1 });
    expect(b.spread).toBe(true);
  });
});

describe("side by side", () => {
  const trace = (calls: Array<[string, Record<string, unknown>]>, text: string): SuiteTrace => ({
    input: [{ role: "user", content: "rates to IT?" }], turns: [], text, approvals: [], usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 }, durationMs: 10, notes: [],
    toolCalls: calls.map(([name, args], i) => ({ id: `c${i}`, turn: 0, name, args, result: "ok", isError: false, mocked: "mock" as const, durationMs: 1 })),
  });
  const res = (t: SuiteTrace) => ({ key: "a", caseId: "a", caseName: "A", status: "passed", mode: "all", engine: "native", assertions: [], trace: t, startedAt: "", durationMs: 10, costUsd: 0.001, variantId: "x" }) as SuiteCaseResult;

  it("aligns tool calls by name, flags changed arguments, added and missing calls; diffs the answers by word", () => {
    const cmp = compareBenchmarkCase([
      { variantId: "a", label: "A", runId: "r1", owner: "shop", result: res(trace([["rates", { country: "IT" }], ["log", {}]], "Shipping costs 4.99 EUR.")) },
      { variantId: "b", label: "B", runId: "r2", owner: "shop", result: res(trace([["search", { q: "x" }], ["rates", { country: "DE" }]], "Shipping costs 5.49 EUR.")) },
    ]);
    expect(cmp.reference).toBe("a");
    const b = cmp.columns[1];
    expect(b.toolCalls.map((c) => c.diff)).toEqual(["added", "changed"]);
    expect(b.toolCalls[1].argChanges).toEqual(["country"]);
    expect(b.missingCalls).toEqual(["log"]);
    expect(b.sameAsReference).toEqual({ tools: false, text: false });
    expect(b.textDiff).toEqual([{ op: "same", text: "Shipping costs " }, { op: "del", text: "4.99" }, { op: "add", text: "5.49" }, { op: "same", text: " EUR." }]);
    expect(cmp.columns[0].textDiff).toBeUndefined();
  });

  it("argChanges and wordDiff edge cases", () => {
    expect(argChanges({ a: { b: [1, 2] } }, { a: { b: [1, 3] }, c: 1 })).toEqual(["a.b[1]", "c"]);
    expect(argChanges({ x: 1 }, { x: 1 })).toEqual([]);
    expect(wordDiff("same", "same")).toEqual([{ op: "same", text: "same" }]);
    expect(wordDiff("", "new")).toEqual([{ op: "add", text: "new" }]);
  });
});

// ── orchestration and the Playground, with a fake chat pipeline ──

const agentCfg = (name: string, over: Partial<AgentConfig> = {}): AgentConfig => ({ name, role: "r", model: "anthropic:mock", systemPrompt: "Be helpful.", ...over } as AgentConfig);

/**
 * A fake chat turn: plays the scripted turns (model mock) or, for a real model, answers by the
 * variant's model override; tool calls go through the hooks (mocks first, like the pipeline).
 */
function fakeTurn(opts: { costPerTurn?: number; gate?: Promise<void>; onTurn?: (ref: string, h: SuiteCaseHooks) => void; realTool?: (name: string) => string; live?: { n: number; peak: number } } = {}): AgentSuiteDeps["turn"] {
  return async (ref, messages, h, turnOpts) => {
    opts.onTurn?.(ref, h);
    if (opts.live) { opts.live.n++; opts.live.peak = Math.max(opts.live.peak, opts.live.n); }
    try {
      if (opts.gate) await opts.gate;
      await new Promise((r) => setTimeout(r, 5));
      let text = "";
      for (let i = 0; i < 6; i++) {
        if (h.budgetExceeded()) break;
        const scripted = h.mocksModel ? h.nextScriptedTurn() : undefined;
        if (h.mocksModel && !scripted) break;
        const turn = scripted ?? { text: h.overrides?.model === "smart" ? "The rate is 4.99" : "I am not sure", toolCalls: i === 0 ? [{ name: "rates", args: { country: "IT" } }] : [] };
        const calls = (turn.toolCalls ?? []).map((c, k) => ({ id: `t${i}-${k}`, name: c.name, args: c.args ?? {} }));
        h.recordTurn({ text: turn.text ?? "", toolCalls: calls, mocked: !!scripted, durationMs: 1, usage: { inputTokens: 100, outputTokens: 10, costUsd: scripted ? 0 : opts.costPerTurn ?? 0 } });
        if (turn.text) { text = turn.text; turnOpts?.onText?.(turn.text); }
        if (!calls.length) break;
        for (const c of calls) await h.toolCall(c.name, c.args, async () => opts.realTool?.(c.name) ?? "real result", c.id);
      }
      return { text, toolCalls: [] };
    } finally { if (opts.live) opts.live.n--; }
  };
}

function setup(turn: AgentSuiteDeps["turn"], extra: Partial<ConstructorParameters<typeof AgentBenchmarks>[0]> = {}) {
  const agents = [agentCfg("shop"), agentCfg("helper", { model: "openai:helper" })];
  const runner = new AgentSuiteRunner({ store: new InMemoryAgentSuiteStore(), agents: async () => agents, resolveAgent: async (n) => agents.find((a) => a.name === n), turn });
  const drafts: Array<{ agent: string; fields: Record<string, unknown> }> = [];
  const events: string[] = [];
  const bench = new AgentBenchmarks({
    runner: () => runner, store: new InMemoryBenchmarkStore(), agents: async () => agents, resolveAgent: async (n) => agents.find((a) => a.name === n),
    price: async (spec) => ({ model: spec ?? "default", price: { input: 3, output: 15 } }),
    emit: (e) => events.push(`${e.status}:${e.progress.runsDone}/${e.progress.runsTotal}`),
    writeDraft: async (agent, fields) => { drafts.push({ agent, fields }); return { draftChanged: true }; },
    ...extra,
  });
  return { runner, bench, drafts, events };
}

const quoteSuite = {
  name: "Quotes", defaultMode: "tools",
  mocks: { tools: [{ tool: "rates", response: { rate: "4.99" } }] },
  datasets: [{ id: "countries", name: "Countries", rows: [{ c: "IT" }, { c: "DE" }] }],
  cases: [
    { id: "quote", name: "Quote", input: { message: "rate?" }, assertions: [{ type: "text_contains", value: "4.99" }] },
    { id: "rows", name: "Rows", dataset: "countries", input: { message: "rate for {{row.c}}?" }, assertions: [{ type: "tool_called", tool: "rates" }] },
  ],
};

describe("benchmark orchestration", () => {
  it("runs suites × variants × repetitions (another agent too) within two runs at a time; compares them", async () => {
    const live = { n: 0, peak: 0 };
    const seen = new Set<string>();
    const { runner, bench, events } = setup(fakeTurn({ costPerTurn: 0.001, live, onTurn: (ref, h) => seen.add(`${ref}:${h.overrides?.model ?? "-"}`) }));
    await runner.saveSuite("shop", quoteSuite);
    const saved = await bench.save({ name: "Models", suites: [{ agent: "shop", suite: "quotes" }], repetitions: 2, variants: [
      { agent: "shop", label: "Smart", overrides: { model: "smart" } }, { agent: "shop", label: "Plain" }, { agent: "helper", label: "Helper", version: "production" },
    ] }, { actor: "t" });
    // a real model: the cost must be confirmed first
    await expect(bench.start({ benchmarkId: saved.id })).rejects.toMatchObject({ code: "CONFLICT", reason: "CONFIRM_COST" });
    const { run, done } = await bench.start({ benchmarkId: saved.id }, { confirm: true, actor: "t" });
    expect(run.status).toBe("running");
    expect(run.runs).toHaveLength(6);
    const finished = await done;
    expect(finished.status).toBe("completed");
    expect(finished.progress).toMatchObject({ runsDone: 6, runsTotal: 6, casesDone: 18, casesTotal: 18 });
    expect(live.peak).toBeLessThanOrEqual(2);
    expect([...seen].sort()).toEqual(["helper:-", "shop:-", "shop:smart"]);
    expect(events.at(-1)).toBe("completed:6/6");
    // each suite run is tagged with the benchmark, its repetition and its variant (the helper agent ran the shop's suite)
    const suiteRuns = await runner.listRuns("shop", { benchmarkRunId: run.id });
    expect(suiteRuns).toHaveLength(6);
    expect(suiteRuns.every((r) => r.trigger === "benchmark" && !r.baseline)).toBe(true);
    expect(suiteRuns.filter((r) => r.variant.agent === "helper").map((r) => r.repetition).sort()).toEqual([1, 2]);
    // the suite's own history leaves benchmark runs out
    expect((await runner.trend("shop", "quotes")).points).toHaveLength(0);

    const report = await bench.report(run.id, { quality: 1, cost: 0, latency: 0 });
    expect(report.leaderboard.entries[0].label).toBe("Smart");
    expect(report.stats.find((s) => s.label === "Smart")).toMatchObject({ repetitions: 2, cases: 3, passRate: { mean: 1, stddev: 0 } });
    expect(report.stats.find((s) => s.label === "Plain")!.passRate.mean).toBeCloseTo(2 / 3, 3);
    expect(report.matrix.rows.map((r) => r.caseKey)).toEqual(["quote", "rows#1", "rows#2"]);
    expect(report.matrix.rows[0].spread).toBe(true);
    const cmp = await bench.compareCase(run.id, "quote", { variants: ["smart", "plain"] });
    expect(cmp.columns.map((c) => c.label)).toEqual(["Smart", "Plain"]);
    expect(cmp.columns[1].sameAsReference).toEqual({ tools: true, text: false });
    expect(cmp.columns[1].textDiff!.some((s) => s.op === "add")).toBe(true);
    await expect(bench.compareCase(run.id, "nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("an offline benchmark needs no confirmation; a dataset benchmark runs only that dataset's cases; the estimate uses history then", async () => {
    const { runner, bench } = setup(fakeTurn());
    await runner.saveSuite("shop", { ...quoteSuite, defaultMode: "all", cases: quoteSuite.cases.map((c) => ({ ...c, mocks: { model: { turns: [{ toolCalls: [{ name: "rates", args: {} }] }, { text: "4.99" }] } } })) });
    const spec = { name: "Offline", suites: [{ agent: "shop", suite: "quotes", dataset: "countries" }], variants: [{ agent: "shop" }, { agent: "shop", version: "production", label: "B" }] };
    const est = await bench.estimate(parseBenchmarkSpec(spec));
    expect(est).toMatchObject({ offline: true, runs: 2, cases: 4, costUsd: 0 });
    const run = await (await bench.start({ benchmark: spec })).done;
    expect(run.status).toBe("completed");
    expect(run.progress.casesTotal).toBe(4);
    const report = await bench.report(run.id);
    expect(report.matrix.rows.map((r) => r.caseKey)).toEqual(["rows#1", "rows#2"]);
    expect(report.stats.every((s) => s.passRate.mean === 1)).toBe(true);
    await expect(bench.start({ benchmark: { ...spec, suites: [{ agent: "shop", suite: "quotes", dataset: "nope" }] } })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("the estimate prices real-model cases from the prompt, then from past runs; a budget below the estimate is refused", async () => {
    const { runner, bench } = setup(fakeTurn({ costPerTurn: 0.02 }));
    await runner.saveSuite("shop", quoteSuite);
    const spec = parseBenchmarkSpec({ name: "E", suites: [{ agent: "shop", suite: "quotes" }], variants: [{ agent: "shop" }], repetitions: 2 });
    const first = await bench.estimate(spec);
    expect(first.cells[0]).toMatchObject({ basis: "heuristic", realModelCases: 3, cases: 3 });
    expect(first.costUsd).toBeGreaterThan(0);
    await runner.run("shop", "quotes");
    const second = await bench.estimate(spec);
    expect(second.cells[0].basis).toBe("history");
    expect(second.costUsd).toBeCloseTo(0.04 * 3 * 2, 4);
    await expect(bench.start({ benchmark: { ...spec, budgetUsd: 0.01 } }, { confirm: true })).rejects.toMatchObject({ reason: "OVER_BUDGET" });
  });

  it("the budget cap stops the benchmark once spent: the runs not finished are cancelled", async () => {
    const { runner, bench } = setup(fakeTurn({ costPerTurn: 0.02 }), { price: async () => ({ model: "cheap", price: { input: 0.01, output: 0.01 } }) });
    await runner.saveSuite("shop", { ...quoteSuite, cases: [quoteSuite.cases[0]] });
    const spec = { name: "Cap", suites: [{ agent: "shop", suite: "quotes" }], variants: [{ agent: "shop" }], repetitions: 6 };
    const run = await (await bench.start({ benchmark: spec }, { confirm: true, budgetUsd: 0.09 })).done;
    expect(run.status).toBe("cancelled");
    expect(run.stopReason).toBe("budget");
    expect(run.spentUsd).toBeGreaterThanOrEqual(0.09);
    expect(run.runs.some((e) => e.status === "cancelled")).toBe(true);
    expect(run.notes.join(" ")).toContain("budget cap");
  });

  it("cancel stops every run; real tools need the admin", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { runner, bench } = setup(fakeTurn({ gate }));
    await runner.saveSuite("shop", { ...quoteSuite, defaultMode: "all", cases: [quoteSuite.cases[0]] });
    const { run } = await bench.start({ benchmark: { name: "C", suites: [{ agent: "shop", suite: "quotes" }], variants: [{ agent: "shop" }, { agent: "helper" }], repetitions: 3 } });
    await new Promise((r) => setTimeout(r, 20));
    const stopping = bench.cancel(run.id);
    release();
    const stopped = await stopping;
    expect(stopped).toMatchObject({ status: "cancelled", stopReason: "cancelled" });
    expect(stopped.runs.filter((e) => e.status === "cancelled").length).toBeGreaterThan(0);
    await runner.saveSuite("shop", { name: "Live", defaultMode: "none", cases: [{ name: "x", input: { message: "x" } }] });
    await expect(bench.start({ benchmark: { name: "L", suites: [{ agent: "shop", suite: "live" }], variants: [{ agent: "shop" }] } }, { confirm: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("Playground", () => {
  const panes = [
    { label: "Scripted", variant: { agent: "shop" }, mockModel: true, mocks: { tools: [{ tool: "rates", response: "4.99 EUR" }], model: { turns: [{ toolCalls: [{ name: "rates", args: { country: "IT" } }] }, { text: "It is 4.99" }] } } },
    { label: "Smart", variant: { agent: "shop", overrides: { model: "smart" } }, mocks: { suite: { agent: "shop", suite: "quotes" } } },
    { label: "Blocked", variant: { agent: "helper" }, mockTools: false },
  ];

  it("sends once to every pane, each with its own mocks; streams events; keeps each pane's conversation", async () => {
    const realRuns: string[] = [];
    const { runner, bench } = setup(fakeTurn({ costPerTurn: 0.003, realTool: (n) => { realRuns.push(n); return "REAL"; } }));
    await runner.saveSuite("shop", quoteSuite);
    const s = await bench.createSession(panes, { actor: "me" });
    expect(s.panes.map((p) => [p.id, p.mockTools, p.mockModel, p.realTools])).toEqual([["pane-1", true, true, false], ["pane-2", true, false, false], ["pane-3", false, false, false]]);
    const events: string[] = [];
    const { exchanges } = await bench.send(s.id, { message: "Rate to Italy?" }, (pane, e) => events.push(`${pane}:${e.type}`));
    expect(exchanges["pane-1"]).toMatchObject({ mode: "all", status: "done", costUsd: 0 });
    expect(exchanges["pane-1"].trace.toolCalls[0]).toMatchObject({ name: "rates", mocked: "mock", result: "4.99 EUR" });
    expect(exchanges["pane-1"].trace.text).toBe("It is 4.99");
    expect(exchanges["pane-2"].trace.toolCalls[0]).toMatchObject({ mocked: "mock" });
    expect(exchanges["pane-2"].trace.text).toBe("The rate is 4.99");
    expect(exchanges["pane-2"].costUsd).toBeGreaterThan(0);
    expect(exchanges["pane-3"].trace.toolCalls[0]).toMatchObject({ mocked: "blocked", isError: true });
    expect(realRuns).toEqual([]);
    expect(events).toEqual(expect.arrayContaining(["pane-1:start", "pane-1:tool", "pane-1:text", "pane-1:done", "pane-2:turn", "pane-3:done"]));
    // the next message continues each pane's own conversation
    const seen: Array<Array<{ role: string }>> = [];
    const again = setup(async (ref, messages, h, o) => { seen.push(messages); return fakeTurn()(ref, messages, h, o); });
    await again.runner.saveSuite("shop", quoteSuite);
    const s2 = await again.bench.createSession([panes[1]]);
    await again.bench.send(s2.id, { message: "one" });
    await again.bench.send(s2.id, { message: "two" });
    expect(seen[1].map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect((await again.bench.getSession(s2.id)).exchanges["pane-1"]).toHaveLength(2);
    expect(again.bench.resetSession(s2.id).exchanges["pane-1"]).toEqual([]);
  });

  it("real tools need allowRealTools; then unmocked calls run for real", async () => {
    const realRuns: string[] = [];
    const { bench } = setup(fakeTurn({ realTool: (n) => { realRuns.push(n); return "REAL"; } }));
    const s = await bench.createSession([{ variant: { agent: "shop", overrides: { model: "smart" } }, mockTools: false, realTools: true }]);
    await expect(bench.send(s.id, { message: "go" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { exchanges } = await bench.send(s.id, { message: "go", allowRealTools: true });
    expect(exchanges["pane-1"].trace.toolCalls[0]).toMatchObject({ mocked: false, result: "REAL" });
    expect(realRuns).toEqual(["rates"]);
  });

  it("save as a test case (caseFromTrace): mocks and checks from the exchange; saved into a suite; promote writes the draft only", async () => {
    const { runner, bench, drafts } = setup(fakeTurn());
    await runner.saveSuite("shop", quoteSuite);
    const s = await bench.createSession([panes[0]]);
    await bench.send(s.id, { message: "Rate to Italy?" });
    const proposed = await bench.caseFromExchange(s.id, { paneId: "pane-1", mockModel: true });
    expect(proposed.suite).toBeUndefined();
    expect(proposed.case).toMatchObject({ name: "Rate to Italy?", mode: "all", input: { kind: "chat", message: "Rate to Italy?" } });
    expect(proposed.case.mocks?.tools?.[0]).toMatchObject({ tool: "rates", response: "4.99 EUR", when: { args: { country: "IT" }, match: "exact" } });
    expect(proposed.case.assertions[0]).toMatchObject({ type: "tool_called", tool: "rates" });
    expect(proposed.case.mocks?.model?.turns).toHaveLength(2);
    const saved = await bench.caseFromExchange(s.id, { paneId: "pane-1", name: "Italy quote", mockModel: true, save: { agent: "shop", suite: "quotes" } });
    expect(saved.suite!.cases.map((c) => c.name)).toContain("Italy quote");
    // the saved case replays offline and passes
    const run = await runner.run("shop", "quotes", { caseIds: [saved.case.id], mode: "all" });
    expect(run.results[0]).toMatchObject({ status: "passed" });
    expect(run.results[0].trace.toolCalls[0]).toMatchObject({ mocked: "mock", result: "4.99 EUR" });

    const promoted = await bench.promote({ agent: "shop", overrides: { model: "smart", instructionsAppend: "Always quote in EUR." } }, { actor: "me" });
    expect(promoted.fields).toEqual({ model: "smart", systemPrompt: "Be helpful.\n\nAlways quote in EUR." });
    expect(drafts).toEqual([{ agent: "shop", fields: promoted.fields }]);
    await expect(bench.promote({ agent: "shop", overrides: {} })).rejects.toThrow(/no overrides/);
    expect(promotionFields({ model: "a" }, { model: "a" })).toEqual({ model: "a" });
    expect(playgroundCase({ index: 0, message: "", at: "", mode: "tools", status: "done", costUsd: 0, durationMs: 0, tokens: { input: 0, output: 0 }, trace: { input: [{ role: "user", content: "x" }], turns: [], toolCalls: [], text: "", approvals: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, durationMs: 0, notes: [] } }).name).toBe("Playground exchange 1");
  });

  it("headless: one message to panes without a session", async () => {
    const { bench } = setup(fakeTurn());
    const out = await bench.sendOnce([panes[0], panes[2]], { message: "hi" });
    expect(Object.keys(out.exchanges)).toEqual(["pane-1", "pane-2"]);
    expect(bench.listSessions()).toEqual([]);
  });
});
