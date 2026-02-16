import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ServerEnv } from "../app.js";

// ── Route definitions ─────────────────────────────────────────────────

const reloadConfigRoute = createRoute({
  method: "post",
  path: "/reload",
  tags: ["Config"],
  summary: "Reload configuration from polpo.json",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ message: z.string() }) }) } },
      description: "Configuration reloaded successfully",
    },
    500: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Failed to reload configuration",
    },
  },
});

const getConfigRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Config"],
  summary: "Get current configuration (redacted)",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Current configuration",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "No configuration loaded",
    },
  },
});

// ── Route handlers ────────────────────────────────────────────────────

/**
 * Config management routes.
 * POST /config/reload — trigger a runtime config reload from polpo.json.
 */
export function configRoutes(): OpenAPIHono<ServerEnv> {
  const app = new OpenAPIHono<ServerEnv>();

  // POST /config/reload — reload polpo.json at runtime
  app.openapi(reloadConfigRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const success = orchestrator.reloadConfig();

    if (success) {
      return c.json({ ok: true, data: { message: "Configuration reloaded successfully" } }, 200);
    }

    return c.json({ ok: false, error: "Failed to reload configuration — check polpo.json" }, 500);
  });

  // GET /config — return current config (redacted)
  app.openapi(getConfigRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const config = orchestrator.getConfig();
    if (!config) {
      return c.json({ ok: false, error: "No configuration loaded" }, 404);
    }

    // Redact sensitive provider keys
    const redacted = {
      ...config,
      providers: config.providers
        ? Object.fromEntries(
            Object.entries(config.providers).map(([k, v]) => [
              k,
              { ...v, apiKey: v.apiKey ? `${v.apiKey.slice(0, 8)}...` : undefined },
            ]),
          )
        : undefined,
    };

    return c.json({ ok: true, data: redacted }, 200);
  });

  return app;
}
