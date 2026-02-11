import type { Orchestrator } from "../core/orchestrator.js";
import type { TUIStore, LogSeg } from "./store.js";

type Store = Pick<TUIStore, "log" | "logAlways" | "logEvent">;

/** Shorthand segment constructors */
const s = (text: string, color?: string, bold?: boolean, dim?: boolean): LogSeg => ({ text, color, bold, dim });

/**
 * Subscribe to typed orchestrator events and route them to the TUI store.
 * Ink version — uses LogSeg[] for colored output in LogPanel.
 *
 * Returns a dispose function to unsubscribe all listeners.
 */
export function bridgeOrchestraEvents(
  orchestrator: Orchestrator,
  store: Store,
): () => void {
  const listeners: Array<{ event: string; fn: (...args: any[]) => void }> = [];

  function on(event: string, fn: (...args: any[]) => void) {
    orchestrator.on(event, fn);
    listeners.push({ event, fn });
  }

  // ─── Agent events ──────────────────────────────────────

  on("agent:spawned", ({ taskId, agentName, taskTitle }) => {
    store.log(`[${taskId}] Spawning "${agentName}" for: ${taskTitle}`);
    store.logEvent(`  ▶ ${taskTitle} → ${agentName}`, [
      s("  "),
      s("▶", "blue"),
      s(` ${taskTitle}`, undefined, true),
      s(` → ${agentName}`, "gray"),
    ]);
  });

  on("agent:finished", ({ taskId, agentName, exitCode, duration }) => {
    const secs = (duration / 1000).toFixed(1);
    store.log(`[${taskId}] Agent "${agentName}" finished — exit ${exitCode} (${secs}s)`);
  });

  // ─── Task events ───────────────────────────────────────

  on("task:created", ({ task }) => {
    store.log(`[${task.id}] Task added: ${task.title}`);
    store.logEvent(`  + ${task.title} [${task.id}]`, [
      s("  "),
      s("+", "cyan"),
      s(` ${task.title}`),
      s(` [${task.id}]`, "gray"),
    ]);
  });

  on("task:transition", ({ taskId, to, task }) => {
    if (to === "done") {
      const duration = task.result?.duration;
      const score = task.result?.assessment?.globalScore;
      const durationStr = duration ? ` ${(duration / 1000).toFixed(1)}s` : "";
      const scoreStr = score !== undefined ? ` (${score.toFixed(1)}/5)` : "";
      store.log(`[${taskId}] DONE — ${task.title}`);
      store.logEvent(`  ✓ ${task.title}${durationStr}${scoreStr}`, [
        s("  "),
        s("✓", "green"),
        s(` ${task.title}`, undefined, true),
        ...(durationStr ? [s(durationStr, "gray")] : []),
        ...(scoreStr ? [s(scoreStr, "gray")] : []),
      ]);
    } else if (to === "failed") {
      store.logEvent(`  ✗ ${task.title} [${taskId}]`, [
        s("  "),
        s("✗", "red"),
        s(` ${task.title}`),
        s(` [${taskId}]`, "gray"),
      ]);
    }
  });

  // ─── Assessment events ─────────────────────────────────

  on("assessment:started", ({ taskId }) => {
    store.log(`[${taskId}] Assessment started`);
    store.logEvent(`  ⚡ Assessing... [${taskId}]`, [
      s("  "),
      s("⚡", "yellow"),
      s(" Assessing...", "gray"),
      s(` [${taskId}]`, "gray"),
    ]);
  });

  on("assessment:progress", ({ taskId, message }) => {
    store.log(`[${taskId}] Review: ${message}`);
    store.logEvent(`    ↳ ${message}`, [
      s("    "),
      s(`↳ ${message}`, "gray"),
    ]);
  });

  on("assessment:corrected", ({ taskId, corrections }: { taskId: string; corrections: number }) => {
    store.log(`[${taskId}] Auto-corrected ${corrections} file path(s), re-assessing`);
    store.logEvent(`  ↻ Auto-corrected ${corrections} path(s) [${taskId}]`, [
      s("  "),
      s("↻", "cyan"),
      s(` Auto-corrected ${corrections} path(s), re-assessing`),
      s(` [${taskId}]`, "gray"),
    ]);
  });

  on("assessment:complete", ({ taskId, passed, globalScore, message }) => {
    const scoreStr = globalScore !== undefined ? ` (score: ${globalScore.toFixed(1)}/5)` : "";
    const status = passed ? "PASSED" : "FAILED";
    store.log(`[${taskId}] ${status}${scoreStr} — ${message ?? ""}`);

    if (passed) {
      store.logEvent(`  ✓ ${message ?? ""}${scoreStr}`, [
        s("  "),
        s("✓", "green"),
        s(` ${message ?? ""}`, undefined, true),
        ...(scoreStr ? [s(scoreStr, "green")] : []),
      ]);
    } else {
      store.logEvent(`  ✗ ${message ?? ""}${scoreStr}`, [
        s("  "),
        s("✗", "red"),
        s(` ${message ?? ""}`, undefined, true),
        ...(scoreStr ? [s(scoreStr, "gray")] : []),
      ]);
    }
  });

  // ─── Retry events ──────────────────────────────────────

  on("task:retry", ({ taskId, attempt, maxRetries }) => {
    store.log(`[${taskId}] Retrying (${attempt}/${maxRetries})...`);
    store.logEvent(`  ↻ Retry ${attempt}/${maxRetries} [${taskId}]`, [
      s("  "),
      s("↻", "yellow"),
      s(` Retry ${attempt}/${maxRetries}`),
      s(` [${taskId}]`, "gray"),
    ]);
  });

  on("task:fix", ({ taskId, attempt, maxFix }) => {
    store.log(`[${taskId}] Fix attempt ${attempt}/${maxFix}`);
    store.logEvent(`  🔧 Fix ${attempt}/${maxFix} [${taskId}]`, [
      s("  "),
      s("🔧", "magenta"),
      s(` Fix ${attempt}/${maxFix}`),
      s(` [${taskId}]`, "gray"),
    ]);
  });

  on("task:maxRetries", ({ taskId }) => {
    store.log(`[${taskId}] Max retries reached`);
    store.logEvent(`  ✗ Max retries reached [${taskId}]`, [
      s("  "),
      s("✗", "red"),
      s(" Max retries reached", "gray"),
      s(` [${taskId}]`, "gray"),
    ]);
  });

  // ─── Question detection events ──────────────────────

  on("task:question", ({ taskId, question }: { taskId: string; question: string }) => {
    store.log(`[${taskId}] Agent asked: ${question.slice(0, 100)}`);
    store.logEvent(`  ? Agent asked a question [${taskId}]`, [
      s("  "),
      s("?", "yellow"),
      s(" Agent asked a question"),
      s(` [${taskId}]`, "gray"),
    ]);
  });

  on("task:answered", ({ taskId, answer }: { taskId: string; question: string; answer: string }) => {
    store.log(`[${taskId}] Auto-answered: ${answer.slice(0, 100)}`);
    store.logEvent(`  → Auto-resolved, re-running [${taskId}]`, [
      s("  "),
      s("→", "cyan"),
      s(" Auto-resolved, re-running"),
      s(` [${taskId}]`, "gray"),
    ]);
  });

  // ─── Resilience events ────────────────────────────────

  on("task:timeout", ({ taskId, elapsed }) => {
    const secs = Math.round(elapsed / 1000);
    store.log(`[${taskId}] Task timed out after ${secs}s`);
    store.logEvent(`  ⏱ Timeout after ${secs}s [${taskId}]`, [
      s("  "),
      s("⏱", "red"),
      s(` Timeout after ${secs}s`),
      s(` [${taskId}]`, "gray"),
    ]);
  });

  on("agent:stale", ({ taskId, agentName, idleMs, action }) => {
    const secs = Math.round(idleMs / 1000);
    if (action === "killed") {
      store.logEvent(`  ☠ ${agentName} unresponsive (${secs}s idle) — killed [${taskId}]`, [
        s("  "),
        s("☠", "red"),
        s(` ${agentName} unresponsive (${secs}s idle) — killed`),
        s(` [${taskId}]`, "gray"),
      ]);
    } else {
      store.logEvent(`  ⚠ ${agentName} idle for ${secs}s [${taskId}]`, [
        s("  "),
        s("⚠", "yellow"),
        s(` ${agentName} idle for ${secs}s`),
        s(` [${taskId}]`, "gray"),
      ]);
    }
  });

  // ─── Recovery events ───────────────────────────────────

  on("task:recovered", ({ title, previousStatus }) => {
    store.log(`Recovered orphaned task: "${title}" (was ${previousStatus})`);
    store.logEvent(`  ↻ Recovered orphaned: ${title}`, [
      s("  "),
      s("↻", "yellow"),
      s(` Recovered orphaned: ${title}`),
    ]);
  });

  // ─── Orchestrator lifecycle ────────────────────────────

  on("orchestrator:started", ({ project, agents }) => {
    store.log(`Polpo started — ${project}`);
    store.log(`Team agents: ${agents.join(", ")}`);
  });

  on("orchestrator:deadlock", () => {
    store.log("Deadlock detected: tasks have unresolvable dependencies.");
    store.logEvent(`  ⚠ Deadlock detected`, [
      s("  "),
      s("⚠", "red"),
      s(" Deadlock detected", undefined, true),
    ]);
  });

  // ─── Deadlock resolution events ──────────────────────

  on("deadlock:detected", ({ taskIds, resolvableCount }: { taskIds: string[]; resolvableCount: number }) => {
    store.log(`Deadlock: ${taskIds.length} blocked, ${resolvableCount} resolvable`);
    store.logEvent(`  ⚡ Deadlock — ${resolvableCount}/${taskIds.length} resolvable`, [
      s("  "),
      s("⚡", "yellow"),
      s(" Deadlock", undefined, true),
      s(` — ${resolvableCount}/${taskIds.length} resolvable`),
    ]);
  });

  on("deadlock:resolving", ({ taskId, failedDepId }: { taskId: string; failedDepId: string }) => {
    store.log(`[${taskId}] Resolving blockage (failed dep: ${failedDepId})`);
    store.logEvent(`  ⟳ Resolving [${taskId} ← ${failedDepId}]`, [
      s("  "),
      s("⟳", "yellow"),
      s(" Resolving"),
      s(` [${taskId} ← ${failedDepId}]`, "gray"),
    ]);
  });

  on("deadlock:resolved", ({ taskId, action, reason }: { taskId: string; failedDepId: string; action: string; reason: string }) => {
    const label = action === "absorb" ? "Absorbed dep" : "Retrying dep";
    store.log(`[${taskId}] ${label}: ${reason}`);
    store.logEvent(`  ↻ ${label} [${taskId}]`, [
      s("  "),
      s("↻", "green"),
      s(` ${label}`),
      s(` [${taskId}]`, "gray"),
    ]);
  });

  on("deadlock:unresolvable", ({ taskId, reason }: { taskId: string; reason: string }) => {
    store.log(`[${taskId}] Unresolvable: ${reason}`);
    store.logEvent(`  ✗ Unresolvable [${taskId}]`, [
      s("  "),
      s("✗", "red"),
      s(" Unresolvable"),
      s(` [${taskId}]`, "gray"),
    ]);
  });

  on("orchestrator:shutdown", () => {
    store.log("Polpo shut down cleanly.");
    store.logEvent(`  Polpo stopped`, [
      s("  Polpo stopped", "gray"),
    ]);
  });

  // ─── Plan completion report ───────────────────────────

  on("plan:completed", ({ group, allPassed, report }) => {
    const statusText = allPassed ? "COMPLETED" : "FAILED";
    const statusColor = allPassed ? "green" : "red";
    const durationSecs = (report.totalDuration / 1000).toFixed(1);
    const scoreStr = report.avgScore !== undefined
      ? ` avg score: ${report.avgScore.toFixed(1)}/5`
      : "";

    store.logAlways("", []);
    store.logAlways(`━━━ Plan ${statusText}: ${group} ━━━${scoreStr}`, [
      s(`━━━ Plan `, undefined, true),
      s(statusText, statusColor, true),
      s(`: ${group} ━━━`, undefined, true),
      ...(scoreStr ? [s(scoreStr, "gray")] : []),
    ]);
    store.logAlways("", []);

    for (const t of report.tasks) {
      const icon = t.status === "done" ? "✓" : "✗";
      const iconColor = t.status === "done" ? "green" : "red";
      const secs = (t.duration / 1000).toFixed(1);
      const tScore = t.score !== undefined ? ` (${t.score.toFixed(1)}/5)` : "";
      store.logAlways(`  ${icon} ${t.title} ${secs}s${tScore}`, [
        s("  "),
        s(icon, iconColor),
        s(` ${t.title}`),
        s(` ${secs}s`, "gray"),
        ...(tScore ? [s(tScore, "gray")] : []),
      ]);
    }

    if (report.filesCreated.length > 0 || report.filesEdited.length > 0) {
      store.logAlways("", []);
      if (report.filesCreated.length > 0) {
        store.logAlways(`  + Created: ${report.filesCreated.length} file(s)`, [
          s("  "),
          s("+", "green"),
          s(" Created: ", undefined, true),
          s(`${report.filesCreated.length}`, undefined, true),
          s(" file(s)"),
        ]);
        for (const f of report.filesCreated.slice(0, 10)) {
          store.logAlways(`    + ${f}`, [s("    "), s("+", "green"), s(` ${f}`, "gray")]);
        }
        if (report.filesCreated.length > 10) {
          store.logAlways(`    ... and ${report.filesCreated.length - 10} more`, [
            s(`    ... and ${report.filesCreated.length - 10} more`, "gray"),
          ]);
        }
      }
      if (report.filesEdited.length > 0) {
        store.logAlways(`  ~ Edited: ${report.filesEdited.length} file(s)`, [
          s("  "),
          s("~", "yellow"),
          s(" Edited: ", undefined, true),
          s(`${report.filesEdited.length}`, undefined, true),
          s(" file(s)"),
        ]);
        for (const f of report.filesEdited.slice(0, 10)) {
          store.logAlways(`    ~ ${f}`, [s("    "), s("~", "yellow"), s(` ${f}`, "gray")]);
        }
        if (report.filesEdited.length > 10) {
          store.logAlways(`    ... and ${report.filesEdited.length - 10} more`, [
            s(`    ... and ${report.filesEdited.length - 10} more`, "gray"),
          ]);
        }
      }
    }

    const passed = report.tasks.filter((t: { status: string }) => t.status === "done").length;
    const failed = report.tasks.filter((t: { status: string }) => t.status === "failed").length;
    store.logAlways("", []);
    store.logAlways(`  ${passed} passed, ${failed} failed — total ${durationSecs}s`, [
      s("  "),
      s(`${passed}`, undefined, true),
      s(" passed, "),
      s(`${failed}`, undefined, true),
      s(` failed — total `),
      s(`${durationSecs}s`, undefined, true),
    ]);
    store.logAlways(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, [
      s("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", undefined, true),
    ]);
    store.logAlways("", []);
  });

  // ─── General log ───────────────────────────────────────

  on("log", ({ level, message }) => {
    if (level === "error") {
      store.log(`ERROR: ${message}`);
      store.logEvent(`ERROR: ${message}`, [s(`ERROR: ${message}`, "red")]);
    } else if (level === "warn") {
      store.log(`WARN: ${message}`);
    } else {
      store.log(message);
    }
  });

  // ─── Dispose ───────────────────────────────────────────

  return () => {
    for (const { event, fn } of listeners) {
      orchestrator.off(event, fn);
    }
    listeners.length = 0;
  };
}
