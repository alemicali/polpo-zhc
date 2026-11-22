/**
 * ask_agent and message_agent: an agent (or Polpo) talks to another agent during a chat, without a
 * background task. See src/server/agent-talk.ts.
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ConversationCheckTarget } from "@polpo-ai/core";

export interface AgentTalkAccess {
  ask(from: AgentTalkCaller, to: string, question: string): Promise<{ to: string }>;
  send(from: AgentTalkCaller, to: string, message: string): Promise<{ to: string }>;
}

export interface AgentTalkCaller {
  agent?: string;
  chain: string[];
  sessionId?: string;
  origin?: ConversationCheckTarget;
}

export const AskAgentSchema = Type.Object({
  agent: Type.String({ description: "The agent to ask (by name)" }),
  question: Type.String({ description: "What you need from them, with the context they need: they do not see this conversation" }),
});
export const MessageAgentSchema = Type.Object({
  agent: Type.String({ description: "The agent to hand this to (by name)" }),
  message: Type.String({ description: "What they should do, with the context they need: they do not see this conversation" }),
});

export const ASK_AGENT_DESCRIPTION = "Ask another agent a quick question, in the middle of your work: "
  + "what they know or can find out with their own tools, memory and skills (\"wealth-coach: how much can Alessio spend on the gym this month?\"). "
  + "It returns at once, without the answer: do not wait for it. Go on with what you can (or tell the person you asked); "
  + "the answer arrives in this conversation as soon as it is ready, even while you are still writing. "
  + "They do not see this conversation: put what they need in the question. Use it instead of guessing what another agent knows.";
export const MESSAGE_AGENT_DESCRIPTION = "Hand something to another agent and go on: they work on it in their own time, "
  + "and their reply comes back to you in this conversation later (you get a turn to act on it). "
  + "For quick questions use ask_agent; for real work that takes a while, use this.";

export async function execAskAgent(args: Record<string, unknown>, talk: AgentTalkAccess | undefined, from: AgentTalkCaller): Promise<string> {
  if (!talk) return "Error: agents cannot be reached from here";
  const agent = String(args.agent ?? "").trim();
  const question = String(args.question ?? "").trim();
  if (!agent || !question) return "Error: agent and question are required";
  try {
    const { to } = await talk.ask(from, agent, question);
    return `Asked ${to}. Their answer will arrive in this conversation as soon as it is ready: do not wait for it, go on with what you can.`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function execMessageAgent(args: Record<string, unknown>, talk: AgentTalkAccess | undefined, from: AgentTalkCaller): Promise<string> {
  if (!talk) return "Error: agents cannot be reached from here";
  const agent = String(args.agent ?? "").trim();
  const message = String(args.message ?? "").trim();
  if (!agent || !message) return "Error: agent and message are required";
  try {
    const { to } = await talk.send(from, agent, message);
    return `Handed to ${to}: they are working on it, and their reply will come back to you in this conversation.`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

type Result = { content: { type: "text"; text: string }[]; details: Record<string, unknown> };
const text = (t: string): Result => ({ content: [{ type: "text", text: t }], details: {} });

/** The tools for an agent chat; `caller` is read when a tool runs (the session is known late). */
export function createAgentTalkTools(talk: AgentTalkAccess, caller: () => AgentTalkCaller): AgentTool<any>[] {
  return [
    {
      name: "ask_agent", label: "Ask agent", description: ASK_AGENT_DESCRIPTION, parameters: AskAgentSchema,
      execute: async (_id, params) => text(await execAskAgent(params as Record<string, unknown>, talk, caller())),
    },
    {
      name: "message_agent", label: "Message agent", description: MESSAGE_AGENT_DESCRIPTION, parameters: MessageAgentSchema,
      execute: async (_id, params) => text(await execMessageAgent(params as Record<string, unknown>, talk, caller())),
    },
  ];
}
