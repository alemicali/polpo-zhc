import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Orchestrator } from "../core/orchestrator.js";
import { SqliteTaskStore } from "../stores/sqlite-task-store.js";
import { InMemoryRunStore, createTestAgent } from "./fixtures.js";

const TEST_DIR = join(process.cwd(), ".test-polpo-mission-resume");

describe("Mission resume (Orchestrator)", () => {
  let store: SqliteTaskStore;
  let runStore: InMemoryRunStore;
  let orchestrator: Orchestrator;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });

    store = new SqliteTaskStore(TEST_DIR);
    runStore = new InMemoryRunStore();

    orchestrator = new Orchestrator({
      workDir: TEST_DIR,
      store,
      runStore,
      assessFn: async () => ({
        passed: true,
        checks: [],
        metrics: [],
        timestamp: new Date().toISOString(),
      }),
    });

    await orchestrator.initInteractive("test-project", {
      name: "test-team",
      agents: [createTestAgent({ name: "dev" })],
    });
  });

  afterEach(() => {
    store.close();
    runStore.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  describe("getResumableMissions", () => {
    it("returns empty array when no missions exist", () => {
      expect(orchestrator.getResumableMissions()).toEqual([]);
    });

    it("returns empty array for draft missions", () => {
      orchestrator.saveMission({ data: JSON.stringify({ tasks: [{ title: "T1", assignTo: "dev" }] }), status: "draft" });
      expect(orchestrator.getResumableMissions()).toEqual([]);
    });

    it("returns empty array for completed missions", () => {
      const mission = orchestrator.saveMission({ data: JSON.stringify({ tasks: [{ title: "T1", assignTo: "dev" }] }), status: "draft" });
      orchestrator.updateMission(mission.id, { status: "completed" });
      expect(orchestrator.getResumableMissions()).toEqual([]);
    });

    it("returns active mission with pending tasks", () => {
      const data = JSON.stringify({ tasks: [{ title: "Task1", description: "Do something", assignTo: "dev" }] });
      const mission = orchestrator.saveMission({ data });
      orchestrator.executeMission(mission.id);

      const resumable = orchestrator.getResumableMissions();
      // After execution, tasks start as pending — mission is resumable
      expect(resumable.length).toBe(1);
      expect(resumable[0].id).toBe(mission.id);
    });

    it("returns failed mission with failed tasks", () => {
      const data = JSON.stringify({ tasks: [{ title: "FailTask", description: "Will fail", assignTo: "dev" }] });
      const mission = orchestrator.saveMission({ data });
      orchestrator.executeMission(mission.id);

      // Manually fail the task
      const state = store.getState();
      const task = state.tasks.find(t => t.group === mission.name);
      expect(task).toBeDefined();
      store.transition(task!.id, "assigned");
      store.transition(task!.id, "in_progress");
      store.transition(task!.id, "review");
      store.transition(task!.id, "failed");
      orchestrator.updateMission(mission.id, { status: "failed" });

      const resumable = orchestrator.getResumableMissions();
      expect(resumable.length).toBe(1);
      expect(resumable[0].name).toBe(mission.name);
    });

    it("excludes cancelled missions", () => {
      const data = JSON.stringify({ tasks: [{ title: "T", description: "d", assignTo: "dev" }] });
      const mission = orchestrator.saveMission({ data });
      orchestrator.executeMission(mission.id);
      orchestrator.updateMission(mission.id, { status: "cancelled" });

      expect(orchestrator.getResumableMissions()).toEqual([]);
    });
  });

  describe("resumeMission", () => {
    it("throws for non-existent mission", () => {
      expect(() => orchestrator.resumeMission("nonexistent")).toThrow("Mission not found");
    });

    it("resumes a failed mission and retries failed tasks", () => {
      const data = JSON.stringify({ tasks: [{ title: "ResumableTask", description: "Will be resumed", assignTo: "dev" }] });
      const mission = orchestrator.saveMission({ data });
      orchestrator.executeMission(mission.id);

      // Fail the task
      const state = store.getState();
      const task = state.tasks.find(t => t.group === mission.name)!;
      store.transition(task.id, "assigned");
      store.transition(task.id, "in_progress");
      store.transition(task.id, "review");
      store.transition(task.id, "failed");
      orchestrator.updateMission(mission.id, { status: "failed" });

      const result = orchestrator.resumeMission(mission.id, { retryFailed: true });
      expect(result.retried).toBe(1);

      // Mission should be back to active
      const updated = orchestrator.getMission(mission.id);
      expect(updated?.status).toBe("active");

      // Task should be back to pending
      const taskAfter = store.getTask(task.id);
      expect(taskAfter?.status).toBe("pending");
    });

    it("resumes without retrying when retryFailed is false", () => {
      const data = JSON.stringify({ tasks: [{ title: "NoRetryTask", description: "d", assignTo: "dev" }] });
      const mission = orchestrator.saveMission({ data });
      orchestrator.executeMission(mission.id);

      const state = store.getState();
      const task = state.tasks.find(t => t.group === mission.name)!;
      store.transition(task.id, "assigned");
      store.transition(task.id, "in_progress");
      store.transition(task.id, "review");
      store.transition(task.id, "failed");
      orchestrator.updateMission(mission.id, { status: "failed" });

      const result = orchestrator.resumeMission(mission.id, { retryFailed: false });
      expect(result.retried).toBe(0);

      // Task stays failed
      const taskAfter = store.getTask(task.id);
      expect(taskAfter?.status).toBe("failed");
    });

    it("emits mission:resumed event", () => {
      const data = JSON.stringify({ tasks: [{ title: "EventTask", description: "d", assignTo: "dev" }] });
      const mission = orchestrator.saveMission({ data });
      orchestrator.executeMission(mission.id);
      orchestrator.updateMission(mission.id, { status: "failed" });

      // Fail the task
      const task = store.getState().tasks.find(t => t.group === mission.name)!;
      store.transition(task.id, "assigned");
      store.transition(task.id, "in_progress");
      store.transition(task.id, "review");
      store.transition(task.id, "failed");

      let event: any;
      orchestrator.on("mission:resumed", (e) => { event = e; });

      orchestrator.resumeMission(mission.id, { retryFailed: true });
      expect(event).toBeDefined();
      expect(event.missionId).toBe(mission.id);
      expect(event.retried).toBe(1);
    });
  });
});
