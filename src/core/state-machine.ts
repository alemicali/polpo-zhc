import type { TaskStatus } from "./types.js";

/** Valid state transitions for the task state machine. */
export const VALID_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ["assigned"],
  assigned: ["in_progress"],
  in_progress: ["review", "failed"],
  review: ["done", "failed"],
  done: [],
  failed: ["pending"],
} as const;

/** Check whether a transition from one status to another is valid. */
export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

/** Throw if the transition is invalid. */
export function assertValidTransition(from: TaskStatus, to: TaskStatus): void {
  if (!isValidTransition(from, to)) {
    const allowed = VALID_TRANSITIONS[from];
    throw new Error(
      `Invalid transition: ${from} → ${to} (allowed: ${allowed.join(", ") || "none"})`
    );
  }
}
