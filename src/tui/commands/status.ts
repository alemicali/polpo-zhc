/**
 * Simple informational commands: /status, /result, /help
 */

import type { CommandContext } from "../context.js";
import { getStatusIcon, getStatusLabel } from "../formatters.js";
import { SLASH_COMMANDS, SHORTCUTS } from "../constants.js";

export function cmdStatus(ctx: CommandContext): void {
  ctx.loadState();
  const state = ctx.getState();
  if (!state || state.tasks.length === 0) {
    ctx.logAlways("{grey-fg}No tasks found{/grey-fg}");
    return;
  }

  ctx.logAlways("");
  ctx.logAlways("{bold}Task Status:{/bold}");
  for (const task of state.tasks) {
    const icon = getStatusIcon(task.status);
    const label = getStatusLabel(task.status);
    const dur = task.result ? ` (${(task.result.duration / 1000).toFixed(1)}s)` : "";
    const score = task.result?.assessment?.globalScore !== undefined
      ? ` [{bold}${task.result.assessment.globalScore.toFixed(1)}/5{/bold}]`
      : "";
    ctx.logAlways(`  ${icon} ${label} ${task.title}${dur}${score}`);

    if (task.result?.assessment?.scores) {
      for (const s of task.result.assessment.scores) {
        const stars = "★".repeat(s.score) + "☆".repeat(5 - s.score);
        const color = s.score >= 4 ? "green" : s.score >= 3 ? "yellow" : "red";
        ctx.logAlways(`    {${color}-fg}${stars}{/${color}-fg} ${s.dimension}`);
      }
    }
  }
  ctx.logAlways("");
}

export function cmdResult(ctx: CommandContext): void {
  ctx.loadState();
  const state = ctx.getState();
  if (!state || state.tasks.length === 0) {
    ctx.logAlways("{grey-fg}No tasks found{/grey-fg}");
    return;
  }

  const withResult = [...state.tasks]
    .filter(t => t.result)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  if (withResult.length === 0) {
    ctx.logAlways("{grey-fg}No task results yet{/grey-fg}");
    return;
  }

  const task = withResult[0];
  const r = task.result!;

  ctx.logAlways("");
  ctx.logAlways(`{bold}Result: ${task.title}{/bold} {grey-fg}[${task.id}]{/grey-fg}`);
  ctx.logAlways(`{grey-fg}Status: ${task.status} | Duration: ${(r.duration / 1000).toFixed(1)}s | Exit: ${r.exitCode}{/grey-fg}`);

  if (r.assessment?.globalScore !== undefined) {
    const color = r.assessment.globalScore >= 4 ? "green" : r.assessment.globalScore >= 3 ? "yellow" : "red";
    ctx.logAlways(`{${color}-fg}Score: ${r.assessment.globalScore.toFixed(1)}/5{/${color}-fg}`);
    if (r.assessment.scores) {
      for (const s of r.assessment.scores) {
        const sc = s.score >= 4 ? "green" : s.score >= 3 ? "yellow" : "red";
        const stars = "★".repeat(s.score) + "☆".repeat(5 - s.score);
        ctx.logAlways(`  {${sc}-fg}${stars}{/${sc}-fg} ${s.dimension}`);
      }
    }
  }

  ctx.logAlways("");
  if (r.stdout) {
    const lines = r.stdout.split("\n");
    for (const line of lines) {
      ctx.logAlways(`  ${line}`);
    }
  }
  ctx.logAlways("");
}

export function cmdHelp(ctx: CommandContext): void {
  ctx.logAlways("");
  ctx.logAlways("{bold}Commands:{/bold}");
  for (const [cmd, desc] of Object.entries(SLASH_COMMANDS)) {
    ctx.logAlways(`  {cyan-fg}${cmd.padEnd(12)}{/cyan-fg} ${desc}`);
  }
  ctx.logAlways("");
  ctx.logAlways("{bold}Shortcuts:{/bold}");
  for (const [key, desc] of Object.entries(SHORTCUTS)) {
    ctx.logAlways(`  {cyan-fg}${key.padEnd(12)}{/cyan-fg} ${desc}`);
  }
  ctx.logAlways("");
}
