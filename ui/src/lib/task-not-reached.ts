/**
 * Tasks a mission decision node did not reach. When a decision takes a branch, the other branches'
 * tasks are closed as `done` without running (so joins and mission completion keep working), with
 * `result.skipped` saying why (older ones only have the result text). The dashboard must never show
 * them as done: they are "Not reached" — muted, dashed, out of the done counts.
 *
 * The decision itself (which branch, which answer) comes from the live node state while the run is
 * going (GET /decisions/nodes) and from the skipped tasks' markers once it ended.
 */
import { countTaskOutcomes, taskSkip, type TaskSkip } from "@polpo-ai/core/task-skip";
import type { Task } from "@polpo-ai/react";
import { taskNotReachedStyle, taskStatusStyles, type TaskStatusStyle } from "./status-tokens";

export { countTaskOutcomes, taskSkip, type TaskSkip };

type TaskLike = Pick<Task, "status"> & { result?: Task["result"] | null; notReached?: TaskSkip };

/** The skip marker of a task: the API's `notReached`, `result.skipped`, or the legacy result text. */
export function notReachedOf(task: TaskLike | null | undefined): TaskSkip | undefined {
  if (!task) return undefined;
  return task.notReached ?? taskSkip(task as Parameters<typeof taskSkip>[0]);
}

export function isNotReached(task: TaskLike | null | undefined): boolean {
  return notReachedOf(task) !== undefined;
}

/** The status to show and filter on: "not_reached" for a skipped task, else its status. */
export type DisplayTaskStatus = Task["status"] | "not_reached";

export function displayTaskStatus(task: TaskLike): DisplayTaskStatus {
  return isNotReached(task) ? "not_reached" : task.status;
}

/** The style (colour, icon, label) of a task's displayed status. */
export function taskDisplayStyle(task: TaskLike): TaskStatusStyle {
  return isNotReached(task) ? taskNotReachedStyle : taskStatusStyles[task.status];
}

/** "Decision route chose billing" — the tooltip on every "Not reached" badge. */
export function notReachedTooltip(s: TaskSkip): string {
  return `Decision ${s.node} chose ${s.branch ?? "no branch"}`;
}

/** A confidence (0..1) as a short label: "0.81". */
export function confidenceText(c: number | undefined): string | undefined {
  return typeof c === "number" && Number.isFinite(c) ? c.toFixed(2) : undefined;
}

/**
 * A decision node's state for the graph: pending (its after tasks are not finished), deciding,
 * awaiting (uncertain: waiting for a person), or decided (with the branch). Live state first; when
 * the run is over (the live state is gone) the branch tasks' skip markers say what it chose.
 */
export interface DecisionBranchView {
  status: "pending" | "deciding" | "awaiting" | "decided";
  branch?: string | null;
  suggested?: string | null;
  /** The answer in words ("team: billing (0.81)"). */
  answer?: string;
  confidence?: number;
}

export function decisionBranchView(
  node: { name: string; branches: Record<string, string[]> },
  live: { status: "deciding" | "decided" | "awaiting"; branch?: string | null; suggested?: string | null; answer?: string; confidence?: number } | undefined,
  findLive: (title: string) => TaskLike | undefined,
): DecisionBranchView {
  // what the tasks say: a branch task skipped by this node carries the branch it took
  let marker: TaskSkip | undefined;
  for (const title of new Set(Object.values(node.branches).flat())) {
    const s = notReachedOf(findLive(title));
    if (s && s.node === node.name) { marker = s; break; }
  }
  if (live) {
    const answer = live.answer ?? marker?.answer;
    const confidence = live.confidence ?? marker?.confidence;
    const branch = live.branch !== undefined ? live.branch : live.status === "decided" ? marker?.branch : undefined;
    return {
      status: live.status,
      ...(branch !== undefined ? { branch } : {}),
      ...(live.suggested !== undefined ? { suggested: live.suggested } : {}),
      ...(answer ? { answer } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
    };
  }
  if (marker) {
    return { status: "decided", branch: marker.branch, ...(marker.answer ? { answer: marker.answer } : {}), ...(marker.confidence !== undefined ? { confidence: marker.confidence } : {}) };
  }
  return { status: "pending" };
}

/** How one branch edge looks: taken (highlighted), not reached (dashed, muted), waiting, or neutral. */
export type BranchEdgeState = "taken" | "not_reached" | "awaiting" | "deciding" | "pending";

export function branchEdgeState(view: DecisionBranchView, keys: string[]): BranchEdgeState {
  if (view.status === "decided") return view.branch != null && keys.includes(view.branch) ? "taken" : "not_reached";
  return view.status;
}
