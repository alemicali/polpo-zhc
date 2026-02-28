import { describe, it, expect, beforeEach, vi } from "vitest";
import { MissionExecutor } from "../core/mission-executor.js";
import { TaskManager } from "../core/task-manager.js";
import { AgentManager } from "../core/agent-manager.js";
import { HookRegistry } from "../core/hooks.js";
import { TypedEmitter } from "../core/events.js";
import { InMemoryTaskStore, InMemoryRunStore, createTestTask } from "./fixtures.js";
import type { OrchestratorContext } from "../core/orchestrator-context.js";
import type { PolpoConfig, Task, Mission, MissionCheckpoint } from "../core/types.js";

// ── Helpers ──────────────────────────────────────────

function createMinimalConfig(): PolpoConfig {
  return {
    version: "1",
    project: "test",
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
    saveMission: (opts: { name: string; data: string; prompt?: string; status?: string; notifications?: unknown }) => {
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
    getMission: (id: string) => missions.get(id),
    getMissionByName: (name: string) => [...missions.values()].find(p => p.name === name),
    getAllMissions: () => [...missions.values()],
    updateMission: (id: string, updates: Partial<Mission>) => {
      const mission = missions.get(id);
      if (!mission) throw new Error(`Mission not found: ${id}`);
      Object.assign(mission, updates, { updatedAt: new Date().toISOString() });
      return mission;
    },
    deleteMission: (id: string) => missions.delete(id),
    nextMissionName: () => `mission-${missionCounter + 1}`,
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
  let missionExec: MissionExecutor;
  let taskMgr: TaskManager;
  let agentMgr: AgentManager;

  beforeEach(() => {
    ctx = createMockCtx();
    taskMgr = new TaskManager(ctx);
    agentMgr = new AgentManager(ctx);
    missionExec = new MissionExecutor(ctx, taskMgr, agentMgr);
  });

  describe("getCheckpoints", () => {
    it("returns empty array when no checkpoints defined", () => {
      expect(missionExec.getCheckpoints("my-mission")).toEqual([]);
    });

    it("returns checkpoints after mission execution", () => {
      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });

      const mission = missionExec.saveMission({ data: missionData, name: "my-mission" });
      missionExec.executeMission(mission.id);

      const checkpoints = missionExec.getCheckpoints("my-mission");
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].name).toBe("review-a");
    });
  });

  describe("getBlockingCheckpoint", () => {
    it("returns undefined when no checkpoints defined", () => {
      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      const result = missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      expect(result).toBeUndefined();
    });

    it("does not block when afterTasks are not yet complete", () => {
      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = missionExec.saveMission({ data: missionData, name: "my-mission" });
      missionExec.executeMission(mission.id);

      // Task A is still pending — checkpoint not reached
      const tasks = [createPendingTask("Task A"), createPendingTask("Task B")];
      const result = missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      expect(result).toBeUndefined();
    });

    it("blocks when afterTasks are done and checkpoint not resumed", () => {
      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = missionExec.saveMission({ data: missionData, name: "my-mission" });
      missionExec.executeMission(mission.id);

      // Task A is done — checkpoint triggers
      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      const result = missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      expect(result).toBeDefined();
      expect(result!.checkpoint.name).toBe("review-a");
      expect(result!.reachedAt).toBeTruthy();
    });

    it("does not block tasks not listed in blocksTasks", () => {
      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
          { title: "Task C", description: "Do C" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = missionExec.saveMission({ data: missionData, name: "my-mission" });
      missionExec.executeMission(mission.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B"), createPendingTask("Task C")];
      // Task C is NOT in blocksTasks — should not be blocked
      const result = missionExec.getBlockingCheckpoint("my-mission", "Task C", "id-c", tasks);
      expect(result).toBeUndefined();
    });

    it("emits checkpoint:reached event when first activated", () => {
      const events: unknown[] = [];
      ctx.emitter.on("checkpoint:reached", (data) => events.push(data));

      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"], message: "Review Task A output" },
        ],
      });
      const mission = missionExec.saveMission({ data: missionData, name: "my-mission" });
      missionExec.executeMission(mission.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        group: "my-mission",
        checkpointName: "review-a",
        message: "Review Task A output",
      });
    });

    it("does not emit duplicate events on repeated checks", () => {
      const events: unknown[] = [];
      ctx.emitter.on("checkpoint:reached", (data) => events.push(data));

      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = missionExec.saveMission({ data: missionData, name: "my-mission" });
      missionExec.executeMission(mission.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];

      // Call multiple times
      missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);

      // Event only emitted once
      expect(events).toHaveLength(1);
    });

    it("pauses the mission when checkpoint is reached", () => {
      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = missionExec.saveMission({ data: missionData, name: "my-mission" });
      missionExec.executeMission(mission.id);

      // Mission should be active
      expect(missionExec.getMission(mission.id)!.status).toBe("active");

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);

      // Mission should now be paused
      expect(missionExec.getMission(mission.id)!.status).toBe("paused");
    });
  });

  describe("resumeCheckpoint", () => {
    it("returns false for non-existent checkpoint", () => {
      expect(missionExec.resumeCheckpoint("my-mission", "nonexistent")).toBe(false);
    });

    it("resumes an active checkpoint and unblocks tasks", () => {
      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = missionExec.saveMission({ data: missionData, name: "my-mission" });
      missionExec.executeMission(mission.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];

      // Activate checkpoint
      const blocking = missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      expect(blocking).toBeDefined();

      // Resume
      const resumed = missionExec.resumeCheckpoint("my-mission", "review-a");
      expect(resumed).toBe(true);

      // Task B should no longer be blocked
      const blocking2 = missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      expect(blocking2).toBeUndefined();
    });

    it("sets mission status back to active after resume", () => {
      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = missionExec.saveMission({ data: missionData, name: "my-mission" });
      missionExec.executeMission(mission.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      expect(missionExec.getMission(mission.id)!.status).toBe("paused");

      missionExec.resumeCheckpoint("my-mission", "review-a");
      expect(missionExec.getMission(mission.id)!.status).toBe("active");
    });

    it("emits checkpoint:resumed event", () => {
      const events: unknown[] = [];
      ctx.emitter.on("checkpoint:resumed", (data) => events.push(data));

      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = missionExec.saveMission({ data: missionData, name: "my-mission" });
      missionExec.executeMission(mission.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      missionExec.resumeCheckpoint("my-mission", "review-a");

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        group: "my-mission",
        checkpointName: "review-a",
      });
    });

    it("does not re-trigger after resume", () => {
      const reachedEvents: unknown[] = [];
      ctx.emitter.on("checkpoint:reached", (data) => reachedEvents.push(data));

      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = missionExec.saveMission({ data: missionData, name: "my-mission" });
      missionExec.executeMission(mission.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      missionExec.resumeCheckpoint("my-mission", "review-a");

      // Check again after resume — should not re-trigger
      const blocking = missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      expect(blocking).toBeUndefined();
      expect(reachedEvents).toHaveLength(1); // Only the first trigger
    });
  });

  describe("getActiveCheckpoints", () => {
    it("returns empty array when no checkpoints active", () => {
      expect(missionExec.getActiveCheckpoints()).toEqual([]);
    });

    it("returns active checkpoints", () => {
      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = missionExec.saveMission({ data: missionData, name: "my-mission" });
      missionExec.executeMission(mission.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);

      const active = missionExec.getActiveCheckpoints();
      expect(active).toHaveLength(1);
      expect(active[0].group).toBe("my-mission");
      expect(active[0].checkpointName).toBe("review-a");
    });

    it("removes checkpoint from active list after resume", () => {
      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = missionExec.saveMission({ data: missionData, name: "my-mission" });
      missionExec.executeMission(mission.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);
      expect(missionExec.getActiveCheckpoints()).toHaveLength(1);

      missionExec.resumeCheckpoint("my-mission", "review-a");
      expect(missionExec.getActiveCheckpoints()).toHaveLength(0);
    });
  });

  describe("multiple checkpoints", () => {
    it("handles sequential checkpoints in a mission", () => {
      const missionData = JSON.stringify({
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
      const mission = missionExec.saveMission({ data: missionData, name: "my-mission" });
      missionExec.executeMission(mission.id);

      // Checkpoint 1: Task A done, blocks Task B
      const tasks1 = [createDoneTask("Task A"), createPendingTask("Task B"), createPendingTask("Task C")];
      const blocking1 = missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks1);
      expect(blocking1).toBeDefined();
      expect(blocking1!.checkpoint.name).toBe("cp-1");

      // Task C not blocked by cp-1
      const blockingC1 = missionExec.getBlockingCheckpoint("my-mission", "Task C", "id-c", tasks1);
      expect(blockingC1).toBeUndefined();

      // Resume cp-1
      missionExec.resumeCheckpoint("my-mission", "cp-1");
      const blocking1After = missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks1);
      expect(blocking1After).toBeUndefined();

      // Checkpoint 2: Task B done, blocks Task C
      const tasks2 = [createDoneTask("Task A"), createDoneTask("Task B"), createPendingTask("Task C")];
      const blocking2 = missionExec.getBlockingCheckpoint("my-mission", "Task C", "id-c", tasks2);
      expect(blocking2).toBeDefined();
      expect(blocking2!.checkpoint.name).toBe("cp-2");

      // Resume cp-2
      missionExec.resumeCheckpoint("my-mission", "cp-2");
      const blocking2After = missionExec.getBlockingCheckpoint("my-mission", "Task C", "id-c", tasks2);
      expect(blocking2After).toBeUndefined();
    });
  });

  describe("notification rules", () => {
    it("registers notification rules for checkpoint notifyChannels", () => {
      const addedRules: Array<{ id: string; events: string[] }> = [];
      const mockRouter = {
        addRule: (rule: { id: string; events: string[] }) => { addedRules.push(rule); },
      };
      missionExec.setNotificationRouter(mockRouter as any);

      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"], notifyChannels: ["slack-alerts"] },
        ],
      });
      const mission = missionExec.saveMission({ data: missionData, name: "my-mission" });
      missionExec.executeMission(mission.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);

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
      missionExec.setNotificationRouter(mockRouter as any);

      const missionData = JSON.stringify({
        tasks: [
          { title: "Task A", description: "Do A" },
          { title: "Task B", description: "Do B" },
        ],
        checkpoints: [
          { name: "review-a", afterTasks: ["Task A"], blocksTasks: ["Task B"] },
        ],
      });
      const mission = missionExec.saveMission({ data: missionData, name: "my-mission" });
      missionExec.executeMission(mission.id);

      const tasks = [createDoneTask("Task A"), createPendingTask("Task B")];
      missionExec.getBlockingCheckpoint("my-mission", "Task B", "id-b", tasks);

      expect(addedRules).toHaveLength(0);
    });
  });
});
