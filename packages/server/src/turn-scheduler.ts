/**
 * Turn scheduler — decides what a chat session says next once a turn is over,
 * without depending on a browser being open:
 *
 * - **Undelivered steers** (the turn ended on an interactive tool, an error or
 *   the round limit before a safe point): they become the next message. The
 *   next turn that starts on the session (e.g. the client's acknowledgement of
 *   navigate_to) picks them up at its start; if none starts within a short
 *   grace period, the scheduler starts one itself.
 * - **Queued prompts**: when a turn completes normally and the session's queue
 *   has auto-send on, the head is sent as a new turn.
 *
 * Turns are started through the regular completions endpoint (streaming, so
 * clients can attach with /resume), and announced with `chat:turn-started`.
 *
 * In-memory and single-process, like the stream registry it builds on.
 */

import type { AttachmentStore, ChatQueueStore, SessionStore } from "@polpo-ai/core";
import { streamRegistry } from "./stream-registry.js";

export type TurnOutcome = "completed" | "interactive" | "error" | "aborted" | "max_turns";
export type TurnStartReason = "queue" | "steer" | "fork" | "send-now";

export interface CarriedSteer {
  id: string;
  content: string;
}

export interface TurnSchedulerDeps {
  getSessionStore: () => SessionStore | undefined;
  getAttachmentStore?: () => AttachmentStore | undefined;
  getQueueStore?: () => ChatQueueStore | undefined;
  emit: (event: string, data: unknown) => void;
  /** Run a request against the chat completions app (mounted at its root). */
  request: (req: Request) => Response | Promise<Response>;
  /** Bearer token for the internal request, when the completions app requires one. */
  apiKey?: string;
  /** Delays (ms) — overridable for tests. */
  delays?: { afterCompleted?: number; carryOver?: number; carryOverAfterInteractive?: number };
}

export interface StartedTurn {
  turnId: string;
  userMessageId?: string;
}

export type SendNowResult =
  | { mode: "steer"; turnId: string; steerId: string }
  | { mode: "turn"; turnId: string }
  | { mode: "scheduled" };

const DEFAULT_DELAYS = { afterCompleted: 250, carryOver: 300, carryOverAfterInteractive: 1500 };

export class TurnScheduler {
  private readonly carry = new Map<string, CarriedSteer[]>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastOutcome = new Map<string, TurnOutcome>();
  /** Sessions with a turn being started by the scheduler right now. */
  private readonly starting = new Set<string>();
  private readonly delays: typeof DEFAULT_DELAYS;

  constructor(private readonly deps: TurnSchedulerDeps) {
    this.delays = { ...DEFAULT_DELAYS, ...deps.delays };
  }

  /** Called by the completions loop when a turn on `sessionId` is over. */
  turnFinished(sessionId: string, outcome: TurnOutcome, undelivered: CarriedSteer[] = []): void {
    this.lastOutcome.set(sessionId, outcome);
    if (undelivered.length > 0) this.carryOver(sessionId, undelivered, outcome);
    else if (this.carry.has(sessionId)) this.schedule(sessionId, this.delays.carryOver);
    else if (outcome === "completed") this.schedule(sessionId, this.delays.afterCompleted);
  }

  /** Make steers the next message of the session (see the module comment). */
  carryOver(sessionId: string, steers: CarriedSteer[], outcome?: TurnOutcome): void {
    if (steers.length === 0) return;
    this.carry.set(sessionId, [...(this.carry.get(sessionId) ?? []), ...steers]);
    this.schedule(sessionId, outcome === "interactive" ? this.delays.carryOverAfterInteractive : this.delays.carryOver);
  }

  /** Steers carried over to the turn that is starting now (it injects them after its own message). */
  takeCarryOver(sessionId: string): CarriedSteer[] {
    const steers = this.carry.get(sessionId) ?? [];
    this.carry.delete(sessionId);
    return steers;
  }

  /** The queue changed: if the session is idle after a completed turn, auto-send may apply now. */
  queueChanged(sessionId: string): void {
    if (this.lastOutcome.get(sessionId) !== "completed") return;
    this.schedule(sessionId, 0);
  }

  /** Forget a session (deleted). */
  forget(sessionId: string): void {
    this.carry.delete(sessionId);
    this.lastOutcome.delete(sessionId);
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  /**
   * "Send now" for a queued prompt: steer the running turn when there is one, otherwise start a
   * turn with it. Returns undefined when the item no longer exists.
   */
  async sendNow(sessionId: string, itemId: string): Promise<SendNowResult | undefined> {
    const queue = this.deps.getQueueStore?.();
    if (!queue) return undefined;
    const item = await queue.remove(sessionId, itemId);
    if (!item) return undefined;
    this.deps.emit("chat:queue-updated", { sessionId });

    const live = streamRegistry.getActiveTurnForSession(sessionId);
    if (live || this.starting.has(sessionId)) {
      const steered = live ? streamRegistry.steer(live, { content: item.content }) : undefined;
      if (live && steered?.ok) return { mode: "steer", turnId: live, steerId: steered.steer.id };
      // The running turn is wrapping up: the prompt becomes its next message.
      this.carryOver(sessionId, [{ id: item.id, content: item.content }]);
      return { mode: "scheduled" };
    }
    try {
      const started = await this.startTurn(sessionId, { content: item.content, reason: "send-now" });
      if (started) return { mode: "turn", turnId: started.turnId };
    } catch (error) {
      await queue.add(sessionId, item.content, { front: true }).catch(() => undefined);
      this.deps.emit("chat:queue-updated", { sessionId });
      throw error;
    }
    return undefined;
  }

  /**
   * Start a streaming turn on the session through the completions endpoint, with the stored
   * conversation as history. `content` is the new user message; without it the stored
   * conversation must already end with the user message to answer.
   */
  async startTurn(sessionId: string, opts: { content?: string; reason: TurnStartReason }): Promise<StartedTurn | undefined> {
    const sessionStore = this.deps.getSessionStore();
    if (!sessionStore) return undefined;
    const session = await sessionStore.getSession(sessionId);
    if (!session) return undefined;
    this.starting.add(sessionId);
    try {
      const history = await sessionStore.getMessages(sessionId);
      const attachments = await (this.deps.getAttachmentStore?.()?.getBySession(sessionId) ?? Promise.resolve([])).catch(() => []);
      const refs = new Map<string, string[]>();
      for (const attachment of attachments) {
        if (!attachment.messageId) continue;
        refs.set(attachment.messageId, [...(refs.get(attachment.messageId) ?? []), `[file: ${attachment.path}]`]);
      }
      const messages = history
        .map((m) => ({ role: m.role, content: [m.content, ...(refs.get(m.id) ?? [])].filter(Boolean).join("\n\n") }))
        .filter((m) => m.content.trim().length > 0);
      if (opts.content !== undefined) messages.push({ role: "user", content: opts.content });
      if (!messages.some((m) => m.role === "user")) return undefined;

      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-session-id": sessionId,
        "x-polpo-turn-reason": opts.reason,
      };
      if (opts.content === undefined) headers["x-polpo-skip-user-message"] = "1";
      if (this.deps.apiKey) headers.authorization = `Bearer ${this.deps.apiKey}`;
      const response = await this.deps.request(new Request("http://polpo.internal/", {
        method: "POST",
        headers,
        body: JSON.stringify({ stream: true, ...(session.agent ? { agent: session.agent } : {}), messages }),
      }));
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as any;
        throw new Error(payload?.error?.message ?? `Could not start the turn (${response.status})`);
      }
      const turnId = response.headers.get("x-turn-id");
      // Nobody reads this response: drain it so the turn streams into the registry at full speed.
      void (async () => {
        const reader = response.body?.getReader();
        if (!reader) return;
        try { while (!(await reader.read()).done) { /* drain */ } } catch { /* turn ended */ }
      })();
      if (!turnId) return undefined;
      const userMessageId = response.headers.get("x-user-message-id") ?? undefined;
      this.lastOutcome.delete(sessionId);
      this.deps.emit("chat:turn-started", { sessionId, turnId, reason: opts.reason, ...(userMessageId ? { userMessageId } : {}) });
      return { turnId, userMessageId };
    } finally {
      this.starting.delete(sessionId);
    }
  }

  private schedule(sessionId: string, delay: number): void {
    const previous = this.timers.get(sessionId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      void this.dispatch(sessionId).catch((error) => {
        console.warn("[turn-scheduler] dispatch failed:", error instanceof Error ? error.message : error);
      });
    }, delay);
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }

  /** Send what comes next, if the session is idle: carried-over steers first, then the queue. */
  private async dispatch(sessionId: string): Promise<void> {
    // A running turn will call turnFinished again when it is over.
    if (streamRegistry.getActiveTurnForSession(sessionId) || this.starting.has(sessionId)) return;

    const carried = this.carry.get(sessionId);
    if (carried?.length) {
      // The first steer is the new message; the turn takes the rest at its start.
      const [first, ...rest] = carried;
      if (rest.length > 0) this.carry.set(sessionId, rest);
      else this.carry.delete(sessionId);
      try {
        const started = await this.startTurn(sessionId, { content: first.content, reason: "steer" });
        if (!started) throw new Error("session unavailable");
      } catch (error) {
        // Never lose what the user typed: park it at the head of the queue.
        const leftover = [first, ...this.takeCarryOver(sessionId)];
        const queue = this.deps.getQueueStore?.();
        if (queue) {
          for (const steer of leftover.reverse()) await queue.add(sessionId, steer.content, { front: true }).catch(() => undefined);
          this.deps.emit("chat:queue-updated", { sessionId });
        }
        throw error;
      }
      return;
    }

    if (this.lastOutcome.get(sessionId) !== "completed") return;
    const queue = this.deps.getQueueStore?.();
    if (!queue) return;
    const state = await queue.get(sessionId);
    if (!state.autoSend || state.items.length === 0) return;
    if (streamRegistry.getActiveTurnForSession(sessionId) || this.starting.has(sessionId)) return;
    const item = await queue.shift(sessionId);
    if (!item) return;
    this.deps.emit("chat:queue-updated", { sessionId });
    try {
      await this.startTurn(sessionId, { content: item.content, reason: "queue" });
    } catch (error) {
      await queue.add(sessionId, item.content, { front: true });
      this.deps.emit("chat:queue-updated", { sessionId });
      // Stop auto-sending after a failure; the next completed turn retries.
      this.lastOutcome.set(sessionId, "error");
      throw error;
    }
  }
}

export function createTurnScheduler(deps: TurnSchedulerDeps): TurnScheduler {
  return new TurnScheduler(deps);
}
