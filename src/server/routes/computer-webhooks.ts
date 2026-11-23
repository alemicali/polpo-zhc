/**
 * Provider webhooks for computers (see sandbox/computer-webhooks.ts).
 *
 * Public (no dashboard auth; the provider's signature is the authentication):
 *   POST /api/v1/computers/webhooks/:provider   a delivery from Daytona or E2B (signature-verified, 256 KB at most,
 *                                               rate limited, replays refused). Behind Tailscale Funnel, the path
 *                                               /<instance>/api/v1/computers/webhooks/ must be exposed too.
 *
 * Authenticated (/api/v1/computer-webhooks):
 *   GET    /                         each provider's status: secret set, registered (E2B), the URL to give the provider,
 *                                    last event, counts; never a secret
 *   GET    /:provider/events         the provider's event log (every delivery: accepted / ignored / rejected / error),
 *                                    newest first; ?limit&cursor&outcome=accepted,rejected
 *   GET    /:provider/events/:id     one delivery with its redacted payload and safe headers
 *   PUT    /:provider/secret         { secret }: the signing secret (Daytona's whsec_…) into the vault (the dashboard only)
 *   DELETE /:provider/secret
 *   POST   /e2b/register             register this instance's endpoint at E2B (a fresh secret, kept in the vault)
 *   DELETE /e2b/register             unregister it
 */
import { Hono } from "hono";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { COMPUTER_WEBHOOK_PROVIDERS, WEBHOOK_MAX_BODY_BYTES, type ComputerWebhookProviderId, type ComputerWebhooks } from "../../sandbox/computer-webhooks.js";
import { COMPUTER_WEBHOOK_EVENTS_MAX, COMPUTER_WEBHOOK_OUTCOMES, type ComputerWebhookOutcome } from "../../sandbox/computer-webhook-events.js";

export interface ComputerWebhookRouteDeps {
  webhooks: () => ComputerWebhooks | undefined;
}

/** The note on exposing the endpoint (Tailscale Funnel exposes only listed paths). */
export const COMPUTER_WEBHOOK_FUNNEL_NOTE = "The provider must reach POLPO_PUBLIC_URL + /api/v1/computers/webhooks/<provider>: "
  + "behind Tailscale Funnel, expose the path /<instance>/api/v1/computers/webhooks/ as well (not only /mcp).";

export function computerWebhookInboundRoutes(deps: ComputerWebhookRouteDeps): Hono {
  const app = new Hono();
  app.post("/:provider", async (c) => {
    const w = deps.webhooks();
    if (!w) return c.json({ ok: false, error: "Polpo is not initialized" }, 503);
    const length = Number(c.req.header("content-length") ?? "0");
    const header = (name: string) => c.req.header(name);
    if (length > WEBHOOK_MAX_BODY_BYTES) {
      const r = w.refuseTooLarge(c.req.param("provider"), length, header);
      return c.json(r.body, r.status);
    }
    const raw = await c.req.text();
    const r = await w.handle(c.req.param("provider"), raw, header);
    return c.json(r.body, r.status);
  });
  return app;
}

// ── Schemas (OpenAPI) ─────────────────────────────────────────────────

const providerParam = z.string().openapi({ param: { name: "provider", in: "path" }, example: "daytona", description: "daytona or e2b" });

const providerStatusSchema = z.object({
  provider: z.enum(["daytona", "e2b"]),
  label: z.string(),
  registration: z.enum(["manual", "api"]),
  secretSet: z.boolean(),
  registered: z.boolean().optional(),
  webhookId: z.string().optional(),
  url: z.string().optional(),
  inUse: z.boolean(),
  lastEventAt: z.string().optional(),
  lastEventType: z.string().optional(),
  received: z.number(),
  rejected: z.number(),
  ignored: z.number(),
  errors: z.number(),
  before: z.object({
    received: z.number(), ignored: z.number(), rejected: z.number(), errors: z.number(),
    until: z.string().openapi({ description: "When the event log took over" }),
  }).optional().openapi({ description: "Deliveries counted before the event log existed: totals only, no entry in the log. The other counts are the event log's." }),
  lastError: z.string().optional(),
  lastErrorAt: z.string().optional(),
  state: z.enum(["receiving", "configured", "not-configured"]),
  waitingNote: z.string().optional(),
}).openapi("ComputerWebhookProviderStatus");

const outcomeSchema = z.enum(["accepted", "ignored", "rejected", "error"]);

const eventSummaryShape = {
  id: z.string(),
  provider: z.string(),
  receivedAt: z.string(),
  outcome: outcomeSchema,
  reason: z.string().optional(),
  httpStatus: z.number(),
  signature: z.enum(["valid", "invalid", "missing", "not-checked"]),
  eventType: z.string().optional(),
  providerEventId: z.string().optional(),
  deliveryId: z.string().optional(),
  sandboxId: z.string().optional(),
  snapshotName: z.string().optional(),
  computerId: z.string().optional(),
  providerState: z.object({ from: z.string().optional(), to: z.string().optional() }).optional(),
  statusChange: z.object({ from: z.string().optional(), to: z.string().optional(), error: z.string().optional(), appliedAt: z.string().optional() }).optional(),
  action: z.string().optional(),
  events: z.number().optional(),
  processingMs: z.number(),
  bytes: z.number(),
};
const eventSummarySchema = z.object(eventSummaryShape).openapi("ComputerWebhookEventSummary");
const eventSchema = z.object({
  ...eventSummaryShape,
  payload: z.unknown().optional().openapi({ description: "The redacted payload (JSON), or a redacted text preview; capped at 4 KB" }),
  payloadTruncated: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional().openapi({ description: "Safe headers only (never a signature or an authorization)" }),
}).openapi("ComputerWebhookEvent");

const errorSchema = z.object({ ok: z.literal(false), error: z.string(), code: z.string().optional() });
const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });

export function computerWebhookAdminRoutes(deps: ComputerWebhookRouteDeps): OpenAPIHono {
  const app = new OpenAPIHono();
  const known = (p: string): p is ComputerWebhookProviderId => p in COMPUTER_WEBHOOK_PROVIDERS;
  const need = () => {
    const w = deps.webhooks();
    if (!w) throw new Error("Polpo is not initialized");
    return w;
  };
  const notFound = (p: string) => ({ ok: false as const, error: `No webhooks for provider "${p}"`, code: "NOT_FOUND" });

  app.openapi(createRoute({
    method: "get", path: "/", tags: ["Computers"],
    summary: "Computer provider webhooks: each provider's status",
    description: "Per provider (daytona, e2b): the signing secret is set, registered (E2B), the URL to give the provider, the last event, "
      + "the counters (they follow the event log), the last problem since it was configured, and the state (receiving / configured / not-configured). "
      + "`waitingNote`: configured but no delivery ever arrived. Never a secret.",
    responses: {
      200: json(z.object({ ok: z.literal(true), data: z.object({ providers: z.array(providerStatusSchema), note: z.string(), reconcileOnly: z.array(z.string()) }) }), "Status"),
    },
  }), async (c) => c.json({ ok: true as const, data: { providers: await need().status(), note: COMPUTER_WEBHOOK_FUNNEL_NOTE, reconcileOnly: ["vercel"] } }, 200));

  app.openapi(createRoute({
    method: "get", path: "/{provider}/events", tags: ["Computers"],
    summary: "A provider's webhook event log",
    description: `Every delivery the provider sent (the last ${COMPUTER_WEBHOOK_EVENTS_MAX}), newest first: accepted (a computer was checked at its provider), `
      + "ignored (not about one of this instance's computers, a duplicate, an event Polpo does not act on), rejected (signature, replay, size, rate, not configured) "
      + "or error (Polpo could not apply it). Without payloads (GET /{provider}/events/{id}). `counts`: entries kept per outcome.",
    request: {
      params: z.object({ provider: providerParam }),
      query: z.object({
        limit: z.coerce.number().int().min(1).max(COMPUTER_WEBHOOK_EVENTS_MAX).optional().openapi({ description: "Default 50" }),
        cursor: z.string().optional().openapi({ description: "nextCursor of the previous page" }),
        outcome: z.string().optional().openapi({ description: "Comma-separated outcomes: accepted, ignored, rejected, error", example: "rejected,error" }),
      }),
    },
    responses: {
      200: json(z.object({ ok: z.literal(true), data: z.object({
        provider: z.string(), events: z.array(eventSummarySchema), nextCursor: z.string().optional(), total: z.number(),
        counts: z.object({ accepted: z.number(), ignored: z.number(), rejected: z.number(), error: z.number() }),
      }) }), "Events"),
      400: json(errorSchema, "Unknown outcome"),
      404: json(errorSchema, "Unknown provider"),
    },
  }), (c) => {
    const { provider } = c.req.valid("param");
    if (!known(provider)) return c.json(notFound(provider), 404);
    const { limit, cursor, outcome } = c.req.valid("query");
    const outcomes = (outcome ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const bad = outcomes.find((o) => !COMPUTER_WEBHOOK_OUTCOMES.includes(o as ComputerWebhookOutcome));
    if (bad) return c.json({ ok: false as const, error: `Unknown outcome "${bad}" (accepted, ignored, rejected, error)`, code: "VALIDATION_ERROR" }, 400);
    const page = need().events(provider, { ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}), outcomes: outcomes as ComputerWebhookOutcome[] });
    return c.json({ ok: true as const, data: { provider, ...page } }, 200);
  });

  app.openapi(createRoute({
    method: "get", path: "/{provider}/events/{id}", tags: ["Computers"],
    summary: "One webhook delivery",
    description: "A recorded delivery with what Polpo did (the computer it matched, its status before and after, the reason it was ignored or rejected), "
      + "its redacted payload (secrets, tokens, keys and signatures replaced; at most 4 KB) and its safe headers.",
    request: { params: z.object({ provider: providerParam, id: z.string().openapi({ param: { name: "id", in: "path" } }) }) },
    responses: {
      200: json(z.object({ ok: z.literal(true), data: eventSchema }), "The delivery"),
      404: json(errorSchema, "Unknown provider or delivery (no longer kept)"),
    },
  }), (c) => {
    const { provider, id } = c.req.valid("param");
    if (!known(provider)) return c.json(notFound(provider), 404);
    const ev = need().event(provider, id);
    if (!ev) return c.json({ ok: false as const, error: `No delivery "${id}" (only the last ${COMPUTER_WEBHOOK_EVENTS_MAX} are kept)`, code: "NOT_FOUND" }, 404);
    return c.json({ ok: true as const, data: ev as z.infer<typeof eventSchema> }, 200);
  });

  app.put("/:provider/secret", async (c) => {
    const p = c.req.param("provider");
    if (!known(p)) return c.json(notFound(p), 404);
    if (COMPUTER_WEBHOOK_PROVIDERS[p].registration === "api") return c.json({ ok: false, error: `${COMPUTER_WEBHOOK_PROVIDERS[p].label}'s secret is made by Polpo when it registers the webhook (POST /computer-webhooks/${p}/register)`, code: "VALIDATION_ERROR" }, 400);
    const body = await c.req.json().catch(() => ({})) as { secret?: unknown };
    if (typeof body.secret !== "string") return c.json({ ok: false, error: "Send { secret }", code: "VALIDATION_ERROR" }, 400);
    try {
      await need().setSecret(p, body.secret);
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message, code: "VALIDATION_ERROR" }, 400);
    }
    return c.json({ ok: true, data: (await need().status()).find((s) => s.provider === p) });
  });

  app.delete("/:provider/secret", async (c) => {
    const p = c.req.param("provider");
    if (!known(p)) return c.json(notFound(p), 404);
    await need().setSecret(p, null);
    return c.json({ ok: true, data: (await need().status()).find((s) => s.provider === p) });
  });

  app.post("/e2b/register", async (c) => {
    try {
      return c.json({ ok: true, data: await need().registerE2b() });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message, code: "PROVIDER_ERROR" }, 502);
    }
  });

  app.delete("/e2b/register", async (c) => {
    try {
      await need().unregisterE2b();
      return c.json({ ok: true, data: (await need().status()).find((s) => s.provider === "e2b") });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message, code: "PROVIDER_ERROR" }, 502);
    }
  });

  return app;
}
