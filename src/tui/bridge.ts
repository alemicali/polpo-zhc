/**
 * Event bridge — wires Orchestrator events to TUI store log entries.
 * Returns a cleanup function to unsubscribe all listeners.
 */

import type { Orchestrator } from "../core/orchestrator.js";
import type { TUIStore } from "./store.js";
import { seg } from "./format.js";

type Off = () => void;

export function bridgeEvents(polpo: Orchestrator, store: TUIStore): Off {
  const offs: Off[] = [];

  const on = (event: string, handler: (...args: any[]) => void) => {
    polpo.on(event as any, handler as any);
    offs.push(() => polpo.off(event as any, handler as any));
  };

  // ─── Agent lifecycle ────────────────────────────────

  on("agent:spawned", ({ agentName, taskTitle }: any) => {
    store.log(`→ ${taskTitle} → ${agentName}`, [
      seg("→ ", "cyan"),
      seg(taskTitle, undefined, true),
      seg(` → ${agentName}`, "gray"),
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

  on("task:done", ({ title, score }: any) => {
    const scoreText = score !== undefined ? ` (${score.toFixed(1)}/5)` : "";
    store.log(`✓ ${title}${scoreText}`, [
      seg("✓ ", "green", true),
      seg(title, undefined, true),
      seg(scoreText, "gray"),
    ]);
  });

  on("task:failed", ({ title }: any) => {
    store.log(`✗ ${title}`, [
      seg("✗ ", "red", true),
      seg(title, undefined, true),
    ]);
  });

  on("task:retry", ({ title, attempt, maxRetries }: any) => {
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
    store.log(`⏱ Timeout: ${taskId}`, [
      seg("⏱ ", "red"),
      seg(taskId, undefined, true),
      seg(" timed out", "gray"),
    ]);
  });

  // ─── Assessment ─────────────────────────────────────

  on("assessment:started", ({ title }: any) => {
    store.log(`⚖ Assessing: ${title}`, [
      seg("⚖ ", "magenta"),
      seg(title, undefined, true),
      seg("...", "gray"),
    ]);
  });

  on("assessment:passed", ({ title, score }: any) => {
    const scoreText = score !== undefined ? ` ${score.toFixed(1)}/5` : "";
    store.log(`✓ Passed: ${title}${scoreText}`, [
      seg("✓ ", "green", true),
      seg(title, undefined, true),
      seg(scoreText, "gray"),
    ]);
  });

  on("assessment:failed", ({ title }: any) => {
    store.log(`✗ Failed: ${title}`, [
      seg("✗ ", "red"),
      seg(title, undefined, true),
    ]);
  });

  on("assessment:autoCorrect", ({ corrections }: any) => {
    store.log(`⚡ Auto-corrected ${corrections} expectation(s)`, [
      seg("⚡ ", "yellow"),
      seg(`${corrections}`, undefined, true),
      seg(" expectation(s) corrected", "gray"),
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
