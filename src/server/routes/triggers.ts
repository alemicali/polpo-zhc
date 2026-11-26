/**
 * Triggers: public endpoints that receive events (form submissions, any service's webhooks).
 *
 * Public (mounted before the instance auth gate and outside /api: the trigger's secret / signature
 * authenticates; the only public prefix of this feature):
 *   POST /hooks/:id     a delivery → 202 { deliveryId, status, actions? } (actions: "queued" when the
 *                       trigger has actions: they run after the answer; 200 for a duplicate, with the
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
 *   POST   /:id/deliveries/:deliveryId/run-actions   re-run the actions on a stored accepted delivery (202)
 *   POST   /:id/actions/preview            the actions (or a draft) rendered against a delivery; nothing runs
 *   GET    /:id/action-usage               actions started today and the agent actions' spend
 *   POST   /:id/test                       a test delivery (recorded, test: true; runActions: true runs the actions)
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
  scheme: z.enum(["standard-webhooks"]).optional().openapi({ description: "standard-webhooks: webhook-id / webhook-timestamp / webhook-signature (v1,<base64>), signed \"{id}.{timestamp}.{body}\", whsec_ secret; the other fields are set for you" }),
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
const templates = z.record(z.string(), z.string());
const actionCommon = {
  id: z.string().optional().openapi({ description: "Stable within the trigger (generated when absent); later actions read its outputs as {{steps.<id>.…}}" }),
  enabled: z.boolean().optional().openapi({ description: "Default true; a disabled action is recorded as skipped" }),
  name: z.string().optional(),
  retries: z.number().int().optional().openapi({ description: "Retries after a failure with backoff (default 2; 0 for agent). What was created is never created again" }),
  continueOnError: z.boolean().optional().openapi({ description: "When this action fails, still run the later ones (default false: they are skipped)" }),
};
const waitSeconds = z.number().int().optional().openapi({ description: "Wait until it ends (at most 3600 s): later actions read {{steps.<id>.result}} and .status" });
const actionSchema = z.discriminatedUnion("kind", [
  z.object({ ...actionCommon, kind: z.literal("playbook"), playbook: z.string(), params: templates.optional().openapi({ description: "Parameter → template over body / headers / query / mapped / trigger / delivery / steps, e.g. {{mapped.email}}" }), waitSeconds }),
  z.object({ ...actionCommon, kind: z.literal("mission"), mission: z.string().openapi({ description: "Mission id or name" }), variables: templates.optional().openapi({ description: "Replace {{name}} in a copy of the mission" }), waitSeconds }),
  z.object({ ...actionCommon, kind: z.literal("task"), title: z.string(), description: z.string(), assignTo: z.string(), waitSeconds }),
  z.object({
    ...actionCommon, kind: z.literal("agent"), agent: z.string().optional().openapi({ description: "Absent: Polpo" }),
    instructions: z.string().openapi({ description: "Only {{trigger.*}} / {{delivery.*}}: the payload follows as delimited data, never inside the instructions" }),
    data: z.enum(["mapped", "body", "both"]).optional(), allowedTools: z.array(z.string()).optional().openapi({ description: "Only these tools in this turn ('prefix*' a family; [] none)" }),
    maxSteps: z.number().int().optional(),
    deliverTo: z.object({ channel: z.string(), chatId: z.string(), threadId: z.number().int().optional(), name: z.string().optional() }).optional().openapi({ description: "Also send the reply to this chat (e.g. Telegram)" }),
  }),
  z.object({ ...actionCommon, kind: z.literal("notify"), channel: z.string().openapi({ description: "A notification channel id (settings.notifications.channels)" }), title: z.string().optional(), body: z.string(), severity: z.enum(["info", "warning", "critical"]).optional() }),
]).openapi("TriggerAction");
const actionLimitsSchema = z.object({
  concurrency: z.number().int().optional().openapi({ description: "Deliveries whose actions run at once (default 2)" }),
  perMinute: z.number().int().optional().openapi({ description: "Actions started a minute (default 30); beyond: skipped" }),
  perDay: z.number().int().optional().openapi({ description: "Actions started a day (default 1000); beyond: skipped" }),
  agentDailyCostUsd: z.number().optional().openapi({ description: "What the agent actions may spend a day (USD); beyond: skipped" }),
}).openapi("TriggerActionLimits");
const actionStatusEnum = z.enum(["queued", "running", "done", "failed", "skipped"]);
const actionsStatusEnum = z.enum(["queued", "running", "done", "failed", "skipped", "partial"]);
const actionRefsSchema = z.object({
  playbook: z.string().optional(), missionId: z.string().optional(), missionName: z.string().optional(), copyOf: z.string().optional(), taskId: z.string().optional(),
  sessionId: z.string().optional(), agent: z.string().optional(), notificationId: z.string().optional(), channel: z.string().optional(),
}).openapi("TriggerActionRefs");
const actionRunShape = {
  actionId: z.string(), kind: z.enum(["playbook", "mission", "task", "agent", "notify"]), name: z.string().optional(), status: actionStatusEnum, attempts: z.number().int(),
  queuedAt: z.string(), startedAt: z.string().optional(), endedAt: z.string().optional(), error: z.string().optional(), reason: z.string().optional(),
  refs: actionRefsSchema.optional(), costUsd: z.number().optional(),
};
const actionRunSchema = z.object({ ...actionRunShape, outputs: z.record(z.string(), z.unknown()).optional() }).openapi("TriggerActionRun");
const workOriginSchema = z.object({
  kind: z.literal("trigger"), triggerId: z.string(), deliveryId: z.string(), triggerName: z.string().optional(), actionId: z.string().optional(), depth: z.number().int().optional(),
}).openapi("WorkOrigin");
const triggerSchema = z.object({
  id: z.string(), name: z.string(), description: z.string().optional(), enabled: z.boolean(), owner: z.string().optional(),
  createdAt: z.string(), updatedAt: z.string(),
  auth: z.object({ secret: z.boolean(), allowQueryToken: z.boolean().optional(), hmac: hmacSchema.optional(), ipAllowlist: z.array(z.string()).optional() }),
  secrets: z.array(z.object({ id: z.string(), hint: z.string(), createdAt: z.string(), expiresAt: z.string().optional() })).openapi({ description: "Generated secrets still valid (hints only, never the value)" }),
  hmacSecret: z.object({ secretSet: z.boolean(), previousUntil: z.string().optional() }).optional(),
  contract: contractSchema, contractVersion: z.number().int(),
  filter: filterSchema.optional(), dedupe: dedupeSchema.optional(),
  rateLimitPerMinute: z.number().int(), mapping: z.record(z.string(), z.string()).optional(), retention: z.number().int(),
  actions: z.array(actionSchema).optional().openapi({ description: "What runs on an accepted delivery, in order" }), actionLimits: actionLimitsSchema.optional(),
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
  actions: z.array(actionSchema).nullable().optional().openapi({ description: "Replaces the actions (in order); null or [] removes them" }),
  actionLimits: actionLimitsSchema.nullable().optional().openapi({ description: "null: the defaults" }),
}).openapi("TriggerInput");
const sampleSchema = z.object({
  body: z.unknown(), contentType: contentTypeEnum.optional(),
  headers: z.record(z.string(), z.string()).optional(), query: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  runActions: z.boolean().optional().openapi({ description: "Test delivery: also run the trigger's actions (default false: a test runs nothing)" }),
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
  actionsStatus: actionsStatusEnum.optional().openapi({ description: "The delivery's actions as a whole (partial: some done, some failed)" }),
  actionsRequestedBy: z.string().optional().openapi({ description: "The member the actions ran for (the trigger's owner)" }),
  origin: workOriginSchema.optional().openapi({ description: "It arrived while another trigger's actions ran (loop guard chain)" }),
};
const deliverySummarySchema = z.object({ ...deliverySummaryShape, actions: z.array(z.object(actionRunShape)).optional() }).openapi("TriggerDeliverySummary");
const deliverySchema = z.object({
  ...deliverySummaryShape,
  actions: z.array(actionRunSchema).optional().openapi({ description: "Each action's run: status, attempts, times, error, refs to what it created, outputs" }),
  previousActions: z.array(z.object({ endedAt: z.string().optional(), status: actionsStatusEnum.optional(), runs: z.array(actionRunSchema) })).optional().openapi({ description: "Earlier runs (re-runs), newest first" }),
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
      + "An accepted delivery runs the trigger's actions (in order, after the 202; see actions); deliveries are recorded and announced (trigger:delivery).",
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
    method: "post", path: "/{id}/deliveries/{deliveryId}/run-actions", tags: ["Triggers"], summary: "Re-run a delivery's actions",
    description: "Runs the trigger's current actions again on a stored accepted delivery (a test one too), after the answer: 202 with the queued runs. "
      + "The previous runs are kept on the delivery (previousActions). 409 while its actions are still queued or running, or when the trigger is disabled.",
    request: { params: deliveryParams },
    responses: { 202: json(okOf(z.object({ deliveryId: z.string(), actionsStatus: actionsStatusEnum.optional(), actions: z.array(actionRunSchema) })), "Queued"), ...errors, 409: json(errorSchema, "Running, or the trigger is disabled") },
  }), (c) => guard(c, () => {
    const { id, deliveryId } = c.req.valid("param");
    const d = need().rerunActions(id, deliveryId);
    return c.json({ ok: true as const, data: { deliveryId: d.id, ...(d.actionsStatus ? { actionsStatus: d.actionsStatus } : {}), actions: d.actions ?? [] } }, 202);
  }));

  app.openapi(createRoute({
    method: "post", path: "/{id}/actions/preview", tags: ["Triggers"], summary: "Preview the actions on a delivery",
    description: "Renders the trigger's actions (or a draft of them) against a stored delivery (default: the newest accepted one) without running anything: playbook params, "
      + "mission variables, task title and description, the agent's message (instructions, then the payload as delimited data), the notification.",
    request: { params: idParam, ...body(z.object({ deliveryId: z.string().optional(), actions: z.array(actionSchema).optional().openapi({ description: "A draft (unsaved)" }) })) },
    responses: {
      200: json(okOf(z.object({
        deliveryId: z.string().optional(), note: z.string().optional(),
        actions: z.array(z.object({ actionId: z.string(), kind: z.string(), rendered: z.record(z.string(), z.unknown()), error: z.string().optional() })),
      })), "The rendered actions"),
      ...errors,
    },
  }), (c) => guard(c, () => {
    const b = c.req.valid("json") as { deliveryId?: string; actions?: unknown[] };
    return c.json({ ok: true as const, data: need().previewActions(c.req.valid("param").id, b) }, 200);
  }));

  app.openapi(createRoute({
    method: "get", path: "/{id}/action-usage", tags: ["Triggers"], summary: "A trigger's action usage today",
    description: "Actions started today (UTC) and what its agent actions spent, against the limits (actionLimits).",
    request: { params: idParam },
    responses: { 200: json(okOf(z.object({ day: z.string(), actions: z.number(), agentUsd: z.number() })), "Usage"), 404: errors[404] },
  }), (c) => guard(c, () => c.json({ ok: true as const, data: need().actionUsage(c.req.valid("param").id) }, 200)));

  app.openapi(createRoute({
    method: "post", path: "/{id}/test", tags: ["Triggers"], summary: "Send a test delivery",
    description: "Records a delivery marked test: true, through the contract, filter, dedupe and mapping (no secret, IP or rate limit check) and announces it (trigger:delivery). Its actions run only with runActions: true.",
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
