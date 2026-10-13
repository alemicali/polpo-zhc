import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileConversationCheckStore } from "../stores/file-conversation-check-store.js";
import { ConversationCheckManager, isNothingToReport, MAX_ACTIVE_CHECKS_PER_SESSION, parseCheckTime } from "../core/conversation-check-manager.js";
import { execCancelCheck, execListChats, execListChecks, execScheduleCheck, execSendMessage, type ChatAccess } from "../tools/conversation-check-tools.js";
import { botOrder, buildChatDirectory, chatTarget, resolveChat } from "../core/chat-directory.js";
import { Orchestrator } from "../core/orchestrator.js";

const GROUP = { channel: "team-bot", chatId: "-100123", conversation: "telegram:group:-100123" };

let dir: string;
let store: FileConversationCheckStore;
let manager: ConversationCheckManager;
const runner = vi.fn();
const delivery = vi.fn(async () => {});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "polpo-checks-"));
  store = new FileConversationCheckStore(dir);
  manager = new ConversationCheckManager(store);
  runner.mockReset();
  delivery.mockClear();
  manager.setRunner(runner);
  manager.setDelivery(delivery);
});
afterEach(() => {
  manager.dispose();
  rmSync(dir, { recursive: true, force: true });
});

/** Run what is due and wait for the runs it started. */
async function tick(at: Date): Promise<void> {
  await manager.tick(at);
  await vi.waitFor(() => expect((manager as any).running.size).toBe(0));
}
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

describe("ConversationCheckManager", () => {
  it("delivers a report, stays silent on NO_UPDATE, schedules the next run", async () => {
    const check = await manager.create({ sessionId: "s1", agent: "ops", prompt: "is the site up?", everyMinutes: 2, target: GROUP });
    await tick(new Date()); // not due yet
    expect(runner).not.toHaveBeenCalled();

    runner.mockResolvedValueOnce({ text: "NO_UPDATE" });
    await tick(later(3));
    expect(runner).toHaveBeenCalledTimes(1);
    expect(delivery).not.toHaveBeenCalled();
    let current = await store.getCheck(check.id);
    expect(current).toMatchObject({ runs: 1, state: "active" });
    expect(current!.nextRunAt > check.nextRunAt).toBe(true);

    runner.mockResolvedValueOnce({ text: "  The site is down (502).  " });
    await tick(later(10));
    expect(delivery).toHaveBeenCalledWith(expect.objectContaining({ id: check.id }), "The site is down (502).");
    current = await store.getCheck(check.id);
    expect(current).toMatchObject({ runs: 2, lastReport: "The site is down (502)." });
  });

  it("ends after max runs; a deferred run is retried; errors keep the schedule", async () => {
    const check = await manager.create({ sessionId: "s1", prompt: "ping", everyMinutes: 1, maxRuns: 2 });
    runner.mockResolvedValueOnce("deferred");
    await tick(later(2));
    expect((await store.getCheck(check.id))!.runs).toBe(0);

    runner.mockRejectedValueOnce(new Error("model unavailable"));
    await tick(later(2));
    expect(await store.getCheck(check.id)).toMatchObject({ runs: 1, state: "active", lastError: "model unavailable" });

    runner.mockResolvedValueOnce({ text: "ok" });
    await tick(later(10));
    const ended = await store.getCheck(check.id);
    expect(ended).toMatchObject({ runs: 2, state: "ended" });
    expect(ended!.lastError).toBeUndefined();
    await tick(later(30));
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it("cancelled checks stop; checks past their end time end", async () => {
    const a = await manager.create({ sessionId: "s1", prompt: "a", everyMinutes: 1 });
    const b = await manager.create({ sessionId: "s1", prompt: "b", everyMinutes: 1, endsAt: later(1).toISOString() });
    await manager.cancel(a.id);
    runner.mockResolvedValue({ text: "x" });
    await tick(later(5));
    expect(runner).not.toHaveBeenCalled();
    expect((await store.getCheck(a.id))!.state).toBe("cancelled");
    expect((await store.getCheck(b.id))!.state).toBe("ended");
  });

  it("validates new checks and refuses checks started from a check run", async () => {
    await expect(manager.create({ sessionId: "s1", prompt: " ", everyMinutes: 2 })).rejects.toThrow(/what to do/);
    await expect(manager.create({ sessionId: "s1", prompt: "x", everyMinutes: 0.5 })).rejects.toThrow(/at least 1 minute/);
    const check = await manager.create({ sessionId: "s1", prompt: "x", everyMinutes: 2 });
    await manager.setRunSession(check.id, "run-session");
    await expect(manager.create({ sessionId: "run-session", prompt: "y", everyMinutes: 2 })).rejects.toThrow(/cannot schedule/);
    for (let i = 1; i < MAX_ACTIVE_CHECKS_PER_SESSION; i++) await manager.create({ sessionId: "s1", prompt: `x${i}`, everyMinutes: 2 });
    await expect(manager.create({ sessionId: "s1", prompt: "one more", everyMinutes: 2 })).rejects.toThrow(/already has/);
  });

  it("isNothingToReport", () => {
    expect(isNothingToReport("NO_UPDATE")).toBe(true);
    expect(isNothingToReport(" `NO_UPDATE`. ")).toBe(true);
    expect(isNothingToReport("")).toBe(true);
    expect(isNothingToReport("No update: all fine")).toBe(false);
  });
});

describe("check tools", () => {
  it("schedule_check targets the chat the turn came from; list and cancel stay in that chat", async () => {
    const ctx = { manager, sessionId: "s1", agent: "ops", origin: { ...GROUP, threadId: 4, conversation: "telegram:group:-100123:topic:4" } };
    const created = await execScheduleCheck({ every_minutes: 2, instructions: "check https://example.com", max_runs: 30 }, ctx);
    expect(created).toMatch(/^Check chk_[\w-]+ scheduled every 2 min, .*Reports go to this Telegram group topic/);
    const id = /chk_[\w-]+/.exec(created)![0];
    expect(await store.getCheck(id)).toMatchObject({ agent: "ops", maxRuns: 30, target: ctx.origin });

    expect(await execListChecks(ctx)).toContain(`${id} [active] every 2 min (up to 30 runs)`);
    expect(await execListChecks({ manager, sessionId: "other" })).toMatch(/^No scheduled checks in this chat/);
    // another agent, in another chat, cannot stop it; Polpo (no agent) can stop any
    expect(await execCancelCheck({ id }, { manager, sessionId: "other", agent: "dev" })).toBe(`Error: no check ${id}`);
    expect(await execCancelCheck({ id }, ctx)).toBe(`Check ${id} cancelled.`);

    expect(await execScheduleCheck({ every_minutes: 5, instructions: "x" }, { manager })).toMatch(/persisted chat session/);
    expect(await execScheduleCheck({ every_minutes: 5, instructions: "web" }, { manager, sessionId: "web" })).toMatch(/Reports go to this chat session/);
  });
});

describe("scheduling: once, cron, fixed messages", () => {
  it("runs once at a time and ends", async () => {
    const at = later(30).toISOString();
    const check = await manager.create({ sessionId: "s1", prompt: "tell them", everyMinutes: 0, firstRunAt: at });
    expect(check).toMatchObject({ everyMinutes: 0, nextRunAt: at });
    runner.mockResolvedValueOnce({ text: "Time for the meeting" });
    await tick(later(31));
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(await store.getCheck(check.id)).toMatchObject({ runs: 1, state: "ended" });
    await expect(manager.create({ sessionId: "s1", prompt: "x", everyMinutes: 0 })).rejects.toThrow(/Say when it runs/);
  });

  it("follows a cron in its timezone", async () => {
    const check = await manager.create({ sessionId: "s1", prompt: "weekly digest", everyMinutes: 5, cron: "0 9 * * 1", timezone: "Europe/Rome" });
    expect(check.everyMinutes).toBe(0);
    const first = new Date(check.nextRunAt);
    // Monday 9:00 in Rome is 7:00 or 8:00 UTC
    expect(first.getUTCDay()).toBe(1);
    expect([7, 8]).toContain(first.getUTCHours());
    runner.mockResolvedValueOnce({ text: "digest" });
    await tick(new Date(first.getTime() + 1000));
    const after = await store.getCheck(check.id);
    expect(after).toMatchObject({ runs: 1, state: "active" });
    expect(Date.parse(after!.nextRunAt) - first.getTime()).toBeGreaterThanOrEqual(6.9 * 24 * 3600_000);
    await expect(manager.create({ sessionId: "s1", prompt: "x", everyMinutes: 0, cron: "not a cron" })).rejects.toThrow(/Invalid cron/);
  });

  it("sends a fixed message without running the agent", async () => {
    const check = await manager.create({ sessionId: "s1", prompt: "", message: "Stand-up in 10 minutes!", everyMinutes: 0, firstRunAt: later(1).toISOString(), target: GROUP });
    expect(check.prompt).toMatch(/Stand-up in 10 minutes/);
    await tick(later(2));
    expect(runner).not.toHaveBeenCalled();
    expect(delivery).toHaveBeenCalledWith(expect.objectContaining({ id: check.id }), "Stand-up in 10 minutes!");
  });

  it("parseCheckTime reads local times in a timezone", () => {
    expect(parseCheckTime("2026-10-14T09:00", "Europe/Rome")!.toISOString()).toBe("2026-10-14T07:00:00.000Z");
    expect(parseCheckTime("2026-10-14T09:00:00Z")!.toISOString()).toBe("2026-10-14T09:00:00.000Z");
    expect(parseCheckTime("tomorrow")).toBeUndefined();
  });
});

const peers = [
  { id: "telegram:group:-100123", channel: "telegram" as const, externalId: "group:-100123", displayName: "Team Marketing", firstSeenAt: "2026-10-01", lastSeenAt: "2026-10-12T10:00:00Z" },
  { id: "telegram:42", channel: "telegram" as const, externalId: "42", displayName: "Marco Rossi", firstSeenAt: "2026-10-01", lastSeenAt: "2026-10-12T11:00:00Z" },
  { id: "telegram:group:-100999", channel: "telegram" as const, externalId: "group:-100999", displayName: "Team Sales", firstSeenAt: "2026-10-01", lastSeenAt: "2026-10-11T10:00:00Z" },
];
const rooms = [
  { id: "telegram:group:-100123:topic:7", kind: "telegram" as const, title: "Releases", agents: [], settings: {}, createdAt: "2026-10-01", updatedAt: "2026-10-12T09:00:00Z" },
];

describe("chat directory", () => {
  const chats = buildChatDirectory(peers as any, rooms as any);

  it("lists groups, topics and people", () => {
    expect(chats.map(c => [c.id, c.kind, c.name])).toEqual([
      ["telegram:42", "person", "Marco Rossi"],
      ["telegram:group:-100123", "group", "Team Marketing"],
      ["telegram:group:-100123:topic:7", "topic", "Team Marketing › Releases"],
      ["telegram:group:-100999", "group", "Team Sales"],
    ]);
  });

  it("resolves names, ids and topics; refuses unknown or ambiguous names", () => {
    expect(resolveChat(chats, "team marketing").id).toBe("telegram:group:-100123");
    expect(resolveChat(chats, "Marco").id).toBe("telegram:42");
    expect(resolveChat(chats, "Releases").id).toBe("telegram:group:-100123:topic:7");
    expect(resolveChat(chats, "Team Marketing", 7).threadId).toBe(7);
    expect(resolveChat(chats, "-100555")).toMatchObject({ kind: "group", chatId: "-100555" });
    expect(resolveChat(chats, "telegram:group:-100999").name).toBe("Team Sales");
    expect(() => resolveChat(chats, "Team")).toThrow(/several chats/);
    expect(() => resolveChat(chats, "Finance")).toThrow(/No chat called "Finance"/);
  });

  it("tries the agent's own bot, then the bots in the group, then any", () => {
    const bots = [
      { key: "main" },
      { key: "ops-bot", agent: "ops" },
      { key: "dev-bot", agent: "dev", isIn: (c: string) => c === "telegram:group:-100123" },
    ];
    expect(botOrder(bots, { channel: "", conversation: "telegram:group:-100123" }, "ops")).toEqual(["ops-bot", "dev-bot", "main"]);
    expect(botOrder(bots, { channel: "", conversation: "telegram:group:-100123" })).toEqual(["main", "dev-bot", "ops-bot"]);
    expect(botOrder(bots, { channel: "dev-bot" }, "ops")).toEqual(["dev-bot", "ops-bot", "main"]);
  });
});

describe("sending anywhere", () => {
  const chats = buildChatDirectory(peers as any, rooms as any);
  const sent: Array<[string, string, string]> = [];
  const access: ChatAccess = {
    listChats: async () => chats,
    chatBots: () => [{ key: "main" }, { key: "ops-bot", agent: "ops" }],
    resolveChatTarget: async (to, opts) => chatTarget(resolveChat(chats, to, opts?.topic), opts?.agent === "ops" ? "ops-bot" : "main"),
    sendToChat: async (target, text) => { sent.push([target.channel, target.chatId, text]); return target.channel; },
  };
  beforeEach(() => { sent.length = 0; });

  it("schedule_check to another chat, from a web chat, with a cron or once", async () => {
    const ctx = { manager, sessionId: "web-1", agent: "ops", chats: access, timezone: "Europe/Rome" };
    const weekly = await execScheduleCheck({ to: "Team Marketing", cron: "0 9 * * 1", message: "Weekly sync at 10!" }, ctx);
    expect(weekly).toMatch(/scheduled cron "0 9 \* \* 1" \(Europe\/Rome\), first run at \d{4}-\d\d-\d\d 09:00 Europe\/Rome\. Reports go to the Telegram group "Team Marketing"/);
    const id = /chk_[\w-]+/.exec(weekly)![0];
    expect(await store.getCheck(id)).toMatchObject({ message: "Weekly sync at 10!", cron: "0 9 * * 1", timezone: "Europe/Rome", target: { channel: "ops-bot", chatId: "-100123", conversation: "telegram:group:-100123" } });

    const once = await execScheduleCheck({ to: "Marco", in_minutes: 20, instructions: "tell Marco how the deploy went" }, ctx);
    expect(once).toMatch(/scheduled once, runs at .*Reports go to the Telegram chat "Marco Rossi"/);
    expect(await execScheduleCheck({ to: "Marco", at: "2020-01-01T09:00", message: "x" }, ctx)).toMatch(/in the past/);
    expect(await execScheduleCheck({ to: "Nobody", every_minutes: 5, message: "x" }, ctx)).toMatch(/No chat called "Nobody"/);

    expect(await execListChecks({ manager, sessionId: "elsewhere", agent: "ops" }, { all: true })).toContain(id);
  });

  it("send_message and list_chats", async () => {
    expect(await execSendMessage({ to: "Team Sales", text: "Release is out" }, { chats: access, agent: "ops" })).toBe('Sent to the Telegram group "Team Sales" (bot ops-bot).');
    expect(sent).toEqual([["ops-bot", "-100999", "Release is out"]]);
    expect(await execSendMessage({ to: "Team", text: "x" }, { chats: access })).toMatch(/several chats/);
    expect(await execSendMessage({ to: "Team Sales", text: "x" }, {})).toMatch(/no Telegram bot/);
    const list = await execListChats({ chats: access });
    expect(list).toMatch(/^Now: .*Telegram bots: main \(Polpo\), ops-bot \(ops\)/);
    expect(list).toContain("- Team Marketing [group] to: telegram:group:-100123");
  });

  it("the orchestrator falls back to another bot when Telegram refuses", async () => {
    const calls: string[] = [];
    const poller = (key: string, ok: boolean) => ({ sendMarkdown: vi.fn(async () => { calls.push(key); return ok; }) });
    const recorded = vi.fn(async () => {});
    const fake = {
      chatBots: () => [{ key: "main" }, { key: "ops-bot", agent: "ops" }],
      telegramPollersByChannel: new Map([["main", poller("main", true)], ["ops-bot", poller("ops-bot", false)]]),
      channelGateways: new Map([["main", { recordConversationReport: recorded }]]),
    };
    const target = { channel: "ops-bot", chatId: "-100123", conversation: "telegram:group:-100123", name: "Team Marketing" };
    expect(await Orchestrator.prototype.sendToChat.call(fake as any, target, "hello", "ops")).toBe("main");
    expect(calls).toEqual(["ops-bot", "main"]);
    expect(recorded).toHaveBeenCalledWith("telegram:group:-100123", "hello");
    fake.telegramPollersByChannel.set("main", poller("main", false));
    await expect(Orchestrator.prototype.sendToChat.call(fake as any, target, "hello", "ops")).rejects.toThrow(/refused the message to Team Marketing from every bot/);
  });
});
