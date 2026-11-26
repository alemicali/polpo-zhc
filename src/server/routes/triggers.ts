/**
 * Triggers: public endpoints that receive events (form submissions, any service's webhooks).
 *
 * Public (mounted before the instance auth gate and outside /api: the trigger's secret / signature
 * authenticates; the only public prefix of this feature):
 *   POST /hooks/:id     a delivery → 202 { deliveryId, status } (200 for a duplicate, with the
 *                       original's id; 400 with errors for a contract mismatch; 401, 413, 415, 429;
 *                       404 for an unknown or disabled trigger and for senders outside the IP allowlist).
 *                       Behind Tailscale Funnel publish /<instance>/hooks/ (see docs/triggers.md).
 *
 * Authenticated (/api/v1/triggers):
 *   GET    /                               triggers (status, endpoint, counts, last delivery)
 *   POST   /                               create → { trigger, secret? } (the generated secret, shown once)
 *   POST   /infer-schema                   { sample } → a JSON Schema
 *   GET    /:id                            one trigger
 *   PATCH  /:id                            change (a contract change makes a new revision)
 *   DELETE /:id
 *   POST   /:id/rotate-secret              { overlapSeconds? } → { secret } (shown once)
 *   PUT    /:id/hmac-secret                { secret } | { generate: true } → vault (never echoed; generated: shown once)
 *   DELETE /:id/hmac-secret
 *   GET    /:id/contract-versions          revisions, newest first
 *   GET    /:id/contract-versions/diff     ?from&to → a unified diff
 *   GET    /:id/deliveries                 ?limit&cursor&status=accepted,rejected&test
 *   GET    /:id/deliveries/:deliveryId
 *   POST   /:id/deliveries/:deliveryId/replay   dry run through the current (or a draft) contract, filter, dedupe, mapping
 *   POST   /:id/test                       a test delivery (recorded, test: true)
 *   POST   /:id/validate                   dry run of a sample (optionally against a draft)
 *   POST   /:id/infer-schema               { sample } | { deliveryId } → a JSON Schema
 */
import { Hono } from "hono";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { currentEventOrigin } from "../../core/events.js";
import { senderIp } from "../../triggers/evaluate.js";
import { TriggerError, type TriggerService } from "../../triggers/service.js";
import { TRIGGER_DELIVERY_STATUSES, type TriggerDeliveryStatus } from "../../triggers/types.js";

export interface TriggerRouteDeps {
  service: () => TriggerService | undefined;
}

/** Read a request body up to `max` bytes; undefined when it is larger. */
export async function readCapped(req: Request, max: number): Promise<Buffer | undefined> {
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function triggerInboundRoutes(deps: TriggerRouteDeps): Hono {
  const app = new Hono();
  app.post("/:id", async (c) => {
    const s = deps.service();
    if (!s) return c.json({ error: "Not found" }, 404);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the node server's socket
    const socketIp = (c.env as any)?.incoming?.socket?.remoteAddress as string | undefined;
    const length = c.req.header("content-length");
    const r = await s.receive(c.req.param("id"), {
      header: (name) => c.req.header(name),
      headers: c.req.raw.headers,
      query: new URL(c.req.url).searchParams,
      ip: senderIp(socketIp, c.req.header("x-forwarded-for")),
      ...(length && /^\d+$/.test(length) ? { contentLength: Number(length) } : {}),
      read: (max) => readCapped(c.req.raw, max),
    });
    for (const [k, v] of Object.entries(r.headers ?? {})) c.header(k, v);
    return c.json(r.body, r.status as 200);
  });
  return app;
}

// ── Schemas (OpenAPI) ─────────────────────────────────────────────────

const statusEnum = z.enum(["accepted", "rejected", "filtered", "duplicate", "rate_limited"]);
const contentTypeEnum = z.enum(["json", "form", "multipart", "text"]);
const hmacSchema = z.object({
  header: z.string().openapi({ example: "x-hub-signature-256" }),
  algorithm: z.enum(["sha256", "sha1"]),
  encoding: z.enum(["hex", "base64"]),
  prefix: z.string().optional().openapi({ example: "sha256=" }),
  timestampHeader: z.string().optional(),
  toleranceSeconds: z.number().int().optional(),
  signedPayload: z.string().optional().openapi({ description: "What is signed: {body} (default) or e.g. {timestamp}.{body}" }),
}).openapi("TriggerHmacConfig");
const contractSchema = z.object({
  contentTypes: z.array(contentTypeEnum),
  maxBodyBytes: z.number().int(),
  maxFileBytes: z.number().int().optional(),
  schema: z.record(z.string(), z.unknown()).optional().openapi({ description: "A JSON Schema for the parsed body" }),
}).openapi("TriggerContract");
const filterSchema = z.object({
  mode: z.enum(["all", "any"]).optional(),
  conditions: z.array(z.object({
    path: z.string().openapi({ example: "body.status" }),
    op: z.enum(["equals", "not_equals", "contains", "in", "gte", "lte", "exists", "not_exists"]),
    value: z.unknown().optional(),
  })),
}).openapi("TriggerFilter");
const dedupeSchema = z.object({ key: z.string().openapi({ example: "{{body.submission_id}}" }), ttlSeconds: z.number().int() }).openapi("TriggerDedupe");
const statsSchema = z.object({
  counts: z.record(z.string(), z.number()), total: z.number(), lastDeliveryAt: z.string().optional(), lastStatus: statusEnum.optional(),
});
const triggerSchema = z.object({
  id: z.string(), name: z.string(), description: z.string().optional(), enabled: z.boolean(), owner: z.string().optional(),
  createdAt: z.string(), updatedAt: z.string(),
  auth: z.object({ secret: z.boolean(), allowQueryToken: z.boolean().optional(), hmac: hmacSchema.optional(), ipAllowlist: z.array(z.string()).optional() }),
  secrets: z.array(z.object({ id: z.string(), hint: z.string(), createdAt: z.string(), expiresAt: z.string().optional() })).openapi({ description: "Generated secrets still valid (hints only, never the value)" }),
  hmacSecret: z.object({ secretSet: z.boolean(), previousUntil: z.string().optional() }).optional(),
  contract: contractSchema, contractVersion: z.number().int(),
  filter: filterSchema.optional(), dedupe: dedupeSchema.optional(),
  rateLimitPerMinute: z.number().int(), mapping: z.record(z.string(), z.string()).optional(), retention: z.number().int(),
  endpoint: z.string().openapi({ description: "POLPO_PUBLIC_URL + /hooks/{id} (the path when the public URL is unknown)" }),
  path: z.string(), stats: statsSchema,
}).openapi("Trigger");
const inputSchema = z.object({
  id: z.string().optional().openapi({ description: "create: a slug the id starts with (a random suffix is added)" }),
  name: z.string().optional(), description: z.string().nullable().optional(), enabled: z.boolean().optional(), owner: z.string().nullable().optional(),
  auth: z.object({
    secret: z.boolean().optional(), allowQueryToken: z.boolean().optional(),
    hmac: hmacSchema.partial().nullable().optional(), ipAllowlist: z.array(z.string()).optional(),
  }).optional(),
  contract: z.object({
    contentTypes: z.array(contentTypeEnum).optional(), maxBodyBytes: z.number().int().optional(), maxFileBytes: z.number().int().optional(),
    schema: z.record(z.string(), z.unknown()).nullable().optional(),
  }).optional(),
  contractNote: z.string().optional(),
  filter: filterSchema.nullable().optional(), dedupe: dedupeSchema.partial({ ttlSeconds: true }).nullable().optional(),
  rateLimitPerMinute: z.number().int().optional(), mapping: z.record(z.string(), z.string()).nullable().optional(), retention: z.number().int().optional(),
}).openapi("TriggerInput");
const sampleSchema = z.object({
  body: z.unknown(), contentType: contentTypeEnum.optional(),
  headers: z.record(z.string(), z.string()).optional(), query: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
}).openapi("TriggerSample");
const draftSchema = z.object({
  contract: inputSchema.shape.contract, filter: inputSchema.shape.filter, dedupe: inputSchema.shape.dedupe, mapping: inputSchema.shape.mapping,
}).openapi("TriggerDraft");
const dryRunSchema = z.object({
  status: statusEnum, reasons: z.array(z.string()), errors: z.array(z.string()), filterMatched: z.boolean(),
  dedupeKey: z.string().optional(), duplicateOf: z.string().optional(), mapped: z.record(z.string(), z.unknown()).optional(),
  mappingErrors: z.array(z.string()).optional(), contractVersion: z.number(), replayOf: z.string().optional(),
}).openapi("TriggerDryRun");
const deliverySummaryShape = {
  id: z.string(), triggerId: z.string(), receivedAt: z.string(), status: statusEnum, httpStatus: z.number(), reasons: z.array(z.string()),
  errors: z.array(z.string()).optional(), test: z.boolean().optional(), ip: z.string().optional(),
  auth: z.object({ secret: z.enum(["header", "bearer", "query"]).optional(), secretId: z.string().optional(), hmac: z.enum(["current", "previous"]).optional() }).optional(),
  contentType: z.string().optional(), kind: contentTypeEnum.optional(), bytes: z.number(), bodyTruncated: z.boolean().optional(),
  mappingErrors: z.array(z.string()).optional(), contractVersion: z.number(), dedupeHash: z.string().optional(), duplicateOf: z.string().optional(), count: z.number().optional(),
};
const deliverySummarySchema = z.object(deliverySummaryShape).openapi("TriggerDeliverySummary");
const deliverySchema = z.object({
  ...deliverySummaryShape,
  headers: z.record(z.string(), z.string()), query: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  body: z.unknown().optional(),
  files: z.array(z.object({ field: z.string(), filename: z.string(), contentType: z.string(), size: z.number(), sha256: z.string() })).optional(),
  mapped: z.record(z.string(), z.unknown()).optional(),
}).openapi("TriggerDelivery");
const revisionSchema = z.object({ version: z.number(), contract: contractSchema, createdAt: z.string(), by: z.string().optional(), note: z.string().optional() }).openapi("TriggerContractRevision");

const errorSchema = z.object({ ok: z.literal(false), error: z.string(), code: z.string().optional(), details: z.array(z.string()).optional() });
const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const okOf = <T extends z.ZodTypeAny>(schema: T) => z.object({ ok: z.literal(true), data: schema });
const body = <T extends z.ZodTypeAny>(schema: T) => ({ body: { content: { "application/json": { schema } } } });
const idParam = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });
const deliveryParams = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }), deliveryId: z.string().openapi({ param: { name: "deliveryId", in: "path" } }) });
const errors = { 400: json(errorSchema, "Invalid input"), 404: json(errorSchema, "No such trigger (or delivery)") };
const by = () => currentEventOrigin()?.by;

export function triggerAdminRoutes(deps: TriggerRouteDeps): OpenAPIHono {
  const app = new OpenAPIHono();
  const need = () => {
    const s = deps.service();
    if (!s) throw new TriggerError("Polpo is not initialized", 503);
    return s;
  };
  // Expected errors become { ok: false } answers with their status; anything else goes to the error middleware.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each route's own response union
  const guard = async (c: any, fn: () => Promise<Response> | Response): Promise<any> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof TriggerError) return c.json({ ok: false, error: err.message, code: err.code, ...(err.problems ? { details: err.problems } : {}) }, err.status);
      throw err;
    }
  };

  app.openapi(createRoute({
    method: "get", path: "/", tags: ["Triggers"], summary: "List triggers",
    description: "Every trigger with its endpoint (POLPO_PUBLIC_URL + /hooks/{id}), auth (never a secret: hints only), contract, filter, dedupe, mapping and delivery counts.",
    responses: { 200: json(okOf(z.array(triggerSchema)), "Triggers") },
  }), (c) => guard(c, async () => c.json({ ok: true as const, data: await need().list() }, 200)));

  app.openapi(createRoute({
    method: "post", path: "/", tags: ["Triggers"], summary: "Create a trigger",
    description: "A new trigger. With the generated secret on (the default unless only an HMAC is configured), `secret` is returned this once: only its hash is kept. "
      + "Nothing runs on a delivery yet: the action engine comes later; deliveries are recorded and announced (trigger:delivery).",
    request: body(inputSchema.extend({ name: z.string() })),
    responses: { 201: json(okOf(z.object({ trigger: triggerSchema, secret: z.string().optional() })), "Created"), ...errors },
  }), (c) => guard(c, async () => c.json({ ok: true as const, data: await need().create(c.req.valid("json") as never, by()) }, 201)));

  app.openapi(createRoute({
    method: "post", path: "/infer-schema", tags: ["Triggers"], summary: "Infer a JSON Schema from a sample",
    request: body(z.object({ sample: z.unknown() })),
    responses: { 200: json(okOf(z.object({ schema: z.record(z.string(), z.unknown()) })), "Schema"), 400: errors[400] },
  }), (c) => guard(c, () => c.json({ ok: true as const, data: { schema: need().inferSchema({ sample: (c.req.valid("json") as { sample: unknown }).sample }) } }, 200)));

  app.openapi(createRoute({
    method: "get", path: "/{id}", tags: ["Triggers"], summary: "Get a trigger",
    request: { params: idParam },
    responses: { 200: json(okOf(triggerSchema), "The trigger"), 404: errors[404] },
  }), (c) => guard(c, async () => c.json({ ok: true as const, data: await need().get(c.req.valid("param").id) }, 200)));

  app.openapi(createRoute({
    method: "patch", path: "/{id}", tags: ["Triggers"], summary: "Change a trigger",
    description: "Only the fields given change; null clears filter, dedupe, mapping, description, auth.hmac, contract.schema. A contract change makes a new contract version. "
      + "Turning the generated secret on when there is none returns `secret` this once.",
    request: { params: idParam, ...body(inputSchema) },
    responses: { 200: json(okOf(z.object({ trigger: triggerSchema, secret: z.string().optional() })), "Changed"), ...errors },
  }), (c) => guard(c, async () => c.json({ ok: true as const, data: await need().update(c.req.valid("param").id, c.req.valid("json") as never, by()) }, 200)));

  app.openapi(createRoute({
    method: "delete", path: "/{id}", tags: ["Triggers"], summary: "Delete a trigger",
    description: "The trigger, its deliveries, its contract history and its HMAC secret (vault).",
    request: { params: idParam },
    responses: { 200: json(okOf(z.object({ deleted: z.boolean() })), "Deleted"), 404: errors[404] },
  }), (c) => guard(c, async () => {
    const id = c.req.valid("param").id;
    if (!(await need().delete(id))) throw new TriggerError(`No trigger "${id}"`, 404);
    return c.json({ ok: true as const, data: { deleted: true } }, 200);
  }));

  app.openapi(createRoute({
    method: "post", path: "/{id}/rotate-secret", tags: ["Triggers"], summary: "Rotate the generated secret",
    description: "A new secret, returned this once; the previous one keeps working for overlapSeconds (default 86400; 0 revokes it now).",
    request: { params: idParam, ...body(z.object({ overlapSeconds: z.number().int().optional() })) },
    responses: { 200: json(okOf(z.object({ secret: z.string(), previousValidUntil: z.string().optional(), trigger: triggerSchema })), "Rotated"), ...errors },
  }), (c) => guard(c, async () => {
    const b = c.req.valid("json") as { overlapSeconds?: number };
    return c.json({ ok: true as const, data: await need().rotateSecret(c.req.valid("param").id, b.overlapSeconds) }, 200);
  }));

  app.openapi(createRoute({
    method: "put", path: "/{id}/hmac-secret", tags: ["Triggers"], summary: "Set the HMAC signing secret",
    description: "Stores the sender's signing secret (`secret`) in the vault, or one Polpo generates (`generate: true`, returned this once). The previous keeps working for overlapSeconds. Never echoed.",
    request: { params: idParam, ...body(z.object({ secret: z.string().optional(), generate: z.boolean().optional(), overlapSeconds: z.number().int().optional() })) },
    responses: { 200: json(okOf(z.object({ secret: z.string().optional(), status: z.object({ secretSet: z.boolean(), previousUntil: z.string().optional() }) })), "Set"), ...errors, 503: json(errorSchema, "No vault") },
  }), (c) => guard(c, async () => c.json({ ok: true as const, data: await need().setHmacSecret(c.req.valid("param").id, c.req.valid("json") as never) }, 200)));

  app.openapi(createRoute({
    method: "delete", path: "/{id}/hmac-secret", tags: ["Triggers"], summary: "Remove the HMAC signing secret",
    request: { params: idParam },
    responses: { 200: json(okOf(z.object({ secretSet: z.boolean(), previousUntil: z.string().optional() })), "Removed"), 404: errors[404] },
  }), (c) => guard(c, async () => c.json({ ok: true as const, data: await need().removeHmacSecret(c.req.valid("param").id) }, 200)));

  app.openapi(createRoute({
    method: "get", path: "/{id}/contract-versions", tags: ["Triggers"], summary: "A trigger's contract versions",
    request: { params: idParam },
    responses: { 200: json(okOf(z.array(revisionSchema)), "Revisions, newest first"), 404: errors[404] },
  }), (c) => guard(c, () => c.json({ ok: true as const, data: need().contractRevisions(c.req.valid("param").id) }, 200)));

  app.openapi(createRoute({
    method: "get", path: "/{id}/contract-versions/diff", tags: ["Triggers"], summary: "Diff two contract versions",
    request: { params: idParam, query: z.object({ from: z.coerce.number().int(), to: z.coerce.number().int() }) },
    responses: { 200: json(okOf(z.object({ from: z.number(), to: z.number(), diff: z.string() })), "A unified diff"), 404: errors[404] },
  }), (c) => guard(c, () => {
    const { from, to } = c.req.valid("query");
    return c.json({ ok: true as const, data: need().contractDiff(c.req.valid("param").id, from, to) }, 200);
  }));

  app.openapi(createRoute({
    method: "get", path: "/{id}/deliveries", tags: ["Triggers"], summary: "A trigger's deliveries",
    description: "Newest first, without bodies (GET /{id}/deliveries/{deliveryId}). `counts`: kept deliveries per status.",
    request: {
      params: idParam,
      query: z.object({
        limit: z.coerce.number().int().min(1).max(200).optional(), cursor: z.string().optional(),
        status: z.string().optional().openapi({ description: "Comma-separated: accepted, rejected, filtered, duplicate, rate_limited" }),
        test: z.enum(["true", "false"]).optional(),
      }),
    },
    responses: {
      200: json(okOf(z.object({ deliveries: z.array(deliverySummarySchema), nextCursor: z.string().optional(), total: z.number(), counts: z.record(z.string(), z.number()) })), "Deliveries"),
      ...errors,
    },
  }), (c) => guard(c, () => {
    const { limit, cursor, status, test } = c.req.valid("query");
    const statuses = (status ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const bad = statuses.find((s) => !TRIGGER_DELIVERY_STATUSES.includes(s as TriggerDeliveryStatus));
    if (bad) throw new TriggerError(`Unknown status "${bad}" (${TRIGGER_DELIVERY_STATUSES.join(", ")})`, 400);
    return c.json({ ok: true as const, data: need().deliveries(c.req.valid("param").id, {
      ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}), statuses: statuses as TriggerDeliveryStatus[], ...(test ? { test: test === "true" } : {}),
    }) }, 200);
  }));

  app.openapi(createRoute({
    method: "get", path: "/{id}/deliveries/{deliveryId}", tags: ["Triggers"], summary: "One delivery",
    description: "With its headers (secrets redacted), query, body (capped; keys that look secret redacted), files' metadata and mapped values.",
    request: { params: deliveryParams },
    responses: { 200: json(okOf(deliverySchema), "The delivery"), 404: errors[404] },
  }), (c) => guard(c, () => {
    const { id, deliveryId } = c.req.valid("param");
    return c.json({ ok: true as const, data: need().delivery(id, deliveryId) as never }, 200);
  }));

  app.openapi(createRoute({
    method: "post", path: "/{id}/deliveries/{deliveryId}/replay", tags: ["Triggers"], summary: "Replay a delivery (dry run)",
    description: "Runs a stored delivery through the current contract, filter, dedupe and mapping (or a draft of them) and shows the result. Nothing is recorded and no action runs.",
    request: { params: deliveryParams, ...body(z.object({ draft: draftSchema.optional() })) },
    responses: { 200: json(okOf(dryRunSchema), "The result"), ...errors },
  }), (c) => guard(c, () => {
    const { id, deliveryId } = c.req.valid("param");
    const b = c.req.valid("json") as { draft?: never };
    return c.json({ ok: true as const, data: need().dryRun(id, { deliveryId, ...(b.draft ? { draft: b.draft } : {}) }) }, 200);
  }));

  app.openapi(createRoute({
    method: "post", path: "/{id}/test", tags: ["Triggers"], summary: "Send a test delivery",
    description: "Records a delivery marked test: true, through the contract, filter, dedupe and mapping (no secret, IP or rate limit check) and announces it (trigger:delivery).",
    request: { params: idParam, ...body(sampleSchema) },
    responses: { 200: json(okOf(deliverySchema), "The recorded delivery"), ...errors },
  }), (c) => guard(c, () => c.json({ ok: true as const, data: need().test(c.req.valid("param").id, c.req.valid("json") as never) as never }, 200)));

  app.openapi(createRoute({
    method: "post", path: "/{id}/validate", tags: ["Triggers"], summary: "Validate a sample (dry run)",
    description: "A sample against the contract, filter, dedupe and mapping — the saved ones or a draft — without recording anything: contract errors, whether the filter matches, the mapped values.",
    request: { params: idParam, ...body(z.object({ sample: sampleSchema, draft: draftSchema.optional() })) },
    responses: { 200: json(okOf(dryRunSchema), "The result"), ...errors },
  }), (c) => guard(c, () => {
    const b = c.req.valid("json") as { sample: never; draft?: never };
    return c.json({ ok: true as const, data: need().dryRun(c.req.valid("param").id, { sample: b.sample, ...(b.draft ? { draft: b.draft } : {}) }) }, 200);
  }));

  app.openapi(createRoute({
    method: "post", path: "/{id}/infer-schema", tags: ["Triggers"], summary: "Infer a JSON Schema from a sample or a delivery",
    request: { params: idParam, ...body(z.object({ sample: z.unknown().optional(), deliveryId: z.string().optional() })) },
    responses: { 200: json(okOf(z.object({ schema: z.record(z.string(), z.unknown()) })), "Schema"), ...errors },
  }), (c) => guard(c, () => {
    const id = c.req.valid("param").id;
    const b = c.req.valid("json") as { sample?: unknown; deliveryId?: string };
    need().require(id);
    return c.json({ ok: true as const, data: { schema: need().inferSchema({ triggerId: id, ...(b.deliveryId ? { deliveryId: b.deliveryId } : { sample: b.sample }) }) } }, 200);
  }));

  return app;
}
