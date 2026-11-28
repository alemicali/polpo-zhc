/**
 * The rules for steering or continuing a task from the dashboard, shared by the Execution tab's
 * two views (the log's direction box and the chat view's composer) so both allow the same things:
 *
 * - draft, awaiting approval, review: nothing to steer yet (or being assessed);
 * - a live run (assigned / in progress with a runner): the message steers it;
 * - a runner still stopping (failed / done with a process): wait;
 * - otherwise (pending, done, failed): the message continues the task in a new run, and a task
 *   with side effects asks to confirm that external actions may repeat.
 */
import type { AgentProcess, SendTaskDirectionResult, Task, UseTaskDirectionsReturn } from "@polpo-ai/react";

export interface TaskSteering {
  /** The task accepts directions at all. */
  isAvailable: boolean;
  /** A run is going: the message steers it. */
  isLive: boolean;
  /** A runner is still stopping: nothing can be sent until it is gone. */
  isStopping: boolean;
  /** Continuing a task with side effects needs the explicit confirmation. */
  needsConfirmation: boolean;
  /** "Send direction", "Add direction", "Continue task". */
  actionLabel: string;
  placeholder: string;
  /** Why nothing can be sent right now (undefined: it can). */
  disabledReason?: string;
}

export function taskSteering(task: Pick<Task, "status" | "sideEffects">, process?: AgentProcess): TaskSteering {
  const isLive = !!process && (task.status === "assigned" || task.status === "in_progress");
  const isStopping = !!process && (task.status === "failed" || task.status === "done");
  const isAvailable = task.status !== "draft" && task.status !== "awaiting_approval" && task.status !== "review";
  const needsConfirmation = !isLive && !!task.sideEffects;
  const actionLabel = isLive ? "Send direction" : task.status === "pending" ? "Add direction" : "Continue task";
  const placeholder = isLive ? "Steer the current run..." : "Continue with a new direction...";
  const disabledReason = !isAvailable
    ? task.status === "draft"
      ? "Queue the task to steer it"
      : task.status === "awaiting_approval"
        ? "The task is waiting for approval"
        : "The task is being reviewed: wait for the assessment"
    : isStopping
      ? "Waiting for the runner to stop"
      : undefined;
  return { isAvailable, isLive, isStopping, needsConfirmation, actionLabel, placeholder, disabledReason };
}

/** Send a direction (auto: steer a live run, else continue), with the side-effect confirmation when needed. */
export async function sendTaskDirection(
  steering: TaskSteering,
  sendDirection: UseTaskDirectionsReturn["sendDirection"],
  message: string,
  confirmSideEffects: boolean,
) {
  return sendDirection({
    message: message.trim(),
    mode: "auto",
    confirmSideEffects: steering.needsConfirmation ? confirmSideEffects : undefined,
  });
}

/** What the toast says once a direction is sent (a continuation may reopen the task's finished mission). */
export function directionSentMessage(result: Pick<SendTaskDirectionResult, "action" | "reopenedMission">): string {
  if (result.action !== "continue") return "Direction queued";
  const reopened = result.reopenedMission;
  return reopened ? `Continuation queued: mission "${reopened.name}" is active again` : "Continuation queued";
}
