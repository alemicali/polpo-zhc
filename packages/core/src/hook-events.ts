/**
 * Canonical catalog of lifecycle hook events.
 *
 * SSOT (single source of truth) for the set of events the orchestrator emits
 * through PolpoEventMap AND that the notification router subscribes to.
 *
 * This module is **pure data** — no imports, no runtime dependencies.
 * It is safe to import from the browser (UI bundler will tree-shake nothing,
 * but there is no Node-only code to drag along).
 *
 * Keep this file in sync with:
 *   - packages/core/src/events.ts  (PolpoEventMap declaration)
 *   - src/notifications/index.ts   (getAllEventNames subscriber list)
 */

export type HookEventCategory =
  | "task"
  | "agent"
  | "mission"
  | "assessment"
  | "schedule"
  | "approval"
  | "sla"
  | "checkpoint"
  | "delay"
  | "quality"
  | "escalation"
  | "deadlock"
  | "watcher"
  | "notification"
  | "orchestrator"
  | "peer"
  | "session"
  | "config"
  | "file"
  | "action";

export interface HookEventDef {
  /** Concrete event name (e.g. "task:transition"). */
  name: string;
  /** Short human label (e.g. "Task transition"). */
  label: string;
  /** One-line description of when it fires. */
  description: string;
  /** Category for grouping in the UI. */
  category: HookEventCategory;
  /** Top-level keys available on the event payload (for {{placeholder}} hints). */
  placeholders: string[];
}

/**
 * Canonical catalog — every event the notification router subscribes to today.
 * Must match `getAllEventNames()` in src/notifications/index.ts AND a key in
 * PolpoEventMap (packages/core/src/events.ts).
 */
export const HOOK_EVENT_CATALOG: HookEventDef[] = [
  // ── Task lifecycle ──────────────────────────────────────────────
  { name: "task:created", label: "Task created", description: "A new task was created.", category: "task", placeholders: ["task"] },
  { name: "task:transition", label: "Task transition", description: "A task moved between statuses (pending → in_progress → done, etc).", category: "task", placeholders: ["taskId", "from", "to", "task"] },
  { name: "task:updated", label: "Task updated", description: "A task field was modified (description, assignTo, expectations, ...).", category: "task", placeholders: ["taskId", "task"] },
  { name: "task:removed", label: "Task removed", description: "A task was deleted from the registry.", category: "task", placeholders: ["taskId"] },
  { name: "task:retry", label: "Task retry", description: "A task is being retried after assessment failure.", category: "task", placeholders: ["taskId", "attempt", "maxRetries"] },
  { name: "task:fix", label: "Task fix attempt", description: "A task entered the targeted fix phase (does not burn a retry).", category: "task", placeholders: ["taskId", "attempt", "maxFix"] },
  { name: "task:maxRetries", label: "Task exhausted retries", description: "A task hit maxRetries and entered terminal failure.", category: "task", placeholders: ["taskId"] },
  { name: "task:question", label: "Task asked a question", description: "An agent emitted a clarifying question instead of producing work.", category: "task", placeholders: ["taskId", "question"] },
  { name: "task:answered", label: "Task question answered", description: "An LLM (or human) answered an agent's clarifying question.", category: "task", placeholders: ["taskId", "question", "answer"] },
  { name: "task:timeout", label: "Task timed out", description: "Agent runtime exceeded the task timeout and was killed.", category: "task", placeholders: ["taskId", "elapsed", "timeout"] },
  { name: "task:recovered", label: "Task recovered", description: "A task was recovered after a server restart.", category: "task", placeholders: ["taskId", "title", "previousStatus"] },

  // ── Agent lifecycle ────────────────────────────────────────────
  { name: "agent:spawned", label: "Agent spawned", description: "An agent process was launched for a task.", category: "agent", placeholders: ["taskId", "agentName", "taskTitle"] },
  { name: "agent:finished", label: "Agent finished", description: "An agent process exited (regardless of success).", category: "agent", placeholders: ["taskId", "agentName", "exitCode", "duration", "sessionId"] },
  { name: "agent:activity", label: "Agent activity", description: "An agent reported a tool call or file change in flight.", category: "agent", placeholders: ["taskId", "agentName", "tool", "file", "summary"] },
  { name: "agent:stale", label: "Agent stale", description: "An agent has been idle past the stale threshold (warning or kill).", category: "agent", placeholders: ["taskId", "agentName", "idleMs", "action"] },

  // ── Assessment ─────────────────────────────────────────────────
  { name: "assessment:started", label: "Assessment started", description: "The review pipeline started for a finished task.", category: "assessment", placeholders: ["taskId"] },
  { name: "assessment:progress", label: "Assessment progress", description: "Streaming progress update from the review pipeline.", category: "assessment", placeholders: ["taskId", "message"] },
  { name: "assessment:complete", label: "Assessment complete", description: "Review pipeline finished — pass/fail and per-dimension scores.", category: "assessment", placeholders: ["taskId", "passed", "scores", "globalScore", "message"] },
  { name: "assessment:corrected", label: "Assessment corrected", description: "Auto-correction adjusted estimated expectations after first pass.", category: "assessment", placeholders: ["taskId", "corrections"] },

  // ── Orchestrator ───────────────────────────────────────────────
  { name: "orchestrator:started", label: "Orchestrator started", description: "The supervisor loop booted with this project.", category: "orchestrator", placeholders: ["project", "agents"] },
  { name: "orchestrator:tick", label: "Orchestrator tick", description: "A scheduler tick — counts of pending/running/done/failed/queued.", category: "orchestrator", placeholders: ["pending", "running", "done", "failed", "queued"] },
  { name: "orchestrator:deadlock", label: "Orchestrator deadlock", description: "Nothing is ready but work remains — deadlock resolver engaged.", category: "orchestrator", placeholders: ["taskIds"] },
  { name: "orchestrator:shutdown", label: "Orchestrator shutdown", description: "Supervisor is shutting down cleanly.", category: "orchestrator", placeholders: [] },

  // ── Deadlock resolution ────────────────────────────────────────
  { name: "deadlock:detected", label: "Deadlock detected", description: "A set of tasks is deadlocked (transitive failed deps).", category: "deadlock", placeholders: ["taskIds", "resolvableCount"] },
  { name: "deadlock:resolving", label: "Deadlock resolving", description: "Resolver is attempting to unblock a specific task.", category: "deadlock", placeholders: ["taskId", "failedDepId"] },
  { name: "deadlock:resolved", label: "Deadlock resolved", description: "Resolver succeeded — task was absorbed or retried.", category: "deadlock", placeholders: ["taskId", "failedDepId", "action", "reason"] },
  { name: "deadlock:unresolvable", label: "Deadlock unresolvable", description: "Resolver gave up — task remains blocked.", category: "deadlock", placeholders: ["taskId", "reason"] },

  // ── Missions ──────────────────────────────────────────────────
  { name: "mission:saved", label: "Mission saved", description: "A mission definition was created or modified.", category: "mission", placeholders: ["missionId", "name", "status"] },
  { name: "mission:executed", label: "Mission executed", description: "A mission was kicked off — tasks queued.", category: "mission", placeholders: ["missionId", "group", "taskCount"] },
  { name: "mission:completed", label: "Mission completed", description: "All tasks in a mission reached a terminal state.", category: "mission", placeholders: ["missionId", "group", "allPassed", "report"] },
  { name: "mission:resumed", label: "Mission resumed", description: "A paused or failed mission was resumed.", category: "mission", placeholders: ["missionId", "name", "retried", "pending"] },
  { name: "mission:deleted", label: "Mission deleted", description: "A mission and its tasks were removed.", category: "mission", placeholders: ["missionId", "deletedTasks"] },

  // ── Chat sessions ─────────────────────────────────────────────
  { name: "session:created", label: "Chat session created", description: "A new chat session was opened.", category: "session", placeholders: ["sessionId", "title"] },
  { name: "message:added", label: "Chat message added", description: "A new message was appended to a chat session.", category: "session", placeholders: ["sessionId", "messageId", "role"] },

  // ── Approval gates ────────────────────────────────────────────
  { name: "approval:requested", label: "Approval requested", description: "A gate matched and is waiting for human approval.", category: "approval", placeholders: ["requestId", "gateId", "gateName", "taskId", "missionId"] },
  { name: "approval:resolved", label: "Approval resolved", description: "An approval was granted or rejected.", category: "approval", placeholders: ["requestId", "status", "resolvedBy"] },
  { name: "approval:timeout", label: "Approval timed out", description: "An approval request hit its timeout and applied the timeout action.", category: "approval", placeholders: ["requestId", "action"] },

  // ── Escalation ────────────────────────────────────────────────
  { name: "escalation:triggered", label: "Escalation triggered", description: "An escalation level handler engaged for a task.", category: "escalation", placeholders: ["taskId", "level", "handler", "target"] },
  { name: "escalation:resolved", label: "Escalation resolved", description: "An escalation was resolved at a particular level.", category: "escalation", placeholders: ["taskId", "level", "action"] },
  { name: "escalation:human", label: "Escalation → human", description: "Escalation pipeline reached the human-in-the-loop level.", category: "escalation", placeholders: ["taskId", "message", "channels"] },

  // ── SLA ───────────────────────────────────────────────────────
  { name: "sla:warning", label: "SLA warning", description: "A task or mission crossed its SLA warning threshold.", category: "sla", placeholders: ["entityId", "entityType", "deadline", "elapsed", "remaining", "percentUsed"] },
  { name: "sla:violated", label: "SLA violated", description: "A task or mission missed its SLA deadline.", category: "sla", placeholders: ["entityId", "entityType", "deadline", "overdueMs"] },
  { name: "sla:met", label: "SLA met", description: "A task or mission finished within the SLA deadline.", category: "sla", placeholders: ["entityId", "entityType", "deadline", "marginMs"] },

  // ── Quality gates ─────────────────────────────────────────────
  { name: "quality:gate:passed", label: "Quality gate passed", description: "A mission quality gate evaluated and passed.", category: "quality", placeholders: ["missionId", "gateName", "avgScore"] },
  { name: "quality:gate:failed", label: "Quality gate failed", description: "A mission quality gate evaluated and failed.", category: "quality", placeholders: ["missionId", "gateName", "avgScore", "reason"] },
  { name: "quality:threshold:failed", label: "Quality threshold failed", description: "A mission's average score fell under the configured threshold.", category: "quality", placeholders: ["missionId", "avgScore", "threshold"] },

  // ── Checkpoints ───────────────────────────────────────────────
  { name: "checkpoint:reached", label: "Checkpoint reached", description: "A mission checkpoint triggered — waiting for resume.", category: "checkpoint", placeholders: ["missionId", "group", "checkpointName", "message", "afterTasks", "blocksTasks", "reachedAt"] },
  { name: "checkpoint:resumed", label: "Checkpoint resumed", description: "A checkpoint was resumed and blocked tasks were released.", category: "checkpoint", placeholders: ["missionId", "group", "checkpointName"] },

  // ── Scheduling ────────────────────────────────────────────────
  { name: "schedule:triggered", label: "Schedule triggered", description: "A cron or ISO schedule fired and is invoking its mission.", category: "schedule", placeholders: ["scheduleId", "missionId", "expression"] },
  { name: "schedule:created", label: "Schedule created", description: "A new schedule entry was registered.", category: "schedule", placeholders: ["scheduleId", "missionId", "nextRunAt"] },
  { name: "schedule:completed", label: "Schedule completed", description: "A one-shot schedule finished and was disabled.", category: "schedule", placeholders: ["scheduleId", "missionId"] },
  { name: "schedule:expired", label: "Schedule expired", description: "A recurring schedule passed its endDate and was disabled.", category: "schedule", placeholders: ["scheduleId", "missionId", "endDate"] },

  // ── Notifications ─────────────────────────────────────────────
  { name: "notification:sent", label: "Notification sent", description: "The router successfully delivered a notification.", category: "notification", placeholders: ["ruleId", "channel", "event"] },
  { name: "notification:failed", label: "Notification failed", description: "A notification delivery attempt failed.", category: "notification", placeholders: ["ruleId", "channel", "error"] },

  // ── Task watchers ─────────────────────────────────────────────
  { name: "watcher:created", label: "Watcher created", description: "A task watcher was registered.", category: "watcher", placeholders: ["watcherId", "taskId", "targetStatus"] },
  { name: "watcher:fired", label: "Watcher fired", description: "A task reached the watched status and the watcher action ran.", category: "watcher", placeholders: ["watcherId", "taskId", "targetStatus", "actionType"] },
  { name: "watcher:removed", label: "Watcher removed", description: "A task watcher was removed.", category: "watcher", placeholders: ["watcherId"] },

  // ── Notification rule actions ─────────────────────────────────
  { name: "action:triggered", label: "Action triggered", description: "A notification rule action (create_task/run_script/...) executed.", category: "action", placeholders: ["ruleId", "actionType", "result", "error"] },
];

/** All canonical event names — derived from the catalog. */
export const CANONICAL_HOOK_EVENT_NAMES: string[] = HOOK_EVENT_CATALOG.map(e => e.name);

/** Lookup table for fast access. */
const HOOK_EVENT_INDEX: Record<string, HookEventDef> = Object.fromEntries(
  HOOK_EVENT_CATALOG.map(e => [e.name, e]),
);

/** Glob shortcuts the UI surfaces as first-class suggestions. */
export const HOOK_EVENT_GLOBS: { pattern: string; label: string; description: string }[] = [
  { pattern: "task:*", label: "All task events", description: "Matches every task lifecycle event (created, transition, retry, timeout, ...)." },
  { pattern: "mission:*", label: "All mission events", description: "Matches every mission event (saved, executed, completed, resumed, deleted)." },
  { pattern: "assessment:*", label: "All assessment events", description: "Matches every assessment event (started, progress, complete, corrected)." },
  { pattern: "schedule:*", label: "All schedule events", description: "Matches every schedule event (triggered, created, completed, expired)." },
  { pattern: "approval:*", label: "All approval events", description: "Matches every approval gate event (requested, resolved, timeout)." },
  { pattern: "sla:*", label: "All SLA events", description: "Matches every SLA event (warning, violated, met)." },
  { pattern: "quality:*", label: "All quality events", description: "Matches every quality gate event (passed, failed, threshold:failed)." },
  { pattern: "escalation:*", label: "All escalation events", description: "Matches every escalation event (triggered, resolved, human)." },
];

/** Known top-level event categories (used to validate freeform patterns). */
const KNOWN_CATEGORY_PREFIXES = new Set<string>([
  "task", "agent", "mission", "assessment", "schedule", "approval", "sla",
  "checkpoint", "delay", "quality", "escalation", "deadlock", "watcher",
  "notification", "orchestrator", "peer", "session", "config", "file", "action",
  "message", "team", "gateway",
]);

/** Look up a catalog entry by exact event name. */
export function getHookEventDef(name: string): HookEventDef | undefined {
  return HOOK_EVENT_INDEX[name];
}

/**
 * Return true if `name` looks like a real Polpo event.
 *
 * Accepts:
 *  - An exact match in the canonical catalog
 *  - An exact match in HOOK_EVENT_GLOBS
 *  - Any pattern shaped like "<knownCategory>:..." (allowing freeform globs
 *    like "task:fail*" or "mission:*:done") — useful so user-typed globs are
 *    not flagged as unknown if the prefix is a real category.
 *
 * Used by the UI to render an amber warning when a user types an event that
 * does not look canonical.
 */
export function isCanonicalHookEvent(name: string): boolean {
  if (!name) return false;
  if (HOOK_EVENT_INDEX[name]) return true;
  for (const g of HOOK_EVENT_GLOBS) {
    if (g.pattern === name) return true;
  }
  const idx = name.indexOf(":");
  if (idx > 0) {
    const prefix = name.slice(0, idx);
    if (KNOWN_CATEGORY_PREFIXES.has(prefix)) return true;
  }
  return false;
}
