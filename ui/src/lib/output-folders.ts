// Links to the output folders of tasks and mission runs (see @polpo-ai/core/output-paths):
// output/<mission run>/<NN> - <task title>/, relative to the agents' workspace.

import { taskOutputPath, taskPosition } from "@polpo-ai/core/output-paths";
import type { Task } from "@polpo-ai/react";

/** Files page on a folder relative to the agents' workspace (not always the project root). */
export function outputFolderLink(workspacePath: string): string {
  return `/files?${new URLSearchParams({ workspacePath }).toString()}`;
}

/** Statuses before the task's first run: its folder does not exist yet. */
const NOT_STARTED = new Set(["draft", "pending", "awaiting_approval", "assigned"]);

/** The task's output folder, or undefined while it has not run yet. `missionData` orders the folders. */
export function taskOutputFolder(task: Pick<Task, "id" | "title" | "group" | "status">, missionData?: string): string | undefined {
  if (NOT_STARTED.has(task.status)) return undefined;
  return taskOutputPath(task, taskPosition(missionData, task.title));
}
