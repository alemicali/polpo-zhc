/**
 * Supervisor tick: how many times it reads the task list and the missions, and that the
 * end-of-tick group cleanup still sees tasks changed while the tick ran.
 */
import { describe, it, expect, vi } from "vitest";
import { OrchestratorEngine } from "@polpo-ai/core";
import type { Mission, Task, TaskStatus } from "../core/types.js";
import { TypedEmitter } from "../core/events.js";
import { InMemoryTaskStore, InMemoryRunStore } from "./fixtures.js";

/** Returns copies, like the Drizzle store, so a snapshot does not follow later writes. */
class CopyingTaskStore extends InMemoryTaskStore {
  missions = new Map<string, Mission>();
  override async getAllTasks(): Promise<Task[]> { return structuredClone(await super.getAllTasks()); }
  override async getTask(id: string): Promise<Task | undefined> {
    const task = await super.getTask(id);
    return task ? structuredClone(task) : undefined;
  }
  async getMission(id: string): Promise<Mission | undefined> { return this.missions.get(id); }
  async getMissionByName(name: string): Promise<Mission | undefined> {
    return [...this.missions.values()].find((m) => m.name === name);
  }
}

/** Like the orchestrator's store wrapper: every status change emits task:transition. */
function withTransitionEvents(store: CopyingTaskStore, emitter: TypedEmitter): CopyingTaskStore {
  const transition = store.transition.bind(store);
  Object.assign(store, {
    __emitsTaskTransitionEvents: true,
    transition: async (taskId: string, to: TaskStatus) => {
      const from = (await InMemoryTaskStore.prototype.getTask.call(store, taskId))!.status;
      const task = await transition(taskId, to);
      emitter.emit("task:transition", { taskId, from, to, task: structuredClone(task) });
      return task;
    },
  });
  return store;
}

async function addTask(store: CopyingTaskStore, opts: Partial<Task> & { status?: TaskStatus } = {}): Promise<Task> {
  const { status, ...rest } = opts;
  const task = await store.addTask({
    title: "t", description: "d", assignTo: "dev", dependsOn: [], expectations: [], metrics: [], maxRetries: 2, ...rest,
  });
  const path: Record<string, TaskStatus[]> = {
    pending: [], assigned: ["assigned"], in_progress: ["assigned", "in_progress"],
    review: ["assigned", "in_progress", "review"], done: ["assigned", "in_progress", "review", "done"],
    failed: ["assigned", "in_progress", "failed"],
  };
  for (const s of path[status ?? "pending"]) await InMemoryTaskStore.prototype.transition.call(store, task.id, s);
  return structuredClone((await InMemoryTaskStore.prototype.getTask.call(store, task.id))!);
}

function setup(opts: { evented?: boolean } = {}) {
  const emitter = new TypedEmitter();
  const base = new CopyingTaskStore();
  const store = opts.evented === false ? base : withTransitionEvents(base, emitter);
  const getAllTasks = vi.spyOn(store, "getAllTasks");
  const getTask = vi.spyOn(store, "getTask");
  const getMission = vi.spyOn(store, "getMission");
  const getMissionByName = vi.spyOn(store, "getMissionByName");
  const cleaned: Task[][] = [];
  const duringTick: Array<() => Promise<void>> = [];
  const missionExecutor = {
    cleanupCompletedGroups: vi.fn(async (tasks: Task[]) => { cleaned.push(structuredClone(tasks)); }),
    getQualityGates: () => [], getCheckpoints: () => [], getDelays: () => [],
    getActiveCheckpoints: () => [], getActiveDelays: () => [],
  };
  const taskRunner = {
    collectResults: vi.fn(async () => { for (const step of duringTick) await step(); }),
    enforceHealthChecks: vi.fn(async () => {}),
    spawnForTask: vi.fn(async () => {}),
    syncProcessesFromRunStore: vi.fn(async () => {}),
    recoverOrphanedTasks: vi.fn(async () => 0),
  };
  const ctx = {
    emitter,
    registry: store,
    runStore: new InMemoryRunStore(),
    config: { project: "p", teams: [], settings: { maxRetries: 2, logLevel: "quiet" } },
  };
  const engine = new OrchestratorEngine({
    ctx: ctx as never,
    taskManager: {} as never,
    agentManager: { getAgents: async () => [], findAgent: async () => undefined } as never,
    missionExecutor: missionExecutor as never,
    taskRunner,
    assessmentOrchestrator: { handleResult: () => {}, retryOrFail: async () => {} },
  });
  return { engine, store, emitter, getAllTasks, getTask, getMission, getMissionByName, cleaned, duringTick, missionExecutor };
}

const byId = (tasks: Task[]) => new Map(tasks.map((t) => [t.id, t]));

describe("OrchestratorEngine.tick task reads", () => {
  it("reads the task list once per tick and cleans up groups from that snapshot", async () => {
    const s = setup();
    await addTask(s.store, { group: "g1", status: "in_progress" });
    await addTask(s.store, { group: "g1", status: "done" });

    await s.engine.tick();
    await s.engine.tick();

    expect(s.getAllTasks).toHaveBeenCalledTimes(2);
    expect(s.getTask).not.toHaveBeenCalled();
    expect(s.cleaned).toHaveLength(2);
    expect(s.cleaned[1].map((t) => t.status)).toEqual(["in_progress", "done"]);
  });

  it("gives the cleanup fresh copies of tasks that changed during the tick", async () => {
    const s = setup();
    const running = await addTask(s.store, { group: "g1", status: "review" });
    const done = await addTask(s.store, { group: "g1", status: "done" });
    s.duringTick.push(async () => { await s.store.transition(running.id, "done"); });

    await s.engine.tick();

    expect(s.getAllTasks).toHaveBeenCalledTimes(1);
    expect(s.getTask).toHaveBeenCalledTimes(1);
    expect(s.getTask).toHaveBeenCalledWith(running.id);
    const seen = byId(s.cleaned[0]);
    expect(seen.get(running.id)?.status).toBe("done");
    expect(seen.get(done.id)?.status).toBe("done");
    expect(s.cleaned[0].map((t) => t.id)).toEqual([running.id, done.id]);
  });

  it("drops tasks removed and appends tasks created during the tick", async () => {
    const s = setup();
    const keep = await addTask(s.store, { group: "g1", status: "in_progress" });
    const gone = await addTask(s.store, { group: "g1", status: "pending", dependsOn: ["missing"] });
    let created: Task | undefined;
    s.duringTick.push(async () => {
      await s.store.removeTask(gone.id);
      s.emitter.emit("task:removed", { taskId: gone.id });
      created = await addTask(s.store, { group: "g2" });
      s.emitter.emit("task:created", { task: created });
    });

    await s.engine.tick();

    expect(s.getAllTasks).toHaveBeenCalledTimes(1);
    expect(s.cleaned[0].map((t) => t.id)).toEqual([keep.id, created!.id]);
  });

  it("ignores task events emitted after the tick", async () => {
    const s = setup();
    const task = await addTask(s.store, { group: "g1", status: "in_progress" });
    await s.engine.tick();
    s.emitter.emit("task:updated", { taskId: task.id, task });
    await s.engine.tick();
    expect(s.getTask).not.toHaveBeenCalled();
    expect(s.emitter.listenerCount("task:updated")).toBe(0);
  });

  it("re-reads every task when the store does not emit transition events", async () => {
    const s = setup({ evented: false });
    const running = await addTask(s.store, { group: "g1", status: "review" });
    s.duringTick.push(async () => { await s.store.transition(running.id, "done"); });

    await s.engine.tick();

    expect(s.getAllTasks).toHaveBeenCalledTimes(2);
    expect(byId(s.cleaned[0]).get(running.id)?.status).toBe("done");
  });

  it("re-reads every task when many tasks changed during the tick", async () => {
    const s = setup();
    const tasks: Task[] = [];
    for (let i = 0; i < 30; i++) tasks.push(await addTask(s.store, { group: `g${i}`, status: "review" }));
    s.duringTick.push(async () => { for (const t of tasks) await s.store.transition(t.id, "done"); });

    await s.engine.tick();

    expect(s.getAllTasks).toHaveBeenCalledTimes(2);
    expect(s.getTask).not.toHaveBeenCalled();
    expect(s.cleaned[0].every((t) => t.status === "done")).toBe(true);
  });

  it("still cleans up from the snapshot when every task is terminal", async () => {
    const s = setup();
    await addTask(s.store, { group: "g1", status: "done" });
    await addTask(s.store, { group: "g1", status: "failed" });

    expect(await s.engine.tick()).toBe(true);

    expect(s.getAllTasks).toHaveBeenCalledTimes(1);
    expect(s.missionExecutor.cleanupCompletedGroups).toHaveBeenCalledTimes(1);
    expect(s.cleaned[0].map((t) => t.status)).toEqual(["done", "failed"]);
  });
});

describe("OrchestratorEngine.tick mission lookups", () => {
  it("resolves each mission once per tick for its pending tasks", async () => {
    const s = setup();
    const now = new Date().toISOString();
    const mission: Mission = { id: "m1", name: "M1", data: "{}", status: "paused", createdAt: now, updatedAt: now };
    const legacy: Mission = { id: "m2", name: "Legacy", data: "{}", status: "cancelled", createdAt: now, updatedAt: now };
    s.store.missions.set(mission.id, mission);
    s.store.missions.set(legacy.id, legacy);
    await addTask(s.store, { status: "in_progress" }); // keeps the deadlock check away
    for (let i = 0; i < 3; i++) await addTask(s.store, { group: "M1", missionId: "m1" });
    for (let i = 0; i < 2; i++) await addTask(s.store, { group: "Legacy" });

    await s.engine.tick();
    expect(s.getMission).toHaveBeenCalledTimes(1);
    expect(s.getMissionByName).toHaveBeenCalledTimes(1);

    // Fresh lookups on the next tick: a resumed mission is seen.
    mission.status = "active";
    await s.engine.tick();
    expect(s.getMission).toHaveBeenCalledTimes(2);
    expect(s.getMissionByName).toHaveBeenCalledTimes(2);
  });

  it("does not spawn tasks of paused or cancelled missions", async () => {
    const s = setup();
    const now = new Date().toISOString();
    s.store.missions.set("m1", { id: "m1", name: "M1", data: "{}", status: "paused", createdAt: now, updatedAt: now });
    s.store.missions.set("m3", { id: "m3", name: "M3", data: "{}", status: "active", createdAt: now, updatedAt: now });
    await addTask(s.store, { status: "in_progress" });
    await addTask(s.store, { group: "M1", missionId: "m1" });
    await addTask(s.store, { group: "M1", missionId: "m1" });
    const runnable = await addTask(s.store, { group: "M3", missionId: "m3" });

    await s.engine.tick();

    const spawn = (s.engine as unknown as { runner: { spawnForTask: ReturnType<typeof vi.fn> } }).runner.spawnForTask;
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0].id).toBe(runnable.id);
  });
});
