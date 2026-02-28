import { describe, it, expect, beforeEach } from "vitest";
import { nanoid } from "nanoid";
import { TaskManager } from "../core/task-manager.js";
import { MissionExecutor } from "../core/mission-executor.js";
import { AgentManager } from "../core/agent-manager.js";
import { TypedEmitter } from "../core/events.js";
import { InMemoryTaskStore, InMemoryRunStore, createTestAgent } from "./fixtures.js";
import type { OrchestratorContext } from "../core/orchestrator-context.js";
import { HookRegistry } from "../core/hooks.js";
import type { PolpoConfig, Mission } from "../core/types.js";
import type { TaskStore } from "../core/task-store.js";

// ── Extended InMemoryTaskStore with mission support ────────────────────

class InMemoryTaskStoreWithMissions extends InMemoryTaskStore implements TaskStore {
  private missions = new Map<string, Mission>();

  saveMission(mission: Omit<Mission, "id" | "createdAt" | "updatedAt">): Mission {
    const existing = [...this.missions.values()].find(p => p.name === mission.name);
    if (existing) throw new Error(`Mission name "${mission.name}" already exists`);
    const now = new Date().toISOString();
    const newMission: Mission = {
      ...mission,
      id: nanoid(),
      createdAt: now,
      updatedAt: now,
    };
    this.missions.set(newMission.id, newMission);
    return newMission;
  }

  getMission(missionId: string): Mission | undefined {
    return this.missions.get(missionId);
  }

  getMissionByName(name: string): Mission | undefined {
    return [...this.missions.values()].find(p => p.name === name);
  }

  getAllMissions(): Mission[] {
    return [...this.missions.values()];
  }

  updateMission(missionId: string, updates: Partial<Omit<Mission, "id">>): Mission {
    const mission = this.missions.get(missionId);
    if (!mission) throw new Error("Mission not found");
    Object.assign(mission, updates, { updatedAt: new Date().toISOString() });
    return mission;
  }

  deleteMission(missionId: string): boolean {
    return this.missions.delete(missionId);
  }

  nextMissionName(): string {
    return `mission-${this.missions.size + 1}`;
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
    teams: [{
      name: "test-team",
      agents: [createTestAgent({ name: "dev" })],
    }],
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
    registry: overrides?.registry ?? new InMemoryTaskStoreWithMissions(),
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

    it("cancels the associated mission if active", () => {
      const store = ctx.registry as InMemoryTaskStoreWithMissions;
      const mission = store.saveMission({
        name: "g2",
        data: JSON.stringify({ tasks: [{ title: "T1" }] }),
        status: "active",
      });

      mgr.addTask({
        title: "Mission task",
        description: "in mission",
        assignTo: "dev",
        group: "g2",
      });

      mgr.abortGroup("g2");

      const updatedMission = store.getMission(mission.id)!;
      expect(updatedMission.status).toBe("cancelled");
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
// MissionExecutor Tests
// ════════════════════════════════════════════════════════════════════════

describe("MissionExecutor", () => {
  let ctx: OrchestratorContext;
  let taskMgr: TaskManager;
  let agentMgr: AgentManager;
  let missionExec: MissionExecutor;

  beforeEach(() => {
    ctx = createContext();
    taskMgr = new TaskManager(ctx);
    agentMgr = new AgentManager(ctx);
    missionExec = new MissionExecutor(ctx, taskMgr, agentMgr);
  });

  // ── saveMission ──────────────────────────────────────────────────────

  describe("saveMission", () => {
    it("persists a mission with draft status by default", () => {
      const mission = missionExec.saveMission({
        data: JSON.stringify({ tasks: [{ title: "T1", assignTo: "dev" }] }),
      });

      expect(mission).toBeDefined();
      expect(mission.id).toBeTruthy();
      expect(mission.status).toBe("draft");
      expect(mission.data).toContain("tasks");

      // Verify it is retrievable
      const found = missionExec.getMission(mission.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(mission.id);
    });

    it("emits mission:saved event", () => {
      const events: any[] = [];
      ctx.emitter.on("mission:saved", (e) => events.push(e));

      const mission = missionExec.saveMission({
        data: JSON.stringify({ tasks: [{ title: "T1" }] }),
      });

      expect(events).toHaveLength(1);
      expect(events[0].missionId).toBe(mission.id);
      expect(events[0].status).toBe("draft");
    });

    it("assigns auto-generated name when none provided", () => {
      const mission = missionExec.saveMission({
        data: JSON.stringify({ tasks: [{ title: "T1" }] }),
      });

      expect(mission.name).toBeTruthy();
      // Should get nextMissionName() output: "mission-1"
      expect(mission.name).toBe("mission-1");
    });

    it("uses provided name", () => {
      const mission = missionExec.saveMission({
        data: JSON.stringify({ tasks: [{ title: "T1" }] }),
        name: "my-custom-mission",
      });

      expect(mission.name).toBe("my-custom-mission");
    });

    it("stores optional prompt", () => {
      const mission = missionExec.saveMission({
        data: JSON.stringify({ tasks: [{ title: "T1" }] }),
        prompt: "Build a login page",
      });

      expect(mission.prompt).toBe("Build a login page");
    });
  });

  // ── executeMission ───────────────────────────────────────────────────

  describe("executeMission", () => {
    it("creates tasks from JSON mission", () => {
      const data = JSON.stringify({ tasks: [
          { title: "Setup project", description: "Initialize the project structure", assignTo: "dev" },
          { title: "Write tests", description: "Add unit tests", assignTo: "dev" },
        ] });

      const mission = missionExec.saveMission({ data });
      const result = missionExec.executeMission(mission.id);

      expect(result.tasks).toHaveLength(2);
      expect(result.group).toBe(mission.name);
      expect(result.tasks[0].title).toBe("Setup project");
      expect(result.tasks[1].title).toBe("Write tests");

      // Tasks should be in the registry
      const allTasks = ctx.registry.getAllTasks();
      expect(allTasks).toHaveLength(2);
      expect(allTasks.every((t) => t.group === mission.name)).toBe(true);
    });

    it("resolves title-based dependencies within the mission", () => {
      const data = JSON.stringify({ tasks: [
          { title: "Create DB", description: "Setup database", assignTo: "dev" },
          { title: "Build API", description: "Implement REST API", assignTo: "dev", dependsOn: ["Create DB"] },
        ] });

      const mission = missionExec.saveMission({ data });
      const result = missionExec.executeMission(mission.id);

      const dbTask = result.tasks.find((t) => t.title === "Create DB")!;
      const apiTask = result.tasks.find((t) => t.title === "Build API")!;

      expect(apiTask.dependsOn).toEqual([dbTask.id]);
    });

    it("throws for non-existent mission", () => {
      expect(() => missionExec.executeMission("nonexistent-id")).toThrow(
        "Mission not found",
      );
    });

    it("throws for already-active mission", () => {
      const data = JSON.stringify({ tasks: [{ title: "T1", description: "d", assignTo: "dev" }] });
      const mission = missionExec.saveMission({ data });
      missionExec.executeMission(mission.id);

      // Mission is now active — second execution should throw
      expect(() => missionExec.executeMission(mission.id)).toThrow(
        "Mission already active",
      );
    });

    it("throws for mission with no tasks in mission data", () => {
      const mission = missionExec.saveMission({ data: JSON.stringify({ team: [{ name: "dev" }] }) });

      expect(() => missionExec.executeMission(mission.id)).toThrow("Mission has no tasks");
    });

    it("marks mission as active after execution", () => {
      const data = JSON.stringify({ tasks: [{ title: "T1", description: "d", assignTo: "dev" }] });
      const mission = missionExec.saveMission({ data });
      missionExec.executeMission(mission.id);

      const updated = missionExec.getMission(mission.id)!;
      expect(updated.status).toBe("active");
    });

    it("emits mission:executed event", () => {
      const events: any[] = [];
      ctx.emitter.on("mission:executed", (e) => events.push(e));

      const data = JSON.stringify({ tasks: [{ title: "T1", description: "d", assignTo: "dev" }] });
      const mission = missionExec.saveMission({ data });
      missionExec.executeMission(mission.id);

      expect(events).toHaveLength(1);
      expect(events[0].missionId).toBe(mission.id);
      expect(events[0].taskCount).toBe(1);
    });

    it("uses first agent from config when assignTo is missing in mission data", () => {
      const data = JSON.stringify({ tasks: [{ title: "No Agent", description: "has no assignTo" }] });
      const mission = missionExec.saveMission({ data });
      const result = missionExec.executeMission(mission.id);

      expect(result.tasks[0].assignTo).toBe("dev");
    });
  });

  // ── resumeMission ────────────────────────────────────────────────────

  describe("resumeMission", () => {
    it("throws for non-existent mission", () => {
      expect(() => missionExec.resumeMission("nonexistent")).toThrow(
        "Mission not found",
      );
    });

    it("resets failed tasks when retryFailed is true", () => {
      const data = JSON.stringify({ tasks: [
          { title: "Failing task", description: "This will fail", assignTo: "dev" },
        ] });

      const mission = missionExec.saveMission({ data });
      missionExec.executeMission(mission.id);

      // Fail the task manually through state machine
      const task = ctx.registry.getAllTasks().find((t) => t.group === mission.name)!;
      ctx.registry.transition(task.id, "assigned");
      ctx.registry.transition(task.id, "in_progress");
      ctx.registry.transition(task.id, "review");
      ctx.registry.transition(task.id, "failed");
      missionExec.updateMission(mission.id, { status: "failed" });

      const result = missionExec.resumeMission(mission.id, { retryFailed: true });

      expect(result.retried).toBe(1);

      // Task should be back to pending
      const taskAfter = ctx.registry.getTask(task.id)!;
      expect(taskAfter.status).toBe("pending");

      // Mission should be active again
      const missionAfter = missionExec.getMission(mission.id)!;
      expect(missionAfter.status).toBe("active");
    });

    it("does not retry when retryFailed is false", () => {
      const data = JSON.stringify({ tasks: [{ title: "T", description: "d", assignTo: "dev" }] });
      const mission = missionExec.saveMission({ data });
      missionExec.executeMission(mission.id);

      const task = ctx.registry.getAllTasks().find((t) => t.group === mission.name)!;
      ctx.registry.transition(task.id, "assigned");
      ctx.registry.transition(task.id, "in_progress");
      ctx.registry.transition(task.id, "review");
      ctx.registry.transition(task.id, "failed");
      missionExec.updateMission(mission.id, { status: "failed" });

      const result = missionExec.resumeMission(mission.id, { retryFailed: false });

      expect(result.retried).toBe(0);
      expect(ctx.registry.getTask(task.id)!.status).toBe("failed");
    });

    it("emits mission:resumed event", () => {
      const events: any[] = [];
      ctx.emitter.on("mission:resumed", (e) => events.push(e));

      const data = JSON.stringify({ tasks: [{ title: "T", description: "d", assignTo: "dev" }] });
      const mission = missionExec.saveMission({ data });
      missionExec.executeMission(mission.id);
      missionExec.updateMission(mission.id, { status: "failed" });

      missionExec.resumeMission(mission.id);

      expect(events).toHaveLength(1);
      expect(events[0].missionId).toBe(mission.id);
      expect(events[0].name).toBe(mission.name);
    });

    it("reports pending task count", () => {
      const data = JSON.stringify({ tasks: [
          { title: "T1", description: "d1", assignTo: "dev" },
          { title: "T2", description: "d2", assignTo: "dev" },
        ] });

      const mission = missionExec.saveMission({ data });
      missionExec.executeMission(mission.id);

      // Both tasks are pending
      const result = missionExec.resumeMission(mission.id);

      expect(result.pending).toBe(2);
      expect(result.retried).toBe(0);
    });
  });

  // ── cleanupCompletedGroups ───────────────────────────────────────────

  describe("cleanupCompletedGroups", () => {
    it("marks mission as completed when all tasks are done", () => {
      const data = JSON.stringify({ tasks: [{ title: "T1", description: "d", assignTo: "dev" }] });
      const mission = missionExec.saveMission({ data });
      missionExec.executeMission(mission.id);

      // Complete the task
      const task = ctx.registry.getAllTasks().find((t) => t.group === mission.name)!;
      ctx.registry.transition(task.id, "assigned");
      ctx.registry.transition(task.id, "in_progress");
      ctx.registry.transition(task.id, "review");
      ctx.registry.transition(task.id, "done");

      missionExec.cleanupCompletedGroups(ctx.registry.getAllTasks());

      const updatedMission = missionExec.getMission(mission.id)!;
      expect(updatedMission.status).toBe("completed");
    });

    it("marks mission as failed when some tasks failed", () => {
      const data = JSON.stringify({ tasks: [
          { title: "T1", description: "d1", assignTo: "dev" },
          { title: "T2", description: "d2", assignTo: "dev" },
        ] });

      const mission = missionExec.saveMission({ data });
      missionExec.executeMission(mission.id);

      const tasks = ctx.registry.getAllTasks().filter((t) => t.group === mission.name);

      // One done, one failed
      ctx.registry.transition(tasks[0].id, "assigned");
      ctx.registry.transition(tasks[0].id, "in_progress");
      ctx.registry.transition(tasks[0].id, "review");
      ctx.registry.transition(tasks[0].id, "done");

      ctx.registry.transition(tasks[1].id, "assigned");
      ctx.registry.transition(tasks[1].id, "in_progress");
      ctx.registry.transition(tasks[1].id, "failed");

      missionExec.cleanupCompletedGroups(ctx.registry.getAllTasks());

      const updatedMission = missionExec.getMission(mission.id)!;
      expect(updatedMission.status).toBe("failed");
    });

    it("emits mission:completed event", () => {
      const events: any[] = [];
      ctx.emitter.on("mission:completed", (e) => events.push(e));

      const data = JSON.stringify({ tasks: [{ title: "T1", description: "d", assignTo: "dev" }] });
      const mission = missionExec.saveMission({ data });
      missionExec.executeMission(mission.id);

      const task = ctx.registry.getAllTasks().find((t) => t.group === mission.name)!;
      ctx.registry.transition(task.id, "assigned");
      ctx.registry.transition(task.id, "in_progress");
      ctx.registry.transition(task.id, "review");
      ctx.registry.transition(task.id, "done");

      missionExec.cleanupCompletedGroups(ctx.registry.getAllTasks());

      expect(events).toHaveLength(1);
      expect(events[0].missionId).toBe(mission.id);
      expect(events[0].allPassed).toBe(true);
    });

    it("only cleans up each group once", () => {
      const data = JSON.stringify({ tasks: [{ title: "T1", description: "d", assignTo: "dev" }] });
      const mission = missionExec.saveMission({ data });
      missionExec.executeMission(mission.id);

      const task = ctx.registry.getAllTasks().find((t) => t.group === mission.name)!;
      ctx.registry.transition(task.id, "assigned");
      ctx.registry.transition(task.id, "in_progress");
      ctx.registry.transition(task.id, "review");
      ctx.registry.transition(task.id, "done");

      const events: any[] = [];
      ctx.emitter.on("mission:completed", (e) => events.push(e));

      missionExec.cleanupCompletedGroups(ctx.registry.getAllTasks());
      missionExec.cleanupCompletedGroups(ctx.registry.getAllTasks());

      // Should only emit once
      expect(events).toHaveLength(1);
    });
  });
});
