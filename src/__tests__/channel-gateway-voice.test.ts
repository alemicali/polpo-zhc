import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InboundAttachment } from "../notifications/channel-gateway.js";

// The speech-to-text call: replaced, so no provider is reached.
const transcribeSpeech = vi.hoisted(() => vi.fn());
vi.mock("../tools/audio-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools/audio-tools.js")>()),
  transcribeSpeech,
}));
const vaults = vi.hoisted(() => new Map<string, Record<string, string>>());
vi.mock("../vault/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../vault/index.js")>()),
  loadAgentVaultEntries: async (_store: unknown, agent: string) => agent,
  resolveAgentVault: (agent: string) => ({ getKey: (service: string) => vaults.get(agent)?.[service] }),
}));

const { ChannelGateway } = await import("../notifications/channel-gateway.js");

const voice = (): InboundAttachment => ({ kind: "voice", filename: "voice.ogg", mimeType: "audio/ogg", data: Buffer.from("ogg") });
const photo = (): InboundAttachment => ({ kind: "photo", filename: "photo.jpg", mimeType: "image/jpeg", data: Buffer.from("jpg") });

function setup(agent?: string) {
  const runner = vi.fn().mockResolvedValue({ text: "ok" });
  const sessions = new Map<string, { id: string; updatedAt: string }>();
  const sessionStore = {
    create: vi.fn(async () => { const id = `s${sessions.size + 1}`; sessions.set(id, { id, updatedAt: new Date().toISOString() }); return id; }),
    getSession: vi.fn(async (id: string) => sessions.get(id)),
    getLatestSession: vi.fn(async () => undefined),
    getMessages: vi.fn(async () => []),
    addMessage: vi.fn(async () => ({ id: "m" })),
  };
  const peerStore = {
    upsertPeer: vi.fn(async () => ({})), updatePresence: vi.fn(), isAllowed: vi.fn(async () => true),
    getSessionId: vi.fn(async () => undefined), setSessionId: vi.fn(async () => {}), resolveCanonicalId: vi.fn(async (id: string) => id),
  };
  const orchestrator = {
    getAgents: vi.fn().mockResolvedValue([{ name: "coach" }, { name: "creative" }]),
    getConfig: vi.fn().mockReturnValue({ project: "test", settings: {} }),
    getChannelChatRunner: vi.fn().mockReturnValue(runner),
    getVaultStore: vi.fn().mockReturnValue({}),
    getStore: vi.fn().mockReturnValue({ getAllTasks: vi.fn().mockResolvedValue([]), getState: vi.fn().mockResolvedValue({ processes: [] }) }),
  };
  const gateway = new ChannelGateway({
    orchestrator: orchestrator as never,
    peerStore: peerStore as never,
    sessionStore: sessionStore as never,
    channelConfig: { type: "telegram", botToken: "fake", chatId: "", gateway: { enableInbound: true, dmPolicy: "open", ...(agent ? { agent } : {}) } },
  });
  const send = (text: string, attachments: InboundAttachment[]) =>
    gateway.handleMessage({ channel: "telegram", externalId: "7", chatId: "chat-7", displayName: "Alessio", text, attachments });
  const lastTurn = () => runner.mock.calls.at(-1)![0].messages.at(-1).content;
  return { runner, send, lastTurn };
}

describe("ChannelGateway — voice notes in private chats", () => {
  beforeEach(() => {
    transcribeSpeech.mockReset();
    vaults.clear();
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;
  });

  it("an agent's voice note is transcribed on arrival: the words are the message, the audio is dropped", async () => {
    vaults.set("coach", { openai: "sk-coach" });
    transcribeSpeech.mockResolvedValue({ text: "ieri pizza per il compleanno di Grazia", provider: "openai" });
    const { send, lastTurn } = setup("coach");
    await send("", [voice()]);
    expect(lastTurn()).toBe('[voice message, transcribed: "ieri pizza per il compleanno di Grazia"]');
    // with the agent's own vault
    expect(transcribeSpeech.mock.calls[0]![2].getKey("openai")).toBe("sk-coach");
  });

  it("keeps the caption and the other attachments", async () => {
    transcribeSpeech.mockResolvedValue({ text: "guarda questa foto", provider: "openai" });
    const { send, lastTurn } = setup("coach");
    await send("e questa?", [voice(), photo()]);
    const parts = lastTurn() as Array<{ type: string; text?: string }>;
    expect(parts[0]).toEqual({ type: "text", text: '[voice message, transcribed: "guarda questa foto"]\ne questa?' });
    expect(parts.filter((p) => p.type === "image_url")).toHaveLength(1);
    expect(parts.some((p) => p.type === "file")).toBe(false);
  });

  it("Polpo, without a vault, uses the first agent's speech-to-text key", async () => {
    vaults.set("creative", { openai: "sk-creative" });
    transcribeSpeech.mockResolvedValue({ text: "ricordami OVH sabato", provider: "openai" });
    const { send, lastTurn } = setup();
    await send("", [voice()]);
    expect(lastTurn()).toBe('[voice message, transcribed: "ricordami OVH sabato"]');
    expect(transcribeSpeech.mock.calls[0]![2].getKey("openai")).toBe("sk-creative");
  });

  it("without a key (or when it fails) the audio stays attached for the agent's own tools", async () => {
    transcribeSpeech.mockResolvedValue(null);
    const { send, lastTurn } = setup("coach");
    await send("", [voice()]);
    const parts = lastTurn() as Array<{ type: string; text?: string }>;
    expect(parts[0]!.text).toMatch(/voice message \(voice\.ogg\)\. Audio is attached as a file/);
    expect(parts.some((p) => p.type === "file")).toBe(true);
  });
});
