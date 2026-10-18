import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { VoiceChannel } from "../notifications/channels/voice.js";
import { NotificationRouter } from "../notifications/index.js";
import { StoredNotificationChannelConfigSchema } from "../../packages/server/src/schemas.js";
import type { Notification } from "../notifications/types.js";
import type { NotificationChannelConfig } from "../core/types.js";

const BRIDGE = "http://127.0.0.1:8765";
const DEVICE = "90:70:69:eb:19:44";

function config(overrides: Partial<NotificationChannelConfig> = {}): NotificationChannelConfig {
  return { type: "voice", url: BRIDGE, apiKey: "bridge-token", chatId: DEVICE, ...overrides };
}

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: "n1", channel: "speaker", title: "Promemoria", body: "Ricordati di **chiamare** Marco",
    severity: "info", sourceEvent: "test", sourceData: {}, ruleId: "r1", timestamp: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("voice channel config", () => {
  it("accepts a voice channel: bridge url, bridge token, inbound secret, default device and gateway", () => {
    const parsed = StoredNotificationChannelConfigSchema.safeParse({
      type: "voice",
      url: BRIDGE,
      apiKey: "${VOICE_BRIDGE_TOKEN}",
      inboundSecret: "a-long-enough-secret",
      chatId: DEVICE,
      gateway: { enableInbound: true, agent: "speaker", dmPolicy: "allowlist", allowFrom: [DEVICE], sessionIdleMinutes: 0 },
    });
    expect(parsed.success).toBe(true);
  });

  it("is created by the notification router", () => {
    const router = new NotificationRouter(new EventEmitter() as any);
    router.init({ channels: { speaker: config() }, rules: [] });
    expect(router.getChannel("speaker")?.type).toBe("voice");
  });

  it("requires the bridge url", () => {
    expect(() => new VoiceChannel(config({ url: undefined }))).toThrow(/url/);
  });
});

describe("VoiceChannel delivery", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.VOICE_BRIDGE_TOKEN;
  });

  it("asks the bridge to speak the notification on the default device, as plain speakable text", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await new VoiceChannel(config()).send(notification());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BRIDGE}/notify`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer bridge-token");
    expect(JSON.parse(init.body)).toEqual({
      id: "n1", device: DEVICE, text: "Ricordati di chiamare Marco", title: "Promemoria", severity: "info",
    });
  });

  it("targets the conversation's device when the notification carries one (chat replies, checks)", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await new VoiceChannel(config()).send(notification({ sourceData: { chatId: "aa:bb:cc:dd:ee:ff" } }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).device).toBe("aa:bb:cc:dd:ee:ff");
  });

  it("speaks the title when the body is empty", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await new VoiceChannel(config()).send(notification({ body: "  " }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).text).toBe("Promemoria");
  });

  it("resolves the bridge token and url from environment references", async () => {
    process.env.VOICE_BRIDGE_TOKEN = "from-env";
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await new VoiceChannel(config({ apiKey: "${VOICE_BRIDGE_TOKEN}", url: `${BRIDGE}/` })).send(notification());
    expect(fetchMock.mock.calls[0][0]).toBe(`${BRIDGE}/notify`);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer from-env");
  });

  it("fails loudly when no device can be targeted", async () => {
    await expect(new VoiceChannel(config({ chatId: undefined })).send(notification())).rejects.toThrow(/device/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces bridge errors (offline device, bad token)", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "device offline" }), { status: 409 }));
    await expect(new VoiceChannel(config()).send(notification())).rejects.toThrow(/409.*device offline/);
  });

  it("reports reachability through the bridge health endpoint", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect(await new VoiceChannel(config()).test()).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe(`${BRIDGE}/healthz`);
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await new VoiceChannel(config()).test()).toBe(false);
  });
});
