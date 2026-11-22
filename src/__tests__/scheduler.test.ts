import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Scheduler } from "../scheduling/scheduler.js";
import { parseCron, matchesCron, nextCronOccurrence, isCronExpression, scheduleExpressionProblem } from "../scheduling/cron.js";
import { HookRegistry } from "../core/hooks.js";
import { TypedEmitter } from "../core/events.js";
import { InMemoryTaskStore, InMemoryRunStore } from "./fixtures.js";
import type { OrchestratorContext } from "../core/orchestrator-context.js";
import type { PolpoConfig, Mission } from "../core/types.js";

// ── Helpers ──────────────────────────────────────────

function createMinimalConfig(): PolpoConfig {
  return {
    version: "1",
    project: "test",
    teams: [{ name: "test-team", agents: [{ name: "test-agent" }] }],
    tasks: [],
    settings: { maxRetries: 2, workDir: "/tmp/test", logLevel: "quiet" },
  };
}

/** InMemoryTaskStore with mission support */
class MissionAwareStore extends InMemoryTaskStore {
  private missions = new Map<string, Mission>();
  private missionCounter = 0;

  async saveMission(opts: { name: string; data: string; prompt?: string; status: string }): Promise<Mission> {
    const mission: Mission = {
      id: `mission-${++this.missionCounter}`,
      name: opts.name,
      data: opts.data,
      prompt: opts.prompt,
      status: opts.status as any,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.missions.set(mission.id, mission);
    return mission;
  }

  async getMission(missionId: string): Promise<Mission | undefined> {
    return this.missions.get(missionId);
  }

  async getMissionByName(name: string): Promise<Mission | undefined> {
    return [...this.missions.values()].find(p => p.name === name);
  }

  async getAllMissions(): Promise<Mission[]> {
    return [...this.missions.values()];
  }

  async updateMission(missionId: string, updates: Partial<Mission>): Promise<Mission> {
    const mission = this.missions.get(missionId);
    if (!mission) throw new Error("Mission not found");
    Object.assign(mission, updates, { updatedAt: new Date().toISOString() });
    return mission;
  }

  async deleteMission(missionId: string): Promise<boolean> {
    return this.missions.delete(missionId);
  }
}

function createMockCtx(store?: MissionAwareStore): OrchestratorContext {
  return {
    emitter: new TypedEmitter(),
    registry: store ?? new MissionAwareStore(),
    runStore: new InMemoryRunStore(),
    memoryStore: { exists: async () => false, get: async () => "", save: async () => {}, append: async () => {}, update: async () => true as const },
    logStore: { startSession: async () => "s", getSessionId: async () => "s", append: async () => {}, getSessionEntries: async () => [], listSessions: async () => [], prune: async () => 0, close: () => {} },
    sessionStore: { create: async () => "s1", addMessage: async () => ({ id: "m1", role: "user" as const, content: "", ts: "" }), updateMessage: async () => false, getMessages: async () => [], getRecentMessages: async () => [], listSessions: async () => [], getSession: async () => undefined, getLatestSession: async () => undefined, renameSession: async () => false, setStarred: async () => false, deleteSession: async () => false, prune: async () => 0, close: () => {} },
    hooks: new HookRegistry(),
    config: createMinimalConfig(),
    workDir: "/tmp/test",
    agentWorkDir: "/tmp/test",
    polpoDir: "/tmp/test/.polpo",
    assessFn: vi.fn(),
  };
}

// ── Cron Parser Tests ────────────────────────────────

describe("Cron Parser", () => {
  describe("parseCron", () => {
    it("parses wildcard expression", () => {
      const cron = parseCron("* * * * *");
      expect(cron.minute.values.size).toBe(60);
      expect(cron.hour.values.size).toBe(24);
    });

    it("parses specific values", () => {
      const cron = parseCron("30 2 15 6 3");
      expect(cron.minute.values.has(30)).toBe(true);
      expect(cron.minute.values.size).toBe(1);
      expect(cron.hour.values.has(2)).toBe(true);
      expect(cron.dayOfMonth.values.has(15)).toBe(true);
      expect(cron.month.values.has(6)).toBe(true);
      expect(cron.dayOfWeek.values.has(3)).toBe(true);
    });

    it("parses ranges", () => {
      const cron = parseCron("1-5 * * * *");
      expect(cron.minute.values.has(1)).toBe(true);
      expect(cron.minute.values.has(5)).toBe(true);
      expect(cron.minute.values.has(6)).toBe(false);
      expect(cron.minute.values.size).toBe(5);
    });

    it("parses lists", () => {
      const cron = parseCron("1,15,30,45 * * * *");
      expect(cron.minute.values.size).toBe(4);
      expect(cron.minute.values.has(1)).toBe(true);
      expect(cron.minute.values.has(15)).toBe(true);
      expect(cron.minute.values.has(30)).toBe(true);
      expect(cron.minute.values.has(45)).toBe(true);
    });

    it("parses steps with wildcard", () => {
      const cron = parseCron("*/15 * * * *");
      expect(cron.minute.values.has(0)).toBe(true);
      expect(cron.minute.values.has(15)).toBe(true);
      expect(cron.minute.values.has(30)).toBe(true);
      expect(cron.minute.values.has(45)).toBe(true);
      expect(cron.minute.values.has(5)).toBe(false);
    });

    it("parses steps with ranges", () => {
      const cron = parseCron("1-10/3 * * * *");
      expect(cron.minute.values.has(1)).toBe(true);
      expect(cron.minute.values.has(4)).toBe(true);
      expect(cron.minute.values.has(7)).toBe(true);
      expect(cron.minute.values.has(10)).toBe(true);
      expect(cron.minute.values.has(2)).toBe(false);
    });

    it("normalizes day-of-week 7 to 0 (Sunday)", () => {
      const cron = parseCron("* * * * 7");
      expect(cron.dayOfWeek.values.has(0)).toBe(true);
      expect(cron.dayOfWeek.values.has(7)).toBe(false);
    });

    it("throws on invalid expression", () => {
      expect(() => parseCron("* * *")).toThrow("expected 5 fields");
    });

    it("is strict: out-of-range values, a step of 0 and backwards ranges are errors (live: '99 99 * * *' was accepted and never ran)", () => {
      expect(() => parseCron("99 99 * * *")).toThrow(/minute "99": 99 is not between 0 and 59/);
      expect(() => parseCron("0 24 * * *")).toThrow(/hour "24": 24 is not between 0 and 23/);
      expect(() => parseCron("*/0 * * * *")).toThrow(/step must be at least 1/);
      expect(() => parseCron("0 9 * * 5-1")).toThrow(/goes backwards/);
      expect(() => parseCron("0 9 * * x")).toThrow(/not a number/);
      expect(() => parseCron("0 9 32 * *")).toThrow(/day of month/);
      // still fine
      expect(parseCron("0 9 * * 1-5").dayOfWeek.values.size).toBe(5);
      expect(parseCron("5/15 * * * *").minute.values).toEqual(new Set([5, 20, 35, 50]));
    });
  });

  describe("scheduleExpressionProblem", () => {
    const now = new Date("2026-11-21T12:00:00Z");
    it("explains a bad cron, a cron that never fires, a non-date and a past one-shot; null when fine", () => {
      expect(scheduleExpressionProblem("99 99 * * *", { now })).toMatch(/^Invalid cron expression "99 99 \* \* \*": minute "99": 99 is not between 0 and 59\. Use 5 fields/);
      expect(scheduleExpressionProblem("0 0 31 2 *", { now })).toMatch(/never fires within a year/);
      expect(scheduleExpressionProblem("next tuesday", { now })).toMatch(/neither a cron expression .* nor a date/);
      expect(scheduleExpressionProblem("2026-01-01T09:00:00Z", { now })).toMatch(/in the past/);
      expect(scheduleExpressionProblem("0 3 1 1 *", { now, recurring: true })).toBeNull();
      expect(scheduleExpressionProblem("2027-01-01T09:00:00Z", { now })).toBeNull();
    });
  });

  describe("matchesCron", () => {
    it("matches a specific date against cron", () => {
      const cron = parseCron("30 14 * * *"); // 14:30 every day
      const date = new Date(2026, 1, 15, 14, 30, 0); // Feb 15, 2026 14:30:00
      expect(matchesCron(cron, date)).toBe(true);
    });

    it("does not match wrong minute", () => {
      const cron = parseCron("30 14 * * *");
      const date = new Date(2026, 1, 15, 14, 31, 0);
      expect(matchesCron(cron, date)).toBe(false);
    });
  });

  describe("nextCronOccurrence", () => {
    it("finds next occurrence after a date", () => {
      const after = new Date(2026, 1, 15, 14, 0, 0); // Feb 15, 2026 14:00
      const next = nextCronOccurrence("30 14 * * *", after);
      expect(next).not.toBeNull();
      expect(next!.getMinutes()).toBe(30);
      expect(next!.getHours()).toBe(14);
    });

    it("returns next day if today's match has passed", () => {
      const after = new Date(2026, 1, 15, 14, 35, 0); // Feb 15, 2026 14:35
      const next = nextCronOccurrence("30 14 * * *", after);
      expect(next).not.toBeNull();
      expect(next!.getDate()).toBe(16);
    });
  });

  describe("isCronExpression", () => {
    it("returns true for valid cron-like strings", () => {
      expect(isCronExpression("* * * * *")).toBe(true);
      expect(isCronExpression("0 2 * * 1-5")).toBe(true);
      expect(isCronExpression("*/15 * * * *")).toBe(true);
    });

    it("returns false for non-cron strings", () => {
      expect(isCronExpression("2026-01-15T14:00:00Z")).toBe(false);
      expect(isCronExpression("hello world")).toBe(false);
      expect(isCronExpression("* *")).toBe(false);
    });
  });
});

// ── Scheduler Tests ──────────────────────────────────

describe("Scheduler", () => {
  let ctx: OrchestratorContext;
  let store: MissionAwareStore;
  let scheduler: Scheduler;
  let executeMissionFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = new MissionAwareStore();
    ctx = createMockCtx(store);
    scheduler = new Scheduler(ctx, { checkIntervalMs: 0 }); // no throttle in tests
    executeMissionFn = vi.fn();
    scheduler.setExecutor(executeMissionFn);
  });

  afterEach(() => {
    scheduler.dispose();
  });

  it("registers a scheduled mission with a cron schedule", async () => {
    const mission = await store.saveMission({
      name: "cron-mission",
      data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }),
      status: "scheduled",
    });
    Object.assign(mission, { schedule: "0 2 * * *" });

    const entry = scheduler.registerMission(mission);
    expect(entry).not.toBeNull();
    expect(entry!.recurring).toBe(false);
    expect(entry!.nextRunAt).toBeDefined();
  });

  it("registers a recurring mission with a cron schedule", async () => {
    const mission = await store.saveMission({
      name: "recurring-mission",
      data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }),
      status: "recurring",
    });
    Object.assign(mission, { schedule: "0 2 * * *" });

    const entry = scheduler.registerMission(mission);
    expect(entry).not.toBeNull();
    expect(entry!.recurring).toBe(true);
    expect(entry!.nextRunAt).toBeDefined();
  });

  it("registers a mission with an ISO timestamp schedule", async () => {
    const futureDate = new Date(Date.now() + 60_000).toISOString();
    const mission = await store.saveMission({
      name: "oneshot-mission",
      data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }),
      status: "scheduled",
    });
    Object.assign(mission, { schedule: futureDate });

    const entry = scheduler.registerMission(mission);
    expect(entry).not.toBeNull();
    expect(entry!.nextRunAt).toBe(futureDate);
  });

  it("skips past ISO timestamps for non-recurring missions", async () => {
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    const mission = await store.saveMission({
      name: "past-mission",
      data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }),
      status: "scheduled",
    });
    Object.assign(mission, { schedule: pastDate });

    const entry = scheduler.registerMission(mission);
    expect(entry).toBeNull();
  });

  it("triggers mission execution when schedule is due", async () => {
    const mission = await store.saveMission({
      name: "due-mission",
      data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }),
      status: "scheduled",
    });

    // Set nextRunAt to the past
    const entry = scheduler.registerMission({
      ...mission,
      schedule: "0 0 * * *",
    } as Mission);
    if (entry) {
      entry.nextRunAt = new Date(Date.now() - 1000).toISOString();
    }

    await scheduler.check();

    expect(executeMissionFn).toHaveBeenCalledWith(mission.id);
  });

  it("disables one-shot schedules after execution", async () => {
    const mission = await store.saveMission({
      name: "oneshot",
      data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }),
      status: "scheduled",
    });

    const futureDate = new Date(Date.now() + 60_000).toISOString();
    const entry = scheduler.registerMission({
      ...mission,
      schedule: futureDate,
    } as Mission);
    expect(entry).not.toBeNull();

    // Force the schedule to be due
    entry!.nextRunAt = new Date(Date.now() - 1000).toISOString();
    await scheduler.check();

    expect(entry!.enabled).toBe(false);
  });

  it("keeps recurring schedules active after execution", async () => {
    const mission = await store.saveMission({
      name: "recurring",
      data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }),
      status: "recurring",
    });

    const entry = scheduler.registerMission({
      ...mission,
      schedule: "0 2 * * *",
    } as Mission);
    expect(entry).not.toBeNull();

    // Force due
    entry!.nextRunAt = new Date(Date.now() - 1000).toISOString();
    await scheduler.check();

    expect(entry!.enabled).toBe(true);
    expect(entry!.nextRunAt).toBeDefined();
    expect(entry!.lastRunAt).toBeDefined();
  });

  it("emits schedule:triggered and schedule:completed events", async () => {
    const emitSpy = vi.spyOn(ctx.emitter, "emit");

    const mission = await store.saveMission({
      name: "event-mission",
      data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }),
      status: "scheduled",
    });

    const entry = scheduler.registerMission({
      ...mission,
      schedule: "0 0 * * *",
    } as Mission);
    entry!.nextRunAt = new Date(Date.now() - 1000).toISOString();

    await scheduler.check();

    expect(emitSpy).toHaveBeenCalledWith("schedule:triggered", expect.objectContaining({
      missionId: mission.id,
    }));
    expect(emitSpy).toHaveBeenCalledWith("schedule:completed", expect.objectContaining({
      missionId: mission.id,
    }));
  });

  it("skips missions that are not in scheduled/recurring state", async () => {
    const mission = await store.saveMission({
      name: "active-mission",
      data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }),
      status: "active",
    });

    const entry = scheduler.registerMission({
      ...mission,
      schedule: "0 0 * * *",
    } as Mission);
    entry!.nextRunAt = new Date(Date.now() - 1000).toISOString();

    await scheduler.check();

    expect(executeMissionFn).not.toHaveBeenCalled();
  });

  it("before:schedule:trigger hook can cancel execution", async () => {
    ctx.hooks.register({
      hook: "schedule:trigger",
      phase: "before",
      handler: (hookCtx) => {
        hookCtx.cancel("maintenance window");
      },
    });

    const mission = await store.saveMission({
      name: "blocked-mission",
      data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }),
      status: "scheduled",
    });

    const entry = scheduler.registerMission({
      ...mission,
      schedule: "0 0 * * *",
    } as Mission);
    entry!.nextRunAt = new Date(Date.now() - 1000).toISOString();

    await scheduler.check();

    expect(executeMissionFn).not.toHaveBeenCalled();
  });

  it("unregisterMission removes the schedule", async () => {
    const mission = await store.saveMission({
      name: "remove-mission",
      data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }),
      status: "scheduled",
    });

    scheduler.registerMission({ ...mission, schedule: "0 0 * * *" } as Mission);
    expect(scheduler.getAllSchedules().length).toBe(1);

    scheduler.unregisterMission(mission.id);
    expect(scheduler.getAllSchedules().length).toBe(0);
  });

  it("getActiveSchedules only returns enabled schedules", async () => {
    const mission1 = await store.saveMission({ name: "m1", data: "{}", status: "scheduled" });
    const mission2 = await store.saveMission({ name: "m2", data: "{}", status: "scheduled" });

    scheduler.registerMission({ ...mission1, schedule: "0 0 * * *" } as Mission);
    const entry2 = scheduler.registerMission({ ...mission2, schedule: "0 0 * * *" } as Mission);
    entry2!.enabled = false;

    expect(scheduler.getActiveSchedules().length).toBe(1);
  });

  it("init scans existing missions with scheduled/recurring status", async () => {
    const mission = await store.saveMission({
      name: "pre-scheduled",
      data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }),
      status: "scheduled",
    });
    Object.assign(mission, { schedule: "0 3 * * *" });

    await scheduler.init();

    expect(scheduler.getAllSchedules().length).toBe(1);
  });

  it("init skips draft missions even with schedule field", async () => {
    const mission = await store.saveMission({
      name: "draft-with-schedule",
      data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }),
      status: "draft",
    });
    Object.assign(mission, { schedule: "0 3 * * *" });

    await scheduler.init();

    expect(scheduler.getAllSchedules().length).toBe(0);
  });

  it("init registers recurring missions", async () => {
    const mission = await store.saveMission({
      name: "recurring-init",
      data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }),
      status: "recurring",
    });
    Object.assign(mission, { schedule: "0 2 * * *" });

    await scheduler.init();

    expect(scheduler.getAllSchedules().length).toBe(1);
    const entry = scheduler.getAllSchedules()[0];
    expect(entry.recurring).toBe(true);
  });

  it("respects endDate — expires schedule when endDate is in the past", async () => {
    const mission = await store.saveMission({
      name: "expiring-mission",
      data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }),
      status: "recurring",
    });
    // endDate is already past
    Object.assign(mission, {
      schedule: "0 2 * * *",
      endDate: new Date(Date.now() - 60_000).toISOString(),
    });

    const entry = scheduler.registerMission(mission);
    expect(entry).not.toBeNull();

    // Force due
    entry!.nextRunAt = new Date(Date.now() - 1000).toISOString();

    const emitSpy = vi.spyOn(ctx.emitter, "emit");
    await scheduler.check();

    // Should NOT have executed the mission
    expect(executeMissionFn).not.toHaveBeenCalled();

    // Should have disabled the schedule
    expect(entry!.enabled).toBe(false);

    // Should have emitted schedule:expired
    expect(emitSpy).toHaveBeenCalledWith("schedule:expired", expect.objectContaining({
      missionId: mission.id,
    }));

    // Should have transitioned mission to completed
    const updated = await store.getMission(mission.id);
    expect(updated!.status).toBe("completed");
  });
});

describe("Scheduler.runNow", () => {
  it("runs a scheduled mission out of turn and keeps its next run", async () => {
    const store = new MissionAwareStore();
    const ctx = createMockCtx(store);
    const scheduler = new Scheduler(ctx, { checkIntervalMs: 0 });
    const execute = vi.fn();
    const events: string[] = [];
    ctx.emitter.on("schedule:triggered", () => events.push("triggered"));
    try {
      expect(() => scheduler.runNow("none")).toThrow(/No schedule/);
      const mission = await store.saveMission({ name: "digest", data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }), status: "recurring" });
      Object.assign(mission, { schedule: "0 9 * * *" });
      const entry = scheduler.registerMission(mission)!;
      expect(() => scheduler.runNow(mission.id)).toThrow(/cannot execute/);
      scheduler.setExecutor(execute);
      const next = entry.nextRunAt;
      const ran = scheduler.runNow(mission.id);
      expect(execute).toHaveBeenCalledWith(mission.id);
      expect(ran.lastRunAt).toEqual(expect.any(String));
      expect(ran.nextRunAt).toBe(next);
      expect(events).toEqual(["triggered"]);
    } finally {
      scheduler.dispose();
    }
  });

  it("a paused schedule stays paused after a run now (live: the finished run re-registered it enabled)", async () => {
    const store = new MissionAwareStore();
    const ctx = createMockCtx(store);
    const scheduler = new Scheduler(ctx, { checkIntervalMs: 0 });
    scheduler.setExecutor(vi.fn());
    try {
      await scheduler.init();
      const mission = await store.saveMission({ name: "digest", data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }), status: "recurring" });
      Object.assign(mission, { schedule: "0 3 1 1 *" });
      scheduler.registerMission(mission);
      scheduler.setEnabled(mission.id, false);
      const ran = scheduler.runNow(mission.id);
      expect(ran.enabled).toBe(false);
      // the run finishes: the mission is back to "recurring" and the scheduler registers it again
      ctx.emitter.emit("mission:completed", { missionId: mission.id, group: "digest", allPassed: true, report: {} as any });
      await vi.waitFor(() => expect(scheduler.getScheduleByMissionId(mission.id)!.lastRunAt).toBe(ran.lastRunAt));
      expect(scheduler.getScheduleByMissionId(mission.id)!.enabled).toBe(false);
      expect(scheduler.getActiveSchedules()).toEqual([]);
      // a changed expression keeps the pause too
      Object.assign(mission, { schedule: "0 4 1 1 *" });
      expect(scheduler.rescheduleMission(mission)!.enabled).toBe(false);
      // resuming is explicit
      expect(scheduler.setEnabled(mission.id, true)!.enabled).toBe(true);
    } finally {
      scheduler.dispose();
    }
  });
});
