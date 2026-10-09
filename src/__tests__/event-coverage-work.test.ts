import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../core/orchestrator.js";
import { TypedEmitter, withEventOrigin, compactForLog } from "../core/events.js";
import type { Team } from "../core/types.js";

const TEAM: Team = { name: "t", agents: [{ name: "dev", role: "developer" }] };

/** Collect every event the orchestrator emits while `fn` runs. */
async function recording(o: Orchestrator, fn: () => Promise<unknown>): Promise<Array<{ event: string; data: any }>> {
  const seen: Array<{ event: string; data: any }> = [];
  const original = o.emit.bind(o);
  (o as unknown as { emit: (...a: unknown[]) => boolean }).emit = (event: unknown, ...args: unknown[]) => {
    const result = (original as (...a: unknown[]) => boolean)(event, ...args);
    seen.push({ event: String(event), data: args[0] });
    return result;
  };
  try { await fn(); } finally { (o as unknown as { emit: unknown }).emit = original; }
  return seen;
}

const MISSION_DOC = JSON.stringify({ tasks: [{ title: "First", description: "do it", assignTo: "dev" }] });

describe("work events (phase 2 of the bus coverage)", () => {
  let dir: string;
  let o: Orchestrator;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "polpo-events-work-"));
    await mkdir(join(dir, ".polpo"), { recursive: true });
    o = new Orchestrator({ workDir: dir });
    await o.initInteractive("events", JSON.parse(JSON.stringify(TEAM)));
  });

  afterAll(async () => {
    try { await o.gracefulStop(200); } catch { /* already stopped */ }
    await rm(dir, { recursive: true, force: true });
  });

  it("every task field change emits task:updated with the fields, from one place", async () => {
    const task = await o.addTask({ title: "Write", description: "d", assignTo: "dev" });
    const events = await recording(o, async () => {
      await o.getStore().updateTask(task.id, { description: "new", maxRetries: 5 });
    });
    const updated = events.filter((e) => e.event === "task:updated");
    expect(updated).toHaveLength(1);
    expect(updated[0]!.data).toMatchObject({ taskId: task.id, fields: ["description", "maxRetries"] });
    expect(updated[0]!.data.task.description).toBe("new");
  });

  it("removals emit task:removed, single and in bulk", async () => {
    const a = await o.addTask({ title: "A", description: "d", assignTo: "dev", group: "g-bulk" });
    const b = await o.addTask({ title: "B", description: "d", assignTo: "dev", group: "g-bulk" });
    const c = await o.addTask({ title: "C", description: "d", assignTo: "dev" });
    const events = await recording(o, async () => {
      await o.getStore().removeTasks((t) => t.group === "g-bulk");
      await o.getStore().removeTask(c.id);
    });
    const removed = events.filter((e) => e.event === "task:removed").map((e) => e.data);
    expect(removed.map((r) => r.taskId).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(removed.find((r) => r.taskId === a.id)).toMatchObject({ title: "A", group: "g-bulk" });
  });

  it("retry, kill and force-fail say what happened", async () => {
    const t = await o.addTask({ title: "Flaky", description: "d", assignTo: "dev" });
    const events = await recording(o, async () => {
      await o.killTask(t.id);
      await o.retryTask(t.id);
      await o.forceFailTask(t.id, "manual");
    });
    const names = events.map((e) => e.event);
    expect(names).toContain("task:killed");
    expect(names).toContain("task:retried");
    expect(events.find((e) => e.event === "task:force-failed")!.data).toMatchObject({ taskId: t.id, title: "Flaky", reason: "manual" });
  });

  it("missions: created, edited inside (section/action/item), status changes", async () => {
    let missionId = "";
    const events = await recording(o, async () => {
      const m = await o.saveMission({ data: MISSION_DOC, name: "m-events" });
      missionId = m.id;
      await o.addMissionTask(m.id, { title: "Second", description: "more", assignTo: "dev" });
      await o.updateMission(m.id, { status: "paused" });
    });
    expect(events.find((e) => e.event === "mission:created")!.data).toMatchObject({ missionId, name: "m-events" });
    const updates = events.filter((e) => e.event === "mission:updated").map((e) => e.data);
    expect(updates).toContainEqual(expect.objectContaining({ missionId, section: "task", action: "added", item: "Second" }));
    expect(updates).toContainEqual(expect.objectContaining({ missionId, fields: ["status"], status: "paused", prevStatus: "draft" }));
  });

  it("schedules: updated, paused and removed are announced", async () => {
    const scheduler = o.getScheduler()!;
    const m = await o.saveMission({ data: MISSION_DOC, name: "m-sched", status: "recurring" });
    const mission = await o.updateMission(m.id, { schedule: "0 3 * * *" });
    const events = await recording(o, async () => {
      scheduler.registerMission(mission);
      scheduler.rescheduleMission({ ...mission, schedule: "0 4 * * *" });
      scheduler.setEnabled(m.id, false);
      scheduler.unregisterMission(m.id);
    });
    expect(events.map((e) => e.event).filter((n) => n.startsWith("schedule:"))).toEqual([
      "schedule:created", "schedule:updated", "schedule:updated", "schedule:removed",
    ]);
    expect(events.find((e) => e.event === "schedule:updated")!.data).toMatchObject({ expression: "0 4 * * *", enabled: true });
  });

  it("playbooks announce their changes", async () => {
    const store = o.getPlaybookStore();
    const definition = { name: "pb-events", description: "x", mission: { tasks: [{ title: "T", description: "d", assignTo: "dev" }] } };
    const events = await recording(o, async () => {
      await store.save(definition as never);
      await store.save(definition as never);
      await store.delete("pb-events");
    });
    expect(events.filter((e) => e.event === "playbook:changed").map((e) => e.data.action)).toEqual(["created", "updated", "deleted"]);
  });
});

describe("event origin", () => {
  it("events carry who caused them; nested origins keep the person", () => {
    const emitter = new TypedEmitter();
    const seen: any[] = [];
    emitter.on("task:removed", (p) => seen.push(p));
    emitter.emit("task:removed", { taskId: "t0" });
    withEventOrigin({ source: "api", by: "ale@example.com" }, () => {
      emitter.emit("task:removed", { taskId: "t1" });
      withEventOrigin({ source: "polpo" }, () => emitter.emit("task:removed", { taskId: "t2" }));
      withEventOrigin({ source: "agent", by: "dev" }, () => emitter.emit("task:removed", { taskId: "t3", source: "system" }));
    });
    expect(seen).toEqual([
      { taskId: "t0" },
      { taskId: "t1", source: "api", by: "ale@example.com" },
      { taskId: "t2", source: "polpo", by: "ale@example.com" },
      { taskId: "t3", source: "system" },
    ]);
  });

  it("follows awaits", async () => {
    const emitter = new TypedEmitter();
    const seen: any[] = [];
    emitter.on("task:removed", (p) => seen.push(p));
    await withEventOrigin({ source: "schedule" }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      emitter.emit("task:removed", { taskId: "later" });
    });
    expect(seen).toEqual([{ taskId: "later", source: "schedule" }]);
  });

  it("the log keeps a compact task and drops team snapshots", () => {
    const task = { id: "t1", title: "T", status: "done", assignTo: "dev", group: "g", result: { stdout: "x".repeat(1000) }, description: "long" };
    expect(compactForLog({ taskId: "t1", task })).toEqual({ taskId: "t1", task: { id: "t1", title: "T", status: "done", assignTo: "dev", group: "g", missionId: undefined } });
    expect(compactForLog({ agentName: "a", agents: [1], teams: [2], timestamp: "x" })).toEqual({ agentName: "a", timestamp: "x" });
    expect(compactForLog("plain")).toBe("plain");
  });
});
