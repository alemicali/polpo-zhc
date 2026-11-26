/**
 * A reply for an agent working a task (a handoff's reply, or an answer that came after the run
 * stopped waiting). It is written in the run's log, and then:
 *   - while the run works: it reaches the agent as a follow-up message (a task direction);
 *   - when the run is over (or the engine cannot take follow-ups): it is attached to the task as a
 *     text outcome ("Reply from <agent>").
 */
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { TaskOutcome } from "@polpo-ai/core";
import type { AgentExchange, AgentTalkTask } from "./agent-talk.js";

export interface AgentReplyTaskHost {
  getPolpoDir(): string;
  getRunStore(): { getRun(runId: string): Promise<{ status: string } | undefined>; getRunByTaskId(taskId: string): Promise<{ id: string; status: string } | undefined> };
  getStore(): { getTask(id: string): Promise<{ outcomes?: TaskOutcome[] } | undefined>; updateTask(id: string, updates: { outcomes: TaskOutcome[] }): Promise<unknown> };
  sendDirection(taskId: string, message: string, opts: { mode: "follow_up" }): Promise<unknown>;
}

export async function deliverAgentReplyToTask(
  host: AgentReplyTaskHost,
  task: AgentTalkTask,
  reply: { from: string; kind: AgentExchange["kind"]; content: string },
): Promise<"run" | "task"> {
  const run = task.runId ? await host.getRunStore().getRun(task.runId) : await host.getRunStore().getRunByTaskId(task.id);
  const runId = task.runId ?? (run as { id?: string } | undefined)?.id;
  // the run's log (the task's Log tab): the reply, whatever happens next
  if (runId) {
    const log = join(host.getPolpoDir(), "logs", `run-${runId}.jsonl`);
    if (existsSync(log)) {
      try {
        appendFileSync(log, JSON.stringify({ ts: new Date().toISOString(), event: "agent:reply", data: { from: reply.from, kind: reply.kind, text: reply.content.slice(0, 8000) } }) + "\n", "utf-8");
      } catch { /* best effort */ }
    }
  }
  if (run?.status === "running") {
    try {
      await host.sendDirection(task.id, reply.content.slice(0, 7900), { mode: "follow_up" });
      return "run";
    } catch { /* the run is stopping: on the task instead */ }
  }
  const current = await host.getStore().getTask(task.id);
  if (!current) return "task";
  const outcome: TaskOutcome = {
    id: nanoid(),
    type: "text",
    label: `Reply from ${reply.from}`,
    text: reply.content,
    producedBy: reply.kind === "handoff" ? "message_agent" : reply.kind === "escalation" ? "escalate" : "ask_agent",
    producedAt: new Date().toISOString(),
  };
  await host.getStore().updateTask(task.id, { outcomes: [...(current.outcomes ?? []), outcome] });
  return "task";
}
