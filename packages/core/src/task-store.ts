import type { Task, TaskStatus, PolpoState, Mission } from "./types.js";

/**
 * Abstract interface for task persistence.
 * Implementations can be JSON file, SQLite, PostgreSQL, or in-memory (for tests).
 *
 * All methods return Promise to support async backends (PostgreSQL, cloud DBs).
 * Synchronous implementations (SQLite, file) can simply use `async` keyword.
 */
export interface TaskStore {
  // State access
  getState(): Promise<PolpoState>;
  setState(partial: Partial<PolpoState>): Promise<void>;

  // Task CRUD
  addTask(task: Omit<Task, "id" | "status" | "retries" | "createdAt" | "updatedAt"> & { status?: TaskStatus }): Promise<Task>;
  getTask(taskId: string): Promise<Task | undefined>;
  getAllTasks(): Promise<Task[]>;
  updateTask(taskId: string, updates: Partial<Omit<Task, "id" | "status">>): Promise<Task>;
  removeTask(taskId: string): Promise<boolean>;
  removeTasks(filter: (task: Task) => boolean): Promise<number>;

  // State machine
  transition(taskId: string, newStatus: TaskStatus): Promise<Task>;

  /** Bypass state machine — sets status directly with mandatory reason logging.
   *  Use ONLY for recovery, race-condition fallbacks, and fix/Q&A re-runs. */
  unsafeSetStatus(taskId: string, newStatus: TaskStatus, reason: string): Promise<Task>;

  // Lifecycle
  close?(): Promise<void> | void;

  // Mission persistence (optional)
  saveMission?(mission: Omit<Mission, "id" | "createdAt" | "updatedAt">): Promise<Mission>;
  getMission?(missionId: string): Promise<Mission | undefined>;
  getMissionByName?(name: string): Promise<Mission | undefined>;
  getAllMissions?(): Promise<Mission[]>;
  updateMission?(missionId: string, updates: Partial<Omit<Mission, "id">>): Promise<Mission>;
  deleteMission?(missionId: string): Promise<boolean>;
  nextMissionName?(): Promise<string>;
}
