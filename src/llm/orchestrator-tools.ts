/**
 * Orchestrator tools — tool definitions for conversational task/plan management.
 *
 * Read tools execute immediately. Write tools may require user approval
 * depending on the current approval mode (approval vs accept-all).
 */

import { Type } from "@sinclair/typebox";
import type { Tool } from "@mariozechner/pi-ai";
import type { Orchestrator } from "../core/orchestrator.js";

// ─── Read Tools ──────────────────────────────────────

const listTasksTool: Tool = {
  name: "list_tasks",
  description: "List all tasks. Optionally filter by status.",
  parameters: Type.Object({
    status: Type.Optional(Type.String({ description: "Filter by status: pending, assigned, in_progress, review, done, failed" })),
    group: Type.Optional(Type.String({ description: "Filter by plan group name" })),
  }),
};

const getTaskTool: Tool = {
  name: "get_task",
  description: "Get full details of a task by ID or title.",
  parameters: Type.Object({
    id: Type.Optional(Type.String({ description: "Task ID" })),
    title: Type.Optional(Type.String({ description: "Task title (partial match)" })),
  }),
};

const listPlansTool: Tool = {
  name: "list_plans",
  description: "List all plans. Optionally filter by status.",
  parameters: Type.Object({
    status: Type.Optional(Type.String({ description: "Filter by status: draft, active, completed, failed, cancelled" })),
  }),
};

const getPlanTool: Tool = {
  name: "get_plan",
  description: "Get full details of a plan by ID or name.",
  parameters: Type.Object({
    id: Type.Optional(Type.String({ description: "Plan ID" })),
    name: Type.Optional(Type.String({ description: "Plan name (partial match)" })),
  }),
};

const listAgentsTool: Tool = {
  name: "list_agents",
  description: "List all configured agents with their roles and models.",
  parameters: Type.Object({}),
};

const getStatusTool: Tool = {
  name: "get_status",
  description: "Get an overview of the orchestrator: task counts by status, active processes, team info.",
  parameters: Type.Object({}),
};

const getMemoryTool: Tool = {
  name: "get_memory",
  description: "Read the project memory content.",
  parameters: Type.Object({}),
};

// ─── Write Tools ─────────────────────────────────────

const createTaskTool: Tool = {
  name: "create_task",
  description: "Create a new task and assign it to an agent.",
  parameters: Type.Object({
    title: Type.String({ description: "Task title" }),
    description: Type.String({ description: "Detailed task description" }),
    assignTo: Type.String({ description: "Agent name to assign the task to" }),
    dependsOn: Type.Optional(Type.Array(Type.String(), { description: "IDs of tasks this depends on" })),
    group: Type.Optional(Type.String({ description: "Plan group name" })),
  }),
};

const updateTaskTool: Tool = {
  name: "update_task",
  description: "Update a task's description, assignment, or expectations.",
  parameters: Type.Object({
    taskId: Type.String({ description: "Task ID to update" }),
    description: Type.Optional(Type.String({ description: "New description" })),
    assignTo: Type.Optional(Type.String({ description: "New agent assignment" })),
  }),
};

const retryTaskTool: Tool = {
  name: "retry_task",
  description: "Retry a failed task. Resets it to pending status.",
  parameters: Type.Object({
    taskId: Type.String({ description: "Task ID to retry" }),
  }),
};

const killTaskTool: Tool = {
  name: "kill_task",
  description: "Kill a running task's process.",
  parameters: Type.Object({
    taskId: Type.String({ description: "Task ID to kill" }),
  }),
};

const deleteTasksTool: Tool = {
  name: "delete_tasks",
  description: "Delete tasks matching a filter.",
  parameters: Type.Object({
    status: Type.Optional(Type.String({ description: "Delete tasks with this status" })),
    group: Type.Optional(Type.String({ description: "Delete tasks in this plan group" })),
    all: Type.Optional(Type.Boolean({ description: "Delete ALL tasks (use with caution)" })),
  }),
};

const executePlanTool: Tool = {
  name: "execute_plan",
  description: "Execute a draft plan, creating tasks for all plan items.",
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

const deletePlanTool: Tool = {
  name: "delete_plan",
  description: "Delete a plan.",
  parameters: Type.Object({
    planId: Type.String({ description: "Plan ID to delete" }),
  }),
};

const saveMemoryTool: Tool = {
  name: "save_memory",
  description: "Overwrite the project memory with new content.",
  parameters: Type.Object({
    content: Type.String({ description: "New memory content" }),
  }),
};

const switchModeTool: Tool = {
  name: "switch_mode",
  description: "Switch the TUI input mode. Use 'plan' to enter plan creation mode, 'chat' to return to chat, or 'task' to create individual tasks.",
  parameters: Type.Object({
    mode: Type.Union([
      Type.Literal("chat"),
      Type.Literal("plan"),
      Type.Literal("task"),
    ], { description: "Target mode: chat, plan, or task" }),
  }),
};

// ─── Tool Collections ────────────────────────────────

export const READ_TOOLS = new Set([
  "list_tasks", "get_task", "list_plans", "get_plan",
  "list_agents", "get_status", "get_memory", "switch_mode",
]);

export const WRITE_TOOLS = new Set([
  "create_task", "update_task", "retry_task", "kill_task", "delete_tasks",
  "execute_plan", "resume_plan", "delete_plan", "save_memory",
]);

export function needsApproval(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}

export const ALL_ORCHESTRATOR_TOOLS: Tool[] = [
  // Read
  listTasksTool, getTaskTool, listPlansTool, getPlanTool,
  listAgentsTool, getStatusTool, getMemoryTool,
  // Write
  createTaskTool, updateTaskTool, retryTaskTool, killTaskTool, deleteTasksTool,
  executePlanTool, resumePlanTool, deletePlanTool, saveMemoryTool,
  switchModeTool,
];

// ─── Tool Executor ───────────────────────────────────

export function executeOrchestratorTool(
  toolName: string,
  args: Record<string, unknown>,
  polpo: Orchestrator,
): string {
  try {
    switch (toolName) {
      // ── Read tools ──
      case "list_tasks":
        return execListTasks(polpo, args);
      case "get_task":
        return execGetTask(polpo, args);
      case "list_plans":
        return execListPlans(polpo, args);
      case "get_plan":
        return execGetPlan(polpo, args);
      case "list_agents":
        return execListAgents(polpo);
      case "get_status":
        return execGetStatus(polpo);
      case "get_memory":
        return execGetMemory(polpo);

      // ── Write tools ──
      case "create_task":
        return execCreateTask(polpo, args);
      case "update_task":
        return execUpdateTask(polpo, args);
      case "retry_task":
        return execRetryTask(polpo, args);
      case "kill_task":
        return execKillTask(polpo, args);
      case "delete_tasks":
        return execDeleteTasks(polpo, args);
      case "execute_plan":
        return execExecutePlan(polpo, args);
      case "resume_plan":
        return execResumePlan(polpo, args);
      case "delete_plan":
        return execDeletePlan(polpo, args);
      case "save_memory":
        return execSaveMemory(polpo, args);
      case "switch_mode":
        return `__switch_mode:${args.mode ?? "chat"}`;

      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: ${msg}`;
  }
}

/** Tool action labels for the approval prompt title. */
const TOOL_LABELS: Record<string, string> = {
  create_task: "Create Task",
  update_task: "Update Task",
  retry_task: "Retry Task",
  kill_task: "Kill Task",
  delete_tasks: "Delete Tasks",
  execute_plan: "Execute Plan",
  resume_plan: "Resume Plan",
  delete_plan: "Delete Plan",
  save_memory: "Save Memory",
};

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

/** Resolve a human-readable target name (plan name, task title) from args. */
function resolveTargetName(
  toolName: string,
  args: Record<string, unknown>,
  polpo?: Orchestrator,
): string | null {
  // Task tools: resolve task title from ID
  if (args.taskId && polpo) {
    try {
      const state = polpo.getStore()?.getState();
      const task = state?.tasks.find(t => t.id === args.taskId);
      if (task) return `"${task.title}"`;
    } catch { /* ignore */ }
    return String(args.taskId);
  }

  // Plan tools: resolve plan name from ID
  if (args.planId && polpo) {
    try {
      const plan = polpo.getPlan(String(args.planId));
      if (plan) return `"${plan.name}"`;
    } catch { /* ignore */ }
    return String(args.planId);
  }

  // Create task: use title from args
  if (toolName === "create_task" && args.title) {
    return `"${String(args.title)}"`;
  }

  // Delete tasks: describe scope
  if (toolName === "delete_tasks") {
    if (args.all) return "ALL tasks";
    if (args.group) return `group "${args.group}"`;
    if (args.status) return `status: ${args.status}`;
  }

  // Save memory: no specific target
  return null;
}

/**
 * Return structured detail lines for the approval prompt.
 * Each entry is [label, value]. The compact view shows only essential fields;
 * expanded view shows everything.
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

  // Helper: resolve task or plan name
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

  // Always show the action as first field
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
    case "retry_task":
      main.push(["Task", resolveTask(args.taskId)]);
      break;
    case "kill_task":
      main.push(["Task", resolveTask(args.taskId)]);
      break;
    case "delete_tasks":
      if (args.all) main.push(["Scope", "ALL tasks"]);
      if (args.status) main.push(["Status filter", String(args.status)]);
      if (args.group) main.push(["Group filter", String(args.group)]);
      if (!args.all && !args.status && !args.group) main.push(["Scope", "no filter specified"]);
      break;
    case "execute_plan":
      main.push(["Plan", resolvePlan(args.planId)]);
      break;
    case "resume_plan":
      main.push(["Plan", resolvePlan(args.planId)]);
      if (args.retryFailed) main.push(["Retry failed", "yes"]);
      break;
    case "delete_plan":
      main.push(["Plan", resolvePlan(args.planId)]);
      break;
    case "save_memory":
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

// ─── Read Implementations ────────────────────────────

function execListTasks(polpo: Orchestrator, args: Record<string, unknown>): string {
  const state = polpo.getStore().getState();
  let tasks = state.tasks;
  if (args.status) {
    tasks = tasks.filter(t => t.status === args.status);
  }
  if (args.group) {
    tasks = tasks.filter(t => t.group === args.group);
  }
  if (tasks.length === 0) return "No tasks found.";
  const lines = tasks.map(t =>
    `[${t.id}] ${t.status.toUpperCase().padEnd(11)} ${t.title} → ${t.assignTo}${t.group ? ` (${t.group})` : ""}`
  );
  return `${tasks.length} task(s):\n${lines.join("\n")}`;
}

function execGetTask(polpo: Orchestrator, args: Record<string, unknown>): string {
  const store = polpo.getStore();
  let task;
  if (args.id) {
    task = store.getTask(args.id as string);
  }
  if (!task && args.title) {
    const needle = (args.title as string).toLowerCase();
    const all = store.getAllTasks();
    task = all.find(t => t.title.toLowerCase().includes(needle));
  }
  if (!task) return "Task not found.";
  return JSON.stringify(task, null, 2);
}

function execListPlans(polpo: Orchestrator, args: Record<string, unknown>): string {
  let plans = polpo.getAllPlans();
  if (args.status) {
    plans = plans.filter(p => p.status === args.status);
  }
  if (plans.length === 0) return "No plans found.";
  const lines = plans.map(p =>
    `[${p.id}] ${p.status.toUpperCase().padEnd(10)} ${p.name}${p.prompt ? ` — "${p.prompt.slice(0, 60)}"` : ""}`
  );
  return `${plans.length} plan(s):\n${lines.join("\n")}`;
}

function execGetPlan(polpo: Orchestrator, args: Record<string, unknown>): string {
  let plan;
  if (args.id) {
    plan = polpo.getPlan(args.id as string);
  }
  if (!plan && args.name) {
    plan = polpo.getPlanByName(args.name as string);
    if (!plan) {
      // Partial match
      const needle = (args.name as string).toLowerCase();
      const all = polpo.getAllPlans();
      plan = all.find(p => p.name.toLowerCase().includes(needle));
    }
  }
  if (!plan) return "Plan not found.";
  return JSON.stringify(plan, null, 2);
}

function execListAgents(polpo: Orchestrator): string {
  const agents = polpo.getAgents();
  if (agents.length === 0) return "No agents configured.";
  const lines = agents.map(a =>
    `• ${a.name}${a.role ? ` — ${a.role}` : ""}${a.model ? ` [${a.model}]` : ""}`
  );
  return `${agents.length} agent(s):\n${lines.join("\n")}`;
}

function execGetStatus(polpo: Orchestrator): string {
  const state = polpo.getStore().getState();
  const tasks = state.tasks;
  const processes = state.processes;
  const agents = polpo.getAgents();

  const counts: Record<string, number> = {};
  for (const t of tasks) {
    counts[t.status] = (counts[t.status] || 0) + 1;
  }

  const lines: string[] = [
    `Project: ${state.project}`,
    `Team: ${agents.length} agent(s)`,
    `Tasks: ${tasks.length} total`,
  ];
  for (const [status, count] of Object.entries(counts)) {
    lines.push(`  ${status}: ${count}`);
  }
  const alive = processes.filter(p => p.alive);
  lines.push(`Active processes: ${alive.length}`);
  if (alive.length > 0) {
    for (const p of alive) {
      lines.push(`  ${p.agentName} → task ${p.taskId}`);
    }
  }
  const plans = polpo.getAllPlans();
  if (plans.length > 0) {
    lines.push(`Plans: ${plans.length} total`);
    const planCounts: Record<string, number> = {};
    for (const p of plans) {
      planCounts[p.status] = (planCounts[p.status] || 0) + 1;
    }
    for (const [status, count] of Object.entries(planCounts)) {
      lines.push(`  ${status}: ${count}`);
    }
  }
  if (polpo.hasMemory()) {
    lines.push("Memory: available");
  }
  return lines.join("\n");
}

function execGetMemory(polpo: Orchestrator): string {
  if (!polpo.hasMemory()) return "No project memory configured.";
  const content = polpo.getMemory();
  return content || "(empty)";
}

// ─── Write Implementations ───────────────────────────

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
    if (!agents.find(a => a.name === args.assignTo)) {
      return `Error: Agent "${args.assignTo}" not found.`;
    }
    polpo.updateTaskAssignment(taskId, args.assignTo as string);
    changes.push(`assignment → ${args.assignTo}`);
  }
  if (changes.length === 0) return "No changes specified.";
  return `Task ${taskId} updated: ${changes.join(", ")}`;
}

function execRetryTask(polpo: Orchestrator, args: Record<string, unknown>): string {
  const taskId = args.taskId as string;
  polpo.retryTask(taskId);
  return `Task ${taskId} retried — reset to pending.`;
}

function execKillTask(polpo: Orchestrator, args: Record<string, unknown>): string {
  const taskId = args.taskId as string;
  const killed = polpo.killTask(taskId);
  return killed ? `Task ${taskId} killed.` : `Task ${taskId} — no running process found.`;
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

function execDeletePlan(polpo: Orchestrator, args: Record<string, unknown>): string {
  const planId = args.planId as string;
  const plan = polpo.getPlan(planId);
  if (!plan) return `Error: Plan "${planId}" not found.`;
  polpo.deletePlan(planId);
  return `Plan "${plan.name}" deleted.`;
}

function execSaveMemory(polpo: Orchestrator, args: Record<string, unknown>): string {
  polpo.saveMemory(args.content as string);
  return "Project memory updated.";
}
