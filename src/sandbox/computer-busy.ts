/**
 * Whether a computer is busy: the work a stop or restart would interrupt. Used by
 * POST /computers/:id/stop and /restart (409 COMPUTER_BUSY unless force) and Polpo's computer_stop.
 *
 * - task runs in progress on it: assigned or in_progress tasks whose running run resolved to it;
 * - live agent harness sessions on it (task and chat sessions held by a process: starting,
 *   running or idle; a detached or stopped session is not work).
 */
import type { Task } from "@polpo-ai/core";
import type { HarnessSessionView } from "../harness/control.js";

export interface ComputerBusy {
  tasks: Array<{ taskId: string; title: string; status: string; runId: string; agent?: string }>;
  sessions: Array<{ key: string; sessionId?: string; agent: string; harness: string; scope: "task" | "chat"; state: string; taskId?: string; chatSessionId?: string }>;
}

/** Harness session states that are work on the computer (held live by a process). */
const BUSY_SESSION_STATES = new Set<string>(["starting", "running", "idle"]);

export function computerBusy(computerId: string, tasks: Task[], sessions: HarnessSessionView[]): ComputerBusy {
  const busyTasks: ComputerBusy["tasks"] = [];
  for (const t of tasks) {
    if (t.status !== "assigned" && t.status !== "in_progress") continue;
    const run = [...(t.runs ?? [])].reverse().find((r) => r.computer?.id === computerId && r.status === "running");
    if (run) busyTasks.push({ taskId: t.id, title: t.title, status: t.status, runId: run.runId, ...(run.agent ? { agent: run.agent } : {}) });
  }
  const busySessions = sessions
    .filter((s) => s.computerId === computerId && s.live && BUSY_SESSION_STATES.has(s.state))
    .map((s) => ({
      key: s.key, ...(s.sessionId ? { sessionId: s.sessionId } : {}), agent: s.agent, harness: s.harness, scope: s.scope, state: s.state,
      ...(s.taskId ? { taskId: s.taskId } : {}), ...(s.chatSessionId ? { chatSessionId: s.chatSessionId } : {}),
    }));
  return { tasks: busyTasks, sessions: busySessions };
}

export function isComputerBusy(busy: ComputerBusy): boolean {
  return busy.tasks.length > 0 || busy.sessions.length > 0;
}

/** "Computer "nina" is busy: task t-1 "Scrape" (sitoinchat); chat session s-9 (growth, claude-code, running). Stopping it now…" */
export function computerBusyMessage(computerId: string, busy: ComputerBusy, op: "stop" | "restart", how = `send { "force": true }`): string {
  const what = [
    ...busy.tasks.map((t) => `task ${t.taskId} "${t.title}"${t.agent ? ` (${t.agent})` : ""}`),
    ...busy.sessions.map((s) => `${s.scope} session ${s.sessionId ?? s.key} (${s.agent}, ${s.harness}, ${s.state})`),
  ];
  const verb = op === "stop" ? "Stopping" : "Restarting";
  return `Computer "${computerId}" is busy: ${what.join("; ")}. ${verb} it now interrupts them: wait for them to finish, or ${how} to ${op} it anyway`;
}
