/**
 * The Playground page (agent suites phase 5): two panes (production and draft, the suite's mocks
 * from ?suite=), type once and send to every pane (the session opened with the panes' toggles and
 * mocks), the exchanges with their cost, latency and tokens, real tools only after a confirmation,
 * "Save as test case" (the proposed case reviewed, then saved into a suite) and "Promote variant"
 * (the draft, after a confirmation).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const exchange = (text: string, mode: string) => ({
  index: 0, message: "Rate to Italy?", at: "", mode, status: "done", costUsd: mode === "all" ? 0 : 0.0042, durationMs: 1500, tokens: { input: 120, output: 30 },
  trace: { input: [{ role: "user", content: "Rate to Italy?" }], turns: [{ index: 0, text, toolCalls: [], mocked: mode === "all", durationMs: 1 }], text, approvals: [], notes: [], usage: { inputTokens: 120, outputTokens: 30, costUsd: 0 }, durationMs: 1500,
    toolCalls: [{ id: "c1", turn: 0, name: "rates", args: { country: "IT" }, result: "4.99", isError: false, mocked: "mock", mockId: "rates", durationMs: 1 }] },
});
let session: Record<string, unknown> | undefined;
const pg = {
  open: vi.fn(async (panes: Array<Record<string, unknown>>) => {
    session = { id: "pg-1", panes: panes.map((p, i) => ({ ...p, id: `pane-${i + 1}` })), exchanges: {}, createdAt: "", updatedAt: "" };
    return session;
  }),
  setPanes: vi.fn(async () => session),
  send: vi.fn(async () => {
    session = { ...session!, exchanges: { "pane-1": [exchange("It is 4.99", "all")], "pane-2": [exchange("4.99 EUR", "tools")] } };
    return {};
  }),
  reset: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  saveCase: vi.fn(async () => ({ case: { id: "rate-to-italy", name: "Rate to Italy?", input: { kind: "chat", message: "Rate to Italy?" }, mode: "all", assertions: [{ type: "tool_called", tool: "rates" }] } })),
  promote: vi.fn(async () => ({ agent: "shop", fields: { model: "smart" }, draftChanged: true })),
};
const accept = vi.fn(async () => ({}));

vi.mock("@polpo-ai/react", () => ({
  useAgents: () => ({ agents: [{ name: "shop" }], teams: [], isLoading: false }),
  usePlayground: () => ({ session, live: {}, sending: false, error: null, ...pg }),
  useAgentSuites: () => ({ suites: [{ id: "quotes", name: "Quotes", cases: [{ id: "italy", name: "Italy" }], datasets: [] }], runs: [], isLoading: false, error: null, accept }),
  useAgentVersions: () => ({ data: { versions: [] }, isLoading: false, error: null }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PlaygroundPage } from "../src/pages/playground";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  for (const f of [...Object.values(pg), accept]) f.mockClear();
  session = undefined;
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
const type = async (el: HTMLElement | null, value: string) => {
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
};
const byText = (text: string, sel = "button") => [...document.body.querySelectorAll(sel)].find((e) => e.textContent?.trim() === text) as HTMLElement | undefined;

async function render(url = "/playground?agent=shop&suite=quotes") {
  await act(async () => root.render(<MemoryRouter initialEntries={[url]}><PlaygroundPage /></MemoryRouter>));
  await flush();
}

test("two panes (production and draft with the suite's mocks); send once to every pane; the exchanges with their metrics", async () => {
  await render();
  expect(qa('[data-testid="pg-pane"]')).toHaveLength(2);
  await type(q('[data-testid="pg-message"]'), "Rate to Italy?");
  await click(q('[data-testid="pg-send-all"]'));
  expect(pg.open).toHaveBeenCalledTimes(1);
  const panes = pg.open.mock.calls[0]![0] as Array<{ label: string; variant: { version: string }; mockTools: boolean; mockModel: boolean; realTools: boolean; mocks?: { suite?: unknown } }>;
  expect(panes.map((p) => [p.label, p.variant.version, p.mockTools, p.mockModel, p.realTools])).toEqual([["Production", "production", true, false, false], ["Draft", "draft", true, false, false]]);
  expect(panes[0].mocks).toEqual({ suite: { agent: "shop", suite: "quotes" } });
  expect(pg.send).toHaveBeenCalledWith("Rate to Italy?", {});
  await render();
  const exchanges = qa('[data-testid="pg-exchange"]');
  expect(exchanges).toHaveLength(2);
  expect(exchanges[1].querySelector('[data-testid="pg-metrics"]')!.textContent).toContain("1.5 s · 150 tokens · 1 tool call(s) · real model");
  expect(qa('[data-testid="pg-pane-totals"]')[0].textContent).toContain("1 exchange(s)");
});

test("real tools: the send asks first, then allows them", async () => {
  await render();
  await click(qa('[data-testid="pg-toggle-real"]')[0]);
  await type(q('[data-testid="pg-message"]'), "Do it for real");
  await click(q('[data-testid="pg-send-all"]'));
  expect(pg.send).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Approvals are never given by a test");
  await click(byText("Send with real tools", '[role="alertdialog"] button, [role="dialog"] button'));
  expect(pg.send).toHaveBeenCalledWith("Do it for real", { allowRealTools: true });
  expect((pg.open.mock.calls[0]![0] as Array<{ realTools: boolean }>)[0].realTools).toBe(true);
});

test("save as test case: propose, review, save into the suite; promote a pane's overrides to the draft", async () => {
  session = { id: "pg-1", panes: [{ id: "pane-1", variant: { agent: "shop", version: "production" }, mockTools: true, mockModel: true, realTools: false }], exchanges: { "pane-1": [exchange("It is 4.99", "all")] }, createdAt: "", updatedAt: "" };
  await render();
  await click(q('[data-testid="pg-save-case"]'));
  expect(q('[data-testid="pg-save-dialog"]')).toBeTruthy();
  await click(q('[data-testid="pg-propose-case"]'));
  expect(pg.saveCase).toHaveBeenCalledWith({ paneId: "pane-1", exchange: 0, mockModel: true });
  expect((q('[data-testid="pg-case-json"]') as HTMLTextAreaElement).value).toContain('"tool_called"');
  // choose the suite (radix select): set through its hidden native select
  const native = q('[data-testid="pg-save-dialog"] select') as HTMLSelectElement | null;
  if (native) {
    await act(async () => { native.value = "quotes"; native.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
  }
  if ((q('[data-testid="pg-save-case-confirm"]') as HTMLButtonElement).disabled) {
    // no native select rendered: open the trigger and pick the item
    await click(q('[data-testid="pg-save-dialog"] [aria-label="Suite"]'));
    await click(byText("Quotes", '[role="option"]'));
  }
  await click(q('[data-testid="pg-save-case-confirm"]'));
  expect(accept).toHaveBeenCalledWith("quotes", [expect.objectContaining({ id: "rate-to-italy", name: "Rate to Italy?" })]);

  // promote: needs overrides; asks; writes the draft
  await type(qa('[aria-label="Model override"]')[0], "smart");
  await click(qa('[data-testid="pg-promote"]')[0]);
  expect(document.body.textContent).toContain("Nothing is deployed");
  await click(byText("Write the draft", '[role="alertdialog"] button, [role="dialog"] button'));
  expect(pg.promote).toHaveBeenCalledWith({ agent: "shop", version: "production", overrides: { model: "smart" } });
});
