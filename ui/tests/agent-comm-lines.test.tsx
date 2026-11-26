/**
 * Communication lines in the dashboard: the agent's Communication section (hint for agents from
 * before the lines, lines and extra agents, the preview, saving through the agent update) and the
 * org chart's lines overlay (a toggle, off by default, remembered per viewer).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

type Agent = { name: string; reportsTo?: string; talksTo?: { mode: string; agents?: string[]; acceptFrom?: string }; identity?: { displayName?: string } };

const state = vi.hoisted(() => ({
  agents: [] as Agent[],
  agent: { name: "dev" } as Agent,
  updates: [] as Array<{ name: string; req: unknown }>,
  refetched: 0,
  chart: undefined as unknown,
  /** The agents page's state: stable between renders, as the real provider's. */
  page: undefined as unknown,
}));

vi.mock("@polpo-ai/react", () => ({
  useAgents: () => ({
    agents: state.agents,
    updateAgent: async (name: string, req: unknown) => { state.updates.push({ name, req }); return { name }; },
  }),
  useAgentLines: () => ({ chart: state.chart, isLoading: false, error: null, refetch: async () => {} }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../src/components/agents/agent-detail-context", () => ({
  useAgentDetail: () => ({
    state: { agent: state.agent },
    actions: { refetch: async () => { state.refetched += 1; } },
    meta: { agentName: state.agent.name },
  }),
}));
vi.mock("../src/components/agents/agents-page-context", () => ({
  useAgentsPage: () => state.page,
}));

import { AgentCommunicationSection } from "../src/components/agents/agent-communication-section";
import {
  OrgChartView, SHOW_LINES_KEY, communicationLineEdges, readShowLines, writeShowLines,
} from "../src/components/agents/agents-org-chart";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  state.updates = [];
  state.refetched = 0;
  state.chart = undefined;
  try { localStorage.clear(); } catch { /* none */ }
  state.agents = [
    { name: "cto", talksTo: { mode: "org" } },
    { name: "dev", reportsTo: "cto" },
    { name: "qa", reportsTo: "cto", talksTo: { mode: "org" } },
    { name: "writer", talksTo: { mode: "org" } },
  ];
  state.page = { state: { agents: state.agents, teams: [{ name: "eng", agents: state.agents }], processes: [] } };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); });
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const byText = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent?.trim() === text);
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); await flush(); };

async function renderSection(agent: Agent) {
  state.agent = agent;
  state.agents = state.agents.map((a) => (a.name === agent.name ? agent : a));
  await act(async () => root.render(<MemoryRouter><AgentCommunicationSection /></MemoryRouter>));
  await flush();
}

describe("the agent's Communication section", () => {
  test("an agent from before the lines: a hint to restrict it, one click to org chart lines", async () => {
    await renderSection({ name: "dev", reportsTo: "cto" });
    expect($('[data-testid="lines-unrestricted"]')?.textContent).toMatch(/can talk to any agent/);
    expect($('[data-testid="lines-preview"]')?.textContent).toMatch(/Any agent/);
    await click(byText("Use org chart lines"));
    expect(state.updates).toEqual([{ name: "dev", req: { talksTo: { mode: "org" } } }]);
    expect(state.refetched).toBe(1);
  });

  test("org lines: no hint; the preview shows its manager (and Polpo); extra agents are added and saved with the manager", async () => {
    await renderSection({ name: "dev", reportsTo: "cto", talksTo: { mode: "org" } });
    expect($('[data-testid="lines-unrestricted"]')).toBeNull();
    const preview = () => $('[data-testid="lines-preview"]')!.textContent;
    expect(preview()).toMatch(/Talks to now/);
    expect(preview()).toMatch(/cto/);
    expect(preview()).not.toMatch(/writer/);
    expect(preview()).toMatch(/Polpo/);
    const chip = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="lines-agents"] button')].find((b) => b.textContent === "writer");
    expect(chip?.getAttribute("aria-pressed")).toBe("false");
    await click(chip);
    expect(chip?.getAttribute("aria-pressed")).toBe("true");
    expect(preview()).toMatch(/Would talk to/);
    expect(preview()).toMatch(/writer/);
    await click(byText("Save"));
    expect(state.updates).toEqual([{ name: "dev", req: { talksTo: { mode: "org", agents: ["writer"] }, reportsTo: "cto" } }]);
  });

  test("accept only its lines is a switch saved as acceptFrom", async () => {
    await renderSection({ name: "dev", reportsTo: "cto", talksTo: { mode: "list", agents: ["qa"] } });
    expect($('[data-testid="lines-preview"]')!.textContent).toMatch(/qa/);
    await click($('button[aria-label="Accept only its lines"]'));
    await click(byText("Save"));
    expect(state.updates[0]!.req).toEqual({ talksTo: { mode: "list", agents: ["qa"], acceptFrom: "lines" }, reportsTo: "cto" });
  });
});

describe("the org chart's communication lines overlay", () => {
  const chart = {
    agents: [
      { agent: "cto", mode: "org", explicit: true, reports: ["dev", "qa"], agents: [], acceptFrom: "anyone", reachable: ["dev", "qa"] },
      { agent: "dev", mode: "anyone", explicit: false, manager: "cto", reports: [], agents: [], acceptFrom: "anyone", reachable: ["cto", "qa", "writer"] },
      { agent: "qa", mode: "org", explicit: true, manager: "cto", reports: [], agents: [], acceptFrom: "anyone", reachable: ["cto"] },
      { agent: "writer", mode: "org", explicit: true, reports: [], agents: [], acceptFrom: "anyone", reachable: [] },
    ],
    edges: [
      { from: "cto", to: "dev", kind: "report" }, { from: "cto", to: "qa", kind: "report" },
      { from: "dev", to: "cto", kind: "open" }, { from: "dev", to: "qa", kind: "open" }, { from: "dev", to: "writer", kind: "open" },
      { from: "qa", to: "cto", kind: "manager" },
    ],
    unrestricted: ["dev"],
  };

  test("one edge per pair (arrows both ways when both may talk); agents that talk to anyone get none; only agents on the chart", () => {
    const edges = communicationLineEdges(chart as never, new Set(["cto", "dev", "qa", "writer"]));
    expect(edges.map((e) => [e.source, e.target, !!e.markerStart])).toEqual([["cto", "dev", false], ["cto", "qa", true]]);
    expect(communicationLineEdges(chart as never, new Set(["cto", "dev"])).map((e) => e.id)).toEqual(["line-cto~dev"]);
  });

  test("the viewer's choice is remembered, and a browser without storage just keeps it off", () => {
    expect(readShowLines()).toBe(false);
    writeShowLines(true);
    expect(localStorage.getItem(SHOW_LINES_KEY)).toBe("1");
    expect(readShowLines()).toBe(true);
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(readShowLines()).toBe(false);
    expect(() => writeShowLines(true)).not.toThrow();
  });

  test("off by default: the org chart only; the toggle shows the lines (legend, node badges) and is remembered", async () => {
    state.chart = chart;
    await act(async () => root.render(<MemoryRouter><OrgChartView /></MemoryRouter>));
    await flush();
    const toggle = $('[data-testid="toggle-communication-lines"]')!;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect($('[data-testid="communication-lines-legend"]')).toBeNull();
    expect(document.querySelectorAll('[data-testid="agent-node-lines"]')).toHaveLength(0);
    await click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem(SHOW_LINES_KEY)).toBe("1");
    expect($('[data-testid="communication-lines-legend"]')?.textContent).toMatch(/1 agent not restricted yet/);
    const badges = [...document.querySelectorAll('[data-testid="agent-node-lines"]')].map((b) => b.textContent);
    expect(badges).toContain("talks to anyone");
    expect(badges).toContain("org lines");
    // a new visit starts with the lines shown
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<MemoryRouter><OrgChartView /></MemoryRouter>));
    await flush();
    expect($('[data-testid="toggle-communication-lines"]')!.getAttribute("aria-pressed")).toBe("true");
    await click($('[data-testid="toggle-communication-lines"]'));
    expect(localStorage.getItem(SHOW_LINES_KEY)).toBe("0");
    expect($('[data-testid="communication-lines-legend"]')).toBeNull();
  });
});
