import { Hono } from "hono";
import type { ServerEnv } from "../app.js";

/**
 * Notification history routes.
 *
 * GET /notifications           — list all notifications (most recent first)
 * GET /notifications/stats     — summary counts (total, sent, failed)
 *
 * Query params:
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

  return app;
}
