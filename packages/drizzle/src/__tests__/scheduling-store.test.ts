/** Schedules' state, claims and task watchers on SQLite (migrations included), and PostgreSQL when POLPO_TEST_DATABASE_URL is set. */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { drizzle as pgDrizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createPgStores, createSqliteStores, migratePg, migrateSqlite, type DrizzleStores } from "../index.js";

const PG_URL = process.env.POLPO_TEST_DATABASE_URL;
const DIALECTS = ["sqlite", ...(PG_URL ? ["postgres"] : [])] as const;

describe.each(DIALECTS)("scheduling stores on %s", (dialect) => {
  let stores: DrizzleStores;
  /** A second process on the same database. */
  let other: DrizzleStores;
  let pg: ReturnType<typeof postgres> | undefined;
  let pgDb: ReturnType<typeof pgDrizzle> | undefined;

  beforeAll(async () => {
    if (dialect !== "postgres") return;
    pg = postgres(PG_URL!, { max: 4, onnotice: () => {} });
    pgDb = pgDrizzle(pg);
    await migratePg(pgDb);
  });
  afterAll(async () => { await pg?.end({ timeout: 5 }); });

  beforeEach(async () => {
    if (dialect === "sqlite") {
      const db = drizzle(new Database(":memory:"));
      migrateSqlite(db);
      stores = createSqliteStores(db);
      other = createSqliteStores(db);
      return;
    }
    await pg!.unsafe(`TRUNCATE "schedules", "leases", "task_watchers"`);
    stores = createPgStores(pgDb!);
    other = createPgStores(pgDb!);
  });

  it("saves, replaces, lists and deletes a schedule's state", async () => {
    const s = stores.scheduleStore;
    const state = {
      missionId: "m1", expression: "0 9 * * *", recurring: true, enabled: false, catchUp: "none" as const,
      nextRunAt: "2026-12-01T09:00:00.000Z", lastRunAt: "2026-11-30T09:00:00.000Z", lastOutcome: "failed" as const, lastError: "boom",
      missedRuns: 3, lastMissedAt: "2026-11-29T09:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-30T09:00:01.000Z",
    };
    await s.saveSchedule(state);
    expect(await other.scheduleStore.getSchedule("m1")).toEqual(state);
    await s.saveSchedule({ ...state, enabled: true, updatedAt: "2026-11-30T10:00:00.000Z" });
    expect(await s.listSchedules()).toEqual([{ ...state, enabled: true, updatedAt: "2026-11-30T10:00:00.000Z" }]);
    expect(await s.deleteSchedule("m1")).toBe(true);
    expect(await s.deleteSchedule("m1")).toBe(false);
    expect(await s.getSchedule("m1")).toBeUndefined();
  });

  it("a claim belongs to one owner until it expires; the owner extends it; release and prune", async () => {
    const a = stores.leaseStore;
    const b = other.leaseStore;
    const both = await Promise.all([a.tryClaim("schedule:m1@2026-12-01T09:00:00.000Z", "A", 60_000), b.tryClaim("schedule:m1@2026-12-01T09:00:00.000Z", "B", 60_000)]);
    expect(both.filter(Boolean)).toHaveLength(1);
    expect(await a.tryClaim("k", "A", 60_000)).toBe(true);
    expect(await b.tryClaim("k", "B", 60_000)).toBe(false);
    expect(await a.tryClaim("k", "A", 60_000)).toBe(true);
    await b.release("k", "B"); // not B's: stays
    expect(await b.tryClaim("k", "B", 60_000)).toBe(false);
    await a.release("k", "A");
    expect(await b.tryClaim("k", "B", 60_000)).toBe(true);
    expect(await a.tryClaim("short", "A", 1)).toBe(true);
    await new Promise((r) => setTimeout(r, 15));
    expect(await b.tryClaim("short", "B", 60_000)).toBe(true);
    expect(await a.tryClaim("short", "A", 60_000)).toBe(false);
    expect(await a.prune!(new Date(Date.now() + 120_000).toISOString())).toBe(3);
    expect(await a.tryClaim("k", "A", 60_000)).toBe(true);
  });

  it("stores task watchers", async () => {
    const w = { id: "watch-1", taskId: "t1", targetStatus: "done" as const, action: { type: "send_notification" as const, channel: "ops", title: "done", message: "t1 done" }, fired: false, createdAt: "2026-11-30T09:00:00.000Z" };
    await stores.taskWatcherStore.saveWatcher(w as never);
    await stores.taskWatcherStore.saveWatcher({ ...w, fired: true, firedAt: "2026-11-30T10:00:00.000Z" } as never);
    expect(await other.taskWatcherStore.listWatchers()).toEqual([{ ...w, fired: true, firedAt: "2026-11-30T10:00:00.000Z" }]);
    expect(await stores.taskWatcherStore.deleteWatcher("watch-1")).toBe(true);
    expect(await stores.taskWatcherStore.deleteWatcher("watch-1")).toBe(false);
  });
});
