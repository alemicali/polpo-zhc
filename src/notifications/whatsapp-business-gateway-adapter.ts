/**
 * WhatsApp Business gateway adapter: hands an inbound message (already verified, stored and
 * de-duplicated by the service) to the channel's ChannelGateway as `whatsapp-business:<wa_id>`,
 * and gives the reply back to the service, which sends it. Partial responses (long agent turns)
 * go out as they come, through the same service.
 */
import type { ChannelGateway } from "./channel-gateway.js";
import type { WaBizGatewayHandle } from "./whatsapp-business-service.js";

export class WaBusinessGatewayAdapter implements WaBizGatewayHandle {
  constructor(private readonly gateway: ChannelGateway) {}

  async handle(input: { waId: string; chatId: string; name?: string; text: string; messageId: string }): Promise<{ text: string } | undefined> {
    const reply = await this.gateway.handleMessageReply({
      channel: "whatsapp-business",
      externalId: input.waId,
      chatId: input.chatId,
      ...(input.name ? { displayName: input.name } : {}),
      text: input.text,
      messageId: input.messageId,
    });
    // buttons, files and voice are not sent in this version: the text is
    if (!reply || reply.deliveredTo) return undefined;
    return { text: reply.text };
  }
}
