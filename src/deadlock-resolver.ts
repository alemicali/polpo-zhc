/**
 * Deadlock resolution: LLM-powered dependency unblocking.
 *
 * When a plan task fails and blocks downstream dependents, the resolver
 * analyzes the failure and decides whether blocked tasks can proceed
 * (absorb), whether the failed dep should be retried, or whether the
 * chain should be failed.
 */

import type { Task } from "./core/types.js";
import type { Orchestrator } from "./orchestrator.js";
import { querySDKText } from "./llm/query.js";

// ── Types ─────────────────────────────────────────────

export interface BlockageInfo {
  task: Task;            // the blocked task
  failedDeps: Task[];    // direct or root-cause deps with status "failed"
  missingDeps: string[]; // dep IDs that don't exist in the task list
}

export interface BlockageAnalysis {
  resolvable: BlockageInfo[];   // at least 1 failed dep → LLM can decide
  unresolvable: BlockageInfo[]; // ONLY missing deps → force-fail
}

interface ResolutionDecision {
  action: "absorb" | "retry" | "fail";
  reason: string;
  absorbedDescription?: string;
}

// ── State ─────────────────────────────────────────────

let resolving = false;

/** Whether an async resolution is currently in progress. */
export function isResolving(): boolean {
  return resolving;
}

// ── Analysis ──────────────────────────────────────────

/**
 * Classify each pending task's blockage: resolvable (failed deps) vs
 * unresolvable (missing deps). Follows cascade chains to root failures.
 */
export function analyzeBlockedTasks(pending: Task[], allTasks: Task[]): BlockageAnalysis {
  const taskMap = new Map(allTasks.map(t => [t.id, t]));
  const resolvable: BlockageInfo[] = [];
  const unresolvable: BlockageInfo[] = [];

  for (const task of pending) {
    const failedDeps: Task[] = [];
    const missingDeps: string[] = [];

    for (const depId of task.dependsOn) {
      const dep = taskMap.get(depId);
      if (!dep) {
        missingDeps.push(depId);
        continue;
      }

      if (dep.status === "failed") {
        failedDeps.push(dep);
      } else if (dep.status === "pending") {
        // Cascade: dep is pending but itself blocked — find root cause
        const root = findRootFailure(dep, taskMap, new Set());
        if (root) {
          failedDeps.push(root);
        } else {
          // Pending dep with no root failure found — treat as missing
          missingDeps.push(depId);
        }
      }
      // dep.status === "done" → this dep is fine, skip
    }

    if (failedDeps.length > 0) {
      resolvable.push({ task, failedDeps, missingDeps });
    } else if (missingDeps.length > 0) {
      unresolvable.push({ task, failedDeps: [], missingDeps });
    }
    // If neither: all deps are done (shouldn't be here) or still running
  }

  return { resolvable, unresolvable };
}

/**
 * Walk the dependency chain to find the root failed task.
 * Returns the first failed ancestor, or null if no failed root found.
 */
function findRootFailure(task: Task, taskMap: Map<string, Task>, visited: Set<string>): Task | null {
  if (visited.has(task.id)) return null; // circular
  visited.add(task.id);

  for (const depId of task.dependsOn) {
    const dep = taskMap.get(depId);
    if (!dep) continue;
    if (dep.status === "failed") return dep;
    if (dep.status === "pending") {
      const root = findRootFailure(dep, taskMap, visited);
      if (root) return root;
    }
  }
  return null;
}

// ── Resolution ────────────────────────────────────────

/**
 * Async deadlock resolution. For each resolvable blockage, calls LLM
 * to decide action (absorb/retry/fail) and applies the decision.
 *
 * Pattern: fire-and-forget from tick(), results applied via registry.updateTask()
 * and picked up on next tick.
 */
export async function resolveDeadlock(
  analysis: BlockageAnalysis,
  orchestrator: Orchestrator,
  cwd: string,
): Promise<void> {
  resolving = true;
  try {
    const settings = orchestrator.getConfig()?.settings;
    const maxAttempts = settings?.maxResolutionAttempts ?? 2;
    const model = settings?.orchestratorModel;
    const memory = orchestrator.getMemory();
    const allTasks = orchestrator.getStore().getAllTasks();

    // Deduplicate: if multiple blocked tasks share the same failed dep,
    // process each blocked task independently but track retried deps
    const retriedDeps = new Set<string>();

    for (const blockage of analysis.resolvable) {
      const task = blockage.task;

      // Guard: max resolution attempts
      if ((task.resolutionAttempts ?? 0) >= maxAttempts) {
        orchestrator.emit("deadlock:unresolvable", {
          taskId: task.id,
          reason: "max resolution attempts reached",
        });
        forceFailTask(orchestrator, task.id);
        continue;
      }

      // Use the first (most relevant) failed dep for the LLM prompt
      const failedDep = blockage.failedDeps[0];
      orchestrator.emit("deadlock:resolving", {
        taskId: task.id,
        failedDepId: failedDep.id,
      });

      let decision: ResolutionDecision;
      try {
        decision = await classifyBlockage(task, failedDep, allTasks, memory, cwd, model);
      } catch {
        // LLM call failed → fail this task
        orchestrator.emit("deadlock:unresolvable", {
          taskId: task.id,
          reason: "LLM analysis failed",
        });
        forceFailTask(orchestrator, task.id);
        continue;
      }

      applyDecision(decision, task, failedDep, blockage, orchestrator, retriedDeps);
    }

    // Force-fail unresolvable tasks (missing deps)
    for (const blockage of analysis.unresolvable) {
      orchestrator.emit("deadlock:unresolvable", {
        taskId: blockage.task.id,
        reason: `missing dependencies: ${blockage.missingDeps.join(", ")}`,
      });
      forceFailTask(orchestrator, blockage.task.id);
    }
  } finally {
    resolving = false;
  }
}

// ── LLM Classification ───────────────────────────────

async function classifyBlockage(
  blockedTask: Task,
  failedDep: Task,
  allTasks: Task[],
  memory: string,
  cwd: string,
  model?: string,
): Promise<ResolutionDecision> {
  const prompt = buildResolutionPrompt(blockedTask, failedDep, allTasks, memory);
  const response = await querySDKText(prompt, cwd, model);

  try {
    const cleaned = response.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    const action = parsed.action;
    if (action !== "absorb" && action !== "retry" && action !== "fail") {
      return { action: "fail", reason: "invalid LLM response" };
    }
    return {
      action,
      reason: parsed.reason || "no reason provided",
      absorbedDescription: parsed.absorbedDescription,
    };
  } catch {
    return { action: "fail", reason: "failed to parse LLM response" };
  }
}

function buildResolutionPrompt(
  blockedTask: Task,
  failedDep: Task,
  allTasks: Task[],
  memory: string,
): string {
  const siblings = blockedTask.group
    ? allTasks.filter(t => t.group === blockedTask.group && t.id !== blockedTask.id && t.id !== failedDep.id && t.status === "done")
    : [];

  const errorInfo = failedDep.result
    ? (failedDep.result.stderr || `exit code ${failedDep.result.exitCode}`)
    : "unknown error";

  const assessmentInfo = failedDep.result?.assessment
    ? `\nAssessment score: ${failedDep.result.assessment.globalScore?.toFixed(1) ?? "N/A"}/5`
    : "";

  const resultExcerpt = failedDep.result?.stdout
    ? `\nResult output (last 500 chars): ${failedDep.result.stdout.slice(-500)}`
    : "";

  const parts = [
    `You are Polpo, an AI agent orchestration framework, managing a coding plan. A task has FAILED, blocking a downstream task.`,
    `Analyze the situation and decide how to unblock the downstream task.`,
    ``,
    `## Failed Task`,
    `Title: ${failedDep.title}`,
    `Description: ${failedDep.originalDescription || failedDep.description}`,
    `Error: ${errorInfo}${assessmentInfo}${resultExcerpt}`,
    ``,
    `## Blocked Downstream Task`,
    `Title: ${blockedTask.title}`,
    `Description: ${blockedTask.originalDescription || blockedTask.description}`,
  ];

  if (siblings.length > 0) {
    parts.push(``, `## Completed Siblings (same plan)`);
    for (const s of siblings.slice(0, 5)) {
      const resultBrief = s.result?.stdout ? s.result.stdout.slice(0, 150) : "";
      parts.push(`- [done] ${s.title}${resultBrief ? `: ${resultBrief}` : ""}`);
    }
  }

  if (memory) {
    parts.push(``, `## Project Memory`, memory.slice(0, 1000));
  }

  parts.push(
    ``,
    `## Decision`,
    `Choose ONE action:`,
    `- "absorb": The blocked task CAN proceed by incorporating the failed task's work into its own scope. Provide a clear updated description that tells the agent what extra work to do.`,
    `- "retry": The failed task should be retried (transient error, environment issue, might succeed on retry).`,
    `- "fail": The blocked task genuinely CANNOT proceed without the dependency. No workaround exists.`,
    ``,
    `Respond with ONLY a JSON object:`,
    `{"action": "absorb|retry|fail", "reason": "brief explanation", "absorbedDescription": "updated description for the blocked task if action is absorb"}`,
  );

  return parts.join("\n");
}

// ── Apply Decision ────────────────────────────────────

function applyDecision(
  decision: ResolutionDecision,
  blockedTask: Task,
  failedDep: Task,
  blockage: BlockageInfo,
  orchestrator: Orchestrator,
  retriedDeps: Set<string>,
): void {
  const store = orchestrator.getStore();

  switch (decision.action) {
    case "absorb": {
      // Save original description before first resolution
      if (!blockedTask.originalDescription) {
        store.updateTask(blockedTask.id, { originalDescription: blockedTask.description });
      }

      // Build absorbed description
      const errorInfo = failedDep.result
        ? (failedDep.result.stderr || `exit code ${failedDep.result.exitCode}`)
        : "unknown error";

      const absorbBlock = [
        `[Dependency Resolution]`,
        `The dependency "${failedDep.title}" could not be completed.`,
        `Original dependency task: ${(failedDep.originalDescription || failedDep.description).slice(0, 500)}`,
        `Error: ${errorInfo}`,
        `You must handle this work as part of your task.`,
        ``,
        decision.absorbedDescription || "",
        ``,
        `---`,
        `ORIGINAL TASK: ${blockedTask.originalDescription || blockedTask.description}`,
      ].join("\n");

      // Remove failed dep from dependsOn
      const newDeps = blockedTask.dependsOn.filter(id => id !== failedDep.id);
      // Also remove any other failed deps from this blockage
      const allFailedIds = new Set(blockage.failedDeps.map(d => d.id));
      const cleanDeps = newDeps.filter(id => !allFailedIds.has(id));

      store.updateTask(blockedTask.id, {
        dependsOn: cleanDeps,
        description: absorbBlock,
        status: "pending" as any,
        resolutionAttempts: (blockedTask.resolutionAttempts ?? 0) + 1,
      });

      orchestrator.emit("deadlock:resolved", {
        taskId: blockedTask.id,
        failedDepId: failedDep.id,
        action: "absorb",
        reason: decision.reason,
      });
      break;
    }

    case "retry": {
      // Retry the failed dep (if not already retried in this resolution round)
      if (!retriedDeps.has(failedDep.id)) {
        const fresh = store.getTask(failedDep.id);
        if (fresh && fresh.retries < fresh.maxRetries) {
          // Use transition to properly increment retries
          store.transition(failedDep.id, "pending");
          retriedDeps.add(failedDep.id);

          orchestrator.emit("deadlock:resolved", {
            taskId: blockedTask.id,
            failedDepId: failedDep.id,
            action: "retry",
            reason: decision.reason,
          });
        } else {
          // No retries left → force-fail the blocked task
          orchestrator.emit("deadlock:unresolvable", {
            taskId: blockedTask.id,
            reason: `dependency "${failedDep.title}" has no retries remaining`,
          });
          forceFailTask(orchestrator, blockedTask.id);
        }
      }
      // If already retried: do nothing, next tick will re-evaluate
      break;
    }

    case "fail":
    default: {
      orchestrator.emit("deadlock:unresolvable", {
        taskId: blockedTask.id,
        reason: decision.reason,
      });
      forceFailTask(orchestrator, blockedTask.id);
      break;
    }
  }
}

// ── Helpers ───────────────────────────────────────────

function forceFailTask(orchestrator: Orchestrator, taskId: string): void {
  const store = orchestrator.getStore();
  try {
    const task = store.getTask(taskId);
    if (!task || task.status === "done" || task.status === "failed") return;
    // Walk through state machine to reach failed
    if (task.status === "pending") store.transition(taskId, "assigned");
    const t2 = store.getTask(taskId);
    if (t2 && t2.status === "assigned") store.transition(taskId, "in_progress");
    const t3 = store.getTask(taskId);
    if (t3 && t3.status === "in_progress") store.transition(taskId, "failed");
    else if (t3 && t3.status === "review") store.transition(taskId, "failed");
  } catch { /* already terminal or transition error */ }
}
