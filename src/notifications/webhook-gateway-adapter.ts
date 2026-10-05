/**
 * Webhook Gateway Adapter — lets any HTTP client (iOS Shortcuts, scripts, other apps)
 * talk to Polpo or an agent through the same ChannelGateway as Telegram: commands,
 * /agent, suggestions, sessions (per-peer/shared, idle timeout), attachments and files.
 *
 * Unlike Telegram the reply goes back in the HTTP response, so messages the gateway
 * would send while the turn is still running (partial responses) are collected and
 * returned together with the final reply.
 */

import type { InboundAttachment } from "./channels/telegram.js";
import type { ChannelGateway, ChannelOutboundFile, ReplyButton } from "./channel-gateway.js";

export interface WebhookInboundMessage {
  /** Caller identity (e.g. "alessio-iphone"); one peer, with its own sessions, per sender. */
  sender?: string;
  /** Display name shown to the agent. */
  name?: string;
  text?: string;
  /** Optional id for idempotent retries. */
  messageId?: string;
  attachments?: InboundAttachment[];
  /** Button press from a previous reply, e.g. "agent:health-coach". */
  callback?: string;
}

export interface WebhookReply {
  /** Every message of the turn, oldest first (partial responses, then the final reply). */
  messages: string[];
  /** The final reply. */
  text: string;
  buttons?: ReplyButton[][];
  forceReply?: { placeholder?: string };
  files?: ChannelOutboundFile[];
}

export const DEFAULT_WEBHOOK_SENDER = "default";
const SENDER = /^[A-Za-z0-9_.@+-]{1,64}$/;

/** Sender ids become peer ids ("webhook:<sender>"): keep them short and safe. */
export function normalizeWebhookSender(sender: string | undefined): string | undefined {
  const value = (sender ?? "").trim();
  if (!value) return DEFAULT_WEBHOOK_SENDER;
  return SENDER.test(value) ? value : undefined;
}

export class WebhookGatewayAdapter {
  /** chatId → messages sent while a request for that chat is in flight. */
  private collectors = new Map<string, string[][]>();

  constructor(private gateway: ChannelGateway) {
    gateway.setPartialResponseHandler(async (chatId, text) => {
      const stack = this.collectors.get(chatId);
      stack?.[stack.length - 1]?.push(text);
    });
  }

  /** Route one inbound request; undefined when the gateway ignores it (inbound off, policy disabled). */
  async handle(input: WebhookInboundMessage): Promise<WebhookReply | undefined> {
    const externalId = normalizeWebhookSender(input.sender) ?? DEFAULT_WEBHOOK_SENDER;
    const base = { channel: "webhook" as const, externalId, chatId: externalId, displayName: input.name?.trim() || undefined };

    if (input.callback) {
      const sep = input.callback.indexOf(":");
      if (sep <= 0) return undefined;
      const text = await this.gateway.handleMenuCallback(input.callback.slice(0, sep), input.callback.slice(sep + 1), base);
      return text === undefined ? undefined : { messages: [text], text };
    }

    const partials: string[] = [];
    const stack = this.collectors.get(externalId) ?? [];
    stack.push(partials);
    this.collectors.set(externalId, stack);
    try {
      const reply = await this.gateway.handleMessageReply({
        ...base,
        text: input.text ?? "",
        messageId: input.messageId,
        attachments: input.attachments,
      });
      if (!reply) return undefined;
      return {
        messages: [...partials, reply.text].filter(m => m.trim()),
        text: reply.text,
        ...(reply.buttons ? { buttons: reply.buttons } : {}),
        ...(reply.forceReply ? { forceReply: reply.forceReply } : {}),
        ...(reply.files?.length ? { files: reply.files } : {}),
      };
    } finally {
      stack.splice(stack.indexOf(partials), 1);
      if (stack.length === 0) this.collectors.delete(externalId);
    }
  }
}
