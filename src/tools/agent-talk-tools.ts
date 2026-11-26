/**
 * ask_agent, message_agent and escalate: an agent (or Polpo) talks to another agent during a chat
 * or while working a task, without a background task. See src/server/agent-talk.ts.
 *
 * Communication lines: the descriptions name only the agents the writer may reach (its `talksTo`
 * lines), and the server refuses any other target anyway. escalate reaches the writer's manager
 * (reportsTo) whatever its lines.
 *
 * In a chat nobody waits: the answer arrives in the conversation later. In a task run there is no
 * later turn, so ask_agent and escalate wait for the answer (up to a time limit) and return it;
 * message_agent hands off and the run goes on (the reply reaches the task).
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ConversationCheckTarget } from "@polpo-ai/core";

/** What an agent may reach (computed from its lines; Polpo reaches everyone). */
export interface AgentReach {
  reachable: string[];
  manager?: string;
  mode: string;
}

export interface AgentTalkAccess {
  ask(from: AgentTalkCaller, to: string, question: string): Promise<{ to: string }>;
  send(from: AgentTalkCaller, to: string, message: string): Promise<{ to: string }>;
  escalate?(from: AgentTalkCaller, reason: string): Promise<{ to: string }>;
  /** A task run: ask (or escalate) and wait for the answer. */
  askAndWait?(from: AgentTalkCaller, to: string | undefined, question: string, opts?: { escalation?: boolean; waitMs?: number }): Promise<{ to: string; answer?: string }>;
  /** What `agent` may reach (undefined: Polpo). */
  lines?(agent: string | undefined): Promise<AgentReach>;
}

export interface AgentTalkCaller {
  agent?: string;
  chain: string[];
  sessionId?: string;
  origin?: ConversationCheckTarget;
  /** A task run: the task (and run) the agent is working. */
  task?: { id: string; runId?: string };
}

export const AskAgentSchema = Type.Object({
  agent: Type.String({ description: "The agent to ask (by name)" }),
  question: Type.String({ description: "What you need from them, with the context they need: they do not see this conversation" }),
});
export const MessageAgentSchema = Type.Object({
  agent: Type.String({ description: "The agent to hand this to (by name)" }),
  message: Type.String({ description: "What they should do, with the context they need: they do not see this conversation" }),
});
export const EscalateSchema = Type.Object({
  reason: Type.String({ description: "What is blocking you or needs their decision, with the context they need: they do not see your work" }),
});

export const ASK_AGENT_DESCRIPTION = "Ask another agent a quick question, in the middle of your work: "
  + "what they know or can find out with their own tools, memory and skills (\"wealth-coach: how much can Alessio spend on the gym this month?\"). "
  + "It returns at once, without the answer: do not wait for it. Go on with what you can (or tell the person you asked); "
  + "the answer arrives in this conversation as soon as it is ready, even while you are still writing. "
  + "They do not see this conversation: put what they need in the question. Use it instead of guessing what another agent knows.";
export const MESSAGE_AGENT_DESCRIPTION = "Hand something to another agent and go on: they work on it in their own time, "
  + "and their reply comes back to you in this conversation later (you get a turn to act on it). "
  + "For quick questions use ask_agent; for real work that takes a while, use this.";
export const ESCALATE_DESCRIPTION = "Escalate to your manager (the agent you report to): when you are blocked, "
  + "need a decision above your role, or something is outside your communication lines. Give the reason and the context.";

export const TASK_ASK_AGENT_DESCRIPTION = "Ask another agent a quick question while you work this task: "
  + "what they know or can find out with their own tools, memory and skills. "
  + "It waits for their answer (a few minutes at most) and returns it; if they take longer, go on with what you can: "
  + "their answer is attached to this task when it comes. They do not see your work: put what they need in the question.";
export const TASK_MESSAGE_AGENT_DESCRIPTION = "Hand something to another agent and go on with this task: they work on it in their own time; "
  + "their reply reaches this task (while you are still working you receive it as a message). For quick questions use ask_agent.";
export const TASK_ESCALATE_DESCRIPTION = "Escalate to your manager (the agent you report to) while you work this task: when you are blocked "
  + "or need a decision above your role. It waits for their answer (a few minutes at most) and returns it.";

/** The line an agent's tools add about who it can reach. */
export function reachNote(reach: AgentReach | undefined): string {
  if (!reach || reach.mode === "anyone") return reach?.reachable.length ? ` Agents you can talk to: ${reach.reachable.join(", ")}.` : "";
  return reach.reachable.length
    ? ` Your communication lines: you can talk only to ${reach.reachable.join(", ")}.`
    : " Your communication lines do not include other agents.";
}

export async function execAskAgent(args: Record<string, unknown>, talk: AgentTalkAccess | undefined, from: AgentTalkCaller): Promise<string> {
  if (!talk) return "Error: agents cannot be reached from here";
  const agent = String(args.agent ?? "").trim();
  const question = String(args.question ?? "").trim();
  if (!agent || !question) return "Error: agent and question are required";
  try {
    if (from.task && talk.askAndWait) {
      const { to, answer } = await talk.askAndWait(from, agent, question);
      return answer !== undefined
        ? `${to} answered:\n${answer}`
        : `${to} has not answered yet: go on with what you can. Their answer will be attached to this task when it comes.`;
    }
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
    return from.task
      ? `Handed to ${to}: they are working on it. Go on with this task; their reply will reach it.`
      : `Handed to ${to}: they are working on it, and their reply will come back to you in this conversation.`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function execEscalate(args: Record<string, unknown>, talk: AgentTalkAccess | undefined, from: AgentTalkCaller): Promise<string> {
  if (!talk?.escalate) return "Error: escalation is not available from here";
  const reason = String(args.reason ?? "").trim();
  if (!reason) return "Error: reason is required";
  try {
    if (from.task && talk.askAndWait) {
      const { to, answer } = await talk.askAndWait(from, undefined, reason, { escalation: true });
      return answer !== undefined
        ? `${to} (your manager) answered:\n${answer}`
        : `Escalated to ${to} (your manager), who has not answered yet: go on with what you can. Their answer will be attached to this task.`;
    }
    const { to } = await talk.escalate(from, reason);
    return `Escalated to ${to} (your manager). Their answer will arrive in this conversation as soon as it is ready.`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

type Result = { content: { type: "text"; text: string }[]; details: Record<string, unknown> };
const text = (t: string): Result => ({ content: [{ type: "text", text: t }], details: {} });

/**
 * The talk tools for an agent: `caller` is read when a tool runs (a chat's session is known late);
 * `reach` (its lines) names who it can talk to in the descriptions: without anyone to reach there is
 * no ask_agent / message_agent, without a manager no escalate. `task`: a task run's wording.
 */
export function createAgentTalkTools(
  talk: AgentTalkAccess,
  caller: () => AgentTalkCaller,
  opts: { reach?: AgentReach; task?: boolean } = {},
): AgentTool<any>[] {
  const { reach, task } = opts;
  const note = reachNote(reach);
  const tools: AgentTool<any>[] = [];
  if (!reach || reach.reachable.length > 0) {
    tools.push(
      {
        name: "ask_agent", label: "Ask agent", description: (task ? TASK_ASK_AGENT_DESCRIPTION : ASK_AGENT_DESCRIPTION) + note, parameters: AskAgentSchema,
        execute: async (_id, params) => text(await execAskAgent(params as Record<string, unknown>, talk, caller())),
      },
      {
        name: "message_agent", label: "Message agent", description: (task ? TASK_MESSAGE_AGENT_DESCRIPTION : MESSAGE_AGENT_DESCRIPTION) + note, parameters: MessageAgentSchema,
        execute: async (_id, params) => text(await execMessageAgent(params as Record<string, unknown>, talk, caller())),
      },
    );
  }
  if (reach?.manager && talk.escalate) {
    tools.push({
      name: "escalate", label: "Escalate", description: `${task ? TASK_ESCALATE_DESCRIPTION : ESCALATE_DESCRIPTION} Your manager: ${reach.manager}.`, parameters: EscalateSchema,
      execute: async (_id, params) => text(await execEscalate(params as Record<string, unknown>, talk, caller())),
    });
  }
  return tools;
}
