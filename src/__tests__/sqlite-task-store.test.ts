import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteTaskStore } from "../stores/sqlite-task-store.js";
import type { Task, PolpoState } from "../core/types.js";

const TEST_DIR = join(process.cwd(), ".test-orchestra-sqlite");

function makeStore(): SqliteTaskStore {
  return new SqliteTaskStore(TEST_DIR);
}

function addSampleTask(store: SqliteTaskStore, overrides: Partial<Omit<Task, "id" | "status" | "retries" | "createdAt" | "updatedAt">> = {}): Task {
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

describe("SqliteTaskStore", () => {
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
      store.close();
    });

    it("persists to SQLite database", () => {
      const store = makeStore();
      addSampleTask(store);
      const dbPath = join(TEST_DIR, "state.db");
      expect(existsSync(dbPath)).toBe(true);
      store.close();
    });
  });

  describe("getTask", () => {
    it("returns task by ID", () => {
      const store = makeStore();
      const created = addSampleTask(store);
      const found = store.getTask(created.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
      store.close();
    });

    it("returns undefined for missing ID", () => {
      const store = makeStore();
      expect(store.getTask("nonexistent")).toBeUndefined();
      store.close();
    });
  });

  describe("getAllTasks", () => {
    it("returns all tasks", () => {
      const store = makeStore();
      addSampleTask(store, { title: "Task 1" });
      addSampleTask(store, { title: "Task 2" });
      expect(store.getAllTasks()).toHaveLength(2);
      store.close();
    });
  });

  describe("updateTask", () => {
    it("modifies fields and updates timestamp", () => {
      const store = makeStore();
      const task = addSampleTask(store);
      const updated = store.updateTask(task.id, { description: "Updated" });
      expect(updated.description).toBe("Updated");
      expect(updated.title).toBe("Sample task"); // unchanged
      store.close();
    });

    it("throws for missing task", () => {
      const store = makeStore();
      expect(() => store.updateTask("nope", { title: "x" })).toThrow("Task not found");
      store.close();
    });
  });

  describe("removeTask", () => {
    it("removes by ID and returns true", () => {
      const store = makeStore();
      const task = addSampleTask(store);
      expect(store.removeTask(task.id)).toBe(true);
      expect(store.getAllTasks()).toHaveLength(0);
      store.close();
    });

    it("returns false for missing ID", () => {
      const store = makeStore();
      expect(store.removeTask("nope")).toBe(false);
      store.close();
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
      store.close();
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
      store.close();
    });

    it("throws on invalid transition", () => {
      const store = makeStore();
      const task = addSampleTask(store);
      expect(() => store.transition(task.id, "done")).toThrow("Invalid transition");
      store.close();
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
      store.close();
    });

    it("throws for missing task", () => {
      const store = makeStore();
      expect(() => store.transition("nope", "assigned")).toThrow("Task not found");
      store.close();
    });
  });

  describe("setState / getState", () => {
    it("merges partial state", () => {
      const store = makeStore();
      store.setState({ project: "test-project" });
      expect(store.getState().project).toBe("test-project");
      store.close();
    });

    it("persists team as JSON", () => {
      const store = makeStore();
      const team = { name: "test-team", agents: [{ name: "dev", adapter: "claude-sdk", role: "dev" }] };
      store.setState({ team });
      const state = store.getState();
      expect(state.team.name).toBe("test-team");
      expect(state.team.agents).toHaveLength(1);
      expect(state.team.agents[0].name).toBe("dev");
      store.close();
    });

    it("persists and retrieves processes", () => {
      const store = makeStore();
      const processes = [{
        agentName: "dev",
        pid: 1234,
        taskId: "task-1",
        startedAt: new Date().toISOString(),
        alive: true,
        activity: { toolCalls: 5, filesCreated: [], filesEdited: [], lastUpdate: new Date().toISOString() },
      }];
      store.setState({ processes });
      const state = store.getState();
      expect(state.processes).toHaveLength(1);
      expect(state.processes[0].agentName).toBe("dev");
      expect(state.processes[0].alive).toBe(true);
      expect(state.processes[0].activity.toolCalls).toBe(5);
      store.close();
    });
  });

  describe("persistence", () => {
    it("loads existing state after close and reopen", () => {
      const store1 = makeStore();
      addSampleTask(store1, { title: "Persisted" });
      store1.close();

      const store2 = makeStore();
      expect(store2.getAllTasks()).toHaveLength(1);
      expect(store2.getAllTasks()[0].title).toBe("Persisted");
      store2.close();
    });

    it("returns empty state when DB is fresh", () => {
      rmSync(TEST_DIR, { recursive: true });
      mkdirSync(TEST_DIR, { recursive: true });
      const store = makeStore();
      expect(store.getAllTasks()).toHaveLength(0);
      store.close();
    });
  });

  describe("JSON migration", () => {
    it("auto-migrates from state.json on first open", () => {
      const jsonState: PolpoState = {
        project: "migrated-project",
        team: { name: "old-team", agents: [{ name: "dev", adapter: "generic" }] },
        tasks: [{
          id: "old-task-1",
          title: "Migrated task",
          description: "From JSON",
          assignTo: "dev",
          dependsOn: [],
          status: "done",
          expectations: [],
          metrics: [],
          retries: 0,
          maxRetries: 2,
          result: { exitCode: 0, stdout: "ok", stderr: "", duration: 100 },
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:01:00.000Z",
        }],
        processes: [],
        startedAt: "2025-01-01T00:00:00.000Z",
      };

      writeFileSync(join(TEST_DIR, "state.json"), JSON.stringify(jsonState, null, 2));
      const store = makeStore();

      expect(store.getState().project).toBe("migrated-project");
      expect(store.getState().team.name).toBe("old-team");
      expect(store.getAllTasks()).toHaveLength(1);
      expect(store.getAllTasks()[0].title).toBe("Migrated task");
      expect(store.getAllTasks()[0].result?.exitCode).toBe(0);

      // Original file should be renamed
      expect(existsSync(join(TEST_DIR, "state.json"))).toBe(false);
      expect(existsSync(join(TEST_DIR, "state.json.migrated"))).toBe(true);
      store.close();
    });
  });

  describe("SQLite-specific", () => {
    it("uses WAL journal mode", () => {
      const store = makeStore();
      // WAL files should exist after first write
      addSampleTask(store);
      const walPath = join(TEST_DIR, "state.db-wal");
      expect(existsSync(walPath)).toBe(true);
      store.close();
    });

    it("handles nested JSON fields roundtrip", () => {
      const store = makeStore();
      const task = store.addTask({
        title: "Complex task",
        description: "With nested data",
        assignTo: "dev",
        dependsOn: ["dep-1", "dep-2"],
        expectations: [{ type: "test", command: "npm test" }, { type: "file_exists", paths: ["/foo/bar.ts"] }],
        metrics: [{ name: "coverage", command: "npm run cov", threshold: 80 }],
        maxRetries: 3,
      });

      const retrieved = store.getTask(task.id)!;
      expect(retrieved.dependsOn).toEqual(["dep-1", "dep-2"]);
      expect(retrieved.expectations).toHaveLength(2);
      expect(retrieved.expectations[0].type).toBe("test");
      expect(retrieved.expectations[1].paths).toEqual(["/foo/bar.ts"]);
      expect(retrieved.metrics[0].threshold).toBe(80);
      expect(retrieved.maxRetries).toBe(3);
      store.close();
    });
  });
});
