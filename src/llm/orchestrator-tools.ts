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
import type { ApprovalStatus, VaultEntry, AgentIdentity, AgentResponsibility, AgentConfig } from "../core/types.js";
import { existsSync, readFileSync, appendFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "fs";
import { join, resolve, relative, isAbsolute, dirname } from "path";
import { execSync } from "child_process";
import { assertUrlAllowed } from "../tools/ssrf-guard.js";
import {
  discoverOrchestratorSkills, createOrchestratorSkill, updateOrchestratorSkill,
  removeOrchestratorSkill, installOrchestratorSkills,
  discoverSkills, installSkills, removeSkill, createAgentSkill,
  getSkillByName, updateSkillIndex,
} from "./skills.js";

// ═══════════════════════════════════════════════════════
//  READ TOOLS (12)
// ═══════════════════════════════════════════════════════

const getStatusTool: Tool = {
  name: "get_status",
  description: "Get a full overview: task counts, active processes, team info, missions, memory status, pending approvals, active checkpoints.",
  parameters: Type.Object({}),
};

const listTasksTool: Tool = {
  name: "list_tasks",
  description: "List all tasks. Optionally filter by status, group, or assigned agent.",
  parameters: Type.Object({
    status: Type.Optional(Type.String({ description: "Filter by status: pending, assigned, in_progress, review, done, failed" })),
    group: Type.Optional(Type.String({ description: "Filter by mission group name" })),
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

const listMissionsTool: Tool = {
  name: "list_missions",
  description: "List all missions. Optionally filter by status.",
  parameters: Type.Object({
    status: Type.Optional(Type.String({ description: "Filter by status: draft, scheduled, recurring, active, paused, completed, failed, cancelled" })),
  }),
};

const getMissionTool: Tool = {
  name: "get_mission",
  description: "Get full details of a mission by ID or name (partial match).",
  parameters: Type.Object({
    id: Type.Optional(Type.String({ description: "Mission ID" })),
    name: Type.Optional(Type.String({ description: "Mission name (partial match)" })),
  }),
};

const listAgentsTool: Tool = {
  name: "list_agents",
  description: "List all configured agents with their roles, models, skills, and system prompts.",
  parameters: Type.Object({}),
};

const getTeamsTool: Tool = {
  name: "get_teams",
  description: "Get all teams with their agents and configuration. Optionally filter by team name.",
  parameters: Type.Object({
    name: Type.Optional(Type.String({ description: "Filter by team name (optional)" })),
  }),
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
  description: "List all active (unresumed) checkpoints across missions.",
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
  description: "Create a new task and assign it to an agent. Task titles MUST be unique among active tasks.",
  parameters: Type.Object({
    title: Type.String({ description: "Unique task title (must not match any active task)" }),
    description: Type.String({ description: "Detailed task description" }),
    assignTo: Type.String({ description: "Agent name to assign the task to" }),
    dependsOn: Type.Optional(Type.Array(Type.String(), { description: "IDs of tasks this depends on" })),
    group: Type.Optional(Type.String({ description: "Mission group name" })),
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
    group: Type.Optional(Type.String({ description: "Delete tasks in this mission group" })),
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
//  MISSION TOOLS (6)
// ═══════════════════════════════════════════════════════

const createMissionTool: Tool = {
  name: "create_mission",
  description: "Create a new mission. Provide the mission content as a JSON string with tasks, dependencies, expectations, and optionally quality gates.",
  parameters: Type.Object({
    name: Type.String({ description: "Mission name" }),
    data: Type.String({ description: "JSON mission content (tasks array, qualityGates, etc.)" }),
    prompt: Type.Optional(Type.String({ description: "Original user request that generated this mission" })),
  }),
};

const updateMissionTool: Tool = {
  name: "update_mission",
  description: "Update an existing mission's name, content, or status.",
  parameters: Type.Object({
    missionId: Type.String({ description: "Mission ID to update" }),
    name: Type.Optional(Type.String({ description: "New mission name" })),
    data: Type.Optional(Type.String({ description: "New JSON mission content" })),
    status: Type.Optional(Type.String({ description: "New status: draft, scheduled, recurring, active, paused, completed, failed, cancelled" })),
  }),
};

const executeMissionTool: Tool = {
  name: "execute_mission",
  description: "Execute a draft, scheduled, or recurring mission — creates tasks for all mission items and starts the work.",
  parameters: Type.Object({
    missionId: Type.String({ description: "Mission ID to execute" }),
  }),
};

const resumeMissionTool: Tool = {
  name: "resume_mission",
  description: "Resume a failed or active mission. Optionally retry failed tasks.",
  parameters: Type.Object({
    missionId: Type.String({ description: "Mission ID to resume" }),
    retryFailed: Type.Optional(Type.Boolean({ description: "Also retry failed tasks (default: false)" })),
  }),
};

const abortMissionTool: Tool = {
  name: "abort_mission",
  description: "Abort all tasks in a mission — kills running processes and marks tasks as failed.",
  parameters: Type.Object({
    missionId: Type.String({ description: "Mission ID to abort" }),
  }),
};

const deleteMissionTool: Tool = {
  name: "delete_mission",
  description: "Delete a mission.",
  parameters: Type.Object({
    missionId: Type.String({ description: "Mission ID to delete" }),
  }),
};

// ═══════════════════════════════════════════════════════
//  TEAM & AGENT TOOLS (4)
// ═══════════════════════════════════════════════════════

const addAgentTool: Tool = {
  name: "add_agent",
  description: "Add a new agent to a team. If no team is specified, adds to the default (first) team. Use allowedTools to grant extended tool access (e.g. ['browser_*', 'email_*', 'image_*', 'video_*', 'audio_*', 'excel_*', 'pdf_*', 'docx_*']). Core tools (including vault_get/vault_list) are always available. Use allowedTools to restrict to specific tool names.",
  parameters: Type.Object({
    name: Type.String({ description: "Agent name (unique identifier, must be globally unique across all teams)" }),
    role: Type.Optional(Type.String({ description: "Agent role description (e.g. 'Frontend developer')" })),
    model: Type.Optional(Type.String({ description: "LLM model (e.g. 'claude-sonnet-4-5-20250929', 'gpt-4o')" })),
    systemPrompt: Type.Optional(Type.String({ description: "Custom system prompt for this agent" })),
    skills: Type.Optional(Type.Array(Type.String(), { description: "Skill names to assign" })),
    allowedPaths: Type.Optional(Type.Array(Type.String(), { description: "Filesystem paths this agent can access (relative to workDir)" })),
    allowedTools: Type.Optional(Type.Array(Type.String(), { description: "Tool names/wildcards to enable (e.g. ['read','write','bash','browser_*','email_*','image_*','video_*','audio_*','excel_*','pdf_*','docx_*']). Vault tools are always available. Omit for core coding tools only." })),
    reportsTo: Type.Optional(Type.String({ description: "Name of the agent this one reports to (org chart hierarchy, e.g. 'lead-dev')" })),
    team: Type.Optional(Type.String({ description: "Team name to add the agent to (default: first team)" })),
    reasoning: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], { description: "Agent thinking/reasoning level. Overrides global settings.reasoning." })),
    maxTurns: Type.Optional(Type.Number({ description: "Max conversation turns before agent stops. Default: 200" })),
    maxConcurrency: Type.Optional(Type.Number({ description: "Max concurrent tasks this agent can run. Default: 1" })),
    browserProfile: Type.Optional(Type.String({ description: "Persistent browser profile name (shares cookies/state across tasks). Requires browser_* in allowedTools." })),
    emailAllowedDomains: Type.Optional(Type.Array(Type.String(), { description: "Restrict email sending to these domains only (e.g. ['company.com'])" })),
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
  description: "Update an existing agent's configuration. Only provided fields are changed; omitted fields keep their current value. Use empty string for reportsTo to remove hierarchy.",
  parameters: Type.Object({
    name: Type.String({ description: "Agent name to update" }),
    role: Type.Optional(Type.String({ description: "New role description" })),
    model: Type.Optional(Type.String({ description: "New LLM model" })),
    systemPrompt: Type.Optional(Type.String({ description: "New system prompt" })),
    skills: Type.Optional(Type.Array(Type.String(), { description: "New skill list (replaces existing)" })),
    allowedPaths: Type.Optional(Type.Array(Type.String(), { description: "New allowed paths (replaces existing)" })),
    allowedTools: Type.Optional(Type.Array(Type.String(), { description: "Tool names/wildcards to enable (replaces existing). Include 'browser_*', 'email_*', 'image_*', 'video_*', 'audio_*', 'excel_*', 'pdf_*', or 'docx_*' to grant those categories. Vault tools are always available. Omit to keep current." })),
    reportsTo: Type.Optional(Type.String({ description: "Name of the agent this one reports to. Use empty string to remove." })),
    team: Type.Optional(Type.String({ description: "Move agent to a different team" })),
    reasoning: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], { description: "Agent thinking/reasoning level" })),
    maxTurns: Type.Optional(Type.Number({ description: "Max conversation turns" })),
    maxConcurrency: Type.Optional(Type.Number({ description: "Max concurrent tasks" })),
    browserProfile: Type.Optional(Type.String({ description: "Persistent browser profile name" })),
    emailAllowedDomains: Type.Optional(Type.Array(Type.String(), { description: "Restrict email to these domains" })),
  }),
};

const listTeamsTool: Tool = {
  name: "list_teams",
  description: "List all teams with their agent counts.",
  parameters: Type.Object({}),
};

const addTeamTool: Tool = {
  name: "add_team",
  description: "Create a new team.",
  parameters: Type.Object({
    name: Type.String({ description: "Team name (must be unique)" }),
    description: Type.Optional(Type.String({ description: "Team description" })),
  }),
};

const removeTeamTool: Tool = {
  name: "remove_team",
  description: "Remove a team and all its agents. Cannot remove the last team.",
  parameters: Type.Object({
    name: Type.String({ description: "Team name to remove" }),
  }),
};

const renameTeamTool: Tool = {
  name: "rename_team",
  description: "Rename a team. Specify the current name and the new name.",
  parameters: Type.Object({
    oldName: Type.String({ description: "Current team name" }),
    name: Type.String({ description: "New team name" }),
  }),
};

// ═══════════════════════════════════════════════════════
//  VAULT TOOLS (3)
// ═══════════════════════════════════════════════════════

const setVaultEntryTool: Tool = {
  name: "set_vault_entry",
  description: "Add or update a credential in an agent's vault. Credentials are encrypted at rest (AES-256-GCM). Ask the user for actual values — do NOT use placeholder or template syntax. Common types: smtp (host, port, user, pass), imap (host, port, user, pass), api_key (key), oauth (clientId, clientSecret, refreshToken), login (username, password), custom (any fields).",
  parameters: Type.Object({
    agent: Type.String({ description: "Agent name" }),
    service: Type.String({ description: "Service name (vault key, e.g. 'gmail', 'sendgrid', 'stripe')" }),
    type: Type.Union([
      Type.Literal("smtp"),
      Type.Literal("imap"),
      Type.Literal("oauth"),
      Type.Literal("api_key"),
      Type.Literal("login"),
      Type.Literal("custom"),
    ], { description: "Credential type" }),
    label: Type.Optional(Type.String({ description: "Human-readable label (e.g. 'Work Gmail SMTP')" })),
    credentials: Type.Record(Type.String(), Type.String(), { description: "Key-value credential fields. Use actual values — they will be encrypted at rest." }),
  }),
};

const removeVaultEntryTool: Tool = {
  name: "remove_vault_entry",
  description: "Remove a credential from an agent's vault.",
  parameters: Type.Object({
    agent: Type.String({ description: "Agent name" }),
    service: Type.String({ description: "Service name (vault key) to remove" }),
  }),
};

const listVaultTool: Tool = {
  name: "list_vault",
  description: "List all credentials in an agent's vault. Values are masked (***) for security.",
  parameters: Type.Object({
    agent: Type.String({ description: "Agent name" }),
  }),
};

// ═══════════════════════════════════════════════════════
//  IDENTITY TOOLS (2)
// ═══════════════════════════════════════════════════════

const setIdentityTool: Tool = {
  name: "set_identity",
  description: "Set or update an agent's identity — who they are, how they communicate, and what they're responsible for. All fields are optional; only provided fields are updated, existing values are preserved. Responsibilities can be simple strings or structured objects with area/description/priority.",
  parameters: Type.Object({
    agent: Type.String({ description: "Agent name" }),
    displayName: Type.Optional(Type.String({ description: "Display name (e.g. 'Alice Chen')" })),
    title: Type.Optional(Type.String({ description: "Job title (e.g. 'Social Media Manager')" })),
    company: Type.Optional(Type.String({ description: "Company name" })),
    email: Type.Optional(Type.String({ description: "Email address (also used as default SMTP sender)" })),
    bio: Type.Optional(Type.String({ description: "Brief persona description" })),
    timezone: Type.Optional(Type.String({ description: "Timezone (e.g. 'Europe/Rome')" })),
    tone: Type.Optional(Type.String({ description: "Communication tone — HOW the agent communicates (e.g. 'Professional but warm', 'Concise and data-driven')" })),
    personality: Type.Optional(Type.String({ description: "Personality traits — WHO the agent IS (e.g. 'Detail-oriented and empathetic')" })),
    avatar: Type.Optional(Type.String({ description: "Avatar image path relative to project root (e.g. '.polpo/avatars/alice.png'). Upload via POST /agents/:name/avatar endpoint." })),
    socials: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Social & web accounts — keys are platform names, values are handles/URLs (e.g. { x: '@alice', github: 'alice', linkedin: '...', website: 'https://...' })" })),
    responsibilities: Type.Optional(Type.Array(
      Type.Union([
        Type.String(),
        Type.Object({
          area: Type.String({ description: "Responsibility area (e.g. 'Customer Relations')" }),
          description: Type.String({ description: "What the agent does in this area" }),
          priority: Type.Optional(Type.Union([
            Type.Literal("critical"),
            Type.Literal("high"),
            Type.Literal("medium"),
            Type.Literal("low"),
          ], { description: "Priority level" })),
        }),
      ]),
      { description: "Responsibilities — simple strings or structured { area, description, priority } objects" },
    )),
  }),
};

const getIdentityTool: Tool = {
  name: "get_identity",
  description: "Get an agent's current identity configuration.",
  parameters: Type.Object({
    agent: Type.String({ description: "Agent name" }),
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
  description: "Resume a blocked checkpoint in a mission.",
  parameters: Type.Object({
    missionId: Type.String({ description: "Mission ID" }),
    checkpointName: Type.String({ description: "Checkpoint name to resume" }),
  }),
};

// ═══════════════════════════════════════════════════════
//  SCHEDULING TOOLS (4)
// ═══════════════════════════════════════════════════════

const createScheduleTool: Tool = {
  name: "create_schedule",
  description: "Schedule a mission for future or recurring execution. Sets the mission status to 'scheduled' (one-shot) or 'recurring'. Supports cron expressions (minimum 1 minute) and ISO timestamps.",
  parameters: Type.Object({
    missionId: Type.String({ description: "Mission ID to schedule" }),
    expression: Type.String({ description: "Cron expression (e.g. '*/5 * * * *' = every 5 min) or ISO timestamp for one-shot" }),
    recurring: Type.Optional(Type.Boolean({ description: "If true, status becomes 'recurring' (repeats on every cron tick). Default: false (one-shot, status becomes 'scheduled')" })),
    endDate: Type.Optional(Type.String({ description: "End date (ISO timestamp) — schedule stops firing after this date. Useful for recurring missions (e.g. 'every Friday until June 30')" })),
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
  description: "Delete a schedule by mission ID.",
  parameters: Type.Object({
    missionId: Type.String({ description: "Mission ID whose schedule to delete" }),
  }),
};

const updateScheduleTool: Tool = {
  name: "update_schedule",
  description: "Update a schedule's expression, recurring/one-shot mode, enabled state, or end date. Changing recurring mode updates the mission status.",
  parameters: Type.Object({
    missionId: Type.String({ description: "Mission ID whose schedule to update" }),
    expression: Type.Optional(Type.String({ description: "New cron expression or ISO timestamp" })),
    recurring: Type.Optional(Type.Boolean({ description: "Switch between recurring (true) and one-shot (false) mode" })),
    enabled: Type.Optional(Type.Boolean({ description: "Enable or disable the schedule" })),
    endDate: Type.Optional(Type.String({ description: "End date (ISO timestamp). Schedule stops after this date. Use empty string to remove." })),
  }),
};

// ═══════════════════════════════════════════════════════
//  NOTIFICATION RULE TOOLS (4)
// ═══════════════════════════════════════════════════════

const addNotificationRuleTool: Tool = {
  name: "add_notification_rule",
  description: "Add a notification rule that triggers on events. Can include action triggers (create_task, execute_mission, run_script, send_notification) in addition to channel notifications.",
  parameters: Type.Object({
    name: Type.String({ description: "Rule name" }),
    events: Type.Array(Type.String(), { description: "Event patterns (glob: 'task:*', 'mission:completed', etc.)" }),
    channels: Type.Optional(Type.Array(Type.String(), { description: "Channel IDs to notify. Omit if using actions only." })),
    condition: Type.Optional(Type.String({ description: "JSON condition string, e.g. '{\"field\":\"to\",\"op\":\"==\",\"value\":\"done\"}'" })),
    severity: Type.Optional(Type.String({ description: "info, warning, or critical" })),
    cooldownMs: Type.Optional(Type.Number({ description: "Minimum ms between notifications for this rule" })),
    actions: Type.Optional(Type.Array(Type.Object({
      type: Type.String({ description: "create_task, execute_mission, run_script, or send_notification" }),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      assignTo: Type.Optional(Type.String()),
      missionId: Type.Optional(Type.String()),
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
      type: Type.String({ description: "create_task, execute_mission, run_script, or send_notification" }),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      assignTo: Type.Optional(Type.String()),
      missionId: Type.Optional(Type.String()),
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
//  SKILL TOOLS (7) — manage orchestrator + agent skills
// ═══════════════════════════════════════════════════════

const listOrchestratorSkillsTool: Tool = {
  name: "list_orchestrator_skills",
  description: "List all skills installed in the orchestrator's skill pool (.polpo/.agent/skills/).",
  parameters: Type.Object({}),
};

const createOrchestratorSkillTool: Tool = {
  name: "create_orchestrator_skill",
  description: "Create a new skill in the orchestrator's pool. Writes a SKILL.md with YAML frontmatter and markdown body.",
  parameters: Type.Object({
    name: Type.String({ description: "Skill name (directory name, e.g. 'project-planner')" }),
    description: Type.String({ description: "Short description for the skill frontmatter" }),
    content: Type.String({ description: "Markdown body content (the skill instructions, without frontmatter)" }),
    allowedTools: Type.Optional(Type.Array(Type.String(), { description: "Tool names this skill requires (informational)" })),
  }),
};

const updateOrchestratorSkillTool: Tool = {
  name: "update_orchestrator_skill",
  description: "Update an existing skill in the orchestrator's pool. Only provided fields are changed.",
  parameters: Type.Object({
    name: Type.String({ description: "Skill name to update" }),
    description: Type.Optional(Type.String({ description: "New description" })),
    content: Type.Optional(Type.String({ description: "New markdown body content" })),
    allowedTools: Type.Optional(Type.Array(Type.String(), { description: "New allowed tools list" })),
  }),
};

const removeOrchestratorSkillTool: Tool = {
  name: "remove_orchestrator_skill",
  description: "Remove a skill from the orchestrator's pool.",
  parameters: Type.Object({
    name: Type.String({ description: "Skill name to remove" }),
  }),
};

const installOrchestratorSkillTool: Tool = {
  name: "install_orchestrator_skill",
  description: "Install skills from a GitHub repo or local path into the orchestrator's pool. Supports owner/repo shorthand, full GitHub URLs, and local paths.",
  parameters: Type.Object({
    source: Type.String({ description: "GitHub owner/repo (e.g. 'anthropics/skills'), full URL, or local path" }),
    skillNames: Type.Optional(Type.Array(Type.String(), { description: "Only install specific skill names (default: all found)" })),
    force: Type.Optional(Type.Boolean({ description: "Overwrite existing skills (default: false)" })),
  }),
};

const listAgentSkillsTool: Tool = {
  name: "list_agent_skills",
  description: "List all skills installed in the agent skill pool (.polpo/skills/).",
  parameters: Type.Object({}),
};

const installAgentSkillTool: Tool = {
  name: "install_agent_skill",
  description: "Install skills from a GitHub repo or local path into the agent skill pool. Supports owner/repo shorthand, full GitHub URLs, and local paths.",
  parameters: Type.Object({
    source: Type.String({ description: "GitHub owner/repo, full URL, or local path" }),
    skillNames: Type.Optional(Type.Array(Type.String(), { description: "Only install specific skill names (default: all found)" })),
    force: Type.Optional(Type.Boolean({ description: "Overwrite existing skills (default: false)" })),
  }),
};

const removeAgentSkillTool: Tool = {
  name: "remove_agent_skill",
  description: "Remove a skill from the agent skill pool.",
  parameters: Type.Object({
    name: Type.String({ description: "Skill name to remove" }),
  }),
};

const createAgentSkillTool: Tool = {
  name: "create_agent_skill",
  description: "Create a new skill in the agent skill pool (.polpo/skills/). Writes a SKILL.md with YAML frontmatter and markdown body. After creation, assign it to agents with update_agent.",
  parameters: Type.Object({
    name: Type.String({ description: "Skill name (directory name, e.g. 'api-testing')" }),
    description: Type.String({ description: "Short description for the skill frontmatter" }),
    content: Type.String({ description: "Markdown body content (the skill instructions, without frontmatter)" }),
    allowedTools: Type.Optional(Type.Array(Type.String(), { description: "Tool names this skill requires (informational)" })),
  }),
};

const searchSkillsTool: Tool = {
  name: "search_skills",
  description: "Search the skills.sh registry for installable skills. Returns matching skills with install counts. Use install_orchestrator_skill or install_agent_skill to install results.",
  parameters: Type.Object({
    query: Type.String({ description: "Search query (e.g. 'react', 'testing', 'frontend design')" }),
  }),
};

const getSkillTool: Tool = {
  name: "get_skill",
  description: "Get the full content of a skill by name. Returns the SKILL.md body (markdown instructions). Use this to read a skill before creating similar ones or to understand what a skill does.",
  parameters: Type.Object({
    name: Type.String({ description: "Skill name to read" }),
    pool: Type.Optional(Type.Union([Type.Literal("agent"), Type.Literal("orchestrator")], { description: "Which pool to search: 'agent' (default) or 'orchestrator'" })),
  }),
};

const tagSkillTool: Tool = {
  name: "tag_skill",
  description: "Update the tags and/or category of a skill in the skills index. Tags are freeform strings for search/filtering. Category is a single string for macro-grouping. This does NOT modify the SKILL.md file — metadata is stored in .polpo/skills-index.json.",
  parameters: Type.Object({
    name: Type.String({ description: "Skill name to tag" }),
    tags: Type.Optional(Type.Array(Type.String(), { description: "Freeform tags for search and filtering (e.g. ['frontend', 'react', 'ui'])" })),
    category: Type.Optional(Type.String({ description: "Macro-category for grouping (e.g. 'development', 'design', 'operations')" })),
  }),
};

// ═══════════════════════════════════════════════════════
//  FILE SYSTEM TOOLS (6) — core coding capabilities
// ═══════════════════════════════════════════════════════

const readFileTool: Tool = {
  name: "read_file",
  description: "Read the contents of a file. Returns numbered lines. Use offset/limit for large files.",
  parameters: Type.Object({
    path: Type.String({ description: "File path (relative to project root or absolute)" }),
    offset: Type.Optional(Type.Number({ description: "Start line (1-indexed, default: 1)" })),
    limit: Type.Optional(Type.Number({ description: "Max lines to return (default: 500)" })),
  }),
};

const writeFileTool: Tool = {
  name: "write_file",
  description: "Write content to a file. Creates parent directories if needed. Overwrites existing files.",
  parameters: Type.Object({
    path: Type.String({ description: "File path (relative to project root or absolute)" }),
    content: Type.String({ description: "File content to write" }),
  }),
};

const editFileTool: Tool = {
  name: "edit_file",
  description: "Replace an exact string in a file. The oldString must match exactly (including whitespace). Use replaceAll to replace every occurrence.",
  parameters: Type.Object({
    path: Type.String({ description: "File path (relative to project root or absolute)" }),
    oldString: Type.String({ description: "The exact text to find and replace" }),
    newString: Type.String({ description: "The replacement text" }),
    replaceAll: Type.Optional(Type.Boolean({ description: "Replace all occurrences (default: false)" })),
  }),
};

const listDirectoryTool: Tool = {
  name: "list_directory",
  description: "List files and directories at a path. Directories have a trailing /. Supports glob patterns.",
  parameters: Type.Object({
    path: Type.Optional(Type.String({ description: "Directory path (default: project root). Supports glob patterns like 'src/**/*.ts'" })),
  }),
};

const grepFilesTool: Tool = {
  name: "grep_files",
  description: "Search file contents using a regex pattern. Returns matching file paths and line numbers.",
  parameters: Type.Object({
    pattern: Type.String({ description: "Regex pattern to search for" }),
    path: Type.Optional(Type.String({ description: "Directory to search in (default: project root)" })),
    include: Type.Optional(Type.String({ description: "File glob filter (e.g. '*.ts', '*.{ts,tsx}')" })),
  }),
};

const runCommandTool: Tool = {
  name: "run_command",
  description: "Execute a shell command in the project directory. Use for mkdir, cp, mv, npm, git, and other operations. Returns stdout/stderr. Timeout: 30s.",
  parameters: Type.Object({
    command: Type.String({ description: "Shell command to execute" }),
    cwd: Type.Optional(Type.String({ description: "Working directory (default: project root)" })),
  }),
};

// ═══════════════════════════════════════════════════════
//  HTTP TOOLS (2) — network access for the orchestrator
// ═══════════════════════════════════════════════════════

const httpFetchTool: Tool = {
  name: "http_fetch",
  description: "Make an HTTP request to a URL. Supports all HTTP methods, custom headers, and request bodies. Returns status code, response headers, and body. Use for API calls, fetching web pages, or checking endpoints. SSRF-protected: internal/private network addresses are blocked.",
  parameters: Type.Object({
    url: Type.String({ description: "URL to fetch (must be http:// or https://)" }),
    method: Type.Optional(Type.Union([
      Type.Literal("GET"),
      Type.Literal("POST"),
      Type.Literal("PUT"),
      Type.Literal("DELETE"),
      Type.Literal("PATCH"),
      Type.Literal("HEAD"),
      Type.Literal("OPTIONS"),
    ], { description: "HTTP method (default: GET)" })),
    headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Request headers as key-value pairs" })),
    body: Type.Optional(Type.String({ description: "Request body (for POST/PUT/PATCH). Use JSON string for JSON APIs." })),
    timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default: 30000)" })),
  }),
};

const httpDownloadTool: Tool = {
  name: "http_download",
  description: "Download a file from a URL and save it locally. Use for downloading assets, binaries, or data files. SSRF-protected: internal/private network addresses are blocked.",
  parameters: Type.Object({
    url: Type.String({ description: "URL to download from" }),
    path: Type.String({ description: "Local file path to save the downloaded content (relative to project root or absolute)" }),
    headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Optional request headers" })),
  }),
};

// ═══════════════════════════════════════════════════════
//  CLIENT-SIDE TOOLS (executed on the user's browser, not the server)
// ═══════════════════════════════════════════════════════

const goToFileTool: Tool = {
  name: "go_to_file",
  description: `Navigate the user's UI to the file browser and highlight a specific file.
Use this when you want to point the user to a file in the project — the UI navigates directly
to the /files page with the file's directory open and the file selected/previewed.
This is a client-side navigation — no new tab, no download. The user stays in the app.
Examples: show a generated output, point to a config file, highlight a source file.`,
  parameters: Type.Object({
    path: Type.String({ description: "File path relative to project root (e.g. 'output/report.pdf', 'src/index.ts', '.polpo/polpo.json')" }),
  }),
};

const openFileTool: Tool = {
  name: "open_file",
  description: `Open a file for the user in an inline preview dialog, without navigating away.
Use this when the user says "open the file", "show me the file", "let me see it", etc.
The file is read from disk and rendered in a fullscreen-capable dialog (code with syntax
highlighting, images, PDFs, HTML, markdown — same as the file browser preview).
Prefer this over go_to_file when the user wants to SEE the file content without leaving the chat.`,
  parameters: Type.Object({
    path: Type.String({ description: "File path relative to project root (e.g. 'output/report.pdf', 'src/index.ts', 'templates/email.html')" }),
  }),
};

const navigateToTool: Tool = {
  name: "navigate_to",
  description: `Navigate the user's UI to any page in the dashboard.
Use this when the user asks to see a specific section or detail page, e.g. "show me the dashboard",
"go to the agents page", "open mission X", "show me agent coder".
This is a client-side navigation — the user stays in the app.

Available targets:
- "dashboard" — Main dashboard overview
- "tasks" — Task list / kanban board
- "task" — Specific task detail (requires id)
- "missions" — Mission list
- "mission" — Specific mission detail (requires id)
- "agents" — Agent list
- "agent" — Specific agent detail (requires name)
- "skills" — Skills page
- "skill" — Specific skill detail (requires name)
- "files" — File browser (optional path to navigate to a directory, optional highlight to select a file)
- "activity" — Activity / event log
- "chat" — Chat page
- "memory" — Memory page
- "notifications" — Notifications page
- "approvals" — Approvals page
- "templates" — Templates page
- "config" — Configuration / settings page

Examples:
- navigate_to({ target: "dashboard" })
- navigate_to({ target: "mission", id: "abc123" })
- navigate_to({ target: "agent", name: "coder" })
- navigate_to({ target: "files", path: "src/", highlight: "index.ts" })
- navigate_to({ target: "task", id: "task-xyz" })`,
  parameters: Type.Object({
    target: Type.String({ description: "Page target: dashboard, tasks, task, missions, mission, agents, agent, skills, skill, files, activity, chat, memory, notifications, approvals, templates, config" }),
    id: Type.Optional(Type.String({ description: "Entity ID for detail pages (task, mission)" })),
    name: Type.Optional(Type.String({ description: "Entity name for detail pages (agent, skill)" })),
    path: Type.Optional(Type.String({ description: "Directory path for files target" })),
    highlight: Type.Optional(Type.String({ description: "File to highlight/select for files target" })),
  }),
};

// ═══════════════════════════════════════════════════════
//  INTERACTIVE TOOLS
// ═══════════════════════════════════════════════════════

const askUserTool: Tool = {
  name: "ask_user",
  description: `Ask the user clarifying questions when something is ambiguous or you need preferences.
Each question has pre-populated options the user can pick from, plus a free-text custom input.
Use this ONLY when you genuinely need information to proceed — do NOT ask obvious questions.
The user can select from options or type a custom answer. Supports single and multiple selection.
After receiving answers, continue with the task using the clarified information.`,
  parameters: Type.Object({
    questions: Type.Array(Type.Object({
      id: Type.String({ description: "Unique question key (e.g. 'deploy-target', 'notification-channel')" }),
      question: Type.String({ description: "The full question text" }),
      header: Type.Optional(Type.String({ description: "Short label for compact display (max 30 chars)" })),
      options: Type.Array(Type.Object({
        label: Type.String({ description: "Option display text (1-5 words, concise)" }),
        description: Type.Optional(Type.String({ description: "Extra context explaining this option" })),
      }), { minItems: 2, description: "Pre-built selectable options. A 'Type your own answer' custom input is added automatically — do NOT include catch-all options like 'Other'." }),
      multiple: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options (default: false)" })),
      custom: Type.Optional(Type.Boolean({ description: "Show custom text input (default: true). Set to false for strict choice-only questions." })),
    }), { minItems: 1, maxItems: 5, description: "Questions to ask the user" }),
  }),
};

// ═══════════════════════════════════════════════════════
//  TOOL COLLECTIONS
// ═══════════════════════════════════════════════════════

export const READ_TOOLS = new Set([
  "get_status", "list_tasks", "get_task", "list_missions", "get_mission",
  "list_agents", "get_team", "get_memory", "get_config",
  "list_approvals", "list_checkpoints", "get_logs",
  // Read-only listing tools
  "list_schedules", "list_notification_rules", "list_watchers",
  // Skills (read-only)
  "list_orchestrator_skills", "list_agent_skills", "search_skills", "get_skill",
  // File System (read-only)
  "read_file", "list_directory", "grep_files",
  // HTTP (read-only)
  "http_fetch",
]);

export const WRITE_TOOLS = new Set([
  // Task
  "create_task", "update_task", "delete_task", "delete_tasks",
  "retry_task", "kill_task", "reassess_task", "force_fail_task",
  // Mission
  "create_mission", "update_mission", "execute_mission", "resume_mission", "abort_mission", "delete_mission",
  // Team
  "add_agent", "remove_agent", "update_agent", "rename_team", "add_team", "remove_team",
  // Vault & Identity
  "set_vault_entry", "remove_vault_entry", "set_identity",
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
  // Skills (write)
  "create_orchestrator_skill", "update_orchestrator_skill", "remove_orchestrator_skill",
  "install_orchestrator_skill", "create_agent_skill", "install_agent_skill", "remove_agent_skill",
  "tag_skill",
  // File System (write)
  "write_file", "edit_file", "run_command",
  // HTTP (write — downloads files to disk)
  "http_download",
]);

/** Tools that pause the conversation to collect user input / show a preview. */
export const INTERACTIVE_TOOLS = new Set(["ask_user", "create_mission", "set_vault_entry", "go_to_file", "open_file", "navigate_to"]);

export function needsApproval(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}

export function isInteractive(toolName: string): boolean {
  return INTERACTIVE_TOOLS.has(toolName);
}

export const ALL_ORCHESTRATOR_TOOLS: Tool[] = [
  // Read (15)
  getStatusTool, listTasksTool, getTaskTool, listMissionsTool, getMissionTool,
  listAgentsTool, getTeamsTool, getMemoryTool, getConfigTool,
  listApprovalsTool, listCheckpointsTool, getLogsTool,
  listSchedulesTool, listNotificationRulesTool, listWatchersTool,
  // Task (8)
  createTaskTool, updateTaskTool, deleteTaskTool, deleteTasksTool,
  retryTaskTool, killTaskTool, reassessTaskTool, forceFailTaskTool,
  // Mission (6)
  createMissionTool, updateMissionTool, executeMissionTool, resumeMissionTool, abortMissionTool, deleteMissionTool,
  // Team (7)
  listTeamsTool, addAgentTool, removeAgentTool, updateAgentTool, renameTeamTool, addTeamTool, removeTeamTool,
  // Vault (3)
  setVaultEntryTool, removeVaultEntryTool, listVaultTool,
  // Identity (2)
  setIdentityTool, getIdentityTool,
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
  // Skills (10)
  listOrchestratorSkillsTool, createOrchestratorSkillTool, updateOrchestratorSkillTool,
  removeOrchestratorSkillTool, installOrchestratorSkillTool,
  listAgentSkillsTool, createAgentSkillTool, installAgentSkillTool, removeAgentSkillTool,
  searchSkillsTool, getSkillTool, tagSkillTool,
  // File System (6)
  readFileTool, writeFileTool, editFileTool, listDirectoryTool, grepFilesTool, runCommandTool,
  // HTTP (2)
  httpFetchTool, httpDownloadTool,
  // Interactive (1)
  askUserTool,
  // Client-side (3)
  goToFileTool, openFileTool, navigateToTool,
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
  create_mission: "Create Mission",
  update_mission: "Update Mission",
  execute_mission: "Execute Mission",
  resume_mission: "Resume Mission",
  abort_mission: "Abort Mission",
  delete_mission: "Delete Mission",
  add_agent: "Add Agent",
  remove_agent: "Remove Agent",
  update_agent: "Update Agent",
  rename_team: "Rename Team",
  add_team: "Add Team",
  remove_team: "Remove Team",
  set_vault_entry: "Set Vault Entry",
  remove_vault_entry: "Remove Vault Entry",
  set_identity: "Set Agent Identity",
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
  // Skills
  create_orchestrator_skill: "Create Orchestrator Skill",
  update_orchestrator_skill: "Update Orchestrator Skill",
  remove_orchestrator_skill: "Remove Orchestrator Skill",
  install_orchestrator_skill: "Install Orchestrator Skill",
  create_agent_skill: "Create Agent Skill",
  install_agent_skill: "Install Agent Skill",
  remove_agent_skill: "Remove Agent Skill",
  // File System
  write_file: "Write File",
  edit_file: "Edit File",
  run_command: "Run Command",
  // HTTP
  http_fetch: "HTTP Fetch",
  http_download: "HTTP Download",
};

// ═══════════════════════════════════════════════════════
//  AGENT RESOLUTION HELPER
// ═══════════════════════════════════════════════════════

/**
 * Resolve an agent by name or displayName.
 *
 * Resolution order:
 * 1. Exact match on `agent.name`
 * 2. Case-insensitive match on `agent.name`
 * 3. Case-insensitive match on `agent.identity.displayName`
 *
 * Returns the AgentConfig if found, or undefined.
 */
function resolveAgent(agents: AgentConfig[], query: string): AgentConfig | undefined {
  // 1. Exact match on name
  const exact = agents.find(a => a.name === query);
  if (exact) return exact;

  // 2. Case-insensitive match on name
  const lower = query.toLowerCase();
  const ciName = agents.find(a => a.name.toLowerCase() === lower);
  if (ciName) return ciName;

  // 3. Case-insensitive match on displayName
  const ciDisplay = agents.find(a =>
    a.identity?.displayName?.toLowerCase() === lower,
  );
  if (ciDisplay) return ciDisplay;

  return undefined;
}

/**
 * Resolve an agent and return its canonical name, or an error string.
 * Convenience wrapper used by tool executors.
 */
function resolveAgentName(agents: AgentConfig[], query: string): { name: string } | { error: string } {
  const agent = resolveAgent(agents, query);
  if (agent) return { name: agent.name };
  const available = agents.map(a => {
    const dn = a.identity?.displayName;
    return dn ? `${a.name} (${dn})` : a.name;
  }).join(", ");
  return { error: `Error: Agent "${query}" not found. Available agents: ${available}` };
}

// ═══════════════════════════════════════════════════════
//  EXECUTOR
// ═══════════════════════════════════════════════════════

export async function executeOrchestratorTool(
  toolName: string,
  args: Record<string, unknown>,
  polpo: Orchestrator,
): Promise<string> {
  try {
    switch (toolName) {
      // ── Read ──
      case "get_status":       return execGetStatus(polpo);
      case "list_tasks":       return execListTasks(polpo, args);
      case "get_task":         return execGetTask(polpo, args);
      case "list_missions":    return execListMissions(polpo, args);
      case "get_mission":      return execGetMission(polpo, args);
      case "list_agents":      return execListAgents(polpo);
      case "get_teams":        return execGetTeams(polpo, args);
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

      // ── Mission ──
      case "create_mission":   return execCreateMission(polpo, args);
      case "update_mission":   return execUpdateMission(polpo, args);
      case "execute_mission":  return execExecuteMission(polpo, args);
      case "resume_mission":   return execResumeMission(polpo, args);
      case "abort_mission":    return execAbortMission(polpo, args);
      case "delete_mission":   return execDeleteMission(polpo, args);

      // ── Team ──
      case "list_teams":       return execListTeams(polpo);
      case "add_agent":        return execAddAgent(polpo, args);
      case "remove_agent":     return execRemoveAgent(polpo, args);
      case "update_agent":     return execUpdateAgent(polpo, args);
      case "rename_team":      return execRenameTeam(polpo, args);
      case "add_team":         return execAddTeam(polpo, args);
      case "remove_team":      return execRemoveTeam(polpo, args);

      // ── Vault ──
      case "set_vault_entry":    return execSetVaultEntry(polpo, args);
      case "remove_vault_entry": return execRemoveVaultEntry(polpo, args);
      case "list_vault":         return execListVault(polpo, args);

      // ── Identity ──
      case "set_identity":       return execSetIdentity(polpo, args);
      case "get_identity":       return execGetIdentity(polpo, args);

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

      // ── Skills ──
      case "list_orchestrator_skills":    return execListOrchestratorSkills(polpo);
      case "create_orchestrator_skill":   return execCreateOrchestratorSkill(polpo, args);
      case "update_orchestrator_skill":   return execUpdateOrchestratorSkill(polpo, args);
      case "remove_orchestrator_skill":   return execRemoveOrchestratorSkill(polpo, args);
      case "install_orchestrator_skill":  return execInstallOrchestratorSkill(polpo, args);
      case "list_agent_skills":           return execListAgentSkills(polpo);
      case "create_agent_skill":          return execCreateAgentSkill(polpo, args);
      case "install_agent_skill":         return execInstallAgentSkill(polpo, args);
      case "remove_agent_skill":          return execRemoveAgentSkill(polpo, args);
      case "search_skills":              return execSearchSkills(args);
      case "get_skill":                  return execGetSkill(polpo, args);
      case "tag_skill":                  return execTagSkill(polpo, args);

      // ── File System ──
      case "read_file":        return execReadFile(polpo, args);
      case "write_file":       return execWriteFile(polpo, args);
      case "edit_file":        return execEditFile(polpo, args);
      case "list_directory":   return execListDirectory(polpo, args);
      case "grep_files":       return execGrepFiles(polpo, args);
      case "run_command":      return execRunCommand(polpo, args);

      // ── HTTP ──
      case "http_fetch":       return await execHttpFetch(polpo, args);
      case "http_download":    return await execHttpDownload(polpo, args);

      // ── Interactive (handled by the calling loop, not here) ──
      case "ask_user":
        return "Questions sent to user. Waiting for answers.";

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
  if (args.missionId && polpo) {
    try {
      const mission = polpo.getMission(String(args.missionId));
      if (mission) return `"${mission.name}"`;
    } catch { /* ignore */ }
    return String(args.missionId);
  }
  if (args.requestId) return String(args.requestId);
  if (toolName === "create_task" && args.title) return `"${String(args.title)}"`;
  if (toolName === "create_mission" && args.name) return `"${String(args.name)}"`;
  if (toolName === "add_agent" && args.name) return `"${String(args.name)}"`;
  if (toolName === "remove_agent" && args.name) return `"${String(args.name)}"`;
  if (toolName === "update_agent" && args.name) return `"${String(args.name)}"`;
  if (toolName === "set_vault_entry" && args.agent) return `"${String(args.agent)}" → ${String(args.service)}`;
  if (toolName === "remove_vault_entry" && args.agent) return `"${String(args.agent)}" → ${String(args.service)}`;
  if (toolName === "list_vault" && args.agent) return `"${String(args.agent)}"`;
  if (toolName === "set_identity" && args.agent) return `"${String(args.agent)}"`;
  if (toolName === "get_identity" && args.agent) return `"${String(args.agent)}"`;
  if (toolName === "rename_team" && args.name) return `"${String(args.name)}"`;
  if (toolName === "delete_tasks") {
    if (args.all) return "ALL tasks";
    if (args.group) return `group "${args.group}"`;
    if (args.status) return `status: ${args.status}`;
  }
  // Skill tools
  if (args.name && toolName.includes("skill")) return `"${String(args.name)}"`;
  if (args.source && toolName.includes("install")) return String(args.source);
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
  const resolveMission = (id: unknown): string => {
    if (!polpo || !id) return String(id);
    try {
      const mission = polpo.getMission(String(id));
      return mission ? `${mission.name} (${id})` : String(id);
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
    case "create_mission":
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
    case "execute_mission":
    case "resume_mission":
    case "abort_mission":
    case "delete_mission":
      main.push(["Mission", resolveMission(args.missionId)]);
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
    case "set_vault_entry":
      main.push(["Agent", String(args.agent)]);
      main.push(["Service", String(args.service)]);
      main.push(["Type", String(args.type)]);
      if (args.label) main.push(["Label", String(args.label)]);
      extra.push(["Credential keys", Object.keys((args.credentials as Record<string, string>) ?? {}).join(", ")]);
      break;
    case "remove_vault_entry":
      main.push(["Agent", String(args.agent)]);
      main.push(["Service", String(args.service)]);
      break;
    case "set_identity":
      main.push(["Agent", String(args.agent)]);
      { const fields = Object.keys(args).filter(k => k !== "agent" && args[k] !== undefined);
        if (fields.length) main.push(["Fields", fields.join(", ")]); }
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
  const teams = polpo.getTeams();

  const counts: Record<string, number> = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;

  const teamSummary = teams.map(t => `${t.name} (${t.agents.length})`).join(", ");
  const lines: string[] = [
    `Project: ${state.project}`,
    `Teams: ${teams.length} — ${teamSummary}`,
    `Agents: ${agents.length} total`,
    `Tasks: ${tasks.length} total`,
  ];
  // Show org hierarchy per team
  for (const team of teams) {
    const hierarchy = team.agents.filter(a => a.reportsTo);
    if (hierarchy.length > 0) {
      lines.push(`  ${team.name} hierarchy:`);
      for (const a of hierarchy) lines.push(`    ${a.name} → ${a.reportsTo}`);
    }
  }
  for (const [status, count] of Object.entries(counts)) lines.push(`  ${status}: ${count}`);

  const alive = processes.filter(p => p.alive);
  lines.push(`Active processes: ${alive.length}`);
  for (const p of alive) lines.push(`  ${p.agentName} → task ${p.taskId}`);

  const missions = polpo.getAllMissions();
  if (missions.length > 0) {
    lines.push(`Missions: ${missions.length} total`);
    const missionCounts: Record<string, number> = {};
    for (const p of missions) missionCounts[p.status] = (missionCounts[p.status] || 0) + 1;
    for (const [status, count] of Object.entries(missionCounts)) lines.push(`  ${status}: ${count}`);
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

function execListMissions(polpo: Orchestrator, args: Record<string, unknown>): string {
  let missions = polpo.getAllMissions();
  if (args.status) missions = missions.filter(p => p.status === args.status);
  if (missions.length === 0) return "No missions found.";
  const lines = missions.map(p =>
    `[${p.id}] ${p.status.toUpperCase().padEnd(10)} ${p.name}${p.prompt ? ` — "${p.prompt.slice(0, 60)}"` : ""}`
  );
  return `${missions.length} mission(s):\n${lines.join("\n")}`;
}

function execGetMission(polpo: Orchestrator, args: Record<string, unknown>): string {
  let mission;
  if (args.id) mission = polpo.getMission(args.id as string);
  if (!mission && args.name) {
    mission = polpo.getMissionByName(args.name as string);
    if (!mission) {
      const needle = (args.name as string).toLowerCase();
      mission = polpo.getAllMissions().find(p => p.name.toLowerCase().includes(needle));
    }
  }
  if (!mission) return "Mission not found.";
  return JSON.stringify(mission, null, 2);
}

function execListAgents(polpo: Orchestrator): string {
  const agents = polpo.getAgents();
  if (agents.length === 0) return "No agents configured.";
  const lines = agents.map(a => {
    const dn = a.identity?.displayName;
    const parts = [`• ${a.name}${dn ? ` (${dn})` : ""}`];
    if (a.role) parts.push(`— ${a.role}`);
    if (a.model) parts.push(`[${a.model}]`);
    if (a.reportsTo) parts.push(`→ reports to: ${a.reportsTo}`);
    if (a.skills?.length) parts.push(`skills: ${a.skills.join(", ")}`);
    if (a.systemPrompt) parts.push("(has system prompt)");
    return parts.join(" ");
  });
  return `${agents.length} agent(s):\n${lines.join("\n")}`;
}

function execGetTeams(polpo: Orchestrator, args: Record<string, unknown>): string {
  if (args.name) {
    const team = polpo.getTeam(args.name as string);
    if (!team) return `Error: Team "${args.name}" not found.`;
    return JSON.stringify(team, null, 2);
  }
  const teams = polpo.getTeams();
  return JSON.stringify(teams, null, 2);
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
  const resolved = resolveAgentName(agents, args.assignTo as string);
  if ("error" in resolved) return resolved.error;
  const agentName = resolved.name;
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
    const resolved = resolveAgentName(agents, args.assignTo as string);
    if ("error" in resolved) return resolved.error;
    polpo.updateTaskAssignment(taskId, resolved.name);
    changes.push(`assignment → ${resolved.name}`);
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
//  MISSION IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════

function execCreateMission(polpo: Orchestrator, args: Record<string, unknown>): string {
  const mission = polpo.saveMission({
    data: args.data as string,
    name: args.name as string,
    prompt: args.prompt as string | undefined,
    status: "draft",
  });
  return `Mission created: [${mission.id}] "${mission.name}" (draft)`;
}

function execUpdateMission(polpo: Orchestrator, args: Record<string, unknown>): string {
  const missionId = args.missionId as string;
  const mission = polpo.getMission(missionId);
  if (!mission) return `Error: Mission "${missionId}" not found.`;
  const updates: Record<string, unknown> = {};
  if (args.name) updates.name = args.name;
  if (args.data) updates.data = args.data;
  if (args.status) updates.status = args.status;
  const updated = polpo.updateMission(missionId, updates as any);
  return `Mission "${updated.name}" updated.`;
}

function execExecuteMission(polpo: Orchestrator, args: Record<string, unknown>): string {
  const missionId = args.missionId as string;
  const mission = polpo.getMission(missionId);
  if (!mission) return `Error: Mission "${missionId}" not found.`;
  const result = polpo.executeMission(missionId);
  return `Mission "${mission.name}" executed: ${result.tasks.length} tasks created in group "${result.group}".`;
}

function execResumeMission(polpo: Orchestrator, args: Record<string, unknown>): string {
  const missionId = args.missionId as string;
  const mission = polpo.getMission(missionId);
  if (!mission) return `Error: Mission "${missionId}" not found.`;
  const result = polpo.resumeMission(missionId, { retryFailed: args.retryFailed as boolean | undefined });
  return `Mission "${mission.name}" resumed: ${result.retried} retried, ${result.pending} pending.`;
}

function execAbortMission(polpo: Orchestrator, args: Record<string, unknown>): string {
  const missionId = args.missionId as string;
  const mission = polpo.getMission(missionId);
  if (!mission) return `Error: Mission "${missionId}" not found.`;
  // abortGroup uses the mission's group name, which is typically the mission ID or name
  // We need to find the group from active tasks
  const state = polpo.getStore().getState();
  const missionTasks = state.tasks.filter(t => t.group && polpo.getMission(missionId));
  // Use the mission name as group identifier
  const count = polpo.abortGroup(mission.name);
  return count > 0 ? `Mission "${mission.name}" aborted: ${count} tasks killed/failed.` : `Mission "${mission.name}" — no active tasks to abort.`;
}

function execDeleteMission(polpo: Orchestrator, args: Record<string, unknown>): string {
  const missionId = args.missionId as string;
  const mission = polpo.getMission(missionId);
  if (!mission) return `Error: Mission "${missionId}" not found.`;
  polpo.deleteMission(missionId);
  return `Mission "${mission.name}" deleted.`;
}

// ═══════════════════════════════════════════════════════
//  TEAM IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════

function execAddAgent(polpo: Orchestrator, args: Record<string, unknown>): string {
  const existing = polpo.getAgents();
  // For add_agent, check if agent already exists (by name or displayName)
  const dup = resolveAgent(existing, args.name as string);
  if (dup) {
    return `Error: Agent "${args.name}" already exists (matched "${dup.name}"). Use update_agent to modify.`;
  }
  const teamName = args.team as string | undefined;
  const config: Record<string, unknown> = {
    name: args.name as string,
    role: args.role as string | undefined,
    model: args.model as string | undefined,
    systemPrompt: args.systemPrompt as string | undefined,
    skills: args.skills as string[] | undefined,
    allowedPaths: args.allowedPaths as string[] | undefined,
    allowedTools: args.allowedTools as string[] | undefined,
    reportsTo: args.reportsTo as string | undefined,
    reasoning: args.reasoning as string | undefined,
    maxTurns: args.maxTurns as number | undefined,
    maxConcurrency: args.maxConcurrency as number | undefined,
    browserProfile: args.browserProfile as string | undefined,
    emailAllowedDomains: args.emailAllowedDomains as string[] | undefined,
  };
  // Strip undefined values so addAgent only receives explicitly set fields
  const cleaned = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined));
  polpo.addAgent(cleaned as any, teamName);
  return `Agent "${args.name}" added to ${teamName ? `team "${teamName}"` : "the first team"}.`;
}

function execRemoveAgent(polpo: Orchestrator, args: Record<string, unknown>): string {
  const agents = polpo.getAgents();
  const resolved = resolveAgentName(agents, args.name as string);
  if ("error" in resolved) return resolved.error;
  const removed = polpo.removeAgent(resolved.name);
  return removed ? `Agent "${resolved.name}" removed.` : `Error: Agent "${resolved.name}" not found.`;
}

function execUpdateAgent(polpo: Orchestrator, args: Record<string, unknown>): string {
  const agents = polpo.getAgents();
  const existing = resolveAgent(agents, args.name as string);
  if (!existing) {
    const resolved = resolveAgentName(agents, args.name as string);
    return "error" in resolved ? resolved.error : `Error: Agent "${args.name}" not found.`;
  }
  const name = existing.name; // canonical name

  // Remember which team the agent is currently in BEFORE removing
  const currentTeam = polpo.findAgentTeam(name);
  const originalTeamName = currentTeam?.name;

  // Remove and re-add with updated fields
  polpo.removeAgent(name);

  // Handle reportsTo: empty string clears it, undefined keeps existing
  let reportsTo = existing.reportsTo;
  if (typeof args.reportsTo === "string") {
    reportsTo = args.reportsTo.trim() || undefined;
  }

  // Merge: explicit args override existing, undefined keeps current
  const merged: Record<string, unknown> = {
    ...existing,
    role: (args.role as string | undefined) ?? existing.role,
    model: (args.model as string | undefined) ?? existing.model,
    systemPrompt: (args.systemPrompt as string | undefined) ?? existing.systemPrompt,
    skills: (args.skills as string[] | undefined) ?? existing.skills,
    allowedPaths: (args.allowedPaths as string[] | undefined) ?? existing.allowedPaths,
    allowedTools: (args.allowedTools as string[] | undefined) ?? existing.allowedTools,
    reportsTo,
    reasoning: (args.reasoning as string | undefined) ?? existing.reasoning,
    maxTurns: (args.maxTurns as number | undefined) ?? existing.maxTurns,
    maxConcurrency: (args.maxConcurrency as number | undefined) ?? existing.maxConcurrency,
    browserProfile: (args.browserProfile as string | undefined) ?? existing.browserProfile,
    emailAllowedDomains: (args.emailAllowedDomains as string[] | undefined) ?? existing.emailAllowedDomains,
  };

  // Use explicit team from args, otherwise preserve the original team
  const targetTeam = (args.team as string | undefined) ?? originalTeamName;
  polpo.addAgent(merged as any, targetTeam);
  const changes = Object.keys(args).filter(k => k !== "name").join(", ");
  return `Agent "${name}" updated: ${changes}`;
}

function execListTeams(polpo: Orchestrator): string {
  const teams = polpo.getTeams();
  if (teams.length === 0) return "No teams configured.";
  const lines = teams.map(t => `- ${t.name}: ${t.agents.length} agent(s)${t.description ? ` — ${t.description}` : ""}`);
  return `${teams.length} team(s):\n${lines.join("\n")}`;
}

function execAddTeam(polpo: Orchestrator, args: Record<string, unknown>): string {
  const name = args.name as string;
  const existing = polpo.getTeam(name);
  if (existing) return `Error: Team "${name}" already exists.`;
  polpo.addTeam({
    name,
    description: args.description as string | undefined,
    agents: [],
  });
  return `Team "${name}" created.`;
}

function execRemoveTeam(polpo: Orchestrator, args: Record<string, unknown>): string {
  const name = args.name as string;
  const teams = polpo.getTeams();
  if (teams.length <= 1) return "Error: Cannot remove the last team.";
  const removed = polpo.removeTeam(name);
  return removed ? `Team "${name}" removed.` : `Error: Team "${name}" not found.`;
}

function execRenameTeam(polpo: Orchestrator, args: Record<string, unknown>): string {
  const oldName = args.oldName as string;
  const newName = args.name as string;
  const team = polpo.getTeam(oldName);
  if (!team) return `Error: Team "${oldName}" not found.`;
  polpo.renameTeam(oldName, newName);
  return `Team "${oldName}" renamed to "${newName}".`;
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
  const resumed = polpo.resumeCheckpointByMissionId(
    args.missionId as string,
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
  const missionId = args.missionId as string;
  const mission = polpo.getMission(missionId);
  if (!mission) return `Error: Mission "${missionId}" not found.`;

  const isRecurring = (args.recurring as boolean) ?? false;
  // Set schedule expression and transition status to scheduled/recurring
  const newStatus = isRecurring ? "recurring" : "scheduled";
  const missionUpdate: Record<string, unknown> = {
    schedule: args.expression as string,
    status: newStatus,
  };
  if (args.endDate !== undefined) {
    missionUpdate.endDate = args.endDate as string;
  }
  const updatedMission = polpo.updateMission(missionId, missionUpdate as any);

  const entry = scheduler.registerMission(updatedMission);
  if (!entry) return `Error: Could not create schedule. Expression may be invalid or timestamp is in the past.`;
  let result = `Schedule created for mission "${updatedMission.name}" (status: ${updatedMission.status}): ${entry.expression}${entry.recurring ? " (recurring)" : " (one-shot)"}, next run: ${entry.nextRunAt ?? "N/A"}`;
  if (updatedMission.endDate) result += `, ends: ${updatedMission.endDate}`;
  return result;
}

function execListSchedules(polpo: Orchestrator, args: Record<string, unknown>): string {
  const scheduler = polpo.getScheduler();
  if (!scheduler) return "Scheduler not available.";
  const all = args.active ? scheduler.getActiveSchedules() : scheduler.getAllSchedules();
  if (all.length === 0) return "No schedules found.";
  const lines = all.map(s => {
    const mission = polpo.getMission(s.missionId);
    const missionName = mission ? mission.name : s.missionId;
    return `[${s.id}] ${s.enabled ? "ACTIVE" : "DISABLED"} mission: "${missionName}" expr: ${s.expression}${s.recurring ? " (recurring)" : ""} next: ${s.nextRunAt ?? "N/A"}${s.lastRunAt ? ` last: ${s.lastRunAt}` : ""}`;
  });
  return `${all.length} schedule(s):\n${lines.join("\n")}`;
}

function execDeleteSchedule(polpo: Orchestrator, args: Record<string, unknown>): string {
  const scheduler = polpo.getScheduler();
  if (!scheduler) return "Error: Scheduler not available.";
  const missionId = args.missionId as string;
  const deleted = scheduler.unregisterMission(missionId);
  if (!deleted) return `Error: No schedule found for mission "${missionId}".`;
  // Clear schedule from the mission and reset status to draft
  polpo.updateMission(missionId, { schedule: undefined, status: "draft" });
  return `Schedule for mission "${missionId}" deleted. Mission status reset to draft.`;
}

function execUpdateSchedule(polpo: Orchestrator, args: Record<string, unknown>): string {
  const scheduler = polpo.getScheduler();
  if (!scheduler) return "Error: Scheduler not available.";
  const missionId = args.missionId as string;
  const existing = scheduler.getScheduleByMissionId(missionId);
  if (!existing) return `Error: No schedule found for mission "${missionId}".`;

  const changes: string[] = [];
  if (args.expression !== undefined) {
    // Re-register with new expression
    const mission = polpo.getMission(missionId);
    if (!mission) return `Error: Mission "${missionId}" not found.`;
    // Determine new status based on recurring flag
    const isRecurring = (args.recurring as boolean) ?? existing.recurring;
    const newStatus = isRecurring ? "recurring" : "scheduled";
    const updated = polpo.updateMission(missionId, {
      schedule: args.expression as string,
      status: newStatus,
    });
    scheduler.unregisterMission(missionId);
    scheduler.registerMission(updated);
    changes.push(`expression: ${args.expression}`);
    if (args.recurring !== undefined) changes.push(`mode: ${isRecurring ? "recurring" : "one-shot"}`);
  }
  if (args.recurring !== undefined && args.expression === undefined) {
    const isRecurring = args.recurring as boolean;
    existing.recurring = isRecurring;
    const newStatus = isRecurring ? "recurring" : "scheduled";
    polpo.updateMission(missionId, { status: newStatus });
    // Re-register to pick up the new recurring flag
    const mission = polpo.getMission(missionId);
    if (mission) {
      scheduler.unregisterMission(missionId);
      scheduler.registerMission(mission);
    }
    changes.push(`mode: ${isRecurring ? "recurring" : "one-shot"}`);
  }
  if (args.enabled !== undefined) {
    existing.enabled = args.enabled as boolean;
    changes.push(`enabled: ${args.enabled}`);
  }
  if (args.endDate !== undefined) {
    const endDate = (args.endDate as string).trim() || undefined;
    polpo.updateMission(missionId, { endDate } as any);
    changes.push(endDate ? `endDate: ${endDate}` : "endDate: removed");
  }
  if (changes.length === 0) return "No changes specified.";
  return `Schedule for mission "${missionId}" updated: ${changes.join(", ")}`;
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

// ═══════════════════════════════════════════════════════
//  VAULT IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════

function execSetVaultEntry(polpo: Orchestrator, args: Record<string, unknown>): string {
  const agents = polpo.getAgents();
  const resolved = resolveAgentName(agents, args.agent as string);
  if ("error" in resolved) return resolved.error;
  const agentName = resolved.name;

  const vaultStore = polpo.getVaultStore();
  if (!vaultStore) return `Error: Vault store not available. Check POLPO_VAULT_KEY or ~/.polpo/vault.key.`;

  const service = args.service as string;
  const entry: VaultEntry = {
    type: args.type as VaultEntry["type"],
    ...(args.label ? { label: args.label as string } : {}),
    credentials: args.credentials as Record<string, string>,
  };

  vaultStore.set(agentName, service, entry);
  const credKeys = Object.keys(entry.credentials).join(", ");
  return `Vault entry "${service}" (${entry.type}) set for agent "${agentName}". Credential fields: ${credKeys}`;
}

function execRemoveVaultEntry(polpo: Orchestrator, args: Record<string, unknown>): string {
  const agents = polpo.getAgents();
  const resolved = resolveAgentName(agents, args.agent as string);
  if ("error" in resolved) return resolved.error;
  const agentName = resolved.name;

  const vaultStore = polpo.getVaultStore();
  if (!vaultStore) return `Error: Vault store not available.`;

  const service = args.service as string;
  const removed = vaultStore.remove(agentName, service);
  if (!removed) return `Error: No vault entry "${service}" found for agent "${agentName}".`;

  return `Vault entry "${service}" removed from agent "${agentName}".`;
}

function execListVault(polpo: Orchestrator, args: Record<string, unknown>): string {
  const agents = polpo.getAgents();
  const resolved = resolveAgentName(agents, args.agent as string);
  if ("error" in resolved) return resolved.error;
  const agentName = resolved.name;

  const vaultStore = polpo.getVaultStore();
  if (!vaultStore) return `Error: Vault store not available.`;

  const entries = vaultStore.list(agentName);
  if (entries.length === 0) return `Agent "${agentName}" has no vault entries.`;

  const lines: string[] = [`Vault for "${agentName}" (${entries.length} entries):`];
  for (const e of entries) {
    const maskedCreds = e.keys.map(k => `${k}: ***`).join(", ");
    let line = `  - ${e.service} [${e.type}]`;
    if (e.label) line += ` — ${e.label}`;
    line += `: { ${maskedCreds} }`;
    lines.push(line);
  }
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════
//  IDENTITY IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════

function execSetIdentity(polpo: Orchestrator, args: Record<string, unknown>): string {
  const agents = polpo.getAgents();
  const existing = resolveAgent(agents, args.agent as string);
  if (!existing) {
    const resolved = resolveAgentName(agents, args.agent as string);
    return "error" in resolved ? resolved.error : `Error: Agent "${args.agent}" not found.`;
  }
  const agentName = existing.name;

  // Remember which team the agent is currently in BEFORE removing
  const currentTeam = polpo.findAgentTeam(agentName);
  const originalTeamName = currentTeam?.name;

  const currentIdentity = existing.identity ?? {};

  // Merge only provided fields
  const updated: AgentIdentity = { ...currentIdentity };
  if (args.displayName !== undefined) updated.displayName = args.displayName as string;
  if (args.title !== undefined) updated.title = args.title as string;
  if (args.company !== undefined) updated.company = args.company as string;
  if (args.email !== undefined) updated.email = args.email as string;
  if (args.bio !== undefined) updated.bio = args.bio as string;
  if (args.timezone !== undefined) updated.timezone = args.timezone as string;
  if (args.tone !== undefined) updated.tone = args.tone as string;
  if (args.personality !== undefined) updated.personality = args.personality as string;
  if (args.avatar !== undefined) updated.avatar = args.avatar as string;
  if (args.socials !== undefined) updated.socials = args.socials as Record<string, string>;
  if (args.responsibilities !== undefined) {
    updated.responsibilities = (args.responsibilities as (string | AgentResponsibility)[]);
  }

  polpo.removeAgent(agentName);
  polpo.addAgent({ ...existing, identity: updated }, originalTeamName);

  const updatedFields = Object.keys(args).filter(k => k !== "agent");
  return `Identity updated for agent "${agentName}": ${updatedFields.join(", ")}`;
}

function execGetIdentity(polpo: Orchestrator, args: Record<string, unknown>): string {
  const agents = polpo.getAgents();
  const existing = resolveAgent(agents, args.agent as string);
  if (!existing) {
    const resolved = resolveAgentName(agents, args.agent as string);
    return "error" in resolved ? resolved.error : `Error: Agent "${args.agent}" not found.`;
  }

  const id = existing.identity;
  if (!id) return `Agent "${existing.name}" has no identity configured.`;

  const lines: string[] = [`Identity for "${existing.name}":`];
  if (id.displayName) lines.push(`  Display name: ${id.displayName}`);
  if (id.title) lines.push(`  Title: ${id.title}`);
  if (id.company) lines.push(`  Company: ${id.company}`);
  if (id.email) lines.push(`  Email: ${id.email}`);
  if (id.bio) lines.push(`  Bio: ${id.bio}`);
  if (id.timezone) lines.push(`  Timezone: ${id.timezone}`);
  if (id.avatar) lines.push(`  Avatar: ${id.avatar}`);
  if (id.tone) lines.push(`  Tone: ${id.tone}`);
  if (id.personality) lines.push(`  Personality: ${id.personality}`);
  if (id.socials && Object.keys(id.socials).length > 0) {
    lines.push(`  Socials: ${Object.entries(id.socials).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
  }
  if (id.responsibilities?.length) {
    lines.push(`  Responsibilities (${id.responsibilities.length}):`);
    for (const r of id.responsibilities) {
      if (typeof r === "string") {
        lines.push(`    - ${r}`);
      } else {
        lines.push(`    - [${r.priority ?? "medium"}] ${r.area}: ${r.description}`);
      }
    }
  }
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════
//  SKILLS.SH SEARCH
// ═══════════════════════════════════════════════════════

function execSearchSkills(args: Record<string, unknown>): string {
  const query = args.query as string;
  try {
    const encoded = encodeURIComponent(query);
    const raw = execSync(
      `curl -sf "https://skills.sh/api/search?q=${encoded}"`,
      { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const data = JSON.parse(raw) as {
      skills: Array<{ name: string; source: string; installs: number }>;
      count: number;
    };

    if (!data.skills || data.skills.length === 0) {
      return `No skills found for "${query}". Try different keywords.`;
    }

    const lines = [`Found ${data.count} skill(s) for "${query}":\n`];
    for (const s of data.skills) {
      const installs = s.installs >= 1000
        ? `${(s.installs / 1000).toFixed(1)}K`
        : String(s.installs);
      lines.push(`  ${s.source}@${s.name}  (${installs} installs)`);
      lines.push(`    install: install_orchestrator_skill or install_agent_skill with source "${s.source}" and skillNames ["${s.name}"]`);
    }
    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error searching skills.sh: ${msg}`;
  }
}

// ═══════════════════════════════════════════════════════
//  SKILL IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════

function execListOrchestratorSkills(polpo: Orchestrator): string {
  const skills = discoverOrchestratorSkills(polpo.getPolpoDir());
  if (skills.length === 0) return "No orchestrator skills installed. Use install_orchestrator_skill or create_orchestrator_skill to add some.";
  const lines = [`Orchestrator skills (${skills.length}):`];
  for (const s of skills) {
    lines.push(`  - ${s.name} (${s.source}): ${s.description || "(no description)"}`);
    if (s.allowedTools?.length) lines.push(`    tools: ${s.allowedTools.join(", ")}`);
  }
  return lines.join("\n");
}

function execCreateOrchestratorSkill(polpo: Orchestrator, args: Record<string, unknown>): string {
  // Gate: force reading skill-creator guidelines before creating any skill
  if (!_skillCreatorRead) {
    _skillCreatorRead = true;
    return `MANDATORY: Read the skill-creator guidelines below before creating a skill. After reading, call create_orchestrator_skill again with the same arguments.\n\n${BUILTIN_SKILL_CREATOR_CONTENT}`;
  }

  const name = args.name as string;
  const description = args.description as string;
  const content = args.content as string;
  const allowedTools = args.allowedTools as string[] | undefined;

  const existing = discoverOrchestratorSkills(polpo.getPolpoDir());
  if (existing.some(s => s.name === name)) {
    return `Error: Orchestrator skill "${name}" already exists. Use update_orchestrator_skill to modify it.`;
  }

  const path = createOrchestratorSkill(polpo.getPolpoDir(), name, description, content, { allowedTools });
  return `Created orchestrator skill "${name}" at ${path}`;
}

function execUpdateOrchestratorSkill(polpo: Orchestrator, args: Record<string, unknown>): string {
  const name = args.name as string;
  const updates: { description?: string; content?: string; allowedTools?: string[] } = {};
  if (args.description !== undefined) updates.description = args.description as string;
  if (args.content !== undefined) updates.content = args.content as string;
  if (args.allowedTools !== undefined) updates.allowedTools = args.allowedTools as string[];

  const ok = updateOrchestratorSkill(polpo.getPolpoDir(), name, updates);
  if (!ok) return `Error: Orchestrator skill "${name}" not found.`;

  const fields = Object.keys(updates);
  return `Updated orchestrator skill "${name}": ${fields.join(", ")}`;
}

function execRemoveOrchestratorSkill(polpo: Orchestrator, args: Record<string, unknown>): string {
  const name = args.name as string;
  const ok = removeOrchestratorSkill(polpo.getPolpoDir(), name);
  if (!ok) return `Error: Orchestrator skill "${name}" not found.`;
  return `Removed orchestrator skill "${name}"`;
}

function execInstallOrchestratorSkill(polpo: Orchestrator, args: Record<string, unknown>): string {
  const source = args.source as string;
  const skillNames = args.skillNames as string[] | undefined;
  const force = args.force as boolean | undefined;

  const result = installOrchestratorSkills(source, polpo.getPolpoDir(), { skillNames, force });

  const lines: string[] = [];
  if (result.installed.length > 0) {
    lines.push(`Installed ${result.installed.length} orchestrator skill(s):`);
    for (const s of result.installed) lines.push(`  + ${s.name}: ${s.description}`);
  }
  if (result.skipped.length > 0) {
    lines.push(`Skipped ${result.skipped.length} (already exist):`);
    for (const s of result.skipped) lines.push(`  ~ ${s.name}`);
  }
  if (result.errors.length > 0) {
    lines.push(`Errors:`);
    for (const e of result.errors) lines.push(`  ! ${e}`);
  }
  return lines.length > 0 ? lines.join("\n") : "No skills found to install.";
}

function execListAgentSkills(polpo: Orchestrator): string {
  const cwd = polpo.getWorkDir();
  const polpoDir = polpo.getPolpoDir();
  const skills = discoverSkills(cwd, polpoDir);
  if (skills.length === 0) return "No agent skills installed. Use install_agent_skill to add some.";
  const lines = [`Agent skills (${skills.length}):`];
  for (const s of skills) {
    lines.push(`  - ${s.name} (${s.source}): ${s.description || "(no description)"}`);
    if (s.allowedTools?.length) lines.push(`    tools: ${s.allowedTools.join(", ")}`);
  }
  return lines.join("\n");
}

function execInstallAgentSkill(polpo: Orchestrator, args: Record<string, unknown>): string {
  const source = args.source as string;
  const skillNames = args.skillNames as string[] | undefined;
  const force = args.force as boolean | undefined;

  const result = installSkills(source, polpo.getPolpoDir(), { skillNames, force });

  const lines: string[] = [];
  if (result.installed.length > 0) {
    lines.push(`Installed ${result.installed.length} agent skill(s):`);
    for (const s of result.installed) lines.push(`  + ${s.name}: ${s.description}`);
  }
  if (result.skipped.length > 0) {
    lines.push(`Skipped ${result.skipped.length} (already exist):`);
    for (const s of result.skipped) lines.push(`  ~ ${s.name}`);
  }
  if (result.errors.length > 0) {
    lines.push(`Errors:`);
    for (const e of result.errors) lines.push(`  ! ${e}`);
  }
  return lines.length > 0 ? lines.join("\n") : "No skills found to install.";
}

function execCreateAgentSkill(polpo: Orchestrator, args: Record<string, unknown>): string {
  // Gate: force reading skill-creator guidelines before creating any skill
  if (!_skillCreatorRead) {
    _skillCreatorRead = true;
    return `MANDATORY: Read the skill-creator guidelines below before creating a skill. After reading, call create_agent_skill again with the same arguments.\n\n${BUILTIN_SKILL_CREATOR_CONTENT}`;
  }

  const name = args.name as string;
  const description = args.description as string;
  const content = args.content as string;
  const allowedTools = args.allowedTools as string[] | undefined;

  const polpoDir = polpo.getPolpoDir();
  const cwd = polpo.getWorkDir();

  // Check if already exists
  const existing = discoverSkills(cwd, polpoDir);
  if (existing.some(s => s.name === name)) {
    return `Error: Agent skill "${name}" already exists. Use install_agent_skill with force, or remove it first.`;
  }

  const skillPath = createAgentSkill(polpoDir, name, description, content, { allowedTools });
  return `Created agent skill "${name}" at ${skillPath}. Assign it to agents with update_agent (add to their skills array).`;
}

function execRemoveAgentSkill(polpo: Orchestrator, args: Record<string, unknown>): string {
  const name = args.name as string;
  const ok = removeSkill(polpo.getPolpoDir(), name);
  if (!ok) return `Error: Agent skill "${name}" not found.`;
  return `Removed agent skill "${name}"`;
}

function execGetSkill(polpo: Orchestrator, args: Record<string, unknown>): string {
  const name = args.name as string;
  const pool = (args.pool as "agent" | "orchestrator" | undefined) ?? "agent";
  const cwd = polpo.getWorkDir();
  const polpoDir = polpo.getPolpoDir();

  // If asking for the built-in skill-creator, return it directly and mark as read
  if (name === "skill-creator") {
    _skillCreatorRead = true;
    return `Skill: skill-creator\nDescription: Guidelines for creating high-quality Polpo skills\nSource: built-in\n\n--- Content ---\n\n${BUILTIN_SKILL_CREATOR_CONTENT}`;
  }

  const skill = getSkillByName(cwd, polpoDir, name, pool);
  if (!skill) {
    return `Error: Skill "${name}" not found in the ${pool} pool.`;
  }

  const lines = [
    `Skill: ${skill.name}`,
    `Description: ${skill.description || "(none)"}`,
    `Source: ${skill.source}`,
    `Path: ${skill.path}`,
  ];
  if (skill.allowedTools?.length) {
    lines.push(`Allowed tools: ${skill.allowedTools.join(", ")}`);
  }
  if (skill.tags?.length) {
    lines.push(`Tags: ${skill.tags.join(", ")}`);
  }
  if (skill.category) {
    lines.push(`Category: ${skill.category}`);
  }
  lines.push("", "--- Content ---", "", skill.content);
  return lines.join("\n");
}

function execTagSkill(polpo: Orchestrator, args: Record<string, unknown>): string {
  const name = args.name as string;
  const tags = args.tags as string[] | undefined;
  const category = args.category as string | undefined;

  if (!tags && !category) {
    return "Error: At least one of 'tags' or 'category' must be provided.";
  }

  const polpoDir = polpo.getPolpoDir();
  const cwd = polpo.getWorkDir();

  // Verify the skill exists
  const skills = discoverSkills(cwd, polpoDir);
  const skill = skills.find(s => s.name === name);
  if (!skill) {
    return `Error: Skill "${name}" not found in the skill pool.`;
  }

  const entry: Record<string, unknown> = {};
  if (tags) entry.tags = tags;
  if (category) entry.category = category;

  updateSkillIndex(polpoDir, name, entry as { tags?: string[]; category?: string });

  const parts = [`Skill "${name}" index updated.`];
  if (tags) parts.push(`Tags: ${tags.join(", ")}`);
  if (category) parts.push(`Category: ${category}`);
  return parts.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════
//  BUILT-IN SKILL-CREATOR — mandatory reading before creating any skill
// ═══════════════════════════════════════════════════════════════════════

/**
 * The built-in skill-creator guidelines. The orchestrator MUST read these
 * (via get_skill or automatically) before creating any skill.
 */
export const BUILTIN_SKILL_CREATOR_CONTENT = `# Skill Creator Guidelines

You are creating a Polpo skill — a reusable knowledge package that enhances an agent's (or the orchestrator's) capabilities for specific domains.

## Skill Structure

Every skill is a directory containing a single \`SKILL.md\` file:

\`\`\`
skill-name/
  SKILL.md
\`\`\`

The \`SKILL.md\` has two parts: YAML frontmatter and markdown body.

### YAML Frontmatter (required)

\`\`\`yaml
---
name: skill-name
description: One-line description of what this skill does (max 120 chars)
allowed-tools:
  - tool_name_1
  - tool_name_2
---
\`\`\`

- **name**: kebab-case, lowercase, descriptive (e.g. \`api-testing\`, \`react-patterns\`, \`code-review\`)
- **description**: What the skill teaches the agent to do — be specific, not vague
- **allowed-tools**: Optional list of tool names this skill may need. Purely informational for filtering.

### Markdown Body (the actual skill content)

This is the core — it's injected directly into the agent's system prompt. Write it as if you're giving expert instructions to a capable developer.

## Quality Standards

### DO:
- Start with a clear purpose statement: what this skill is for and when to use it
- Organize with clear \`##\` sections and \`###\` subsections
- Include concrete examples with code blocks
- Provide decision trees: "If X, do Y. If Z, do W."
- List anti-patterns and common mistakes to avoid
- Keep instructions actionable — every section should tell the agent what to DO
- Use bullet points for rules, numbered lists for sequential steps
- Include file path patterns where relevant (e.g. "Look for config in \`src/config/\`")

### DON'T:
- Write vague/generic advice ("write clean code") — be specific
- Include information the agent already knows (basic language syntax, etc.)
- Make the skill too broad — focus on one domain/task
- Write walls of text without structure
- Include credentials, secrets, or environment-specific paths
- Exceed ~3000 words — keep it focused and scannable

## Recommended Sections

1. **Overview** — What this skill does, when to apply it
2. **Key Concepts** — Domain-specific knowledge the agent needs
3. **Workflow** — Step-by-step process for the main task
4. **Patterns & Examples** — Code examples, templates, common patterns
5. **Anti-patterns** — What NOT to do, common mistakes
6. **Checklist** — Quick verification list before considering the task done

## Example Skill

\`\`\`markdown
---
name: api-testing
description: Write comprehensive API endpoint tests with proper mocking, edge cases, and assertions
allowed-tools:
  - read
  - write
  - bash
---

# API Testing

This skill guides you in writing thorough API endpoint tests.

## When to Use
- Creating new API endpoints
- Adding test coverage to existing endpoints
- Reviewing API test quality

## Workflow
1. Read the endpoint implementation to understand inputs/outputs
2. Identify all code paths (success, validation errors, auth failures, edge cases)
3. Write test file following the patterns below
4. Run tests to verify

## Patterns

### Basic endpoint test
\\\`\\\`\\\`typescript
describe("POST /api/items", () => {
  it("creates item with valid data", async () => {
    const res = await request(app)
      .post("/api/items")
      .send({ name: "Test", value: 42 });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Test");
  });

  it("rejects invalid payload", async () => {
    const res = await request(app)
      .post("/api/items")
      .send({});
    expect(res.status).toBe(400);
  });
});
\\\`\\\`\\\`

## Anti-patterns
- Testing only the happy path — always test error cases
- Hardcoding IDs or timestamps in assertions
- Not cleaning up test data between runs

## Checklist
- [ ] All HTTP methods tested
- [ ] Validation errors covered
- [ ] Auth/permission checks tested
- [ ] Edge cases (empty input, large payload, special chars)
- [ ] Response shape assertions (not just status codes)
\`\`\`

## Creating the Skill

Use \`create_orchestrator_skill\` or \`create_agent_skill\` with:
- **name**: The kebab-case directory name
- **description**: The frontmatter description
- **content**: The markdown body (everything AFTER the frontmatter)
- **allowedTools**: Optional array of tool names

The tool handles writing the SKILL.md file with proper frontmatter automatically.
`;

/**
 * Session-level flag: set to true after the orchestrator reads the skill-creator
 * guidelines (either via get_skill or the built-in). This gate prevents creating
 * skills without first understanding the format.
 *
 * Reset on each new session (module scope = per process).
 */
let _skillCreatorRead = false;

/** Mark that the skill-creator guidelines have been read in this session. */
export function markSkillCreatorRead(): void { _skillCreatorRead = true; }

/** Check whether the skill-creator guidelines have been read. */
export function hasReadSkillCreator(): boolean { return _skillCreatorRead; }

/** Reset the gate (for tests). */
export function resetSkillCreatorGate(): void { _skillCreatorRead = false; }

// ═══════════════════════════════════════════════════════════════════════
//  FILE SYSTEM EXECUTORS
// ═══════════════════════════════════════════════════════════════════════

/** Resolve a path argument relative to the project work directory. */
function resolveFilePath(polpo: Orchestrator, pathArg: string): string {
  if (isAbsolute(pathArg)) return pathArg;
  return resolve(polpo.getWorkDir(), pathArg);
}

function execReadFile(polpo: Orchestrator, args: Record<string, unknown>): string {
  const filePath = resolveFilePath(polpo, args.path as string);
  if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;

  const stat = statSync(filePath);
  if (stat.isDirectory()) return `Error: Path is a directory, not a file: ${filePath}. Use list_directory instead.`;

  const content = readFileSync(filePath, "utf-8");
  const allLines = content.split("\n");
  const offset = Math.max(1, (args.offset as number | undefined) ?? 1);
  const limit = Math.min(2000, (args.limit as number | undefined) ?? 500);
  const slice = allLines.slice(offset - 1, offset - 1 + limit);

  const numbered = slice.map((line, i) => `${offset + i}: ${line}`).join("\n");
  const totalLines = allLines.length;
  const shown = slice.length;

  let suffix = "";
  if (offset + shown - 1 < totalLines) {
    suffix = `\n\n(Showing lines ${offset}-${offset + shown - 1} of ${totalLines}. Use offset=${offset + shown} to continue.)`;
  }
  return numbered + suffix;
}

function execWriteFile(polpo: Orchestrator, args: Record<string, unknown>): string {
  const filePath = resolveFilePath(polpo, args.path as string);
  const content = args.content as string;

  // Create parent directories if needed
  const dir = join(filePath, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(filePath, content, "utf-8");
  const lines = content.split("\n").length;
  const relPath = relative(polpo.getWorkDir(), filePath);
  return `Wrote ${lines} lines to ${relPath}`;
}

function execEditFile(polpo: Orchestrator, args: Record<string, unknown>): string {
  const filePath = resolveFilePath(polpo, args.path as string);
  if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;

  const oldString = args.oldString as string;
  const newString = args.newString as string;
  const replaceAll = (args.replaceAll as boolean | undefined) ?? false;

  let content = readFileSync(filePath, "utf-8");

  if (!content.includes(oldString)) {
    return `Error: oldString not found in ${relative(polpo.getWorkDir(), filePath)}`;
  }

  if (!replaceAll) {
    // Check for multiple matches
    const firstIdx = content.indexOf(oldString);
    const secondIdx = content.indexOf(oldString, firstIdx + 1);
    if (secondIdx !== -1) {
      return `Error: Found multiple matches for oldString in ${relative(polpo.getWorkDir(), filePath)}. Use replaceAll=true or provide more context to make the match unique.`;
    }
    content = content.replace(oldString, newString);
  } else {
    content = content.split(oldString).join(newString);
  }

  writeFileSync(filePath, content, "utf-8");
  return `Edited ${relative(polpo.getWorkDir(), filePath)}`;
}

function execListDirectory(polpo: Orchestrator, args: Record<string, unknown>): string {
  const pathArg = (args.path as string | undefined) ?? ".";

  // Check if it looks like a glob pattern
  if (pathArg.includes("*") || pathArg.includes("?")) {
    // Use find/glob via shell — more reliable for glob patterns
    try {
      const cwd = polpo.getWorkDir();
      const result = execSync(`find . -path '${pathArg}' -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -200`, {
        cwd,
        encoding: "utf-8",
        timeout: 10000,
      }).trim();
      return result || "(no matches)";
    } catch {
      return "(no matches)";
    }
  }

  const dirPath = resolveFilePath(polpo, pathArg);
  if (!existsSync(dirPath)) return `Error: Path not found: ${dirPath}`;

  const stat = statSync(dirPath);
  if (!stat.isDirectory()) return `Error: Not a directory: ${dirPath}`;

  const entries = readdirSync(dirPath);
  const formatted = entries.map(name => {
    try {
      const s = statSync(join(dirPath, name));
      return s.isDirectory() ? `${name}/` : name;
    } catch {
      return name;
    }
  });

  return formatted.join("\n") || "(empty directory)";
}

function execGrepFiles(polpo: Orchestrator, args: Record<string, unknown>): string {
  const pattern = args.pattern as string;
  const searchPath = resolveFilePath(polpo, (args.path as string | undefined) ?? ".");
  const include = args.include as string | undefined;

  // Build grep command
  let cmd = `grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.json' --include='*.md' --include='*.yaml' --include='*.yml' --include='*.toml' --include='*.css' --include='*.html'`;
  if (include) {
    // Override with user-specified include
    cmd = `grep -rn --include='${include}'`;
  }
  cmd += ` -E '${pattern.replace(/'/g, "'\\''")}' '${searchPath}' 2>/dev/null | head -100`;

  try {
    const result = execSync(cmd, {
      cwd: polpo.getWorkDir(),
      encoding: "utf-8",
      timeout: 15000,
    }).trim();
    if (!result) return "(no matches)";

    // Make paths relative
    const workDir = polpo.getWorkDir();
    return result.split("\n").map(line => {
      if (line.startsWith(workDir)) {
        return line.slice(workDir.length + 1);
      }
      return line;
    }).join("\n");
  } catch {
    return "(no matches)";
  }
}

function execRunCommand(polpo: Orchestrator, args: Record<string, unknown>): string {
  const command = args.command as string;
  const cwdArg = args.cwd as string | undefined;
  const cwd = cwdArg ? resolveFilePath(polpo, cwdArg) : polpo.getWorkDir();

  // Block obviously dangerous commands
  const dangerous = ["rm -rf /", "rm -rf /*", "mkfs", "dd if=", ":(){", "chmod -R 777 /"];
  for (const d of dangerous) {
    if (command.includes(d)) {
      return `Error: Blocked potentially dangerous command: ${command}`;
    }
  }

  try {
    const result = execSync(command, {
      cwd,
      encoding: "utf-8",
      timeout: 30000,
      maxBuffer: 1024 * 1024, // 1MB
    });
    return result.trim() || "(command completed with no output)";
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    const parts: string[] = [];
    if (e.stdout) parts.push(e.stdout.trim());
    if (e.stderr) parts.push(e.stderr.trim());
    if (parts.length === 0) parts.push(e.message ?? "Command failed");
    return `Exit code ${e.status ?? 1}:\n${parts.join("\n")}`;
  }
}

// ═══════════════════════════════════════════════════════
//  HTTP EXECUTORS
// ═══════════════════════════════════════════════════════

const HTTP_MAX_RESPONSE_BYTES = 100_000;
const HTTP_DEFAULT_TIMEOUT = 30_000;

async function execHttpFetch(_polpo: Orchestrator, args: Record<string, unknown>): Promise<string> {
  const url = args.url as string;
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return "Error: URL must start with http:// or https://";
  }

  try {
    assertUrlAllowed(url);
  } catch (err: any) {
    return `Error: ${err.message}`;
  }

  const method = (args.method as string | undefined) ?? "GET";
  const timeout = (args.timeout as number | undefined) ?? HTTP_DEFAULT_TIMEOUT;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      method,
      headers: args.headers as Record<string, string> | undefined,
      body: args.body as string | undefined,
      signal: controller.signal,
      redirect: "follow",
    });

    clearTimeout(timer);

    const contentType = response.headers.get("content-type") ?? "";
    const isText = contentType.includes("text") || contentType.includes("json") ||
      contentType.includes("xml") || contentType.includes("javascript") ||
      contentType.includes("html") || contentType.includes("css") ||
      contentType.includes("svg");

    let body: string;
    if (isText) {
      const text = await response.text();
      body = text.length > HTTP_MAX_RESPONSE_BYTES
        ? text.slice(0, HTTP_MAX_RESPONSE_BYTES) + `\n[truncated — ${text.length} total bytes]`
        : text;
    } else {
      const buffer = await response.arrayBuffer();
      body = `[Binary response: ${buffer.byteLength} bytes, content-type: ${contentType}]`;
    }

    // Extract relevant response headers
    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of response.headers.entries()) {
      if (["content-type", "content-length", "location", "set-cookie",
           "cache-control", "x-ratelimit-remaining", "retry-after"].includes(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    }

    return [
      `Status: ${response.status} ${response.statusText}`,
      `Headers: ${JSON.stringify(responseHeaders)}`,
      ``,
      body,
    ].join("\n");
  } catch (err: any) {
    const message = err.name === "AbortError" ? "Request timed out" : err.message;
    return `Error: HTTP ${method} ${url} — ${message}`;
  }
}

async function execHttpDownload(polpo: Orchestrator, args: Record<string, unknown>): Promise<string> {
  const url = args.url as string;
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return "Error: URL must start with http:// or https://";
  }

  try {
    assertUrlAllowed(url);
  } catch (err: any) {
    return `Error: ${err.message}`;
  }

  const filePath = resolveFilePath(polpo, args.path as string);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000); // 2 min for downloads

    const response = await fetch(url, {
      headers: args.headers as Record<string, string> | undefined,
      signal: controller.signal,
      redirect: "follow",
    });

    clearTimeout(timer);

    if (!response.ok) {
      return `Error: Download failed — ${response.status} ${response.statusText}`;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, buffer);

    const relPath = relative(polpo.getWorkDir(), filePath);
    return `Downloaded ${buffer.byteLength} bytes to ${relPath}`;
  } catch (err: any) {
    const message = err.name === "AbortError" ? "Download timed out" : err.message;
    return `Error: Download ${url} — ${message}`;
  }
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
