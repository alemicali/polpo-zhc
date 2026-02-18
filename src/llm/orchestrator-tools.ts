/**
 * Polpo tools — the complete tool surface for Polpo's conversational interface.
 *
 * Read tools execute immediately. Write tools may require user approval
 * depending on the current approval mode (approval vs accept-all).
 *
 * These tools are used by both the TUI chat and the OpenAI-compatible
 * /v1/chat/completions endpoint.
 */

import { Type } from "@sinclair/typebox";
import type { Tool } from "@mariozechner/pi-ai";
import type { Orchestrator } from "../core/orchestrator.js";
import type { ApprovalStatus } from "../core/types.js";
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "fs";
import { join } from "path";

// ═══════════════════════════════════════════════════════
//  READ TOOLS (12)
// ═══════════════════════════════════════════════════════

const getStatusTool: Tool = {
  name: "get_status",
  description: "Get a full overview: task counts, active processes, team info, plans, memory status, pending approvals, active checkpoints.",
  parameters: Type.Object({}),
};

const listTasksTool: Tool = {
  name: "list_tasks",
  description: "List all tasks. Optionally filter by status, group, or assigned agent.",
  parameters: Type.Object({
    status: Type.Optional(Type.String({ description: "Filter by status: pending, assigned, in_progress, review, done, failed" })),
    group: Type.Optional(Type.String({ description: "Filter by plan group name" })),
    assignTo: Type.Optional(Type.String({ description: "Filter by agent name" })),
  }),
};

const getTaskTool: Tool = {
  name: "get_task",
  description: "Get full details of a task by ID or title (partial match).",
  parameters: Type.Object({
    id: Type.Optional(Type.String({ description: "Task ID" })),
    title: Type.Optional(Type.String({ description: "Task title (partial match)" })),
  }),
};

const listPlansTool: Tool = {
  name: "list_plans",
  description: "List all plans. Optionally filter by status.",
  parameters: Type.Object({
    status: Type.Optional(Type.String({ description: "Filter by status: draft, active, paused, completed, failed, cancelled" })),
  }),
};

const getPlanTool: Tool = {
  name: "get_plan",
  description: "Get full details of a plan by ID or name (partial match).",
  parameters: Type.Object({
    id: Type.Optional(Type.String({ description: "Plan ID" })),
    name: Type.Optional(Type.String({ description: "Plan name (partial match)" })),
  }),
};

const listAgentsTool: Tool = {
  name: "list_agents",
  description: "List all configured agents with their roles, models, skills, and system prompts.",
  parameters: Type.Object({}),
};

const getTeamTool: Tool = {
  name: "get_team",
  description: "Get full team info: name, description, and all agents with their configuration.",
  parameters: Type.Object({}),
};

const getMemoryTool: Tool = {
  name: "get_memory",
  description: "Read the project memory content (.polpo/memory.md).",
  parameters: Type.Object({}),
};

const getConfigTool: Tool = {
  name: "get_config",
  description: "Get the current Polpo configuration: settings, models, providers, notification rules, approval gates, SLA config.",
  parameters: Type.Object({}),
};

const listApprovalsTool: Tool = {
  name: "list_approvals",
  description: "List approval requests. Optionally filter by status.",
  parameters: Type.Object({
    status: Type.Optional(Type.String({ description: "Filter: pending, approved, rejected, timeout" })),
  }),
};

const listCheckpointsTool: Tool = {
  name: "list_checkpoints",
  description: "List all active (unresumed) checkpoints across plans.",
  parameters: Type.Object({}),
};

const getLogsTool: Tool = {
  name: "get_logs",
  description: "List agent log sessions, or get log entries for a specific session.",
  parameters: Type.Object({
    sessionId: Type.Optional(Type.String({ description: "Session ID to get entries for. Omit to list all sessions." })),
  }),
};

// ═══════════════════════════════════════════════════════
//  TASK TOOLS (8)
// ═══════════════════════════════════════════════════════

const createTaskTool: Tool = {
  name: "create_task",
  description: "Create a new task and assign it to an agent.",
  parameters: Type.Object({
    title: Type.String({ description: "Task title" }),
    description: Type.String({ description: "Detailed task description" }),
    assignTo: Type.String({ description: "Agent name to assign the task to" }),
    dependsOn: Type.Optional(Type.Array(Type.String(), { description: "IDs of tasks this depends on" })),
    group: Type.Optional(Type.String({ description: "Plan group name" })),
    expectations: Type.Optional(Type.Array(Type.Object({
      type: Type.String({ description: "test, file_exists, script, or llm_review" }),
      command: Type.Optional(Type.String()),
      paths: Type.Optional(Type.Array(Type.String())),
      criteria: Type.Optional(Type.String()),
      threshold: Type.Optional(Type.Number()),
    }), { description: "Acceptance criteria for this task" })),
  }),
};

const updateTaskTool: Tool = {
  name: "update_task",
  description: "Update a task's description, assignment, or expectations.",
  parameters: Type.Object({
    taskId: Type.String({ description: "Task ID to update" }),
    description: Type.Optional(Type.String({ description: "New description" })),
    assignTo: Type.Optional(Type.String({ description: "New agent assignment" })),
    expectations: Type.Optional(Type.Array(Type.Object({
      type: Type.String({ description: "test, file_exists, script, or llm_review" }),
      command: Type.Optional(Type.String()),
      paths: Type.Optional(Type.Array(Type.String())),
      criteria: Type.Optional(Type.String()),
      threshold: Type.Optional(Type.Number()),
    }), { description: "New acceptance criteria" })),
  }),
};

const deleteTaskTool: Tool = {
  name: "delete_task",
  description: "Delete a single task by ID.",
  parameters: Type.Object({
    taskId: Type.String({ description: "Task ID to delete" }),
  }),
};

const deleteTasksTool: Tool = {
  name: "delete_tasks",
  description: "Delete multiple tasks matching a filter.",
  parameters: Type.Object({
    status: Type.Optional(Type.String({ description: "Delete tasks with this status" })),
    group: Type.Optional(Type.String({ description: "Delete tasks in this plan group" })),
    all: Type.Optional(Type.Boolean({ description: "Delete ALL tasks (use with caution)" })),
  }),
};

const retryTaskTool: Tool = {
  name: "retry_task",
  description: "Retry a failed task — resets it to pending status.",
  parameters: Type.Object({
    taskId: Type.String({ description: "Task ID to retry" }),
  }),
};

const killTaskTool: Tool = {
  name: "kill_task",
  description: "Kill a running task's agent process.",
  parameters: Type.Object({
    taskId: Type.String({ description: "Task ID to kill" }),
  }),
};

const reassessTaskTool: Tool = {
  name: "reassess_task",
  description: "Re-run the review pipeline on a completed task.",
  parameters: Type.Object({
    taskId: Type.String({ description: "Task ID to reassess" }),
  }),
};

const forceFailTaskTool: Tool = {
  name: "force_fail_task",
  description: "Force a stuck task into failed status.",
  parameters: Type.Object({
    taskId: Type.String({ description: "Task ID to force-fail" }),
  }),
};

// ═══════════════════════════════════════════════════════
//  PLAN TOOLS (6)
// ═══════════════════════════════════════════════════════

const createPlanTool: Tool = {
  name: "create_plan",
  description: "Create a new plan. Provide the plan content as a JSON string with tasks, dependencies, expectations, and optionally quality gates.",
  parameters: Type.Object({
    name: Type.String({ description: "Plan name" }),
    data: Type.String({ description: "JSON plan content (tasks array, qualityGates, etc.)" }),
    prompt: Type.Optional(Type.String({ description: "Original user request that generated this plan" })),
  }),
};

const updatePlanTool: Tool = {
  name: "update_plan",
  description: "Update an existing plan's name, content, or status.",
  parameters: Type.Object({
    planId: Type.String({ description: "Plan ID to update" }),
    name: Type.Optional(Type.String({ description: "New plan name" })),
    data: Type.Optional(Type.String({ description: "New JSON plan content" })),
    status: Type.Optional(Type.String({ description: "New status: draft, active, paused, completed, failed, cancelled" })),
  }),
};

const executePlanTool: Tool = {
  name: "execute_plan",
  description: "Execute a draft plan — creates tasks for all plan items and starts the work.",
  parameters: Type.Object({
    planId: Type.String({ description: "Plan ID to execute" }),
  }),
};

const resumePlanTool: Tool = {
  name: "resume_plan",
  description: "Resume a failed or active plan. Optionally retry failed tasks.",
  parameters: Type.Object({
    planId: Type.String({ description: "Plan ID to resume" }),
    retryFailed: Type.Optional(Type.Boolean({ description: "Also retry failed tasks (default: false)" })),
  }),
};

const abortPlanTool: Tool = {
  name: "abort_plan",
  description: "Abort all tasks in a plan — kills running processes and marks tasks as failed.",
  parameters: Type.Object({
    planId: Type.String({ description: "Plan ID to abort" }),
  }),
};

const deletePlanTool: Tool = {
  name: "delete_plan",
  description: "Delete a plan.",
  parameters: Type.Object({
    planId: Type.String({ description: "Plan ID to delete" }),
  }),
};

// ═══════════════════════════════════════════════════════
//  TEAM & AGENT TOOLS (4)
// ═══════════════════════════════════════════════════════

const addAgentTool: Tool = {
  name: "add_agent",
  description: "Add a new agent to the team.",
  parameters: Type.Object({
    name: Type.String({ description: "Agent name (unique identifier)" }),
    role: Type.Optional(Type.String({ description: "Agent role description (e.g. 'Frontend developer')" })),
    model: Type.Optional(Type.String({ description: "LLM model (e.g. 'claude-sonnet-4-5-20250929', 'gpt-4o')" })),
    systemPrompt: Type.Optional(Type.String({ description: "Custom system prompt for this agent" })),
    skills: Type.Optional(Type.Array(Type.String(), { description: "Skill names to assign" })),
    allowedPaths: Type.Optional(Type.Array(Type.String(), { description: "Filesystem paths this agent can access" })),
  }),
};

const removeAgentTool: Tool = {
  name: "remove_agent",
  description: "Remove an agent from the team.",
  parameters: Type.Object({
    name: Type.String({ description: "Agent name to remove" }),
  }),
};

const updateAgentTool: Tool = {
  name: "update_agent",
  description: "Update an existing agent's configuration (model, role, system prompt, skills, paths).",
  parameters: Type.Object({
    name: Type.String({ description: "Agent name to update" }),
    role: Type.Optional(Type.String({ description: "New role description" })),
    model: Type.Optional(Type.String({ description: "New LLM model" })),
    systemPrompt: Type.Optional(Type.String({ description: "New system prompt" })),
    skills: Type.Optional(Type.Array(Type.String(), { description: "New skill list (replaces existing)" })),
    allowedPaths: Type.Optional(Type.Array(Type.String(), { description: "New allowed paths (replaces existing)" })),
  }),
};

const renameTeamTool: Tool = {
  name: "rename_team",
  description: "Rename the team.",
  parameters: Type.Object({
    name: Type.String({ description: "New team name" }),
  }),
};

// ═══════════════════════════════════════════════════════
//  APPROVAL & CHECKPOINT TOOLS (3)
// ═══════════════════════════════════════════════════════

const approveRequestTool: Tool = {
  name: "approve_request",
  description: "Approve a pending approval request.",
  parameters: Type.Object({
    requestId: Type.String({ description: "Approval request ID" }),
    note: Type.Optional(Type.String({ description: "Optional note" })),
  }),
};

const rejectRequestTool: Tool = {
  name: "reject_request",
  description: "Reject a pending approval request with feedback.",
  parameters: Type.Object({
    requestId: Type.String({ description: "Approval request ID" }),
    feedback: Type.String({ description: "Rejection feedback" }),
  }),
};

const resumeCheckpointTool: Tool = {
  name: "resume_checkpoint",
  description: "Resume a blocked checkpoint in a plan.",
  parameters: Type.Object({
    planId: Type.String({ description: "Plan ID" }),
    checkpointName: Type.String({ description: "Checkpoint name to resume" }),
  }),
};

// ═══════════════════════════════════════════════════════
//  SCHEDULING TOOLS (4)
// ═══════════════════════════════════════════════════════

const createScheduleTool: Tool = {
  name: "create_schedule",
  description: "Schedule a plan for future or recurring execution. Supports cron expressions (minimum 1 minute) and ISO timestamps.",
  parameters: Type.Object({
    planId: Type.String({ description: "Plan ID to schedule" }),
    expression: Type.String({ description: "Cron expression (e.g. '*/5 * * * *' = every 5 min) or ISO timestamp for one-shot" }),
    recurring: Type.Optional(Type.Boolean({ description: "Repeat on every cron tick (default: false = one-shot)" })),
  }),
};

const listSchedulesTool: Tool = {
  name: "list_schedules",
  description: "List all schedules (active and inactive).",
  parameters: Type.Object({
    active: Type.Optional(Type.Boolean({ description: "If true, only show active (enabled) schedules" })),
  }),
};

const deleteScheduleTool: Tool = {
  name: "delete_schedule",
  description: "Delete a schedule by plan ID.",
  parameters: Type.Object({
    planId: Type.String({ description: "Plan ID whose schedule to delete" }),
  }),
};

const updateScheduleTool: Tool = {
  name: "update_schedule",
  description: "Update a schedule's expression, recurring flag, or enabled state.",
  parameters: Type.Object({
    planId: Type.String({ description: "Plan ID whose schedule to update" }),
    expression: Type.Optional(Type.String({ description: "New cron expression or ISO timestamp" })),
    recurring: Type.Optional(Type.Boolean({ description: "New recurring flag" })),
    enabled: Type.Optional(Type.Boolean({ description: "Enable or disable the schedule" })),
  }),
};

// ═══════════════════════════════════════════════════════
//  NOTIFICATION RULE TOOLS (4)
// ═══════════════════════════════════════════════════════

const addNotificationRuleTool: Tool = {
  name: "add_notification_rule",
  description: "Add a notification rule that triggers on events. Can include action triggers (create_task, execute_plan, run_script, send_notification) in addition to channel notifications.",
  parameters: Type.Object({
    name: Type.String({ description: "Rule name" }),
    events: Type.Array(Type.String(), { description: "Event patterns (glob: 'task:*', 'plan:completed', etc.)" }),
    channels: Type.Optional(Type.Array(Type.String(), { description: "Channel IDs to notify. Omit if using actions only." })),
    condition: Type.Optional(Type.String({ description: "JSON condition string, e.g. '{\"field\":\"to\",\"op\":\"==\",\"value\":\"done\"}'" })),
    severity: Type.Optional(Type.String({ description: "info, warning, or critical" })),
    cooldownMs: Type.Optional(Type.Number({ description: "Minimum ms between notifications for this rule" })),
    actions: Type.Optional(Type.Array(Type.Object({
      type: Type.String({ description: "create_task, execute_plan, run_script, or send_notification" }),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      assignTo: Type.Optional(Type.String()),
      planId: Type.Optional(Type.String()),
      command: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Number()),
      channel: Type.Optional(Type.String()),
      body: Type.Optional(Type.String()),
    }), { description: "Actions to execute when this rule fires" })),
  }),
};

const listNotificationRulesTool: Tool = {
  name: "list_notification_rules",
  description: "List all notification rules (global).",
  parameters: Type.Object({}),
};

const removeNotificationRuleTool: Tool = {
  name: "remove_notification_rule",
  description: "Remove a notification rule by ID.",
  parameters: Type.Object({
    ruleId: Type.String({ description: "Rule ID to remove" }),
  }),
};

const sendNotificationTool: Tool = {
  name: "send_notification",
  description: "Send a direct notification to a channel, bypassing rules. Optionally delayed.",
  parameters: Type.Object({
    channel: Type.String({ description: "Channel ID to send to" }),
    title: Type.String({ description: "Notification title" }),
    body: Type.String({ description: "Notification body" }),
    severity: Type.Optional(Type.String({ description: "info, warning, or critical" })),
    delayMs: Type.Optional(Type.Number({ description: "Delay before sending (ms)" })),
  }),
};

// ═══════════════════════════════════════════════════════
//  TASK WATCHER TOOLS (3)
// ═══════════════════════════════════════════════════════

const watchTaskTool: Tool = {
  name: "watch_task",
  description: "Set up an event-driven watcher on a task. When the task reaches the target status, the specified action fires automatically. No polling — uses the internal event system.",
  parameters: Type.Object({
    taskId: Type.String({ description: "Task ID to watch" }),
    targetStatus: Type.String({ description: "Status to trigger on: done, failed, review, etc." }),
    action: Type.Object({
      type: Type.String({ description: "create_task, execute_plan, run_script, or send_notification" }),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      assignTo: Type.Optional(Type.String()),
      planId: Type.Optional(Type.String()),
      command: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Number()),
      channel: Type.Optional(Type.String()),
      body: Type.Optional(Type.String()),
    }, { description: "Action to execute when triggered" }),
  }),
};

const listWatchersTool: Tool = {
  name: "list_watchers",
  description: "List all task watchers (active and fired).",
  parameters: Type.Object({
    active: Type.Optional(Type.Boolean({ description: "If true, only show active (unfired) watchers" })),
  }),
};

const removeWatcherTool: Tool = {
  name: "remove_watcher",
  description: "Remove a task watcher by ID.",
  parameters: Type.Object({
    watcherId: Type.String({ description: "Watcher ID to remove" }),
  }),
};

// ═══════════════════════════════════════════════════════
//  CONFIG & SELF-MODIFICATION TOOLS (4)
// ═══════════════════════════════════════════════════════

const reloadConfigTool: Tool = {
  name: "reload_config",
  description: "Hot-reload polpo.json from disk. Picks up changes to settings, team, providers, notifications, approvals, SLA, scheduling.",
  parameters: Type.Object({}),
};

const saveMemoryTool: Tool = {
  name: "save_memory",
  description: "Overwrite the project memory (.polpo/memory.md) with new content.",
  parameters: Type.Object({
    content: Type.String({ description: "New memory content (replaces everything)" }),
  }),
};

const appendMemoryTool: Tool = {
  name: "append_memory",
  description: "Append a line to the project memory without overwriting existing content.",
  parameters: Type.Object({
    content: Type.String({ description: "Content to append" }),
  }),
};

const appendSystemContextTool: Tool = {
  name: "append_system_context",
  description: "Add persistent instructions to Polpo's system context (.polpo/system-context.md). These are included in every future conversation. Use when the user says 'remember that...' or gives you a standing instruction about the project.",
  parameters: Type.Object({
    content: Type.String({ description: "Instruction or context to remember permanently" }),
  }),
};

// ═══════════════════════════════════════════════════════
//  TOOL COLLECTIONS
// ═══════════════════════════════════════════════════════

export const READ_TOOLS = new Set([
  "get_status", "list_tasks", "get_task", "list_plans", "get_plan",
  "list_agents", "get_team", "get_memory", "get_config",
  "list_approvals", "list_checkpoints", "get_logs",
  // Read-only listing tools
  "list_schedules", "list_notification_rules", "list_watchers",
]);

export const WRITE_TOOLS = new Set([
  // Task
  "create_task", "update_task", "delete_task", "delete_tasks",
  "retry_task", "kill_task", "reassess_task", "force_fail_task",
  // Plan
  "create_plan", "update_plan", "execute_plan", "resume_plan", "abort_plan", "delete_plan",
  // Team
  "add_agent", "remove_agent", "update_agent", "rename_team",
  // Approvals & Checkpoints
  "approve_request", "reject_request", "resume_checkpoint",
  // Scheduling
  "create_schedule", "delete_schedule", "update_schedule",
  // Notification rules
  "add_notification_rule", "remove_notification_rule", "send_notification",
  // Task watchers
  "watch_task", "remove_watcher",
  // Config & Self
  "reload_config", "save_memory", "append_memory", "append_system_context",
]);

export function needsApproval(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}

export const ALL_ORCHESTRATOR_TOOLS: Tool[] = [
  // Read (15)
  getStatusTool, listTasksTool, getTaskTool, listPlansTool, getPlanTool,
  listAgentsTool, getTeamTool, getMemoryTool, getConfigTool,
  listApprovalsTool, listCheckpointsTool, getLogsTool,
  listSchedulesTool, listNotificationRulesTool, listWatchersTool,
  // Task (8)
  createTaskTool, updateTaskTool, deleteTaskTool, deleteTasksTool,
  retryTaskTool, killTaskTool, reassessTaskTool, forceFailTaskTool,
  // Plan (6)
  createPlanTool, updatePlanTool, executePlanTool, resumePlanTool, abortPlanTool, deletePlanTool,
  // Team (4)
  addAgentTool, removeAgentTool, updateAgentTool, renameTeamTool,
  // Approvals & Checkpoints (3)
  approveRequestTool, rejectRequestTool, resumeCheckpointTool,
  // Scheduling (3 write + 1 read above)
  createScheduleTool, deleteScheduleTool, updateScheduleTool,
  // Notification rules (2 write + 1 read above + 1 direct send)
  addNotificationRuleTool, removeNotificationRuleTool, sendNotificationTool,
  // Task watchers (2 write + 1 read above)
  watchTaskTool, removeWatcherTool,
  // Config & Self (4)
  reloadConfigTool, saveMemoryTool, appendMemoryTool, appendSystemContextTool,
];

/** Tool action labels for the approval prompt title. */
const TOOL_LABELS: Record<string, string> = {
  create_task: "Create Task",
  update_task: "Update Task",
  delete_task: "Delete Task",
  delete_tasks: "Delete Tasks",
  retry_task: "Retry Task",
  kill_task: "Kill Task",
  reassess_task: "Reassess Task",
  force_fail_task: "Force Fail Task",
  create_plan: "Create Plan",
  update_plan: "Update Plan",
  execute_plan: "Execute Plan",
  resume_plan: "Resume Plan",
  abort_plan: "Abort Plan",
  delete_plan: "Delete Plan",
  add_agent: "Add Agent",
  remove_agent: "Remove Agent",
  update_agent: "Update Agent",
  rename_team: "Rename Team",
  approve_request: "Approve Request",
  reject_request: "Reject Request",
  resume_checkpoint: "Resume Checkpoint",
  // Scheduling
  create_schedule: "Create Schedule",
  delete_schedule: "Delete Schedule",
  update_schedule: "Update Schedule",
  // Notification rules
  add_notification_rule: "Add Notification Rule",
  remove_notification_rule: "Remove Notification Rule",
  send_notification: "Send Notification",
  // Task watchers
  watch_task: "Watch Task",
  remove_watcher: "Remove Watcher",
  // Config & Self
  reload_config: "Reload Config",
  save_memory: "Save Memory",
  append_memory: "Append Memory",
  append_system_context: "Remember",
};

// ═══════════════════════════════════════════════════════
//  EXECUTOR
// ═══════════════════════════════════════════════════════

export function executeOrchestratorTool(
  toolName: string,
  args: Record<string, unknown>,
  polpo: Orchestrator,
): string {
  try {
    switch (toolName) {
      // ── Read ──
      case "get_status":       return execGetStatus(polpo);
      case "list_tasks":       return execListTasks(polpo, args);
      case "get_task":         return execGetTask(polpo, args);
      case "list_plans":       return execListPlans(polpo, args);
      case "get_plan":         return execGetPlan(polpo, args);
      case "list_agents":      return execListAgents(polpo);
      case "get_team":         return execGetTeam(polpo);
      case "get_memory":       return execGetMemory(polpo);
      case "get_config":       return execGetConfig(polpo);
      case "list_approvals":   return execListApprovals(polpo, args);
      case "list_checkpoints": return execListCheckpoints(polpo);
      case "get_logs":         return execGetLogs(polpo, args);

      // ── Task ──
      case "create_task":      return execCreateTask(polpo, args);
      case "update_task":      return execUpdateTask(polpo, args);
      case "delete_task":      return execDeleteTask(polpo, args);
      case "delete_tasks":     return execDeleteTasks(polpo, args);
      case "retry_task":       return execRetryTask(polpo, args);
      case "kill_task":        return execKillTask(polpo, args);
      case "reassess_task":    return execReassessTask(polpo, args);
      case "force_fail_task":  return execForceFailTask(polpo, args);

      // ── Plan ──
      case "create_plan":      return execCreatePlan(polpo, args);
      case "update_plan":      return execUpdatePlan(polpo, args);
      case "execute_plan":     return execExecutePlan(polpo, args);
      case "resume_plan":      return execResumePlan(polpo, args);
      case "abort_plan":       return execAbortPlan(polpo, args);
      case "delete_plan":      return execDeletePlan(polpo, args);

      // ── Team ──
      case "add_agent":        return execAddAgent(polpo, args);
      case "remove_agent":     return execRemoveAgent(polpo, args);
      case "update_agent":     return execUpdateAgent(polpo, args);
      case "rename_team":      return execRenameTeam(polpo, args);

      // ── Approvals & Checkpoints ──
      case "approve_request":    return execApproveRequest(polpo, args);
      case "reject_request":     return execRejectRequest(polpo, args);
      case "resume_checkpoint":  return execResumeCheckpoint(polpo, args);

      // ── Scheduling ──
      case "create_schedule":      return execCreateSchedule(polpo, args);
      case "list_schedules":       return execListSchedules(polpo, args);
      case "delete_schedule":      return execDeleteSchedule(polpo, args);
      case "update_schedule":      return execUpdateSchedule(polpo, args);

      // ── Notification Rules ──
      case "add_notification_rule":    return execAddNotificationRule(polpo, args);
      case "list_notification_rules":  return execListNotificationRules(polpo);
      case "remove_notification_rule": return execRemoveNotificationRule(polpo, args);
      case "send_notification":        return execSendNotification(polpo, args);

      // ── Task Watchers ──
      case "watch_task":          return execWatchTask(polpo, args);
      case "list_watchers":       return execListWatchers(polpo, args);
      case "remove_watcher":      return execRemoveWatcher(polpo, args);

      // ── Config & Self ──
      case "reload_config":        return execReloadConfig(polpo);
      case "save_memory":          return execSaveMemory(polpo, args);
      case "append_memory":        return execAppendMemory(polpo, args);
      case "append_system_context": return execAppendSystemContext(polpo, args);

      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: ${msg}`;
  }
}

/**
 * Format the approval prompt title — short action label + target name.
 */
export function formatToolDescription(
  toolName: string,
  args: Record<string, unknown>,
  polpo?: Orchestrator,
): string {
  const label = TOOL_LABELS[toolName] ?? toolName;
  const target = resolveTargetName(toolName, args, polpo);
  return target ? `${label}: ${target}` : label;
}

/** Resolve a human-readable target name from args. */
function resolveTargetName(
  toolName: string,
  args: Record<string, unknown>,
  polpo?: Orchestrator,
): string | null {
  if (args.taskId && polpo) {
    try {
      const state = polpo.getStore()?.getState();
      const task = state?.tasks.find(t => t.id === args.taskId);
      if (task) return `"${task.title}"`;
    } catch { /* ignore */ }
    return String(args.taskId);
  }
  if (args.planId && polpo) {
    try {
      const plan = polpo.getPlan(String(args.planId));
      if (plan) return `"${plan.name}"`;
    } catch { /* ignore */ }
    return String(args.planId);
  }
  if (args.requestId) return String(args.requestId);
  if (toolName === "create_task" && args.title) return `"${String(args.title)}"`;
  if (toolName === "create_plan" && args.name) return `"${String(args.name)}"`;
  if (toolName === "add_agent" && args.name) return `"${String(args.name)}"`;
  if (toolName === "remove_agent" && args.name) return `"${String(args.name)}"`;
  if (toolName === "update_agent" && args.name) return `"${String(args.name)}"`;
  if (toolName === "rename_team" && args.name) return `"${String(args.name)}"`;
  if (toolName === "delete_tasks") {
    if (args.all) return "ALL tasks";
    if (args.group) return `group "${args.group}"`;
    if (args.status) return `status: ${args.status}`;
  }
  return null;
}

/**
 * Structured detail lines for the approval prompt.
 */
export function formatToolDetails(
  toolName: string,
  args: Record<string, unknown>,
  polpo?: Orchestrator,
): { main: Array<[string, string]>; extra: Array<[string, string]> } {
  const main: Array<[string, string]> = [];
  const extra: Array<[string, string]> = [];
  const trunc = (v: unknown, max = 100): string => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > max ? s.slice(0, max - 3) + "..." : s;
  };

  const resolveTask = (id: unknown): string => {
    if (!polpo || !id) return String(id);
    try {
      const state = polpo.getStore()?.getState();
      const task = state?.tasks.find(t => t.id === id);
      return task ? `${task.title} (${id})` : String(id);
    } catch { return String(id); }
  };
  const resolvePlan = (id: unknown): string => {
    if (!polpo || !id) return String(id);
    try {
      const plan = polpo.getPlan(String(id));
      return plan ? `${plan.name} (${id})` : String(id);
    } catch { return String(id); }
  };

  const actionLabel = TOOL_LABELS[toolName] ?? toolName;
  main.push(["Action", actionLabel]);

  switch (toolName) {
    case "create_task":
      main.push(["Title", trunc(args.title)]);
      main.push(["Agent", String(args.assignTo)]);
      if (args.group) main.push(["Group", String(args.group)]);
      if (args.description) extra.push(["Description", trunc(args.description, 200)]);
      if (args.dependsOn) extra.push(["Depends on", trunc(args.dependsOn)]);
      break;
    case "update_task":
      main.push(["Task", resolveTask(args.taskId)]);
      if (args.assignTo) main.push(["New agent", String(args.assignTo)]);
      if (args.description) extra.push(["New description", trunc(args.description, 200)]);
      break;
    case "create_plan":
      main.push(["Name", trunc(args.name)]);
      if (args.data) extra.push(["Content", trunc(args.data, 300)]);
      break;
    case "add_agent":
      main.push(["Name", String(args.name)]);
      if (args.role) main.push(["Role", trunc(args.role)]);
      if (args.model) main.push(["Model", String(args.model)]);
      break;
    case "update_agent":
      main.push(["Agent", String(args.name)]);
      if (args.model) main.push(["New model", String(args.model)]);
      if (args.role) main.push(["New role", trunc(args.role)]);
      break;
    case "delete_task":
    case "retry_task":
    case "kill_task":
    case "reassess_task":
    case "force_fail_task":
      main.push(["Task", resolveTask(args.taskId)]);
      break;
    case "execute_plan":
    case "resume_plan":
    case "abort_plan":
    case "delete_plan":
      main.push(["Plan", resolvePlan(args.planId)]);
      if (args.retryFailed) main.push(["Retry failed", "yes"]);
      break;
    case "delete_tasks":
      if (args.all) main.push(["Scope", "ALL tasks"]);
      if (args.status) main.push(["Status filter", String(args.status)]);
      if (args.group) main.push(["Group filter", String(args.group)]);
      break;
    case "save_memory":
    case "append_memory":
    case "append_system_context":
      main.push(["Content length", `${String(args.content ?? "").length} chars`]);
      extra.push(["Content", trunc(args.content, 300)]);
      break;
    default:
      for (const [k, v] of Object.entries(args)) {
        if (v !== undefined && v !== null) main.push([k, trunc(v)]);
      }
  }
  return { main, extra };
}

// ═══════════════════════════════════════════════════════
//  READ IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════

function execGetStatus(polpo: Orchestrator): string {
  const state = polpo.getStore().getState();
  const tasks = state.tasks;
  const processes = state.processes;
  const agents = polpo.getAgents();
  const team = polpo.getTeam();

  const counts: Record<string, number> = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;

  const lines: string[] = [
    `Project: ${state.project}`,
    `Team: ${team.name} (${agents.length} agents)`,
    `Tasks: ${tasks.length} total`,
  ];
  for (const [status, count] of Object.entries(counts)) lines.push(`  ${status}: ${count}`);

  const alive = processes.filter(p => p.alive);
  lines.push(`Active processes: ${alive.length}`);
  for (const p of alive) lines.push(`  ${p.agentName} → task ${p.taskId}`);

  const plans = polpo.getAllPlans();
  if (plans.length > 0) {
    lines.push(`Plans: ${plans.length} total`);
    const planCounts: Record<string, number> = {};
    for (const p of plans) planCounts[p.status] = (planCounts[p.status] || 0) + 1;
    for (const [status, count] of Object.entries(planCounts)) lines.push(`  ${status}: ${count}`);
  }

  if (polpo.hasMemory()) lines.push("Memory: available");

  const pending = polpo.getPendingApprovals?.();
  if (pending?.length) lines.push(`Pending approvals: ${pending.length}`);

  const checkpoints = polpo.getActiveCheckpoints?.();
  if (checkpoints?.length) lines.push(`Active checkpoints: ${checkpoints.length}`);

  return lines.join("\n");
}

function execListTasks(polpo: Orchestrator, args: Record<string, unknown>): string {
  const state = polpo.getStore().getState();
  let tasks = state.tasks;
  if (args.status) tasks = tasks.filter(t => t.status === args.status);
  if (args.group) tasks = tasks.filter(t => t.group === args.group);
  if (args.assignTo) tasks = tasks.filter(t => t.assignTo === args.assignTo);
  if (tasks.length === 0) return "No tasks found.";
  const lines = tasks.map(t =>
    `[${t.id}] ${t.status.toUpperCase().padEnd(11)} ${t.title} → ${t.assignTo}${t.group ? ` (${t.group})` : ""}`
  );
  return `${tasks.length} task(s):\n${lines.join("\n")}`;
}

function execGetTask(polpo: Orchestrator, args: Record<string, unknown>): string {
  const store = polpo.getStore();
  let task;
  if (args.id) task = store.getTask(args.id as string);
  if (!task && args.title) {
    const needle = (args.title as string).toLowerCase();
    task = store.getAllTasks().find(t => t.title.toLowerCase().includes(needle));
  }
  if (!task) return "Task not found.";
  return JSON.stringify(task, null, 2);
}

function execListPlans(polpo: Orchestrator, args: Record<string, unknown>): string {
  let plans = polpo.getAllPlans();
  if (args.status) plans = plans.filter(p => p.status === args.status);
  if (plans.length === 0) return "No plans found.";
  const lines = plans.map(p =>
    `[${p.id}] ${p.status.toUpperCase().padEnd(10)} ${p.name}${p.prompt ? ` — "${p.prompt.slice(0, 60)}"` : ""}`
  );
  return `${plans.length} plan(s):\n${lines.join("\n")}`;
}

function execGetPlan(polpo: Orchestrator, args: Record<string, unknown>): string {
  let plan;
  if (args.id) plan = polpo.getPlan(args.id as string);
  if (!plan && args.name) {
    plan = polpo.getPlanByName(args.name as string);
    if (!plan) {
      const needle = (args.name as string).toLowerCase();
      plan = polpo.getAllPlans().find(p => p.name.toLowerCase().includes(needle));
    }
  }
  if (!plan) return "Plan not found.";
  return JSON.stringify(plan, null, 2);
}

function execListAgents(polpo: Orchestrator): string {
  const agents = polpo.getAgents();
  if (agents.length === 0) return "No agents configured.";
  const lines = agents.map(a => {
    const parts = [`• ${a.name}`];
    if (a.role) parts.push(`— ${a.role}`);
    if (a.model) parts.push(`[${a.model}]`);
    if (a.skills?.length) parts.push(`skills: ${a.skills.join(", ")}`);
    if (a.systemPrompt) parts.push("(has system prompt)");
    return parts.join(" ");
  });
  return `${agents.length} agent(s):\n${lines.join("\n")}`;
}

function execGetTeam(polpo: Orchestrator): string {
  const team = polpo.getTeam();
  return JSON.stringify(team, null, 2);
}

function execGetMemory(polpo: Orchestrator): string {
  if (!polpo.hasMemory()) return "No project memory configured.";
  const content = polpo.getMemory();
  return content || "(empty)";
}

function execGetConfig(polpo: Orchestrator): string {
  const config = polpo.getConfig();
  if (!config) return "No configuration loaded.";
  // Redact API keys
  const safe = { ...config, providers: undefined };
  return JSON.stringify(safe, null, 2);
}

function execListApprovals(polpo: Orchestrator, args: Record<string, unknown>): string {
  const getAllApprovals = polpo.getAllApprovals;
  if (!getAllApprovals) return "Approval system not active.";
  const approvals = args.status
    ? getAllApprovals.call(polpo, args.status as ApprovalStatus)
    : getAllApprovals.call(polpo);
  if (!approvals || approvals.length === 0) return "No approval requests found.";
  const lines = approvals.map((a: { id: string; status: string; gateName: string; taskId?: string }) =>
    `[${a.id}] ${a.status.toUpperCase().padEnd(8)} gate: ${a.gateName}${a.taskId ? ` task: ${a.taskId}` : ""}`
  );
  return `${approvals.length} approval(s):\n${lines.join("\n")}`;
}

function execListCheckpoints(polpo: Orchestrator): string {
  const getCheckpoints = polpo.getActiveCheckpoints;
  if (!getCheckpoints) return "No checkpoint system active.";
  const checkpoints = getCheckpoints.call(polpo);
  if (!checkpoints || checkpoints.length === 0) return "No active checkpoints.";
  const lines = checkpoints.map((c: { group: string; checkpointName: string; reachedAt: string }) =>
    `• ${c.checkpointName} (group: ${c.group}, reached: ${c.reachedAt})`
  );
  return `${checkpoints.length} checkpoint(s):\n${lines.join("\n")}`;
}

function execGetLogs(polpo: Orchestrator, args: Record<string, unknown>): string {
  const logStore = polpo.getLogStore?.();
  if (!logStore) return "Log store not available.";
  if (args.sessionId) {
    try {
      const entries = logStore.getSessionEntries(args.sessionId as string);
      if (!entries || entries.length === 0) return `No log entries for session ${args.sessionId}.`;
      return entries.map((e) => `[${e.ts}] ${e.event}: ${JSON.stringify(e.data)}`).join("\n");
    } catch {
      return `Session ${args.sessionId} not found.`;
    }
  }
  try {
    const sessions = logStore.listSessions();
    if (!sessions || sessions.length === 0) return "No log sessions.";
    return sessions.map((s) => `[${s.sessionId}] started: ${s.startedAt} (${s.entries} entries)`).join("\n");
  } catch {
    return "Unable to list log sessions.";
  }
}

// ═══════════════════════════════════════════════════════
//  TASK IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════

function execCreateTask(polpo: Orchestrator, args: Record<string, unknown>): string {
  const agents = polpo.getAgents();
  const agentName = args.assignTo as string;
  if (!agents.find(a => a.name === agentName)) {
    return `Error: Agent "${agentName}" not found. Available agents: ${agents.map(a => a.name).join(", ")}`;
  }
  const task = polpo.addTask({
    title: args.title as string,
    description: args.description as string,
    assignTo: agentName,
    dependsOn: args.dependsOn as string[] | undefined,
    group: args.group as string | undefined,
    expectations: args.expectations as any[] | undefined,
  });
  return `Task created: [${task.id}] "${task.title}" → ${task.assignTo}`;
}

function execUpdateTask(polpo: Orchestrator, args: Record<string, unknown>): string {
  const taskId = args.taskId as string;
  const task = polpo.getStore().getTask(taskId);
  if (!task) return `Error: Task "${taskId}" not found.`;

  const changes: string[] = [];
  if (args.description) {
    polpo.updateTaskDescription(taskId, args.description as string);
    changes.push("description");
  }
  if (args.assignTo) {
    const agents = polpo.getAgents();
    if (!agents.find(a => a.name === args.assignTo)) return `Error: Agent "${args.assignTo}" not found.`;
    polpo.updateTaskAssignment(taskId, args.assignTo as string);
    changes.push(`assignment → ${args.assignTo}`);
  }
  if (args.expectations) {
    polpo.updateTaskExpectations(taskId, args.expectations as any[]);
    changes.push("expectations");
  }
  if (changes.length === 0) return "No changes specified.";
  return `Task ${taskId} updated: ${changes.join(", ")}`;
}

function execDeleteTask(polpo: Orchestrator, args: Record<string, unknown>): string {
  const taskId = args.taskId as string;
  const deleted = polpo.deleteTask(taskId);
  return deleted ? `Task ${taskId} deleted.` : `Error: Task "${taskId}" not found.`;
}

function execDeleteTasks(polpo: Orchestrator, args: Record<string, unknown>): string {
  let filter: (t: { status: string; group?: string }) => boolean;
  if (args.all) {
    filter = () => true;
  } else if (args.status && args.group) {
    filter = (t) => t.status === args.status && t.group === args.group;
  } else if (args.status) {
    filter = (t) => t.status === args.status;
  } else if (args.group) {
    filter = (t) => t.group === args.group;
  } else {
    return "Error: Specify at least one filter (status, group) or all=true.";
  }
  const count = polpo.clearTasks(filter);
  return `Deleted ${count} task(s).`;
}

function execRetryTask(polpo: Orchestrator, args: Record<string, unknown>): string {
  polpo.retryTask(args.taskId as string);
  return `Task ${args.taskId} retried — reset to pending.`;
}

function execKillTask(polpo: Orchestrator, args: Record<string, unknown>): string {
  const killed = polpo.killTask(args.taskId as string);
  return killed ? `Task ${args.taskId} killed.` : `Task ${args.taskId} — no running process found.`;
}

function execReassessTask(polpo: Orchestrator, args: Record<string, unknown>): string {
  polpo.reassessTask(args.taskId as string);
  return `Reassessment started for task ${args.taskId}.`;
}

function execForceFailTask(polpo: Orchestrator, args: Record<string, unknown>): string {
  polpo.forceFailTask(args.taskId as string);
  return `Task ${args.taskId} force-failed.`;
}

// ═══════════════════════════════════════════════════════
//  PLAN IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════

function execCreatePlan(polpo: Orchestrator, args: Record<string, unknown>): string {
  const plan = polpo.savePlan({
    data: args.data as string,
    name: args.name as string,
    prompt: args.prompt as string | undefined,
    status: "draft",
  });
  return `Plan created: [${plan.id}] "${plan.name}" (draft)`;
}

function execUpdatePlan(polpo: Orchestrator, args: Record<string, unknown>): string {
  const planId = args.planId as string;
  const plan = polpo.getPlan(planId);
  if (!plan) return `Error: Plan "${planId}" not found.`;
  const updates: Record<string, unknown> = {};
  if (args.name) updates.name = args.name;
  if (args.data) updates.data = args.data;
  if (args.status) updates.status = args.status;
  const updated = polpo.updatePlan(planId, updates as any);
  return `Plan "${updated.name}" updated.`;
}

function execExecutePlan(polpo: Orchestrator, args: Record<string, unknown>): string {
  const planId = args.planId as string;
  const plan = polpo.getPlan(planId);
  if (!plan) return `Error: Plan "${planId}" not found.`;
  const result = polpo.executePlan(planId);
  return `Plan "${plan.name}" executed: ${result.tasks.length} tasks created in group "${result.group}".`;
}

function execResumePlan(polpo: Orchestrator, args: Record<string, unknown>): string {
  const planId = args.planId as string;
  const plan = polpo.getPlan(planId);
  if (!plan) return `Error: Plan "${planId}" not found.`;
  const result = polpo.resumePlan(planId, { retryFailed: args.retryFailed as boolean | undefined });
  return `Plan "${plan.name}" resumed: ${result.retried} retried, ${result.pending} pending.`;
}

function execAbortPlan(polpo: Orchestrator, args: Record<string, unknown>): string {
  const planId = args.planId as string;
  const plan = polpo.getPlan(planId);
  if (!plan) return `Error: Plan "${planId}" not found.`;
  // abortGroup uses the plan's group name, which is typically the plan ID or name
  // We need to find the group from active tasks
  const state = polpo.getStore().getState();
  const planTasks = state.tasks.filter(t => t.group && polpo.getPlan(planId));
  // Use the plan name as group identifier
  const count = polpo.abortGroup(plan.name);
  return count > 0 ? `Plan "${plan.name}" aborted: ${count} tasks killed/failed.` : `Plan "${plan.name}" — no active tasks to abort.`;
}

function execDeletePlan(polpo: Orchestrator, args: Record<string, unknown>): string {
  const planId = args.planId as string;
  const plan = polpo.getPlan(planId);
  if (!plan) return `Error: Plan "${planId}" not found.`;
  polpo.deletePlan(planId);
  return `Plan "${plan.name}" deleted.`;
}

// ═══════════════════════════════════════════════════════
//  TEAM IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════

function execAddAgent(polpo: Orchestrator, args: Record<string, unknown>): string {
  const existing = polpo.getAgents();
  if (existing.find(a => a.name === args.name)) {
    return `Error: Agent "${args.name}" already exists. Use update_agent to modify.`;
  }
  polpo.addAgent({
    name: args.name as string,
    role: args.role as string | undefined,
    model: args.model as string | undefined,
    systemPrompt: args.systemPrompt as string | undefined,
    skills: args.skills as string[] | undefined,
    allowedPaths: args.allowedPaths as string[] | undefined,
  });
  return `Agent "${args.name}" added to team.`;
}

function execRemoveAgent(polpo: Orchestrator, args: Record<string, unknown>): string {
  const removed = polpo.removeAgent(args.name as string);
  return removed ? `Agent "${args.name}" removed.` : `Error: Agent "${args.name}" not found.`;
}

function execUpdateAgent(polpo: Orchestrator, args: Record<string, unknown>): string {
  const name = args.name as string;
  const agents = polpo.getAgents();
  const existing = agents.find(a => a.name === name);
  if (!existing) return `Error: Agent "${name}" not found.`;

  // Remove and re-add with updated fields
  polpo.removeAgent(name);
  polpo.addAgent({
    ...existing,
    role: (args.role as string | undefined) ?? existing.role,
    model: (args.model as string | undefined) ?? existing.model,
    systemPrompt: (args.systemPrompt as string | undefined) ?? existing.systemPrompt,
    skills: (args.skills as string[] | undefined) ?? existing.skills,
    allowedPaths: (args.allowedPaths as string[] | undefined) ?? existing.allowedPaths,
  });
  const changes = Object.keys(args).filter(k => k !== "name").join(", ");
  return `Agent "${name}" updated: ${changes}`;
}

function execRenameTeam(polpo: Orchestrator, args: Record<string, unknown>): string {
  polpo.renameTeam(args.name as string);
  return `Team renamed to "${args.name}".`;
}

// ═══════════════════════════════════════════════════════
//  APPROVAL & CHECKPOINT IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════

function execApproveRequest(polpo: Orchestrator, args: Record<string, unknown>): string {
  const result = polpo.approveRequest(
    args.requestId as string,
    "polpo",
    args.note as string | undefined,
  );
  return result ? `Request ${args.requestId} approved.` : `Error: Request "${args.requestId}" not found or already resolved.`;
}

function execRejectRequest(polpo: Orchestrator, args: Record<string, unknown>): string {
  const result = polpo.rejectRequest(
    args.requestId as string,
    args.feedback as string,
    "polpo",
  );
  return result ? `Request ${args.requestId} rejected.` : `Error: Request "${args.requestId}" not found or already resolved.`;
}

function execResumeCheckpoint(polpo: Orchestrator, args: Record<string, unknown>): string {
  const resumed = polpo.resumeCheckpointByPlanId(
    args.planId as string,
    args.checkpointName as string,
  );
  return resumed ? `Checkpoint "${args.checkpointName}" resumed.` : `Error: Checkpoint not found or already resumed.`;
}

// ═══════════════════════════════════════════════════════
//  SCHEDULING IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════

function execCreateSchedule(polpo: Orchestrator, args: Record<string, unknown>): string {
  const scheduler = polpo.getScheduler();
  if (!scheduler) return "Error: Scheduler not available (enableScheduler may be false).";
  const planId = args.planId as string;
  const plan = polpo.getPlan(planId);
  if (!plan) return `Error: Plan "${planId}" not found.`;

  // Temporarily set schedule on the plan so registerPlan can read it
  const updatedPlan = polpo.updatePlan(planId, {
    schedule: args.expression as string,
    recurring: (args.recurring as boolean) ?? false,
  });

  const entry = scheduler.registerPlan(updatedPlan);
  if (!entry) return `Error: Could not create schedule. Expression may be invalid or timestamp is in the past.`;
  return `Schedule created for plan "${updatedPlan.name}": ${entry.expression}${entry.recurring ? " (recurring)" : ""}, next run: ${entry.nextRunAt ?? "N/A"}`;
}

function execListSchedules(polpo: Orchestrator, args: Record<string, unknown>): string {
  const scheduler = polpo.getScheduler();
  if (!scheduler) return "Scheduler not available.";
  const all = args.active ? scheduler.getActiveSchedules() : scheduler.getAllSchedules();
  if (all.length === 0) return "No schedules found.";
  const lines = all.map(s => {
    const plan = polpo.getPlan(s.planId);
    const planName = plan ? plan.name : s.planId;
    return `[${s.id}] ${s.enabled ? "ACTIVE" : "DISABLED"} plan: "${planName}" expr: ${s.expression}${s.recurring ? " (recurring)" : ""} next: ${s.nextRunAt ?? "N/A"}${s.lastRunAt ? ` last: ${s.lastRunAt}` : ""}`;
  });
  return `${all.length} schedule(s):\n${lines.join("\n")}`;
}

function execDeleteSchedule(polpo: Orchestrator, args: Record<string, unknown>): string {
  const scheduler = polpo.getScheduler();
  if (!scheduler) return "Error: Scheduler not available.";
  const planId = args.planId as string;
  const deleted = scheduler.unregisterPlan(planId);
  if (!deleted) return `Error: No schedule found for plan "${planId}".`;
  // Clear schedule from the plan itself
  polpo.updatePlan(planId, { schedule: undefined, recurring: undefined } as any);
  return `Schedule for plan "${planId}" deleted.`;
}

function execUpdateSchedule(polpo: Orchestrator, args: Record<string, unknown>): string {
  const scheduler = polpo.getScheduler();
  if (!scheduler) return "Error: Scheduler not available.";
  const planId = args.planId as string;
  const existing = scheduler.getScheduleByPlanId(planId);
  if (!existing) return `Error: No schedule found for plan "${planId}".`;

  const changes: string[] = [];
  if (args.expression !== undefined) {
    // Re-register with new expression
    const plan = polpo.getPlan(planId);
    if (!plan) return `Error: Plan "${planId}" not found.`;
    const updated = polpo.updatePlan(planId, {
      schedule: args.expression as string,
      recurring: (args.recurring as boolean) ?? existing.recurring,
    });
    scheduler.unregisterPlan(planId);
    scheduler.registerPlan(updated);
    changes.push(`expression: ${args.expression}`);
  }
  if (args.recurring !== undefined && args.expression === undefined) {
    existing.recurring = args.recurring as boolean;
    polpo.updatePlan(planId, { recurring: args.recurring as boolean } as any);
    changes.push(`recurring: ${args.recurring}`);
  }
  if (args.enabled !== undefined) {
    existing.enabled = args.enabled as boolean;
    changes.push(`enabled: ${args.enabled}`);
  }
  if (changes.length === 0) return "No changes specified.";
  return `Schedule for plan "${planId}" updated: ${changes.join(", ")}`;
}

// ═══════════════════════════════════════════════════════
//  NOTIFICATION RULE IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════

function execAddNotificationRule(polpo: Orchestrator, args: Record<string, unknown>): string {
  const router = polpo.getNotificationRouter();
  if (!router) return "Error: Notification system not configured.";

  const ruleId = `rule-${Date.now().toString(36)}`;
  let condition;
  if (args.condition) {
    try {
      condition = JSON.parse(args.condition as string);
    } catch {
      return "Error: Invalid condition JSON.";
    }
  }

  const rule = {
    id: ruleId,
    name: args.name as string,
    events: args.events as string[],
    channels: (args.channels as string[] | undefined) ?? [],
    condition,
    severity: (args.severity as "info" | "warning" | "critical" | undefined) ?? "info",
    cooldownMs: args.cooldownMs as number | undefined,
    actions: args.actions as any[] | undefined,
  };

  router.addRule(rule);
  const parts = [`Rule "${rule.name}" [${ruleId}] created: events=${rule.events.join(",")}`];
  if (rule.channels.length) parts.push(`channels=${rule.channels.join(",")}`);
  if (rule.actions?.length) parts.push(`actions=${rule.actions.map((a: any) => a.type).join(",")}`);
  return parts.join(", ");
}

function execListNotificationRules(polpo: Orchestrator): string {
  const router = polpo.getNotificationRouter();
  if (!router) return "Notification system not configured.";
  const rules = router.getRules();
  if (rules.length === 0) return "No notification rules configured.";
  const lines = rules.map(r => {
    let line = `[${r.id}] "${r.name}" events=${r.events.join(",")} channels=${r.channels.join(",")}`;
    if (r.condition) line += " (has condition)";
    if (r.cooldownMs) line += ` cooldown=${r.cooldownMs}ms`;
    if ((r as any).actions?.length) line += ` actions=${(r as any).actions.length}`;
    return line;
  });
  return `${rules.length} rule(s):\n${lines.join("\n")}`;
}

function execRemoveNotificationRule(polpo: Orchestrator, args: Record<string, unknown>): string {
  const router = polpo.getNotificationRouter();
  if (!router) return "Error: Notification system not configured.";
  const removed = router.removeRule(args.ruleId as string);
  return removed ? `Rule "${args.ruleId}" removed.` : `Error: Rule "${args.ruleId}" not found.`;
}

function execSendNotification(polpo: Orchestrator, args: Record<string, unknown>): string {
  const router = polpo.getNotificationRouter();
  if (!router) return "Error: Notification system not configured.";

  // Fire and forget — sendDirect is async but we return immediately with confirmation
  router.sendDirect({
    channel: args.channel as string,
    title: args.title as string,
    body: args.body as string,
    severity: args.severity as "info" | "warning" | "critical" | undefined,
    delayMs: args.delayMs as number | undefined,
  }).catch((err) => {
    // Error is emitted as notification:failed event
  });

  const delay = args.delayMs as number | undefined;
  return delay
    ? `Notification scheduled to "${args.channel}" in ${delay}ms.`
    : `Notification sent to "${args.channel}".`;
}

// ═══════════════════════════════════════════════════════
//  TASK WATCHER IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════

function execWatchTask(polpo: Orchestrator, args: Record<string, unknown>): string {
  const watcherMgr = polpo.getWatcherManager();
  if (!watcherMgr) return "Error: Watcher manager not available.";

  const taskId = args.taskId as string;
  const task = polpo.getStore().getTask(taskId);
  if (!task) return `Error: Task "${taskId}" not found.`;

  const targetStatus = args.targetStatus as string;
  const validStatuses = ["pending", "assigned", "in_progress", "review", "done", "failed", "awaiting_approval"];
  if (!validStatuses.includes(targetStatus)) {
    return `Error: Invalid target status "${targetStatus}". Valid: ${validStatuses.join(", ")}`;
  }

  // Check if the task is already at the target status
  if (task.status === targetStatus) {
    return `Warning: Task "${task.title}" is already in "${targetStatus}" status. Watcher will not fire. Consider executing the action directly.`;
  }

  const action = args.action as any;
  const watcher = watcherMgr.create({
    taskId,
    targetStatus: targetStatus as any,
    action,
  });
  return `Watcher created: [${watcher.id}] watching task "${task.title}" for status "${targetStatus}" → action: ${action.type}`;
}

function execListWatchers(polpo: Orchestrator, args: Record<string, unknown>): string {
  const watcherMgr = polpo.getWatcherManager();
  if (!watcherMgr) return "Watcher manager not available.";
  const all = args.active ? watcherMgr.getActive() : watcherMgr.getAll();
  if (all.length === 0) return "No watchers found.";

  const lines = all.map(w => {
    const task = polpo.getStore().getTask(w.taskId);
    const taskName = task ? task.title : w.taskId;
    const status = w.fired ? `FIRED at ${w.firedAt}` : "ACTIVE";
    return `[${w.id}] ${status} task: "${taskName}" target: ${w.targetStatus} → ${w.action.type}`;
  });
  return `${all.length} watcher(s):\n${lines.join("\n")}`;
}

function execRemoveWatcher(polpo: Orchestrator, args: Record<string, unknown>): string {
  const watcherMgr = polpo.getWatcherManager();
  if (!watcherMgr) return "Error: Watcher manager not available.";
  const removed = watcherMgr.remove(args.watcherId as string);
  return removed ? `Watcher "${args.watcherId}" removed.` : `Error: Watcher "${args.watcherId}" not found.`;
}

// ═══════════════════════════════════════════════════════
//  CONFIG & SELF-MODIFICATION IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════

function execReloadConfig(polpo: Orchestrator): string {
  const reloaded = polpo.reloadConfig();
  return reloaded ? "Configuration reloaded from polpo.json." : "Error: Failed to reload configuration.";
}

function execSaveMemory(polpo: Orchestrator, args: Record<string, unknown>): string {
  polpo.saveMemory(args.content as string);
  return "Project memory updated.";
}

function execAppendMemory(polpo: Orchestrator, args: Record<string, unknown>): string {
  polpo.appendMemory(args.content as string);
  return "Appended to project memory.";
}

function execAppendSystemContext(polpo: Orchestrator, args: Record<string, unknown>): string {
  const polpoDir = polpo.getPolpoDir();
  const contextPath = join(polpoDir, "system-context.md");
  const content = args.content as string;

  if (existsSync(contextPath)) {
    appendFileSync(contextPath, `\n${content}\n`, "utf-8");
  } else {
    writeFileSync(contextPath, `${content}\n`, "utf-8");
  }
  return `Remembered: "${content.slice(0, 80)}${content.length > 80 ? "..." : ""}"`;
}

/**
 * Read the system context file, if it exists.
 */
export function readSystemContext(polpoDir: string): string {
  const contextPath = join(polpoDir, "system-context.md");
  if (existsSync(contextPath)) {
    return readFileSync(contextPath, "utf-8").trim();
  }
  return "";
}
