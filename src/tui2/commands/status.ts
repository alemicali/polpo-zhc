import chalk from "chalk";
import type { CommandAPI } from "../types.js";
import { theme, statusIcon, statusColor } from "../theme.js";

export function cmdStatus(api: CommandAPI): void {
  const { polpo } = api;
  const config = polpo.getConfig();
  const state = polpo.getStore().getState();
  const tasks = state.tasks;
  const agents = polpo.getAgents();

  const lines: string[] = [];
  lines.push(theme.bold("Status"));
  lines.push(`  Project: ${chalk.bold(state.project ?? config?.project ?? "unknown")}`);
  lines.push(`  Team: ${chalk.bold(state.team?.name ?? config?.team?.name ?? "default")} (${agents.length} agents)`);

  // Task counts
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
  }
  const countLine = Object.entries(counts)
    .map(([s, n]) => statusColor(s)(`${statusIcon(s)} ${n} ${s}`))
    .join("  ");
  lines.push(`  Tasks: ${countLine || theme.dim("none")}`);

  // Running agents
  const running = state.processes.filter((p) => p.alive);
  if (running.length > 0) {
    lines.push(theme.bold("  Running agents:"));
    for (const proc of running) {
      const task = polpo.getStore().getTask(proc.taskId);
      const title = task?.title ?? proc.taskId;
      lines.push(`    ${theme.info("●")} ${proc.agentName} → "${title}"`);
    }
  }

  api.tui.logSystem(lines.join("\n"));
  api.tui.requestRender();
}
