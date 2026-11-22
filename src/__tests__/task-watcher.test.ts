import { describe, it, expect, vi, beforeEach } from "vitest";
import { TaskWatcherManager } from "../core/task-watcher.js";
import { TypedEmitter } from "../core/events.js";
import type { NotificationAction, TaskStatus } from "../core/types.js";
import { InMemoryLeaseStore, InMemoryTaskWatcherStore } from "@polpo-ai/core";

describe("TaskWatcherManager", () => {
  let emitter: TypedEmitter;
  let manager: TaskWatcherManager;
  let actionExecutor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    emitter = new TypedEmitter();
    manager = new TaskWatcherManager(emitter);
    actionExecutor = vi.fn().mockResolvedValue("ok");
    manager.setActionExecutor(actionExecutor);
    manager.start();
  });

  // ── Creation ──

  it("creates a watcher with correct properties", () => {
    const action: NotificationAction = {
      type: "create_task",
      title: "Follow-up",
      description: "Do the follow-up work",
      assignTo: "agent-1",
    };
    const watcher = manager.create({
      taskId: "task-1",
      targetStatus: "done",
      action,
    });

    expect(watcher.id).toMatch(/^watch-/);
    expect(watcher.taskId).toBe("task-1");
    expect(watcher.targetStatus).toBe("done");
    expect(watcher.action).toEqual(action);
    expect(watcher.fired).toBe(false);
    expect(watcher.createdAt).toBeTruthy();
  });

  it("emits watcher:created on creation", () => {
    const listener = vi.fn();
    emitter.on("watcher:created", listener);

    manager.create({
      taskId: "task-1",
      targetStatus: "done",
      action: { type: "run_script", command: "echo done" },
    });

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1",
      targetStatus: "done",
    }));
  });

  // ── Firing ──

  it("fires when task transitions to target status", () => {
    const action: NotificationAction = {
      type: "send_notification",
      channel: "telegram",
      title: "Task done!",
      body: "The task has completed.",
    };
    manager.create({
      taskId: "task-42",
      targetStatus: "done",
      action,
    });

    emitter.emit("task:transition", {
      taskId: "task-42",
      from: "review" as TaskStatus,
      to: "done" as TaskStatus,
      task: {} as any,
    });

    expect(actionExecutor).toHaveBeenCalledWith(action);
  });

  it("does NOT fire on wrong task ID", () => {
    manager.create({
      taskId: "task-42",
      targetStatus: "done",
      action: { type: "run_script", command: "echo hi" },
    });

    emitter.emit("task:transition", {
      taskId: "task-99",
      from: "review" as TaskStatus,
      to: "done" as TaskStatus,
      task: {} as any,
    });

    expect(actionExecutor).not.toHaveBeenCalled();
  });

  it("does NOT fire on wrong target status", () => {
    manager.create({
      taskId: "task-42",
      targetStatus: "done",
      action: { type: "run_script", command: "echo hi" },
    });

    emitter.emit("task:transition", {
      taskId: "task-42",
      from: "assigned" as TaskStatus,
      to: "in_progress" as TaskStatus,
      task: {} as any,
    });

    expect(actionExecutor).not.toHaveBeenCalled();
  });

  it("fires only once (does not re-trigger)", () => {
    manager.create({
      taskId: "task-42",
      targetStatus: "done",
      action: { type: "run_script", command: "echo hi" },
    });

    // First transition
    emitter.emit("task:transition", {
      taskId: "task-42",
      from: "review" as TaskStatus,
      to: "done" as TaskStatus,
      task: {} as any,
    });

    // Second transition (somehow)
    emitter.emit("task:transition", {
      taskId: "task-42",
      from: "review" as TaskStatus,
      to: "done" as TaskStatus,
      task: {} as any,
    });

    expect(actionExecutor).toHaveBeenCalledTimes(1);
  });

  it("marks watcher as fired with timestamp", () => {
    const watcher = manager.create({
      taskId: "task-42",
      targetStatus: "done",
      action: { type: "run_script", command: "echo hi" },
    });

    emitter.emit("task:transition", {
      taskId: "task-42",
      from: "review" as TaskStatus,
      to: "done" as TaskStatus,
      task: {} as any,
    });

    const updated = manager.get(watcher.id)!;
    expect(updated.fired).toBe(true);
    expect(updated.firedAt).toBeTruthy();
  });

  it("emits watcher:fired event", () => {
    const listener = vi.fn();
    emitter.on("watcher:fired", listener);

    const watcher = manager.create({
      taskId: "task-42",
      targetStatus: "failed",
      action: { type: "run_script", command: "echo fail" },
    });

    emitter.emit("task:transition", {
      taskId: "task-42",
      from: "review" as TaskStatus,
      to: "failed" as TaskStatus,
      task: {} as any,
    });

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      watcherId: watcher.id,
      taskId: "task-42",
      targetStatus: "failed",
      actionType: "run_script",
    }));
  });

  // ── Multiple watchers ──

  it("supports multiple watchers on different tasks", () => {
    const action1: NotificationAction = { type: "run_script", command: "echo task1" };
    const action2: NotificationAction = { type: "run_script", command: "echo task2" };

    manager.create({ taskId: "task-1", targetStatus: "done", action: action1 });
    manager.create({ taskId: "task-2", targetStatus: "done", action: action2 });

    emitter.emit("task:transition", {
      taskId: "task-1",
      from: "review" as TaskStatus,
      to: "done" as TaskStatus,
      task: {} as any,
    });

    expect(actionExecutor).toHaveBeenCalledTimes(1);
    expect(actionExecutor).toHaveBeenCalledWith(action1);
  });

  it("supports multiple watchers on same task with different target statuses", () => {
    const actionDone: NotificationAction = { type: "run_script", command: "echo done" };
    const actionFailed: NotificationAction = { type: "run_script", command: "echo failed" };

    manager.create({ taskId: "task-1", targetStatus: "done", action: actionDone });
    manager.create({ taskId: "task-1", targetStatus: "failed", action: actionFailed });

    emitter.emit("task:transition", {
      taskId: "task-1",
      from: "review" as TaskStatus,
      to: "failed" as TaskStatus,
      task: {} as any,
    });

    expect(actionExecutor).toHaveBeenCalledTimes(1);
    expect(actionExecutor).toHaveBeenCalledWith(actionFailed);
  });

  // ── Listing ──

  it("lists all watchers", () => {
    manager.create({ taskId: "task-1", targetStatus: "done", action: { type: "run_script", command: "a" } });
    manager.create({ taskId: "task-2", targetStatus: "done", action: { type: "run_script", command: "b" } });

    expect(manager.getAll()).toHaveLength(2);
  });

  it("lists only active (unfired) watchers", () => {
    manager.create({ taskId: "task-1", targetStatus: "done", action: { type: "run_script", command: "a" } });
    manager.create({ taskId: "task-2", targetStatus: "done", action: { type: "run_script", command: "b" } });

    // Fire the first one
    emitter.emit("task:transition", {
      taskId: "task-1",
      from: "review" as TaskStatus,
      to: "done" as TaskStatus,
      task: {} as any,
    });

    expect(manager.getActive()).toHaveLength(1);
    expect(manager.getActive()[0].taskId).toBe("task-2");
  });

  // ── Removal ──

  it("removes a watcher by ID", () => {
    const watcher = manager.create({
      taskId: "task-1",
      targetStatus: "done",
      action: { type: "run_script", command: "a" },
    });

    expect(manager.remove(watcher.id)).toBe(true);
    expect(manager.get(watcher.id)).toBeUndefined();
    expect(manager.getAll()).toHaveLength(0);
  });

  it("emits watcher:removed on removal", () => {
    const listener = vi.fn();
    emitter.on("watcher:removed", listener);

    const watcher = manager.create({
      taskId: "task-1",
      targetStatus: "done",
      action: { type: "run_script", command: "a" },
    });
    manager.remove(watcher.id);

    expect(listener).toHaveBeenCalledWith({ watcherId: watcher.id });
  });

  it("returns false when removing non-existent watcher", () => {
    expect(manager.remove("watch-nonexistent")).toBe(false);
  });

  it("removed watcher does not fire", () => {
    const watcher = manager.create({
      taskId: "task-1",
      targetStatus: "done",
      action: { type: "run_script", command: "a" },
    });
    manager.remove(watcher.id);

    emitter.emit("task:transition", {
      taskId: "task-1",
      from: "review" as TaskStatus,
      to: "done" as TaskStatus,
      task: {} as any,
    });

    expect(actionExecutor).not.toHaveBeenCalled();
  });

  // ── Dispose ──

  it("dispose removes all watchers and stops listening", () => {
    manager.create({ taskId: "task-1", targetStatus: "done", action: { type: "run_script", command: "a" } });
    manager.dispose();

    expect(manager.getAll()).toHaveLength(0);

    // Events after dispose should not trigger anything
    emitter.emit("task:transition", {
      taskId: "task-1",
      from: "review" as TaskStatus,
      to: "done" as TaskStatus,
      task: {} as any,
    });

    expect(actionExecutor).not.toHaveBeenCalled();
  });

  // ── Edge cases ──

  it("handles action executor errors gracefully", () => {
    actionExecutor.mockRejectedValueOnce(new Error("boom"));

    const logListener = vi.fn();
    emitter.on("log", logListener);

    manager.create({
      taskId: "task-1",
      targetStatus: "done",
      action: { type: "run_script", command: "fail" },
    });

    emitter.emit("task:transition", {
      taskId: "task-1",
      from: "review" as TaskStatus,
      to: "done" as TaskStatus,
      task: {} as any,
    });

    // Action was called even though it will error
    expect(actionExecutor).toHaveBeenCalled();
  });

  it("does not fire without action executor set", () => {
    const mgr = new TaskWatcherManager(emitter);
    mgr.start();
    // No setActionExecutor call

    mgr.create({
      taskId: "task-1",
      targetStatus: "done",
      action: { type: "run_script", command: "a" },
    });

    // Should not throw
    emitter.emit("task:transition", {
      taskId: "task-1",
      from: "review" as TaskStatus,
      to: "done" as TaskStatus,
      task: {} as any,
    });

    expect(actionExecutor).not.toHaveBeenCalled();
    // Watcher should still be marked as fired
    expect(mgr.getAll()[0].fired).toBe(true);
  });

  it("start is idempotent — calling twice does not double-listen", () => {
    manager.start(); // called again
    manager.create({
      taskId: "task-1",
      targetStatus: "done",
      action: { type: "run_script", command: "a" },
    });

    emitter.emit("task:transition", {
      taskId: "task-1",
      from: "review" as TaskStatus,
      to: "done" as TaskStatus,
      task: {} as any,
    });

    expect(actionExecutor).toHaveBeenCalledTimes(1);
  });
});

describe("TaskWatcherManager persistence", () => {
  const action: NotificationAction = { type: "run_script", command: "echo done" };
  const transition = (emitter: TypedEmitter, taskId: string, to: TaskStatus) =>
    emitter.emit("task:transition", { taskId, from: "review" as TaskStatus, to, task: {} as any });

  it("watchers survive a restart; one whose task got there while the server was down fires at start", async () => {
    const store = new InMemoryTaskWatcherStore();
    const a = new TaskWatcherManager(new TypedEmitter(), { store });
    a.start();
    const kept = a.create({ taskId: "t1", targetStatus: "done", action });
    const reached = a.create({ taskId: "t2", targetStatus: "done", action });
    await vi.waitFor(async () => expect(await store.listWatchers()).toHaveLength(2));
    a.dispose();

    const emitter = new TypedEmitter();
    const execute = vi.fn().mockResolvedValue("ok");
    const b = new TaskWatcherManager(emitter, { store, taskStatus: async (id) => (id === "t2" ? "done" : "in_progress") });
    b.setActionExecutor(execute);
    b.start();
    await b.ready;
    expect(b.get(kept.id)).toMatchObject({ fired: false });
    expect(b.get(reached.id)).toMatchObject({ fired: true });
    expect(execute).toHaveBeenCalledTimes(1);
    transition(emitter, "t1", "done");
    expect(execute).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => expect((await store.listWatchers()).every((w) => w.fired)).toBe(true));
    b.remove(kept.id);
    await vi.waitFor(async () => expect(await store.listWatchers()).toHaveLength(1));
  });

  it("two processes seeing the same transition run the action once", async () => {
    const store = new InMemoryTaskWatcherStore();
    const leases = new InMemoryLeaseStore();
    const ea = new TypedEmitter();
    const eb = new TypedEmitter();
    const a = new TaskWatcherManager(ea, { store, leases });
    a.start();
    const w = a.create({ taskId: "t1", targetStatus: "done", action });
    await vi.waitFor(async () => expect(await store.listWatchers()).toHaveLength(1));
    const b = new TaskWatcherManager(eb, { store, leases });
    b.start();
    await b.ready;
    const xa = vi.fn().mockResolvedValue("ok");
    const xb = vi.fn().mockResolvedValue("ok");
    a.setActionExecutor(xa);
    b.setActionExecutor(xb);
    transition(ea, "t1", "done");
    transition(eb, "t1", "done");
    await vi.waitFor(() => expect(xa.mock.calls.length + xb.mock.calls.length).toBe(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(xa.mock.calls.length + xb.mock.calls.length).toBe(1);
    expect(a.get(w.id)!.fired && b.get(w.id)!.fired).toBe(true);
  });
});
