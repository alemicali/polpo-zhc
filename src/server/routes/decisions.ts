/**
 * Decisions: typed judgments with probabilities from a decision model (decide()).
 *
 *   POST /api/v1/decide                      { state, questions, model?, thresholds?, fallback? } → the answers
 *   GET  /api/v1/decisions                   the decision log: ?limit&cursor&caller&callerId&uncertain&status
 *   GET  /api/v1/decisions/status            what is configured (model, gateway, where the key is: never the key)
 *   GET  /api/v1/decisions/nodes             missions' decision nodes (deciding, decided, waiting for a person)
 *   POST /api/v1/decisions/nodes/resolve     { group, node, branch } a person chooses a waiting node's branch
 *   GET  /api/v1/decisions/{id}              one decision with its questions and (capped) state
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { DecisionNodeState } from "@polpo-ai/core";
import { currentEventOrigin } from "../../core/events.js";
import { DecisionError, type DecisionService } from "../../decisions/service.js";
import type { DecisionCaller } from "../../decisions/store.js";

export interface DecisionRouteDeps {
  service: () => DecisionService | undefined;
  nodes: () => { list: () => DecisionNodeState[]; resolve: (group: string, node: string, branch: string | null, by: string) => Promise<DecisionNodeState> } | undefined;
}

// ── Schemas (OpenAPI) ─────────────────────────────────────────────────

const typeEnum = z.enum(["predicate", "choice", "score", "rank"]);
const questionSchema = z.object({
  name: z.string().openapi({ example: "refund" }),
  type: typeEnum,
  instructions: z.string().openapi({ example: "Is the customer asking for money back?" }),
  choices: z.array(z.object({ value: z.string(), description: z.string().optional() })).optional().openapi({ description: "choice: the options (2–20)" }),
  levels: z.array(z.union([z.string(), z.object({ label: z.string(), description: z.string().optional() })])).optional()
    .openapi({ description: "score (rank: the rating scale): ordered levels, lowest first (2–11)" }),
  items: z.array(z.union([z.string(), z.object({ id: z.string().optional(), label: z.string(), description: z.string().optional() })])).optional()
    .openapi({ description: "rank: the items to sort (2–20); each is rated on the levels" }),
  threshold: z.number().min(0).max(1).optional().openapi({ description: "Confidence below it → uncertain" }),
}).openapi("DecisionQuestion");
const modelSettingSchema = z.union([
  z.string().openapi({ example: "vercel-ai-gateway:typesafe-ai/jev" }),
  z.object({
    gateway: z.string().optional(), model: z.string(),
    fallback: z.union([z.string(), z.object({ model: z.string(), confidenceBelow: z.number().optional() })]).optional(),
    credentialRef: z.object({ owner: z.string(), service: z.string() }).optional(), credentialField: z.string().optional(),
    zeroDataRetention: z.boolean().optional(),
  }),
]).openapi("DecisionModelSetting");
const decideSchema = z.object({
  state: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]).openapi({ description: "The text or JSON the questions are about" }),
  questions: z.array(questionSchema),
  model: modelSettingSchema.optional().openapi({ description: "Another decision model than settings.decisionModel" }),
  thresholds: z.union([z.number(), z.record(z.string(), z.number())]).optional().openapi({ description: "A confidence threshold for every question, or per question name" }),
  fallback: z.union([z.string(), z.object({ model: z.string(), confidenceBelow: z.number().optional() })]).optional()
    .openapi({ description: "Rerun with another model on low confidence (or when the first fails)" }),
}).openapi("DecideRequest");
const answerSchema = z.object({
  name: z.string(), type: typeEnum,
  value: z.boolean().optional(), probability: z.number().optional(), choice: z.string().optional(), score: z.number().optional(), level: z.string().optional(),
  probabilities: z.record(z.string(), z.number()).optional(),
  ranking: z.array(z.object({ id: z.string(), label: z.string(), score: z.number(), confidence: z.number().optional() })).optional(),
  confidence: z.number().optional(), threshold: z.number().optional(), uncertain: z.boolean(),
}).openapi("DecisionAnswer");
const usageSchema = z.object({ inputTokens: z.number().optional(), outputTokens: z.number().optional() });
const resultSchema = z.object({
  id: z.string(), answers: z.array(answerSchema), model: z.string(), gateway: z.string().optional(), usage: usageSchema,
  costUsd: z.number(), calibrated: z.boolean(), latencyMs: z.number(), uncertain: z.boolean(),
}).openapi("DecideResult");
const callerSchema = z.object({
  kind: z.enum(["api", "mcp", "chat", "agent", "mission", "suite", "playground"]), id: z.string().optional(), label: z.string().optional(), by: z.string().optional(),
});
const summaryShape = {
  id: z.string(), at: z.string(), caller: callerSchema, status: z.enum(["ok", "error"]), error: z.string().optional(),
  model: z.string(), gateway: z.string().optional(), calibrated: z.boolean(), latencyMs: z.number(), costUsd: z.number(), usage: usageSchema,
  answers: z.array(answerSchema), uncertain: z.boolean(), stateHash: z.string(), stateChars: z.number(),
};
const summarySchema = z.object({ ...summaryShape, questions: z.array(z.object({ name: z.string(), type: typeEnum })) }).openapi("DecisionLogSummary");
const entrySchema = z.object({
  ...summaryShape, questions: z.array(questionSchema), state: z.string().optional(), stateTruncated: z.boolean().optional(),
}).openapi("DecisionLogEntry");
const statusSchema = z.object({
  configured: z.boolean(), model: z.string().optional(), gateway: z.object({ id: z.string(), label: z.string() }).optional(),
  fallback: z.object({ model: z.string(), confidenceBelow: z.number().optional() }).optional(), zeroDataRetention: z.boolean().optional(),
  key: z.object({ ok: z.boolean(), source: z.enum(["vault", "env"]).optional(), detail: z.string() }).optional(),
  error: z.string().optional(), unconfigured: z.enum(["error", "orchestrator"]), retention: z.number(), retentionDays: z.number(),
  storeInputs: z.enum(["capped", "hash"]),
  gateways: z.array(z.object({ id: z.string(), label: z.string(), envVar: z.string(), docsUrl: z.string().optional() })),
}).openapi("DecisionStatus");
const nodeSchema = z.object({
  group: z.string(), missionId: z.string().optional(), node: z.string(), status: z.enum(["deciding", "decided", "awaiting"]),
  branch: z.string().nullable().optional(), suggested: z.string().nullable().optional(), decisionId: z.string().optional(), answer: answerSchema.optional(),
  calibrated: z.boolean().optional(), reason: z.string().optional(), startedAt: z.string(), decidedAt: z.string().optional(), decidedBy: z.string().optional(),
}).openapi("DecisionNodeState");

const errorSchema = z.object({ ok: z.literal(false), error: z.string(), code: z.string().optional(), details: z.array(z.string()).optional() });
const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const okOf = <T extends z.ZodTypeAny>(schema: T) => z.object({ ok: z.literal(true), data: schema });
const body = <T extends z.ZodTypeAny>(schema: T) => ({ body: { content: { "application/json": { schema } } } });

/** Who called, from the request's origin (MCP and Polpo's chat tools come through the same API). */
function callerOf(): DecisionCaller {
  const o = currentEventOrigin();
  const kind: DecisionCaller["kind"] = o?.scopes ? "mcp" : o?.source === "polpo" ? "chat" : o?.source === "agent" ? "agent" : "api";
  return { kind, ...(o?.by ? { by: o.by } : {}) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each route's own response union
async function guard(c: any, fn: () => Promise<Response> | Response): Promise<any> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DecisionError) return c.json({ ok: false, error: err.message, code: err.code, ...(err.problems ? { details: err.problems } : {}) }, err.status);
    throw err;
  }
}

export function decideRoutes(deps: DecisionRouteDeps): OpenAPIHono {
  const app = new OpenAPIHono();
  app.openapi(createRoute({
    method: "post", path: "/", tags: ["Decisions"], summary: "Take a decision",
    description: "Typed decisions with probabilities about a state, from the decision model (settings.decisionModel, e.g. vercel-ai-gateway:typesafe-ai/jev): "
      + "predicate (P(yes)), choice (the option and a probability per option), score (ordered levels → a fractional score and a probability per level), "
      + "rank (items sorted: one score per item). A threshold marks answers below it `uncertain`. Without a decision model: 409 with a link to Settings, "
      + "or Polpo's own model through the chat pipeline (settings.decisions.unconfigured \"orchestrator\"), flagged calibrated: false. Every call is in the decision log.",
    request: body(decideSchema),
    responses: {
      200: json(okOf(resultSchema), "The answers"), 400: json(errorSchema, "Invalid request"), 409: json(errorSchema, "No decision model (or its key) is configured"),
      429: json(errorSchema, "The gateway is rate limiting"), 502: json(errorSchema, "The decision model failed"), 503: json(errorSchema, "Not available"), 504: json(errorSchema, "The decision model was too slow"),
    },
  }), (c) => guard(c, async () => {
    const s = deps.service();
    if (!s) throw new DecisionError("Polpo is not initialized", 503, "UNAVAILABLE");
    return c.json({ ok: true as const, data: await s.decide(c.req.valid("json"), callerOf()) }, 200);
  }));
  return app;
}

export function decisionRoutes(deps: DecisionRouteDeps): OpenAPIHono {
  const app = new OpenAPIHono();
  const need = () => {
    const s = deps.service();
    if (!s) throw new DecisionError("Polpo is not initialized", 503, "UNAVAILABLE");
    return s;
  };

  app.openapi(createRoute({
    method: "get", path: "/", tags: ["Decisions"], summary: "The decision log",
    description: "Every decision (who called it, the questions, the answers, the model, the cost), newest first.",
    request: {
      query: z.object({
        limit: z.string().optional(), cursor: z.string().optional(),
        caller: z.enum(["api", "mcp", "chat", "agent", "mission", "suite", "playground"]).optional(), callerId: z.string().optional(),
        uncertain: z.enum(["true", "false"]).optional(), status: z.enum(["ok", "error"]).optional(),
      }),
    },
    responses: { 200: json(okOf(z.object({ decisions: z.array(summarySchema), nextCursor: z.string().optional(), total: z.number() })), "A page of decisions") },
  }), (c) => guard(c, () => {
    const q = c.req.valid("query");
    return c.json({
      ok: true as const,
      data: need().store.list({
        ...(q.limit ? { limit: Number(q.limit) || 50 } : {}), ...(q.cursor ? { cursor: q.cursor } : {}), ...(q.caller ? { caller: q.caller } : {}),
        ...(q.callerId ? { callerId: q.callerId } : {}), ...(q.uncertain ? { uncertain: q.uncertain === "true" } : {}), ...(q.status ? { status: q.status } : {}),
      }),
    }, 200);
  }));

  app.openapi(createRoute({
    method: "get", path: "/status", tags: ["Decisions"], summary: "Decision model status",
    description: "The decision model, its gateway, where the gateway's key comes from (a vault entry or the env var; never the key) and whether it resolves, the policy without a model, the log's retention.",
    responses: { 200: json(okOf(statusSchema), "Status") },
  }), (c) => guard(c, async () => c.json({ ok: true as const, data: await need().status() }, 200)));

  app.openapi(createRoute({
    method: "get", path: "/nodes", tags: ["Decisions"], summary: "Mission decision nodes",
    description: "Missions' decision nodes of the runs in progress: deciding, decided (the branch taken), or waiting for a person to choose a branch.",
    responses: { 200: json(okOf(z.array(nodeSchema)), "Nodes") },
  }), (c) => guard(c, () => c.json({ ok: true as const, data: deps.nodes()?.list() ?? [] }, 200)));

  app.openapi(createRoute({
    method: "post", path: "/nodes/resolve", tags: ["Decisions"], summary: "Choose a waiting decision node's branch",
    description: "A mission's decision node whose answer was uncertain (or failed) waits for a person: take a branch (null: none of its tasks run). The mission resumes.",
    request: body(z.object({ group: z.string().openapi({ description: "The mission run (its group)" }), node: z.string(), branch: z.string().nullable() })),
    responses: { 200: json(okOf(nodeSchema), "Decided"), 400: json(errorSchema, "Not waiting, or an unknown branch"), 503: json(errorSchema, "Not available") },
  }), (c) => guard(c, async () => {
    const n = deps.nodes();
    if (!n) throw new DecisionError("Polpo is not initialized", 503, "UNAVAILABLE");
    const b = c.req.valid("json");
    try {
      return c.json({ ok: true as const, data: await n.resolve(b.group, b.node, b.branch, currentEventOrigin()?.by ?? "person") }, 200);
    } catch (err) {
      throw new DecisionError((err as Error).message, 400, "INVALID");
    }
  }));

  app.openapi(createRoute({
    method: "get", path: "/{id}", tags: ["Decisions"], summary: "One decision",
    request: { params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) }) },
    responses: { 200: json(okOf(entrySchema), "The decision"), 404: json(errorSchema, "No such decision (or no longer kept)") },
  }), (c) => guard(c, () => {
    const id = c.req.valid("param").id;
    const e = need().store.get(id);
    if (!e) throw new DecisionError(`No decision "${id}" (or no longer kept)`, 404, "NOT_FOUND");
    return c.json({ ok: true as const, data: e }, 200);
  }));

  return app;
}
