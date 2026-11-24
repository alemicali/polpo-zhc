/**
 * The drill-in sidebar: its tree (every page the classic navigation reaches), the levels (drill
 * in, Back, deep links), the slide (and none with reduced motion), the keyboard, the Chat level,
 * and the preference (instance default, this person's choice, the banners — storage blocked too).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@polpo-ai/react", () => ({
  usePolpo: () => ({ client: { getApprovals: async () => [{ id: "a1" }, { id: "a2" }] }, connectionStatus: "connected" }),
  useEvents: () => ({ events: [] }),
  useAgents: () => ({ agents: [] }),
}));
vi.mock("@/hooks/use-polpo", () => ({ useProjectInfo: () => ({ info: { project: "demo", version: "1.0.0" } }) }));
vi.mock("@/pages/chat", () => ({
  ChatHistoryPanel: ({ onOpenChat }: { onOpenChat: () => void }) => (
    <div data-testid="chat-history">
      <span>History</span>
      <button type="button" onClick={onOpenChat}>Open thread</button>
    </div>
  ),
}));

import {
  DRILL_IN_NAV, activeTrail, configSectionId, findActiveTrail, isLinkActive, linkPath, listedNodes, navTargets, pinnedNodes,
} from "../src/lib/nav-tree";
import { DrillInNav } from "../src/components/layout/drill-in-nav";
import { Sidebar } from "../src/components/layout/sidebar";
import {
  SIDEBAR_BANNER_STORAGE_KEY, SIDEBAR_STYLE_STORAGE_KEY, resetSidebarStyleForTests, setSidebarStyle,
} from "../src/hooks/use-sidebar-style";

type RuntimeWindow = typeof globalThis & { __POLPO_RUNTIME_CONFIG__?: Record<string, unknown> };

let reducedMotion = false;

beforeEach(() => {
  reducedMotion = false;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? reducedMotion : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  localStorage.clear();
  delete (globalThis as RuntimeWindow).__POLPO_RUNTIME_CONFIG__;
  resetSidebarStyleForTests();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{`${pathname}${search}`}</output>;
}

function renderNav(at: string, ui = <DrillInNav />) {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <TooltipProvider>
        {ui}
        <Where />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const level = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-level]")!;
const nav = () => screen.getByRole("navigation", { name: "Main navigation" });

describe("the nav tree", () => {
  test("every page the classic navigation reaches, the drill-in one reaches too", () => {
    const drill = new Set(navTargets(DRILL_IN_NAV).map(linkPath));
    // the pages each classic navigation lists: the sidebar, the mobile drawer, the chat-first tabs
    const pages = (file: string, pattern: RegExp) => [...readFileSync(resolve(process.cwd(), "ui/src/components/layout", file), "utf8")
      .matchAll(pattern)].map((m) => m[1]).filter((to) => to !== "/changelog");
    const classic = pages("sidebar.tsx", /\{ to: "(\/[a-z-]+)", icon/g);
    const mobile = pages("mobile-nav-sheet.tsx", /\{ to: "(\/[a-z-]+)", icon/g);
    const chatFirst = pages("chat-first-layout.tsx", /\{ path: "(\/[a-z-]+)", icon/g);
    expect(classic.length).toBeGreaterThan(20);
    expect(mobile.length).toBeGreaterThan(20);
    expect(chatFirst.length).toBeGreaterThan(20);
    const missing = [...new Set([...classic, ...mobile, ...chatFirst])].filter((to) => !drill.has(to));
    expect(missing).toEqual([]);
  });

  test("every Configuration section has a Settings entry", () => {
    const config = readFileSync(resolve(process.cwd(), "ui/src/lib/config-sections.ts"), "utf8");
    const block = config.slice(config.indexOf("const baseSections = ["), config.indexOf("] as const;", config.indexOf("const baseSections = [")));
    const sections = [...block.matchAll(/id: "([a-z]+)"/g)].map((m) => m[1]);
    expect(sections.length).toBeGreaterThan(10);
    const targets = new Set(navTargets(DRILL_IN_NAV));
    expect(sections.filter((id) => !targets.has(`/config?section=${id}`))).toEqual([]);
  });

  test("the trail to the current page picks the level", () => {
    expect(activeTrail(DRILL_IN_NAV, "/tasks").map((g) => g.id)).toEqual(["work"]);
    expect(activeTrail(DRILL_IN_NAV, "/tasks/t-1").map((g) => g.id)).toEqual(["work"]);
    expect(activeTrail(DRILL_IN_NAV, "/chat").map((g) => g.id)).toEqual(["chat"]);
    expect(activeTrail(DRILL_IN_NAV, "/config", "?section=providers").map((g) => g.id)).toEqual(["settings"]);
    expect(activeTrail(DRILL_IN_NAV, "/computers").map((g) => g.id)).toEqual(["tools"]);
    expect(findActiveTrail(DRILL_IN_NAV, "/dashboard")).toEqual([]);
    expect(findActiveTrail(DRILL_IN_NAV, "/changelog")).toBeNull();
  });

  test("links with a query match it; /config alone is General", () => {
    expect(isLinkActive("/config?section=general", "/config", "")).toBe(true);
    expect(isLinkActive("/config?section=general", "/config", "?section=mcp")).toBe(false);
    expect(isLinkActive("/config?section=mcp", "/config", "?section=mcp&focus=x")).toBe(true);
    expect(isLinkActive("/agents", "/agents/ada", "")).toBe(true);
    expect(isLinkActive("/agents", "/agent-talk", "")).toBe(false);
  });
});

describe("drilling in and out", () => {
  test("a group opens its level with a Back row; Back returns to the top", async () => {
    const { container } = renderNav("/dashboard");
    expect(level(container).dataset.level).toBe("top");
    expect(screen.getByRole("link", { name: /Dashboard/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("button", { name: /^Back/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Work/ }));
    expect(level(container).dataset.level).toBe("work");
    expect(screen.getByRole("heading", { name: "Work" })).toBeTruthy();
    const work = within(level(container));
    for (const page of ["Missions", "Tasks", "Schedules", "Playbooks", "Events"]) expect(work.getByRole("link", { name: page })).toBeTruthy();
    expect(work.queryByRole("link", { name: "Dashboard" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to main menu" }));
    expect(level(container).dataset.level).toBe("top");
    // Settings is pinned at the bottom, out of the top level's list
    expect(within(level(container)).queryByRole("button", { name: /Settings/ })).toBeNull();
    expect(within(screen.getByRole("list", { name: "Settings and more" })).getByRole("button", { name: /Settings/ })).toBeTruthy();
  });

  test("Settings at the bottom: opens its level, hides while in it, comes back on Back", () => {
    const { container } = renderNav("/dashboard", <DrillInNav aboveBottom={<div data-testid="above-bottom" />} />);
    const pinned = screen.getByRole("list", { name: "Settings and more" });
    // below the levels and below what sits above it (the What's new cards)
    expect(level(container).compareDocumentPosition(pinned) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("above-bottom").compareDocumentPosition(pinned) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(listedNodes(DRILL_IN_NAV).map((n) => n.id)).not.toContain("settings");
    expect(pinnedNodes(DRILL_IN_NAV).map((n) => n.id)).toEqual(["settings"]);

    fireEvent.click(within(pinned).getByRole("button", { name: /Settings/ }));
    expect(level(container).dataset.level).toBe("settings");
    expect(screen.queryByRole("list", { name: "Settings and more" })).toBeNull();
    for (const page of ["General", "Providers", "Orchestrator", "Channels", "MCP access"]) expect(screen.getByRole("link", { name: page })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to main menu" }));
    expect(level(container).dataset.level).toBe("top");
    expect(screen.getByRole("list", { name: "Settings and more" })).toBeTruthy();
  });

  test("Settings is current on a /config page; the rail shows it as an icon", () => {
    renderNav("/tasks", <DrillInNav collapsed />);
    const settings = within(screen.getByRole("list", { name: "Settings and more" })).getByRole("button", { name: "Settings" });
    expect(settings.className).not.toContain("bg-sidebar-primary/10");
    cleanup();
    renderNav("/config?section=mcp", <DrillInNav collapsed />);
    // inside the Settings level: the pinned row is the level itself
    expect(screen.queryByRole("list", { name: "Settings and more" })).toBeNull();
  });

  test("the Orchestrator section: ?section=agent and the ?section=orchestrator alias both open it", () => {
    renderNav("/config?section=agent");
    const orchestrator = screen.getByRole("link", { name: "Orchestrator" });
    expect(orchestrator.getAttribute("href")).toBe("/config?section=agent");
    expect(orchestrator.getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("link", { name: "Agent" })).toBeNull();
    cleanup();
    renderNav("/config?section=orchestrator");
    expect(screen.getByRole("link", { name: "Orchestrator" }).getAttribute("aria-current")).toBe("page");
    expect(configSectionId("orchestrator")).toBe("agent");
    expect(configSectionId("agent")).toBe("agent");
    expect(isLinkActive("/config?section=agent", "/config", "?section=orchestrator")).toBe(true);
  });

  test("Artifacts carries a Beta badge (Content level)", () => {
    renderNav("/artifacts");
    expect(within(screen.getByRole("link", { name: /Artifacts/ })).getByTestId("beta-badge").textContent).toBe("Beta");
    expect(within(screen.getByRole("link", { name: "Files" })).queryByTestId("beta-badge")).toBeNull();
  });

  test("a deep link opens its group, with the page current and no slide", () => {
    const { container } = renderNav("/tasks");
    expect(level(container).dataset.level).toBe("work");
    expect(level(container).dataset.motion).toBe("none");
    expect(container.querySelector("[data-leaving-level]")).toBeNull();
    expect(screen.getByRole("link", { name: "Tasks" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Missions" }).getAttribute("aria-current")).toBeNull();
  });

  test("the Settings level: grouped sections linking to /config?section=…", () => {
    const { container } = renderNav("/config?section=providers");
    expect(level(container).dataset.level).toBe("settings");
    for (const header of ["Workspace", "Models & agents", "Execution", "Integrations"]) expect(screen.getByText(header)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Providers" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Providers" }).getAttribute("href")).toBe("/config?section=providers");
    fireEvent.click(screen.getByRole("link", { name: "MCP access" }));
    expect(screen.getByTestId("where").textContent).toBe("/config?section=mcp");
    expect(screen.getByRole("link", { name: "MCP access" }).getAttribute("aria-current")).toBe("page");
  });

  test("following a link elsewhere moves the sidebar to that page's level", () => {
    const { container } = renderNav("/dashboard", (
      <>
        <DrillInNav />
        <GoTo to="/agents" />
      </>
    ));
    fireEvent.click(screen.getByText("go to /agents"));
    expect(level(container).dataset.level).toBe("team");
    expect(screen.getByRole("link", { name: "Agents" }).getAttribute("aria-current")).toBe("page");
  });

  test("Approvals sits at the top level with its pending count", async () => {
    renderNav("/dashboard");
    const approvals = screen.getByRole("link", { name: /Approvals/ });
    expect(approvals.getAttribute("href")).toBe("/approvals");
    await waitFor(() => expect(within(approvals).getByText("2")).toBeTruthy());
  });
});

function GoTo({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(to)}>go to {to}</button>;
}

describe("the slide", () => {
  test("forward: the new level slides in from the right, the old out to the left; back: the reverse", () => {
    const { container } = renderNav("/dashboard");
    fireEvent.click(screen.getByRole("button", { name: /Team/ }));
    expect(level(container).dataset.motion).toBe("forward");
    expect(level(container).className).toContain("slide-in-from-right-8");
    const leaving = container.querySelector<HTMLElement>("[data-leaving-level]")!;
    expect(leaving.dataset.leavingLevel).toBe("top");
    expect(leaving.className).toContain("slide-out-to-left-8");
    expect(leaving.getAttribute("aria-hidden")).toBe("true");
    // the leaving level is not in the accessibility tree
    expect(screen.queryAllByRole("link", { name: /Dashboard/ })).toHaveLength(0);

    // (the old level goes when its slide ends: see the next test)
    fireEvent.click(screen.getByRole("button", { name: "Back to main menu" }));
    expect(level(container).dataset.motion).toBe("back");
    expect(level(container).className).toContain("slide-in-from-left-8");
    expect(container.querySelector<HTMLElement>("[data-leaving-level]")!.className).toContain("slide-out-to-right-8");
  });

  test("the old level goes even without an animation event", async () => {
    const { container } = renderNav("/dashboard");
    fireEvent.click(screen.getByRole("button", { name: /Tools/ }));
    expect(container.querySelector("[data-leaving-level]")).not.toBeNull();
    await waitFor(() => expect(container.querySelector("[data-leaving-level]")).toBeNull());
  });

  test("prefers-reduced-motion: levels switch without any slide", () => {
    reducedMotion = true;
    const { container } = renderNav("/dashboard");
    fireEvent.click(screen.getByRole("button", { name: /Content/ }));
    expect(level(container).dataset.level).toBe("content");
    expect(level(container).dataset.motion).toBe("none");
    expect(level(container).className).not.toContain("slide-in");
    expect(container.querySelector("[data-leaving-level]")).toBeNull();
  });
});

describe("keyboard", () => {
  test("→ / Enter open a group and focus its first entry; ← / Escape go up; ↑/↓ move", () => {
    reducedMotion = true;
    const { container } = renderNav("/dashboard");
    const dashboard = screen.getByRole("link", { name: /Dashboard/ });
    dashboard.focus();
    fireEvent.keyDown(dashboard, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toContain("Chat");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement?.textContent).toContain("Settings");

    const work = screen.getByRole("button", { name: /Work/ });
    work.focus();
    fireEvent.keyDown(work, { key: "ArrowRight" });
    expect(level(container).dataset.level).toBe("work");
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Missions" }));

    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(level(container).dataset.level).toBe("top");
    expect(document.activeElement).toBe(screen.getByRole("link", { name: /Dashboard/ }));

    // Enter on a group is a click (a native button)
    fireEvent.click(screen.getByRole("button", { name: /Team/ }));
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Agents" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(level(container).dataset.level).toBe("top");
  });

  test("the landmark, the back button's name and the current page", () => {
    renderNav("/memory");
    expect(nav().getAttribute("data-sidebar-style")).toBe("drill-in");
    expect(screen.getByRole("button", { name: "Back to main menu" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Team" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Memory" }).getAttribute("aria-current")).toBe("page");
  });
});

describe("the Chat level", () => {
  test("opening Chat goes to the chat and shows its history in the sidebar", async () => {
    const { container } = renderNav("/dashboard");
    fireEvent.click(screen.getByRole("button", { name: /Chat/ }));
    expect(screen.getByTestId("where").textContent).toBe("/chat");
    expect(level(container).dataset.level).toBe("chat");
    expect(await screen.findByTestId("chat-history")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Chat history" })).toBeTruthy();
  });

  test("on /chat the sidebar opens at the Chat level; picking a thread stays on the chat", async () => {
    const onNavigate = vi.fn();
    renderNav("/chat", <DrillInNav onNavigate={onNavigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open thread" }));
    expect(screen.getByTestId("where").textContent).toBe("/chat");
    expect(onNavigate).toHaveBeenCalled();
  });

  test("the icon rail: back, and a button that expands the sidebar to show the history", () => {
    const onExpand = vi.fn();
    renderNav("/chat", <DrillInNav collapsed onExpand={onExpand} />);
    expect(screen.getByRole("button", { name: "Back to main menu" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show chat history" }));
    expect(onExpand).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back to main menu" }));
    expect(screen.getByRole("button", { name: "Work" })).toBeTruthy();
  });
});

describe("the preference", () => {
  const renderSidebar = (at = "/tasks") => renderNav(at, <Sidebar />);
  const classicShown = () => !!document.querySelector("nav[aria-label='Main navigation']:not([data-sidebar-style])");

  test("drill-in by default, with a dismissible “You're using the new sidebar · Switch back” banner", () => {
    const { container } = renderSidebar();
    expect(container.querySelector("[data-sidebar-style='drill-in']")).not.toBeNull();
    // deep link: on /tasks the Work level is open
    expect(level(container).dataset.level).toBe("work");
    expect(screen.getByText(/You're using the new sidebar/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/You're using the new sidebar/)).toBeNull();
    expect(localStorage.getItem(SIDEBAR_BANNER_STORAGE_KEY)).toBe("drill-in");
    // nothing stored for the style: the person follows the default
    expect(localStorage.getItem(SIDEBAR_STYLE_STORAGE_KEY)).toBeNull();
  });

  test("Switch back goes to classic (kept); Try it returns to drill-in", () => {
    const { container } = renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Switch back" }));
    expect(classicShown()).toBe(true);
    expect(localStorage.getItem(SIDEBAR_STYLE_STORAGE_KEY)).toBe("classic");
    expect(screen.getByText("Try the new sidebar")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try it" }));
    expect(container.querySelector("[data-sidebar-style='drill-in']")).not.toBeNull();
    expect(localStorage.getItem(SIDEBAR_STYLE_STORAGE_KEY)).toBe("drill-in");
  });

  test("a person's earlier choice of classic is kept", () => {
    localStorage.setItem(SIDEBAR_STYLE_STORAGE_KEY, "classic");
    resetSidebarStyleForTests();
    renderSidebar();
    expect(classicShown()).toBe(true);
  });

  test("an instance set to classic applies until the person chooses", () => {
    (globalThis as RuntimeWindow).__POLPO_RUNTIME_CONFIG__ = { appearance: { sidebarStyle: "classic" } };
    resetSidebarStyleForTests();
    const { container } = renderSidebar();
    expect(classicShown()).toBe(true);
    act(() => setSidebarStyle("drill-in"));
    expect(container.querySelector("[data-sidebar-style='drill-in']")).not.toBeNull();
    act(() => setSidebarStyle(null));
    expect(classicShown()).toBe(true);
  });

  test("classic: no What's new row, the What's new cards at the bottom; Artifacts is Beta", () => {
    act(() => setSidebarStyle("classic"));
    renderSidebar("/dashboard");
    expect(screen.queryByText("Novità")).toBeNull();
    expect(screen.getByTestId("whats-new-stack")).toBeTruthy();
    expect(within(screen.getByRole("link", { name: /Artifacts/ })).getByTestId("beta-badge")).toBeTruthy();
    // classic keeps Configuration in its list
    expect(screen.getByRole("link", { name: /Configuration/ }).getAttribute("href")).toBe("/config");
  });

  test("drill-in: the banner and the What's new cards above Settings, at the bottom", () => {
    act(() => setSidebarStyle("drill-in"));
    renderSidebar("/dashboard");
    const pinned = screen.getByRole("list", { name: "Settings and more" });
    const stack = screen.getByTestId("whats-new-stack");
    expect(stack.compareDocumentPosition(pinned) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/You're using the new sidebar/).compareDocumentPosition(stack) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // the connection footer stays last
    expect(pinned.compareDocumentPosition(screen.getByText("Connected")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("with storage blocked the switch and the dismissal still work for the visit", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("blocked"); });
    resetSidebarStyleForTests();
    const { container } = renderSidebar();
    expect(container.querySelector("[data-sidebar-style='drill-in']")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Switch back" }));
    expect(classicShown()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Try the new sidebar")).toBeNull();
  });
});
