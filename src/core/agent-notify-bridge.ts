/**
 * send_notification from a task run (runner.ts, any engine: Polpo's, a harness, a CLI): the tool
 * asks the orchestrator over the notification socket, and the orchestrator sends as the run's
 * agent (from the run record and the task, never from the request), with the agent's allowlist
 * and rate limit (src/notifications/agent-notify.ts) and the task / mission as the origin.
 */
import type { AgentConfig, AgentNotifyRequest, Task } from "@polpo-ai/core";
import type { RunRecord } from "./run-store.js";
import { requestOverSocket, type AgentNotifyWireReply, type AgentNotifyWireRequest } from "./notification.js";
import type { AgentNotifyAccess } from "../tools/notify-tools.js";
import type { AgentNotifier } from "../notifications/agent-notify.js";

const SEND_TIMEOUT_MS = 60_000;

/** Runner side: send_notification's access, over the notification socket. */
export function socketAgentNotify(socketPath: string, runId: string): AgentNotifyAccess {
  return {
    send: async (req) => {
      const reply = await requestOverSocket(socketPath, {
        type: "agent_notify", runId, channel: req.channel, body: req.body,
        ...(req.to ? { to: req.to } : {}), ...(req.threadTs ? { threadTs: req.threadTs } : {}),
        ...(req.title ? { title: req.title } : {}), ...(req.severity ? { severity: req.severity } : {}),
      }, SEND_TIMEOUT_MS);
      if (!reply.ok) throw new Error(reply.error);
      return { id: reply.id, channel: reply.channel, ...(reply.to ? { to: reply.to } : {}) };
    },
  };
}

/** Server side: one send of a task run, as the run's agent. */
export async function handleAgentNotifyWire(
  msg: AgentNotifyWireRequest,
  deps: {
    notifier: AgentNotifier | undefined;
    run(runId: string): Promise<Pick<RunRecord, "agentName" | "taskId" | "status" | "config"> | undefined>;
    task(taskId: string): Promise<Task | undefined>;
    /** The agent config the run uses (its version and the task's tool scope). */
    agentFor(run: Pick<RunRecord, "agentName" | "config">, task: Task | undefined): Promise<AgentConfig | undefined>;
  },
): Promise<AgentNotifyWireReply> {
  if (!deps.notifier) return { ok: false, error: "Notifications are not available on this server" };
  const run = typeof msg.runId === "string" ? await deps.run(msg.runId) : undefined;
  if (!run || run.status !== "running") return { ok: false, error: "this run is not running" };
  const task = await deps.task(run.taskId).catch(() => undefined);
  const agent = await deps.agentFor(run, task);
  if (!agent || agent.name !== run.agentName) return { ok: false, error: `agent "${run.agentName}" not found` };
  const req: AgentNotifyRequest = {
    channel: String(msg.channel ?? ""), body: String(msg.body ?? ""),
    ...(typeof msg.to === "string" ? { to: msg.to } : {}),
    ...(typeof msg.threadTs === "string" ? { threadTs: msg.threadTs } : {}),
    ...(typeof msg.title === "string" ? { title: msg.title } : {}),
    ...(msg.severity ? { severity: msg.severity } : {}),
  };
  try {
    const r = await deps.notifier.send(agent, req, {
      taskId: run.taskId, runId: msg.runId, ...(task?.missionId ? { missionId: task.missionId } : {}),
    });
    return { ok: true, id: r.id, channel: r.channel, ...(r.to ? { to: r.to } : {}) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
