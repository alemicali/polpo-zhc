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
export type EventSource = "api" | "polpo" | "agent" | "channel" | "schedule" | "trigger" | "system";

/** Who caused an event: carried by events about changes (`by` is a person: email or channel contact id). */
export interface EventOrigin {
  source?: EventSource;
  by?: string;
  /** The scopes `by` acted under, when it came through Polpo's MCP connector (e.g. ["polpo:read", "polpo:work"]). */
  scopes?: string[];
}

export interface PolpoEventMap {
  // Task lifecycle
  "task:created": { task: Task };
  /** `reason` is set when the status was forced (recovery, races, manual set). */
  /** skipped: a decision node closed it without running (Task.result.skipped). */
  "task:transition": { taskId: string; from: TaskStatus; to: TaskStatus; task: Task; reason?: string; skipped?: boolean } & EventOrigin;
  /** Any change of a task's fields; `fields` names them (status changes are task:transition). */
  "task:updated": { taskId: string; task: Task; fields?: string[] } & EventOrigin;
  "task:removed": { taskId: string; title?: string; group?: string; missionId?: string } & EventOrigin;
  /** A person (or Polpo) asked to run a failed task again; automatic retries are task:retry. */
  "task:retried": { taskId: string; title: string } & EventOrigin;
  /** A running or waiting task was stopped on request. */
  "task:killed": { taskId: string; title: string; runId?: string; pid?: number } & EventOrigin;
  /**
   * A task was paused (a person, Polpo, or a blocking computer takeover nobody took): not scheduled
   * until resumed; `runId`: the run it stopped (resuming continues it). `pausedBy` is who asked.
   */
  "task:paused": { taskId: string; title: string; from: TaskStatus; reason?: string; pausedBy?: string; runId?: string; takeover?: { requestId: string; computerId: string } } & EventOrigin;
  /** A paused task was resumed: pending again; `continued`: its stopped run goes on as a continuation. */
  "task:resumed": { taskId: string; title: string; continued: boolean; resumedBy?: string; message?: string; reason?: string; pausedMs?: number; takeover?: { requestId: string; computerId: string } } & EventOrigin;
  /** A task was failed on purpose (deadlock, manual force-fail). */
  "task:force-failed": { taskId: string; title: string; reason?: string } & EventOrigin;
  /** The agent produced new outcomes (files, text, media…) for a task. */
  "task:outcome": { taskId: string; outcomes: Array<{ id: string; type: string; label: string; mimeType?: string; path?: string }> };
  /** A lifecycle hook refused to mark the task done. */
  "task:complete-blocked": { taskId: string; reason: string };
  "task:direction": { taskId: string; action: TaskDirectionMode; direction: TaskDirection };

  // Agent lifecycle
  /** engine: "polpo", "claude-code", "codex" or "opencode"; computerId: "host", a computer id or "ephemeral" (see Task.runs). */
  "agent:spawned": { taskId: string; agentName: string; taskTitle: string; engine?: import("./run-context.js").RunEngine; computerId?: string };
  "agent:finished": { taskId: string; agentName: string; exitCode: number; duration: number; sessionId?: string };
  "agent:activity": { taskId: string; agentName: string; tool?: string; file?: string; summary?: string };
  "agent:created": { agentName: string; teamName?: string; agents: AgentConfig[]; teams: Team[]; timestamp: string };
  "agent:updated": { agentName: string; agents: AgentConfig[]; teams: Team[]; timestamp: string };
  "agent:removed": { agentName: string; agents: AgentConfig[]; teams: Team[]; timestamp: string };
  /** An agent reviewed its conversations (learning): what it changed in its memory and own skills. */
  "agent:reflected": { agentName: string; trigger: "first" | "activity" | "daily" | "manual"; messages: number; summary: string; actions: string[]; timestamp: string };
  "agent:gate": { agentName: string; gateId: string; version: string; status: import("./agent-suite-gates.js").DeployGateStatus; trigger: import("./agent-suite-gates.js").DeployGateTrigger; progress: { done: number; total: number }; summary: string; timestamp: string };
  /** A benchmark run (agent suites phase 5) started, progressed, finished, was cancelled or stopped by its budget cap. */
  "benchmark:progress": { benchmarkRunId: string; benchmarkId?: string; name: string; status: import("./agent-suite-bench.js").BenchmarkRunStatus; stopReason?: "budget" | "cancelled" | "error"; progress: { runsDone: number; runsTotal: number; casesDone: number; casesTotal: number }; spentUsd: number; budgetUsd?: number; timestamp: string };
  "agent:learned": { agentName: string; messages: number; changes: { id: string; kind: "memory" | "skill-created" | "skill-updated"; target: string }[]; summary: string; timestamp: string };
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
  "orchestrator:tick": { pending: number; running: number; done: number; failed: number; queued: number; paused?: number };
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
  /** What the mission spent reached its budget: no new task starts and it pauses (running ones finish). */
  "mission:budget-exceeded": { missionId: string; name: string; spentUsd: number; budgetUsd: number; reason: string };
  /** The budget was raised or cleared: the mission paused by it goes on. */
  "mission:budget-resumed": { missionId: string; name: string; spentUsd: number; budgetUsd?: number };

  // Chat sessions
  "session:created": { sessionId: string; title?: string };
  "session:updated": { sessionId: string; title?: string; starred?: boolean };
  "session:deleted": { sessionId: string };
  "message:added": { sessionId: string; messageId: string; role: "user" | "assistant" };
  /** The server started a chat turn on its own (queued prompt, undelivered steer, branch answer). */
  "chat:turn-started": { sessionId: string; turnId: string; reason: "queue" | "steer" | "fork" | "send-now"; userMessageId?: string };
  /** A session's prompt queue changed (items or auto-send). */
  "chat:queue-updated": { sessionId: string };
  /** Two agents talking during a chat: an exchange started ("working"), was answered or failed. */
  "agent:message": {
    id: string; from: string; to: string; kind: "question" | "handoff"; message: string;
    status: "working" | "answered" | "failed"; answer?: string; error?: string;
    fromSessionId?: string; dmSessionId?: string; startedAt: string; answeredAt?: string;
  };

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
  "artifact:changed": { artifactId: string; action: "created" | "updated" | "deleted"; type: string; title: string; timestamp: string };
  "data-view:changed": { viewId: string; action: "created" | "updated" | "deleted"; timestamp: string };
  "skill:changed": { scope: "agent" | "orchestrator"; action: "created" | "updated" | "deleted" | "installed" | "assigned" | "unassigned" | "indexed"; skillName?: string; agentName?: string; timestamp: string };
  /** A skill version was published to production (a draft published, or a change applied directly). */
  "skill:published": { scope: "agent" | "orchestrator"; skillName: string; global?: boolean; version: string; versionNumber: number; previous?: string; bump?: string; author: string; note?: string; direct?: boolean; timestamp: string };
  /** A skill's production was rolled back to an earlier version. */
  "skill:rolled-back": { scope: "agent" | "orchestrator"; skillName: string; global?: boolean; from?: string; to: string; versionNumber: number; author: string; note?: string; timestamp: string };
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

  // Context compaction (chat sessions and task runs)
  /** A conversation or a task run was compacted to fit the model's window. */
  "context:compacted": {
    scope: "chat" | "task";
    sessionId?: string; taskId?: string; runId?: string; agentName?: string;
    reason: "budget" | "overflow" | "manual";
    mode: "prune" | "summary" | "fallback" | "truncate";
    beforeTokens: number; afterTokens: number; hardLimit: number;
    removedMessages: number; prunedToolResults: number; compactionCount: number; durationMs: number;
    model?: string; focus?: string; fallbackReason?: string;
    /** Durable facts saved to memory by this compaction. */
    savedFacts?: number;
  } & EventOrigin;
  /** A branch of a chat started with its parent's context checkpoint (no need to compact the copied history again). */
  "context:checkpoint-carried": {
    sessionId: string; parentSessionId: string; agentName?: string;
    /** Messages with text the carried summary covers. */
    coveredMessages: number;
    compactionCount: number;
  };

  // Sandboxes (where agents' tools run) and storage (mounted buckets)
  "sandbox:created": { workspaceId: string; provider: string; scope: "chat" | "task"; taskId?: string; runId?: string; sessionId?: string; agentName?: string; network: string };
  "sandbox:ready": { workspaceId: string; provider: string; durationMs: number; steps?: Record<string, number>; remoteId?: string; source?: "created" | "pool" | "warm" | "shared" | "computer"; agentName?: string; taskId?: string; sessionId?: string };
  "sandbox:suspended": { workspaceId: string; provider: string; remoteId?: string; agentName?: string; taskId?: string; sessionId?: string; idleMs: number };
  "sandbox:resumed": { workspaceId: string; provider: string; remoteId?: string; agentName?: string; taskId?: string; sessionId?: string; durationMs: number };
  "sandbox:override-denied": { scope: "chat" | "task"; taskId?: string; agentName?: string; level: "mission" | "task"; field: string; requested: unknown; applied: unknown };
  "sandbox:network-denied": { workspaceId?: string; provider: string; scope: "chat" | "task"; taskId?: string; agentName?: string; host: string; port?: number; reason: "not-allowed" | "private-address" };
  "sandbox:failed": { workspaceId?: string; provider: string; scope: "chat" | "task"; taskId?: string; sessionId?: string; error: string };
  "sandbox:destroyed": { workspaceId: string; provider: string; durationMs: number; reason: "done" | "idle" | "error" | "shutdown" | "expired" | "orphan"; remoteId?: string; outcome?: "pooled" | "destroyed" | "shared" | "kept"; runningMs?: number; agentName?: string; taskId?: string; sessionId?: string };
  /** open Polpo's volume.* events: attached, written back (checkpoint or end), revision conflict. */
  "sandbox:volume": { workspaceId: string; provider: string; step: "prepared" | "checkpointed" | "finalized" | "conflict"; name: string; revision?: number; message?: string; agentName?: string; taskId?: string; sessionId?: string };
  "storage:changed": { name: string; action: "created" | "updated" | "deleted" | "mounted" | "unmounted" | "mount-failed"; error?: string } & EventOrigin;
  /** A connector (MCP server) was added, changed, removed, or its connection status changed. */
  "connector:changed": import("./connectors.js").ConnectorChangedEvent & EventOrigin;
  /** A hosted MCP server changed: created, draft, published, deployed, settings, tests, pending (approval), deleted. */
  "mcp-server:changed": { id: string; what: string } & EventOrigin;
  /**
   * A computer (persistent machine, settings.computers) was created, changed, deleted, or its
   * machine changed status (creating, running, stopped, paused, hibernated, archived, error…).
   */
  "computer:changed": {
    id: string;
    action: "created" | "updated" | "deleted" | "status";
    status?: import("./computers.js").ComputerStatus;
    remoteId?: string;
    error?: string;
    /** Something worth knowing that is not an error (e.g. a Daytona v2 VM that vanished was restored from its snapshot). */
    notice?: string;
  } & EventOrigin;
  /**
   * Who holds a computer's desktop (its live view): a person took control or gave it back, an
   * agent asked a person to take over (request_computer_takeover: a login, 2FA, CAPTCHA), the
   * request timed out or was cancelled, the desktop started or stopped. Never carries the VNC
   * password or anything the person typed.
   */
  "computer:takeover": {
    id: string;
    /** parked: a hard (blocking) request nobody took in time: its task was paused, the request stays open. */
    action: "requested" | "taken" | "released" | "timeout" | "cancelled" | "parked" | "desktop-started" | "desktop-stopped";
    /** Who holds control now. */
    holder: "agent" | "person";
    /** The person (member email, or "someone" without member sign-in). */
    person?: string;
    requestId?: string;
    agent?: string;
    reason?: string;
    url?: string;
    /** The person's note to the agent (release). */
    note?: string;
    taskId?: string;
    sessionId?: string;
    /** soft (optional help: the agent goes on without it) or hard (blocking: its task pauses when the wait ends). */
    level?: "soft" | "hard";
    /** When the agent stops waiting (requested). */
    expiresAt?: string;
  } & EventOrigin;
  /**
   * A computer provider's webhook delivery (Daytona, E2B) was recorded in its event log
   * (`action: "recorded"`), or Polpo finished applying it (`"updated"`: the computer's status change).
   */
  "computer:webhook": {
    provider: string;
    /** The log entry's id (GET /computer-webhooks/:provider/events/:id). */
    id: string;
    action: "recorded" | "updated";
    outcome: "accepted" | "ignored" | "rejected" | "error";
    eventType?: string;
    computerId?: string;
  };

  /** A trigger (POST /hooks/{id}) was created, changed, deleted, or its secret rotated / HMAC secret set. */
  "trigger:changed": {
    id: string;
    action: "created" | "updated" | "deleted" | "secret-rotated" | "hmac-secret";
  } & EventOrigin;
  /**
   * A trigger recorded a delivery: accepted, rejected (auth, size, type, contract), filtered,
   * duplicate or rate_limited; `test` when sent from the dashboard / API / a tool. `mapped`: the
   * mapping's values (what the actions receive).
   */
  "trigger:delivery": {
    triggerId: string;
    deliveryId: string;
    status: "accepted" | "rejected" | "filtered" | "duplicate" | "rate_limited";
    httpStatus: number;
    test?: boolean;
    mapped?: Record<string, unknown>;
    /** The delivery's actions as a whole when it has some (queued on an accepted delivery; skipped by the loop guard). */
    actions?: "queued" | "running" | "done" | "failed" | "skipped" | "partial";
  };
  /**
   * A delivery's actions changed: one started, ended (done, failed, skipped) or was re-run. `actions`:
   * each action's run (status, attempts, times, error, refs to what it created).
   */
  "trigger:actions": {
    triggerId: string;
    deliveryId: string;
    status?: "queued" | "running" | "done" | "failed" | "skipped" | "partial";
    actions: Array<{
      actionId: string; kind: string; name?: string; status: "queued" | "running" | "done" | "failed" | "skipped"; attempts: number;
      queuedAt: string; startedAt?: string; endedAt?: string; error?: string; reason?: string; costUsd?: number;
      refs?: { playbook?: string; missionId?: string; missionName?: string; copyOf?: string; taskId?: string; sessionId?: string; agent?: string; notificationId?: string; channel?: string };
    }>;
  };

  /**
   * A decision was taken (decide(): REST, MCP, Polpo's chat, an agent's decide tool, a mission's
   * decision node, a suite's decision scorer) and recorded in the decision log — or failed.
   */
  "decision:made": {
    id: string;
    caller: string;
    callerId?: string;
    model: string;
    calibrated: boolean;
    uncertain: boolean;
    costUsd: number;
    status: "ok" | "error";
    error?: string;
  };
  /**
   * A coding chat (a Claude Code / Codex session of the Coding app, on a person's own CLI account)
   * was created, changed status (running, waiting for an approval, idle, error) or was deleted.
   */
  "coding:chat": {
    id: string;
    action: "created" | "updated" | "deleted";
    kind: "claude" | "codex";
    status: "idle" | "running" | "awaiting-approval" | "error";
    cwd: string;
    title: string;
    branch?: string;
    workspaceId?: string;
    owner?: string;
  };
  /** A mission's decision node is deciding, took a branch, or waits for a person to choose one. */
  "decision:node": {
    group: string;
    missionId?: string;
    node: string;
    status: "deciding" | "decided" | "awaiting";
    branch?: string | null;
    suggested?: string | null;
    decidedBy?: string;
    decisionId?: string;
    reason?: string;
    skipped?: number;
  };

  /**
   * An image request (generateImage / editImage: REST, MCP, Polpo's chat, an agent's image tools, a
   * mission's image node) was answered and recorded in the media log — or it failed.
   */
  "media:generated": {
    id: string;
    kind: "generate" | "edit";
    caller: string;
    callerId?: string;
    model: string;
    images: number;
    costUsd: number;
    status: "ok" | "error";
    error?: string;
  };
  /** A mission's image node is generating, made its image, or failed. */
  "media:node": {
    group: string;
    missionId?: string;
    node: string;
    status: "generating" | "done" | "failed";
    mediaId?: string;
    error?: string;
  };

  /**
   * A message of a WhatsApp Business channel changed status: Meta's status webhooks (sent,
   * delivered, read, failed), a send queued for approval, approved or rejected, an inbound message.
   */
  "channel:message-status": {
    channel: string;
    /** The message id (wamid, or the local id of a queued send). */
    messageId: string;
    status: string;
    direction: "in" | "out";
    /** The contact, masked (39•••••567). */
    contact?: string;
    error?: string;
    pricingCategory?: string;
  };
  /**
   * A structured WhatsApp Business event: a flow completed, an order, a payment, a button or list
   * reply, an address, a call permission answer, a reaction, a marketing preference, an account
   * update (quality, name review, templates, capabilities). `data` is the structured content.
   */
  "channel:wabiz-event": {
    channel: string;
    kind: string;
    /** The contact, masked (39•••••567). */
    contact?: string;
    messageId?: string;
    data: Record<string, unknown>;
  };
  /** A WhatsApp Business webhook delivery was recorded in the channel's event log, or its processing finished. */
  "channel:webhook": {
    channel: string;
    id: string;
    action: "recorded" | "updated";
    outcome: "accepted" | "ignored" | "rejected" | "error";
    eventType?: string;
  };

  // Company brain
  "brain:changed": import("./company-brain.js").BrainChangeEvent;

  // General
  "log": { level: "info" | "warn" | "error" | "debug"; message: string };
}

export type PolpoEvent = keyof PolpoEventMap;
