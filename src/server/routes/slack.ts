/**
 * Slack (Socket Mode) — the dashboard's side of a Slack channel's inbound connection:
 *
 *   GET    /                         every Slack channel's status
 *   GET    /:name/status             connection state, which tokens are set (never their values), bot identity
 *   PUT    /:name/secrets            { botToken?, appToken? } into the vault ($channels; the dashboard only)
 *   DELETE /:name/secrets/:kind      remove one
 *   POST   /:name/test               auth.test with the bot token: the bot and the workspace
 *
 * Sending a message to a Slack channel or thread goes through POST /notifications/send
 * ({ channel, to, threadTs }), like every other channel.
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { SLACK_SECRET_KINDS, SlackInputError, SlackNotFoundError, type SlackSecretKind, type SlackService } from "../../notifications/slack-service.js";

export interface SlackRouteDeps {
  service: () => SlackService | undefined;
}

const nameParam = z.string().openapi({ param: { name: "name", in: "path" }, example: "slack", description: "The channel's name (settings.notifications.channels)" });
const statusSchema = z.object({
  channel: z.string(),
  inbound: z.boolean(),
  secrets: z.object({ botToken: z.boolean(), appToken: z.boolean() }),
  state: z.enum(["not-configured", "stopped", "connecting", "connected", "reconnecting", "error"]),
  team: z.string().optional(),
  botUserId: z.string().optional(),
  botName: z.string().optional(),
  connectedAt: z.string().optional(),
  lastEventAt: z.string().optional(),
  lastError: z.string().optional(),
  received: z.number(),
}).openapi("SlackStatus");
const errorSchema = z.object({ ok: z.literal(false), error: z.string(), code: z.string().optional() });
const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const errors = {
  400: json(errorSchema, "Refused (not a Slack token, no vault)"),
  404: json(errorSchema, "No such Slack channel"),
};

function failure(err: unknown): { body: z.infer<typeof errorSchema>; status: 400 | 404 } {
  if (err instanceof SlackNotFoundError) return { body: { ok: false, error: err.message, code: "NOT_FOUND" }, status: 404 };
  const e = err as Error;
  return { body: { ok: false, error: e?.message ?? String(err), code: err instanceof SlackInputError ? "INVALID" : "VALIDATION_ERROR" }, status: 400 };
}

export function slackRoutes(deps: SlackRouteDeps): OpenAPIHono {
  const app = new OpenAPIHono();
  const tags = ["Slack"];
  const run = async (c: any, fn: (s: SlackService) => Promise<unknown>) => {
    try {
      const s = deps.service();
      if (!s) throw new Error("Polpo is not initialized");
      return c.json({ ok: true as const, data: await fn(s) }, 200);
    } catch (err) {
      const f = failure(err);
      return c.json(f.body, f.status);
    }
  };

  app.openapi(createRoute({
    method: "get", path: "/", tags, summary: "Every Slack channel's status",
    description: "Per Slack channel: inbound on, which tokens are in the vault (never their values), the Socket Mode connection, the bot and workspace, the last event.",
    responses: { 200: json(z.object({ ok: z.literal(true), data: z.object({ channels: z.array(statusSchema) }) }), "Statuses") },
  }), async (c) => run(c, async (s) => ({ channels: await Promise.all(s.channelNames().map((n) => s.status(n))) })));

  app.openapi(createRoute({
    method: "get", path: "/{name}/status", tags, summary: "A Slack channel's status",
    request: { params: z.object({ name: nameParam }) },
    responses: { 200: json(z.object({ ok: z.literal(true), data: statusSchema }), "Status"), ...errors },
  }), async (c) => run(c, (s) => s.status(c.req.valid("param").name)));

  app.openapi(createRoute({
    method: "put", path: "/{name}/secrets", tags, summary: "Set the Slack app's tokens (dashboard)",
    description: "The bot token (xoxb-…, OAuth & Permissions) and the app-level token (xapp-…, Basic Information → App-Level Tokens, scope connections:write). "
      + "They go to the vault (owner $channels) and are never returned or logged; the Socket Mode connection restarts. Only the fields given change.",
    request: {
      params: z.object({ name: nameParam }),
      body: { content: { "application/json": { schema: z.object({ botToken: z.string().optional(), appToken: z.string().optional() }) } } },
    },
    responses: { 200: json(z.object({ ok: z.literal(true), data: z.object({ secrets: z.object({ botToken: z.boolean(), appToken: z.boolean() }) }) }), "Which tokens are set"), ...errors },
  }), async (c) => run(c, async (s) => {
    const { name } = c.req.valid("param");
    const body = c.req.valid("json");
    for (const kind of SLACK_SECRET_KINDS) {
      const v = body[kind];
      if (typeof v === "string" && v.trim()) await s.setSecret(name, kind, v);
    }
    return { secrets: await s.secretsSet(name) };
  }));

  app.openapi(createRoute({
    method: "delete", path: "/{name}/secrets/{kind}", tags, summary: "Remove one of the Slack app's tokens",
    request: { params: z.object({ name: nameParam, kind: z.enum(["botToken", "appToken"]).openapi({ param: { name: "kind", in: "path" } }) }) },
    responses: { 200: json(z.object({ ok: z.literal(true), data: z.object({ secrets: z.object({ botToken: z.boolean(), appToken: z.boolean() }) }) }), "Which tokens are set"), ...errors },
  }), async (c) => run(c, async (s) => {
    const { name, kind } = c.req.valid("param");
    await s.setSecret(name, kind as SlackSecretKind, null);
    return { secrets: await s.secretsSet(name) };
  }));

  app.openapi(createRoute({
    method: "post", path: "/{name}/test", tags, summary: "Check the Slack app's bot token",
    description: "auth.test with the bot token: whether Slack accepts it. The status then shows the bot and the workspace.",
    request: { params: z.object({ name: nameParam }) },
    responses: { 200: json(z.object({ ok: z.literal(true), data: z.object({ ok: z.boolean(), status: statusSchema }) }), "Result"), ...errors },
  }), async (c) => run(c, async (s) => {
    const { name } = c.req.valid("param");
    const okay = await s.test(name);
    return { ok: okay, status: await s.status(name) };
  }));

  return app;
}
