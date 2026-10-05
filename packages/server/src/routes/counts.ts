import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

/**
 * Lightweight counts endpoint — exposes just the cardinality of each
 * top-level collection. Lets dashboards (mobile AccountScreen, web
 * sidebar badges) render "N tasks / M missions / K agents" without
 * paying the cost of fetching the full lists.
 *
 * Each thunk runs in parallel and degrades to `null` on error so a
 * single failing store doesn't break the whole response.
 */

const countsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Counts"],
  summary: "Cardinality of tasks/missions/agents",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            data: z.object({
              tasks: z.number().nullable(),
              missions: z.number().nullable(),
              agents: z.number().nullable(),
            }),
          }),
        },
      },
      description: "Counts",
    },
  },
});

export function countsRoutes(getDeps: () => {
  getAllTasks: () => Promise<any[]>;
  getAllMissions: () => Promise<any[]>;
  getAgents: () => Promise<any[]>;
}): OpenAPIHono {
  const app = new OpenAPIHono();

  app.openapi(countsRoute, async (c) => {
    const deps = getDeps();
    const [tasks, missions, agents] = await Promise.all([
      deps.getAllTasks().then(a => a.length).catch(() => null),
      deps.getAllMissions().then(a => a.length).catch(() => null),
      deps.getAgents().then(a => a.length).catch(() => null),
    ]);
    return c.json({ ok: true, data: { tasks, missions, agents } });
  });

  return app;
}
