/**
 * What a messaging channel can do, told to the agent for turns that come from one
 * (internal x-polpo-chat-origin). Keyed by the type of the origin channel.
 */

const VOICE_TURN_PROMPT = [
  "## Channel",
  "This turn comes from a voice speaker: the person spoke to you (the text is a speech transcript and may contain",
  "recognition errors) and will hear your answer spoken aloud.",
  "Answer in one to three short spoken sentences, in the person's language. No markdown, lists, tables, emoji, links",
  "or code: write numbers, symbols and abbreviations the way they are said. If you did not understand, ask briefly.",
  "Before a tool that takes a while, say in a few words what you are doing.",
].join(" ").replace("## Channel ", "## Channel\n");

/** Guidance for a channel turn, or undefined when there is none. */
export function channelTurnPrompt(type: string | undefined, telegramReactionHint: string): string | undefined {
  if (type === "voice") return VOICE_TURN_PROMPT;
  // Telegram, and any other origin (only Telegram turns carried an origin before voice channels).
  return `## Channel\nThis turn comes from Telegram: your answer is sent as a Telegram message. ${telegramReactionHint}`;
}
