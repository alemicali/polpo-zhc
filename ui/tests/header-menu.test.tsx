/**
 * The header's right side (the look, ⋯ with Install app / Ink Hub / GitHub / sidebar style / Log
 * out — nothing else as loose icons), the What's new cards in the sidebar (latest entries, unread
 * first, a card opens the drawer at its entry, auto-advance paused on hover, static with reduced
 * motion), the Configuration page's section bar (tabs in classic, a title in drill-in, the
 * Orchestrator section) and the Beta badge on Artifacts.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@polpo-ai/react", () => ({
  usePolpo: () => ({ client: { getApprovals: async () => [] }, connectionStatus: "connected" }),
  useEvents: () => ({ events: [] }),
  useAgents: () => ({ agents: [] }),
}));
vi.mock("@/hooks/use-polpo", () => ({ useProjectInfo: () => ({ info: { project: "demo", version: "1.0.0" } }) }));
vi.mock("@/hooks/chat-context", () => ({
  useSidebarOpen: () => false,
  sidebarActions: { toggleSidebar: () => {} },
  useChatPageSessionsOpen: () => false,
  useChatState: () => ({ messages: [], isLoading: false, sessionId: null, sessions: [], selectedAgent: null }),
  useChatActions: () => ({ newSession: () => {}, clear: () => {} }),
  chatPageSessionActions: { toggle: () => {} },
}));
vi.mock("@/pages/chat", () => ({ ChatHistoryPanel: () => <div /> }));

import { Header } from "../src/components/layout/header";
import { MobileNavSheet } from "../src/components/layout/mobile-nav-sheet";
import { HeaderMoreMenu, ThemeMenu, GITHUB_URL } from "../src/components/layout/header-actions";
import { KIND_BADGE_CLASS, WhatsNewStack } from "../src/components/whats-new/whats-new-stack";
import { ConfigSectionBar } from "../src/components/config/config-sections";
import { findConfigSection } from "../src/lib/config-sections";
import { closeWhatsNew, useWhatsNewFocus, useWhatsNewOpen } from "../src/hooks/use-whats-new-drawer";
import { markChangelogSeen, whatsNewStackEntries } from "../src/hooks/use-whats-new";
import { resetSidebarStyleForTests, setSidebarStyle, SIDEBAR_STYLE_STORAGE_KEY } from "../src/hooks/use-sidebar-style";
import { setLayoutMode } from "../src/hooks/use-layout-mode";
import type { ChangelogEntry } from "../src/lib/changelog";

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
  // the instance has a sign-in: the ⋯ menu offers Log out
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { enabled: true } }))));
  localStorage.clear();
  resetSidebarStyleForTests();
  setLayoutMode("sidebar");
});

afterEach(() => {
  cleanup();
  act(() => closeWhatsNew());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function wrap(ui: React.ReactNode, at = "/dashboard") {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <TooltipProvider>{ui}</TooltipProvider>
    </MemoryRouter>,
  );
}

/** Radix menus open on pointer down (jsdom has no pointer capture). */
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

describe("the header", () => {
  test("only the look and ⋯ on the right: no loose GitHub, Ink Hub, install QR, What's new or log-out icons", () => {
    wrap(<Header />);
    const header = screen.getByRole("banner");
    expect(within(header).getByRole("button", { name: "Theme" })).toBeTruthy();
    expect(within(header).getByRole("button", { name: "More" })).toBeTruthy();
    expect(within(header).queryByRole("link", { name: /GitHub/ })).toBeNull();
    expect(within(header).queryByRole("link", { name: /Ink Hub/ })).toBeNull();
    expect(within(header).queryByRole("button", { name: /Install/ })).toBeNull();
    expect(within(header).queryByRole("button", { name: /What's new|Novità/ })).toBeNull();
    expect(within(header).queryByRole("button", { name: "Log out" })).toBeNull();
  });

  test("the Artifacts page title carries the Beta badge", () => {
    wrap(<Header />, "/artifacts");
    expect(screen.getAllByTestId("beta-badge").length).toBeGreaterThan(0);
    cleanup();
    wrap(<Header />, "/tasks");
    expect(screen.queryByTestId("beta-badge")).toBeNull();
  });

  test("⋯ lists Install app, Polpo Ink Hub, GitHub, the sidebar style and Log out", async () => {
    wrap(<HeaderMoreMenu />);
    openMenu(screen.getByRole("button", { name: "More" }));
    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitem").map((el) => el.textContent?.trim());
    expect(items.slice(0, 3)).toEqual(["Install app", "Polpo Ink Hub", "GitHub"]);
    expect(items).toContain("Classic");
    expect(items).toContain("Drill-in (new)");
    expect(within(menu).getByRole("menuitem", { name: "GitHub" }).getAttribute("href")).toBe(GITHUB_URL);
    expect(within(menu).getByRole("menuitem", { name: "Polpo Ink Hub" }).getAttribute("target")).toBe("_blank");
    await waitFor(() => expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Log out" })).toBeTruthy());
  });

  test("⋯ → Install app opens the install dialog; ⋯ → Classic switches the sidebar", async () => {
    wrap(<HeaderMoreMenu />);
    openMenu(screen.getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Install app" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/Scan the QR code/)).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    openMenu(screen.getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Classic" }));
    expect(localStorage.getItem(SIDEBAR_STYLE_STORAGE_KEY)).toBe("classic");
  });

  test("chat-first layout: ⋯ has no sidebar style", async () => {
    wrap(<HeaderMoreMenu showSidebarStyle={false} />);
    openMenu(screen.getByRole("button", { name: "More" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: "Classic" })).toBeNull();
  });

  test("the look menu holds only the mode and the palette", async () => {
    wrap(<ThemeMenu />);
    openMenu(screen.getByRole("button", { name: "Theme" }));
    const menu = await screen.findByRole("menu");
    for (const mode of ["Light", "Dark", "System"]) expect(within(menu).getByRole("menuitem", { name: mode })).toBeTruthy();
    expect(within(menu).getByText("Palette")).toBeTruthy();
    expect(within(menu).queryByText("Sidebar")).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: /Drill-in/ })).toBeNull();
  });
});

// ── What's new cards ──

let run = 0;
function entries(): ChangelogEntry[] {
  run += 1;
  const id = (n: string) => `t${run}-${n}`;
  return [
    { id: id("a"), date: "2026-11-24", kind: "new", title: "Newest A", summary: "", body: "" },
    { id: id("b"), date: "2026-11-23", kind: "improved", title: "Older B", summary: "", body: "" },
    { id: id("c"), date: "2026-11-22", kind: "fixed", title: "Oldest C", summary: "", body: "" },
    { id: id("d"), date: "2026-11-21", kind: "new", title: "Even older D", summary: "", body: "" },
  ];
}

const front = () => document.querySelector<HTMLElement>("[data-testid='whats-new-stack'] [data-depth='0']")!;

function DrawerProbe() {
  const open = useWhatsNewOpen();
  const focus = useWhatsNewFocus();
  return <output data-testid="drawer">{open ? `open:${focus ?? ""}` : "closed"}</output>;
}

describe("the What's new cards", () => {
  test("the latest entries, unread first, with the unread dot", () => {
    const list = entries();
    act(() => markChangelogSeen([list[0].id])); // the newest one is read
    wrap(<WhatsNewStack entries={list} />);
    const order = [...document.querySelectorAll<HTMLElement>("[data-entry]")].map((el) => el.dataset.entry);
    expect(order).toEqual([list[1].id, list[2].id, list[3].id, list[0].id]);
    expect(front().textContent).toContain("Older B");
    expect(within(front()).getByTestId("whats-new-stack-unread")).toBeTruthy();
    expect(screen.getByText("3 non lette")).toBeTruthy();
    // the cards behind the front one are out of the accessibility tree and not focusable
    const behind = document.querySelector<HTMLElement>("[data-depth='1']")!;
    expect(behind.getAttribute("aria-hidden")).toBe("true");
    expect(behind.tabIndex).toBe(-1);
    expect(whatsNewStackEntries(list, new Set([list[0].id]), 2).map((e) => e.title)).toEqual(["Older B", "Oldest C"]);
  });

  test("called Novità, with a quiet kind badge and three cards visibly stacked", () => {
    const list = entries();
    wrap(<WhatsNewStack entries={list} />);
    const stack = screen.getByRole("region", { name: "Novità" });
    expect(stack.dataset.testid).toBe("whats-new-stack");
    expect(within(stack).getByText("Novità")).toBeTruthy();
    expect(front().getAttribute("aria-label")).toBe(`Nuovo: ${list[0].title} (non letta). Apri in Novità`);
    // the kind: a small muted badge, not a coloured pill
    const badge = within(front()).getByTestId("whats-new-stack-kind");
    expect(badge.textContent).toBe("Nuovo");
    expect(badge.className).toBe(KIND_BADGE_CLASS);
    for (const cls of ["rounded-badge", "text-micro", "bg-muted/60", "text-muted-foreground"]) expect(badge.className).toContain(cls);
    expect(badge.className).not.toMatch(/\b(?:bg|text)-(?:primary|success|warning)\b/);
    // the layers: the front card and two behind it, each lower, smaller and fainter
    const layer = (d: number) => document.querySelector<HTMLElement>(`[data-testid='whats-new-stack'] [data-depth='${d}']`)!;
    const shift = (el: HTMLElement) => Number(/translateY\(([\d.]+)rem\)/.exec(el.style.transform)?.[1]);
    const scale = (el: HTMLElement) => Number(/scale\(([\d.]+)\)/.exec(el.style.transform)?.[1]);
    expect([0, 1, 2].map((d) => layer(d).className.includes("invisible"))).toEqual([false, false, false]);
    expect(layer(3).className).toContain("invisible");
    expect(shift(layer(1))).toBeGreaterThanOrEqual(0.6);
    expect(shift(layer(2))).toBeGreaterThan(shift(layer(1)));
    expect(scale(layer(1))).toBeLessThan(1);
    expect(scale(layer(2))).toBeLessThan(scale(layer(1)));
    expect(Number(layer(1).style.opacity)).toBeLessThan(1);
    expect(Number(layer(2).style.opacity)).toBeLessThan(Number(layer(1).style.opacity));
    expect(Number(layer(2).style.opacity)).toBeGreaterThan(0.4);
    // roomier cards
    expect(front().className).toContain("px-3");
    expect(front().className).toContain("py-2.5");
  });

  test("a card opens the What's new drawer at its entry", () => {
    const list = entries();
    const onOpen = vi.fn();
    wrap(<><WhatsNewStack entries={list} onOpen={onOpen} /><DrawerProbe /></>);
    expect(screen.getByTestId("drawer").textContent).toBe("closed");
    fireEvent.click(front());
    expect(screen.getByTestId("drawer").textContent).toBe(`open:${list[0].id}`);
    expect(onOpen).toHaveBeenCalled();
  });

  test("moves on by itself, pauses while hovered, and moves with the arrows", () => {
    vi.useFakeTimers();
    const list = entries();
    wrap(<WhatsNewStack entries={list} intervalMs={1000} />);
    expect(front().dataset.entry).toBe(list[0].id);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(front().dataset.entry).toBe(list[1].id);

    const stack = screen.getByTestId("whats-new-stack");
    fireEvent.mouseEnter(stack);
    expect(stack.dataset.paused).toBe("true");
    act(() => { vi.advanceTimersByTime(5000); });
    expect(front().dataset.entry).toBe(list[1].id);
    fireEvent.mouseLeave(stack);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(front().dataset.entry).toBe(list[2].id);

    fireEvent.keyDown(front(), { key: "ArrowLeft" });
    expect(front().dataset.entry).toBe(list[1].id);
    fireEvent.keyDown(front(), { key: "ArrowRight" });
    expect(front().dataset.entry).toBe(list[2].id);
  });

  test("a swipe moves to the next card", () => {
    const list = entries();
    wrap(<WhatsNewStack entries={list} />);
    const stack = screen.getByTestId("whats-new-stack");
    fireEvent.touchStart(stack, { touches: [{ clientX: 200 }] });
    fireEvent.touchEnd(stack, { changedTouches: [{ clientX: 120 }] });
    expect(front().dataset.entry).toBe(list[1].id);
  });

  test("prefers-reduced-motion: static, no auto-advance", () => {
    reducedMotion = true;
    vi.useFakeTimers();
    const list = entries();
    wrap(<WhatsNewStack entries={list} intervalMs={1000} />);
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(front().dataset.entry).toBe(list[0].id);
    expect(screen.getByTestId("whats-new-stack").dataset.paused).toBe("true");
    expect(front().className).toContain("motion-reduce:transition-none");
  });

  test("the icon rail: one icon with the unread dot, opening the drawer", () => {
    const list = entries();
    wrap(<><WhatsNewStack entries={list} collapsed /><DrawerProbe /></>);
    expect(screen.queryByTestId("whats-new-stack")).toBeNull();
    const rail = screen.getByRole("button", { name: "Novità" });
    expect(within(rail).getByRole("status", { name: "Unread" })).toBeTruthy();
    fireEvent.click(rail);
    expect(screen.getByTestId("drawer").textContent).toBe("open:");
  });
});

// ── Configuration ──

describe("the Configuration section bar", () => {
  test("classic: the tabs, with Orchestrator (not Agent)", () => {
    act(() => setSidebarStyle("classic"));
    const onSelect = vi.fn();
    wrap(<ConfigSectionBar active="agent" onSelect={onSelect} />);
    const tabs = screen.getByRole("group", { name: "Configuration sections" });
    expect(within(tabs).getByRole("button", { name: "Orchestrator" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(tabs).queryByRole("button", { name: "Agent" })).toBeNull();
    fireEvent.click(within(tabs).getByRole("button", { name: "Providers" }));
    expect(onSelect).toHaveBeenCalledWith("providers");
    expect(screen.queryByTestId("config-section-title")).toBeNull();
  });

  test("drill-in (the default): no tabs (the sidebar lists the sections), the section's title instead", () => {
    wrap(<ConfigSectionBar active="agent" onSelect={() => {}} actions={<button type="button">Reload</button>} />);
    expect(screen.queryByRole("group", { name: "Configuration sections" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Orchestrator" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });

  test("drill-in in the chat-first layout (no sidebar): the tabs stay", () => {
    act(() => { setSidebarStyle("drill-in"); setLayoutMode("chat-first"); });
    wrap(<ConfigSectionBar active="general" onSelect={() => {}} />);
    expect(screen.getByRole("group", { name: "Configuration sections" })).toBeTruthy();
  });

  test("?section=agent keeps working; ?section=orchestrator is an alias", () => {
    expect(findConfigSection("agent")).toBe("agent");
    expect(findConfigSection("orchestrator")).toBe("agent");
    expect(findConfigSection("providers")).toBe("providers");
    expect(findConfigSection("nope")).toBeUndefined();
    expect(findConfigSection(null)).toBeUndefined();
  });
});

describe("the mobile navigation drawer", () => {
  test("classic: the What's new cards, Ink Hub and GitHub; Artifacts is Beta; no Novità tile", async () => {
    act(() => setSidebarStyle("classic"));
    wrap(<MobileNavSheet><button type="button">Open navigation</button></MobileNavSheet>);
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByTestId("whats-new-stack")).toBeTruthy();
    expect(within(sheet).getByRole("link", { name: "GitHub" }).getAttribute("href")).toBe(GITHUB_URL);
    expect(within(sheet).getByRole("link", { name: /Ink Hub/ })).toBeTruthy();
    expect(within(within(sheet).getByRole("link", { name: /Artifacts/ })).getByTestId("beta-badge")).toBeTruthy();
    expect(within(sheet).queryByRole("link", { name: "Novità" })).toBeNull();
  });

  test("drill-in: Settings at the bottom, under the What's new cards", async () => {
    act(() => setSidebarStyle("drill-in"));
    wrap(<MobileNavSheet><button type="button">Open navigation</button></MobileNavSheet>);
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    const sheet = await screen.findByRole("dialog");
    const stack = within(sheet).getByTestId("whats-new-stack");
    const pinned = within(sheet).getByRole("list", { name: "Settings and more" });
    expect(stack.compareDocumentPosition(pinned) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("drill-in: the Novità cards on the drawer's top level only", async () => {
    act(() => setSidebarStyle("drill-in"));
    wrap(<MobileNavSheet><button type="button">Open navigation</button></MobileNavSheet>);
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("region", { name: "Novità" })).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: /Team/ }));
    expect(sheet.querySelector<HTMLElement>("[data-level]")!.dataset.level).toBe("team");
    expect(within(sheet).queryByTestId("whats-new-stack")).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "Back to main menu" }));
    expect(within(sheet).getByTestId("whats-new-stack")).toBeTruthy();
  });
});
