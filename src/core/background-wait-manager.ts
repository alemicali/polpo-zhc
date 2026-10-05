import type { BackgroundWait, BackgroundWaitStore } from "./task-control-store.js";
import type { EventBus } from "./events.js";
import type { TaskStore } from "./task-store.js";
import type { Task, TaskStatus } from "./types.js";

export type BackgroundWaitContinuationResult = "completed" | "deferred";
export type BackgroundWaitContinuation = (
  wait: BackgroundWait,
  task: Task,
  signal: AbortSignal,
) => Promise<BackgroundWaitContinuationResult>;

const TERMINAL_STATUSES = new Set<TaskStatus>(["done", "failed"]);

export class BackgroundWaitManager {
  private continuation?: BackgroundWaitContinuation;
  private timer?: ReturnType<typeof setInterval>;
  private draining = false;
  private stopped = true;
  private readonly activeControllers = new Map<string, AbortController>();

  private readonly onTaskTransition = (): void => {
    void this.tick();
  };

  constructor(
    private readonly events: EventBus,
    private readonly tasks: TaskStore,
    private readonly store: BackgroundWaitStore,
    private readonly pollIntervalMs = 2_000,
  ) {}

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.events.on("task:transition", this.onTaskTransition);
    await this.store.recoverBackgroundWaits();
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
    this.timer.unref?.();
    await this.tick();
  }

  dispose(): void {
    this.stopped = true;
    this.events.off("task:transition", this.onTaskTransition);
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.activeControllers.values()) controller.abort();
    this.activeControllers.clear();
  }

  setContinuation(handler: BackgroundWaitContinuation): void {
    this.continuation = handler;
    void this.tick();
  }

  async create(input: {
    taskId: string;
    sessionId: string;
    targetStatus?: string;
  }): Promise<BackgroundWait> {
    const task = await this.tasks.getTask(input.taskId);
    if (!task) throw new Error(`Task "${input.taskId}" not found`);
    if (!input.sessionId.trim()) throw new Error("A chat session is required for a background wait");

    const existing = (await this.store.listBackgroundWaits(input.sessionId)).find((wait) =>
      wait.taskId === input.taskId
      && wait.targetStatus === input.targetStatus
      && ["waiting", "ready", "running"].includes(wait.state),
    );
    if (existing) return existing;

    const wait = await this.store.createBackgroundWait(input);
    this.events.emit("background-wait:created", { wait });
    await this.reconcileWait(wait, task);
    void this.drainReady();
    return (await this.store.getBackgroundWait(wait.id)) ?? wait;
  }

  async list(sessionId?: string): Promise<BackgroundWait[]> {
    return this.store.listBackgroundWaits(sessionId);
  }

  async get(id: string): Promise<BackgroundWait | undefined> {
    return this.store.getBackgroundWait(id);
  }

  async cancel(id: string): Promise<boolean> {
    this.activeControllers.get(id)?.abort();
    const cancelled = await this.store.cancelBackgroundWait(id);
    if (cancelled) {
      const wait = await this.store.getBackgroundWait(id);
      if (wait) this.events.emit("background-wait:cancelled", { wait });
    }
    return cancelled;
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    const waits = await this.store.listBackgroundWaits();
    for (const wait of waits) {
      if (wait.state !== "waiting") continue;
      const task = await this.tasks.getTask(wait.taskId);
      if (!task) {
        await this.fail(wait.id, `Task "${wait.taskId}" no longer exists`);
        continue;
      }
      await this.reconcileWait(wait, task);
    }
    await this.drainReady();
  }

  private async reconcileWait(wait: BackgroundWait, task: Task): Promise<void> {
    const matches = wait.targetStatus
      ? task.status === wait.targetStatus
      : TERMINAL_STATUSES.has(task.status);
    if (matches) {
      if (await this.store.markBackgroundWaitReady(wait.id, task.status)) {
        const ready = await this.store.getBackgroundWait(wait.id);
        if (ready) this.events.emit("background-wait:ready", { wait: ready });
      }
      return;
    }

    if (wait.targetStatus && TERMINAL_STATUSES.has(task.status)) {
      await this.fail(
        wait.id,
        `Task reached terminal status "${task.status}" before target "${wait.targetStatus}"`,
      );
    }
  }

  private async drainReady(): Promise<void> {
    if (this.draining || !this.continuation || this.stopped) return;
    this.draining = true;
    try {
      const waits = await this.store.listBackgroundWaits();
      for (const candidate of waits.reverse()) {
        if (candidate.state !== "ready") continue;
        const wait = await this.store.claimBackgroundWait(candidate.id);
        if (!wait) continue;
        this.events.emit("background-wait:running", { wait });

        const task = await this.tasks.getTask(wait.taskId);
        if (!task) {
          await this.fail(wait.id, `Task "${wait.taskId}" no longer exists`);
          continue;
        }

        try {
          const controller = new AbortController();
          this.activeControllers.set(wait.id, controller);
          const result = await this.continuation(wait, task, controller.signal);
          const latest = await this.store.getBackgroundWait(wait.id);
          if (latest?.state === "cancelled") continue;
          if (result === "deferred") {
            await this.store.requeueBackgroundWait(wait.id);
            continue;
          }
          await this.store.completeBackgroundWait(wait.id);
          const completed = await this.store.getBackgroundWait(wait.id);
          if (completed?.state === "completed") {
            this.events.emit("background-wait:completed", { wait: completed });
          }
        } catch (error) {
          const latest = await this.store.getBackgroundWait(wait.id);
          if (latest?.state === "cancelled") continue;
          const message = error instanceof Error ? error.message : String(error);
          if (wait.attempts < 3) {
            await this.store.requeueBackgroundWait(wait.id);
          } else {
            await this.fail(wait.id, message);
          }
        } finally {
          this.activeControllers.delete(wait.id);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async fail(id: string, error: string): Promise<void> {
    await this.store.failBackgroundWait(id, error);
    const wait = await this.store.getBackgroundWait(id);
    if (wait?.state === "failed") this.events.emit("background-wait:failed", { wait });
  }
}
