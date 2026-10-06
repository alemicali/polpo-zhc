import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const events: { events: Array<{ id: string; data: unknown }> } = { events: [] };
vi.mock("@polpo-ai/react", () => ({
  usePolpo: () => ({ client: {} }),
  useEvents: () => events,
}));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn() } }));

import {
  applySteerToTranscript,
  composerKeyAction,
  mergeDraft,
  onComposerRestore,
  pendingSteers,
  requestComposerRestore,
} from "../src/hooks/use-chat-steering";
import { Queue, PendingSteers } from "../src/components/ai-elements/queue";
import { useChatQueue, type QueueClient, type UseChatQueueApi } from "../src/hooks/use-chat-queue";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

test("composer keys: idle Enter sends; running Enter steers, Ctrl/Cmd+Enter queues, Shift+Enter is a newline", () => {
  expect(composerKeyAction({ key: "Enter" }, false)).toBe("send");
  expect(composerKeyAction({ key: "Enter", ctrlKey: true }, false)).toBe("send");
  expect(composerKeyAction({ key: "Enter" }, true)).toBe("steer");
  expect(composerKeyAction({ key: "Enter", ctrlKey: true }, true)).toBe("queue");
  expect(composerKeyAction({ key: "Enter", metaKey: true }, true)).toBe("queue");
  expect(composerKeyAction({ key: "Enter", shiftKey: true }, true)).toBeNull();
  expect(composerKeyAction({ key: "Enter", isComposing: true }, true)).toBeNull();
  expect(composerKeyAction({ key: "a" }, true)).toBeNull();
});

test("a steer splits the streamed answer; a replay of the same steer does not duplicate it", () => {
  const base = [
    { id: "u0", role: "user", content: "do it", ts: "1" },
    { id: "a0", role: "assistant", content: "working", ts: "2" },
  ];
  const event = { steers: [{ id: "s1", content: "metric please", message_id: "u1" }], assistant_message_id: "a1", previous_assistant_message_id: "a0" };
  const first = applySteerToTranscript(base, "a0", event, "3");
  expect(first.assistantId).toBe("a1");
  expect(first.messages.map((m) => [m.id, m.content])).toEqual([["u0", "do it"], ["a0", "working"], ["u1", "metric please"], ["a1", ""]]);
  // Resume replays the event over a snapshot that already holds u1/a1.
  const replay = applySteerToTranscript([...first.messages, { id: "x", role: "user", content: "later", ts: "4" }], "a0", event, "5");
  expect(replay.messages.map((m) => m.id)).toEqual(["u0", "a0", "x", "u1", "a1"]);
  // An empty answer-in-progress moves after the steer instead of leaving a blank bubble.
  const empty = applySteerToTranscript([{ id: "u0", role: "user", content: "hi", ts: "1" }, { id: "tmp", role: "assistant", content: "", ts: "2" }], "tmp",
    { steers: [{ id: "s2", content: "also this" }], assistant_message_id: null }, "3");
  expect(empty.messages.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
  expect(empty.messages[1].id).toBe("temp-steer-s2");
});

test("pending steers: add, update, migrate to the server id, remove and take", () => {
  pendingSteers.add("new-key", { id: "a", content: "one", status: "sending" });
  pendingSteers.add("new-key", { id: "b", content: "two", status: "sending" });
  pendingSteers.migrate("new-key", "sid");
  expect(pendingSteers.get("new-key")).toEqual([]);
  pendingSteers.update("sid", "a", { status: "pending", turnId: "t" });
  expect(pendingSteers.get("sid")[0]).toMatchObject({ status: "pending", turnId: "t" });
  expect(pendingSteers.remove("sid", ["a"]).map((s) => s.id)).toEqual(["a"]);
  expect(pendingSteers.take("sid").map((s) => s.id)).toEqual(["b"]);
  expect(pendingSteers.get("sid")).toEqual([]);
});

test("text handed back goes before the current draft", () => {
  const received: Array<[string, string]> = [];
  const off = onComposerRestore((key, text) => received.push([key, text]));
  requestComposerRestore("sid", ["first", " ", "second"]);
  requestComposerRestore("sid", []);
  off();
  expect(received).toEqual([["sid", "first\n\nsecond"]]);
  expect(mergeDraft("", "back")).toBe("back");
  expect(mergeDraft("typing", "back")).toBe("back\n\ntyping");
});

test("queue list: count with auto-send, click to edit, send now, remove, drag to reorder", async () => {
  const props = {
    onUpdate: vi.fn(), onRemove: vi.fn(), onClear: vi.fn(), onAutoSendChange: vi.fn(), onSend: vi.fn(), onReorder: vi.fn(),
  };
  const items = [{ id: "1", text: "first", createdAt: 1 }, { id: "2", text: "second", createdAt: 2 }];
  await act(async () => root.render(<Queue items={items} autoSend running {...props} />));
  expect(container.textContent).toContain("2 queued");
  expect(container.textContent).toContain("auto-send");
  const rows = container.querySelectorAll('[data-testid="chat-queue-item"]');
  expect(rows).toHaveLength(2);

  await act(async () => (rows[0].querySelector('button[title="Click to edit"]') as HTMLButtonElement).click());
  const editor = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "first, edited");
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(props.onUpdate).toHaveBeenCalledWith("1", "first, edited");

  const second = container.querySelectorAll('[data-testid="chat-queue-item"]')[1];
  expect((second.querySelector('[aria-label="Send this prompt now"]') as HTMLButtonElement).title).toContain("joins the current response");
  await act(async () => (second.querySelector('[aria-label="Send this prompt now"]') as HTMLButtonElement).click());
  expect(props.onSend).toHaveBeenCalledWith("2");
  await act(async () => (second.querySelector('[aria-label="Remove from queue"]') as HTMLButtonElement).click());
  expect(props.onRemove).toHaveBeenCalledWith("2");

  const data = new Map<string, string>();
  const dataTransfer = { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? "", effectAllowed: "", dropEffect: "" };
  const fire = (el: Element, type: string) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { dataTransfer });
    el.dispatchEvent(event);
  };
  const [a, b] = Array.from(container.querySelectorAll('[data-testid="chat-queue-item"]'));
  await act(async () => { fire(b, "dragstart"); fire(a, "dragover"); fire(a, "drop"); });
  expect(props.onReorder).toHaveBeenCalledWith(1, 0);

  await act(async () => (container.querySelector('[role="switch"]') as HTMLButtonElement).click());
  expect(props.onAutoSendChange).toHaveBeenCalledWith(false);
  await act(async () => root.render(<Queue items={[]} autoSend {...props} />));
  expect(container.querySelector('[data-testid="chat-queue"]')).toBeNull();
});

test("pending steers can be withdrawn", async () => {
  const onCancel = vi.fn();
  await act(async () => root.render(<PendingSteers steers={[{ id: "s", content: "wait, use staging", status: "pending" }]} onCancel={onCancel} />));
  expect(container.textContent).toContain("Joins the response at its next step");
  await act(async () => (container.querySelector('[aria-label="Withdraw this message"]') as HTMLButtonElement).click());
  expect(onCancel).toHaveBeenCalledWith("s");
});

test("useChatQueue mirrors the server queue with optimistic changes", async () => {
  let serverItems = [{ id: "q1", content: "one", createdAt: "2026-01-01T00:00:00Z" }, { id: "q2", content: "two", createdAt: "2026-01-01T00:00:01Z" }];
  const client: QueueClient = {
    getChatQueue: vi.fn(async () => ({ items: serverItems, autoSend: true })),
    addToChatQueue: vi.fn(async (_sid, content) => { serverItems = [...serverItems, { id: "q3", content, createdAt: "2026-01-01T00:00:02Z" }]; }),
    updateChatQueueItem: vi.fn(async () => undefined),
    removeChatQueueItem: vi.fn(async () => undefined),
    reorderChatQueue: vi.fn(async () => undefined),
    clearChatQueue: vi.fn(async () => undefined),
    setChatQueueAutoSend: vi.fn(async () => undefined),
    sendChatQueueItem: vi.fn(async () => ({ mode: "steer" as const, turnId: "t", steerId: "st" })),
  };
  let api!: UseChatQueueApi;
  function Probe({ onApi }: { onApi: (value: UseChatQueueApi) => void }) {
    const queue = useChatQueue("session-1", client);
    React.useEffect(() => { onApi(queue); });
    return <span>{queue.items.map((i) => i.text).join(",")}</span>;
  }
  await act(async () => root.render(<Probe onApi={(value) => { api = value; }} />));
  expect(container.textContent).toBe("one,two");

  await act(async () => { api.add("three"); });
  expect(client.addToChatQueue).toHaveBeenCalledWith("session-1", "three");
  expect(container.textContent).toBe("one,two,three");

  await act(async () => { api.reorder(1, 0); });
  expect(client.reorderChatQueue).toHaveBeenCalledWith("session-1", ["q2", "q1", "q3"]);

  let result;
  await act(async () => { result = await api.sendNow("q1"); });
  expect(result).toEqual({ mode: "steer", turnId: "t", steerId: "st" });
  expect(client.sendChatQueueItem).toHaveBeenCalledWith("session-1", "q1");
});
