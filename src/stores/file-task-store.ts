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
  PolpoState,
  AgentProcess,
  Team,
  Mission,
} from "../core/types.js";
import type { TaskStore } from "../core/task-store.js";
import { assertValidTransition } from "../core/state-machine.js";

interface MetaState {
  project: string;
  teams: Team[];
  processes: AgentProcess[];
  startedAt?: string;
  completedAt?: string;
}

/** Legacy meta state with singular team — auto-migrated on read. */
interface MetaStateRaw {
  project: string;
  team?: Team;
  teams?: Team[];
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
 * Stores tasks, missions, and metadata as individual JSON files under .polpo/.
 *
 * Layout:
 *   .polpo/tasks/<taskId>.json
 *   .polpo/missions/<missionId>.json
 *   .polpo/_meta.json
 */
export class FileTaskStore implements TaskStore {
  private tasksDir: string;
  private missionsDir: string;
  private metaPath: string;

  constructor(polpoDir: string) {
    this.tasksDir = join(polpoDir, "tasks");
    this.missionsDir = join(polpoDir, "missions");
    this.metaPath = join(polpoDir, "_meta.json");

    if (!existsSync(polpoDir)) mkdirSync(polpoDir, { recursive: true });
    if (!existsSync(this.tasksDir)) mkdirSync(this.tasksDir, { recursive: true });
    if (!existsSync(this.missionsDir)) mkdirSync(this.missionsDir, { recursive: true });
  }

  // ── Helpers ──

  private taskPath(id: string): string {
    return join(this.tasksDir, `${id}.json`);
  }

  private missionPath(id: string): string {
    return join(this.missionsDir, `${id}.json`);
  }

  private readMeta(): MetaState {
    const raw = readJson<MetaStateRaw>(this.metaPath, {
      project: "",
      teams: [{ name: "", agents: [] }],
      processes: [],
    });
    // Migrate legacy singular team → teams array
    const teams = raw.teams && raw.teams.length > 0
      ? raw.teams
      : raw.team
        ? [raw.team]
        : [{ name: "", agents: [] }];
    return { project: raw.project, teams, processes: raw.processes, startedAt: raw.startedAt, completedAt: raw.completedAt };
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

  private readMission(id: string): Mission | undefined {
    return readJson<Mission | undefined>(this.missionPath(id), undefined);
  }

  private writeMission(mission: Mission): void {
    atomicWrite(this.missionPath(mission.id), mission);
  }

  private listMissionIds(): string[] {
    if (!existsSync(this.missionsDir)) return [];
    return readdirSync(this.missionsDir)
      .filter(f => f.endsWith(".json") && !f.endsWith(".tmp"))
      .map(f => f.slice(0, -5));
  }

  // ── TaskStore interface ──

  async getState(): Promise<PolpoState> {
    const meta = this.readMeta();
    const tasks = await this.getAllTasks();
    return {
      project: meta.project,
      teams: meta.teams,
      tasks,
      processes: meta.processes,
      startedAt: meta.startedAt,
      completedAt: meta.completedAt,
    };
  }

  async setState(partial: Partial<PolpoState>): Promise<void> {
    const meta = this.readMeta();

    if (partial.project !== undefined) meta.project = partial.project;
    if (partial.teams !== undefined) meta.teams = partial.teams;
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

  async addTask(
    task: Omit<Task, "id" | "status" | "retries" | "createdAt" | "updatedAt"> & { status?: TaskStatus },
  ): Promise<Task> {
    const now = new Date().toISOString();
    const newTask: Task = {
      ...task,
      id: nanoid(),
      status: task.status ?? "pending",
      retries: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.writeTask(newTask);
    return newTask;
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    return this.readTask(taskId);
  }

  async getAllTasks(): Promise<Task[]> {
    const ids = this.listTaskIds();
    const tasks: Task[] = [];
    for (const id of ids) {
      const task = this.readTask(id);
      if (task) tasks.push(task);
    }
    tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return tasks;
  }

  async unsafeSetStatus(taskId: string, newStatus: TaskStatus, reason: string): Promise<Task> {
    const existing = this.readTask(taskId);
    if (!existing) throw new Error(`Task not found: ${taskId}`);
    const from = existing.status;
    const updated: Task = { ...existing, status: newStatus, updatedAt: new Date().toISOString() };
    this.writeTask(updated);
    console.warn(`[unsafeSetStatus] ${taskId}: ${from} → ${newStatus} — ${reason}`);
    return updated;
  }

  async updateTask(taskId: string, updates: Partial<Omit<Task, "id" | "status">>): Promise<Task> {
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

  async removeTask(taskId: string): Promise<boolean> {
    const path = this.taskPath(taskId);
    if (!existsSync(path)) return false;
    try {
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }

  async removeTasks(filter: (task: Task) => boolean): Promise<number> {
    const all = await this.getAllTasks();
    const toRemove = all.filter(filter);
    for (const task of toRemove) {
      this.removeTask(task.id);
    }
    return toRemove.length;
  }

  async transition(taskId: string, newStatus: TaskStatus): Promise<Task> {
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

  // ── Mission persistence ──

  async saveMission(mission: Omit<Mission, "id" | "createdAt" | "updatedAt">): Promise<Mission> {
    const now = new Date().toISOString();
    const newMission: Mission = {
      ...mission,
      id: nanoid(),
      createdAt: now,
      updatedAt: now,
    };
    this.writeMission(newMission);
    return newMission;
  }

  async getMission(missionId: string): Promise<Mission | undefined> {
    return this.readMission(missionId);
  }

  async getMissionByName(name: string): Promise<Mission | undefined> {
    for (const id of this.listMissionIds()) {
      const mission = this.readMission(id);
      if (mission && mission.name === name) return mission;
    }
    return undefined;
  }

  async getAllMissions(): Promise<Mission[]> {
    const missions: Mission[] = [];
    for (const id of this.listMissionIds()) {
      const mission = this.readMission(id);
      if (mission) missions.push(mission);
    }
    missions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return missions;
  }

  async updateMission(missionId: string, updates: Partial<Omit<Mission, "id">>): Promise<Mission> {
    const existing = this.readMission(missionId);
    if (!existing) throw new Error(`Mission not found: ${missionId}`);

    const updated: Mission = {
      ...existing,
      ...updates,
      id: missionId,
      updatedAt: new Date().toISOString(),
    };
    this.writeMission(updated);
    return updated;
  }

  async deleteMission(missionId: string): Promise<boolean> {
    const path = this.missionPath(missionId);
    if (!existsSync(path)) return false;
    try {
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }

  async nextMissionName(): Promise<string> {
    const count = this.listMissionIds().length;
    return `mission-${count + 1}`;
  }

  async close(): Promise<void> {
    // No-op for filesystem store
  }
}
