/**
 * Resumable stream registry — keeps in-flight chat completion streams
 * alive on the server even when the originating client disconnects, so
 * a returning client can resume where it left off (replay buffered
 * deltas, then tail live ones).
 *
 * In-memory single-process. For multi-instance deployments swap the
 * backing store for Redis or similar.
 *
 * Lifecycle:
 *   register(turnId, sessionId) → 'live'
 *     append(turnId, payload) → broadcast to subscribers + buffer
 *     complete(turnId) → 'done', notify subscribers, schedule TTL evict
 *     error(turnId, msg) → 'error', notify subscribers, schedule TTL evict
 *   abort(turnId) → mirror of complete; flips an external signal that
 *     the route loop checks to bail out of the LLM call.
 */
type Status = "live" | "done" | "error" | "aborted";

export interface BufferedEvent {
  /** SSE `data:` payload as a string (already serialized JSON or [DONE]). */
  data: string;
  /** Sequence number — strictly increasing, used by clients for de-dup on resume. */
  seq: number;
}

interface Subscriber {
  push: (event: BufferedEvent) => void | Promise<void>;
  finish: (status: Exclude<Status, "live">, error?: string) => void | Promise<void>;
}

interface RegistryEntry {
  turnId: string;
  sessionId: string;
  status: Status;
  errorMessage?: string;
  /** All events emitted so far, oldest first. Used to replay on resume. */
  events: BufferedEvent[];
  /** Live SSE subscribers — receive each new append in real time. */
  subscribers: Set<Subscriber>;
  /** External abort signal — when fired, the LLM loop should bail out. */
  abortController: AbortController;
  /** Wallclock timestamps for TTL/cleanup. */
  createdAt: number;
  finishedAt?: number;
  /** Set after status flips to terminal — used to schedule eviction. */
  evictTimer?: ReturnType<typeof setTimeout>;
}

const REGISTRY = new Map<string, RegistryEntry>();
/** Reverse index — `sessionId → turnId` for live turns only. */
const LIVE_BY_SESSION = new Map<string, string>();

/** How long a finished entry sticks around for late resume attempts. */
const POST_DONE_TTL_MS = 5 * 60 * 1000;

export interface ResumableStreamRegistry {
  register: (turnId: string, sessionId: string) => RegistryEntry;
  append: (turnId: string, data: string) => number | undefined;
  complete: (turnId: string) => void;
  error: (turnId: string, message: string) => void;
  abort: (turnId: string) => boolean;
  getActiveTurnForSession: (sessionId: string) => string | undefined;
  subscribe: (turnId: string, sub: Subscriber) => (() => void) | undefined;
  get: (turnId: string) => RegistryEntry | undefined;
  /** For tests/diagnostics. */
  size: () => number;
}

function evictLater(entry: RegistryEntry) {
  if (entry.evictTimer) clearTimeout(entry.evictTimer);
  entry.evictTimer = setTimeout(() => {
    REGISTRY.delete(entry.turnId);
  }, POST_DONE_TTL_MS);
}

function notifyFinish(entry: RegistryEntry) {
  const status = entry.status === "live" ? "done" : entry.status;
  for (const sub of entry.subscribers) {
    void sub.finish(status as Exclude<Status, "live">, entry.errorMessage);
  }
  entry.subscribers.clear();
}

export const streamRegistry: ResumableStreamRegistry = {
  register(turnId, sessionId) {
    const entry: RegistryEntry = {
      turnId,
      sessionId,
      status: "live",
      events: [],
      subscribers: new Set(),
      abortController: new AbortController(),
      createdAt: Date.now(),
    };
    REGISTRY.set(turnId, entry);
    LIVE_BY_SESSION.set(sessionId, turnId);
    return entry;
  },

  append(turnId, data) {
    const entry = REGISTRY.get(turnId);
    if (!entry || entry.status !== "live") return undefined;
    const event: BufferedEvent = { data, seq: entry.events.length };
    entry.events.push(event);
    for (const sub of entry.subscribers) {
      // Best-effort — a slow subscriber doesn't block the LLM loop.
      void sub.push(event);
    }
    return event.seq;
  },

  complete(turnId) {
    const entry = REGISTRY.get(turnId);
    if (!entry || entry.status !== "live") return;
    entry.status = "done";
    entry.finishedAt = Date.now();
    if (LIVE_BY_SESSION.get(entry.sessionId) === turnId) {
      LIVE_BY_SESSION.delete(entry.sessionId);
    }
    notifyFinish(entry);
    evictLater(entry);
  },

  error(turnId, message) {
    const entry = REGISTRY.get(turnId);
    if (!entry || entry.status !== "live") return;
    entry.status = "error";
    entry.errorMessage = message;
    entry.finishedAt = Date.now();
    if (LIVE_BY_SESSION.get(entry.sessionId) === turnId) {
      LIVE_BY_SESSION.delete(entry.sessionId);
    }
    notifyFinish(entry);
    evictLater(entry);
  },

  abort(turnId) {
    const entry = REGISTRY.get(turnId);
    if (!entry || entry.status !== "live") return false;
    entry.status = "aborted";
    entry.finishedAt = Date.now();
    entry.abortController.abort();
    if (LIVE_BY_SESSION.get(entry.sessionId) === turnId) {
      LIVE_BY_SESSION.delete(entry.sessionId);
    }
    notifyFinish(entry);
    evictLater(entry);
    return true;
  },

  getActiveTurnForSession(sessionId) {
    return LIVE_BY_SESSION.get(sessionId);
  },

  subscribe(turnId, sub) {
    const entry = REGISTRY.get(turnId);
    if (!entry) return undefined;
    if (entry.status !== "live") {
      // Replay synchronously and immediately finish.
      for (const event of entry.events) void sub.push(event);
      void sub.finish(entry.status as Exclude<Status, "live">, entry.errorMessage);
      return () => { /* nothing to unsubscribe */ };
    }
    // Replay then attach for live tail.
    for (const event of entry.events) void sub.push(event);
    entry.subscribers.add(sub);
    return () => { entry.subscribers.delete(sub); };
  },

  get(turnId) {
    return REGISTRY.get(turnId);
  },

  size() {
    return REGISTRY.size;
  },
};
