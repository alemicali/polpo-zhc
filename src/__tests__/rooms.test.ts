import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelGateway, type ChannelChatRunner } from "../notifications/channel-gateway.js";
import { FileRoomStore } from "../stores/file-room-store.js";
import type { PeerStore } from "../core/peer-store.js";
import type { SessionStore } from "../core/session-store.js";
import type { Orchestrator } from "../core/orchestrator.js";

const GROUP = "-100123";
const ROOM = `telegram:group:${GROUP}`;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "polpo-rooms-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ── The file store ───────────────────────────────────────

describe("FileRoomStore", () => {
  it("keeps rooms and one transcript, a channel message stored once", async () => {
    const store = new FileRoomStore(dir);
    const room = await store.ensureRoom({ id: ROOM, kind: "telegram", title: "Team" });
    expect(await store.ensureRoom({ id: ROOM, kind: "telegram", title: "Other" })).toEqual(room);
    const q = await store.addMessage(ROOM, { authorKind: "person", authorId: "telegram:7", authorName: "Ada", text: "budget?", externalId: "1" });
    expect((await store.addMessage(ROOM, { authorKind: "person", authorId: "telegram:7", authorName: "Ada", text: "budget?", externalId: "1" })).id).toBe(q.id);
    const a = await store.addMessage(ROOM, { authorKind: "agent", authorId: "growth", authorName: "Giulia", text: "420 €", replyToId: q.id });
    const b = await store.addMessage(ROOM, { authorKind: "person", authorId: "telegram:7", authorName: "Ada", text: "thanks" });
    expect((await store.getRecentMessages(ROOM, 10)).map((m) => m.text)).toEqual(["budget?", "420 €", "thanks"]);
    expect((await store.getMessagesAfter(ROOM, a.id, 10)).map((m) => m.id)).toEqual([b.id]);
    expect(await store.updateRoom(ROOM, { settings: { replyOrder: "sequential" } })).toMatchObject({ settings: { replyOrder: "sequential" } });
    expect((await new FileRoomStore(dir).listRooms()).map((r) => r.id)).toEqual([ROOM]);
    expect(await store.deleteRoom(ROOM)).toBe(true);
    expect(await store.listRooms()).toEqual([]);
  });
});

// ── Two bots of one group, one room ──────────────────────

function fakes() {
  const allow = new Set<string>([`telegram:group:${GROUP}`, "telegram:7"]);
  const kv = new Map<string, string>();
  const peerStore = {
    isAllowed: vi.fn(async (id: string) => allow.has(id)),
    upsertPeer: vi.fn(async () => undefined),
    updatePresence: vi.fn(),
    getPeer: vi.fn(async () => undefined),
    getSessionId: vi.fn(async (k: string) => kv.get(k)),
    setSessionId: vi.fn(async (k: string, v: string) => { kv.set(k, v); }),
    resolveCanonicalId: vi.fn(async (id: string) => id),
  } as unknown as PeerStore;
  const sessions = new Map<string, { id: string; updatedAt: string }>();
  let seq = 0;
  const sessionStore = {
    create: vi.fn(async () => { const id = `s${++seq}`; sessions.set(id, { id, updatedAt: new Date().toISOString() }); return id; }),
    getSession: vi.fn(async (id: string) => sessions.get(id)),
    getRecentMessages: vi.fn(async () => []),
    addMessage: vi.fn(async () => undefined),
  } as unknown as SessionStore;
  return { peerStore, sessionStore };
}

function bots() {
  const roomStore = new FileRoomStore(dir);
  const { peerStore, sessionStore } = fakes();
  const runner = vi.fn<ChannelChatRunner>(async ({ agent }) => ({ text: agent === "growth" ? "420 € left this week." : "Paid, receipt in the folder." }));
  const orchestrator = {
    getAgents: vi.fn().mockResolvedValue([
      { name: "growth", role: "Growth", identity: { displayName: "Giulia" } },
      { name: "ops", role: "Operations", identity: { displayName: "Otto" } },
    ]),
    getChannelChatRunner: vi.fn().mockReturnValue(runner),
    getConfig: vi.fn().mockReturnValue({ project: "test", settings: {} }),
  } as unknown as Orchestrator;
  const gateway = (key: string, agent: string) => new ChannelGateway({
    orchestrator, peerStore, sessionStore, roomStore, key,
    channelConfig: { type: "telegram", botToken: "fake", chatId: "7", gateway: { enableInbound: true, agent } },
  });
  const growth = gateway("growth-bot", "growth");
  const ops = gateway("ops-bot", "ops");
  let id = 100;
  /** Ada writes once; every bot gets its copy, addressed to some of them. */
  const say = async (text: string, to: Array<"growth" | "ops"> = []) => {
    const messageId = String(id++);
    const copy = (g: ChannelGateway, name: "growth" | "ops") => g.handleMessageReply({
      channel: "telegram", externalId: "7", chatId: GROUP, displayName: "Ada", text, messageId,
      group: { title: "Team", addressed: to.includes(name) },
    });
    return Promise.all([copy(growth, "growth"), copy(ops, "ops")]);
  };
  const turnOf = (agent: string) => {
    const call = runner.mock.calls.filter(([r]) => r.agent === agent).at(-1)![0];
    return call.messages.at(-1)!.content as string;
  };
  return { roomStore, runner, say, turnOf };
}

describe("ChannelGateway — groups as rooms", () => {
  it("one transcript for the group: people once, every agent's reply with what it answers", async () => {
    const { roomStore, say } = bots();
    await say("lunch at 1?");
    const [reply] = await say("how much ads budget is left?", ["growth"]);
    expect(reply?.text).toBe("420 € left this week.");
    const room = await roomStore.getRoom(ROOM);
    expect(room).toMatchObject({ kind: "telegram", title: "Team" });
    const lines = await roomStore.getRecentMessages(ROOM, 10);
    expect(lines.map((m) => `${m.authorName}: ${m.text}`)).toEqual([
      "Ada: lunch at 1?",
      "Ada: how much ads budget is left?",
      "Giulia: 420 € left this week.",
    ]);
    expect(lines[1]).toMatchObject({ authorKind: "person", externalId: "101", addressedTo: ["growth"] });
    expect(lines[2]).toMatchObject({ authorKind: "agent", authorId: "growth", replyToId: lines[1]!.id });
  });

  it("an agent reads what the group said since it last spoke, the other agents included", async () => {
    const { say, turnOf } = bots();
    await say("lunch at 1?");
    await say("how much ads budget is left?", ["growth"]);
    expect(turnOf("growth")).toBe("[Earlier in the group]\nAda: lunch at 1?\n\nAda: how much ads budget is left?");

    await say("ok, then pay the ad invoice", ["ops"]);
    expect(turnOf("ops")).toBe(
      "[Earlier in the group]\nAda: lunch at 1?\nAda: how much ads budget is left?\nGiulia (agent): 420 € left this week.\n\nAda: ok, then pay the ad invoice",
    );

    await say("and next week?", ["growth"]);
    expect(turnOf("growth")).toBe(
      "[In the group since your last reply]\nAda: ok, then pay the ad invoice\nOtto (agent): Paid, receipt in the folder.\n\nAda: and next week?",
    );
  });
});
