/**
 * The chat history (ChatHistoryList, the same component in the drill-in sidebar, the chat page's
 * column and the mobile overlay): the time buckets of "By chat" with a fixed clock, the per-agent
 * sections of "By agent", Pinned (the API's `starred`), the search, the organize switch kept per
 * person (storage blocked too), the row menu, the keyboard and the empty state.
 */
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@polpo-ai/react", () => ({
  useAgents: () => ({
    agents: [
      { name: "giulia", identity: { displayName: "Giulia" } },
      { name: "marco", identity: { displayName: "Marco Deploy" } },
    ],
    isLoading: false,
  }),
}));

import {
  ORCHESTRATOR_KEY,
  dateBucketOf,
  filterSessions,
  groupByAgent,
  groupByDate,
  pinnedOf,
  type HistorySession,
} from "../src/lib/chat-history";
import { ChatHistoryList, type ChatHistoryListProps } from "../src/components/chat/chat-history-list";
import {
  CHAT_HISTORY_ORGANIZE_KEY,
  resetChatHistoryOrganizeForTests,
  setChatHistoryOrganize,
} from "../src/hooks/use-chat-history-organize";

// Tuesday 24 November 2026, noon (local time)
const NOW = new Date(2026, 10, 24, 12, 0, 0);
const at = (y: number, m: number, d: number, h = 10) => new Date(y, m, d, h, 0, 0).toISOString();

const session = (id: string, updatedAt: string, extra: Partial<HistorySession> = {}): HistorySession => ({
  id, title: id, createdAt: updatedAt, updatedAt, messageCount: 4, ...extra,
});

const SESSIONS: HistorySession[] = [
  session("Plan the launch", at(2026, 10, 24, 9)),
  session("Deploy checklist", at(2026, 10, 24, 11), { agent: "marco" }),
  session("Yesterday notes", at(2026, 10, 23), { agent: "giulia" }),
  session("Weekly review", at(2026, 10, 19)),
  session("Old budget", at(2026, 10, 2), { agent: "giulia" }),
  session("September recap", at(2026, 8, 10)),
  session("Last year", at(2025, 10, 1), { agent: "marco" }),
];

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  localStorage.clear();
  resetChatHistoryOrganizeForTests();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("chat history helpers", () => {
  test("date buckets follow the calendar like Claude's sidebar", () => {
    expect(dateBucketOf(at(2026, 10, 24, 0), NOW).label).toBe("Today");
    expect(dateBucketOf(at(2026, 10, 25), NOW).label).toBe("Today"); // clock skew: future counts as today
    expect(dateBucketOf(at(2026, 10, 23, 23), NOW).label).toBe("Yesterday");
    expect(dateBucketOf(at(2026, 10, 17), NOW).label).toBe("Previous 7 days");
    expect(dateBucketOf(at(2026, 10, 16), NOW).label).toBe("Previous 30 days");
    expect(dateBucketOf(at(2026, 9, 25), NOW).label).toBe("Previous 30 days");
    expect(dateBucketOf(at(2026, 9, 24), NOW).label).toBe("October");
    expect(dateBucketOf(at(2025, 10, 1), NOW).label).toBe("November 2025");
  });

  test("groupByDate keeps the buckets and the chats most recent first", () => {
    const sections = groupByDate(SESSIONS, NOW);
    expect(sections.map((s) => s.label)).toEqual([
      "Today", "Yesterday", "Previous 7 days", "Previous 30 days", "September", "November 2025",
    ]);
    expect(sections[0].items.map((s) => s.id)).toEqual(["Deploy checklist", "Plan the launch"]);
  });

  test("groupByAgent puts the orchestrator first, then agents by their latest chat", () => {
    const sections = groupByAgent(SESSIONS, (k) => (k === ORCHESTRATOR_KEY ? "Polpo" : k));
    expect(sections.map((s) => s.key)).toEqual([ORCHESTRATOR_KEY, "marco", "giulia"]);
    expect(sections[0].label).toBe("Polpo");
    expect(sections[1].items.map((s) => s.id)).toEqual(["Deploy checklist", "Last year"]);
  });

  test("the search matches the title or the agent's name, every word", () => {
    const label = (k: string) => (k === "marco" ? "Marco Deploy" : k === ORCHESTRATOR_KEY ? "Polpo" : k);
    expect(filterSessions(SESSIONS, "budget", label).map((s) => s.id)).toEqual(["Old budget"]);
    expect(filterSessions(SESSIONS, "marco", label).map((s) => s.id)).toEqual(["Deploy checklist", "Last year"]);
    expect(filterSessions(SESSIONS, "deploy last", label).map((s) => s.id)).toEqual(["Last year"]);
    expect(filterSessions(SESSIONS, "  ", label)).toHaveLength(SESSIONS.length);
    expect(pinnedOf([session("a", at(2026, 1, 1), { starred: true }), session("b", at(2026, 1, 1))]).map((s) => s.id)).toEqual(["a"]);
  });
});

/** A stateful host: pinning, renaming and deleting change the list like the real hook does. */
function Host(props: Partial<ChatHistoryListProps> & { initial?: HistorySession[]; spy?: Partial<ChatHistoryListProps> }) {
  const [sessions, setSessions] = useState<HistorySession[]>(props.initial ?? SESSIONS);
  return (
    <TooltipProvider>
      <ChatHistoryList
        sessions={sessions}
        activeSessionId={props.activeSessionId ?? null}
        streamingSessionIds={props.streamingSessionIds ?? []}
        onSelect={props.spy?.onSelect ?? (() => {})}
        onNew={props.spy?.onNew ?? (() => {})}
        onNewGroup={props.spy?.onNewGroup ?? (() => {})}
        onRename={props.spy?.onRename ?? (() => {})}
        onDelete={(id) => {
          props.spy?.onDelete?.(id);
          setSessions((list) => list.filter((s) => s.id !== id));
        }}
        onTogglePin={(id, pinned) => {
          props.spy?.onTogglePin?.(id, pinned);
          setSessions((list) => list.map((s) => (s.id === id ? { ...s, starred: pinned } : s)));
        }}
        renderGroups={props.renderGroups}
        surface={props.surface ?? "sidebar"}
        now={NOW}
      />
    </TooltipProvider>
  );
}

/** The accessible name (decorative avatars are aria-hidden). */
function nameOf(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Opens a Radix menu from its trigger (jsdom has no pointer events: the keyboard opens it). */
function openMenu(trigger: HTMLElement) {
  act(() => {
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
  });
}

function rowActions(title: string) {
  const row = document.querySelector(`[data-session-row="${title}"]`) as HTMLElement;
  return within(row).getByRole("button", { name: "Chat actions" });
}

describe("ChatHistoryList", () => {
  test("By chat: Recents in time buckets with small normal-case labels, no box around the list", () => {
    const { container } = render(<Host />);
    expect(screen.getByText("Recents")).toBeTruthy();
    for (const label of ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "September", "November 2025"]) {
      expect(screen.getByRole("region", { name: label })).toBeTruthy();
    }
    expect(screen.queryByText("HISTORY")).toBeNull();
    expect(screen.queryByText("History")).toBeNull();
    // flat on the surface: no bordered card, no segmented control
    expect(container.querySelector('[class*="border"]')).toBeNull();
    expect(container.querySelector('[class*="bg-card"]')).toBeNull();
    expect(screen.queryByRole("group", { name: "History view" })).toBeNull();
    const today = screen.getByRole("region", { name: "Today" });
    expect(within(today).getAllByRole("button", { name: /Deploy checklist|Plan the launch/ }).map(nameOf)).toEqual([
      "Deploy checklist", "Plan the launch",
    ]);
  });

  test("pin and unpin move the row between Pinned and Recents", () => {
    const onTogglePin = vi.fn();
    render(<Host spy={{ onTogglePin }} />);
    expect(screen.queryByRole("region", { name: "Pinned" })).toBeNull();

    openMenu(rowActions("Weekly review"));
    act(() => { fireEvent.click(screen.getByRole("menuitem", { name: "Pin" })); });
    expect(onTogglePin).toHaveBeenCalledWith("Weekly review", true);
    const pinned = screen.getByRole("region", { name: "Pinned" });
    expect(within(pinned).getByText("Weekly review")).toBeTruthy();
    // it was the only chat of its bucket: the bucket is gone from Recents
    expect(screen.queryByRole("region", { name: "Previous 7 days" })).toBeNull();
    expect(screen.getAllByText("Weekly review")).toHaveLength(1);

    openMenu(rowActions("Weekly review"));
    act(() => { fireEvent.click(screen.getByRole("menuitem", { name: "Unpin" })); });
    expect(onTogglePin).toHaveBeenLastCalledWith("Weekly review", false);
    expect(screen.queryByRole("region", { name: "Pinned" })).toBeNull();
    expect(within(screen.getByRole("region", { name: "Previous 7 days" })).getByText("Weekly review")).toBeTruthy();
  });

  test("the search filters by title and by agent", () => {
    render(<Host />);
    const search = screen.getByRole("textbox", { name: "Search chats" });
    fireEvent.change(search, { target: { value: "giulia" } });
    expect(screen.getByText("Yesterday notes")).toBeTruthy();
    expect(screen.getByText("Old budget")).toBeTruthy();
    expect(screen.queryByText("Plan the launch")).toBeNull();
    fireEvent.change(search, { target: { value: "nothing like this" } });
    expect(screen.getByText("No chats match your search")).toBeTruthy();
    // Escape clears the search
    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.getByText("Plan the launch")).toBeTruthy();
  });

  test("the organize switch shows By agent sections and is kept for this person", () => {
    render(<Host />);
    openMenu(screen.getByRole("button", { name: "Organize chats" }));
    act(() => { fireEvent.click(screen.getByRole("menuitemradio", { name: "By agent" })); });
    expect(localStorage.getItem(CHAT_HISTORY_ORGANIZE_KEY)).toBe("agent");
    const sections = screen.getAllByRole("button", { expanded: true }).map(nameOf);
    expect(sections).toEqual(["Polpo3", "Marco Deploy2", "Giulia2"]);
    expect(screen.queryByRole("region", { name: "Today" })).toBeNull();

    // collapsing a section hides its chats
    act(() => { fireEvent.click(screen.getByRole("button", { name: /Giulia/, expanded: true })); });
    expect(screen.queryByText("Old budget")).toBeNull();

    // a new mount follows the stored choice
    cleanup();
    resetChatHistoryOrganizeForTests();
    render(<Host />);
    expect(screen.getByText("By agent")).toBeTruthy();
  });

  test("with storage blocked the organize switch still works for the visit", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    resetChatHistoryOrganizeForTests();
    render(<Host />);
    expect(screen.getByText("Recents")).toBeTruthy();
    act(() => setChatHistoryOrganize("agent"));
    expect(screen.getByText("By agent")).toBeTruthy();
    act(() => setChatHistoryOrganize("chat"));
    expect(screen.getByText("Recents")).toBeTruthy();
  });

  test("row menu: rename, and delete only after the confirmation", () => {
    const onRename = vi.fn();
    const onDelete = vi.fn();
    render(<Host spy={{ onRename, onDelete }} />);

    openMenu(rowActions("Old budget"));
    act(() => { fireEvent.click(screen.getByRole("menuitem", { name: "Rename" })); });
    expect(onRename).toHaveBeenCalledWith("Old budget", "Old budget");

    openMenu(rowActions("Old budget"));
    act(() => { fireEvent.click(screen.getByRole("menuitem", { name: "Delete" })); });
    expect(onDelete).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Delete chat?")).toBeTruthy();
    act(() => { fireEvent.click(within(dialog).getByRole("button", { name: "Delete" })); });
    expect(onDelete).toHaveBeenCalledWith("Old budget");
    expect(screen.queryByText("Old budget")).toBeNull();
  });

  test("keyboard: arrows move between rows, Enter opens, Delete asks first", () => {
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    render(<Host spy={{ onSelect, onDelete }} />);
    const search = screen.getByRole("textbox", { name: "Search chats" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    // the first row is "New chat"
    expect(nameOf(document.activeElement!)).toBe("New chat");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(nameOf(document.activeElement!)).toBe("Deploy checklist");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(nameOf(document.activeElement!)).toBe("Plan the launch");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(nameOf(document.activeElement!)).toBe("Deploy checklist");
    fireEvent.click(document.activeElement!);
    expect(onSelect).toHaveBeenCalledWith("Deploy checklist");
    fireEvent.keyDown(document.activeElement!, { key: "Delete" });
    expect(within(screen.getByRole("dialog")).getByText("Delete chat?")).toBeTruthy();
    expect(onDelete).not.toHaveBeenCalled();
    // "/" goes to the search
    act(() => { (screen.getByRole("dialog").querySelector("button") as HTMLButtonElement).click(); });
    const row = screen.getByRole("button", { name: "Plan the launch" });
    row.focus();
    fireEvent.keyDown(row, { key: "/" });
    expect(document.activeElement).toBe(search);
  });

  test("the active chat is highlighted and a running one shows a dot", () => {
    render(<Host activeSessionId="Weekly review" streamingSessionIds={["Old budget"]} />);
    expect(screen.getByRole("button", { name: "Weekly review" }).getAttribute("aria-current")).toBe("page");
    const running = document.querySelector('[data-session-row="Old budget"]') as HTMLElement;
    expect(within(running).getByLabelText("Running")).toBeTruthy();
  });

  test("empty: one muted line and the New chat action, groups still listed", () => {
    const onNew = vi.fn();
    render(<Host initial={[]} spy={{ onNew }} renderGroups={() => <section aria-label="Groups">Launch room</section>} />);
    expect(screen.getByText("No chats yet")).toBeTruthy();
    expect(screen.queryByText(/CLI/)).toBeNull();
    expect(screen.getByText("Launch room")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(onNew).toHaveBeenCalledWith();
  });

  test("the New chat menu starts a chat with an agent or a new group", () => {
    const onNew = vi.fn();
    const onNewGroup = vi.fn();
    render(<Host spy={{ onNew, onNewGroup }} />);
    openMenu(screen.getByRole("button", { name: "New chat options" }));
    act(() => { fireEvent.click(screen.getByRole("menuitem", { name: "Giulia" })); });
    expect(onNew).toHaveBeenCalledWith("giulia");
    openMenu(screen.getByRole("button", { name: "New chat options" }));
    act(() => { fireEvent.click(screen.getByRole("menuitem", { name: "New group" })); });
    expect(onNewGroup).toHaveBeenCalled();
  });
});
