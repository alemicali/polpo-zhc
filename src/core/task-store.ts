import type { Task, TaskStatus, PolpoState, Plan } from "./types.js";

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

  // Plan persistence (optional)
  savePlan?(plan: Omit<Plan, "id" | "createdAt" | "updatedAt">): Plan;
  getPlan?(planId: string): Plan | undefined;
  getPlanByName?(name: string): Plan | undefined;
  getAllPlans?(): Plan[];
  updatePlan?(planId: string, updates: Partial<Omit<Plan, "id">>): Plan;
  deletePlan?(planId: string): boolean;
  nextPlanName?(): string;
}
