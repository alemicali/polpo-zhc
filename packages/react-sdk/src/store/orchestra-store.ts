import type {
  Task,
  Plan,
  AgentConfig,
  AgentProcess,
  SSEEvent,
} from "../client/types.js";
import type { ConnectionStatus } from "../client/event-source.js";
import type { StoreState } from "./types.js";
import { reduceEvent } from "./event-reducer.js";

export type { StoreState, OrchestraStats } from "./types.js";

function createInitialState(): StoreState {
  return {
    tasks: new Map(),
    plans: new Map(),
    planReports: new Map(),
    agents: [],
    processes: [],
    stats: null,
    connectionStatus: "disconnected",
    recentEvents: [],
    plansStale: false,
    memory: null,
  };
}

const SERVER_SNAPSHOT = createInitialState();

export class OrchestraStore {
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
    this.state = {
      ...this.state,
      tasks: new Map(tasks.map((t) => [t.id, t])),
    };
    this.notify();
  }

  setPlans(plans: Plan[]): void {
    this.state = {
      ...this.state,
      plans: new Map(plans.map((p) => [p.id, p])),
      plansStale: false,
    };
    this.notify();
  }

  setAgents(agents: AgentConfig[]): void {
    this.state = { ...this.state, agents };
    this.notify();
  }

  setProcesses(processes: AgentProcess[]): void {
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
