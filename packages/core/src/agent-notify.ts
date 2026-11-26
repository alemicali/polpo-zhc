/**
 * Agents posting to a notification channel (send_notification): the per-agent allowlist.
 *
 * An agent gets the tool only when its owner allows it twice: `send_notification` in its
 * allowedTools and at least one channel in `notifyChannels`. Each entry names a configured channel
 * (settings.notifications.channels) and, optionally, the targets within it the agent may pick
 * (`to`: a Slack channel id, a Telegram chat id, an email address…):
 *
 *   notifyChannels: "*"                                   every channel, its default target only
 *   notifyChannels: [{ channel: "slack" }]                that channel, its default target only
 *   notifyChannels: [{ channel: "slack", targets: ["C0LEADS"] }]   only #C0LEADS (to is required)
 *   notifyChannels: [{ channel: "slack", targets: ["*"] }]         any target on that channel
 *
 * A Slack thread (threadTs) is always allowed within an allowed target. The checks here are pure;
 * the send (rate limit, the notification router, the history's origin) is in
 * src/notifications/agent-notify.ts, on the server, as the agent.
 */

/** The tool's name (the same as Polpo's own tool). */
export const AGENT_NOTIFY_TOOL = "send_notification";

/** Default and bounds of the per-agent rate limit (messages per minute). */
export const AGENT_NOTIFY_DEFAULT_PER_MINUTE = 5;
export const AGENT_NOTIFY_MAX_PER_MINUTE = 60;
/** Longest body and title an agent may send. */
export const AGENT_NOTIFY_MAX_BODY = 8000;
export const AGENT_NOTIFY_MAX_TITLE = 200;

export interface AgentNotifyChannel {
  /** A configured channel's name (settings.notifications.channels). */
  channel: string;
  /** Targets within it the agent may pick with `to` ("*" = any); absent or empty = the channel's default target only. */
  targets?: string[];
}

/** "*" = every configured channel, default targets only. */
export type AgentNotifyChannels = "*" | AgentNotifyChannel[];

/** What an agent asks to send. */
export interface AgentNotifyRequest {
  channel: string;
  /** Target within the channel (Slack channel id, Telegram chat id, email address); absent = the channel's default. */
  to?: string;
  /** Slack: post in this thread (the parent message's ts). */
  threadTs?: string;
  title?: string;
  body: string;
  severity?: "info" | "warning" | "critical";
}

/** Who sent a notification (kept in the notification history). */
export interface NotificationOrigin {
  kind: "agent";
  agent: string;
  taskId?: string;
  missionId?: string;
  sessionId?: string;
  runId?: string;
}

const CHANNEL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** Shape problems of a notifyChannels value (empty: fine). */
export function agentNotifyChannelsProblems(value: unknown): string[] {
  if (value === undefined || value === null || value === "*") return [];
  if (!Array.isArray(value)) return ['notifyChannels must be "*" or a list of { channel, targets? }'];
  const problems: string[] = [];
  value.forEach((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) { problems.push(`notifyChannels[${i}] must be an object { channel, targets? }`); return; }
    const e = entry as Record<string, unknown>;
    if (typeof e.channel !== "string" || !CHANNEL_NAME.test(e.channel.trim())) problems.push(`notifyChannels[${i}].channel must be a channel name`);
    if (e.targets !== undefined && (!Array.isArray(e.targets) || e.targets.some((t) => typeof t !== "string" || !t.trim() || t.length > 320))) {
      problems.push(`notifyChannels[${i}].targets must be a list of targets (a Slack channel id, a chat id, an email address, or "*")`);
    }
    const extra = Object.keys(e).filter((k) => k !== "channel" && k !== "targets");
    if (extra.length) problems.push(`notifyChannels[${i}]: unknown field ${extra.join(", ")}`);
  });
  return problems;
}

/**
 * Tidy a notifyChannels value: trimmed names, one entry per channel (targets merged, deduplicated),
 * a "*" target swallowing the others; an empty list becomes undefined (no channel: no tool).
 */
export function normalizeAgentNotifyChannels(value: unknown): AgentNotifyChannels | undefined {
  if (value === "*") return "*";
  if (!Array.isArray(value)) return undefined;
  const byChannel = new Map<string, Set<string> | undefined>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const channel = typeof (entry as AgentNotifyChannel).channel === "string" ? (entry as AgentNotifyChannel).channel.trim() : "";
    if (!channel) continue;
    const targets = Array.isArray((entry as AgentNotifyChannel).targets)
      ? (entry as AgentNotifyChannel).targets!.map((t) => String(t).trim()).filter(Boolean)
      : [];
    const prev = byChannel.get(channel);
    if (!targets.length) { if (!byChannel.has(channel)) byChannel.set(channel, undefined); continue; }
    const set = prev ?? new Set<string>();
    for (const t of targets) set.add(t);
    byChannel.set(channel, set);
  }
  if (!byChannel.size) return undefined;
  return [...byChannel.entries()].map(([channel, set]) => {
    if (!set || !set.size) return { channel };
    return { channel, targets: set.has("*") ? ["*"] : [...set] };
  });
}

/** Configured channels the allowlist names that do not exist (yet): a warning, never an error. */
export function agentNotifyChannelWarnings(value: AgentNotifyChannels | undefined, configured: readonly string[]): string[] {
  if (!value || value === "*") return [];
  const known = new Set(configured);
  return value.filter((e) => !known.has(e.channel))
    .map((e) => `notifyChannels: channel "${e.channel}" is not configured (yet): the agent cannot post to it until it exists (Settings → Notifications)`);
}

/** Does allowedTools give the tool (its exact name, or a pattern like "send_*")? */
export function allowedToolsInclude(allowedTools: readonly string[] | undefined, name: string): boolean {
  if (!allowedTools?.length) return false;
  return allowedTools.some((a) => {
    const p = a.trim().toLowerCase();
    if (p === name) return true;
    if (!p.includes("*")) return false;
    const re = new RegExp(`^${p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return re.test(name);
  });
}

/** Is send_notification offered to this agent (allowedTools and a non-empty allowlist)? */
export function agentHasNotifyTool(agent: { allowedTools?: string[]; notifyChannels?: AgentNotifyChannels }): boolean {
  const allow = agent.notifyChannels;
  const hasChannels = allow === "*" || (Array.isArray(allow) && allow.length > 0);
  return hasChannels && allowedToolsInclude(agent.allowedTools, AGENT_NOTIFY_TOOL);
}

/** The per-agent rate limit (messages per minute), within bounds. */
export function agentNotifyPerMinute(agent: { notifyRateLimit?: number }): number {
  const n = agent.notifyRateLimit;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 1) return AGENT_NOTIFY_DEFAULT_PER_MINUTE;
  return Math.min(AGENT_NOTIFY_MAX_PER_MINUTE, Math.floor(n));
}

/** What the agent may send to, in a sentence (the tool's description and refusals). */
export function describeAgentNotifyAllowlist(value: AgentNotifyChannels | undefined, configured?: readonly string[]): string {
  if (!value) return "no channel";
  if (value === "*") {
    return configured?.length
      ? `every configured channel (${configured.map((c) => `"${c}"`).join(", ")}), each to its default target only (no \`to\`)`
      : "every configured channel, each to its default target only (no `to`)";
  }
  return value.map((e) => {
    if (!e.targets?.length) return `"${e.channel}" (its default target only, no \`to\`)`;
    if (e.targets.includes("*")) return `"${e.channel}" (any target)`;
    return `"${e.channel}" (to: ${e.targets.map((t) => `"${t}"`).join(", ")})`;
  }).join("; ");
}

/** Check a request against the allowlist: undefined when allowed, else why not (with what is allowed). */
export function agentNotifyRefusal(
  agent: { name: string; allowedTools?: string[]; notifyChannels?: AgentNotifyChannels },
  req: Pick<AgentNotifyRequest, "channel" | "to">,
  configured?: readonly string[],
): string | undefined {
  if (!agentHasNotifyTool(agent)) {
    return `Agent "${agent.name}" may not send notifications (it needs ${AGENT_NOTIFY_TOOL} in allowedTools and at least one channel in notifyChannels)`;
  }
  const allow = agent.notifyChannels!;
  const allowed = `Allowed: ${describeAgentNotifyAllowlist(allow, configured)}.`;
  const channel = (req.channel ?? "").trim();
  const to = typeof req.to === "string" ? req.to.trim() : "";
  if (!channel) return `A channel is required. ${allowed}`;
  if (allow === "*") {
    if (configured && !configured.includes(channel)) return `Channel "${channel}" is not configured. ${allowed}`;
    if (to) return `Agent "${agent.name}" may only post to the default target of "${channel}" (no \`to\`). ${allowed}`;
    return undefined;
  }
  const entry = allow.find((e) => e.channel === channel);
  if (!entry) return `Agent "${agent.name}" may not post to channel "${channel}". ${allowed}`;
  const targets = entry.targets ?? [];
  if (!targets.length) {
    if (to) return `Agent "${agent.name}" may only post to the default target of "${channel}" (no \`to\`). ${allowed}`;
    return undefined;
  }
  if (targets.includes("*")) return undefined;
  if (!to) return `Channel "${channel}" needs a target (\`to\`) for agent "${agent.name}". ${allowed}`;
  if (!targets.includes(to)) return `Agent "${agent.name}" may not post to "${to}" on "${channel}". ${allowed}`;
  return undefined;
}

/** The record name the notification history shows for an agent's message. */
export function agentNotifyRuleName(origin: NotificationOrigin): string {
  const where = origin.taskId ? ` · task ${origin.taskId}` : origin.sessionId ? ` · chat ${origin.sessionId}` : "";
  return `Agent ${origin.agent}${where}`;
}
