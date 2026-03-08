import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createSqliteStores } from "@polpo/drizzle";
import { ensureSqliteSchema } from "../core/drizzle-sqlite-schema.js";
import type { TaskStore } from "../core/task-store.js";

let sqlite: InstanceType<typeof Database>;

function makeStore(): TaskStore {
  sqlite = new Database(":memory:");
  ensureSqliteSchema(sqlite);
  const db = drizzle(sqlite);
  return createSqliteStores(db).taskStore;
}

describe("Mission Persistence (Drizzle SQLite)", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = makeStore();
  });

  afterEach(() => {
    sqlite.close();
  });

  describe("saveMission", () => {
    it("creates a mission with generated ID and timestamps", async () => {
      const mission = await store.saveMission!({
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
    });

    it("saves without prompt", async () => {
      const mission = await store.saveMission!({
        name: "mission-1",
        data: JSON.stringify({ tasks: [{ title: "Test" }] }),
        status: "draft",
      });
      expect(mission.prompt).toBeUndefined();
    });

    it("enforces unique name", async () => {
      await store.saveMission!({ name: "mission-1", data: "a", status: "draft" });
      await expect(store.saveMission!({ name: "mission-1", data: "b", status: "draft" }))
        .rejects.toThrow();
    });
  });

  describe("getMission", () => {
    it("returns mission by ID", async () => {
      const created = await store.saveMission!({ name: "p1", data: "d", status: "draft" });
      const found = await store.getMission!(created.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
      expect(found!.name).toBe("p1");
    });

    it("returns undefined for missing ID", async () => {
      expect(await store.getMission!("nonexistent")).toBeUndefined();
    });
  });

  describe("getMissionByName", () => {
    it("returns mission by name", async () => {
      const created = await store.saveMission!({ name: "my-mission", data: "d", status: "draft" });
      const found = await store.getMissionByName!("my-mission");
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
    });

    it("returns undefined for missing name", async () => {
      expect(await store.getMissionByName!("nope")).toBeUndefined();
    });
  });

  describe("getAllMissions", () => {
    it("returns all missions", async () => {
      await store.saveMission!({ name: "p1", data: "a", status: "draft" });
      await store.saveMission!({ name: "p2", data: "b", status: "active" });
      await store.saveMission!({ name: "p3", data: "c", status: "completed" });
      const missions = await store.getAllMissions!();
      expect(missions).toHaveLength(3);
      const names = missions.map(p => p.name).sort();
      expect(names).toEqual(["p1", "p2", "p3"]);
    });
  });

  describe("updateMission", () => {
    it("updates data", async () => {
      const mission = await store.saveMission!({ name: "p1", data: "old", status: "draft" });
      const updated = await store.updateMission!(mission.id, { data: "new data" });
      expect(updated.data).toBe("new data");
      expect(updated.name).toBe("p1");
    });

    it("updates status", async () => {
      const mission = await store.saveMission!({ name: "p1", data: "d", status: "draft" });
      const updated = await store.updateMission!(mission.id, { status: "active" });
      expect(updated.status).toBe("active");
    });

    it("updates name", async () => {
      const mission = await store.saveMission!({ name: "old-name", data: "d", status: "draft" });
      const updated = await store.updateMission!(mission.id, { name: "new-name" });
      expect(updated.name).toBe("new-name");
    });

    it("throws for missing mission", async () => {
      await expect(store.updateMission!("nope", { data: "x" })).rejects.toThrow("not found");
    });
  });

  describe("deleteMission", () => {
    it("deletes and returns true", async () => {
      const mission = await store.saveMission!({ name: "p1", data: "d", status: "draft" });
      expect(await store.deleteMission!(mission.id)).toBe(true);
      expect(await store.getAllMissions!()).toHaveLength(0);
    });

    it("returns false for missing mission", async () => {
      expect(await store.deleteMission!("nope")).toBe(false);
    });
  });

  describe("nextMissionName", () => {
    it("returns mission-1 for empty store", async () => {
      expect(await store.nextMissionName!()).toBe("mission-1");
    });

    it("increments based on count", async () => {
      await store.saveMission!({ name: "mission-1", data: "a", status: "draft" });
      expect(await store.nextMissionName!()).toBe("mission-2");
      await store.saveMission!({ name: "mission-2", data: "b", status: "active" });
      expect(await store.nextMissionName!()).toBe("mission-3");
    });
  });

  describe("mission status lifecycle", () => {
    it("supports draft → active → completed", async () => {
      const mission = await store.saveMission!({ name: "p1", data: "d", status: "draft" });
      expect(mission.status).toBe("draft");

      const active = await store.updateMission!(mission.id, { status: "active" });
      expect(active.status).toBe("active");

      const completed = await store.updateMission!(mission.id, { status: "completed" });
      expect(completed.status).toBe("completed");
    });

    it("supports draft → active → failed", async () => {
      const mission = await store.saveMission!({ name: "p1", data: "d", status: "draft" });
      await store.updateMission!(mission.id, { status: "active" });
      const failed = await store.updateMission!(mission.id, { status: "failed" });
      expect(failed.status).toBe("failed");
    });

    it("supports active → cancelled", async () => {
      const mission = await store.saveMission!({ name: "p1", data: "d", status: "active" });
      const cancelled = await store.updateMission!(mission.id, { status: "cancelled" });
      expect(cancelled.status).toBe("cancelled");
    });
  });
});
