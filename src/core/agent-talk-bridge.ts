/**
 * Agents working a task talk to other agents (ask_agent, message_agent, escalate).
 *
 * A task run lives in its own process (runner.ts), on any engine: Polpo's, a harness, a CLI. Its
 * talk tools go to the orchestrator over the notification socket (a request and its reply), and the
 * orchestrator runs them through AgentTalk (src/server/agent-talk.ts) as the run's agent, for the
 * run's task: the same lines, brakes and conversations as in a chat.
 *
 *   ask_agent / escalate — wait for the answer (TASK_ASK_WAIT_MS) and return it as the tool result;
 *                          an answer that comes later reaches the task (agent-talk-task.ts).
 *   message_agent        — hand off and go on; the reply reaches the task.
 */
import type { RunRecord } from "./run-store.js";
import { requestOverSocket, type AgentTalkWireReply, type AgentTalkWireRequest } from "./notification.js";
import type { AgentReach, AgentTalkAccess, AgentTalkCaller } from "../tools/agent-talk-tools.js";

/** How long a task run waits for an answer before going on (the server's limit; the socket waits a little more). */
export const TASK_ASK_WAIT_MS = 3 * 60_000;
const SEND_TIMEOUT_MS = 60_000;

/** What a task run gets: who it can reach (computed by the orchestrator when it started) and the way to talk. */
export interface TaskAgentTalk {
  reach: AgentReach;
  talk: AgentTalkAccess;
  task: { id: string; runId?: string };
}

/** Runner side: the talk tools' access, over the notification socket. */
export function socketAgentTalk(socketPath: string, runId: string, waitMs = TASK_ASK_WAIT_MS): AgentTalkAccess {
  const call = async (op: AgentTalkWireRequest["op"], to: string | undefined, text: string, timeoutMs: number) => {
    const reply = await requestOverSocket(socketPath, { type: "agent_talk", op, runId, ...(to ? { to } : {}), text }, timeoutMs);
    if (!reply.ok) throw new Error(reply.error);
    return reply;
  };
  return {
    ask: (_from, to, question) => call("ask", to, question, waitMs + 30_000),
    send: (_from, to, message) => call("send", to, message, SEND_TIMEOUT_MS),
    escalate: (_from, reason) => call("escalate", undefined, reason, waitMs + 30_000),
    askAndWait: (_from, to, question, opts) => opts?.escalation
      ? call("escalate", undefined, question, waitMs + 30_000)
      : call("ask", to, question, waitMs + 30_000),
  };
}

/** Server side: one request of a task run, as the run's agent (from the run record, never the request). */
export async function handleAgentTalkWire(
  msg: AgentTalkWireRequest,
  deps: { talk: AgentTalkAccess | undefined; run(runId: string): Promise<Pick<RunRecord, "agentName" | "taskId" | "status"> | undefined> },
): Promise<AgentTalkWireReply> {
  const talk = deps.talk;
  if (!talk) return { ok: false, error: "agents cannot be reached from here" };
  const run = typeof msg.runId === "string" ? await deps.run(msg.runId) : undefined;
  if (!run || run.status !== "running") return { ok: false, error: "this run is not running" };
  const text = typeof msg.text === "string" ? msg.text.trim() : "";
  if (!text) return { ok: false, error: "the message is empty" };
  const from: AgentTalkCaller = { agent: run.agentName, chain: [], task: { id: run.taskId, runId: msg.runId } };
  try {
    if (msg.op === "send") {
      const { to } = await talk.send(from, String(msg.to ?? ""), text);
      return { ok: true, to };
    }
    if (!talk.askAndWait) return { ok: false, error: "agents cannot be reached from here" };
    const { to, answer } = msg.op === "escalate"
      ? await talk.askAndWait(from, undefined, text, { escalation: true })
      : await talk.askAndWait(from, String(msg.to ?? ""), text);
    return { ok: true, to, ...(answer !== undefined ? { answer } : {}) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
