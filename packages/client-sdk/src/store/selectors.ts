import type { Task, Mission, MissionReport, AgentProcess, SSEEvent, TaskStatus } from "../client/types.js";
import type { StoreState } from "./types.js";

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[];
  group?: string;
  assignTo?: string;
}

// ── Multi-key task selector cache ───────────────────────────
// Uses a Map keyed by serialized filter so that multiple components
// with different filters don't thrash a single-slot cache.

interface TaskCacheEntry {
  mapRef: Map<string, Task>;
  result: Task[];
}

const taskCacheByFilter = new Map<string, TaskCacheEntry>();
// Limit cache size to prevent unbounded growth
const MAX_TASK_CACHE_ENTRIES = 8;

export function selectTasks(state: StoreState, filter?: TaskFilter): Task[] {
  const filterKey = JSON.stringify(filter ?? {});
  const cached = taskCacheByFilter.get(filterKey);

  // Cache hit: same Map reference for this filter key
  if (cached && cached.mapRef === state.tasks) {
    return cached.result;
  }

  let tasks = Array.from(state.tasks.values());

  if (filter?.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    tasks = tasks.filter((t) => statuses.includes(t.status));
  }
  if (filter?.group) {
    tasks = tasks.filter((t) => t.group === filter.group);
  }
  if (filter?.assignTo) {
    tasks = tasks.filter((t) => t.assignTo === filter.assignTo);
  }

  // Default sort: most recently updated first
  tasks.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  // Evict oldest entries if cache is full
  if (taskCacheByFilter.size >= MAX_TASK_CACHE_ENTRIES) {
    const firstKey = taskCacheByFilter.keys().next().value!;
    taskCacheByFilter.delete(firstKey);
  }

  taskCacheByFilter.set(filterKey, { mapRef: state.tasks, result: tasks });
  return tasks;
}

// ── Single task selector ────────────────────────────────────

export function selectTask(state: StoreState, taskId: string): Task | undefined {
  return state.tasks.get(taskId);
}

// ── Mission selectors ───────────────────────────────────────

let lastMissionsMap: Map<string, Mission> | null = null;
let lastMissionResult: Mission[] = [];

export function selectMissions(state: StoreState): Mission[] {
  if (state.missions === lastMissionsMap) return lastMissionResult;
  lastMissionsMap = state.missions;
  lastMissionResult = Array.from(state.missions.values());
  return lastMissionResult;
}

export function selectMission(state: StoreState, missionId: string): Mission | undefined {
  return state.missions.get(missionId);
}

export function selectMissionReport(state: StoreState, missionId: string): MissionReport | undefined {
  return state.missionReports.get(missionId);
}

// ── Process selector ────────────────────────────────────────

export function selectProcesses(state: StoreState): AgentProcess[] {
  return state.processes;
}

// ── Events selector with multi-key cache ────────────────────

interface EventCacheEntry {
  eventsRef: SSEEvent[];
  result: SSEEvent[];
}

const eventCacheByFilter = new Map<string, EventCacheEntry>();
const MAX_EVENT_CACHE_ENTRIES = 8;

export function selectEvents(state: StoreState, filter?: string[]): SSEEvent[] {
  const filterKey = filter?.join(",") ?? "";
  const cached = eventCacheByFilter.get(filterKey);

  if (cached && cached.eventsRef === state.recentEvents) {
    return cached.result;
  }

  let events = state.recentEvents;
  if (filter?.length) {
    events = events.filter((e) => matchesEventFilter(e.event, filter));
  }

  if (eventCacheByFilter.size >= MAX_EVENT_CACHE_ENTRIES) {
    const firstKey = eventCacheByFilter.keys().next().value!;
    eventCacheByFilter.delete(firstKey);
  }

  eventCacheByFilter.set(filterKey, { eventsRef: state.recentEvents, result: events });
  return events;
}

function matchesEventFilter(eventName: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith("*")) {
      return eventName.startsWith(pattern.slice(0, -1));
    }
    return eventName === pattern;
  });
}

// ── Assessment progress selector ────────────────────────────

import type { AssessmentProgressEntry, AssessmentCheckStatus } from "./types.js";

const EMPTY_PROGRESS: AssessmentProgressEntry[] = [];
const EMPTY_CHECKS: AssessmentCheckStatus[] = [];

export function selectAssessmentProgress(state: StoreState, taskId: string): AssessmentProgressEntry[] {
  return state.assessmentProgress.get(taskId) ?? EMPTY_PROGRESS;
}

export function selectAssessmentChecks(state: StoreState, taskId: string): AssessmentCheckStatus[] {
  return state.assessmentChecks.get(taskId) ?? EMPTY_CHECKS;
}
