/**
 * The Suites tab and deploy gates: required suites carry a Required badge, gate runs are marked
 * (deploy gate / publish check with their decision), and the editor's Gate view saves the gate
 * (required, minimum pass rate, max regression, on publish).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const BASE = {
  agent: "shop", defaultMode: "all", target: { kind: "agent" }, createdAt: "", updatedAt: "", datasets: [],
  cases: [{ id: "quote", name: "Quote", input: { kind: "chat", message: "Shipping?" }, mocks: { model: { turns: [{ text: "4.99" }] } }, assertions: [] }],
};
const REQUIRED = { ...BASE, id: "shipping", name: "Shipping rates", revision: 2, gate: { required: true, minPassRate: 0.9, onPublish: true } };
const PLAIN = { ...BASE, id: "tone", name: "Tone", revision: 1 };
const GATE_RUN = {
  id: "sr-g", agent: "shop", suiteId: "shipping", suiteName: "Shipping rates", suiteRevision: 2, target: "1.3.0", version: "1.3.0", trigger: "deploy",
  gate: { decision: "fail", reason: "pass rate 0% < 90%", gateId: "g1" },
  variant: { id: "shop@1.3.0", agent: "shop", version: "1.3.0" }, status: "failed", startedAt: "2026-11-25T10:00:00.000Z", planned: ["quote"], notes: [], results: [],
  stats: { total: 1, passed: 0, failed: 1, errored: 0, skipped: 0, passRate: 0, costUsd: 0, durationMs: 10, inputTokens: 0, outputTokens: 0, turns: 1, toolCalls: 0 },
};
const api = vi.hoisted(() => ({
  run: vi.fn(), remove: vi.fn(), cancel: vi.fn(), importDataset: vi.fn(), yaml: vi.fn(),
  save: vi.fn(async (s: { name: string }) => ({ ...s, id: "shipping", revision: 3 })),
}));

vi.mock("@polpo-ai/react", () => ({
  useAgentSuites: () => ({ suites: [REQUIRED, PLAIN], runs: [GATE_RUN], isLoading: false, error: null, refetch: async () => undefined, ...api }),
  useAgentSuiteRun: () => ({ run: undefined, isLoading: true, error: null, refetch: async () => undefined }),
  useAgentVersions: () => ({ data: { state: {}, versions: [] }, isLoading: false, error: null }),
}));
vi.mock("../src/components/agents/agent-detail-context", () => ({
  useAgentDetail: () => ({ meta: { agentName: "shop" }, actions: { refetch: async () => undefined } }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { AgentSuitesTab } from "../src/components/agents/agent-suites-tab";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api.save.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const click = async (el: HTMLElement | null | undefined) => { await act(async () => { el!.click(); }); await flush(); };
const row = (id: string) => q(`[data-testid="suite-row"][data-suite="${id}"]`)!;

test("required suites are marked; gate runs say which gate and its decision", async () => {
  await act(async () => root.render(<MemoryRouter><AgentSuitesTab /></MemoryRouter>));
  await flush();
  const badge = row("shipping").querySelector('[data-testid="suite-required"]')!;
  expect(badge.textContent).toContain("Required");
  expect(badge.getAttribute("title")).toBe("Required to deploy: pass rate ≥ 90%, also on publish");
  expect(row("tone").querySelector('[data-testid="suite-required"]')).toBeNull();
  expect(q('[data-testid="suite-run-row-gate"]')!.textContent).toBe("Deploy gate · fail");
});

test("the Gate view saves the gate with the suite", async () => {
  await act(async () => root.render(<MemoryRouter><AgentSuitesTab /></MemoryRouter>));
  await flush();
  await click(row("tone").querySelector("button") as HTMLElement);
  await click(q('[data-testid="suite-view-gate"]'));
  const gate = q('[data-testid="suite-gate"]')!;
  await click(gate.querySelector('[data-testid="suite-gate-required"]') as HTMLElement);
  const input = gate.querySelector('input[aria-label="Maximum regression"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "0.05");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(gate.querySelector('[data-testid="suite-gate-on-publish"]') as HTMLElement);
  await click(q('[data-testid="suite-save"]'));
  const [body] = api.save.mock.calls[0] as unknown as [{ gate: unknown }];
  expect(body.gate).toEqual({ required: true, maxRegression: 0.05, onPublish: true });
});
