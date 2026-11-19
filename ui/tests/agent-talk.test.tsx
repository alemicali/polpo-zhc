import { act } from "react";
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
      return { events: filter?.length ? all.filter((e) => filter.includes(e.event)) : all };
    },
    useAgents: () => ({ agents: [], isLoading: false }),
  };
});
const chat = vi.hoisted(() => ({ loadSession: vi.fn(async () => {}) }));
vi.mock("../src/hooks/chat-context", () => ({ useChatActions: () => chat }));
// The markdown renderer loads lazily; plain text is enough here.
vi.mock("../src/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => <div>{children}</div>,
}));

import { MemoryRouter, Route, Routes } from "react-router-dom";
import { mergeExchanges, mergePairs, splitIntro, type AgentExchange } from "../src/lib/agent-talk-api";
import { AgentTalkPage } from "../src/pages/agent-talk";

const exchange = (id: string, startedAt: string, extra: Partial<AgentExchange> = {}): AgentExchange => ({
  id, from: "health-coach", to: "wealth-coach", kind: "question", message: `q ${id}`, status: "working", startedAt, ...extra,
});

test("mergeExchanges merges status updates by id, newest first", () => {
  const a = exchange("a", "2026-11-19T10:00:00Z");
  const b = exchange("b", "2026-11-19T10:05:00Z");
  const merged = mergeExchanges([a], [b]);
  expect(merged.map((x) => x.id)).toEqual(["b", "a"]);
  const answered = mergeExchanges(merged, [{ ...a, status: "answered", answer: "yes" }]);
  expect(answered.map((x) => [x.id, x.status])).toEqual([["b", "working"], ["a", "answered"]]);
  // Nothing new → same array
  expect(mergeExchanges(answered, [answered[0]])).toBe(answered);
});

test("splitIntro and mergePairs", () => {
  expect(splitIntro("[health-coach asks you, in the middle of their work]\nHow much?")).toEqual({
    intro: "health-coach asks you, in the middle of their work",
    text: "How much?",
  });
  expect(splitIntro("plain")).toEqual({ intro: null, text: "plain" });
  const pairs = mergePairs([], exchange("a", "2026-11-19T10:00:00Z", { dmSessionId: "s1" }));
  expect(pairs).toEqual([{ from: "health-coach", to: "wealth-coach", sessionId: "s1" }]);
  expect(mergePairs(pairs, exchange("b", "2026-11-19T10:01:00Z", { dmSessionId: "s1" }))).toBe(pairs);
});

// ── DOM ─────────────────────────────────────────────────────────────────────
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  sse.events = [];
  chat.loadSession.mockClear();
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
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function renderPage() {
  return act(async () => root.render(
    <MemoryRouter initialEntries={["/agent-talk"]}>
      <Routes>
        <Route path="/agent-talk" element={<AgentTalkPage />} />
        <Route path="/chat" element={<div data-testid="chat-page" />} />
      </Routes>
    </MemoryRouter>,
  ));
}

test("shows the empty state when agents have not talked yet", async () => {
  vi.stubGlobal("fetch", vi.fn(() => respond({ conversations: [], recent: [] })));
  await renderPage();
  await flush();
  expect(container.textContent).toContain("No agent conversations yet");
  expect(container.textContent).toContain("ask_agent");
});

test("feed updates live, a click opens the transcript, and it refreshes when answered", async () => {
  const working = exchange("x1", "2026-11-19T10:00:00Z", { dmSessionId: "dm-1", fromSessionId: "chat-1" });
  let transcript = [
    { id: "u1", role: "user", content: "[health-coach asks you, in the middle of their work]\nq x1", ts: "2026-11-19T10:00:00Z" },
  ];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    expect(url).not.toContain("key");
    expect(init?.credentials).toBe("include");
    if (url.endsWith("/api/v1/agent-talk")) {
      return respond({ conversations: [{ from: "health-coach", to: "wealth-coach", sessionId: "dm-1" }], recent: [working] });
    }
    if (url.includes("/api/v1/chat/sessions/dm-1/messages")) return respond({ messages: transcript });
    return respond(null);
  });
  vi.stubGlobal("fetch", fetchMock);
  await renderPage();
  await flush();

  let cards = container.querySelectorAll("[data-testid=agent-exchange]");
  expect(cards).toHaveLength(1);
  expect(cards[0].textContent).toContain("Question");
  expect(cards[0].textContent).toContain("Working");

  // A new exchange arrives live, newest first
  await act(async () => {
    sse.push("agent:message", exchange("x2", "2026-11-19T10:05:00Z", { from: "Polpo", kind: "handoff", dmSessionId: "dm-2" }));
  });
  cards = container.querySelectorAll("[data-testid=agent-exchange]");
  expect(cards).toHaveLength(2);
  expect(cards[0].textContent).toContain("Polpo");
  expect(cards[0].textContent).toContain("Handoff");

  // Open the first exchange's pair transcript
  await act(async () => { (cards[1] as HTMLElement).click(); });
  await flush();
  const panel = () => container.querySelector("[data-testid=agent-transcript]")!;
  expect(panel().textContent).toContain("health-coach asks you, in the middle of their work");
  expect(panel().textContent).toContain("q x1");
  const transcriptCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes("/sessions/dm-1/messages")).length;
  expect(transcriptCalls()).toBe(1);

  // The status update reuses the id: the card flips to answered and the transcript reloads
  transcript = [...transcript, { id: "a1", role: "assistant", content: "about 200", ts: "2026-11-19T10:00:30Z" }];
  await act(async () => {
    sse.push("agent:message", { ...working, status: "answered", answer: "about 200", answeredAt: "2026-11-19T10:00:30Z" });
  });
  await flush();
  cards = container.querySelectorAll("[data-testid=agent-exchange]");
  expect(cards).toHaveLength(2);
  expect(cards[1].textContent).toContain("Answered");
  expect(cards[1].textContent).toContain("answered after 30s");
  expect(transcriptCalls()).toBe(2);
  expect(panel().textContent).toContain("about 200");

  // "Open the chat" loads the writer's session in the chat
  const open = [...cards[1].querySelectorAll("button")].find((b) => b.textContent?.includes("Open the chat"))!;
  await act(async () => { open.click(); });
  expect(chat.loadSession).toHaveBeenCalledWith("chat-1");
  expect(container.querySelector("[data-testid=chat-page]")).not.toBeNull();
});
