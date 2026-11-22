/**
 * Voice replies: whether chat answers on Telegram are also sent as a voice message. Off by default;
 * an agent (or Polpo) changes its own preference when someone asks ("answer me with voice notes").
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { VoiceReplyMode } from "@polpo-ai/core";

export const VOICE_REPLY_MODES: readonly VoiceReplyMode[] = ["off", "voice", "always"];

const MODE_MEANING: Record<VoiceReplyMode, string> = {
  off: "text only",
  voice: "a voice message when the person wrote with a voice message, text otherwise",
  always: "every reply also as a voice message",
};

export function isVoiceReplyMode(value: unknown): value is VoiceReplyMode {
  return typeof value === "string" && (VOICE_REPLY_MODES as readonly string[]).includes(value);
}

/** One line for a prompt or a tool description: the current mode and how to change it. */
export function describeVoiceReplies(mode: VoiceReplyMode | undefined): string {
  const current = mode ?? "off";
  return `Voice replies on Telegram are "${current}" (${MODE_MEANING[current]}). `
    + `Modes: off, voice (${MODE_MEANING.voice}), always. The text stays as the caption. `
    + "Change it with set_voice_replies only when someone asks to hear (or stop hearing) your answers.";
}

export const SetVoiceRepliesSchema = Type.Object({
  mode: Type.Union(VOICE_REPLY_MODES.map((m) => Type.Literal(m)), { description: "off (text only), voice (answer voice messages with voice), always" }),
});

/** The agent-chat tool: changes this agent's own preference. */
export function createVoiceReplyTool(
  current: VoiceReplyMode | undefined,
  update: (mode: VoiceReplyMode) => Promise<void>,
): AgentTool<typeof SetVoiceRepliesSchema> {
  return {
    name: "set_voice_replies",
    label: "Set voice replies",
    description: `Change whether your chat replies on Telegram are also sent as voice messages. ${describeVoiceReplies(current)}`,
    parameters: SetVoiceRepliesSchema,
    async execute(_id, params) {
      if (!isVoiceReplyMode(params.mode)) {
        return { content: [{ type: "text", text: `Error: mode must be one of ${VOICE_REPLY_MODES.join(", ")}` }], details: {} };
      }
      await update(params.mode);
      return { content: [{ type: "text", text: `Voice replies set to "${params.mode}": ${MODE_MEANING[params.mode]}.` }], details: { mode: params.mode } };
    },
  };
}
