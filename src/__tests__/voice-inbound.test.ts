import { describe, it, expect, vi } from "vitest";
import { streamRegistry } from "@polpo-ai/server";
import { ChannelGateway, type ChannelChatStreamRunner } from "../notifications/channel-gateway.js";
import { VoiceGatewayAdapter, normalizeVoiceDevice } from "../notifications/voice-gateway-adapter.js";
import { voiceInboundRoutes } from "../server/routes/voice-inbound.js";
import { VOICE_FILLERS } from "../notifications/voice-stream.js";
import type { PeerStore } from "../core/peer-store.js";
import type { SessionStore } from "../core/session-store.js";
import type { Orchestrator } from "../core/orchestrator.js";
import type { ChannelGatewayConfig, NotificationChannelConfig } from "../core/types.js";

const SECRET = "voice-secret-voice-secret";
const DEVICE = "90:70:69:EB:19:44";
const enc = new TextEncoder();

function createPeerStore(allowed: (peerId: string) => boolean = () => true): PeerStore {
  const sessions = new Map<string, string>();
  return {
    getPeer: vi.fn().mockResolvedValue(undefined),
    upsertPeer: vi.fn().mockImplementation(async (input) => ({ id: `${input.channel}:${input.externalId}`, ...input })),
    isAllowed: vi.fn().mockImplementation(async (peerId: string) => allowed(peerId)),
    updatePresence: vi.fn(),
    getSessionId: vi.fn().mockImplementation(async (key: string) => sessions.get(key)),
    setSessionId: vi.fn().mockImplementation(async (key: string, id: string) => { sessions.set(key, id); }),
    clearSession: vi.fn().mockImplementation(async (key: string) => { sessions.delete(key); }),
    getPendingPairing: vi.fn().mockResolvedValue(undefined),
    resolveCanonicalId: vi.fn().mockImplementation(async (id: string) => id),
  } as unknown as PeerStore;
}

function createSessionStore(): SessionStore {
  let seq = 0;
  return {
    create: vi.fn().mockImplementation(async () => `vs${++seq}-${Math.random().toString(36).slice(2, 8)}`),
    addMessage: vi.fn(),
    getRecentMessages: vi.fn().mockResolvedValue([]),
    getMessages: vi.fn().mockResolvedValue([{ role: "user", content: "earlier" }, { role: "assistant", content: "earlier reply" }]),
    getSession: vi.fn().mockImplementation(async (id: string) => ({ id, updatedAt: new Date().toISOString() })),
    getLatestSession: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionStore;
}

const chunk = (content: string) =>
  `data: ${JSON.stringify({ id: "u", object: "chat.completion.chunk", created: 1, model: "polpo", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;

function sse(parts: string[], opts: { hang?: boolean; onCancel?: () => void } = {}): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      if (!opts.hang) c.close();
    },
    cancel() { opts.onCancel?.(); },
  });
}

interface SetupOpts {
  gateway?: ChannelGatewayConfig;
  allowed?: (peerId: string) => boolean;
  runner?: ChannelChatStreamRunner;
  initialized?: boolean;
}

function setup(opts: SetupOpts = {}) {
  const runner = vi.fn<ChannelChatStreamRunner>(opts.runner ?? (async () => ({
    turnId: "turn-1", body: sse([chunk("Ciao, "), chunk("sono Polpo."), "data: [DONE]\n\n"]),
  })));
  const orchestrator = {
    getAgents: vi.fn().mockResolvedValue([{ name: "speaker", role: "Voice assistant" }]),
    getConfig: vi.fn().mockReturnValue({ project: "test", settings: {} }),
    getChannelChatRunner: vi.fn().mockReturnValue(vi.fn()),
    getChannelChatStreamRunner: vi.fn().mockReturnValue(runner),
  } as unknown as Orchestrator;
  const channel: NotificationChannelConfig = {
    type: "voice", url: "http://127.0.0.1:8765", inboundSecret: SECRET,
    gateway: opts.gateway ?? { enableInbound: true, agent: "speaker" },
  };
  const peerStore = createPeerStore(opts.allowed);
  const sessionStore = createSessionStore();
  const gateway = new ChannelGateway({ orchestrator, peerStore, sessionStore, channelConfig: channel, key: "speaker" });
  const adapter = new VoiceGatewayAdapter(gateway);
  const abortTurn = vi.fn();
  const webhook: NotificationChannelConfig = { type: "webhook", inboundSecret: SECRET, gateway: { enableInbound: true } };
  const app = voiceInboundRoutes({
    isInitialized: () => opts.initialized ?? true,
    getChannelConfig: (name) => (name === "speaker" ? channel : name === "shortcuts" ? webhook : undefined),
    getAdapter: (name) => (name === "speaker" ? adapter : undefined),
    abortTurn,
  });
  const post = (body: unknown, headers: Record<string, string> = {}, path = "/speaker/voice/chat/completions", init: RequestInit = {}) =>
    app.request(path, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}`, "x-polpo-peer": DEVICE, ...headers },
      ...init,
    });
  return { app, post, runner, peerStore, sessionStore, abortTurn };
}

const EL_BODY = {
  model: "custom", stream: true,
  messages: [
    { role: "system", content: "ElevenLabs system prompt" },
    { role: "user", content: "che ore sono?" },
    { role: "assistant", content: "Le dieci." },
    { role: "user", content: "alza il volume" },
  ],
};

async function spoken(res: Response): Promise<string> {
  const text = await res.text();
  return text.split("\n\n").filter((b) => b.startsWith("data: ") && b !== "data: [DONE]")
    .map((b) => JSON.parse(b.slice(6)).choices[0].delta.content ?? "").join("");
}

describe("normalizeVoiceDevice", () => {
  it.each([
    ["90:70:69:EB:19:44", "90:70:69:eb:19:44"],
    [" aa-bb-cc ", "aa-bb-cc"],
    ["kitchen_speaker.1", "kitchen_speaker.1"],
  ])("accepts %s", (raw, normal) => expect(normalizeVoiceDevice(raw)).toBe(normal));

  it.each([undefined, "", "a b", "x".repeat(65), "dev/../etc", "<script>"])("rejects %s", (raw) =>
    expect(normalizeVoiceDevice(raw as string | undefined)).toBeUndefined());
});

describe("POST /:name/voice/chat/completions — auth and validation", () => {
  it.each([
    ["no secret", { authorization: "" }],
    ["wrong secret", { authorization: "Bearer nope" }],
  ])("rejects %s with 401", async (_label, headers) => {
    const { post, runner } = setup();
    expect((await post(EL_BODY, headers)).status).toBe(401);
    expect(runner).not.toHaveBeenCalled();
  });

  it("accepts the secret in X-Polpo-Secret too", async () => {
    const { post } = setup();
    expect((await post(EL_BODY, { authorization: "", "x-polpo-secret": SECRET })).status).toBe(200);
  });

  it("answers 401 for unknown channels and for channels that are not voice (no probing)", async () => {
    const { post } = setup();
    expect((await post(EL_BODY, {}, "/nope/voice/chat/completions")).status).toBe(401);
    expect((await post(EL_BODY, {}, "/shortcuts/voice/chat/completions")).status).toBe(401);
  });

  it("answers 503 until the instance is initialized", async () => {
    const { post } = setup({ initialized: false });
    expect((await post(EL_BODY)).status).toBe(503);
  });

  it.each([
    ["missing device", { "x-polpo-peer": "" }],
    ["invalid device", { "x-polpo-peer": "a b c" }],
  ])("rejects a %s with 400", async (_label, headers) => {
    const { post } = setup();
    expect((await post(EL_BODY, headers)).status).toBe(400);
  });

  it.each([
    ["invalid JSON", "{nope"],
    ["no messages", { messages: [] }],
    ["no user message", { messages: [{ role: "system", content: "x" }] }],
    ["empty user message", { messages: [{ role: "user", content: "   " }] }],
  ])("rejects %s with 400", async (_label, body) => {
    const { post, runner } = setup();
    expect((await post(body)).status).toBe(400);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("POST /:name/voice/chat/completions — the turn", () => {
  it("streams the agent's words as a clean OpenAI stream", async () => {
    const { post } = setup();
    const res = await post(EL_BODY);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    expect(await spoken(res)).toBe("Ciao, sono Polpo.");
  });

  it("runs the configured agent on the device's own session, with Polpo's history (not the voice provider's)", async () => {
    const { post, runner, peerStore } = setup();
    await (await post(EL_BODY)).text();
    expect(peerStore.upsertPeer).toHaveBeenCalledWith(expect.objectContaining({ channel: "voice", externalId: "90:70:69:eb:19:44" }));
    const req = runner.mock.calls[0][0];
    expect(req.agent).toBe("speaker");
    expect(req.messages).toEqual([
      { role: "user", content: "earlier" },
      { role: "assistant", content: "earlier reply" },
      { role: "user", content: "alza il volume" },
    ]);
    expect(req.origin).toEqual({ channel: "speaker", chatId: "90:70:69:eb:19:44" });
  });

  it("accepts content parts in the last user message", async () => {
    const { post, runner } = setup();
    await (await post({ messages: [{ role: "user", content: [{ type: "text", text: "ciao" }, { type: "text", text: "Polpo" }] }] })).text();
    expect(runner.mock.calls[0][0].messages.at(-1)).toEqual({ role: "user", content: "ciao Polpo" });
  });

  it("keeps one session per device across turns, and separate sessions for different devices", async () => {
    const { post, runner } = setup();
    await (await post(EL_BODY)).text();
    await (await post(EL_BODY)).text();
    await (await post(EL_BODY, { "x-polpo-peer": "aa:bb:cc:dd:ee:ff" })).text();
    const ids = runner.mock.calls.map((c) => c[0].sessionId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("stays silent for devices that are not allowed, without running the agent", async () => {
    const { post, runner } = setup({ allowed: () => false });
    const res = await post(EL_BODY);
    expect(res.status).toBe(200);
    expect(await spoken(res)).toBe("");
    expect(runner).not.toHaveBeenCalled();
  });

  it("barge-in: a new utterance aborts the answer still running in the same session", async () => {
    const { post, runner } = setup();
    await (await post(EL_BODY)).text();
    const sessionId = runner.mock.calls[0][0].sessionId;
    streamRegistry.register("old-turn", sessionId);
    expect(streamRegistry.getActiveTurnForSession(sessionId)).toBe("old-turn");
    await (await post(EL_BODY)).text();
    expect(streamRegistry.get("old-turn")?.status).toBe("aborted");
  });

  it("aborts the turn when the voice client hangs up mid-answer", async () => {
    let cancelled = false;
    const { post, abortTurn } = setup({
      runner: async () => ({ turnId: "turn-hang", body: sse([chunk("parte")], { hang: true, onCancel: () => { cancelled = true; } }) }),
    });
    const res = await post(EL_BODY);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => expect(abortTurn).toHaveBeenCalledWith("turn-hang"));
    expect(cancelled).toBe(true);
  });

  it("speaks the caller's apology when the agent fails", async () => {
    const { post } = setup({ runner: async () => { throw new Error("model down"); } });
    const res = await post(EL_BODY, { "x-polpo-error-text": "Scusa, non riesco a rispondere." });
    expect(res.status).toBe(200);
    expect(await spoken(res)).toBe("Scusa, non riesco a rispondere.");
  });

  const slowSearch = () => {
    const parts: (string | number)[] = [
      `data: ${JSON.stringify({ id: "u", object: "chat.completion.chunk", created: 1, model: "polpo", choices: [{ index: 0, delta: {}, finish_reason: null, tool_call: { id: "t", name: "search_web", state: "preparing" } }] })}\n\n`,
      1200, chunk("Trovato."), "data: [DONE]\n\n",
    ];
    return new ReadableStream<Uint8Array>({
      async pull(c) {
        const p = parts.shift();
        if (p === undefined) return c.close();
        if (typeof p === "number") { await new Promise((r) => setTimeout(r, p)); return; }
        c.enqueue(enc.encode(p));
      },
    });
  };

  it("fills a slow tool with a courtesy phrase in the caller's language (X-Polpo-Language)", async () => {
    const { post } = setup({ runner: async () => ({ turnId: "t-fill", body: slowSearch() }) });
    const it_ = await spoken(await post(EL_BODY, { "x-polpo-language": "it" }));
    expect(VOICE_FILLERS.it.search.some((f) => it_ === `${f.replace(/[.!?]+$/, "")}... Trovato.`)).toBe(true);
  });

  it("without a language the fillers are English", async () => {
    const { post } = setup({ runner: async () => ({ turnId: "t-fill", body: slowSearch() }) });
    const en = await spoken(await post(EL_BODY));
    expect(VOICE_FILLERS.en.search.some((f) => en === `${f.replace(/[.!?]+$/, "")}... Trovato.`)).toBe(true);
  });

  it("non-streaming answers carry no fillers: only the agent's words", async () => {
    const { post } = setup({ runner: async () => ({ turnId: "t-fill", body: slowSearch() }) });
    const json = await (await post({ ...EL_BODY, stream: false }, { "x-polpo-language": "it" })).json() as any;
    expect(json.choices[0].message.content).toBe("Trovato.");
  });

  it("falls back to a default apology without the header", async () => {
    const { post } = setup({ runner: async () => { throw new Error("model down"); } });
    expect((await spoken(await post(EL_BODY))).length).toBeGreaterThan(0);
  });

  it("answers non-streaming requests with a single chat.completion", async () => {
    const { post } = setup();
    const res = await post({ ...EL_BODY, stream: false });
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const json = await res.json() as any;
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message).toEqual({ role: "assistant", content: "Ciao, sono Polpo." });
  });

  it("does nothing when the channel's inbound gateway is disabled", async () => {
    const { post, runner } = setup({ gateway: { enableInbound: false, agent: "speaker" } });
    expect(await spoken(await post(EL_BODY))).toBe("");
    expect(runner).not.toHaveBeenCalled();
  });
});
