import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve, basename, join } from "node:path";
import { getPolpoDir } from "../../core/constants.js";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { redactPolpoConfig } from "../security.js";
import { loadPolpoConfig, savePolpoConfig, generatePolpoConfigDefault } from "../../core/config.js";
import { detectProviders } from "../../setup/index.js";
import { createCliStores } from "../../cli/stores.js";
import type { Orchestrator } from "../../core/orchestrator.js";
import { createInitialInstanceAuth, isInstanceAuthEnabled, loadInstanceAuth, normalizeEmail } from "../auth/instance-auth.js";

const MANAGED_LOGO_URL = "/api/v1/config/branding/logo";
const BRANDING_LOGO_TYPES: Record<string, { extension: string; contentType: string }> = {
  "image/png": { extension: "png", contentType: "image/png" },
  "image/jpeg": { extension: "jpg", contentType: "image/jpeg" },
  "image/webp": { extension: "webp", contentType: "image/webp" },
  "image/gif": { extension: "gif", contentType: "image/gif" },
};

function findManagedLogo(polpoDir: string): { path: string; contentType: string } | null {
  for (const logo of Object.values(BRANDING_LOGO_TYPES)) {
    const path = join(polpoDir, "branding", `logo.${logo.extension}`);
    if (existsSync(path)) return { path, contentType: logo.contentType };
  }
  return null;
}

function clearManagedLogos(polpoDir: string): void {
  for (const logo of Object.values(BRANDING_LOGO_TYPES)) {
    const path = join(polpoDir, "branding", `logo.${logo.extension}`);
    if (existsSync(path)) unlinkSync(path);
  }
}

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
              auth: z.object({
                enabled: z.boolean(),
                configured: z.boolean(),
              }),
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
            adminEmail: z.string().email().optional(),
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
    400: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), error: z.string() }),
        },
      },
      description: "Invalid setup request",
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

const uploadBrandingLogoRoute = createRoute({
  method: "post",
  path: "/instance-logo",
  tags: ["Config"],
  summary: "Upload the managed instance logo",
  request: {
    headers: z.object({ "content-type": z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Logo uploaded and configuration reloaded",
    },
    400: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Empty image",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "No configuration loaded",
    },
    413: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Image exceeds the size limit",
    },
    415: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Unsupported image type",
    },
    500: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Failed to persist configuration",
    },
  },
});

const deleteBrandingLogoRoute = createRoute({
  method: "delete",
  path: "/instance-logo",
  tags: ["Config"],
  summary: "Remove the managed instance logo",
  request: {
    headers: z.object({ "x-polpo-operation": z.string().optional() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Logo removed and configuration reloaded",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "No configuration loaded",
    },
    500: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Failed to persist configuration",
    },
  },
});

// ── Authed route handlers ─────────────────────────────────────────────

/** Shared helper: read config from disk, apply a mutation, persist, reload, return updated config. */
async function mutateConfig(
  deps: { getPolpoDir: () => string; reloadConfig: () => Promise<boolean>; getConfig: () => any },
  mutate: (fileConfig: ReturnType<typeof loadPolpoConfig> & {}) => void,
): Promise<{ ok: true; config: any } | { ok: false; error: string; status: 404 | 500 }> {
  const polpoDir = deps.getPolpoDir();
  const fileConfig = loadPolpoConfig(polpoDir);
  if (!fileConfig) return { ok: false, error: "No configuration found on disk", status: 404 };

  mutate(fileConfig);

  try {
    savePolpoConfig(polpoDir, fileConfig);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, error: `Failed to save config: ${msg}`, status: 500 };
  }

  await deps.reloadConfig();
  return { ok: true, config: deps.getConfig()! };
}

type BrandingConfigRouteDeps = {
  getConfig: () => any;
  reloadConfig: () => Promise<boolean>;
  getPolpoDir: () => string;
};

function registerBrandingConfigRoutes(
  app: OpenAPIHono,
  getDeps: () => BrandingConfigRouteDeps,
): void {
  app.openapi(uploadBrandingLogoRoute, async (c) => {
    const deps = getDeps();
    const contentType = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    const logoType = BRANDING_LOGO_TYPES[contentType];
    if (!logoType) {
      return c.json({ ok: false, error: "Logo must be a PNG, JPEG, WebP, or GIF image" }, 415);
    }
    const bytes = Buffer.from(await c.req.arrayBuffer());
    if (bytes.length === 0) return c.json({ ok: false, error: "Logo file is empty" }, 400);
    if (bytes.length > 4 * 1024 * 1024) return c.json({ ok: false, error: "Logo must be smaller than 4 MB" }, 413);

    const polpoDir = deps.getPolpoDir();
    const brandingDir = join(polpoDir, "branding");
    mkdirSync(brandingDir, { recursive: true });
    clearManagedLogos(polpoDir);
    writeFileSync(join(brandingDir, `logo.${logoType.extension}`), bytes);

    const result = await mutateConfig(deps, (fileConfig) => {
      const settings = fileConfig.settings ?? {} as any;
      settings.branding = { ...(settings.branding ?? {}), logoUrl: MANAGED_LOGO_URL };
      fileConfig.settings = settings;
    });
    if (!result.ok) {
      if (result.status === 404) return c.json({ ok: false, error: result.error }, 404);
      return c.json({ ok: false, error: result.error }, 500);
    }
    return c.json({ ok: true, data: redactPolpoConfig(result.config) }, 200);
  });

  app.openapi(deleteBrandingLogoRoute, async (c) => {
    const deps = getDeps();
    clearManagedLogos(deps.getPolpoDir());
    const result = await mutateConfig(deps, (fileConfig) => {
      const settings = fileConfig.settings ?? {} as any;
      settings.branding = { ...(settings.branding ?? {}) };
      delete settings.branding.logoUrl;
      fileConfig.settings = settings;
    });
    if (!result.ok) {
      if (result.status === 404) return c.json({ ok: false, error: result.error }, 404);
      return c.json({ ok: false, error: result.error }, 500);
    }
    return c.json({ ok: true, data: redactPolpoConfig(result.config) }, 200);
  });
}

export function brandingConfigRoutes(getDeps: () => BrandingConfigRouteDeps): OpenAPIHono {
  const app = new OpenAPIHono();
  registerBrandingConfigRoutes(app, getDeps);
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

  app.get("/branding", (c) => {
    const activeWorkDir = orchestrator.isInitialized ? orchestrator.getWorkDir() : workDir;
    const branding = loadPolpoConfig(getPolpoDir(activeWorkDir))?.settings?.branding ?? {};
    return c.json({ ok: true, data: branding });
  });

  app.get("/branding/logo", (c) => {
    const activeWorkDir = orchestrator.isInitialized ? orchestrator.getWorkDir() : workDir;
    const logo = findManagedLogo(getPolpoDir(activeWorkDir));
    if (!logo) return c.json({ ok: false, error: "No managed logo configured" }, 404);
    return new Response(readFileSync(logo.path), {
      headers: {
        "content-type": logo.contentType,
        "cache-control": "no-cache",
      },
    });
  });

  // GET /config/status
  app.openapi(configStatusRoute, (c) => {
    const activeWorkDir = orchestrator.isInitialized ? orchestrator.getWorkDir() : workDir;
    const activePolpoDir = getPolpoDir(activeWorkDir);
    const hasConfig = existsSync(join(activePolpoDir, "polpo.json"));
    const providers = detectProviders();
    const hasProviders = providers.some((p) => p.hasKey);
    const authConfig = loadInstanceAuth(activePolpoDir);

    return c.json({
      ok: true,
      data: {
        initialized: orchestrator.isInitialized,
        hasConfig,
        hasProviders,
        detectedProviders: providers,
        auth: {
          enabled: isInstanceAuthEnabled(),
          configured: !!authConfig?.enabled && authConfig.allowedEmails.length > 0,
        },
        workDir: activeWorkDir,
        orgName: basename(activeWorkDir),
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
      const targetPolpoDir = getPolpoDir(targetDir);
      const org = body.orgName || basename(targetDir);
      const adminEmail = typeof body.adminEmail === "string" ? normalizeEmail(body.adminEmail) : "";
      if (isInstanceAuthEnabled() && !adminEmail) {
        return c.json({ ok: false, error: "Admin email is required when instance auth is enabled." }, 400);
      }

      const config = generatePolpoConfigDefault(org, {
        model: body.model || undefined,
        agentName: body.agentName || undefined,
        agentRole: body.agentRole || undefined,
        providers: body.providers,
      });
      const teams = config.teams;

      try {
        // polpo.json carries only project/settings/providers — teams live in
        // the configured store (sqlite by default). Strip teams before save.
        savePolpoConfig(targetPolpoDir, { ...config, teams: [] });
        // Honour storage backend (sqlite / postgres / file) for the seed.
        // Previously this hardcoded FileTeamStore/FileAgentStore, which on a
        // sqlite project silently wrote agents.json/teams.json that nobody
        // reads at runtime — losing the wizard's agentName/agentRole input.
        const { teamStore, agentStore } = await createCliStores(targetPolpoDir);
        await teamStore.seed(teams);
        await agentStore.seed(teams.flatMap((team) =>
          team.agents.map((agent) => ({ ...agent, teamName: team.name })),
        ));
        if (isInstanceAuthEnabled() && adminEmail) {
          createInitialInstanceAuth(targetPolpoDir, adminEmail);
        }
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
