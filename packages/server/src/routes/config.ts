import { daytonaProviderErrors, normalizeSandboxSettings } from "@polpo-ai/core/sandbox";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { redactPolpoConfig, redactSecrets, restoreRedactedSecrets } from "../security.js";
import { UnrestorableSecretError } from "@polpo-ai/core/secret-redaction";
import { computerEgressProblem, isEmptyAppearance, parseAppearanceSettings, parseComputers, parseEgressProxies, parseTailscaleSettings, type AppearanceSettings, type TailscaleSettings } from "@polpo-ai/core";
import {
  UpdateSettingsSchema,
  PLAIN_SETTINGS_KEYS,
  NotificationChannelConfigSchema,
  StoredNotificationChannelConfigSchema,
  UpsertNotificationRuleSchema,
  UpsertApprovalGateSchema,
} from "../schemas.js";

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
    400: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Invalid settings (e.g. an egress proxy)",
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
    400: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Invalid channel config (or a masked secret that cannot be restored)",
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

// ── Notification rule routes ──

const upsertRuleRoute = createRoute({
  method: "put",
  path: "/rules/{id}",
  tags: ["Config"],
  summary: "Create or update a notification rule",
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: { content: { "application/json": { schema: UpsertNotificationRuleSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Rule saved",
    },
    400: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "The id in the body does not match the URL",
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

const deleteRuleRoute = createRoute({
  method: "delete",
  path: "/rules/{id}",
  tags: ["Config"],
  summary: "Delete a notification rule",
  request: {
    params: z.object({ id: z.string().min(1) }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Rule deleted",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Rule or config not found",
    },
    500: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Failed to save",
    },
  },
});

// ── Approval gate routes ──

const upsertGateRoute = createRoute({
  method: "put",
  path: "/gates/{id}",
  tags: ["Config"],
  summary: "Create or update an approval gate",
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: { content: { "application/json": { schema: UpsertApprovalGateSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Gate saved",
    },
    400: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "The id in the body does not match the URL",
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

const deleteGateRoute = createRoute({
  method: "delete",
  path: "/gates/{id}",
  tags: ["Config"],
  summary: "Delete an approval gate",
  request: {
    params: z.object({ id: z.string().min(1) }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Gate deleted",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Gate or config not found",
    },
    500: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Failed to save",
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
    // Daytona API version and options (v2: no API URL): refused before anything is saved
    if (body.sandbox && typeof body.sandbox === "object") {
      const errors = daytonaProviderErrors((body.sandbox as { providers?: { daytona?: unknown } }).providers?.daytona);
      if (errors.length) return c.json({ ok: false, error: errors.join("; ") }, 400);
    }
    let egressProxies: Record<string, string> | null | undefined;
    if (body.egressProxies !== undefined) {
      try {
        egressProxies = body.egressProxies === null ? null : parseEgressProxies(body.egressProxies);
      } catch (err) {
        return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
    // the dashboard's default look: colours, font stack and radius checked
    let appearance: AppearanceSettings | null | undefined;
    if (body.appearance !== undefined) {
      try {
        appearance = body.appearance === null ? null : parseAppearanceSettings(body.appearance);
      } catch (err) {
        return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
    // Tailscale in remote computers: the auth key only as a vault reference
    let tailscale: TailscaleSettings | null | undefined;
    if (body.tailscale !== undefined) {
      try {
        tailscale = body.tailscale === null ? null : parseTailscaleSettings(body.tailscale);
      } catch (err) {
        return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
    // remote computers going out through a proxy must still be able to (Tailscale, a tailnet SOCKS5 proxy)
    if (egressProxies !== undefined || tailscale !== undefined) {
      const current = deps.getConfig()?.settings;
      const next = {
        egressProxies: egressProxies === undefined ? current?.egressProxies : egressProxies ?? undefined,
        tailscale: tailscale === undefined ? current?.tailscale : tailscale ?? undefined,
      };
      let computers: ReturnType<typeof parseComputers> = [];
      try { computers = parseComputers(current?.computers); } catch { /* invalid computers are reported where they are edited */ }
      const problems = computers.filter((x) => x.kind !== "host").map((x) => computerEgressProblem(x, next)).filter((p): p is string => !!p);
      if (problems.length) return c.json({ ok: false, error: `${problems.join("; ")}. Change the computer's egress first.` }, 400);
    }

    const result = await mutateConfig(deps, (config) => {
      const settings = config.settings ?? {};
      if (egressProxies !== undefined) settings.egressProxies = egressProxies === null || Object.keys(egressProxies).length === 0 ? undefined : egressProxies;
      if (tailscale !== undefined) settings.tailscale = tailscale === null ? undefined : tailscale;
      if (body.orchestratorModel !== undefined) settings.orchestratorModel = body.orchestratorModel;
      // the orchestrator's display name: null or "" goes back to the default ("Polpo")
      if (body.orchestratorName !== undefined) {
        if (body.orchestratorName) settings.orchestratorName = body.orchestratorName;
        else delete settings.orchestratorName;
      }
      if (body.imageModel !== undefined) settings.imageModel = body.imageModel === null ? undefined : body.imageModel;
      if (body.reasoning !== undefined) settings.reasoning = body.reasoning;
      if (body.sandbox !== undefined) settings.sandbox = body.sandbox === null ? undefined : normalizeSandboxSettings(body.sandbox);
      if (body.compaction !== undefined) settings.compaction = body.compaction === null ? undefined : body.compaction;
      if (body.tools !== undefined) settings.tools = body.tools === null || Object.keys(body.tools).length === 0 ? undefined : body.tools;
      // Polpo's MCP server settings merge: the keys given change (toolsets, keys)
      if (body.mcp === null) delete settings.mcp;
      else if (body.mcp !== undefined) {
        const mcp: Record<string, unknown> = { ...(settings.mcp ?? {}), ...body.mcp };
        settings.mcp = Object.keys(mcp).length ? mcp : undefined;
      }
      for (const key of PLAIN_SETTINGS_KEYS) {
        const value = (body as Record<string, unknown>)[key];
        if (value === undefined) continue;
        if (value === null) delete settings[key];
        else settings[key] = value;
      }
      if (appearance !== undefined) settings.appearance = appearance === null || isEmptyAppearance(appearance) ? undefined : appearance;
      if (body.branding !== undefined) {
        // only the fields given change; an empty string restores the default
        const branding: Record<string, string | undefined> = { ...(settings.branding ?? {}) };
        for (const key of ["productName", "tagline", "logoUrl", "logoDarkUrl", "logoFrame"] as const) {
          const value = body.branding[key];
          if (value === undefined) continue;
          if (value === "") delete branding[key];
          else branding[key] = value;
        }
        settings.branding = Object.keys(branding).some((k) => branding[k] !== undefined) ? branding : undefined;
      }
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
    return c.json({ ok: true, data: redactSecrets(channels) }, 200);
  });

  app.openapi(upsertChannelRoute, async (c) => {
    const deps = getDeps();
    const { name } = c.req.valid("param");
    const incoming = c.req.valid("json");

    // Clients read channels redacted ("••••1234"): restore the stored secret
    // wherever the incoming value is still the masked placeholder, THEN
    // validate the result as a stored channel. A masked value with nothing
    // stored under this name (e.g. a renamed channel) is a client error.
    const storedChannel = deps.getConfig()?.settings?.notifications?.channels?.[name];
    let channelConfig: unknown;
    try {
      // Fields that decide where the channel's secrets are sent: if any of
      // them changes, saved secrets (headers, tokens, keys) are not reused.
      channelConfig = restoreRedactedSecrets(incoming, storedChannel, {
        strict: true,
        destinationKeys: ["type", "url", "webhookUrl", "host", "port", "provider"],
      });
    } catch (err) {
      if (err instanceof UnrestorableSecretError) return c.json({ ok: false, error: err.message }, 400);
      throw err;
    }
    const checked = StoredNotificationChannelConfigSchema.safeParse(channelConfig);
    if (!checked.success) {
      return c.json({ ok: false, error: `Invalid channel config: ${checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` }, 400);
    }

    const result = await mutateConfig(deps, (config) => {
      const settings = config.settings ?? {};
      if (!settings.notifications) settings.notifications = { channels: {}, rules: [] };
      if (!settings.notifications.channels) settings.notifications.channels = {};
      settings.notifications.channels[name] = checked.data;
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
      if (typeof notificationRouter.testChannel === "function") {
        const result = await notificationRouter.testChannel(name);
        return c.json({ ok: true, data: result }, 200);
      }
      const results = await notificationRouter.testChannels();
      return c.json({ ok: true, data: { success: results[name] ?? false } }, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Channel test failed";
      return c.json({ ok: true, data: { success: false, error: msg } }, 200);
    }
  });

  // ── Notification rule CRUD ──

  app.openapi(upsertRuleRoute, async (c) => {
    const deps = getDeps();
    const { id } = c.req.valid("param");
    const ruleBody = c.req.valid("json");
    if (ruleBody.id !== id) {
      return c.json({ ok: false, error: "Rule id in body must match URL param" }, 400);
    }

    const result = await mutateConfig(deps, (config) => {
      const settings = config.settings ?? {};
      if (!settings.notifications) settings.notifications = { channels: {}, rules: [] };
      if (!Array.isArray(settings.notifications.rules)) settings.notifications.rules = [];
      const rules: any[] = settings.notifications.rules;
      const idx = rules.findIndex((r) => r?.id === id);
      if (idx === -1) rules.push(ruleBody);
      else rules[idx] = ruleBody;
      config.settings = settings;
    });

    if (!result.ok) return c.json({ ok: false, error: result.error }, result.status);
    return c.json({ ok: true, data: redactPolpoConfig(result.config) }, 200);
  });

  app.openapi(deleteRuleRoute, async (c) => {
    const deps = getDeps();
    const { id } = c.req.valid("param");

    const currentConfig = deps.getConfig();
    const rules: any[] | undefined = currentConfig?.settings?.notifications?.rules;
    if (!rules || !rules.some((r) => r?.id === id)) {
      return c.json({ ok: false, error: `Rule "${id}" not found` }, 404);
    }

    const result = await mutateConfig(deps, (config) => {
      const settings = config.settings ?? {};
      if (settings.notifications?.rules) {
        settings.notifications.rules = settings.notifications.rules.filter(
          (r: any) => r?.id !== id,
        );
      }
      config.settings = settings;
    });

    if (!result.ok) return c.json({ ok: false, error: result.error }, result.status);
    return c.json({ ok: true, data: redactPolpoConfig(result.config) }, 200);
  });

  // ── Approval gate CRUD ──

  app.openapi(upsertGateRoute, async (c) => {
    const deps = getDeps();
    const { id } = c.req.valid("param");
    const gateBody = c.req.valid("json");
    if (gateBody.id !== id) {
      return c.json({ ok: false, error: "Gate id in body must match URL param" }, 400);
    }

    const result = await mutateConfig(deps, (config) => {
      const settings = config.settings ?? {};
      if (!Array.isArray(settings.approvalGates)) settings.approvalGates = [];
      const gates: any[] = settings.approvalGates;
      const idx = gates.findIndex((g) => g?.id === id);
      if (idx === -1) gates.push(gateBody);
      else gates[idx] = gateBody;
      config.settings = settings;
    });

    if (!result.ok) return c.json({ ok: false, error: result.error }, result.status);
    return c.json({ ok: true, data: redactPolpoConfig(result.config) }, 200);
  });

  app.openapi(deleteGateRoute, async (c) => {
    const deps = getDeps();
    const { id } = c.req.valid("param");

    const currentConfig = deps.getConfig();
    const gates: any[] | undefined = currentConfig?.settings?.approvalGates;
    if (!gates || !gates.some((g) => g?.id === id)) {
      return c.json({ ok: false, error: `Gate "${id}" not found` }, 404);
    }

    const result = await mutateConfig(deps, (config) => {
      const settings = config.settings ?? {};
      if (Array.isArray(settings.approvalGates)) {
        settings.approvalGates = settings.approvalGates.filter((g: any) => g?.id !== id);
      }
      config.settings = settings;
    });

    if (!result.ok) return c.json({ ok: false, error: result.error }, result.status);
    return c.json({ ok: true, data: redactPolpoConfig(result.config) }, 200);
  });

  return app;
}
