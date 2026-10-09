/**
 * Agents talking to each other in Telegram groups.
 *
 * A bot never receives another bot's messages from Telegram, so when an agent replies in a
 * group the other agents would not know. All the bots of the instance run here, though: when
 * one replies, the relay asks who among the other bots of that group should answer it (the
 * ones it mentions, by agent id, name or @username; then, for bots in intent mode, the ones the
 * classifier picks with a higher threshold than for people), runs their turns and has each
 * reply posted by its own bot. Their replies go round the same way.
 *
 * Brakes, as in web rooms: at most maxAgentHops rounds after a person's message, an agent never
 * answers itself nor comes back by intent in the same chain (only when mentioned), at most 8
 * agent turns per person's message, and a new message from a person stops the chain.
 */

import type { RoomMessage, RoomSettings, RoomStore } from "@polpo-ai/core";
import type { GroupIntentArbiter } from "../notifications/group-intent.js";
import { ROOM_DEFAULTS, mentionedAgents, type AgentProfile } from "./room-engine.js";

/** Between agents the classifier must be surer than for a person. */
const AGENT_TO_AGENT_MARGIN = 0.15;
const MAX_TURNS_PER_MESSAGE = 8;

/** A bot of the instance, as the relay sees it. */
export interface RelayBot {
  key: string;
  /** Has this bot seen the group conversation (it is a member)? */
  isIn(conversation: string): boolean;
  /** The group is enabled for it, and it answers by intent (vs mentions only). */
  mode(conversation: string): Promise<"intent" | "mentions" | undefined>;
  threshold(): number;
  /** Who the bot speaks as; `aliases` are other names it may be called by (@username). */
  profile(conversation: string): Promise<AgentProfile & { aliases: string[] }>;
  /** Run its turn on an agent's message; the reply is stored in the room and returned. */
  answer(conversation: string, message: RoomMessage): Promise<RoomMessage | undefined>;
  /** Post a text in the group, as this bot. */
  post(conversation: string, text: string): Promise<void>;
}

interface Chain {
  generation: number;
  turns: number;
  spoke: Set<string>;
}

export interface TelegramRelayOptions {
  bots: () => RelayBot[];
  rooms: RoomStore;
  intent?: GroupIntentArbiter;
  log?: (level: "info" | "warn", message: string) => void;
}

export class TelegramAgentRelay {
  private generations = new Map<string, number>();
  /** The last person's message seen per conversation: every bot gets its own copy of it. */
  private lastPerson = new Map<string, string>();
  private running = new Set<Promise<void>>();

  constructor(private opts: TelegramRelayOptions) {}

  /** A person wrote in the group: the chain under way stops (once per message, whichever bot got it). */
  personSpoke(conversation: string, messageId: string): void {
    if (this.lastPerson.get(conversation) === messageId) return;
    this.lastPerson.set(conversation, messageId);
    this.generations.set(conversation, (this.generations.get(conversation) ?? 0) + 1);
  }

  /** The other agents of a group, for an agent's turn ("who else is here"). */
  async peers(conversation: string, exceptKey: string): Promise<AgentProfile[]> {
    const others = this.opts.bots().filter((b) => b.key !== exceptKey && b.isIn(conversation));
    return Promise.all(others.map((b) => b.profile(conversation)));
  }

  /** An agent (bot `fromKey`) replied to a person in the group: the other agents may answer it. */
  agentReplied(conversation: string, reply: RoomMessage, fromKey: string): void {
    const chain: Chain = { generation: this.generations.get(conversation) ?? 0, turns: 0, spoke: new Set([reply.authorId]) };
    const run = this.relay(conversation, reply, fromKey, 1, chain).catch((err) =>
      this.opts.log?.("warn", `[group relay] ${conversation}: ${err instanceof Error ? err.message : String(err)}`));
    this.running.add(run);
    void run.finally(() => this.running.delete(run));
  }

  /** Resolves when the relays under way are done (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  private async settings(conversation: string): Promise<Required<RoomSettings>> {
    const room = await this.opts.rooms.getRoom(conversation);
    return { ...ROOM_DEFAULTS, ...room?.settings };
  }

  private async relay(conversation: string, message: RoomMessage, fromKey: string, hop: number, chain: Chain): Promise<void> {
    const settings = await this.settings(conversation);
    if (!settings.agentToAgent || hop > settings.maxAgentHops) return;
    if ((this.generations.get(conversation) ?? 0) !== chain.generation) return;

    const bots = this.opts.bots().filter((b) => b.key !== fromKey && b.isIn(conversation));
    const present: Array<{ bot: RelayBot; profile: AgentProfile & { aliases: string[] }; mode: "intent" | "mentions" }> = [];
    for (const bot of bots) {
      const mode = await bot.mode(conversation);
      if (!mode) continue;
      const profile = await bot.profile(conversation);
      if (profile.id === message.authorId) continue; // the same agent on another bot
      present.push({ bot, profile, mode });
    }
    if (present.length === 0) return;

    // mentions: agent id, display name or the bot's @username
    const chosen = new Map<string, number>();
    for (const p of present) {
      const names = [p.profile.id, p.profile.name, ...p.profile.aliases];
      if (mentionedAgents(message.text, names.map((n) => ({ ...p.profile, id: n, name: n }))).length) chosen.set(p.bot.key, 1);
    }
    // by intent, only bots in intent mode that have not spoken in this chain
    const byIntent = present.filter((p) => p.mode === "intent" && !chosen.has(p.bot.key) && !chain.spoke.has(p.profile.id));
    if (byIntent.length > 0 && chosen.size === 0 && this.opts.intent?.available) {
      const room = await this.opts.rooms.getRoom(conversation);
      const decision = await this.opts.intent.evaluate({
        conversation,
        messageId: message.id,
        title: room?.title,
        speaker: `${message.authorName} (agent)`,
        text: message.text,
      }, byIntent.map((p) => ({ key: p.bot.key, name: p.profile.name, role: p.profile.role, responsibilities: p.profile.responsibilities })));
      for (const p of byIntent) {
        const threshold = Math.min(0.95, p.bot.threshold() + AGENT_TO_AGENT_MARGIN);
        if ((decision[p.bot.key] ?? 0) >= threshold) chosen.set(p.bot.key, decision[p.bot.key]!);
      }
    }
    if (chosen.size === 0) return;

    const order = present.filter((p) => chosen.has(p.bot.key)).sort((a, b) => chosen.get(b.bot.key)! - chosen.get(a.bot.key)!);
    const run = async ({ bot, profile }: (typeof present)[number]) => {
      if ((this.generations.get(conversation) ?? 0) !== chain.generation || chain.turns >= MAX_TURNS_PER_MESSAGE) return;
      chain.turns += 1;
      const reply = await bot.answer(conversation, message);
      if (!reply) return;
      chain.spoke.add(profile.id);
      await bot.post(conversation, reply.text);
      await this.relay(conversation, reply, bot.key, hop + 1, chain);
    };
    if (settings.replyOrder === "sequential") {
      for (const p of order) await run(p);
    } else {
      await Promise.all(order.map(run));
    }
  }
}
