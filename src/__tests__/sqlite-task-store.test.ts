import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteTaskStore } from "../stores/sqlite-task-store.js";
import type { Task, PolpoState } from "../core/types.js";

const TEST_DIR = join(process.cwd(), ".test-orchestra-sqlite");

function makeStore(): SqliteTaskStore {
  return new SqliteTaskStore(TEST_DIR);
}

async function addSampleTask(store: SqliteTaskStore, overrides: Partial<Omit<Task, "id" | "status" | "retries" | "createdAt" | "updatedAt">> = {}): Promise<Task> {
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
    it("generates an ID and sets defaults", async () => {
      const store = makeStore();
      const task = await addSampleTask(store);
      expect(task.id).toBeDefined();
      expect(task.id.length).toBeGreaterThan(0);
      expect(task.status).toBe("pending");
      expect(task.retries).toBe(0);
      expect(task.createdAt).toBeDefined();
      expect(task.updatedAt).toBeDefined();
      store.close();
    });

    it("persists to SQLite database", async () => {
      const store = makeStore();
      await addSampleTask(store);
      const dbPath = join(TEST_DIR, "state.db");
      expect(existsSync(dbPath)).toBe(true);
      store.close();
    });
  });

  describe("getTask", () => {
    it("returns task by ID", async () => {
      const store = makeStore();
      const created = await addSampleTask(store);
      const found = await store.getTask(created.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
      store.close();
    });

    it("returns undefined for missing ID", async () => {
      const store = makeStore();
      expect(await store.getTask("nonexistent")).toBeUndefined();
      store.close();
    });
  });

  describe("getAllTasks", () => {
    it("returns all tasks", async () => {
      const store = makeStore();
      await addSampleTask(store, { title: "Task 1" });
      await addSampleTask(store, { title: "Task 2" });
      expect(await store.getAllTasks()).toHaveLength(2);
      store.close();
    });
  });

  describe("updateTask", () => {
    it("modifies fields and updates timestamp", async () => {
      const store = makeStore();
      const task = await addSampleTask(store);
      const updated = await store.updateTask(task.id, { description: "Updated" });
      expect(updated.description).toBe("Updated");
      expect(updated.title).toBe("Sample task"); // unchanged
      store.close();
    });

    it("throws for missing task", async () => {
      const store = makeStore();
      await expect(store.updateTask("nope", { title: "x" })).rejects.toThrow("Task not found");
      store.close();
    });
  });

  describe("removeTask", () => {
    it("removes by ID and returns true", async () => {
      const store = makeStore();
      const task = await addSampleTask(store);
      expect(await store.removeTask(task.id)).toBe(true);
      expect(await store.getAllTasks()).toHaveLength(0);
      store.close();
    });

    it("returns false for missing ID", async () => {
      const store = makeStore();
      expect(await store.removeTask("nope")).toBe(false);
      store.close();
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
      store.close();
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
      store.close();
    });

    it("throws on invalid transition", async () => {
      const store = makeStore();
      const task = await addSampleTask(store);
      await expect(store.transition(task.id, "done")).rejects.toThrow("Invalid transition");
      store.close();
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
      store.close();
    });

    it("throws for missing task", async () => {
      const store = makeStore();
      await expect(store.transition("nope", "assigned")).rejects.toThrow("Task not found");
      store.close();
    });
  });

  describe("setState / getState", () => {
    it("merges partial state", async () => {
      const store = makeStore();
      await store.setState({ project: "test-project" });
      expect((await store.getState()).project).toBe("test-project");
      store.close();
    });

    it("persists team as JSON", async () => {
      const store = makeStore();
      const team = { name: "test-team", agents: [{ name: "dev", role: "dev" }] };
      await store.setState({ teams: [team] });
      const state = await store.getState();
      expect(state.teams[0].name).toBe("test-team");
      expect(state.teams[0].agents).toHaveLength(1);
      expect(state.teams[0].agents[0].name).toBe("dev");
      store.close();
    });

    it("persists and retrieves processes", async () => {
      const store = makeStore();
      const processes = [{
        agentName: "dev",
        pid: 1234,
        taskId: "task-1",
        startedAt: new Date().toISOString(),
        alive: true,
        activity: { toolCalls: 5, filesCreated: [], filesEdited: [], lastUpdate: new Date().toISOString() },
      }];
      await store.setState({ processes });
      const state = await store.getState();
      expect(state.processes).toHaveLength(1);
      expect(state.processes[0].agentName).toBe("dev");
      expect(state.processes[0].alive).toBe(true);
      expect(state.processes[0].activity.toolCalls).toBe(5);
      store.close();
    });
  });

  describe("persistence", () => {
    it("loads existing state after close and reopen", async () => {
      const store1 = makeStore();
      await addSampleTask(store1, { title: "Persisted" });
      store1.close();

      const store2 = makeStore();
      expect(await store2.getAllTasks()).toHaveLength(1);
      expect((await store2.getAllTasks())[0].title).toBe("Persisted");
      store2.close();
    });

    it("returns empty state when DB is fresh", async () => {
      rmSync(TEST_DIR, { recursive: true });
      mkdirSync(TEST_DIR, { recursive: true });
      const store = makeStore();
      expect(await store.getAllTasks()).toHaveLength(0);
      store.close();
    });
  });

  describe("JSON migration", () => {
    it("auto-migrates from state.json on first open", async () => {
      const jsonState: PolpoState = {
        project: "migrated-project",
        team: { name: "old-team", agents: [{ name: "dev" }] },
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

      expect((await store.getState()).project).toBe("migrated-project");
      expect((await store.getState()).teams[0].name).toBe("old-team");
      expect(await store.getAllTasks()).toHaveLength(1);
      expect((await store.getAllTasks())[0].title).toBe("Migrated task");
      expect((await store.getAllTasks())[0].result?.exitCode).toBe(0);

      // Original file should be renamed
      expect(existsSync(join(TEST_DIR, "state.json"))).toBe(false);
      expect(existsSync(join(TEST_DIR, "state.json.migrated"))).toBe(true);
      store.close();
    });
  });

  describe("SQLite-specific", () => {
    it("uses WAL journal mode", async () => {
      const store = makeStore();
      // WAL files should exist after first write
      await addSampleTask(store);
      const walPath = join(TEST_DIR, "state.db-wal");
      expect(existsSync(walPath)).toBe(true);
      store.close();
    });

    it("handles nested JSON fields roundtrip", async () => {
      const store = makeStore();
      const task = await store.addTask({
        title: "Complex task",
        description: "With nested data",
        assignTo: "dev",
        dependsOn: ["dep-1", "dep-2"],
        expectations: [{ type: "test", command: "npm test" }, { type: "file_exists", paths: ["/foo/bar.ts"] }],
        metrics: [{ name: "coverage", command: "npm run cov", threshold: 80 }],
        maxRetries: 3,
      });

      const retrieved = (await store.getTask(task.id))!;
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
