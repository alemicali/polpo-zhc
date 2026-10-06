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
 *
 * Steering: while a turn is live and `steerable`, users can add messages
 * (steer) that the route loop injects at its next safe point (after a
 * round's tool results, or instead of finishing). closeSteering() ends that
 * window atomically and hands back whatever was not delivered.
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

/** A message typed while the turn runs, waiting for the loop's next safe point. */
export interface PendingSteer {
  id: string;
  content: string;
  createdAt: number;
}

/** At most this many undelivered steers per turn. */
export const MAX_PENDING_STEERS = 20;

export type SteerResult =
  | { ok: true; steer: PendingSteer }
  | { ok: false; reason: "not_found" | "not_steerable" | "aborted" | "duplicate" | "too_many" };

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
  /** Steers not yet injected into the conversation, oldest first. */
  steers: PendingSteer[];
  /** False once the loop can no longer take steers (finishing, finished, aborted). */
  steerable: boolean;
  /** Every steer id this turn ever accepted: a retry after delivery is not injected twice. */
  seenSteerIds: Set<string>;
  /** The session was deleted under the turn: it must not record anything any more. */
  discarded?: boolean;
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
  /**
   * Explicit user cancel. `finalData`, when given, is appended to the replay buffer before
   * subscribers are released (e.g. a steer_returned chunk for other devices).
   */
  abort: (turnId: string, finalData?: string) => boolean;
  /** Queue a steer for the turn's next safe point. */
  steer: (turnId: string, steer: { id?: string; content: string }) => SteerResult;
  /** Withdraw an undelivered steer. */
  cancelSteer: (turnId: string, steerId: string) => "cancelled" | "not_found" | "not_pending";
  /** Drain the pending steers (the loop is about to inject them). */
  takeSteers: (turnId: string) => PendingSteer[];
  /** Stop accepting steers; returns those never delivered. Idempotent. */
  closeSteering: (turnId: string) => PendingSteer[];
  isSteerable: (turnId: string) => boolean;
  hasSeenSteer: (turnId: string, steerId: string) => boolean;
  /** Abort the turn and mark it as belonging to a deleted session (nothing gets recorded). */
  discard: (turnId: string) => boolean;
  isDiscarded: (turnId: string) => boolean;
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
      steers: [],
      steerable: true,
      seenSteerIds: new Set(),
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
    entry.steerable = false;
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
    entry.steerable = false;
    entry.errorMessage = message;
    entry.finishedAt = Date.now();
    if (LIVE_BY_SESSION.get(entry.sessionId) === turnId) {
      LIVE_BY_SESSION.delete(entry.sessionId);
    }
    notifyFinish(entry);
    evictLater(entry);
  },

  abort(turnId, finalData) {
    const entry = REGISTRY.get(turnId);
    if (!entry || entry.status !== "live") return false;
    if (finalData !== undefined) {
      const event: BufferedEvent = { data: finalData, seq: entry.events.length };
      entry.events.push(event);
      for (const sub of entry.subscribers) void sub.push(event);
    }
    entry.steerable = false;
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

  steer(turnId, { id, content }) {
    const entry = REGISTRY.get(turnId);
    if (!entry) return { ok: false, reason: "not_found" };
    if (entry.status === "aborted") return { ok: false, reason: "aborted" };
    if (entry.status !== "live" || !entry.steerable) return { ok: false, reason: "not_steerable" };
    if (entry.steers.length >= MAX_PENDING_STEERS) return { ok: false, reason: "too_many" };
    const steerId = id ?? `steer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    if (entry.seenSteerIds.has(steerId)) return { ok: false, reason: "duplicate" };
    const steer: PendingSteer = { id: steerId, content, createdAt: Date.now() };
    entry.steers.push(steer);
    entry.seenSteerIds.add(steerId);
    return { ok: true, steer };
  },

  cancelSteer(turnId, steerId) {
    const entry = REGISTRY.get(turnId);
    if (!entry) return "not_found";
    const index = entry.steers.findIndex((s) => s.id === steerId);
    if (index < 0) return "not_pending";
    entry.steers.splice(index, 1);
    return "cancelled";
  },

  takeSteers(turnId) {
    const entry = REGISTRY.get(turnId);
    if (!entry) return [];
    return entry.steers.splice(0);
  },

  closeSteering(turnId) {
    const entry = REGISTRY.get(turnId);
    if (!entry) return [];
    entry.steerable = false;
    return entry.steers.splice(0);
  },

  discard(turnId) {
    const entry = REGISTRY.get(turnId);
    if (!entry) return false;
    entry.discarded = true;
    entry.steers.splice(0);
    entry.steerable = false;
    if (entry.status === "live") streamRegistry.abort(turnId);
    return true;
  },

  isDiscarded(turnId) {
    return REGISTRY.get(turnId)?.discarded === true;
  },

  /** Was this steer id ever accepted by the turn? */
  hasSeenSteer(turnId: string, steerId: string) {
    return REGISTRY.get(turnId)?.seenSteerIds.has(steerId) === true;
  },

  isSteerable(turnId) {
    const entry = REGISTRY.get(turnId);
    return !!entry && entry.status === "live" && entry.steerable;
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
