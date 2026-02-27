import type { Task, TaskStatus, PolpoState, Mission } from "./types.js";

/**
 * Abstract interface for task persistence.
 * Implementations can be JSON file, SQLite, PostgreSQL, or in-memory (for tests).
 */
export interface TaskStore {
  // State access
  getState(): PolpoState;
  setState(partial: Partial<PolpoState>): void;

  // Task CRUD
  addTask(task: Omit<Task, "id" | "status" | "retries" | "createdAt" | "updatedAt"> & { status?: TaskStatus }): Task;
  getTask(taskId: string): Task | undefined;
  getAllTasks(): Task[];
  updateTask(taskId: string, updates: Partial<Omit<Task, "id" | "status">>): Task;
  removeTask(taskId: string): boolean;
  removeTasks(filter: (task: Task) => boolean): number;

  // State machine
  transition(taskId: string, newStatus: TaskStatus): Task;

  /** Bypass state machine — sets status directly with mandatory reason logging.
   *  Use ONLY for recovery, race-condition fallbacks, and fix/Q&A re-runs. */
  unsafeSetStatus(taskId: string, newStatus: TaskStatus, reason: string): Task;

  // Lifecycle
  close?(): void;

  // Mission persistence (optional)
  saveMission?(mission: Omit<Mission, "id" | "createdAt" | "updatedAt">): Mission;
  getMission?(missionId: string): Mission | undefined;
  getMissionByName?(name: string): Mission | undefined;
  getAllMissions?(): Mission[];
  updateMission?(missionId: string, updates: Partial<Omit<Mission, "id">>): Mission;
  deleteMission?(missionId: string): boolean;
  nextMissionName?(): string;
}
