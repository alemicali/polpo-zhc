import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JsonTaskStore } from "../stores/json-task-store.js";
import type { Task } from "../core/types.js";

const TEST_DIR = join(process.cwd(), ".test-orchestra-store");

function makeStore(): JsonTaskStore {
  return new JsonTaskStore(TEST_DIR);
}

async function addSampleTask(store: JsonTaskStore, overrides: Partial<Omit<Task, "id" | "status" | "retries" | "createdAt" | "updatedAt">> = {}): Promise<Task> {
  return store.addTask({
    title: "Sample task",
    description: "Description",
    assignTo: "agent-1",
    dependsOn: [],
    expectations: [],
    metrics: [],
    maxRetries: 2,
    ...overrides,
  });
}

describe("JsonTaskStore", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  describe("addTask", () => {
    it("generates an ID and sets defaults", async () => {
      const store = makeStore();
      const task = await addSampleTask(store);
      expect(task.id).toBeDefined();
      expect(task.id.length).toBeGreaterThan(0);
      expect(task.status).toBe("pending");
      expect(task.retries).toBe(0);
      expect(task.createdAt).toBeDefined();
      expect(task.updatedAt).toBeDefined();
    });

    it("persists to file", async () => {
      const store = makeStore();
      await addSampleTask(store);
      const statePath = join(TEST_DIR, "state.json");
      expect(existsSync(statePath)).toBe(true);
      const raw = readFileSync(statePath, "utf-8");
      const state = JSON.parse(raw);
      expect(state.tasks).toHaveLength(1);
    });
  });

  describe("getTask", () => {
    it("returns task by ID", async () => {
      const store = makeStore();
      const created = await addSampleTask(store);
      const found = await store.getTask(created.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
    });

    it("returns undefined for missing ID", async () => {
      const store = makeStore();
      expect(await store.getTask("nonexistent")).toBeUndefined();
    });
  });

  describe("getAllTasks", () => {
    it("returns all tasks", async () => {
      const store = makeStore();
      await addSampleTask(store, { title: "Task 1" });
      await addSampleTask(store, { title: "Task 2" });
      expect(await store.getAllTasks()).toHaveLength(2);
    });
  });

  describe("updateTask", () => {
    it("modifies fields and updates timestamp", async () => {
      const store = makeStore();
      const task = await addSampleTask(store);
      // Small delay to ensure timestamp difference
      const updated = await store.updateTask(task.id, { description: "Updated" });
      expect(updated.description).toBe("Updated");
      expect(updated.title).toBe("Sample task"); // unchanged
    });

    it("throws for missing task", async () => {
      const store = makeStore();
      await expect(store.updateTask("nope", { title: "x" })).rejects.toThrow("Task not found");
    });
  });

  describe("removeTask", () => {
    it("removes by ID and returns true", async () => {
      const store = makeStore();
      const task = await addSampleTask(store);
      expect(await store.removeTask(task.id)).toBe(true);
      expect(await store.getAllTasks()).toHaveLength(0);
    });

    it("returns false for missing ID", async () => {
      const store = makeStore();
      expect(await store.removeTask("nope")).toBe(false);
    });
  });

  describe("removeTasks", () => {
    it("removes tasks matching filter", async () => {
      const store = makeStore();
      await addSampleTask(store, { title: "Keep" });
      await addSampleTask(store, { title: "Remove" });
      await addSampleTask(store, { title: "Remove too" });
      const removed = await store.removeTasks(t => t.title.startsWith("Remove"));
      expect(removed).toBe(2);
      expect(await store.getAllTasks()).toHaveLength(1);
      expect((await store.getAllTasks())[0].title).toBe("Keep");
    });
  });

  describe("transition", () => {
    it("follows valid path: pending → assigned → in_progress → review → done", async () => {
      const store = makeStore();
      const task = await addSampleTask(store);
      await store.transition(task.id, "assigned");
      await store.transition(task.id, "in_progress");
      await store.transition(task.id, "review");
      await store.transition(task.id, "done");
      expect((await store.getTask(task.id))!.status).toBe("done");
    });

    it("throws on invalid transition", async () => {
      const store = makeStore();
      const task = await addSampleTask(store);
      await expect(store.transition(task.id, "done")).rejects.toThrow("Invalid transition");
    });

    it("increments retries on failed → pending", async () => {
      const store = makeStore();
      const task = await addSampleTask(store);
      await store.transition(task.id, "assigned");
      await store.transition(task.id, "in_progress");
      await store.transition(task.id, "failed");
      expect((await store.getTask(task.id))!.retries).toBe(0);
      await store.transition(task.id, "pending");
      expect((await store.getTask(task.id))!.retries).toBe(1);
    });

    it("throws for missing task", async () => {
      const store = makeStore();
      await expect(store.transition("nope", "assigned")).rejects.toThrow("Task not found");
    });
  });

  describe("setState / getState", () => {
    it("merges partial state", async () => {
      const store = makeStore();
      await store.setState({ org: "test-project" });
      expect((await store.getState()).org).toBe("test-project");
    });
  });

  describe("persistence", () => {
    it("loads existing state from file", async () => {
      const store1 = makeStore();
      await addSampleTask(store1, { title: "Persisted" });

      // Create a new store instance reading the same directory
      const store2 = makeStore();
      expect(await store2.getAllTasks()).toHaveLength(1);
      expect((await store2.getAllTasks())[0].title).toBe("Persisted");
    });

    it("returns empty state when file is missing", async () => {
      rmSync(TEST_DIR, { recursive: true });
      mkdirSync(TEST_DIR, { recursive: true });
      const store = makeStore();
      expect(await store.getAllTasks()).toHaveLength(0);
    });
  });
});
