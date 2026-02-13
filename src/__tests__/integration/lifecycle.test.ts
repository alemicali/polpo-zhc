import { describe, it, expect, beforeEach, vi } from "vitest";
import { Orchestrator } from "../../core/orchestrator.js";
import { registerAdapter } from "../../adapters/registry.js";
import { InMemoryTaskStore, InMemoryRunStore, MockAdapter, createTestAgent } from "../fixtures.js";
import type { TaskResult } from "../../core/types.js";

// Mock child_process.spawn and writeFileSync since spawnForTask spawns a real subprocess
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: (_cmd: string, _args: string[], _opts: any) => {
      const child = { pid: Math.floor(Math.random() * 90000) + 10000, unref: () => {} };
      return child;
    },
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    writeFileSync: (_path: string, _data: string) => {},
  };
});

/**
 * Helper: simulate what the runner subprocess does — populate RunStore with result.
 * In real usage, the runner.js process does this. In tests, we mock it.
 */
function simulateRunnerResult(
  runStore: InMemoryRunStore,
  taskId: string,
  result: TaskResult,
): void {
  const run = runStore.getRunByTaskId(taskId);
  if (run && run.status === "running") {
    const status = result.exitCode === 0 ? "completed" : "failed";
    runStore.completeRun(run.id, status, result);
  }
}

describe("integration: lifecycle", () => {
  let store: InMemoryTaskStore;
  let runStore: InMemoryRunStore;
  let mockAdapter: MockAdapter;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    store = new InMemoryTaskStore();
    runStore = new InMemoryRunStore();
    mockAdapter = new MockAdapter();
    registerAdapter("mock", () => mockAdapter);

    orchestrator = new Orchestrator({
      workDir: "/tmp/orchestra-integration-test",
      store,
      runStore,
      assessFn: async () => ({
        passed: true,
        checks: [],
        metrics: [],
        timestamp: new Date().toISOString(),
      }),
    });

    orchestrator.initInteractive("integration-test", {
      name: "test-team",
      agents: [
        createTestAgent({ name: "worker", adapter: "mock" }),
      ],
    });
  });

  it("full lifecycle: pending → done via RunStore", async () => {
    const transitions: string[] = [];
    orchestrator.on("agent:spawned", () => transitions.push("spawned"));
    orchestrator.on("task:transition", ({ to }) => transitions.push(to));

    orchestrator.addTask({
      title: "Simple task",
      description: "Do something",
      assignTo: "worker",
    });

    // Tick 1: spawn agent (writes run record to RunStore)
    orchestrator.tick();
    expect(transitions).toContain("spawned");

    // Simulate the runner completing the task
    const task = store.getAllTasks()[0];
    simulateRunnerResult(runStore, task.id, {
      exitCode: 0, stdout: "done", stderr: "", duration: 100,
    });

    // Tick 2: collect results from RunStore
    orchestrator.tick();
    await new Promise(r => setTimeout(r, 10));

    expect(store.getTask(task.id)!.status).toBe("done");
  });

  it("dependency resolution: B waits for A", async () => {
    const spawnOrder: string[] = [];
    orchestrator.on("agent:spawned", ({ taskTitle }) => spawnOrder.push(taskTitle));

    const taskA = orchestrator.addTask({
      title: "Task A",
      description: "First",
      assignTo: "worker",
    });

    orchestrator.addTask({
      title: "Task B",
      description: "After A",
      assignTo: "worker",
      dependsOn: [taskA.id],
    });

    // Tick 1: spawn A
    orchestrator.tick();
    expect(spawnOrder).toEqual(["Task A"]);

    // Simulate A completing
    simulateRunnerResult(runStore, taskA.id, {
      exitCode: 0, stdout: "ok", stderr: "", duration: 50,
    });

    // Tick 2: collect A result, A → done, spawn B
    orchestrator.tick();
    await new Promise(r => setTimeout(r, 10));

    expect(spawnOrder).toContain("Task B");
  });

  it("retry flow: fail → retry → succeed via RunStore", async () => {
    const retryEvents: any[] = [];
    orchestrator.on("task:retry", (e) => retryEvents.push(e));

    orchestrator.addTask({
      title: "Flaky task",
      description: "Fails first, succeeds second",
      assignTo: "worker",
    });

    // Tick 1: spawn
    orchestrator.tick();
    const task = store.getAllTasks()[0];

    // Simulate failure
    simulateRunnerResult(runStore, task.id, {
      exitCode: 1, stdout: "", stderr: "error", duration: 50,
    });

    // Tick 2: collect failure → retry
    orchestrator.tick();
    await new Promise(r => setTimeout(r, 10));

    expect(retryEvents.length).toBeGreaterThanOrEqual(1);
    expect(store.getTask(task.id)!.status).toBe("pending");

    // Tick 3: respawn
    orchestrator.tick();

    // Simulate success
    simulateRunnerResult(runStore, task.id, {
      exitCode: 0, stdout: "ok", stderr: "", duration: 50,
    });

    // Tick 4: collect success → done
    orchestrator.tick();
    await new Promise(r => setTimeout(r, 10));

    expect(store.getTask(task.id)!.status).toBe("done");
  });

  it("deadlock detection with unresolvable deps", () => {
    const deadlockEvents: any[] = [];
    orchestrator.on("orchestrator:deadlock", (e) => deadlockEvents.push(e));

    orchestrator.addTask({
      title: "Blocked task",
      description: "Depends on nonexistent",
      assignTo: "worker",
      dependsOn: ["nonexistent-dep"],
    });

    orchestrator.tick();

    expect(deadlockEvents).toHaveLength(1);
    const task = store.getAllTasks()[0];
    expect(task.status).toBe("failed");
  });
});
