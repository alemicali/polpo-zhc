import type { Task, TaskStatus, OrchestraState } from "./types.js";

/**
 * Abstract interface for task persistence.
 * Implementations can be JSON file, SQLite, PostgreSQL, or in-memory (for tests).
 */
export interface TaskStore {
  // State access
  getState(): OrchestraState;
  setState(partial: Partial<OrchestraState>): void;

  // Task CRUD
  addTask(task: Omit<Task, "id" | "status" | "retries" | "createdAt" | "updatedAt">): Task;
  getTask(taskId: string): Task | undefined;
  getAllTasks(): Task[];
  updateTask(taskId: string, updates: Partial<Omit<Task, "id">>): Task;
  removeTask(taskId: string): boolean;
  removeTasks(filter: (task: Task) => boolean): number;

  // State machine
  transition(taskId: string, newStatus: TaskStatus): Task;
}
