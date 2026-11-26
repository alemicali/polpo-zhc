/**
 * The agents' `send_notification` tool: post a message to a notification channel the owner allows
 * (a Slack channel as the Polpo bot, a Telegram chat, an email address, a webhook, push…).
 *
 * Offered only with `send_notification` in allowedTools and at least one channel in the agent's
 * notifyChannels; its description names what is allowed. Every engine gets the same tool (Polpo's
 * engine; harness and CLI runtimes as a host tool) and every send is checked again where it runs:
 * the server, as the agent (src/notifications/agent-notify.ts). The tool only carries what the agent
 * writes: the channel and target must be in the allowlist.
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  AGENT_NOTIFY_MAX_BODY, AGENT_NOTIFY_MAX_TITLE, AGENT_NOTIFY_TOOL, agentHasNotifyTool, agentNotifyPerMinute, agentNotifyRefusal,
  describeAgentNotifyAllowlist, type AgentConfig, type AgentNotifyRequest,
} from "@polpo-ai/core";

export const AGENT_NOTIFY_TOOL_NAMES = [AGENT_NOTIFY_TOOL] as const;

/** How a run sends: in the server process, or over the notification socket from a task run. */
export interface AgentNotifyAccess {
  send(req: AgentNotifyRequest): Promise<{ id: string; channel: string; to?: string }>;
}

/** The send_notification tool when the agent has it (allowedTools + notifyChannels) and a way to send. */
export function createAgentNotifyTools(agent: AgentConfig, access: AgentNotifyAccess | undefined): AgentTool<any>[] {
  if (!access || !agentHasNotifyTool(agent)) return [];
  const allowed = describeAgentNotifyAllowlist(agent.notifyChannels);
  const tool: AgentTool<any> = {
    name: AGENT_NOTIFY_TOOL,
    label: "Send Notification",
    description: "Post a message to a notification channel your owner allows (Slack as the Polpo bot, Telegram, email, webhook, push…). "
      + `Allowed: ${allowed}. On Slack, \`to\` is the Slack channel id (C0123…) and thread_ts posts in a thread. `
      + `Write the whole message yourself: it is sent as you write it. At most ${agentNotifyPerMinute(agent)} per minute.`,
    parameters: Type.Object({
      channel: Type.String({ description: "The configured channel's name (from the allowed list)" }),
      to: Type.Optional(Type.String({ description: "Target within the channel, only if allowed: Slack channel id, Telegram chat id, email address. Omit for the channel's default." })),
      thread_ts: Type.Optional(Type.String({ description: "Slack: post in this thread (the parent message's ts, e.g. 1712345678.123456)" })),
      title: Type.Optional(Type.String({ maxLength: AGENT_NOTIFY_MAX_TITLE, description: "A short title (default: a message from you)" })),
      body: Type.String({ minLength: 1, maxLength: AGENT_NOTIFY_MAX_BODY, description: "The message (markdown or plain text)" }),
      severity: Type.Optional(Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("critical")], { description: "Default info" })),
    }),
    async execute(_id: string, params: { channel: string; to?: string; thread_ts?: string; title?: string; body: string; severity?: "info" | "warning" | "critical" }) {
      const fail = (text: string) => ({ content: [{ type: "text" as const, text: `Error: ${text}` }], details: { error: true } });
      const req: AgentNotifyRequest = {
        channel: String(params.channel ?? "").trim(),
        ...(typeof params.to === "string" && params.to.trim() ? { to: params.to.trim() } : {}),
        ...(typeof params.thread_ts === "string" && params.thread_ts.trim() ? { threadTs: params.thread_ts.trim() } : {}),
        ...(typeof params.title === "string" && params.title.trim() ? { title: params.title } : {}),
        body: String(params.body ?? ""),
        ...(params.severity ? { severity: params.severity } : {}),
      };
      // a refusal here saves a round trip; the server checks again
      const refusal = agentNotifyRefusal(agent, req);
      if (refusal) return fail(refusal);
      try {
        const r = await access.send(req);
        return {
          content: [{ type: "text" as const, text: `Notification sent to "${r.channel}"${r.to ? ` (${r.to}${req.threadTs ? `, thread ${req.threadTs}` : ""})` : ""} [${r.id}].` }],
          details: { notificationId: r.id, channel: r.channel, ...(r.to ? { to: r.to } : {}) },
        };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  };
  return [tool];
}
