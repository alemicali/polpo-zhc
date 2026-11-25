/**
 * The MCP agent suite card (widgets/suite-card/view.ts) rendered in a DOM from the server's cards
 * (src/server/mcp-suite-card.ts): the run report with scores, deltas, regressions and the review;
 * the suites list; the trend chart with the baseline marked.
 */
import { describe, expect, it, vi } from "vitest";
import { renderView } from "../../widgets/suite-card/view";
import { buildSuiteListCard, buildSuiteRunCard, buildSuiteTrendCard, suiteCardText } from "../../src/server/mcp-suite-card";

const key = { createdAt: 1, seq: 1 };
const env = (card: unknown, extra: Record<string, unknown> = {}) => ({ card: card as never, locale: "en", full: false, canFullscreen: true, busy: false, superseded: false, ...extra });
const score = (id: string, value: number, passed: boolean) => ({ id, score: value, threshold: 0.6, passed, description: id, ...(passed ? {} : { reason: "wrong price" }) });
const suiteRun = {
  id: "sr-2", agent: "shop", suiteId: "quotes", suiteName: "Quotes", status: "failed", target: "draft", startedAt: "2026-11-25T10:00:00.000Z", notes: [],
  variant: { label: "gpt" },
  stats: { total: 2, passed: 1, failed: 1, errored: 0, skipped: 0, passRate: 0.5, costUsd: 0.0123, durationMs: 2400, inputTokens: 0, outputTokens: 0, turns: 0, toolCalls: 0 },
  results: [
    { key: "quote#1", caseName: "Quote IT", status: "passed", score: 1, costUsd: 0.006, durationMs: 1200, assertions: [], scores: [score("judge", 1, true)] },
    { key: "quote#2", caseName: "Quote DE", status: "failed", score: 0.25, costUsd: 0.006, durationMs: 1200, assertions: [{ description: 'reply contains "5.49"', passed: false, message: "missing" }], scores: [score("judge", 0.25, false)] },
  ],
  aggregates: {
    score: 0.63, passRate: 0.5, costUsd: 0.0123, durationMs: 2400, judgeCostUsd: 0, repetitions: 1, flaky: [], cases: [],
    scorers: [{ id: "judge", label: "LLM judge: polite", type: "llm_judge", count: 2, mean: 0.63, median: 0.63, p10: 0.33, min: 0.25, max: 1, stddev: 0.38, passRate: 0.5, weight: 1 }],
  },
  baseline: {
    runId: "sr-1", source: "marked", baselineTarget: "production", baselineVersion: "1.2.0", tolerance: 0.05, passRateDelta: -0.5, costDelta: 0, durationDelta: 0, scoreDelta: -0.37, regressions: 1, improvements: 0,
    cases: [{ key: "quote#2", caseName: "Quote DE", change: "regressed", passRate: {}, scorers: [], reasons: ["was passed, now failed"] }],
    scorers: [{ id: "judge", baseline: 1, current: 0.63, delta: -0.37, change: "regressed" }],
  },
  review: { text: "## Summary\nThe German quote regressed.", model: "m", at: "2026-11-25T10:01:00.000Z" },
};

describe("the agent suite card (MCP App)", () => {
  it("the run report: pass rate and score with deltas, scorers, the regressed case with its failed checks, the review; Explain asks", () => {
    const root = document.createElement("div");
    const card = buildSuiteRunCard({ run: suiteRun as never, key });
    const onAsk = vi.fn();
    const onShow = vi.fn();
    renderView(root, env(card, { onAsk, onShow }));
    expect(root.querySelector(".head .name")!.textContent).toBe("Quotes · draft");
    expect(root.textContent).toContain("1/2");
    expect(root.textContent).toContain("0.63");
    expect([...root.querySelectorAll(".delta")].map((e) => e.textContent)).toEqual(expect.arrayContaining(["−0.50", "−0.37"]));
    expect(root.querySelector('[data-testid="suite-baseline"]')!.textContent).toContain("vs baseline sr-1 (v1.2.0)");
    expect(root.querySelector('[data-scorer="judge"]')!.textContent).toContain("mean 0.63");
    const de = root.querySelector('[data-case="quote#2"]')!;
    expect(de.querySelector('[data-change="regressed"]')!.textContent).toContain("Regressed");
    expect(de.textContent).toContain('reply contains "5.49": missing');
    expect(de.textContent).toContain("judge: 0.25 < 0.6");
    expect(root.querySelector('[data-testid="suite-review"]')!.textContent).toContain("The German quote regressed");
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Explain this run")!.click();
    expect(onAsk).toHaveBeenCalled();
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Trend")!.click();
    expect(onShow).toHaveBeenCalledWith({ suite: "quotes", view: "trend" });
    expect(suiteCardText(card)).toContain("vs sr-1: pass rate −50 pts");
    // Italian
    renderView(root, env(card, { locale: "it-IT" }));
    expect(root.textContent).toContain("Spiega questo run");
    expect(root.textContent).toContain("Peggiorato");
  });

  it("the suites list opens a run or the trend; the trend draws a chart with the baseline marked", () => {
    const root = document.createElement("div");
    const list = buildSuiteListCard({
      agent: "shop", key,
      suites: [{ id: "quotes", name: "Quotes", cases: [{ scorers: [{}] }], datasets: [], defaultMode: "all", scorers: [{}] }, { id: "new", name: "New", cases: [], datasets: [], defaultMode: "all" }],
      runs: [
        { id: "sr-2", suiteId: "quotes", status: "failed", startedAt: "2026-11-25T10:00:00.000Z", target: "draft", stats: { passed: 1, total: 2, skipped: 0 } as never, aggregates: { score: 0.63 }, baseline: { regressions: 1 } },
        { id: "sr-1", suiteId: "quotes", status: "passed", startedAt: "2026-11-24T10:00:00.000Z", target: "production", stats: { passed: 2, total: 2, skipped: 0 } as never, isBaseline: true },
      ],
    });
    const onShow = vi.fn();
    renderView(root, env(list, { onShow }));
    const q = root.querySelector('[data-suite="quotes"]')!;
    expect(q.textContent).toContain("2 scorers");
    expect(q.textContent).toContain("score 0.63");
    expect(q.textContent).toContain("1 regression");
    expect(q.textContent).toContain("Baseline");
    expect(root.querySelector('[data-suite="new"]')!.textContent).toContain("never run");
    [...q.querySelectorAll("button")].find((b) => b.textContent === "Latest run")!.click();
    expect(onShow).toHaveBeenCalledWith({ run: "sr-2", suite: "quotes", view: "run" });

    const trend = buildSuiteTrendCard({
      agent: "shop", suiteName: "Quotes", key,
      trend: {
        suiteId: "quotes", scorers: [],
        points: [
          { runId: "sr-1", startedAt: "2026-11-24T10:00:00.000Z", target: "production", version: "1.2.0", status: "passed", passRate: 1, score: 1, costUsd: 0, durationMs: 1, scorers: {}, isBaseline: true },
          { runId: "sr-2", startedAt: "2026-11-25T10:00:00.000Z", target: "draft", status: "failed", passRate: 0.5, score: 0.63, costUsd: 0, durationMs: 1, scorers: {} },
        ],
        byVersion: [
          { version: "1.2.0", runs: 1, passRate: 1, score: 1, costUsd: 0, durationMs: 1, lastRunAt: "" },
          { version: "draft", runs: 1, passRate: 0.5, score: 0.63, costUsd: 0, durationMs: 1, lastRunAt: "" },
        ],
      } as never,
    });
    renderView(root, env(trend, { onShow }));
    const svg = root.querySelector("svg.chart")!;
    expect(svg.querySelectorAll("polyline")).toHaveLength(2);
    expect(svg.querySelectorAll(".baseline-mark")).toHaveLength(1);
    expect(svg.querySelectorAll(".dot-bad")).toHaveLength(1);
    expect(root.querySelector('[data-version="1.2.0"]')!.textContent).toContain("100% · 1.00");
    expect(root.querySelector('[data-version="draft"]')!.textContent).toContain("50% · 0.63");
  });

  it("shows what is loading, and the error", () => {
    const root = document.createElement("div");
    renderView(root, env(undefined, { pending: "sr-9" }));
    expect(root.querySelector("[aria-busy='true']")?.textContent).toContain("sr-9");
    renderView(root, env(undefined, { error: "There is no run sr-9" }));
    expect(root.textContent).toContain("Could not load the card: There is no run sr-9");
  });
});
