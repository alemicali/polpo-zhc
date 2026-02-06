import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { Task, TaskStatus, OrchestraState } from "./types.js";

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["assigned"],
  assigned: ["in_progress"],
  in_progress: ["review", "failed"],
  review: ["done", "failed"],
  done: [],
  failed: ["pending"],
};

export class TaskRegistry {
  private statePath: string;
  private state: OrchestraState;

  constructor(orchestraDir: string) {
    this.statePath = join(orchestraDir, "state.json");
    this.state = this.load();
  }

  private load(): OrchestraState {
    if (existsSync(this.statePath)) {
      const raw = readFileSync(this.statePath, "utf-8");
      return JSON.parse(raw) as OrchestraState;
    }
    return {
      project: "",
      team: { name: "", agents: [] },
      tasks: [],
      processes: [],
    };
  }

  private persist(): void {
    const dir = join(this.statePath, "..");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    // Atomic write: write to temp file, then rename
    const tmp = this.statePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf-8");
    renameSync(tmp, this.statePath);
  }

  getState(): OrchestraState {
    return this.state;
  }

  setState(partial: Partial<OrchestraState>): void {
    Object.assign(this.state, partial);
    this.persist();
  }

  addTask(
    task: Omit<Task, "id" | "status" | "retries" | "createdAt" | "updatedAt">
  ): Task {
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
    this.persist();
    return newTask;
  }

  getTask(taskId: string): Task | undefined {
    return this.state.tasks.find((t) => t.id === taskId);
  }

  getAllTasks(): Task[] {
    return this.state.tasks;
  }

  updateTask(taskId: string, updates: Partial<Omit<Task, "id">>): Task {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    Object.assign(task, updates, { updatedAt: new Date().toISOString() });
    this.persist();
    return task;
  }

  transition(taskId: string, newStatus: TaskStatus): Task {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const allowed = VALID_TRANSITIONS[task.status];
    if (!allowed.includes(newStatus)) {
      throw new Error(
        `Invalid transition: ${task.status} → ${newStatus} (allowed: ${allowed.join(", ") || "none"})`
      );
    }

    if (newStatus === "pending" && task.status === "failed") {
      task.retries += 1;
    }

    task.status = newStatus;
    task.updatedAt = new Date().toISOString();
    this.persist();
    return task;
  }
}
