/**
 * The agent page scrolls as one: on desktop the right column is the single scroll container (the
 * activity strip scrolls away, the tab bar sticks to its top with the page background), every tab
 * panel is plain flow content inside it — no nested ScrollArea, no overflow-hidden ancestor that
 * would clip a long tab (the Tests tab used to be cut off) — and the left column scrolls on its own,
 * vertically only, with long social URLs truncated (whole value on hover). Deep links (?tab=) still
 * open their tab, and switching tabs after scrolling down starts the new tab at its top.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { AgentDetailContext, type AgentDetailContextValue } from "../src/components/agents/agent-detail-context";

const LONG_URL = "https://www.linkedin.com/in/a-very-long-profile-handle-that-would-never-fit-in-the-sidebar-0123456789/";
const many = <T,>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i));

const RUN = {
  id: "r1", agent: "alessio", target: "production", status: "warn", startedAt: "2026-11-25T10:00:00.000Z", finishedAt: "2026-11-25T10:00:02.000Z",
  checks: [{ id: "tools", title: "Tools", status: "warn", summary: "many warnings", durationMs: 1,
    items: many(40, (i) => ({ label: `tool-${i}`, status: "warn", detail: `Unknown tool name ${i}` })) }],
};
const HISTORY = many(30, (i) => ({ ...RUN, id: `r${i}`, startedAt: `2026-11-${String(1 + (i % 24)).padStart(2, "0")}T10:00:00.000Z` }));
const VERSIONS = many(40, (i) => ({ agent: "alessio", version: `1.${i}.0`, author: "person:ada@example.com", createdAt: "2026-11-20T10:00:00.000Z", note: `Change ${i}`, bump: "minor", changes: [], changedFields: ["systemPrompt"] }));
const DEPLOYS = many(40, (i) => ({ id: `d${i}`, agent: "alessio", pointer: "production", to: `1.${i}.0`, action: "deploy", actor: "person:ada@example.com", at: "2026-11-20T11:00:00.000Z" }));

vi.mock("@polpo-ai/react", () => ({
  useAgentTests: () => ({ history: HISTORY, latest: RUN, isLoading: false, running: null, error: null, refetch: async () => undefined,
    runAll: vi.fn(), runOne: vi.fn(), fix: vi.fn() }),
  useAgentVersions: () => ({
    data: { state: { agent: "alessio", production: "1.39.0", latest: "1.39.0", pointers: { production: "1.39.0" }, versions: 40,
      draft: { exists: false, hasChanges: false, changes: [], changedFields: [] } }, versions: VERSIONS },
    isLoading: false, error: null, refetch: async () => undefined,
    diff: vi.fn(async () => ({ changes: [], unified: "" })), get: vi.fn(), publish: vi.fn(), discardDraft: vi.fn(), rebaseDraft: vi.fn(),
  }),
  useAgentDeploys: () => ({ data: DEPLOYS, isLoading: false, error: null, refetch: async () => undefined, deploy: vi.fn(), rollback: vi.fn(), get: vi.fn() }),
  useAgentDeployGates: () => ({ data: [], pending: undefined, isLoading: false, error: null, refetch: async () => undefined, get: vi.fn(), cancel: vi.fn(), override: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../src/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => <div data-testid="prompt">{children}</div>,
}));
// Heavy pieces this test is not about.
vi.mock("../src/components/shared/model-with-engine", () => ({ AgentModelWithEngine: () => <span>model</span> }));
vi.mock("../src/components/shared/agent-avatar", () => ({ AgentAvatar: () => <span>avatar</span> }));
vi.mock("../src/components/agents/agent-hero-card", () => ({ AgentHeroCard: () => <div>hero</div> }));
vi.mock("../src/components/agents/agent-hierarchy-card", () => ({ AgentHierarchyCard: () => <div>hierarchy</div> }));
vi.mock("../src/components/agents/agent-performance-card", () => ({ AgentPerformanceCard: () => <div>performance</div> }));
vi.mock("../src/components/agents/live-activity", () => ({ LiveActivity: () => null }));
for (const [path, name] of [
  ["agent-overview-tab", "AgentOverviewTab"], ["agent-tools-tab", "AgentToolsTab"], ["agent-credentials-tab", "AgentCredentialsTab"],
  ["agent-memory-tab", "AgentMemoryTab"], ["agent-learning-tab", "AgentLearningTab"], ["agent-drive-tab", "AgentDriveTab"],
  ["agent-computer-tab", "AgentComputerTab"], ["agent-sandbox-tab", "AgentSandboxTab"], ["agent-config-tab", "AgentConfigTab"],
] as const) {
  vi.doMock(`../src/components/agents/${path}`, () => ({ [name]: () => <div data-testid={`stub-${path}`}>{name}</div> }));
}

const TASKS = many(60, (i) => ({ id: `t${i}`, title: `Task number ${i}`, status: "done", group: "g", updatedAt: "2026-11-24T10:00:00.000Z", assignTo: "alessio" }));
const ctx = {
  state: {
    agent: {
      name: "alessio", allowedTools: ["read"], skills: [],
      systemPrompt: many(400, (i) => `Line ${i} of a very long system prompt.`).join("\n"),
      identity: { displayName: "Alessio", socials: { linkedin: LONG_URL, x: "@alessio" } },
    },
    isLoading: false, isRefreshing: false, error: null, process: undefined, subordinates: [], manager: null,
    taskStats: { done: 60, failed: 0, active: 0, pending: 0, total: 60, successRate: 1, avgScore: null },
    sortedTasks: TASKS, skillPool: new Map(), vaultEntries: [], agentAllowedTools: ["read"], enabledCategories: [],
    teamName: null, teamColorIndex: 0,
  },
  actions: { refetch: async () => undefined, refetchVault: async () => undefined },
  meta: { agentName: "alessio" },
} as unknown as AgentDetailContextValue;
vi.mock("../src/components/agents/agent-detail-provider", () => ({
  AgentDetailProvider: ({ children }: { children: React.ReactNode }) => <AgentDetailContext value={ctx}>{children}</AgentDetailContext>,
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const cls = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);
const scrolls = (el: Element) => cls(el).some((c) => /^overflow(-y)?-(auto|scroll)$/.test(c)) || el.getAttribute("data-slot") === "scroll-area";
const bounded = (el: Element) => cls(el).some((c) => /^max-h-/.test(c) || /^h-\[/.test(c));

async function render(tab: string) {
  const { AgentDetailPage } = await import("../src/pages/agent-detail");
  await act(async () => root.render(
    <MemoryRouter initialEntries={[`/agents/alessio?tab=${tab}`]}>
      <TooltipProvider><AgentDetailPage /></TooltipProvider>
    </MemoryRouter>,
  ));
  await flush();
}

test.each([
  ["tests", '[data-testid="agent-tests"]'],
  ["versions", '[data-testid="agent-versions"]'],
  ["instructions", '[data-testid="prompt"]'],
  ["tasks", 'a[href="/tasks/t59"]'],
])("the %s tab (deep link) is flow content in the column's single scroll container", async (tab, marker) => {
  await render(tab);
  const scroller = q('[data-testid="agent-detail-scroll"]')!;
  expect(scroller).not.toBeNull();
  expect(cls(scroller)).toContain("overflow-y-auto");
  expect(cls(scroller)).toContain("overflow-x-hidden");

  // the deep-linked tab is the one shown, with its long content all rendered
  const panel = q('[role="tabpanel"][data-state="active"]')!;
  expect(panel.id).toContain(tab);
  expect(panel.querySelector(marker)).not.toBeNull();

  // from the panel up to the scroll container: nothing clips it and nothing else scrolls
  for (let el = panel.parentElement; el && el !== scroller; el = el.parentElement) {
    expect(cls(el)).not.toContain("overflow-hidden");
    expect(scrolls(el)).toBe(false);
  }
  // inside the panel: no nested scroller, except the bounded ones (a diff, a JSON view…)
  const nested = [...panel.querySelectorAll("*")].filter(scrolls);
  expect(nested.filter((el) => !bounded(el))).toEqual([]);
  expect(panel.querySelector('[data-slot="scroll-area"]')).toBeNull();

  // the tab bar sticks to the top of that same container, on the page background
  const bar = q('[data-testid="agent-detail-tabbar"]')!;
  expect(bar.querySelector('[role="tablist"]')).not.toBeNull();
  expect(cls(bar)).toEqual(expect.arrayContaining(["sticky", "top-0", "bg-background"]));
  expect(scroller.contains(bar)).toBe(true);
  for (let el = bar.parentElement; el && el !== scroller; el = el.parentElement) expect(scrolls(el)).toBe(false);
});

test("the left column scrolls vertically only and long social URLs are truncated with the whole value on hover", async () => {
  await render("overview");
  const sidebar = q('[data-testid="agent-detail-sidebar"]')!;
  expect(cls(sidebar)).toEqual(expect.arrayContaining(["overflow-y-auto", "overflow-x-hidden", "min-h-0"]));
  expect(cls(sidebar)).not.toContain("overflow-auto");

  const handles = [...sidebar.querySelectorAll('[data-testid="agent-social-handle"]')] as HTMLElement[];
  // a URL is shown without its scheme and opens the profile
  const linkedin = handles.find((h) => h.textContent === LONG_URL.replace("https://www.", "").replace(/\/$/, ""))!;
  expect(linkedin).toBeDefined();
  expect(linkedin.closest("a")?.getAttribute("href")).toBe(LONG_URL);
  expect(cls(linkedin)).toEqual(expect.arrayContaining(["truncate", "min-w-0"]));
  const badge = linkedin.closest('[data-slot="badge"]')!;
  expect(badge.getAttribute("title")).toBe(`linkedin: ${LONG_URL}`);
  expect(cls(badge)).toEqual(expect.arrayContaining(["max-w-full", "min-w-0"]));
});

test("switching tabs after scrolling past the tab bar starts the new tab at its top; ?tab= follows", async () => {
  await render("tasks");
  const scroller = q('[data-testid="agent-detail-scroll"]')!;
  const tabsRoot = q('[data-testid="agent-detail-tabbar"]')!.parentElement!;
  scroller.scrollTop = 900;
  scroller.getBoundingClientRect = () => ({ top: 100 } as DOMRect);
  tabsRoot.getBoundingClientRect = () => ({ top: -500 } as DOMRect); // scrolled 600px past the tab bar

  const trigger = q('[role="tab"][id$="trigger-tests"]')!;
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  });
  await flush();
  expect(q('[role="tabpanel"][data-state="active"]')!.id).toContain("tests");
  expect(scroller.scrollTop).toBe(300);
});

test("no agent tab wraps itself in its own full-height scroller (only the memory editor scrolls inside, bounded)", async () => {
  const sources = import.meta.glob("../src/components/agents/agent-*-tab.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const tabs = Object.keys(sources).map((p) => p.split("/").pop()!);
  expect(tabs.length).toBeGreaterThanOrEqual(13);
  for (const [path, src] of Object.entries(sources)) {
    const f = path.split("/").pop()!;
    expect([f, /<ScrollArea className="h-full">/.test(src)]).toEqual([f, f === "agent-memory-tab.tsx"]);
    expect([f, /className="[^"]*\boverflow-auto\b[^"]*pb-bottom-nav/.test(src)]).toEqual([f, false]);
  }
  const memory = sources["../src/components/agents/agent-memory-tab.tsx"];
  expect(memory).toMatch(/data-testid="agent-memory-editor"/);
  expect(memory).toMatch(/className="flex h-\[70dvh\] min-h-80 flex-col overflow-hidden"/);
});
