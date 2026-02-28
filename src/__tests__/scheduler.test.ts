import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Scheduler } from "../scheduling/scheduler.js";
import { parseCron, matchesCron, nextCronOccurrence, isCronExpression } from "../scheduling/cron.js";
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

  saveMission(opts: { name: string; data: string; prompt?: string; status: string }): Mission {
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

  getMission(missionId: string): Mission | undefined {
    return this.missions.get(missionId);
  }

  getMissionByName(name: string): Mission | undefined {
    return [...this.missions.values()].find(p => p.name === name);
  }

  getAllMissions(): Mission[] {
    return [...this.missions.values()];
  }

  updateMission(missionId: string, updates: Partial<Mission>): Mission {
    const mission = this.missions.get(missionId);
    if (!mission) throw new Error("Mission not found");
    Object.assign(mission, updates, { updatedAt: new Date().toISOString() });
    return mission;
  }

  deleteMission(missionId: string): boolean {
    return this.missions.delete(missionId);
  }
}

function createMockCtx(store?: MissionAwareStore): OrchestratorContext {
  return {
    emitter: new TypedEmitter(),
    registry: store ?? new MissionAwareStore(),
    runStore: new InMemoryRunStore(),
    memoryStore: { exists: () => false, get: () => "", save: () => {}, append: () => {} },
    logStore: { startSession: () => "s", getSessionId: () => "s", append: () => {}, getSessionEntries: () => [], listSessions: () => [], prune: () => 0, close: () => {} },
    sessionStore: { create: () => "s1", addMessage: () => ({ id: "m1", role: "user" as const, content: "", ts: "" }), getMessages: () => [], getRecentMessages: () => [], listSessions: () => [], getSession: () => undefined, getLatestSession: () => undefined, deleteSession: () => false, prune: () => 0, close: () => {} },
    hooks: new HookRegistry(),
    config: createMinimalConfig(),
    workDir: "/tmp/test",
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

  it("registers a mission with a cron schedule", () => {
    const mission = store.saveMission({
      name: "cron-mission",
      data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }),
      status: "draft",
    });
    Object.assign(mission, { schedule: "0 2 * * *" });

    const entry = scheduler.registerMission(mission);
    expect(entry).not.toBeNull();
    expect(entry!.recurring).toBe(false);
    expect(entry!.nextRunAt).toBeDefined();
  });

  it("registers a mission with an ISO timestamp schedule", () => {
    const futureDate = new Date(Date.now() + 60_000).toISOString();
    const mission = store.saveMission({
      name: "oneshot-mission",
      data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }),
      status: "draft",
    });
    Object.assign(mission, { schedule: futureDate });

    const entry = scheduler.registerMission(mission);
    expect(entry).not.toBeNull();
    expect(entry!.nextRunAt).toBe(futureDate);
  });

  it("skips past ISO timestamps for non-recurring missions", () => {
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    const mission = store.saveMission({
      name: "past-mission",
      data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }),
      status: "draft",
    });
    Object.assign(mission, { schedule: pastDate });

    const entry = scheduler.registerMission(mission);
    expect(entry).toBeNull();
  });

  it("triggers mission execution when schedule is due", () => {
    const mission = store.saveMission({
      name: "due-mission",
      data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }),
      status: "draft",
    });

    // Set nextRunAt to the past
    const entry = scheduler.registerMission({
      ...mission,
      schedule: "0 0 * * *",
    } as Mission);
    if (entry) {
      entry.nextRunAt = new Date(Date.now() - 1000).toISOString();
    }

    scheduler.check();

    expect(executeMissionFn).toHaveBeenCalledWith(mission.id);
  });

  it("disables one-shot schedules after execution", () => {
    const mission = store.saveMission({
      name: "oneshot",
      data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }),
      status: "draft",
    });

    const futureDate = new Date(Date.now() + 60_000).toISOString();
    const entry = scheduler.registerMission({
      ...mission,
      schedule: futureDate,
    } as Mission);
    expect(entry).not.toBeNull();

    // Force the schedule to be due
    entry!.nextRunAt = new Date(Date.now() - 1000).toISOString();
    scheduler.check();

    expect(entry!.enabled).toBe(false);
  });

  it("keeps recurring schedules active after execution", () => {
    const mission = store.saveMission({
      name: "recurring",
      data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }),
      status: "draft",
    });

    const entry = scheduler.registerMission({
      ...mission,
      schedule: "0 2 * * *",
      recurring: true,
    } as Mission);
    expect(entry).not.toBeNull();

    // Force due
    entry!.nextRunAt = new Date(Date.now() - 1000).toISOString();
    scheduler.check();

    expect(entry!.enabled).toBe(true);
    expect(entry!.nextRunAt).toBeDefined();
    expect(entry!.lastRunAt).toBeDefined();
  });

  it("emits schedule:triggered and schedule:completed events", () => {
    const emitSpy = vi.spyOn(ctx.emitter, "emit");

    const mission = store.saveMission({
      name: "event-mission",
      data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }),
      status: "draft",
    });

    const entry = scheduler.registerMission({
      ...mission,
      schedule: "0 0 * * *",
    } as Mission);
    entry!.nextRunAt = new Date(Date.now() - 1000).toISOString();

    scheduler.check();

    expect(emitSpy).toHaveBeenCalledWith("schedule:triggered", expect.objectContaining({
      missionId: mission.id,
    }));
    expect(emitSpy).toHaveBeenCalledWith("schedule:completed", expect.objectContaining({
      missionId: mission.id,
    }));
  });

  it("skips missions that are not in draft/completed state", () => {
    const mission = store.saveMission({
      name: "active-mission",
      data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }),
      status: "active",
    });

    const entry = scheduler.registerMission({
      ...mission,
      schedule: "0 0 * * *",
    } as Mission);
    entry!.nextRunAt = new Date(Date.now() - 1000).toISOString();

    scheduler.check();

    expect(executeMissionFn).not.toHaveBeenCalled();
  });

  it("before:schedule:trigger hook can cancel execution", () => {
    ctx.hooks.register({
      hook: "schedule:trigger",
      phase: "before",
      handler: (hookCtx) => {
        hookCtx.cancel("maintenance window");
      },
    });

    const mission = store.saveMission({
      name: "blocked-mission",
      data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }),
      status: "draft",
    });

    const entry = scheduler.registerMission({
      ...mission,
      schedule: "0 0 * * *",
    } as Mission);
    entry!.nextRunAt = new Date(Date.now() - 1000).toISOString();

    scheduler.check();

    expect(executeMissionFn).not.toHaveBeenCalled();
  });

  it("unregisterMission removes the schedule", () => {
    const mission = store.saveMission({
      name: "remove-mission",
      data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }),
      status: "draft",
    });

    scheduler.registerMission({ ...mission, schedule: "0 0 * * *" } as Mission);
    expect(scheduler.getAllSchedules().length).toBe(1);

    scheduler.unregisterMission(mission.id);
    expect(scheduler.getAllSchedules().length).toBe(0);
  });

  it("getActiveSchedules only returns enabled schedules", () => {
    const mission1 = store.saveMission({ name: "m1", data: "{}", status: "draft" });
    const mission2 = store.saveMission({ name: "m2", data: "{}", status: "draft" });

    scheduler.registerMission({ ...mission1, schedule: "0 0 * * *" } as Mission);
    const entry2 = scheduler.registerMission({ ...mission2, schedule: "0 0 * * *" } as Mission);
    entry2!.enabled = false;

    expect(scheduler.getActiveSchedules().length).toBe(1);
  });

  it("init scans existing missions for schedules", () => {
    const mission = store.saveMission({
      name: "pre-scheduled",
      data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }),
      status: "draft",
    });
    Object.assign(mission, { schedule: "0 3 * * *" });

    scheduler.init();

    expect(scheduler.getAllSchedules().length).toBe(1);
  });
});
