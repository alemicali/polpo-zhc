import { Hono } from "hono";
import type { ServerEnv } from "../app.js";
import { SendNotificationSchema, parseBody } from "../schemas.js";

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
export function notificationRoutes(): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();

  // GET /notifications — list notification history
  app.get("/", (c) => {
    const orchestrator = c.get("orchestrator");
    const router = orchestrator.getNotificationRouter();
    const store = router?.getStore();

    if (!store) {
      return c.json({ ok: true, data: [], message: "Notification store not configured" });
    }

    const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10) || 100, 500);
    const status = c.req.query("status") as "sent" | "failed" | undefined;
    const channel = c.req.query("channel");
    const rule = c.req.query("rule");

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
  app.get("/stats", (c) => {
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
  app.post("/send", async (c) => {
    const orchestrator = c.get("orchestrator");
    const router = orchestrator.getNotificationRouter();

    if (!router) {
      return c.json(
        { ok: false, error: "Notification system not configured", code: "NOT_CONFIGURED" },
        400,
      );
    }

    const body = parseBody(SendNotificationSchema, await c.req.json());

    try {
      const result = await router.sendDirect({
        channel: body.channel,
        title: body.title,
        body: body.body,
        severity: body.severity,
        delayMs: body.delayMs,
      });

      return c.json({ ok: true, data: result });
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
