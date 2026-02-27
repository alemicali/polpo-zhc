import chalk from "chalk";
import type { Orchestrator } from "../core/orchestrator.js";
import type { PolpoEvent } from "../core/events.js";
import type { ChatLog } from "./components/chat-log.js";
import { theme, statusIcon, statusColor } from "./theme.js";
import { formatElapsed } from "./format.js";

type Off = () => void;

function taskTitle(polpo: Orchestrator, taskId: string): string {
  const task = polpo.getStore().getTask(taskId);
  return task?.title ?? taskId;
}

/**
 * Bridges Orchestrator events to the pi-tui ChatLog.
 * Returns a cleanup function.
 */
export function bridgeEvents(polpo: Orchestrator, chatLog: ChatLog, requestRender: () => void): Off {
  const handlers: Array<{ event: PolpoEvent; fn: (...args: any[]) => void }> = [];

  const on = (event: PolpoEvent, fn: (...args: any[]) => void) => {
    polpo.on(event, fn);
    handlers.push({ event, fn });
  };

  // Agent lifecycle
  on("agent:spawned", ({ agentName, taskId }: any) => {
    const title = taskTitle(polpo, taskId);
    chatLog.addEvent(theme.info(`▸ Agent ${chalk.bold(agentName)} spawned for "${title}"`));
    requestRender();
  });

  on("agent:finished", ({ agentName, taskId, exitCode, duration }: any) => {
    const title = taskTitle(polpo, taskId);
    const success = exitCode === 0;
    const icon = success ? theme.done("✓") : theme.failed("✗");
    const dur = duration !== undefined ? ` (${(duration / 1000).toFixed(1)}s)` : "";
    chatLog.addEvent(`${icon} Agent ${chalk.bold(agentName)} finished "${title}"${dur}`);
    requestRender();
  });

  on("agent:stale", ({ agentName, taskId }: any) => {
    const title = taskTitle(polpo, taskId);
    chatLog.addEvent(theme.warning(`⚠ Agent ${chalk.bold(agentName)} stale on "${title}"`));
    requestRender();
  });

  on("agent:activity", ({ taskId, agentName, tool, file }: any) => {
    // Activity updates are consumed by TaskPanel via syncState polling.
    // Only surface notable tool calls in the log.
    if (tool) {
      const title = taskTitle(polpo, taskId);
      chatLog.addEvent(theme.dim(`  ${agentName}: ${tool}${file ? ` → ${file}` : ""}`));
      requestRender();
    }
  });

  // Task lifecycle
  on("task:created", ({ task }: any) => {
    chatLog.addEvent(theme.info(`+ Task created: "${task.title}"`));
    requestRender();
  });

  on("task:transition", ({ taskId, from, to }: any) => {
    const title = taskTitle(polpo, taskId);
    const fromColor = statusColor(from);
    const toColor = statusColor(to);
    const toIcon = statusIcon(to);
    chatLog.addEvent(
      `${toColor(toIcon)} "${title}" ${fromColor(from)} → ${toColor(to)}`
    );
    requestRender();
  });

  on("task:retry", ({ taskId, attempt, maxRetries }: any) => {
    const title = taskTitle(polpo, taskId);
    chatLog.addEvent(theme.warning(`↻ Retrying "${title}" (${attempt}/${maxRetries})`));
    requestRender();
  });

  on("task:recovered", ({ taskId }: any) => {
    const title = taskTitle(polpo, taskId);
    chatLog.addEvent(theme.info(`⟳ Recovered orphan: "${title}"`));
    requestRender();
  });

  on("task:timeout", ({ taskId }: any) => {
    const title = taskTitle(polpo, taskId);
    chatLog.addEvent(theme.error(`⏱ Task timed out: "${title}"`));
    requestRender();
  });

  on("task:fix", ({ taskId, attempt, maxFix }: any) => {
    const title = taskTitle(polpo, taskId);
    chatLog.addEvent(theme.warning(`⚡ Auto-fix "${title}" (${attempt}/${maxFix})`));
    requestRender();
  });

  on("task:maxRetries", ({ taskId }: any) => {
    const title = taskTitle(polpo, taskId);
    chatLog.addEvent(theme.error(`✗ Max retries reached: "${title}"`));
    requestRender();
  });

  on("task:question", ({ taskId, question }: any) => {
    const title = taskTitle(polpo, taskId);
    chatLog.addEvent(theme.warning(`? Agent question on "${title}": ${question}`));
    requestRender();
  });

  // Assessment
  on("assessment:started", ({ taskId }: any) => {
    const title = taskTitle(polpo, taskId);
    chatLog.addEvent(theme.dim(`⊕ Assessing "${title}"…`));
    requestRender();
  });

  on("assessment:progress", ({ taskId, message }: any) => {
    const title = taskTitle(polpo, taskId);
    chatLog.addEvent(theme.dim(`  ⊕ ${message} "${title}"`));
    requestRender();
  });

  on("assessment:complete", ({ taskId, passed, globalScore }: any) => {
    const title = taskTitle(polpo, taskId);
    const scoreStr = globalScore !== undefined ? ` (${globalScore}/5)` : "";
    const result = passed
      ? theme.done(`✓ Passed${scoreStr}`)
      : theme.failed(`✗ Failed${scoreStr}`);
    chatLog.addEvent(`${result} Assessment "${title}"`);
    requestRender();
  });

  on("assessment:corrected", ({ taskId, corrections }: any) => {
    const title = taskTitle(polpo, taskId);
    const countStr = corrections > 0 ? ` (${corrections} correction${corrections > 1 ? "s" : ""})` : "";
    chatLog.addEvent(theme.info(`⊕ Corrected "${title}"${countStr}`));
    requestRender();
  });

  // Deadlock
  on("deadlock:detected", ({ taskIds, resolvableCount }: any) => {
    const names = (taskIds as string[]).map(id => taskTitle(polpo, id)).join(", ");
    const resolvable = resolvableCount > 0 ? ` (${resolvableCount} resolvable)` : " (unresolvable)";
    chatLog.addEvent(theme.error(`⚠ Deadlock detected: ${names}${resolvable}`));
    requestRender();
  });

  on("deadlock:resolved", ({ taskId, failedDepId, action, reason }: any) => {
    const title = taskTitle(polpo, taskId);
    chatLog.addEvent(theme.done(`✓ Deadlock resolved: "${title}" — ${action} dep ${failedDepId} (${reason})`));
    requestRender();
  });

  on("deadlock:unresolvable", ({ taskId, reason }: any) => {
    const title = taskTitle(polpo, taskId);
    chatLog.addEvent(theme.error(`✗ Deadlock unresolvable: "${title}" — ${reason}`));
    requestRender();
  });

  // Missions
  on("mission:executed", ({ group, taskCount }: any) => {
    const countStr = taskCount ? ` (${taskCount} tasks)` : "";
    chatLog.addEvent(theme.info(`▸ Mission executed: ${group}${countStr}`));
    requestRender();
  });

  on("mission:completed", ({ group, allPassed }: any) => {
    const icon = allPassed ? theme.done("✓") : theme.warning("⚠");
    const label = allPassed ? "completed" : "completed with failures";
    chatLog.addEvent(`${icon} Mission ${label}: ${group}`);
    requestRender();
  });

  on("mission:resumed", ({ name, retried, pending }: any) => {
    const parts: string[] = [];
    if (retried) parts.push(`${retried} retried`);
    if (pending) parts.push(`${pending} pending`);
    const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
    chatLog.addEvent(theme.info(`↻ Mission resumed: ${name}${detail}`));
    requestRender();
  });

  // Approval gates
  on("approval:requested", ({ gateName, taskId }: any) => {
    const title = taskId ? taskTitle(polpo, taskId) : gateName;
    chatLog.addEvent(theme.warning(`⏳ Approval required: "${title}"`));
    requestRender();
  });

  // Escalation
  on("escalation:human", ({ taskId, message: msg }: any) => {
    const title = taskTitle(polpo, taskId);
    chatLog.addEvent(theme.error(`🔺 Human escalation: "${title}" — ${msg}`));
    requestRender();
  });

  // SLA monitoring
  on("sla:warning", ({ entityId, entityType, percentUsed }: any) => {
    chatLog.addEvent(theme.warning(`⏰ SLA warning: ${entityType} ${entityId} (${Math.round(percentUsed)}% of deadline used)`));
    requestRender();
  });

  on("sla:violated", ({ entityId, entityType }: any) => {
    chatLog.addEvent(theme.error(`⏰ SLA violated: ${entityType} ${entityId}`));
    requestRender();
  });

  // Quality gates
  on("quality:gate:passed", ({ missionId, gateName, avgScore }: any) => {
    const scoreStr = avgScore !== undefined ? ` (avg ${avgScore.toFixed(1)})` : "";
    chatLog.addEvent(theme.done(`✓ Quality gate "${gateName}" passed${scoreStr}`));
    requestRender();
  });

  on("quality:gate:failed", ({ missionId, gateName, reason }: any) => {
    chatLog.addEvent(theme.error(`✗ Quality gate "${gateName}" failed: ${reason}`));
    requestRender();
  });

  // Scheduling
  on("schedule:triggered", ({ missionId, expression }: any) => {
    chatLog.addEvent(theme.info(`⏲ Schedule triggered for mission ${missionId} (${expression})`));
    requestRender();
  });

  // Task removal
  on("task:removed", ({ taskId }: any) => {
    chatLog.addEvent(theme.dim(`- Task removed: ${taskId}`));
    requestRender();
  });

  // Question auto-answer
  on("task:answered", ({ taskId, question, answer }: any) => {
    const title = taskTitle(polpo, taskId);
    chatLog.addEvent(theme.info(`A "${title}": ${answer}`));
    requestRender();
  });

  // Approval resolution
  on("approval:resolved", ({ requestId, status: resolvedStatus }: any) => {
    const icon = resolvedStatus === "approved" ? theme.done("✓") : theme.failed("✗");
    chatLog.addEvent(`${icon} Approval ${resolvedStatus}: ${requestId}`);
    requestRender();
  });

  on("approval:timeout", ({ requestId, action }: any) => {
    chatLog.addEvent(theme.warning(`⏱ Approval timeout → ${action}: ${requestId}`));
    requestRender();
  });

  // Config reload
  on("config:reloaded", () => {
    chatLog.addEvent(theme.info(`↻ Configuration reloaded`));
    requestRender();
  });

  // Notification failures
  on("notification:failed", ({ channel, error }: any) => {
    chatLog.addEvent(theme.error(`✗ Notification failed (${channel}): ${error}`));
    requestRender();
  });

  // Orchestrator lifecycle
  on("orchestrator:started", () => {
    // TaskPanel needs this — but we don't have direct access. Emit via requestRender hint.
    chatLog.addEvent(theme.info("▸ Orchestrator started"));
    requestRender();
  });

  // General log
  on("log", ({ level, message }: any) => {
    if (level === "error") {
      chatLog.addEvent(theme.error(`✗ ${message}`));
    } else if (level === "warn") {
      chatLog.addEvent(theme.warning(`⚠ ${message}`));
    }
    requestRender();
  });

  return () => {
    for (const { event, fn } of handlers) {
      polpo.off(event, fn);
    }
  };
}
