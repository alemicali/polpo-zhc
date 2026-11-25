/**
 * The MCP benchmark card (widgets/suite-card/view.ts, kinds "benchmark" and "compare") rendered in
 * a DOM from the server's cards (src/server/mcp-suite-card.ts): the leaderboard with its Pareto
 * front and noise notes, the case × variant matrix (a row opens the case side by side), and the
 * side-by-side columns with the tool calls and the answer diffed; the text for clients without apps.
 */
import { describe, expect, it, vi } from "vitest";
import { renderView } from "../../widgets/suite-card/view";
import { buildBenchmarkCard, buildCompareCard, suiteCardText } from "../../src/server/mcp-suite-card";

const key = { createdAt: 1, seq: 1 };
const env = (card: unknown, extra: Record<string, unknown> = {}) => ({ card: card as never, locale: "en", full: false, canFullscreen: true, busy: false, superseded: false, ...extra });

const run = {
  id: "br-1", name: "Models", status: "completed", startedAt: "2026-11-25T10:00:00.000Z", spec: { variants: [{ id: "a", agent: "shop", version: "production" }], repetitions: 3, suites: [] },
  estimate: { costUsd: 0.12 }, spentUsd: 0.1, budgetUsd: 1, runs: [], progress: { runsDone: 6, runsTotal: 6, casesDone: 12, casesTotal: 12 }, notes: [],
};
const leaderboard = {
  weights: { quality: 0.7, cost: 0.2, latency: 0.1 }, qualityMetric: "score", paretoFront: ["a"], notes: ['"A" and "B": within the noise'],
  entries: [
    { rank: 1, variantId: "a", label: "A", quality: 0.9, qualityStddev: 0.02, qualityError: 0.01, passRate: 1, costUsd: 0.01, latencyP50Ms: 800, latencyP95Ms: 900, composite: 0.95, pareto: true, dominatedBy: [], flakiness: 0 },
    { rank: 2, variantId: "b", label: "B", quality: 0.85, qualityStddev: 0.1, qualityError: 0.06, passRate: 0.83, costUsd: 0.05, latencyP50Ms: 1500, latencyP95Ms: 2500, composite: 0.6, pareto: false, dominatedBy: ["a"], flakiness: 0.5 },
  ],
};
const matrix = {
  variants: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
  rows: [
    { key: "shop/q/same", owner: "shop", suiteId: "q", suiteName: "Q", caseId: "same", caseName: "Same", caseKey: "same", spread: false, cells: { a: { status: "passed", attempts: 3, passed: 3, results: [] }, b: { status: "passed", attempts: 3, passed: 3, results: [] } } },
    { key: "shop/q/italy", owner: "shop", suiteId: "q", suiteName: "Q", caseId: "italy", caseName: "Italy", caseKey: "italy", spread: true, cells: { a: { status: "passed", attempts: 3, passed: 3, score: 0.9, results: [] }, b: { status: "mixed", attempts: 3, passed: 2, score: 0.7, results: [] } } },
  ],
};

describe("the benchmark card (MCP App)", () => {
  it("the leaderboard (Pareto front, flakiness, notes) and the matrix, disagreeing rows first; a row opens the case side by side", () => {
    const root = document.createElement("div");
    const card = buildBenchmarkCard({ run: run as never, leaderboard: leaderboard as never, matrix: matrix as never, key });
    expect(card.rows.map((r) => r.key)).toEqual(["shop/q/italy", "shop/q/same"]);
    const onBench = vi.fn();
    renderView(root, env(card, { onBench }));
    expect(root.querySelector(".head .name")!.textContent).toBe("Models");
    const rows = [...root.querySelectorAll(".lb-row")];
    expect(rows.map((r) => r.getAttribute("data-variant"))).toEqual(["a", "b"]);
    expect(rows[0].getAttribute("data-pareto")).toBe("true");
    expect(rows[1].textContent).toContain("flaky 50%");
    expect(root.querySelector('[data-testid="bench-notes"]')!.textContent).toContain("within the noise");
    const italy = root.querySelector('[data-case="shop/q/italy"]')!;
    expect(italy.className).toContain("spread");
    expect(italy.querySelector('[data-cell="mixed"]')!.textContent).toContain("2/3 0.70");
    (italy.querySelector("button") as HTMLButtonElement).click();
    expect(onBench).toHaveBeenCalledWith({ run: "br-1", view: "compare", case: "shop/q/italy" });
    expect(suiteCardText(card)).toContain("1. A ◆ · score 0.90 ± 0.02");
  });

  it("side by side: columns with the tool calls marked (changed, added, missing) and the answer's words added and removed; Back", () => {
    const res = (text: string) => ({ key: "italy", caseName: "Italy", trace: { text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } } });
    const comparison = {
      key: "shop/q/italy", caseName: "Italy", reference: "a",
      columns: [
        { variantId: "a", label: "A", runId: "sr-1", owner: "shop", repetition: 1, key: "italy", status: "passed", costUsd: 0.01, durationMs: 800, tokens: { input: 10, output: 5 }, finalText: "It is 4.99",
          toolCalls: [{ name: "rates", args: { country: "IT" }, result: "ok", isError: false, mocked: "mock", diff: "same" }, { name: "notify", args: {}, result: "ok", isError: false, mocked: "mock", diff: "same" }], missingCalls: [], sameAsReference: { tools: true, text: true }, result: res("It is 4.99") },
        { variantId: "b", label: "B", runId: "sr-2", owner: "shop", repetition: 1, key: "italy", status: "failed", costUsd: 0.05, durationMs: 1500, tokens: { input: 10, output: 5 }, finalText: "It is 5.49",
          toolCalls: [{ name: "rates", args: { country: "DE" }, result: "ok", isError: false, mocked: "mock", diff: "changed", argChanges: ["country"] }, { name: "search", args: {}, result: "ok", isError: false, mocked: "mock", diff: "added" }],
          missingCalls: ["notify"], textDiff: [{ op: "same", text: "It is " }, { op: "del", text: "4.99" }, { op: "add", text: "5.49" }], sameAsReference: { tools: false, text: false }, result: res("It is 5.49") },
      ],
    };
    const card = buildCompareCard({ runId: "br-1", comparison: comparison as never, key });
    expect(card.columns[1].toolCalls[0].args).toBe('{"country":"DE"}');
    const root = document.createElement("div");
    const onBench = vi.fn();
    renderView(root, env(card, { onBench }));
    const cols = [...root.querySelectorAll(".compare-col")];
    expect(cols.map((c) => c.getAttribute("data-variant"))).toEqual(["a", "b"]);
    expect(cols[1].querySelector('[data-diff="changed"]')!.getAttribute("title")).toBe("country");
    expect(cols[1].querySelector('[data-diff="added"]')!.textContent).toContain("+ search");
    expect(cols[1].querySelector('[data-diff="missing"]')!.textContent).toContain("notify");
    expect(cols[1].querySelector("del")!.textContent).toBe("4.99");
    expect(cols[1].querySelector("ins")!.textContent).toBe("5.49");
    ([...root.querySelectorAll("button")].find((b) => b.textContent === "Leaderboard") as HTMLButtonElement).click();
    expect(onBench).toHaveBeenCalledWith({ run: "br-1", view: "benchmark" });
    expect(suiteCardText(card)).toContain("B: failed · $0.0500 · tools ~rates, +search · missing notify");
  });
});
