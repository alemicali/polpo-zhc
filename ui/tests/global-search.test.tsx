/**
 * The search palette (⌘K): the shortcut, the sidebar field (above Dashboard) and the mobile icon,
 * pages and commands found at once, the server's groups, the keyboard (arrows, Tab between groups,
 * Enter), prefixes, the preview, recents (storage blocked too) and the phone layout.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";

const searchCalls: Array<{ q: string; types?: string[] }> = [];
const newSession = vi.fn();
const send = vi.fn(async () => {});

const RESULTS = {
  query: "invoice",
  took: 4,
  partial: [],
  nextCursor: null,
  groups: [
    {
      type: "chat", label: "Chats", total: 9, items: [{
        type: "chat", id: "s1", title: "Taxes 2026", subtitle: "Chat with coach", url: "/chat?session=s1", score: 300, updatedAt: new Date().toISOString(),
        snippet: { text: "I sent the invoice to the accountant", highlights: [[11, 18]] }, meta: { agent: "coach", messageId: "m2", author: "coach", matches: 2 },
      }],
    },
    {
      type: "task", label: "Tasks", total: 1, items: [{
        type: "task", id: "t1", title: "Invoice run", titleHighlights: [[0, 7]], url: "/tasks/t1", score: 900, meta: { status: "in_progress", agent: "writer" },
      }],
    },
  ],
};
RESULTS.items = RESULTS.groups.flatMap((g) => g.items) as never;

vi.mock("@polpo-ai/react", () => ({
  useSearch: (q: string, opts: { types?: string[]; enabled?: boolean }) => {
    if (opts.enabled !== false && q) searchCalls.push({ q, ...(opts.types ? { types: opts.types } : {}) });
    return { data: q && /invo/i.test(q) ? RESULTS : q ? { ...RESULTS, groups: [], items: [], query: q } : null, isLoading: false, error: null };
  },
  usePolpo: () => ({
    connectionStatus: "connected",
    client: {
      getApprovals: async () => [],
      getSessionMessages: async () => ({ session: { id: "s1" }, messages: [
        { id: "m1", role: "user", content: "Did you send the invoice?", ts: "2026-11-23T09:00:00Z" },
        { id: "m2", role: "assistant", content: "I sent the invoice to the accountant", ts: "2026-11-23T09:01:00Z" },
      ] }),
      getTask: async () => ({ id: "t1", title: "Invoice run", status: "in_progress", assignTo: "writer", description: "Send invoices", updatedAt: new Date().toISOString(), runs: [] }),
    },
  }),
  useEvents: () => ({ events: [] }),
  useAgents: () => ({ agents: [] }),
}));
vi.mock("@/hooks/use-polpo", () => ({ useProjectInfo: () => ({ info: { project: "demo", version: "1.0.0" } }) }));
vi.mock("@/hooks/chat-context", () => ({ useChatActions: () => ({ newSession, send }) }));
vi.mock("@/pages/chat", () => ({ ChatHistoryPanel: () => <div /> }));

import { GlobalSearch } from "../src/components/search/search-palette";
import { MobileSearchButton } from "../src/components/search/sidebar-search-button";
import { Sidebar } from "../src/components/layout/sidebar";
import { openSearchPalette, resetSearchPaletteForTests } from "../src/hooks/use-search-palette";
import { clearRecents, parsePaletteQuery } from "../src/lib/global-search";
import { matchActions, paletteActions } from "../src/components/search/palette-actions";
import { resetSidebarStyleForTests } from "../src/hooks/use-sidebar-style";

let desktop = true;

beforeEach(() => {
  desktop = true;
  searchCalls.length = 0;
  newSession.mockClear();
  send.mockClear();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width") ? desktop : false,
    media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false,
  }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  localStorage.clear();
  clearRecents();
  resetSearchPaletteForTests();
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

function renderApp(ui = <GlobalSearch />) {
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <TooltipProvider>
        {ui}
        <Where />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const input = () => document.querySelector("[cmdk-input]") as HTMLInputElement;
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const selectedText = () => document.querySelector("[cmdk-item][data-selected='true']")?.textContent ?? "";
const press = (key: string, opts: Record<string, unknown> = {}) => fireEvent.keyDown(input(), { key, ...opts });
const headings = () => [...document.querySelectorAll("[cmdk-group-heading]")].map((h) => h.textContent);

describe("opening", () => {
  test("⌘K and Ctrl+K open it, again closes it; Ctrl+K in a terminal stays the terminal's", async () => {
    renderApp(<><GlobalSearch /><div className="xterm"><textarea data-testid="term" /></div></>);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(await screen.findByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.keyDown(screen.getByTestId("term"), { key: "k", ctrlKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  test("the sidebar's search field sits above Dashboard (both styles) and opens the palette", async () => {
    renderApp(<><Sidebar /><GlobalSearch /></>);
    const field = screen.getByRole("button", { name: /^Search/ });
    const dashboard = screen.getAllByText("Dashboard")[0]!;
    expect(field.compareDocumentPosition(dashboard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(field);
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  test("on a phone: the header icon opens it full screen, without the preview", async () => {
    desktop = false;
    renderApp(<><MobileSearchButton /><GlobalSearch /></>);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByRole("dialog");
    type("invoice");
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("Invoice run"));
    expect(screen.queryByText("Select a result to see more.")).toBeNull();
    expect(screen.queryByLabelText("Loading preview")).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });
});

describe("results", () => {
  test("the empty state offers commands; typing shows pages at once and the server's groups", async () => {
    renderApp();
    act(() => openSearchPalette());
    await screen.findByRole("dialog");
    expect(screen.getByText("New task")).toBeTruthy();
    type("tasks");
    // the page, found without the server
    expect(headings()).toContain("Pages");
    expect(selectedText()).toContain("Tasks");
    type("invoice");
    const dialog = screen.getByRole("dialog");
    expect(headings()).toEqual(["Chats", "Tasks"]);
    // the chat with who said it and the matched words marked
    const list = dialog.querySelector("[cmdk-list]") as HTMLElement;
    expect(within(list).getByText("Taxes 2026")).toBeTruthy();
    const mark = dialog.querySelector("mark");
    expect(mark?.textContent?.toLowerCase()).toContain("invoic");
    expect(within(dialog).getByText("Running")).toBeTruthy(); // the task's status
    expect(within(dialog).getByText(/Show all 9 chats/)).toBeTruthy();
  });

  test("arrows move, Tab jumps to the next group, Enter opens, ⌘Enter opens in a new tab", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    renderApp();
    act(() => openSearchPalette());
    await screen.findByRole("dialog");
    type("invoice");
    expect(selectedText()).toContain("Taxes 2026");
    press("Tab");
    expect(selectedText()).toContain("Invoice run");
    press("Tab", { shiftKey: true });
    expect(selectedText()).toContain("Taxes 2026");
    press("Enter", { metaKey: true });
    expect(open).toHaveBeenCalledWith("/chat?session=s1", "_blank", "noopener");
    press("ArrowDown");
    expect(selectedText()).toContain("Show all 9 chats");
    press("ArrowDown");
    expect(selectedText()).toContain("Invoice run");
    press("Enter");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/tasks/t1"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("the preview shows the chat's matching message in context", async () => {
    renderApp();
    act(() => openSearchPalette());
    await screen.findByRole("dialog");
    type("invoice");
    expect(await screen.findByText("Did you send the invoice?", {}, { timeout: 2000 })).toBeTruthy();
    expect(screen.getAllByText(/I sent the/).length).toBeGreaterThan(1);
  });
});

describe("prefixes and commands", () => {
  test("prefixes narrow the search", () => {
    expect(parsePaletteQuery("@coach")).toMatchObject({ text: "coach", scope: "types", types: ["agent"] });
    expect(parsePaletteQuery("# login")).toMatchObject({ text: "login", types: ["task"] });
    expect(parsePaletteQuery("chat: invoice")).toMatchObject({ text: "invoice", types: ["chat", "room"] });
    expect(parsePaletteQuery("> theme")).toMatchObject({ text: "theme", scope: "commands" });
    expect(parsePaletteQuery("/tasks")).toMatchObject({ text: "tasks", scope: "pages" });
    expect(parsePaletteQuery("invoice")).toMatchObject({ text: "invoice", scope: "all" });
  });

  test("@ asks the server for agents only; > shows commands without asking it", async () => {
    renderApp();
    act(() => openSearchPalette());
    await screen.findByRole("dialog");
    type("@coach");
    expect(searchCalls.at(-1)).toEqual({ q: "coach", types: ["agent"] });
    searchCalls.length = 0;
    type("> theme");
    expect(searchCalls).toEqual([]);
    expect(screen.getByText(/Switch to (dark|light) theme/)).toBeTruthy();
    expect(headings()).toEqual(["Commands"]);
  });

  test("a command takes the words after its name; picked without them it waits for them", async () => {
    const found = matchActions(paletteActions({ theme: "dark", sidebarStyle: "classic" }), "new task fix the login");
    expect(found[0]).toMatchObject({ argument: "fix the login" });
    expect(found[0]!.action.id).toBe("new-task");

    renderApp();
    act(() => openSearchPalette(">"));
    await screen.findByRole("dialog");
    type("> new task");
    expect(selectedText()).toContain("New task");
    press("Enter");
    expect((input() as HTMLInputElement).value).toBe("> New task ");
    type("> New task fix the login");
    expect(selectedText()).toContain("New task: “fix the login”");
    press("Enter");
    expect(newSession).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("Create a task: fix the login");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/chat"));
  });
});

describe("recents", () => {
  test("remembers what was searched and opened", async () => {
    renderApp();
    act(() => openSearchPalette());
    await screen.findByRole("dialog");
    type("invoice");
    press("Tab");
    press("Enter");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    act(() => openSearchPalette());
    await screen.findByRole("dialog");
    expect(screen.getByText("Recent searches")).toBeTruthy();
    expect(screen.getByText("Recently opened")).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).toContain("Invoice run");
  });

  test("works with the browser's storage blocked (this tab only)", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    renderApp();
    act(() => openSearchPalette());
    await screen.findByRole("dialog");
    type("invoice");
    press("Enter");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    act(() => openSearchPalette());
    await screen.findByRole("dialog");
    expect(screen.getByText("Recently opened")).toBeTruthy();
  });
});
