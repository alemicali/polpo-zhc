import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelGateway, type ChannelChatRunner, type ReplyRouter } from "../notifications/channel-gateway.js";
import { WebhookGatewayAdapter, normalizeWebhookSender } from "../notifications/webhook-gateway-adapter.js";
import { webhookInboundRoutes } from "../server/routes/webhook-inbound.js";
import type { PeerStore } from "../core/peer-store.js";
import type { SessionStore } from "../core/session-store.js";
import type { Orchestrator } from "../core/orchestrator.js";
import type { ChannelGatewayConfig, NotificationChannelConfig } from "../core/types.js";

const SECRET = "s3cret-s3cret-s3cret-s3cret";

function createPeerStore(): PeerStore {
  const sessions = new Map<string, string>();
  return {
    getPeer: vi.fn().mockResolvedValue(undefined),
    upsertPeer: vi.fn().mockImplementation(async (input) => ({ id: `${input.channel}:${input.externalId}`, ...input })),
    isAllowed: vi.fn().mockImplementation(async (_peerId: string, config?: ChannelGatewayConfig) => config?.dmPolicy === "open"),
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
    create: vi.fn().mockImplementation(async () => `s${++seq}`),
    addMessage: vi.fn(),
    getRecentMessages: vi.fn().mockResolvedValue([]),
    getSession: vi.fn().mockImplementation(async (id: string) => ({ id, updatedAt: new Date().toISOString() })),
    getLatestSession: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionStore;
}

function setup(gateway: ChannelGatewayConfig = { enableInbound: true, dmPolicy: "open", agent: "health-coach" }, runnerResult?: Awaited<ReturnType<ChannelChatRunner>>, router?: ReplyRouter) {
  const runner = vi.fn<ChannelChatRunner>().mockResolvedValue(runnerResult ?? { text: "ciao!" });
  const orchestrator = {
    getAgents: vi.fn().mockResolvedValue([{ name: "health-coach", role: "Coach" }, { name: "backend", role: "Backend" }]),
    getConfig: vi.fn().mockReturnValue({ project: "test", settings: {} }),
    getChannelChatRunner: vi.fn().mockReturnValue(runner),
  } as unknown as Orchestrator;
  const channel: NotificationChannelConfig = { type: "webhook", inboundSecret: SECRET, gateway };
  const channelGateway = new ChannelGateway({
    orchestrator, peerStore: createPeerStore(), sessionStore: createSessionStore(), channelConfig: channel,
  });
  if (router) channelGateway.setReplyRouter(router);
  const adapter = new WebhookGatewayAdapter(channelGateway);
  const app = webhookInboundRoutes({
    isInitialized: () => true,
    getChannelConfig: (name) => (name === "shortcuts" ? channel : undefined),
    getAdapter: (name) => (name === "shortcuts" ? adapter : undefined),
  });
  const post = (body: BodyInit, headers: Record<string, string> = {}, path = "/shortcuts/inbound") =>
    app.request(path, { method: "POST", body, headers: { authorization: `Bearer ${SECRET}`, ...headers } });
  return { runner, post, adapter };
}

describe("webhook inbound — auth", () => {
  it("rejects a wrong secret and unknown channels with the same 401", async () => {
    const { post, runner } = setup();
    const wrong = await post(JSON.stringify({ text: "hi" }), { authorization: "Bearer nope", "content-type": "application/json" });
    const unknown = await post(JSON.stringify({ text: "hi" }), { "content-type": "application/json" }, "/other/inbound");
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(runner).not.toHaveBeenCalled();
  });

  it("accepts the secret in X-Polpo-Secret", async () => {
    const { post } = setup();
    const res = await post(JSON.stringify({ text: "hi" }), { authorization: "", "x-polpo-secret": SECRET, "content-type": "application/json" });
    expect(res.status).toBe(200);
  });
});

describe("webhook inbound — messages", () => {
  it("routes JSON text to the dedicated agent and returns the reply", async () => {
    const { post, runner } = setup();
    const res = await post(JSON.stringify({ text: "come sto?", sender: "alessio-iphone" }), { "content-type": "application/json" });
    const body = await res.json() as any;
    expect(body.data.text).toBe("ciao!");
    expect(body.data.messages).toEqual(["ciao!"]);
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ agent: "health-coach" }));
    const last = runner.mock.calls[0][0].messages.at(-1);
    expect(last?.content).toBe("come sto?");
  });

  it("returns plain text with ?format=text and accepts a text/plain body", async () => {
    const { post } = setup();
    const res = await post("ciao", { "content-type": "text/plain" }, "/shortcuts/inbound?format=text&sender=phone");
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("ciao!");
  });

  it("turns multipart file fields into attachments", async () => {
    const { post, runner } = setup();
    const form = new FormData();
    form.set("text", "guarda");
    form.set("photo", new File([Buffer.from([0xff, 0xd8, 0xff])], "pasto.jpg", { type: "image/jpeg" }));
    await post(form);
    const content = runner.mock.calls[0][0].messages.at(-1)?.content as any[];
    expect(content[0]).toEqual({ type: "text", text: "guarda" });
    expect(content[1].type).toBe("image_url");
  });

  it("inlines files the agent opened as base64", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webhook-files-"));
    writeFileSync(join(dir, "plan.md"), "# plan");
    const { post } = setup(undefined, { text: "ecco il piano", files: [{ path: join(dir, "plan.md"), filename: "plan.md" }] });
    const res = await post(JSON.stringify({ text: "mandami il piano" }), { "content-type": "application/json" });
    const body = await res.json() as any;
    expect(body.data.files).toEqual([{ filename: "plan.md", mimeType: "text/markdown", size: 6, data: Buffer.from("# plan").toString("base64") }]);
  });

  it("supports /agent and agent buttons like Telegram", async () => {
    const { post, runner } = setup({ enableInbound: true, dmPolicy: "open" });
    const pick = await post(JSON.stringify({ text: "/agent" }), { "content-type": "application/json" });
    const picked = await pick.json() as any;
    expect(picked.data.buttons.flat().map((b: any) => b.data)).toContain("agent:backend");

    const chosen = await post(JSON.stringify({ callback: "agent:backend" }), { "content-type": "application/json" });
    expect((await chosen.json() as any).data.text).toContain("now talking to backend");

    await post(JSON.stringify({ text: "deploy?" }), { "content-type": "application/json" });
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ agent: "backend" }));
  });

  it("rejects empty messages and invalid sender names", async () => {
    const { post } = setup();
    expect((await post(JSON.stringify({ text: " " }), { "content-type": "application/json" })).status).toBe(400);
    expect((await post(JSON.stringify({ text: "hi", sender: "bad sender!" }), { "content-type": "application/json" })).status).toBe(400);
  });
});

describe("WebhookGatewayAdapter", () => {
  it("collects partial responses sent during the turn", async () => {
    let partial: ((chatId: string, text: string) => Promise<void>) | undefined;
    const gateway = {
      setPartialResponseHandler: (h: typeof partial) => { partial = h; },
      handleMessageReply: async (msg: { chatId: string }) => {
        await partial!(msg.chatId, "sto cercando…");
        return { text: "fatto" };
      },
    } as unknown as ChannelGateway;
    const reply = await new WebhookGatewayAdapter(gateway).handle({ text: "vai", sender: "me" });
    expect(reply?.messages).toEqual(["sto cercando…", "fatto"]);
  });

  it("normalizes sender ids", () => {
    expect(normalizeWebhookSender(undefined)).toBe("default");
    expect(normalizeWebhookSender(" alessio-iphone ")).toBe("alessio-iphone");
    expect(normalizeWebhookSender("a b")).toBeUndefined();
  });
});

describe("conversation pipe", () => {
  const flush = () => new Promise(r => setTimeout(r, 20));

  it("delivers echo and reply to the configured channel and answers 202 at once", async () => {
    const router = vi.fn<ReplyRouter>().mockResolvedValue(undefined);
    const { post, runner } = setup(
      { enableInbound: true, dmPolicy: "open", agent: "health-coach", replyTo: { channel: "coach-bot" } },
      { text: "ottima scelta", files: [{ path: "/w/plan.md", filename: "plan.md" }] },
      router,
    );
    const res = await post(JSON.stringify({ text: "ho mangiato un'insalata", sender: "iphone", name: "Alessio" }), { "content-type": "application/json" });
    expect(res.status).toBe(202);
    expect((await res.json() as any).data).toEqual({ status: "accepted", deliveredTo: "coach-bot" });
    await flush();
    expect(runner).toHaveBeenCalledOnce();
    expect(router.mock.calls.map(c => c[1].kind)).toEqual(["echo", "reply"]);
    expect(router.mock.calls[0]).toEqual([{ channel: "coach-bot" }, { kind: "echo", text: "ho mangiato un'insalata", from: "Alessio", via: "webhook" }]);
    expect(router.mock.calls[1][1]).toEqual({ kind: "reply", reply: { text: "ottima scelta", files: [{ path: "/w/plan.md", filename: "plan.md" }] } });
  });

  it("lets a request pick the target, skip the echo, or force the origin", async () => {
    const router = vi.fn<ReplyRouter>().mockResolvedValue(undefined);
    const { post } = setup(undefined, undefined, router);

    const piped = await post(JSON.stringify({ text: "hi", replyTo: { channel: "tg", chatId: 42, echoInbound: false } }), { "content-type": "application/json" }, "/shortcuts/inbound?wait=1");
    expect((await piped.json() as any).data).toMatchObject({ deliveredTo: "tg", messages: [] });
    expect(router.mock.calls.map(c => c[0])).toEqual([{ channel: "tg", chatId: "42", echoInbound: false }]);

    const here = await post(JSON.stringify({ text: "hi", replyTo: "origin" }), { "content-type": "application/json" });
    expect((await here.json() as any).data.text).toBe("ciao!");
    expect(router).toHaveBeenCalledTimes(1);
  });

  it("keeps command replies on the origin channel", async () => {
    const router = vi.fn<ReplyRouter>().mockResolvedValue(undefined);
    const { post } = setup({ enableInbound: true, dmPolicy: "open", replyTo: { channel: "tg" } }, undefined, router);
    const res = await post(JSON.stringify({ text: "/help" }), { "content-type": "application/json" });
    expect(res.status).toBe(200);
    expect((await res.json() as any).data.text).toContain("/agent");
    expect(router).not.toHaveBeenCalled();
  });
});
