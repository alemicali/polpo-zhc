/**
 * Telegram groups: which messages are meant for the bot, and what the gateway needs to know
 * about the group. Pure helpers, shared by the poller and its tests.
 *
 * A message in a group is addressed to the bot when it mentions it (@username or a text
 * mention), replies to one of its messages, or is a command for it (/cmd@username, or /cmd
 * without a target, which Telegram sends to every bot of the group). Everything else is
 * conversation between people: the gateway keeps it as context and does not answer.
 */

import type { TelegramMessage } from "./channels/telegram.js";

/** The bot itself, from getMe. */
export interface TelegramIdentity {
  id: number;
  username?: string;
  /** False while privacy mode is on: in groups the bot only gets commands and replies to it. */
  canReadAllGroupMessages?: boolean;
}

/** What the gateway knows about a group message. */
export interface InboundGroup {
  /** Chat title, for session names and the conversation header. */
  title?: string;
  /** Forum topic: each topic is a conversation of its own. */
  threadId?: number;
  /** Meant for the bot (mention, reply, command); otherwise kept as context only. */
  addressed: boolean;
}

export type TelegramChatType = "private" | "group" | "supergroup" | "channel";

/** Group lifecycle events the gateway reacts to. */
export type TelegramGroupEvent =
  /** The bot was added: by an authorized person, the group is enabled right away. */
  | { kind: "joined"; chatId: string; title?: string; senderId: string; senderName?: string }
  /** The group became a supergroup and got a new id. */
  | { kind: "migrated"; chatId: string; fromChatId: string; title?: string };

export function isGroupChat(chat: { id: number; type?: TelegramChatType }): boolean {
  return chat.type ? chat.type === "group" || chat.type === "supergroup" : chat.id < 0;
}

/** The forum topic of a message, only when it really is in a topic (not a plain reply thread). */
export function topicOf(message: Pick<TelegramMessage, "is_topic_message" | "message_thread_id">): number | undefined {
  return message.is_topic_message ? message.message_thread_id : undefined;
}

export interface Addressing {
  /** The message is for this bot. */
  addressed: boolean;
  /** A command for another bot of the group: ignored entirely. */
  forOtherBot: boolean;
  /** Text without the bot's mention and with /cmd@bot reduced to /cmd. */
  text: string;
}

const COMMAND_TARGET = /^(\/[A-Za-z0-9_]+)@([A-Za-z0-9_]+)(?=\s|$)/;

/** Is this group message for the bot, and its text as the bot should read it. */
export function groupAddressing(message: TelegramMessage, me: TelegramIdentity | undefined): Addressing {
  const raw = message.text ?? message.caption ?? "";
  const username = me?.username?.toLowerCase();

  const command = COMMAND_TARGET.exec(raw);
  if (command) {
    const forMe = !!username && command[2].toLowerCase() === username;
    return forMe
      ? { addressed: true, forOtherBot: false, text: command[1] + raw.slice(command[0].length) }
      : { addressed: false, forOtherBot: true, text: raw };
  }
  if (raw.startsWith("/")) return { addressed: true, forOtherBot: false, text: raw };

  let text = raw;
  let mentioned = false;
  const entities = (message.text !== undefined ? message.entities : message.caption_entities) ?? [];
  // Right to left, so earlier offsets stay valid while cutting.
  for (const e of [...entities].sort((a, b) => b.offset - a.offset)) {
    const span = raw.slice(e.offset, e.offset + e.length);
    const isMe = (e.type === "mention" && !!username && span.toLowerCase() === `@${username}`)
      || (e.type === "text_mention" && !!me && e.user?.id === me.id);
    if (!isMe) continue;
    mentioned = true;
    text = text.slice(0, e.offset) + text.slice(e.offset + e.length);
  }
  text = text.replace(/[ \t]{2,}/g, " ").replace(/ +([,.;:!?])/g, "$1").replace(/^[\s,:]+/, "").trim();

  const reply = message.reply_to_message;
  // In forums every message "replies" to the topic's opening message: that is not a reply to the bot.
  const repliedToMe = !!me && !!reply && !reply.forum_topic_created && reply.from?.id === me.id;
  return { addressed: mentioned || repliedToMe, forOtherBot: false, text: mentioned ? text : raw };
}

/** The bot was just added to this group (or created it with others). */
export function botJoined(message: TelegramMessage, me: TelegramIdentity | undefined): boolean {
  if (message.group_chat_created || message.supergroup_chat_created) return true;
  return !!me && (message.new_chat_members ?? []).some((u) => u.id === me.id);
}

/** Short stand-in for media in the group context ("[photo]"), since context files are not downloaded. */
export function mediaLabel(message: TelegramMessage): string | undefined {
  if (message.photo) return "[photo]";
  if (message.voice) return "[voice message]";
  if (message.video || message.video_note) return "[video]";
  if (message.audio) return "[audio]";
  if (message.document) return `[file: ${message.document.file_name ?? "file"}]`;
  if (message.sticker) return `[sticker${message.sticker.emoji ? ` ${message.sticker.emoji}` : ""}]`;
  return undefined;
}
