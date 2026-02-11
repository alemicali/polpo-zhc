import type { Orchestrator } from "../orchestrator.js";
import type { TUILogger } from "./context.js";
import { esc } from "./formatters.js";

/**
 * Subscribe to typed orchestrator events and route them to the TUI logger.
 * Replaces the console.log monkey-patch + emitEvent() regex parser.
 *
 * Returns a dispose function to unsubscribe all listeners.
 */
export function bridgeOrchestraEvents(
  orchestrator: Orchestrator,
  logger: TUILogger,
): () => void {
  const listeners: Array<{ event: string; fn: (...args: any[]) => void }> = [];

  function on(event: string, fn: (...args: any[]) => void) {
    orchestrator.on(event, fn);
    listeners.push({ event, fn });
  }

  // ─── Agent events ──────────────────────────────────────

  on("agent:spawned", ({ taskId, agentName, taskTitle }) => {
    logger.log(`[${taskId}] Spawning "${agentName}" for: ${taskTitle}`);
    logger.logEvent(`  {blue-fg}▶{/blue-fg} {bold}${esc(taskTitle)}{/bold} {grey-fg}→ ${esc(agentName)}{/grey-fg}`);
  });

  on("agent:finished", ({ taskId, agentName, exitCode, duration }) => {
    const secs = (duration / 1000).toFixed(1);
    logger.log(`[${taskId}] Agent "${agentName}" finished — exit ${exitCode} (${secs}s)`);
  });

  // ─── Task events ───────────────────────────────────────

  on("task:created", ({ task }) => {
    logger.log(`[${task.id}] Task added: ${task.title}`);
    logger.logEvent(`  {cyan-fg}+{/cyan-fg} ${esc(task.title)} {grey-fg}[${task.id}]{/grey-fg}`);
  });

  on("task:transition", ({ taskId, to, task }) => {
    if (to === "done") {
      const duration = task.result?.duration;
      const score = task.result?.assessment?.globalScore;
      const durationStr = duration ? ` {grey-fg}${(duration / 1000).toFixed(1)}s{/grey-fg}` : "";
      const scoreStr = score !== undefined ? ` {grey-fg}(${score.toFixed(1)}/5){/grey-fg}` : "";
      logger.log(`[${taskId}] DONE — ${task.title}`);
      logger.logEvent(`  {green-fg}✓{/green-fg} {bold}${esc(task.title)}{/bold}${durationStr}${scoreStr}`);
    } else if (to === "failed") {
      logger.logEvent(`  {red-fg}✗{/red-fg} ${esc(task.title)} {grey-fg}[${taskId}]{/grey-fg}`);
    }
  });

  // ─── Assessment events ─────────────────────────────────

  on("assessment:started", ({ taskId }) => {
    logger.log(`[${taskId}] Assessment started`);
    logger.logEvent(`  {yellow-fg}⚡{/yellow-fg} {grey-fg}Assessing...{/grey-fg} {grey-fg}[${taskId}]{/grey-fg}`);
  });

  on("assessment:progress", ({ taskId, message }) => {
    logger.log(`[${taskId}] Review: ${message}`);
    logger.logEvent(`  {grey-fg}  ↳ ${esc(message)}{/grey-fg}`);
  });

  on("assessment:corrected", ({ taskId, corrections }: { taskId: string; corrections: number }) => {
    logger.log(`[${taskId}] Auto-corrected ${corrections} file path(s), re-assessing`);
    logger.logEvent(`  {cyan-fg}↻{/cyan-fg} Auto-corrected ${corrections} path(s), re-assessing {grey-fg}[${taskId}]{/grey-fg}`);
  });

  on("assessment:complete", ({ taskId, passed, globalScore, message }) => {
    const scoreStr = globalScore !== undefined ? ` (score: ${globalScore.toFixed(1)}/5)` : "";
    const status = passed ? "PASSED" : "FAILED";
    logger.log(`[${taskId}] ${status}${scoreStr} — ${message ?? ""}`);

    if (passed) {
      logger.logEvent(`  {green-fg}✓{/green-fg} {bold}${esc(message ?? "")}{/bold} ${scoreStr ? `{green-fg}${scoreStr}{/green-fg}` : ""}`);
    } else {
      const reason = scoreStr || "";
      logger.logEvent(`  {red-fg}✗{/red-fg} {bold}${esc(message ?? "")}{/bold} ${reason ? `{grey-fg}${reason}{/grey-fg}` : ""}`);
    }
  });

  // ─── Retry events ──────────────────────────────────────

  on("task:retry", ({ taskId, attempt, maxRetries }) => {
    logger.log(`[${taskId}] Retrying (${attempt}/${maxRetries})...`);
    logger.logEvent(`  {yellow-fg}↻{/yellow-fg} Retry ${attempt}/${maxRetries} {grey-fg}[${taskId}]{/grey-fg}`);
  });

  on("task:fix", ({ taskId, attempt, maxFix }) => {
    logger.log(`[${taskId}] Fix attempt ${attempt}/${maxFix}`);
    logger.logEvent(`  {magenta-fg}🔧{/magenta-fg} Fix ${attempt}/${maxFix} {grey-fg}[${taskId}]{/grey-fg}`);
  });

  on("task:maxRetries", ({ taskId }) => {
    logger.log(`[${taskId}] Max retries reached`);
    logger.logEvent(`  {red-fg}✗{/red-fg} {grey-fg}Max retries reached [${taskId}]{/grey-fg}`);
  });

  // ─── Question detection events ──────────────────────

  on("task:question", ({ taskId, question }: { taskId: string; question: string }) => {
    logger.log(`[${taskId}] Agent asked: ${question.slice(0, 100)}`);
    logger.logEvent(`  {yellow-fg}?{/yellow-fg} Agent asked a question {grey-fg}[${taskId}]{/grey-fg}`);
  });

  on("task:answered", ({ taskId, answer }: { taskId: string; question: string; answer: string }) => {
    logger.log(`[${taskId}] Auto-answered: ${answer.slice(0, 100)}`);
    logger.logEvent(`  {cyan-fg}→{/cyan-fg} Auto-resolved, re-running {grey-fg}[${taskId}]{/grey-fg}`);
  });

  // ─── Resilience events ────────────────────────────────

  on("task:timeout", ({ taskId, elapsed }) => {
    const secs = Math.round(elapsed / 1000);
    logger.log(`[${taskId}] Task timed out after ${secs}s`);
    logger.logEvent(`  {red-fg}⏱{/red-fg} Timeout after ${secs}s {grey-fg}[${taskId}]{/grey-fg}`);
  });

  on("agent:stale", ({ taskId, agentName, idleMs, action }) => {
    const secs = Math.round(idleMs / 1000);
    if (action === "killed") {
      logger.logEvent(`  {red-fg}☠{/red-fg} ${esc(agentName)} unresponsive (${secs}s idle) — killed {grey-fg}[${taskId}]{/grey-fg}`);
    } else {
      logger.logEvent(`  {yellow-fg}⚠{/yellow-fg} ${esc(agentName)} idle for ${secs}s {grey-fg}[${taskId}]{/grey-fg}`);
    }
  });

  // ─── Recovery events ───────────────────────────────────

  on("task:recovered", ({ title, previousStatus }) => {
    logger.log(`Recovered orphaned task: "${title}" (was ${previousStatus})`);
    logger.logEvent(`  {yellow-fg}↻{/yellow-fg} Recovered orphaned: ${esc(title)}`);
  });

  // ─── Orchestrator lifecycle ────────────────────────────

  on("orchestrator:started", ({ project, agents }) => {
    logger.log(`Polpo started — ${project}`);
    logger.log(`Team agents: ${agents.join(", ")}`);
  });

  on("orchestrator:deadlock", () => {
    logger.log("Deadlock detected: tasks have unresolvable dependencies.");
    logger.logEvent(`  {red-fg}⚠{/red-fg} {bold}Deadlock detected{/bold}`);
  });

  // ─── Deadlock resolution events ──────────────────────

  on("deadlock:detected", ({ taskIds, resolvableCount }: { taskIds: string[]; resolvableCount: number }) => {
    logger.log(`Deadlock: ${taskIds.length} blocked, ${resolvableCount} resolvable`);
    logger.logEvent(`  {yellow-fg}⚡{/yellow-fg} {bold}Deadlock{/bold} — ${resolvableCount}/${taskIds.length} resolvable`);
  });

  on("deadlock:resolving", ({ taskId, failedDepId }: { taskId: string; failedDepId: string }) => {
    logger.log(`[${taskId}] Resolving blockage (failed dep: ${failedDepId})`);
    logger.logEvent(`  {yellow-fg}⟳{/yellow-fg} Resolving {grey-fg}[${taskId} ← ${failedDepId}]{/grey-fg}`);
  });

  on("deadlock:resolved", ({ taskId, action, reason }: { taskId: string; failedDepId: string; action: string; reason: string }) => {
    const label = action === "absorb" ? "Absorbed dep" : "Retrying dep";
    logger.log(`[${taskId}] ${label}: ${reason}`);
    logger.logEvent(`  {green-fg}↻{/green-fg} ${label} {grey-fg}[${taskId}]{/grey-fg}`);
  });

  on("deadlock:unresolvable", ({ taskId, reason }: { taskId: string; reason: string }) => {
    logger.log(`[${taskId}] Unresolvable: ${reason}`);
    logger.logEvent(`  {red-fg}✗{/red-fg} Unresolvable {grey-fg}[${taskId}]{/grey-fg}`);
  });

  on("orchestrator:shutdown", () => {
    logger.log("Polpo shut down cleanly.");
    logger.logEvent(`  {grey-fg}Polpo stopped{/grey-fg}`);
  });

  // ─── Plan completion report ───────────────────────────

  on("plan:completed", ({ group, allPassed, report }) => {
    const status = allPassed
      ? "{green-fg}COMPLETED{/green-fg}"
      : "{red-fg}FAILED{/red-fg}";
    const durationSecs = (report.totalDuration / 1000).toFixed(1);
    const scoreStr = report.avgScore !== undefined
      ? ` {grey-fg}avg score: ${report.avgScore.toFixed(1)}/5{/grey-fg}`
      : "";

    logger.logAlways("");
    logger.logAlways(`{bold}━━━ Plan ${status}: ${esc(group)} ━━━{/bold}${scoreStr}`);
    logger.logAlways("");

    // Per-task summary
    for (const t of report.tasks) {
      const icon = t.status === "done" ? "{green-fg}✓{/green-fg}" : "{red-fg}✗{/red-fg}";
      const secs = (t.duration / 1000).toFixed(1);
      const tScore = t.score !== undefined ? ` {grey-fg}(${t.score.toFixed(1)}/5){/grey-fg}` : "";
      logger.logAlways(`  ${icon} ${esc(t.title)} {grey-fg}${secs}s{/grey-fg}${tScore}`);
    }

    // Files summary
    if (report.filesCreated.length > 0 || report.filesEdited.length > 0) {
      logger.logAlways("");
      if (report.filesCreated.length > 0) {
        logger.logAlways(`  {green-fg}+{/green-fg} Created: {bold}${report.filesCreated.length}{/bold} file(s)`);
        for (const f of report.filesCreated.slice(0, 10)) {
          logger.logAlways(`    {green-fg}+{/green-fg} {grey-fg}${esc(f)}{/grey-fg}`);
        }
        if (report.filesCreated.length > 10) {
          logger.logAlways(`    {grey-fg}... and ${report.filesCreated.length - 10} more{/grey-fg}`);
        }
      }
      if (report.filesEdited.length > 0) {
        logger.logAlways(`  {yellow-fg}~{/yellow-fg} Edited: {bold}${report.filesEdited.length}{/bold} file(s)`);
        for (const f of report.filesEdited.slice(0, 10)) {
          logger.logAlways(`    {yellow-fg}~{/yellow-fg} {grey-fg}${esc(f)}{/grey-fg}`);
        }
        if (report.filesEdited.length > 10) {
          logger.logAlways(`    {grey-fg}... and ${report.filesEdited.length - 10} more{/grey-fg}`);
        }
      }
    }

    // Totals
    const passed = report.tasks.filter((t: { status: string }) => t.status === "done").length;
    const failed = report.tasks.filter((t: { status: string }) => t.status === "failed").length;
    logger.logAlways("");
    logger.logAlways(`  {bold}${passed}{/bold} passed, {bold}${failed}{/bold} failed — total {bold}${durationSecs}s{/bold}`);
    logger.logAlways(`{bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━{/bold}`);
    logger.logAlways("");
  });

  // ─── General log ───────────────────────────────────────

  on("log", ({ level, message }) => {
    const safe = esc(message);
    if (level === "error") {
      logger.log(`{red-fg}${safe}{/red-fg}`);
      logger.logEvent(`{red-fg}${safe}{/red-fg}`);
    } else if (level === "warn") {
      logger.log(`{yellow-fg}${safe}{/yellow-fg}`);
    } else {
      logger.log(safe);
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
