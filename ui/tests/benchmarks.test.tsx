/**
 * The Benchmarks page (agent suites phase 5): saved benchmarks and runs, the run dialog (the cost
 * estimate, the confirmations for real models and real tools, the budget cap), a run's report —
 * the leaderboard with its weights and Pareto front, the notes, the case × variant matrix — and a
 * case side by side (traces in columns, tool calls and answers diffed); the editor prefilled from
 * a suite (?new=1&agent=&suite=).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const trace = (calls: Array<[string, Record<string, unknown>]>, text: string) => ({
  input: [{ role: "user", content: "Shipping to Italy?" }], turns: [], text, approvals: [], notes: [], usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 }, durationMs: 10,
  toolCalls: calls.map(([name, args], i) => ({ id: `c${i}`, turn: 0, name, args, result: "ok", isError: false, mocked: "mock", durationMs: 1 })),
});
const result = (t: ReturnType<typeof trace>) => ({ key: "italy", caseId: "italy", caseName: "Italy", status: "passed", mode: "all", engine: "native", assertions: [], trace: t, startedAt: "", durationMs: 10, costUsd: 0, variantId: "x" });

const DEF = { id: "models", name: "Models", suites: [{ agent: "shop", suite: "quotes" }], variants: [{ id: "prod", label: "Prod", agent: "shop", version: "production" }, { id: "draft", label: "Draft", agent: "shop", version: "draft" }], repetitions: 3, revision: 1, createdAt: "", updatedAt: "" };
const RUN = {
  id: "br-1", benchmarkId: "models", name: "Models", spec: DEF, status: "completed", startedAt: "2026-11-25T10:00:00.000Z", estimate: { costUsd: 0.12 }, spentUsd: 0.1,
  runs: [], progress: { runsDone: 6, runsTotal: 6, casesDone: 12, casesTotal: 12 }, notes: [],
};
const REPORT = {
  run: RUN,
  stats: [
    { variantId: "prod", label: "Prod", agent: "shop", version: "production", runs: 3, repetitions: 3, cases: 2, passRate: { mean: 1, stddev: 0 }, score: { mean: 0.9, stddev: 0.02 }, scorers: [{ id: "price", label: "price", mean: 0.9, stddev: 0.02 }], costUsd: { mean: 0.05, stddev: 0, total: 0.15, perCase: 0.025 }, latency: { p50Ms: 1200, p95Ms: 2000, meanMs: 1300 }, tokens: { input: 100, output: 20, perCase: 20 }, flakiness: 0, flakyCases: [], errored: 0, complete: true },
    { variantId: "draft", label: "Draft", agent: "shop", version: "draft", runs: 3, repetitions: 3, cases: 2, passRate: { mean: 0.83, stddev: 0.29 }, score: { mean: 0.88, stddev: 0.05 }, scorers: [], costUsd: { mean: 0.01, stddev: 0, total: 0.03, perCase: 0.005 }, latency: { p50Ms: 800, p95Ms: 900, meanMs: 820 }, tokens: { input: 100, output: 20, perCase: 20 }, flakiness: 0.5, flakyCases: ["shop/quotes/italy"], errored: 0, complete: true },
  ],
  leaderboard: {
    weights: { quality: 0.7, cost: 0.2, latency: 0.1 }, qualityMetric: "score", paretoFront: ["prod", "draft"],
    notes: ['"Prod" and "Draft": their score differs by 0.02, within the noise (±0.06, about 95%)'],
    entries: [
      { rank: 1, variantId: "draft", label: "Draft", quality: 0.88, qualityStddev: 0.05, qualityError: 0.03, passRate: 0.83, costUsd: 0.01, latencyP50Ms: 800, latencyP95Ms: 900, composite: 0.92, pareto: true, dominatedBy: [], flakiness: 0.5 },
      { rank: 2, variantId: "prod", label: "Prod", quality: 0.9, qualityStddev: 0.02, qualityError: 0.01, passRate: 1, costUsd: 0.05, latencyP50Ms: 1200, latencyP95Ms: 2000, composite: 0.63, pareto: true, dominatedBy: [], flakiness: 0 },
    ],
  },
  matrix: {
    variants: [{ id: "prod", label: "Prod" }, { id: "draft", label: "Draft" }],
    rows: [{ key: "shop/quotes/italy", owner: "shop", suiteId: "quotes", suiteName: "Quotes", caseId: "italy", caseName: "Italy", caseKey: "italy", spread: true,
      cells: { prod: { variantId: "prod", attempts: 3, passed: 3, passRate: 1, score: 0.9, costUsd: 0.02, durationMs: 1200, status: "passed", results: [] }, draft: { variantId: "draft", attempts: 3, passed: 2, passRate: 0.67, score: 0.85, costUsd: 0.005, durationMs: 800, status: "mixed", results: [] } } }],
  },
};
const COMPARISON = {
  key: "shop/quotes/italy", caseName: "Italy", reference: "prod",
  columns: [
    { variantId: "prod", label: "Prod", runId: "sr-1", owner: "shop", repetition: 1, key: "italy", status: "passed", costUsd: 0.02, durationMs: 1200, tokens: { input: 10, output: 5 }, finalText: "It costs 4.99 EUR.",
      toolCalls: [{ name: "rates", args: { country: "IT" }, result: "ok", isError: false, mocked: "mock", diff: "same" }], missingCalls: [], sameAsReference: { tools: true, text: true }, result: result(trace([["rates", { country: "IT" }]], "It costs 4.99 EUR.")) },
    { variantId: "draft", label: "Draft", runId: "sr-2", owner: "shop", repetition: 1, key: "italy", status: "failed", costUsd: 0.005, durationMs: 800, tokens: { input: 10, output: 5 }, finalText: "It costs 5.49 EUR.",
      toolCalls: [{ name: "rates", args: { country: "DE" }, result: "ok", isError: false, mocked: "mock", diff: "changed", argChanges: ["country"] }, { name: "log", args: {}, result: "ok", isError: false, mocked: "stub", diff: "added" }],
      missingCalls: ["notify"], textDiff: [{ op: "same", text: "It costs " }, { op: "del", text: "4.99" }, { op: "add", text: "5.49" }, { op: "same", text: " EUR." }],
      sameAsReference: { tools: false, text: false }, result: result(trace([["rates", { country: "DE" }]], "It costs 5.49 EUR.")) },
  ],
};

let estimate = { runs: 6, cases: 12, realModelCases: 0, costUsd: 0, maxCostUsd: 0, offline: true, unknownPrice: false, realTools: false, cells: [], notes: ["Every case runs offline (scripted model, mocked tools): the benchmark is free."] };
const api = {
  save: vi.fn(async (b: { name: string }) => ({ ...DEF, ...b, id: "new-one", revision: 1 })),
  remove: vi.fn(async () => undefined),
  estimate: vi.fn(async () => estimate),
  run: vi.fn(async () => RUN),
  cancel: vi.fn(async () => RUN),
};
const runApi = { cancel: vi.fn(async () => RUN), compare: vi.fn(async () => COMPARISON) };
let weightsSeen: unknown[] = [];

vi.mock("@polpo-ai/react", () => ({
  useAgents: () => ({ agents: [{ name: "shop" }, { name: "helper" }], teams: [], isLoading: false }),
  useBenchmarks: () => ({ benchmarks: [DEF], runs: [{ ...RUN, leaderboard: REPORT.leaderboard }], isLoading: false, error: null, refetch: async () => undefined, ...api }),
  useBenchmarkRun: (_id: string, w: unknown) => { weightsSeen.push(w); return { report: REPORT, isLoading: false, error: null, refetch: async () => undefined, ...runApi }; },
  useAgentSuites: () => ({ suites: [{ id: "quotes", name: "Quotes", cases: [{ id: "italy" }], datasets: [{ id: "rows", name: "Rows" }] }], runs: [], isLoading: false, error: null }),
  useAgentVersions: () => ({ data: { versions: [{ version: "1.2.0" }] }, isLoading: false, error: null }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { BenchmarksPage } from "../src/pages/benchmarks";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  for (const f of [...Object.values(api), ...Object.values(runApi)]) f.mockClear();
  weightsSeen = [];
  estimate = { ...estimate, realModelCases: 0, costUsd: 0, offline: true, realTools: false };
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

async function render(url = "/benchmarks") {
  await act(async () => root.render(<MemoryRouter initialEntries={[url]}><BenchmarksPage /></MemoryRouter>));
  await flush();
}

test("saved benchmarks and runs; an offline benchmark starts without a cost confirmation", async () => {
  await render();
  expect(q('[data-testid="bench-row"]')!.textContent).toContain("shop/quotes · 2 variant(s): Prod, Draft · ×3");
  expect(q('[data-testid="bench-run-row"]')!.textContent).toContain("best: Draft");
  await click(q('[data-testid="bench-run-open"]'));
  expect(api.estimate).toHaveBeenCalledWith({ benchmarkId: "models" });
  expect(q('[data-testid="bench-estimate"]')!.textContent).toContain("offline: free");
  expect(q('[data-testid="bench-confirm-cost"]')).toBeNull();
  await click(q('[data-testid="bench-start"]'));
  expect(api.run).toHaveBeenCalledWith({ benchmarkId: "models" }, { confirm: false, allowRealTools: false, source: "benchmarks" });
  expect(q('[data-testid="bench-run"]')).toBeTruthy();
});

test("a real model needs the cost accepted; real tools their own confirmation", async () => {
  estimate = { ...estimate, realModelCases: 12, costUsd: 0.12, maxCostUsd: 0.18, offline: false, realTools: true };
  await render();
  await click(q('[data-testid="bench-run-open"]'));
  expect(q('[data-testid="bench-estimate"]')!.textContent).toContain("about $0.12");
  expect((q('[data-testid="bench-start"]') as HTMLButtonElement).disabled).toBe(true);
  await click(q('[data-testid="bench-confirm-cost"]'));
  expect((q('[data-testid="bench-start"]') as HTMLButtonElement).disabled).toBe(true);
  await click(q('[data-testid="bench-confirm-real"]'));
  await click(q('[data-testid="bench-start"]'));
  expect(api.run).toHaveBeenCalledWith({ benchmarkId: "models" }, { confirm: true, allowRealTools: true, source: "benchmarks" });
});

test("a run: leaderboard (Pareto, notes, weights), the matrix, a case side by side with the diffs", async () => {
  await render("/benchmarks?run=br-1");
  const rows = qa('[data-testid="bench-lb-row"]');
  expect(rows.map((r) => r.getAttribute("data-variant"))).toEqual(["draft", "prod"]);
  expect(rows[0].getAttribute("data-pareto")).toBe("true");
  expect(q('[data-testid="bench-notes"]')!.textContent).toContain("within the noise");
  expect(q('[data-testid="bench-variants"]')!.textContent).toContain("pass 100% ± 0%");
  // weights change the leaderboard query
  const slider = q('[data-testid="bench-weight-cost"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "0.5");
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
  expect(weightsSeen.at(-1)).toEqual({ quality: 0.7, cost: 0.5, latency: 0.1 });
  // the matrix: the mixed cell; open the case
  const row = q('[data-testid="bench-matrix-row"]')!;
  expect(row.getAttribute("data-spread")).toBe("true");
  expect(row.querySelector('[data-cell="mixed"]')!.textContent).toContain("2/3");
  await click(row.querySelector('[data-testid="bench-open-case"]') as HTMLElement);
  expect(runApi.compare).toHaveBeenCalledWith("shop/quotes/italy", { variants: ["prod", "draft"] });
  const cols = qa('[data-testid="bench-compare-column"]');
  expect(cols.map((c) => c.getAttribute("data-variant"))).toEqual(["prod", "draft"]);
  expect(cols[1].querySelector('[data-diff="changed"]')!.textContent).toContain("changed country");
  expect(cols[1].querySelector('[data-diff="added"]')!.textContent).toContain("log");
  expect(cols[1].querySelector('[data-diff="missing"]')!.textContent).toContain("notify");
  expect(cols[1].querySelector('[data-diff="del"]')!.textContent).toBe("4.99");
  expect(cols[1].querySelector('[data-diff="add"]')!.textContent).toBe("5.49");
  expect(cols[1].querySelector('[data-testid="bench-tools-differ"]')).toBeTruthy();
  // the traces, drawn like the suite report
  expect(cols[0].querySelector('[data-testid="suite-case-trace"]')!.textContent).toContain("Shipping to Italy?");
});

test("from a suite: the editor is prefilled (production vs draft); save", async () => {
  await render("/benchmarks?new=1&agent=shop&suite=quotes");
  expect(q('[data-testid="bench-editor"]')).toBeTruthy();
  expect(qa('[data-testid="bench-suite-row"]')).toHaveLength(1);
  expect(qa('[data-testid="bench-variant-row"]')).toHaveLength(2);
  await click(q('[data-testid="bench-add-variant"]'));
  expect(qa('[data-testid="bench-variant-row"]')).toHaveLength(3);
  await click(q('[data-testid="bench-editor-save"]'));
  expect(api.save).toHaveBeenCalledTimes(1);
  const [body] = api.save.mock.calls[0] as unknown as [{ suites: unknown[]; variants: Array<{ agent: string; version: string; label?: string }>; repetitions: number; mode: string }];
  expect(body.suites).toEqual([{ agent: "shop", suite: "quotes" }]);
  expect(body.variants.map((v) => `${v.agent}@${v.version}:${v.label}`)).toEqual(["shop@production:Production", "shop@draft:Draft", "shop@production:Variant 3"]);
  expect(body).toMatchObject({ repetitions: 3, mode: "all" });
});
