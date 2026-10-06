/**
 * Turn scheduler — decides what a chat session says next once a turn is over,
 * without depending on a browser being open:
 *
 * - **Undelivered steers** (the turn ended on an interactive tool, an error or
 *   the round limit before a safe point, or the steer arrived as it finished):
 *   they become the next message. They are stored at the head of the session's
 *   queue (so a restart does not lose them) and marked to be sent regardless of
 *   auto-send. The next turn that starts on the session (e.g. the client's
 *   acknowledgement of navigate_to) takes them at its start; if none starts
 *   within a short grace period, the scheduler starts one itself.
 * - **Queued prompts**: when the session is idle after a normally completed
 *   turn (or after a restart, unless the conversation waits for the user) and
 *   auto-send is on, the head is sent as a new turn.
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

/** The session already runs a turn. */
export class SessionBusyError extends Error {
  constructor() {
    super("Another response is running in this chat");
    this.name = "SessionBusyError";
  }
}

const DEFAULT_DELAYS = { afterCompleted: 250, carryOver: 300, carryOverAfterInteractive: 1500 };
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

let tokenCounter = 0;
const newToken = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(tokenCounter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

interface ForcedItem {
  /** Steer id the client knows (to withdraw it). */
  steerId: string;
  /** Queue item holding it. */
  itemId: string;
}

export class TurnScheduler {
  /** Queue items that are carried-over steers: sent first, whatever auto-send says. */
  private readonly forced = new Map<string, ForcedItem[]>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastOutcome = new Map<string, TurnOutcome>();
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
    this.lastOutcome.set(sessionId, outcome);
    if (undelivered.length > 0) await this.carryOver(sessionId, undelivered, outcome);
    else if (this.forced.get(sessionId)?.length) this.schedule(sessionId, this.delays.carryOver);
    else if (outcome === "completed") this.schedule(sessionId, this.delays.afterCompleted);
  }

  /**
   * Make steers the next message of the session: stored at the head of its queue (in order) and
   * sent regardless of auto-send.
   */
  async carryOver(sessionId: string, steers: CarriedSteer[], outcome?: TurnOutcome): Promise<void> {
    if (steers.length === 0) return;
    const queue = this.deps.getQueueStore?.();
    const forced = this.forced.get(sessionId) ?? [];
    if (queue) {
      const added: ForcedItem[] = [];
      for (const steer of [...steers].reverse()) {
        const item = await queue.add(sessionId, steer.content, { front: true });
        added.unshift({ steerId: steer.id, itemId: item.id });
      }
      this.forced.set(sessionId, [...added, ...forced]);
      this.deps.emit("chat:queue-updated", { sessionId });
    }
    this.schedule(sessionId, outcome === "interactive" ? this.delays.carryOverAfterInteractive : this.delays.carryOver);
  }

  /** Is this steer id waiting as a carried-over steer? */
  isCarried(steerId: string): boolean {
    for (const list of this.forced.values()) if (list.some((f) => f.steerId === steerId)) return true;
    return false;
  }

  /** Withdraw a carried-over steer that was not sent yet. */
  async cancelCarried(steerId: string): Promise<boolean> {
    for (const [sessionId, list] of this.forced) {
      const index = list.findIndex((f) => f.steerId === steerId);
      if (index < 0) continue;
      const [entry] = list.splice(index, 1);
      if (list.length === 0) this.forced.delete(sessionId);
      const removed = await this.deps.getQueueStore?.()?.remove(sessionId, entry.itemId);
      if (removed) this.deps.emit("chat:queue-updated", { sessionId });
      return !!removed;
    }
    return false;
  }

  /** Carried-over steers taken by the turn starting now (it injects them after its own message). */
  async takeCarryOver(sessionId: string): Promise<CarriedSteer[]> {
    const forced = this.forced.get(sessionId) ?? [];
    this.forced.delete(sessionId);
    if (forced.length === 0) return [];
    const queue = this.deps.getQueueStore?.();
    const taken: CarriedSteer[] = [];
    for (const entry of forced) {
      const item = await queue?.remove(sessionId, entry.itemId);
      if (item) taken.push({ id: entry.steerId, content: item.content });
    }
    if (taken.length > 0) this.deps.emit("chat:queue-updated", { sessionId });
    return taken;
  }

  /** The queue changed (or was looked at): auto-send may apply now. */
  queueChanged(sessionId: string): void {
    this.kick(sessionId, 0);
  }

  /** After a restart: sessions with queued prompts get a chance to send them. */
  async resumePending(): Promise<void> {
    const sessions = await this.deps.getQueueStore?.()?.sessionsWithItems?.().catch(() => []) ?? [];
    for (const sessionId of sessions) this.kick(sessionId, 0);
  }

  /** Forget a session (deleted). */
  forget(sessionId: string): void {
    this.forced.delete(sessionId);
    this.lastOutcome.delete(sessionId);
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
      // Something is running or about to (a turn finishing, a channel turn): it goes next.
      const state = await queue.get(sessionId);
      if (!state.items.some((i) => i.id === itemId)) return undefined;
      await queue.reorder(sessionId, [itemId]);
      const forced = this.forced.get(sessionId) ?? [];
      if (!forced.some((f) => f.itemId === itemId)) this.forced.set(sessionId, [{ steerId: itemId, itemId }, ...forced]);
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
      this.lastOutcome.delete(sessionId);
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

  /** May auto-send run now? After a completed turn; after a restart, unless the chat waits for the user. */
  private async autoSendAllowed(sessionId: string): Promise<boolean> {
    const outcome = this.lastOutcome.get(sessionId);
    if (outcome) return outcome === "completed";
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
      let content: string | undefined;
      let forcedEntry: ForcedItem | undefined;
      let reason: TurnStartReason = "queue";
      const forced = this.forced.get(sessionId) ?? [];
      while (forced.length > 0 && content === undefined) {
        const entry = forced.shift()!;
        const item = await queue.remove(sessionId, entry.itemId);
        if (item) {
          content = item.content;
          forcedEntry = entry;
          reason = "steer";
        }
      }
      if (forced.length === 0) this.forced.delete(sessionId);
      if (content === undefined) {
        const state = await queue.get(sessionId);
        if (!state.autoSend || state.items.length === 0) return;
        if (!(await this.autoSendAllowed(sessionId))) return;
        const item = await queue.shift(sessionId);
        if (!item) return;
        content = item.content;
      }
      this.deps.emit("chat:queue-updated", { sessionId });
      try {
        const started = await this.startTurn(sessionId, { content, reason, leaseToken: token });
        if (!started) throw new Error("The chat is not available");
        handedOff = true;
      } catch (error) {
        // Never lose what the user typed: back to the head of the queue.
        const item = await queue.add(sessionId, content, { front: true });
        if (forcedEntry) this.forced.set(sessionId, [{ steerId: forcedEntry.steerId, itemId: item.id }, ...(this.forced.get(sessionId) ?? [])]);
        this.deps.emit("chat:queue-updated", { sessionId });
        if (!(error instanceof SessionBusyError)) {
          // Stop auto-sending after a failure; the next completed turn retries.
          this.lastOutcome.set(sessionId, "error");
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
