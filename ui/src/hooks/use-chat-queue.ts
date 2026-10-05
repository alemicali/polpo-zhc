/**
 * use-chat-queue — per-session prompt queue + auto-send flag.
 *
 * Model: each chat session owns an independent FIFO list of pending prompts
 * plus an `autoSend` boolean (default ON). When the user adds prompts while
 * a response is streaming, they pile up here; the ChatInput watches the
 * streaming state and, when it transitions stream→idle with autoSend on
 * and items.length > 0, dequeues the head and submits it via the same
 * `send` path as a manual submit.
 *
 * State storage: module-level `Map<sessionId, QueueState>` + listener set,
 * exposed through React's `useSyncExternalStore`. Persisted to localStorage
 * under `polpo:chat:queue:v1` as a single JSON object so a reload restores
 * every session's queue + flag. Same convention as ChatTabs' open-tabs
 * store (see `components/layout/chat-tabs.tsx`).
 *
 * The `__new__` session-id sentinel mirrors `NEW_SESSION_DRAFT_KEY` in
 * chat.tsx — it's the queue used while the user is composing in a brand
 * new (unsaved) session.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";

const STORAGE_KEY = "polpo:chat:queue:v1";

export interface QueueItem {
  id: string;
  text: string;
  createdAt: number;
}

export interface QueueState {
  items: QueueItem[];
  autoSend: boolean;
}

const DEFAULT_STATE: QueueState = { items: [], autoSend: true };

// ─── Persistence ──────────────────────────────────────────────────────

function readInitial(): Map<string, QueueState> {
  const m = new Map<string, QueueState>();
  if (typeof window === "undefined") return m;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return m;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return m;
    for (const [sid, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (!val || typeof val !== "object") continue;
      const v = val as { items?: unknown; autoSend?: unknown };
      const items: QueueItem[] = [];
      if (Array.isArray(v.items)) {
        for (const it of v.items) {
          if (!it || typeof it !== "object") continue;
          const x = it as { id?: unknown; text?: unknown; createdAt?: unknown };
          if (
            typeof x.id === "string" &&
            typeof x.text === "string" &&
            typeof x.createdAt === "number"
          ) {
            items.push({ id: x.id, text: x.text, createdAt: x.createdAt });
          }
        }
      }
      const autoSend = typeof v.autoSend === "boolean" ? v.autoSend : true;
      m.set(sid, { items, autoSend });
    }
  } catch {
    /* malformed — ignore */
  }
  return m;
}

let _store: Map<string, QueueState> = readInitial();
const listeners = new Set<() => void>();

function persist() {
  if (typeof window === "undefined") return;
  try {
    const obj: Record<string, QueueState> = {};
    for (const [sid, state] of _store) {
      // Skip pure defaults to keep storage compact
      if (state.items.length === 0 && state.autoSend === true) continue;
      obj[sid] = state;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {
    /* quota or disabled — ignore */
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function notify() {
  listeners.forEach((cb) => cb());
}

function getStateFor(sessionId: string): QueueState {
  return _store.get(sessionId) ?? DEFAULT_STATE;
}

function setStateFor(sessionId: string, next: QueueState) {
  _store.set(sessionId, next);
  persist();
  notify();
}

// ─── ID generator (no nanoid dep) ──────────────────────────────────────

function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

// ─── Mutations (pure functions over _store) ────────────────────────────

function addItem(sessionId: string, text: string): QueueItem | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const cur = getStateFor(sessionId);
  const item: QueueItem = { id: genId(), text: trimmed, createdAt: Date.now() };
  setStateFor(sessionId, { ...cur, items: [...cur.items, item] });
  return item;
}

function updateItem(sessionId: string, id: string, text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const cur = getStateFor(sessionId);
  const idx = cur.items.findIndex((it) => it.id === id);
  if (idx < 0) return false;
  const nextItems = cur.items.slice();
  nextItems[idx] = { ...nextItems[idx], text: trimmed };
  setStateFor(sessionId, { ...cur, items: nextItems });
  return true;
}

function removeItem(sessionId: string, id: string): boolean {
  const cur = getStateFor(sessionId);
  const next = cur.items.filter((it) => it.id !== id);
  if (next.length === cur.items.length) return false;
  setStateFor(sessionId, { ...cur, items: next });
  return true;
}

function reorderItems(sessionId: string, fromIdx: number, toIdx: number): boolean {
  const cur = getStateFor(sessionId);
  if (
    fromIdx === toIdx ||
    fromIdx < 0 ||
    toIdx < 0 ||
    fromIdx >= cur.items.length ||
    toIdx >= cur.items.length
  ) {
    return false;
  }
  const next = cur.items.slice();
  const [moved] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, moved);
  setStateFor(sessionId, { ...cur, items: next });
  return true;
}

function clearItems(sessionId: string) {
  const cur = getStateFor(sessionId);
  if (cur.items.length === 0) return;
  setStateFor(sessionId, { ...cur, items: [] });
}

function setAutoSendFlag(sessionId: string, value: boolean) {
  const cur = getStateFor(sessionId);
  if (cur.autoSend === value) return;
  setStateFor(sessionId, { ...cur, autoSend: value });
}

function shiftItem(sessionId: string): QueueItem | undefined {
  const cur = getStateFor(sessionId);
  if (cur.items.length === 0) return undefined;
  const [head, ...rest] = cur.items;
  setStateFor(sessionId, { ...cur, items: rest });
  return head;
}

/**
 * Migrate the `__new__` sentinel queue to a real session id once the
 * server assigns one. Called from ChatInput after a successful submit when
 * `sessionId` transitions from null → defined and the new id has no queue
 * of its own yet. Idempotent — safe to call repeatedly.
 */
export function migrateNewSessionQueue(newSessionId: string) {
  if (!newSessionId || newSessionId === NEW_SESSION_QUEUE_KEY) return;
  const fromState = _store.get(NEW_SESSION_QUEUE_KEY);
  if (!fromState) return;
  if (_store.has(newSessionId)) return;
  _store.delete(NEW_SESSION_QUEUE_KEY);
  _store.set(newSessionId, fromState);
  persist();
  notify();
}

/** Sentinel key used while a new session has no server-assigned id yet. */
export const NEW_SESSION_QUEUE_KEY = "__new__";

// ─── Hook ──────────────────────────────────────────────────────────────

export interface UseChatQueueApi extends QueueState {
  add: (text: string) => QueueItem | null;
  update: (id: string, text: string) => boolean;
  remove: (id: string) => boolean;
  reorder: (fromIdx: number, toIdx: number) => boolean;
  clear: () => void;
  setAutoSend: (value: boolean) => void;
  shift: () => QueueItem | undefined;
}

export function useChatQueue(sessionId: string | null | undefined): UseChatQueueApi {
  const key = sessionId ?? NEW_SESSION_QUEUE_KEY;

  // Reactive map subscription — fires on every mutation. We then read the
  // per-session slice with getStateFor inside useMemo so consumers only
  // re-render when this session's state changes.
  const getSnapshot = useCallback(() => _store, []);
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const state = getStateFor(key);

  const add = useCallback((text: string) => addItem(key, text), [key]);
  const update = useCallback((id: string, text: string) => updateItem(key, id, text), [key]);
  const remove = useCallback((id: string) => removeItem(key, id), [key]);
  const reorder = useCallback(
    (fromIdx: number, toIdx: number) => reorderItems(key, fromIdx, toIdx),
    [key],
  );
  const clear = useCallback(() => clearItems(key), [key]);
  const setAutoSend = useCallback((v: boolean) => setAutoSendFlag(key, v), [key]);
  const shift = useCallback(() => shiftItem(key), [key]);

  return useMemo(
    () => ({
      items: state.items,
      autoSend: state.autoSend,
      add,
      update,
      remove,
      reorder,
      clear,
      setAutoSend,
      shift,
    }),
    [state.items, state.autoSend, add, update, remove, reorder, clear, setAutoSend, shift],
  );
}
