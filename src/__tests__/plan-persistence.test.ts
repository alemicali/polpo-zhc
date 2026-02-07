import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SqliteTaskStore } from "../stores/sqlite-task-store.js";

const TEST_DIR = join(process.cwd(), ".test-orchestra-plans");

function makeStore(): SqliteTaskStore {
  return new SqliteTaskStore(TEST_DIR);
}

describe("Plan Persistence (SqliteTaskStore)", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  describe("savePlan", () => {
    it("creates a plan with generated ID and timestamps", () => {
      const store = makeStore();
      const plan = store.savePlan({
        name: "plan-1",
        yaml: "tasks:\n  - title: Test",
        prompt: "Build a test",
        status: "draft",
      });
      expect(plan.id).toBeDefined();
      expect(plan.id.length).toBeGreaterThan(0);
      expect(plan.name).toBe("plan-1");
      expect(plan.status).toBe("draft");
      expect(plan.yaml).toContain("tasks:");
      expect(plan.prompt).toBe("Build a test");
      expect(plan.createdAt).toBeDefined();
      expect(plan.updatedAt).toBeDefined();
      store.close();
    });

    it("saves without prompt", () => {
      const store = makeStore();
      const plan = store.savePlan({
        name: "plan-1",
        yaml: "tasks:\n  - title: Test",
        status: "draft",
      });
      expect(plan.prompt).toBeUndefined();
      store.close();
    });

    it("enforces unique name", () => {
      const store = makeStore();
      store.savePlan({ name: "plan-1", yaml: "a", status: "draft" });
      expect(() => store.savePlan({ name: "plan-1", yaml: "b", status: "draft" }))
        .toThrow();
      store.close();
    });
  });

  describe("getPlan", () => {
    it("returns plan by ID", () => {
      const store = makeStore();
      const created = store.savePlan({ name: "p1", yaml: "y", status: "draft" });
      const found = store.getPlan(created.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
      expect(found!.name).toBe("p1");
      store.close();
    });

    it("returns undefined for missing ID", () => {
      const store = makeStore();
      expect(store.getPlan("nonexistent")).toBeUndefined();
      store.close();
    });
  });

  describe("getPlanByName", () => {
    it("returns plan by name", () => {
      const store = makeStore();
      const created = store.savePlan({ name: "my-plan", yaml: "y", status: "draft" });
      const found = store.getPlanByName("my-plan");
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
      store.close();
    });

    it("returns undefined for missing name", () => {
      const store = makeStore();
      expect(store.getPlanByName("nope")).toBeUndefined();
      store.close();
    });
  });

  describe("getAllPlans", () => {
    it("returns all plans", () => {
      const store = makeStore();
      store.savePlan({ name: "p1", yaml: "a", status: "draft" });
      store.savePlan({ name: "p2", yaml: "b", status: "active" });
      store.savePlan({ name: "p3", yaml: "c", status: "completed" });
      const plans = store.getAllPlans();
      expect(plans).toHaveLength(3);
      const names = plans.map(p => p.name).sort();
      expect(names).toEqual(["p1", "p2", "p3"]);
      store.close();
    });
  });

  describe("updatePlan", () => {
    it("updates yaml", () => {
      const store = makeStore();
      const plan = store.savePlan({ name: "p1", yaml: "old", status: "draft" });
      const updated = store.updatePlan(plan.id, { yaml: "new yaml" });
      expect(updated.yaml).toBe("new yaml");
      expect(updated.name).toBe("p1"); // unchanged
      store.close();
    });

    it("updates status", () => {
      const store = makeStore();
      const plan = store.savePlan({ name: "p1", yaml: "y", status: "draft" });
      const updated = store.updatePlan(plan.id, { status: "active" });
      expect(updated.status).toBe("active");
      store.close();
    });

    it("updates name", () => {
      const store = makeStore();
      const plan = store.savePlan({ name: "old-name", yaml: "y", status: "draft" });
      const updated = store.updatePlan(plan.id, { name: "new-name" });
      expect(updated.name).toBe("new-name");
      store.close();
    });

    it("throws for missing plan", () => {
      const store = makeStore();
      expect(() => store.updatePlan("nope", { yaml: "x" })).toThrow("Plan not found");
      store.close();
    });
  });

  describe("deletePlan", () => {
    it("deletes and returns true", () => {
      const store = makeStore();
      const plan = store.savePlan({ name: "p1", yaml: "y", status: "draft" });
      expect(store.deletePlan(plan.id)).toBe(true);
      expect(store.getAllPlans()).toHaveLength(0);
      store.close();
    });

    it("returns false for missing plan", () => {
      const store = makeStore();
      expect(store.deletePlan("nope")).toBe(false);
      store.close();
    });
  });

  describe("nextPlanName", () => {
    it("returns plan-1 for empty store", () => {
      const store = makeStore();
      expect(store.nextPlanName()).toBe("plan-1");
      store.close();
    });

    it("increments based on count", () => {
      const store = makeStore();
      store.savePlan({ name: "plan-1", yaml: "a", status: "draft" });
      expect(store.nextPlanName()).toBe("plan-2");
      store.savePlan({ name: "plan-2", yaml: "b", status: "active" });
      expect(store.nextPlanName()).toBe("plan-3");
      store.close();
    });
  });

  describe("plan status lifecycle", () => {
    it("supports draft → active → completed", () => {
      const store = makeStore();
      const plan = store.savePlan({ name: "p1", yaml: "y", status: "draft" });
      expect(plan.status).toBe("draft");

      const active = store.updatePlan(plan.id, { status: "active" });
      expect(active.status).toBe("active");

      const completed = store.updatePlan(plan.id, { status: "completed" });
      expect(completed.status).toBe("completed");
      store.close();
    });

    it("supports draft → active → failed", () => {
      const store = makeStore();
      const plan = store.savePlan({ name: "p1", yaml: "y", status: "draft" });
      store.updatePlan(plan.id, { status: "active" });
      const failed = store.updatePlan(plan.id, { status: "failed" });
      expect(failed.status).toBe("failed");
      store.close();
    });

    it("supports active → cancelled", () => {
      const store = makeStore();
      const plan = store.savePlan({ name: "p1", yaml: "y", status: "active" });
      const cancelled = store.updatePlan(plan.id, { status: "cancelled" });
      expect(cancelled.status).toBe("cancelled");
      store.close();
    });
  });

  describe("persistence", () => {
    it("survives close and reopen", () => {
      const store1 = makeStore();
      store1.savePlan({ name: "persistent", yaml: "tasks:\n  - hi", status: "draft", prompt: "test" });
      store1.close();

      const store2 = makeStore();
      const plans = store2.getAllPlans();
      expect(plans).toHaveLength(1);
      expect(plans[0].name).toBe("persistent");
      expect(plans[0].prompt).toBe("test");
      store2.close();
    });
  });
});
