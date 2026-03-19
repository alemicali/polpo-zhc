import { describe, it, expect, beforeEach, vi } from "vitest";
import { QualityController } from "../quality/quality-controller.js";
import { HookRegistry } from "../core/hooks.js";
import { TypedEmitter } from "../core/events.js";
import { InMemoryTaskStore, InMemoryRunStore, createTestTask } from "./fixtures.js";
import type { OrchestratorContext } from "../core/orchestrator-context.js";
import type { PolpoConfig, Task, MissionQualityGate, Mission, AssessmentResult } from "../core/types.js";

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
  return {
    emitter: new TypedEmitter(),
    registry: new InMemoryTaskStore(),
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
  };
}

function createDoneTask(title: string, score?: number, overrides: Partial<Task> = {}): Task {
  return createTestTask({
    title,
    status: "done",
    result: {
      exitCode: 0,
      stdout: "",
      stderr: "",
      duration: 100,
      assessment: score !== undefined ? {
        passed: true,
        checks: [],
        metrics: [],
        globalScore: score,
        timestamp: new Date().toISOString(),
      } : undefined,
    },
    ...overrides,
  });
}

function createFailedTask(title: string, overrides: Partial<Task> = {}): Task {
  return createTestTask({
    title,
    status: "failed",
    result: {
      exitCode: 1,
      stdout: "",
      stderr: "error",
      duration: 100,
    },
    ...overrides,
  });
}

function createMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "mission-1",
    name: "test-mission",
    data: "{}",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────

describe("QualityController", () => {
  let ctx: OrchestratorContext;
  let ctrl: QualityController;

  beforeEach(() => {
    ctx = createMockCtx();
    ctrl = new QualityController(ctx);
    ctrl.init();
  });

  describe("evaluateGate", () => {
    it("passes when all afterTasks are done and no score requirement", () => {
      const gate: MissionQualityGate = {
        name: "gate-1",
        afterTasks: ["Task A", "Task B"],
        blocksTasks: ["Task C"],
      };
      const tasks = [
        createDoneTask("Task A"),
        createDoneTask("Task B"),
      ];

      const result = ctrl.evaluateGate("mission-1", gate, tasks);
      expect(result.passed).toBe(true);
    });

    it("fails when afterTasks are not yet terminal", () => {
      const gate: MissionQualityGate = {
        name: "gate-1",
        afterTasks: ["Task A", "Task B"],
        blocksTasks: ["Task C"],
      };
      const tasks = [
        createDoneTask("Task A"),
        createTestTask({ title: "Task B", status: "in_progress" }),
      ];

      const result = ctrl.evaluateGate("mission-1", gate, tasks);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain("Waiting for tasks");
    });

    it("fails when requireAllPassed and some tasks failed", () => {
      const gate: MissionQualityGate = {
        name: "gate-1",
        afterTasks: ["Task A", "Task B"],
        blocksTasks: ["Task C"],
        requireAllPassed: true,
      };
      const tasks = [
        createDoneTask("Task A"),
        createFailedTask("Task B"),
      ];

      const result = ctrl.evaluateGate("mission-1", gate, tasks);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain("Required tasks failed");
    });

    it("passes when requireAllPassed and all tasks done", () => {
      const gate: MissionQualityGate = {
        name: "gate-1",
        afterTasks: ["Task A", "Task B"],
        blocksTasks: ["Task C"],
        requireAllPassed: true,
      };
      const tasks = [
        createDoneTask("Task A"),
        createDoneTask("Task B"),
      ];

      const result = ctrl.evaluateGate("mission-1", gate, tasks);
      expect(result.passed).toBe(true);
    });

    it("fails when avgScore below minScore", () => {
      const gate: MissionQualityGate = {
        name: "gate-1",
        afterTasks: ["Task A", "Task B"],
        blocksTasks: ["Task C"],
        minScore: 4.0,
      };
      const tasks = [
        createDoneTask("Task A", 3.0),
        createDoneTask("Task B", 3.5),
      ];

      const result = ctrl.evaluateGate("mission-1", gate, tasks);
      expect(result.passed).toBe(false);
      expect(result.avgScore).toBeCloseTo(3.25);
      expect(result.reason).toContain("below threshold");
    });

    it("passes when avgScore meets minScore", () => {
      const gate: MissionQualityGate = {
        name: "gate-1",
        afterTasks: ["Task A", "Task B"],
        blocksTasks: ["Task C"],
        minScore: 4.0,
      };
      const tasks = [
        createDoneTask("Task A", 4.0),
        createDoneTask("Task B", 4.5),
      ];

      const result = ctrl.evaluateGate("mission-1", gate, tasks);
      expect(result.passed).toBe(true);
      expect(result.avgScore).toBeCloseTo(4.25);
    });

    it("emits quality:gate:passed event on success", () => {
      const emitSpy = vi.spyOn(ctx.emitter, "emit");
      const gate: MissionQualityGate = {
        name: "gate-1",
        afterTasks: ["Task A"],
        blocksTasks: ["Task B"],
      };
      const tasks = [createDoneTask("Task A")];

      ctrl.evaluateGate("mission-1", gate, tasks);

      expect(emitSpy).toHaveBeenCalledWith("quality:gate:passed", expect.objectContaining({
        missionId: "mission-1",
        gateName: "gate-1",
      }));
    });

    it("emits quality:gate:failed event on failure", () => {
      const emitSpy = vi.spyOn(ctx.emitter, "emit");
      const gate: MissionQualityGate = {
        name: "gate-1",
        afterTasks: ["Task A"],
        blocksTasks: ["Task B"],
        requireAllPassed: true,
      };
      const tasks = [createFailedTask("Task A")];

      ctrl.evaluateGate("mission-1", gate, tasks);

      expect(emitSpy).toHaveBeenCalledWith("quality:gate:failed", expect.objectContaining({
        missionId: "mission-1",
        gateName: "gate-1",
      }));
    });

    it("caches gate evaluation — does not re-evaluate passed gates", () => {
      const gate: MissionQualityGate = {
        name: "gate-1",
        afterTasks: ["Task A"],
        blocksTasks: ["Task B"],
      };
      const tasks = [createDoneTask("Task A")];

      const r1 = ctrl.evaluateGate("mission-1", gate, tasks);
      expect(r1.passed).toBe(true);

      // Even if we change the tasks to fail, the gate is cached
      const r2 = ctrl.evaluateGate("mission-1", gate, []);
      expect(r2.passed).toBe(true);
    });

    it("clearGateCache allows re-evaluation", () => {
      const gate: MissionQualityGate = {
        name: "gate-1",
        afterTasks: ["Task A"],
        blocksTasks: ["Task B"],
      };
      const tasks = [createDoneTask("Task A")];

      ctrl.evaluateGate("mission-1", gate, tasks);
      ctrl.clearGateCache("mission-1");

      // Now with no tasks, it should fail
      const result = ctrl.evaluateGate("mission-1", gate, []);
      expect(result.passed).toBe(false);
    });
  });

  describe("getBlockingGate", () => {
    it("returns undefined when no gate blocks the task", () => {
      const gates: MissionQualityGate[] = [{
        name: "gate-1",
        afterTasks: ["Task A"],
        blocksTasks: ["Task C"],
      }];
      const tasks = [createDoneTask("Task A")];

      const result = ctrl.getBlockingGate("mission-1", "Task B", "id-b", gates, tasks);
      expect(result).toBeUndefined();
    });

    it("returns the blocking gate when task is blocked", () => {
      const gates: MissionQualityGate[] = [{
        name: "gate-1",
        afterTasks: ["Task A"],
        blocksTasks: ["Task B"],
        minScore: 4.0,
      }];
      const tasks = [createDoneTask("Task A", 2.0)];

      const result = ctrl.getBlockingGate("mission-1", "Task B", "id-b", gates, tasks);
      expect(result).toBeDefined();
      expect(result!.gate.name).toBe("gate-1");
      expect(result!.result.passed).toBe(false);
    });
  });

  describe("checkMissionThreshold", () => {
    it("passes when no threshold is configured", () => {
      const mission = createMission();
      const tasks = [createDoneTask("Task A", 2.0)];

      const result = ctrl.checkMissionThreshold(mission, tasks);
      expect(result.passed).toBe(true);
    });

    it("passes when threshold is met", () => {
      const mission = createMission({ qualityThreshold: 3.0 });
      const tasks = [
        createDoneTask("Task A", 4.0),
        createDoneTask("Task B", 3.5),
      ];

      const result = ctrl.checkMissionThreshold(mission, tasks);
      expect(result.passed).toBe(true);
      expect(result.avgScore).toBeCloseTo(3.75);
    });

    it("fails when threshold is not met", () => {
      const mission = createMission({ qualityThreshold: 4.0 });
      const tasks = [
        createDoneTask("Task A", 3.0),
        createDoneTask("Task B", 3.5),
      ];

      const result = ctrl.checkMissionThreshold(mission, tasks);
      expect(result.passed).toBe(false);
      expect(result.avgScore).toBeCloseTo(3.25);
    });

    it("emits quality:threshold:failed event on failure", () => {
      const emitSpy = vi.spyOn(ctx.emitter, "emit");
      const mission = createMission({ qualityThreshold: 4.0 });
      const tasks = [createDoneTask("Task A", 2.0)];

      ctrl.checkMissionThreshold(mission, tasks);

      expect(emitSpy).toHaveBeenCalledWith("quality:threshold:failed", expect.objectContaining({
        missionId: "mission-1",
        threshold: 4.0,
      }));
    });

    it("uses default threshold from settings as fallback", () => {
      const mission = createMission(); // no qualityThreshold
      const tasks = [createDoneTask("Task A", 2.0)];

      const result = ctrl.checkMissionThreshold(mission, tasks, 3.0);
      expect(result.passed).toBe(false);
      expect(result.threshold).toBe(3.0);
    });

    it("applies priority weighting to scores", () => {
      const mission = createMission({ qualityThreshold: 3.5 });
      const tasks = [
        createDoneTask("Task A", 4.0, { priority: 3.0 }),
        createDoneTask("Task B", 2.0, { priority: 1.0 }),
      ];

      const result = ctrl.checkMissionThreshold(mission, tasks);
      // Weighted avg: (4.0*3 + 2.0*1) / (3+1) = 14/4 = 3.5
      expect(result.passed).toBe(true);
      expect(result.avgScore).toBeCloseTo(3.5);
    });

    it("passes when no scored tasks exist", () => {
      const mission = createMission({ qualityThreshold: 4.0 });
      const tasks = [createDoneTask("Task A")]; // no score

      const result = ctrl.checkMissionThreshold(mission, tasks);
      expect(result.passed).toBe(true);
    });
  });

  describe("metrics aggregation via hooks", () => {
    it("records assessment metrics when hook fires", async () => {
      const assessment: AssessmentResult = {
        passed: true,
        checks: [],
        metrics: [],
        globalScore: 4.5,
        timestamp: new Date().toISOString(),
      };

      const task = createTestTask({ id: "t1", assignTo: "agent-a" });

      // Fire the hook
      await ctx.hooks.runAfter("assessment:complete", {
        taskId: "t1",
        task,
        assessment,
        passed: true,
      });

      const m = ctrl.getMetrics("task", "t1");
      expect(m).toBeDefined();
      expect(m!.totalAssessments).toBe(1);
      expect(m!.passedAssessments).toBe(1);
      expect(m!.avgScore).toBe(4.5);

      // Also recorded for agent
      const am = ctrl.getMetrics("agent", "agent-a");
      expect(am).toBeDefined();
      expect(am!.totalAssessments).toBe(1);
    });

    it("records retry metrics when hook fires", async () => {
      const task = createTestTask({ id: "t1", assignTo: "agent-a" });

      await ctx.hooks.runAfter("task:retry", {
        taskId: "t1",
        task,
        attempt: 1,
        maxRetries: 3,
      });

      const m = ctrl.getMetrics("task", "t1");
      expect(m).toBeDefined();
      expect(m!.totalRetries).toBe(1);

      const am = ctrl.getMetrics("agent", "agent-a");
      expect(am!.totalRetries).toBe(1);
    });

    it("records SLA outcomes when task completes", async () => {
      const deadline = new Date(Date.now() + 60_000).toISOString(); // 1 min in future
      const task = createTestTask({ id: "t1", deadline });

      await ctx.hooks.runAfter("task:complete", {
        taskId: "t1",
        task,
      });

      const m = ctrl.getMetrics("task", "t1");
      expect(m).toBeDefined();
      expect(m!.deadlinesMet).toBe(1);
      expect(m!.deadlinesMissed).toBe(0);
    });

    it("getAllMetrics returns all metrics", async () => {
      const assessment: AssessmentResult = {
        passed: true,
        checks: [],
        metrics: [],
        globalScore: 4.0,
        timestamp: new Date().toISOString(),
      };

      const task1 = createTestTask({ id: "t1" });
      const task2 = createTestTask({ id: "t2" });

      await ctx.hooks.runAfter("assessment:complete", { taskId: "t1", task: task1, assessment, passed: true });
      await ctx.hooks.runAfter("assessment:complete", { taskId: "t2", task: task2, assessment, passed: true });

      const all = ctrl.getAllMetrics("task");
      expect(all.length).toBe(2);
    });
  });

  describe("aggregateMissionMetrics", () => {
    it("aggregates metrics from task-level data", async () => {
      const assessment: AssessmentResult = {
        passed: true,
        checks: [],
        metrics: [],
        globalScore: 4.0,
        timestamp: new Date().toISOString(),
      };

      const t1 = createTestTask({ id: "t1" });
      const t2 = createTestTask({ id: "t2" });

      await ctx.hooks.runAfter("assessment:complete", { taskId: "t1", task: t1, assessment, passed: true });
      await ctx.hooks.runAfter("assessment:complete", { taskId: "t2", task: t2, assessment: { ...assessment, globalScore: 3.0 }, passed: false });

      const missionMetrics = ctrl.aggregateMissionMetrics("mission-1", [t1, t2]);
      expect(missionMetrics.totalAssessments).toBe(2);
      expect(missionMetrics.passedAssessments).toBe(1);
      expect(missionMetrics.avgScore).toBeCloseTo(3.5);
    });
  });

  describe("dispose", () => {
    it("clears all internal state", () => {
      const gate: MissionQualityGate = {
        name: "gate-1",
        afterTasks: ["Task A"],
        blocksTasks: ["Task B"],
      };
      ctrl.evaluateGate("mission-1", gate, [createDoneTask("Task A")]);

      ctrl.dispose();

      expect(ctrl.getAllMetrics().length).toBe(0);
      // Gate cache should be cleared — re-evaluation should work
      const result = ctrl.evaluateGate("mission-1", gate, []);
      expect(result.passed).toBe(false); // No tasks = can't pass
    });
  });
});
