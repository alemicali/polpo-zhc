import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundWaitManager } from "../core/background-wait-manager.js";
import { TypedEmitter } from "../core/events.js";
import { FileTaskControlStore } from "../stores/file-task-control-store.js";
import { FileTaskStore } from "../stores/file-task-store.js";

describe("BackgroundWaitManager", () => {
  let dir: string;
  let tasks: FileTaskStore;
  let controls: FileTaskControlStore;
  let events: TypedEmitter;
  let manager: BackgroundWaitManager;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "polpo-background-wait-"));
    tasks = new FileTaskStore(dir);
    controls = new FileTaskControlStore(dir);
    events = new TypedEmitter();
    manager = new BackgroundWaitManager(events, tasks, controls, 60_000);
    await manager.start();
    await tasks.addTask({
      title: "External job",
      description: "Wait for completion",
      assignTo: "worker",
      dependsOn: [],
      expectations: [],
      metrics: [],
      maxRetries: 0,
    });
  });

  afterEach(() => {
    manager.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it("continues the chat once when the task reaches the target", async () => {
    const task = (await tasks.getAllTasks())[0];
    const continuation = vi.fn().mockResolvedValue("completed");
    manager.setContinuation(continuation);
    const wait = await manager.create({ taskId: task.id, sessionId: "session-1", targetStatus: "done" });

    await tasks.unsafeSetStatus(task.id, "done", "test completion");
    await manager.tick();
    await manager.tick();

    expect(continuation).toHaveBeenCalledTimes(1);
    await expect(controls.getBackgroundWait(wait.id)).resolves.toMatchObject({ state: "completed" });
  });

  it("leaves a busy session ready for a later retry", async () => {
    const task = (await tasks.getAllTasks())[0];
    await tasks.unsafeSetStatus(task.id, "done", "already complete");
    manager.setContinuation(vi.fn().mockResolvedValue("deferred"));

    const wait = await manager.create({ taskId: task.id, sessionId: "busy-session" });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(controls.getBackgroundWait(wait.id)).resolves.toMatchObject({ state: "ready" });
  });

  it("does not continue a cancelled wait", async () => {
    const task = (await tasks.getAllTasks())[0];
    const continuation = vi.fn().mockResolvedValue("completed");
    manager.setContinuation(continuation);
    const wait = await manager.create({ taskId: task.id, sessionId: "session-1" });
    await manager.cancel(wait.id);

    await tasks.unsafeSetStatus(task.id, "done", "test completion");
    await manager.tick();

    expect(continuation).not.toHaveBeenCalled();
    await expect(controls.getBackgroundWait(wait.id)).resolves.toMatchObject({ state: "cancelled" });
  });

  it("deduplicates equivalent active waits", async () => {
    const task = (await tasks.getAllTasks())[0];
    const first = await manager.create({ taskId: task.id, sessionId: "session-1", targetStatus: "done" });
    const second = await manager.create({ taskId: task.id, sessionId: "session-1", targetStatus: "done" });

    expect(second.id).toBe(first.id);
    await expect(controls.listBackgroundWaits("session-1")).resolves.toHaveLength(1);
  });

  it("aborts a running continuation when cancelled", async () => {
    const task = (await tasks.getAllTasks())[0];
    await tasks.unsafeSetStatus(task.id, "done", "already complete");
    const aborted = vi.fn();
    manager.setContinuation((_wait, _task, signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        aborted();
        reject(new DOMException("Cancelled", "AbortError"));
      }, { once: true });
    }));
    const wait = await manager.create({ taskId: task.id, sessionId: "session-1" });
    await vi.waitFor(async () => {
      await expect(controls.getBackgroundWait(wait.id)).resolves.toMatchObject({ state: "running" });
    });

    await manager.cancel(wait.id);

    await vi.waitFor(() => expect(aborted).toHaveBeenCalledOnce());
    await expect(controls.getBackgroundWait(wait.id)).resolves.toMatchObject({ state: "cancelled" });
  });
});
