/**
 * /status — print current orchestrator state summary.
 */

import type { CommandAPI } from "./types.js";
import { seg, statusIcon, statusColor } from "../format.js";

export function cmdStatus({ polpo, store }: CommandAPI) {
  const state = polpo.getStore().getState();
  const team = polpo.getTeam();
  const teamName = team?.name ?? "default";
  const agentCount = team?.agents.length ?? 0;
  const tasks = state.tasks;

  const counts = {
    pending: tasks.filter((t) => t.status === "pending").length,
    in_progress: tasks.filter((t) => t.status === "in_progress" || t.status === "assigned").length,
    review: tasks.filter((t) => t.status === "review").length,
    done: tasks.filter((t) => t.status === "done").length,
    failed: tasks.filter((t) => t.status === "failed").length,
  };

  store.log(`Project: ${state.project}`, [
    seg("Project: ", "gray"),
    seg(state.project, undefined, true),
  ]);
  store.log(`Team: ${teamName} (${agentCount} agents)`, [
    seg("Team: ", "gray"),
    seg(teamName, undefined, true),
    seg(` (${agentCount} agents)`, "gray"),
  ]);
  store.log(
    `Tasks: ${tasks.length} total`,
    [
      seg("Tasks: ", "gray"),
      seg(`${tasks.length}`, undefined, true),
      seg(" total — ", "gray"),
      seg(`${counts.done}✓`, "green"),
      seg(" "),
      counts.failed > 0 ? seg(`${counts.failed}✗`, "red") : seg(""),
      counts.failed > 0 ? seg(" ") : seg(""),
      seg(`${counts.in_progress}●`, "cyan"),
      seg(" "),
      seg(`${counts.pending}○`, "gray"),
    ],
  );

  // Running agents
  for (const proc of state.processes) {
    if (!proc.alive) continue;
    const task = tasks.find((t) => t.id === proc.taskId);
    store.log(`  ${proc.agentName} → ${task?.title ?? proc.taskId}`, [
      seg("  "),
      seg(proc.agentName, "cyan", true),
      seg(" → ", "gray"),
      seg(task?.title ?? proc.taskId),
      proc.activity.lastTool
        ? seg(` (${proc.activity.lastTool})`, "gray", false, true)
        : seg(""),
    ]);
  }
}
