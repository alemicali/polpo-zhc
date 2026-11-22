import { act, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const toastInfo = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { info: toastInfo, error: vi.fn(), success: vi.fn() } }));

import { MemoryRouter, useLocation, useNavigate, type Location, type NavigateFunction } from "react-router-dom";
import type { MemberPreferencesPatch, MemberPreferencesResponse } from "@polpo-ai/react";
import { ChatRoomRouteSync } from "../src/components/layout/chat-room-route-sync";
import { ChatSessionStateContext, sidebarActions, useSidebarOpen } from "../src/hooks/chat-context";
import { useChatNavigationPersistence, type PreferencesApi } from "../src/hooks/use-chat-navigation-persistence";
import {
  getChatSessionRequest,
  getActiveChatRoom,
  setActiveChatRoom,
  settleChatSessionRequest,
} from "../src/hooks/use-chat-room";
import {
  claimInitialChatSelection,
  createLocalCache,
  getChatNavigation,
  hydrateChatNavigation,
  resetChatNavigationForTests,
} from "../src/lib/chat-navigation";

interface FakeSession { id: string; title?: string; messageCount: number; agent?: string }

const SESSIONS: FakeSession[] = [
  { id: "newest", title: "Newest", messageCount: 4 },
  { id: "older", title: "Older", messageCount: 6, agent: "giulia" },
  { id: "oldest", title: "Oldest", messageCount: 2 },
];

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  const pending = getChatSessionRequest();
  if (pending) settleChatSessionRequest(pending);
  setActiveChatRoom(null);
  resetChatNavigationForTests();
  toastInfo.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function fakeApi(stored: MemberPreferencesResponse) {
  let current = stored;
  const patches: MemberPreferencesPatch[] = [];
  const api: PreferencesApi = {
    getPreferences: vi.fn(async () => current),
    updatePreferences: vi.fn(async (patch: MemberPreferencesPatch) => {
      patches.push(patch);
      current = {
        member: current.member,
        preferences: { chatNavigation: { ...current.preferences.chatNavigation, ...patch.chatNavigation } },
      };
      return current;
    }),
  };
  return { api, patches, current: () => current };
}

const opened: string[] = [];

/** Minimal stand-in for ChatProvider: the persistence hook + the session context the route sync reads. */
function FakeChat({ api, sessions = SESSIONS }: { api: PreferencesApi; sessions?: FakeSession[] }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const loadSession = useCallback(async (id: string) => {
    claimInitialChatSelection();
    opened.push(id);
    setSessionId(id);
    const exists = sessions.some((s) => s.id === id);
    if (!exists) setSessionId(null);
    return exists;
  }, [sessions]);
  const newSession = useCallback(() => {
    claimInitialChatSelection();
    setSessionId(null);
  }, []);
  useChatNavigationPersistence(api, {
    sessions, sessionsLoading: false, sessionId, selectedAgent, loadSession, newSession, setSelectedAgent,
  });
  const value = useMemo(() => ({
    sessionId, sessions: sessions.map((s) => ({ ...s, createdAt: "", updatedAt: "" })),
    sessionsLoading: false, streamingSessionIds: [], messagesLoading: false, selectedAgent,
  }), [sessionId, sessions, selectedAgent]);
  return (
    <ChatSessionStateContext.Provider value={value}>
      <ChatRoomRouteSync />
      <Probe />
    </ChatSessionStateContext.Provider>
  );
}

let location: Location | undefined;
let navigate: NavigateFunction | undefined;
function Probe() {
  const current = { location: useLocation(), navigate: useNavigate() };
  useEffect(() => {
    location = current.location;
    navigate = current.navigate;
  });
  return null;
}

const urlSession = () => new URLSearchParams(location!.search).get("session");
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function mount(initial: string, api: PreferencesApi, sessions?: FakeSession[]) {
  opened.length = 0;
  await act(async () => root.render(
    <MemoryRouter initialEntries={[initial]}>
      <FakeChat api={api} sessions={sessions} />
    </MemoryRouter>,
  ));
  await flush();
  await flush();
}

test("/chat restores the last chat this person had open, not the newest one, and puts it in the URL", async () => {
  const { api } = fakeApi({ member: "ale@polpo.sh", preferences: { chatNavigation: { lastSessionId: "older" } } });
  await mount("/chat", api);
  expect(opened).toEqual(["older"]);
  expect(location!.pathname).toBe("/chat");
  expect(urlSession()).toBe("older");
});

test("without remembered chat, /chat falls back to the most recent thread", async () => {
  const { api } = fakeApi({ member: null, preferences: {} });
  await mount("/chat", api);
  expect(opened).toEqual(["newest"]);
  expect(urlSession()).toBe("newest");
});

test("reload keeps the chat in the URL (beats the remembered one), and switching threads is remembered", async () => {
  const { api, patches } = fakeApi({ member: "ale@polpo.sh", preferences: { chatNavigation: { lastSessionId: "newest" } } });
  await mount("/chat?session=oldest", api);
  expect(opened).toEqual(["oldest"]);
  expect(urlSession()).toBe("oldest");
  expect(toastInfo).not.toHaveBeenCalled();

  // Back/forward: going back to another thread's entry opens that thread.
  await act(async () => { navigate!("/chat?session=older"); });
  await flush();
  expect(opened.at(-1)).toBe("older");
  await act(async () => { navigate!(-1); });
  await flush();
  expect(opened.at(-1)).toBe("oldest");
  expect(urlSession()).toBe("oldest");

  // Saved on the server for this person (debounced).
  await act(async () => { await new Promise((r) => setTimeout(r, 500)); });
  expect(getChatNavigation().lastSessionId).toBe("oldest");
  expect(patches.some((p) => p.chatNavigation?.lastSessionId === "oldest")).toBe(true);
});

test("a deleted/stale thread in the URL falls back to the last chat with a notice", async () => {
  const { api } = fakeApi({ member: "ale@polpo.sh", preferences: { chatNavigation: { lastSessionId: "older" } } });
  await mount("/chat?session=gone", api);
  await flush();
  expect(toastInfo).toHaveBeenCalledWith("This chat no longer exists", expect.anything());
  expect(opened).toEqual(["gone", "older"]);
  expect(urlSession()).toBe("older");
});

test("a remembered thread that was deleted falls back to the most recent one", async () => {
  const { api } = fakeApi({ member: "ale@polpo.sh", preferences: { chatNavigation: { lastSessionId: "gone" } } });
  await mount("/chat", api);
  await flush();
  expect(opened).toEqual(["gone", "newest"]);
  expect(urlSession()).toBe("newest");
});

test("a new chat (with its agent) and an open group are restored", async () => {
  const { api } = fakeApi({
    member: "ale@polpo.sh",
    preferences: { chatNavigation: { lastSessionId: null, lastAgent: "giulia", lastRoomId: "web:1" } },
  });
  await mount("/chat", api);
  expect(opened).toEqual([]);
  expect(getActiveChatRoom()).toBe("web:1");
  expect(new URLSearchParams(location!.search).get("room")).toBe("web:1");
  expect(getChatNavigation().lastAgent).toBe("giulia");
});

test("the side chat panel and the tabs come back from the person's preferences", async () => {
  function PanelProbe() {
    const open = useSidebarOpen();
    return <span data-testid="panel">{open ? "open" : "closed"}</span>;
  }
  const { api, patches } = fakeApi({
    member: "ale@polpo.sh",
    preferences: { chatNavigation: { lastSessionId: "older", sidePanelOpen: true, openTabs: ["older", "oldest"] } },
  });
  await act(async () => root.render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <FakeChat api={api} />
      <PanelProbe />
    </MemoryRouter>,
  ));
  await flush();
  expect(container.querySelector("[data-testid=panel]")!.textContent).toBe("open");
  expect(getChatNavigation().openTabs).toEqual(["older", "oldest"]);
  // Restored on another page too (the side panel shows the same chat).
  expect(opened).toEqual(["older"]);

  await act(async () => { sidebarActions.setSidebarOpen(false); });
  expect(container.querySelector("[data-testid=panel]")!.textContent).toBe("closed");
  await act(async () => { await new Promise((r) => setTimeout(r, 500)); });
  expect(patches.some((p) => p.chatNavigation?.sidePanelOpen === false)).toBe(true);
});

test("the local copy is per instance and person: another member never sees the previous one's state", () => {
  hydrateChatNavigation("ale@polpo.sh", { lastSessionId: "a", sidePanelOpen: true });
  expect(getChatNavigation().lastSessionId).toBe("a");
  // Next visit, before the server answers: the local copy of the last member is used.
  resetChatNavigationForTests();
  expect(getChatNavigation()).toMatchObject({ lastSessionId: "a", sidePanelOpen: true });
  // Someone else signs in on this browser.
  hydrateChatNavigation("marco@polpo.sh", undefined);
  expect(getChatNavigation().lastSessionId).toBeUndefined();
  expect(getChatNavigation().sidePanelOpen).toBeUndefined();
});

test("drafts are kept per chat across a reload, scoped to the person", () => {
  hydrateChatNavigation("ale@polpo.sh", {});
  const drafts = createLocalCache<string>("drafts-test", { maxEntries: 3 });
  drafts.set("a", "half-written message for A");
  drafts.set("b", "another for B");
  drafts.flush();

  // "Reload": a fresh cache reads what was stored.
  const reloaded = createLocalCache<string>("drafts-test", { maxEntries: 3 });
  expect(reloaded.get("a")).toBe("half-written message for A");
  expect(reloaded.get("b")).toBe("another for B");
  reloaded.delete("a");
  reloaded.set("c", "c");
  reloaded.set("d", "d");
  reloaded.set("e", "e");
  reloaded.flush();
  const bounded = createLocalCache<string>("drafts-test", { maxEntries: 3 });
  expect(bounded.get("a")).toBeUndefined();
  expect(bounded.get("b")).toBeUndefined();
  expect(bounded.get("e")).toBe("e");

  // Another person on the same browser does not get these drafts.
  hydrateChatNavigation("marco@polpo.sh", {});
  expect(bounded.get("e")).toBeUndefined();
});
