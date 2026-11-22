/**
 * Agents talking to each other, also in the middle of a chat (as Grok Bot's direct messages and
 * handoffs between bots). Nobody waits: the writer goes on, and the answer reaches it in real time.
 *
 * - ask: a quick question. The other agent answers in its own time, and the answer is brought into
 *   the asker's conversation as soon as it is ready: into the answer it is still writing, or as a
 *   new turn (streamed live like any other).
 * - send: a handoff. Same delivery, for real work that takes a while.
 * From a messaging channel (Telegram) the asker gets a turn there and its answer is posted.
 *
 * Each pair has one conversation per direction ("agent-dm:<from>:<to>"), a session of the receiving
 * agent where every message says who wrote it: the receiver remembers earlier exchanges. Every
 * exchange is an `agent:message` event, when it starts and when it is answered; the recent ones and
 * the pairs' conversations are listed by `overview()` (the Agent conversations view).
 *
 * Brakes: no loops (an agent already in the chain is not asked again), at most MAX_AGENT_HOPS
 * nested hops, a time limit per answer.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConversationCheckTarget } from "@polpo-ai/core";

export const MAX_AGENT_HOPS = 3;
export const ASK_TIMEOUT_MS = 5 * 60_000;
/** Header carrying the agents already in this exchange (internal calls only). */
export const AGENT_CHAIN_HEADER = "x-polpo-agent-chain";
/** Who Polpo is in a chain. */
export const POLPO = "polpo";

export interface AgentTalkRequest {
  /** One non-streaming chat turn of `agent` (undefined: Polpo) in `sessionId` ("new" for a new one). */
  turn(input: {
    agent?: string; sessionId: string; messages: Array<{ role: "user" | "assistant"; content: string }>;
    chain: string[]; origin?: ConversationCheckTarget; signal?: AbortSignal;
  }): Promise<{ text: string; sessionId: string }>;
  /** The messages of a session (user and assistant text). */
  history(sessionId: string): Promise<Array<{ role: "user" | "assistant"; content: string }>>;
  agents(): Promise<Array<{ name: string; role?: string }>>;
  /** The orchestrator's display name (settings.orchestratorName); "Polpo" without it. */
  orchestratorName?(): string;
  /**
   * Bring a message into a web conversation now: into the answer it is writing, else as the next
   * turn (streamed). Without it the reply gets a non-streaming turn.
   */
  deliver?(sessionId: string, content: string): Promise<void>;
  /** Post an answer where a conversation came from (Telegram). */
  post?(origin: ConversationCheckTarget, text: string, agent?: string): Promise<unknown>;
  /** Shown in the chat and the activity: who asked whom, and the answer. */
  emit?(event: string, data: Record<string, unknown>): void;
  log?(line: string): void;
}

export interface AgentTalkFrom {
  /** The agent writing; undefined for Polpo. */
  agent?: string;
  /** The agents already in this exchange (whoever asked the writer, and so on). */
  chain: string[];
  /** The conversation the writer is in: a later reply (send) goes back there. */
  sessionId?: string;
  origin?: ConversationCheckTarget;
}

/** One exchange between two agents, as the Agent conversations view shows it. */
export interface AgentExchange {
  id: string;
  from: string;
  to: string;
  kind: "question" | "handoff";
  message: string;
  status: "working" | "answered" | "failed";
  answer?: string;
  error?: string;
  /** The conversation the writer was in (the answer goes back there). */
  fromSessionId?: string;
  /** The pair's conversation (a session of the receiving agent). */
  dmSessionId?: string;
  startedAt: string;
  answeredAt?: string;
}

export interface AgentTalkOverview {
  conversations: Array<{ from: string; to: string; sessionId: string }>;
  recent: AgentExchange[];
}

const RECENT_LIMIT = 200;

let exchangeCounter = 0;

export class AgentTalk {
  private readonly file: string;

  constructor(polpoDir: string, private readonly io: AgentTalkRequest) {
    this.file = join(polpoDir, "agent-dms.json");
  }

  /** The writer as people see it: the agent, or the orchestrator's display name. */
  private label(agent: string | undefined): string {
    return agent ?? this.io.orchestratorName?.() ?? "Polpo";
  }

  private sessions(): Record<string, string> {
    try { return JSON.parse(readFileSync(this.file, "utf-8")) as Record<string, string>; } catch { return {}; }
  }

  private remember(key: string, sessionId: string): void {
    const all = { ...this.sessions(), [key]: sessionId };
    if (!existsSync(dirname(this.file))) mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2));
    renameSync(tmp, this.file);
  }

  /** Why `from` may not write to `to`, or undefined. */
  async refusal(from: AgentTalkFrom, to: string): Promise<string | undefined> {
    const agents = await this.io.agents();
    const target = agents.find((a) => a.name === to) ?? agents.find((a) => a.name.toLowerCase() === to.toLowerCase());
    if (!target) return `No agent "${to}". Agents: ${agents.map((a) => a.name).join(", ") || "none"}`;
    if (target.name === from.agent) return "You cannot write to yourself";
    const chain = [...from.chain, from.agent ?? POLPO];
    if (chain.includes(target.name)) return `${target.name} is already in this exchange (${chain.join(" → ")}): answer with what you have instead of asking back`;
    if (chain.length > MAX_AGENT_HOPS) return `Too many agents in a row (${chain.join(" → ")}): answer with what you have`;
    return undefined;
  }

  private async resolve(to: string): Promise<string> {
    const agents = await this.io.agents();
    return (agents.find((a) => a.name === to) ?? agents.find((a) => a.name.toLowerCase() === to.toLowerCase()))!.name;
  }

  /** The pairs' conversations and the latest exchanges, newest first. */
  overview(): AgentTalkOverview {
    const conversations = Object.entries(this.sessions())
      .map(([key, sessionId]) => {
        const [, from, to] = key.split(":");
        return { from: from === POLPO ? this.label(undefined) : from!, to: to!, sessionId };
      })
      .filter((c) => c.to);
    return { conversations, recent: [...this.recent].reverse() };
  }

  private readonly recent: AgentExchange[] = [];

  private update(exchange: AgentExchange): void {
    if (!this.recent.includes(exchange)) {
      this.recent.push(exchange);
      if (this.recent.length > RECENT_LIMIT) this.recent.splice(0, this.recent.length - RECENT_LIMIT);
    }
    this.io.emit?.("agent:message", { ...exchange, message: exchange.message.slice(0, 2000), ...(exchange.answer ? { answer: exchange.answer.slice(0, 4000) } : {}) });
  }

  /** One message from `from` to `to` in their conversation, and `to`'s answer. */
  private async exchange(from: AgentTalkFrom, exchange: AgentExchange, signal?: AbortSignal): Promise<string> {
    const to = exchange.to;
    const key = `agent-dm:${from.agent ?? POLPO}:${to}`;
    const known = this.sessions()[key];
    const history = known ? await this.io.history(known).catch(() => []) : [];
    const intro = exchange.kind === "question"
      ? `[${this.label(from.agent)} asks you, in the middle of their work: answer briefly and to the point]`
      : `[${this.label(from.agent)} hands this to you: work on it, and your answer goes back to them]`;
    const chain = [...from.chain, from.agent ?? POLPO];
    const { text, sessionId } = await this.io.turn({
      agent: to, sessionId: known ?? "new", chain, signal,
      messages: [...history, { role: "user", content: `${intro}\n${exchange.message}` }],
    });
    if (!known) this.remember(key, sessionId);
    exchange.dmSessionId = sessionId;
    return text.trim() || "(no answer)";
  }

  /**
   * Start an exchange and return at once: the other agent works on it now, and its answer is
   * brought into the writer's conversation as soon as it is ready.
   */
  private async start(from: AgentTalkFrom, to: string, message: string, kind: AgentExchange["kind"]): Promise<{ to: string; id: string }> {
    const refused = await this.refusal(from, to);
    if (refused) throw new Error(refused);
    const target = await this.resolve(to);
    const known = this.sessions()[`agent-dm:${from.agent ?? POLPO}:${target}`];
    const exchange: AgentExchange = {
      id: `ax-${Date.now().toString(36)}-${(exchangeCounter++).toString(36)}`,
      from: this.label(from.agent), to: target, kind, message, status: "working",
      ...(from.sessionId ? { fromSessionId: from.sessionId } : {}),
      ...(known ? { dmSessionId: known } : {}),
      startedAt: new Date().toISOString(),
    };
    this.update(exchange);
    void (async () => {
      let reply: string;
      try {
        reply = await this.exchange(from, exchange, AbortSignal.timeout(ASK_TIMEOUT_MS));
        Object.assign(exchange, { status: "answered", answer: reply, answeredAt: new Date().toISOString() });
        this.update(exchange);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        Object.assign(exchange, { status: "failed", error, answeredAt: new Date().toISOString() });
        this.update(exchange);
        this.io.log?.(`${kind} ${this.label(from.agent)} → ${target} failed: ${error}`);
        reply = `(no answer: ${error})`;
      }
      try {
        await this.bringBack(from, target, kind, reply);
      } catch (err) {
        this.io.log?.(`could not bring ${target}'s answer back to ${this.label(from.agent)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return { to: target, id: exchange.id };
  }

  /** The answer reaches the writer: in the web chat live, on a channel as a turn posted there. */
  private async bringBack(from: AgentTalkFrom, target: string, kind: AgentExchange["kind"], reply: string): Promise<void> {
    if (!from.sessionId) return;
    const content = `${replyHeader(target, kind)}\n${reply}`;
    if (!from.origin && this.io.deliver) {
      await this.io.deliver(from.sessionId, content);
      return;
    }
    const history = await this.io.history(from.sessionId).catch(() => []);
    const { text } = await this.io.turn({
      agent: from.agent, sessionId: from.sessionId, chain: from.chain, origin: from.origin,
      messages: [...history, { role: "user", content }],
    });
    if (from.origin && text.trim()) await this.io.post?.(from.origin, text, from.agent);
  }

  /** A quick question; the answer arrives in the asker's conversation when it is ready. */
  ask(from: AgentTalkFrom, to: string, question: string): Promise<{ to: string; id: string }> {
    return this.start(from, to, question, "question");
  }

  /** A handoff of real work; the reply arrives in the sender's conversation when it is ready. */
  send(from: AgentTalkFrom, to: string, message: string): Promise<{ to: string; id: string }> {
    return this.start(from, to, message, "handoff");
  }
}

/** First line of an answer brought back into a conversation (the web chat shows it as a card). */
export function replyHeader(agent: string, kind: AgentExchange["kind"]): string {
  return kind === "question" ? `[${agent} answered your question]` : `[${agent} replied to what you handed them]`;
}
