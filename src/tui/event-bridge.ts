import type { Orchestrator } from "../orchestrator.js";
import type { TUILogger } from "./context.js";

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
    logger.logEvent(`  {blue-fg}▶{/blue-fg} {bold}${taskTitle}{/bold} {grey-fg}→ ${agentName}{/grey-fg}`);
  });

  on("agent:finished", ({ taskId, agentName, exitCode, duration }) => {
    const secs = (duration / 1000).toFixed(1);
    logger.log(`[${taskId}] Agent "${agentName}" finished — exit ${exitCode} (${secs}s)`);
  });

  // ─── Task events ───────────────────────────────────────

  on("task:created", ({ task }) => {
    logger.log(`[${task.id}] Task added: ${task.title}`);
    logger.logEvent(`  {cyan-fg}+{/cyan-fg} ${task.title} {grey-fg}[${task.id}]{/grey-fg}`);
  });

  on("task:transition", ({ taskId, to, task }) => {
    if (to === "done") {
      logger.log(`[${taskId}] DONE — ${task.title}`);
      logger.logEvent(`  {green-fg}✓{/green-fg} {bold}${task.title}{/bold}`);
    }
  });

  // ─── Assessment events ─────────────────────────────────

  on("assessment:complete", ({ taskId, passed, globalScore, message }) => {
    const scoreStr = globalScore !== undefined ? ` (score: ${globalScore.toFixed(1)}/5)` : "";
    const status = passed ? "PASSED" : "FAILED";
    logger.log(`[${taskId}] ${status}${scoreStr} — ${message ?? ""}`);

    if (passed) {
      logger.logEvent(`  {green-fg}✓{/green-fg} {bold}${message ?? ""}{/bold} ${scoreStr ? `{green-fg}${scoreStr}{/green-fg}` : ""}`);
    } else {
      const reason = scoreStr || "";
      logger.logEvent(`  {red-fg}✗{/red-fg} {bold}${message ?? ""}{/bold} ${reason ? `{grey-fg}${reason}{/grey-fg}` : ""}`);
    }
  });

  // ─── Retry events ──────────────────────────────────────

  on("task:retry", ({ taskId, attempt, maxRetries }) => {
    logger.log(`[${taskId}] Retrying (${attempt}/${maxRetries})...`);
    logger.logEvent(`  {yellow-fg}↻{/yellow-fg} Retry ${attempt}/${maxRetries} {grey-fg}[${taskId}]{/grey-fg}`);
  });

  on("task:maxRetries", ({ taskId }) => {
    logger.log(`[${taskId}] Max retries reached`);
    logger.logEvent(`  {red-fg}✗{/red-fg} {grey-fg}Max retries reached [${taskId}]{/grey-fg}`);
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
      logger.logEvent(`  {red-fg}☠{/red-fg} ${agentName} unresponsive (${secs}s idle) — killed {grey-fg}[${taskId}]{/grey-fg}`);
    } else {
      logger.logEvent(`  {yellow-fg}⚠{/yellow-fg} ${agentName} idle for ${secs}s {grey-fg}[${taskId}]{/grey-fg}`);
    }
  });

  // ─── Recovery events ───────────────────────────────────

  on("task:recovered", ({ title, previousStatus }) => {
    logger.log(`Recovered orphaned task: "${title}" (was ${previousStatus})`);
    logger.logEvent(`  {yellow-fg}↻{/yellow-fg} Recovered orphaned: ${title}`);
  });

  // ─── Orchestrator lifecycle ────────────────────────────

  on("orchestrator:started", ({ project, agents }) => {
    logger.log(`Orchestra started — ${project}`);
    logger.log(`Team agents: ${agents.join(", ")}`);
  });

  on("orchestrator:deadlock", () => {
    logger.log("Deadlock detected: tasks have unresolvable dependencies.");
    logger.logEvent(`  {red-fg}⚠{/red-fg} {bold}Deadlock detected{/bold}`);
  });

  on("orchestrator:shutdown", () => {
    logger.log("Orchestra shut down cleanly.");
    logger.logEvent(`  {grey-fg}Orchestra stopped{/grey-fg}`);
  });

  // ─── General log ───────────────────────────────────────

  on("log", ({ level, message }) => {
    if (level === "error") {
      logger.log(`{red-fg}${message}{/red-fg}`);
      logger.logEvent(`{red-fg}${message}{/red-fg}`);
    } else if (level === "warn") {
      logger.log(`{yellow-fg}${message}{/yellow-fg}`);
    } else {
      logger.log(message);
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
