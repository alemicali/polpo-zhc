/** Artifacts on SQLite (migrations included), and PostgreSQL when POLPO_TEST_DATABASE_URL is set. */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { drizzle as pgDrizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createPgStores, createSqliteStores, migratePg, migrateSqlite, type DrizzleStores } from "../index.js";

const PG_URL = process.env.POLPO_TEST_DATABASE_URL;
const DIALECTS = ["sqlite", ...(PG_URL ? ["postgres"] : [])] as const;

describe.each(DIALECTS)("artifacts on %s", (dialect) => {
  let stores: DrizzleStores;
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
      return;
    }
    await pg!.unsafe(`TRUNCATE "artifacts"`);
    stores = createPgStores(pgDb!);
  });

  it("creates, lists by filter, versions, restores and deletes", async () => {
    const store = stores.artifactStore;
    const dash = await store.create({ title: "Sales", type: "html", kind: "dashboard", content: "<h1>v1</h1>", createdBy: "analyst", sessionId: "s1", sources: ["sales"] });
    const doc = await store.create({ title: "Plan", type: "doc", content: "# Plan", createdBy: "polpo" });
    expect(dash.id).toMatch(/^art_/);

    expect((await store.list()).map((a) => a.id).sort()).toEqual([dash.id, doc.id].sort());
    expect((await store.list({ sessionId: "s1" })).map((a) => a.id)).toEqual([dash.id]);
    expect((await store.list({ type: "doc" })).map((a) => a.id)).toEqual([doc.id]);
    expect((await store.list({ createdBy: "analyst", q: "sal" }))[0]).toMatchObject({ id: dash.id, size: 11, sources: ["sales"] });

    const v2 = await store.update(dash.id, { content: "<h1>v2</h1>", author: "analyst", note: "new chart" });
    expect(v2).toMatchObject({ version: 2, note: "new chart", versions: [{ version: 1, content: "<h1>v1</h1>" }] });
    const restored = await store.restore(dash.id, 1, "person:ada");
    expect(restored).toMatchObject({ version: 3, content: "<h1>v1</h1>", author: "person:ada" });
    expect((await store.get(dash.id))!.versions.map((v) => v.version)).toEqual([2, 1]);
    await expect(store.restore(dash.id, 7)).rejects.toThrow(/No version 7/);

    expect(await store.delete(doc.id)).toBe(true);
    expect(await store.get(doc.id)).toBeUndefined();
    expect(await store.delete(doc.id)).toBe(false);
  });
});
