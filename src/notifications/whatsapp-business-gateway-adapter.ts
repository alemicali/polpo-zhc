/**
 * WhatsApp Business gateway adapter: hands an inbound message (already verified, stored and
 * de-duplicated by the service) to the channel's ChannelGateway as `whatsapp-business:<wa_id>`,
 * with its media as attachments (voice notes are transcribed by the gateway), and gives the reply
 * back to the service, which sends it: text, reply buttons (WhatsApp interactive buttons or a
 * list), files (media) and a voice reply (audio). Partial responses (long agent turns) go out as
 * they come, through the same service.
 */
import type { ChannelGateway } from "./channel-gateway.js";
import type { WaBizGatewayHandle, WaBizGatewayReply } from "./whatsapp-business-service.js";

export class WaBusinessGatewayAdapter implements WaBizGatewayHandle {
  constructor(private readonly gateway: ChannelGateway) {}

  async handle(input: Parameters<WaBizGatewayHandle["handle"]>[0]): Promise<WaBizGatewayReply | undefined> {
    const reply = await this.gateway.handleMessageReply({
      channel: "whatsapp-business",
      externalId: input.waId,
      chatId: input.chatId,
      ...(input.name ? { displayName: input.name } : {}),
      text: input.text,
      messageId: input.messageId,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.voice ? { voice: true } : {}),
    });
    if (!reply || reply.deliveredTo) return undefined;
    return {
      text: reply.text,
      ...(reply.buttons?.length ? { buttons: reply.buttons } : {}),
      ...(reply.files?.length ? { files: reply.files } : {}),
      ...(reply.voice ? { voice: reply.voice } : {}),
    };
  }
}
