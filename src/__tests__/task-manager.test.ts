import { describe, it, expect, beforeEach } from "vitest";
import { nanoid } from "nanoid";
import { TaskManager } from "../core/task-manager.js";
import { PlanExecutor } from "../core/plan-executor.js";
import { AgentManager } from "../core/agent-manager.js";
import { TypedEmitter } from "../core/events.js";
import { InMemoryTaskStore, InMemoryRunStore, createTestAgent } from "./fixtures.js";
import type { OrchestratorContext } from "../core/orchestrator-context.js";
import { HookRegistry } from "../core/hooks.js";
import type { PolpoConfig, Plan } from "../core/types.js";
import type { TaskStore } from "../core/task-store.js";

// ── Extended InMemoryTaskStore with plan support ───────────────────────

class InMemoryTaskStoreWithPlans extends InMemoryTaskStore implements TaskStore {
  private plans = new Map<string, Plan>();

  savePlan(plan: Omit<Plan, "id" | "createdAt" | "updatedAt">): Plan {
    const existing = [...this.plans.values()].find(p => p.name === plan.name);
    if (existing) throw new Error(`Plan name "${plan.name}" already exists`);
    const now = new Date().toISOString();
    const newPlan: Plan = {
      ...plan,
      id: nanoid(),
      createdAt: now,
      updatedAt: now,
    };
    this.plans.set(newPlan.id, newPlan);
    return newPlan;
  }

  getPlan(planId: string): Plan | undefined {
    return this.plans.get(planId);
  }

  getPlanByName(name: string): Plan | undefined {
    return [...this.plans.values()].find(p => p.name === name);
  }

  getAllPlans(): Plan[] {
    return [...this.plans.values()];
  }

  updatePlan(planId: string, updates: Partial<Omit<Plan, "id">>): Plan {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error("Plan not found");
    Object.assign(plan, updates, { updatedAt: new Date().toISOString() });
    return plan;
  }

  deletePlan(planId: string): boolean {
    return this.plans.delete(planId);
  }

  nextPlanName(): string {
    return `plan-${this.plans.size + 1}`;
  }
}

// ── Minimal store stubs ────────────────────────────────────────────────

function createNoopMemoryStore() {
  return { exists: () => false, get: () => "", save: () => {}, append: () => {} };
}

function createNoopLogStore() {
  return {
    startSession: () => "test-session",
    getSessionId: () => "test-session",
    append: () => {},
    getSessionEntries: () => [],
    listSessions: () => [],
    prune: () => 0,
    close: () => {},
  };
}

function createNoopSessionStore() {
  return {
    create: () => "s1",
    addMessage: () => ({ id: "m1", role: "user" as const, content: "", ts: new Date().toISOString() }),
    getMessages: () => [],
    getRecentMessages: () => [],
    listSessions: () => [],
    getSession: () => undefined,
    getLatestSession: () => undefined,
    deleteSession: () => false,
    prune: () => 0,
    close: () => {},
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function createDefaultConfig(overrides?: Partial<PolpoConfig>): PolpoConfig {
  return {
    version: "1",
    project: "test-project",
    team: {
      name: "test-team",
      agents: [createTestAgent({ name: "dev", adapter: "mock" })],
    },
    tasks: [],
    settings: {
      maxRetries: 2,
      workDir: "/tmp/test",
      logLevel: "quiet",
    },
    ...overrides,
  };
}

function createContext(overrides?: {
  config?: PolpoConfig;
  registry?: TaskStore;
}): OrchestratorContext {
  const config = overrides?.config ?? createDefaultConfig();
  return {
    emitter: new TypedEmitter(),
    registry: overrides?.registry ?? new InMemoryTaskStoreWithPlans(),
    runStore: new InMemoryRunStore(),
    memoryStore: createNoopMemoryStore(),
    logStore: createNoopLogStore(),
    sessionStore: createNoopSessionStore(),
    hooks: new HookRegistry(),
    config,
    workDir: "/tmp/test",
    polpoDir: "/tmp/test/.polpo",
    assessFn: async () => ({
      passed: true,
      checks: [],
      metrics: [],
      timestamp: new Date().toISOString(),
    }),
  };
}

// ════════════════════════════════════════════════════════════════════════
// TaskManager Tests
// ════════════════════════════════════════════════════════════════════════

describe("TaskManager", () => {
  let ctx: OrchestratorContext;
  let mgr: TaskManager;

  beforeEach(() => {
    ctx = createContext();
    mgr = new TaskManager(ctx);
  });

  // ── addTask ──────────────────────────────────────────────────────────

  describe("addTask", () => {
    it("creates a task with pending status", () => {
      const task = mgr.addTask({
        title: "Implement feature",
        description: "Build the login page",
        assignTo: "dev",
      });

      expect(task).toBeDefined();
      expect(task.id).toBeTruthy();
      expect(task.title).toBe("Implement feature");
      expect(task.description).toBe("Build the login page");
      expect(task.assignTo).toBe("dev");
      expect(task.status).toBe("pending");
      expect(task.retries).toBe(0);
      expect(task.dependsOn).toEqual([]);
    });

    it("throws if registry is not initialized (null)", () => {
      const ctxNoRegistry = createContext();
      (ctxNoRegistry as any).registry = undefined;
      const mgrBad = new TaskManager(ctxNoRegistry);

      expect(() =>
        mgrBad.addTask({ title: "X", description: "Y", assignTo: "dev" }),
      ).toThrow("Orchestrator not initialized");
    });

    it("emits task:created event", () => {
      const events: any[] = [];
      ctx.emitter.on("task:created", (e) => events.push(e));

      const task = mgr.addTask({
        title: "My task",
        description: "desc",
        assignTo: "dev",
      });

      expect(events).toHaveLength(1);
      expect(events[0].task.id).toBe(task.id);
      expect(events[0].task.title).toBe("My task");
    });

    it("stores task in registry", () => {
      const task = mgr.addTask({
        title: "Stored task",
        description: "desc",
        assignTo: "dev",
      });

      const found = ctx.registry.getTask(task.id);
      expect(found).toBeDefined();
      expect(found!.title).toBe("Stored task");
    });

    it("sets maxRetries from config settings", () => {
      ctx.config.settings.maxRetries = 5;
      const task = mgr.addTask({
        title: "Retryable",
        description: "desc",
        assignTo: "dev",
      });

      expect(task.maxRetries).toBe(5);
    });

    it("assigns group and dependencies when provided", () => {
      const dep = mgr.addTask({
        title: "Dep task",
        description: "dependency",
        assignTo: "dev",
      });

      const task = mgr.addTask({
        title: "Main task",
        description: "depends on dep",
        assignTo: "dev",
        dependsOn: [dep.id],
        group: "my-plan",
      });

      expect(task.group).toBe("my-plan");
      expect(task.dependsOn).toEqual([dep.id]);
    });

    it("sanitizes invalid expectations and emits warnings", () => {
      const warnings: string[] = [];
      ctx.emitter.on("log", (e) => {
        if (e.level === "warn") warnings.push(e.message);
      });

      const task = mgr.addTask({
        title: "With expectations",
        description: "desc",
        assignTo: "dev",
        expectations: [
          { type: "test", command: "npm test" },
          { type: "file_exists" } as any, // invalid: missing paths
        ],
      });

      expect(task.expectations).toHaveLength(1);
      expect(task.expectations[0].type).toBe("test");
      expect(warnings.length).toBeGreaterThan(0);
    });
  });

  // ── retryTask ────────────────────────────────────────────────────────

  describe("retryTask", () => {
    it("transitions failed task to pending", () => {
      const task = mgr.addTask({
        title: "Failing task",
        description: "will fail",
        assignTo: "dev",
      });

      // Move to failed: pending → assigned → in_progress → failed
      ctx.registry.transition(task.id, "assigned");
      ctx.registry.transition(task.id, "in_progress");
      ctx.registry.transition(task.id, "failed");

      expect(ctx.registry.getTask(task.id)!.status).toBe("failed");

      mgr.retryTask(task.id);

      const updated = ctx.registry.getTask(task.id)!;
      expect(updated.status).toBe("pending");
      expect(updated.retries).toBe(1);
    });

    it("throws for non-failed task (pending)", () => {
      const task = mgr.addTask({
        title: "Pending task",
        description: "still pending",
        assignTo: "dev",
      });

      expect(() => mgr.retryTask(task.id)).toThrow(
        'Cannot retry task in "pending" state',
      );
    });

    it("throws for non-failed task (in_progress)", () => {
      const task = mgr.addTask({
        title: "Running task",
        description: "running",
        assignTo: "dev",
      });
      ctx.registry.transition(task.id, "assigned");
      ctx.registry.transition(task.id, "in_progress");

      expect(() => mgr.retryTask(task.id)).toThrow(
        'Cannot retry task in "in_progress" state',
      );
    });

    it("throws for non-failed task (done)", () => {
      const task = mgr.addTask({
        title: "Done task",
        description: "done",
        assignTo: "dev",
      });
      ctx.registry.transition(task.id, "assigned");
      ctx.registry.transition(task.id, "in_progress");
      ctx.registry.transition(task.id, "review");
      ctx.registry.transition(task.id, "done");

      expect(() => mgr.retryTask(task.id)).toThrow(
        'Cannot retry task in "done" state',
      );
    });

    it("throws for non-existent task", () => {
      expect(() => mgr.retryTask("nonexistent")).toThrow("Task not found");
    });
  });

  // ── forceFailTask ────────────────────────────────────────────────────

  describe("forceFailTask", () => {
    it("force-fails a pending task", () => {
      const task = mgr.addTask({
        title: "Will be force-failed",
        description: "desc",
        assignTo: "dev",
      });

      mgr.forceFailTask(task.id);

      expect(ctx.registry.getTask(task.id)!.status).toBe("failed");
    });

    it("force-fails an in_progress task", () => {
      const task = mgr.addTask({
        title: "Running",
        description: "desc",
        assignTo: "dev",
      });
      ctx.registry.transition(task.id, "assigned");
      ctx.registry.transition(task.id, "in_progress");

      mgr.forceFailTask(task.id);

      expect(ctx.registry.getTask(task.id)!.status).toBe("failed");
    });

    it("force-fails an assigned task", () => {
      const task = mgr.addTask({
        title: "Assigned",
        description: "desc",
        assignTo: "dev",
      });
      ctx.registry.transition(task.id, "assigned");

      mgr.forceFailTask(task.id);

      expect(ctx.registry.getTask(task.id)!.status).toBe("failed");
    });

    it("is a no-op for already-failed task", () => {
      const task = mgr.addTask({
        title: "Already failed",
        description: "desc",
        assignTo: "dev",
      });
      ctx.registry.transition(task.id, "assigned");
      ctx.registry.transition(task.id, "in_progress");
      ctx.registry.transition(task.id, "failed");

      // Should not throw
      mgr.forceFailTask(task.id);
      expect(ctx.registry.getTask(task.id)!.status).toBe("failed");
    });

    it("is a no-op for done task", () => {
      const task = mgr.addTask({
        title: "Done",
        description: "desc",
        assignTo: "dev",
      });
      ctx.registry.transition(task.id, "assigned");
      ctx.registry.transition(task.id, "in_progress");
      ctx.registry.transition(task.id, "review");
      ctx.registry.transition(task.id, "done");

      mgr.forceFailTask(task.id);
      expect(ctx.registry.getTask(task.id)!.status).toBe("done");
    });

    it("is a no-op for non-existent task", () => {
      // Should not throw
      mgr.forceFailTask("nonexistent-id");
    });
  });

  // ── updateTaskDescription ────────────────────────────────────────────

  describe("updateTaskDescription", () => {
    it("updates the task description", () => {
      const task = mgr.addTask({
        title: "Editable",
        description: "original",
        assignTo: "dev",
      });

      mgr.updateTaskDescription(task.id, "updated description");

      const updated = ctx.registry.getTask(task.id)!;
      expect(updated.description).toBe("updated description");
    });
  });

  // ── updateTaskAssignment ─────────────────────────────────────────────

  describe("updateTaskAssignment", () => {
    it("updates the task assignTo field", () => {
      const task = mgr.addTask({
        title: "Reassignable",
        description: "desc",
        assignTo: "dev",
      });

      mgr.updateTaskAssignment(task.id, "other-agent");

      const updated = ctx.registry.getTask(task.id)!;
      expect(updated.assignTo).toBe("other-agent");
    });
  });

  // ── updateTaskExpectations ───────────────────────────────────────────

  describe("updateTaskExpectations", () => {
    it("updates expectations on a pending task", () => {
      const task = mgr.addTask({
        title: "With expectations",
        description: "desc",
        assignTo: "dev",
      });

      mgr.updateTaskExpectations(task.id, [
        { type: "test", command: "npm test" },
      ]);

      const updated = ctx.registry.getTask(task.id)!;
      expect(updated.expectations).toHaveLength(1);
      expect(updated.expectations[0].type).toBe("test");
    });

    it("throws for in_progress task", () => {
      const task = mgr.addTask({
        title: "Running",
        description: "desc",
        assignTo: "dev",
      });
      ctx.registry.transition(task.id, "assigned");
      ctx.registry.transition(task.id, "in_progress");

      expect(() =>
        mgr.updateTaskExpectations(task.id, [{ type: "test", command: "npm test" }]),
      ).toThrow('Cannot edit expectations of task in "in_progress" state');
    });

    it("emits task:updated event", () => {
      const events: any[] = [];
      ctx.emitter.on("task:updated", (e) => events.push(e));

      const task = mgr.addTask({
        title: "Observable",
        description: "desc",
        assignTo: "dev",
      });

      mgr.updateTaskExpectations(task.id, [
        { type: "test", command: "npm test" },
      ]);

      expect(events).toHaveLength(1);
      expect(events[0].task.id).toBe(task.id);
    });

    it("throws for non-existent task", () => {
      expect(() =>
        mgr.updateTaskExpectations("nonexistent", [{ type: "test", command: "npm test" }]),
      ).toThrow("Task not found");
    });
  });

  // ── seedTasks ────────────────────────────────────────────────────────

  describe("seedTasks", () => {
    it("creates tasks from config input", () => {
      ctx.config.tasks = [
        {
          id: "c1",
          title: "Config Task 1",
          description: "First config task",
          assignTo: "dev",
          dependsOn: [],
          expectations: [],
          metrics: [],
          maxRetries: 2,
        },
        {
          id: "c2",
          title: "Config Task 2",
          description: "Second config task",
          assignTo: "dev",
          dependsOn: [],
          expectations: [],
          metrics: [],
          maxRetries: 2,
        },
      ];

      mgr.seedTasks();

      const tasks = ctx.registry.getAllTasks();
      expect(tasks).toHaveLength(2);
      expect(tasks[0].title).toBe("Config Task 1");
      expect(tasks[1].title).toBe("Config Task 2");
    });

    it("emits task:created for each seeded task", () => {
      const events: any[] = [];
      ctx.emitter.on("task:created", (e) => events.push(e));

      ctx.config.tasks = [
        {
          id: "c1",
          title: "Seeded",
          description: "desc",
          assignTo: "dev",
          dependsOn: [],
          expectations: [],
          metrics: [],
          maxRetries: 2,
        },
      ];

      mgr.seedTasks();

      expect(events).toHaveLength(1);
      expect(events[0].task.title).toBe("Seeded");
    });

    it("resolves title-based dependencies to task IDs", () => {
      ctx.config.tasks = [
        {
          id: "c1",
          title: "Setup DB",
          description: "Create the database",
          assignTo: "dev",
          dependsOn: [],
          expectations: [],
          metrics: [],
          maxRetries: 2,
        },
        {
          id: "c2",
          title: "Write API",
          description: "Implement the API layer",
          assignTo: "dev",
          dependsOn: ["Setup DB"],
          expectations: [],
          metrics: [],
          maxRetries: 2,
        },
      ];

      mgr.seedTasks();

      const tasks = ctx.registry.getAllTasks();
      const setupTask = tasks.find((t) => t.title === "Setup DB")!;
      const apiTask = tasks.find((t) => t.title === "Write API")!;

      expect(apiTask.dependsOn).toEqual([setupTask.id]);
    });

    it("does nothing when config has no tasks", () => {
      ctx.config.tasks = [];
      mgr.seedTasks();
      expect(ctx.registry.getAllTasks()).toHaveLength(0);
    });

    it("ignores unresolvable dependencies", () => {
      ctx.config.tasks = [
        {
          id: "c1",
          title: "Orphan task",
          description: "depends on nothing real",
          assignTo: "dev",
          dependsOn: ["Nonexistent Task"],
          expectations: [],
          metrics: [],
          maxRetries: 2,
        },
      ];

      mgr.seedTasks();

      const tasks = ctx.registry.getAllTasks();
      expect(tasks).toHaveLength(1);
      // Unresolvable dependency should be filtered out
      expect(tasks[0].dependsOn).toEqual([]);
    });
  });

  // ── abortGroup ───────────────────────────────────────────────────────

  describe("abortGroup", () => {
    it("kills non-terminal tasks in a group", () => {
      const t1 = mgr.addTask({
        title: "Group task 1",
        description: "pending",
        assignTo: "dev",
        group: "my-group",
      });
      const t2 = mgr.addTask({
        title: "Group task 2",
        description: "in progress",
        assignTo: "dev",
        group: "my-group",
      });
      ctx.registry.transition(t2.id, "assigned");
      ctx.registry.transition(t2.id, "in_progress");

      const count = mgr.abortGroup("my-group");

      expect(count).toBe(2);
      expect(ctx.registry.getTask(t1.id)!.status).toBe("failed");
      expect(ctx.registry.getTask(t2.id)!.status).toBe("failed");
    });

    it("returns 0 for empty/nonexistent group", () => {
      expect(mgr.abortGroup("nonexistent-group")).toBe(0);
    });

    it("skips already-terminal tasks", () => {
      const t1 = mgr.addTask({
        title: "Done task",
        description: "already done",
        assignTo: "dev",
        group: "g1",
      });
      ctx.registry.transition(t1.id, "assigned");
      ctx.registry.transition(t1.id, "in_progress");
      ctx.registry.transition(t1.id, "review");
      ctx.registry.transition(t1.id, "done");

      const t2 = mgr.addTask({
        title: "Failed task",
        description: "already failed",
        assignTo: "dev",
        group: "g1",
      });
      ctx.registry.transition(t2.id, "assigned");
      ctx.registry.transition(t2.id, "in_progress");
      ctx.registry.transition(t2.id, "failed");

      const t3 = mgr.addTask({
        title: "Pending task",
        description: "still pending",
        assignTo: "dev",
        group: "g1",
      });

      const count = mgr.abortGroup("g1");

      expect(count).toBe(1); // Only t3 was killed
      expect(ctx.registry.getTask(t1.id)!.status).toBe("done");
      expect(ctx.registry.getTask(t2.id)!.status).toBe("failed");
      expect(ctx.registry.getTask(t3.id)!.status).toBe("failed");
    });

    it("cancels the associated plan if active", () => {
      const store = ctx.registry as InMemoryTaskStoreWithPlans;
      const plan = store.savePlan({
        name: "g2",
        data: JSON.stringify({ tasks: [{ title: "T1" }] }),
        status: "active",
      });

      mgr.addTask({
        title: "Plan task",
        description: "in plan",
        assignTo: "dev",
        group: "g2",
      });

      mgr.abortGroup("g2");

      const updatedPlan = store.getPlan(plan.id)!;
      expect(updatedPlan.status).toBe("cancelled");
    });
  });

  // ── killTask ─────────────────────────────────────────────────────────

  describe("killTask", () => {
    it("fails a pending task", () => {
      const task = mgr.addTask({
        title: "Kill pending",
        description: "desc",
        assignTo: "dev",
      });

      const result = mgr.killTask(task.id);

      expect(result).toBe(true);
      expect(ctx.registry.getTask(task.id)!.status).toBe("failed");
    });

    it("fails an in_progress task", () => {
      const task = mgr.addTask({
        title: "Kill running",
        description: "desc",
        assignTo: "dev",
      });
      ctx.registry.transition(task.id, "assigned");
      ctx.registry.transition(task.id, "in_progress");

      const result = mgr.killTask(task.id);

      expect(result).toBe(true);
      expect(ctx.registry.getTask(task.id)!.status).toBe("failed");
    });

    it("returns false for non-existent task", () => {
      expect(mgr.killTask("nonexistent")).toBe(false);
    });

    it("leaves already-done task unchanged", () => {
      const task = mgr.addTask({
        title: "Already done",
        description: "desc",
        assignTo: "dev",
      });
      ctx.registry.transition(task.id, "assigned");
      ctx.registry.transition(task.id, "in_progress");
      ctx.registry.transition(task.id, "review");
      ctx.registry.transition(task.id, "done");

      const result = mgr.killTask(task.id);

      expect(result).toBe(true);
      expect(ctx.registry.getTask(task.id)!.status).toBe("done");
    });
  });
});

// ════════════════════════════════════════════════════════════════════════
// PlanExecutor Tests
// ════════════════════════════════════════════════════════════════════════

describe("PlanExecutor", () => {
  let ctx: OrchestratorContext;
  let taskMgr: TaskManager;
  let agentMgr: AgentManager;
  let planExec: PlanExecutor;

  beforeEach(() => {
    ctx = createContext();
    taskMgr = new TaskManager(ctx);
    agentMgr = new AgentManager(ctx);
    planExec = new PlanExecutor(ctx, taskMgr, agentMgr);
  });

  // ── savePlan ─────────────────────────────────────────────────────────

  describe("savePlan", () => {
    it("persists a plan with draft status by default", () => {
      const plan = planExec.savePlan({
        data: JSON.stringify({ tasks: [{ title: "T1", assignTo: "dev" }] }),
      });

      expect(plan).toBeDefined();
      expect(plan.id).toBeTruthy();
      expect(plan.status).toBe("draft");
      expect(plan.data).toContain("tasks");

      // Verify it is retrievable
      const found = planExec.getPlan(plan.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(plan.id);
    });

    it("emits plan:saved event", () => {
      const events: any[] = [];
      ctx.emitter.on("plan:saved", (e) => events.push(e));

      const plan = planExec.savePlan({
        data: JSON.stringify({ tasks: [{ title: "T1" }] }),
      });

      expect(events).toHaveLength(1);
      expect(events[0].planId).toBe(plan.id);
      expect(events[0].status).toBe("draft");
    });

    it("assigns auto-generated name when none provided", () => {
      const plan = planExec.savePlan({
        data: JSON.stringify({ tasks: [{ title: "T1" }] }),
      });

      expect(plan.name).toBeTruthy();
      // Should get nextPlanName() output: "plan-1"
      expect(plan.name).toBe("plan-1");
    });

    it("uses provided name", () => {
      const plan = planExec.savePlan({
        data: JSON.stringify({ tasks: [{ title: "T1" }] }),
        name: "my-custom-plan",
      });

      expect(plan.name).toBe("my-custom-plan");
    });

    it("stores optional prompt", () => {
      const plan = planExec.savePlan({
        data: JSON.stringify({ tasks: [{ title: "T1" }] }),
        prompt: "Build a login page",
      });

      expect(plan.prompt).toBe("Build a login page");
    });
  });

  // ── executePlan ──────────────────────────────────────────────────────

  describe("executePlan", () => {
    it("creates tasks from JSON plan", () => {
      const data = JSON.stringify({ tasks: [
          { title: "Setup project", description: "Initialize the project structure", assignTo: "dev" },
          { title: "Write tests", description: "Add unit tests", assignTo: "dev" },
        ] });

      const plan = planExec.savePlan({ data });
      const result = planExec.executePlan(plan.id);

      expect(result.tasks).toHaveLength(2);
      expect(result.group).toBe(plan.name);
      expect(result.tasks[0].title).toBe("Setup project");
      expect(result.tasks[1].title).toBe("Write tests");

      // Tasks should be in the registry
      const allTasks = ctx.registry.getAllTasks();
      expect(allTasks).toHaveLength(2);
      expect(allTasks.every((t) => t.group === plan.name)).toBe(true);
    });

    it("resolves title-based dependencies within the plan", () => {
      const data = JSON.stringify({ tasks: [
          { title: "Create DB", description: "Setup database", assignTo: "dev" },
          { title: "Build API", description: "Implement REST API", assignTo: "dev", dependsOn: ["Create DB"] },
        ] });

      const plan = planExec.savePlan({ data });
      const result = planExec.executePlan(plan.id);

      const dbTask = result.tasks.find((t) => t.title === "Create DB")!;
      const apiTask = result.tasks.find((t) => t.title === "Build API")!;

      expect(apiTask.dependsOn).toEqual([dbTask.id]);
    });

    it("throws for non-existent plan", () => {
      expect(() => planExec.executePlan("nonexistent-id")).toThrow(
        "Plan not found",
      );
    });

    it("throws for already-active plan", () => {
      const data = JSON.stringify({ tasks: [{ title: "T1", description: "d", assignTo: "dev" }] });
      const plan = planExec.savePlan({ data });
      planExec.executePlan(plan.id);

      // Plan is now active — second execution should throw
      expect(() => planExec.executePlan(plan.id)).toThrow(
        "Plan already active",
      );
    });

    it("throws for plan with no tasks in plan data", () => {
      const plan = planExec.savePlan({ data: JSON.stringify({ team: [{ name: "dev" }] }) });

      expect(() => planExec.executePlan(plan.id)).toThrow("Plan has no tasks");
    });

    it("marks plan as active after execution", () => {
      const data = JSON.stringify({ tasks: [{ title: "T1", description: "d", assignTo: "dev" }] });
      const plan = planExec.savePlan({ data });
      planExec.executePlan(plan.id);

      const updated = planExec.getPlan(plan.id)!;
      expect(updated.status).toBe("active");
    });

    it("emits plan:executed event", () => {
      const events: any[] = [];
      ctx.emitter.on("plan:executed", (e) => events.push(e));

      const data = JSON.stringify({ tasks: [{ title: "T1", description: "d", assignTo: "dev" }] });
      const plan = planExec.savePlan({ data });
      planExec.executePlan(plan.id);

      expect(events).toHaveLength(1);
      expect(events[0].planId).toBe(plan.id);
      expect(events[0].taskCount).toBe(1);
    });

    it("uses first agent from config when assignTo is missing in plan data", () => {
      const data = JSON.stringify({ tasks: [{ title: "No Agent", description: "has no assignTo" }] });
      const plan = planExec.savePlan({ data });
      const result = planExec.executePlan(plan.id);

      expect(result.tasks[0].assignTo).toBe("dev");
    });
  });

  // ── resumePlan ───────────────────────────────────────────────────────

  describe("resumePlan", () => {
    it("throws for non-existent plan", () => {
      expect(() => planExec.resumePlan("nonexistent")).toThrow(
        "Plan not found",
      );
    });

    it("resets failed tasks when retryFailed is true", () => {
      const data = JSON.stringify({ tasks: [
          { title: "Failing task", description: "This will fail", assignTo: "dev" },
        ] });

      const plan = planExec.savePlan({ data });
      planExec.executePlan(plan.id);

      // Fail the task manually through state machine
      const task = ctx.registry.getAllTasks().find((t) => t.group === plan.name)!;
      ctx.registry.transition(task.id, "assigned");
      ctx.registry.transition(task.id, "in_progress");
      ctx.registry.transition(task.id, "review");
      ctx.registry.transition(task.id, "failed");
      planExec.updatePlan(plan.id, { status: "failed" });

      const result = planExec.resumePlan(plan.id, { retryFailed: true });

      expect(result.retried).toBe(1);

      // Task should be back to pending
      const taskAfter = ctx.registry.getTask(task.id)!;
      expect(taskAfter.status).toBe("pending");

      // Plan should be active again
      const planAfter = planExec.getPlan(plan.id)!;
      expect(planAfter.status).toBe("active");
    });

    it("does not retry when retryFailed is false", () => {
      const data = JSON.stringify({ tasks: [{ title: "T", description: "d", assignTo: "dev" }] });
      const plan = planExec.savePlan({ data });
      planExec.executePlan(plan.id);

      const task = ctx.registry.getAllTasks().find((t) => t.group === plan.name)!;
      ctx.registry.transition(task.id, "assigned");
      ctx.registry.transition(task.id, "in_progress");
      ctx.registry.transition(task.id, "review");
      ctx.registry.transition(task.id, "failed");
      planExec.updatePlan(plan.id, { status: "failed" });

      const result = planExec.resumePlan(plan.id, { retryFailed: false });

      expect(result.retried).toBe(0);
      expect(ctx.registry.getTask(task.id)!.status).toBe("failed");
    });

    it("emits plan:resumed event", () => {
      const events: any[] = [];
      ctx.emitter.on("plan:resumed", (e) => events.push(e));

      const data = JSON.stringify({ tasks: [{ title: "T", description: "d", assignTo: "dev" }] });
      const plan = planExec.savePlan({ data });
      planExec.executePlan(plan.id);
      planExec.updatePlan(plan.id, { status: "failed" });

      planExec.resumePlan(plan.id);

      expect(events).toHaveLength(1);
      expect(events[0].planId).toBe(plan.id);
      expect(events[0].name).toBe(plan.name);
    });

    it("reports pending task count", () => {
      const data = JSON.stringify({ tasks: [
          { title: "T1", description: "d1", assignTo: "dev" },
          { title: "T2", description: "d2", assignTo: "dev" },
        ] });

      const plan = planExec.savePlan({ data });
      planExec.executePlan(plan.id);

      // Both tasks are pending
      const result = planExec.resumePlan(plan.id);

      expect(result.pending).toBe(2);
      expect(result.retried).toBe(0);
    });
  });

  // ── cleanupCompletedGroups ───────────────────────────────────────────

  describe("cleanupCompletedGroups", () => {
    it("marks plan as completed when all tasks are done", () => {
      const data = JSON.stringify({ tasks: [{ title: "T1", description: "d", assignTo: "dev" }] });
      const plan = planExec.savePlan({ data });
      planExec.executePlan(plan.id);

      // Complete the task
      const task = ctx.registry.getAllTasks().find((t) => t.group === plan.name)!;
      ctx.registry.transition(task.id, "assigned");
      ctx.registry.transition(task.id, "in_progress");
      ctx.registry.transition(task.id, "review");
      ctx.registry.transition(task.id, "done");

      planExec.cleanupCompletedGroups(ctx.registry.getAllTasks());

      const updatedPlan = planExec.getPlan(plan.id)!;
      expect(updatedPlan.status).toBe("completed");
    });

    it("marks plan as failed when some tasks failed", () => {
      const data = JSON.stringify({ tasks: [
          { title: "T1", description: "d1", assignTo: "dev" },
          { title: "T2", description: "d2", assignTo: "dev" },
        ] });

      const plan = planExec.savePlan({ data });
      planExec.executePlan(plan.id);

      const tasks = ctx.registry.getAllTasks().filter((t) => t.group === plan.name);

      // One done, one failed
      ctx.registry.transition(tasks[0].id, "assigned");
      ctx.registry.transition(tasks[0].id, "in_progress");
      ctx.registry.transition(tasks[0].id, "review");
      ctx.registry.transition(tasks[0].id, "done");

      ctx.registry.transition(tasks[1].id, "assigned");
      ctx.registry.transition(tasks[1].id, "in_progress");
      ctx.registry.transition(tasks[1].id, "failed");

      planExec.cleanupCompletedGroups(ctx.registry.getAllTasks());

      const updatedPlan = planExec.getPlan(plan.id)!;
      expect(updatedPlan.status).toBe("failed");
    });

    it("emits plan:completed event", () => {
      const events: any[] = [];
      ctx.emitter.on("plan:completed", (e) => events.push(e));

      const data = JSON.stringify({ tasks: [{ title: "T1", description: "d", assignTo: "dev" }] });
      const plan = planExec.savePlan({ data });
      planExec.executePlan(plan.id);

      const task = ctx.registry.getAllTasks().find((t) => t.group === plan.name)!;
      ctx.registry.transition(task.id, "assigned");
      ctx.registry.transition(task.id, "in_progress");
      ctx.registry.transition(task.id, "review");
      ctx.registry.transition(task.id, "done");

      planExec.cleanupCompletedGroups(ctx.registry.getAllTasks());

      expect(events).toHaveLength(1);
      expect(events[0].planId).toBe(plan.id);
      expect(events[0].allPassed).toBe(true);
    });

    it("only cleans up each group once", () => {
      const data = JSON.stringify({ tasks: [{ title: "T1", description: "d", assignTo: "dev" }] });
      const plan = planExec.savePlan({ data });
      planExec.executePlan(plan.id);

      const task = ctx.registry.getAllTasks().find((t) => t.group === plan.name)!;
      ctx.registry.transition(task.id, "assigned");
      ctx.registry.transition(task.id, "in_progress");
      ctx.registry.transition(task.id, "review");
      ctx.registry.transition(task.id, "done");

      const events: any[] = [];
      ctx.emitter.on("plan:completed", (e) => events.push(e));

      planExec.cleanupCompletedGroups(ctx.registry.getAllTasks());
      planExec.cleanupCompletedGroups(ctx.registry.getAllTasks());

      // Should only emit once
      expect(events).toHaveLength(1);
    });
  });
});
