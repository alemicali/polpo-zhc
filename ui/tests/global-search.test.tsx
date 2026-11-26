/**
 * The search palette (⌘K): the shortcut, the sidebar field (above Dashboard) and the mobile icon,
 * pages and commands found at once, the server's groups, the keyboard (arrows, Tab between groups,
 * Enter), prefixes, the preview, recents (storage blocked too), the phone layout, and asking Polpo
 * (the larger panel, Enter / ⌘Enter, the streamed answer, intents run or offered, the fast path, errors).
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

vi.mock("@polpo-ai/react", async () => ({
  useSearchAsk: (await import("./helpers/search-ask-mock")).useSearchAskMock,
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
import { clearRecents, pageEntries, parsePaletteQuery } from "../src/lib/global-search";
import { matchActions, paletteActions } from "../src/components/search/palette-actions";
import { resetSidebarStyleForTests } from "../src/hooks/use-sidebar-style";
import { askCalls, resetAskMock, setAskScript } from "./helpers/search-ask-mock";
import { automaticIntent, looksLikeRequest, matchNavigation } from "../src/lib/spotlight-ask";

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
  resetAskMock();
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

test("a link with ?search= opens it (the What's new button)", async () => {
  render(
    <MemoryRouter initialEntries={["/dashboard?search=invoice"]}>
      <TooltipProvider><GlobalSearch /><Where /></TooltipProvider>
    </MemoryRouter>,
  );
  await screen.findByRole("dialog");
  expect(input().value).toBe("invoice");
  expect(screen.getByTestId("where").textContent).toBe("/dashboard");
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
    expect(headings()).toEqual(["Chats", "Tasks", "Polpo"]); // a single word: "Ask Polpo" comes last
    // the chat with who said it and the matched words marked
    const list = dialog.querySelector("[cmdk-list]") as HTMLElement;
    expect(within(list).getByText("Taxes 2026")).toBeTruthy();
    const mark = dialog.querySelector("mark");
    expect(mark?.textContent?.toLowerCase()).toContain("invoic");
    expect(within(dialog).getByText("Running")).toBeTruthy(); // the task's status
    expect(within(dialog).getByText(/Show all 9 chats/)).toBeTruthy();
  });

  test("arrows move, Tab jumps to the next group, Enter opens, ⇧Enter opens in a new tab", async () => {
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
    press("Enter", { shiftKey: true });
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

describe("Ask Polpo", () => {
  const TASK = RESULTS.groups[1]!.items[0]!;

  async function openWith(q: string) {
    renderApp();
    act(() => openSearchPalette());
    await screen.findByRole("dialog");
    type(q);
  }

  test("the palette is a large panel, full screen on phones, the preview taking more room", async () => {
    await openWith("");
    const panel = screen.getByTestId("search-palette");
    expect(panel.className).toContain("sm:h-[min(860px,86vh)]");
    expect(panel.className).toContain("sm:max-w-[min(72rem,calc(100vw-4rem))]");
    expect(panel.className).toContain("max-sm:h-[100dvh]");
    expect(screen.getByTestId("search-results").className).toContain("md:max-w-[46%]");
    expect(input().className).toContain("h-16");
    // the footer documents the keys
    const footer = screen.getByRole("dialog").textContent ?? "";
    expect(footer).toContain("ask Polpo");
    expect(footer).toContain("new tab");
  });

  test("Enter on a request asks Polpo: the answer streams with the results it picked, the search stays", async () => {
    let finish: () => void = () => {};
    setAskScript((_q, emit) => new Promise((resolve) => {
      emit({ type: "delta", text: "Un task è fallito: " });
      emit({ type: "delta", text: "Invoice run." });
      emit({ type: "results", items: [TASK] });
      finish = () => resolve({ answer: "Un task è fallito: Invoice run.", items: [TASK], intents: [], fastPath: false, rounds: 2 });
    }));
    await openWith("quali task sono falliti con le invoice?");
    expect(headings()[0]).toBe("Polpo");
    expect(selectedText()).toContain("Ask Polpo: “quali task sono falliti con le invoice?”");
    press("Enter");
    expect(askCalls).toHaveLength(1);
    expect(askCalls[0]!.q).toBe("quali task sono falliti con le invoice?");
    expect(askCalls[0]!.opts.route).toBe("/dashboard");
    // the dashboard's pages and commands, the ones changing data marked
    const commands = askCalls[0]!.opts.commands as Array<{ id: string; confirm?: boolean }>;
    expect(commands.find((c) => c.id === "theme")?.confirm).toBeUndefined();
    expect(commands.find((c) => c.id === "new-task")?.confirm).toBe(true);
    expect((askCalls[0]!.opts.pages as Array<{ to: string }>).some((p) => p.to === "/config?section=channels")).toBe(true);
    const answer = await screen.findByTestId("ask-answer");
    expect(answer.textContent).toContain("Un task è fallito: Invoice run.");
    expect(answer.getAttribute("aria-busy")).toBe("true");
    await act(async () => { finish(); });
    await waitFor(() => expect(screen.getByTestId("ask-answer").getAttribute("aria-busy")).toBe("false"));
    // its result is a row to open; the server's groups are still below
    const polpoGroup = document.querySelector("[cmdk-group]") as HTMLElement;
    expect(polpoGroup.textContent).toContain("Invoice run");
    expect(headings()).toEqual(["Polpo", "Chats", "Tasks"]);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  test("⌘/Ctrl Enter asks from anywhere, even with a result selected", async () => {
    setAskScript(async () => ({ answer: "ok", items: [], intents: [], fastPath: false, rounds: 1 }));
    await openWith("invoice");
    expect(selectedText()).toContain("Taxes 2026");
    press("Enter", { ctrlKey: true });
    expect(askCalls.map((c) => c.q)).toEqual(["invoice"]);
    expect(await screen.findByTestId("ask-answer")).toBeTruthy();
    expect(screen.getByTestId("where").textContent).toBe("/dashboard");
  });

  test("a navigation intent opens the page with the router and closes the palette", async () => {
    setAskScript(async () => ({
      answer: "Apro i canali.", items: [], fastPath: false, rounds: 1,
      intents: [{ kind: "navigate", route: "/config?section=channels", label: "Channels", auto: true }],
    }));
    await openWith("dove si configura telegram?");
    press("Enter");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/config?section=channels"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("changes are only buttons: nothing runs until clicked, whatever the server says", async () => {
    setAskScript(async () => ({
      answer: "Posso chiederlo a Polpo.", items: [], fastPath: false, rounds: 2,
      intents: [
        { kind: "command", id: "new-task", label: "New task", argument: "fix the login", auto: true },
        { kind: "handoff", label: "Create the task", message: "Create a task: fix the login", auto: false },
        { kind: "navigate", route: "https://evil.example", label: "Elsewhere", auto: true },
      ],
    }));
    await openWith("crea un task per sistemare il login");
    press("Enter");
    await screen.findByText("Create the task");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(newSession).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByTestId("where").textContent).toBe("/dashboard");
    expect(screen.getAllByText("New task: “fix the login”").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("Create the task"));
    expect(newSession).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("Create a task: fix the login");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/chat"));
  });

  test("an obvious “vai a X” opens the page at once, without asking the model", async () => {
    await openWith("vai agli artifatti");
    expect(headings()[0]).toBe("Polpo");
    expect(selectedText()).toContain("Go to Artifacts");
    press("Enter");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/artifacts"));
    expect(askCalls).toEqual([]);

    act(() => openSearchPalette());
    await screen.findByRole("dialog");
    type("apri le impostazioni dei canali");
    press("Enter", { metaKey: true });
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/config?section=channels"));
    expect(askCalls).toEqual([]);
  });

  test("without Polpo's model: one clear line, and the search keeps working", async () => {
    setAskScript(async () => { throw Object.assign(new Error("not configured"), { code: "NO_MODEL" }); });
    await openWith("invoice?");
    press("Enter", { ctrlKey: true });
    const alert = await screen.findByTestId("ask-error");
    expect(alert.textContent).toContain("Polpo's model isn't configured (Settings → Orchestrator)");
    expect(alert.textContent).toContain("search still works");
    expect(headings()).toEqual(["Polpo", "Chats", "Tasks"]);
    expect(screen.getByRole("dialog").textContent).toContain("Invoice run");
  });

  test("the rules: requests vs words, the fast path, and what may run by itself", () => {
    expect(looksLikeRequest("invoice")).toBe(false);
    expect(looksLikeRequest("invoice march")).toBe(false);
    expect(looksLikeRequest("which tasks failed?")).toBe(true);
    expect(looksLikeRequest("dove sono gli artefatti")).toBe(true);
    expect(looksLikeRequest("apri la chat con coach")).toBe(true);
    const pages = pageEntries();
    expect(matchNavigation("go to tasks", pages)?.to).toBe("/tasks");
    expect(matchNavigation("open channels settings", pages)?.to).toBe("/config?section=channels");
    expect(matchNavigation("apri la chat con coach", pages)).toBeNull();
    expect(automaticIntent([
      { kind: "navigate", route: "//evil.example", label: "x", auto: true },
      { kind: "command", id: "new-agent", label: "New agent", auto: true },
      { kind: "handoff", label: "x", message: "y", auto: false },
    ])).toBeNull();
    expect(automaticIntent([{ kind: "command", id: "theme", label: "Dark", auto: true }])).toMatchObject({ id: "theme" });
    expect(automaticIntent([{ kind: "open", route: "/tasks/t1", label: "t", key: "task:t1", auto: true }])).toMatchObject({ route: "/tasks/t1" });
  });
});
