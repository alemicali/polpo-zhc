/**
 * Group intent: should an agent join in on a group message nobody addressed to it?
 *
 * In a group the gateway answers mentions, replies and commands. With `groupReplies: "intent"`
 * the other messages are asked about too: one classification per message, one yes/no question
 * per agent of the group (each bot of the instance is an agent, or the orchestrator), all in a
 * single call to a System One model (TypeSafe Jev), which answers every question in one
 * parallel pass with a calibrated probability. Each agent above its threshold answers.
 *
 * Every bot of the group receives its own copy of the message, with the same message id. The
 * copies are gathered for a moment (windowMs): the agents asked about are the bots that really
 * got the message, then one classification answers them all.
 *
 * What the classifier reads is the group's recent conversation, not just the message: the
 * people's messages (to the bots or not) and the agents' replies, so it can tell a follow-up
 * to an agent ("and for tomorrow?") from a new topic, and who is involved with whom.
 *
 * Without a key, or when the call fails, nobody joins: the group falls back to mentions only.
 */

import { classify as typesafeClassify } from "@earendil-works/pi-ai/api/typesafe-system-one";
import { TYPESAFE_CLASSIFIER_MODELS } from "@earendil-works/pi-ai/providers/typesafe.models";
import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";

/** An agent of the group that may join in: one per bot in intent mode where the group is enabled. */
export interface IntentCandidate {
  /** Channel key of the bot (unique in the instance). */
  key: string;
  /** Name the group knows it by. */
  name: string;
  /** What it does, in a line: its title or role. */
  role: string;
  /** Its responsibilities, short. */
  responsibilities: string[];
}

/** A group message nobody addressed, as the arbiter reads it. */
export interface IntentMessage {
  /** Group conversation (group, and topic): the scope of the transcript. */
  conversation: string;
  /** Message id: the same for every bot of the group. */
  messageId: string;
  title?: string;
  speaker: string;
  text: string;
}

/** A line of a group conversation: a person, or an agent's reply. */
export interface GroupLine {
  name: string;
  text: string;
  /** An agent of this instance (its reply), not a person. */
  agent?: boolean;
  /** Who the agent was answering. */
  to?: string;
  at: number;
}

/** Probability, per candidate key, that the agent should answer. */
export type IntentDecision = Record<string, number>;

export type IntentClassifier = (context: ClassifierContext, options: { apiKey: string; timeoutMs: number }) => Promise<ClassifierResult>;

export interface GroupIntentOptions {
  /** API key of the classifier; unset = intent mode stays off (mentions only). */
  apiKey: () => string | undefined;
  classify?: IntentClassifier;
  log?: (level: "info" | "warn", message: string) => void;
  /** Give up on the classifier after this long: the message stays context. Default 4 s. */
  timeoutMs?: number;
  /** How long the bots' copies of a message are gathered before the call. Default 700 ms. */
  windowMs?: number;
}

/** How long a decision is kept for the other bots' copies of the message. */
const DECISION_TTL_MS = 60_000;
/** The conversation the classifier reads: the last lines of the last hours. */
const TRANSCRIPT_LINES = 12;
const TRANSCRIPT_MS = 2 * 60 * 60_000;
/** Kept per conversation, and conversations kept (least recently used dropped). */
const KEEP_LINES = 30;
const KEEP_CONVERSATIONS = 200;
const LINE_CHARS = 300;

const jev = TYPESAFE_CLASSIFIER_MODELS["jev-latest"]!;
const defaultClassify: IntentClassifier = (context, options) => typesafeClassify(jev, context, options);

const clip = (s: string, n = LINE_CHARS) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export class GroupIntentArbiter {
  private decisions = new Map<string, { at: number; candidates: Map<string, IntentCandidate>; result: Promise<IntentDecision> }>();
  private transcripts = new Map<string, { lines: GroupLine[]; heard: Set<string> }>();
  private classify: IntentClassifier;

  constructor(private opts: GroupIntentOptions) {
    this.classify = opts.classify ?? defaultClassify;
  }

  /** Is intent mode usable at all (a key is set)? */
  get available(): boolean {
    return !!this.opts.apiKey();
  }

  /**
   * The decision for this message, for the bot asking (one of the group's agents). The bots that
   * ask within the window are classified together, once; a bot asking later gets no say (0).
   */
  decide(msg: IntentMessage, me: IntentCandidate): Promise<IntentDecision> {
    const now = Date.now();
    for (const [k, v] of this.decisions) if (now - v.at > DECISION_TTL_MS) this.decisions.delete(k);
    const key = `${msg.conversation}#${msg.messageId}`;
    const hit = this.decisions.get(key);
    if (hit) {
      hit.candidates.set(me.key, me);
      return hit.result;
    }
    const candidates = new Map([[me.key, me]]);
    const result = new Promise<void>((r) => setTimeout(r, this.opts.windowMs ?? 700)).then(() => this.run(msg, [...candidates.values()]));
    this.decisions.set(key, { at: now, candidates, result });
    return result;
  }

  /**
   * A line of the group conversation: a person's message (heard once, whichever bot got it) or
   * an agent's reply. Every bot of the group feeds the same transcript.
   */
  hear(conversation: string, line: Omit<GroupLine, "at">, messageId?: string): void {
    const t = this.transcripts.get(conversation) ?? { lines: [], heard: new Set<string>() };
    if (messageId) {
      if (t.heard.has(messageId)) return;
      t.heard.add(messageId);
      if (t.heard.size > KEEP_LINES * 2) t.heard.delete(t.heard.values().next().value!);
    }
    t.lines.push({ ...line, text: clip(line.text), at: Date.now() });
    t.lines = t.lines.slice(-KEEP_LINES);
    this.transcripts.delete(conversation); // re-insert: Map order = least recently used first
    this.transcripts.set(conversation, t);
    if (this.transcripts.size > KEEP_CONVERSATIONS) this.transcripts.delete(this.transcripts.keys().next().value!);
  }

  /** The recent conversation of a group, oldest first. */
  transcript(conversation: string): GroupLine[] {
    const now = Date.now();
    return (this.transcripts.get(conversation)?.lines ?? []).filter((l) => now - l.at < TRANSCRIPT_MS).slice(-TRANSCRIPT_LINES);
  }

  private async run(msg: IntentMessage, candidates: IntentCandidate[]): Promise<IntentDecision> {
    const apiKey = this.opts.apiKey();
    if (!apiKey || candidates.length === 0) return {};

    const context = intentContext(msg, candidates, this.transcript(msg.conversation));
    const started = Date.now();
    try {
      const res = await this.classify(context, { apiKey, timeoutMs: this.opts.timeoutMs ?? 4_000 });
      if (res.stopReason !== "stop") throw new Error(res.errorMessage ?? res.stopReason);
      const decision: IntentDecision = {};
      for (const c of candidates) {
        const a = res.answers[c.key];
        decision[c.key] = a?.type === "bool" ? a.probability : 0;
      }
      const summary = candidates.map((c) => `${c.name} ${decision[c.key]!.toFixed(2)}`).join(", ");
      this.opts.log?.("info", `[group intent] ${msg.title ?? msg.conversation} #${msg.messageId} "${clip(msg.text, 60)}" (${Date.now() - started} ms): ${summary}`);
      return decision;
    } catch (err) {
      this.opts.log?.("warn", `[group intent] classification failed, nobody joins: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  }
}

const minutesAgo = (at: number, now: number) => Math.max(0, Math.round((now - at) / 60_000));

/**
 * The state and the questions: one yes/no per agent, on one shared state. The state holds the
 * recent conversation (people and agents) and, per agent, how involved it is right now.
 */
export function intentContext(msg: IntentMessage, candidates: IntentCandidate[], transcript: GroupLine[], now = Date.now()): ClassifierContext {
  const involvement = (name: string) => {
    const mine = transcript.filter((l) => l.agent && l.name === name);
    const last = mine.at(-1);
    return {
      spokeInThisConversation: mine.length > 0,
      lastSpokeMinutesAgo: last ? minutesAgo(last.at, now) : null,
      lastAnswered: last?.to ?? null,
      talkingWith: [...new Set(mine.map((l) => l.to).filter((x): x is string => !!x))],
    };
  };
  const state = {
    group: msg.title ?? "a group chat",
    conversation: transcript.map((l) => ({
      from: l.agent ? `${l.name} (agent)` : l.name,
      ...(l.agent && l.to ? { replyingTo: l.to } : {}),
      text: l.text,
      minutesAgo: minutesAgo(l.at, now),
    })),
    message: { from: msg.speaker, text: clip(msg.text, 2_000) },
    agentsInGroup: candidates.map((c) => ({
      name: c.name,
      role: c.role,
      responsibilities: c.responsibilities.slice(0, 6),
      ...involvement(c.name),
    })),
  };
  const questions: ClassifierContext["questions"] = {};
  for (const c of candidates) {
    questions[c.key] = {
      type: "bool",
      instructions:
        `Nobody mentioned ${c.name} in the latest group message (state.message, from ${msg.speaker}). Should ${c.name} (${c.role}) reply to it? ` +
        `Read state.conversation, the group's recent conversation (lines marked "(agent)" are the agents' own replies), ` +
        `and ${c.name}'s involvement in state.agentsInGroup.`,
      criteria: {
        true:
          `The message continues a conversation ${c.name} is involved in: it answers something ${c.name} asked or said, ` +
          `follows up on ${c.name}'s last reply, or is a next request from the person ${c.name} was helping. ` +
          `Or it asks a question or makes a request that falls within ${c.name}'s role and responsibilities and that no other agent is already handling.`,
        false:
          `Small talk or a conversation between people, a message addressed to a specific person, something already answered, ` +
          `a follow-up to another agent's conversation, or a topic outside ${c.name}'s role that another agent in state.agentsInGroup fits better.`,
      },
    };
  }
  return { state, questions };
}
