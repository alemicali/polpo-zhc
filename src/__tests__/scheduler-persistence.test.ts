/**
 * Schedules survive a restart and never fire twice: pause, next run, last outcome and missed runs
 * live in the store (file, SQLite, PostgreSQL when POLPO_TEST_DATABASE_URL is set); every
 * occurrence is claimed before it fires, so two schedulers on the same storage run it once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { drizzle as pgDrizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createPgStores, createSqliteStores, migratePg, migrateSqlite } from "@polpo-ai/drizzle";
import { InMemoryLeaseStore, InMemoryScheduleStore, type LeaseStore, type ScheduleStore } from "@polpo-ai/core";
import { Scheduler } from "../scheduling/scheduler.js";
import { nextCronOccurrence } from "../scheduling/cron.js";
import { HookRegistry } from "../core/hooks.js";
import { TypedEmitter } from "../core/events.js";
import { FileLeaseStore, FileScheduleStore } from "../stores/file-scheduling-store.js";
import { InMemoryTaskStore, InMemoryRunStore } from "./fixtures.js";
import type { OrchestratorContext } from "../core/orchestrator-context.js";
import type { Mission } from "../core/types.js";

class Missions extends InMemoryTaskStore {
  readonly missions = new Map<string, Mission>();
  add(id: string, schedule: string, status: Mission["status"]): Mission {
    const now = new Date().toISOString();
    const m: Mission = { id, name: id, data: JSON.stringify({ tasks: [{ title: "A", description: "A" }] }), status, schedule, createdAt: now, updatedAt: now };
    this.missions.set(id, m);
    return m;
  }
  async getMission(id: string) { return this.missions.get(id); }
  async getAllMissions() { return [...this.missions.values()]; }
  async updateMission(id: string, updates: Partial<Mission>) {
    const m = this.missions.get(id)!;
    Object.assign(m, updates);
    return m;
  }
}

function ctxFor(registry: Missions): OrchestratorContext {
  return {
    emitter: new TypedEmitter(),
    registry,
    runStore: new InMemoryRunStore(),
    hooks: new HookRegistry(),
    config: { version: "1", project: "t", teams: [], tasks: [], settings: { maxRetries: 1, workDir: "/tmp", logLevel: "quiet" } },
    workDir: "/tmp", agentWorkDir: "/tmp", polpoDir: "/tmp/.polpo",
  } as unknown as OrchestratorContext;
}

type Backend = { schedules: () => ScheduleStore; leases: () => LeaseStore; cleanup: () => Promise<void> };

const PG_URL = process.env.POLPO_TEST_DATABASE_URL;

/** Each call to schedules()/leases() is a new store object on the same storage, as a second process (or a restart) would have. */
const BACKENDS: Record<string, () => Promise<Backend>> = {
  memory: async () => {
    const s = new InMemoryScheduleStore();
    const l = new InMemoryLeaseStore();
    return { schedules: () => s, leases: () => l, cleanup: async () => {} };
  },
  file: async () => {
    const dir = mkdtempSync(join(tmpdir(), "polpo-sched-"));
    return { schedules: () => new FileScheduleStore(dir), leases: () => new FileLeaseStore(dir), cleanup: async () => rmSync(dir, { recursive: true, force: true }) };
  },
  sqlite: async () => {
    const dir = mkdtempSync(join(tmpdir(), "polpo-sched-db-"));
    const file = join(dir, "polpo.db");
    const conns: InstanceType<typeof Database>[] = [];
    const open = () => {
      const conn = new Database(file);
      conn.pragma("journal_mode = WAL");
      conns.push(conn);
      const db = drizzle(conn);
      migrateSqlite(db);
      return createSqliteStores(db);
    };
    return {
      schedules: () => open().scheduleStore,
      leases: () => open().leaseStore,
      cleanup: async () => { for (const c of conns) c.close(); rmSync(dir, { recursive: true, force: true }); },
    };
  },
  ...(PG_URL ? {
    postgres: async () => {
      const pg = postgres(PG_URL, { max: 4, onnotice: () => {} });
      const db = pgDrizzle(pg);
      await migratePg(db);
      await pg.unsafe(`TRUNCATE "schedules", "leases"`);
      return { schedules: () => createPgStores(db).scheduleStore, leases: () => createPgStores(db).leaseStore, cleanup: async () => { await pg.end({ timeout: 5 }); } };
    },
  } : {}),
};

const HOURLY = "0 * * * *";

describe.each(Object.keys(BACKENDS))("scheduler persistence on %s", (name) => {
  let backend: Backend;
  let missions: Missions;
  const schedulers: Scheduler[] = [];

  /** A scheduler process on the shared storage (a restart = a new one). */
  const start = async (execute = vi.fn()) => {
    const s = new Scheduler(ctxFor(missions), { checkIntervalMs: 0, store: backend.schedules(), leases: backend.leases() });
    s.setExecutor(execute);
    await s.init();
    schedulers.push(s);
    return { scheduler: s, execute };
  };
  const stop = async (s: Scheduler) => { await s.flush(); s.dispose(); };

  beforeEach(async () => {
    backend = await BACKENDS[name]!();
    missions = new Missions();
  });
  afterEach(async () => {
    for (const s of schedulers.splice(0)) s.dispose();
    await backend.cleanup();
  });

  it("a paused schedule stays paused after a restart, with its next run (live: it resumed)", async () => {
    const { scheduler: a } = await start();
    const m = missions.add("m1", HOURLY, "recurring");
    const entry = a.registerMission(m)!;
    a.setEnabled("m1", false);
    const next = entry.nextRunAt;
    await stop(a);

    const { scheduler: b } = await start();
    expect(b.getScheduleByMissionId("m1")).toMatchObject({ enabled: false, nextRunAt: next, recurring: true });
    expect(b.getActiveSchedules()).toEqual([]);
    expect(b.setEnabled("m1", true)!.enabled).toBe(true);
    await stop(b);
    const { scheduler: c } = await start();
    expect(c.getScheduleByMissionId("m1")!.enabled).toBe(true);
  });

  it("keeps the next run, the last run, its outcome and the catch-up policy across a restart", async () => {
    const { scheduler: a, execute } = await start();
    const m = missions.add("m1", HOURLY, "recurring");
    const entry = a.registerMission(m, "created", { catchUp: "none" })!;
    entry.nextRunAt = new Date(Date.now() - 1000).toISOString();
    await a.check();
    expect(execute).toHaveBeenCalledTimes(1);
    const fired = a.getScheduleByMissionId("m1")!;
    expect(fired).toMatchObject({ lastOutcome: "started", catchUp: "none" });
    await stop(a);

    const { scheduler: b, execute: again } = await start();
    expect(b.getScheduleByMissionId("m1")).toMatchObject({ nextRunAt: fired.nextRunAt, lastRunAt: fired.lastRunAt, lastOutcome: "started", catchUp: "none" });
    await b.check();
    expect(again).not.toHaveBeenCalled();
  });

  it("a run missed while the server was down runs once at startup (catchUp once, the default)", async () => {
    missions.add("m1", HOURLY, "recurring");
    const due = new Date(Date.now() - 5 * 3600_000 - 60_000); // five-plus hourly runs ago
    const slot = nextCronOccurrence(HOURLY, new Date(due.getTime() - 60_000))!;
    await backend.schedules().saveSchedule({
      missionId: "m1", expression: HOURLY, recurring: true, enabled: true, nextRunAt: slot.toISOString(),
      createdAt: slot.toISOString(), updatedAt: slot.toISOString(),
    });
    const { scheduler, execute } = await start();
    const entry = scheduler.getScheduleByMissionId("m1")!;
    // the latest missed hour is due now; the earlier ones are counted as missed
    const latest = Date.parse(entry.nextRunAt!);
    expect(latest).toBeLessThanOrEqual(Date.now());
    expect(Date.now() - latest).toBeLessThan(3600_000);
    expect(entry.missedRuns).toBeGreaterThanOrEqual(4); // five or six hours missed, the latest of them runs
    expect(entry.lastMissedAt).toBeDefined();
    await scheduler.check();
    await scheduler.check();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(Date.parse(scheduler.getScheduleByMissionId("m1")!.nextRunAt!)).toBeGreaterThan(Date.now());
  });

  it("catchUp none: missed runs are skipped to the next one and reported", async () => {
    missions.add("m1", HOURLY, "recurring");
    const slot = nextCronOccurrence(HOURLY, new Date(Date.now() - 3 * 3600_000 - 120_000))!;
    await backend.schedules().saveSchedule({
      missionId: "m1", expression: HOURLY, recurring: true, enabled: true, catchUp: "none", nextRunAt: slot.toISOString(),
      createdAt: slot.toISOString(), updatedAt: slot.toISOString(),
    });
    const { scheduler, execute } = await start();
    const entry = scheduler.getScheduleByMissionId("m1")!;
    expect(entry).toMatchObject({ lastOutcome: "missed", enabled: true });
    expect(entry.missedRuns).toBeGreaterThanOrEqual(3);
    expect(Date.parse(entry.nextRunAt!)).toBeGreaterThan(Date.now());
    await scheduler.check();
    expect(execute).not.toHaveBeenCalled();
    // the count is persisted
    expect((await backend.schedules().getSchedule("m1"))).toMatchObject({ lastOutcome: "missed", missedRuns: entry.missedRuns });
  });

  it("a one-shot missed while down runs at startup within its grace, and is reported missed past it", async () => {
    const soon = new Date(Date.now() - 2 * 3600_000).toISOString();
    const old = new Date(Date.now() - 3 * 24 * 3600_000).toISOString();
    missions.add("recent", soon, "scheduled");
    missions.add("stale", old, "scheduled");
    for (const [id, at] of [["recent", soon], ["stale", old]] as const) {
      await backend.schedules().saveSchedule({ missionId: id, expression: at, recurring: false, enabled: true, nextRunAt: at, createdAt: at, updatedAt: at });
    }
    const { scheduler, execute } = await start();
    expect(scheduler.getScheduleByMissionId("stale")).toMatchObject({ enabled: false, lastOutcome: "missed", missedRuns: 1 });
    await scheduler.check();
    expect(execute.mock.calls.map((c) => c[0])).toEqual(["recent"]);
    expect(scheduler.getScheduleByMissionId("recent")).toMatchObject({ enabled: false, lastOutcome: "started" });
  });

  it("two schedulers on the same storage fire a due run once", async () => {
    missions.add("m1", HOURLY, "recurring");
    const due = new Date(Date.now() - 1000).toISOString();
    await backend.schedules().saveSchedule({ missionId: "m1", expression: HOURLY, recurring: true, enabled: true, nextRunAt: due, createdAt: due, updatedAt: due });
    const { scheduler: a, execute: ea } = await start();
    const { scheduler: b, execute: eb } = await start();
    expect(a.getScheduleByMissionId("m1")!.nextRunAt).toBe(due);
    expect(b.getScheduleByMissionId("m1")!.nextRunAt).toBe(due);
    await Promise.all([a.check(), b.check()]);
    await Promise.all([a.check(), b.check()]);
    expect(ea.mock.calls.length + eb.mock.calls.length).toBe(1);
    // both agree on the next run afterwards
    await Promise.all([a.flush(), b.flush()]);
    expect(Date.parse(a.getScheduleByMissionId("m1")!.nextRunAt!)).toBeGreaterThan(Date.now());
    expect(Date.parse(b.getScheduleByMissionId("m1")!.nextRunAt!)).toBeGreaterThan(Date.now());
  });

  it("a schedule paused by another process does not fire here", async () => {
    const { scheduler: a } = await start();
    const { scheduler: b, execute } = await start();
    const m = missions.add("m1", HOURLY, "recurring");
    b.registerMission(m, "none");
    await b.flush();
    await a.check(); // a picks up the schedule b created
    expect(a.getScheduleByMissionId("m1")).toBeDefined();
    await new Promise((r) => setTimeout(r, 5));
    a.setEnabled("m1", false);
    await a.flush();
    // b still has it enabled in memory, and it comes due
    b.getScheduleByMissionId("m1")!.nextRunAt = new Date(Date.now() - 1000).toISOString();
    await b.check();
    expect(execute).not.toHaveBeenCalled();
    expect(b.getScheduleByMissionId("m1")!.enabled).toBe(false);
  });

  it("a removed schedule's state goes with it", async () => {
    const { scheduler: a } = await start();
    a.registerMission(missions.add("m1", HOURLY, "recurring"));
    await a.flush();
    expect(await backend.schedules().getSchedule("m1")).toBeDefined();
    a.unregisterMission("m1");
    await a.flush();
    expect(await backend.schedules().getSchedule("m1")).toBeUndefined();
  });
});

describe("lease claims", () => {
  it.each(["file", "sqlite"])("on %s: one owner at a time, the same owner extends, an expired claim is taken over", async (name) => {
    const backend = await BACKENDS[name]!();
    try {
      const a = backend.leases();
      const b = backend.leases();
      const results = await Promise.all([a.tryClaim("k", "A", 60_000), b.tryClaim("k", "B", 60_000)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = results[0] ? "A" : "B";
      expect(await (winner === "A" ? a : b).tryClaim("k", winner, 60_000)).toBe(true);
      expect(await a.tryClaim("short", "A", 1)).toBe(true);
      await new Promise((r) => setTimeout(r, 15));
      expect(await b.tryClaim("short", "B", 60_000)).toBe(true);
      expect(await a.tryClaim("short", "A", 60_000)).toBe(false);
      await b.release("short", "B");
      expect(await a.tryClaim("short", "A", 60_000)).toBe(true);
      expect(await a.prune!(new Date(Date.now() + 120_000).toISOString())).toBeGreaterThanOrEqual(2);
    } finally {
      await backend.cleanup();
    }
  });
});
