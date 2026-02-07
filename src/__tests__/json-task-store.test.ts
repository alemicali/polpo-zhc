import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JsonTaskStore } from "../stores/json-task-store.js";
import type { Task } from "../core/types.js";

const TEST_DIR = join(process.cwd(), ".test-orchestra-store");

function makeStore(): JsonTaskStore {
  return new JsonTaskStore(TEST_DIR);
}

function addSampleTask(store: JsonTaskStore, overrides: Partial<Omit<Task, "id" | "status" | "retries" | "createdAt" | "updatedAt">> = {}): Task {
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
    it("generates an ID and sets defaults", () => {
      const store = makeStore();
      const task = addSampleTask(store);
      expect(task.id).toBeDefined();
      expect(task.id.length).toBeGreaterThan(0);
      expect(task.status).toBe("pending");
      expect(task.retries).toBe(0);
      expect(task.createdAt).toBeDefined();
      expect(task.updatedAt).toBeDefined();
    });

    it("persists to file", () => {
      const store = makeStore();
      addSampleTask(store);
      const statePath = join(TEST_DIR, "state.json");
      expect(existsSync(statePath)).toBe(true);
      const raw = readFileSync(statePath, "utf-8");
      const state = JSON.parse(raw);
      expect(state.tasks).toHaveLength(1);
    });
  });

  describe("getTask", () => {
    it("returns task by ID", () => {
      const store = makeStore();
      const created = addSampleTask(store);
      const found = store.getTask(created.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
    });

    it("returns undefined for missing ID", () => {
      const store = makeStore();
      expect(store.getTask("nonexistent")).toBeUndefined();
    });
  });

  describe("getAllTasks", () => {
    it("returns all tasks", () => {
      const store = makeStore();
      addSampleTask(store, { title: "Task 1" });
      addSampleTask(store, { title: "Task 2" });
      expect(store.getAllTasks()).toHaveLength(2);
    });
  });

  describe("updateTask", () => {
    it("modifies fields and updates timestamp", () => {
      const store = makeStore();
      const task = addSampleTask(store);
      // Small delay to ensure timestamp difference
      const updated = store.updateTask(task.id, { description: "Updated" });
      expect(updated.description).toBe("Updated");
      expect(updated.title).toBe("Sample task"); // unchanged
    });

    it("throws for missing task", () => {
      const store = makeStore();
      expect(() => store.updateTask("nope", { title: "x" })).toThrow("Task not found");
    });
  });

  describe("removeTask", () => {
    it("removes by ID and returns true", () => {
      const store = makeStore();
      const task = addSampleTask(store);
      expect(store.removeTask(task.id)).toBe(true);
      expect(store.getAllTasks()).toHaveLength(0);
    });

    it("returns false for missing ID", () => {
      const store = makeStore();
      expect(store.removeTask("nope")).toBe(false);
    });
  });

  describe("removeTasks", () => {
    it("removes tasks matching filter", () => {
      const store = makeStore();
      addSampleTask(store, { title: "Keep" });
      addSampleTask(store, { title: "Remove" });
      addSampleTask(store, { title: "Remove too" });
      const removed = store.removeTasks(t => t.title.startsWith("Remove"));
      expect(removed).toBe(2);
      expect(store.getAllTasks()).toHaveLength(1);
      expect(store.getAllTasks()[0].title).toBe("Keep");
    });
  });

  describe("transition", () => {
    it("follows valid path: pending → assigned → in_progress → review → done", () => {
      const store = makeStore();
      const task = addSampleTask(store);
      store.transition(task.id, "assigned");
      store.transition(task.id, "in_progress");
      store.transition(task.id, "review");
      store.transition(task.id, "done");
      expect(store.getTask(task.id)!.status).toBe("done");
    });

    it("throws on invalid transition", () => {
      const store = makeStore();
      const task = addSampleTask(store);
      expect(() => store.transition(task.id, "done")).toThrow("Invalid transition");
    });

    it("increments retries on failed → pending", () => {
      const store = makeStore();
      const task = addSampleTask(store);
      store.transition(task.id, "assigned");
      store.transition(task.id, "in_progress");
      store.transition(task.id, "failed");
      expect(store.getTask(task.id)!.retries).toBe(0);
      store.transition(task.id, "pending");
      expect(store.getTask(task.id)!.retries).toBe(1);
    });

    it("throws for missing task", () => {
      const store = makeStore();
      expect(() => store.transition("nope", "assigned")).toThrow("Task not found");
    });
  });

  describe("setState / getState", () => {
    it("merges partial state", () => {
      const store = makeStore();
      store.setState({ project: "test-project" });
      expect(store.getState().project).toBe("test-project");
    });
  });

  describe("persistence", () => {
    it("loads existing state from file", () => {
      const store1 = makeStore();
      addSampleTask(store1, { title: "Persisted" });

      // Create a new store instance reading the same directory
      const store2 = makeStore();
      expect(store2.getAllTasks()).toHaveLength(1);
      expect(store2.getAllTasks()[0].title).toBe("Persisted");
    });

    it("returns empty state when file is missing", () => {
      rmSync(TEST_DIR, { recursive: true });
      mkdirSync(TEST_DIR, { recursive: true });
      const store = makeStore();
      expect(store.getAllTasks()).toHaveLength(0);
    });
  });
});
