import { Hono } from "hono";
import type { ServerEnv } from "../app.js";

/**
 * Config management routes.
 * POST /config/reload — trigger a runtime config reload from polpo.json.
 */
export function configRoutes(): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();

  // POST /config/reload — reload polpo.json at runtime
  app.post("/reload", (c) => {
    const orchestrator = c.get("orchestrator");
    const success = orchestrator.reloadConfig();

    if (success) {
      return c.json({ ok: true, data: { message: "Configuration reloaded successfully" } });
    }

    return c.json({ ok: false, error: "Failed to reload configuration — check polpo.json" }, 500);
  });

  // GET /config — return current config (redacted)
  app.get("/", (c) => {
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

    return c.json({ ok: true, data: redacted });
  });

  return app;
}
