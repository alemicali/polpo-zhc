/**
 * Emoji reactions: an agent that answers with a single emoji Telegram accepts as a reaction puts it on
 * the message it answers instead of sending a message ("👍" to "ok thanks", "🎉" to good news).
 */

/** The emoji a bot can react with (Telegram Bot API, ReactionTypeEmoji), without variation selectors. */
export const TELEGRAM_REACTIONS: readonly string[] = [
  "👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌",
  "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓",
  "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍", "🤗", "🫡",
  "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡",
];
const REACTIONS = new Set(TELEGRAM_REACTIONS);

/** The ones worth suggesting to a model (the rest are rarely the right answer). */
export const SUGGESTED_REACTIONS = ["👍", "❤", "🔥", "🎉", "👏", "👀", "🙏", "👌", "😁", "🤔", "💯", "🫡"];

/** The reaction a reply stands for: the reply is exactly one supported emoji (variation selectors ignored). */
export function reactionOf(reply: string): string | undefined {
  const emoji = reply.trim().replace(/️/g, "");
  return REACTIONS.has(emoji) ? emoji : undefined;
}

/** What the agent is told about reactions on Telegram. */
export function reactionHint(): string {
  return `To only acknowledge a message, answer with a single emoji (for example ${SUGGESTED_REACTIONS.join(" ")}): `
    + "it is added as a reaction to that message instead of sending a reply. Use it when a reaction says enough "
    + "(thanks, ok, good news); answer in words when there is something to say.";
}

/** How to send a file in a Telegram turn: agents otherwise believe they cannot attach anything. */
export function telegramFilesHint(): string {
  return "To send files (a document, an image, an audio, a PDF or a chart you made), call send_message with `files` "
    + "(paths in your workspace): without `to` they come to this chat as attachments, next to your answer. "
    + "You can send attachments here: never say you cannot.";
}
