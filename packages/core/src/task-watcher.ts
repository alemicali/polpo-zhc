/**
 * TaskWatcherManager — event-driven task watchers.
 *
 * Watchers listen for task:transition events and fire a configured action
 * when a target task reaches a specific status. Each watcher fires at most once.
 *
 * This is the mechanism for "when task X finishes, do Y" without polling.
 */

import { nanoid } from "nanoid";
import type { EventBus } from "./event-bus.js";
import type { TaskWatcher, TaskStatus, NotificationAction } from "./types.js";

export class TaskWatcherManager {
  private watchers = new Map<string, TaskWatcher>();
  private listener?: (payload: { taskId: string; to: TaskStatus }) => void;
  private actionExecutor?: (action: NotificationAction) => Promise<string>;

  constructor(private emitter: EventBus) {}

  /** Set the action executor callback — injected by the orchestrator. */
  setActionExecutor(executor: (action: NotificationAction) => Promise<string>): void {
    this.actionExecutor = executor;
  }

  /** Start listening for task:transition events. */
  start(): void {
    if (this.listener) return; // already started

    this.listener = (payload) => {
      for (const [id, watcher] of this.watchers) {
        if (watcher.fired) continue;
        if (watcher.taskId !== payload.taskId) continue;
        if (watcher.targetStatus !== payload.to) continue;

        // Match! Fire the watcher
        watcher.fired = true;
        watcher.firedAt = new Date().toISOString();

        this.emitter.emit("watcher:fired", {
          watcherId: id,
          taskId: watcher.taskId,
          targetStatus: watcher.targetStatus,
          actionType: watcher.action.type,
        });

        if (this.actionExecutor) {
          this.actionExecutor(watcher.action).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.emitter.emit("log", {
              level: "error",
              message: `[watcher] Action failed for watcher ${id}: ${msg}`,
            });
          });
        }
      }
    };

    this.emitter.on("task:transition", this.listener as (...args: unknown[]) => void);
  }

  /** Create a new task watcher. */
  create(opts: {
    taskId: string;
    targetStatus: TaskStatus;
    action: NotificationAction;
  }): TaskWatcher {
    const watcher: TaskWatcher = {
      id: `watch-${nanoid(10)}`,
      taskId: opts.taskId,
      targetStatus: opts.targetStatus,
      action: opts.action,
      fired: false,
      createdAt: new Date().toISOString(),
    };

    this.watchers.set(watcher.id, watcher);

    this.emitter.emit("watcher:created", {
      watcherId: watcher.id,
      taskId: watcher.taskId,
      targetStatus: watcher.targetStatus,
    });

    return watcher;
  }

  /** Remove a watcher by ID. */
  remove(watcherId: string): boolean {
    const deleted = this.watchers.delete(watcherId);
    if (deleted) {
      this.emitter.emit("watcher:removed", { watcherId });
    }
    return deleted;
  }

  /** Get a watcher by ID. */
  get(watcherId: string): TaskWatcher | undefined {
    return this.watchers.get(watcherId);
  }

  /** List all watchers. */
  getAll(): TaskWatcher[] {
    return [...this.watchers.values()];
  }

  /** List active (unfired) watchers. */
  getActive(): TaskWatcher[] {
    return [...this.watchers.values()].filter(w => !w.fired);
  }

  /** Cleanup: remove all watchers and stop listening. */
  dispose(): void {
    if (this.listener) {
      this.emitter.off("task:transition", this.listener as (...args: unknown[]) => void);
      this.listener = undefined;
    }
    this.watchers.clear();
  }
}
