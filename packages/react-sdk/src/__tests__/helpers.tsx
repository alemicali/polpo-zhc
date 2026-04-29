import React from "react";
import { PolpoContext } from "../provider/polpo-context.js";
import type { PolpoContextValue } from "../provider/polpo-context.js";
import type { PolpoClient } from "@polpo-ai/sdk";
import type { PolpoStore } from "@polpo-ai/sdk";
import type { StoreState } from "@polpo-ai/sdk";
import type { Task, Mission, AgentConfig, AgentProcess, Team, ApprovalRequest } from "@polpo-ai/sdk";

// ---------------------------------------------------------------------------
// Fake data factories
// ---------------------------------------------------------------------------

export function fakeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Test task",
    description: "A test task",
    assignTo: "agent-1",
    dependsOn: [],
    status: "pending",
    expectations: [],
    metrics: [],
    retries: 0,
    maxRetries: 3,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

export function fakeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "mission-1",
    name: "Test mission",
    data: "mission data",
    status: "draft",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

export function fakeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "agent-1",
    model: "gpt-4",
    systemPrompt: "You are a test agent",
    ...overrides,
  } as AgentConfig;
}

export function fakeTeam(overrides: Partial<Team> = {}): Team {
  return {
    name: "team-1",
    agents: ["agent-1"],
    ...overrides,
  } as Team;
}

export function fakeApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "approval-1",
    gateId: "gate-1",
    gateName: "Test Gate",
    status: "pending",
    payload: {},
    requestedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock PolpoStore — implements the useSyncExternalStore interface
// ---------------------------------------------------------------------------

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

export function createMockStore(initialState?: Partial<StoreState>): PolpoStore {
  let state: StoreState = { ...createInitialState(), ...initialState };
  const listeners = new Set<() => void>();

  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    getServerSnapshot: () => createInitialState(),
    setTasks: (tasks: Task[]) => {
      state = { ...state, tasks: new Map(tasks.map((t) => [t.id, t])) };
      listeners.forEach((l) => l());
    },
    setMissions: (missions: Mission[]) => {
      state = { ...state, missions: new Map(missions.map((m) => [m.id, m])), missionsStale: false };
      listeners.forEach((l) => l());
    },
    upsertMission: (mission: Mission) => {
      const missions = new Map(state.missions);
      missions.set(mission.id, mission);
      state = { ...state, missions };
      listeners.forEach((l) => l());
    },
    setAgents: (agents: AgentConfig[]) => {
      state = { ...state, agents };
      listeners.forEach((l) => l());
    },
    setProcesses: (processes: AgentProcess[]) => {
      state = { ...state, processes };
      listeners.forEach((l) => l());
    },
    setConnectionStatus: (status: StoreState["connectionStatus"]) => {
      state = { ...state, connectionStatus: status };
      listeners.forEach((l) => l());
    },
    setMemory: (memory: StoreState["memory"]) => {
      state = { ...state, memory };
      listeners.forEach((l) => l());
    },
    setAgentMemory: (agentName: string, memory: { exists: boolean; content: string }) => {
      const agentMemory = new Map(state.agentMemory);
      agentMemory.set(agentName, memory);
      state = { ...state, agentMemory };
      listeners.forEach((l) => l());
    },
    setActiveDelays: (delays: StoreState["activeDelays"]) => {
      state = { ...state, activeDelays: delays };
      listeners.forEach((l) => l());
    },
    applyEvent: () => {},
    applyEventBatch: () => {},
  } as unknown as PolpoStore;

  return store;
}

// ---------------------------------------------------------------------------
// Mock PolpoClient — all methods are vi.fn() returning resolved promises
// ---------------------------------------------------------------------------

import { vi } from "vitest";

export function createMockClient(overrides: Record<string, unknown> = {}): PolpoClient {
  const client = {
    // Tasks
    getTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn().mockResolvedValue(fakeTask()),
    createTask: vi.fn().mockResolvedValue(fakeTask()),
    updateTask: vi.fn().mockResolvedValue(fakeTask()),
    deleteTask: vi.fn().mockResolvedValue({ removed: true }),
    retryTask: vi.fn().mockResolvedValue({ retried: true }),
    killTask: vi.fn().mockResolvedValue({ killed: true }),
    reassessTask: vi.fn().mockResolvedValue({ reassessed: true }),
    queueTask: vi.fn().mockResolvedValue({ queued: true }),

    // Missions
    getMissions: vi.fn().mockResolvedValue([]),
    getResumableMissions: vi.fn().mockResolvedValue([]),
    getMission: vi.fn().mockResolvedValue(fakeMission()),
    createMission: vi.fn().mockResolvedValue(fakeMission()),
    updateMission: vi.fn().mockResolvedValue(fakeMission()),
    deleteMission: vi.fn().mockResolvedValue({ deleted: true }),
    executeMission: vi.fn().mockResolvedValue({ missionId: "mission-1", taskCount: 1 }),
    resumeMission: vi.fn().mockResolvedValue({ missionId: "mission-1", resumed: true }),
    abortMission: vi.fn().mockResolvedValue({ aborted: 1 }),

    // Agents
    getAgents: vi.fn().mockResolvedValue([]),
    getAgent: vi.fn().mockResolvedValue(fakeAgent()),
    addAgent: vi.fn().mockResolvedValue({ added: true }),
    removeAgent: vi.fn().mockResolvedValue({ removed: true }),
    updateAgent: vi.fn().mockResolvedValue(fakeAgent()),
    getTeams: vi.fn().mockResolvedValue([]),
    getTeam: vi.fn().mockResolvedValue(undefined),
    addTeam: vi.fn().mockResolvedValue({ added: true }),
    removeTeam: vi.fn().mockResolvedValue({ removed: true }),
    renameTeam: vi.fn().mockResolvedValue(fakeTeam()),
    getProcesses: vi.fn().mockResolvedValue([]),

    // State
    getState: vi.fn().mockResolvedValue({}),
    getConfig: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn().mockResolvedValue({}),

    // Approvals
    getApprovals: vi.fn().mockResolvedValue([]),
    getPendingApprovals: vi.fn().mockResolvedValue([]),
    approveRequest: vi.fn().mockResolvedValue(fakeApproval({ status: "approved" })),
    rejectRequest: vi.fn().mockResolvedValue(fakeApproval({ status: "rejected" })),

    // Events URL
    getEventsUrl: vi.fn().mockReturnValue("http://localhost:3000/api/v1/events"),

    ...overrides,
  } as unknown as PolpoClient;

  return client;
}

// ---------------------------------------------------------------------------
// Wrapper for renderHook — provides PolpoContext without PolpoProvider
// (PolpoProvider requires EventSource which jsdom doesn't have)
// ---------------------------------------------------------------------------

export function createWrapper(client: PolpoClient, store: PolpoStore) {
  const value: PolpoContextValue = { client, store };
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <PolpoContext.Provider value={value}>
        {children}
      </PolpoContext.Provider>
    );
  };
}
