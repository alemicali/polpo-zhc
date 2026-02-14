import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { nanoid } from "nanoid";
import type {
  Task,
  TaskStatus,
  OrchestraState,
  AgentProcess,
  Team,
  Plan,
} from "../core/types.js";
import type { TaskStore } from "../core/task-store.js";
import { assertValidTransition } from "../core/state-machine.js";

interface MetaState {
  project: string;
  team: Team;
  processes: AgentProcess[];
  startedAt?: string;
  completedAt?: string;
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Atomic write: write to tmp file then rename. */
function atomicWrite(filePath: string, data: unknown): void {
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, filePath);
}

/** Read and parse a JSON file, returning fallback if missing or malformed. */
function readJson<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  try {
    return safeJsonParse(readFileSync(filePath, "utf-8"), fallback);
  } catch {
    return fallback;
  }
}

/**
 * Filesystem-based TaskStore.
 * Stores tasks, plans, and metadata as individual JSON files under .polpo/.
 *
 * Layout:
 *   .polpo/tasks/<taskId>.json
 *   .polpo/plans/<planId>.json
 *   .polpo/_meta.json
 */
export class FileTaskStore implements TaskStore {
  private tasksDir: string;
  private plansDir: string;
  private metaPath: string;

  constructor(polpoDir: string) {
    this.tasksDir = join(polpoDir, "tasks");
    this.plansDir = join(polpoDir, "plans");
    this.metaPath = join(polpoDir, "_meta.json");

    if (!existsSync(polpoDir)) mkdirSync(polpoDir, { recursive: true });
    if (!existsSync(this.tasksDir)) mkdirSync(this.tasksDir, { recursive: true });
    if (!existsSync(this.plansDir)) mkdirSync(this.plansDir, { recursive: true });
  }

  // ── Helpers ──

  private taskPath(id: string): string {
    return join(this.tasksDir, `${id}.json`);
  }

  private planPath(id: string): string {
    return join(this.plansDir, `${id}.json`);
  }

  private readMeta(): MetaState {
    return readJson<MetaState>(this.metaPath, {
      project: "",
      team: { name: "", agents: [] },
      processes: [],
    });
  }

  private writeMeta(meta: MetaState): void {
    atomicWrite(this.metaPath, meta);
  }

  private readTask(id: string): Task | undefined {
    return readJson<Task | undefined>(this.taskPath(id), undefined);
  }

  private writeTask(task: Task): void {
    atomicWrite(this.taskPath(task.id), task);
  }

  private listTaskIds(): string[] {
    if (!existsSync(this.tasksDir)) return [];
    return readdirSync(this.tasksDir)
      .filter(f => f.endsWith(".json") && !f.endsWith(".tmp"))
      .map(f => f.slice(0, -5));
  }

  private readPlan(id: string): Plan | undefined {
    return readJson<Plan | undefined>(this.planPath(id), undefined);
  }

  private writePlan(plan: Plan): void {
    atomicWrite(this.planPath(plan.id), plan);
  }

  private listPlanIds(): string[] {
    if (!existsSync(this.plansDir)) return [];
    return readdirSync(this.plansDir)
      .filter(f => f.endsWith(".json") && !f.endsWith(".tmp"))
      .map(f => f.slice(0, -5));
  }

  // ── TaskStore interface ──

  getState(): OrchestraState {
    const meta = this.readMeta();
    const tasks = this.getAllTasks();
    return {
      project: meta.project,
      team: meta.team,
      tasks,
      processes: meta.processes,
      startedAt: meta.startedAt,
      completedAt: meta.completedAt,
    };
  }

  setState(partial: Partial<OrchestraState>): void {
    const meta = this.readMeta();

    if (partial.project !== undefined) meta.project = partial.project;
    if (partial.team !== undefined) meta.team = partial.team;
    if (partial.startedAt !== undefined) meta.startedAt = partial.startedAt;
    if (partial.completedAt !== undefined) meta.completedAt = partial.completedAt;
    if (partial.processes !== undefined) meta.processes = partial.processes;

    if (partial.tasks !== undefined) {
      // Wipe existing tasks and write new ones
      for (const id of this.listTaskIds()) {
        try { unlinkSync(this.taskPath(id)); } catch { /* already gone */ }
      }
      for (const task of partial.tasks) {
        this.writeTask(task);
      }
    }

    this.writeMeta(meta);
  }

  addTask(
    task: Omit<Task, "id" | "status" | "retries" | "createdAt" | "updatedAt">,
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
    this.writeTask(newTask);
    return newTask;
  }

  getTask(taskId: string): Task | undefined {
    return this.readTask(taskId);
  }

  getAllTasks(): Task[] {
    const ids = this.listTaskIds();
    const tasks: Task[] = [];
    for (const id of ids) {
      const task = this.readTask(id);
      if (task) tasks.push(task);
    }
    tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return tasks;
  }

  updateTask(taskId: string, updates: Partial<Omit<Task, "id">>): Task {
    const existing = this.readTask(taskId);
    if (!existing) throw new Error(`Task not found: ${taskId}`);

    const updated: Task = {
      ...existing,
      ...updates,
      id: taskId,
      updatedAt: new Date().toISOString(),
    };
    this.writeTask(updated);
    return updated;
  }

  removeTask(taskId: string): boolean {
    const path = this.taskPath(taskId);
    if (!existsSync(path)) return false;
    try {
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }

  removeTasks(filter: (task: Task) => boolean): number {
    const all = this.getAllTasks();
    const toRemove = all.filter(filter);
    for (const task of toRemove) {
      this.removeTask(task.id);
    }
    return toRemove.length;
  }

  transition(taskId: string, newStatus: TaskStatus): Task {
    const existing = this.readTask(taskId);
    if (!existing) throw new Error(`Task not found: ${taskId}`);

    assertValidTransition(existing.status, newStatus);

    let retries = existing.retries;
    if (newStatus === "pending" && existing.status === "failed") {
      retries += 1;
    }

    const updated: Task = {
      ...existing,
      status: newStatus,
      retries,
      updatedAt: new Date().toISOString(),
    };
    this.writeTask(updated);
    return updated;
  }

  // ── Plan persistence ──

  savePlan(plan: Omit<Plan, "id" | "createdAt" | "updatedAt">): Plan {
    const now = new Date().toISOString();
    const newPlan: Plan = {
      ...plan,
      id: nanoid(),
      createdAt: now,
      updatedAt: now,
    };
    this.writePlan(newPlan);
    return newPlan;
  }

  getPlan(planId: string): Plan | undefined {
    return this.readPlan(planId);
  }

  getPlanByName(name: string): Plan | undefined {
    for (const id of this.listPlanIds()) {
      const plan = this.readPlan(id);
      if (plan && plan.name === name) return plan;
    }
    return undefined;
  }

  getAllPlans(): Plan[] {
    const plans: Plan[] = [];
    for (const id of this.listPlanIds()) {
      const plan = this.readPlan(id);
      if (plan) plans.push(plan);
    }
    plans.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return plans;
  }

  updatePlan(planId: string, updates: Partial<Omit<Plan, "id">>): Plan {
    const existing = this.readPlan(planId);
    if (!existing) throw new Error(`Plan not found: ${planId}`);

    const updated: Plan = {
      ...existing,
      ...updates,
      id: planId,
      updatedAt: new Date().toISOString(),
    };
    this.writePlan(updated);
    return updated;
  }

  deletePlan(planId: string): boolean {
    const path = this.planPath(planId);
    if (!existsSync(path)) return false;
    try {
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }

  nextPlanName(): string {
    const count = this.listPlanIds().length;
    return `plan-${count + 1}`;
  }

  close(): void {
    // No-op for filesystem store
  }
}
