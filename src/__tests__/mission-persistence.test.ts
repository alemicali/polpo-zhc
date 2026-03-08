import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SqliteTaskStore } from "../stores/sqlite-task-store.js";

const TEST_DIR = join(process.cwd(), ".test-orchestra-missions");

function makeStore(): SqliteTaskStore {
  return new SqliteTaskStore(TEST_DIR);
}

describe("Mission Persistence (SqliteTaskStore)", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  describe("saveMission", () => {
    it("creates a mission with generated ID and timestamps", async () => {
      const store = makeStore();
      const mission = await store.saveMission({
        name: "mission-1",
        data: JSON.stringify({ tasks: [{ title: "Test" }] }),
        prompt: "Build a test",
        status: "draft",
      });
      expect(mission.id).toBeDefined();
      expect(mission.id.length).toBeGreaterThan(0);
      expect(mission.name).toBe("mission-1");
      expect(mission.status).toBe("draft");
      expect(mission.data).toContain("tasks");
      expect(mission.prompt).toBe("Build a test");
      expect(mission.createdAt).toBeDefined();
      expect(mission.updatedAt).toBeDefined();
      store.close();
    });

    it("saves without prompt", async () => {
      const store = makeStore();
      const mission = await store.saveMission({
        name: "mission-1",
        data: JSON.stringify({ tasks: [{ title: "Test" }] }),
        status: "draft",
      });
      expect(mission.prompt).toBeUndefined();
      store.close();
    });

    it("enforces unique name", async () => {
      const store = makeStore();
      await store.saveMission({ name: "mission-1", data: "a", status: "draft" });
      await expect(store.saveMission({ name: "mission-1", data: "b", status: "draft" }))
        .rejects.toThrow();
      store.close();
    });
  });

  describe("getMission", () => {
    it("returns mission by ID", async () => {
      const store = makeStore();
      const created = await store.saveMission({ name: "p1", data: "d", status: "draft" });
      const found = await store.getMission(created.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
      expect(found!.name).toBe("p1");
      store.close();
    });

    it("returns undefined for missing ID", async () => {
      const store = makeStore();
      expect(await store.getMission("nonexistent")).toBeUndefined();
      store.close();
    });
  });

  describe("getMissionByName", () => {
    it("returns mission by name", async () => {
      const store = makeStore();
      const created = await store.saveMission({ name: "my-mission", data: "d", status: "draft" });
      const found = await store.getMissionByName("my-mission");
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
      store.close();
    });

    it("returns undefined for missing name", async () => {
      const store = makeStore();
      expect(await store.getMissionByName("nope")).toBeUndefined();
      store.close();
    });
  });

  describe("getAllMissions", () => {
    it("returns all missions", async () => {
      const store = makeStore();
      await store.saveMission({ name: "p1", data: "a", status: "draft" });
      await store.saveMission({ name: "p2", data: "b", status: "active" });
      await store.saveMission({ name: "p3", data: "c", status: "completed" });
      const missions = await store.getAllMissions();
      expect(missions).toHaveLength(3);
      const names = missions.map(p => p.name).sort();
      expect(names).toEqual(["p1", "p2", "p3"]);
      store.close();
    });
  });

  describe("updateMission", () => {
    it("updates data", async () => {
      const store = makeStore();
      const mission = await store.saveMission({ name: "p1", data: "old", status: "draft" });
      const updated = await store.updateMission(mission.id, { data: "new data" });
      expect(updated.data).toBe("new data");
      expect(updated.name).toBe("p1"); // unchanged
      store.close();
    });

    it("updates status", async () => {
      const store = makeStore();
      const mission = await store.saveMission({ name: "p1", data: "d", status: "draft" });
      const updated = await store.updateMission(mission.id, { status: "active" });
      expect(updated.status).toBe("active");
      store.close();
    });

    it("updates name", async () => {
      const store = makeStore();
      const mission = await store.saveMission({ name: "old-name", data: "d", status: "draft" });
      const updated = await store.updateMission(mission.id, { name: "new-name" });
      expect(updated.name).toBe("new-name");
      store.close();
    });

    it("throws for missing mission", async () => {
      const store = makeStore();
      await expect(store.updateMission("nope", { data: "x" })).rejects.toThrow("Mission not found");
      store.close();
    });
  });

  describe("deleteMission", () => {
    it("deletes and returns true", async () => {
      const store = makeStore();
      const mission = await store.saveMission({ name: "p1", data: "d", status: "draft" });
      expect(await store.deleteMission(mission.id)).toBe(true);
      expect(await store.getAllMissions()).toHaveLength(0);
      store.close();
    });

    it("returns false for missing mission", async () => {
      const store = makeStore();
      expect(await store.deleteMission("nope")).toBe(false);
      store.close();
    });
  });

  describe("nextMissionName", () => {
    it("returns mission-1 for empty store", async () => {
      const store = makeStore();
      expect(await store.nextMissionName()).toBe("mission-1");
      store.close();
    });

    it("increments based on count", async () => {
      const store = makeStore();
      await store.saveMission({ name: "mission-1", data: "a", status: "draft" });
      expect(await store.nextMissionName()).toBe("mission-2");
      await store.saveMission({ name: "mission-2", data: "b", status: "active" });
      expect(await store.nextMissionName()).toBe("mission-3");
      store.close();
    });
  });

  describe("mission status lifecycle", () => {
    it("supports draft → active → completed", async () => {
      const store = makeStore();
      const mission = await store.saveMission({ name: "p1", data: "d", status: "draft" });
      expect(mission.status).toBe("draft");

      const active = await store.updateMission(mission.id, { status: "active" });
      expect(active.status).toBe("active");

      const completed = await store.updateMission(mission.id, { status: "completed" });
      expect(completed.status).toBe("completed");
      store.close();
    });

    it("supports draft → active → failed", async () => {
      const store = makeStore();
      const mission = await store.saveMission({ name: "p1", data: "d", status: "draft" });
      await store.updateMission(mission.id, { status: "active" });
      const failed = await store.updateMission(mission.id, { status: "failed" });
      expect(failed.status).toBe("failed");
      store.close();
    });

    it("supports active → cancelled", async () => {
      const store = makeStore();
      const mission = await store.saveMission({ name: "p1", data: "d", status: "active" });
      const cancelled = await store.updateMission(mission.id, { status: "cancelled" });
      expect(cancelled.status).toBe("cancelled");
      store.close();
    });
  });

  describe("persistence", () => {
    it("survives close and reopen", async () => {
      const store1 = makeStore();
      await store1.saveMission({ name: "persistent", data: JSON.stringify({ tasks: [{ title: "hi" }] }), status: "draft", prompt: "test" });
      store1.close();

      const store2 = makeStore();
      const missions = await store2.getAllMissions();
      expect(missions).toHaveLength(1);
      expect(missions[0].name).toBe("persistent");
      expect(missions[0].prompt).toBe("test");
      store2.close();
    });
  });
});
