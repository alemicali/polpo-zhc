import { nanoid } from "nanoid";
import type { Task, TaskStatus, TaskOutcome, PolpoState, AgentConfig, AgentActivity, TaskResult, AgentHandle, TaskStore, RunStore, RunRecord, RunStatus } from "../core/index.js";
import { assertValidTransition } from "../core/state-machine.js";

// === InMemoryTaskStore ===

export class InMemoryTaskStore implements TaskStore {
  private state: PolpoState = {
    org: "",
    teams: [{ name: "", agents: [] }],
    tasks: [],
    processes: [],
  };

  async getState(): Promise<PolpoState> { return this.state; }

  async setState(partial: Partial<PolpoState>): Promise<void> {
    Object.assign(this.state, partial);
  }

  async addTask(task: Omit<Task, "id" | "status" | "retries" | "createdAt" | "updatedAt">): Promise<Task> {
    const now = new Date().toISOString();
    const newTask: Task = {
      ...task,
      id: nanoid(),
      status: "pending",
      retries: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.state.tasks.push(newTask);
    return newTask;
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    return this.state.tasks.find(t => t.id === taskId);
  }

  async getAllTasks(): Promise<Task[]> {
    return this.state.tasks;
  }

  async unsafeSetStatus(taskId: string, newStatus: TaskStatus, reason: string): Promise<Task> {
    const task = this.state.tasks.find(t => t.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const from = task.status;
    task.status = newStatus;
    task.updatedAt = new Date().toISOString();
    console.warn(`[unsafeSetStatus] ${taskId}: ${from} → ${newStatus} — ${reason}`);
    return task;
  }

  async updateTask(taskId: string, updates: Partial<Omit<Task, "id" | "status">>): Promise<Task> {
    const task = this.state.tasks.find(t => t.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    Object.assign(task, updates, { updatedAt: new Date().toISOString() });
    return task;
  }

  async removeTask(taskId: string): Promise<boolean> {
    const idx = this.state.tasks.findIndex(t => t.id === taskId);
    if (idx < 0) return false;
    this.state.tasks.splice(idx, 1);
    return true;
  }

  async removeTasks(filter: (task: Task) => boolean): Promise<number> {
    const before = this.state.tasks.length;
    this.state.tasks = this.state.tasks.filter(t => !filter(t));
    return before - this.state.tasks.length;
  }

  async transition(taskId: string, newStatus: TaskStatus): Promise<Task> {
    const task = this.state.tasks.find(t => t.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    assertValidTransition(task.status, newStatus);
    if (newStatus === "pending" && task.status === "failed") {
      task.retries += 1;
    }
    task.status = newStatus;
    task.updatedAt = new Date().toISOString();
    return task;
  }
}

// === MockHandle ===

export function createMockHandle(opts: {
  taskId: string;
  agentName?: string;
  result?: TaskResult;
  alive?: boolean;
}): AgentHandle {
  const result = opts.result ?? { exitCode: 0, stdout: "done", stderr: "", duration: 100 };
  let alive = opts.alive ?? false; // default: already finished
  return {
    agentName: opts.agentName ?? "mock-agent",
    taskId: opts.taskId,
    startedAt: new Date().toISOString(),
    pid: 0,
    activity: createTestActivity(),
    done: Promise.resolve(result),
    isAlive: () => alive,
    kill: () => { alive = false; },
  };
}

// === Factory Functions ===

export function createTestTask(overrides: Partial<Task> = {}): Task {
  return {
    id: nanoid(),
    title: "Test task",
    description: "A test task",
    assignTo: "test-agent",
    dependsOn: [],
    status: "pending",
    expectations: [],
    metrics: [],
    retries: 0,
    maxRetries: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function createTestAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    ...overrides,
  };
}

export function createTestActivity(overrides: Partial<AgentActivity> = {}): AgentActivity {
  return {
    filesCreated: [],
    filesEdited: [],
    toolCalls: 0,
    totalTokens: 0,
    lastUpdate: new Date().toISOString(),
    ...overrides,
  };
}

// === InMemoryRunStore ===

export class InMemoryRunStore implements RunStore {
  private runs = new Map<string, RunRecord>();

  async upsertRun(run: RunRecord): Promise<void> {
    this.runs.set(run.id, { ...run });
  }

  async updateActivity(runId: string, activity: AgentActivity): Promise<void> {
    const run = this.runs.get(runId);
    if (run) {
      run.activity = activity;
      run.updatedAt = new Date().toISOString();
    }
  }

  async updateOutcomes(runId: string, outcomes: TaskOutcome[]): Promise<void> {
    const run = this.runs.get(runId);
    if (run) {
      run.outcomes = outcomes;
      run.updatedAt = new Date().toISOString();
    }
  }

  async completeRun(runId: string, status: RunStatus, result: TaskResult): Promise<void> {
    const run = this.runs.get(runId);
    if (run) {
      run.status = status;
      run.result = result;
      run.updatedAt = new Date().toISOString();
    }
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    const run = this.runs.get(runId);
    return run ? { ...run } : undefined;
  }

  async getRunByTaskId(taskId: string): Promise<RunRecord | undefined> {
    for (const run of this.runs.values()) {
      if (run.taskId === taskId) return { ...run };
    }
    return undefined;
  }

  async getActiveRuns(): Promise<RunRecord[]> {
    return [...this.runs.values()].filter(r => r.status === "running");
  }

  async getTerminalRuns(): Promise<RunRecord[]> {
    return [...this.runs.values()].filter(r =>
      r.status === "completed" || r.status === "failed" || r.status === "killed"
    );
  }

  async deleteRun(runId: string): Promise<void> {
    this.runs.delete(runId);
  }

  close(): void {
    this.runs.clear();
  }
}
