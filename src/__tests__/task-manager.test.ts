import { describe, it, expect, beforeEach } from "vitest";
import { nanoid } from "nanoid";
import { TaskManager } from "../core/task-manager.js";
import { MissionExecutor } from "../core/mission-executor.js";
import { AgentManager } from "../core/agent-manager.js";
import { TypedEmitter } from "../core/events.js";
import { InMemoryTaskStore, InMemoryRunStore, createTestAgent, createMockStores } from "./fixtures.js";
import type { OrchestratorContext } from "../core/orchestrator-context.js";
import { HookRegistry } from "../core/hooks.js";
import type { PolpoConfig, Mission } from "../core/types.js";
import type { TaskStore } from "../core/task-store.js";

// ── Extended InMemoryTaskStore with mission support ────────────────────

class InMemoryTaskStoreWithMissions extends InMemoryTaskStore implements TaskStore {
  private missions = new Map<string, Mission>();

  async saveMission(mission: Omit<Mission, "id" | "createdAt" | "updatedAt">): Promise<Mission> {
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

  async getMission(missionId: string): Promise<Mission | undefined> {
    return this.missions.get(missionId);
  }

  async getMissionByName(name: string): Promise<Mission | undefined> {
    return [...this.missions.values()].find(p => p.name === name);
  }

  async getAllMissions(): Promise<Mission[]> {
    return [...this.missions.values()];
  }

  async updateMission(missionId: string, updates: Partial<Omit<Mission, "id">>): Promise<Mission> {
    const mission = this.missions.get(missionId);
    if (!mission) throw new Error("Mission not found");
    Object.assign(mission, updates, { updatedAt: new Date().toISOString() });
    return mission;
  }

  async deleteMission(missionId: string): Promise<boolean> {
    return this.missions.delete(missionId);
  }

  async nextMissionName(): Promise<string> {
    return `mission-${this.missions.size + 1}`;
  }
}

// ── Minimal store stubs ────────────────────────────────────────────────

function createNoopMemoryStore() {
  return {
    exists: async () => false,
    get: async () => "",
    save: async () => {},
    append: async () => {},
    update: async () => true as const,
  };
}

function createNoopLogStore() {
  return {
    startSession: async () => "test-session",
    getSessionId: async () => "test-session" as string | undefined,
    append: async () => {},
    getSessionEntries: async () => [],
    listSessions: async () => [],
    prune: async () => 0,
    close: () => {},
  };
}

function createNoopSessionStore() {
  return {
    create: async () => "s1",
    addMessage: async () => ({ id: "m1", role: "user" as const, content: "", ts: new Date().toISOString() }),
    updateMessage: async () => false,
    getMessages: async () => [],
    getRecentMessages: async () => [],
    listSessions: async () => [],
    getSession: async () => undefined,
    getLatestSession: async () => undefined,
    renameSession: async () => false,
    deleteSession: async () => false,
    prune: async () => 0,
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
  const { teamStore, agentStore } = createMockStores(config.teams);
  return {
    emitter: new TypedEmitter(),
    registry: overrides?.registry ?? new InMemoryTaskStoreWithMissions(),
    runStore: new InMemoryRunStore(),
    memoryStore: createNoopMemoryStore(),
    logStore: createNoopLogStore(),
    sessionStore: createNoopSessionStore(),
    hooks: new HookRegistry(),
    config,
    teamStore,
    agentStore,
    workDir: "/tmp/test",
    agentWorkDir: "/tmp/test",
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
    it("creates a task with pending status", async () => {
      const task = await mgr.addTask({
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

    it("throws if registry is not initialized (null)", async () => {
      const ctxNoRegistry = createContext();
      (ctxNoRegistry as any).registry = undefined;
      const mgrBad = new TaskManager(ctxNoRegistry);

      await expect(
        mgrBad.addTask({ title: "X", description: "Y", assignTo: "dev" }),
      ).rejects.toThrow("Orchestrator not initialized");
    });

    it("emits task:created event", async () => {
      const events: any[] = [];
      ctx.emitter.on("task:created", (e) => events.push(e));

      const task = await mgr.addTask({
        title: "My task",
        description: "desc",
        assignTo: "dev",
      });

      expect(events).toHaveLength(1);
      expect(events[0].task.id).toBe(task.id);
      expect(events[0].task.title).toBe("My task");
    });

    it("stores task in registry", async () => {
      const task = await mgr.addTask({
        title: "Stored task",
        description: "desc",
        assignTo: "dev",
      });

      const found = await ctx.registry.getTask(task.id);
      expect(found).toBeDefined();
      expect(found!.title).toBe("Stored task");
    });

    it("sets maxRetries from config settings", async () => {
      ctx.config.settings.maxRetries = 5;
      const task = await mgr.addTask({
        title: "Retryable",
        description: "desc",
        assignTo: "dev",
      });

      expect(task.maxRetries).toBe(5);
    });

    it("assigns group and dependencies when provided", async () => {
      const dep = await mgr.addTask({
        title: "Dep task",
        description: "dependency",
        assignTo: "dev",
      });

      const task = await mgr.addTask({
        title: "Main task",
        description: "depends on dep",
        assignTo: "dev",
        dependsOn: [dep.id],
        group: "my-plan",
      });

      expect(task.group).toBe("my-plan");
      expect(task.dependsOn).toEqual([dep.id]);
    });

    it("sanitizes invalid expectations and emits warnings", async () => {
      const warnings: string[] = [];
      ctx.emitter.on("log", (e) => {
        if (e.level === "warn") warnings.push(e.message);
      });

      const task = await mgr.addTask({
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
    it("transitions failed task to pending", async () => {
      const task = await mgr.addTask({
        title: "Failing task",
        description: "will fail",
        assignTo: "dev",
      });

      // Move to failed: pending → assigned → in_progress → failed
      await ctx.registry.transition(task.id, "assigned");
      await ctx.registry.transition(task.id, "in_progress");
      await ctx.registry.transition(task.id, "failed");

      expect((await ctx.registry.getTask(task.id))!.status).toBe("failed");

      await mgr.retryTask(task.id);

      const updated = (await ctx.registry.getTask(task.id))!;
      expect(updated.status).toBe("pending");
      expect(updated.retries).toBe(1);
    });

    it("throws for non-failed task (pending)", async () => {
      const task = await mgr.addTask({
        title: "Pending task",
        description: "still pending",
        assignTo: "dev",
      });

      await expect(mgr.retryTask(task.id)).rejects.toThrow(
        'Cannot retry task in "pending" state',
      );
    });

    it("throws for non-failed task (in_progress)", async () => {
      const task = await mgr.addTask({
        title: "Running task",
        description: "running",
        assignTo: "dev",
      });
      await ctx.registry.transition(task.id, "assigned");
      await ctx.registry.transition(task.id, "in_progress");

      await expect(mgr.retryTask(task.id)).rejects.toThrow(
        'Cannot retry task in "in_progress" state',
      );
    });

    it("throws for non-failed task (done)", async () => {
      const task = await mgr.addTask({
        title: "Done task",
        description: "done",
        assignTo: "dev",
      });
      await ctx.registry.transition(task.id, "assigned");
      await ctx.registry.transition(task.id, "in_progress");
      await ctx.registry.transition(task.id, "review");
      await ctx.registry.transition(task.id, "done");

      await expect(mgr.retryTask(task.id)).rejects.toThrow(
        'Cannot retry task in "done" state',
      );
    });

    it("throws for non-existent task", async () => {
      await expect(mgr.retryTask("nonexistent")).rejects.toThrow("Task not found");
    });
  });

  // ── forceFailTask ────────────────────────────────────────────────────

  describe("forceFailTask", () => {
    it("force-fails a pending task", async () => {
      const task = await mgr.addTask({
        title: "Will be force-failed",
        description: "desc",
        assignTo: "dev",
      });

      await mgr.forceFailTask(task.id);

      expect((await ctx.registry.getTask(task.id))!.status).toBe("failed");
    });

    it("force-fails an in_progress task", async () => {
      const task = await mgr.addTask({
        title: "Running",
        description: "desc",
        assignTo: "dev",
      });
      await ctx.registry.transition(task.id, "assigned");
      await ctx.registry.transition(task.id, "in_progress");

      await mgr.forceFailTask(task.id);

      expect((await ctx.registry.getTask(task.id))!.status).toBe("failed");
    });

    it("force-fails an assigned task", async () => {
      const task = await mgr.addTask({
        title: "Assigned",
        description: "desc",
        assignTo: "dev",
      });
      await ctx.registry.transition(task.id, "assigned");

      await mgr.forceFailTask(task.id);

      expect((await ctx.registry.getTask(task.id))!.status).toBe("failed");
    });

    it("is a no-op for already-failed task", async () => {
      const task = await mgr.addTask({
        title: "Already failed",
        description: "desc",
        assignTo: "dev",
      });
      await ctx.registry.transition(task.id, "assigned");
      await ctx.registry.transition(task.id, "in_progress");
      await ctx.registry.transition(task.id, "failed");

      // Should not throw
      await mgr.forceFailTask(task.id);
      expect((await ctx.registry.getTask(task.id))!.status).toBe("failed");
    });

    it("is a no-op for done task", async () => {
      const task = await mgr.addTask({
        title: "Done",
        description: "desc",
        assignTo: "dev",
      });
      await ctx.registry.transition(task.id, "assigned");
      await ctx.registry.transition(task.id, "in_progress");
      await ctx.registry.transition(task.id, "review");
      await ctx.registry.transition(task.id, "done");

      await mgr.forceFailTask(task.id);
      expect((await ctx.registry.getTask(task.id))!.status).toBe("done");
    });

    it("is a no-op for non-existent task", async () => {
      // Should not throw
      await mgr.forceFailTask("nonexistent-id");
    });
  });

  // ── updateTaskDescription ────────────────────────────────────────────

  describe("updateTaskDescription", () => {
    it("updates the task description", async () => {
      const task = await mgr.addTask({
        title: "Editable",
        description: "original",
        assignTo: "dev",
      });

      await mgr.updateTaskDescription(task.id, "updated description");

      const updated = (await ctx.registry.getTask(task.id))!;
      expect(updated.description).toBe("updated description");
    });
  });

  // ── updateTaskAssignment ─────────────────────────────────────────────

  describe("updateTaskAssignment", () => {
    it("updates the task assignTo field", async () => {
      const task = await mgr.addTask({
        title: "Reassignable",
        description: "desc",
        assignTo: "dev",
      });

      await mgr.updateTaskAssignment(task.id, "other-agent");

      const updated = (await ctx.registry.getTask(task.id))!;
      expect(updated.assignTo).toBe("other-agent");
    });
  });

  // ── updateTaskExpectations ───────────────────────────────────────────

  describe("updateTaskExpectations", () => {
    it("updates expectations on a pending task", async () => {
      const task = await mgr.addTask({
        title: "With expectations",
        description: "desc",
        assignTo: "dev",
      });

      await mgr.updateTaskExpectations(task.id, [
        { type: "test", command: "npm test" },
      ]);

      const updated = (await ctx.registry.getTask(task.id))!;
      expect(updated.expectations).toHaveLength(1);
      expect(updated.expectations[0].type).toBe("test");
    });

    it("throws for in_progress task", async () => {
      const task = await mgr.addTask({
        title: "Running",
        description: "desc",
        assignTo: "dev",
      });
      await ctx.registry.transition(task.id, "assigned");
      await ctx.registry.transition(task.id, "in_progress");

      await expect(
        mgr.updateTaskExpectations(task.id, [{ type: "test", command: "npm test" }]),
      ).rejects.toThrow('Cannot edit expectations of task in "in_progress" state');
    });

    it("emits task:updated event", async () => {
      const events: any[] = [];
      ctx.emitter.on("task:updated", (e) => events.push(e));

      const task = await mgr.addTask({
        title: "Observable",
        description: "desc",
        assignTo: "dev",
      });

      await mgr.updateTaskExpectations(task.id, [
        { type: "test", command: "npm test" },
      ]);

      expect(events).toHaveLength(1);
      expect(events[0].task.id).toBe(task.id);
    });

    it("throws for non-existent task", async () => {
      await expect(
        mgr.updateTaskExpectations("nonexistent", [{ type: "test", command: "npm test" }]),
      ).rejects.toThrow("Task not found");
    });
  });

  // ── seedTasks ────────────────────────────────────────────────────────

  describe("seedTasks", () => {
    it("creates tasks from config input", async () => {
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

      await mgr.seedTasks();

      const tasks = await ctx.registry.getAllTasks();
      expect(tasks).toHaveLength(2);
      expect(tasks[0].title).toBe("Config Task 1");
      expect(tasks[1].title).toBe("Config Task 2");
    });

    it("emits task:created for each seeded task", async () => {
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

      await mgr.seedTasks();

      expect(events).toHaveLength(1);
      expect(events[0].task.title).toBe("Seeded");
    });

    it("resolves title-based dependencies to task IDs", async () => {
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

      await mgr.seedTasks();

      const tasks = await ctx.registry.getAllTasks();
      const setupTask = tasks.find((t) => t.title === "Setup DB")!;
      const apiTask = tasks.find((t) => t.title === "Write API")!;

      expect(apiTask.dependsOn).toEqual([setupTask.id]);
    });

    it("does nothing when config has no tasks", async () => {
      ctx.config.tasks = [];
      await mgr.seedTasks();
      expect(await ctx.registry.getAllTasks()).toHaveLength(0);
    });

    it("ignores unresolvable dependencies", async () => {
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

      await mgr.seedTasks();

      const tasks = await ctx.registry.getAllTasks();
      expect(tasks).toHaveLength(1);
      // Unresolvable dependency should be filtered out
      expect(tasks[0].dependsOn).toEqual([]);
    });
  });

  // ── abortGroup ───────────────────────────────────────────────────────

  describe("abortGroup", () => {
    it("kills non-terminal tasks in a group", async () => {
      const t1 = await mgr.addTask({
        title: "Group task 1",
        description: "pending",
        assignTo: "dev",
        group: "my-group",
      });
      const t2 = await mgr.addTask({
        title: "Group task 2",
        description: "in progress",
        assignTo: "dev",
        group: "my-group",
      });
      await ctx.registry.transition(t2.id, "assigned");
      await ctx.registry.transition(t2.id, "in_progress");

      const count = await mgr.abortGroup("my-group");

      expect(count).toBe(2);
      expect((await ctx.registry.getTask(t1.id))!.status).toBe("failed");
      expect((await ctx.registry.getTask(t2.id))!.status).toBe("failed");
    });

    it("returns 0 for empty/nonexistent group", async () => {
      expect(await mgr.abortGroup("nonexistent-group")).toBe(0);
    });

    it("skips already-terminal tasks", async () => {
      const t1 = await mgr.addTask({
        title: "Done task",
        description: "already done",
        assignTo: "dev",
        group: "g1",
      });
      await ctx.registry.transition(t1.id, "assigned");
      await ctx.registry.transition(t1.id, "in_progress");
      await ctx.registry.transition(t1.id, "review");
      await ctx.registry.transition(t1.id, "done");

      const t2 = await mgr.addTask({
        title: "Failed task",
        description: "already failed",
        assignTo: "dev",
        group: "g1",
      });
      await ctx.registry.transition(t2.id, "assigned");
      await ctx.registry.transition(t2.id, "in_progress");
      await ctx.registry.transition(t2.id, "failed");

      const t3 = await mgr.addTask({
        title: "Pending task",
        description: "still pending",
        assignTo: "dev",
        group: "g1",
      });

      const count = await mgr.abortGroup("g1");

      expect(count).toBe(1); // Only t3 was killed
      expect((await ctx.registry.getTask(t1.id))!.status).toBe("done");
      expect((await ctx.registry.getTask(t2.id))!.status).toBe("failed");
      expect((await ctx.registry.getTask(t3.id))!.status).toBe("failed");
    });

    it("cancels the associated mission if active", async () => {
      const store = ctx.registry as InMemoryTaskStoreWithMissions;
      const mission = await store.saveMission({
        name: "g2",
        data: JSON.stringify({ tasks: [{ title: "T1" }] }),
        status: "active",
      });

      await mgr.addTask({
        title: "Mission task",
        description: "in mission",
        assignTo: "dev",
        group: "g2",
      });

      await mgr.abortGroup("g2");

      const updatedMission = (await store.getMission(mission.id))!;
      expect(updatedMission.status).toBe("cancelled");
    });
  });

  // ── killTask ─────────────────────────────────────────────────────────

  describe("killTask", () => {
    it("fails a pending task", async () => {
      const task = await mgr.addTask({
        title: "Kill pending",
        description: "desc",
        assignTo: "dev",
      });

      const result = await mgr.killTask(task.id);

      expect(result).toBe(true);
      expect((await ctx.registry.getTask(task.id))!.status).toBe("failed");
    });

    it("fails an in_progress task", async () => {
      const task = await mgr.addTask({
        title: "Kill running",
        description: "desc",
        assignTo: "dev",
      });
      await ctx.registry.transition(task.id, "assigned");
      await ctx.registry.transition(task.id, "in_progress");

      const result = await mgr.killTask(task.id);

      expect(result).toBe(true);
      expect((await ctx.registry.getTask(task.id))!.status).toBe("failed");
    });

    it("returns false for non-existent task", async () => {
      expect(await mgr.killTask("nonexistent")).toBe(false);
    });

    it("leaves already-done task unchanged", async () => {
      const task = await mgr.addTask({
        title: "Already done",
        description: "desc",
        assignTo: "dev",
      });
      await ctx.registry.transition(task.id, "assigned");
      await ctx.registry.transition(task.id, "in_progress");
      await ctx.registry.transition(task.id, "review");
      await ctx.registry.transition(task.id, "done");

      const result = await mgr.killTask(task.id);

      expect(result).toBe(true);
      expect((await ctx.registry.getTask(task.id))!.status).toBe("done");
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

  beforeEach(async () => {
    ctx = createContext();
    taskMgr = new TaskManager(ctx);
    agentMgr = new AgentManager(ctx);
    missionExec = new MissionExecutor(ctx, taskMgr, agentMgr);
    await missionExec.ready;
  });

  // ── saveMission ──────────────────────────────────────────────────────

  describe("saveMission", () => {
    it("persists a mission with draft status by default", async () => {
      const mission = await missionExec.saveMission({
        data: JSON.stringify({ tasks: [{ title: "T1", assignTo: "dev" }] }),
      });

      expect(mission).toBeDefined();
      expect(mission.id).toBeTruthy();
      expect(mission.status).toBe("draft");
      expect(mission.data).toContain("tasks");

      // Verify it is retrievable
      const found = await missionExec.getMission(mission.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(mission.id);
    });

    it("emits mission:saved event", async () => {
      const events: any[] = [];
      ctx.emitter.on("mission:saved", (e) => events.push(e));

      const mission = await missionExec.saveMission({
        data: JSON.stringify({ tasks: [{ title: "T1" }] }),
      });

      expect(events).toHaveLength(1);
      expect(events[0].missionId).toBe(mission.id);
      expect(events[0].status).toBe("draft");
    });

    it("assigns auto-generated name when none provided", async () => {
      const mission = await missionExec.saveMission({
        data: JSON.stringify({ tasks: [{ title: "T1" }] }),
      });

      expect(mission.name).toBeTruthy();
      // Should get nextMissionName() output: "mission-1"
      expect(mission.name).toBe("mission-1");
    });

    it("uses provided name", async () => {
      const mission = await missionExec.saveMission({
        data: JSON.stringify({ tasks: [{ title: "T1" }] }),
        name: "my-custom-mission",
      });

      expect(mission.name).toBe("my-custom-mission");
    });

    it("stores optional prompt", async () => {
      const mission = await missionExec.saveMission({
        data: JSON.stringify({ tasks: [{ title: "T1" }] }),
        prompt: "Build a login page",
      });

      expect(mission.prompt).toBe("Build a login page");
    });
  });

  // ── executeMission ───────────────────────────────────────────────────

  describe("executeMission", () => {
    it("creates tasks from JSON mission", async () => {
      const data = JSON.stringify({ tasks: [
          { title: "Setup project", description: "Initialize the project structure", assignTo: "dev" },
          { title: "Write tests", description: "Add unit tests", assignTo: "dev" },
        ] });

      const mission = await missionExec.saveMission({ data });
      const result = await missionExec.executeMission(mission.id);

      expect(result.tasks).toHaveLength(2);
      expect(result.group).toBe(mission.name);
      expect(result.tasks[0].title).toBe("Setup project");
      expect(result.tasks[1].title).toBe("Write tests");

      // Tasks should be in the registry
      const allTasks = await ctx.registry.getAllTasks();
      expect(allTasks).toHaveLength(2);
      expect(allTasks.every((t) => t.group === mission.name)).toBe(true);
    });

    it("resolves title-based dependencies within the mission", async () => {
      const data = JSON.stringify({ tasks: [
          { title: "Create DB", description: "Setup database", assignTo: "dev" },
          { title: "Build API", description: "Implement REST API", assignTo: "dev", dependsOn: ["Create DB"] },
        ] });

      const mission = await missionExec.saveMission({ data });
      const result = await missionExec.executeMission(mission.id);

      const dbTask = result.tasks.find((t) => t.title === "Create DB")!;
      const apiTask = result.tasks.find((t) => t.title === "Build API")!;

      expect(apiTask.dependsOn).toEqual([dbTask.id]);
    });

    it("throws for non-existent mission", async () => {
      await expect(missionExec.executeMission("nonexistent-id")).rejects.toThrow(
        "Mission not found",
      );
    });

    it("throws for already-active mission", async () => {
      const data = JSON.stringify({ tasks: [{ title: "T1", description: "d", assignTo: "dev" }] });
      const mission = await missionExec.saveMission({ data });
      await missionExec.executeMission(mission.id);

      // Mission is now active — second execution should throw
      await expect(missionExec.executeMission(mission.id)).rejects.toThrow(
        'Cannot execute mission in "active" state (must be "draft", "scheduled", or "recurring")',
      );
    });

    it("throws for mission with no tasks in mission data", async () => {
      const mission = await missionExec.saveMission({ data: JSON.stringify({ team: [{ name: "dev" }] }) });

      await expect(missionExec.executeMission(mission.id)).rejects.toThrow("Invalid mission document");
    });

    it("marks mission as active after execution", async () => {
      const data = JSON.stringify({ tasks: [{ title: "T1", description: "d", assignTo: "dev" }] });
      const mission = await missionExec.saveMission({ data });
      await missionExec.executeMission(mission.id);

      const updated = (await missionExec.getMission(mission.id))!;
      expect(updated.status).toBe("active");
    });

    it("emits mission:executed event", async () => {
      const events: any[] = [];
      ctx.emitter.on("mission:executed", (e) => events.push(e));

      const data = JSON.stringify({ tasks: [{ title: "T1", description: "d", assignTo: "dev" }] });
      const mission = await missionExec.saveMission({ data });
      await missionExec.executeMission(mission.id);

      expect(events).toHaveLength(1);
      expect(events[0].missionId).toBe(mission.id);
      expect(events[0].taskCount).toBe(1);
    });

    it("uses first agent from config when assignTo is missing in mission data", async () => {
      const data = JSON.stringify({ tasks: [{ title: "No Agent", description: "has no assignTo" }] });
      const mission = await missionExec.saveMission({ data });
      const result = await missionExec.executeMission(mission.id);

      expect(result.tasks[0].assignTo).toBe("dev");
    });
  });

  // ── resumeMission ────────────────────────────────────────────────────

  describe("resumeMission", () => {
    it("throws for non-existent mission", async () => {
      await expect(missionExec.resumeMission("nonexistent")).rejects.toThrow(
        "Mission not found",
      );
    });

    it("resets failed tasks when retryFailed is true", async () => {
      const data = JSON.stringify({ tasks: [
          { title: "Failing task", description: "This will fail", assignTo: "dev" },
        ] });

      const mission = await missionExec.saveMission({ data });
      await missionExec.executeMission(mission.id);

      // Fail the task manually through state machine
      const task = (await ctx.registry.getAllTasks()).find((t) => t.group === mission.name)!;
      await ctx.registry.transition(task.id, "assigned");
      await ctx.registry.transition(task.id, "in_progress");
      await ctx.registry.transition(task.id, "review");
      await ctx.registry.transition(task.id, "failed");
      await missionExec.updateMission(mission.id, { status: "failed" });

      const result = await missionExec.resumeMission(mission.id, { retryFailed: true });

      expect(result.retried).toBe(1);

      // Task should be back to pending
      const taskAfter = (await ctx.registry.getTask(task.id))!;
      expect(taskAfter.status).toBe("pending");

      // Mission should be active again
      const missionAfter = (await missionExec.getMission(mission.id))!;
      expect(missionAfter.status).toBe("active");
    });

    it("does not retry when retryFailed is false", async () => {
      const data = JSON.stringify({ tasks: [{ title: "T", description: "d", assignTo: "dev" }] });
      const mission = await missionExec.saveMission({ data });
      await missionExec.executeMission(mission.id);

      const task = (await ctx.registry.getAllTasks()).find((t) => t.group === mission.name)!;
      await ctx.registry.transition(task.id, "assigned");
      await ctx.registry.transition(task.id, "in_progress");
      await ctx.registry.transition(task.id, "review");
      await ctx.registry.transition(task.id, "failed");
      await missionExec.updateMission(mission.id, { status: "failed" });

      const result = await missionExec.resumeMission(mission.id, { retryFailed: false });

      expect(result.retried).toBe(0);
      expect((await ctx.registry.getTask(task.id))!.status).toBe("failed");
    });

    it("emits mission:resumed event", async () => {
      const events: any[] = [];
      ctx.emitter.on("mission:resumed", (e) => events.push(e));

      const data = JSON.stringify({ tasks: [{ title: "T", description: "d", assignTo: "dev" }] });
      const mission = await missionExec.saveMission({ data });
      await missionExec.executeMission(mission.id);
      await missionExec.updateMission(mission.id, { status: "failed" });

      await missionExec.resumeMission(mission.id);

      expect(events).toHaveLength(1);
      expect(events[0].missionId).toBe(mission.id);
      expect(events[0].name).toBe(mission.name);
    });

    it("reports pending task count", async () => {
      const data = JSON.stringify({ tasks: [
          { title: "T1", description: "d1", assignTo: "dev" },
          { title: "T2", description: "d2", assignTo: "dev" },
        ] });

      const mission = await missionExec.saveMission({ data });
      await missionExec.executeMission(mission.id);

      // Both tasks are pending
      const result = await missionExec.resumeMission(mission.id);

      expect(result.pending).toBe(2);
      expect(result.retried).toBe(0);
    });
  });

  // ── cleanupCompletedGroups ───────────────────────────────────────────

  describe("cleanupCompletedGroups", () => {
    it("marks mission as completed when all tasks are done", async () => {
      const data = JSON.stringify({ tasks: [{ title: "T1", description: "d", assignTo: "dev" }] });
      const mission = await missionExec.saveMission({ data });
      await missionExec.executeMission(mission.id);

      // Complete the task
      const task = (await ctx.registry.getAllTasks()).find((t) => t.group === mission.name)!;
      await ctx.registry.transition(task.id, "assigned");
      await ctx.registry.transition(task.id, "in_progress");
      await ctx.registry.transition(task.id, "review");
      await ctx.registry.transition(task.id, "done");

      await missionExec.cleanupCompletedGroups(await ctx.registry.getAllTasks());

      const updatedMission = (await missionExec.getMission(mission.id))!;
      expect(updatedMission.status).toBe("completed");
    });

    it("marks mission as failed when some tasks failed", async () => {
      const data = JSON.stringify({ tasks: [
          { title: "T1", description: "d1", assignTo: "dev" },
          { title: "T2", description: "d2", assignTo: "dev" },
        ] });

      const mission = await missionExec.saveMission({ data });
      await missionExec.executeMission(mission.id);

      const tasks = (await ctx.registry.getAllTasks()).filter((t) => t.group === mission.name);

      // One done, one failed
      await ctx.registry.transition(tasks[0].id, "assigned");
      await ctx.registry.transition(tasks[0].id, "in_progress");
      await ctx.registry.transition(tasks[0].id, "review");
      await ctx.registry.transition(tasks[0].id, "done");

      await ctx.registry.transition(tasks[1].id, "assigned");
      await ctx.registry.transition(tasks[1].id, "in_progress");
      await ctx.registry.transition(tasks[1].id, "failed");

      await missionExec.cleanupCompletedGroups(await ctx.registry.getAllTasks());

      const updatedMission = (await missionExec.getMission(mission.id))!;
      expect(updatedMission.status).toBe("failed");
    });

    it("emits mission:completed event", async () => {
      const events: any[] = [];
      ctx.emitter.on("mission:completed", (e) => events.push(e));

      const data = JSON.stringify({ tasks: [{ title: "T1", description: "d", assignTo: "dev" }] });
      const mission = await missionExec.saveMission({ data });
      await missionExec.executeMission(mission.id);

      const task = (await ctx.registry.getAllTasks()).find((t) => t.group === mission.name)!;
      await ctx.registry.transition(task.id, "assigned");
      await ctx.registry.transition(task.id, "in_progress");
      await ctx.registry.transition(task.id, "review");
      await ctx.registry.transition(task.id, "done");

      await missionExec.cleanupCompletedGroups(await ctx.registry.getAllTasks());

      expect(events).toHaveLength(1);
      expect(events[0].missionId).toBe(mission.id);
      expect(events[0].allPassed).toBe(true);
    });

    it("only cleans up each group once", async () => {
      const data = JSON.stringify({ tasks: [{ title: "T1", description: "d", assignTo: "dev" }] });
      const mission = await missionExec.saveMission({ data });
      await missionExec.executeMission(mission.id);

      const task = (await ctx.registry.getAllTasks()).find((t) => t.group === mission.name)!;
      await ctx.registry.transition(task.id, "assigned");
      await ctx.registry.transition(task.id, "in_progress");
      await ctx.registry.transition(task.id, "review");
      await ctx.registry.transition(task.id, "done");

      const events: any[] = [];
      ctx.emitter.on("mission:completed", (e) => events.push(e));

      await missionExec.cleanupCompletedGroups(await ctx.registry.getAllTasks());
      await missionExec.cleanupCompletedGroups(await ctx.registry.getAllTasks());

      // Should only emit once
      expect(events).toHaveLength(1);
    });
  });
});
