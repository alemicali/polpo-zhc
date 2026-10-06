/**
 * Telegram Gateway Adapter — bridges TelegramCallbackPoller to ChannelGateway.
 *
 * This adapter implements the TelegramGatewayHandler interface, translating
 * Telegram-specific update events into generic InboundMessage objects that
 * the ChannelGateway can process.
 */

import type { InboundAttachment, TelegramGatewayHandler, TelegramReply } from "./channels/telegram.js";
import type { InboundGroup, TelegramGroupEvent } from "./telegram-groups.js";
import { ChannelGateway } from "./channel-gateway.js";

export class TelegramGatewayAdapter implements TelegramGatewayHandler {
  constructor(private gateway: ChannelGateway) {}

  async handleInboundMessage(
    senderId: string,
    chatId: string,
    text: string,
    senderName?: string,
    messageId?: string,
    attachments?: InboundAttachment[],
    group?: InboundGroup,
  ): Promise<TelegramReply | undefined> {
    return this.gateway.handleMessageReply({
      channel: "telegram",
      externalId: senderId,
      chatId,
      displayName: senderName,
      text,
      messageId,
      attachments,
      group,
    });
  }

  async handleMenuCallback(action: string, value: string, chatId: string, senderId: string, senderName?: string, group?: InboundGroup): Promise<string | undefined> {
    return this.gateway.handleMenuCallback(action, value, { channel: "telegram", externalId: senderId, chatId, displayName: senderName, group });
  }

  async handleApprovalCallback(
    action: string,
    requestId: string,
    chatId: string,
    senderId: string,
    senderName?: string,
    opts?: { trusted?: boolean; group?: InboundGroup },
  ): Promise<string | undefined> {
    const peerId = `telegram:${senderId}`;
    const resolvedBy = senderName ? `${senderName} (${peerId})` : peerId;
    return this.gateway.handleApprovalCallback(action, requestId, chatId, resolvedBy, {
      peerId,
      trusted: opts?.trusted,
      pendingKey: opts?.group ? `${chatId}:${senderId}` : chatId,
    });
  }

  async handleGroupEvent(event: TelegramGroupEvent): Promise<string | undefined> {
    if (event.kind === "joined") return this.gateway.handleGroupJoined("telegram", event.chatId, event.title, event.senderId);
    await this.gateway.handleGroupMigrated("telegram", event.chatId, event.fromChatId, event.title);
    return undefined;
  }
}
