/**
 * Branching a long chat (POST /chat/sessions/:id/fork, the UI's "branch" action) carries the
 * parent's context checkpoint over, so the branch's first long turn does not summarize the whole
 * copied history again. File stores and Drizzle SQLite here; both Drizzle dialects in
 * packages/drizzle/src/__tests__/fork-context-checkpoint.test.ts. Numbers as in
 * compaction-every-turn.test.ts (a live instance): a 272k window and Polpo's real tools.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createSqliteStores, migrateSqlite } from "@polpo-ai/drizzle";
import type { SessionStore } from "@polpo-ai/core";
import { chatRoutes, createSessionCompaction, inspectContextCheckpoint, saveContextCheckpoint, carryContextCheckpoint, type ContextCheckpointStore } from "@polpo-ai/server";
import { ProgressiveToolSet, POLPO_TOOL_GROUPS } from "@polpo-ai/core";
import { ALL_ORCHESTRATOR_TOOLS } from "../llm/orchestrator-tools.js";
import { FileSessionStore } from "../stores/file-session-store.js";
import { FileContextCheckpointStore } from "../stores/file-context-checkpoint-store.js";

const directories: string[] = [];
const closers: Array<() => void> = [];
beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "info").mockImplementation(() => {}); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0)) close();
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const model = { provider: "openai-codex", id: "gpt-6-astra", contextWindow: 272_000, maxTokens: 128_000 };
const tools = new ProgressiveToolSet({ tools: ALL_ORCHESTRATOR_TOOLS as any[], mode: "auto", groups: POLPO_TOOL_GROUPS }).initialTools({ plainMeta: true });
const systemPrompt = "You are the health coach. ".repeat(2_000);
const scopeOf = (session: { createdAt: string; agent?: string | null }, m = model) =>
  JSON.stringify([session.createdAt, session.agent ?? null, m.provider, m.id]);
/** The turn scheduler's history (stored messages) as the completions route gives it to the model. */
const toModel = (messages: Array<{ role: string; content: string }>) => messages
  .filter((m) => m.content.trim())
  .map((m) => m.role === "assistant"
    ? { role: "user", content: `[Previous assistant response]\n${m.content}\n[End previous response]`, timestamp: Date.now() }
    : { role: "user", content: m.content, timestamp: Date.now() });

type Backend = { sessions: SessionStore; checkpoints: ContextCheckpointStore };
const BACKENDS: Array<[string, () => Promise<Backend>]> = [
  ["file stores", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polpo-fork-checkpoint-")); directories.push(dir);
    return { sessions: new FileSessionStore(dir), checkpoints: new FileContextCheckpointStore(dir) };
  }],
  ["drizzle sqlite", async () => {
    const sqlite = new Database(":memory:");
    closers.push(() => sqlite.close());
    const db = drizzle(sqlite);
    migrateSqlite(db);
    const stores = createSqliteStores(db);
    return { sessions: stores.sessionStore, checkpoints: stores.contextCheckpointStore };
  }],
];

describe.each(BACKENDS)("%s", (_name, open) => {
  let backend: Backend;
  beforeEach(async () => { backend = await open(); });

  async function turn(sessionId: string) {
    const session = (await backend.sessions.getSession(sessionId))!;
    const original = toModel(await backend.sessions.getMessages(sessionId));
    const scope = scopeOf(session);
    const inspection = await inspectContextCheckpoint(backend.checkpoints, sessionId, scope, original);
    const compaction = await createSessionCompaction({
      model, settings: {}, systemPrompt: () => systemPrompt, tools: () => tools,
      original, sessionId, scope, store: backend.checkpoints,
    });
    return { inspection, ...(await compaction.prepare([...original])) };
  }

  it("a branch made from the UI after the compacted part reuses the checkpoint on its first turn", async () => {
    const parent = await backend.sessions.create("Coaching", "health-coach");
    for (let i = 0; i < 950; i += 1) {
      await backend.sessions.addMessage(parent, "user", `Domanda ${i}: cosa mangio stasera?`);
      await backend.sessions.addMessage(parent, "assistant", i % 30 === 7 ? "" : `# Risposta ${i}\n\n${"Proteine, carboidrati e grassi del pasto, con le quantità. ".repeat(20)}`);
    }
    await backend.sessions.addMessage(parent, "user", "E domani a pranzo?");
    expect((await turn(parent)).info).not.toBeNull();
    const checkpoint = (await backend.checkpoints.load(parent))!;
    await backend.sessions.addMessage(parent, "assistant", "Pasta e legumi.");

    const events: Array<{ event: string; data: any }> = [];
    const app = chatRoutes(() => ({
      sessionStore: backend.sessions, contextCheckpoints: backend.checkpoints,
      emit: (event, data) => events.push({ event, data }),
    }));
    const messages = await backend.sessions.getMessages(parent);
    const response = await app.request(`/sessions/${parent}/fork`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: messages[messages.length - 1]!.id }),
    });
    expect(response.status).toBe(201);
    const forkId: string = (await response.json()).data.session.id;
    expect(events.find((e) => e.event === "context:checkpoint-carried")?.data).toEqual({
      sessionId: forkId, parentSessionId: parent, agentName: "health-coach",
      coveredMessages: checkpoint.prefixHashes.length, compactionCount: checkpoint.count ?? 1,
    });

    await backend.sessions.addMessage(forkId, "user", "Invece a colazione?");
    const next = await turn(forkId);
    expect(next.inspection.rejected).toBeUndefined();
    expect(next.info).toBeNull();
    expect(String(next.messages[0].content)).toContain("Context checkpoint");
  });

  it("not carried when it covers the question the branch answers again", async () => {
    const parent = await backend.sessions.create("Short", "health-coach");
    await backend.sessions.addMessage(parent, "user", "uno");
    await backend.sessions.addMessage(parent, "assistant", "risposta uno");
    const question = await backend.sessions.addMessage(parent, "user", "due");
    await backend.sessions.addMessage(parent, "assistant", "risposta due");
    const session = (await backend.sessions.getSession(parent))!;
    const original = toModel(await backend.sessions.getMessages(parent));
    expect(await saveContextCheckpoint(backend.checkpoints, parent, scopeOf(session), original, 3, "riassunto", 1, null)).toBeTruthy();

    const fromQuestion = (await backend.sessions.forkSession!(parent, question.id))!;
    expect(await carryContextCheckpoint(backend.checkpoints, session, fromQuestion.session, await backend.sessions.getMessages(fromQuestion.session.id)))
      .toEqual({ carried: false, reason: "it covers the message the branch answers again" });
    expect(await backend.checkpoints.load(fromQuestion.session.id)).toBeNull();

    // from the answer that follows, the person writes next: carried
    const messages = await backend.sessions.getMessages(parent);
    const fromAnswer = (await backend.sessions.forkSession!(parent, messages[3]!.id))!;
    expect((await carryContextCheckpoint(backend.checkpoints, session, fromAnswer.session, await backend.sessions.getMessages(fromAnswer.session.id))).carried).toBe(true);
  });

  it("not carried from a checkpoint made for another session", async () => {
    const parent = await backend.sessions.create("Short");
    await backend.sessions.addMessage(parent, "user", "uno");
    const answer = await backend.sessions.addMessage(parent, "assistant", "risposta uno");
    const session = (await backend.sessions.getSession(parent))!;
    const original = toModel(await backend.sessions.getMessages(parent));
    await saveContextCheckpoint(backend.checkpoints, parent, JSON.stringify(["2020-01-01T00:00:00.000Z", null, "p", "m"]), original, 1, "riassunto", 1, null);
    const fork = (await backend.sessions.forkSession!(parent, answer.id))!;
    expect(await carryContextCheckpoint(backend.checkpoints, session, fork.session, await backend.sessions.getMessages(fork.session.id)))
      .toEqual({ carried: false, reason: "made for another session" });
  });
});
