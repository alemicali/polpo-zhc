/**
 * Group intent: should an agent join in on a group message nobody addressed to it?
 *
 * In a group the gateway answers mentions, replies and commands. With `groupReplies: "intent"`
 * the other messages are asked about too: one classification per message, one yes/no question
 * per agent of the group (each bot of the instance is an agent, or the orchestrator), all in a
 * single call to a System One model (TypeSafe Jev), which answers every question in one
 * parallel pass with a calibrated probability. Each agent above its threshold answers.
 *
 * Every bot of the group receives its own copy of the message, with the same message id: the
 * first copy runs the classification for all the agents, the others read the same result.
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
  /** Group conversation (group, and topic): the scope of recent replies. */
  conversation: string;
  /** Message id: the same for every bot of the group. */
  messageId: string;
  title?: string;
  speaker: string;
  text: string;
  /** What the group said just before, oldest first. */
  earlier: Array<{ name: string; text: string }>;
}

/** Probability, per candidate key, that the agent should answer. */
export type IntentDecision = Record<string, number>;

export type IntentClassifier = (context: ClassifierContext, options: { apiKey: string; timeoutMs: number }) => Promise<ClassifierResult>;

export interface GroupIntentOptions {
  /** API key of the classifier; unset = intent mode stays off (mentions only). */
  apiKey: () => string | undefined;
  /** The bots that may join this conversation (asked when a message arrives). */
  candidates: (conversation: string) => Promise<IntentCandidate[]>;
  classify?: IntentClassifier;
  log?: (level: "info" | "warn", message: string) => void;
  /** Give up on the classifier after this long: the message stays context. Default 4 s. */
  timeoutMs?: number;
}

/** How long a decision is kept for the other bots' copies of the message. */
const DECISION_TTL_MS = 60_000;
/** Who answered recently counts for follow-ups ("and for tomorrow?"). */
const RECENT_REPLY_MS = 10 * 60_000;
/** The classifier reads better a short state: the last lines are enough. */
const EARLIER_LINES = 8;
const LINE_CHARS = 400;

const jev = TYPESAFE_CLASSIFIER_MODELS["jev-latest"]!;
const defaultClassify: IntentClassifier = (context, options) => typesafeClassify(jev, context, options);

const clip = (s: string, n = LINE_CHARS) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export class GroupIntentArbiter {
  private decisions = new Map<string, { at: number; result: Promise<IntentDecision> }>();
  private replies = new Map<string, Array<{ name: string; at: number }>>();
  private classify: IntentClassifier;

  constructor(private opts: GroupIntentOptions) {
    this.classify = opts.classify ?? defaultClassify;
  }

  /** Is intent mode usable at all (a key is set)? */
  get available(): boolean {
    return !!this.opts.apiKey();
  }

  /** The decision for this message: computed once, shared by every bot of the group. */
  decide(msg: IntentMessage): Promise<IntentDecision> {
    const now = Date.now();
    for (const [k, v] of this.decisions) if (now - v.at > DECISION_TTL_MS) this.decisions.delete(k);
    const key = `${msg.conversation}#${msg.messageId}`;
    const hit = this.decisions.get(key);
    if (hit) return hit.result;
    const result = this.run(msg);
    this.decisions.set(key, { at: now, result });
    return result;
  }

  /** An agent answered in this conversation: its name helps the next follow-up find it. */
  noteReply(conversation: string, name: string): void {
    const now = Date.now();
    const list = (this.replies.get(conversation) ?? []).filter((r) => now - r.at < RECENT_REPLY_MS && r.name !== name);
    list.push({ name, at: now });
    this.replies.set(conversation, list.slice(-5));
  }

  private recentRepliers(conversation: string): string[] {
    const now = Date.now();
    return (this.replies.get(conversation) ?? []).filter((r) => now - r.at < RECENT_REPLY_MS).map((r) => r.name);
  }

  private async run(msg: IntentMessage): Promise<IntentDecision> {
    const apiKey = this.opts.apiKey();
    if (!apiKey) return {};
    const candidates = await this.opts.candidates(msg.conversation);
    if (candidates.length === 0) return {};

    const context = intentContext(msg, candidates, this.recentRepliers(msg.conversation));
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
      this.opts.log?.("info", `[group intent] ${msg.conversation} #${msg.messageId} (${Date.now() - started} ms): ${summary}`);
      return decision;
    } catch (err) {
      this.opts.log?.("warn", `[group intent] classification failed, nobody joins: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  }
}

/** The state and the questions: one yes/no per agent, on the same short state. */
export function intentContext(msg: IntentMessage, candidates: IntentCandidate[], recentlyAnswered: string[]): ClassifierContext {
  const state = {
    group: msg.title ?? "a group chat",
    earlier: msg.earlier.slice(-EARLIER_LINES).map((l) => ({ from: l.name, text: clip(l.text) })),
    message: { from: msg.speaker, text: clip(msg.text, 2_000) },
    agentsInGroup: candidates.map((c) => ({ name: c.name, role: c.role, responsibilities: c.responsibilities.slice(0, 6) })),
    answeredRecently: recentlyAnswered,
  };
  const questions: ClassifierContext["questions"] = {};
  for (const c of candidates) {
    questions[c.key] = {
      type: "bool",
      instructions:
        `Nobody mentioned ${c.name} in the latest group message (state.message). Should ${c.name} (${c.role}) reply to it anyway? ` +
        `Judge only state.message, reading state.earlier as context.`,
      criteria: {
        true:
          `The message asks a question or makes a request that ${c.name} can answer or act on given its role and responsibilities, ` +
          `or it follows up on something ${c.name} said recently (state.answeredRecently).`,
        false:
          `Small talk or a conversation between people, a message addressed to a specific person, something already handled, ` +
          `or a topic outside ${c.name}'s role that another agent in state.agentsInGroup fits better.`,
      },
    };
  }
  return { state, questions };
}
