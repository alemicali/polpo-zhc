/**
 * Stores that used to live only in .polpo files (token usage, context checkpoints, apps, data
 * registry, company brain, WhatsApp), on SQLite always and on PostgreSQL when
 * POLPO_TEST_DATABASE_URL is set (see stores.test.ts).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { drizzle as pgDrizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createPgStores, createSqliteStores, migratePg, migrateSqlite, type DrizzleStores } from "../index.js";

const PG_URL = process.env.POLPO_TEST_DATABASE_URL;
const DIALECTS = ["sqlite", ...(PG_URL ? ["postgres"] : [])] as const;
const HASH = "a".repeat(64);

describe.each(DIALECTS)("%s", (dialect) => {
  let stores: DrizzleStores;
  let sqlite: InstanceType<typeof Database> | undefined;
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
      sqlite = new Database(":memory:");
      const db = drizzle(sqlite);
      migrateSqlite(db);
      stores = createSqliteStores(db);
      return;
    }
    const tables = await pg!`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
    await pg!.unsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
    stores = createPgStores(pgDb!);
  });
  afterEach(() => { sqlite?.close(); sqlite = undefined; });

  // ── Token usage ──────────────────────────────────────────────────────

  describe("DrizzleTokenUsageStore", () => {
    const record = (timestamp: string, cost: number) => ({
      timestamp, source: "agent_chat" as const, model: "m", inputTokens: 10, outputTokens: 5,
      cacheReadTokens: 1, cacheWriteTokens: 0, totalTokens: 16, cost,
    });

    it("lists records in the range, oldest first, with numeric fields", async () => {
      const now = Date.now();
      await stores.tokenUsageStore.record(record(new Date(now - 2 * 86_400_000).toISOString(), 0.5));
      await stores.tokenUsageStore.record(record(new Date(now - 60_000).toISOString(), 0.25));
      await stores.tokenUsageStore.record(record(new Date(now - 10 * 86_400_000).toISOString(), 1));
      const week = await stores.tokenUsageStore.list("7d");
      expect(week.map((r) => r.cost)).toEqual([0.5, 0.25]);
      expect(week[0]).toMatchObject({ model: "m", totalTokens: 16, source: "agent_chat" });
      expect((await stores.tokenUsageStore.list("all")).length).toBe(3);
      expect((await stores.tokenUsageStore.list("24h")).length).toBe(1);
    });
  });

  // ── Context checkpoints ─────────────────────────────────────────────

  describe("DrizzleContextCheckpointStore", () => {
    const cp = (revision: string) => ({ version: 1 as const, revision, scope: "s", prefixHashes: [HASH], summary: "sum" });

    it("compare-and-swaps on the revision", async () => {
      const store = stores.contextCheckpointStore;
      expect(await store.load("s1")).toBeNull();
      expect(await store.save("s1", cp("r1"), null)).toBe(true);
      expect(await store.save("s1", cp("rX"), null)).toBe(false); // already exists
      expect(await store.save("s1", cp("r2"), "stale")).toBe(false);
      expect(await store.save("s1", cp("r2"), "r1")).toBe(true);
      expect((await store.load("s1"))?.revision).toBe("r2");
    });
  });

  // ── Apps ─────────────────────────────────────────────────────────────

  describe("DrizzleAppRegistryStore", () => {
    const app = (slug: string, name: string) => ({ slug, name, description: "", tags: [] } as any);

    it("creates, finds by id or slug, updates, deletes", async () => {
      const store = stores.appRegistryStore;
      const events: string[] = [];
      store.setEmitter((e: any) => events.push(e.action));
      const b = await store.create(app("beta", "Beta"));
      await store.create(app("alpha", "Alpha"));
      expect((await store.list()).map((a) => a.name)).toEqual(["Alpha", "Beta"]);
      expect((await store.get("beta"))?.id).toBe(b.id);
      expect((await store.get(b.id))?.slug).toBe("beta");
      await expect(store.create(app("beta", "Again"))).rejects.toThrow(/already exists/);
      const updated = await store.update("beta", { name: "Beta 2" } as any);
      expect(updated?.name).toBe("Beta 2");
      expect(updated?.createdAt).toBe(b.createdAt);
      await expect(store.update("alpha", { slug: "beta" } as any)).rejects.toThrow(/already exists/);
      expect(await store.delete("beta")).toBe(true);
      expect(await store.delete("beta")).toBe(false);
      expect(events).toEqual(["created", "created", "updated", "deleted"]);
    });
  });

  // ── Data registry ────────────────────────────────────────────────────

  describe("DrizzleDataRegistryStore", () => {
    it("handles sources, views and capped activity", async () => {
      const store = stores.dataRegistryStore;
      const source = await store.createSource({ slug: "crm", name: "CRM", kind: "sqlite" } as any);
      expect((await store.getSource("crm"))?.id).toBe(source.id);
      await expect(store.createSource({ slug: "crm", name: "x" } as any)).rejects.toThrow(/already exists/);
      const view = await store.createView({ name: "V", sourceId: source.id } as any);
      await store.updateView(view.id, { name: "V2" } as any);
      expect((await store.listViews())[0]?.name).toBe("V2");
      for (let i = 0; i < 3; i++) await store.addActivity({ sourceId: source.id, action: "query", status: "succeeded" } as any);
      await store.addActivity({ sourceId: "other", action: "query", status: "succeeded" } as any);
      expect((await store.listActivity()).length).toBe(4);
      expect((await store.listActivity(source.id)).length).toBe(3);
      expect(await store.deleteView(view.id)).toBe(true);
      expect(await store.deleteSource("crm")).toBe(true);
      expect(await store.getSource("crm")).toBeNull();
    });
  });

  // ── Company brain ────────────────────────────────────────────────────

  describe("DrizzleCompanyBrainStore", () => {
    const entity = (id: string) => ({ id, type: "company", name: id, aliases: [], properties: {}, tags: [], confidence: 1, status: "confirmed", evidence: [], createdAt: "1", updatedAt: "1" } as any);
    const run = (id: string) => ({ id, kind: "text", label: id, status: "succeeded", entitiesCreated: 0, entitiesUpdated: 0, relationsCreated: 0, claimsCreated: 0, warnings: [], startedAt: id } as any);

    it("keeps array order and writes only what changed", async () => {
      const store = stores.companyBrainStore;
      await store.transaction((s) => { s.entities.push(entity("e1"), entity("e2")); s.runs.unshift(run("r1")); });
      await store.transaction((s) => { s.entities.push(entity("e3")); s.runs.unshift(run("r2")); });
      let snap = await store.snapshot();
      expect(snap.entities.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
      expect(snap.runs.map((r) => r.id)).toEqual(["r2", "r1"]);
      const result = await store.transaction((s) => {
        s.entities = s.entities.filter((e) => e.id !== "e2");
        s.entities[0]!.name = "renamed";
        const index = s.runs.findIndex((r) => r.id === "r1");
        s.runs[index] = { ...s.runs[index]!, status: "failed" };
        return "done";
      });
      expect(result).toBe("done");
      snap = await store.snapshot();
      expect(snap.entities.map((e) => [e.id, e.name])).toEqual([["e1", "renamed"], ["e3", "e3"]]);
      expect(snap.runs.map((r) => [r.id, r.status])).toEqual([["r2", "succeeded"], ["r1", "failed"]]);
    });

    it("caps runs at 250, newest kept", async () => {
      const store = stores.companyBrainStore;
      await store.transaction((s) => { for (let i = 0; i < 260; i++) s.runs.unshift(run(`r${i}`)); });
      const snap = await store.snapshot();
      expect(snap.runs.length).toBe(250);
      expect(snap.runs[0]!.id).toBe("r259");
    });

    it("serializes concurrent transactions", async () => {
      const store = stores.companyBrainStore;
      await Promise.all(Array.from({ length: 10 }, (_, i) => store.transaction((s) => { s.entities.push(entity(`c${i}`)); })));
      expect((await store.snapshot()).entities.length).toBe(10);
    });
  });

  // ── WhatsApp ─────────────────────────────────────────────────────────

  describe("DrizzleWhatsAppStore", () => {
    const msg = (id: string, chat: string, ts: number, extra: Record<string, unknown> = {}) =>
      ({ id, chatJid: chat, senderJid: chat, text: `t${id}`, fromMe: false, timestamp: ts, ...extra });

    it("stores messages idempotently, filling in details", async () => {
      const wa = stores.whatsappStore;
      await wa.appendMessage(msg("m1", "1@s.whatsapp.net", 100, { text: "[image]" }));
      await wa.appendMessage(msg("m1", "1@s.whatsapp.net", 100, { text: "photo caption", mediaPath: "/x.jpg", senderName: "Ann" }));
      const [m] = await wa.listMessages("1@s.whatsapp.net");
      expect(m).toMatchObject({ text: "photo caption", mediaPath: "/x.jpg", senderName: "Ann", fromMe: false, timestamp: 100 });
      expect(await wa.messageCount()).toBe(1);
    });

    it("lists chats with last message and unread, and marks read", async () => {
      const wa = stores.whatsappStore;
      await wa.appendMessage(msg("a1", "1@s.whatsapp.net", 100));
      await wa.appendMessage(msg("a2", "1@s.whatsapp.net", 200));
      await wa.appendMessage(msg("b1", "2@s.whatsapp.net", 150, { fromMe: true }));
      await wa.upsertContact("1@s.whatsapp.net", "Ann", 200);
      const chats = await wa.listChats();
      expect(chats.map((c) => c.jid)).toEqual(["1@s.whatsapp.net", "2@s.whatsapp.net"]);
      expect(chats[0]).toMatchObject({ name: "Ann", phone: "1", lastMessage: "ta2", lastMessageAt: 200, messageCount: 2, unread: 2 });
      expect(chats[1]).toMatchObject({ unread: 0, messageCount: 1 });
      expect(await wa.markRead(["a1", "a2"])).toBe(2);
      expect((await wa.listChats())[0]!.unread).toBe(0);
      expect((await wa.listMessages("1@s.whatsapp.net", 10, 200)).map((x) => x.id)).toEqual(["a1"]);
    });

    it("searches case-insensitively and resolves contacts by phone or name", async () => {
      const wa = stores.whatsappStore;
      await wa.appendMessage(msg("s1", "1@s.whatsapp.net", 1, { text: "Hello World" }));
      expect((await wa.searchMessages("hello")).length).toBe(1);
      expect((await wa.searchMessages("50%")).length).toBe(0);
      await wa.upsertContact("393331234567@s.whatsapp.net", "Mario Rossi", 10);
      await wa.upsertContact("393331234567@s.whatsapp.net", "Old Name", 5); // older sighting: name kept
      expect((await wa.resolveContact("+39 333 1234567"))?.name).toBe("Mario Rossi");
      expect((await wa.resolveContact("mario"))?.jid).toBe("393331234567@s.whatsapp.net");
      expect((await wa.searchContacts("ROSSI")).length).toBe(1);
      expect((await wa.listContacts())[0]!.lastSeen).toBe(10);
    });
  });
});
