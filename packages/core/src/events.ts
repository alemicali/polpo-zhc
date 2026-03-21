/**
 * Event type definitions for Polpo.
 * Pure type declarations — no runtime dependencies.
 *
 * The TypedEmitter class (which extends Node.js EventEmitter) lives in the
 * shell layer (src/core/events.ts), not here.
 */

import type { Task, TaskStatus, DimensionScore, MissionStatus, MissionReport, ChannelType, PeerIdentity } from "./types.js";

export interface PolpoEventMap {
  // Task lifecycle
  "task:created": { task: Task };
  "task:transition": { taskId: string; from: TaskStatus; to: TaskStatus; task: Task };
  "task:updated": { taskId: string; task: Task };
  "task:removed": { taskId: string };

  // Agent lifecycle
  "agent:spawned": { taskId: string; agentName: string; taskTitle: string };
  "agent:finished": { taskId: string; agentName: string; exitCode: number; duration: number; sessionId?: string };
  "agent:activity": { taskId: string; agentName: string; tool?: string; file?: string; summary?: string };

  // Assessment
  "assessment:started": { taskId: string };
  "assessment:progress": { taskId: string; message: string };
  "assessment:check:started": { taskId: string; index: number; total: number; type: string; label: string };
  "assessment:check:complete": { taskId: string; index: number; total: number; type: string; label: string; passed: boolean; message?: string };
  "assessment:complete": { taskId: string; passed: boolean; scores?: DimensionScore[]; globalScore?: number; message?: string };
  "assessment:corrected": { taskId: string; corrections: number };

  // Orchestrator lifecycle
  "orchestrator:started": { project: string; agents: string[] };
  "orchestrator:tick": { pending: number; running: number; done: number; failed: number; queued: number };
  "orchestrator:deadlock": { taskIds: string[] };
  "orchestrator:shutdown": Record<string, never>;

  // Retry & Fix
  "task:retry": { taskId: string; attempt: number; maxRetries: number };
  "task:retry:blocked": { taskId: string; reason: string };
  "task:fix": { taskId: string; attempt: number; maxFix: number };
  "task:maxRetries": { taskId: string };

  // Question detection & auto-resolution
  "task:question": { taskId: string; question: string };
  "task:answered": { taskId: string; question: string; answer: string };

  // Deadlock resolution
  "deadlock:detected": { taskIds: string[]; resolvableCount: number };
  "deadlock:resolving": { taskId: string; failedDepId: string };
  "deadlock:resolved": { taskId: string; failedDepId: string; action: "absorb" | "retry"; reason: string };
  "deadlock:unresolvable": { taskId: string; reason: string };

  // Resilience
  "task:timeout": { taskId: string; elapsed: number; timeout: number };
  "agent:stale": { taskId: string; agentName: string; idleMs: number; action: "warning" | "killed" };

  // Recovery
  "task:recovered": { taskId: string; title: string; previousStatus: TaskStatus };

  // Missions
  "mission:saved": { missionId: string; name: string; status: MissionStatus };
  "mission:executed": { missionId: string; group: string; taskCount: number };
  "mission:completed": { missionId: string; group: string; allPassed: boolean; report: MissionReport };
  "mission:resumed": { missionId: string; name: string; retried: number; pending: number };
  "mission:deleted": { missionId: string; deletedTasks?: number };

  // Chat sessions
  "session:created": { sessionId: string; title?: string };
  "message:added": { sessionId: string; messageId: string; role: "user" | "assistant" };

  // Approval gates
  "approval:requested": { requestId: string; gateId: string; gateName: string; taskId?: string; missionId?: string };
  "approval:resolved": { requestId: string; status: "approved" | "rejected"; resolvedBy?: string };
  "approval:rejected": { requestId: string; taskId?: string; feedback: string; rejectionCount: number; resolvedBy?: string };
  "approval:timeout": { requestId: string; action: "approve" | "reject" };

  // Escalation
  "escalation:triggered": { taskId: string; level: number; handler: string; target?: string };
  "escalation:resolved": { taskId: string; level: number; action: string };
  "escalation:human": { taskId: string; message: string; channels?: string[] };

  // SLA & Deadlines
  "sla:warning": { entityId: string; entityType: "task" | "mission"; deadline: string; elapsed: number; remaining: number; percentUsed: number };
  "sla:violated": { entityId: string; entityType: "task" | "mission"; deadline: string; overdueMs: number };
  "sla:met": { entityId: string; entityType: "task" | "mission"; deadline: string; marginMs: number };

  // Checkpoints (mission-level)
  "checkpoint:reached": { missionId?: string; group: string; checkpointName: string; message?: string; afterTasks: string[]; blocksTasks: string[]; reachedAt: string };
  "checkpoint:resumed": { missionId?: string; group: string; checkpointName: string };

  // Delays (mission-level)
  "delay:started": { missionId?: string; group: string; delayName: string; duration: string; message?: string; afterTasks: string[]; blocksTasks: string[]; startedAt: string; expiresAt: string };
  "delay:expired": { missionId?: string; group: string; delayName: string };

  // Quality gates (mission-level)
  "quality:gate:passed": { missionId: string; gateName: string; avgScore?: number };
  "quality:gate:failed": { missionId: string; gateName: string; avgScore?: number; reason: string };
  "quality:threshold:failed": { missionId: string; avgScore: number; threshold: number };

  // Scheduling
  "schedule:triggered": { scheduleId: string; missionId: string; expression: string };
  "schedule:created": { scheduleId: string; missionId: string; nextRunAt?: string };
  "schedule:completed": { scheduleId: string; missionId: string };
  "schedule:expired": { scheduleId: string; missionId: string; endDate?: string };

  // Notifications
  "notification:sent": { ruleId: string; channel: string; event: string };
  "notification:failed": { ruleId: string; channel: string; error: string };

  // Config
  "config:reloaded": { timestamp: string };

  // Channel gateway & peers
  "gateway:started": { channels: ChannelType[] };
  "gateway:stopped": Record<string, never>;
  "peer:paired": { peer: PeerIdentity; channel: ChannelType };
  "peer:message": { peerId: string; channel: ChannelType; text: string; sessionId: string };
  "peer:blocked": { peerId: string; channel: ChannelType; reason: string };
  "peer:presence": { peerId: string; channel: ChannelType; status: "online" | "offline" };

  // Task watchers
  "watcher:created": { watcherId: string; taskId: string; targetStatus: TaskStatus };
  "watcher:fired": { watcherId: string; taskId: string; targetStatus: TaskStatus; actionType: string };
  "watcher:removed": { watcherId: string };

  // Notification rule actions
  "action:triggered": { ruleId: string; actionType: string; result?: string; error?: string };

  // Filesystem
  "file:changed": { path: string; dir: string; action: "created" | "modified" | "deleted" | "renamed"; source: "agent" | "server" | "chat" };

  // General
  "log": { level: "info" | "warn" | "error" | "debug"; message: string };
}

export type PolpoEvent = keyof PolpoEventMap;
