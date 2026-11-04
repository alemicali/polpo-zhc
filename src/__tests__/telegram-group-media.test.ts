import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelGateway } from "../notifications/channel-gateway.js";
import { TelegramCallbackPoller, type InboundAttachment, type TelegramGatewayHandler, type TelegramMessage } from "../notifications/channels/telegram.js";
import type { PeerStore } from "../core/peer-store.js";
import type { SessionStore } from "../core/session-store.js";
import type { Orchestrator } from "../core/orchestrator.js";

const GROUP = { id: -100123, type: "supergroup" as const, title: "Team" };
const msg = (over: Partial<TelegramMessage>): TelegramMessage => ({
  message_id: 10, chat: GROUP, from: { id: 7, is_bot: false, first_name: "Ada" }, ...over,
});
const voice = { file_id: "voice-file", file_unique_id: "u", duration: 2, mime_type: "audio/ogg", file_size: 100 };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ── Gateway: one transcript line per media message ──

describe("ChannelGateway.describeGroupMedia", () => {
  function gateway(workDir: string) {
    const orchestrator = { getWorkDir: () => workDir, getVaultStore: () => undefined, emit: vi.fn() };
    return new ChannelGateway({
      orchestrator: orchestrator as unknown as Orchestrator,
      peerStore: {} as PeerStore,
      sessionStore: {} as SessionStore,
      channelConfig: { type: "telegram", gateway: { enableInbound: true } } as any,
    });
  }
  const photo: InboundAttachment = { kind: "photo", filename: "photo.jpg", mimeType: "image/jpeg", data: Buffer.from("jpeg") };
  const note: InboundAttachment = { kind: "voice", filename: "voice.ogg", mimeType: "audio/ogg", data: Buffer.from("ogg") };

  it("saves the files in the workspace and transcribes voice notes", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "polpo-group-media-"));
    try {
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: " ci vediamo alle 5 " })));
      vi.stubGlobal("fetch", fetchMock);
      const { text, transcribed } = await gateway(workDir).describeGroupMedia(String(GROUP.id), "57", [photo, note]);
      const photoPath = join(workDir, "workspace", "attachments", "telegram-group-100123", "57-1.jpg");
      expect(text).toBe(`[photo: ${photoPath}] [voice message, transcribed: "ci vediamo alle 5"]`);
      expect(readFileSync(photoPath, "utf8")).toBe("jpeg");
      expect(existsSync(join(workDir, "workspace", "attachments", "telegram-group-100123", "57-2.ogg"))).toBe(true);
      expect(transcribed).toEqual([note]);
      expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("api.openai.com/v1/audio/transcriptions");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("without a speech-to-text key the voice note is kept and pointed to", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "polpo-group-media-"));
    try {
      vi.stubEnv("OPENAI_API_KEY", "");
      vi.stubEnv("DEEPGRAM_API_KEY", "");
      const { text, transcribed } = await gateway(workDir).describeGroupMedia(String(GROUP.id), "58", [note]);
      expect(text).toBe(`[voice message, not transcribed (no speech-to-text key): ${join(workDir, "workspace", "attachments", "telegram-group-100123", "58-1.ogg")}]`);
      expect(transcribed).toEqual([]);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

// ── Poller: media described once, used for context, intent and the addressed turn ──

describe("TelegramCallbackPoller — group media", () => {
  const LINE = `[voice message, transcribed: "deploy alle 5?"]`;

  function stubTelegram() {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith("/getMe")) return new Response(JSON.stringify({ ok: true, result: { id: 999, username: "polpo_test_bot", can_read_all_group_messages: true } }));
      if (u.includes("/getFile")) return new Response(JSON.stringify({ ok: true, result: { file_path: "voice/1.ogg" } }));
      if (u.includes("/file/bot")) return new Response("ogg-bytes");
      return new Response(JSON.stringify({ ok: true, result: {} }));
    }));
    return calls;
  }

  function poller(token: string) {
    const handler = {
      handleInboundMessage: vi.fn(async () => ({ text: "ok" })),
      handleApprovalCallback: vi.fn(async () => undefined),
      describeGroupMedia: vi.fn(async (_c: string, _m: string, attachments: InboundAttachment[]) => ({ text: LINE, transcribed: attachments })),
      joinsByIntent: vi.fn(async () => false),
    } satisfies TelegramGatewayHandler;
    const p = new TelegramCallbackPoller(token, "7");
    p.setGateway(handler);
    return { handle: (m: TelegramMessage) => (p as any).handleMessage(m) as Promise<void>, handler };
  }

  it("an unaddressed voice note reaches the group context as its transcript, downloaded once for all bots", async () => {
    const calls = stubTelegram();
    const a = poller("token-a");
    const b = poller("token-b");
    const note = msg({ message_id: 501, voice });
    await Promise.all([a.handle(note), b.handle(note)]);

    expect(calls.filter(u => u.includes("/getFile"))).toHaveLength(1);
    expect(a.handler.describeGroupMedia.mock.calls.length + b.handler.describeGroupMedia.mock.calls.length).toBe(1);
    for (const { handler } of [a, b]) {
      // a voice note without caption can now be weighed by intent, on its transcript
      expect(handler.joinsByIntent).toHaveBeenCalledWith("7", String(GROUP.id), LINE, "Ada", "501", expect.objectContaining({ addressed: false }));
      expect(handler.handleInboundMessage).toHaveBeenCalledWith("7", String(GROUP.id), LINE, "Ada", "501", [], { title: "Team", threadId: undefined, addressed: false });
    }
  });

  it("a voice note addressed to the bot is answered from its transcript, without an error or the audio file", async () => {
    stubTelegram();
    const { handle, handler } = poller("token-c");
    const toBot = msg({ message_id: 502, voice, reply_to_message: msg({ message_id: 9, from: { id: 999, is_bot: true, first_name: "Polpo" } }) });
    await handle(toBot);
    expect(handler.handleInboundMessage).toHaveBeenCalledWith("7", String(GROUP.id), LINE, "Ada", "502", [], { title: "Team", threadId: undefined, addressed: true }, true);
  });

  it("when the media cannot be downloaded, the context keeps the short label", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).endsWith("/getMe")) return new Response(JSON.stringify({ ok: true, result: { id: 999, username: "polpo_test_bot" } }));
      return new Response(JSON.stringify({ ok: false }));
    }));
    const { handle, handler } = poller("token-d");
    await handle(msg({ message_id: 503, photo: [{ file_id: "p", file_unique_id: "u", width: 1, height: 1 }], caption: "the new logo" }));
    expect(handler.describeGroupMedia).not.toHaveBeenCalled();
    expect(handler.handleInboundMessage).toHaveBeenCalledWith("7", String(GROUP.id), "[photo] the new logo", "Ada", "503", [], expect.objectContaining({ addressed: false }));
  });

  it("a mention in reply to someone's voice note brings that voice note along (even one the bot never received)", async () => {
    const calls = stubTelegram();
    const { handle, handler } = poller("token-e");
    const text = "@polpo_test_bot cosa dice?";
    await handle(msg({
      message_id: 504, text, entities: [{ type: "mention", offset: 0, length: 15 }],
      reply_to_message: msg({ message_id: 400, voice, from: { id: 8, is_bot: false, first_name: "Grazia" } }),
    }));
    expect(calls.filter(u => u.includes("/getFile"))).toHaveLength(1);
    expect(handler.describeGroupMedia).toHaveBeenCalledWith(String(GROUP.id), "400", expect.any(Array));
    expect(handler.handleInboundMessage).toHaveBeenCalledWith("7", String(GROUP.id), `${LINE} cosa dice?`, "Ada", "504", [], { title: "Team", threadId: undefined, addressed: true }, true);
  });

  it("an unaddressed reply, or a reply to the bot's own voice, does not bring media", async () => {
    stubTelegram();
    const { handle, handler } = poller("token-f");
    await handle(msg({ message_id: 505, text: "ahah", reply_to_message: msg({ message_id: 401, voice }) }));
    await handle(msg({
      message_id: 506, text: "@polpo_test_bot ripeti", entities: [{ type: "mention", offset: 0, length: 15 }],
      reply_to_message: msg({ message_id: 402, voice, from: { id: 999, is_bot: true, first_name: "Polpo" } }),
    }));
    expect(handler.describeGroupMedia).not.toHaveBeenCalled();
  });
});

describe("TelegramCallbackPoller — private replies and polling errors", () => {
  it("in a private chat, a reply to an earlier voice note sends that voice note", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/getFile")) return new Response(JSON.stringify({ ok: true, result: { file_path: "voice/2.ogg" } }));
      if (u.includes("/file/bot")) return new Response("ogg-bytes");
      return new Response(JSON.stringify({ ok: true, result: {} }));
    }));
    const handler = {
      handleInboundMessage: vi.fn(async () => ({ text: "ok" })),
      handleApprovalCallback: vi.fn(async () => undefined),
    } satisfies TelegramGatewayHandler;
    const p = new TelegramCallbackPoller("token-g", "7");
    p.setGateway(handler);
    const dm = { id: 7, type: "private" as const };
    await (p as any).handleMessage({
      message_id: 30, chat: dm, from: { id: 7, is_bot: false, first_name: "Ada" }, text: "riascolta questo",
      reply_to_message: { message_id: 29, chat: dm, from: { id: 7, is_bot: false, first_name: "Ada" }, voice },
    });
    const [, , text, , , attachments] = handler.handleInboundMessage.mock.calls[0] as unknown as [string, string, string, string, string, InboundAttachment[]];
    expect(text).toBe("riascolta questo");
    expect(attachments).toEqual([expect.objectContaining({ kind: "voice", filename: "voice.ogg", mimeType: "audio/ogg" })]);
  });

  it("a getUpdates conflict is logged once, saying another program reads the bot", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" }), { status: 409 })));
    const p = new TelegramCallbackPoller("token-h", "7");
    await (p as any).poll();
    await (p as any).poll();
    const lines = errors.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("getUpdates failed"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("(409): Conflict: terminated by other getUpdates request.");
    expect(lines[0]).toContain("Another program reads this bot's messages");
    errors.mockRestore();
  });
});
