/**
 * WhatsApp Business (Meta Cloud API) channels (see notifications/whatsapp-business-service.ts).
 *
 * Public (no dashboard auth; Meta's verify token and signature are the authentication), mounted
 * before the global rate limit with a limit of its own per channel:
 *   GET  /api/v1/channels/whatsapp-business/webhooks/:name   Meta's subscription check (hub.challenge as text/plain)
 *   POST /api/v1/channels/whatsapp-business/webhooks/:name   a delivery (X-Hub-Signature-256 over the raw body, 1 MB at most)
 *
 * Authenticated (/api/v1/whatsapp-business):
 *   GET    /                               every WhatsApp Business channel's status
 *   GET    /:name/status                   one channel: configured / receiving, secrets set (never their values), callback URL,
 *                                          the Funnel command, counts, quality rating and tier (after a test)
 *   PUT    /:name/secrets                  { accessToken?, appSecret?, verifyToken? } into the vault ($channels; the dashboard only)
 *   DELETE /:name/secrets/:kind            remove one
 *   POST   /:name/verify-token             generate a verify token: returned once, to paste in Meta's dashboard
 *   GET    /:name/events[/:id]             the webhook event log (no message text, contacts masked)
 *   GET    /:name/contacts                 contacts with their window and opt-in / opt-out
 *   GET    /:name/contacts/:waId           the conversation: messages, window, opt-out
 *   PUT    /:name/contacts/:waId/opt-in    { optIn: boolean, source? }
 *   DELETE /:name/contacts/:waId           erase the contact and its messages
 *   POST   /:name/send                     { to, text } free-form, inside the 24-hour window only
 *   POST   /:name/send-template            { to, template, language?, params[], queue? } business-initiated
 *   GET    /:name/templates                ?refresh=true syncs from Meta
 *   POST   /:name/templates/sync
 *   GET    /:name/pending                  sends waiting for approval
 *   POST   /:name/pending/:id/approve      { by? }  /  POST /:name/pending/:id/reject { by?, reason? }
 *   POST   /:name/test                     the phone number at Meta (token, quality rating, tier)
 */
import { Hono } from "hono";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { WABIZ_SECRET_KINDS, type WaBizOutbound, type WaBizSecretKind, type WaBizTemplateInput } from "@polpo-ai/core/whatsapp-business";
import type { WaTemplateDefinition } from "../../notifications/channels/whatsapp-business.js";
import { WEBHOOK_EVENT_OUTCOMES, type WebhookEventOutcome } from "../../core/webhook-event-log.js";
import {
  WABIZ_EVENTS_MAX, WABIZ_WEBHOOK_MAX_BODY_BYTES, WaBizPolicyError, type WaBusinessService,
} from "../../notifications/whatsapp-business-service.js";

export interface WaBusinessRouteDeps {
  service: () => WaBusinessService | undefined;
}

export function waBusinessWebhookRoutes(deps: WaBusinessRouteDeps): Hono {
  const app = new Hono();
  app.get("/:name", async (c) => {
    const s = deps.service();
    if (!s) return c.text("Not ready", 503);
    const r = await s.verifyChallenge(c.req.param("name"), {
      mode: c.req.query("hub.mode"), token: c.req.query("hub.verify_token"), challenge: c.req.query("hub.challenge"),
    });
    return c.text(r.text, r.status, { "Content-Type": "text/plain; charset=utf-8" });
  });
  app.post("/:name", async (c) => {
    const s = deps.service();
    if (!s) return c.json({ ok: false, error: "Polpo is not initialized" }, 503);
    const name = c.req.param("name");
    const length = Number(c.req.header("content-length") ?? "0");
    if (length > WABIZ_WEBHOOK_MAX_BODY_BYTES) {
      const r = s.refuseTooLarge(name, length);
      return c.json(r.body, r.status);
    }
    // the signature is over the raw bytes: never re-serialize the JSON
    const raw = Buffer.from(await c.req.arrayBuffer());
    const r = await s.receive(name, raw, c.req.header("x-hub-signature-256"));
    return c.json(r.body, r.status);
  });
  return app;
}

// ── Admin ─────────────────────────────────────────────────────────────

const nameParam = z.string().openapi({ param: { name: "name", in: "path" }, example: "whatsapp-shop", description: "The channel's name (settings.notifications.channels)" });
const anyData = z.object({ ok: z.literal(true), data: z.any() });
const errorSchema = z.object({ ok: z.literal(false), error: z.string(), code: z.string().optional() });
const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const errors = {
  400: json(errorSchema, "Refused (a rule: window, opt-out, cap, template, or a bad request)"),
  404: json(errorSchema, "No such channel, contact or pending send"),
  502: json(errorSchema, "Meta refused the request"),
};

type Status = 400 | 404 | 502;

/** A refused rule is 400 (NOT_FOUND 404), Meta's refusal 502. */
function failure(err: unknown): { body: z.infer<typeof errorSchema>; status: Status } {
  if (err instanceof WaBizPolicyError) return { body: { ok: false, error: err.message, code: err.code }, status: err.code === "NOT_FOUND" ? 404 : 400 };
  const e = err as Error & { name?: string };
  if (e?.name === "WaGraphError") return { body: { ok: false, error: e.message, code: "PROVIDER_ERROR" }, status: 502 };
  return { body: { ok: false, error: e?.message ?? String(err), code: "VALIDATION_ERROR" }, status: 400 };
}

// ── Message shapes (whatsapp-business-messages.ts checks Meta's limits) ──

const mediaKind = z.enum(["image", "audio", "video", "document", "sticker"]);
const headerSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string().min(1).max(60) }),
  z.object({ type: z.enum(["image", "video", "document"]), link: z.string().url().optional(), mediaId: z.string().optional(), filename: z.string().optional() }),
]);
const replyTo = { replyTo: z.string().optional().openapi({ description: "Quote this message (its wamid)" }) };
const orderItem = z.object({ retailerId: z.string().optional(), name: z.string().min(1), amount: z.number().min(0), quantity: z.number().int().min(1), saleAmount: z.number().min(0).optional() });

/** Every free-form message type (inside the 24-hour window). */
export const WaBizOutboundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().min(1).max(20_000), previewUrl: z.boolean().optional(), ...replyTo }),
  z.object({ type: z.literal("media"), kind: mediaKind, link: z.string().url().optional(), mediaId: z.string().optional(), caption: z.string().max(1024).optional(), filename: z.string().max(240).optional(), ...replyTo }),
  z.object({ type: z.literal("location"), latitude: z.number(), longitude: z.number(), name: z.string().optional(), address: z.string().optional(), ...replyTo }),
  z.object({ type: z.literal("contacts"), contacts: z.array(z.object({
    name: z.string().min(1), firstName: z.string().optional(), lastName: z.string().optional(),
    phones: z.array(z.object({ phone: z.string(), type: z.string().optional(), waId: z.string().optional() })).optional(),
    emails: z.array(z.object({ email: z.string(), type: z.string().optional() })).optional(), company: z.string().optional(), title: z.string().optional(),
    urls: z.array(z.object({ url: z.string(), type: z.string().optional() })).optional(),
  })).min(1), ...replyTo }),
  z.object({ type: z.literal("reaction"), messageId: z.string().min(1), emoji: z.string() }),
  z.object({ type: z.literal("buttons"), body: z.string(), header: headerSchema.optional(), footer: z.string().optional(), buttons: z.array(z.object({ id: z.string(), title: z.string() })).min(1).max(3), ...replyTo }),
  z.object({ type: z.literal("list"), body: z.string(), header: z.string().optional(), footer: z.string().optional(), button: z.string(), sections: z.array(z.object({ title: z.string().optional(), rows: z.array(z.object({ id: z.string(), title: z.string(), description: z.string().optional() })) })).min(1).max(10), ...replyTo }),
  z.object({ type: z.literal("cta_url"), body: z.string(), header: headerSchema.optional(), footer: z.string().optional(), displayText: z.string(), url: z.string().url(), ...replyTo }),
  z.object({ type: z.literal("location_request"), body: z.string(), ...replyTo }),
  z.object({
    type: z.literal("flow"), body: z.string(), header: headerSchema.optional(), footer: z.string().optional(), flowId: z.string().optional(), flowName: z.string().optional(), cta: z.string(),
    flowToken: z.string().optional(), mode: z.enum(["published", "draft"]).optional(), action: z.enum(["navigate", "data_exchange"]).optional(), screen: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(), ...replyTo,
  }),
  z.object({ type: z.literal("product"), catalogId: z.string().optional(), productRetailerId: z.string(), body: z.string().optional(), footer: z.string().optional(), ...replyTo }),
  z.object({ type: z.literal("product_list"), catalogId: z.string().optional(), header: z.string(), body: z.string(), footer: z.string().optional(), sections: z.array(z.object({ title: z.string(), productRetailerIds: z.array(z.string()).min(1) })).min(1).max(10), ...replyTo }),
  z.object({ type: z.literal("catalog"), body: z.string(), footer: z.string().optional(), thumbnailProductRetailerId: z.string().optional(), ...replyTo }),
  z.object({ type: z.literal("voice_call"), body: z.string(), displayText: z.string().optional(), ttlMinutes: z.number().int().optional(), payload: z.string().optional(), ...replyTo }),
  z.object({ type: z.literal("call_permission_request"), body: z.string().optional(), ...replyTo }),
  z.object({ type: z.literal("address"), body: z.string(), country: z.literal("IN"), values: z.record(z.string(), z.string()).optional(), savedAddresses: z.array(z.record(z.string(), z.unknown())).optional(), validationErrors: z.record(z.string(), z.string()).optional(), ...replyTo }),
  z.object({
    type: z.literal("order_details"), body: z.string(), header: headerSchema.optional(), footer: z.string().optional(), referenceId: z.string(),
    goods: z.enum(["digital-goods", "physical-goods"]).optional(), items: z.array(orderItem).min(1), tax: z.number().optional(), shipping: z.number().optional(), discount: z.number().optional(),
    catalogId: z.string().optional(), expiresAt: z.string().optional(), expirationText: z.string().optional(), paymentSettings: z.array(z.record(z.string(), z.unknown())).optional(), ...replyTo,
  }),
  z.object({
    type: z.literal("order_status"), body: z.string(), referenceId: z.string(), status: z.enum(["pending", "processing", "partially-shipped", "shipped", "completed", "canceled"]),
    description: z.string().optional(), payment: z.object({ status: z.string(), timestamp: z.number().optional() }).optional(), ...replyTo,
  }),
]).openapi("WaBizOutbound");

const templateButtonInput = z.object({
  index: z.number().int().min(0), payload: z.string().optional(), text: z.string().optional(), couponCode: z.string().optional(), flowToken: z.string().optional(),
  flowActionData: z.record(z.string(), z.unknown()).optional(), action: z.record(z.string(), z.unknown()).optional(),
});
/** Every component of a template: header, body (positional or named), buttons, carousel cards, OTP. */
export const WaBizTemplateInputSchema = z.object({
  header: z.union([
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.enum(["image", "video", "document"]), link: z.string().url().optional(), mediaId: z.string().optional(), filename: z.string().optional() }),
    z.object({ type: z.literal("location"), latitude: z.number(), longitude: z.number(), name: z.string().optional(), address: z.string().optional() }),
  ]).optional(),
  body: z.union([z.array(z.string()), z.record(z.string(), z.string())]).optional(),
  buttons: z.array(templateButtonInput).optional(),
  offerExpiresAt: z.string().optional(),
  carousel: z.array(z.object({
    header: z.object({ type: z.enum(["image", "video"]), link: z.string().url().optional(), mediaId: z.string().optional() }).optional(),
    body: z.union([z.array(z.string()), z.record(z.string(), z.string())]).optional(),
    buttons: z.array(z.object({ index: z.number().int().min(0), payload: z.string().optional(), text: z.string().optional() })).optional(),
  })).max(10).optional(),
  otp: z.string().max(15).optional(),
}).openapi("WaBizTemplateInput");

const fileSchema = z.object({
  data: z.string().min(1).openapi({ description: "The file, base64 (at most 20 MB; larger documents go by link)" }),
  mimeType: z.string().min(1), filename: z.string().min(1).max(240),
});
const decodeFile = (f: z.infer<typeof fileSchema> | undefined) => {
  if (!f) return undefined;
  const data = Buffer.from(f.data, "base64");
  if (data.length > 20 * 1024 * 1024) throw new WaBizPolicyError("The file is over 20 MB: send larger documents by link", "INVALID");
  return { data, mimeType: f.mimeType, filename: f.filename };
};

export function waBusinessAdminRoutes(deps: WaBusinessRouteDeps): OpenAPIHono {
  const app = new OpenAPIHono();
  const need = () => {
    const s = deps.service();
    if (!s) throw new Error("Polpo is not initialized");
    return s;
  };
  const tags = ["WhatsApp Business"];
  const run = async (c: any, fn: (s: WaBusinessService) => Promise<unknown>) => {
    try {
      return c.json({ ok: true as const, data: await fn(need()) }, 200);
    } catch (err) {
      const f = failure(err);
      return c.json(f.body, f.status);
    }
  };

  app.openapi(createRoute({
    method: "get", path: "/", tags, summary: "Every WhatsApp Business channel's status",
    description: "Per channel: configured / receiving, which secrets are set (never their values), the callback URL Meta must call, the Tailscale Funnel command, event counts, pending approvals, business-initiated messages sent today.",
    responses: { 200: json(anyData, "Statuses") },
  }), async (c) => run(c, async (s) => ({ channels: await Promise.all(s.channelNames().map((n) => s.status(n))) })));

  app.openapi(createRoute({
    method: "get", path: "/{name}/status", tags, summary: "A WhatsApp Business channel's status",
    request: { params: z.object({ name: nameParam }) },
    responses: { 200: json(anyData, "Status"), ...errors },
  }), async (c) => run(c, (s) => s.status(c.req.valid("param").name)));

  app.openapi(createRoute({
    method: "put", path: "/{name}/secrets", tags, summary: "Set the channel's secrets (dashboard)",
    description: "Access token (system user, whatsapp_business_messaging + whatsapp_business_management), app secret (webhook signatures), verify token. "
      + "They go to the vault (owner $channels) and are never returned. Only the fields given change.",
    request: {
      params: z.object({ name: nameParam }),
      body: { content: { "application/json": { schema: z.object({ accessToken: z.string().optional(), appSecret: z.string().optional(), verifyToken: z.string().optional() }) } } },
    },
    responses: { 200: json(anyData, "Which secrets are set"), ...errors },
  }), async (c) => run(c, async (s) => {
    const { name } = c.req.valid("param");
    const body = c.req.valid("json");
    for (const kind of WABIZ_SECRET_KINDS) {
      const v = body[kind];
      if (typeof v === "string" && v.trim()) await s.setSecret(name, kind, v);
    }
    return { secrets: await s.secretsSet(name) };
  }));

  app.openapi(createRoute({
    method: "delete", path: "/{name}/secrets/{kind}", tags, summary: "Remove one of the channel's secrets",
    request: { params: z.object({ name: nameParam, kind: z.enum(["accessToken", "appSecret", "verifyToken"]).openapi({ param: { name: "kind", in: "path" } }) }) },
    responses: { 200: json(anyData, "Which secrets are set"), ...errors },
  }), async (c) => run(c, async (s) => {
    const { name, kind } = c.req.valid("param");
    await s.setSecret(name, kind as WaBizSecretKind, null);
    return { secrets: await s.secretsSet(name) };
  }));

  app.openapi(createRoute({
    method: "post", path: "/{name}/verify-token", tags, summary: "Generate the webhook verify token",
    description: "A fresh random token, stored in the vault and returned this once: paste it in Meta's dashboard (WhatsApp → Configuration → Webhook) with the callback URL.",
    request: { params: z.object({ name: nameParam }) },
    responses: { 200: json(z.object({ ok: z.literal(true), data: z.object({ verifyToken: z.string() }) }), "The token (shown once)"), ...errors },
  }), async (c) => run(c, async (s) => ({ verifyToken: await s.generateVerifyToken(c.req.valid("param").name) })));

  app.openapi(createRoute({
    method: "get", path: "/{name}/events", tags, summary: "The channel's webhook event log",
    description: `Every delivery from Meta (the last ${WABIZ_EVENTS_MAX}), newest first: accepted, ignored (another phone number, nothing to do), rejected (signature, size, rate, not configured) or error. No message text: types, lengths and masked contacts only.`,
    request: {
      params: z.object({ name: nameParam }),
      query: z.object({ limit: z.coerce.number().int().min(1).max(WABIZ_EVENTS_MAX).optional(), cursor: z.string().optional(), outcome: z.string().optional() }),
    },
    responses: { 200: json(anyData, "Events"), ...errors },
  }), async (c) => run(c, async (s) => {
    const { name } = c.req.valid("param");
    const { limit, cursor, outcome } = c.req.valid("query");
    const outcomes = (outcome ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const bad = outcomes.find((o) => !WEBHOOK_EVENT_OUTCOMES.includes(o as WebhookEventOutcome));
    if (bad) throw new Error(`Unknown outcome "${bad}" (accepted, ignored, rejected, error)`);
    return { channel: name, ...s.events(name, { ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}), outcomes: outcomes as WebhookEventOutcome[] }) };
  }));

  app.openapi(createRoute({
    method: "get", path: "/{name}/events/{id}", tags, summary: "One webhook delivery",
    request: { params: z.object({ name: nameParam, id: z.string().openapi({ param: { name: "id", in: "path" } }) }) },
    responses: { 200: json(anyData, "The delivery"), ...errors },
  }), async (c) => run(c, async (s) => {
    const { name, id } = c.req.valid("param");
    const ev = s.event(name, id);
    if (!ev) throw new WaBizPolicyError(`No delivery "${id}" (only the last ${WABIZ_EVENTS_MAX} are kept)`, "NOT_FOUND");
    return ev;
  }));

  app.openapi(createRoute({
    method: "get", path: "/{name}/contacts", tags, summary: "Contacts",
    description: "Contacts newest first, each with its 24-hour window (open, when it closes), opt-in and opt-out.",
    request: { params: z.object({ name: nameParam }), query: z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }) },
    responses: { 200: json(anyData, "Contacts"), ...errors },
  }), async (c) => run(c, async (s) => ({ contacts: await s.contacts(c.req.valid("param").name, c.req.valid("query").limit ?? 100) })));

  app.openapi(createRoute({
    method: "get", path: "/{name}/contacts/{waId}", tags, summary: "A contact's conversation",
    description: "The messages (newest first, within the retention), the window and whether the contact opted out.",
    request: { params: z.object({ name: nameParam, waId: z.string().openapi({ param: { name: "waId", in: "path" } }) }), query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }) },
    responses: { 200: json(anyData, "Conversation"), ...errors },
  }), async (c) => run(c, (s) => s.conversation(c.req.valid("param").name, c.req.valid("param").waId, c.req.valid("query").limit ?? 50)));

  app.openapi(createRoute({
    method: "put", path: "/{name}/contacts/{waId}/opt-in", tags, summary: "Record a contact's opt-in (or opt-out)",
    request: {
      params: z.object({ name: nameParam, waId: z.string().openapi({ param: { name: "waId", in: "path" } }) }),
      body: { content: { "application/json": { schema: z.object({ optIn: z.boolean(), source: z.string().max(200).optional() }) } } },
    },
    responses: { 200: json(anyData, "The contact"), ...errors },
  }), async (c) => run(c, async (s) => {
    const { name, waId } = c.req.valid("param");
    const b = c.req.valid("json");
    return s.setOptIn(name, waId, b.optIn, b.source ?? (b.optIn ? "operator" : "operator opt-out"));
  }));

  app.openapi(createRoute({
    method: "delete", path: "/{name}/contacts/{waId}", tags, summary: "Erase a contact and its messages (GDPR)",
    request: { params: z.object({ name: nameParam, waId: z.string().openapi({ param: { name: "waId", in: "path" } }) }) },
    responses: { 200: json(anyData, "Erased"), ...errors },
  }), async (c) => run(c, async (s) => {
    const { name, waId } = c.req.valid("param");
    if (!(await s.deleteContact(name, waId))) throw new WaBizPolicyError(`No contact ${waId}`, "NOT_FOUND");
    return { deleted: true };
  }));

  app.openapi(createRoute({
    method: "post", path: "/{name}/send", tags, summary: "Send a free-form message (inside the 24-hour window)",
    request: {
      params: z.object({ name: nameParam }),
      body: { content: { "application/json": { schema: z.object({ to: z.string().min(1), text: z.string().min(1).max(20_000), by: z.string().max(80).optional(), replyTo: z.string().optional() }) } } },
    },
    responses: { 200: json(anyData, "Sent: the message ids"), ...errors },
  }), async (c) => run(c, async (s) => {
    const { name } = c.req.valid("param");
    const b = c.req.valid("json");
    return { status: "sent", ids: await s.sendText(name, b.to, b.text, { sentBy: b.by ?? "operator", ...(b.replyTo ? { replyTo: b.replyTo } : {}) }) };
  }));

  app.openapi(createRoute({
    method: "post", path: "/{name}/messages", tags, summary: "Send any message type (inside the 24-hour window)",
    description: "Text, media (image, audio, video, document, sticker: by Meta media id, public link, or a base64 file uploaded first), location, contact cards, "
      + "a reaction, reply buttons, a list, a CTA URL button, a location request, a flow, a product / product list / the catalog, a call button, a call "
      + "permission request, an address request (India), order details with payment (India, Brazil: business.payments) and order status. "
      + "Checked against Meta's limits (characters, counts, media types and sizes), the window and the block list.",
    request: {
      params: z.object({ name: nameParam }),
      body: { content: { "application/json": { schema: z.object({ to: z.string().min(1), message: WaBizOutboundSchema, file: fileSchema.optional(), by: z.string().max(80).optional() }) } } },
    },
    responses: { 200: json(anyData, "Sent: the message id"), ...errors },
  }), async (c) => run(c, async (s) => {
    const { name } = c.req.valid("param");
    const b = c.req.valid("json");
    const file = decodeFile(b.file);
    return s.sendMessage(name, b.to, b.message as WaBizOutbound, { sentBy: b.by ?? "operator", ...(file ? { file } : {}) });
  }));

  app.openapi(createRoute({
    method: "post", path: "/{name}/react", tags, summary: "React to a message (an empty emoji removes the reaction)",
    request: {
      params: z.object({ name: nameParam }),
      body: { content: { "application/json": { schema: z.object({ to: z.string().min(1), messageId: z.string().min(1), emoji: z.string().max(16), by: z.string().max(80).optional() }) } } },
    },
    responses: { 200: json(anyData, "Sent"), ...errors },
  }), async (c) => run(c, async (s) => {
    const { name } = c.req.valid("param");
    const b = c.req.valid("json");
    return s.sendMessage(name, b.to, { type: "reaction", messageId: b.messageId, emoji: b.emoji }, { sentBy: b.by ?? "operator" });
  }));

  app.openapi(createRoute({
    method: "post", path: "/{name}/read", tags, summary: "Mark a contact's message read (and show typing)",
    request: {
      params: z.object({ name: nameParam }),
      body: { content: { "application/json": { schema: z.object({ messageId: z.string().min(1), typing: z.boolean().optional() }) } } },
    },
    responses: { 200: json(anyData, "Marked"), ...errors },
  }), async (c) => run(c, async (s) => {
    const { name } = c.req.valid("param");
    const b = c.req.valid("json");
    await s.markRead(name, b.messageId, { ...(b.typing ? { typing: true } : {}) });
    return { read: b.messageId };
  }));

  app.openapi(createRoute({
    method: "get", path: "/{name}/media/{messageId}", tags, summary: "A message's file (inbound downloads, outbound sends)",
    description: "The bytes of the media kept with a message (image, audio, voice note, video, document, sticker), with its type. Kept for the retention.",
    request: { params: z.object({ name: nameParam, messageId: z.string().openapi({ param: { name: "messageId", in: "path" } }) }) },
    responses: { 200: { description: "The file", content: { "application/octet-stream": { schema: z.any() } } }, ...errors },
  }), (async (c: any) => {
    try {
      const { name, messageId } = c.req.valid("param");
      const f = await need().mediaFile(name, messageId);
      return new Response(new Uint8Array(f.data), { status: 200, headers: {
        "Content-Type": f.mimeType, "Content-Length": String(f.data.length), "Cache-Control": "private, max-age=3600",
        "Content-Disposition": `inline; filename="${f.filename.replace(/[^\w.-]/g, "_")}"`, "X-Content-Type-Options": "nosniff",
      } });
    } catch (err) {
      const f = failure(err);
      return c.json(f.body, f.status);
    }
  }) as any);

  app.openapi(createRoute({
    method: "post", path: "/{name}/send-template", tags, summary: "Send an approved template (business-initiated)",
    description: "Checked: the contact did not opt out, the template is APPROVED with these body parameters, its category is allowed, the daily caps. "
      + "queue: true (agents, Polpo) waits for an operator's approval when business.approveTemplates is on; otherwise it is sent now.",
    request: {
      params: z.object({ name: nameParam }),
      body: { content: { "application/json": { schema: z.object({
        to: z.string().min(1), template: z.string().min(1), language: z.string().optional(), params: z.array(z.string()).max(30).optional(),
        queue: z.boolean().optional(), by: z.string().max(80).optional(), reason: z.string().max(500).optional(),
        components: WaBizTemplateInputSchema.optional(),
      }) } } },
    },
    responses: { 200: json(anyData, "sent (ids) or pending_approval (id)"), ...errors },
  }), async (c) => run(c, async (s) => {
    const { name } = c.req.valid("param");
    const b = c.req.valid("json");
    return s.sendTemplate(name, b.to, b.template, b.params ?? [], {
      ...(b.language ? { language: b.language } : {}), sentBy: b.by ?? (b.queue ? "polpo" : "operator"),
      approval: b.queue ? "queue" : "direct", ...(b.reason ? { reason: b.reason } : {}),
      ...(b.components ? { components: b.components as WaBizTemplateInput } : {}),
    });
  }));

  const componentArray = z.array(z.record(z.string(), z.unknown())).min(1).openapi({ description: "Meta's template components (HEADER, BODY, FOOTER, BUTTONS, CAROUSEL…) with their examples" });
  const categoryEnum = z.enum(["UTILITY", "MARKETING", "AUTHENTICATION"]);

  app.openapi(createRoute({
    method: "post", path: "/{name}/templates", tags, summary: "Create a template (it goes to Meta's review)",
    description: "Meta's definition: name (lowercase, digits, underscores), language, category (UTILITY, MARKETING, AUTHENTICATION), components, parameterFormat. "
      + "Its status comes back through the message_template_status_update webhook and a sync.",
    request: {
      params: z.object({ name: nameParam }),
      body: { content: { "application/json": { schema: z.object({
        name: z.string().min(1).max(512), language: z.string().min(2), category: categoryEnum,
        components: componentArray, parameterFormat: z.enum(["POSITIONAL", "NAMED"]).optional(), allowCategoryChange: z.boolean().optional(),
      }) } } },
    },
    responses: { 200: json(anyData, "Created: id, status, category"), ...errors },
  }), async (c) => run(c, (s) => s.createTemplate(c.req.valid("param").name, c.req.valid("json") as WaTemplateDefinition)));

  app.openapi(createRoute({
    method: "patch", path: "/{name}/templates/{id}", tags, summary: "Edit a template (it goes back to review)",
    request: {
      params: z.object({ name: nameParam, id: z.string().openapi({ param: { name: "id", in: "path" } }) }),
      body: { content: { "application/json": { schema: z.object({ components: componentArray.optional(), category: categoryEnum.optional() }) } } },
    },
    responses: { 200: json(anyData, "Edited"), ...errors },
  }), async (c) => run(c, async (s) => {
    const { name, id } = c.req.valid("param");
    await s.editTemplate(name, id, c.req.valid("json"));
    return { id, edited: true };
  }));

  app.openapi(createRoute({
    method: "delete", path: "/{name}/templates/{template}", tags, summary: "Delete a template (every language, or one by id)",
    request: {
      params: z.object({ name: nameParam, template: z.string().openapi({ param: { name: "template", in: "path" } }) }),
      query: z.object({ id: z.string().optional() }),
    },
    responses: { 200: json(anyData, "Deleted"), ...errors },
  }), async (c) => run(c, async (s) => {
    const { name, template } = c.req.valid("param");
    const { id } = c.req.valid("query");
    await s.deleteTemplate(name, template, id);
    return { template, deleted: true };
  }));

  app.openapi(createRoute({
    method: "get", path: "/{name}/profile", tags, summary: "The business profile (about, address, description, email, websites, vertical, photo)",
    request: { params: z.object({ name: nameParam }) },
    responses: { 200: json(anyData, "The profile"), ...errors },
  }), async (c) => run(c, (s) => s.profile(c.req.valid("param").name)));

  app.openapi(createRoute({
    method: "put", path: "/{name}/profile", tags, summary: "Update the business profile (and its photo)",
    description: "about ≤ 139, description ≤ 512, address ≤ 256, email ≤ 128, up to 2 websites, vertical. The photo (JPEG or PNG ≤ 5 MB) needs business.appId (Resumable Upload).",
    request: {
      params: z.object({ name: nameParam }),
      body: { content: { "application/json": { schema: z.object({
        about: z.string().optional(), address: z.string().optional(), description: z.string().optional(), email: z.string().optional(),
        websites: z.array(z.string()).max(2).optional(), vertical: z.string().optional(), photo: fileSchema.optional(),
      }) } } },
    },
    responses: { 200: json(anyData, "The profile"), ...errors },
  }), async (c) => run(c, async (s) => {
    const { photo, ...p } = c.req.valid("json");
    return s.updateProfile(c.req.valid("param").name, p, decodeFile(photo));
  }));

  app.openapi(createRoute({
    method: "post", path: "/{name}/block", tags, summary: "Block or unblock contacts",
    description: "Meta blocks only people who wrote in the last 24 hours; a blocked contact cannot write to the number and nothing is sent to them.",
    request: {
      params: z.object({ name: nameParam }),
      body: { content: { "application/json": { schema: z.object({ users: z.array(z.string().min(1)).min(1).max(1000), block: z.boolean(), by: z.string().max(80).optional() }) } } },
    },
    responses: { 200: json(anyData, "Done and failed"), ...errors },
  }), async (c) => run(c, async (s) => {
    const b = c.req.valid("json");
    return s.block(c.req.valid("param").name, b.users, b.block, b.by ?? "operator");
  }));

  app.openapi(createRoute({
    method: "get", path: "/{name}/blocked", tags, summary: "Blocked contacts (at Meta)",
    request: { params: z.object({ name: nameParam }) },
    responses: { 200: json(anyData, "Blocked"), ...errors },
  }), async (c) => run(c, async (s) => ({ blocked: await s.blocked(c.req.valid("param").name) })));

  app.openapi(createRoute({
    method: "get", path: "/{name}/analytics", tags, summary: "Analytics: messages, pricing, templates",
    description: "messages: sent and delivered (granularity HALF_HOUR, DAY, MONTH); pricing: cost and volume per category (DAILY, HALF_HOUR, MONTHLY; "
      + "dimensions COUNTRY, PHONE, PRICING_CATEGORY, PRICING_TYPE, TIER); templates: sent, delivered, read, clicked per template (DAILY, up to 10 ids, 90 days). "
      + "Conversation analytics are retired by Meta (November 2026).",
    request: {
      params: z.object({ name: nameParam }),
      query: z.object({
        kind: z.enum(["messages", "pricing", "templates"]), start: z.coerce.number().int(), end: z.coerce.number().int(),
        granularity: z.string().optional(), templateIds: z.string().optional(), dimensions: z.string().optional(),
      }),
    },
    responses: { 200: json(anyData, "Meta's data points"), ...errors },
  }), async (c) => run(c, async (s) => {
    const q = c.req.valid("query");
    const list = (v?: string) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    return s.analytics(c.req.valid("param").name, q.kind, {
      start: q.start, end: q.end, ...(q.granularity ? { granularity: q.granularity } : {}),
      ...(q.templateIds ? { templateIds: list(q.templateIds) } : {}), ...(q.dimensions ? { dimensions: list(q.dimensions) } : {}),
    });
  }));

  app.openapi(createRoute({
    method: "post", path: "/{name}/phone", tags, summary: "Phone number: register, deregister, two-step PIN, verification code, subscribe the app",
    request: {
      params: z.object({ name: nameParam }),
      body: { content: { "application/json": { schema: z.object({
        action: z.enum(["register", "deregister", "set_pin", "request_code", "verify_code", "subscribe_app"]),
        pin: z.string().regex(/^\d{6}$/).optional(), code: z.string().regex(/^\d{4,8}$/).optional(), method: z.enum(["SMS", "VOICE"]).optional(), language: z.string().optional(),
      }) } } },
    },
    responses: { 200: json(anyData, "Done"), ...errors },
  }), async (c) => run(c, async (s) => {
    const b = c.req.valid("json");
    await s.phoneAction(c.req.valid("param").name, b);
    return { action: b.action, done: true };
  }));

  app.openapi(createRoute({
    method: "get", path: "/{name}/webhook-override", tags, summary: "This number's callback at Meta (one app shared by several instances)",
    request: { params: z.object({ name: nameParam }) },
    responses: { 200: json(anyData, "The callback URL here and Meta's configuration"), ...errors },
  }), async (c) => run(c, (s) => s.webhookOverride(c.req.valid("param").name)));

  app.openapi(createRoute({
    method: "put", path: "/{name}/webhook-override", tags, summary: "Point this number's deliveries at this instance (or back to the app's callback)",
    description: "set: true overrides the callback for this phone number with this instance's (POLPO_PUBLIC_URL) and its verify token; false removes the override.",
    request: { params: z.object({ name: nameParam }), body: { content: { "application/json": { schema: z.object({ set: z.boolean() }) } } } },
    responses: { 200: json(anyData, "The configuration"), ...errors },
  }), async (c) => run(c, (s) => s.webhookOverride(c.req.valid("param").name, c.req.valid("json").set)));

  app.openapi(createRoute({
    method: "get", path: "/{name}/account-events", tags, summary: "Account updates from Meta",
    description: "Quality rating and messaging limit changes, display name reviews, template status / quality / category changes, capabilities, alerts, newest first.",
    request: { params: z.object({ name: nameParam }), query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }) },
    responses: { 200: json(anyData, "Events"), ...errors },
  }), async (c) => run(c, async (s) => ({ events: s.accountEvents(c.req.valid("param").name, c.req.valid("query").limit ?? 50) })));


  app.openapi(createRoute({
    method: "get", path: "/{name}/templates", tags, summary: "The account's message templates",
    request: { params: z.object({ name: nameParam }), query: z.object({ refresh: z.enum(["true", "false"]).optional() }) },
    responses: { 200: json(anyData, "Templates (name, language, status, category, components)"), ...errors },
  }), async (c) => run(c, (s) => s.templates(c.req.valid("param").name, { refresh: c.req.valid("query").refresh === "true" })));

  app.openapi(createRoute({
    method: "post", path: "/{name}/templates/sync", tags, summary: "Sync the templates from Meta",
    request: { params: z.object({ name: nameParam }) },
    responses: { 200: json(anyData, "Templates"), ...errors },
  }), async (c) => run(c, (s) => s.templates(c.req.valid("param").name, { refresh: true })));

  app.openapi(createRoute({
    method: "get", path: "/{name}/pending", tags, summary: "Sends waiting for approval",
    request: { params: z.object({ name: nameParam }) },
    responses: { 200: json(anyData, "Pending sends, oldest first"), ...errors },
  }), async (c) => run(c, async (s) => ({ pending: await s.pending(c.req.valid("param").name) })));

  app.openapi(createRoute({
    method: "post", path: "/{name}/pending/{id}/approve", tags, summary: "Approve a queued template: it is sent now",
    description: "The rules are checked again (opt-out, caps, template).",
    request: {
      params: z.object({ name: nameParam, id: z.string().openapi({ param: { name: "id", in: "path" } }) }),
      body: { content: { "application/json": { schema: z.object({ by: z.string().max(120).optional() }) } }, required: false },
    },
    responses: { 200: json(anyData, "Sent"), ...errors },
  }), async (c) => run(c, async (s) => {
    const { name, id } = c.req.valid("param");
    const by = ((await c.req.json().catch(() => ({}))) as { by?: string }).by ?? "operator";
    return s.approve(name, id, by);
  }));

  app.openapi(createRoute({
    method: "post", path: "/{name}/pending/{id}/reject", tags, summary: "Reject a queued template",
    request: {
      params: z.object({ name: nameParam, id: z.string().openapi({ param: { name: "id", in: "path" } }) }),
      body: { content: { "application/json": { schema: z.object({ by: z.string().max(120).optional(), reason: z.string().max(500).optional() }) } }, required: false },
    },
    responses: { 200: json(anyData, "Rejected"), ...errors },
  }), async (c) => run(c, async (s) => {
    const { name, id } = c.req.valid("param");
    const b = (await c.req.json().catch(() => ({}))) as { by?: string; reason?: string };
    await s.reject(name, id, b.by ?? "operator", b.reason);
    return { id, status: "rejected" };
  }));

  app.openapi(createRoute({
    method: "post", path: "/{name}/test", tags, summary: "Test the channel at Meta",
    description: "Reads the phone number with the access token: display number, verified name, quality rating and messaging limit tier when Graph returns them.",
    request: { params: z.object({ name: nameParam }) },
    responses: { 200: json(anyData, "The phone number"), ...errors },
  }), async (c) => run(c, (s) => s.testDetails(c.req.valid("param").name)));

  return app;
}
