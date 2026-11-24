/**
 * WhatsApp Business (Meta Cloud API) channel: webhook verification (GET and signed POST over the
 * raw bytes), the persisted inbox (no loss, no duplicates across a restart), the rules for sending
 * (window, opt-out, caps, templates, approval), customer mode in the gateway, statuses, tools,
 * the admin REST (secrets never returned) and the event log (no text, contacts masked).
 * Meta is never called: fetch is a stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { InMemoryWaBusinessStore, readsExternalContent, type NotificationChannelConfig, type VaultStore } from "@polpo-ai/core";
import {
  WaBusinessService, wabizSignature, verifyWabizSignature, type WaBizGatewayHandle,
} from "../notifications/whatsapp-business-service.js";
import { splitWhatsAppText, templateProblem } from "../notifications/channels/whatsapp-business.js";
import { waBusinessAdminRoutes, waBusinessWebhookRoutes } from "../server/routes/whatsapp-business.js";
import { createWabizTools, grantsWabizTool } from "../tools/wabiz-tools.js";
import { ChannelGateway, type ChannelChatRunner } from "../notifications/channel-gateway.js";
import { WaBusinessGatewayAdapter } from "../notifications/whatsapp-business-gateway-adapter.js";
import type { Orchestrator } from "../core/orchestrator.js";
import type { PeerStore } from "../core/peer-store.js";
import type { SessionStore } from "../core/session-store.js";

const APP_SECRET = "app-secret-0123456789";
const VERIFY = "verify-token-abcdef";
const TOKEN = "EAAG-access-token-xyz";
const PHONE_ID = "1234567890";
const WABA = "9876543210";
const CUSTOMER = "393331234567";
const NOW = Date.parse("2026-11-24T10:00:00Z");

function memoryVault(): VaultStore & { entries: Map<string, any> } {
  const entries = new Map<string, any>();
  const k = (o: string, s: string) => `${o}|${s}`;
  return {
    entries,
    get: async (o: string, s: string) => entries.get(k(o, s)),
    set: async (o: string, s: string, e: any) => { entries.set(k(o, s), e); },
    remove: async (o: string, s: string) => entries.delete(k(o, s)),
    getAllForAgent: async () => ({}),
    patch: async () => [],
  } as unknown as VaultStore & { entries: Map<string, any> };
}

const TEMPLATES = [
  { name: "order_update", language: "it", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Ciao {{1}}, il tuo ordine {{2}} è pronto." }] },
  { name: "promo", language: "it", status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: "Sconto!" }] },
];

/** Meta's Graph API, stubbed: records every call. */
function graphStub(o: { failText?: number } = {}) {
  let n = 0;
  const calls: Array<{ url: string; method: string; body: any }> = [];
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: u, method: init?.method ?? "GET", body });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    if (u.includes("/message_templates")) return json(200, { data: TEMPLATES });
    if (u.endsWith(`/${PHONE_ID}/messages`) && body?.status === "read") return json(200, { success: true });
    if (u.endsWith(`/${PHONE_ID}/messages`)) {
      if (o.failText && body?.type === "text") return json(400, { error: { code: o.failText, message: "Re-engagement message" } });
      return json(200, { messages: [{ id: `wamid.out${++n}` }] });
    }
    if (u.includes(`/${PHONE_ID}?fields=`)) return json(200, { id: PHONE_ID, display_phone_number: "+39 02 1234", quality_rating: "GREEN", messaging_limit_tier: "TIER_1K" });
    return json(404, { error: { message: "unknown" } });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, sends: () => calls.filter((c) => c.url.endsWith("/messages") && c.body?.status !== "read") };
}

function channelConfig(over: Partial<NotificationChannelConfig> = {}): NotificationChannelConfig {
  return {
    type: "whatsapp-business", phoneNumberId: PHONE_ID, wabaId: WABA,
    business: { operators: ["393330000001"], limits: { businessInitiatedPerDay: 2, perAgentPerDay: { sales: 1 } } },
    gateway: { enableInbound: true, agent: "support" },
    ...over,
  };
}

interface Rig {
  dir: string; service: WaBusinessService; store: InMemoryWaBusinessStore; vault: ReturnType<typeof memoryVault>;
  graph: ReturnType<typeof graphStub>; events: Array<{ event: string; payload: any }>; channels: Record<string, NotificationChannelConfig>;
  now: { t: number };
}

async function rig(o: { config?: Partial<NotificationChannelConfig>; failText?: number; dir?: string; store?: InMemoryWaBusinessStore; vault?: ReturnType<typeof memoryVault> } = {}): Promise<Rig> {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "wabiz-"));
  const store = o.store ?? new InMemoryWaBusinessStore();
  const vault = o.vault ?? memoryVault();
  const graph = graphStub({ failText: o.failText });
  const events: Rig["events"] = [];
  const channels: Record<string, NotificationChannelConfig> = { shop: channelConfig(o.config) };
  const now = { t: NOW };
  const service = new WaBusinessService({
    polpoDir: () => dir, channels: () => channels, store: () => store, vault: () => vault,
    emit: (event, payload) => events.push({ event, payload }), fetch: graph.fetch, now: () => now.t, timers: false,
    publicBase: () => "https://host.ts.net/acme",
  });
  if (!o.vault) {
    await service.setSecret("shop", "accessToken", TOKEN);
    await service.setSecret("shop", "appSecret", APP_SECRET);
    await service.setSecret("shop", "verifyToken", VERIFY);
  }
  return { dir, service, store, vault, graph, events, channels, now };
}

function delivery(o: { messages?: any[]; statuses?: any[]; phoneId?: string; contacts?: any[] } = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: WABA, changes: [{ field: "messages", value: {
      messaging_product: "whatsapp", metadata: { display_phone_number: "39021234", phone_number_id: o.phoneId ?? PHONE_ID },
      ...(o.contacts ?? o.messages ? { contacts: o.contacts ?? [{ profile: { name: "Mario" }, wa_id: CUSTOMER }] } : {}),
      ...(o.messages ? { messages: o.messages } : {}), ...(o.statuses ? { statuses: o.statuses } : {}),
    } }] }],
  };
}

const textMessage = (id: string, body: string, ts = NOW / 1000) => ({ from: CUSTOMER, id, timestamp: String(Math.floor(ts)), type: "text", text: { body } });

async function post(r: Rig, body: unknown | string, sig?: string | null) {
  const raw = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  return r.service.receive("shop", raw, sig === undefined ? wabizSignature(APP_SECRET, raw) : sig);
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
async function tracked(o: Parameters<typeof rig>[0] = {}) { const r = await rig(o); dirs.push(r.dir); return r; }

// ── Signature and verification ─────────────────────────────────────

describe("webhook signature (X-Hub-Signature-256)", () => {
  it("accepts the HMAC of the raw bytes and refuses anything else", () => {
    const raw = Buffer.from('{"a": 1,  "b":"è"}'); // spacing and unicode as sent: a re-serialized body would not match
    const sig = wabizSignature(APP_SECRET, raw);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWabizSignature(raw, sig, APP_SECRET)).toBe("valid");
    expect(verifyWabizSignature(raw, sig.toUpperCase().replace("SHA256", "sha256"), APP_SECRET)).toBe("valid");
    expect(verifyWabizSignature(Buffer.from(JSON.stringify(JSON.parse(raw.toString()))), sig, APP_SECRET)).toBe("invalid");
    expect(verifyWabizSignature(raw, wabizSignature("other-secret", raw), APP_SECRET)).toBe("invalid");
    expect(verifyWabizSignature(raw, undefined, APP_SECRET)).toBe("missing");
  });

  it("refuses unsigned or badly signed deliveries (401) and records them", async () => {
    const r = await tracked();
    expect((await post(r, delivery({ messages: [textMessage("wamid.1", "hi")] }), null)).status).toBe(401);
    expect((await post(r, delivery({ messages: [textMessage("wamid.1", "hi")] }), "sha256=00")).status).toBe(401);
    const page = r.service.events("shop");
    expect(page.counts.rejected).toBe(2);
    expect(page.events.map((e) => e.signature)).toEqual(["invalid", "missing"]);
  });

  it("refuses without an app secret (503) and over 1 MB (413)", async () => {
    const r = await tracked();
    await r.service.setSecret("shop", "appSecret", null);
    expect((await post(r, delivery())).status).toBe(503);
    expect((await r.service.receive("shop", Buffer.alloc(1024 * 1024 + 1), "sha256=x")).status).toBe(413);
  });
});

describe("GET verification (hub.challenge)", () => {
  it("answers the challenge as text/plain with the right token, 403 otherwise", async () => {
    const r = await tracked();
    const app = new Hono();
    app.route("/wh", waBusinessWebhookRoutes({ service: () => r.service }));
    const ok = await app.request(`/wh/shop?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=12345`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/plain");
    expect(await ok.text()).toBe("12345");
    expect((await app.request("/wh/shop?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1")).status).toBe(403);
    expect((await app.request(`/wh/shop?hub.mode=other&hub.verify_token=${VERIFY}&hub.challenge=1`)).status).toBe(403);
    expect((await app.request(`/wh/nope?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1`)).status).toBe(404);
  });

  it("POST through the route verifies the raw bytes", async () => {
    const r = await tracked();
    const app = new Hono();
    app.route("/wh", waBusinessWebhookRoutes({ service: () => r.service }));
    const raw = JSON.stringify(delivery({ statuses: [] }), null, 2);
    const res = await app.request("/wh/shop", { method: "POST", body: raw, headers: { "x-hub-signature-256": wabizSignature(APP_SECRET, raw), "content-type": "application/json" } });
    expect(res.status).toBe(200);
  });
});

// ── Inbox, idempotency, routing ─────────────────────────────────────

describe("inbox and idempotency", () => {
  it("routes a message to the gateway once, even when Meta delivers it twice", async () => {
    const r = await tracked();
    const handle = vi.fn<WaBizGatewayHandle["handle"]>().mockResolvedValue({ text: "Buongiorno Mario!" });
    r.service.setGateway("shop", { handle });
    const d = delivery({ messages: [textMessage("wamid.IN1", "ciao")] });
    expect((await post(r, d)).status).toBe(200);
    expect((await post(r, d)).status).toBe(200);
    await r.service.idle();
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0]![0]).toMatchObject({ waId: CUSTOMER, chatId: `${PHONE_ID}:${CUSTOMER}`, name: "Mario", text: "ciao", messageId: "wamid.IN1" });
    // marked read with the typing indicator, then the reply
    const read = r.graph.calls.find((c) => c.body?.status === "read");
    expect(read?.body).toEqual({ messaging_product: "whatsapp", status: "read", message_id: "wamid.IN1", typing_indicator: { type: "text" } });
    expect(r.graph.sends().map((c) => c.body.text?.body)).toEqual(["Buongiorno Mario!"]);
    expect(r.graph.sends()[0]!.body.to).toBe(CUSTOMER);
    expect(readdirSync(join(r.dir, "whatsapp-business-inbox")).filter((f) => f.endsWith(".json"))).toEqual([]);
    const contact = await r.store.getContact("shop", CUSTOMER);
    expect(contact).toMatchObject({ name: "Mario", lastInboundWamid: "wamid.IN1" });
  });

  it("processes what the inbox kept across a restart, once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wabiz-"));
    dirs.push(dir);
    const store = new InMemoryWaBusinessStore();
    const first = await rig({ dir, store });
    // the delivery is acknowledged and kept, but the process stops before processing it
    const drain = vi.spyOn(first.service, "drain").mockResolvedValue();
    expect((await post(first, delivery({ messages: [textMessage("wamid.R1", "sei aperto?")] }))).status).toBe(200);
    drain.mockRestore();
    expect(readdirSync(join(dir, "whatsapp-business-inbox")).filter((f) => f.endsWith(".json"))).toHaveLength(1);

    const second = await rig({ dir, store, vault: first.vault });
    const handle = vi.fn<WaBizGatewayHandle["handle"]>().mockResolvedValue({ text: "Sì!" });
    second.service.setGateway("shop", { handle });
    second.service.start();
    await second.service.idle();
    expect(handle).toHaveBeenCalledTimes(1);
    expect(readdirSync(join(dir, "whatsapp-business-inbox")).filter((f) => f.endsWith(".json"))).toEqual([]);

    // a third start (or Meta's retry) does nothing more
    const third = await rig({ dir, store, vault: first.vault });
    third.service.setGateway("shop", { handle });
    expect((await post(third, delivery({ messages: [textMessage("wamid.R1", "sei aperto?")] }))).status).toBe(200);
    await third.service.idle();
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("ignores deliveries for another phone number", async () => {
    const r = await tracked();
    const handle = vi.fn<WaBizGatewayHandle["handle"]>();
    r.service.setGateway("shop", { handle });
    const res = await post(r, delivery({ phoneId: "5555555555", messages: [textMessage("wamid.F1", "hello")] }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ignored: true });
    await r.service.idle();
    expect(handle).not.toHaveBeenCalled();
    expect(r.service.events("shop").events[0]).toMatchObject({ outcome: "ignored", reason: expect.stringContaining("5555555555") });
  });

  it("turns interactive replies into text and other types into a placeholder", async () => {
    const r = await tracked();
    const handle = vi.fn<WaBizGatewayHandle["handle"]>().mockResolvedValue(undefined);
    r.service.setGateway("shop", { handle });
    await post(r, delivery({ messages: [
      { from: CUSTOMER, id: "wamid.B1", timestamp: String(NOW / 1000), type: "interactive", interactive: { type: "button_reply", button_reply: { id: "y", title: "Sì, confermo" } } },
      { from: CUSTOMER, id: "wamid.I1", timestamp: String(NOW / 1000), type: "image", image: { id: "media1", caption: "lo scontrino" } },
    ] }));
    await r.service.idle();
    expect(handle.mock.calls.map((c) => c[0].text)).toEqual(["Sì, confermo", "[immagine] lo scontrino"]);
  });
});

// ── Event log ───────────────────────────────────────────────────────

describe("event log", () => {
  it("keeps types, lengths and masked contacts, never message text", async () => {
    const r = await tracked();
    await post(r, delivery({ messages: [textMessage("wamid.S1", "il mio codice segreto è 4242")] }));
    await r.service.idle();
    const [summary] = r.service.events("shop").events;
    expect(summary).toMatchObject({ outcome: "accepted", eventType: "messages", messages: 1, signature: "valid" });
    const full = r.service.event("shop", summary!.id)!;
    expect(full.items?.[0]).toMatchObject({ kind: "message", type: "text", length: 28, contact: "39•••••••567" });
    const file = readFileSync(join(r.dir, "whatsapp-business-events", "shop.json"), "utf8");
    expect(file).not.toContain("segreto");
    expect(file).not.toContain(CUSTOMER);
    expect(r.events.some((e) => e.event === "channel:webhook")).toBe(true);
  });
});

// ── Statuses ────────────────────────────────────────────────────────

describe("statuses", () => {
  it("updates the message's history and pricing, once per status, and announces it", async () => {
    const r = await tracked();
    await r.store.saveContact({ channel: "shop", waId: CUSTOMER, lastInboundAt: new Date(NOW - 3600_000).toISOString(), optIn: null, optOut: null, createdAt: "", updatedAt: "" });
    const [id] = await r.service.sendText("shop", CUSTOMER, "ciao", { sentBy: "operator" });
    const st = (status: string) => ({ id, status, timestamp: String(NOW / 1000 + 5), recipient_id: CUSTOMER, pricing: { billable: false, pricing_model: "PMP", category: "service", type: "free_customer_service" } });
    await post(r, delivery({ statuses: [st("delivered")] }));
    await post(r, delivery({ statuses: [st("delivered")] }));
    await post(r, delivery({ statuses: [st("read")] }));
    await post(r, delivery({ statuses: [st("sent")] })); // late: does not go back
    await r.service.idle();
    const m = await r.store.getMessage(id!);
    expect(m?.status).toBe("read");
    expect(m?.statuses.map((s) => s.status)).toEqual(["accepted", "delivered", "read", "sent"]);
    expect(m?.pricing).toEqual({ category: "service", type: "free_customer_service", billable: false, model: "PMP" });
    expect(r.events.filter((e) => e.event === "channel:message-status").map((e) => e.payload.status)).toEqual(["accepted", "delivered", "read", "sent"]);
    expect(r.events.find((e) => e.payload.status === "read")?.payload.contact).toBe("39•••••••567");
  });
});

// ── Sending rules ───────────────────────────────────────────────────

describe("the 24-hour window", () => {
  it("sends free-form inside the window and refuses outside", async () => {
    const r = await tracked();
    await expect(r.service.sendText("shop", CUSTOMER, "hello", { sentBy: "a" })).rejects.toMatchObject({ code: "OUTSIDE_WINDOW" });
    await r.store.saveContact({ channel: "shop", waId: CUSTOMER, lastInboundAt: new Date(NOW - 23 * 3600_000).toISOString(), optIn: null, optOut: null, createdAt: "", updatedAt: "" });
    expect(await r.service.sendText("shop", `+39 333 1234567`, "hello", { sentBy: "a" })).toHaveLength(1);
    r.now.t = NOW + 2 * 3600_000;
    await expect(r.service.sendText("shop", CUSTOMER, "hello", { sentBy: "a" })).rejects.toMatchObject({ code: "OUTSIDE_WINDOW" });
  });

  it("maps Meta's 131047 to the window error", async () => {
    const r = await tracked({ failText: 131047 });
    await r.store.saveContact({ channel: "shop", waId: CUSTOMER, lastInboundAt: new Date(NOW - 60_000).toISOString(), optIn: null, optOut: null, createdAt: "", updatedAt: "" });
    await expect(r.service.sendText("shop", CUSTOMER, "hello", { sentBy: "a" })).rejects.toMatchObject({ code: "OUTSIDE_WINDOW", message: expect.stringContaining("131047") });
  });

  it("splits long texts at 4096 characters", () => {
    const parts = splitWhatsAppText(`${"a".repeat(3000)}\n\n${"b".repeat(3000)}`);
    expect(parts).toHaveLength(2);
    expect(parts.every((p) => p.length <= 4096)).toBe(true);
  });

  it("notifications: free-form inside, the template outside, or a failure", async () => {
    const op = "393330000001";
    const note = { id: "n1", channel: "shop", title: "Task failed", body: "deploy", severity: "warning" as const, sourceEvent: "task:transition", sourceData: {}, ruleId: "r", timestamp: "" };
    const fail = await tracked();
    await expect(fail.service.notify("shop", note)).rejects.toThrow(/outside the 24-hour window/);

    const tpl = await tracked({ config: { business: { operators: [op], outsideWindow: "template", notificationTemplate: { name: "order_update", language: "it", bodyParams: ["{title}", "{body}"] } } } });
    await tpl.service.notify("shop", note);
    const sent = tpl.graph.sends()[0]!.body;
    expect(sent.type).toBe("template");
    expect(sent.template.components[0].parameters.map((p: any) => p.text)).toEqual(["Task failed", "deploy"]);

    await tpl.store.saveContact({ channel: "shop", waId: op, lastInboundAt: new Date(NOW - 60_000).toISOString(), optIn: null, optOut: null, createdAt: "", updatedAt: "" });
    await tpl.service.notify("shop", note);
    expect(tpl.graph.sends()[1]!.body.type).toBe("text");
  });
});

describe("templates, opt-out, caps and approval", () => {
  it("validates the template: approved, parameters, allowed category", async () => {
    const r = await tracked();
    await expect(r.service.sendTemplate("shop", CUSTOMER, "order_update", ["Mario"], { sentBy: "x", approval: "direct" })).rejects.toMatchObject({ code: "TEMPLATE" });
    await expect(r.service.sendTemplate("shop", CUSTOMER, "promo", [], { sentBy: "x", approval: "direct" })).rejects.toMatchObject({ code: "CATEGORY" });
    await expect(r.service.sendTemplate("shop", CUSTOMER, "missing", [], { sentBy: "x", approval: "direct" })).rejects.toMatchObject({ code: "TEMPLATE" });
    expect(await r.service.sendTemplate("shop", CUSTOMER, "order_update", ["Mario", "A12"], { sentBy: "x", approval: "direct" })).toMatchObject({ status: "sent" });
    expect(templateProblem({ ...TEMPLATES[0]!, status: "PAUSED" } as any, ["a", "b"])).toMatch(/PAUSED/);
  });

  it("an opt-out keyword stops business-initiated messages and is not routed", async () => {
    const r = await tracked();
    const handle = vi.fn<WaBizGatewayHandle["handle"]>();
    r.service.setGateway("shop", { handle });
    await post(r, delivery({ messages: [textMessage("wamid.O1", "Stop")] }));
    await r.service.idle();
    expect(handle).not.toHaveBeenCalled();
    expect((await r.store.getContact("shop", CUSTOMER))?.optOut).toMatchObject({ keyword: "STOP" });
    await expect(r.service.sendTemplate("shop", CUSTOMER, "order_update", ["a", "b"], { sentBy: "x", approval: "direct" })).rejects.toMatchObject({ code: "OPTED_OUT" });
    // ANNULLA works too, START undoes it
    await post(r, delivery({ messages: [textMessage("wamid.O2", "START")] }));
    await r.service.idle();
    expect((await r.store.getContact("shop", CUSTOMER))?.optOut).toBeNull();
  });

  it("applies the daily caps, for the channel and per agent", async () => {
    const r = await tracked();
    const other = "393339999999";
    expect(await r.service.sendTemplate("shop", CUSTOMER, "order_update", ["a", "b"], { sentBy: "sales", approval: "direct" })).toMatchObject({ status: "sent" });
    await expect(r.service.sendTemplate("shop", other, "order_update", ["a", "b"], { sentBy: "sales", approval: "direct" })).rejects.toMatchObject({ code: "CAP_REACHED", message: expect.stringContaining("sales") });
    expect(await r.service.sendTemplate("shop", other, "order_update", ["a", "b"], { sentBy: "ops", approval: "direct" })).toMatchObject({ status: "sent" });
    await expect(r.service.sendTemplate("shop", other, "order_update", ["a", "b"], { sentBy: "ops", approval: "direct" })).rejects.toMatchObject({ code: "CAP_REACHED" });
    r.now.t = NOW + 24 * 3600_000; // a new day
    expect(await r.service.sendTemplate("shop", other, "order_update", ["a", "b"], { sentBy: "ops", approval: "direct" })).toMatchObject({ status: "sent" });
  });

  it("queues agents' templates for approval; approve sends, reject drops", async () => {
    const r = await tracked();
    const q = await r.service.sendTemplate("shop", CUSTOMER, "order_update", ["Mario", "A12"], { sentBy: "support", approval: "queue", reason: "order ready" });
    expect(q.status).toBe("pending_approval");
    expect(r.graph.sends()).toHaveLength(0);
    const [pending] = await r.service.pending("shop");
    expect(pending?.pending).toMatchObject({ template: "order_update", params: ["Mario", "A12"], requestedBy: "support", reason: "order ready" });
    const done = await r.service.approve("shop", pending!.id, "ada");
    expect(done.sentAs).toMatch(/^wamid\.out/);
    expect(r.graph.sends()).toHaveLength(1);
    expect(await r.service.pending("shop")).toEqual([]);

    const q2 = await r.service.sendTemplate("shop", CUSTOMER, "order_update", ["x", "y"], { sentBy: "support", approval: "queue" });
    await r.service.reject("shop", (q2 as { id: string }).id, "ada", "not now");
    expect((await r.store.getMessage((q2 as { id: string }).id))?.status).toBe("rejected");
    expect(r.graph.sends()).toHaveLength(1);
  });
});

// ── Customer mode in the gateway ───────────────────────────────────

function gatewaySetup(o: { gateway?: Record<string, unknown>; customerMode?: boolean; allowed?: boolean; runnerText?: string } = {}) {
  const allow = new Set<string>(o.allowed ? [`whatsapp-business:${CUSTOMER}`] : []);
  const peerStore = {
    getPeer: vi.fn().mockResolvedValue(undefined),
    upsertPeer: vi.fn().mockResolvedValue({}),
    isAllowed: vi.fn().mockImplementation(async (id: string, cfg: { dmPolicy?: string }) => cfg.dmPolicy === "open" || allow.has(id)),
    createPairingRequest: vi.fn().mockResolvedValue({ code: "ZZZ999" }),
    getPendingPairing: vi.fn().mockResolvedValue(undefined),
    getSessionId: vi.fn().mockResolvedValue(undefined),
    setSessionId: vi.fn(),
    updatePresence: vi.fn(),
    getPresence: vi.fn().mockResolvedValue([]),
    resolveCanonicalId: vi.fn().mockImplementation(async (id: string) => id),
  } as unknown as PeerStore;
  const sessionStore = {
    create: vi.fn().mockResolvedValue("s1"), addMessage: vi.fn(), getMessages: vi.fn().mockResolvedValue([]),
    getRecentMessages: vi.fn().mockResolvedValue([]), getSession: vi.fn().mockResolvedValue(undefined), getLatestSession: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionStore;
  const runner = vi.fn<ChannelChatRunner>().mockResolvedValue({ text: o.runnerText ?? "agent says hi" });
  const orchestrator = {
    getStore: vi.fn().mockReturnValue({ getAllTasks: vi.fn().mockResolvedValue([]), getState: vi.fn().mockResolvedValue({ processes: [] }) }),
    getAgents: vi.fn().mockResolvedValue([{ name: "support", role: "Customer care" }]),
    getConfig: vi.fn().mockReturnValue({ project: "t", settings: {} }),
    getChannelChatRunner: vi.fn().mockReturnValue(runner),
  } as unknown as Orchestrator;
  const gateway = new ChannelGateway({
    orchestrator, peerStore, sessionStore,
    channelConfig: { type: "whatsapp-business", gateway: { enableInbound: true, dmPolicy: "open", agent: "support", ...o.gateway } as never },
    customerMode: o.customerMode ?? true,
    isOperator: (id) => id === "393330000001",
  });
  const adapter = new WaBusinessGatewayAdapter(gateway);
  const send = (text: string, from = CUSTOMER) => adapter.handle({ waId: from, chatId: `${PHONE_ID}:${from}`, text, messageId: `m-${Math.random()}` });
  return { gateway, send, runner, peerStore };
}

describe("customer mode", () => {
  it("customers' slash commands are plain chat for the agent; operators' are commands", async () => {
    const g = gatewaySetup();
    const reply = await g.send("/status");
    expect(reply?.text).toBe("agent says hi");
    expect(g.runner).toHaveBeenCalledTimes(1);
    expect(g.runner.mock.calls[0]![0]).toMatchObject({ agent: "support" });
    const op = await g.send("/help", "393330000001");
    expect(op?.text).toMatch(/You are talking to support/);
    expect(g.runner).toHaveBeenCalledTimes(1);
  });

  it("never tells a customer about pairing", async () => {
    const g = gatewaySetup({ gateway: { dmPolicy: "pairing" } });
    expect(await g.send("ciao")).toBeUndefined();
    expect(g.peerStore.createPairingRequest).toHaveBeenCalled();
    expect(g.runner).not.toHaveBeenCalled();
    // outside customer mode the same policy answers with the code
    const team = gatewaySetup({ gateway: { dmPolicy: "pairing" }, customerMode: false });
    expect((await team.send("ciao"))?.text).toContain("ZZZ999");
  });

  it("without gateway.agent customers are not answered (never the orchestrator)", async () => {
    const g = gatewaySetup({ gateway: { agent: undefined } });
    expect(await g.send("ciao")).toBeUndefined();
    expect(g.runner).not.toHaveBeenCalled();
  });

  it("an empty agent turn sends nothing to the customer (no team fallback)", async () => {
    const g = gatewaySetup({ runnerText: "" });
    expect((await g.send("ciao"))?.text ?? "").toBe("");
  });

  it("gateway.commands none: nobody uses commands", async () => {
    const g = gatewaySetup({ customerMode: false, gateway: { commands: "none" } });
    expect((await g.send("/help", "393330000001"))?.text).toBe("agent says hi");
  });
});

// ── Tools ───────────────────────────────────────────────────────────

describe("wabiz_* tools", () => {
  it("are granted only explicitly: never by whatsapp_*, nor by a missing list", () => {
    expect(grantsWabizTool(["whatsapp_*"], "wabiz_send")).toBe(false);
    expect(grantsWabizTool(["whatsapp_send"], "wabiz_send")).toBe(false);
    expect(grantsWabizTool(undefined, "wabiz_send")).toBe(false);
    expect(grantsWabizTool(["*"], "wabiz_send")).toBe(false);
    expect(grantsWabizTool(["wabiz_*"], "wabiz_send_template")).toBe(true);
    expect(grantsWabizTool(["wabiz_conversation"], "wabiz_send")).toBe(false);
    // and the QR WhatsApp patterns do not match them
    expect("wabiz_send".startsWith("whatsapp_")).toBe(false);
    expect(readsExternalContent(["wabiz_*"])).toBe(true);
  });

  it("wabiz_send_template queues for approval; wabiz_send refuses outside the window", async () => {
    const r = await tracked();
    const tools = createWabizTools({ service: () => r.service, sender: "sales" }, ["wabiz_*"]);
    expect(tools.map((t) => t.name).sort()).toEqual(["wabiz_conversation", "wabiz_send", "wabiz_send_template", "wabiz_templates"]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const tpl = await byName.wabiz_send_template!.execute("1", { to: CUSTOMER, template: "order_update", params: ["a", "b"] });
    expect(tpl.content[0]).toMatchObject({ text: expect.stringContaining("queued for approval") });
    const send = await byName.wabiz_send!.execute("2", { to: CUSTOMER, text: "hi" });
    expect((send.content[0] as { text: string }).text).toMatch(/Error: .*24 hours/);
    const conv = await byName.wabiz_conversation!.execute("3", { to: CUSTOMER });
    expect((conv.content[0] as { text: string }).text).toContain("window: closed");
    expect(r.graph.sends()).toHaveLength(0);
  });
});

// ── Admin REST ──────────────────────────────────────────────────────

describe("admin REST", () => {
  let r: Rig;
  let app: ReturnType<typeof waBusinessAdminRoutes>;
  beforeEach(async () => {
    r = await tracked();
    app = waBusinessAdminRoutes({ service: () => r.service });
  });

  it("stores secrets in the vault ($channels) and never returns them", async () => {
    const put = await app.request("/shop/secrets", { method: "PUT", body: JSON.stringify({ accessToken: "EAAG-new-token-123456" }), headers: { "content-type": "application/json" } });
    expect(put.status).toBe(200);
    const putText = await put.text();
    expect(putText).not.toContain("EAAG-new-token");
    expect(r.vault.entries.get("$channels|whatsapp-business:shop:accessToken")?.credentials.secret).toBe("EAAG-new-token-123456");
    const status = await app.request("/shop/status");
    const text = await status.text();
    for (const secret of ["EAAG-new-token-123456", APP_SECRET, VERIFY]) expect(text).not.toContain(secret);
    const data = JSON.parse(text).data;
    expect(data.secrets).toEqual({ accessToken: true, appSecret: true, verifyToken: true });
    expect(data.callbackUrl).toBe("https://host.ts.net/acme/api/v1/channels/whatsapp-business/webhooks/shop");
    expect(data.funnelCommand).toContain("tailscale funnel --bg --set-path /acme/api/v1/channels/whatsapp-business/webhooks");
    const list = await (await app.request("/")).text();
    for (const secret of ["EAAG-new-token-123456", APP_SECRET, VERIFY]) expect(list).not.toContain(secret);
    const del = await app.request("/shop/secrets/appSecret", { method: "DELETE" });
    expect((await del.json()).data.secrets.appSecret).toBe(false);
  });

  it("generates the verify token once and reports refused sends as 400", async () => {
    const gen = await (await app.request("/shop/verify-token", { method: "POST" })).json();
    expect(gen.data.verifyToken).toMatch(/^[\w-]{20,}$/);
    const send = await app.request("/shop/send", { method: "POST", body: JSON.stringify({ to: CUSTOMER, text: "hi" }), headers: { "content-type": "application/json" } });
    expect(send.status).toBe(400);
    expect((await send.json()).code).toBe("OUTSIDE_WINDOW");
    expect((await app.request("/nope/status")).status).toBe(404);
  });

  it("test reads the number's quality rating and tier", async () => {
    const t = await (await app.request("/shop/test", { method: "POST" })).json();
    expect(t.data).toMatchObject({ qualityRating: "GREEN", messagingLimitTier: "TIER_1K" });
    expect(r.graph.calls.at(-1)?.url).toContain(`graph.facebook.com/v23.0/${PHONE_ID}?fields=`);
  });
});
