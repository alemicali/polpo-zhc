import type { NotificationSeverity } from "../core/types.js";

/**
 * Default notification templates — generates human-readable title + body
 * for each event type. Can be overridden per-rule via template field.
 */

const SEVERITY_EMOJI: Record<NotificationSeverity, string> = {
  info: "ℹ️",
  warning: "⚠️",
  critical: "🚨",
};

interface TemplateContext {
  event: string;
  data: unknown;
  severity: NotificationSeverity;
}

/** Get a typed field from the data payload. */
function field(data: unknown, key: string): unknown {
  if (typeof data !== "object" || data === null) return undefined;
  return (data as Record<string, unknown>)[key];
}

function str(data: unknown, key: string): string {
  const v = field(data, key);
  return typeof v === "string" ? v : String(v ?? "");
}

function num(data: unknown, key: string): number {
  const v = field(data, key);
  return typeof v === "number" ? v : 0;
}

function numFixed(data: unknown, key: string, decimals = 1): string {
  const v = field(data, key);
  return typeof v === "number" ? v.toFixed(decimals) : "N/A";
}

function bool(data: unknown, key: string): boolean {
  return field(data, key) === true;
}

/**
 * Generate a default title for a notification.
 */
export function defaultTitle(ctx: TemplateContext): string {
  const emoji = SEVERITY_EMOJI[ctx.severity];
  const { event, data } = ctx;

  switch (event) {
    case "task:created":
      return `${emoji} Task Created: ${str(field(data, "task"), "title")}`;
    case "task:transition":
      return `${emoji} Task ${str(data, "from")} → ${str(data, "to")}`;
    case "task:retry":
      return `${emoji} Task Retry (${num(data, "attempt")}/${num(data, "maxRetries")})`;
    case "task:fix":
      return `${emoji} Task Fix Attempt (${num(data, "attempt")}/${num(data, "maxFix")})`;
    case "task:maxRetries":
      return `${emoji} Task Exhausted All Retries`;
    case "task:timeout":
      return `${emoji} Task Timed Out`;
    case "task:question":
      return `${emoji} Agent Asked a Question`;
    case "task:answered":
      return `${emoji} Question Auto-Answered`;
    case "task:recovered":
      return `${emoji} Task Recovered from Crash`;

    case "agent:spawned":
      return `${emoji} Agent Spawned: ${str(data, "agentName")}`;
    case "agent:finished":
      return `${emoji} Agent Finished: ${str(data, "agentName")} (exit: ${num(data, "exitCode")})`;
    case "agent:stale":
      return `${emoji} Agent Stale: ${str(data, "agentName")} (${str(data, "action")})`;

    case "assessment:complete":
      return `${emoji} Assessment ${bool(data, "passed") ? "PASSED" : "FAILED"}`;

    case "plan:saved":
      return `${emoji} Plan Saved: ${str(data, "name")}`;
    case "plan:executed":
      return `${emoji} Plan Executing: ${num(data, "taskCount")} tasks`;
    case "plan:completed":
      return `${emoji} Plan ${bool(data, "allPassed") ? "Completed" : "Failed"}`;
    case "plan:resumed":
      return `${emoji} Plan Resumed`;
    case "plan:deleted":
      return `${emoji} Plan Deleted`;

    case "approval:requested":
      return `${emoji} Approval Required: ${str(data, "gateName")}`;
    case "approval:resolved":
      return `${emoji} Approval ${str(data, "status")}`;
    case "approval:timeout":
      return `${emoji} Approval Timed Out (action: ${str(data, "action")})`;

    case "escalation:triggered":
      return `${emoji} Escalation Level ${num(data, "level")}: ${str(data, "handler")}`;
    case "escalation:human":
      return `${emoji} Human Intervention Required`;

    case "deadlock:detected":
      return `${emoji} Deadlock Detected`;
    case "deadlock:resolved":
      return `${emoji} Deadlock Resolved`;

    // SLA & Deadlines
    case "sla:warning":
      return `${emoji} SLA Warning: ${str(data, "entityType")} ${str(data, "entityId")} at ${Math.round(num(data, "percentUsed") * 100)}% of deadline`;
    case "sla:violated":
      return `${emoji} SLA Violated: ${str(data, "entityType")} ${str(data, "entityId")} is overdue`;
    case "sla:met":
      return `${emoji} SLA Met: ${str(data, "entityType")} ${str(data, "entityId")} completed on time`;

    // Quality gates
    case "quality:gate:passed":
      return `${emoji} Quality Gate Passed: ${str(data, "gateName")}`;
    case "quality:gate:failed":
      return `${emoji} Quality Gate Failed: ${str(data, "gateName")}`;
    case "quality:threshold:failed":
      return `${emoji} Plan Quality Below Threshold: ${numFixed(data, "avgScore")}/${numFixed(data, "threshold")}`;

    // Scheduling
    case "schedule:triggered":
      return `${emoji} Schedule Triggered: plan ${str(data, "planId")}`;
    case "schedule:created":
      return `${emoji} Schedule Created: plan ${str(data, "planId")}`;
    case "schedule:completed":
      return `${emoji} Schedule Completed: plan ${str(data, "planId")}`;

    default:
      return `${emoji} ${event}`;
  }
}

/**
 * Generate a default body for a notification.
 */
export function defaultBody(ctx: TemplateContext): string {
  const { event, data } = ctx;
  const lines: string[] = [];

  switch (event) {
    case "task:maxRetries":
      lines.push(`Task **${str(data, "taskId")}** has exhausted all retries and is now failed.`);
      break;
    case "task:timeout":
      lines.push(`Task **${str(data, "taskId")}** timed out after ${Math.round(num(data, "elapsed") / 1000)}s (limit: ${Math.round(num(data, "timeout") / 1000)}s).`);
      break;
    case "agent:stale":
      lines.push(`Agent **${str(data, "agentName")}** on task **${str(data, "taskId")}** has been idle for ${Math.round(num(data, "idleMs") / 1000)}s.`);
      lines.push(`Action: **${str(data, "action")}**`);
      break;
    case "plan:completed": {
      const report = field(data, "report") as Record<string, unknown> | undefined;
      lines.push(`Plan **${str(data, "group")}** has ${bool(data, "allPassed") ? "completed successfully" : "failed"}.`);
      if (report) {
        lines.push(`Tasks: ${(report.tasks as unknown[])?.length ?? 0}`);
        if (typeof report.avgScore === "number") {
          lines.push(`Average score: ${report.avgScore.toFixed(1)}/5`);
        }
      }
      break;
    }
    case "approval:requested":
      lines.push(`Gate **${str(data, "gateName")}** requires approval.`);
      if (str(data, "taskId")) lines.push(`Task: ${str(data, "taskId")}`);
      if (str(data, "planId")) lines.push(`Plan: ${str(data, "planId")}`);
      break;
    case "escalation:human":
      lines.push(str(data, "message"));
      break;

    // SLA & Deadlines
    case "sla:warning": {
      const pct = Math.round(num(data, "percentUsed") * 100);
      const remainSec = Math.round(num(data, "remaining") / 1000);
      lines.push(`${str(data, "entityType")} **${str(data, "entityId")}** has used ${pct}% of its deadline budget.`);
      lines.push(`Remaining: ${remainSec}s`);
      lines.push(`Deadline: ${str(data, "deadline")}`);
      break;
    }
    case "sla:violated":
      lines.push(`${str(data, "entityType")} **${str(data, "entityId")}** has exceeded its deadline.`);
      lines.push(`Overdue by: ${Math.round(num(data, "overdueMs") / 1000)}s`);
      lines.push(`Deadline was: ${str(data, "deadline")}`);
      break;
    case "sla:met": {
      const marginSec = Math.round(num(data, "marginMs") / 1000);
      lines.push(`${str(data, "entityType")} **${str(data, "entityId")}** completed before its deadline.`);
      lines.push(`Margin: ${marginSec}s remaining`);
      break;
    }

    // Quality gates
    case "quality:gate:passed":
      lines.push(`Quality gate **${str(data, "gateName")}** passed for plan **${str(data, "planId")}**.`);
      if (num(data, "avgScore") > 0) lines.push(`Average score: ${numFixed(data, "avgScore")}/5`);
      break;
    case "quality:gate:failed":
      lines.push(`Quality gate **${str(data, "gateName")}** failed for plan **${str(data, "planId")}**.`);
      lines.push(`Reason: ${str(data, "reason")}`);
      if (num(data, "avgScore") > 0) lines.push(`Average score: ${numFixed(data, "avgScore")}/5`);
      break;
    case "quality:threshold:failed":
      lines.push(`Plan **${str(data, "planId")}** did not meet its quality threshold.`);
      lines.push(`Score: ${numFixed(data, "avgScore")}/5 (required: ${numFixed(data, "threshold")})`);
      break;

    // Scheduling
    case "schedule:triggered":
      lines.push(`Scheduled execution of plan **${str(data, "planId")}** has been triggered.`);
      lines.push(`Expression: \`${str(data, "expression")}\``);
      break;
    case "schedule:created":
      lines.push(`Schedule created for plan **${str(data, "planId")}**.`);
      if (str(data, "nextRunAt")) lines.push(`Next run: ${str(data, "nextRunAt")}`);
      break;
    case "schedule:completed":
      lines.push(`Scheduled execution of plan **${str(data, "planId")}** has completed.`);
      break;

    default:
      // Generic: dump key fields
      if (typeof data === "object" && data !== null) {
        for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
          if (v !== undefined && v !== null && typeof v !== "object") {
            lines.push(`**${k}**: ${String(v)}`);
          }
        }
      }
  }

  return lines.join("\n");
}

/**
 * Apply a user-defined template string.
 * Simple {{variable}} replacement from the data payload.
 */
export function applyTemplate(template: string, data: unknown): string {
  if (typeof data !== "object" || data === null) return template;
  const record = data as Record<string, unknown>;

  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, path: string) => {
    const parts = path.split(".");
    let current: unknown = record;
    for (const part of parts) {
      if (typeof current !== "object" || current === null) return "";
      current = (current as Record<string, unknown>)[part];
    }
    return current !== undefined && current !== null ? String(current) : "";
  });
}
