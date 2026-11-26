/**
 * The agent page's Suites tab: suites with their last run, Run (offline at once; real tools only
 * after a confirmation, then allowRealTools), the run report (a failed assertion's diff, the case's
 * trace drawn as a chat with the mock that answered), and the editor (add an assertion, save with
 * the revision, the JSON view).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const CONTRACT = {
  id: "shipping", agent: "shop", name: "Shipping rates", defaultMode: "all", target: { kind: "agent" }, revision: 3, createdAt: "", updatedAt: "",
  cases: [{ id: "quote-it", name: "Quote IT", input: { kind: "chat", message: "Shipping to Italy?" }, mocks: { model: { turns: [{ text: "4.99" }] } }, assertions: [] }],
  datasets: [{ id: "countries", name: "Countries", columns: ["country"], rows: [{ country: "IT" }, { country: "FR" }] }],
};
const LIVE = { ...CONTRACT, id: "live", name: "Live checks", defaultMode: "none", cases: [{ ...CONTRACT.cases[0], mocks: undefined }] };
const RUN = {
  id: "sr-1", agent: "shop", suiteId: "shipping", suiteName: "Shipping rates", suiteRevision: 3, target: "production", version: "1.2.0", trigger: "manual",
  variant: { id: "shop@production", agent: "shop", version: "production" }, status: "failed", startedAt: "2026-11-25T10:00:00.000Z", finishedAt: "2026-11-25T10:00:01.000Z",
  planned: ["quote-it"], notes: [],
  stats: { total: 1, passed: 0, failed: 1, errored: 0, skipped: 0, passRate: 0, costUsd: 0, durationMs: 40, inputTokens: 0, outputTokens: 0, turns: 2, toolCalls: 1 },
  results: [{
    key: "quote-it", caseId: "quote-it", caseName: "Quote IT", status: "failed", mode: "all", engine: "native", startedAt: "", durationMs: 40, costUsd: 0, variantId: "shop@production",
    assertions: [{ assertion: { type: "tool_called", tool: "mcp__printful__shipping_rates" }, description: "mcp__printful__shipping_rates called with partial args", passed: false,
      message: "called 1×, never with the expected arguments", diff: '--- expected\n+++ actual\n-  "country": "DE"\n+  "country": "IT"' }],
    trace: {
      input: [{ role: "user", content: "Shipping to Italy?" }], text: "Standard shipping costs 4.99 EUR.", approvals: [], notes: ["The model script ended after 2 turn(s)"],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, durationMs: 40, finishReason: "stop",
      turns: [{ index: 0, text: "", toolCalls: [{ id: "c1", name: "mcp__printful__shipping_rates", args: { country: "IT" } }], mocked: true, durationMs: 0 }, { index: 1, text: "Standard shipping costs 4.99 EUR.", toolCalls: [], mocked: true, durationMs: 0 }],
      toolCalls: [{ id: "c1", turn: 0, name: "mcp__printful__shipping_rates", args: { country: "IT" }, result: '{"rate":"4.99"}', isError: false, mocked: "mock", mockId: "rates", durationMs: 0 }],
    },
  }],
};
const api = {
  run: vi.fn(async () => RUN),
  save: vi.fn(async (s: { name: string }) => ({ ...CONTRACT, ...s, id: "new-suite", revision: 1 })),
  remove: vi.fn(async () => undefined),
  cancel: vi.fn(async () => RUN),
  importDataset: vi.fn(async () => CONTRACT),
  yaml: vi.fn(async () => ({ yaml: "name: Shipping rates\n", revision: 3 })),
};

vi.mock("@polpo-ai/react", () => ({
  useAgentSuites: () => ({ suites: [CONTRACT, LIVE], runs: [RUN], isLoading: false, error: null, refetch: async () => undefined, ...api }),
  useAgentSuiteRun: () => ({ run: RUN, isLoading: false, error: null, refetch: async () => undefined }),
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
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => [...document.body.querySelectorAll(sel)] as HTMLElement[];
const byText = (text: string, sel = "button") => [...document.body.querySelectorAll(sel)].find((e) => e.textContent?.trim() === text) as HTMLElement | undefined;
const click = async (el: HTMLElement | null | undefined) => { await act(async () => { el!.click(); }); await flush(); };
const row = (id: string) => q(`[data-testid="suite-row"][data-suite="${id}"]`)!;

async function render() {
  await act(async () => root.render(<MemoryRouter><AgentSuitesTab /></MemoryRouter>));
  await flush();
}

test("suites with their last run; an offline suite runs at once and its report opens", async () => {
  await render();
  expect(qa('[data-testid="suite-row"]').map((e) => e.getAttribute("data-suite"))).toEqual(["shipping", "live"]);
  expect(row("shipping").textContent).toContain("1 case(s) · 1 dataset(s) · Contract (offline) · last failed 0/1 (production · v1.2.0)");
  expect(row("live").textContent).toContain("never run");
  await click(row("shipping").querySelector('[data-testid="suite-run"]') as HTMLElement);
  expect(api.run).toHaveBeenCalledWith("shipping", {});
  expect(q('[data-testid="suite-run-report"]')!.getAttribute("data-status")).toBe("failed");
});

test("a run with real tools asks first, then confirms allowRealTools", async () => {
  await render();
  await click(row("live").querySelector('[data-testid="suite-run"]') as HTMLElement);
  expect(api.run).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Approvals are never given by a test");
  await click(byText("Run with real tools", '[role="alertdialog"] button, [role="dialog"] button'));
  expect(api.run).toHaveBeenCalledWith("live", { allowRealTools: true });
});

test("the report: failed assertion with its diff, the trace as a chat with the mock that answered", async () => {
  await render();
  await click(q('[data-testid="suite-run-row"]'));
  const result = q('[data-testid="suite-case-result"]')!;
  expect(result.getAttribute("data-status")).toBe("failed");
  expect(q('[data-testid="suite-assertion"]')!.getAttribute("data-passed")).toBe("false");
  expect(q('[data-testid="suite-assertion-diff"]')!.textContent).toContain('+  "country": "IT"');
  const trace = q('[data-testid="suite-case-trace"]')!;
  expect(trace.textContent).toContain("Shipping to Italy?");
  expect(trace.textContent).toContain("Standard shipping costs 4.99 EUR.");
  expect(trace.textContent).toContain("mcp__printful__shipping_rates (mock)");
  expect(trace.textContent).toContain("The model script ended");
});

test("the editor: add an assertion and save with the revision; the JSON view", async () => {
  await render();
  await click(row("shipping").querySelector("button") as HTMLElement);
  expect(q('[data-testid="suite-editor"]')).toBeTruthy();
  expect(qa('[data-testid="suite-case-form"]')).toHaveLength(1);
  await click(q('[data-testid="suite-add-assertion"]'));
  expect(qa('[data-testid="suite-assertion-form"]')).toHaveLength(1);
  await click(q('[data-testid="suite-save"]'));
  expect(api.save).toHaveBeenCalledTimes(1);
  const [body, opts] = api.save.mock.calls[0] as unknown as [{ cases: Array<{ assertions: Array<{ type: string }> }>; revision?: number }, { id: string; revision: number }];
  expect(opts).toEqual({ id: "shipping", revision: 3 });
  expect(body.cases[0]!.assertions).toEqual([{ type: "tool_called", tool: "", args: {} }]);
  expect(body.revision).toBeUndefined();
  await click(q('[data-testid="suite-view-json"]'));
  expect((q('[data-testid="suite-json"]') as HTMLTextAreaElement).value).toContain('"name": "Shipping rates"');
  await click(q('[data-testid="suite-view-datasets"]'));
  expect(q('[data-testid="suite-datasets"]')!.textContent).toContain("Countries countries · 2 rows");
});
