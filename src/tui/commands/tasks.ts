/**
 * /tasks — browse and manage tasks.
 * Shows task list as picker; selecting opens detail view with actions.
 */

import type { CommandAPI } from "./types.js";
import type { Task } from "../../core/types.js";
import { seg, statusIcon, statusColor, formatElapsed, kickRun } from "../format.js";

export function cmdTasks({ polpo, store, args }: CommandAPI) {
  const state = polpo.getStore().getState();
  const tasks = state.tasks;
  const sub = args[0]?.toLowerCase();

  if (tasks.length === 0) {
    store.log("No tasks", [seg("No tasks", "gray")]);
    return;
  }

  // /tasks list — inline summary (no picker)
  if (sub === "list" || sub === "ls") {
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
    return;
  }

  // Default: open picker
  store.navigate({
    id: "picker",
    title: `Tasks (${tasks.length})`,
    items: tasks.map((t) => ({
      label: `${statusIcon(t.status)} ${t.title}`,
      value: t.id,
      description: `${t.status}${t.assignTo ? ` → ${t.assignTo}` : ""}`,
    })),
    hint: "Enter to view details  Esc to go back",
    onSelect: (_idx, taskId) => {
      const task = state.tasks.find((t) => t.id === taskId);
      if (task) showTaskDetail(task, polpo, store);
    },
    onCancel: () => store.goMain(),
  });
}

function showTaskDetail(
  task: Task,
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  const icon = statusIcon(task.status);
  const duration = task.result?.duration;

  const lines = [
    `${icon} ${task.title}`,
    `Status: ${task.status}`,
    `Agent: ${task.assignTo}`,
    task.group ? `Group: ${task.group}` : "",
    task.dependsOn.length > 0 ? `Depends on: ${task.dependsOn.join(", ")}` : "",
    `Retries: ${task.retries}/${task.maxRetries}`,
    duration ? `Duration: ${formatElapsed(duration)}` : "",
    "",
    "── Description ──",
    task.description,
  ];

  // Assessment results
  if (task.result?.assessment) {
    const a = task.result.assessment;
    lines.push("", "── Assessment ──");
    lines.push(`Passed: ${a.passed ? "yes" : "no"}`);
    if (a.globalScore !== undefined) {
      lines.push(`Score: ${a.globalScore.toFixed(1)}/5`);
    }
    for (const check of a.checks) {
      lines.push(`  ${check.passed ? "✓" : "✗"} [${check.type}] ${check.message}`);
    }
    if (a.llmReview) {
      lines.push("", "── LLM Review ──", a.llmReview);
    }
  }

  // Result output
  if (task.result && (task.result.stdout || task.result.stderr)) {
    lines.push("", "── Output ──");
    if (task.result.stdout) lines.push(task.result.stdout.slice(0, 2000));
    if (task.result.stderr) lines.push("stderr:", task.result.stderr.slice(0, 1000));
  }

  // Build actions based on status
  const actions: string[] = [];
  if (task.status === "failed") {
    actions.push("Retry", "Kill");
  } else if (task.status === "done") {
    actions.push("Reassess");
  } else if (task.status === "in_progress" || task.status === "assigned") {
    actions.push("Kill");
  } else if (task.status === "review") {
    actions.push("Reassess");
  }
  actions.push("Close");

  store.navigate({
    id: "viewer",
    title: task.title,
    content: lines.filter(Boolean).join("\n"),
    actions,
    onAction: (idx) => {
      const action = actions[idx];
      store.goMain();

      if (action === "Retry") {
        polpo.retryTask(task.id);
        store.log(`Retrying: ${task.title}`, [
          seg("↻ ", "yellow"),
          seg(task.title, undefined, true),
        ]);
        kickRun(polpo, store);
      } else if (action === "Kill") {
        const killed = polpo.killTask(task.id);
        store.log(
          killed ? `Killed: ${task.title}` : `Could not kill: ${task.title}`,
          [seg(killed ? "✗ " : "⚠ ", killed ? "red" : "yellow"), seg(task.title, undefined, true)],
        );
      } else if (action === "Reassess") {
        store.setProcessing(true, `Reassessing ${task.title}...`);
        polpo.reassessTask(task.id).then(() => {
          store.setProcessing(false);
          store.log(`Reassessed: ${task.title}`, [
            seg("⚖ ", "magenta"),
            seg(task.title, undefined, true),
          ]);
        }).catch((err: unknown) => {
          store.setProcessing(false);
          const msg = err instanceof Error ? err.message : String(err);
          store.log(`Reassess error: ${msg}`, [seg(`Error: ${msg}`, "red")]);
        });
      }
      // "Close" just goes back to main (already called goMain above)
    },
    onClose: () => store.goMain(),
  });
}
