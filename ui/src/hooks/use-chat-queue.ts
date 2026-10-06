/**
 * use-chat-queue — per-session prompt queue, kept on the server.
 *
 * The queue lives in the session on the server (`/api/v1/chat/sessions/:id/queue`): it survives
 * reloads, is shared by every tab and device, and with auto-send on the server itself sends the
 * head when a turn completes (no browser needed). This hook mirrors it in a module-level cache,
 * applies changes optimistically, and refreshes on `chat:queue-updated` events.
 *
 * A brand-new chat has no server id yet: prompts queued there wait locally under the `__new__`
 * key and move to the server as soon as the session exists (migrateNewSessionQueue).
 * Queues saved in localStorage by older versions are moved to the server the first time their
 * session is opened.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useEvents, usePolpo } from "@polpo-ai/react";
import { toast } from "sonner";

const LEGACY_STORAGE_KEY = "polpo:chat:queue:v1";

/** Sentinel key used while a new session has no server-assigned id yet. */
export const NEW_SESSION_QUEUE_KEY = "__new__";

export interface QueueItem {
  id: string;
  text: string;
  createdAt: number;
}

export interface QueueState {
  items: QueueItem[];
  autoSend: boolean;
}

export type QueueSendResult =
  | { mode: "steer"; turnId: string; steerId: string }
  | { mode: "turn"; turnId: string }
  | { mode: "scheduled" };

/** The subset of the SDK client this hook needs (kept narrow for tests). */
export interface QueueClient {
  getChatQueue(sessionId: string): Promise<{ items: Array<{ id: string; content: string; createdAt: string }>; autoSend: boolean }>;
  addToChatQueue(sessionId: string, content: string, opts?: { front?: boolean }): Promise<unknown>;
  updateChatQueueItem(sessionId: string, itemId: string, content: string): Promise<unknown>;
  removeChatQueueItem(sessionId: string, itemId: string): Promise<unknown>;
  reorderChatQueue(sessionId: string, ids: string[]): Promise<unknown>;
  clearChatQueue(sessionId: string): Promise<unknown>;
  setChatQueueAutoSend(sessionId: string, autoSend: boolean): Promise<unknown>;
  sendChatQueueItem(sessionId: string, itemId: string): Promise<QueueSendResult>;
}

const DEFAULT_STATE: QueueState = { items: [], autoSend: true };

// ─── Cache (external store) ───────────────────────────────────────────

let cache = new Map<string, QueueState>();
const listeners = new Set<() => void>();

function setState(key: string, next: QueueState) {
  cache = new Map(cache);
  cache.set(key, next);
  listeners.forEach((cb) => cb());
}

function getState(key: string): QueueState {
  return cache.get(key) ?? DEFAULT_STATE;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function localId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `local-${crypto.randomUUID()}`;
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

const fromServer = (state: Awaited<ReturnType<QueueClient["getChatQueue"]>>): QueueState => ({
  autoSend: state.autoSend,
  items: state.items.map((i) => ({ id: i.id, text: i.content, createdAt: Date.parse(i.createdAt) || Date.now() })),
});

const inflight = new Map<string, Promise<void>>();

/** Load a session's queue from the server into the cache. */
export function refreshQueue(client: QueueClient, sessionId: string): Promise<void> {
  const running = inflight.get(sessionId);
  if (running) return running;
  const promise = client.getChatQueue(sessionId)
    .then((state) => setState(sessionId, fromServer(state)))
    .catch(() => { /* offline: keep what we have */ })
    .finally(() => inflight.delete(sessionId));
  inflight.set(sessionId, promise);
  return promise;
}

// ─── Legacy (localStorage) queues ─────────────────────────────────────

function takeLegacyItems(sessionId: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Record<string, { items?: Array<{ text?: unknown }> }>;
    const entry = parsed?.[sessionId];
    if (!entry) return [];
    delete parsed[sessionId];
    if (Object.keys(parsed).length === 0) localStorage.removeItem(LEGACY_STORAGE_KEY);
    else localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(parsed));
    return (entry.items ?? []).map((i) => (typeof i.text === "string" ? i.text.trim() : "")).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The new chat just got its server id: move prompts queued meanwhile to the server.
 * Idempotent — safe to call on every session change.
 */
export function migrateNewSessionQueue(newSessionId: string, client?: QueueClient) {
  if (!newSessionId || newSessionId === NEW_SESSION_QUEUE_KEY) return;
  const pending = cache.get(NEW_SESSION_QUEUE_KEY);
  if (!pending || pending.items.length === 0) return;
  setState(NEW_SESSION_QUEUE_KEY, DEFAULT_STATE);
  const current = getState(newSessionId);
  setState(newSessionId, { ...current, items: [...current.items, ...pending.items] });
  if (!client) return;
  void (async () => {
    for (const item of pending.items) await client.addToChatQueue(newSessionId, item.text).catch(() => undefined);
    await refreshQueue(client, newSessionId);
  })();
}

// ─── Hook ──────────────────────────────────────────────────────────────

export interface UseChatQueueApi extends QueueState {
  /** Queue a prompt (optimistic). Returns false for empty text. */
  add: (text: string) => boolean;
  update: (id: string, text: string) => void;
  remove: (id: string) => void;
  reorder: (fromIdx: number, toIdx: number) => void;
  clear: () => void;
  setAutoSend: (value: boolean) => void;
  /** Send an item now: it steers the running turn, or starts one when idle. */
  sendNow: (id: string) => Promise<QueueSendResult | undefined>;
}

export function useChatQueue(sessionId: string | null | undefined, injectedClient?: QueueClient): UseChatQueueApi {
  const { client: polpoClient } = usePolpo();
  const client = (injectedClient ?? polpoClient) as unknown as QueueClient;
  const key = sessionId ?? NEW_SESSION_QUEUE_KEY;
  const remote = key !== NEW_SESSION_QUEUE_KEY;
  const getSnapshot = useCallback(() => getState(key), [key]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { events } = useEvents(["chat:queue-updated"], 20);

  // Load on open, moving any queue an older version kept in localStorage.
  useEffect(() => {
    if (!remote) return;
    const legacy = takeLegacyItems(key);
    void (async () => {
      for (const text of legacy) await client.addToChatQueue(key, text).catch(() => undefined);
      await refreshQueue(client, key);
    })();
  }, [client, key, remote]);

  // Another tab, device or the server's auto-send changed it.
  const latest = events.at(-1);
  useEffect(() => {
    if (!remote || !latest) return;
    if ((latest.data as { sessionId?: string } | undefined)?.sessionId !== key) return;
    void refreshQueue(client, key);
  }, [client, key, latest, remote]);

  const mutate = useCallback((optimistic: (s: QueueState) => QueueState, request?: () => Promise<unknown>) => {
    setState(key, optimistic(getState(key)));
    if (!remote || !request) return;
    void request()
      .catch((error) => toast.error(error instanceof Error ? error.message : "Queue update failed"))
      .finally(() => { void refreshQueue(client, key); });
  }, [client, key, remote]);

  const add = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    mutate((s) => ({ ...s, items: [...s.items, { id: localId(), text: trimmed, createdAt: Date.now() }] }),
      () => client.addToChatQueue(key, trimmed));
    return true;
  }, [client, key, mutate]);

  const update = useCallback((id: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    mutate((s) => ({ ...s, items: s.items.map((i) => (i.id === id ? { ...i, text: trimmed } : i)) }),
      () => client.updateChatQueueItem(key, id, trimmed));
  }, [client, key, mutate]);

  const remove = useCallback((id: string) => {
    mutate((s) => ({ ...s, items: s.items.filter((i) => i.id !== id) }), () => client.removeChatQueueItem(key, id));
  }, [client, key, mutate]);

  const reorder = useCallback((fromIdx: number, toIdx: number) => {
    const items = getState(key).items.slice();
    if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0 || fromIdx >= items.length || toIdx >= items.length) return;
    const [moved] = items.splice(fromIdx, 1);
    items.splice(toIdx, 0, moved);
    mutate((s) => ({ ...s, items }), () => client.reorderChatQueue(key, items.map((i) => i.id)));
  }, [client, key, mutate]);

  const clear = useCallback(() => {
    mutate((s) => ({ ...s, items: [] }), () => client.clearChatQueue(key));
  }, [client, key, mutate]);

  const setAutoSend = useCallback((value: boolean) => {
    mutate((s) => ({ ...s, autoSend: value }), () => client.setChatQueueAutoSend(key, value));
  }, [client, key, mutate]);

  const sendNow = useCallback(async (id: string) => {
    if (!remote) return undefined;
    setState(key, { ...getState(key), items: getState(key).items.filter((i) => i.id !== id) });
    try {
      return await client.sendChatQueueItem(key, id);
    } finally {
      void refreshQueue(client, key);
    }
  }, [client, key, remote]);

  return useMemo(() => ({
    items: state.items,
    autoSend: state.autoSend,
    add,
    update,
    remove,
    reorder,
    clear,
    setAutoSend,
    sendNow,
  }), [state.items, state.autoSend, add, update, remove, reorder, clear, setAutoSend, sendNow]);
}
