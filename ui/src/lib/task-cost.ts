/**
 * What a task cost: every recorded run of it (first run, retries, continuations, directions), not
 * just the latest — the same helper the server and the mission's cost use (@polpo-ai/core
 * task-cost), so a task's total and its mission's agree.
 */
import { computeTaskCost } from "@polpo-ai/core/task-cost";
import type { TaskCost, TaskCostSummary, TaskRunContext } from "@polpo-ai/react";

type TaskLike = { assignTo?: string; runs?: TaskRunContext[]; cost?: TaskCost | TaskCostSummary };

const isFull = (c: TaskCost | TaskCostSummary | undefined): c is TaskCost => !!c && "perRun" in c;

/**
 * The full breakdown from the task's runs. Task records from live events carry no `cost`, so it is
 * computed here; the API's (GET /tasks/:id) is used when it recovered runs dropped past the latest
 * 20 from the usage records (the browser cannot).
 */
export function taskCostOf(task: TaskLike | undefined): TaskCost | undefined {
  if (!task?.runs?.length) return isFull(task?.cost) ? task.cost : undefined;
  const local = computeTaskCost(task) as TaskCost;
  const server = isFull(task.cost) ? task.cost : undefined;
  if (local.partial && server?.recoveredUsd && server.runs === local.runs) return server;
  return local;
}

/** The compact total (list rows, board cards): the slim row's `cost`, else from the runs. */
export function taskCostSummaryOf(task: TaskLike | undefined): TaskCostSummary | undefined {
  if (task?.runs?.length) {
    const c = taskCostOf(task)!;
    return { usd: c.usd, tokens: c.tokens, runs: c.runs, ...(c.partial ? { partial: true } : {}) };
  }
  const c = task?.cost;
  return c?.runs ? { usd: c.usd, tokens: c.tokens, runs: c.runs, ...(c.partial ? { partial: true } : {}) } : undefined;
}

/** A total is worth showing: some run recorded a cost. */
export function hasRecordedCost(c: Pick<TaskCost, "runs"> & Partial<Pick<TaskCost, "unpricedRuns" | "recoveredUsd" | "usd">> | undefined): boolean {
  if (!c?.runs) return false;
  if (c.unpricedRuns === undefined) return true;
  return c.unpricedRuns < c.runs || !!c.recoveredUsd;
}
