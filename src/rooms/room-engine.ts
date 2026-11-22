/**
 * The room engine: group chats of people and agents on the web.
 *
 * A message comes into a room (from a person, or an agent's reply). Who answers it:
 *   1. the agents it mentions (@name);
 *   2. in "intent" rooms, the others the classifier (TypeSafe Jev) judges it is for, above the
 *      threshold; one person alone with one agent: that agent, no classification. A "mentions"
 *      room answers mentions (and replies to an agent's message) only, even with one agent;
 *   3. a person's message nobody picked up: the agent most likely to be meant (a group chat on
 *      the web should not leave the person unanswered).
 * The chosen agents answer all at once (replyOrder "parallel", default) or one after the other,
 * most likely first ("sequential": each reads what the previous ones said).
 *
 * Agents talking to each other (agentToAgent): an agent's reply is a message of the room like
 * any other, so it can set off other agents. Brakes: at most maxAgentHops rounds after a
 * person's message, a higher threshold between agents, an agent never answers itself, and a
 * new message from a person stops the chain that was running, except the answers of agents that
 * person's earlier message mentioned: a mention is always answered (a quick follow-up never
 * swallows it).
 */

import { nanoid } from "nanoid";
import type { Room, RoomMessage, RoomSettings, RoomStore } from "@polpo-ai/core";
import type { SessionStore } from "../core/session-store.js";
import type { ChannelChatRunner } from "../notifications/channel-gateway.js";
import type { GroupIntentArbiter, IntentCandidate } from "../notifications/group-intent.js";
import { ROOM_TURN_LINES, roomTurnText } from "./transcript.js";

/** The orchestrator as a member of a room. */
export const POLPO = "polpo";

export const ROOM_DEFAULTS: Required<RoomSettings> = {
  replyMode: "intent",
  intentThreshold: 0.7,
  replyOrder: "parallel",
  agentToAgent: true,
  maxAgentHops: 3,
  goal: "",
  owner: "",
};

/** Mentions that call every agent of the group. */
const EVERYONE = ["everyone", "all", "tutti"];

/** Between agents the classifier must be surer than for a person. */
const AGENT_TO_AGENT_MARGIN = 0.15;
/** Agent turns one person's message can set off, whatever the hops. */
const MAX_TURNS_PER_MESSAGE = 8;
const MAX_REPLY_CHARS = 8_000;

export interface AgentProfile {
  /** Agent name, or POLPO. */
  id: string;
  name: string;
  role: string;
  responsibilities: string[];
}

export type RoomEvent =
  | { type: "room:message"; roomId: string; message: RoomMessage }
  | { type: "room:typing"; roomId: string; agent: string; name: string; typing: boolean };

export interface RoomEngineOptions {
  rooms: RoomStore;
  sessions: SessionStore;
  /** Runs one agent turn (the orchestrator when `agent` is omitted). */
  runner: () => ChannelChatRunner | undefined;
  /** Who an agent is, for its messages and the classifier. */
  profile: (agent: string) => Promise<AgentProfile>;
  intent?: GroupIntentArbiter;
  emit: (event: RoomEvent) => void;
  log?: (level: "info" | "warn", message: string) => void;
}

/** One person's message and everything it sets off: shared by the agent rounds that follow. */
interface Chain {
  generation: number;
  turns: number;
  /** Agents that already answered in this chain: they come back only when mentioned. */
  spoke: Set<string>;
}

const settingsOf = (room: Room): Required<RoomSettings> => ({ ...ROOM_DEFAULTS, ...room.settings });

/** The agents a message mentions: @name, @display name, case-insensitive. */
export function mentionedAgents(text: string, profiles: AgentProfile[]): string[] {
  const lower = text.toLowerCase();
  const whole = (n: string) => {
    const at = `@${n}`;
    const i = lower.indexOf(at);
    return i >= 0 && !/[\p{L}\p{N}_-]/u.test(lower.charAt(i + at.length));
  };
  // @everyone: the whole group (sparingly, as in Grok Bot's group chats)
  if (EVERYONE.some(whole) && !profiles.some((p) => EVERYONE.includes(p.id.toLowerCase()))) return profiles.map((p) => p.id);
  return profiles
    .filter((p) => [p.id, p.name].some((n) => {
      const at = `@${n.toLowerCase()}`;
      const i = lower.indexOf(at);
      // a whole mention: "@growth," yes, "@growthbot" no
      return i >= 0 && !/[\p{L}\p{N}_-]/u.test(lower.charAt(i + at.length));
    }))
    .map((p) => p.id);
}

export class RoomEngine {
  /** Bumped by every person's message: chains of an older generation stop. */
  private generations = new Map<string, number>();
  /** Per room, the agents answering now: their name and how many of their turns run (one agent may have several queued). */
  private typing = new Map<string, Map<string, { name: string; turns: number }>>();
  /** Dispatches still running (a person's message and what it set off). */
  private running = new Set<Promise<void>>();

  constructor(private opts: RoomEngineOptions) {}

  /** The agents typing in a room right now. */
  typingIn(roomId: string): Array<{ agent: string; name: string }> {
    return [...(this.typing.get(roomId) ?? new Map<string, { name: string; turns: number }>()).entries()].map(([agent, t]) => ({ agent, name: t.name }));
  }

  /**
   * A person writes in a room: the message is stored and announced, then the agents answer in
   * the background (their replies come as room:message events).
   */
  async post(roomId: string, person: { id: string; name: string }, text: string, options: { replyToId?: string } = {}): Promise<RoomMessage> {
    const room = await this.opts.rooms.getRoom(roomId);
    if (!room) throw new Error(`Room not found: ${roomId}`);
    const profiles = await this.profiles(room);
    // replying to an agent's message calls that agent in, as a mention would
    const replied = options.replyToId
      ? (await this.opts.rooms.getRecentMessages(roomId, 200)).find((m) => m.id === options.replyToId)
      : undefined;
    const repliedAgent = replied?.authorKind === "agent" && profiles.some((p) => p.id === replied.authorId) ? replied.authorId : undefined;
    const addressedTo = [...new Set([...mentionedAgents(text, profiles), ...(repliedAgent ? [repliedAgent] : [])])];
    const message = await this.opts.rooms.addMessage(roomId, {
      authorKind: "person", authorId: person.id, authorName: person.name, text,
      ...(addressedTo.length ? { addressedTo } : {}),
      ...(replied ? { replyToId: replied.id } : {}),
    });
    this.opts.emit({ type: "room:message", roomId, message });
    const generation = (this.generations.get(roomId) ?? 0) + 1;
    this.generations.set(roomId, generation);
    const run = this.dispatch(room, message, 0, { generation, turns: 0, spoke: new Set() }).catch((err) =>
      this.opts.log?.("warn", `[rooms] ${roomId}: ${err instanceof Error ? err.message : String(err)}`));
    this.running.add(run);
    void run.finally(() => this.running.delete(run));
    return message;
  }

  /** Resolves when every answer under way has been given (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  private async profiles(room: Room): Promise<AgentProfile[]> {
    return Promise.all(room.agents.map((a) => this.opts.profile(a)));
  }

  private stale(room: Room, chain: Chain): boolean {
    return this.generations.get(room.id) !== chain.generation;
  }

  /** Who answers `message`, then their turns; their replies may set off the next round. */
  async dispatch(room: Room, message: RoomMessage, hop: number, chain: Chain): Promise<void> {
    const settings = settingsOf(room);
    if (hop > 0 && (!settings.agentToAgent || hop > settings.maxAgentHops)) return;
    // agents' rounds stop when a person wrote again; a person's own message still gets the agents it mentions
    if (hop > 0 && this.stale(room, chain)) return;

    const profiles = (await this.profiles(room)).filter((p) => !(message.authorKind === "agent" && p.id === message.authorId));
    if (profiles.length === 0) return;
    const mentioned = [...new Set([...mentionedAgents(message.text, profiles),
      ...(message.authorKind === "person" ? (message.addressedTo ?? []).filter((id) => profiles.some((p) => p.id === id)) : [])])];
    const chosen = new Map<string, number>(mentioned.map((id) => [id, 1]));
    // a person's mention is always answered, even after a newer message (never swallowed by a follow-up)
    const owed = new Set(hop === 0 && message.authorKind === "person" ? mentioned : []);
    if (hop === 0 && this.stale(room, chain)) {
      for (const id of chosen.keys()) if (!owed.has(id)) chosen.delete(id);
      if (chosen.size === 0) return;
    }

    // between agents, by intent, only those who have not spoken in this chain yet
    const others = this.stale(room, chain) ? [] : profiles.filter((p) => !chosen.has(p.id) && (hop === 0 || !chain.spoke.has(p.id)));
    if (others.length > 0 && settings.replyMode === "intent" && (hop === 0 || mentioned.length === 0)) {
      const probabilities = await this.classify(room, message, others);
      const threshold = hop === 0 ? settings.intentThreshold : Math.min(0.95, settings.intentThreshold + AGENT_TO_AGENT_MARGIN);
      for (const p of others) if ((probabilities[p.id] ?? 0) >= threshold) chosen.set(p.id, probabilities[p.id]!);
      // a person's message nobody picked up: the owner of the next step answers, else the agent most likely meant
      const owner = settings.owner && others.find((p) => p.id === settings.owner);
      if (chosen.size === 0 && hop === 0 && message.authorKind === "person" && owner) chosen.set(owner.id, probabilities[owner.id] ?? 0);
      if (chosen.size === 0 && hop === 0 && message.authorKind === "person") {
        const best = others.map((p) => [p.id, probabilities[p.id] ?? 0] as const).sort((a, b) => b[1] - a[1])[0];
        if (best && (best[1] > 0 || others.length === 1)) chosen.set(best[0], best[1]);
      }
    }
    // a "mentions" room answers mentions only, whatever the number of agents (one agent included:
    // the setting is what the person chose; an "intent" room with one agent answers everything)
    if (chosen.size === 0) return;

    const order = [...chosen.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => profiles.find((p) => p.id === id)!);
    const room2 = await this.opts.rooms.getRoom(room.id) ?? room;
    const run = async (agent: AgentProfile) => {
      if ((this.stale(room, chain) && !owed.has(agent.id)) || chain.turns >= MAX_TURNS_PER_MESSAGE) return;
      chain.turns += 1;
      const reply = await this.turn(room2, agent, message);
      if (reply) chain.spoke.add(agent.id);
      if (reply) await this.dispatch(room2, reply, hop + 1, chain);
    };
    if (settings.replyOrder === "sequential") {
      for (const agent of order) await run(agent);
    } else {
      await Promise.all(order.map(run));
    }
  }

  private async classify(room: Room, message: RoomMessage, candidates: AgentProfile[]): Promise<Record<string, number>> {
    const intent = this.opts.intent;
    if (!intent?.available) return {};
    const toCandidate = (p: AgentProfile): IntentCandidate => ({ key: p.id, name: p.name, role: p.role, responsibilities: p.responsibilities });
    return intent.evaluate({
      conversation: room.id,
      messageId: message.id,
      title: room.title,
      speaker: message.authorKind === "agent" ? `${message.authorName} (agent)` : message.authorName,
      text: message.text,
      // a web room: one person and its agents
      members: 1 + room.agents.length,
    }, candidates.map(toCandidate));
  }

  /** One agent's turn: it reads the room, answers, and its reply goes into the room. */
  private async turn(room: Room, agent: AgentProfile, message: RoomMessage): Promise<RoomMessage | undefined> {
    const runner = this.opts.runner();
    if (!runner) {
      this.opts.log?.("warn", `[rooms] ${room.id}: agent chat is not available on this instance`);
      return undefined;
    }
    const typing = this.typing.get(room.id) ?? new Map<string, { name: string; turns: number }>();
    this.typing.set(room.id, typing);
    // counted: a second turn of the same agent (queued behind its first) keeps it typing until both are done
    const t = typing.get(agent.id) ?? { name: agent.name, turns: 0 };
    t.turns += 1;
    typing.set(agent.id, t);
    if (t.turns === 1) this.opts.emit({ type: "room:typing", roomId: room.id, agent: agent.id, name: agent.name, typing: true });
    try {
      const sessionId = await this.sessionOf(room, agent.id);
      const recent = await this.opts.rooms.getRecentMessages(room.id, ROOM_TURN_LINES + 20);
      const speaker = message.authorKind === "agent" ? `${message.authorName} (agent)` : message.authorName;
      const text = roomTurnText(recent, agent.id, { id: message.id, speaker, text: message.text });
      // the agent's whole session in this group: compaction keeps it within the window
      const history = typeof this.opts.sessions.getMessages === "function"
        ? await this.opts.sessions.getMessages(sessionId)
        : await this.opts.sessions.getRecentMessages(sessionId, 20);
      const members = await this.profiles(room);
      const messages = [
        ...history.filter((m) => m.content).map((m) => ({ role: m.role, content: m.content })),
        { role: "user" as const, content: `${roomPreamble(room, agent, members)}\n\n${text}` },
      ];
      const { text: out } = await runner({ ...(agent.id === POLPO ? {} : { agent: agent.id }), sessionId, messages });
      const body = out.trim().slice(0, MAX_REPLY_CHARS);
      if (!body) return undefined;
      const addressedTo = mentionedAgents(body, members.filter((p) => p.id !== agent.id));
      const reply = await this.opts.rooms.addMessage(room.id, {
        authorKind: "agent", authorId: agent.id, authorName: agent.name, text: body, replyToId: message.id,
        ...(addressedTo.length ? { addressedTo } : {}),
      });
      this.opts.emit({ type: "room:message", roomId: room.id, message: reply });
      return reply;
    } catch (err) {
      this.opts.log?.("warn", `[rooms] ${room.id}: ${agent.name} could not answer: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    } finally {
      t.turns -= 1;
      if (t.turns <= 0) {
        typing.delete(agent.id);
        this.opts.emit({ type: "room:typing", roomId: room.id, agent: agent.id, name: agent.name, typing: false });
      }
    }
  }

  /** The agent's own (hidden) session for this room: its turns, tool calls and replies. */
  private async sessionOf(room: Room, agent: string): Promise<string> {
    const name = agent === POLPO ? undefined : agent;
    const existing = (await this.opts.sessions.listSessions())
      .filter((s) => s.scope === room.id && (s.agent ?? undefined) === name)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (existing) return existing.id;
    return this.opts.sessions.create(`${room.title} (group)`, name, { scope: room.id });
  }
}

/** What the agent is told about the room it speaks in, on each turn. */
function roomPreamble(room: Room, me: AgentProfile, members: AgentProfile[]): string {
  const others = members.filter((p) => p.id !== me.id).map((p) => `${p.name} (@${p.id}: ${p.role})`);
  const { goal, owner } = settingsOf(room);
  const ownerName = owner ? (members.find((p) => p.id === owner)?.name ?? owner) : "";
  const purpose = [
    goal ? `The group's goal: ${goal}.` : "",
    ownerName ? (owner === me.id ? "You own the next step: move the work forward and say who does what." : `${ownerName} owns the next step.`) : "",
  ].filter(Boolean).join(" ");
  return `[Group chat "${room.title}": one person and the agents${others.length ? ` ${others.join(", ")} and you` : ""}. ` +
    `You are ${me.name}. Lines marked "(agent)" are the other agents. ${purpose ? `${purpose} ` : ""}Answer the last message as ${me.name}; ` +
    `to ask another agent, write @its-id (@everyone for all, sparingly). Keep it short and do not repeat what another agent already said.]`;
}

/** A new web room's id. */
export const newRoomId = () => `web:${nanoid(10)}`;
