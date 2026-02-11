import type { TaskStatus, PlanStatus, SSEEvent } from "@orchestra/react";

export const ORCHESTRA_URL = process.env.NEXT_PUBLIC_ORCHESTRA_URL ?? "http://localhost:3000";
export const PROJECT_ID = process.env.NEXT_PUBLIC_PROJECT_ID ?? "default";
export const API_KEY = process.env.NEXT_PUBLIC_ORCHESTRA_API_KEY;

export const STATUS_COLORS: Record<TaskStatus, string> = {
  pending: "text-status-pending bg-status-pending/10 border-status-pending/30",
  assigned: "text-status-assigned bg-status-assigned/10 border-status-assigned/30",
  in_progress: "text-status-running bg-status-running/10 border-status-running/30",
  review: "text-status-review bg-status-review/10 border-status-review/30",
  done: "text-status-done bg-status-done/10 border-status-done/30",
  failed: "text-status-failed bg-status-failed/10 border-status-failed/30",
};

export const STATUS_DOT_COLORS: Record<TaskStatus, string> = {
  pending: "bg-status-pending",
  assigned: "bg-status-assigned",
  in_progress: "bg-status-running",
  review: "bg-status-review",
  done: "bg-status-done",
  failed: "bg-status-failed",
};

export const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: "Pending",
  assigned: "Assigned",
  in_progress: "Running",
  review: "Review",
  done: "Done",
  failed: "Failed",
};

export const PLAN_STATUS_COLORS: Record<PlanStatus, string> = {
  draft: "text-blue-400 bg-blue-400/10",
  active: "text-status-running bg-status-running/10",
  completed: "text-status-done bg-status-done/10",
  failed: "text-status-failed bg-status-failed/10",
  cancelled: "text-muted-foreground bg-muted",
};

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = Math.floor(secs % 60);
  return `${mins}m ${remainSecs}s`;
}

export function formatScore(score: number | undefined): string {
  if (score === undefined) return "—";
  return `${score.toFixed(1)}/5`;
}

export function formatTimeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  if (diff < 1000) return "just now";
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

// ── Event categorization helpers ──

export type EventCategory = "task" | "agent" | "assessment" | "plan" | "system";
export type EventSeverity = "error" | "warning" | "info";

export function getEventCategory(event: string): EventCategory {
  if (event.startsWith("task:")) return "task";
  if (event.startsWith("agent:")) return "agent";
  if (event.startsWith("assessment:")) return "assessment";
  if (event.startsWith("plan:")) return "plan";
  return "system";
}

export const EVENT_CATEGORY_COLORS: Record<EventCategory, string> = {
  task: "text-cyan-400 bg-cyan-400/10 border-cyan-400/30",
  agent: "text-blue-400 bg-blue-400/10 border-blue-400/30",
  assessment: "text-yellow-400 bg-yellow-400/10 border-yellow-400/30",
  plan: "text-purple-400 bg-purple-400/10 border-purple-400/30",
  system: "text-muted-foreground bg-muted border-border",
};

const ERROR_EVENTS = new Set([
  "deadlock:detected", "deadlock:resolved", "deadlock:failed",
  "task:timeout", "task:removed",
]);
const WARNING_EVENTS = new Set([
  "agent:stale", "task:retry", "task:question",
]);

export function getEventSeverity(event: string): EventSeverity {
  if (ERROR_EVENTS.has(event)) return "error";
  if (WARNING_EVENTS.has(event)) return "warning";
  // task:transition to failed is also an error
  return "info";
}

export const SEVERITY_ROW_COLORS: Record<EventSeverity, string> = {
  error: "bg-red-500/5",
  warning: "bg-yellow-500/5",
  info: "",
};

export function formatTimestamp(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatTimestampMinute(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
}

export function getEventIcon(event: string): { icon: string; color: string } {
  if (event.startsWith("task:")) {
    switch (event) {
      case "task:created": return { icon: "+", color: "text-cyan-400" };
      case "task:transition": return { icon: "→", color: "text-cyan-400" };
      case "task:removed": return { icon: "−", color: "text-muted-foreground" };
      case "task:retry": return { icon: "↻", color: "text-yellow-400" };
      case "task:fix": return { icon: "🔧", color: "text-purple-400" };
      case "task:question": return { icon: "?", color: "text-yellow-400" };
      case "task:answered": return { icon: "→", color: "text-cyan-400" };
      case "task:timeout": return { icon: "⏱", color: "text-red-400" };
      default: return { icon: "•", color: "text-cyan-400" };
    }
  }
  if (event.startsWith("agent:")) {
    switch (event) {
      case "agent:spawned": return { icon: "▶", color: "text-blue-400" };
      case "agent:finished": return { icon: "■", color: "text-blue-400" };
      case "agent:activity": return { icon: "~", color: "text-blue-300" };
      case "agent:stale": return { icon: "⚠", color: "text-yellow-400" };
      default: return { icon: "•", color: "text-blue-400" };
    }
  }
  if (event.startsWith("assessment:")) {
    return { icon: "⚡", color: "text-yellow-400" };
  }
  if (event.startsWith("plan:")) {
    return { icon: "◆", color: "text-purple-400" };
  }
  if (event.startsWith("deadlock:")) {
    return { icon: "⚠", color: "text-red-400" };
  }
  if (event.startsWith("orchestrator:")) {
    return { icon: "●", color: "text-muted-foreground" };
  }
  return { icon: "•", color: "text-muted-foreground" };
}

export function summarizeEvent(event: SSEEvent): string {
  const d = event.data as Record<string, unknown>;
  switch (event.event) {
    case "task:created":
      return `Task created: ${(d.task as Record<string, unknown>)?.title ?? ""}`;
    case "task:transition": {
      const task = d.task as Record<string, unknown>;
      return `${task?.title ?? ""} → ${d.to as string}`;
    }
    case "task:removed":
      return `Task removed [${d.taskId as string}]`;
    case "agent:spawned":
      return `${d.agentName as string} → ${d.taskTitle as string}`;
    case "agent:finished":
      return `${d.agentName as string} finished (${formatDuration((d.duration as number) ?? 0)})`;
    case "agent:activity":
      return `${d.agentName as string}: ${d.tool ?? ""} ${d.file ?? ""}`;
    case "assessment:started":
      return `Assessing [${d.taskId as string}]`;
    case "assessment:complete":
      return `${(d as Record<string, unknown>).passed ? "PASSED" : "FAILED"} ${d.globalScore !== undefined ? formatScore(d.globalScore as number) : ""}`;
    case "plan:executed":
      return `Plan executed (${d.taskCount as number} tasks)`;
    case "plan:completed":
      return `Plan ${(d as Record<string, unknown>).allPassed ? "completed" : "failed"}`;
    case "orchestrator:tick":
      return `${d.running as number} running, ${d.pending as number} pending`;
    default:
      return event.event;
  }
}
