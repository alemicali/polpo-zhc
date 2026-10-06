import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// ── SDK mock: a controllable SSE event buffer ───────────────────────────────
type FakeEvent = { id: string; event: string; data: unknown; timestamp: string };
const sse = vi.hoisted(() => ({
  events: [] as FakeEvent[],
  listeners: new Set<() => void>(),
  push(event: string, data: unknown) {
    sse.events = [...sse.events, { id: String(sse.events.length + 1), event, data, timestamp: new Date().toISOString() }];
    sse.listeners.forEach((l) => l());
  },
}));
vi.mock("@polpo-ai/react", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useEvents: (filter?: string[]) => {
      const all = useSyncExternalStore(
        (cb) => { sse.listeners.add(cb); return () => sse.listeners.delete(cb); },
        () => sse.events,
      );
      const prefixes = (filter ?? []).map((f) => f.replace(/\*$/, ""));
      return { events: prefixes.length ? all.filter((e) => prefixes.some((p) => e.event.startsWith(p))) : all };
    },
    usePolpo: () => ({ connectionStatus: "connected" }),
    useAgents: () => ({ agents: [], isLoading: false }),
  };
});

import { firstLine, mergeRoomMessages, typingLabel, type RoomMessage } from "../src/lib/rooms-api";
import { useGroups } from "../src/hooks/use-rooms";
import { GroupComposer } from "../src/components/groups/group-composer";
import type { GroupMember } from "../src/components/groups/use-member-directory";

const msg = (id: string, ts: string, extra: Partial<RoomMessage> = {}): RoomMessage => ({
  id, roomId: "web:1", ts, authorKind: "person", authorId: "me", authorName: "Me", text: id, ...extra,
});

test("mergeRoomMessages dedupes by id and sorts oldest first", () => {
  const a = msg("a", "2026-10-06T10:00:00Z");
  const b = msg("b", "2026-10-06T10:01:00Z");
  const merged = mergeRoomMessages([b], [a, b]);
  expect(merged.map((m) => m.id)).toEqual(["a", "b"]);
  // Nothing new → same array (no re-render)
  expect(mergeRoomMessages(merged, [a])).toBe(merged);
});

test("typingLabel and firstLine", () => {
  expect(typingLabel(["Giulia"])).toBe("Giulia is typing…");
  expect(typingLabel(["Giulia", "Marco"])).toBe("Giulia and Marco are typing…");
  expect(typingLabel(["A", "B", "C", "D", "E"])).toBe("A, B and 3 others are typing…");
  expect(firstLine("\n\n## Plan\nsecond")).toBe("Plan");
});

// ── DOM tests ───────────────────────────────────────────────────────────────
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  sse.events = [];
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function respond(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ ok: true, data }), { status: 200 }));
}

test("useGroups loads the transcript, dedupes the SSE echo and tracks typing", async () => {
  const room = { id: "web:1", kind: "web", title: "Launch", agents: ["giulia"], settings: {}, createdAt: "2026-10-06T09:00:00Z", updatedAt: "2026-10-06T09:00:00Z" };
  const first = msg("m1", "2026-10-06T10:00:00Z");
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/messages") && init?.method === "POST") return respond(msg("m2", "2026-10-06T10:02:00Z", { text: "hi @giulia" }));
    if (url.includes("/messages")) return respond([first]);
    if (url.includes("/typing")) return respond([]);
    if (url.includes("kind=web")) return respond([room]);
    if (url.includes("kind=telegram")) return respond([]);
    return respond(room);
  });
  vi.stubGlobal("fetch", fetchMock);

  let state: ReturnType<typeof useGroups> | undefined;
  function Probe() {
    const groups = useGroups("web:1");
    useEffect(() => { state = groups; });
    return null;
  }
  await act(async () => root.render(<Probe />));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

  expect(state!.room?.title).toBe("Launch");
  expect(state!.messages.map((m) => m.id)).toEqual(["m1"]);
  expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/rooms/web%3A1/messages"))).toBe(true);

  await act(async () => { await state!.send("hi @giulia"); });
  // SSE echo of the same message + a typing flag + the agent reply
  await act(async () => {
    sse.push("room:message", { roomId: "web:1", message: msg("m2", "2026-10-06T10:02:00Z", { text: "hi @giulia" }) });
    sse.push("room:typing", { roomId: "web:1", agent: "giulia", name: "Giulia", typing: true });
  });
  expect(state!.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  expect(state!.typingAgents).toEqual([{ agent: "giulia", name: "Giulia" }]);

  await act(async () => {
    sse.push("room:message", {
      roomId: "web:1",
      message: msg("m3", "2026-10-06T10:03:00Z", { authorKind: "agent", authorId: "giulia", authorName: "Giulia", replyToId: "m2" }),
    });
  });
  expect(state!.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  expect(state!.typingAgents).toEqual([]);

  await act(async () => { sse.push("room:deleted", { roomId: "web:1" }); });
  expect(state!.rooms).toEqual([]);
  expect(state!.roomMissing).toBe(true);
});

const members: GroupMember[] = [
  { id: "polpo", name: "Polpo", isOrchestrator: true, known: true },
  { id: "giulia", name: "Giulia", role: "Marketing", isOrchestrator: false, known: true },
  { id: "marco", name: "Marco", isOrchestrator: false, known: true },
];

const textarea = () => container.querySelector("textarea")!;
async function typeText(text: string) {
  await act(async () => {
    const el = textarea();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, text);
    el.setSelectionRange(text.length, text.length);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function key(k: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    textarea().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
}

test("composer: @ opens the agent list, Enter inserts the mention instead of sending", async () => {
  const onSend = vi.fn(() => Promise.resolve());
  await act(async () => root.render(<GroupComposer members={members} onSend={onSend} />));

  await typeText("ask @gi");
  const options = () => [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);
  expect(options()).toHaveLength(1);
  expect(options()[0]).toContain("Giulia");

  await key("Enter");
  expect(onSend).not.toHaveBeenCalled();
  expect(textarea().value).toBe("ask @giulia ");
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);

  await typeText("ask @giulia for the plan");
  await key("Enter");
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(onSend).toHaveBeenCalledWith("ask @giulia for the plan");
});

test("composer: Shift+Enter does not send and a failed send keeps the draft", async () => {
  const onSend = vi.fn(() => Promise.reject(new Error("offline")));
  await act(async () => root.render(<GroupComposer members={members} onSend={onSend} />));
  await typeText("hello");
  await key("Enter", { shiftKey: true });
  expect(onSend).not.toHaveBeenCalled();
  await key("Enter");
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(onSend).toHaveBeenCalledWith("hello");
  expect(textarea().value).toBe("hello");
});
