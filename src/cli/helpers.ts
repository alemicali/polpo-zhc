import chalk from "chalk";
import { resolve } from "node:path";
import { Orchestrator } from "../core/orchestrator.js";
import type { Task, Plan, TaskStatus } from "../core/types.js";

// Register adapters (side-effect imports)
import "../adapters/native.js";
import "../adapters/claude-sdk.js";
import "../adapters/generic.js";

/** Create and initialize an Orchestrator for the given config path. */
export async function createOrchestrator(configPath: string): Promise<Orchestrator> {
  const o = new Orchestrator(resolve(configPath));
  await o.init();
  return o;
}

/** Wrap orchestrator lifecycle: create, run callback, handle errors. */
export async function withOrchestrator(
  configPath: string,
  fn: (orchestrator: Orchestrator) => Promise<void>,
): Promise<void> {
  try {
    const o = await createOrchestrator(configPath);
    await fn(o);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Error: ${msg}`));
    process.exit(1);
  }
}

/** Format timestamp for console output */
export function ts(): string {
  return chalk.dim(`[${new Date().toLocaleTimeString()}]`);
}

/** Status icon for task status */
export function statusIcon(status: TaskStatus): string {
  switch (status) {
    case "pending": return chalk.gray("○");
    case "assigned": return chalk.cyan("◉");
    case "in_progress": return chalk.yellow("●");
    case "review": return chalk.magenta("●");
    case "done": return chalk.green("●");
    case "failed": return chalk.red("✗");
  }
}

/** Format a single task as a one-liner for list output */
export function formatTaskLine(task: Task): string {
  const icon = statusIcon(task.status);
  const agent = task.assignTo ? chalk.dim(` → ${task.assignTo}`) : "";
  const group = task.group ? chalk.dim(` [${task.group}]`) : "";
  const retries = task.retries > 0 ? chalk.yellow(` (retry ${task.retries}/${task.maxRetries})`) : "";
  return `  ${icon} ${task.title}${agent}${group}${retries}`;
}

/** Format a plan as a one-liner */
export function formatPlanLine(plan: Plan): string {
  const colors: Record<string, typeof chalk> = {
    draft: chalk.gray,
    active: chalk.cyan,
    completed: chalk.green,
    failed: chalk.red,
    cancelled: chalk.yellow,
  };
  const color = colors[plan.status] ?? chalk.gray;
  return `  ${plan.name} ${color(`[${plan.status}]`)}`;
}

/** Format elapsed milliseconds as human-readable string */
export function formatElapsed(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  if (min < 60) return `${min}m${s}s`;
  const hr = Math.floor(min / 60);
  const m = min % 60;
  return `${hr}h${m}m`;
}
