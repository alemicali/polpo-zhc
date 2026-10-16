import { describe, expect, test } from "vitest";
import {
  addNode,
  connect,
  disconnect,
  draftFromMission,
  missionFromDraft,
  parseNodeId,
  reconnect,
  removeNodes,
  updateGate,
  updateTask,
  type GraphDraft,
} from "@/lib/playbook-graph-edit";

const T = (index: number) => ({ kind: "task" as const, index });
const CP = (index: number) => ({ kind: "checkpoint" as const, index });

function baseDraft(): GraphDraft {
  return draftFromMission({
    name: "demo",
    team: [{ name: "dev" }],
    tasks: [
      { title: "A", description: "a", assignTo: "dev" },
      { title: "B", description: "b", dependsOn: ["A"] },
      { title: "C", description: "c" },
    ],
    checkpoints: [{ name: "review", afterTasks: ["B"], blocksTasks: ["C"] }],
  });
}

describe("playbook graph editing", () => {
  test("parseNodeId reads the ids produced by the layout", () => {
    expect(parseNodeId("task-3")).toEqual({ kind: "task", index: 3 });
    expect(parseNodeId("delay-0")).toEqual({ kind: "delay", index: 0 });
    expect(parseNodeId("e-1-2")).toBeNull();
  });

  test("task → task connection adds a dependency without mutating the input", () => {
    const draft = baseDraft();
    const result = connect(draft, T(0), T(2));
    expect(result.error).toBeUndefined();
    expect(result.draft!.tasks[2].dependsOn).toEqual(["A"]);
    expect(draft.tasks[2].dependsOn).toBeUndefined();
  });

  test("connections that close a cycle are refused, also through checkpoints", () => {
    const draft = baseDraft();
    expect(connect(draft, T(1), T(0)).error).toMatch(/cycle/);
    // C is blocked by the checkpoint that waits for B, so C → B is a cycle.
    expect(connect(draft, T(2), T(1)).error).toMatch(/cycle/);
    expect(connect(draft, T(0), T(0)).error).toBeDefined();
  });

  test("a connection can be removed, or moved to another node in one edit", () => {
    const draft = baseDraft();
    expect(disconnect(draft, T(0), T(1)).tasks[1].dependsOn).toEqual([]);

    // A → B moved to A → C: B no longer waits for A, C does
    const moved = reconnect(draft, { source: T(0), target: T(1) }, T(0), T(2));
    expect(moved.error).toBeUndefined();
    expect(moved.draft!.tasks[1].dependsOn).toEqual([]);
    expect(moved.draft!.tasks[2].dependsOn).toEqual(["A"]);
    expect(draft.tasks[1].dependsOn).toEqual(["A"]);

    // A move that would close a cycle is refused as a whole: the old connection stays
    const refused = reconnect(draft, { source: T(0), target: T(1) }, T(2), T(1));
    expect(refused.error).toMatch(/cycle/);
    expect(refused.draft).toBeUndefined();
  });

  test("task ↔ checkpoint connections edit afterTasks and blocksTasks", () => {
    const draft = baseDraft();
    const after = connect(draft, T(0), CP(0)).draft!;
    expect(after.checkpoints[0].afterTasks).toEqual(["B", "A"]);
    const removed = disconnect(after, CP(0), T(2));
    expect(removed.checkpoints[0].blocksTasks).toEqual([]);
    expect(connect(draft, CP(0), { kind: "delay", index: 0 }).error).toBeDefined();
  });

  test("renaming a task updates every reference to it", () => {
    const next = updateTask(baseDraft(), 1, { title: "Build" }).draft!;
    expect(next.tasks[1].title).toBe("Build");
    expect(next.checkpoints[0].afterTasks).toEqual(["Build"]);
    expect(updateTask(next, 0, { title: "Build" }).error).toMatch(/already exists/);
    expect(updateTask(next, 0, { title: "  " }).error).toBeDefined();
  });

  test("removing a task strips it from dependencies and gates", () => {
    const next = removeNodes(baseDraft(), [T(1)]);
    expect(next.tasks.map((t) => t.title)).toEqual(["A", "C"]);
    expect(next.checkpoints[0].afterTasks).toEqual([]);
  });

  test("added nodes get unique names", () => {
    let draft = baseDraft();
    draft = addNode(draft, "task").draft;
    draft = addNode(draft, "task").draft;
    draft = addNode(draft, "checkpoint").draft;
    expect(draft.tasks.slice(-2).map((t) => t.title)).toEqual(["New task", "New task 2"]);
    expect(draft.checkpoints.map((c) => c.name)).toEqual(["review", "review-2"]);
    expect(updateGate(draft, "checkpoint", 1, { name: "review" }).error).toMatch(/already exists/);
  });

  test("missionFromDraft adds the dependsOn that checkpoints and delays require", () => {
    // Raccogli → Scrivi → [checkpoint review] → Traduci, drawn only through the checkpoint
    let draft = draftFromMission({
      tasks: [{ title: "Raccogli" }, { title: "Scrivi", dependsOn: ["Raccogli"] }, { title: "Traduci" }],
      checkpoints: [{ name: "review", afterTasks: ["Scrivi"], blocksTasks: ["Traduci"] }],
      delays: [{ name: "wait", afterTasks: ["Raccogli"], blocksTasks: ["Traduci"], duration: "PT1H" }],
    });
    const mission = missionFromDraft({}, draft) as { tasks: { title: string; dependsOn?: string[] }[] };
    expect(mission.tasks[2].dependsOn).toEqual(["Scrivi", "Raccogli"]);
    expect(mission.tasks[1].dependsOn).toEqual(["Raccogli"]);
    // The draft itself is untouched
    expect(draft.tasks[2].dependsOn).toBeUndefined();
    draft = removeNodes(draft, [{ kind: "checkpoint", index: 0 }, { kind: "delay", index: 0 }]);
    expect((missionFromDraft({}, draft) as typeof mission).tasks[2].dependsOn).toBeUndefined();
  });

  test("missionFromDraft keeps other mission fields and drops empty lists", () => {
    const base = { name: "demo", team: [{ name: "dev" }], checkpoints: [], tasks: [] };
    const draft = removeNodes(baseDraft(), [CP(0)]);
    const mission = missionFromDraft(base, draft);
    expect(mission.team).toEqual([{ name: "dev" }]);
    expect(mission).not.toHaveProperty("checkpoints");
    expect(mission).not.toHaveProperty("delays");
    expect((mission.tasks as { title: string }[]).map((t) => t.title)).toEqual(["A", "B", "C"]);
  });
});
