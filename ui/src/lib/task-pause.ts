/**
 * Pausing a task (status "paused"): which tasks can be paused or resumed, and how a pause reads.
 * Mirrors the server (packages/core/src/state-machine.ts PAUSABLE_STATUSES): pending, assigned and
 * in-progress tasks can be paused; a running one's run stops and is continued on resume.
 */
import type { Task, TaskStatus } from "@polpo-ai/react";

/** Statuses a task can be paused from. */
export const PAUSABLE_STATUSES: readonly TaskStatus[] = ["pending", "assigned", "in_progress"];

export const canPauseTask = (task: Pick<Task, "status">): boolean => PAUSABLE_STATUSES.includes(task.status);
export const canResumeTask = (task: Pick<Task, "status">): boolean => task.status === "paused";

/** "Paused by anna@acme.com · waiting for the client's logo" (who and why, for badges and tooltips). */
export function pauseSummary(task: Pick<Task, "status" | "pause">): string | undefined {
  if (task.status !== "paused") return undefined;
  const p = task.pause;
  if (!p) return "Paused";
  const who = p.by ? `Paused by ${p.by}` : "Paused";
  return p.reason ? `${who} · ${p.reason}` : who;
}

/** The pause was a blocking computer takeover nobody took: completing the takeover resumes the task. */
export const pausedForTakeover = (task: Pick<Task, "status" | "pause">): boolean => task.status === "paused" && !!task.pause?.takeover;
