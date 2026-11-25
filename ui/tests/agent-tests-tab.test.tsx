/**
 * The agent page's Tests tab: each check's ✓ / ⚠ / ✗ with its problems and fixes (a link, or the
 * one-click "grant access" that re-runs the check), Run all, Run one, the smoke run and "Start and
 * test" only after a confirmation, and the history (a past run opens).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const RUN = {
  id: "r2", agent: "shop", target: "production", version: "1.2.0", status: "fail", startedAt: "2026-11-25T10:00:00.000Z", finishedAt: "2026-11-25T10:00:02.000Z",
  checks: [
    { id: "engine", title: "Engine & model", status: "pass", summary: "anthropic:claude-haiku-4-5 answered in 120 ms", durationMs: 130, items: [{ label: "Polpo engine · anthropic:claude-haiku-4-5", status: "pass", detail: "Answered in 120 ms" }], data: { model: "anthropic:claude-haiku-4-5", latencyMs: 120 } },
    { id: "tools", title: "Tools", status: "warn", summary: "1 built-in tools allowed", durationMs: 1, items: [
      { label: "read", status: "pass", detail: "Loads" },
      { label: "reed", status: "warn", detail: "Unknown tool name", fix: { label: "Edit tools", href: "/agents/shop?tab=tools" } },
    ] },
    { id: "connectors", title: "Connectors", status: "fail", summary: "1 failed", durationMs: 2, items: [
      { label: "Printful (mcp__printful__*)", status: "fail", detail: "access does not include shop", fix: { label: "Grant shop access", action: { type: "grant-connector-access", connector: "printful" } } },
    ] },
    { id: "computer", title: "Computer & sandbox", status: "warn", summary: "1 warning", durationMs: 2, items: [{ label: "Computer box (daytona)", status: "warn", detail: "stopped" }], data: { computer: "box", status: "stopped", canStart: true } },
  ],
};
const OLD = { ...RUN, id: "r1", status: "pass", target: "draft", version: undefined, startedAt: "2026-11-24T09:00:00.000Z", checks: [
  { id: "tools", title: "Tools", status: "pass", summary: "all fine back then", durationMs: 1, items: [] },
] };
const api = {
  runAll: vi.fn(async () => RUN),
  runOne: vi.fn(async () => RUN),
  fix: vi.fn(async () => ({ message: "Printful now grants shop" })),
};

vi.mock("@polpo-ai/react", () => ({
  useAgentTests: () => ({ history: [RUN, OLD], latest: RUN, isLoading: false, running: null, error: null, refetch: async () => undefined, ...api }),
  useAgentVersions: () => ({ data: { state: {}, versions: [{ version: "1.2.0" }, { version: "1.1.0" }] }, isLoading: false, error: null }),
}));
vi.mock("../src/components/agents/agent-detail-context", () => ({
  useAgentDetail: () => ({ meta: { agentName: "shop" }, actions: { refetch: async () => undefined } }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AgentTestsTab } from "../src/components/agents/agent-tests-tab";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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
const byText = (text: string | RegExp, sel = "button") => [...document.body.querySelectorAll(sel)].find((e) => (typeof text === "string" ? e.textContent?.trim() === text : text.test(e.textContent ?? ""))) as HTMLElement | undefined;
const click = async (el: HTMLElement | null | undefined) => { await act(async () => { el!.click(); }); await flush(); };
const check = (id: string) => q(`[data-testid="test-check"][data-check="${id}"]`)!;

async function render() {
  await act(async () => root.render(<MemoryRouter><AgentTestsTab /></MemoryRouter>));
  await flush();
}

test("every check with its status; problems shown with their fixes; checks never run say so", async () => {
  await render();
  expect(qa('[data-testid="test-check"]').map((e) => [e.getAttribute("data-check"), e.getAttribute("data-status")])).toEqual([
    ["engine", "pass"], ["tools", "warn"], ["connectors", "fail"], ["vault", "none"], ["skills", "none"], ["computer", "warn"], ["channels", "none"], ["versioning", "none"], ["smoke", "none"],
  ]);
  expect(check("engine").textContent).toContain("answered in 120 ms");
  // only the problems are listed until the row is opened
  expect(check("tools").querySelectorAll('[data-testid="test-item"]')).toHaveLength(1);
  expect(check("tools").querySelector('[data-testid="test-fix-link"]')!.getAttribute("href")).toBe("/agents/shop?tab=tools");
  await click(check("tools").querySelector("button[aria-expanded]") as HTMLElement);
  expect(check("tools").querySelectorAll('[data-testid="test-item"]')).toHaveLength(2);
  expect(q('[aria-label="Checks"]')!.textContent).toContain("production · v1.2.0");
});

test("Run all, Run one, and the one-click fix that re-runs its check", async () => {
  await render();
  await click(q('[data-testid="run-all"]'));
  expect(api.runAll).toHaveBeenCalledWith({});
  await click(q('[data-testid="run-vault"]'));
  expect(api.runOne).toHaveBeenCalledWith("vault", {});
  await click(check("connectors").querySelector('[data-testid="test-fix"]') as HTMLElement);
  expect(api.fix).toHaveBeenCalledWith({ type: "grant-connector-access", connector: "printful" }, "connectors");
});

test("the smoke run and starting a stopped computer ask first", async () => {
  await render();
  await click(q('[data-testid="run-smoke"]'));
  expect(api.runOne).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("It costs a few tokens");
  await click(byText("Run it"));
  expect(api.runOne).toHaveBeenCalledWith("smoke", {});

  await click(q('[data-testid="start-and-test"]'));
  expect(document.body.textContent).toContain("may cost while it runs");
  await click(byText("Start and test", '[role="alertdialog"] button, [role="dialog"] button'));
  expect(api.runOne).toHaveBeenLastCalledWith("computer", { startComputer: true });
});

test("history: each run with its target; a past run opens instead of the latest", async () => {
  await render();
  const rows = qa('[data-testid="history-row"]');
  expect(rows).toHaveLength(2);
  expect(rows[1]!.textContent).toContain("draft");
  expect(rows[1]!.textContent).toContain("all good");
  await click(rows[1]);
  expect(check("tools").getAttribute("data-status")).toBe("pass");
  expect(check("tools").textContent).toContain("all fine back then");
  expect(check("connectors").getAttribute("data-status")).toBe("none");
  await click(byText("Back to latest"));
  expect(check("connectors").getAttribute("data-status")).toBe("fail");
});
