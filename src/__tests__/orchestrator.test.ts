import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { Orchestrator, buildRetryPrompt } from "../core/orchestrator.js";
import { analyzeBlockedTasks } from "../core/deadlock-resolver.js";
import { InMemoryTaskStore, InMemoryRunStore, createTestTask, createTestAgent, createTestActivity } from "./fixtures.js";
import type { TaskResult } from "../core/types.js";
import type { RunRecord } from "../core/run-store.js";

const TEST_WORK_DIR = "/tmp/polpo-test";

function createTestRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  const now = new Date().toISOString();
  return {
    id: "run-1",
    taskId: "task-1",
    pid: 0,
    agentName: "agent-1",
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
  let orchestrator: Orchestrator;

  afterEach(() => {
    const polpoDir = `${TEST_WORK_DIR}/.polpo`;
    if (existsSync(polpoDir)) rmSync(polpoDir, { recursive: true });
  });

  beforeEach(async () => {
    store = new InMemoryTaskStore();
    runStore = new InMemoryRunStore();

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
      agents: [createTestAgent({ name: "agent-1" })],
    };
    await orchestrator.initInteractive("test-project", team);
  });

  describe("addTask", () => {
    it("creates a task and emits task:created", async () => {
      const events: any[] = [];
      orchestrator.on("task:created", (e) => events.push(e));

      const task = await orchestrator.addTask({
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
    it("returns true when all tasks are terminal", async () => {
      const task = await orchestrator.addTask({
        title: "Test",
        description: "Done",
        assignTo: "agent-1",
      });
      // Manually set to done
      await store.transition(task.id, "assigned");
      await store.transition(task.id, "in_progress");
      await store.transition(task.id, "review");
      await store.transition(task.id, "done");

      expect(await orchestrator.tick()).toBe(true);
    });

    it("detects deadlock with missing deps (unresolvable)", async () => {
      const events: any[] = [];
      orchestrator.on("orchestrator:deadlock", (e) => events.push(e));

      const taskA = await orchestrator.addTask({
        title: "Task A",
        description: "Depends on B",
        assignTo: "agent-1",
        dependsOn: ["nonexistent-id"],
      });

      await orchestrator.tick();

      expect(events).toHaveLength(1);
      expect(events[0].taskIds).toContain(taskA.id);
    });

    it("attempts resolution when dep is failed (resolvable)", async () => {
      const detected: any[] = [];
      orchestrator.on("deadlock:detected", (e) => detected.push(e));

      // Create Task A (no deps) and force it to failed
      const taskA = await orchestrator.addTask({
        title: "Task A",
        description: "Do something",
        assignTo: "agent-1",
      });
      await store.transition(taskA.id, "assigned");
      await store.transition(taskA.id, "in_progress");
      await store.transition(taskA.id, "failed");

      // Create Task B that depends on (now-failed) Task A
      await orchestrator.addTask({
        title: "Task B",
        description: "Depends on A",
        assignTo: "agent-1",
        dependsOn: [taskA.id],
      });

      // tick should NOT force-fail B immediately — it should detect resolvable deadlock
      const done = await orchestrator.tick();

      expect(done).toBe(false); // loop continues (async resolution pending)
      expect(detected).toHaveLength(1);
      expect(detected[0].resolvableCount).toBe(1);
    });

    it("emits orchestrator:tick with counts", async () => {
      const events: any[] = [];
      orchestrator.on("orchestrator:tick", (e) => events.push(e));

      await orchestrator.addTask({
        title: "Test",
        description: "Task",
        assignTo: "agent-1",
      });

      await orchestrator.tick();

      expect(events.length).toBeGreaterThan(0);
      const lastTick = events[events.length - 1];
      expect(lastTick).toHaveProperty("pending");
      expect(lastTick).toHaveProperty("running");
      expect(lastTick).toHaveProperty("done");
      expect(lastTick).toHaveProperty("failed");
    });
  });

  describe("collectResults via RunStore", () => {
    it("processes terminal runs and transitions tasks", async () => {
      const task = await orchestrator.addTask({
        title: "Collect me",
        description: "Test",
        assignTo: "agent-1",
      });
      await store.transition(task.id, "assigned");
      await store.transition(task.id, "in_progress");

      const result: TaskResult = {
        exitCode: 0,
        stdout: "done",
        stderr: "",
        duration: 100,
      };

      // Pre-populate RunStore with a completed run
      await runStore.upsertRun(createTestRunRecord({
        id: "run-collect",
        taskId: task.id,
        status: "completed",
        result,
      }));

      await orchestrator.tick();
      // transitionToDone is async (runs hooks) — wait for microtasks to settle
      await new Promise(r => setTimeout(r, 50));

      // Run should be consumed (deleted)
      expect(await runStore.getRun("run-collect")).toBeUndefined();
      // Task should be done
      expect((await store.getTask(task.id))!.status).toBe("done");
    });

    it("handles failed runs", async () => {
      const task = await orchestrator.addTask({
        title: "Fail me",
        description: "Test",
        assignTo: "agent-1",
      });
      await store.transition(task.id, "assigned");
      await store.transition(task.id, "in_progress");

      await runStore.upsertRun(createTestRunRecord({
        id: "run-fail",
        taskId: task.id,
        status: "failed",
        result: { exitCode: 1, stdout: "", stderr: "boom", duration: 50 },
      }));

      await orchestrator.tick();

      // Task should be retried (back to pending since retries < maxRetries)
      expect((await store.getTask(task.id))!.status).toBe("pending");
    });
  });

  describe("agent management", () => {
    it("addAgent adds to team", async () => {
      await orchestrator.addAgent(createTestAgent({ name: "new-agent" }));
      expect((await orchestrator.getAgents()).find(a => a.name === "new-agent")).toBeDefined();
    });

    it("addAgent throws for duplicate", async () => {
      await expect(orchestrator.addAgent(createTestAgent({ name: "agent-1" })))
        .rejects.toThrow("already exists");
    });

    it("removeAgent removes from team", async () => {
      await orchestrator.addAgent(createTestAgent({ name: "to-remove" }));
      expect(await orchestrator.removeAgent("to-remove")).toBe(true);
      expect((await orchestrator.getAgents()).find(a => a.name === "to-remove")).toBeUndefined();
    });

    it("removeAgent returns false for nonexistent", async () => {
      expect(await orchestrator.removeAgent("nope")).toBe(false);
    });
  });

  describe("volatile agents", () => {
    it("addVolatileAgent marks agent as volatile", async () => {
      await orchestrator.addVolatileAgent(createTestAgent({ name: "vol-1" }), "mission-1");
      const agent = (await orchestrator.getAgents()).find(a => a.name === "vol-1");
      expect(agent?.volatile).toBe(true);
      expect(agent?.missionGroup).toBe("mission-1");
    });

    it("cleanupVolatileAgents removes agents for group", async () => {
      await orchestrator.addVolatileAgent(createTestAgent({ name: "vol-1" }), "mission-1");
      await orchestrator.addVolatileAgent(createTestAgent({ name: "vol-2" }), "mission-1");
      const removed = await orchestrator.cleanupVolatileAgents("mission-1");
      expect(removed).toBe(2);
      expect((await orchestrator.getAgents()).find(a => a.name === "vol-1")).toBeUndefined();
    });
  });

  describe("killTask", () => {
    it("marks task as failed", async () => {
      const task = await orchestrator.addTask({
        title: "Kill me",
        description: "Test",
        assignTo: "agent-1",
      });
      await orchestrator.killTask(task.id);
      expect((await store.getTask(task.id))!.status).toBe("failed");
    });
  });

  describe("retryTask", () => {
    it("transitions failed task to pending", async () => {
      const task = await orchestrator.addTask({
        title: "Retry me",
        description: "Test",
        assignTo: "agent-1",
      });
      await store.transition(task.id, "assigned");
      await store.transition(task.id, "in_progress");
      await store.transition(task.id, "failed");

      await orchestrator.retryTask(task.id);
      expect((await store.getTask(task.id))!.status).toBe("pending");
    });

    it("throws for non-failed task", async () => {
      const task = await orchestrator.addTask({
        title: "Not failed",
        description: "Test",
        assignTo: "agent-1",
      });
      await expect(orchestrator.retryTask(task.id)).rejects.toThrow('Cannot retry task in "pending" state');
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
    it("resets stuck tasks to pending", async () => {
      const task = await store.addTask({
        title: "Stuck",
        description: "Was in_progress",
        assignTo: "agent-1",
        dependsOn: [],
        expectations: [],
        metrics: [],
        maxRetries: 2,
      });
      await store.transition(task.id, "assigned");
      await store.transition(task.id, "in_progress");

      const recovered = await orchestrator.recoverOrphanedTasks();
      expect(recovered).toBe(1);
      expect((await store.getTask(task.id))!.status).toBe("pending");
    });

    it("requeues orphaned in_progress tasks to pending (shutdown is not a real failure)", async () => {
      const task = await store.addTask({
        title: "Exhausted",
        description: "No retries left",
        assignTo: "agent-1",
        dependsOn: [],
        expectations: [],
        metrics: [],
        maxRetries: 0,
      });
      await store.transition(task.id, "assigned");
      await store.transition(task.id, "in_progress");

      await orchestrator.recoverOrphanedTasks();
      // Recovery doesn't burn retries — task goes back to pending
      expect((await store.getTask(task.id))!.status).toBe("pending");
      expect((await store.getTask(task.id))!.retries).toBe(0);
    });
  });

  describe("syncProcessesFromRunStore", () => {
    it("syncs active runs to processes state", async () => {
      const task = await orchestrator.addTask({
        title: "Running",
        description: "Test",
        assignTo: "agent-1",
      });
      await store.transition(task.id, "assigned");
      await store.transition(task.id, "in_progress");

      await runStore.upsertRun(createTestRunRecord({
        id: "run-sync",
        taskId: task.id,
        pid: 42,
        agentName: "agent-1",
        status: "running",
      }));

      await orchestrator.tick();

      const state = await store.getState();
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

  describe("shared memory", () => {
    it("hasMemory returns false when no memory saved", async () => {
      expect(await orchestrator.hasMemory()).toBe(false);
    });

    it("getMemory returns empty string when no memory", async () => {
      expect(await orchestrator.getMemory()).toBe("");
    });

    it("saveMemory + getMemory round-trips", async () => {
      await orchestrator.saveMemory("# Architecture\nTypeScript project");
      expect(await orchestrator.hasMemory()).toBe(true);
      expect(await orchestrator.getMemory()).toBe("# Architecture\nTypeScript project");
    });

    it("appendMemory adds timestamped entry", async () => {
      await orchestrator.saveMemory("# Memory");
      await orchestrator.appendMemory("New insight");
      const content = await orchestrator.getMemory();
      expect(content).toContain("# Memory");
      expect(content).toContain("New insight");
    });
  });

  describe("agent memory", () => {
    it("hasAgentMemory returns false for unknown agent", async () => {
      expect(await orchestrator.hasAgentMemory("alice")).toBe(false);
    });

    it("getAgentMemory returns empty string for unknown agent", async () => {
      expect(await orchestrator.getAgentMemory("alice")).toBe("");
    });

    it("saveAgentMemory + getAgentMemory round-trips", async () => {
      await orchestrator.saveAgentMemory("alice", "Alice prefers functional style");
      expect(await orchestrator.hasAgentMemory("alice")).toBe(true);
      expect(await orchestrator.getAgentMemory("alice")).toBe("Alice prefers functional style");
    });

    it("agent memory is isolated from shared memory", async () => {
      await orchestrator.saveMemory("shared context");
      await orchestrator.saveAgentMemory("alice", "agent context");
      expect(await orchestrator.getMemory()).toBe("shared context");
      expect(await orchestrator.getAgentMemory("alice")).toBe("agent context");
    });

    it("different agents have separate memories", async () => {
      await orchestrator.saveAgentMemory("alice", "alice notes");
      await orchestrator.saveAgentMemory("bob", "bob notes");
      expect(await orchestrator.getAgentMemory("alice")).toBe("alice notes");
      expect(await orchestrator.getAgentMemory("bob")).toBe("bob notes");
    });

    it("appendAgentMemory appends to agent memory", async () => {
      await orchestrator.saveAgentMemory("alice", "# Notes");
      await orchestrator.appendAgentMemory("alice", "learned React patterns");
      const content = await orchestrator.getAgentMemory("alice");
      expect(content).toContain("# Notes");
      expect(content).toContain("learned React patterns");
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
