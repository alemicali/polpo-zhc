/**
 * Turn scheduler — decides what a chat session says next once a turn is over,
 * without depending on a browser being open:
 *
 * - **Undelivered steers** (the turn ended on an interactive tool, an error or
 *   the round limit before a safe point, or the steer arrived as it finished):
 *   they become the next message. They are stored at the head of the session's
 *   queue marked with their steer id (so a restart does not lose them, and they
 *   are sent whatever auto-send says). The next turn that starts on the session
 *   (e.g. the client's acknowledgement of navigate_to) takes them at its start;
 *   if none starts within a short grace period, the scheduler starts one itself.
 * - **Queued prompts**: when the session is idle and auto-send is on, the head
 *   is sent as a new turn. A turn that did not complete normally (error, Stop,
 *   waiting for the user, round limit) puts a persisted *hold* on auto-send
 *   until a turn completes or the user resumes it — also across restarts.
 *
 * One turn per session: the scheduler claims the session lease (session-lease.ts)
 * before taking anything from the queue and hands it to the turn it starts, so
 * dispatch is single-flight and never races a client's turn. Turns are started
 * through the regular completions endpoint (streaming, so clients can attach
 * with /resume) and announced with `chat:turn-started`.
 */

import type { AttachmentStore, ChatQueueStore, SessionStore } from "@polpo-ai/core";
import { streamRegistry } from "./stream-registry.js";
import { sessionLeases } from "./session-lease.js";
import { internalCallHeaders } from "./internal-call.js";

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
  /** Read an attachment file (project-relative path), to rebuild image parts for a branch's answer. */
  readAttachment?: (path: string) => Promise<Buffer>;
  emit: (event: string, data: unknown) => void;
  /** Run a request against the chat completions app (mounted at its root). */
  request: (req: Request) => Response | Promise<Response>;
  /** Bearer token for the internal request, when the completions app requires one. */
  apiKey?: string;
  /** Delays (ms) — overridable for tests. */
  delays?: { afterCompleted?: number; carryOver?: number; carryOverAfterInteractive?: number; afterError?: number; resumeStagger?: number };
}

export interface StartedTurn {
  turnId: string;
  userMessageId?: string;
}

export type SendNowResult =
  | { mode: "steer"; turnId: string; steerId: string }
  | { mode: "turn"; turnId: string }
  | { mode: "scheduled" };

/** The session already runs a turn. */
export class SessionBusyError extends Error {
  constructor() {
    super("Another response is running in this chat");
    this.name = "SessionBusyError";
  }
}

const DEFAULT_DELAYS = { afterCompleted: 250, carryOver: 300, carryOverAfterInteractive: 1500, afterError: 5000, resumeStagger: 500 };
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

let tokenCounter = 0;
const newToken = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(tokenCounter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export class TurnScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly delays: typeof DEFAULT_DELAYS;
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: TurnSchedulerDeps) {
    this.delays = { ...DEFAULT_DELAYS, ...deps.delays };
    // A turn (or anything but our own dispatch) freed a session: look for what comes next.
    this.unsubscribe = sessionLeases.onRelease((sessionId, kind) => {
      if (kind !== "dispatch") this.kick(sessionId, this.delays.afterCompleted);
    });
  }

  dispose(): void {
    this.unsubscribe();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Called by the completions loop when a turn on `sessionId` is over (before it frees the session). */
  async turnFinished(sessionId: string, outcome: TurnOutcome, undelivered: CarriedSteer[] = []): Promise<void> {
    const queue = this.deps.getQueueStore?.();
    // Auto-send only follows a turn that completed; anything else holds it (persisted).
    await queue?.setHold?.(sessionId, outcome === "completed" ? null : outcome).catch(() => undefined);
    if (undelivered.length > 0) {
      await this.carryOver(sessionId, undelivered, outcome);
      return;
    }
    const state = await queue?.get(sessionId).catch(() => undefined);
    if (state?.items.some((i) => i.steerId)) this.schedule(sessionId, this.delays.carryOver);
    else if (outcome === "completed") this.schedule(sessionId, this.delays.afterCompleted);
  }

  /** Hold auto-send for the session (e.g. the user pressed Stop). */
  async holdAutoSend(sessionId: string, reason: string): Promise<void> {
    await this.deps.getQueueStore?.()?.setHold?.(sessionId, reason).catch(() => undefined);
  }

  /**
   * Make steers the next message of the session: stored at the head of its queue (in order) with
   * their steer id, so they are sent regardless of auto-send — also after a restart.
   */
  async carryOver(sessionId: string, steers: CarriedSteer[], outcome?: TurnOutcome): Promise<void> {
    if (steers.length === 0) return;
    const queue = this.deps.getQueueStore?.();
    if (!queue) return;
    for (const steer of [...steers].reverse()) await queue.add(sessionId, steer.content, { front: true, steerId: steer.id });
    this.deps.emit("chat:queue-updated", { sessionId });
    const delay = outcome === "interactive" ? this.delays.carryOverAfterInteractive
      : outcome === "error" ? this.delays.afterError
        : this.delays.carryOver;
    this.schedule(sessionId, delay);
  }

  /** Is this steer id waiting in the session's queue as a carried-over steer? */
  async isCarried(sessionId: string, steerId: string): Promise<boolean> {
    const state = await this.deps.getQueueStore?.()?.get(sessionId).catch(() => undefined);
    return !!state?.items.some((i) => i.steerId === steerId);
  }

  /** Withdraw a carried-over steer that was not sent yet. */
  async cancelCarried(sessionId: string, steerId: string): Promise<boolean> {
    const queue = this.deps.getQueueStore?.();
    const item = (await queue?.get(sessionId).catch(() => undefined))?.items.find((i) => i.steerId === steerId);
    if (!queue || !item) return false;
    const removed = await queue.remove(sessionId, item.id);
    if (removed) this.deps.emit("chat:queue-updated", { sessionId });
    return !!removed;
  }

  /** Carried-over steers taken by the turn starting now (it injects them after its own message). */
  async takeCarryOver(sessionId: string): Promise<CarriedSteer[]> {
    const queue = this.deps.getQueueStore?.();
    if (!queue) return [];
    const carried = (await queue.get(sessionId)).items.filter((i) => i.steerId);
    const taken: CarriedSteer[] = [];
    for (const item of carried) {
      const removed = await queue.remove(sessionId, item.id);
      if (removed) taken.push({ id: item.steerId!, content: removed.content });
    }
    if (taken.length > 0) this.deps.emit("chat:queue-updated", { sessionId });
    return taken;
  }

  /** The queue changed (or was looked at): auto-send may apply now. */
  queueChanged(sessionId: string): void {
    this.kick(sessionId, 0);
  }

  /**
   * After a restart: sessions with queued prompts get a chance to send them (one at a time,
   * staggered). Held sessions and auto-send off still wait; carried-over steers go out.
   */
  async resumePending(): Promise<void> {
    const sessions = await this.deps.getQueueStore?.()?.sessionsWithItems?.().catch(() => []) ?? [];
    sessions.forEach((sessionId, index) => this.kick(sessionId, index * this.delays.resumeStagger));
  }

  /** Forget a session (deleted). */
  forget(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  /**
   * "Send now" for a queued prompt: steer the running turn when there is one, otherwise start a
   * turn with it (atomically: the item leaves the queue only when this call owns the session).
   * Returns undefined when the item no longer exists.
   */
  async sendNow(sessionId: string, itemId: string): Promise<SendNowResult | undefined> {
    const queue = this.deps.getQueueStore?.();
    if (!queue) return undefined;

    const live = streamRegistry.getActiveTurnForSession(sessionId);
    if (live && streamRegistry.isSteerable(live)) {
      const item = await queue.remove(sessionId, itemId);
      if (!item) return undefined;
      this.deps.emit("chat:queue-updated", { sessionId });
      const steered = streamRegistry.steer(live, { content: item.content });
      if (steered.ok) return { mode: "steer", turnId: live, steerId: steered.steer.id };
      await this.carryOver(sessionId, [{ id: item.id, content: item.content }]);
      return { mode: "scheduled" };
    }

    const token = newToken("dispatch");
    if (!sessionLeases.tryAcquire(sessionId, token, "dispatch")) {
      // Something is running or about to (a turn finishing, a channel turn): it goes next,
      // whatever auto-send says.
      const item = await queue.remove(sessionId, itemId);
      if (!item) return undefined;
      await queue.add(sessionId, item.content, { front: true, steerId: item.steerId ?? `next-${item.id}` });
      this.deps.emit("chat:queue-updated", { sessionId });
      return { mode: "scheduled" };
    }
    let handedOff = false;
    try {
      const item = await queue.remove(sessionId, itemId);
      if (!item) return undefined;
      this.deps.emit("chat:queue-updated", { sessionId });
      try {
        const started = await this.startTurn(sessionId, { content: item.content, reason: "send-now", leaseToken: token });
        if (!started) throw new Error("The chat is not available");
        handedOff = true;
        return { mode: "turn", turnId: started.turnId };
      } catch (error) {
        await queue.add(sessionId, item.content, { front: true }).catch(() => undefined);
        this.deps.emit("chat:queue-updated", { sessionId });
        throw error;
      }
    } finally {
      if (!handedOff) sessionLeases.release(sessionId, token);
    }
  }

  /**
   * Start a streaming turn on the session through the completions endpoint, with the stored
   * conversation as history. `content` is the new user message; without it the stored
   * conversation must already end with the user message to answer (a branch), whose images are
   * rebuilt from its attachments. Holds the session lease (claimed here, or `leaseToken` handed
   * by the caller) and passes it to the turn; throws SessionBusyError when the session is busy.
   */
  async startTurn(
    sessionId: string,
    opts: { content?: string; reason: TurnStartReason; leaseToken?: string },
  ): Promise<StartedTurn | undefined> {
    const token = opts.leaseToken ?? newToken("dispatch");
    if (!opts.leaseToken && !sessionLeases.tryAcquire(sessionId, token, "dispatch")) throw new SessionBusyError();
    let handedOff = false;
    try {
      const sessionStore = this.deps.getSessionStore();
      if (!sessionStore) return undefined;
      const session = await sessionStore.getSession(sessionId);
      if (!session) return undefined;
      const history = await sessionStore.getMessages(sessionId);
      const attachments = await (this.deps.getAttachmentStore?.()?.getBySession(sessionId) ?? Promise.resolve([])).catch(() => []);
      const byMessage = new Map<string, typeof attachments>();
      for (const attachment of attachments) {
        if (!attachment.messageId) continue;
        byMessage.set(attachment.messageId, [...(byMessage.get(attachment.messageId) ?? []), attachment]);
      }
      type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
      const messages: Array<{ role: string; content: string | Part[] }> = history
        .map((m) => ({
          id: m.id,
          role: m.role,
          content: [m.content, ...(byMessage.get(m.id) ?? []).map((a) => `[file: ${a.path}]`)].filter(Boolean).join("\n\n"),
        }))
        .filter((m) => m.content.trim().length > 0)
        .map(({ role, content }) => ({ role, content }));
      if (opts.content !== undefined) {
        messages.push({ role: "user", content: opts.content });
      } else {
        // A branch answers its last (stored) user message again: give the model its images too,
        // like the original turn had them.
        const lastUser = [...history].reverse().find((m) => m.role === "user");
        const files = lastUser ? byMessage.get(lastUser.id) ?? [] : [];
        const images = files.filter((a) => IMAGE_TYPES.has(a.mimeType));
        if (lastUser && images.length > 0 && this.deps.readAttachment) {
          const parts: Part[] = [];
          const text = [lastUser.content, ...files.filter((a) => !IMAGE_TYPES.has(a.mimeType)).map((a) => `[file: ${a.path}]`)]
            .filter(Boolean).join("\n\n");
          if (text) parts.push({ type: "text", text });
          for (const image of images) {
            try {
              const bytes = await this.deps.readAttachment(image.path);
              parts.push({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${bytes.toString("base64")}` } });
            } catch {
              parts.push({ type: "text", text: `[file: ${image.path}]` });
            }
          }
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "user") { messages[i] = { role: "user", content: parts }; break; }
          }
        }
      }
      if (!messages.some((m) => m.role === "user")) return undefined;

      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-session-id": sessionId,
        "x-polpo-turn-reason": opts.reason,
        "x-polpo-lease": token,
        ...internalCallHeaders(),
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
        if (response.status === 409) throw new SessionBusyError();
        throw new Error(payload?.error?.message ?? `Could not start the turn (${response.status})`);
      }
      // The turn owns the session now.
      handedOff = true;
      const turnId = response.headers.get("x-turn-id");
      // Nobody reads this response: drain it so the turn streams into the registry at full speed.
      void (async () => {
        const reader = response.body?.getReader();
        if (!reader) return;
        try { while (!(await reader.read()).done) { /* drain */ } } catch { /* turn ended */ }
      })();
      if (!turnId) return undefined;
      const userMessageId = response.headers.get("x-user-message-id") ?? undefined;
      this.deps.emit("chat:turn-started", { sessionId, turnId, reason: opts.reason, ...(userMessageId ? { userMessageId } : {}) });
      return { turnId, userMessageId };
    } finally {
      // Ours to release only if the turn never took it (an error, or a lease we claimed here).
      if (!handedOff && !opts.leaseToken) sessionLeases.release(sessionId, token);
    }
  }

  /** Look for work soon, unless a (possibly longer, deliberate) wait is already set. */
  private kick(sessionId: string, delay: number): void {
    if (this.timers.has(sessionId)) return;
    this.schedule(sessionId, delay);
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

  /**
   * May auto-send run now? Not while held (the last turn errored, was stopped, waits for the
   * user…), nor when the stored conversation ends on a question to the user.
   */
  private async autoSendAllowed(sessionId: string, state: { autoSend: boolean; hold?: string }): Promise<boolean> {
    if (!state.autoSend || state.hold) return false;
    const recent = await this.deps.getSessionStore()?.getRecentMessages(sessionId, 1).catch(() => []) ?? [];
    const last = recent[0];
    return !(last?.role === "assistant" && last.toolCalls?.some((call) => call.state === "interrupted"));
  }

  /**
   * Send what comes next, if the session is free: carried-over steers first, then the queue.
   * Single-flight per session: the session lease is claimed before anything is taken.
   */
  private async dispatch(sessionId: string): Promise<void> {
    const queue = this.deps.getQueueStore?.();
    if (!queue) return;
    const token = newToken("dispatch");
    // Busy: whoever holds it releases it when done, which brings us back here.
    if (!sessionLeases.tryAcquire(sessionId, token, "dispatch")) return;
    let handedOff = false;
    try {
      const state = await queue.get(sessionId);
      // Carried-over steers (and "send now" while busy) first, whatever auto-send says.
      const forced = state.items.find((i) => i.steerId);
      let item: Awaited<ReturnType<ChatQueueStore["shift"]>>;
      if (forced) {
        item = await queue.remove(sessionId, forced.id);
      } else {
        if (state.items.length === 0 || !(await this.autoSendAllowed(sessionId, state))) return;
        item = await queue.shift(sessionId);
      }
      if (!item) return;
      this.deps.emit("chat:queue-updated", { sessionId });
      try {
        const started = await this.startTurn(sessionId, { content: item.content, reason: item.steerId ? "steer" : "queue", leaseToken: token });
        if (!started) throw new Error("The chat is not available");
        handedOff = true;
      } catch (error) {
        // Never lose what the user typed: back to the head of the queue, still marked if it was.
        await queue.add(sessionId, item.content, { front: true, ...(item.steerId ? { steerId: item.steerId } : {}) });
        this.deps.emit("chat:queue-updated", { sessionId });
        if (!(error instanceof SessionBusyError)) {
          // Hold auto-send after a failure; a completed turn or the user resumes it.
          await queue.setHold?.(sessionId, "error").catch(() => undefined);
          throw error;
        }
      }
    } finally {
      if (!handedOff) sessionLeases.release(sessionId, token);
    }
  }
}

export function createTurnScheduler(deps: TurnSchedulerDeps): TurnScheduler {
  return new TurnScheduler(deps);
}
