/**
 * A branch of a long chat starts with its parent's context checkpoint (session store + context
 * checkpoint store of this package, compaction of @polpo-ai/server), on SQLite always and on
 * PostgreSQL when POLPO_TEST_DATABASE_URL is set (see stores.test.ts).
 *
 * Before: the checkpoint is scoped to the session's creation time, so a branch had none and its
 * first long turn summarized the whole copied history again.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { drizzle as pgDrizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createPgStores, createSqliteStores, migratePg, migrateSqlite, type DrizzleStores } from "../index.js";

const PG_URL = process.env.POLPO_TEST_DATABASE_URL;
const DIALECTS = ["sqlite", ...(PG_URL ? ["postgres"] : [])] as const;

// @polpo-ai/server is built after this package (build:packages): loaded at run time from its
// dist, through a specifier the compiler does not follow.
const SERVER = "@polpo-ai/server";
let server: any;

const model = { provider: "openai-codex", id: "gpt-6-astra", contextWindow: 64_000, maxTokens: 16_000 };
const otherModel = { ...model, id: "gpt-6-astra-mini" };
const scopeOf = (session: { createdAt: string; agent?: string | null }, m = model) =>
  JSON.stringify([session.createdAt, session.agent ?? null, m.provider, m.id]);
/** What a turn sends the model for the stored messages (turn scheduler → completions). */
const toModel = (messages: Array<{ role: string; content: string }>) => messages
  .filter((m) => m.role === "user" || m.role === "assistant")
  .map((m) => m.role === "assistant"
    ? { role: "user", content: `[Previous assistant response]\n${m.content}\n[End previous response]`, timestamp: Date.now() }
    : { role: "user", content: m.content, timestamp: Date.now() });

describe.each(DIALECTS)("%s", (dialect) => {
  let stores: DrizzleStores;
  let sqlite: InstanceType<typeof Database> | undefined;
  let pg: ReturnType<typeof postgres> | undefined;
  let pgDb: ReturnType<typeof pgDrizzle> | undefined;

  beforeAll(async () => {
    server = await import(SERVER);
    if (dialect !== "postgres") return;
    pg = postgres(PG_URL!, { max: 4, onnotice: () => {} });
    pgDb = pgDrizzle(pg);
    await migratePg(pgDb);
  });
  afterAll(async () => { await pg?.end({ timeout: 5 }); });

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    if (dialect === "sqlite") {
      sqlite = new Database(":memory:");
      const db = drizzle(sqlite);
      migrateSqlite(db);
      sqlite.exec("PRAGMA foreign_keys = ON");
      stores = createSqliteStores(db);
      return;
    }
    const tables = await pg!`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
    await pg!.unsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
    stores = createPgStores(pgDb!);
  });
  afterEach(() => { vi.restoreAllMocks(); sqlite?.close(); sqlite = undefined; });

  /** A turn of `sessionId`: compaction with the session's scope over its stored history. */
  async function turn(sessionId: string, m = model) {
    const session = (await stores.sessionStore.getSession(sessionId))!;
    const original = toModel(await stores.sessionStore.getMessages(sessionId));
    const scope = scopeOf(session, m);
    const inspection = await server.inspectContextCheckpoint(stores.contextCheckpointStore, sessionId, scope, original);
    const compaction = await server.createSessionCompaction({
      model: m, settings: {}, systemPrompt: () => "You are the health coach.", tools: () => [],
      original, sessionId, scope, store: stores.contextCheckpointStore,
    });
    const { info, messages } = await compaction.prepare([...original]);
    return { inspection, info, messages };
  }

  /** A long chat, compacted once: the checkpoint covers its first messages, not the last ones. */
  async function compactedParent() {
    const parent = await stores.sessionStore.create("Coaching", "health-coach");
    for (let i = 0; i < 120; i += 1) {
      await stores.sessionStore.addMessage(parent, "user", `Domanda ${i}: cosa mangio stasera?`);
      await stores.sessionStore.addMessage(parent, "assistant", i % 30 === 7 ? "" : `# Risposta ${i}\n\n${"Proteine, carboidrati e grassi del pasto, con le quantità. ".repeat(20)}`);
    }
    await stores.sessionStore.addMessage(parent, "user", "E domani a pranzo?");
    const first = await turn(parent);
    expect(first.info).not.toBeNull();
    const checkpoint = (await stores.contextCheckpointStore.load(parent))!;
    expect(checkpoint.version).toBe(2);
    const messages = await stores.sessionStore.getMessages(parent);
    // index (in the stored messages) of the last message the checkpoint covers
    let withText = 0;
    let lastCovered = -1;
    for (let i = 0; i < messages.length && withText < checkpoint.prefixHashes.length; i += 1) {
      if (messages[i]!.content.trim()) { withText += 1; lastCovered = i; }
    }
    expect(lastCovered).toBeGreaterThan(10);
    expect(lastCovered).toBeLessThan(messages.length - 2);
    return { parent, checkpoint, messages, lastCovered };
  }

  it("a branch after the covered messages starts from the parent's checkpoint and does not compact again", async () => {
    const { parent, checkpoint, messages } = await compactedParent();
    const replyIndex = messages.length - 2; // the last answer, before the pending question
    expect(messages[replyIndex]!.role).toBe("assistant");
    const fork = (await stores.sessionStore.forkSession!(parent, messages[replyIndex]!.id))!;
    const parentSession = (await stores.sessionStore.getSession(parent))!;

    const carry = await server.carryContextCheckpoint(stores.contextCheckpointStore, parentSession, fork.session,
      await stores.sessionStore.getMessages(fork.session.id));
    expect(carry).toEqual({ carried: true, covers: checkpoint.prefixHashes.length, count: checkpoint.count ?? 1 });
    const copy = (await stores.contextCheckpointStore.load(fork.session.id))!;
    expect(copy).toMatchObject({ version: 2, summary: checkpoint.summary, prefixHashes: checkpoint.prefixHashes, scope: scopeOf(fork.session) });
    expect(copy.revision).not.toBe(checkpoint.revision);
    // the parent's checkpoint is untouched
    expect(await stores.contextCheckpointStore.load(parent)).toEqual(checkpoint);

    // the branch's next turn reuses it: no compaction, the summary first
    await stores.sessionStore.addMessage(fork.session.id, "user", "Invece a colazione?");
    const next = await turn(fork.session.id);
    expect(next.inspection.rejected).toBeUndefined();
    expect(next.inspection.checkpoint).not.toBeNull();
    expect(next.info).toBeNull();
    expect(String(next.messages[0].content)).toContain("Context checkpoint");
    expect(String(next.messages[next.messages.length - 1].content)).toBe("Invece a colazione?");

    // with another model the copy is not used, as on the parent
    const other = await turn(fork.session.id, otherModel);
    expect(other.inspection.rejected).toBe("made for another model or session");
  });

  it("a branch from a question after the covered messages gets it too", async () => {
    const { parent, checkpoint, messages, lastCovered } = await compactedParent();
    const question = messages.findIndex((m, i) => i > lastCovered && m.role === "user");
    const fork = (await stores.sessionStore.forkSession!(parent, messages[question]!.id))!;
    const carry = await server.carryContextCheckpoint(stores.contextCheckpointStore,
      (await stores.sessionStore.getSession(parent))!, fork.session, await stores.sessionStore.getMessages(fork.session.id));
    expect(carry.carried).toBe(true);
    const next = await turn(fork.session.id);
    expect(next.inspection.checkpoint?.covered).toBeGreaterThan(0);
    expect(next.info).toBeNull();
    expect((await stores.contextCheckpointStore.load(fork.session.id))?.summary).toBe(checkpoint.summary);
  });

  it("a branch inside the covered messages does not get it", async () => {
    const { parent, messages, lastCovered } = await compactedParent();
    const fork = (await stores.sessionStore.forkSession!(parent, messages[lastCovered - 4]!.id))!;
    const carry = await server.carryContextCheckpoint(stores.contextCheckpointStore,
      (await stores.sessionStore.getSession(parent))!, fork.session, await stores.sessionStore.getMessages(fork.session.id));
    expect(carry).toEqual({ carried: false, reason: "it covers messages after the branch point" });
    expect(await stores.contextCheckpointStore.load(fork.session.id)).toBeNull();
  });

  it("a branch with another agent does not get it", async () => {
    const { parent, messages } = await compactedParent();
    const fork = (await stores.sessionStore.forkSession!(parent, messages[messages.length - 2]!.id))!;
    const carry = await server.carryContextCheckpoint(stores.contextCheckpointStore,
      (await stores.sessionStore.getSession(parent))!, { ...fork.session, agent: "other-agent" },
      await stores.sessionStore.getMessages(fork.session.id));
    expect(carry).toEqual({ carried: false, reason: "the branch has another agent" });
    expect(await stores.contextCheckpointStore.load(fork.session.id)).toBeNull();
  });
});
