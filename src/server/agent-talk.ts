/**
 * Agents talking to each other, also in the middle of a chat (as Grok Bot's direct messages and
 * handoffs between bots):
 *
 * - ask: an agent (or Polpo) asks another and waits for the answer within its own turn;
 * - send: a handoff. The other agent wakes up, works on it in its own time, and its reply goes back
 *   to the sender, who gets a turn in the conversation it wrote from (on Telegram, its answer is
 *   posted there).
 *
 * Each pair has one conversation per direction ("agent-dm:<from>:<to>"), a session of the receiving
 * agent where every message says who wrote it: the receiver remembers earlier exchanges.
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

const label = (agent: string | undefined) => agent ?? "Polpo";

export class AgentTalk {
  private readonly file: string;

  constructor(polpoDir: string, private readonly io: AgentTalkRequest) {
    this.file = join(polpoDir, "agent-dms.json");
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

  /** One message from `from` to `to` in their conversation, and `to`'s answer. */
  private async exchange(from: AgentTalkFrom, to: string, message: string, kind: "question" | "handoff", signal?: AbortSignal): Promise<string> {
    const key = `agent-dm:${from.agent ?? POLPO}:${to}`;
    const known = this.sessions()[key];
    const history = known ? await this.io.history(known).catch(() => []) : [];
    const intro = kind === "question"
      ? `[${label(from.agent)} asks you, in the middle of their work: answer briefly and to the point; they are waiting]`
      : `[${label(from.agent)} hands this to you: work on it, and your answer goes back to them]`;
    const chain = [...from.chain, from.agent ?? POLPO];
    const { text, sessionId } = await this.io.turn({
      agent: to, sessionId: known ?? "new", chain, signal,
      messages: [...history, { role: "user", content: `${intro}\n${message}` }],
    });
    if (!known) this.remember(key, sessionId);
    this.io.emit?.("agent:message", { from: label(from.agent), to, kind, sessionId, question: message.slice(0, 500), answer: text.slice(0, 2000) });
    return text.trim() || "(no answer)";
  }

  /** Ask and wait: the answer comes back within the asker's turn. */
  async ask(from: AgentTalkFrom, to: string, question: string): Promise<string> {
    const refused = await this.refusal(from, to);
    if (refused) throw new Error(refused);
    const target = await this.resolve(to);
    const timeout = AbortSignal.timeout(ASK_TIMEOUT_MS);
    return this.exchange(from, target, question, "question", timeout);
  }

  /**
   * Hand off and go on: the other agent works on it now, in the background; its reply goes back to
   * the sender, who gets a turn in its conversation (and on Telegram posts its answer there).
   */
  async send(from: AgentTalkFrom, to: string, message: string): Promise<{ to: string }> {
    const refused = await this.refusal(from, to);
    if (refused) throw new Error(refused);
    const target = await this.resolve(to);
    void (async () => {
      try {
        const reply = await this.exchange(from, target, message, "handoff");
        if (!from.sessionId) return;
        const history = await this.io.history(from.sessionId).catch(() => []);
        const { text } = await this.io.turn({
          agent: from.agent, sessionId: from.sessionId, chain: from.chain, origin: from.origin,
          messages: [...history, { role: "user", content: `[${target} replied to what you handed them]\n${reply}` }],
        });
        if (from.origin && text.trim()) await this.io.post?.(from.origin, text, from.agent);
      } catch (err) {
        this.io.log?.(`handoff ${label(from.agent)} → ${target} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return { to: target };
  }
}
