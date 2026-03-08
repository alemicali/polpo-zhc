import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createSqliteStores } from "@polpo-ai/drizzle";
import { ensureSqliteSchema } from "../core/drizzle-sqlite-schema.js";
import { Orchestrator } from "../core/orchestrator.js";
import type { TaskStore } from "../core/task-store.js";
import { InMemoryRunStore, createTestAgent } from "./fixtures.js";

const TEST_DIR = join(process.cwd(), ".test-polpo-mission-resume");

describe("Mission resume (Orchestrator)", () => {
  let sqlite: InstanceType<typeof Database>;
  let store: TaskStore;
  let runStore: InMemoryRunStore;
  let orchestrator: Orchestrator;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });

    sqlite = new Database(join(TEST_DIR, "state.db"));
    sqlite.exec("PRAGMA journal_mode = WAL");
    sqlite.exec("PRAGMA foreign_keys = ON");
    ensureSqliteSchema(sqlite);
    const db = drizzle(sqlite);
    store = createSqliteStores(db).taskStore;
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
    sqlite.close();
    runStore.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  describe("getResumableMissions", () => {
    it("returns empty array when no missions exist", async () => {
      expect(await orchestrator.getResumableMissions()).toEqual([]);
    });

    it("returns empty array for draft missions", async () => {
      await orchestrator.saveMission({ data: JSON.stringify({ tasks: [{ title: "T1", assignTo: "dev" }] }), status: "draft" });
      expect(await orchestrator.getResumableMissions()).toEqual([]);
    });

    it("returns empty array for completed missions", async () => {
      const mission = await orchestrator.saveMission({ data: JSON.stringify({ tasks: [{ title: "T1", assignTo: "dev" }] }), status: "draft" });
      await orchestrator.updateMission(mission.id, { status: "completed" });
      expect(await orchestrator.getResumableMissions()).toEqual([]);
    });

    it("returns active mission with pending tasks", async () => {
      const data = JSON.stringify({ tasks: [{ title: "Task1", description: "Do something", assignTo: "dev" }] });
      const mission = await orchestrator.saveMission({ data });
      await orchestrator.executeMission(mission.id);

      const resumable = await orchestrator.getResumableMissions();
      // After execution, tasks start as pending — mission is resumable
      expect(resumable.length).toBe(1);
      expect(resumable[0].id).toBe(mission.id);
    });

    it("returns failed mission with failed tasks", async () => {
      const data = JSON.stringify({ tasks: [{ title: "FailTask", description: "Will fail", assignTo: "dev" }] });
      const mission = await orchestrator.saveMission({ data });
      await orchestrator.executeMission(mission.id);

      // Manually fail the task
      const state = await store.getState();
      const task = state.tasks.find(t => t.group === mission.name);
      expect(task).toBeDefined();
      await store.transition(task!.id, "assigned");
      await store.transition(task!.id, "in_progress");
      await store.transition(task!.id, "review");
      await store.transition(task!.id, "failed");
      await orchestrator.updateMission(mission.id, { status: "failed" });

      const resumable = await orchestrator.getResumableMissions();
      expect(resumable.length).toBe(1);
      expect(resumable[0].name).toBe(mission.name);
    });

    it("excludes cancelled missions", async () => {
      const data = JSON.stringify({ tasks: [{ title: "T", description: "d", assignTo: "dev" }] });
      const mission = await orchestrator.saveMission({ data });
      await orchestrator.executeMission(mission.id);
      await orchestrator.updateMission(mission.id, { status: "cancelled" });

      expect(await orchestrator.getResumableMissions()).toEqual([]);
    });
  });

  describe("resumeMission", () => {
    it("throws for non-existent mission", async () => {
      await expect(orchestrator.resumeMission("nonexistent")).rejects.toThrow("Mission not found");
    });

    it("resumes a failed mission and retries failed tasks", async () => {
      const data = JSON.stringify({ tasks: [{ title: "ResumableTask", description: "Will be resumed", assignTo: "dev" }] });
      const mission = await orchestrator.saveMission({ data });
      await orchestrator.executeMission(mission.id);

      // Fail the task
      const state = await store.getState();
      const task = state.tasks.find(t => t.group === mission.name)!;
      await store.transition(task.id, "assigned");
      await store.transition(task.id, "in_progress");
      await store.transition(task.id, "review");
      await store.transition(task.id, "failed");
      await orchestrator.updateMission(mission.id, { status: "failed" });

      const result = await orchestrator.resumeMission(mission.id, { retryFailed: true });
      expect(result.retried).toBe(1);

      // Mission should be back to active
      const updated = await orchestrator.getMission(mission.id);
      expect(updated?.status).toBe("active");

      // Task should be back to pending
      const taskAfter = await store.getTask(task.id);
      expect(taskAfter?.status).toBe("pending");
    });

    it("resumes without retrying when retryFailed is false", async () => {
      const data = JSON.stringify({ tasks: [{ title: "NoRetryTask", description: "d", assignTo: "dev" }] });
      const mission = await orchestrator.saveMission({ data });
      await orchestrator.executeMission(mission.id);

      const state = await store.getState();
      const task = state.tasks.find(t => t.group === mission.name)!;
      await store.transition(task.id, "assigned");
      await store.transition(task.id, "in_progress");
      await store.transition(task.id, "review");
      await store.transition(task.id, "failed");
      await orchestrator.updateMission(mission.id, { status: "failed" });

      const result = await orchestrator.resumeMission(mission.id, { retryFailed: false });
      expect(result.retried).toBe(0);

      // Task stays failed
      const taskAfter = await store.getTask(task.id);
      expect(taskAfter?.status).toBe("failed");
    });

    it("emits mission:resumed event", async () => {
      const data = JSON.stringify({ tasks: [{ title: "EventTask", description: "d", assignTo: "dev" }] });
      const mission = await orchestrator.saveMission({ data });
      await orchestrator.executeMission(mission.id);
      await orchestrator.updateMission(mission.id, { status: "failed" });

      // Fail the task
      const task = (await store.getState()).tasks.find(t => t.group === mission.name)!;
      await store.transition(task.id, "assigned");
      await store.transition(task.id, "in_progress");
      await store.transition(task.id, "review");
      await store.transition(task.id, "failed");

      let event: any;
      orchestrator.on("mission:resumed", (e) => { event = e; });

      await orchestrator.resumeMission(mission.id, { retryFailed: true });
      expect(event).toBeDefined();
      expect(event.missionId).toBe(mission.id);
      expect(event.retried).toBe(1);
    });
  });
});
