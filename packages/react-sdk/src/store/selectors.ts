import type { Task, Plan, AgentProcess, SSEEvent, TaskStatus } from "../client/types.js";
import type { StoreState } from "./types.js";

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[];
  group?: string;
  assignTo?: string;
}

// ── Memoized task selector ──────────────────────────────────

let lastTasksMap: Map<string, Task> | null = null;
let lastTaskFilter = "";
let lastTaskResult: Task[] = [];

export function selectTasks(state: StoreState, filter?: TaskFilter): Task[] {
  const filterKey = JSON.stringify(filter ?? {});
  if (state.tasks === lastTasksMap && filterKey === lastTaskFilter) {
    return lastTaskResult;
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

  lastTasksMap = state.tasks;
  lastTaskFilter = filterKey;
  lastTaskResult = tasks;
  return tasks;
}

// ── Single task selector ────────────────────────────────────

export function selectTask(state: StoreState, taskId: string): Task | undefined {
  return state.tasks.get(taskId);
}

// ── Plan selectors ──────────────────────────────────────────

let lastPlansMap: Map<string, Plan> | null = null;
let lastPlanResult: Plan[] = [];

export function selectPlans(state: StoreState): Plan[] {
  if (state.plans === lastPlansMap) return lastPlanResult;
  lastPlansMap = state.plans;
  lastPlanResult = Array.from(state.plans.values());
  return lastPlanResult;
}

export function selectPlan(state: StoreState, planId: string): Plan | undefined {
  return state.plans.get(planId);
}

// ── Process selector ────────────────────────────────────────

export function selectProcesses(state: StoreState): AgentProcess[] {
  return state.processes;
}

// ── Events selector with filter ─────────────────────────────

let lastEventsRef: SSEEvent[] | null = null;
let lastEventFilter = "";
let lastEventResult: SSEEvent[] = [];

export function selectEvents(state: StoreState, filter?: string[]): SSEEvent[] {
  const filterKey = filter?.join(",") ?? "";
  if (state.recentEvents === lastEventsRef && filterKey === lastEventFilter) {
    return lastEventResult;
  }

  let events = state.recentEvents;
  if (filter?.length) {
    events = events.filter((e) => matchesEventFilter(e.event, filter));
  }

  lastEventsRef = state.recentEvents;
  lastEventFilter = filterKey;
  lastEventResult = events;
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
