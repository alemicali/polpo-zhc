import { Hono } from "hono";

const startedAt = Date.now();

/**
 * Health check routes.
 * GET /health — server status, version, uptime.
 */
export function healthRoutes(): Hono {
  const app = new Hono();

  app.get("/", (c) => {
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
