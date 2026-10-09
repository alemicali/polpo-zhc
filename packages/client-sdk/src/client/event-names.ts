/**
 * Every event name the server streams (the whole bus). Kept equal to POLPO_EVENT_NAMES of
 * @polpo-ai/core by a test (src/__tests__/event-catalog.test.ts); this SDK has no dependencies.
 */
export const POLPO_EVENT_NAMES = [
  "task:created", "task:transition", "task:updated", "task:removed", "task:retry", "task:fix",
  "task:maxRetries", "task:question", "task:answered", "task:timeout", "task:recovered",
  "agent:spawned", "agent:finished", "agent:activity", "agent:stale", "assessment:started",
  "assessment:progress", "assessment:complete", "assessment:corrected", "orchestrator:started",
  "orchestrator:tick", "orchestrator:deadlock", "orchestrator:shutdown", "deadlock:detected",
  "deadlock:resolving", "deadlock:resolved", "deadlock:unresolvable", "mission:saved",
  "mission:executed", "mission:completed", "mission:resumed", "mission:deleted", "session:created",
  "session:updated", "session:deleted", "message:added", "approval:requested", "approval:resolved",
  "approval:timeout", "escalation:triggered", "escalation:resolved", "escalation:human",
  "sla:warning", "sla:violated", "sla:met", "quality:gate:passed", "quality:gate:failed",
  "quality:threshold:failed", "checkpoint:reached", "checkpoint:resumed", "schedule:triggered",
  "schedule:created", "schedule:completed", "schedule:expired", "notification:sent",
  "notification:failed", "watcher:created", "watcher:fired", "watcher:removed", "action:triggered",
  "task:direction", "task:retry:blocked", "agent:created", "agent:updated", "agent:removed",
  "team:created", "team:updated", "team:removed", "assessment:check:started",
  "assessment:check:complete", "approval:rejected", "delay:started", "delay:expired",
  "chat:turn-started", "chat:queue-updated", "room:created", "room:updated", "room:deleted",
  "room:message", "room:typing", "background-wait:created", "background-wait:ready",
  "background-wait:running", "background-wait:completed", "background-wait:failed",
  "background-wait:cancelled", "app:changed", "data-source:changed", "data-view:changed",
  "skill:changed", "brain:changed", "token-usage:recorded", "config:reloaded", "gateway:started",
  "gateway:stopped", "peer:paired", "peer:message", "peer:blocked", "peer:presence",
  "file:changed", "task:retried", "task:killed", "task:force-failed", "task:outcome",
  "task:complete-blocked", "mission:created", "mission:updated", "mission:aborted",
  "schedule:updated", "schedule:removed", "schedule:skipped", "watcher:action-completed",
  "watcher:action-failed", "background-wait:requeued", "approval:auto-blocked",
  "orchestrator:stopping", "orchestrator:stopped", "playbook:changed", "playbook:run",
  "context:compacted", "sandbox:created", "sandbox:ready",
  "sandbox:suspended",
  "sandbox:volume",
  "sandbox:resumed", "sandbox:override-denied", "sandbox:network-denied",
  "sandbox:failed", "sandbox:destroyed", "storage:changed", "log",
] as const;

export type PolpoEventName = typeof POLPO_EVENT_NAMES[number];
