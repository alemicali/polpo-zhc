import chalk from "chalk";
import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";
import type { TaskSnapshot, MissionSnapshot, AgentActivity } from "../types.js";
import { theme, statusIcon, statusColor } from "../theme.js";
import { formatElapsed, formatDuration, progressBar, spinnerFrame } from "../format.js";

/** Default task panel width in columns */
export const TASK_PANEL_WIDTH = 56;

export class TaskPanel implements Component {
  private tasks: TaskSnapshot[] = [];
  private missions: MissionSnapshot[] = [];
  private activities: AgentActivity[] = [];
  private startedAt: number | null = null;
  private orchestratorStartedAt: number | null = null;
  private visible = true;
  private spinnerTick = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private requestRenderFn: () => void) {
    this.spinnerTimer = setInterval(() => {
      this.spinnerTick++;
      if (this.visible && this.hasActiveTask()) {
        this.requestRenderFn();
      }
    }, 80);
  }

  setTasks(tasks: TaskSnapshot[]): void {
    this.tasks = tasks;
  }

  setMissions(missions: MissionSnapshot[]): void {
    this.missions = missions;
  }

  setActivities(activities: AgentActivity[]): void {
    this.activities = activities;
  }

  setStartedAt(ts: number | null): void {
    this.startedAt = ts;
  }

  setOrchestratorStartedAt(ts: number | null): void {
    this.orchestratorStartedAt = ts;
  }

  setVisible(v: boolean): void {
    this.visible = v;
  }

  isVisible(): boolean {
    return this.visible;
  }

  private hasActiveTask(): boolean {
    return this.tasks.some((t) => t.status === "in_progress" || t.status === "review");
  }

  dispose(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (!this.visible) return [];

    const lines: string[] = [];
    const panelWidth = Math.min(width, 64);
    const sep = chalk.dim("\u2500".repeat(panelWidth));
    const border = chalk.dim("\u2502"); // │ left border

    // Header
    lines.push(theme.header(" TASKS"));
    lines.push(sep);

    // Task counts
    const counts = this.countByStatus();
    const countParts: string[] = [];
    for (const [status, count] of Object.entries(counts)) {
      if (count > 0) {
        const icon = statusIcon(status);
        const color = statusColor(status);
        countParts.push(color(`${icon} ${count} ${status}`));
      }
    }
    if (countParts.length > 0) {
      lines.push(` ${countParts.join("  ")}`);
    } else {
      lines.push(theme.dim(" No tasks"));
    }

    // Progress bar
    const doneCount = counts.done ?? 0;
    const totalCount = this.tasks.length;
    if (totalCount > 0) {
      const bar = progressBar(doneCount, totalCount, panelWidth - 10);
      lines.push(` ${bar} ${doneCount}/${totalCount}`);
    }

    // Timers
    if (this.startedAt) {
      const elapsed = Date.now() - this.startedAt;
      lines.push(theme.dim(` Session: ${formatDuration(elapsed)}`));
    }
    if (this.orchestratorStartedAt) {
      const elapsed = Date.now() - this.orchestratorStartedAt;
      lines.push(theme.dim(` Orchestrator: ${formatDuration(elapsed)}`));
    }

    // Compute time
    const totalCompute = this.tasks.reduce((sum, t) => sum + (t.duration ?? 0), 0);
    if (totalCompute > 0) {
      lines.push(theme.dim(` Compute: ${formatDuration(totalCompute)}`));
    }

    lines.push(sep);

    // Missions
    if (this.missions.length > 0) {
      lines.push(theme.bold(" MISSIONS"));
      for (const mission of this.missions) {
        const statusLabel =
          mission.status === "active"
            ? theme.inProgress("active")
            : mission.status === "completed"
              ? theme.done("completed")
              : mission.status === "failed"
                ? theme.failed("failed")
                : theme.dim(mission.status);
        const progress = mission.taskCount
          ? ` (${mission.completedCount ?? 0}/${mission.taskCount})`
          : "";
        lines.push(` ${statusLabel} ${mission.name}${progress}`);
      }
      lines.push(sep);
    }

    // Task list with activity
    if (this.tasks.length > 0) {
      lines.push(theme.bold(" TASK LIST"));
      const maxTasks = 20;
      const displayed = this.tasks.slice(0, maxTasks);
      for (const task of displayed) {
        const icon =
          task.status === "in_progress"
            ? theme.inProgress(spinnerFrame(this.spinnerTick))
            : statusIcon(task.status);
        const color = statusColor(task.status);
        const title = truncateToWidth(task.title, panelWidth - 8);
        lines.push(` ${color(icon)} ${title}`);

        // Activity line
        const activity = this.activities.find((a) => a.taskId === task.id);
        if (activity) {
          const parts: string[] = [];
          if (activity.currentTool) parts.push(activity.currentTool);
          if (activity.elapsed) parts.push(formatElapsed(activity.elapsed));
          if (activity.tokens) parts.push(`${activity.tokens}tok`);
          if (activity.toolCalls) parts.push(`${activity.toolCalls}calls`);
          if (parts.length > 0) {
            lines.push(theme.dim(`   ${parts.join(" \u00B7 ")}`));
          }
        }

        // Score
        if (task.score !== undefined && task.score >= 0) {
          const scoreColor =
            task.score >= 80 ? theme.done : task.score >= 50 ? theme.warning : theme.failed;
          lines.push(theme.dim(`   Score: `) + scoreColor(`${task.score}%`));
        }
      }
      if (this.tasks.length > maxTasks) {
        lines.push(theme.dim(` +${this.tasks.length - maxTasks} more`));
      }
    }

    // Hint
    lines.push("");
    lines.push(theme.dim(" Ctrl+O to hide"));

    // Prepend left border to every line for visual separation
    return lines.map(l => `${border}${l}`);
  }

  private countByStatus(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const task of this.tasks) {
      counts[task.status] = (counts[task.status] ?? 0) + 1;
    }
    return counts;
  }
}
