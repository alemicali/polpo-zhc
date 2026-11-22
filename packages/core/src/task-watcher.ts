/**
 * TaskWatcherManager — event-driven task watchers.
 *
 * Watchers listen for task:transition events and fire a configured action
 * when a target task reaches a specific status. Each watcher fires at most once.
 *
 * This is the mechanism for "when task X finishes, do Y" without polling.
 *
 * With a {@link TaskWatcherStore} the watchers survive a restart: they are loaded at start, and
 * one whose task reached its status while the server was down fires then. With a
 * {@link LeaseStore} shared by several processes, the action of a watcher runs in one of them.
 */

import { nanoid } from "nanoid";
import type { EventBus } from "./event-bus.js";
import type { TaskWatcher, TaskStatus, NotificationAction } from "./types.js";
import type { LeaseStore, TaskWatcherStore } from "./schedule-store.js";

const WATCHER_CLAIM_TTL_MS = 7 * 24 * 60 * 60_000;

export interface TaskWatcherPersistence {
  store?: TaskWatcherStore;
  leases?: LeaseStore;
  /** The current status of a task: a watcher whose task got there while the server was down fires at start. */
  taskStatus?: (taskId: string) => Promise<TaskStatus | undefined>;
  log?: (level: "info" | "warn", message: string) => void;
}

export class TaskWatcherManager {
  private watchers = new Map<string, TaskWatcher>();
  private listener?: (payload: { taskId: string; to: TaskStatus }) => void;
  private actionExecutor?: (action: NotificationAction) => Promise<string>;
  private readonly owner = `watchers-${nanoid(8)}`;
  /** Loading the stored watchers (start). */
  ready: Promise<void> = Promise.resolve();

  constructor(private emitter: EventBus, private readonly persistence: TaskWatcherPersistence = {}) {}

  /** Set the action executor callback — injected by the orchestrator. */
  setActionExecutor(executor: (action: NotificationAction) => Promise<string>): void {
    this.actionExecutor = executor;
  }

  /** Start listening for task:transition events (and load the stored watchers). */
  start(): void {
    if (this.listener) return; // already started

    this.listener = (payload) => {
      for (const watcher of this.watchers.values()) {
        if (watcher.fired) continue;
        if (watcher.taskId !== payload.taskId) continue;
        if (watcher.targetStatus !== payload.to) continue;
        this.fire(watcher);
      }
    };

    this.emitter.on("task:transition", this.listener as (...args: unknown[]) => void);
    if (this.persistence.store) this.ready = this.load();
  }

  private async load(): Promise<void> {
    const { store, taskStatus } = this.persistence;
    if (!store) return;
    let stored: TaskWatcher[];
    try {
      stored = await store.listWatchers();
    } catch (err) {
      this.persistence.log?.("warn", `[watcher] Could not load the watchers: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const stale = new Date(Date.now() - WATCHER_CLAIM_TTL_MS).toISOString();
    for (const watcher of stored) {
      if (this.watchers.has(watcher.id)) continue;
      // fired long ago: forgotten
      if (watcher.fired && (watcher.firedAt ?? watcher.createdAt) < stale) {
        await store.deleteWatcher(watcher.id).catch(() => false);
        continue;
      }
      this.watchers.set(watcher.id, watcher);
    }
    // reached while the server was down
    if (!taskStatus) return;
    for (const watcher of stored) {
      if (watcher.fired) continue;
      const status = await taskStatus(watcher.taskId).catch(() => undefined);
      const live = this.watchers.get(watcher.id);
      if (live && !live.fired && status === watcher.targetStatus) this.fire(live);
    }
  }

  private fire(watcher: TaskWatcher): void {
    const id = watcher.id;
    watcher.fired = true;
    watcher.firedAt = new Date().toISOString();
    this.save(watcher);

    this.emitter.emit("watcher:fired", {
      watcherId: id,
      taskId: watcher.taskId,
      targetStatus: watcher.targetStatus,
      actionType: watcher.action.type,
    });

    if (!this.actionExecutor) return;
    const executor = this.actionExecutor;
    const run = () => executor(watcher.action).then((result) => {
      this.emitter.emit("watcher:action-completed", { watcherId: id, taskId: watcher.taskId, actionType: watcher.action.type, result });
      this.emitter.emit("log", {
        level: "info",
        message: `[watcher] Action completed for watcher ${id}: ${result}`,
      });
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.emitter.emit("watcher:action-failed", { watcherId: id, taskId: watcher.taskId, actionType: watcher.action.type, error: msg });
      this.emitter.emit("log", {
        level: "error",
        message: `[watcher] Action failed for watcher ${id}: ${msg}`,
      });
    });
    const leases = this.persistence.leases;
    if (!leases) {
      void run();
      return;
    }
    // several processes see the same transition: the action runs in one
    void leases.tryClaim(`watcher:${id}`, this.owner, WATCHER_CLAIM_TTL_MS)
      .catch(() => true)
      .then((claimed) => (claimed ? run() : undefined));
  }

  private save(watcher: TaskWatcher): void {
    this.persistence.store?.saveWatcher({ ...watcher }).catch((err) => {
      this.persistence.log?.("warn", `[watcher] Could not save watcher ${watcher.id}: ${err instanceof Error ? err.message : String(err)}`);
    });
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
    this.save(watcher);

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
      this.persistence.store?.deleteWatcher(watcherId).catch(() => undefined);
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

  /** Cleanup: remove all watchers and stop listening (the stored ones stay). */
  dispose(): void {
    if (this.listener) {
      this.emitter.off("task:transition", this.listener as (...args: unknown[]) => void);
      this.listener = undefined;
    }
    this.watchers.clear();
  }
}
