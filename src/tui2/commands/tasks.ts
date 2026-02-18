import chalk from "chalk";
import type { CommandAPI } from "../types.js";
import { theme, statusIcon, statusColor } from "../theme.js";
import { formatElapsed, kickRun } from "../format.js";
import { PickerOverlay } from "../overlays/picker.js";
import { ViewerOverlay } from "../overlays/viewer.js";
import { ConfirmOverlay } from "../overlays/confirm.js";

export function cmdTasks(api: CommandAPI): void {
  const { polpo, tui } = api;
  const tasks = polpo.getStore().getAllTasks();

  if (tasks.length === 0) {
    tui.logSystem("No tasks");
    tui.requestRender();
    return;
  }

  const items = tasks.map((t) => ({
    value: t.id,
    label: `${statusIcon(t.status)} ${t.title}`,
    description: `${t.status}${t.assignTo ? ` → ${t.assignTo}` : ""}`,
  }));

  const picker = new PickerOverlay({
    title: "Tasks",
    items,
    onSelect: (item) => {
      tui.hideOverlay();
      showTaskDetail(api, item.value);
    },
    onCancel: () => tui.hideOverlay(),
  });
  tui.showOverlay(picker);
}

function showTaskDetail(api: CommandAPI, taskId: string): void {
  const { polpo, tui } = api;
  const task = polpo.getStore().getTask(taskId);
  if (!task) {
    tui.logSystem(`Task not found: ${taskId}`);
    tui.requestRender();
    return;
  }

  const lines: string[] = [];
  lines.push(chalk.bold(task.title));
  lines.push("");
  lines.push(
    `Status: ${statusColor(task.status)(`${statusIcon(task.status)} ${task.status}`)}`,
  );
  if (task.assignTo) lines.push(`Agent: ${task.assignTo}`);
  if (task.group) lines.push(`Group: ${task.group}`);
  if (task.dependsOn?.length)
    lines.push(`Depends on: ${task.dependsOn.join(", ")}`);
  if (task.retries !== undefined)
    lines.push(`Retries: ${task.retries}/${task.maxRetries ?? "∞"}`);
  if (task.result?.duration)
    lines.push(`Duration: ${formatElapsed(task.result.duration)}`);
  lines.push("");
  if (task.description) {
    lines.push(chalk.bold("Description:"));
    lines.push(task.description);
  }
  if (task.result?.assessment) {
    lines.push("");
    lines.push(chalk.bold("Assessment:"));
    const a = task.result.assessment;
    if (a.globalScore !== undefined) lines.push(`  Score: ${a.globalScore}/5`);
    if (a.passed !== undefined)
      lines.push(`  Passed: ${a.passed ? "yes" : "no"}`);
    if (a.llmReview) lines.push(`  Review: ${a.llmReview}`);
  }

  const actions = [];
  if (task.status === "failed") {
    actions.push({
      label: "Retry",
      handler: () => {
        tui.hideOverlay();
        polpo.retryTask(task.id);
        kickRun(polpo);
        tui.logSystem(`Retrying: ${task.title}`);
        tui.requestRender();
      },
    });
  }
  if (task.status === "in_progress" || task.status === "assigned") {
    actions.push({
      label: "Kill",
      handler: () => {
        tui.hideOverlay();
        const confirm = new ConfirmOverlay({
          message: `Kill running task "${task.title}"?`,
          onConfirm: () => {
            tui.hideOverlay();
            polpo.killTask(task.id);
            tui.logSystem(`Killed: ${task.title}`);
            tui.requestRender();
          },
          onCancel: () => tui.hideOverlay(),
        });
        tui.showOverlay(confirm);
      },
    });
  }
  if (task.status === "done" || task.status === "review" || task.status === "failed") {
    actions.push({
      label: "Reassess",
      handler: async () => {
        tui.hideOverlay();
        tui.logSystem(`Reassessing: ${task.title}…`);
        tui.requestRender();
        try {
          await polpo.reassessTask(task.id);
          tui.logSystem(`Reassessment complete: ${task.title}`);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          tui.logSystem(`Reassessment error: ${msg}`);
        }
        tui.requestRender();
      },
    });
  }
  if (task.status === "pending" || task.status === "failed" || task.status === "done") {
    actions.push({
      label: "Delete",
      handler: () => {
        tui.hideOverlay();
        const confirm = new ConfirmOverlay({
          message: `Delete task "${task.title}"?`,
          onConfirm: () => {
            tui.hideOverlay();
            polpo.deleteTask(task.id);
            tui.logSystem(`Deleted: ${task.title}`);
            tui.requestRender();
          },
          onCancel: () => tui.hideOverlay(),
        });
        tui.showOverlay(confirm);
      },
    });
  }
  actions.push({
    label: "Close",
    handler: () => tui.hideOverlay(),
  });

  const viewer = new ViewerOverlay({
    title: `Task: ${task.title}`,
    content: lines.join("\n"),
    actions,
    onClose: () => tui.hideOverlay(),
  });
  tui.showOverlay(viewer);
}
