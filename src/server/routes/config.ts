import { existsSync } from "node:fs";
import { resolve, basename, join } from "node:path";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ServerEnv } from "../app.js";
import { redactPolpoConfig } from "../security.js";
import { UpdateSettingsSchema, NotificationChannelConfigSchema } from "../schemas.js";
import { loadPolpoConfig, savePolpoConfig, generatePolpoConfigDefault } from "../../core/config.js";
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
                envVar: z.string().optional(),
                hasKey: z.boolean(),
                source: z.enum(["env", "oauth", "none"]),
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
    409: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), error: z.string() }),
        },
      },
      description: "Already initialized or initialization in progress",
    },
    500: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), error: z.string() }),
        },
      },
      description: "Initialization failed",
    },
  },
});

const updateSettingsRoute = createRoute({
  method: "patch",
  path: "/settings",
  tags: ["Config"],
  summary: "Update orchestrator settings",
  description: "Partially update orchestrator settings (orchestratorModel, imageModel, reasoning). Persists to polpo.json and triggers a runtime config reload.",
  request: {
    body: { content: { "application/json": { schema: UpdateSettingsSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Settings updated",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "No configuration loaded",
    },
    500: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Failed to update settings",
    },
  },
});

// ── Channel CRUD route definitions ────────────────────────────────────

const upsertChannelRoute = createRoute({
  method: "put",
  path: "/channels/{name}",
  tags: ["Config"],
  summary: "Create or update a notification channel",
  description: "Upserts a notification channel in settings.notifications.channels. Persists to polpo.json and reloads the notification router.",
  request: {
    params: z.object({ name: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, "Channel name must be alphanumeric with dashes/underscores") }),
    body: { content: { "application/json": { schema: NotificationChannelConfigSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Channel saved",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "No configuration loaded",
    },
    500: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Failed to save",
    },
  },
});

const deleteChannelRoute = createRoute({
  method: "delete",
  path: "/channels/{name}",
  tags: ["Config"],
  summary: "Delete a notification channel",
  request: {
    params: z.object({ name: z.string().min(1) }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Channel deleted",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Channel or config not found",
    },
    500: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Failed to save",
    },
  },
});

const testChannelRoute = createRoute({
  method: "post",
  path: "/channels/{name}/test",
  tags: ["Config"],
  summary: "Test a notification channel",
  description: "Sends a test notification to verify the channel is correctly configured.",
  request: {
    params: z.object({ name: z.string().min(1) }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ success: z.boolean() }) }) } },
      description: "Test result",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Channel not found",
    },
  },
});

const listChannelsRoute = createRoute({
  method: "get",
  path: "/channels",
  tags: ["Config"],
  summary: "List notification channels",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Channel list",
    },
  },
});

// ── Authed route handlers ─────────────────────────────────────────────

/** Shared helper: read config from disk, apply a mutation, persist, reload, return updated config. */
function mutateConfig(
  orchestrator: Orchestrator,
  mutate: (fileConfig: ReturnType<typeof loadPolpoConfig> & {}) => void,
): { ok: true; config: NonNullable<ReturnType<Orchestrator["getConfig"]>> } | { ok: false; error: string; status: 404 | 500 } {
  const polpoDir = orchestrator.getPolpoDir();
  const fileConfig = loadPolpoConfig(polpoDir);
  if (!fileConfig) return { ok: false, error: "No configuration found on disk", status: 404 };

  mutate(fileConfig);

  try {
    savePolpoConfig(polpoDir, fileConfig);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, error: `Failed to save config: ${msg}`, status: 500 };
  }

  orchestrator.reloadConfig();
  return { ok: true, config: orchestrator.getConfig()! };
}

/**
 * Config management routes (requires orchestrator).
 * GET    /config              — return current config (redacted)
 * POST   /config/reload       — trigger a runtime config reload
 * PATCH  /config/settings     — partially update settings (persists + reloads)
 * GET    /config/channels     — list notification channels
 * PUT    /config/channels/:n  — create or update a channel
 * DELETE /config/channels/:n  — delete a channel
 * POST   /config/channels/:n/test — test a channel
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

  app.openapi(updateSettingsRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const body = c.req.valid("json");

    const result = mutateConfig(orchestrator, (fileConfig) => {
      const settings = fileConfig.settings ?? {} as any;
      if (body.orchestratorModel !== undefined) settings.orchestratorModel = body.orchestratorModel;
      if (body.imageModel !== undefined) settings.imageModel = body.imageModel === null ? undefined : body.imageModel;
      if (body.reasoning !== undefined) settings.reasoning = body.reasoning;
      fileConfig.settings = settings;
    });

    if (!result.ok) return c.json({ ok: false, error: result.error }, result.status);
    return c.json({ ok: true, data: redactPolpoConfig(result.config) }, 200);
  });

  // ── Channel CRUD ──

  app.openapi(listChannelsRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const config = orchestrator.getConfig();
    const channels = config?.settings?.notifications?.channels ?? {};
    return c.json({ ok: true, data: channels }, 200);
  });

  app.openapi(upsertChannelRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { name } = c.req.valid("param");
    const channelConfig = c.req.valid("json");

    const result = mutateConfig(orchestrator, (fileConfig) => {
      const settings = fileConfig.settings ?? {} as any;
      if (!settings.notifications) settings.notifications = { channels: {}, rules: [] };
      if (!settings.notifications.channels) settings.notifications.channels = {};
      settings.notifications.channels[name] = channelConfig;
      fileConfig.settings = settings;
    });

    if (!result.ok) return c.json({ ok: false, error: result.error }, result.status);
    return c.json({ ok: true, data: redactPolpoConfig(result.config) }, 200);
  });

  app.openapi(deleteChannelRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { name } = c.req.valid("param");

    // Check the channel exists before deleting
    const currentConfig = orchestrator.getConfig();
    const channels = currentConfig?.settings?.notifications?.channels;
    if (!channels || !(name in channels)) {
      return c.json({ ok: false, error: `Channel "${name}" not found` }, 404);
    }

    const result = mutateConfig(orchestrator, (fileConfig) => {
      const settings = fileConfig.settings ?? {} as any;
      if (settings.notifications?.channels) {
        delete settings.notifications.channels[name];
      }
      fileConfig.settings = settings;
    });

    if (!result.ok) return c.json({ ok: false, error: result.error }, result.status);
    return c.json({ ok: true, data: redactPolpoConfig(result.config) }, 200);
  });

  app.openapi(testChannelRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const { name } = c.req.valid("param");

    const notificationRouter = orchestrator.getNotificationRouter();
    if (!notificationRouter) {
      return c.json({ ok: false, error: "Notification system not initialized" }, 404);
    }

    const channelIds: string[] = notificationRouter.getChannelIds();
    if (!channelIds.includes(name)) {
      return c.json({ ok: false, error: `Channel "${name}" not found in runtime. Save and reload first.` }, 404);
    }

    try {
      const results = await notificationRouter.testChannels();
      return c.json({ ok: true, data: { success: results[name] ?? false } }, 200);
    } catch {
      return c.json({ ok: true, data: { success: false } }, 200);
    }
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

  // Guard against concurrent initialization
  let initializing = false;

  // POST /config/initialize
  app.openapi(initializeRoute, async (c: any) => {
    if (orchestrator.isInitialized) {
      return c.json({ ok: false, error: "Already initialized." }, 409);
    }
    if (initializing) {
      return c.json({ ok: false, error: "Initialization already in progress." }, 409);
    }

    initializing = true;
    try {
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

      try {
        savePolpoConfig(targetPolpoDir, config);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        return c.json({ ok: false, error: `Failed to save config: ${msg}` }, 500);
      }

      if (onInitialize) {
        await onInitialize(targetDir);
      }

      return c.json({
        ok: true,
        data: { message: "Setup complete! Dashboard is ready.", workDir: targetDir },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`[Config] Initialization failed: ${msg}`);
      return c.json({ ok: false, error: `Initialization failed: ${msg}` }, 500);
    } finally {
      initializing = false;
    }
  });

  return app;
}
