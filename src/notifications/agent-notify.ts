/**
 * An agent posts to a notification channel (send_notification), on the server, as the agent.
 *
 * One path for every engine and surface: Polpo's engine in chats (in this process), task runs on
 * any engine (Polpo's, a harness, a CLI: the runner asks over the notification socket and the
 * orchestrator answers with the run's agent, never one named in the request) and CLI chats. Each
 * send is checked here against the agent's allowlist (notifyChannels + send_notification in
 * allowedTools, see @polpo-ai/core agent-notify.ts) and its rate limit, then goes through the
 * notification router like POST /notifications/send (sendDirect, throwOnError: a refused message
 * is an error the agent sees), with the agent and its task / mission / chat as the record's origin.
 *
 * Prompt-injection hygiene: only what the agent writes is sent (title and body as text, bounded);
 * the channel and target come from the owner's allowlist, never from content the agent read.
 */
import {
  AGENT_NOTIFY_MAX_BODY, AGENT_NOTIFY_MAX_TITLE, agentNotifyPerMinute, agentNotifyRefusal, agentNotifyRuleName,
  type AgentConfig, type AgentNotifyRequest, type NotificationOrigin,
} from "@polpo-ai/core";

/** What the sender needs from the notification router (NotificationRouter). */
export interface AgentNotifyRouter {
  getChannelIds(): string[];
  sendDirect(opts: {
    channel: string; title: string; body: string; severity?: "info" | "warning" | "critical";
    throwOnError?: boolean; ruleName?: string; target?: { chatId?: string; threadTs?: string }; origin?: NotificationOrigin;
  }): Promise<{ id: string }>;
}

/** The result an agent gets back. */
export interface AgentNotifyResult { id: string; channel: string; to?: string }

/** A refusal (allowlist, rate limit, no router): the message the agent sees. */
export class AgentNotifyError extends Error {
  constructor(message: string, readonly code: "NOT_ALLOWED" | "RATE_LIMITED" | "NOT_CONFIGURED" | "INVALID" | "SEND_FAILED") {
    super(message);
    this.name = "AgentNotifyError";
  }
}

const WINDOW_MS = 60_000;

/** The sender for one instance: the router, and each agent's sends in the last minute. */
export class AgentNotifier {
  private readonly sent = new Map<string, number[]>();

  constructor(private readonly deps: { router: () => AgentNotifyRouter | undefined; now?: () => number }) {}

  /** Send as `agent` (its config decides what is allowed), recording `origin`. */
  async send(agent: AgentConfig, req: AgentNotifyRequest, origin: Omit<NotificationOrigin, "kind" | "agent">): Promise<AgentNotifyResult> {
    const router = this.deps.router();
    if (!router) throw new AgentNotifyError("Notifications are not configured on this server (Settings → Notifications)", "NOT_CONFIGURED");
    const channel = typeof req.channel === "string" ? req.channel.trim() : "";
    const to = typeof req.to === "string" && req.to.trim() ? req.to.trim() : undefined;
    const threadTs = typeof req.threadTs === "string" && req.threadTs.trim() ? req.threadTs.trim() : undefined;
    const refusal = agentNotifyRefusal(agent, { channel, ...(to ? { to } : {}) }, router.getChannelIds());
    if (refusal) throw new AgentNotifyError(refusal, "NOT_ALLOWED");
    if (!router.getChannelIds().includes(channel)) {
      throw new AgentNotifyError(`Channel "${channel}" is not configured on this server (Settings → Notifications)`, "NOT_CONFIGURED");
    }
    const body = typeof req.body === "string" ? req.body.trim() : "";
    if (!body) throw new AgentNotifyError("The message body is empty", "INVALID");
    if (body.length > AGENT_NOTIFY_MAX_BODY) throw new AgentNotifyError(`The message is too long (${body.length} characters, at most ${AGENT_NOTIFY_MAX_BODY})`, "INVALID");
    const severity = req.severity === "warning" || req.severity === "critical" ? req.severity : "info";
    const title = (typeof req.title === "string" && req.title.trim() ? req.title.trim() : `Message from ${agent.identity?.displayName || agent.name}`)
      .replace(/\s+/g, " ").slice(0, AGENT_NOTIFY_MAX_TITLE);

    // rate limit: per agent, a sliding minute
    const now = (this.deps.now ?? Date.now)();
    const limit = agentNotifyPerMinute(agent);
    const recent = (this.sent.get(agent.name) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= limit) {
      const waitS = Math.max(1, Math.ceil((WINDOW_MS - (now - recent[0]!)) / 1000));
      this.sent.set(agent.name, recent);
      throw new AgentNotifyError(`Rate limit: agent "${agent.name}" may send ${limit} notification${limit === 1 ? "" : "s"} per minute; try again in ${waitS}s`, "RATE_LIMITED");
    }
    recent.push(now);
    this.sent.set(agent.name, recent);

    const full: NotificationOrigin = { kind: "agent", agent: agent.name, ...origin };
    try {
      const r = await router.sendDirect({
        channel, title, body, severity, throwOnError: true, ruleName: agentNotifyRuleName(full), origin: full,
        ...(to || threadTs ? { target: { ...(to ? { chatId: to } : {}), ...(threadTs ? { threadTs } : {}) } } : {}),
      });
      return { id: r.id, channel, ...(to ? { to } : {}) };
    } catch (err) {
      throw new AgentNotifyError(`Not sent to "${channel}": ${err instanceof Error ? err.message : String(err)}`, "SEND_FAILED");
    }
  }
}

const notifiers = new Map<string, AgentNotifier>();

/** The instance's sender, registered by the server for its .polpo directory. */
export function registerAgentNotifier(polpoDir: string, notifier: AgentNotifier): () => void {
  notifiers.set(polpoDir, notifier);
  return () => { if (notifiers.get(polpoDir) === notifier) notifiers.delete(polpoDir); };
}

/** The sender of this process for a .polpo directory (the server's; none in a task runner). */
export function agentNotifierFor(polpoDir: string | undefined): AgentNotifier | undefined {
  return polpoDir ? notifiers.get(polpoDir) : undefined;
}
