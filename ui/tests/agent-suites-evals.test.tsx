/**
 * The Suites tab's evals: the scorer editor in the case form and the Evals view (judge model,
 * repetitions, default scorers), the report's scores (per case, per scorer with the delta versus
 * the baseline, the judge's reasoning), regressions, the baseline toggle, "Explain this run" with
 * the stored review, and the trend chart.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const SUITE = {
  id: "quotes", agent: "shop", name: "Quotes", defaultMode: "all", target: { kind: "agent" }, revision: 2, createdAt: "", updatedAt: "",
  cases: [{ id: "quote", name: "Quote", input: { kind: "chat", message: "Shipping to {{row.country}}?" }, mocks: { model: { turns: [{ text: "4.99" }] } }, assertions: [], dataset: "rates",
    scorers: [{ id: "price", type: "numeric", expected: "{{row.expected}}", tolerance: 0.01 }] }],
  datasets: [{ id: "rates", name: "Rates", columns: ["country", "expected"], rows: [{ country: "IT", expected: 4.99 }, { country: "DE", expected: 5.49 }] }],
};
const score = (id: string, value: number, passed: boolean, extra: Record<string, unknown> = {}) => ({ scorer: { id, type: id === "judge" ? "llm_judge" : "numeric" }, id, description: id === "judge" ? "LLM judge: polite" : "number 4.99 ±0.01", score: value, threshold: id === "judge" ? 0.6 : 1, weight: 1, passed, ...extra });
const trace = { input: [{ role: "user", content: "Shipping?" }], text: "It costs 9.99 EUR.", approvals: [], notes: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, durationMs: 10, turns: [], toolCalls: [] };
const RUN = {
  id: "sr-2", agent: "shop", suiteId: "quotes", suiteName: "Quotes", suiteRevision: 2, target: "draft", trigger: "manual",
  variant: { id: "shop@draft", agent: "shop", version: "draft" }, status: "failed", startedAt: "2026-11-25T10:00:00.000Z", finishedAt: "2026-11-25T10:00:01.000Z",
  planned: ["quote#1", "quote#2"], notes: [],
  stats: { total: 2, passed: 1, failed: 1, errored: 0, skipped: 0, passRate: 0.5, costUsd: 0, durationMs: 20, inputTokens: 0, outputTokens: 0, turns: 2, toolCalls: 0 },
  results: [
    { key: "quote#1", caseId: "quote", caseName: "Quote", row: { index: 0, values: { country: "IT" } }, status: "passed", mode: "all", engine: "native", startedAt: "", durationMs: 10, costUsd: 0, variantId: "v",
      assertions: [], scores: [score("price", 1, true), score("judge", 1, true)], score: 1, trace },
    { key: "quote#2", caseId: "quote", caseName: "Quote", row: { index: 1, values: { country: "DE" } }, status: "failed", mode: "all", engine: "native", startedAt: "", durationMs: 10, costUsd: 0, variantId: "v",
      assertions: [], score: 0.4,
      scores: [score("price", 0.18, false, { reason: "9.99 vs 5.49: off by 4.5" }), score("judge", 0.25, false, { reason: "Wrong price.", judge: { model: "anthropic:judge", criteria: [{ name: "correctness", weight: 1, score: 2, reasoning: "9.99 is not the German rate" }] } })],
      trace },
  ],
  aggregates: {
    score: 0.7, passRate: 0.5, costUsd: 0, durationMs: 20, judgeCostUsd: 0, repetitions: 1, flaky: [],
    scorers: [
      { id: "price", label: "number 4.99 ±0.01", type: "numeric", count: 2, mean: 0.59, median: 0.59, p10: 0.26, min: 0.18, max: 1, stddev: 0.41, passRate: 0.5, weight: 1 },
      { id: "judge", label: "LLM judge: polite", type: "llm_judge", count: 2, mean: 0.63, median: 0.63, p10: 0.33, min: 0.25, max: 1, stddev: 0.38, passRate: 0.5, weight: 1 },
    ],
    cases: [],
  },
  baseline: {
    runId: "sr-1", source: "marked", baselineTarget: "production", baselineVersion: "1.2.0", tolerance: 0.05, passRateDelta: -0.5, costDelta: 0, durationDelta: 0, scoreDelta: -0.3,
    regressions: 1, improvements: 0,
    cases: [{ key: "quote#2", caseName: "Quote", change: "regressed", baselineStatus: "passed", status: "failed", passRate: { baseline: 1, current: 0, delta: -1 }, scorers: [], reasons: ["was passed, now failed"] }],
    scorers: [{ id: "price", baseline: 1, current: 0.59, delta: -0.41, change: "regressed" }, { id: "judge", baseline: 1, current: 0.63, delta: -0.37, change: "regressed" }],
  },
  review: { text: "## Summary\nThe German quote regressed.", model: "anthropic:polpo", at: "2026-11-25T10:01:00.000Z" },
};
const BASE = { ...RUN, id: "sr-1", status: "passed", target: "production", version: "1.2.0", isBaseline: true, baseline: undefined, review: undefined, aggregates: { ...RUN.aggregates, score: 1 } };
const TREND = {
  suiteId: "quotes",
  points: [
    { runId: "sr-1", startedAt: "2026-11-24T10:00:00.000Z", target: "production", version: "1.2.0", status: "passed", passRate: 1, score: 1, costUsd: 0, durationMs: 20, scorers: { price: 1 }, isBaseline: true },
    { runId: "sr-2", startedAt: "2026-11-25T10:00:00.000Z", target: "draft", status: "failed", passRate: 0.5, score: 0.7, costUsd: 0, durationMs: 20, scorers: { price: 0.59 }, regressions: 1 },
  ],
  byVersion: [
    { version: "1.2.0", runs: 1, passRate: 1, score: 1, costUsd: 0, durationMs: 20, lastRunAt: "2026-11-24T10:00:00.000Z" },
    { version: "draft", runs: 1, passRate: 0.5, score: 0.7, costUsd: 0, durationMs: 20, lastRunAt: "2026-11-25T10:00:00.000Z" },
  ],
  scorers: [{ id: "price", label: "number" }],
};
let current: Record<string, unknown> = RUN;
const api = {
  run: vi.fn(async () => RUN),
  save: vi.fn(async (s: { name: string }) => ({ ...SUITE, ...s, revision: 3 })),
  remove: vi.fn(async () => undefined),
  cancel: vi.fn(async () => RUN),
  importDataset: vi.fn(async () => SUITE),
  yaml: vi.fn(async () => ({ yaml: "name: Quotes\n", revision: 2 })),
  setBaseline: vi.fn(async () => undefined),
  review: vi.fn(async () => RUN),
};
const refetch = vi.fn(async () => undefined);

vi.mock("@polpo-ai/react", () => ({
  useAgentSuites: () => ({ suites: [SUITE], runs: [RUN, BASE], isLoading: false, error: null, refetch: async () => undefined, ...api }),
  useAgentSuiteRun: () => ({ run: current, isLoading: false, error: null, refetch }),
  useAgentSuiteTrend: () => ({ trend: TREND, isLoading: false, error: null, refetch: async () => undefined }),
  useAgentVersions: () => ({ data: { state: {}, versions: [{ version: "1.2.0" }] }, isLoading: false, error: null }),
}));
vi.mock("../src/components/agents/agent-detail-context", () => ({
  useAgentDetail: () => ({ meta: { agentName: "shop" }, actions: { refetch: async () => undefined } }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AgentSuitesTab } from "../src/components/agents/agent-suites-tab";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  for (const f of Object.values(api)) f.mockClear();
  refetch.mockClear();
  current = RUN;
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => [...document.body.querySelectorAll(sel)] as HTMLElement[];
const click = async (el: HTMLElement | null | undefined) => { await act(async () => { el!.click(); }); await flush(); };
const row = (id: string) => q(`[data-testid="suite-row"][data-suite="${id}"]`)!;

async function render() {
  await act(async () => root.render(<MemoryRouter><AgentSuitesTab /></MemoryRouter>));
  await flush();
}

test("the suite row and the runs list show the score, regressions and the baseline", async () => {
  await render();
  expect(row("quotes").textContent).toContain("score 0.70");
  expect(row("quotes").textContent).toContain("1 regression(s)");
  const runs = qa('[data-testid="suite-run-row"]');
  expect(runs[0].textContent).toContain("score 0.70");
  expect(runs[0].textContent).toContain("▼ 1");
  expect(runs[1].querySelector('[data-testid="suite-run-row-baseline"]')).toBeTruthy();
});

test("the report: scores per scorer with deltas, per case with the judge's reasoning, regressions, the stored review", async () => {
  await render();
  await click(qa('[data-testid="suite-run-row"]')[0]);
  const summary = q('[data-testid="suite-eval-summary"]')!;
  expect(q('[data-testid="suite-baseline-compare"]')!.textContent).toContain("vs baseline sr-1 (marked, v1.2.0)");
  expect(q('[data-testid="suite-baseline-compare"]')!.textContent).toContain("−50 pts");
  expect(q('[data-testid="suite-baseline-compare"]')!.textContent).toContain("1 regression(s)");
  const table = summary.querySelector('[data-testid="suite-scorer-table"]')!;
  expect(table.querySelector('[data-scorer="price"]')!.textContent).toContain("0.59");
  expect(table.querySelector('[data-scorer="price"]')!.textContent).toContain("−0.41");
  const cases = qa('[data-testid="suite-case-result"]');
  expect(cases[1].querySelector('[data-change="regressed"]')).toBeTruthy();
  expect(cases[1].querySelector('[data-testid="suite-case-score"]')!.textContent).toBe("0.40");
  expect(cases[1].textContent).toContain("price 0.18 < 1");
  // the failed case is open: its scores and the judge's criteria
  const price = cases[1].querySelector('[data-testid="suite-score"][data-scorer="price"]')!;
  expect(price.getAttribute("data-passed")).toBe("false");
  expect(price.textContent).toContain("9.99 vs 5.49: off by 4.5");
  expect(cases[1].querySelector('[data-testid="suite-judge"]')!.textContent).toContain("correctness 2/5: 9.99 is not the German rate");
  expect(q('[data-testid="suite-run-review-text"]')!.textContent).toContain("The German quote regressed");
});

test("mark as baseline and explain this run call the API and refresh the report", async () => {
  await render();
  await click(qa('[data-testid="suite-run-row"]')[0]);
  const toggle = q('[data-testid="suite-run-baseline"]')!;
  expect(toggle.textContent).toContain("Mark as baseline");
  await click(toggle);
  expect(api.setBaseline).toHaveBeenCalledWith("quotes", "sr-2");
  expect(refetch).toHaveBeenCalled();
  expect(q('[data-testid="suite-run-review"]')!.textContent).toContain("Explain again");
  await click(q('[data-testid="suite-run-review"]'));
  expect(api.review).toHaveBeenCalledWith("sr-2");
});

test("on the baseline run the toggle clears the mark", async () => {
  current = BASE;
  await render();
  await click(qa('[data-testid="suite-run-row"]')[1]);
  expect(q('[data-testid="suite-run-is-baseline"]')).toBeTruthy();
  const toggle = q('[data-testid="suite-run-baseline"]')!;
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  await click(toggle);
  expect(api.setBaseline).toHaveBeenCalledWith("quotes", null);
  expect(q('[data-testid="suite-run-review"]')!.textContent).toContain("Explain this run");
});

test("the trend: a chart and the means by version", async () => {
  await render();
  await click(row("quotes").querySelector('[data-testid="suite-trend-open"]') as HTMLElement);
  expect(q('[data-testid="suite-trend"]')!.textContent).toContain("Quotes · trend");
  expect(q('[data-testid="suite-trend-chart"]')).toBeTruthy();
  const versions = q('[data-testid="suite-trend-versions"]')!.textContent!;
  expect(versions).toContain("v1.2.0");
  expect(versions).toContain("draft");
  expect(versions).toContain("50%");
});

test("the editor: a scorer in the case form, and the Evals view (judge model, repetitions, default scorers) saved", async () => {
  await render();
  await click(row("quotes").querySelector("button") as HTMLElement);
  expect(qa('[data-testid="suite-scorer-form"]')).toHaveLength(1);
  await click(q('[data-testid="suite-case-form"] [data-testid="suite-add-scorer"]'));
  expect(qa('[data-testid="suite-scorer-form"]')).toHaveLength(2);
  await click(q('[data-testid="suite-view-evals"]'));
  const evals = q('[data-testid="suite-evals"]')!;
  const set = async (label: string, value: string) => {
    const input = evals.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await set("Judge model", "anthropic:judge");
  await set("Repetitions", "3");
  await click(evals.querySelector('[data-testid="suite-add-scorer"]') as HTMLElement);
  await click(q('[data-testid="suite-save"]'));
  const [body, opts] = api.save.mock.calls[0] as unknown as [{ cases: Array<{ scorers: Array<{ type: string }> }>; evals: unknown; scorers: Array<{ type: string }> }, unknown];
  expect(opts).toEqual({ id: "quotes", revision: 2 });
  expect(body.cases[0].scorers.map((s) => s.type)).toEqual(["numeric", "exact"]);
  expect(body.evals).toEqual({ judgeModel: "anthropic:judge", repetitions: 3 });
  expect(body.scorers).toEqual([{ type: "exact", expected: "{{row.expected}}" }]);
});
