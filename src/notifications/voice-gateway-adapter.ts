/**
 * Voice Gateway Adapter — a smart speaker talks to an agent through the same ChannelGateway
 * as Telegram: one peer per device ("voice:<device>"), allowlist/pairing, per-device sessions,
 * the channel's dedicated agent. The reply is streamed back so the speaker starts talking
 * while the agent is still writing.
 */

import type { ChannelGateway } from "./channel-gateway.js";

export interface VoiceTurnRequest {
  /** Device id (e.g. the speaker's MAC), already normalized. */
  device: string;
  /** What the person said (the voice provider's transcript). */
  text: string;
  /** Optional display name of the person or device. */
  name?: string;
  /** Optional id for idempotent retries. */
  messageId?: string;
}

export type VoiceTurnResult =
  | { kind: "stream"; body: ReadableStream<Uint8Array>; turnId?: string }
  | { kind: "text"; text: string };

const DEVICE = /^[A-Za-z0-9:_.-]{1,64}$/;

/** Device ids become peer ids ("voice:<device>"): short, safe, case-insensitive (MAC addresses). */
export function normalizeVoiceDevice(raw: string | undefined): string | undefined {
  const value = (raw ?? "").trim();
  return DEVICE.test(value) ? value.toLowerCase() : undefined;
}

export class VoiceGatewayAdapter {
  constructor(private gateway: ChannelGateway) {}

  async turn(request: VoiceTurnRequest): Promise<VoiceTurnResult> {
    const reply = await this.gateway.handleMessageReply({
      channel: "voice",
      externalId: request.device,
      chatId: request.device,
      displayName: request.name,
      text: request.text,
      messageId: request.messageId,
      streamReply: true,
    });
    if (reply?.stream) return { kind: "stream", body: reply.stream.body, turnId: reply.stream.turnId };
    return { kind: "text", text: reply?.text ?? "" };
  }
}
