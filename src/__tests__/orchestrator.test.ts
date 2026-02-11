import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { Orchestrator, buildRetryPrompt } from "../core/orchestrator.js";
import { analyzeBlockedTasks } from "../core/deadlock-resolver.js";
import { registerAdapter } from "../adapters/registry.js";
import { InMemoryTaskStore, InMemoryRunStore, MockAdapter, createTestTask, createTestAgent, createTestActivity } from "./fixtures.js";
import type { TaskResult } from "../core/types.js";
import type { RunRecord } from "../core/run-store.js";

const TEST_WORK_DIR = "/tmp/orchestra-test";

function createTestRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  const now = new Date().toISOString();
  return {
    id: "run-1",
    taskId: "task-1",
    pid: 0,
    agentName: "agent-1",
    adapterType: "mock",
    status: "running",
    startedAt: now,
    updatedAt: now,
    activity: createTestActivity(),
    configPath: "/tmp/run.json",
    ...overrides,
  };
}

describe("Orchestrator", () => {
  let store: InMemoryTaskStore;
  let runStore: InMemoryRunStore;
  let mockAdapter: MockAdapter;
  let orchestrator: Orchestrator;

  afterEach(() => {
    const orchestraDir = `${TEST_WORK_DIR}/.polpo`;
    if (existsSync(orchestraDir)) rmSync(orchestraDir, { recursive: true });
  });

  beforeEach(() => {
    store = new InMemoryTaskStore();
    runStore = new InMemoryRunStore();
    mockAdapter = new MockAdapter();
    registerAdapter("mock", () => mockAdapter);

    orchestrator = new Orchestrator({
      workDir: TEST_WORK_DIR,
      store,
      runStore,
      assessFn: async () => ({
        passed: true,
        checks: [],
        metrics: [],
        timestamp: new Date().toISOString(),
      }),
    });

    const team = {
      name: "test-team",
      agents: [createTestAgent({ name: "agent-1", adapter: "mock" })],
    };
    orchestrator.initInteractive("test-project", team);
  });

  describe("addTask", () => {
    it("creates a task and emits task:created", () => {
      const events: any[] = [];
      orchestrator.on("task:created", (e) => events.push(e));

      const task = orchestrator.addTask({
        title: "Test",
        description: "Test task",
        assignTo: "agent-1",
      });

      expect(task.status).toBe("pending");
      expect(task.title).toBe("Test");
      expect(events).toHaveLength(1);
      expect(events[0].task.id).toBe(task.id);
    });
  });

  describe("tick", () => {
    it("returns true when all tasks are terminal", () => {
      const task = orchestrator.addTask({
        title: "Test",
        description: "Done",
        assignTo: "agent-1",
      });
      // Manually set to done
      store.transition(task.id, "assigned");
      store.transition(task.id, "in_progress");
      store.transition(task.id, "review");
      store.transition(task.id, "done");

      expect(orchestrator.tick()).toBe(true);
    });

    it("detects deadlock with missing deps (unresolvable)", () => {
      const events: any[] = [];
      orchestrator.on("orchestrator:deadlock", (e) => events.push(e));

      const taskA = orchestrator.addTask({
        title: "Task A",
        description: "Depends on B",
        assignTo: "agent-1",
        dependsOn: ["nonexistent-id"],
      });

      orchestrator.tick();

      expect(events).toHaveLength(1);
      expect(events[0].taskIds).toContain(taskA.id);
    });

    it("attempts resolution when dep is failed (resolvable)", () => {
      const detected: any[] = [];
      orchestrator.on("deadlock:detected", (e) => detected.push(e));

      // Create Task A (no deps) and force it to failed
      const taskA = orchestrator.addTask({
        title: "Task A",
        description: "Do something",
        assignTo: "agent-1",
      });
      store.transition(taskA.id, "assigned");
      store.transition(taskA.id, "in_progress");
      store.transition(taskA.id, "failed");

      // Create Task B that depends on (now-failed) Task A
      orchestrator.addTask({
        title: "Task B",
        description: "Depends on A",
        assignTo: "agent-1",
        dependsOn: [taskA.id],
      });

      // tick should NOT force-fail B immediately — it should detect resolvable deadlock
      const done = orchestrator.tick();

      expect(done).toBe(false); // loop continues (async resolution pending)
      expect(detected).toHaveLength(1);
      expect(detected[0].resolvableCount).toBe(1);
    });

    it("emits orchestrator:tick with counts", () => {
      const events: any[] = [];
      orchestrator.on("orchestrator:tick", (e) => events.push(e));

      orchestrator.addTask({
        title: "Test",
        description: "Task",
        assignTo: "agent-1",
      });

      orchestrator.tick();

      expect(events.length).toBeGreaterThan(0);
      const lastTick = events[events.length - 1];
      expect(lastTick).toHaveProperty("pending");
      expect(lastTick).toHaveProperty("running");
      expect(lastTick).toHaveProperty("done");
      expect(lastTick).toHaveProperty("failed");
    });
  });

  describe("collectResults via RunStore", () => {
    it("processes terminal runs and transitions tasks", () => {
      const task = orchestrator.addTask({
        title: "Collect me",
        description: "Test",
        assignTo: "agent-1",
      });
      store.transition(task.id, "assigned");
      store.transition(task.id, "in_progress");

      const result: TaskResult = {
        exitCode: 0,
        stdout: "done",
        stderr: "",
        duration: 100,
      };

      // Pre-populate RunStore with a completed run
      runStore.upsertRun(createTestRunRecord({
        id: "run-collect",
        taskId: task.id,
        status: "completed",
        result,
      }));

      orchestrator.tick();

      // Run should be consumed (deleted)
      expect(runStore.getRun("run-collect")).toBeUndefined();
      // Task should be done
      expect(store.getTask(task.id)!.status).toBe("done");
    });

    it("handles failed runs", () => {
      const task = orchestrator.addTask({
        title: "Fail me",
        description: "Test",
        assignTo: "agent-1",
      });
      store.transition(task.id, "assigned");
      store.transition(task.id, "in_progress");

      runStore.upsertRun(createTestRunRecord({
        id: "run-fail",
        taskId: task.id,
        status: "failed",
        result: { exitCode: 1, stdout: "", stderr: "boom", duration: 50 },
      }));

      orchestrator.tick();

      // Task should be retried (back to pending since retries < maxRetries)
      expect(store.getTask(task.id)!.status).toBe("pending");
    });
  });

  describe("agent management", () => {
    it("addAgent adds to team", () => {
      orchestrator.addAgent(createTestAgent({ name: "new-agent", adapter: "mock" }));
      expect(orchestrator.getAgents().find(a => a.name === "new-agent")).toBeDefined();
    });

    it("addAgent throws for duplicate", () => {
      expect(() => orchestrator.addAgent(createTestAgent({ name: "agent-1", adapter: "mock" })))
        .toThrow("already exists");
    });

    it("removeAgent removes from team", () => {
      orchestrator.addAgent(createTestAgent({ name: "to-remove", adapter: "mock" }));
      expect(orchestrator.removeAgent("to-remove")).toBe(true);
      expect(orchestrator.getAgents().find(a => a.name === "to-remove")).toBeUndefined();
    });

    it("removeAgent returns false for nonexistent", () => {
      expect(orchestrator.removeAgent("nope")).toBe(false);
    });
  });

  describe("volatile agents", () => {
    it("addVolatileAgent marks agent as volatile", () => {
      orchestrator.addVolatileAgent(createTestAgent({ name: "vol-1", adapter: "mock" }), "plan-1");
      const agent = orchestrator.getAgents().find(a => a.name === "vol-1");
      expect(agent?.volatile).toBe(true);
      expect(agent?.planGroup).toBe("plan-1");
    });

    it("cleanupVolatileAgents removes agents for group", () => {
      orchestrator.addVolatileAgent(createTestAgent({ name: "vol-1", adapter: "mock" }), "plan-1");
      orchestrator.addVolatileAgent(createTestAgent({ name: "vol-2", adapter: "mock" }), "plan-1");
      const removed = orchestrator.cleanupVolatileAgents("plan-1");
      expect(removed).toBe(2);
      expect(orchestrator.getAgents().find(a => a.name === "vol-1")).toBeUndefined();
    });
  });

  describe("killTask", () => {
    it("marks task as failed", () => {
      const task = orchestrator.addTask({
        title: "Kill me",
        description: "Test",
        assignTo: "agent-1",
      });
      orchestrator.killTask(task.id);
      expect(store.getTask(task.id)!.status).toBe("failed");
    });
  });

  describe("retryTask", () => {
    it("transitions failed task to pending", () => {
      const task = orchestrator.addTask({
        title: "Retry me",
        description: "Test",
        assignTo: "agent-1",
      });
      store.transition(task.id, "assigned");
      store.transition(task.id, "in_progress");
      store.transition(task.id, "failed");

      orchestrator.retryTask(task.id);
      expect(store.getTask(task.id)!.status).toBe("pending");
    });

    it("throws for non-failed task", () => {
      const task = orchestrator.addTask({
        title: "Not failed",
        description: "Test",
        assignTo: "agent-1",
      });
      expect(() => orchestrator.retryTask(task.id)).toThrow('Cannot retry task in "pending" state');
    });
  });

  describe("gracefulStop", () => {
    it("emits orchestrator:shutdown", async () => {
      const events: any[] = [];
      orchestrator.on("orchestrator:shutdown", (e) => events.push(e));
      await orchestrator.gracefulStop(100);
      expect(events).toHaveLength(1);
    });
  });

  describe("recoverOrphanedTasks", () => {
    it("resets stuck tasks to pending", () => {
      const task = store.addTask({
        title: "Stuck",
        description: "Was in_progress",
        assignTo: "agent-1",
        dependsOn: [],
        expectations: [],
        metrics: [],
        maxRetries: 2,
      });
      store.transition(task.id, "assigned");
      store.transition(task.id, "in_progress");

      const recovered = orchestrator.recoverOrphanedTasks();
      expect(recovered).toBe(1);
      expect(store.getTask(task.id)!.status).toBe("pending");
    });

    it("requeues orphaned in_progress tasks to pending (shutdown is not a real failure)", () => {
      const task = store.addTask({
        title: "Exhausted",
        description: "No retries left",
        assignTo: "agent-1",
        dependsOn: [],
        expectations: [],
        metrics: [],
        maxRetries: 0,
      });
      store.transition(task.id, "assigned");
      store.transition(task.id, "in_progress");

      orchestrator.recoverOrphanedTasks();
      // Recovery doesn't burn retries — task goes back to pending
      expect(store.getTask(task.id)!.status).toBe("pending");
      expect(store.getTask(task.id)!.retries).toBe(0);
    });
  });

  describe("syncProcessesFromRunStore", () => {
    it("syncs active runs to processes state", () => {
      const task = orchestrator.addTask({
        title: "Running",
        description: "Test",
        assignTo: "agent-1",
      });
      store.transition(task.id, "assigned");
      store.transition(task.id, "in_progress");

      runStore.upsertRun(createTestRunRecord({
        id: "run-sync",
        taskId: task.id,
        pid: 42,
        agentName: "agent-1",
        status: "running",
      }));

      orchestrator.tick();

      const state = store.getState();
      expect(state.processes).toHaveLength(1);
      expect(state.processes[0].pid).toBe(42);
      expect(state.processes[0].agentName).toBe("agent-1");
      expect(state.processes[0].alive).toBe(true);
    });
  });

  describe("getRunStore", () => {
    it("returns the injected run store", () => {
      expect(orchestrator.getRunStore()).toBe(runStore);
    });
  });

  describe("project memory", () => {
    it("hasMemory returns false when no memory saved", () => {
      expect(orchestrator.hasMemory()).toBe(false);
    });

    it("getMemory returns empty string when no memory", () => {
      expect(orchestrator.getMemory()).toBe("");
    });

    it("saveMemory + getMemory round-trips", () => {
      orchestrator.saveMemory("# Architecture\nTypeScript project");
      expect(orchestrator.hasMemory()).toBe(true);
      expect(orchestrator.getMemory()).toBe("# Architecture\nTypeScript project");
    });

    it("appendMemory adds timestamped entry", () => {
      orchestrator.saveMemory("# Memory");
      orchestrator.appendMemory("New insight");
      const content = orchestrator.getMemory();
      expect(content).toContain("# Memory");
      expect(content).toContain("New insight");
    });
  });
});

describe("buildRetryPrompt", () => {
  it("includes original description and error info", () => {
    const task = createTestTask({ description: "Implement feature X" });
    const result: TaskResult = {
      exitCode: 1,
      stdout: "",
      stderr: "Error: module not found",
      duration: 1000,
    };

    const prompt = buildRetryPrompt(task, result);
    expect(prompt).toContain("Implement feature X");
    expect(prompt).toContain("PREVIOUS ATTEMPT FAILED");
    expect(prompt).toContain("Exit code: 1");
    expect(prompt).toContain("module not found");
    expect(prompt).toContain("Please fix the issues");
  });

  it("includes dimension scores when available", () => {
    const task = createTestTask();
    const result: TaskResult = {
      exitCode: 0,
      stdout: "",
      stderr: "",
      duration: 1000,
      assessment: {
        passed: false,
        checks: [],
        metrics: [],
        scores: [
          { dimension: "correctness", score: 2, reasoning: "Has bugs", weight: 0.5 },
          { dimension: "completeness", score: 4, reasoning: "Good", weight: 0.5 },
        ],
        globalScore: 3.0,
        timestamp: new Date().toISOString(),
      },
    };

    const prompt = buildRetryPrompt(task, result);
    expect(prompt).toContain("EVALUATION SCORES");
    expect(prompt).toContain("correctness: 2/5");
    expect(prompt).toContain("Has bugs");
    expect(prompt).toContain("Focus on improving the lowest-scoring dimensions");
  });
});

describe("analyzeBlockedTasks", () => {
  it("classifies missing deps as unresolvable", () => {
    const task = createTestTask({
      id: "t1",
      title: "Blocked",
      dependsOn: ["nonexistent"],
      status: "pending",
    });
    const result = analyzeBlockedTasks([task], [task]);
    expect(result.resolvable).toHaveLength(0);
    expect(result.unresolvable).toHaveLength(1);
    expect(result.unresolvable[0].missingDeps).toContain("nonexistent");
  });

  it("classifies failed deps as resolvable", () => {
    const depA = createTestTask({ id: "a", title: "Dep A", status: "failed" });
    const taskB = createTestTask({
      id: "b",
      title: "Blocked by A",
      dependsOn: ["a"],
      status: "pending",
    });
    const result = analyzeBlockedTasks([taskB], [depA, taskB]);
    expect(result.resolvable).toHaveLength(1);
    expect(result.unresolvable).toHaveLength(0);
    expect(result.resolvable[0].failedDeps[0].id).toBe("a");
  });

  it("follows cascade chains to root failure", () => {
    const depA = createTestTask({ id: "a", title: "Root fail", status: "failed" });
    const depB = createTestTask({ id: "b", title: "Cascade blocked", dependsOn: ["a"], status: "pending" });
    const taskC = createTestTask({ id: "c", title: "Blocked by B", dependsOn: ["b"], status: "pending" });
    const allTasks = [depA, depB, taskC];
    const pending = [depB, taskC];

    const result = analyzeBlockedTasks(pending, allTasks);
    // Both depB and taskC should be resolvable (root cause is depA which is failed)
    expect(result.resolvable).toHaveLength(2);
    expect(result.unresolvable).toHaveLength(0);
  });

  it("skips tasks with all deps done", () => {
    const depA = createTestTask({ id: "a", title: "Done dep", status: "done" });
    const taskB = createTestTask({
      id: "b",
      title: "Ready",
      dependsOn: ["a"],
      status: "pending",
    });
    const result = analyzeBlockedTasks([taskB], [depA, taskB]);
    // All deps are done → not blocked, shouldn't appear in either list
    expect(result.resolvable).toHaveLength(0);
    expect(result.unresolvable).toHaveLength(0);
  });
});
