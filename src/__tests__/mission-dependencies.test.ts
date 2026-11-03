import { describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMissionDocument, dependencyOrder } from "@polpo-ai/core";
import { TypedEmitter } from "../core/events.js";
import { MissionExecutor } from "../core/mission-executor.js";
import { TaskManager } from "../core/task-manager.js";
import { AgentManager } from "../core/agent-manager.js";
import { HookRegistry } from "../core/hooks.js";
import type { OrchestratorContext } from "../core/orchestrator-context.js";
import type { Mission, PolpoConfig } from "../core/types.js";
import { InMemoryTaskStore, InMemoryRunStore, createMockStores } from "./fixtures.js";

const task = (title: string, dependsOn?: string[]) => ({ title, description: title, ...(dependsOn ? { dependsOn } : {}) });

describe("dependsOn in a mission document", () => {
  test("a task may depend on one listed after it", () => {
    expect(() => parseMissionDocument({ tasks: [task("B", ["A"]), task("A")] })).not.toThrow();
  });

  test("an unknown task is an error, not a link dropped in silence", () => {
    expect(() => parseMissionDocument({ tasks: [task("A"), task("B", ["Z"])] }))
      .toThrow('tasks.1.dependsOn: dependsOn references unknown task "Z"');
  });

  test("a cycle is an error (its tasks would never start)", () => {
    expect(() => parseMissionDocument({ tasks: [task("A", ["C"]), task("B", ["A"]), task("C", ["B"])] }))
      .toThrow('dependsOn forms a cycle: "A" → "C" → "B" → "A"');
    expect(() => parseMissionDocument({ tasks: [task("A", ["A"])] })).toThrow('dependsOn forms a cycle: "A" → "A"');
  });

  test("dependencyOrder puts dependencies first and keeps the listed order otherwise", () => {
    const order = dependencyOrder([task("D", ["B"]), task("A"), task("B", ["C"]), task("C"), task("E")]);
    expect(order.map((t) => t.title)).toEqual(["A", "C", "B", "D", "E"]);
  });
});

describe("a mission whose tasks are listed before their dependencies", () => {
  function executor() {
    const store = new InMemoryTaskStore();
    const missions = new Map<string, Mission>();
    const registry = Object.assign(store, {
      saveMission: async (opts: { name: string; data: string }) => {
        const mission = { id: "m1", name: opts.name, data: opts.data, status: "draft", createdAt: "", updatedAt: "" } as Mission;
        missions.set(mission.id, mission);
        return mission;
      },
      getMission: async (id: string) => missions.get(id),
      getMissionByName: async (name: string) => [...missions.values()].find((m) => m.name === name),
      getAllMissions: async () => [...missions.values()],
      updateMission: async (id: string, updates: Partial<Mission>) => Object.assign(missions.get(id)!, updates),
      nextMissionName: async () => "mission-1",
    });
    const config: PolpoConfig = { version: "1", project: "test", teams: [{ name: "team", agents: [{ name: "dev" }] }], tasks: [], settings: { maxRetries: 2, workDir: "/tmp/test", logLevel: "quiet" } };
    const { teamStore, agentStore } = createMockStores(config.teams);
    const tmp = mkdtempSync(join(tmpdir(), "polpo-deps-mission-"));
    const ctx = {
      emitter: new TypedEmitter(), registry, runStore: new InMemoryRunStore(), hooks: new HookRegistry(), config, teamStore, agentStore,
      memoryStore: { exists: async () => false, get: async () => "", save: async () => {}, append: async () => {}, update: async () => true },
      workDir: tmp, agentWorkDir: tmp, polpoDir: tmp, assessFn: vi.fn(),
    } as unknown as OrchestratorContext;
    return { exec: new MissionExecutor(ctx, new TaskManager(ctx), new AgentManager(ctx)), store, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
  }

  test("keeps every link: the dependent waits for its dependency", async () => {
    const h = executor();
    try {
      await h.exec.ready;
      const mission = await h.exec.saveMission({
        name: "disegno",
        data: JSON.stringify({ tasks: [task("crea il disegno", ["crea una frase"]), task("crea una frase"), task("riassumi", ["crea il disegno", "crea una frase"])] }),
      });
      await h.exec.executeMission(mission.id);
      const tasks = await h.store.getAllTasks();
      const id = (title: string) => tasks.find((t) => t.title === title)!.id;
      const deps = (title: string) => tasks.find((t) => t.title === title)!.dependsOn;
      expect(deps("crea il disegno")).toEqual([id("crea una frase")]);
      expect(deps("riassumi")).toEqual([id("crea il disegno"), id("crea una frase")]);
      expect(deps("crea una frase")).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("renaming a task keeps the links that point to it", async () => {
    const h = executor();
    try {
      await h.exec.ready;
      const mission = await h.exec.saveMission({
        name: "rinomina",
        data: JSON.stringify({
          tasks: [task("A"), task("B", ["A"])],
          checkpoints: [{ name: "ok", afterTasks: ["A"], blocksTasks: ["B"] }],
        }),
      });
      const updated = await h.exec.updateMissionTask(mission.id, "A", { title: "A2" });
      const doc = JSON.parse(updated.data);
      expect(doc.tasks[1].dependsOn).toEqual(["A2"]);
      expect(doc.checkpoints[0].afterTasks).toEqual(["A2"]);
    } finally {
      h.cleanup();
    }
  });
});
