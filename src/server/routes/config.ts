import { existsSync } from "node:fs";
import { resolve, basename, join } from "node:path";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ServerEnv } from "../app.js";
import { redactPolpoConfig } from "../security.js";
import { savePolpoConfig, generatePolpoConfigDefault } from "../../core/config.js";
import { detectProviders } from "../../setup/index.js";
import type { Orchestrator } from "../../core/orchestrator.js";

// ── Authed route definitions ──────────────────────────────────────────

const reloadConfigRoute = createRoute({
  method: "post",
  path: "/reload",
  tags: ["Config"],
  summary: "Reload config",
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
  summary: "Get config",
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

// ── Public route definitions ──────────────────────────────────────────

const configStatusRoute = createRoute({
  method: "get",
  path: "/status",
  tags: ["Config"],
  summary: "Check if Polpo is configured and initialized",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            data: z.object({
              initialized: z.boolean(),
              hasConfig: z.boolean(),
              hasProviders: z.boolean(),
              detectedProviders: z.array(z.object({
                name: z.string(),
                envVar: z.string(),
                hasKey: z.boolean(),
              })),
            }),
          }),
        },
      },
      description: "Configuration and initialization status",
    },
  },
});

const initializeRoute = createRoute({
  method: "post",
  path: "/initialize",
  tags: ["Config"],
  summary: "Save config and initialize the orchestrator",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            orgName: z.string().optional(),
            workDir: z.string().optional(),
            model: z.string().optional(),
            agentName: z.string().optional(),
            agentRole: z.string().optional(),
            providers: z.record(z.string(), z.object({
              baseUrl: z.string().optional(),
              api: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]).optional(),
            })).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), data: z.object({ message: z.string() }) }),
        },
      },
      description: "Initialization complete",
    },
  },
});

// ── Authed route handlers ─────────────────────────────────────────────

/**
 * Config management routes (requires orchestrator).
 * GET  /config       — return current config (redacted)
 * POST /config/reload — trigger a runtime config reload
 */
export function configRoutes(): OpenAPIHono<ServerEnv> {
  const app = new OpenAPIHono<ServerEnv>();

  app.openapi(reloadConfigRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const success = orchestrator.reloadConfig();
    if (success) {
      return c.json({ ok: true, data: { message: "Configuration reloaded successfully" } }, 200);
    }
    return c.json({ ok: false, error: "Failed to reload configuration — check polpo.json" }, 500);
  });

  app.openapi(getConfigRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const config = orchestrator.getConfig();
    if (!config) {
      return c.json({ ok: false, error: "No configuration loaded" }, 404);
    }
    return c.json({ ok: true, data: redactPolpoConfig(config) }, 200);
  });

  return app;
}

// ── Public route handlers ─────────────────────────────────────────────

/**
 * Public config routes — no auth required.
 * GET  /config/status     — check if Polpo is configured/initialized
 * POST /config/initialize — save config and init the orchestrator
 */
export function publicConfigRoutes(
  orchestrator: Orchestrator,
  workDir: string,
  onInitialize?: (workDir: string) => Promise<void>,
): OpenAPIHono {
  const app = new OpenAPIHono();
  const polpoDir = resolve(workDir, ".polpo");

  // GET /config/status
  app.openapi(configStatusRoute, (c) => {
    const hasConfig = existsSync(join(polpoDir, "polpo.json"));
    const providers = detectProviders();
    const hasProviders = providers.some((p) => p.hasKey);

    return c.json({
      ok: true,
      data: {
        initialized: orchestrator.isInitialized,
        hasConfig,
        hasProviders,
        detectedProviders: providers,
        workDir,
        orgName: basename(workDir),
      },
    });
  });

  // POST /config/initialize
  app.openapi(initializeRoute, async (c) => {
    const body = c.req.valid("json");
    const targetDir = body.workDir ? resolve(body.workDir) : workDir;
    const targetPolpoDir = resolve(targetDir, ".polpo");
    const org = body.orgName || basename(targetDir);

    const config = generatePolpoConfigDefault(org, {
      model: body.model || undefined,
      agentName: body.agentName || undefined,
      agentRole: body.agentRole || undefined,
      providers: body.providers,
    });

    savePolpoConfig(targetPolpoDir, config);

    if (onInitialize) {
      try {
        await onInitialize(targetDir);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[Config] Failed to initialize orchestrator: ${msg}`);
      }
    }

    return c.json({
      ok: true,
      data: { message: "Setup complete! Dashboard is ready.", workDir: targetDir },
    });
  });

  return app;
}
