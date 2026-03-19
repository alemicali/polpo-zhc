import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { redactPolpoConfig } from "../security.js";
import { UpdateSettingsSchema, NotificationChannelConfigSchema } from "../schemas.js";

// ── Route definitions ──────────────────────────────────────────────

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

const updateSettingsRoute = createRoute({
  method: "patch",
  path: "/settings",
  tags: ["Config"],
  summary: "Update orchestrator settings",
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

const upsertChannelRoute = createRoute({
  method: "put",
  path: "/channels/{name}",
  tags: ["Config"],
  summary: "Create or update a notification channel",
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

// ── Route handlers ─────────────────────────────────────────────────

/**
 * Config management routes.
 * Uses ConfigStore via deps for persistence — no direct filesystem access.
 */
export function configRoutes(getDeps: () => {
  getConfig: () => any;
  reloadConfig: () => Promise<boolean>;
  /** Save a modified config. Replaces loadPolpoConfig/savePolpoConfig coupling. */
  saveConfig: (config: any) => Promise<void>;
  getNotificationRouter: () => any;
}): OpenAPIHono {
  const app = new OpenAPIHono();

  /** Read config, apply mutation, save, reload, return updated. */
  async function mutateConfig(
    deps: ReturnType<typeof getDeps>,
    mutate: (config: any) => void,
  ): Promise<{ ok: true; config: any } | { ok: false; error: string; status: 404 | 500 }> {
    const config = deps.getConfig();
    if (!config) return { ok: false, error: "No configuration loaded", status: 404 };

    // Deep clone to avoid mutating the live config before save
    const clone = JSON.parse(JSON.stringify(config));
    mutate(clone);

    try {
      await deps.saveConfig(clone);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return { ok: false, error: `Failed to save config: ${msg}`, status: 500 };
    }

    await deps.reloadConfig();
    return { ok: true, config: deps.getConfig()! };
  }

  app.openapi(reloadConfigRoute, async (c) => {
    const deps = getDeps();
    const success = await deps.reloadConfig();
    if (success) {
      return c.json({ ok: true, data: { message: "Configuration reloaded successfully" } }, 200);
    }
    return c.json({ ok: false, error: "Failed to reload configuration" }, 500);
  });

  app.openapi(getConfigRoute, (c) => {
    const deps = getDeps();
    const config = deps.getConfig();
    if (!config) {
      return c.json({ ok: false, error: "No configuration loaded" }, 404);
    }
    return c.json({ ok: true, data: redactPolpoConfig(config) }, 200);
  });

  app.openapi(updateSettingsRoute, async (c) => {
    const deps = getDeps();
    const body = c.req.valid("json");

    const result = await mutateConfig(deps, (config) => {
      const settings = config.settings ?? {};
      if (body.orchestratorModel !== undefined) settings.orchestratorModel = body.orchestratorModel;
      if (body.imageModel !== undefined) settings.imageModel = body.imageModel === null ? undefined : body.imageModel;
      if (body.reasoning !== undefined) settings.reasoning = body.reasoning;
      config.settings = settings;
    });

    if (!result.ok) return c.json({ ok: false, error: result.error }, result.status);
    return c.json({ ok: true, data: redactPolpoConfig(result.config) }, 200);
  });

  // ── Channel CRUD ──

  app.openapi(listChannelsRoute, (c) => {
    const deps = getDeps();
    const config = deps.getConfig();
    const channels = config?.settings?.notifications?.channels ?? {};
    return c.json({ ok: true, data: channels }, 200);
  });

  app.openapi(upsertChannelRoute, async (c) => {
    const deps = getDeps();
    const { name } = c.req.valid("param");
    const channelConfig = c.req.valid("json");

    const result = await mutateConfig(deps, (config) => {
      const settings = config.settings ?? {};
      if (!settings.notifications) settings.notifications = { channels: {}, rules: [] };
      if (!settings.notifications.channels) settings.notifications.channels = {};
      settings.notifications.channels[name] = channelConfig;
      config.settings = settings;
    });

    if (!result.ok) return c.json({ ok: false, error: result.error }, result.status);
    return c.json({ ok: true, data: redactPolpoConfig(result.config) }, 200);
  });

  app.openapi(deleteChannelRoute, async (c) => {
    const deps = getDeps();
    const { name } = c.req.valid("param");

    const currentConfig = deps.getConfig();
    const channels = currentConfig?.settings?.notifications?.channels;
    if (!channels || !(name in channels)) {
      return c.json({ ok: false, error: `Channel "${name}" not found` }, 404);
    }

    const result = await mutateConfig(deps, (config) => {
      const settings = config.settings ?? {};
      if (settings.notifications?.channels) {
        delete settings.notifications.channels[name];
      }
      config.settings = settings;
    });

    if (!result.ok) return c.json({ ok: false, error: result.error }, result.status);
    return c.json({ ok: true, data: redactPolpoConfig(result.config) }, 200);
  });

  app.openapi(testChannelRoute, async (c) => {
    const deps = getDeps();
    const { name } = c.req.valid("param");

    const notificationRouter = deps.getNotificationRouter();
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
