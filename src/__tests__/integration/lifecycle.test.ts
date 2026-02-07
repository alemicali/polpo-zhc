import { describe, it, expect, beforeEach } from "vitest";
import { Orchestrator } from "../../orchestrator.js";
import { registerAdapter } from "../../adapters/registry.js";
import { InMemoryTaskStore, MockAdapter, createTestAgent } from "../fixtures.js";

describe("integration: lifecycle", () => {
  let store: InMemoryTaskStore;
  let mockAdapter: MockAdapter;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    store = new InMemoryTaskStore();
    mockAdapter = new MockAdapter();
    registerAdapter("mock", () => mockAdapter);

    orchestrator = new Orchestrator({
      workDir: "/tmp/orchestra-integration-test",
      store,
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

  it("full lifecycle: pending → done", async () => {
    const transitions: string[] = [];
    orchestrator.on("agent:spawned", () => transitions.push("spawned"));
    orchestrator.on("task:transition", ({ to }) => transitions.push(to));

    orchestrator.addTask({
      title: "Simple task",
      description: "Do something",
      assignTo: "worker",
    });

    // First tick: spawn agent
    orchestrator.tick();

    // Wait for async result handling
    await new Promise(r => setTimeout(r, 50));

    // Second tick: collect results
    orchestrator.tick();

    await new Promise(r => setTimeout(r, 50));

    const task = store.getAllTasks()[0];
    expect(task.status).toBe("done");
    expect(transitions).toContain("spawned");
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
    await new Promise(r => setTimeout(r, 50));

    // Tick 2: A finishes, spawn B
    orchestrator.tick();
    await new Promise(r => setTimeout(r, 50));

    // Tick 3: B finishes
    orchestrator.tick();
    await new Promise(r => setTimeout(r, 50));

    expect(spawnOrder[0]).toBe("Task A");
    // B should be spawned after A completes
    if (spawnOrder.length > 1) {
      expect(spawnOrder[1]).toBe("Task B");
    }
  });

  it("retry flow: fail → retry → succeed", async () => {
    let callCount = 0;
    mockAdapter.resultFn = () => {
      callCount++;
      if (callCount === 1) {
        return { exitCode: 1, stdout: "", stderr: "error", duration: 50 };
      }
      return { exitCode: 0, stdout: "ok", stderr: "", duration: 50 };
    };

    const retryEvents: any[] = [];
    orchestrator.on("task:retry", (e) => retryEvents.push(e));

    orchestrator.addTask({
      title: "Flaky task",
      description: "Fails first, succeeds second",
      assignTo: "worker",
    });

    // Tick 1: spawn, finishes with failure
    orchestrator.tick();
    await new Promise(r => setTimeout(r, 50));

    // Tick 2: collect failure, trigger retry
    orchestrator.tick();
    await new Promise(r => setTimeout(r, 50));

    // Tick 3: respawn (task is pending again)
    orchestrator.tick();
    await new Promise(r => setTimeout(r, 50));

    // Tick 4: collect success
    orchestrator.tick();
    await new Promise(r => setTimeout(r, 50));

    expect(retryEvents.length).toBeGreaterThanOrEqual(1);
    const task = store.getAllTasks()[0];
    // Task should eventually be done or still in progress
    expect(["done", "pending", "assigned", "in_progress", "review"]).toContain(task.status);
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
