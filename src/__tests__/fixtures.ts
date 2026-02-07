import { nanoid } from "nanoid";
import type { Task, TaskStatus, OrchestraState, AgentConfig, AgentActivity, TaskResult, AgentHandle, AgentAdapter, TaskStore } from "../core/index.js";
import { assertValidTransition } from "../core/state-machine.js";

// === InMemoryTaskStore ===

export class InMemoryTaskStore implements TaskStore {
  private state: OrchestraState = {
    project: "",
    team: { name: "", agents: [] },
    tasks: [],
    processes: [],
  };

  getState(): OrchestraState { return this.state; }

  setState(partial: Partial<OrchestraState>): void {
    Object.assign(this.state, partial);
  }

  addTask(task: Omit<Task, "id" | "status" | "retries" | "createdAt" | "updatedAt">): Task {
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

  getTask(taskId: string): Task | undefined {
    return this.state.tasks.find(t => t.id === taskId);
  }

  getAllTasks(): Task[] {
    return this.state.tasks;
  }

  updateTask(taskId: string, updates: Partial<Omit<Task, "id">>): Task {
    const task = this.state.tasks.find(t => t.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    Object.assign(task, updates, { updatedAt: new Date().toISOString() });
    return task;
  }

  removeTask(taskId: string): boolean {
    const idx = this.state.tasks.findIndex(t => t.id === taskId);
    if (idx < 0) return false;
    this.state.tasks.splice(idx, 1);
    return true;
  }

  removeTasks(filter: (task: Task) => boolean): number {
    const before = this.state.tasks.length;
    this.state.tasks = this.state.tasks.filter(t => !filter(t));
    return before - this.state.tasks.length;
  }

  transition(taskId: string, newStatus: TaskStatus): Task {
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

// === MockAdapter & MockHandle ===

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

export class MockAdapter implements AgentAdapter {
  readonly name = "mock";
  public spawnCalls: Array<{ agent: AgentConfig; taskId: string }> = [];
  public resultFn: (task: Task) => TaskResult = () => ({
    exitCode: 0, stdout: "ok", stderr: "", duration: 50,
  });

  spawn(agent: AgentConfig, task: Task, _cwd: string): AgentHandle {
    this.spawnCalls.push({ agent, taskId: task.id });
    const result = this.resultFn(task);
    return {
      agentName: agent.name,
      taskId: task.id,
      startedAt: new Date().toISOString(),
      pid: 0,
      activity: createTestActivity(),
      done: Promise.resolve(result),
      isAlive: () => false, // finishes immediately
      kill: () => {},
    };
  }
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
    adapter: "mock",
    ...overrides,
  };
}

export function createTestActivity(overrides: Partial<AgentActivity> = {}): AgentActivity {
  return {
    filesCreated: [],
    filesEdited: [],
    toolCalls: 0,
    lastUpdate: new Date().toISOString(),
    ...overrides,
  };
}
