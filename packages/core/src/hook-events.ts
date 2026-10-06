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
 * Exhaustive over PolpoEventMap (packages/core/src/events.ts): adding an event there without
 * an entry here fails to compile. The only import is a type, erased at build time.
 */

import type { PolpoEvent } from "./events.js";

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
  | "action"
  | "room"
  | "background"
  | "registry";

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
 * Canonical catalog: one entry per event of PolpoEventMap (packages/core/src/events.ts). The
 * mapped type makes the compiler reject a missing or unknown event, so the SSE stream, the
 * notification router and the UI all read the same, complete list.
 */
const EVENT_CATALOG: { [K in PolpoEvent]: Omit<HookEventDef, "name"> } = {
  // ── Task lifecycle ──────────────────────────────────────────────
  "task:created": { label: "Task created", description: "A new task was created.", category: "task", placeholders: ["task"] },
  "task:transition": { label: "Task transition", description: "A task moved between statuses (pending → in_progress → done, etc).", category: "task", placeholders: ["taskId", "from", "to", "task"] },
  "task:updated": { label: "Task updated", description: "A task field was modified (description, assignTo, expectations, result, outcomes...).", category: "task", placeholders: ["taskId", "task", "fields", "source", "by"] },
  "task:removed": { label: "Task removed", description: "A task was deleted from the registry.", category: "task", placeholders: ["taskId"] },
  "task:retry": { label: "Task retry", description: "A task is being retried after assessment failure.", category: "task", placeholders: ["taskId", "attempt", "maxRetries"] },
  "task:fix": { label: "Task fix attempt", description: "A task entered the targeted fix phase (does not burn a retry).", category: "task", placeholders: ["taskId", "attempt", "maxFix"] },
  "task:maxRetries": { label: "Task exhausted retries", description: "A task hit maxRetries and entered terminal failure.", category: "task", placeholders: ["taskId"] },
  "task:question": { label: "Task asked a question", description: "An agent emitted a clarifying question instead of producing work.", category: "task", placeholders: ["taskId", "question"] },
  "task:answered": { label: "Task question answered", description: "An LLM (or human) answered an agent's clarifying question.", category: "task", placeholders: ["taskId", "question", "answer"] },
  "task:timeout": { label: "Task timed out", description: "Agent runtime exceeded the task timeout and was killed.", category: "task", placeholders: ["taskId", "elapsed", "timeout"] },
  "task:recovered": { label: "Task recovered", description: "A task was recovered after a server restart.", category: "task", placeholders: ["taskId", "title", "previousStatus"] },

  // ── Agent lifecycle ────────────────────────────────────────────
  "agent:spawned": { label: "Agent spawned", description: "An agent process was launched for a task.", category: "agent", placeholders: ["taskId", "agentName", "taskTitle"] },
  "agent:finished": { label: "Agent finished", description: "An agent process exited (regardless of success).", category: "agent", placeholders: ["taskId", "agentName", "exitCode", "duration", "sessionId"] },
  "agent:activity": { label: "Agent activity", description: "An agent reported a tool call or file change in flight.", category: "agent", placeholders: ["taskId", "agentName", "tool", "file", "summary"] },
  "agent:stale": { label: "Agent stale", description: "An agent has been idle past the stale threshold (warning or kill).", category: "agent", placeholders: ["taskId", "agentName", "idleMs", "action"] },

  // ── Assessment ─────────────────────────────────────────────────
  "assessment:started": { label: "Assessment started", description: "The review pipeline started for a finished task.", category: "assessment", placeholders: ["taskId"] },
  "assessment:progress": { label: "Assessment progress", description: "Streaming progress update from the review pipeline.", category: "assessment", placeholders: ["taskId", "message"] },
  "assessment:complete": { label: "Assessment complete", description: "Review pipeline finished — pass/fail and per-dimension scores.", category: "assessment", placeholders: ["taskId", "passed", "scores", "globalScore", "message"] },
  "assessment:corrected": { label: "Assessment corrected", description: "Auto-correction adjusted estimated expectations after first pass.", category: "assessment", placeholders: ["taskId", "corrections"] },

  // ── Orchestrator ───────────────────────────────────────────────
  "orchestrator:started": { label: "Orchestrator started", description: "The supervisor loop booted with this project.", category: "orchestrator", placeholders: ["project", "agents"] },
  "orchestrator:tick": { label: "Orchestrator tick", description: "A scheduler tick — counts of pending/running/done/failed/queued.", category: "orchestrator", placeholders: ["pending", "running", "done", "failed", "queued"] },
  "orchestrator:deadlock": { label: "Orchestrator deadlock", description: "Nothing is ready but work remains — deadlock resolver engaged.", category: "orchestrator", placeholders: ["taskIds"] },
  "orchestrator:shutdown": { label: "Orchestrator shutdown", description: "Supervisor is shutting down cleanly.", category: "orchestrator", placeholders: [] },

  // ── Deadlock resolution ────────────────────────────────────────
  "deadlock:detected": { label: "Deadlock detected", description: "A set of tasks is deadlocked (transitive failed deps).", category: "deadlock", placeholders: ["taskIds", "resolvableCount"] },
  "deadlock:resolving": { label: "Deadlock resolving", description: "Resolver is attempting to unblock a specific task.", category: "deadlock", placeholders: ["taskId", "failedDepId"] },
  "deadlock:resolved": { label: "Deadlock resolved", description: "Resolver succeeded — task was absorbed or retried.", category: "deadlock", placeholders: ["taskId", "failedDepId", "action", "reason"] },
  "deadlock:unresolvable": { label: "Deadlock unresolvable", description: "Resolver gave up — task remains blocked.", category: "deadlock", placeholders: ["taskId", "reason"] },

  // ── Missions ──────────────────────────────────────────────────
  "mission:saved": { label: "Mission saved", description: "A mission definition was created or modified.", category: "mission", placeholders: ["missionId", "name", "status"] },
  "mission:executed": { label: "Mission executed", description: "A mission was kicked off — tasks queued.", category: "mission", placeholders: ["missionId", "group", "taskCount"] },
  "mission:completed": { label: "Mission completed", description: "All tasks in a mission reached a terminal state.", category: "mission", placeholders: ["missionId", "group", "allPassed", "report"] },
  "mission:resumed": { label: "Mission resumed", description: "A paused or failed mission was resumed.", category: "mission", placeholders: ["missionId", "name", "retried", "pending"] },
  "mission:deleted": { label: "Mission deleted", description: "A mission and its tasks were removed.", category: "mission", placeholders: ["missionId", "deletedTasks"] },

  // ── Chat sessions ─────────────────────────────────────────────
  "session:created": { label: "Chat session created", description: "A new chat session was opened.", category: "session", placeholders: ["sessionId", "title"] },
  "session:updated": { label: "Chat session updated", description: "A chat session title or star status changed.", category: "session", placeholders: ["sessionId", "title", "starred"] },
  "session:deleted": { label: "Chat session deleted", description: "A chat session was removed.", category: "session", placeholders: ["sessionId"] },
  "message:added": { label: "Chat message added", description: "A new message was appended to a chat session.", category: "session", placeholders: ["sessionId", "messageId", "role"] },

  // ── Approval gates ────────────────────────────────────────────
  "approval:requested": { label: "Approval requested", description: "A gate matched and is waiting for human approval.", category: "approval", placeholders: ["requestId", "gateId", "gateName", "taskId", "missionId"] },
  "approval:resolved": { label: "Approval resolved", description: "An approval was granted or rejected.", category: "approval", placeholders: ["requestId", "status", "resolvedBy"] },
  "approval:timeout": { label: "Approval timed out", description: "An approval request hit its timeout and applied the timeout action.", category: "approval", placeholders: ["requestId", "action"] },

  // ── Escalation ────────────────────────────────────────────────
  "escalation:triggered": { label: "Escalation triggered", description: "An escalation level handler engaged for a task.", category: "escalation", placeholders: ["taskId", "level", "handler", "target"] },
  "escalation:resolved": { label: "Escalation resolved", description: "An escalation was resolved at a particular level.", category: "escalation", placeholders: ["taskId", "level", "action"] },
  "escalation:human": { label: "Escalation → human", description: "Escalation pipeline reached the human-in-the-loop level.", category: "escalation", placeholders: ["taskId", "message", "channels"] },

  // ── SLA ───────────────────────────────────────────────────────
  "sla:warning": { label: "SLA warning", description: "A task or mission crossed its SLA warning threshold.", category: "sla", placeholders: ["entityId", "entityType", "deadline", "elapsed", "remaining", "percentUsed"] },
  "sla:violated": { label: "SLA violated", description: "A task or mission missed its SLA deadline.", category: "sla", placeholders: ["entityId", "entityType", "deadline", "overdueMs"] },
  "sla:met": { label: "SLA met", description: "A task or mission finished within the SLA deadline.", category: "sla", placeholders: ["entityId", "entityType", "deadline", "marginMs"] },

  // ── Quality gates ─────────────────────────────────────────────
  "quality:gate:passed": { label: "Quality gate passed", description: "A mission quality gate evaluated and passed.", category: "quality", placeholders: ["missionId", "gateName", "avgScore"] },
  "quality:gate:failed": { label: "Quality gate failed", description: "A mission quality gate evaluated and failed.", category: "quality", placeholders: ["missionId", "gateName", "avgScore", "reason"] },
  "quality:threshold:failed": { label: "Quality threshold failed", description: "A mission's average score fell under the configured threshold.", category: "quality", placeholders: ["missionId", "avgScore", "threshold"] },

  // ── Checkpoints ───────────────────────────────────────────────
  "checkpoint:reached": { label: "Checkpoint reached", description: "A mission checkpoint triggered — waiting for resume.", category: "checkpoint", placeholders: ["missionId", "group", "checkpointName", "message", "afterTasks", "blocksTasks", "reachedAt"] },
  "checkpoint:resumed": { label: "Checkpoint resumed", description: "A checkpoint was resumed and blocked tasks were released.", category: "checkpoint", placeholders: ["missionId", "group", "checkpointName"] },

  // ── Scheduling ────────────────────────────────────────────────
  "schedule:triggered": { label: "Schedule triggered", description: "A cron or ISO schedule fired and is invoking its mission.", category: "schedule", placeholders: ["scheduleId", "missionId", "expression"] },
  "schedule:created": { label: "Schedule created", description: "A new schedule entry was registered.", category: "schedule", placeholders: ["scheduleId", "missionId", "nextRunAt"] },
  "schedule:completed": { label: "Schedule completed", description: "A one-shot schedule finished and was disabled.", category: "schedule", placeholders: ["scheduleId", "missionId"] },
  "schedule:expired": { label: "Schedule expired", description: "A recurring schedule passed its endDate and was disabled.", category: "schedule", placeholders: ["scheduleId", "missionId", "endDate"] },

  // ── Notifications ─────────────────────────────────────────────
  "notification:sent": { label: "Notification sent", description: "The router successfully delivered a notification.", category: "notification", placeholders: ["ruleId", "channel", "event"] },
  "notification:failed": { label: "Notification failed", description: "A notification delivery attempt failed.", category: "notification", placeholders: ["ruleId", "channel", "error"] },

  // ── Task watchers ─────────────────────────────────────────────
  "watcher:created": { label: "Watcher created", description: "A task watcher was registered.", category: "watcher", placeholders: ["watcherId", "taskId", "targetStatus"] },
  "watcher:fired": { label: "Watcher fired", description: "A task reached the watched status and the watcher action ran.", category: "watcher", placeholders: ["watcherId", "taskId", "targetStatus", "actionType"] },
  "watcher:removed": { label: "Watcher removed", description: "A task watcher was removed.", category: "watcher", placeholders: ["watcherId"] },

  // ── Notification rule actions ─────────────────────────────────
  "action:triggered": { label: "Action triggered", description: "A notification rule action (create_task/run_script/...) executed.", category: "action", placeholders: ["ruleId", "actionType", "result", "error"] },

  // ── Added: every other event the bus carries ─────────────────
  "task:direction": { label: "Task direction", description: "A direction (steering message) was queued or changed for a running task.", category: "task", placeholders: ["taskId", "action", "direction"] },
  "task:retry:blocked": { label: "Retry blocked", description: "Automatic retry/fix was blocked because the task has side effects.", category: "task", placeholders: ["taskId", "reason"] },
  "agent:created": { label: "Agent created", description: "An agent was added.", category: "agent", placeholders: ["agentName", "teamName"] },
  "agent:updated": { label: "Agent updated", description: "An agent's configuration changed.", category: "agent", placeholders: ["agentName"] },
  "agent:removed": { label: "Agent removed", description: "An agent was removed.", category: "agent", placeholders: ["agentName"] },
  "team:created": { label: "Team created", description: "A team was added.", category: "agent", placeholders: ["teamName"] },
  "team:updated": { label: "Team updated", description: "A team changed (or was renamed).", category: "agent", placeholders: ["teamName", "oldName"] },
  "team:removed": { label: "Team removed", description: "A team was removed.", category: "agent", placeholders: ["teamName"] },
  "assessment:check:started": { label: "Check started", description: "One assessment check started.", category: "assessment", placeholders: ["taskId", "index", "total", "type", "label"] },
  "assessment:check:complete": { label: "Check complete", description: "One assessment check finished.", category: "assessment", placeholders: ["taskId", "index", "total", "type", "label", "passed", "message"] },
  "approval:rejected": { label: "Approval rejected", description: "A person rejected an approval with feedback; the task goes back for revision.", category: "approval", placeholders: ["requestId", "taskId", "feedback", "rejectionCount", "resolvedBy"] },
  "delay:started": { label: "Delay started", description: "A mission delay started its timer.", category: "delay", placeholders: ["missionId", "group", "delayName", "duration", "expiresAt"] },
  "delay:expired": { label: "Delay expired", description: "A mission delay expired; blocked tasks can start.", category: "delay", placeholders: ["missionId", "group", "delayName"] },
  "chat:turn-started": { label: "Chat turn started", description: "The server started a chat turn on its own (queue, steer, fork, send now).", category: "session", placeholders: ["sessionId", "turnId", "reason"] },
  "chat:queue-updated": { label: "Chat queue updated", description: "A chat session's prompt queue changed.", category: "session", placeholders: ["sessionId"] },
  "room:created": { label: "Group created", description: "A group conversation was created.", category: "room", placeholders: ["room"] },
  "room:updated": { label: "Group updated", description: "A group conversation's settings or members changed.", category: "room", placeholders: ["room"] },
  "room:deleted": { label: "Group deleted", description: "A group conversation was deleted.", category: "room", placeholders: ["roomId"] },
  "room:message": { label: "Group message", description: "A person or an agent wrote in a group conversation.", category: "room", placeholders: ["roomId", "message"] },
  "room:typing": { label: "Group typing", description: "An agent started or finished its turn in a group.", category: "room", placeholders: ["roomId", "agent", "name", "typing"] },
  "background-wait:created": { label: "Background wait created", description: "A chat is now waiting in the background for a task.", category: "background", placeholders: ["wait"] },
  "background-wait:ready": { label: "Background wait ready", description: "The awaited task reached its status; the chat can continue.", category: "background", placeholders: ["wait"] },
  "background-wait:running": { label: "Background wait running", description: "The chat continuation is running.", category: "background", placeholders: ["wait"] },
  "background-wait:completed": { label: "Background wait completed", description: "The chat continuation finished.", category: "background", placeholders: ["wait"] },
  "background-wait:failed": { label: "Background wait failed", description: "The background wait failed.", category: "background", placeholders: ["wait"] },
  "background-wait:cancelled": { label: "Background wait cancelled", description: "The background wait was cancelled.", category: "background", placeholders: ["wait"] },
  "app:changed": { label: "App changed", description: "An app was created, updated, deleted or its runtime changed.", category: "registry", placeholders: ["appId", "action", "resourceId"] },
  "data-source:changed": { label: "Data source changed", description: "A data source was created, updated, deleted or got new data.", category: "registry", placeholders: ["sourceId", "action"] },
  "data-view:changed": { label: "Data view changed", description: "A data view was created, updated or deleted.", category: "registry", placeholders: ["viewId", "action"] },
  "skill:changed": { label: "Skill changed", description: "A skill was created, updated, deleted, installed or (un)assigned.", category: "registry", placeholders: ["scope", "action", "skillName", "agentName"] },
  "brain:changed": { label: "Company brain changed", description: "An item of the company brain was created, updated or deleted.", category: "registry", placeholders: ["action", "subjectType", "subjectId"] },
  "token-usage:recorded": { label: "Token usage recorded", description: "Token usage of a model call was recorded.", category: "registry", placeholders: ["timestamp"] },
  "config:reloaded": { label: "Config reloaded", description: "The instance configuration was reloaded.", category: "config", placeholders: ["timestamp"] },
  "gateway:started": { label: "Gateway started", description: "A messaging channel gateway started.", category: "peer", placeholders: ["channels"] },
  "gateway:stopped": { label: "Gateway stopped", description: "A messaging channel gateway stopped.", category: "peer", placeholders: [] },
  "peer:paired": { label: "Contact paired", description: "A contact was allowed to talk to the bot.", category: "peer", placeholders: ["peer", "channel"] },
  "peer:message": { label: "Inbound message", description: "A message arrived from a messaging channel.", category: "peer", placeholders: ["peerId", "channel", "text", "sessionId"] },
  "peer:blocked": { label: "Contact blocked", description: "A message was refused by the channel policy.", category: "peer", placeholders: ["peerId", "channel", "reason"] },
  "peer:presence": { label: "Contact presence", description: "A contact's presence changed.", category: "peer", placeholders: ["peerId", "channel", "status"] },
  "file:changed": { label: "File changed", description: "A file was created, modified, deleted or renamed.", category: "file", placeholders: ["path", "dir", "action", "source"] },
  "task:retried": { label: "Task retried", description: "Someone asked to run a failed task again.", category: "task", placeholders: ["taskId", "title", "source", "by"] },
  "task:killed": { label: "Task killed", description: "A running or waiting task was stopped on request.", category: "task", placeholders: ["taskId", "title", "runId", "source", "by"] },
  "task:force-failed": { label: "Task force-failed", description: "A task was failed on purpose (deadlock, manual force-fail).", category: "task", placeholders: ["taskId", "title", "reason", "source"] },
  "task:outcome": { label: "Task outcome", description: "The agent produced new outcomes (files, text, media) for a task.", category: "task", placeholders: ["taskId", "outcomes"] },
  "task:complete-blocked": { label: "Completion blocked", description: "A lifecycle hook refused to mark the task done.", category: "task", placeholders: ["taskId", "reason"] },
  "mission:created": { label: "Mission created", description: "A new mission was created.", category: "mission", placeholders: ["missionId", "name", "status", "source", "by"] },
  "mission:updated": { label: "Mission updated", description: "A mission or something inside it (a task, checkpoint, delay, gate, team) changed.", category: "mission", placeholders: ["missionId", "name", "status", "prevStatus", "fields", "section", "action", "item", "source", "by"] },
  "mission:aborted": { label: "Mission aborted", description: "A mission was stopped and its running tasks killed.", category: "mission", placeholders: ["missionId", "name", "group", "killedTasks", "source", "by"] },
  "schedule:updated": { label: "Schedule updated", description: "A schedule changed (expression, enabled, next run).", category: "schedule", placeholders: ["scheduleId", "missionId", "expression", "enabled", "nextRunAt", "source"] },
  "schedule:removed": { label: "Schedule removed", description: "A schedule was removed.", category: "schedule", placeholders: ["scheduleId", "missionId", "source"] },
  "schedule:skipped": { label: "Schedule skipped", description: "A due schedule did not run (refused by a hook, or its mission is gone).", category: "schedule", placeholders: ["scheduleId", "missionId", "reason"] },
  "watcher:action-completed": { label: "Watcher action done", description: "The action of a fired watcher completed.", category: "watcher", placeholders: ["watcherId", "taskId", "actionType", "result"] },
  "watcher:action-failed": { label: "Watcher action failed", description: "The action of a fired watcher failed.", category: "watcher", placeholders: ["watcherId", "taskId", "actionType", "error"] },
  "background-wait:requeued": { label: "Background wait requeued", description: "A background wait was put back in the queue.", category: "background", placeholders: ["wait"] },
  "approval:auto-blocked": { label: "Auto gate blocked", description: "An automatic approval gate blocked an operation.", category: "approval", placeholders: ["gateId", "gateName", "hook", "taskId", "missionId"] },
  "orchestrator:stopping": { label: "Orchestrator stopping", description: "Graceful shutdown started.", category: "orchestrator", placeholders: ["activeRuns"] },
  "orchestrator:stopped": { label: "Orchestrator stopped", description: "The supervisor loop stopped (work done, stop requested, or error).", category: "orchestrator", placeholders: ["reason", "message"] },
  "playbook:changed": { label: "Playbook changed", description: "A playbook was created, updated, deleted or installed.", category: "mission", placeholders: ["name", "action", "source", "by"] },
  "playbook:run": { label: "Playbook run", description: "A playbook was run and became a mission.", category: "mission", placeholders: ["name", "missionId", "params", "source", "by"] },
  "context:compacted": { label: "Context compacted", description: "A chat or a task run was compacted to fit the model's context window (old tool results cleared and/or earlier messages summarized).", category: "session", placeholders: ["scope", "sessionId", "taskId", "agentName", "reason", "mode", "beforeTokens", "afterTokens", "compactionCount", "model"] },
  "sandbox:created": { label: "Sandbox created", description: "A workspace for an agent's tools was created (local, bubblewrap, container or remote).", category: "registry", placeholders: ["workspaceId", "provider", "scope", "taskId", "sessionId", "agentName", "network"] },
  "sandbox:ready": { label: "Sandbox ready", description: "A workspace finished preparing (mounts, context transfer, setup).", category: "registry", placeholders: ["workspaceId", "provider", "durationMs"] },
  "sandbox:override-denied": { label: "Sandbox override denied", description: "A mission or task asked for a looser sandbox than allowed; the stricter option was applied.", category: "registry", placeholders: ["scope", "taskId", "agentName", "level", "field", "requested", "applied"] },
  "sandbox:failed": { label: "Sandbox failed", description: "A workspace could not be created or prepared.", category: "registry", placeholders: ["provider", "scope", "taskId", "sessionId", "error"] },
  "sandbox:destroyed": { label: "Sandbox destroyed", description: "A workspace was closed.", category: "registry", placeholders: ["workspaceId", "provider", "durationMs", "reason"] },
  "storage:changed": { label: "Storage changed", description: "A storage bucket was added, changed, removed, mounted or unmounted.", category: "registry", placeholders: ["name", "action", "error", "source", "by"] },
  "log": { label: "System log", description: "A text message from the server (info, warning, error).", category: "orchestrator", placeholders: ["level", "message"] },
};

/** Every event the bus carries, in catalog order. */
export const HOOK_EVENT_CATALOG: HookEventDef[] = (Object.keys(EVENT_CATALOG) as PolpoEvent[])
  .map((name) => ({ name, ...EVENT_CATALOG[name] }));

/** All canonical event names — derived from the catalog. */
export const CANONICAL_HOOK_EVENT_NAMES: string[] = HOOK_EVENT_CATALOG.map(e => e.name);

/** Every event name, typed: what the SSE bridge streams and the notification router can match. */
export const POLPO_EVENT_NAMES: PolpoEvent[] = HOOK_EVENT_CATALOG.map(e => e.name as PolpoEvent);

/**
 * Events too frequent for glob patterns ("*", "room:*"): a rule still gets them when it names
 * them exactly.
 */
export const HIGH_FREQUENCY_EVENTS: ReadonlySet<string> = new Set(["orchestrator:tick", "agent:activity", "room:typing"]);

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
const KNOWN_CATEGORY_PREFIXES = new Set<string>(
  POLPO_EVENT_NAMES.filter((n) => n.includes(":")).map((n) => n.slice(0, n.indexOf(":"))),
);

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
