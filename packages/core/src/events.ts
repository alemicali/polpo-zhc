/**
 * Event type definitions for Polpo.
 * Pure type declarations — no runtime dependencies.
 *
 * The TypedEmitter class (which extends Node.js EventEmitter) lives in the
 * shell layer (src/core/events.ts), not here.
 */

import type { AgentConfig, Task, TaskStatus, DimensionScore, MissionStatus, MissionReport, ChannelType, PeerIdentity, Team } from "./types.js";
import type { BackgroundWait, TaskDirection, TaskDirectionMode } from "./task-control-store.js";

/** Where a change came from: the UI or an HTTP call, Polpo's own tools, an agent's tools, a messaging channel, a schedule, or the system itself. */
export type EventSource = "api" | "polpo" | "agent" | "channel" | "schedule" | "system";

/** Who caused an event: carried by events about changes (`by` is a person: email or channel contact id). */
export interface EventOrigin {
  source?: EventSource;
  by?: string;
}

export interface PolpoEventMap {
  // Task lifecycle
  "task:created": { task: Task };
  /** `reason` is set when the status was forced (recovery, races, manual set). */
  "task:transition": { taskId: string; from: TaskStatus; to: TaskStatus; task: Task; reason?: string } & EventOrigin;
  /** Any change of a task's fields; `fields` names them (status changes are task:transition). */
  "task:updated": { taskId: string; task: Task; fields?: string[] } & EventOrigin;
  "task:removed": { taskId: string; title?: string; group?: string; missionId?: string } & EventOrigin;
  /** A person (or Polpo) asked to run a failed task again; automatic retries are task:retry. */
  "task:retried": { taskId: string; title: string } & EventOrigin;
  /** A running or waiting task was stopped on request. */
  "task:killed": { taskId: string; title: string; runId?: string; pid?: number } & EventOrigin;
  /** A task was failed on purpose (deadlock, manual force-fail). */
  "task:force-failed": { taskId: string; title: string; reason?: string } & EventOrigin;
  /** The agent produced new outcomes (files, text, media…) for a task. */
  "task:outcome": { taskId: string; outcomes: Array<{ id: string; type: string; label: string; mimeType?: string; path?: string }> };
  /** A lifecycle hook refused to mark the task done. */
  "task:complete-blocked": { taskId: string; reason: string };
  "task:direction": { taskId: string; action: TaskDirectionMode; direction: TaskDirection };

  // Agent lifecycle
  "agent:spawned": { taskId: string; agentName: string; taskTitle: string };
  "agent:finished": { taskId: string; agentName: string; exitCode: number; duration: number; sessionId?: string };
  "agent:activity": { taskId: string; agentName: string; tool?: string; file?: string; summary?: string };
  "agent:created": { agentName: string; teamName?: string; agents: AgentConfig[]; teams: Team[]; timestamp: string };
  "agent:updated": { agentName: string; agents: AgentConfig[]; teams: Team[]; timestamp: string };
  "agent:removed": { agentName: string; agents: AgentConfig[]; teams: Team[]; timestamp: string };
  "team:created": { teamName: string; agents: AgentConfig[]; teams: Team[]; timestamp: string };
  "team:updated": { oldName?: string; teamName: string; agents: AgentConfig[]; teams: Team[]; timestamp: string };
  "team:removed": { teamName: string; agents: AgentConfig[]; teams: Team[]; timestamp: string };

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
  /** Graceful shutdown started: `activeRuns` agents are still running. */
  "orchestrator:stopping": { activeRuns: number };
  /** The supervisor loop stopped (all work done in one-shot mode, stop requested, or a crash). */
  "orchestrator:stopped": { reason: "done" | "stopped" | "error"; message?: string };

  // Playbooks
  "playbook:changed": { name: string; action: "created" | "updated" | "deleted" | "installed" } & EventOrigin;
  /** A playbook was run: the mission it became (parameter names only, never values). */
  "playbook:run": { name: string; missionId: string; params: string[] } & EventOrigin;

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
  "mission:created": { missionId: string; name: string; status: MissionStatus } & EventOrigin;
  /**
   * A mission changed. `fields` for direct edits (name, status, schedule, data…); `section` +
   * `action` + `item` for edits inside its document (a task, a checkpoint, a delay…).
   */
  "mission:updated": {
    missionId: string; name: string; status: MissionStatus; prevStatus?: MissionStatus; fields?: string[];
    section?: "task" | "checkpoint" | "delay" | "qualityGate" | "team" | "notifications" | "order";
    action?: "added" | "updated" | "removed" | "reordered"; item?: string;
  } & EventOrigin;
  /** A mission was stopped: its running tasks were killed. */
  "mission:aborted": { missionId?: string; name?: string; group: string; killedTasks: number } & EventOrigin;
  "mission:executed": { missionId: string; group: string; taskCount: number };
  "mission:completed": { missionId: string; group: string; allPassed: boolean; report: MissionReport };
  "mission:resumed": { missionId: string; name: string; retried: number; pending: number };
  "mission:deleted": { missionId: string; deletedTasks?: number };

  // Chat sessions
  "session:created": { sessionId: string; title?: string };
  "session:updated": { sessionId: string; title?: string; starred?: boolean };
  "session:deleted": { sessionId: string };
  "message:added": { sessionId: string; messageId: string; role: "user" | "assistant" };
  /** The server started a chat turn on its own (queued prompt, undelivered steer, branch answer). */
  "chat:turn-started": { sessionId: string; turnId: string; reason: "queue" | "steer" | "fork" | "send-now"; userMessageId?: string };
  /** A session's prompt queue changed (items or auto-send). */
  "chat:queue-updated": { sessionId: string };

  // Rooms (group conversations of people and agents)
  "room:created": { room: import("./room-store.js").Room };
  "room:updated": { room: import("./room-store.js").Room };
  "room:deleted": { roomId: string };
  "room:message": { roomId: string; message: import("./room-store.js").RoomMessage };
  /** An agent started (typing: true) or finished (false) its turn in a room. */
  "room:typing": { roomId: string; agent: string; name: string; typing: boolean };

  // Durable background task waits
  "background-wait:created": { wait: BackgroundWait };
  "background-wait:ready": { wait: BackgroundWait };
  "background-wait:running": { wait: BackgroundWait };
  "background-wait:completed": { wait: BackgroundWait };
  "background-wait:failed": { wait: BackgroundWait };
  "background-wait:cancelled": { wait: BackgroundWait };
  "background-wait:requeued": { wait: BackgroundWait };

  // Approval gates
  "approval:requested": { requestId: string; gateId: string; gateName: string; taskId?: string; missionId?: string };
  "approval:resolved": { requestId: string; status: "approved" | "rejected"; resolvedBy?: string };
  "approval:rejected": { requestId: string; taskId?: string; feedback: string; rejectionCount: number; resolvedBy?: string };
  "approval:timeout": { requestId: string; action: "approve" | "reject" };
  /** An automatic gate's condition blocked an operation (no person involved). */
  "approval:auto-blocked": { gateId: string; gateName: string; hook: string; taskId?: string; missionId?: string };

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
  "schedule:updated": { scheduleId: string; missionId: string; expression: string; enabled: boolean; nextRunAt?: string } & EventOrigin;
  "schedule:removed": { scheduleId: string; missionId: string } & EventOrigin;
  /** A due schedule did not run (a hook refused it, or its mission is gone). */
  "schedule:skipped": { scheduleId: string; missionId: string; reason: string };

  // Registries and operational surfaces
  "app:changed": { appId: string; action: "created" | "updated" | "deleted" | "runtime" | "log"; resourceId?: string; timestamp: string };
  "data-source:changed": { sourceId: string; action: "created" | "updated" | "deleted" | "activity" | "data"; timestamp: string };
  "data-view:changed": { viewId: string; action: "created" | "updated" | "deleted"; timestamp: string };
  "skill:changed": { scope: "agent" | "orchestrator"; action: "created" | "updated" | "deleted" | "installed" | "assigned" | "unassigned" | "indexed"; skillName?: string; agentName?: string; timestamp: string };
  "token-usage:recorded": { timestamp: string };

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
  "watcher:action-completed": { watcherId: string; taskId: string; actionType: string; result?: string };
  "watcher:action-failed": { watcherId: string; taskId: string; actionType: string; error: string };

  // Notification rule actions
  "action:triggered": { ruleId: string; actionType: string; result?: string; error?: string };

  // Filesystem
  "file:changed": { path: string; dir: string; action: "created" | "modified" | "deleted" | "renamed"; source: "agent" | "server" | "chat" };

  // Company brain
  "brain:changed": import("./company-brain.js").BrainChangeEvent;

  // General
  "log": { level: "info" | "warn" | "error" | "debug"; message: string };
}

export type PolpoEvent = keyof PolpoEventMap;
