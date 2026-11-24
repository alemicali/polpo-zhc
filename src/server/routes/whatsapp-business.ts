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
import { WABIZ_SECRET_KINDS, type WaBizSecretKind } from "@polpo-ai/core/whatsapp-business";
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
      body: { content: { "application/json": { schema: z.object({ to: z.string().min(1), text: z.string().min(1).max(20_000), by: z.string().max(80).optional() }) } } },
    },
    responses: { 200: json(anyData, "Sent: the message ids"), ...errors },
  }), async (c) => run(c, async (s) => {
    const { name } = c.req.valid("param");
    const b = c.req.valid("json");
    return { status: "sent", ids: await s.sendText(name, b.to, b.text, { sentBy: b.by ?? "operator" }) };
  }));

  app.openapi(createRoute({
    method: "post", path: "/{name}/send-template", tags, summary: "Send an approved template (business-initiated)",
    description: "Checked: the contact did not opt out, the template is APPROVED with these body parameters, its category is allowed, the daily caps. "
      + "queue: true (agents, Polpo) waits for an operator's approval when business.approveTemplates is on; otherwise it is sent now.",
    request: {
      params: z.object({ name: nameParam }),
      body: { content: { "application/json": { schema: z.object({
        to: z.string().min(1), template: z.string().min(1), language: z.string().optional(), params: z.array(z.string()).max(30).optional(),
        queue: z.boolean().optional(), by: z.string().max(80).optional(), reason: z.string().max(500).optional(),
      }) } } },
    },
    responses: { 200: json(anyData, "sent (ids) or pending_approval (id)"), ...errors },
  }), async (c) => run(c, async (s) => {
    const { name } = c.req.valid("param");
    const b = c.req.valid("json");
    return s.sendTemplate(name, b.to, b.template, b.params ?? [], {
      ...(b.language ? { language: b.language } : {}), sentBy: b.by ?? (b.queue ? "polpo" : "operator"),
      approval: b.queue ? "queue" : "direct", ...(b.reason ? { reason: b.reason } : {}),
    });
  }));

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
