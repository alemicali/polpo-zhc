import type {
  Task,
  AgentProcess,
  SSEEvent,
  TaskStatus,
  DimensionScore,
  MissionReport,
  MissionStatus,
  MissionDelay,
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
    case "task:retry:blocked":
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
          totalTokens: 0,
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

    case "assessment:started": {
      const { taskId } = data as { taskId: string };
      const assessmentProgress = new Map(state.assessmentProgress);
      assessmentProgress.set(taskId, [{ message: "Assessment started", timestamp: Date.now() }]);
      return { ...next, assessmentProgress };
    }

    case "assessment:progress": {
      const { taskId, message } = data as { taskId: string; message: string };
      const assessmentProgress = new Map(state.assessmentProgress);
      const existing = assessmentProgress.get(taskId) ?? [];
      assessmentProgress.set(taskId, [...existing, { message, timestamp: Date.now() }]);
      return { ...next, assessmentProgress };
    }

    case "assessment:check:started":
    case "assessment:check:complete": {
      const { taskId, index, total, type, label, phase, passed, message: checkMsg } = data as {
        taskId: string; index: number; total: number; type: string; label: string;
        phase: "started" | "complete"; passed?: boolean; message?: string;
      };
      const assessmentChecks = new Map(state.assessmentChecks);
      const existing = assessmentChecks.get(taskId) ?? [];
      // Replace if same index+phase already exists, otherwise append
      const filtered = existing.filter(c => !(c.index === index && c.phase === phase));
      filtered.push({ index, total, type, label, phase, passed, message: checkMsg, timestamp: Date.now() });
      assessmentChecks.set(taskId, filtered);
      return { ...next, assessmentChecks };
    }

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
      // Clear assessment progress and check status for this task
      const assessmentProgress = new Map(state.assessmentProgress);
      assessmentProgress.delete(taskId);
      const assessmentChecks2 = new Map(state.assessmentChecks);
      assessmentChecks2.delete(taskId);
      next = { ...next, assessmentProgress, assessmentChecks: assessmentChecks2 };

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

    // ── Missions ──────────────────────────────────────────────

    case "mission:saved": {
      const { missionId, name, status } = data as { missionId: string; name: string; status: MissionStatus };
      const existing = state.missions.get(missionId);
      if (existing) {
        const missions = new Map(state.missions);
        missions.set(missionId, { ...existing, name, status, updatedAt: new Date().toISOString() });
        return { ...next, missions, missionsStale: true };
      }
      return { ...next, missionsStale: true };
    }

    case "mission:executed": {
      const { missionId } = data as { missionId: string; group: string; taskCount: number };
      const existing = state.missions.get(missionId);
      if (existing) {
        const missions = new Map(state.missions);
        missions.set(missionId, { ...existing, status: "active" as MissionStatus, updatedAt: new Date().toISOString() });
        return { ...next, missions };
      }
      // Don't set missionsStale here — the preceding mission:saved event already
      // triggered a refetch. Setting stale again causes a race where overlapping
      // fetches loop (mission:saved stale → fetch starts → mission:executed arrives
      // before fetch completes → mission not in store yet → stale again → loop).
      return next;
    }

    case "mission:completed": {
      const payload = data as { missionId: string; group: string; allPassed: boolean; report: MissionReport };
      // Store the MissionReport — this is the only source of aggregated mission results
      const missionReports = new Map(state.missionReports);
      if (payload.report) {
        missionReports.set(payload.missionId, payload.report);
      }
      const existing = state.missions.get(payload.missionId);
      if (existing) {
        const missions = new Map(state.missions);
        missions.set(payload.missionId, {
          ...existing,
          status: payload.allPassed ? ("completed" as MissionStatus) : ("failed" as MissionStatus),
          updatedAt: new Date().toISOString(),
        });
        return { ...next, missions, missionReports };
      }
      return { ...next, missionsStale: true, missionReports };
    }

    case "mission:resumed": {
      const { missionId, name } = data as { missionId: string; name: string; retried: number; pending: number };
      const existing = state.missions.get(missionId);
      if (existing) {
        const missions = new Map(state.missions);
        missions.set(missionId, { ...existing, name, status: "active" as MissionStatus, updatedAt: new Date().toISOString() });
        return { ...next, missions, missionsStale: true };
      }
      return { ...next, missionsStale: true };
    }

    case "mission:deleted": {
      const { missionId } = data as { missionId: string };
      const missions = new Map(state.missions);
      missions.delete(missionId);
      return { ...next, missions };
    }

    // ── Approval gates ──────────────────────────────────────

    case "approval:requested":
    case "approval:resolved":
    case "approval:rejected":
    case "approval:timeout":
      return next;

    // ── Notifications ─────────────────────────────────────────

    case "notification:sent":
    case "notification:failed":
      return next;

    // ── Scheduling ────────────────────────────────────────────

    case "schedule:triggered":
    case "schedule:created":
    case "schedule:completed":
      return next;

    // ── Escalation ────────────────────────────────────────────

    case "escalation:triggered":
    case "escalation:resolved":
    case "escalation:human":
      return next;

    // ── SLA ───────────────────────────────────────────────────

    case "sla:warning":
    case "sla:violated":
    case "sla:met":
      return next;

    // ── Checkpoints ─────────────────────────────────────────

    case "checkpoint:reached":
    case "checkpoint:resumed":
      return next;

    // ── Delays ────────────────────────────────────────────────

    case "delay:started": {
      const { group, delayName, delay, startedAt, expiresAt } = data as {
        group: string; delayName: string; delay?: MissionDelay;
        duration: string; message?: string; afterTasks: string[]; blocksTasks: string[];
        startedAt: string; expiresAt: string;
      };
      const activeDelays = new Map(state.activeDelays);
      activeDelays.set(`${group}:${delayName}`, {
        group,
        delayName,
        delay: delay ?? { name: delayName, afterTasks: (data as any).afterTasks ?? [], blocksTasks: (data as any).blocksTasks ?? [], duration: (data as any).duration ?? "" },
        startedAt,
        expiresAt,
      });
      return { ...next, activeDelays };
    }

    case "delay:expired": {
      const { group, delayName } = data as { group: string; delayName: string };
      const activeDelays = new Map(state.activeDelays);
      activeDelays.delete(`${group}:${delayName}`);
      return { ...next, activeDelays };
    }

    // ── Quality gates ─────────────────────────────────────────

    case "quality:gate:passed":
    case "quality:gate:failed":
    case "quality:threshold:failed":
      return next;

    // ── Log ───────────────────────────────────────────────────

    case "log":
    default:
      return next;
  }
}
