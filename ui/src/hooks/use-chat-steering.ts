/**
 * Chat steering — client side.
 *
 * While a turn runs, Enter sends the composer text to that turn ("steer"):
 * the server injects it at the turn's next safe point (after the current
 * round's tool results, or instead of finishing). Until then the message is
 * shown as pending above the composer and can be withdrawn.
 *
 * This module holds that pending list (external store, per session key), the
 * "put text back in the composer" channel used when a turn is stopped with
 * steers still pending, the keyboard routing of the composer, and the pure
 * transform that splits the transcript when a steer is applied.
 */

import { useCallback, useSyncExternalStore } from "react";

export interface PendingSteer {
  id: string;
  content: string;
  /** Turn the steer was sent to (unknown while it waits for the turn id). */
  turnId?: string;
  status: "sending" | "pending";
}

// ─── Pending steers store ─────────────────────────────────────────────

let store = new Map<string, PendingSteer[]>();
const listeners = new Set<() => void>();
const EMPTY: PendingSteer[] = [];

function emit() {
  store = new Map(store);
  listeners.forEach((cb) => cb());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export const pendingSteers = {
  get(key: string): PendingSteer[] {
    return store.get(key) ?? EMPTY;
  },
  add(key: string, steer: PendingSteer) {
    store.set(key, [...(store.get(key) ?? []), steer]);
    emit();
  },
  update(key: string, id: string, patch: Partial<PendingSteer>) {
    const list = store.get(key);
    if (!list?.some((s) => s.id === id)) return;
    store.set(key, list.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    emit();
  },
  /** Remove the given steers (applied, returned or withdrawn); returns those that were present. */
  remove(key: string, ids: string[]): PendingSteer[] {
    const list = store.get(key);
    if (!list) return [];
    const removed = list.filter((s) => ids.includes(s.id));
    if (removed.length === 0) return [];
    const kept = list.filter((s) => !ids.includes(s.id));
    if (kept.length > 0) store.set(key, kept);
    else store.delete(key);
    emit();
    return removed;
  },
  /** Remove and return every pending steer of the session. */
  take(key: string): PendingSteer[] {
    const list = store.get(key) ?? [];
    if (list.length === 0) return [];
    store.delete(key);
    emit();
    return list;
  },
  /** A new session got its server id: carry its pending steers over. */
  migrate(from: string, to: string) {
    const list = store.get(from);
    if (!list || from === to) return;
    store.delete(from);
    store.set(to, [...(store.get(to) ?? []), ...list]);
    emit();
  },
};

export function usePendingSteers(key: string | null | undefined): PendingSteer[] {
  const getSnapshot = useCallback(() => (key ? store.get(key) ?? EMPTY : EMPTY), [key]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function newSteerId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `steer-${crypto.randomUUID()}`;
  return `steer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Composer restore ─────────────────────────────────────────────────

type RestoreListener = (key: string, text: string) => void;
const restoreListeners = new Set<RestoreListener>();

/** Put texts back into the composer of `key` (e.g. steers handed back by Stop). */
export function requestComposerRestore(key: string, texts: string[]) {
  const text = texts.map((t) => t.trim()).filter(Boolean).join("\n\n");
  if (!text) return;
  restoreListeners.forEach((cb) => cb(key, text));
}

export function onComposerRestore(cb: RestoreListener): () => void {
  restoreListeners.add(cb);
  return () => { restoreListeners.delete(cb); };
}

/** Restored text goes before what the user is typing now, separated by a blank line. */
export function mergeDraft(current: string, restored: string): string {
  if (!current.trim()) return restored;
  return `${restored}\n\n${current}`;
}

// ─── Keyboard routing ─────────────────────────────────────────────────

export type ComposerKeyAction = "send" | "steer" | "queue" | null;

/**
 * What Enter does in the composer. Idle: Enter (or Ctrl/Cmd+Enter) sends. While a turn runs:
 * Enter steers it, Ctrl/Cmd+Enter adds to the queue. Shift+Enter is a newline; IME composition
 * and other keys are left alone (null).
 */
export function composerKeyAction(
  e: { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; isComposing?: boolean },
  running: boolean,
): ComposerKeyAction {
  if (e.key !== "Enter" || e.shiftKey || e.altKey || e.isComposing) return null;
  if (!running) return "send";
  return e.ctrlKey || e.metaKey ? "queue" : "steer";
}

// ─── Transcript split ─────────────────────────────────────────────────

export interface SteerAppliedEvent {
  steers: Array<{ id: string; content: string; message_id?: string }>;
  assistant_message_id?: string | null;
  previous_assistant_message_id?: string | null;
}

interface TranscriptMessage {
  id: string;
  role: string;
  content: string;
  ts: string;
  toolCalls?: unknown[];
  segments?: unknown[];
  widgets?: unknown[];
  thinkingText?: string;
}

/**
 * Apply a steer to the local transcript: the assistant message being streamed keeps what it has
 * (or goes away if still empty), the steers follow as user messages, and a new empty assistant
 * message takes the rest of the turn. Messages already carrying the server ids are replaced,
 * which keeps a replay (resume) from duplicating them. Returns the id of the new assistant message.
 */
export function applySteerToTranscript<M extends TranscriptMessage>(
  messages: M[],
  currentAssistantId: string,
  event: SteerAppliedEvent,
  now = new Date().toISOString(),
): { messages: M[]; assistantId: string } {
  const assistantId = event.assistant_message_id || `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-a`;
  const steerMessages = event.steers.map((s) => ({
    id: s.message_id || `temp-steer-${s.id}`,
    role: "user",
    content: s.content,
    ts: now,
  }) as M);
  const replaced = new Set([assistantId, ...steerMessages.map((m) => m.id)]);
  const current = messages.find((m) => m.id === currentAssistantId);
  const currentEmpty = !!current && !current.content.trim() && !current.toolCalls?.length
    && !current.widgets?.length && !current.thinkingText;
  const kept = messages.filter((m) => !replaced.has(m.id) && !(currentEmpty && m.id === currentAssistantId));
  return {
    messages: [...kept, ...steerMessages, { id: assistantId, role: "assistant", content: "", ts: now } as M],
    assistantId,
  };
}
