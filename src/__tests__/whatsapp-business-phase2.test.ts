/**
 * WhatsApp Business phase 2 (Meta Cloud API, never called: fetch is a stub): webhook fixtures for
 * every inbound type, media download (Meta's hosts only, with the token, within the size limits)
 * and upload, the outbound payload of every type and its limits, templates with every component
 * checked against their definition, reactions / edits / revokes / statuses, payments and marketing
 * preferences, the rules (window, block, opt-out, caps, approval) on every send path, one Meta app
 * shared by several channels and instances, account-level webhooks, the admin REST, the MCP tools
 * end to end and the polpo_wabiz_show card.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryWaBusinessStore, mediaProblem, type NotificationChannelConfig, type VaultStore } from "@polpo-ai/core";
import { WaBusinessService, wabizSignature, type WaBizGatewayHandle } from "../notifications/whatsapp-business-service.js";
import { isMetaMediaUrl, WaGraphClient } from "../notifications/channels/whatsapp-business.js";
import { outboundPayload, templateComponents, templateNeeds, templatePreview, type WaTemplate } from "../notifications/channels/whatsapp-business-messages.js";
import { parseInbound } from "../notifications/whatsapp-business-inbound.js";
import { waBusinessAdminRoutes } from "../server/routes/whatsapp-business.js";
import { createWabizTools } from "../tools/wabiz-tools.js";
import { buildWabizCard, cardMessage, wabizCardText } from "../server/mcp-wabiz-card.js";
import type { ApiResponse } from "../server/mcp-server/kit.js";

const APP_SECRET = "app-secret-0123456789";
const TOKEN = "EAAG-access-token-xyz";
const PHONE_ID = "1234567890";
const PHONE_2 = "1234567891";
const PHONE_FAR = "1234567899";
const WABA = "9876543210";
const CUSTOMER = "393331234567";
const NOW = Date.parse("2026-11-24T10:00:00Z");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function memoryVault(): VaultStore {
  const entries = new Map<string, any>();
  const k = (o: string, s: string) => `${o}|${s}`;
  return {
    get: async (o: string, s: string) => entries.get(k(o, s)),
    set: async (o: string, s: string, e: any) => { entries.set(k(o, s), e); },
    remove: async (o: string, s: string) => entries.delete(k(o, s)),
    getAllForAgent: async () => ({}),
    patch: async () => [],
  } as unknown as VaultStore;
}

const TEMPLATES = [
  { id: "t1", name: "order_update", language: "it", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Ciao {{1}}, il tuo ordine {{2}} è pronto." }] },
  { id: "t2", name: "promo", language: "it", status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: "Sconto!" }] },
  {
    id: "t3", name: "shipping", language: "it", status: "APPROVED", category: "UTILITY", parameter_format: "NAMED",
    components: [
      { type: "HEADER", format: "IMAGE" },
      { type: "BODY", text: "Ciao {{name}}, l'ordine {{order}} è partito." },
      { type: "BUTTONS", buttons: [{ type: "URL", text: "Traccia", url: "https://shop.example.com/track/{{1}}" }, { type: "QUICK_REPLY", text: "Grazie" }] },
    ],
  },
];

interface Call { url: string; method: string; body: any; headers: Record<string, string> }

/** Meta's Graph API and the other instances, stubbed: records every call (the token is checked per host). */
function graphStub() {
  let n = 0;
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    let body: any;
    if (typeof init?.body === "string") { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    else if (init?.body instanceof FormData) body = { form: Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `<file ${(v as File).name} ${(v as File).type} ${(v as File).size}>`])) };
    else if (init?.body) body = { bytes: (init.body as Uint8Array).length };
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url: u, method: init?.method ?? "GET", body, headers });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    if (u.startsWith("https://lookaside.fbsbx.com/")) {
      if (headers.authorization !== `Bearer ${TOKEN}`) return new Response("no", { status: 401 });
      const big = u.includes("big");
      return new Response(big ? new Uint8Array(6 * 1024 * 1024) : new Uint8Array(JPEG), { status: 200, headers: { "Content-Type": "image/jpeg", ...(big ? {} : { "Content-Length": String(JPEG.length) }) } });
    }
    if (u.startsWith("https://other-instance.example.com/")) return new Response("{}", { status: 200 });
    if (!u.startsWith("https://graph.facebook.com/v23.0/")) return new Response("unexpected host", { status: 599 });
    const path = u.slice("https://graph.facebook.com/v23.0/".length);
    if (path.startsWith(`${WABA}/message_templates`) && (init?.method ?? "GET") === "GET") return json(200, { data: TEMPLATES });
    if (path.startsWith(`${WABA}/message_templates`) && init?.method === "POST") return json(200, { id: "t9", status: "PENDING", category: body.category });
    if (path.startsWith(`${WABA}/message_templates`) && init?.method === "DELETE") return json(200, { success: true });
    if (path === `${PHONE_ID}/messages` && body?.status === "read") return json(200, { success: true });
    if (path === `${PHONE_ID}/messages` || path === `${PHONE_ID}/marketing_messages`) return json(200, { messages: [{ id: `wamid.out${++n}` }] });
    if (path === `${PHONE_ID}/media`) return json(200, { id: "media.up1" });
    if (path.startsWith("media.in")) {
      const id = path.split("?")[0]!;
      if (id === "media.inEvil") return json(200, { url: "https://evil.example.com/steal", mime_type: "image/jpeg", file_size: 8 });
      if (id === "media.inBig") return json(200, { url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=big", mime_type: "image/jpeg" });
      if (id === "media.inHuge") return json(200, { url: "https://lookaside.fbsbx.com/x", mime_type: "video/mp4", file_size: 40 * 1024 * 1024 });
      return json(200, { url: `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${id}`, mime_type: "image/jpeg", sha256: "abc", file_size: JPEG.length });
    }
    if (path === `${PHONE_ID}/block_users`) {
      const users = (body.block_users as Array<{ user: string }>).map((x) => ({ input: x.user, wa_id: x.user.replace("+", "") }));
      return json(200, { messaging_product: "whatsapp", block_users: init?.method === "DELETE" ? { removed_users: users } : { added_users: users } });
    }
    if (path.startsWith(`${PHONE_ID}/whatsapp_business_profile`)) {
      return init?.method === "POST" ? json(200, { success: true }) : json(200, { data: [{ about: "Siamo aperti", websites: ["https://shop.example.com"], vertical: "RETAIL" }] });
    }
    if (path === `${PHONE_ID}/register` || path === `${WABA}/subscribed_apps`) return json(200, { success: true });
    if (path.startsWith(`${PHONE_ID}?fields=webhook_configuration`)) return json(200, { webhook_configuration: { application: "https://app.example.com/hook" } });
    if (path === PHONE_ID && init?.method === "POST") return json(200, { success: true });
    if (path.startsWith(`${PHONE_ID}?fields=`)) return json(200, { id: PHONE_ID, display_phone_number: "+39 02 1234", quality_rating: "GREEN", messaging_limit_tier: "TIER_1K" });
    return json(404, { error: { message: "unknown" } });
  });
  return {
    fetch: fetch as unknown as typeof globalThis.fetch, calls,
    sends: () => calls.filter((c) => /\/(messages|marketing_messages)$/.test(c.url) && c.body?.status !== "read"),
  };
}

function channelConfig(phoneNumberId: string, over: Partial<NotificationChannelConfig> = {}): NotificationChannelConfig {
  return {
    type: "whatsapp-business", phoneNumberId, wabaId: WABA,
    business: { operators: ["393330000001"], limits: { businessInitiatedPerDay: 5 }, catalogId: "55555", sharedApp: { routes: { [PHONE_FAR]: "https://other-instance.example.com/api/v1/channels/whatsapp-business/webhooks/far" } } },
    gateway: { enableInbound: true, agent: "support" },
    ...over,
  };
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function rig(o: { config?: Partial<NotificationChannelConfig>; second?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wabiz2-"));
  dirs.push(dir);
  const store = new InMemoryWaBusinessStore();
  const vault = memoryVault();
  const graph = graphStub();
  const events: Array<{ event: string; payload: any }> = [];
  const channels: Record<string, NotificationChannelConfig> = { shop: channelConfig(PHONE_ID, o.config), ...(o.second ? { shop2: channelConfig(PHONE_2) } : {}) };
  const now = { t: NOW };
  const service = new WaBusinessService({
    polpoDir: () => dir, channels: () => channels, store: () => store, vault: () => vault,
    emit: (event, payload) => events.push({ event, payload }), fetch: graph.fetch, now: () => now.t, timers: false,
    publicBase: () => "https://host.ts.net/acme",
  });
  for (const ch of Object.keys(channels)) {
    await service.setSecret(ch, "accessToken", TOKEN);
    await service.setSecret(ch, "appSecret", APP_SECRET);
    await service.setSecret(ch, "verifyToken", "verify-token-abcdef");
  }
  return { dir, service, store, graph, events, channels, now };
}
type Rig = Awaited<ReturnType<typeof rig>>;

function delivery(o: { messages?: any[]; statuses?: any[]; phoneId?: string; field?: string; value?: any; userPreferences?: any[] } = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: WABA, changes: [{ field: o.field ?? "messages", value: o.value ?? {
      messaging_product: "whatsapp", metadata: { display_phone_number: "39021234", phone_number_id: o.phoneId ?? PHONE_ID },
      ...(o.messages ? { contacts: [{ profile: { name: "Mario" }, wa_id: CUSTOMER }], messages: o.messages } : {}),
      ...(o.statuses ? { statuses: o.statuses } : {}), ...(o.userPreferences ? { user_preferences: o.userPreferences } : {}),
    } }] }],
  };
}
const ts = String(NOW / 1000);
const msg = (id: string, type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ from: CUSTOMER, id, timestamp: ts, type, ...payload, ...extra });

async function post(r: Rig, body: unknown, channel = "shop") {
  const raw = Buffer.from(JSON.stringify(body));
  const res = await r.service.receive(channel, raw, wabizSignature(APP_SECRET, raw));
  await r.service.idle();
  return res;
}

/** Open the contact's window (a text from them, answered by nobody). */
async function openWindow(r: Rig) {
  await post(r, delivery({ messages: [msg("wamid.open", "text", { text: { body: "ciao" } })] }));
}

// ── Inbound: every type ─────────────────────────────────────────────

describe("inbound webhook fixtures, every type", () => {
  it("normalizes text, media, location, contacts, interactive replies, template buttons, orders, system and unknown types", () => {
    expect(parseInbound(msg("w", "text", { text: { body: "ciao" } }, { context: { forwarded: true } }))).toMatchObject({ type: "text", text: "[forwarded] ciao", route: true, context: { forwarded: true } });
    expect(parseInbound(msg("w", "text", { text: { body: "?" } }, { context: { frequently_forwarded: true, forwarded: true } })).text).toBe("[forwarded many times] ?");
    expect(parseInbound(msg("w", "image", { image: { id: "m1", mime_type: "image/jpeg", sha256: "x", caption: "scontrino" } }))).toMatchObject({ type: "image", text: "scontrino", media: { kind: "image", mediaId: "m1", caption: "scontrino" }, event: { kind: "media" } });
    expect(parseInbound(msg("w", "audio", { audio: { id: "m2", mime_type: "audio/ogg; codecs=opus", voice: true } }))).toMatchObject({ type: "voice", media: { kind: "audio", voice: true } });
    expect(parseInbound(msg("w", "audio", { audio: { id: "m2b", mime_type: "audio/mpeg" } })).type).toBe("audio");
    expect(parseInbound(msg("w", "video", { video: { id: "m3", mime_type: "video/mp4" } })).media).toMatchObject({ kind: "video" });
    expect(parseInbound(msg("w", "document", { document: { id: "m4", mime_type: "application/pdf", filename: "fattura.pdf" } })).media).toMatchObject({ kind: "document", filename: "fattura.pdf" });
    expect(parseInbound(msg("w", "sticker", { sticker: { id: "m5", mime_type: "image/webp", animated: true } })).media).toMatchObject({ kind: "sticker", animated: true });
    const loc = parseInbound(msg("w", "location", { location: { latitude: 45.46, longitude: 9.19, name: "Duomo", address: "Milano" } }));
    expect(loc).toMatchObject({ content: { latitude: 45.46, longitude: 9.19, name: "Duomo" }, event: { kind: "location" } });
    expect(loc.text).toContain("45.46, 9.19 — Duomo, Milano");
    const cards = parseInbound(msg("w", "contacts", { contacts: [{ name: { formatted_name: "Anna Rossi" }, phones: [{ phone: "+39 333 1" }] }] }));
    expect(cards.text).toBe("[shared contact: Anna Rossi, +39 333 1]");
    expect(parseInbound(msg("w", "interactive", { interactive: { type: "list_reply", list_reply: { id: "r2", title: "Martedì", description: "ore 10" } } }, { context: { id: "wamid.q" } })))
      .toMatchObject({ type: "interactive.list_reply", content: { reply: "list", id: "r2", to: "wamid.q" }, event: { kind: "list" } });
    const flow = parseInbound(msg("w", "interactive", { interactive: { type: "nfm_reply", nfm_reply: { name: "flow", body: "Sent", response_json: "{\"flow_token\":\"ord-7\",\"size\":\"M\"}" } } }));
    expect(flow).toMatchObject({ content: { reply: "flow", flowToken: "ord-7", response: { flow_token: "ord-7", size: "M" } }, event: { kind: "flow" }, route: true });
    const address = parseInbound(msg("w", "interactive", { interactive: { type: "nfm_reply", nfm_reply: { name: "address_message", response_json: "{\"values\":{\"city\":\"Mumbai\"}}" } } }));
    expect(address).toMatchObject({ content: { reply: "address", address: { values: { city: "Mumbai" } } }, event: { kind: "address" } });
    const perm = parseInbound(msg("w", "interactive", { interactive: { type: "call_permission_reply", call_permission_reply: { response: "accept", is_permanent: false, expiration_timestamp: 1764000000 } } }));
    expect(perm).toMatchObject({ route: false, content: { response: "accept", permanent: false, expiresAt: new Date(1764000000 * 1000).toISOString() }, event: { kind: "call_permission" } });
    expect(parseInbound(msg("w", "button", { button: { text: "Sì", payload: "CONFIRM" } }))).toMatchObject({ type: "button", content: { reply: "template_button", payload: "CONFIRM" }, text: "Sì\n[template button: payload \"CONFIRM\"]" });
    const order = parseInbound(msg("w", "order", { order: { catalog_id: "55555", text: "per domani", product_items: [{ product_retailer_id: "SKU1", quantity: 2, item_price: 12.5, currency: "EUR" }, { product_retailer_id: "SKU2", quantity: 1, item_price: 5, currency: "EUR" }] } }));
    expect(order).toMatchObject({ content: { order: { catalogId: "55555", total: 30, currency: "EUR", items: [{ productRetailerId: "SKU1", quantity: 2 }, { productRetailerId: "SKU2" }] } }, event: { kind: "order" } });
    expect(parseInbound(msg("w", "text", { text: { body: "info?" } }, { context: { referred_product: { catalog_id: "55555", product_retailer_id: "SKU1" } } })).text).toBe("[about product SKU1] info?");
    expect(parseInbound(msg("w", "text", { text: { body: "hi" } }, { referral: { source_type: "ad", headline: "Saldi" } })).text).toBe("[came from an ad: Saldi] hi");
    expect(parseInbound(msg("w", "request_welcome", {}))).toMatchObject({ route: true, event: { kind: "welcome" } });
    expect(parseInbound(msg("w", "system", { system: { body: "Mario changed number", type: "user_changed_number" } }))).toMatchObject({ route: false });
    expect(parseInbound(msg("w", "unsupported", { errors: [{ code: 131051, title: "Message type unknown" }] }))).toMatchObject({ route: false, text: expect.stringContaining("Message type unknown") });
    expect(parseInbound(msg("w", "reaction", { reaction: { message_id: "wamid.out1", emoji: "👍" } }))).toMatchObject({ route: false, reaction: { messageId: "wamid.out1", emoji: "👍" } });
    expect(parseInbound(msg("w", "edit", { edit: { original_message_id: "wamid.a", message: { type: "text", text: { body: "corretto" } } } }))).toMatchObject({ edit: { originalId: "wamid.a", text: "corretto" } });
    expect(parseInbound(msg("w", "revoke", { revoke: { original_message_id: "wamid.a" } }))).toMatchObject({ revoke: { originalId: "wamid.a" } });
  });

  it("a flow completion, an order and a button reply are announced as structured events (trigger-friendly) and reach the agent with their data", async () => {
    const r = await rig();
    const handle = vi.fn<WaBizGatewayHandle["handle"]>().mockResolvedValue(undefined);
    r.service.setGateway("shop", { handle });
    await post(r, delivery({ messages: [
      msg("wamid.F", "interactive", { interactive: { type: "nfm_reply", nfm_reply: { name: "flow", response_json: "{\"flow_token\":\"ord-7\",\"size\":\"M\"}" } } }),
      msg("wamid.O", "order", { order: { catalog_id: "55555", product_items: [{ product_retailer_id: "SKU1", quantity: 1, item_price: 9, currency: "EUR" }] } }),
      msg("wamid.B", "interactive", { interactive: { type: "button_reply", button_reply: { id: "yes", title: "Sì" } } }),
    ] }));
    const wabiz = r.events.filter((e) => e.event === "channel:wabiz-event").map((e) => e.payload);
    expect(wabiz.map((p) => p.kind)).toEqual(["flow", "order", "button"]);
    expect(wabiz[0]).toMatchObject({ channel: "shop", contact: "39•••••••567", messageId: "wamid.F", data: { flowToken: "ord-7", response: { size: "M" } } });
    expect(JSON.stringify(wabiz)).not.toContain(CUSTOMER);
    expect(handle.mock.calls.map((c) => c[0].text)).toEqual([
      expect.stringContaining("[flow completed (token ord-7)"), expect.stringContaining("[order from catalog 55555: 1× SKU1 at 9 EUR"), "Sì\n[button reply: id \"yes\"]",
    ]);
    expect((await r.store.getMessage("wamid.O"))?.content).toMatchObject({ order: { total: 9 } });
  });
});

// ── Media ───────────────────────────────────────────────────────────

describe("media", () => {
  it("only Meta's https hosts receive the token", () => {
    expect(isMetaMediaUrl("https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1")).toBe(true);
    expect(isMetaMediaUrl("https://graph.facebook.com/v23.0/x")).toBe(true);
    expect(isMetaMediaUrl("http://lookaside.fbsbx.com/x")).toBe(false);
    expect(isMetaMediaUrl("https://lookaside.fbsbx.com.evil.example/x")).toBe(false);
    expect(isMetaMediaUrl("https://evil.example.com/x")).toBe(false);
    expect(isMetaMediaUrl("not a url")).toBe(false);
  });

  it("downloads an inbound photo with the token, keeps it, hands it to the agent and serves it to the dashboard", async () => {
    const r = await rig();
    const handle = vi.fn<WaBizGatewayHandle["handle"]>().mockResolvedValue(undefined);
    r.service.setGateway("shop", { handle });
    await post(r, delivery({ messages: [msg("wamid.P", "image", { image: { id: "media.in1", mime_type: "image/jpeg", caption: "scontrino" } })] }));
    const info = r.graph.calls.find((c) => c.url.includes("/media.in1?"))!;
    expect(info.url).toContain(`phone_number_id=${PHONE_ID}`);
    const dl = r.graph.calls.find((c) => c.url.startsWith("https://lookaside.fbsbx.com/"))!;
    expect(dl.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const call = handle.mock.calls[0]![0];
    expect(call.text).toBe("scontrino");
    expect(call.attachments).toEqual([expect.objectContaining({ kind: "photo", mimeType: "image/jpeg", data: JPEG })]);
    const stored = await r.store.getMessage("wamid.P");
    expect(stored?.media).toMatchObject({ kind: "image", mediaId: "media.in1", size: JPEG.length, stored: expect.stringMatching(/\.jpg$/) });
    const app = waBusinessAdminRoutes({ service: () => r.service });
    const res = await app.request("/shop/media/wamid.P");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(JPEG);
    expect((await app.request("/shop/media/wamid.nope")).status).toBe(404);
  });

  it("a voice note goes to the gateway as voice (transcribed there); a URL off Meta's hosts, a file over the limit or a download switched off are not fetched", async () => {
    const r = await rig({ config: { business: { media: { maxBytes: 1024 * 1024 } } } });
    const handle = vi.fn<WaBizGatewayHandle["handle"]>().mockResolvedValue(undefined);
    r.service.setGateway("shop", { handle });
    await post(r, delivery({ messages: [
      msg("wamid.V", "audio", { audio: { id: "media.inVoice", mime_type: "audio/ogg", voice: true } }),
      msg("wamid.E", "image", { image: { id: "media.inEvil", mime_type: "image/jpeg" } }),
      msg("wamid.G", "image", { image: { id: "media.inBig", mime_type: "image/jpeg" } }),
      msg("wamid.H", "video", { video: { id: "media.inHuge", mime_type: "video/mp4" } }),
    ] }));
    expect(handle.mock.calls[0]![0]).toMatchObject({ voice: true, attachments: [expect.objectContaining({ kind: "voice" })] });
    expect(r.graph.calls.some((c) => c.url.startsWith("https://evil.example.com"))).toBe(false);
    expect((await r.store.getMessage("wamid.E"))?.media?.skipped).toMatch(/only Meta's hosts/);
    expect((await r.store.getMessage("wamid.G"))?.media?.skipped).toMatch(/too large/i);
    expect((await r.store.getMessage("wamid.H"))?.media?.skipped).toMatch(/Too large/);
    expect(handle.mock.calls[1]![0].text).toMatch(/^\[photo not available: Refused/);
    expect(handle.mock.calls[3]![0].text).toMatch(/^\[video not available: Too large/);

    const off = await rig({ config: { business: { media: { download: false } } } });
    await post(off, delivery({ messages: [msg("wamid.X", "image", { image: { id: "media.in2" } })] }));
    expect((await off.store.getMessage("wamid.X"))?.media?.skipped).toContain("off");
    expect(off.graph.calls.some((c) => c.url.includes("media.in2"))).toBe(false);
  });

  it("downloadMedia refuses redirects' hosts up front and stops reading past the limit", async () => {
    const g = graphStub();
    const client = new WaGraphClient({ phoneNumberId: PHONE_ID, wabaId: WABA, token: async () => TOKEN, fetch: g.fetch });
    await expect(client.downloadMedia("https://evil.example.com/x", 1000)).rejects.toThrow(/only Meta's hosts/);
    await expect(client.downloadMedia("https://lookaside.fbsbx.com/?mid=big", 1024)).rejects.toThrow(/too large/);
    expect((await client.downloadMedia("https://lookaside.fbsbx.com/?mid=ok", 1024)).data).toEqual(JPEG);
  });

  it("Meta's types and sizes per kind", () => {
    expect(mediaProblem("image", "image/jpeg", 1000)).toBeUndefined();
    expect(mediaProblem("image", "image/gif", 1000)).toMatch(/image\/jpeg, image\/png, image\/webp/);
    expect(mediaProblem("image", "image/png", 6 * 1024 * 1024)).toMatch(/at most 5 MB/);
    expect(mediaProblem("audio", "audio/ogg; codecs=opus", 1000)).toBeUndefined();
    expect(mediaProblem("video", "video/mp4", 17 * 1024 * 1024)).toMatch(/16 MB/);
    expect(mediaProblem("document", "application/zip", 99 * 1024 * 1024)).toBeUndefined();
    expect(mediaProblem("sticker", "image/webp", 600 * 1024)).toMatch(/500 KB/);
  });

  it("sends a file by upload (multipart, then the media id) inside the window, keeps it, and refuses a type Meta does not take", async () => {
    const r = await rig();
    await openWindow(r);
    const sent = await r.service.sendMessage("shop", CUSTOMER, { type: "media", kind: "image", caption: "il tuo scontrino" }, { sentBy: "support", file: { data: JPEG, mimeType: "image/jpeg", filename: "s.jpg" } });
    const upload = r.graph.calls.find((c) => c.url.endsWith(`/${PHONE_ID}/media`))!;
    expect(upload.body.form).toMatchObject({ messaging_product: "whatsapp", type: "image/jpeg", file: `<file s.jpg image/jpeg ${JPEG.length}>` });
    expect(r.graph.sends().at(-1)!.body).toMatchObject({ to: CUSTOMER, type: "image", image: { id: "media.up1", caption: "il tuo scontrino" } });
    const m = await r.store.getMessage(sent.ids[0]!);
    expect(m?.media).toMatchObject({ kind: "image", mediaId: "media.up1", stored: expect.any(String), size: JPEG.length });
    expect(existsSync(join(r.dir, "whatsapp-business", "media", "shop", m!.media!.stored!))).toBe(true);
    await expect(r.service.sendMessage("shop", CUSTOMER, { type: "media", kind: "image" }, { sentBy: "x", file: { data: JPEG, mimeType: "image/gif", filename: "a.gif" } })).rejects.toMatchObject({ code: "INVALID" });
    // by link, a document with its name
    await r.service.sendMessage("shop", CUSTOMER, { type: "media", kind: "document", link: "https://files.example.com/f.pdf", filename: "fattura.pdf", caption: "Fattura" }, { sentBy: "support" });
    expect(r.graph.sends().at(-1)!.body).toMatchObject({ type: "document", document: { link: "https://files.example.com/f.pdf", filename: "fattura.pdf", caption: "Fattura" } });
  });
});

// ── Outbound payloads ───────────────────────────────────────────────

describe("outbound payloads (Cloud API shapes and limits)", () => {
  const p = (o: Parameters<typeof outboundPayload>[0], d: Parameters<typeof outboundPayload>[1] = { catalogId: "55555" }) => outboundPayload(o, d);

  it("text, media, location, contacts and reactions", () => {
    expect(p({ type: "text", text: "hi", replyTo: "wamid.q" })).toEqual({ context: { message_id: "wamid.q" }, type: "text", text: { body: "hi", preview_url: false } });
    expect(p({ type: "media", kind: "audio", mediaId: "m1" })).toEqual({ type: "audio", audio: { id: "m1" } });
    expect(() => p({ type: "media", kind: "audio", mediaId: "m1", caption: "x" })).toThrow(/no caption/);
    expect(() => p({ type: "media", kind: "image", mediaId: "m1", filename: "a.jpg" })).toThrow(/Only a document/);
    expect(() => p({ type: "media", kind: "image", link: "http://insecure.example.com/a.jpg" })).toThrow(/https/);
    expect(p({ type: "media", kind: "sticker", link: "https://x.example.com/s.webp" })).toEqual({ type: "sticker", sticker: { link: "https://x.example.com/s.webp" } });
    expect(p({ type: "location", latitude: 45.4, longitude: 9.1, name: "Negozio", address: "Via Roma 1" })).toEqual({ type: "location", location: { latitude: 45.4, longitude: 9.1, name: "Negozio", address: "Via Roma 1" } });
    expect(() => p({ type: "location", latitude: 95, longitude: 0 })).toThrow(/latitude/);
    expect(p({ type: "contacts", contacts: [{ name: "Anna Rossi", phones: [{ phone: "+39 02 1", type: "WORK", waId: "3921" }], company: "Acme" }] })).toEqual({
      type: "contacts", contacts: [{ name: { formatted_name: "Anna Rossi", first_name: "Anna", last_name: "Rossi" }, phones: [{ phone: "+39 02 1", type: "WORK", wa_id: "3921" }], org: { company: "Acme" } }],
    });
    expect(p({ type: "reaction", messageId: "wamid.a", emoji: "" })).toEqual({ type: "reaction", reaction: { message_id: "wamid.a", emoji: "" } });
  });

  it("buttons, lists, CTA URL, location and address requests, call buttons", () => {
    expect(p({ type: "buttons", body: "Confermi?", header: { type: "image", link: "https://x.example.com/a.jpg" }, footer: "Acme", buttons: [{ id: "y", title: "Sì" }, { id: "n", title: "No" }] })).toEqual({
      type: "interactive", interactive: { type: "button", header: { type: "image", image: { link: "https://x.example.com/a.jpg" } }, body: { text: "Confermi?" }, footer: { text: "Acme" },
        action: { buttons: [{ type: "reply", reply: { id: "y", title: "Sì" } }, { type: "reply", reply: { id: "n", title: "No" } }] } },
    });
    expect(() => p({ type: "buttons", body: "x", buttons: [1, 2, 3, 4].map((i) => ({ id: `b${i}`, title: "t" })) })).toThrow(/1 to 3/);
    expect(() => p({ type: "buttons", body: "x", buttons: [{ id: "a", title: "a title longer than twenty" }] })).toThrow(/at most 20/);
    expect(() => p({ type: "buttons", body: "x", buttons: [{ id: "a", title: "1" }, { id: "a", title: "2" }] })).toThrow(/unique/);
    expect(p({ type: "list", body: "Scegli", button: "Orari", sections: [{ title: "Mattina", rows: [{ id: "9", title: "9:00", description: "libero" }] }, { title: "Pomeriggio", rows: [{ id: "15", title: "15:00" }] }] }).interactive).toEqual({
      type: "list", body: { text: "Scegli" }, action: { button: "Orari", sections: [{ title: "Mattina", rows: [{ id: "9", title: "9:00", description: "libero" }] }, { title: "Pomeriggio", rows: [{ id: "15", title: "15:00" }] }] },
    });
    expect(() => p({ type: "list", body: "x", button: "b", sections: [{ rows: Array.from({ length: 11 }, (_, i) => ({ id: `${i}`, title: "t" })) }] })).toThrow(/1 to 10/);
    expect(() => p({ type: "list", body: "x", button: "b", sections: [{ rows: [{ id: "1", title: "t" }] }, { rows: [{ id: "2", title: "t" }] }] })).toThrow(/needs a title/);
    expect(p({ type: "cta_url", body: "Il sito", displayText: "Apri", url: "https://shop.example.com" }).interactive).toEqual({
      type: "cta_url", body: { text: "Il sito" }, action: { name: "cta_url", parameters: { display_text: "Apri", url: "https://shop.example.com" } },
    });
    expect(p({ type: "location_request", body: "Dove sei?" }).interactive).toEqual({ type: "location_request_message", body: { text: "Dove sei?" }, action: { name: "send_location" } });
    expect(() => p({ type: "address", body: "Indirizzo?", country: "BR" as "IN" })).toThrow(/India/);
    expect(p({ type: "address", body: "Indirizzo?", country: "IN" }).interactive).toMatchObject({ type: "address_message", action: { name: "address_message", parameters: { country: "IN" } } });
    expect(p({ type: "voice_call", body: "Chiamaci", displayText: "Chiama", ttlMinutes: 60 }).interactive).toEqual({ type: "voice_call", body: { text: "Chiamaci" }, action: { name: "voice_call", parameters: { display_text: "Chiama", ttl_minutes: 60 } } });
    expect(p({ type: "call_permission_request", body: "Possiamo chiamarti?" }).interactive).toEqual({ type: "call_permission_request", body: { text: "Possiamo chiamarti?" }, action: { name: "call_permission_request" } });
  });

  it("flows, products and the catalog", () => {
    expect(p({ type: "flow", body: "Prenota", cta: "Apri", flowId: "1234", flowToken: "ord-7", screen: "START", data: { day: "lun" } }).interactive).toEqual({
      type: "flow", body: { text: "Prenota" },
      action: { name: "flow", parameters: { flow_message_version: "3", flow_id: "1234", flow_cta: "Apri", flow_token: "ord-7", mode: "published", flow_action: "navigate", flow_action_payload: { screen: "START", data: { day: "lun" } } } },
    });
    expect(() => p({ type: "flow", body: "x", cta: "y" })).toThrow(/flow's id/);
    expect(p({ type: "product", productRetailerId: "SKU1", body: "Eccolo" }).interactive).toEqual({ type: "product", body: { text: "Eccolo" }, action: { catalog_id: "55555", product_retailer_id: "SKU1" } });
    expect(() => p({ type: "product", productRetailerId: "SKU1" }, {})).toThrow(/catalog id/);
    expect(p({ type: "product_list", header: "Novità", body: "Guarda", sections: [{ title: "Scarpe", productRetailerIds: ["S1", "S2"] }] }).interactive).toEqual({
      type: "product_list", header: { type: "text", text: "Novità" }, body: { text: "Guarda" },
      action: { catalog_id: "55555", sections: [{ title: "Scarpe", product_items: [{ product_retailer_id: "S1" }, { product_retailer_id: "S2" }] }] },
    });
    expect(() => p({ type: "product_list", header: "h", body: "b", sections: [{ title: "t", productRetailerIds: Array.from({ length: 31 }, (_, i) => `S${i}`) }] })).toThrow(/1 to 30/);
    expect(p({ type: "catalog", body: "Il catalogo", thumbnailProductRetailerId: "S1" }).interactive).toEqual({ type: "catalog_message", body: { text: "Il catalogo" }, action: { name: "catalog_message", parameters: { thumbnail_product_retailer_id: "S1" } } });
  });

  it("order details only where Meta has payments (India, Brazil), amounts in Meta's value/offset", () => {
    const order = { type: "order_details" as const, body: "Il tuo ordine", referenceId: "ORD-1", items: [{ name: "Pizza", amount: 8.5, quantity: 2 }], shipping: 3 };
    expect(() => p(order)).toThrow(/Payments are off/);
    const br = p({ ...order, paymentSettings: [{ type: "pix_dynamic_code", pix_dynamic_code: { code: "000201", merchant_name: "Acme", key: "k", key_type: "CPF" } }] }, { payments: { market: "BR" } });
    expect(br.interactive).toMatchObject({ type: "order_details", action: { name: "review_and_pay", parameters: {
      reference_id: "ORD-1", type: "digital-goods", payment_type: "br", currency: "BRL", total_amount: { value: 2000, offset: 100 },
      order: { status: "pending", items: [{ name: "Pizza", amount: { value: 850, offset: 100 }, quantity: 2 }], subtotal: { value: 1700, offset: 100 }, shipping: { value: 300, offset: 100 } },
    } } });
    expect(() => p(order, { payments: { market: "BR" } })).toThrow(/Brazil/);
    expect(p(order, { payments: { market: "IN", configurationName: "upi-acme" } }).interactive).toMatchObject({ action: { parameters: { payment_type: "upi", payment_configuration: "upi-acme", currency: "INR" } } });
    expect(p({ type: "order_status", body: "Spedito", referenceId: "ORD-1", status: "shipped" }, { payments: { market: "IN" } }).interactive).toEqual({
      type: "order_status", body: { text: "Spedito" }, action: { name: "review_order", parameters: { reference_id: "ORD-1", order: { status: "shipped" } } },
    });
  });
});

// ── Templates ───────────────────────────────────────────────────────

describe("templates: every component, checked against the definition", () => {
  const t = (components: WaTemplate["components"], o: Partial<WaTemplate> = {}): WaTemplate => ({ name: "tpl", language: "it", status: "APPROVED", category: "UTILITY", components, ...o });

  it("headers: text with a variable, image / video / document, location", () => {
    expect(templateComponents(t([{ type: "HEADER", format: "TEXT", text: "Ordine {{1}}" }, { type: "BODY", text: "ok" }]), { header: { type: "text", text: "A12" } }))
      .toEqual([{ type: "header", parameters: [{ type: "text", text: "A12" }] }]);
    expect(() => templateComponents(t([{ type: "HEADER", format: "TEXT", text: "Ordine {{1}}" }, { type: "BODY", text: "ok" }]))).toThrow(/header variable/);
    expect(templateComponents(t([{ type: "HEADER", format: "DOCUMENT" }, { type: "BODY", text: "ok" }]), { header: { type: "document", mediaId: "m1", filename: "f.pdf" } }))
      .toEqual([{ type: "header", parameters: [{ type: "document", document: { id: "m1", filename: "f.pdf" } }] }]);
    expect(() => templateComponents(t([{ type: "HEADER", format: "VIDEO" }, { type: "BODY", text: "ok" }]), { header: { type: "image", link: "https://x.example.com/a.jpg" } })).toThrow(/video header/);
    expect(templateComponents(t([{ type: "HEADER", format: "LOCATION" }, { type: "BODY", text: "ok" }]), { header: { type: "location", latitude: 45.4, longitude: 9.1, name: "Negozio" } }))
      .toEqual([{ type: "header", parameters: [{ type: "location", location: { latitude: "45.4", longitude: "9.1", name: "Negozio" } }] }]);
    expect(() => templateComponents(t([{ type: "BODY", text: "ok" }]), { header: { type: "text", text: "x" } })).toThrow(/no header/);
  });

  it("positional and named body variables: every one, nothing extra, no new lines", () => {
    const pos = t([{ type: "BODY", text: "Ciao {{1}}, ordine {{2}}" }]);
    expect(templateComponents(pos, { body: ["Mario", "A12"] })).toEqual([{ type: "body", parameters: [{ type: "text", text: "Mario" }, { type: "text", text: "A12" }] }]);
    expect(() => templateComponents(pos, { body: ["Mario"] })).toThrow(/needs 2 parameters/);
    expect(() => templateComponents(pos, { body: ["Ma\nrio", "x"] })).toThrow(/new lines/);
    expect(() => templateComponents(pos, { body: { name: "x" } })).toThrow(/positional/);
    const named = t([{ type: "BODY", text: "Ciao {{name}}, ordine {{order}}" }], { parameterFormat: "NAMED" });
    expect(templateComponents(named, { body: { order: "A12", name: "Mario" } })).toEqual([{ type: "body", parameters: [{ type: "text", text: "Mario", parameter_name: "name" }, { type: "text", text: "A12", parameter_name: "order" }] }]);
    expect(() => templateComponents(named, { body: { name: "Mario" } })).toThrow(/needs \{\{order\}\}/);
    expect(() => templateComponents(named, { body: { name: "M", order: "1", extra: "x" } })).toThrow(/no parameter \{\{extra\}\}/);
    expect(templatePreview(named, { body: { name: "Mario", order: "A12" } })).toBe("Ciao Mario, ordine A12");
  });

  it("buttons: URL suffix, quick reply payload, copy code, flow; phone buttons take nothing", () => {
    const tpl = t([{ type: "BODY", text: "ok" }, { type: "BUTTONS", buttons: [
      { type: "URL", text: "Traccia", url: "https://x.example.com/t/{{1}}" }, { type: "QUICK_REPLY", text: "Stop" }, { type: "COPY_CODE", text: "Copia" },
      { type: "PHONE_NUMBER", text: "Chiama", phone_number: "+3902" }, { type: "FLOW", text: "Prenota", flow_id: "77" },
    ] }]);
    expect(templateNeeds(tpl).buttons.map((b) => b.needs ?? b.optional ?? "-")).toEqual(["text", "payload", "coupon_code", "-", "flow"]);
    expect(templateComponents(tpl, { buttons: [{ index: 0, text: "A12" }, { index: 1, payload: "STOP" }, { index: 2, couponCode: "SCONTO10" }, { index: 4, flowToken: "f-1" }] })).toEqual([
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "A12" }] },
      { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: "STOP" }] },
      { type: "button", sub_type: "copy_code", index: "2", parameters: [{ type: "coupon_code", coupon_code: "SCONTO10" }] },
      { type: "button", sub_type: "flow", index: "4", parameters: [{ type: "action", action: { flow_token: "f-1" } }] },
    ]);
    expect(() => templateComponents(tpl, { buttons: [{ index: 2, couponCode: "X" }] })).toThrow(/button 0 "Traccia" has a URL with a variable/);
    expect(() => templateComponents(tpl, { buttons: [{ index: 0, text: "a" }, { index: 2, couponCode: "A-CODE-LONGER-THAN-15" }] })).toThrow(/at most 15/);
    expect(() => templateComponents(tpl, { buttons: [{ index: 0, text: "a" }, { index: 2, couponCode: "X" }, { index: 3, text: "nope" }] })).toThrow(/takes no value/);
    expect(() => templateComponents(tpl, { buttons: [{ index: 9, text: "a" }] })).toThrow(/no button 9/);
  });

  it("authentication: the one-time code fills the body and the copy-code / one-tap button", () => {
    const auth = t([{ type: "BODY", text: "{{1}} è il tuo codice." }, { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "ONE_TAP", text: "Copia codice" }] }], { category: "AUTHENTICATION" });
    expect(templateComponents(auth, { otp: "482913" })).toEqual([
      { type: "body", parameters: [{ type: "text", text: "482913" }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "482913" }] },
    ]);
    expect(() => templateComponents(auth, {})).toThrow();
  });

  it("carousels: a card per definition card, each with its header, body and buttons; limited-time offers", () => {
    const card = { components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Prodotto {{1}}" }, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Lo voglio" }] }] };
    const carousel = t([{ type: "BODY", text: "Novità" }, { type: "CAROUSEL", cards: [card, card] }], { category: "MARKETING" });
    expect(templateComponents(carousel, { carousel: [
      { header: { type: "image", link: "https://x.example.com/1.jpg" }, body: ["A"], buttons: [{ index: 0, payload: "A" }] },
      { header: { type: "image", mediaId: "m2" }, body: ["B"] },
    ] })).toEqual([{ type: "carousel", cards: [
      { card_index: 0, components: [{ type: "header", parameters: [{ type: "image", image: { link: "https://x.example.com/1.jpg" } }] }, { type: "body", parameters: [{ type: "text", text: "A" }] }, { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: "A" }] }] },
      { card_index: 1, components: [{ type: "header", parameters: [{ type: "image", image: { id: "m2" } }] }, { type: "body", parameters: [{ type: "text", text: "B" }] }] },
    ] }]);
    expect(() => templateComponents(carousel, { carousel: [{ header: { type: "image", mediaId: "m" }, body: ["A"] }] })).toThrow(/carousel of 2 cards/);
    const lto = t([{ type: "LIMITED_TIME_OFFER", limited_time_offer: { text: "Fino a domenica", has_expiration: true } }, { type: "BODY", text: "Saldi" }], { category: "MARKETING" });
    expect(templateComponents(lto, { offerExpiresAt: "2026-11-30T23:00:00Z" })).toEqual([{ type: "limited_time_offer", parameters: [{ type: "limited_time_offer", limited_time_offer: { expiration_time_ms: Date.parse("2026-11-30T23:00:00Z") } }] }]);
  });

  it("sends a template with every component (header, named body, URL button), and refuses what does not fit its definition before calling Meta", async () => {
    const r = await rig();
    const res = await r.service.sendTemplate("shop", CUSTOMER, "shipping", [], {
      language: "it", sentBy: "operator", approval: "direct",
      components: { header: { type: "image", link: "https://x.example.com/box.jpg" }, body: { name: "Mario", order: "A12" }, buttons: [{ index: 0, text: "A12" }] },
    });
    expect(res.status).toBe("sent");
    expect(r.graph.sends().at(-1)!.body).toMatchObject({ type: "template", template: { name: "shipping", language: { code: "it" }, components: [
      { type: "header", parameters: [{ type: "image", image: { link: "https://x.example.com/box.jpg" } }] },
      { type: "body", parameters: [{ type: "text", text: "Mario", parameter_name: "name" }, { type: "text", text: "A12", parameter_name: "order" }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "A12" }] },
    ] } });
    const before = r.graph.sends().length;
    await expect(r.service.sendTemplate("shop", CUSTOMER, "shipping", [], { language: "it", sentBy: "operator", approval: "direct", components: { body: { name: "Mario", order: "A12" } } }))
      .rejects.toMatchObject({ code: "TEMPLATE" });
    expect(r.graph.sends().length).toBe(before);
  });

  it("queued templates keep their components through approval; marketing templates use the Marketing Messages API when enabled, never to someone who stopped marketing", async () => {
    const r = await rig({ config: { business: { allowedCategories: ["UTILITY", "MARKETING"], marketingMessagesApi: true, limits: { businessInitiatedPerDay: 5 } } } });
    const q = await r.service.sendTemplate("shop", CUSTOMER, "shipping", [], { language: "it", sentBy: "sales", approval: "queue", components: { header: { type: "image", mediaId: "m9" }, body: { name: "Mario", order: "A1" }, buttons: [{ index: 0, text: "A1" }] } });
    expect(q.status).toBe("pending_approval");
    expect(r.graph.sends()).toHaveLength(0);
    const ok = await r.service.approve("shop", (q as { id: string }).id, "alice");
    expect(r.graph.sends()[0]!.body.template.components[0]).toEqual({ type: "header", parameters: [{ type: "image", image: { id: "m9" } }] });
    expect((await r.store.getMessage(ok.sentAs))?.statuses.map((s) => s.status)).toContain("approved by alice");
    await r.service.sendTemplate("shop", CUSTOMER, "promo", [], { language: "it", sentBy: "operator", approval: "direct" });
    expect(r.graph.sends().at(-1)!.url).toMatch(/\/marketing_messages$/);
    await post(r, delivery({ userPreferences: [{ wa_id: CUSTOMER, detail: "User requested to stop marketing messages", category: "marketing_messages", value: "stop", timestamp: ts }] }));
    await expect(r.service.sendTemplate("shop", CUSTOMER, "promo", [], { language: "it", sentBy: "operator", approval: "direct" })).rejects.toMatchObject({ code: "OPTED_OUT" });
    // utility templates still go
    await r.service.sendTemplate("shop", CUSTOMER, "order_update", ["Mario", "A1"], { language: "it", sentBy: "operator", approval: "direct" });
    expect(r.events.some((e) => e.event === "channel:wabiz-event" && e.payload.kind === "marketing_preference" && e.payload.data.value === "stop")).toBe(true);
  });
});

// ── Rules on every send path ────────────────────────────────────────

describe("window, block, opt-out and caps on every send path", () => {
  it("every free-form type waits for the window; a blocked contact gets nothing; caps and opt-out stop templates", async () => {
    const r = await rig();
    const types: Parameters<WaBusinessService["sendMessage"]>[2][] = [
      { type: "media", kind: "image", link: "https://x.example.com/a.jpg" }, { type: "location", latitude: 1, longitude: 2 },
      { type: "buttons", body: "x", buttons: [{ id: "a", title: "A" }] }, { type: "flow", body: "x", cta: "y", flowId: "1" },
      { type: "product", productRetailerId: "S1" }, { type: "contacts", contacts: [{ name: "A", phones: [{ phone: "1" }] }] },
    ];
    for (const m of types) await expect(r.service.sendMessage("shop", CUSTOMER, m, { sentBy: "support" })).rejects.toMatchObject({ code: "OUTSIDE_WINDOW" });
    expect(r.graph.sends()).toHaveLength(0);
    await openWindow(r);
    for (const m of types) await r.service.sendMessage("shop", CUSTOMER, m, { sentBy: "support" });
    expect(r.graph.sends()).toHaveLength(types.length);
    // a reaction is kept on the message it reacts to
    await r.service.sendMessage("shop", CUSTOMER, { type: "reaction", messageId: "wamid.open", emoji: "❤️" }, { sentBy: "support" });
    expect((await r.store.getMessage("wamid.open"))?.reactions).toEqual([{ emoji: "❤️", by: "business", at: expect.any(String) }]);
    await expect(r.service.sendMessage("shop", CUSTOMER, { type: "reaction", messageId: "wamid.someone-else", emoji: "x" }, { sentBy: "support" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // the window closes after 24 hours
    r.now.t += 24 * 3_600_000 + 1;
    await expect(r.service.sendMessage("shop", CUSTOMER, types[0]!, { sentBy: "support" })).rejects.toMatchObject({ code: "OUTSIDE_WINDOW" });
    r.now.t = NOW;
    // block: no free-form, no templates
    const blocked = await r.service.block("shop", [`+${CUSTOMER}`], true, "alice");
    expect(blocked.done).toEqual([CUSTOMER]);
    expect(r.graph.calls.find((c) => c.url.endsWith("/block_users"))!.body).toEqual({ messaging_product: "whatsapp", block_users: [{ user: `+${CUSTOMER}` }] });
    await expect(r.service.sendMessage("shop", CUSTOMER, types[1]!, { sentBy: "support" })).rejects.toMatchObject({ code: "BLOCKED" });
    await expect(r.service.sendTemplate("shop", CUSTOMER, "order_update", ["a", "b"], { sentBy: "operator", approval: "direct" })).rejects.toMatchObject({ code: "BLOCKED" });
    await r.service.block("shop", [CUSTOMER], false, "alice");
    expect(r.graph.calls.filter((c) => c.url.endsWith("/block_users")).at(-1)!.method).toBe("DELETE");
    // opt-out stops templates
    await r.service.setOptIn("shop", CUSTOMER, false, "operator");
    await expect(r.service.sendTemplate("shop", CUSTOMER, "order_update", ["a", "b"], { sentBy: "operator", approval: "direct" })).rejects.toMatchObject({ code: "OPTED_OUT" });
  });

  it("the agent's tools answer in the chat the turn came from, and its reply buttons go out as interactive buttons or a list", async () => {
    const r = await rig();
    await openWindow(r);
    const tools = createWabizTools({ service: () => r.service, sender: "support", origin: { channel: "shop", chatId: `${PHONE_ID}:${CUSTOMER}` } }, ["wabiz_*"]);
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    const res = await by.wabiz_send_interactive!.execute("1", { kind: "buttons", body: "Confermi?", buttons: [{ id: "y", title: "Sì" }] });
    expect((res.content[0] as { text: string }).text).toMatch(/^Sent buttons to 39•••••••567/);
    expect(r.graph.sends().at(-1)!.body).toMatchObject({ to: CUSTOMER, type: "interactive", interactive: { type: "button" } });
    const file = await by.wabiz_send_media!.execute("2", { path: "report.pdf" });
    expect((file.content[0] as { text: string }).text).toMatch(/Error: Files cannot be read here/);
    const media = createWabizTools({ service: () => r.service, sender: "support", origin: { channel: "shop", chatId: `${PHONE_ID}:${CUSTOMER}` }, readFile: async () => ({ data: Buffer.from("%PDF-1.4"), filename: "report.pdf" }) }, ["wabiz_send_media"]);
    await media[0]!.execute("3", { path: "report.pdf" });
    expect(r.graph.sends().at(-1)!.body).toMatchObject({ type: "document", document: { id: "media.up1", filename: "report.pdf" } });

    await r.service.sendGatewayReply("shop", `${PHONE_ID}:${CUSTOMER}`, { text: "Quale giorno?", buttons: [[{ text: "Lunedì", data: "mon" }, { text: "Martedì", data: "tue" }]] });
    expect(r.graph.sends().at(-1)!.body.interactive).toMatchObject({ type: "button", action: { buttons: [{ reply: { id: "mon", title: "Lunedì" } }, { reply: { id: "tue", title: "Martedì" } }] } });
    const many = Array.from({ length: 5 }, (_, i) => ({ text: `Opzione ${i}`, data: `o${i}` }));
    await r.service.sendGatewayReply("shop", `${PHONE_ID}:${CUSTOMER}`, { text: "Scegli", buttons: [many] });
    expect(r.graph.sends().at(-1)!.body.interactive).toMatchObject({ type: "list", action: { sections: [{ rows: expect.arrayContaining([{ id: "o4", title: "Opzione 4" }]) }] } });
  });
});

// ── Reactions, edits, revokes, statuses, read and typing ────────────

describe("reactions, edits, revokes, statuses, read receipts", () => {
  it("the contact's reaction, edit and revoke change the message they refer to; statuses go into its history with pricing", async () => {
    const r = await rig();
    await post(r, delivery({ messages: [msg("wamid.T", "text", { text: { body: "ordine sbagliato" } })] }));
    const sent = await r.service.sendText("shop", CUSTOMER, "Ricevuto", { sentBy: "support" });
    await post(r, delivery({ messages: [
      msg("wamid.R", "reaction", { reaction: { message_id: sent[0], emoji: "👍" } }),
      msg("wamid.ED", "edit", { edit: { original_message_id: "wamid.T", message: { type: "text", text: { body: "ordine giusto" } } } }),
    ] }));
    expect((await r.store.getMessage(sent[0]!))?.reactions).toEqual([{ emoji: "👍", by: "contact", at: expect.any(String) }]);
    expect(await r.store.getMessage("wamid.T")).toMatchObject({ text: "ordine giusto", edited: expect.any(Object) });
    await post(r, delivery({ messages: [msg("wamid.RV", "revoke", { revoke: { original_message_id: "wamid.T" } })] }));
    const revoked = await r.store.getMessage("wamid.T");
    expect(revoked?.revoked).toBeTruthy();
    expect(revoked?.text).toBeUndefined();
    await post(r, delivery({ statuses: [
      { id: sent[0], status: "delivered", timestamp: ts, recipient_id: CUSTOMER, pricing: { billable: false, pricing_model: "PMP", category: "service", type: "free_customer_service" } },
      { id: sent[0], status: "read", timestamp: ts, recipient_id: CUSTOMER },
    ] }));
    const out = await r.store.getMessage(sent[0]!);
    expect(out).toMatchObject({ status: "read", pricing: { category: "service", billable: false, model: "PMP", type: "free_customer_service" } });
    expect(out?.statuses.map((s) => s.status)).toEqual(["accepted", "delivered", "read"]);
    await post(r, delivery({ statuses: [{ id: "wamid.zz", status: "failed", timestamp: ts, recipient_id: CUSTOMER, errors: [{ code: 131026, title: "Message undeliverable", error_data: { details: "not on WhatsApp" } }] }] }));
    expect(await r.store.getMessage("wamid.zz")).toMatchObject({ status: "failed", error: { code: 131026, title: "Message undeliverable", detail: "not on WhatsApp" } });
    expect(r.events.filter((e) => e.event === "channel:message-status").map((e) => e.payload.status)).toEqual(expect.arrayContaining(["edited", "revoked", "reaction 👍", "delivered", "read", "failed"]));
  });

  it("marks a contact's message read with the typing indicator; refuses messages that are not the contact's", async () => {
    const r = await rig({ config: { business: { markRead: false } } });
    await openWindow(r);
    await r.service.markRead("shop", "wamid.open", { typing: true });
    expect(r.graph.calls.at(-1)!.body).toEqual({ messaging_product: "whatsapp", status: "read", message_id: "wamid.open", typing_indicator: { type: "text" } });
    const out = await r.service.sendText("shop", CUSTOMER, "ok", { sentBy: "x" });
    await expect(r.service.markRead("shop", out[0]!)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("payments (India) arrive as a payment status: kept in the conversation, announced and handed to the agent", async () => {
    const r = await rig({ config: { business: { payments: { market: "IN", configurationName: "upi" } } } });
    const handle = vi.fn<WaBizGatewayHandle["handle"]>().mockResolvedValue(undefined);
    r.service.setGateway("shop", { handle });
    const payment = { id: "wamid.pay", type: "payment", status: "captured", timestamp: ts, recipient_id: CUSTOMER, payment: { reference_id: "ORD-1", amount: { value: 2000, offset: 100 }, currency: "INR", transaction: { id: "tx1", type: "upi", status: "success" } } };
    await post(r, delivery({ statuses: [payment] }));
    await post(r, delivery({ statuses: [payment] }));
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0]![0].text).toBe("[payment captured for order ORD-1: 20 INR]");
    expect(r.events.find((e) => e.event === "channel:wabiz-event" && e.payload.kind === "payment")?.payload.data).toMatchObject({ referenceId: "ORD-1", status: "captured", amount: 20, currency: "INR" });
  });
});

// ── Shared Meta app, account webhooks ───────────────────────────────

describe("one Meta app shared by several channels and instances", () => {
  it("a delivery for another number of this instance is handled as that channel's; one of another instance is forwarded unchanged with its signature", async () => {
    const r = await rig({ second: true });
    const h1 = vi.fn<WaBizGatewayHandle["handle"]>().mockResolvedValue(undefined);
    const h2 = vi.fn<WaBizGatewayHandle["handle"]>().mockResolvedValue(undefined);
    r.service.setGateway("shop", { handle: h1 });
    r.service.setGateway("shop2", { handle: h2 });
    const body = delivery({ phoneId: PHONE_2, messages: [msg("wamid.S2", "text", { text: { body: "per il secondo numero" } })] });
    const raw = Buffer.from(JSON.stringify(body));
    const sig = wabizSignature(APP_SECRET, raw);
    expect((await r.service.receive("shop", raw, sig)).status).toBe(200);
    await r.service.idle();
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledTimes(1);
    expect(r.service.events("shop").events[0]).toMatchObject({ outcome: "accepted", reason: expect.stringContaining(`${PHONE_2} → channel shop2 (200)`) });
    expect(r.service.events("shop2").events[0]).toMatchObject({ outcome: "accepted", action: expect.stringContaining("via shop") });

    const far = Buffer.from(JSON.stringify(delivery({ phoneId: PHONE_FAR, messages: [msg("wamid.F1", "text", { text: { body: "altra istanza" } })] })));
    const farSig = wabizSignature(APP_SECRET, far);
    expect((await r.service.receive("shop", far, farSig)).status).toBe(200);
    const fwd = r.graph.calls.find((c) => c.url.startsWith("https://other-instance.example.com/"))!;
    expect(fwd.url).toBe("https://other-instance.example.com/api/v1/channels/whatsapp-business/webhooks/far");
    expect(fwd.headers["x-hub-signature-256"]).toBe(farSig);
    expect(fwd.body).toEqual({ bytes: far.length });
    expect(fwd.headers.authorization).toBeUndefined();
    expect(r.service.events("shop").events[0]).toMatchObject({ reason: expect.stringContaining(`${PHONE_FAR} → other-instance.example.com`) });
  });

  it("points this number's deliveries at this instance (webhook override) with the verify token", async () => {
    const r = await rig();
    const res = await r.service.webhookOverride("shop", true);
    const call = r.graph.calls.find((c) => c.method === "POST" && c.url.endsWith(`/${PHONE_ID}`))!;
    expect(call.body).toEqual({ webhook_configuration: { override_callback_uri: "https://host.ts.net/acme/api/v1/channels/whatsapp-business/webhooks/shop", verify_token: "verify-token-abcdef" } });
    expect(res).toMatchObject({ callbackUrl: expect.stringContaining("/webhooks/shop"), current: { application: "https://app.example.com/hook" } });
  });

  it("validates shared routes: digits, https, never its own number", async () => {
    const { validateWaBusinessChannel } = await import("@polpo-ai/core");
    expect(validateWaBusinessChannel("shop", { ...channelConfig(PHONE_ID), business: { sharedApp: { routes: { [PHONE_ID]: "https://a.example.com/x", abc: "http://b.example.com" } } } }))
      .toEqual(expect.arrayContaining([expect.stringContaining("this channel's own number"), expect.stringContaining('"abc" is not a phone number id'), expect.stringContaining("(https)")]));
  });

  it("account-level webhooks (quality, name review, template status and category, capabilities) are kept, announced, and refresh the templates", async () => {
    const r = await rig();
    await post(r, delivery({ field: "phone_number_quality_update", value: { display_phone_number: "+39 02 1234", event: "DOWNGRADE", current_limit: "TIER_250" } }));
    await post(r, delivery({ field: "message_template_status_update", value: { event: "REJECTED", message_template_id: 1, message_template_name: "promo", message_template_language: "it", reason: "INCORRECT_CATEGORY" } }));
    await post(r, delivery({ field: "template_category_update", value: { message_template_id: 2, message_template_name: "order_update", previous_category: "UTILITY", new_category: "MARKETING" } }));
    const events = r.service.accountEvents("shop");
    expect(events.map((e) => e.summary)).toEqual([
      "template order_update: category UTILITY → MARKETING",
      "template promo (it): REJECTED (INCORRECT_CATEGORY)",
      "+39 02 1234: DOWNGRADE, limit TIER_250",
    ]);
    expect(r.events.filter((e) => e.event === "channel:wabiz-event" && e.payload.kind === "account")).toHaveLength(3);
    expect(r.graph.calls.some((c) => c.url.includes("/message_templates"))).toBe(true);
    expect((await r.service.status("shop")).lastAccountEvent).toMatchObject({ field: "template_category_update" });
  });
});

// ── Admin REST ──────────────────────────────────────────────────────

describe("admin REST (phase 2)", () => {
  const json = (body: unknown, method = "POST") => ({ method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  it("sends any type and a base64 file, reacts, marks read; refused rules are 400 with a code", async () => {
    const r = await rig();
    const app = waBusinessAdminRoutes({ service: () => r.service });
    const closed = await app.request("/shop/messages", json({ to: CUSTOMER, message: { type: "location_request", body: "Dove sei?" } }));
    expect(closed.status).toBe(400);
    expect((await closed.json()).code).toBe("OUTSIDE_WINDOW");
    await openWindow(r);
    const ok = await app.request("/shop/messages", json({ to: CUSTOMER, message: { type: "media", kind: "image", caption: "foto" }, file: { data: JPEG.toString("base64"), mimeType: "image/jpeg", filename: "a.jpg" } }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).data).toMatchObject({ status: "sent", ids: [expect.stringMatching(/^wamid\.out/)] });
    const bad = await app.request("/shop/messages", json({ to: CUSTOMER, message: { type: "buttons", body: "x", buttons: [{ id: "a", title: "far too long for a button title" }] } }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe("INVALID");
    expect((await app.request("/shop/react", json({ to: CUSTOMER, messageId: "wamid.open", emoji: "👍" }))).status).toBe(200);
    expect((await app.request("/shop/read", json({ messageId: "wamid.open", typing: true }))).status).toBe(200);
  });

  it("template management, profile, blocked users, the phone number and account events", async () => {
    const r = await rig();
    const app = waBusinessAdminRoutes({ service: () => r.service });
    const created = await app.request("/shop/templates", json({ name: "welcome_back", language: "it", category: "UTILITY", components: [{ type: "BODY", text: "Bentornato {{1}}", example: { body_text: [["Mario"]] } }] }));
    expect((await created.json()).data).toMatchObject({ id: "t9", status: "PENDING" });
    expect(r.graph.calls.find((c) => c.method === "POST" && c.url.includes("/message_templates"))!.body).toMatchObject({ name: "welcome_back", category: "UTILITY" });
    expect((await app.request("/shop/templates", json({ name: "Bad Name", language: "it", category: "UTILITY", components: [{ type: "BODY", text: "x" }] }))).status).toBe(400);
    expect((await app.request("/shop/templates/welcome_back?id=t9", { method: "DELETE" })).status).toBe(200);
    expect(r.graph.calls.find((c) => c.method === "DELETE")!.url).toContain("message_templates?name=welcome_back&hsm_id=t9");

    expect((await (await app.request("/shop/profile")).json()).data).toMatchObject({ about: "Siamo aperti", vertical: "RETAIL" });
    const prof = await app.request("/shop/profile", json({ about: "Aperti 9-18", websites: ["https://shop.example.com"] }, "PUT"));
    expect(prof.status).toBe(200);
    expect(r.graph.calls.find((c) => c.method === "POST" && c.url.includes("whatsapp_business_profile"))!.body).toEqual({ messaging_product: "whatsapp", about: "Aperti 9-18", websites: ["https://shop.example.com"] });
    expect((await app.request("/shop/profile", json({ about: "x".repeat(140) }, "PUT"))).status).toBe(400);

    expect((await (await app.request("/shop/block", json({ users: [CUSTOMER], block: true, by: "alice" }))).json()).data.done).toEqual([CUSTOMER]);
    expect((await app.request("/shop/phone", json({ action: "register", pin: "123456" }))).status).toBe(200);
    expect(r.graph.calls.find((c) => c.url.endsWith("/register"))!.body).toEqual({ messaging_product: "whatsapp", pin: "123456" });
    expect((await app.request("/shop/phone", json({ action: "register", pin: "12" }))).status).toBe(400);
    expect((await app.request("/shop/phone", json({ action: "subscribe_app" }))).status).toBe(200);
    expect((await (await app.request("/shop/account-events")).json()).data).toMatchObject({ events: [] });
  });
});

// ── MCP tools end to end, and the card ──────────────────────────────

describe("MCP: the whatsapp-business toolset end to end", () => {
  async function mcp(r: Rig) {
    const app = waBusinessAdminRoutes({ service: () => r.service });
    const api = async (method: string, path: string, body?: unknown): Promise<ApiResponse> => {
      const prefix = "/api/v1/whatsapp-business";
      if (!path.startsWith(prefix)) return { status: 404, body: { ok: false, error: "not here" }, headers: new Headers() };
      const res = await app.request(path.slice(prefix.length) || "/", { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const text = Buffer.from(bytes).toString("utf8");
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* binary */ }
      return { status: res.status, body: parsed, headers: res.headers, bytes };
    };
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createPolpoMcpServer } = await import("../server/mcp.js");
    const server = createPolpoMcpServer({ api, version: "1", toolsets: ["channels", "whatsapp-business"] });
    const client = new Client({ name: "e2e", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }
  const textOf = (res: any) => (res.content as Array<{ text: string }>).map((c) => c.text).join(" ");

  it("sends need confirm; media, interactive, flows and reactions go through the same rules; the card shows the conversation", async () => {
    const r = await rig();
    const client = await mcp(r);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["polpo_wabiz_send_media", "polpo_wabiz_send_interactive", "polpo_wabiz_send_flow", "polpo_wabiz_send_products",
      "polpo_wabiz_send_order", "polpo_wabiz_react", "polpo_wabiz_template_manage", "polpo_wabiz_profile", "polpo_wabiz_block", "polpo_wabiz_analytics", "polpo_wabiz_phone", "polpo_wabiz_show"]));
    const unconfirmed = await client.callTool({ name: "polpo_wabiz_send_interactive", arguments: { to: CUSTOMER, message: { type: "location_request", body: "Dove sei?" } } });
    expect(unconfirmed.isError).toBe(true);
    expect(textOf(unconfirmed)).toContain("confirm: true");
    const outside = await client.callTool({ name: "polpo_wabiz_send_interactive", arguments: { to: CUSTOMER, message: { type: "location_request", body: "Dove sei?" }, confirm: true } });
    expect(outside.isError).toBe(true);
    expect(textOf(outside)).toMatch(/24 hours|template/);
    await openWindow(r);
    const media = await client.callTool({ name: "polpo_wabiz_send_media", arguments: { to: CUSTOMER, kind: "image", file: { data: JPEG.toString("base64"), mime_type: "image/jpeg", filename: "a.jpg" }, caption: "foto", confirm: true } });
    expect(media.isError).toBeFalsy();
    const flow = await client.callTool({ name: "polpo_wabiz_send_flow", arguments: { to: CUSTOMER, flow_id: "77", body: "Prenota", cta: "Apri", flow_ref: "ord-1", confirm: true } });
    expect(flow.isError).toBeFalsy();
    expect(r.graph.sends().at(-1)!.body.interactive.action.parameters).toMatchObject({ flow_id: "77", flow_token: "ord-1" });
    const react = await client.callTool({ name: "polpo_wabiz_react", arguments: { to: CUSTOMER, message_id: "wamid.open", emoji: "👍", confirm: true } });
    expect(react.isError).toBeFalsy();
    const q = await r.service.sendTemplate("shop", CUSTOMER, "order_update", ["Mario", "A1"], { sentBy: "sales", approval: "queue" });

    const card = await client.callTool({ name: "polpo_wabiz_show", arguments: { to: CUSTOMER } });
    expect(card.isError).toBeFalsy();
    const sc = card.structuredContent as any;
    expect(sc).toMatchObject({ kind: "wabiz", channel: "shop", transcript: { waId: CUSTOMER, windowOpen: true } });
    const photo = sc.transcript.messages.find((m: any) => m.media?.kind === "image");
    expect(photo.media.thumb).toMatch(/^data:image\/jpeg;base64,/);
    expect(sc.transcript.messages.find((m: any) => m.flow)).toMatchObject({ flow: "Apri" });
    expect(sc.transcript.messages.find((m: any) => m.id === "wamid.open").reactions).toEqual(["👍"]);
    expect(sc.pending).toEqual([expect.objectContaining({ id: (q as { id: string }).id, template: "order_update" })]);
    // approve from the card's button (the same tool the widget calls)
    const approved = await client.callTool({ name: "polpo_wabiz_approval", arguments: { action: "approve", id: (q as { id: string }).id, confirm: true } });
    expect(approved.isError).toBeFalsy();
    expect(textOf(await client.callTool({ name: "polpo_wabiz_show", arguments: {} }))).toContain("waiting for approval 0");
  });
});

describe("the card's model (polpo_wabiz_show)", () => {
  it("draws interactive, template, media and reply messages, and a text for clients without MCP Apps", () => {
    const at = "2026-11-24T10:00:00Z";
    const messages = [
      { id: "1", direction: "in" as const, type: "image", status: "received", createdAt: at, waId: CUSTOMER, text: "scontrino", media: { kind: "image", caption: "scontrino", stored: "a.jpg" } },
      { id: "2", direction: "out" as const, type: "buttons", status: "read", createdAt: at, waId: CUSTOMER, text: "Confermi?", content: { type: "buttons", body: "Confermi?", buttons: [{ id: "y", title: "Sì" }] } },
      { id: "3", direction: "in" as const, type: "interactive.button_reply", status: "received", createdAt: at, waId: CUSTOMER, content: { reply: "button", id: "y", title: "Sì" } },
      { id: "4", direction: "out" as const, type: "template", status: "pending_approval", createdAt: at, waId: CUSTOMER, text: "Ciao Mario", template: { name: "order_update", language: "it" } },
      { id: "5", direction: "in" as const, type: "voice", status: "received", createdAt: at, waId: CUSTOMER, media: { kind: "audio", voice: true, skipped: "Too large" } },
      { id: "6", direction: "in" as const, type: "text", status: "received", createdAt: at, waId: CUSTOMER, text: "segreto", revoked: { at } },
    ];
    expect(cardMessage(messages[1]!)).toMatchObject({ text: "Confermi?", buttons: ["Sì"], status: "read" });
    expect(cardMessage(messages[2]!)).toMatchObject({ reply: "Sì" });
    expect(cardMessage(messages[5]!).text).toBeUndefined();
    const card = buildWabizCard({
      channel: "shop", channels: ["shop"], status: { state: "receiving", audience: "customers", sentToday: 1, limits: { businessInitiatedPerDay: 50 }, pendingApprovals: 1, missing: [] },
      contacts: [], lastMessages: {}, thumbs: { "1": "data:image/jpeg;base64,AA==" },
      conversation: { contact: { waId: CUSTOMER, masked: "39•••••••567", name: "Mario" }, window: { open: true, closesAt: at }, optedOut: false, messages: [...messages].reverse() },
      pending: [], key: { createdAt: 1, seq: 1 },
    });
    expect(card.transcript!.messages.map((m) => m.id)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(card.transcript!.messages[0]!.media!.thumb).toBe("data:image/jpeg;base64,AA==");
    const text = wabizCardText(card);
    expect(text).toContain("[image] scontrino");
    expect(text).toContain("Confermi? [Sì] ✓✓ read");
    expect(text).toContain("[template order_update (it)] Ciao Mario waiting for approval");
    expect(text).toContain("[voice]");
    expect(text).toContain("(deleted)");
    expect(text).not.toContain("segreto");
  });
});

