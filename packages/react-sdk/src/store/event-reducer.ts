import type {
  Task,
  AgentProcess,
  SSEEvent,
  TaskStatus,
  DimensionScore,
  PlanReport,
  PlanStatus,
} from "../client/types.js";
import type { StoreState } from "./types.js";

/**
 * Pure function: produces next state from current state + SSE event.
 * Returns same reference if no change (structural sharing).
 */
export function reduceEvent(state: StoreState, sseEvent: SSEEvent): StoreState {
  const { event, data } = sseEvent;

  // Always push to recentEvents buffer (cap 200)
  const recentEvents = [...state.recentEvents.slice(-199), sseEvent];
  let next: StoreState = { ...state, recentEvents };

  switch (event) {
    // ── Task lifecycle ────────────────────────────────────────

    case "task:created": {
      const { task } = data as { task: Task };
      const tasks = new Map(state.tasks);
      tasks.set(task.id, task);
      return { ...next, tasks };
    }

    case "task:transition": {
      const { taskId, task } = data as { taskId: string; from: TaskStatus; to: TaskStatus; task: Task };
      const tasks = new Map(state.tasks);
      tasks.set(taskId, task);
      return { ...next, tasks };
    }

    case "task:updated": {
      const { taskId, task } = data as { taskId: string; task: Task };
      const tasks = new Map(state.tasks);
      tasks.set(taskId, task);
      return { ...next, tasks };
    }

    case "task:removed": {
      const { taskId } = data as { taskId: string };
      const tasks = new Map(state.tasks);
      tasks.delete(taskId);
      return { ...next, tasks };
    }

    case "task:retry": {
      const { taskId, attempt, maxRetries } = data as { taskId: string; attempt: number; maxRetries: number };
      const existing = state.tasks.get(taskId);
      if (existing) {
        const tasks = new Map(state.tasks);
        tasks.set(taskId, { ...existing, retries: attempt, maxRetries });
        return { ...next, tasks };
      }
      return next;
    }

    case "task:fix":
    case "task:maxRetries":
    case "task:question":
    case "task:answered":
    case "task:timeout":
    case "task:recovered":
      return next;

    // ── Agent lifecycle ───────────────────────────────────────

    case "agent:spawned": {
      const { taskId, agentName, taskTitle } = data as {
        taskId: string;
        agentName: string;
        adapter: string;
        taskTitle: string;
      };
      const process: AgentProcess = {
        agentName,
        pid: 0,
        taskId,
        startedAt: new Date().toISOString(),
        alive: true,
        activity: {
          filesCreated: [],
          filesEdited: [],
          toolCalls: 0,
          lastUpdate: new Date().toISOString(),
          summary: `Working on: ${taskTitle}`,
        },
      };
      return { ...next, processes: [...state.processes, process] };
    }

    case "agent:finished": {
      const { taskId } = data as { taskId: string; agentName: string; exitCode: number; duration: number };
      return {
        ...next,
        processes: state.processes.filter((p) => p.taskId !== taskId),
      };
    }

    case "agent:activity": {
      const payload = data as {
        taskId: string;
        agentName: string;
        tool?: string;
        file?: string;
        summary?: string;
      };
      const processes = state.processes.map((p) => {
        if (p.taskId !== payload.taskId) return p;
        return {
          ...p,
          activity: {
            ...p.activity,
            lastTool: payload.tool ?? p.activity.lastTool,
            lastFile: payload.file ?? p.activity.lastFile,
            toolCalls: p.activity.toolCalls + (payload.tool ? 1 : 0),
            lastUpdate: new Date().toISOString(),
            summary: payload.summary ?? p.activity.summary,
          },
        };
      });
      return { ...next, processes };
    }

    case "agent:stale":
      return next;

    // ── Assessment ────────────────────────────────────────────

    case "assessment:started":
    case "assessment:progress":
    case "assessment:corrected":
      return next;

    case "assessment:complete": {
      const { taskId, passed, scores, globalScore } = data as {
        taskId: string;
        passed: boolean;
        scores?: DimensionScore[];
        globalScore?: number;
        message?: string;
      };
      const existing = state.tasks.get(taskId);
      if (existing?.result) {
        const tasks = new Map(state.tasks);
        tasks.set(taskId, {
          ...existing,
          result: {
            ...existing.result,
            assessment: {
              passed,
              checks: existing.result.assessment?.checks ?? [],
              metrics: existing.result.assessment?.metrics ?? [],
              scores: scores ?? existing.result.assessment?.scores ?? [],
              globalScore: globalScore ?? existing.result.assessment?.globalScore,
              timestamp: new Date().toISOString(),
            },
          },
        });
        return { ...next, tasks };
      }
      return next;
    }

    // ── Orchestrator ──────────────────────────────────────────

    case "orchestrator:started":
    case "orchestrator:shutdown":
      return next;

    case "orchestrator:tick": {
      const incoming = data as {
        pending: number;
        running: number;
        done: number;
        failed: number;
        queued: number;
      };
      const prev = next.stats;
      // Reuse existing object if values haven't changed (stable reference for useSyncExternalStore)
      if (
        prev &&
        prev.pending === incoming.pending &&
        prev.running === incoming.running &&
        prev.done === incoming.done &&
        prev.failed === incoming.failed &&
        prev.queued === incoming.queued
      ) {
        return next;
      }
      return { ...next, stats: incoming };
    }

    case "orchestrator:deadlock":
    case "deadlock:detected":
    case "deadlock:resolving":
    case "deadlock:resolved":
    case "deadlock:unresolvable":
      return next;

    // ── Plans ─────────────────────────────────────────────────

    case "plan:saved": {
      const { planId, name, status } = data as { planId: string; name: string; status: PlanStatus };
      const existing = state.plans.get(planId);
      if (existing) {
        const plans = new Map(state.plans);
        plans.set(planId, { ...existing, name, status, updatedAt: new Date().toISOString() });
        return { ...next, plans, plansStale: true };
      }
      return { ...next, plansStale: true };
    }

    case "plan:executed": {
      const { planId } = data as { planId: string; group: string; taskCount: number };
      const existing = state.plans.get(planId);
      if (existing) {
        const plans = new Map(state.plans);
        plans.set(planId, { ...existing, status: "active" as PlanStatus, updatedAt: new Date().toISOString() });
        return { ...next, plans };
      }
      return { ...next, plansStale: true };
    }

    case "plan:completed": {
      const payload = data as { planId: string; group: string; allPassed: boolean; report: PlanReport };
      // Store the PlanReport — this is the only source of aggregated plan results
      const planReports = new Map(state.planReports);
      if (payload.report) {
        planReports.set(payload.planId, payload.report);
      }
      const existing = state.plans.get(payload.planId);
      if (existing) {
        const plans = new Map(state.plans);
        plans.set(payload.planId, {
          ...existing,
          status: payload.allPassed ? ("completed" as PlanStatus) : ("failed" as PlanStatus),
          updatedAt: new Date().toISOString(),
        });
        return { ...next, plans, planReports };
      }
      return { ...next, plansStale: true, planReports };
    }

    case "plan:resumed":
      return { ...next, plansStale: true };

    case "plan:deleted": {
      const { planId } = data as { planId: string };
      const plans = new Map(state.plans);
      plans.delete(planId);
      return { ...next, plans };
    }

    // ── Log ───────────────────────────────────────────────────

    case "log":
    default:
      return next;
  }
}
