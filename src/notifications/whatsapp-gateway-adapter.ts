/**
 * WhatsApp Gateway Adapter — bridges WhatsAppBridge to ChannelGateway.
 *
 * Follows the same pattern as TelegramGatewayAdapter: translates WhatsApp-specific
 * message fields (JID-based sender/chat IDs) into the generic InboundMessage format
 * that ChannelGateway can process.
 */

import type { WhatsAppGatewayHandler } from "./channels/whatsapp.js";
import { ChannelGateway } from "./channel-gateway.js";

export class WhatsAppGatewayAdapter implements WhatsAppGatewayHandler {
  constructor(private gateway: ChannelGateway) {}

  async handleInboundMessage(
    senderId: string,
    chatId: string,
    text: string,
    senderName?: string,
    messageId?: string,
  ): Promise<string | undefined> {
    // WhatsApp JIDs look like "393331234567@s.whatsapp.net"
    // Extract just the phone number as the externalId
    const externalId = senderId.replace(/@.*$/, "");

    return this.gateway.handleMessage({
      channel: "whatsapp",
      externalId,
      chatId,
      displayName: senderName,
      text,
      messageId,
    });
  }
}
