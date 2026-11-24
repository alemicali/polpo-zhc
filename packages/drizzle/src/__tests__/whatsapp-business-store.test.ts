/** WhatsApp Business contacts, messages and processed keys on SQLite (migrations included), and PostgreSQL when POLPO_TEST_DATABASE_URL is set. */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { drizzle as pgDrizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { WaBizMessage } from "@polpo-ai/core/whatsapp-business";
import { createPgStores, createSqliteStores, migratePg, migrateSqlite, type DrizzleStores } from "../index.js";

const PG_URL = process.env.POLPO_TEST_DATABASE_URL;
const DIALECTS = ["sqlite", ...(PG_URL ? ["postgres"] : [])] as const;

const msg = (id: string, o: Partial<WaBizMessage> = {}): WaBizMessage => ({
  id, channel: "shop", waId: "393331234567", direction: "out", type: "template", initiated: "business", sentBy: "sales",
  status: "accepted", statuses: [{ status: "accepted", at: "2026-11-24T10:00:00.000Z" }],
  createdAt: "2026-11-24T10:00:00.000Z", updatedAt: "2026-11-24T10:00:00.000Z", ...o,
});

describe.each(DIALECTS)("WhatsApp Business store on %s", (dialect) => {
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
    await pg!.unsafe(`TRUNCATE "wabiz_contacts", "wabiz_messages", "wabiz_processed"`);
    stores = createPgStores(pgDb!);
  });

  it("keeps contacts and erases one with its messages", async () => {
    const s = stores.waBusinessStore;
    await s.saveContact({ channel: "shop", waId: "393331234567", name: "Mario", lastInboundAt: "2026-11-24T09:00:00.000Z", optIn: null, optOut: null, createdAt: "x", updatedAt: "x" });
    await s.saveContact({ channel: "shop", waId: "393331234567", name: "Mario R.", lastInboundAt: "2026-11-24T09:30:00.000Z", optIn: null, optOut: { at: "y", keyword: "STOP" }, createdAt: "x", updatedAt: "y" });
    expect(await s.getContact("shop", "393331234567")).toMatchObject({ name: "Mario R.", optOut: { keyword: "STOP" } });
    expect((await s.listContacts("shop")).map((c) => c.waId)).toEqual(["393331234567"]);
    await s.saveMessage(msg("wamid.1"));
    expect(await s.deleteContact("shop", "393331234567")).toBe(true);
    expect(await s.getContact("shop", "393331234567")).toBeUndefined();
    expect(await s.getMessage("wamid.1")).toBeUndefined();
  });

  it("lists messages, updates them, counts business-initiated ones", async () => {
    const s = stores.waBusinessStore;
    await s.saveMessage(msg("wamid.1"));
    await s.saveMessage(msg("wamid.2", { sentBy: "ops", createdAt: "2026-11-24T11:00:00.000Z" }));
    await s.saveMessage(msg("pending_1", { status: "pending_approval", createdAt: "2026-11-24T12:00:00.000Z" }));
    await s.saveMessage(msg("wamid.in", { direction: "in", initiated: undefined, type: "text", status: "received" }));
    await s.saveMessage({ ...msg("wamid.1"), status: "read" });
    expect((await s.getMessage("wamid.1"))?.status).toBe("read");
    expect((await s.listMessages("shop", { status: "pending_approval" })).map((m) => m.id)).toEqual(["pending_1"]);
    expect((await s.listMessages("shop", { limit: 2 })).map((m) => m.id)).toEqual(["pending_1", "wamid.2"]);
    expect(await s.countBusinessInitiated("shop", "2026-11-24T00:00:00.000Z")).toBe(2);
    expect(await s.countBusinessInitiated("shop", "2026-11-24T00:00:00.000Z", "sales")).toBe(1);
    expect(await s.countBusinessInitiated("shop", "2026-11-25T00:00:00.000Z")).toBe(0);
  });

  it("remembers processed keys once and purges old ones and old messages", async () => {
    const s = stores.waBusinessStore;
    expect(await s.markProcessed("in:shop:wamid.1", "2026-11-01T00:00:00.000Z")).toBe(true);
    expect(await s.markProcessed("in:shop:wamid.1", "2026-11-01T00:00:00.000Z")).toBe(false);
    expect(await s.isProcessed("in:shop:wamid.1")).toBe(true);
    expect(await s.purgeProcessed("2026-11-10T00:00:00.000Z")).toBe(1);
    expect(await s.isProcessed("in:shop:wamid.1")).toBe(false);
    await s.saveMessage(msg("old", { createdAt: "2026-01-01T00:00:00.000Z" }));
    await s.saveMessage(msg("new"));
    await s.saveContact({ channel: "shop", waId: "1", lastInboundAt: "2026-01-01T00:00:00.000Z", optIn: null, optOut: null, createdAt: "x", updatedAt: "x" });
    await s.saveContact({ channel: "shop", waId: "2", lastInboundAt: "2026-01-01T00:00:00.000Z", optIn: null, optOut: { at: "x", keyword: "STOP" }, createdAt: "x", updatedAt: "x" });
    expect(await s.purge("shop", "2026-06-01T00:00:00.000Z")).toEqual({ messages: 1, contacts: 1 });
    expect(await s.getMessage("new")).toBeDefined();
    expect(await s.getContact("shop", "2")).toBeDefined(); // an opt-out is kept
  });
});
