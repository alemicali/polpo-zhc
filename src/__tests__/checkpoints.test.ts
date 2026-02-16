import { describe, it, expect, beforeEach, vi } from "vitest";
import { PlanExecutor } from "../core/plan-executor.js";
import { TaskManager } from "../core/task-manager.js";
import { AgentManager } from "../core/agent-manager.js";
import { HookRegistry } from "../core/hooks.js";
import { TypedEmitter } from "../core/events.js";
import { InMemoryTaskStore, InMemoryRunStore, createTestTask } from "./fixtures.js";
import type { OrchestratorContext } from "../core/orchestrator-context.js";
import type { PolpoConfig, Task, Plan, PlanCheckpoint } from "../core/types.js";

// ── Helpers ──────────────────────────────────────────

function createMinimalConfig(): PolpoConfig {
  return {
    version: "1",
    project: "test",
    team: { name: "test-team", agents: [{ name: "test-agent" }] },
    tasks: [],
    settings: { maxRetries: 2, workDir: "/tmp/test", logLevel: "quiet" },
  };
}

function createMockCtx(overrides: Partial<OrchestratorContext> = {}): OrchestratorContext {
  const store = new InMemoryTaskStore();
  const plans = new Map<string, Plan>();
  let planCounter = 0;

  // Extend the InMemoryTaskStore with plan methods by assigning onto the instance
  const registry = Object.assign(store, {
    savePlan: (opts: { name: string; data: string; prompt?: string; status?: string; notifications?: unknown }) => {
      const id = `plan-${++planCounter}`;
      const plan: Plan = {
        id,
        name: opts.name,
        data: opts.data,
        prompt: opts.prompt,
        status: (opts.status as Plan["status"]) ?? "draft",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      plans.set(id, plan);
      return plan;
    },
    getPlan: (id: string) => plans.get(id),
    getPlanByName: (name: string) => [...plans.values()].find(p => p.name === name),
    getAllPlans: () => [...plans.values()],
    updatePlan: (id: string, updates: Partial<Plan>) => {
      const plan = plans.get(id);
      if (!plan) throw new Error(`Plan not found: ${id}`);
      Object.assign(plan, updates, { updatedAt: new Date().toISOString() });
      return plan;
    },
    deletePlan: (id: string) => plans.delete(id),
    nextPlanName: () => `plan-${planCounter + 1}`,
  });

  return {
    emitter: new TypedEmitter(),
    registry,
    runStore: new InMemoryRunStore(),
    memoryStore: { exists: () => false, get: () => "", save: () => {}, append: () => {} },
    logStore: { startSession: () => "s", getSessionId: () => "s", append: () => {}, getSessionEntries: () => [], listSessions: () => [], prune: () => 0, close: () => {} },
    sessionStore: { create: () => "s1", addMessage: () => ({ id: "m1", role: "user" as const, content: "", ts: "" }), getMessages: () => [], getRecentMessages: () => [], listSessions: () => [], getSession: () => undefined, getLatestSession: () => undefined, deleteSession: () => false, prune: () => 0, close: () => {} },
    hooks: new HookRegistry(),
    config: createMinimalConfig(),
    workDir: "/tmp/test",
    polpoDir: "/tmp/test/.polpo",
    assessFn: vi.fn(),
    ...overrides,
  } as OrchestratorContext;
}

function createDoneTask(title: string, overrides: Partial<Task> = {}): Task {
  return createTestTask({
    title,
    status: "done",
    result: { exitCode: 0, stdout: "", stderr: "", duration: 100 },
    ...overrides,
  });
}

function createPendingTask(title: string, overrides: Partial<Task> = {}): Task {
  return createTestTask({ title, status: "pending", ...overrides });
}

// ── Tests ────────────────────────────────────────────

describe("Checkpoints", () => {
  let ctx: OrchestratorContext;
  let planExec: PlanExecutor;
  let taskMgr: TaskManager;
  let agentMgr: AgentManager;

  beforeEach(() => {
    ctx = createMockCtx();
    taskMgr = new TaskManager(ctx);
    agentMgr = new AgentManager(ctx);
    planExec = new PlanExecutor(ctx, taskMgr, agentMgr);
  });

  describe("getCheckpoints", () => {
    it("returns empty array when no checkpoints defined", () => {
      expect(planExec.getCheckpoints("my-plan")).toEqual([]);
    });

    it("returns checkpoints after plan execution", () => {
      const planData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });

      const plan = planExec.savePlan({ data: planData, name: "my-plan" });
      planExec.executePlan(plan.id);

      const checkpoints = planExec.getCheckpoints("my-plan");
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].name).toBe("review-a");
    });
  });

  describe("getBlockingCheckpoint", () => {
    it("returns undefined when no checkpoints defined", () => {
      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      const result = planExec.getBlockingCheckpoint("my-plan", "Task B", "id-b", tasks);
      expect(result).toBeUndefined();
    });

    it("does not block when afterTasks are not yet complete", () => {
      const planData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const plan = planExec.savePlan({ data: planData, name: "my-plan" });
      planExec.executePlan(plan.id);

      // Task A is still pending — checkpoint not reached
      const tasks = [createPendingTask("Task A"), createPendingTask("Task B")];
      const result = planExec.getBlockingCheckpoint("my-plan", "Task B", "id-b", tasks);
      expect(result).toBeUndefined();
    });

    it("blocks when afterTasks are done and checkpoint not resumed", () => {
      const planData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const plan = planExec.savePlan({ data: planData, name: "my-plan" });
      planExec.executePlan(plan.id);

      // Task A is done — checkpoint triggers
      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      const result = planExec.getBlockingCheckpoint("my-plan", "Task B", "id-b", tasks);
      expect(result).toBeDefined();
      expect(result!.checkpoint.name).toBe("review-a");
      expect(result!.reachedAt).toBeTruthy();
    });

    it("does not block tasks not listed in blocksTasks", () => {
      const planData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
          { title: "Task C", description: "Do C" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const plan = planExec.savePlan({ data: planData, name: "my-plan" });
      planExec.executePlan(plan.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B"), createPendingTask("Task C")];
      // Task C is NOT in blocksTasks — should not be blocked
      const result = planExec.getBlockingCheckpoint("my-plan", "Task C", "id-c", tasks);
      expect(result).toBeUndefined();
    });

    it("emits checkpoint:reached event when first activated", () => {
      const events: unknown[] = [];
      ctx.emitter.on("checkpoint:reached", (data) => events.push(data));

      const planData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"], message: "Review Task A output" },
        ],
      });
      const plan = planExec.savePlan({ data: planData, name: "my-plan" });
      planExec.executePlan(plan.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      planExec.getBlockingCheckpoint("my-plan", "Task B", "id-b", tasks);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        group: "my-plan",
        checkpointName: "review-a",
        message: "Review Task A output",
      });
    });

    it("does not emit duplicate events on repeated checks", () => {
      const events: unknown[] = [];
      ctx.emitter.on("checkpoint:reached", (data) => events.push(data));

      const planData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const plan = planExec.savePlan({ data: planData, name: "my-plan" });
      planExec.executePlan(plan.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];

      // Call multiple times
      planExec.getBlockingCheckpoint("my-plan", "Task B", "id-b", tasks);
      planExec.getBlockingCheckpoint("my-plan", "Task B", "id-b", tasks);
      planExec.getBlockingCheckpoint("my-plan", "Task B", "id-b", tasks);

      // Event only emitted once
      expect(events).toHaveLength(1);
    });

    it("pauses the plan when checkpoint is reached", () => {
      const planData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const plan = planExec.savePlan({ data: planData, name: "my-plan" });
      planExec.executePlan(plan.id);

      // Plan should be active
      expect(planExec.getPlan(plan.id)!.status).toBe("active");

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      planExec.getBlockingCheckpoint("my-plan", "Task B", "id-b", tasks);

      // Plan should now be paused
      expect(planExec.getPlan(plan.id)!.status).toBe("paused");
    });
  });

  describe("resumeCheckpoint", () => {
    it("returns false for non-existent checkpoint", () => {
      expect(planExec.resumeCheckpoint("my-plan", "nonexistent")).toBe(false);
    });

    it("resumes an active checkpoint and unblocks tasks", () => {
      const planData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const plan = planExec.savePlan({ data: planData, name: "my-plan" });
      planExec.executePlan(plan.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];

      // Activate checkpoint
      const blocking = planExec.getBlockingCheckpoint("my-plan", "Task B", "id-b", tasks);
      expect(blocking).toBeDefined();

      // Resume
      const resumed = planExec.resumeCheckpoint("my-plan", "review-a");
      expect(resumed).toBe(true);

      // Task B should no longer be blocked
      const blocking2 = planExec.getBlockingCheckpoint("my-plan", "Task B", "id-b", tasks);
      expect(blocking2).toBeUndefined();
    });

    it("sets plan status back to active after resume", () => {
      const planData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const plan = planExec.savePlan({ data: planData, name: "my-plan" });
      planExec.executePlan(plan.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      planExec.getBlockingCheckpoint("my-plan", "Task B", "id-b", tasks);
      expect(planExec.getPlan(plan.id)!.status).toBe("paused");

      planExec.resumeCheckpoint("my-plan", "review-a");
      expect(planExec.getPlan(plan.id)!.status).toBe("active");
    });

    it("emits checkpoint:resumed event", () => {
      const events: unknown[] = [];
      ctx.emitter.on("checkpoint:resumed", (data) => events.push(data));

      const planData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const plan = planExec.savePlan({ data: planData, name: "my-plan" });
      planExec.executePlan(plan.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      planExec.getBlockingCheckpoint("my-plan", "Task B", "id-b", tasks);
      planExec.resumeCheckpoint("my-plan", "review-a");

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        group: "my-plan",
        checkpointName: "review-a",
      });
    });

    it("does not re-trigger after resume", () => {
      const reachedEvents: unknown[] = [];
      ctx.emitter.on("checkpoint:reached", (data) => reachedEvents.push(data));

      const planData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const plan = planExec.savePlan({ data: planData, name: "my-plan" });
      planExec.executePlan(plan.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      planExec.getBlockingCheckpoint("my-plan", "Task B", "id-b", tasks);
      planExec.resumeCheckpoint("my-plan", "review-a");

      // Check again after resume — should not re-trigger
      const blocking = planExec.getBlockingCheckpoint("my-plan", "Task B", "id-b", tasks);
      expect(blocking).toBeUndefined();
      expect(reachedEvents).toHaveLength(1); // Only the first trigger
    });
  });

  describe("getActiveCheckpoints", () => {
    it("returns empty array when no checkpoints active", () => {
      expect(planExec.getActiveCheckpoints()).toEqual([]);
    });

    it("returns active checkpoints", () => {
      const planData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const plan = planExec.savePlan({ data: planData, name: "my-plan" });
      planExec.executePlan(plan.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      planExec.getBlockingCheckpoint("my-plan", "Task B", "id-b", tasks);

      const active = planExec.getActiveCheckpoints();
      expect(active).toHaveLength(1);
      expect(active[0].group).toBe("my-plan");
      expect(active[0].checkpointName).toBe("review-a");
    });

    it("removes checkpoint from active list after resume", () => {
      const planData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const plan = planExec.savePlan({ data: planData, name: "my-plan" });
      planExec.executePlan(plan.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      planExec.getBlockingCheckpoint("my-plan", "Task B", "id-b", tasks);
      expect(planExec.getActiveCheckpoints()).toHaveLength(1);

      planExec.resumeCheckpoint("my-plan", "review-a");
      expect(planExec.getActiveCheckpoints()).toHaveLength(0);
    });
  });

  describe("multiple checkpoints", () => {
    it("handles sequential checkpoints in a plan", () => {
      const planData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
          { title: "Task C", description: "Do C" },
        ],
        checkpoints: [
          { name: "cp-1", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
          { name: "cp-2", afterTasks: ["Task B"], blocksTasks: ["Task C"] },
        ],
      });
      const plan = planExec.savePlan({ data: planData, name: "my-plan" });
      planExec.executePlan(plan.id);

      // Checkpoint 1: Task A done, blocks Task B
      const tasks1 = [createDoneTask("Task A"), createPendingTask("Task B"), createPendingTask("Task C")];
      const blocking1 = planExec.getBlockingCheckpoint("my-plan", "Task B", "id-b", tasks1);
      expect(blocking1).toBeDefined();
      expect(blocking1!.checkpoint.name).toBe("cp-1");

      // Task C not blocked by cp-1
      const blockingC1 = planExec.getBlockingCheckpoint("my-plan", "Task C", "id-c", tasks1);
      expect(blockingC1).toBeUndefined();

      // Resume cp-1
      planExec.resumeCheckpoint("my-plan", "cp-1");
      const blocking1After = planExec.getBlockingCheckpoint("my-plan", "Task B", "id-b", tasks1);
      expect(blocking1After).toBeUndefined();

      // Checkpoint 2: Task B done, blocks Task C
      const tasks2 = [createDoneTask("Task A"), createDoneTask("Task B"), createPendingTask("Task C")];
      const blocking2 = planExec.getBlockingCheckpoint("my-plan", "Task C", "id-c", tasks2);
      expect(blocking2).toBeDefined();
      expect(blocking2!.checkpoint.name).toBe("cp-2");

      // Resume cp-2
      planExec.resumeCheckpoint("my-plan", "cp-2");
      const blocking2After = planExec.getBlockingCheckpoint("my-plan", "Task C", "id-c", tasks2);
      expect(blocking2After).toBeUndefined();
    });
  });

  describe("notification rules", () => {
    it("registers notification rules for checkpoint notifyChannels", () => {
      const addedRules: Array<{ id: string; events: string[] }> = [];
      const mockRouter = {
        addRule: (rule: { id: string; events: string[] }) => { addedRules.push(rule); },
      };
      planExec.setNotificationRouter(mockRouter as any);

      const planData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"], notifyChannels: ["slack-alerts"] },
        ],
      });
      const plan = planExec.savePlan({ data: planData, name: "my-plan" });
      planExec.executePlan(plan.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      planExec.getBlockingCheckpoint("my-plan", "Task B", "id-b", tasks);

      // Should have registered 2 rules: reached + resumed
      expect(addedRules).toHaveLength(2);
      expect(addedRules[0].events).toContain("checkpoint:reached");
      expect(addedRules[1].events).toContain("checkpoint:resumed");
    });

    it("does not register rules when no notifyChannels", () => {
      const addedRules: unknown[] = [];
      const mockRouter = {
        addRule: (rule: unknown) => { addedRules.push(rule); },
      };
      planExec.setNotificationRouter(mockRouter as any);

      const planData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const plan = planExec.savePlan({ data: planData, name: "my-plan" });
      planExec.executePlan(plan.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      planExec.getBlockingCheckpoint("my-plan", "Task B", "id-b", tasks);

      expect(addedRules).toHaveLength(0);
    });
  });
});
