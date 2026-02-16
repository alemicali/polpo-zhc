import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ServerEnv } from "../app.js";
import { SendNotificationSchema } from "../schemas.js";

/* ── Route definitions ─────────────────────────────────────────────── */

const listNotificationsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Notifications"],
  summary: "List notification history",
  request: {
    query: z.object({
      limit: z.string().optional(),
      status: z.string().optional(),
      channel: z.string().optional(),
      rule: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Notification list",
    },
  },
});

const notificationStatsRoute = createRoute({
  method: "get",
  path: "/stats",
  tags: ["Notifications"],
  summary: "Notification summary counts",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Notification stats",
    },
  },
});

const sendNotificationRoute = createRoute({
  method: "post",
  path: "/send",
  tags: ["Notifications"],
  summary: "Send a notification directly",
  request: {
    body: { content: { "application/json": { schema: SendNotificationSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Notification sent",
    },
    400: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Not configured or send failed",
    },
  },
});

/* ── Handlers ──────────────────────────────────────────────────────── */

/**
 * Notification history + direct send routes.
 *
 * GET  /notifications           — list all notifications (most recent first)
 * GET  /notifications/stats     — summary counts (total, sent, failed)
 * POST /notifications/send      — send a notification directly (with optional delay)
 *
 * Query params (GET /notifications):
 *   ?limit=N         — max records (default 100, max 500)
 *   ?status=sent|failed
 *   ?channel=<channelId>
 *   ?rule=<ruleId>
 */
export function notificationRoutes(): OpenAPIHono<ServerEnv> {
  const app = new OpenAPIHono<ServerEnv>();

  // GET /notifications — list notification history
  app.openapi(listNotificationsRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const router = orchestrator.getNotificationRouter();
    const store = router?.getStore();

    if (!store) {
      return c.json({ ok: true, data: [], message: "Notification store not configured" });
    }

    const query = c.req.valid("query");
    const limit = Math.min(parseInt(query.limit ?? "100", 10) || 100, 500);
    const status = query.status as "sent" | "failed" | undefined;
    const channel = query.channel;
    const rule = query.rule;

    let data;
    if (status) {
      data = store.listByStatus(status, limit);
    } else if (channel) {
      data = store.listByChannel(channel, limit);
    } else if (rule) {
      data = store.listByRule(rule, limit);
    } else {
      data = store.list(limit);
    }

    return c.json({ ok: true, data });
  });

  // GET /notifications/stats — notification summary
  app.openapi(notificationStatsRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const router = orchestrator.getNotificationRouter();
    const store = router?.getStore();

    if (!store) {
      return c.json({ ok: true, data: { total: 0, sent: 0, failed: 0 } });
    }

    return c.json({
      ok: true,
      data: {
        total: store.count(),
        sent: store.count("sent"),
        failed: store.count("failed"),
      },
    });
  });

  // POST /notifications/send — send a notification directly (with optional delay)
  app.openapi(sendNotificationRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const router = orchestrator.getNotificationRouter();

    if (!router) {
      return c.json(
        { ok: false, error: "Notification system not configured", code: "NOT_CONFIGURED" },
        400,
      );
    }

    const body = c.req.valid("json");

    try {
      const result = await router.sendDirect({
        channel: body.channel,
        title: body.title,
        body: body.body,
        severity: body.severity,
        delayMs: body.delayMs,
      });

      return c.json({ ok: true, data: result }, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(
        { ok: false, error: msg, code: "SEND_FAILED" },
        400,
      );
    }
  });

  return app;
}
