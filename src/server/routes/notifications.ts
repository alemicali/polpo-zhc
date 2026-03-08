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
  summary: "Send notification",
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

const listRulesRoute = createRoute({
  method: "get",
  path: "/rules",
  tags: ["Notifications"],
  summary: "List notification rules",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } },
      description: "Notification rules",
    },
  },
});

const createRuleRoute = createRoute({
  method: "post",
  path: "/rules",
  tags: ["Notifications"],
  summary: "Create notification rule",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            events: z.array(z.string().min(1)).min(1),
            channels: z.array(z.string().min(1)).optional(),
            condition: z.any().optional(),
            severity: z.enum(["info", "warning", "critical"]).optional(),
            cooldownMs: z.number().int().min(0).optional(),
            actions: z.array(z.any()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Rule created",
    },
    400: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Not configured",
    },
  },
});

const deleteRuleRoute = createRoute({
  method: "delete",
  path: "/rules/{ruleId}",
  tags: ["Notifications"],
  summary: "Delete notification rule",
  request: {
    params: z.object({ ruleId: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ deleted: z.boolean() }) }) } },
      description: "Rule deleted",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Rule not found",
    },
  },
});

/* ── Handlers ──────────────────────────────────────────────────────── */

/**
 * Notification history, rules, and direct send routes.
 */
export function notificationRoutes(): OpenAPIHono<ServerEnv> {
  const app = new OpenAPIHono<ServerEnv>();

  // GET /notifications — list notification history
  app.openapi(listNotificationsRoute, async (c) => {
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
      data = await store.listByStatus(status, limit);
    } else if (channel) {
      data = await store.listByChannel(channel, limit);
    } else if (rule) {
      data = await store.listByRule(rule, limit);
    } else {
      data = await store.list(limit);
    }

    return c.json({ ok: true, data });
  });

  // GET /notifications/stats — notification summary
  app.openapi(notificationStatsRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const router = orchestrator.getNotificationRouter();
    const store = router?.getStore();

    if (!store) {
      return c.json({ ok: true, data: { total: 0, sent: 0, failed: 0 } });
    }

    return c.json({
      ok: true,
      data: {
        total: await store.count(),
        sent: await store.count("sent"),
        failed: await store.count("failed"),
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

  // GET /notifications/rules — list notification rules
  app.openapi(listRulesRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const router = orchestrator.getNotificationRouter();
    if (!router) {
      return c.json({ ok: true, data: [] });
    }
    return c.json({ ok: true, data: router.getRules() });
  });

  // POST /notifications/rules — create a notification rule
  app.openapi(createRuleRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const router = orchestrator.getNotificationRouter();
    if (!router) {
      return c.json({ ok: false, error: "Notification system not configured", code: "NOT_CONFIGURED" }, 400);
    }

    const body = c.req.valid("json");
    const ruleId = `rule-${Date.now().toString(36)}`;
    const rule = {
      id: ruleId,
      name: body.name,
      events: body.events,
      channels: body.channels ?? [],
      condition: body.condition,
      severity: body.severity ?? "info" as const,
      cooldownMs: body.cooldownMs,
      actions: body.actions,
    };

    router.addRule(rule);
    return c.json({ ok: true, data: rule }, 201);
  });

  // DELETE /notifications/rules/:ruleId — delete a notification rule
  app.openapi(deleteRuleRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const router = orchestrator.getNotificationRouter();
    if (!router) {
      return c.json({ ok: false, error: "Notification system not configured", code: "NOT_FOUND" }, 404);
    }

    const { ruleId } = c.req.valid("param");
    const removed = router.removeRule(ruleId);
    if (!removed) {
      return c.json({ ok: false, error: `Rule "${ruleId}" not found`, code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { deleted: true } }, 200);
  });

  return app;
}
