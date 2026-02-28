import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ServerEnv } from "../app.js";

// ── Route definitions ─────────────────────────────────────────────────

const listSchedulesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Schedules"],
  summary: "List all schedule entries",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } },
      description: "List of schedule entries",
    },
  },
});

// ── Route handlers ────────────────────────────────────────────────────

export function scheduleRoutes(): OpenAPIHono<ServerEnv> {
  const app = new OpenAPIHono<ServerEnv>();

  // GET /schedules — list all schedule entries
  app.openapi(listSchedulesRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const schedules = orchestrator.getScheduler()?.getAllSchedules() ?? [];
    return c.json({ ok: true, data: schedules });
  });

  return app;
}
