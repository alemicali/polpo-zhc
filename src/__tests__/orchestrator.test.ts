import { describe, it, expect, beforeEach } from "vitest";
import { Orchestrator, buildRetryPrompt } from "../orchestrator.js";
import { registerAdapter } from "../adapters/registry.js";
import { InMemoryTaskStore, MockAdapter, createTestTask, createTestAgent } from "./fixtures.js";
import type { TaskResult } from "../core/types.js";

describe("Orchestrator", () => {
  let store: InMemoryTaskStore;
  let mockAdapter: MockAdapter;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    store = new InMemoryTaskStore();
    mockAdapter = new MockAdapter();
    registerAdapter("mock", () => mockAdapter);

    orchestrator = new Orchestrator({
      workDir: "/tmp/orchestra-test",
      store,
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
    it("spawns agent for ready task", () => {
      orchestrator.addTask({
        title: "Ready task",
        description: "Should be spawned",
        assignTo: "agent-1",
      });

      orchestrator.tick();

      expect(mockAdapter.spawnCalls).toHaveLength(1);
      expect(mockAdapter.spawnCalls[0].agent.name).toBe("agent-1");
    });

    it("skips tasks with unresolved dependencies", () => {
      const taskA = orchestrator.addTask({
        title: "Task A",
        description: "First",
        assignTo: "agent-1",
      });

      orchestrator.addTask({
        title: "Task B",
        description: "Depends on A",
        assignTo: "agent-1",
        dependsOn: [taskA.id],
      });

      orchestrator.tick();

      // Only task A should be spawned
      expect(mockAdapter.spawnCalls).toHaveLength(1);
    });

    it("detects deadlock", () => {
      const events: any[] = [];
      orchestrator.on("orchestrator:deadlock", (e) => events.push(e));

      // Create tasks that depend on each other (artificially)
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

    it("returns true when all tasks are terminal", () => {
      // No tasks = done in non-interactive
      // But orchestrator is interactive, so empty returns false
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

    it("marks exhausted tasks as failed", () => {
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
      expect(store.getTask(task.id)!.status).toBe("failed");
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
