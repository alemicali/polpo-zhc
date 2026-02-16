import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

const startedAt = Date.now();

const getHealthRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Health"],
  summary: "Health check",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            data: z.object({
              status: z.string(),
              version: z.string(),
              uptime: z.number(),
            }),
          }),
        },
      },
      description: "Server status, version, uptime",
    },
  },
});

/**
 * Health check routes.
 * GET /health — server status, version, uptime.
 */
export function healthRoutes(): OpenAPIHono {
  const app = new OpenAPIHono();

  app.openapi(getHealthRoute, (c) => {
    return c.json({
      ok: true,
      data: {
        status: "ok",
        version: "0.1.0",
        uptime: Math.round((Date.now() - startedAt) / 1000),
      },
    });
  });

  return app;
}
