import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MissionExecutor } from "../core/mission-executor.js";
import { TaskManager } from "../core/task-manager.js";
import { AgentManager } from "../core/agent-manager.js";
import { HookRegistry } from "../core/hooks.js";
import { TypedEmitter } from "../core/events.js";
import { InMemoryTaskStore, InMemoryRunStore, createTestTask, createMockStores } from "./fixtures.js";
import type { OrchestratorContext } from "../core/orchestrator-context.js";
import type { PolpoConfig, Task, Mission, MissionCheckpoint } from "../core/types.js";

// ── Helpers ──────────────────────────────────────────

function createMinimalConfig(): PolpoConfig {
  return {
    version: "1",
    org: "test",
    teams: [{ name: "test-team", agents: [{ name: "test-agent" }] }],
    tasks: [],
    settings: { maxRetries: 2, workDir: "/tmp/test", logLevel: "quiet" },
  };
}

function createMockCtx(overrides: Partial<OrchestratorContext> = {}): OrchestratorContext {
  const store = new InMemoryTaskStore();
  const missions = new Map<string, Mission>();
  let missionCounter = 0;

  // Extend the InMemoryTaskStore with mission methods by assigning onto the instance
  const registry = Object.assign(store, {
    saveMission: async (opts: { name: string; data: string; prompt?: string; status?: string; notifications?: unknown }) => {
      const id = `mission-${++missionCounter}`;
      const mission: Mission = {
        id,
        name: opts.name,
        data: opts.data,
        prompt: opts.prompt,
        status: (opts.status as Mission["status"]) ?? "draft",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      missions.set(id, mission);
      return mission;
    },
    getMission: async (id: string) => missions.get(id),
    getMissionByName: async (name: string) => [...missions.values()].find(p => p.name === name),
    getAllMissions: async () => [...missions.values()],
    updateMission: async (id: string, updates: Partial<Mission>) => {
      const mission = missions.get(id);
      if (!mission) throw new Error(`Mission not found: ${id}`);
      Object.assign(mission, updates, { updatedAt: new Date().toISOString() });
      return mission;
    },
    deleteMission: async (id: string) => missions.delete(id),
    nextMissionName: async () => `mission-${missionCounter + 1}`,
  });

  const config = createMinimalConfig();
  const { teamStore, agentStore } = createMockStores(config.teams);

  return {
    emitter: new TypedEmitter(),
    registry,
    runStore: new InMemoryRunStore(),
    memoryStore: { exists: async () => false, get: async () => "", save: async () => {}, append: async () => {}, update: async () => true as true | string },
    logStore: { startSession: async () => "s", getSessionId: async () => "s", append: async () => {}, getSessionEntries: async () => [], listSessions: async () => [], prune: async () => 0, close: () => {} },
    sessionStore: { create: async () => "s1", addMessage: async () => ({ id: "m1", role: "user" as const, content: "", ts: "" }), updateMessage: async () => false, getMessages: async () => [], getRecentMessages: async () => [], listSessions: async () => [], getSession: async () => undefined, getLatestSession: async () => undefined, renameSession: async () => false, deleteSession: async () => false, prune: async () => 0, close: () => {} },
    hooks: new HookRegistry(),
    config,
    teamStore,
    agentStore,
    workDir: "/tmp/test",
    agentWorkDir: "/tmp/test",
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
  let missionExec: MissionExecutor;
  let taskMgr: TaskManager;
  let agentMgr: AgentManager;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "polpo-test-cp-"));
    ctx = createMockCtx({ polpoDir: tmpDir });
    taskMgr = new TaskManager(ctx);
    agentMgr = new AgentManager(ctx);
    missionExec = new MissionExecutor(ctx, taskMgr, agentMgr);
    await missionExec.ready;
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe("getCheckpoints", () => {
    it("returns empty array when no checkpoints defined", () => {
      expect(missionExec.getCheckpoints("my-mission")).toEqual([]);
    });

    it("returns checkpoints after mission execution", async () => {
      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B", dependsOn: ["Task A"] },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });

      const mission = await missionExec.saveMission({ data: missionData, name: "my-mission" });
      await missionExec.executeMission(mission.id);

      const checkpoints = missionExec.getCheckpoints("my-mission");
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].name).toBe("review-a");
    });
  });

  describe("getBlockingCheckpoint", () => {
    it("returns undefined when no checkpoints defined", async () => {
      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      const result = await missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      expect(result).toBeUndefined();
    });

    it("does not block when afterTasks are not yet complete", async () => {
      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B", dependsOn: ["Task A"] },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = await missionExec.saveMission({ data: missionData, name: "my-mission" });
      await missionExec.executeMission(mission.id);

      // Task A is still pending — checkpoint not reached
      const tasks = [createPendingTask("Task A"), createPendingTask("Task B")];
      const result = await missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      expect(result).toBeUndefined();
    });

    it("blocks when afterTasks are done and checkpoint not resumed", async () => {
      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B", dependsOn: ["Task A"] },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = await missionExec.saveMission({ data: missionData, name: "my-mission" });
      await missionExec.executeMission(mission.id);

      // Task A is done — checkpoint triggers
      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      const result = await missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      expect(result).toBeDefined();
      expect(result!.checkpoint.name).toBe("review-a");
      expect(result!.reachedAt).toBeTruthy();
    });

    it("does not block tasks not listed in blocksTasks", async () => {
      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B", dependsOn: ["Task A"] },
          { title: "Task C", description: "Do C" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = await missionExec.saveMission({ data: missionData, name: "my-mission" });
      await missionExec.executeMission(mission.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B"), createPendingTask("Task C")];
      // Task C is NOT in blocksTasks — should not be blocked
      const result = await missionExec.getBlockingCheckpoint("my-mission", "Task C", "id-c", tasks);
      expect(result).toBeUndefined();
    });

    it("emits checkpoint:reached event when first activated", async () => {
      const events: unknown[] = [];
      ctx.emitter.on("checkpoint:reached", (data) => events.push(data));

      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B", dependsOn: ["Task A"] },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"], message: "Review Task A output" },
        ],
      });
      const mission = await missionExec.saveMission({ data: missionData, name: "my-mission" });
      await missionExec.executeMission(mission.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      await missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        group: "my-mission",
        checkpointName: "review-a",
        message: "Review Task A output",
      });
    });

    it("does not emit duplicate events on repeated checks", async () => {
      const events: unknown[] = [];
      ctx.emitter.on("checkpoint:reached", (data) => events.push(data));

      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B", dependsOn: ["Task A"] },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = await missionExec.saveMission({ data: missionData, name: "my-mission" });
      await missionExec.executeMission(mission.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];

      // Call multiple times
      await missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      await missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      await missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);

      // Event only emitted once
      expect(events).toHaveLength(1);
    });

    it("pauses the mission when checkpoint is reached", async () => {
      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B", dependsOn: ["Task A"] },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = await missionExec.saveMission({ data: missionData, name: "my-mission" });
      await missionExec.executeMission(mission.id);

      // Mission should be active
      expect((await missionExec.getMission(mission.id))!.status).toBe("active");

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      await missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);

      // Mission should now be paused
      expect((await missionExec.getMission(mission.id))!.status).toBe("paused");
    });
  });

  describe("resumeCheckpoint", () => {
    it("returns false for non-existent checkpoint", async () => {
      expect(await missionExec.resumeCheckpoint("my-mission", "nonexistent")).toBe(false);
    });

    it("resumes an active checkpoint and unblocks tasks", async () => {
      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B", dependsOn: ["Task A"] },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = await missionExec.saveMission({ data: missionData, name: "my-mission" });
      await missionExec.executeMission(mission.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];

      // Activate checkpoint
      const blocking = await missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      expect(blocking).toBeDefined();

      // Resume
      const resumed = await missionExec.resumeCheckpoint("my-mission", "review-a");
      expect(resumed).toBe(true);

      // Task B should no longer be blocked
      const blocking2 = await missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      expect(blocking2).toBeUndefined();
    });

    it("sets mission status back to active after resume", async () => {
      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B", dependsOn: ["Task A"] },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = await missionExec.saveMission({ data: missionData, name: "my-mission" });
      await missionExec.executeMission(mission.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      await missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      expect((await missionExec.getMission(mission.id))!.status).toBe("paused");

      await missionExec.resumeCheckpoint("my-mission", "review-a");
      expect((await missionExec.getMission(mission.id))!.status).toBe("active");
    });

    it("emits checkpoint:resumed event", async () => {
      const events: unknown[] = [];
      ctx.emitter.on("checkpoint:resumed", (data) => events.push(data));

      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B", dependsOn: ["Task A"] },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = await missionExec.saveMission({ data: missionData, name: "my-mission" });
      await missionExec.executeMission(mission.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      await missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      await missionExec.resumeCheckpoint("my-mission", "review-a");

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        group: "my-mission",
        checkpointName: "review-a",
      });
    });

    it("does not re-trigger after resume", async () => {
      const reachedEvents: unknown[] = [];
      ctx.emitter.on("checkpoint:reached", (data) => reachedEvents.push(data));

      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B", dependsOn: ["Task A"] },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = await missionExec.saveMission({ data: missionData, name: "my-mission" });
      await missionExec.executeMission(mission.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      await missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      await missionExec.resumeCheckpoint("my-mission", "review-a");

      // Check again after resume — should not re-trigger
      const blocking = await missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      expect(blocking).toBeUndefined();
      expect(reachedEvents).toHaveLength(1); // Only the first trigger
    });
  });

  describe("getActiveCheckpoints", () => {
    it("returns empty array when no checkpoints active", () => {
      expect(missionExec.getActiveCheckpoints()).toEqual([]);
    });

    it("returns active checkpoints", async () => {
      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B", dependsOn: ["Task A"] },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = await missionExec.saveMission({ data: missionData, name: "my-mission" });
      await missionExec.executeMission(mission.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      await missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);

      const active = missionExec.getActiveCheckpoints();
      expect(active).toHaveLength(1);
      expect(active[0].group).toBe("my-mission");
      expect(active[0].checkpointName).toBe("review-a");
    });

    it("removes checkpoint from active list after resume", async () => {
      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B", dependsOn: ["Task A"] },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = await missionExec.saveMission({ data: missionData, name: "my-mission" });
      await missionExec.executeMission(mission.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      await missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      expect(missionExec.getActiveCheckpoints()).toHaveLength(1);

      await missionExec.resumeCheckpoint("my-mission", "review-a");
      expect(missionExec.getActiveCheckpoints()).toHaveLength(0);
    });
  });

  describe("multiple checkpoints", () => {
    it("handles sequential checkpoints in a mission", async () => {
      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B", dependsOn: ["Task A"] },
          { title: "Task C", description: "Do C", dependsOn: ["Task B"] },
        ],
        checkpoints: [
          { name: "cp-1", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
          { name: "cp-2", afterTasks: ["Task B"], blocksTasks: ["Task C"] },
        ],
      });
      const mission = await missionExec.saveMission({ data: missionData, name: "my-mission" });
      await missionExec.executeMission(mission.id);

      // Checkpoint 1: Task A done, blocks Task B
      const tasks1 = [createDoneTask("Task A"), createPendingTask("Task B"), createPendingTask("Task C")];
      const blocking1 = await missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks1);
      expect(blocking1).toBeDefined();
      expect(blocking1!.checkpoint.name).toBe("cp-1");

      // Task C not blocked by cp-1
      const blockingC1 = await missionExec.getBlockingCheckpoint("my-mission", "Task C", "id-c", tasks1);
      expect(blockingC1).toBeUndefined();

      // Resume cp-1
      await missionExec.resumeCheckpoint("my-mission", "cp-1");
      const blocking1After = await missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks1);
      expect(blocking1After).toBeUndefined();

      // Checkpoint 2: Task B done, blocks Task C
      const tasks2 = [createDoneTask("Task A"), createDoneTask("Task B"), createPendingTask("Task C")];
      const blocking2 = await missionExec.getBlockingCheckpoint("my-mission", "Task C", "id-c", tasks2);
      expect(blocking2).toBeDefined();
      expect(blocking2!.checkpoint.name).toBe("cp-2");

      // Resume cp-2
      await missionExec.resumeCheckpoint("my-mission", "cp-2");
      const blocking2After = await missionExec.getBlockingCheckpoint("my-mission", "Task C", "id-c", tasks2);
      expect(blocking2After).toBeUndefined();
    });
  });

  describe("persistence", () => {
    it("checkpoint definitions survive across MissionExecutor instances", async () => {
      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B", dependsOn: ["Task A"] },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = await missionExec.saveMission({ data: missionData, name: "my-mission" });
      await missionExec.executeMission(mission.id);

      // Verify checkpoint was registered
      expect(missionExec.getCheckpoints("my-mission")).toHaveLength(1);

      // Create a new executor (simulates server restart) — reuse same ctx (same polpoDir)
      const missionExec2 = new MissionExecutor(ctx, taskMgr, agentMgr);
      await missionExec2.ready;
      const checkpoints = missionExec2.getCheckpoints("my-mission");
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].name).toBe("review-a");
    });

    it("active checkpoints survive across MissionExecutor instances", async () => {
      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B", dependsOn: ["Task A"] },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = await missionExec.saveMission({ data: missionData, name: "my-mission" });
      await missionExec.executeMission(mission.id);

      // Activate checkpoint
      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      await missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      expect(missionExec.getActiveCheckpoints()).toHaveLength(1);

      // New executor — active checkpoint should still be there
      const missionExec2 = new MissionExecutor(ctx, taskMgr, agentMgr);
      await missionExec2.ready;
      expect(missionExec2.getActiveCheckpoints()).toHaveLength(1);
      expect(missionExec2.getActiveCheckpoints()[0].checkpointName).toBe("review-a");

      // And it should still block
      const blocking = await missionExec2.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      expect(blocking).toBeDefined();
    });

    it("resumed checkpoints survive across MissionExecutor instances", async () => {
      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B", dependsOn: ["Task A"] },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = await missionExec.saveMission({ data: missionData, name: "my-mission" });
      await missionExec.executeMission(mission.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      await missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      await missionExec.resumeCheckpoint("my-mission", "review-a");

      // New executor — should know checkpoint was resumed (not re-trigger)
      const missionExec2 = new MissionExecutor(ctx, taskMgr, agentMgr);
      await missionExec2.ready;
      const blocking = await missionExec2.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      expect(blocking).toBeUndefined();
      expect(missionExec2.getActiveCheckpoints()).toHaveLength(0);
    });

    it("cleanup removes persisted checkpoint state for completed groups", async () => {
      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B", dependsOn: ["Task A"] },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = await missionExec.saveMission({ data: missionData, name: "my-mission" });
      await missionExec.executeMission(mission.id);

      // Activate and resume checkpoint
      const tasks = [createDoneTask("Task A", { group: "my-mission" }), createPendingTask("Task B", { group: "my-mission" })];
      await missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      await missionExec.resumeCheckpoint("my-mission", "review-a");

      // Mark all tasks as done and cleanup
      const doneTasks = [createDoneTask("Task A", { group: "my-mission" }), createDoneTask("Task B", { group: "my-mission" })];
      await missionExec.cleanupCompletedGroups(doneTasks);

      // New executor — should have no checkpoint state for this group
      const missionExec2 = new MissionExecutor(ctx, taskMgr, agentMgr);
      await missionExec2.ready;
      expect(missionExec2.getCheckpoints("my-mission")).toHaveLength(0);
      expect(missionExec2.getActiveCheckpoints()).toHaveLength(0);
    });
  });

  describe("notification rules", () => {
    it("registers notification rules for checkpoint notifyChannels", async () => {
      const addedRules: Array<{ id: string; events: string[] }> = [];
      const mockRouter = {
        addRule: (rule: { id: string; events: string[] }) => { addedRules.push(rule); },
      };
      missionExec.setNotificationRouter(mockRouter as any);

      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B", dependsOn: ["Task A"] },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"], notifyChannels: ["slack-alerts"] },
        ],
      });
      const mission = await missionExec.saveMission({ data: missionData, name: "my-mission" });
      await missionExec.executeMission(mission.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      await missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);

      // Should have registered 2 rules: reached + resumed
      expect(addedRules).toHaveLength(2);
      expect(addedRules[0].events).toContain("checkpoint:reached");
      expect(addedRules[1].events).toContain("checkpoint:resumed");
    });

    it("does not register rules when no notifyChannels", async () => {
      const addedRules: unknown[] = [];
      const mockRouter = {
        addRule: (rule: unknown) => { addedRules.push(rule); },
      };
      missionExec.setNotificationRouter(mockRouter as any);

      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B", dependsOn: ["Task A"] },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = await missionExec.saveMission({ data: missionData, name: "my-mission" });
      await missionExec.executeMission(mission.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      await missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);

      expect(addedRules).toHaveLength(0);
    });
  });
});
