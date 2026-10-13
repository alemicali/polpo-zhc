/**
 * The chats an instance can write to: every Telegram group, topic and person its bots have met
 * (peers and group rooms). Agents and Polpo send to any of them (send_message, schedule_check `to`),
 * wherever they were asked from.
 */
import type { ConversationCheckTarget } from "@polpo-ai/core";
import type { PeerIdentity } from "@polpo-ai/core";
import type { Room } from "@polpo-ai/core/room-store";

export interface ReachableChat {
  /** Address to use in `to`: "telegram:group:<chat>[:topic:<n>]" or "telegram:<user>". */
  id: string;
  kind: "group" | "topic" | "person";
  chatId: string;
  threadId?: number;
  name: string;
  lastSeenAt?: string;
}

/** A Telegram bot of the instance: its channel key and the agent it speaks as (none = Polpo). */
export interface ChatBot {
  key: string;
  agent?: string;
  /** The bot has seen this group conversation (it is a member). */
  isIn?: (conversation: string) => boolean;
}

const GROUP_ID = /^telegram:group:(-?\d+)(?::topic:(\d+))?$/;

/** The chats known from Telegram peers (people, groups) and group rooms (groups, topics), newest first. */
export function buildChatDirectory(peers: readonly PeerIdentity[], rooms: readonly Room[]): ReachableChat[] {
  const chats = new Map<string, ReachableChat>();
  for (const room of rooms) {
    const m = GROUP_ID.exec(room.id);
    if (!m) continue;
    chats.set(room.id, {
      id: room.id,
      kind: m[2] ? "topic" : "group",
      chatId: m[1]!,
      ...(m[2] ? { threadId: Number(m[2]) } : {}),
      name: room.title || room.id,
      lastSeenAt: room.updatedAt,
    });
  }
  for (const peer of peers) {
    if (peer.channel !== "telegram") continue;
    if (peer.externalId.startsWith("group:")) {
      const id = `telegram:${peer.externalId}`;
      const known = chats.get(id);
      chats.set(id, {
        id,
        kind: "group",
        chatId: peer.externalId.slice("group:".length),
        name: peer.displayName || known?.name || id,
        lastSeenAt: [peer.lastSeenAt, known?.lastSeenAt].filter(Boolean).sort().pop(),
      });
    } else if (/^\d+$/.test(peer.externalId)) {
      // a person: their private chat has their user id
      const id = `telegram:${peer.externalId}`;
      chats.set(id, { id, kind: "person", chatId: peer.externalId, name: peer.displayName || peer.externalId, lastSeenAt: peer.lastSeenAt });
    }
  }
  // a topic is named after its group too ("Team › Releases")
  for (const chat of chats.values()) {
    if (chat.kind !== "topic") continue;
    const group = chats.get(`telegram:group:${chat.chatId}`);
    if (group && !chat.name.includes(group.name)) chat.name = `${group.name} › ${chat.name}`;
  }
  return [...chats.values()].sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""));
}

const norm = (s: string) => s.toLowerCase().replace(/^@/, "").replace(/\s+/g, " ").trim();

/**
 * The chat `to` names: an address from list_chats, a Telegram chat id, or a name (exact, then
 * partial; groups before topics and people). `topic` picks a forum topic of a group. Throws with the
 * candidates when it is unknown or ambiguous.
 */
export function resolveChat(chats: readonly ReachableChat[], to: string, topic?: number): ReachableChat {
  const wanted = to.trim();
  if (!wanted) throw new Error("Say which chat (to): a name or an id from list_chats");
  const withTopic = (chat: ReachableChat): ReachableChat => {
    if (topic === undefined || chat.kind === "person") return chat;
    const id = `telegram:group:${chat.chatId}:topic:${topic}`;
    return chats.find(c => c.id === id) ?? { id, kind: "topic", chatId: chat.chatId, threadId: topic, name: `${chat.name} › topic ${topic}` };
  };
  const byId = chats.find(c => c.id === wanted || c.id === `telegram:${wanted}`);
  if (byId) return withTopic(byId);
  const group = GROUP_ID.exec(wanted);
  if (group) return withTopic({ id: wanted, kind: group[2] ? "topic" : "group", chatId: group[1]!, ...(group[2] ? { threadId: Number(group[2]) } : {}), name: wanted });
  // a raw Telegram chat id: groups are negative, people positive
  if (/^-?\d+$/.test(wanted)) {
    const known = chats.find(c => c.chatId === wanted && c.kind !== "topic");
    if (known) return withTopic(known);
    return withTopic(wanted.startsWith("-")
      ? { id: `telegram:group:${wanted}`, kind: "group", chatId: wanted, name: wanted }
      : { id: `telegram:${wanted}`, kind: "person", chatId: wanted, name: wanted });
  }
  const name = norm(wanted);
  const rank = (c: ReachableChat) => (c.kind === "group" ? 0 : c.kind === "topic" ? 1 : 2);
  const exact = chats.filter(c => norm(c.name) === name || norm(c.name.split(" › ").pop() ?? "") === name).sort((a, b) => rank(a) - rank(b));
  const partial = exact.length ? exact : chats.filter(c => norm(c.name).includes(name)).sort((a, b) => rank(a) - rank(b));
  if (partial.length === 0) {
    throw new Error(`No chat called "${wanted}". Known chats: ${describeCandidates(chats)}`);
  }
  const best = partial.filter(c => rank(c) === rank(partial[0]!));
  if (best.length > 1 && !best.every(c => c.id === best[0]!.id)) {
    throw new Error(`"${wanted}" matches several chats: ${describeCandidates(best)}. Use the id.`);
  }
  return withTopic(partial[0]!);
}

function describeCandidates(chats: readonly ReachableChat[]): string {
  if (chats.length === 0) return "none yet (a bot must be added to the group, or the person must write to a bot first)";
  const shown = chats.slice(0, 15).map(c => `${c.name} (${c.kind}, ${c.id})`).join("; ");
  return chats.length > 15 ? `${shown}; … ${chats.length - 15} more (list_chats)` : shown;
}

/** The delivery target of a chat for a bot (channel key). */
export function chatTarget(chat: ReachableChat, channel: string): ConversationCheckTarget {
  return {
    channel,
    chatId: chat.chatId,
    ...(chat.threadId !== undefined ? { threadId: chat.threadId } : {}),
    ...(chat.kind !== "person" ? { conversation: chat.id } : {}),
    name: chat.name,
  };
}

/**
 * The bots to try for a message to `target`, best first: the one already chosen, the agent's own
 * bots (Polpo's for Polpo), those that have seen the group, then any other.
 */
export function botOrder(bots: readonly ChatBot[], target: Pick<ConversationCheckTarget, "channel" | "conversation">, agent?: string): string[] {
  const own = bots.filter(b => (agent ? b.agent === agent : !b.agent)).map(b => b.key);
  const present = target.conversation ? bots.filter(b => b.isIn?.(target.conversation!)).map(b => b.key) : [];
  return [...new Set([target.channel, ...own, ...present, ...bots.map(b => b.key)].filter(k => bots.some(b => b.key === k)))];
}

/** One line per chat, for list_chats. */
export function describeChats(chats: readonly ReachableChat[], bots: readonly ChatBot[], now = new Date()): string {
  const header = `Now: ${now.toISOString()}. Telegram bots: ${bots.length ? bots.map(b => `${b.key} (${b.agent ?? "Polpo"})`).join(", ") : "none running"}.`;
  if (chats.length === 0) return `${header}\nNo chats yet: add a bot to a group, or have the person write to a bot first.`;
  return [header, ...chats.slice(0, 100).map(c => `- ${c.name} [${c.kind}] to: ${c.id}${c.lastSeenAt ? `, last active ${c.lastSeenAt.slice(0, 16)}` : ""}`)].join("\n");
}
