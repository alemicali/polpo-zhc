import type {
  Task,
  Mission,
  AgentConfig,
  AgentProcess,
  SSEEvent,
} from "../client/types.js";
import type { ConnectionStatus } from "../client/event-source.js";
import type { StoreState } from "./types.js";
import { reduceEvent } from "./event-reducer.js";

export type { StoreState, PolpoStats } from "./types.js";

function createInitialState(): StoreState {
  return {
    tasks: new Map(),
    missions: new Map(),
    missionReports: new Map(),
    agents: [],
    processes: [],
    stats: null,
    connectionStatus: "disconnected",
    recentEvents: [],
    missionsStale: false,
    memory: null,
    agentMemory: new Map(),
    assessmentProgress: new Map(),
    assessmentChecks: new Map(),
    activeDelays: new Map(),
  };
}

const SERVER_SNAPSHOT = createInitialState();

export class PolpoStore {
  private state: StoreState;
  private listeners = new Set<() => void>();

  constructor() {
    this.state = createInitialState();
  }

  // ── useSyncExternalStore interface ──────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): StoreState => {
    return this.state;
  };

  getServerSnapshot = (): StoreState => {
    return SERVER_SNAPSHOT;
  };

  // ── Bulk setters (from REST initial fetch) ─────────────────

  setTasks(tasks: Task[]): void {
    // Avoid creating a new Map (and breaking selector cache) when the
    // task list hasn't actually changed.  Two concurrent useTasks() hooks
    // (e.g. agent-detail page + chat sidebar) each fire an initial fetch;
    // without this guard the second setTasks creates a new Map reference,
    // which causes a selectTasks cache miss → new array → useSyncExternalStore
    // re-render → useEffect re-fires → infinite loop.
    const prev = this.state.tasks;
    if (prev.size === tasks.length && tasks.every((t) => prev.get(t.id) === t)) {
      return;
    }
    this.state = {
      ...this.state,
      tasks: new Map(tasks.map((t) => [t.id, t])),
    };
    this.notify();
  }

  setMissions(missions: Mission[]): void {
    const prev = this.state.missions;
    if (prev.size === missions.length && missions.every((m) => prev.get(m.id) === m)) {
      if (!this.state.missionsStale) return;
    }
    this.state = {
      ...this.state,
      missions: new Map(missions.map((m) => [m.id, m])),
      missionsStale: false,
    };
    this.notify();
  }

  /** Upsert a single mission into the store without replacing the entire map. */
  upsertMission(mission: Mission): void {
    const prev = this.state.missions.get(mission.id);
    // Skip if the object is referentially identical (no change)
    if (prev === mission) return;
    const missions = new Map(this.state.missions);
    missions.set(mission.id, mission);
    this.state = { ...this.state, missions };
    this.notify();
  }

  setAgents(agents: AgentConfig[]): void {
    const prev = this.state.agents;
    if (prev.length === agents.length && agents.every((a, i) => prev[i] === a)) {
      return;
    }
    this.state = { ...this.state, agents };
    this.notify();
  }

  setProcesses(processes: AgentProcess[]): void {
    const prev = this.state.processes;
    if (
      prev.length === processes.length &&
      processes.every((p, i) => prev[i] === p)
    ) {
      return;
    }
    this.state = { ...this.state, processes };
    this.notify();
  }

  setConnectionStatus(status: ConnectionStatus): void {
    this.state = { ...this.state, connectionStatus: status };
    this.notify();
  }

  setMemory(memory: { exists: boolean; content: string } | null): void {
    this.state = { ...this.state, memory };
    this.notify();
  }

  setAgentMemory(agentName: string, memory: { exists: boolean; content: string }): void {
    const agentMemory = new Map(this.state.agentMemory);
    agentMemory.set(agentName, memory);
    this.state = { ...this.state, agentMemory };
    this.notify();
  }

  // ── SSE event application ──────────────────────────────────

  applyEvent(event: SSEEvent): void {
    const next = reduceEvent(this.state, event);
    if (next !== this.state) {
      this.state = next;
      this.notify();
    }
  }

  applyEventBatch(events: SSEEvent[]): void {
    let current = this.state;
    for (const event of events) {
      current = reduceEvent(current, event);
    }
    if (current !== this.state) {
      this.state = current;
      this.notify();
    }
  }

  // ── Notification ───────────────────────────────────────────

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
