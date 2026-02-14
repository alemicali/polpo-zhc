/**
 * Event bridge — wires Orchestrator events to TUI store log entries.
 * Returns a cleanup function to unsubscribe all listeners.
 */

import type { Orchestrator } from "../core/orchestrator.js";
import type { TUIStore } from "./store.js";
import { seg, formatElapsed } from "./format.js";

type Off = () => void;

/** Look up a task title from store, falling back to truncated taskId. */
function taskTitle(polpo: Orchestrator, taskId: string): string {
  try {
    const t = polpo.getStore()?.getTask(taskId);
    return t?.title ?? taskId.slice(0, 8);
  } catch {
    return taskId.slice(0, 8);
  }
}

export function bridgeEvents(polpo: Orchestrator, store: TUIStore): Off {
  const offs: Off[] = [];

  const on = (event: string, handler: (...args: any[]) => void) => {
    polpo.on(event as any, handler as any);
    offs.push(() => polpo.off(event as any, handler as any));
  };

  // ─── Agent lifecycle ────────────────────────────────

  on("agent:spawned", ({ agentName, taskTitle: title }: any) => {
    store.log(`▸ ${title} → ${agentName}`, [
      seg("▸ ", "cyan"),
      seg(title, undefined, true),
      seg(` → ${agentName}`, "gray"),
    ]);
  });

  on("agent:finished", ({ taskId, agentName, exitCode, duration }: any) => {
    const title = taskTitle(polpo, taskId);
    const elapsed = formatElapsed(duration ?? 0);
    const icon = exitCode === 0 ? "✓" : "✗";
    const color = exitCode === 0 ? "green" : "red";
    store.log(`${icon} ${agentName} finished ${title} (${elapsed})`, [
      seg(`${icon} `, color),
      seg(agentName, undefined, true),
      seg(` finished `, "gray"),
      seg(title, undefined, true),
      seg(` (${elapsed})`, "gray"),
    ]);
  });

  on("agent:stale", ({ agentName, action }: any) => {
    const icon = action === "killed" ? "✗" : "⚠";
    const color = action === "killed" ? "red" : "yellow";
    store.log(`${icon} ${agentName} ${action}`, [
      seg(`${icon} `, color),
      seg(agentName, undefined, true),
      seg(` ${action}`, "gray"),
    ]);
  });

  // ─── Task lifecycle ─────────────────────────────────

  on("task:created", ({ task }: any) => {
    store.log(`+ ${task.title}`, [
      seg("+ ", "green"),
      seg(task.title, undefined, true),
    ]);
  });

  on("task:transition", ({ taskId, to, task }: any) => {
    const title = task?.title ?? taskTitle(polpo, taskId);
    if (to === "done") {
      const score = task?.result?.assessment?.globalScore;
      const scoreText = score !== undefined ? ` (${score.toFixed(1)}/5)` : "";
      store.log(`✓ ${title}${scoreText}`, [
        seg("✓ ", "green", true),
        seg(title, undefined, true),
        seg(scoreText, "gray"),
      ]);
    } else if (to === "failed") {
      store.log(`✗ ${title}`, [
        seg("✗ ", "red", true),
        seg(title, undefined, true),
      ]);
    }
  });

  on("task:retry", ({ taskId, attempt, maxRetries }: any) => {
    const title = taskTitle(polpo, taskId);
    store.log(`↻ ${title} (${attempt}/${maxRetries})`, [
      seg("↻ ", "yellow"),
      seg(title, undefined, true),
      seg(` ${attempt}/${maxRetries}`, "gray"),
    ]);
  });

  on("task:recovered", ({ title, previousStatus }: any) => {
    store.log(`⟳ Recovered: ${title}`, [
      seg("⟳ ", "blue"),
      seg(title, undefined, true),
      seg(` from ${previousStatus}`, "gray"),
    ]);
  });

  on("task:timeout", ({ taskId }: any) => {
    const title = taskTitle(polpo, taskId);
    store.log(`⏱ Timeout: ${title}`, [
      seg("⏱ ", "red"),
      seg(title, undefined, true),
      seg(" timed out", "gray"),
    ]);
  });

  // ─── Assessment ─────────────────────────────────────

  on("assessment:started", ({ taskId }: any) => {
    const title = taskTitle(polpo, taskId);
    store.log(`✦ Assessing: ${title}`, [
      seg("✦ ", "yellow"),
      seg(title, undefined, true),
      seg("...", "gray"),
    ]);
  });

  on("assessment:progress", ({ taskId, message }: any) => {
    const title = taskTitle(polpo, taskId);
    store.log(`  ${title}: ${message}`, [
      seg("  ", "gray"),
      seg(title, undefined, true),
      seg(`: ${message}`, "gray"),
    ]);
  });

  on("assessment:complete", ({ taskId, passed, globalScore, message }: any) => {
    const title = taskTitle(polpo, taskId);
    if (passed) {
      const scoreText = globalScore !== undefined ? ` ${globalScore.toFixed(1)}/5` : "";
      store.log(`✓ Passed: ${title}${scoreText}`, [
        seg("✓ ", "green", true),
        seg(title, undefined, true),
        seg(scoreText, "green"),
      ]);
    } else {
      const reason = message ? `: ${message}` : "";
      store.log(`✗ Failed: ${title}${reason}`, [
        seg("✗ ", "red"),
        seg(title, undefined, true),
        seg(reason, "gray", false, true),
      ]);
    }
  });

  on("assessment:corrected", ({ taskId, corrections }: any) => {
    const title = taskTitle(polpo, taskId);
    store.log(`⚡ Auto-corrected ${corrections} expectation(s) for ${title}`, [
      seg("⚡ ", "yellow"),
      seg(`${corrections}`, undefined, true),
      seg(` expectation(s) corrected — `, "gray"),
      seg(title, undefined, true),
    ]);
  });

  // ─── Deadlock ─────────────────────────────────────

  on("deadlock:detected", ({ taskIds }: any) => {
    store.log(`⚠ Deadlock detected: ${taskIds.length} tasks`, [
      seg("⚠ ", "red", true),
      seg("Deadlock: ", "red"),
      seg(`${taskIds.length} tasks blocked`, "gray"),
    ]);
  });

  on("deadlock:resolved", ({ taskId, action, reason }: any) => {
    const title = taskTitle(polpo, taskId);
    store.log(`✓ Deadlock resolved: ${title} (${action})`, [
      seg("✓ ", "green"),
      seg(title, undefined, true),
      seg(` ${action}: ${reason}`, "gray"),
    ]);
  });

  on("deadlock:unresolvable", ({ taskId, reason }: any) => {
    const title = taskTitle(polpo, taskId);
    store.log(`✗ Unresolvable: ${title}`, [
      seg("✗ ", "red"),
      seg(title, undefined, true),
      seg(`: ${reason}`, "gray"),
    ]);
  });

  // ─── Plans ──────────────────────────────────────────

  on("plan:executed", ({ group, taskCount }: any) => {
    store.log(`▶ Plan "${group}" (${taskCount} tasks)`, [
      seg("▶ ", "blue", true),
      seg(group, undefined, true),
      seg(` started (${taskCount} tasks)`, "gray"),
    ]);
  });

  on("plan:completed", ({ group, allPassed }: any) => {
    const icon = allPassed ? "✓" : "✗";
    const color = allPassed ? "green" : "red";
    const label = allPassed ? "completed" : "failed";
    store.log(`${icon} Plan "${group}" ${label}`, [
      seg(`${icon} `, color, true),
      seg(group, undefined, true),
      seg(` ${label}`, color),
    ]);
  });

  on("plan:resumed", ({ name, retried, pending }: any) => {
    store.log(`⟳ Resumed: ${name}`, [
      seg("⟳ ", "blue"),
      seg(name, undefined, true),
      seg(` (${retried} retried, ${pending} pending)`, "gray"),
    ]);
  });

  // ─── General log ────────────────────────────────────

  on("log", ({ level, message }: any) => {
    if (level === "error") {
      store.log(message, [seg(message, "red")]);
    } else if (level === "warn") {
      store.log(message, [seg(message, "yellow")]);
    }
  });

  return () => offs.forEach((fn) => fn());
}
