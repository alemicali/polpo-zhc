/**
 * /tasks — browse and manage tasks.
 */

import type { CommandAPI } from "./types.js";
import { seg, statusIcon, statusColor } from "../format.js";

export function cmdTasks({ polpo, store }: CommandAPI) {
  const state = polpo.getStore().getState();
  const tasks = state.tasks;

  if (tasks.length === 0) {
    store.log("No tasks", [seg("No tasks", "gray")]);
    return;
  }

  for (const task of tasks) {
    const icon = statusIcon(task.status);
    const color = statusColor(task.status);
    store.log(`${icon} ${task.title} [${task.status}]`, [
      seg(`${icon} `, color),
      seg(task.title, undefined, true),
      seg(` [${task.status}]`, "gray"),
      task.assignTo ? seg(` → ${task.assignTo}`, "gray", false, true) : seg(""),
    ]);
  }

  // TODO: implement task detail viewer, abort, reassess via pages
}
