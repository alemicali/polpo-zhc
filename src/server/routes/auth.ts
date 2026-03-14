/**
 * Auth REST API — read-only access to OAuth profile metadata.
 *
 * GET /auth/status — Per-provider auth health overview
 *
 * NEVER exposes access tokens or refresh tokens.
 * Only safe metadata: provider, type, email, expiry, usage stats.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { PROVIDER_ENV_MAP } from "../../llm/pi-client.js";

export function authRoutes(getDeps: () => {
  getConfig: () => any;
}): OpenAPIHono {
  const app = new OpenAPIHono();

  // GET /auth/status — full auth status per provider
  const statusRoute = createRoute({
    method: "get",
    path: "/status",
    tags: ["Auth"],
    summary: "Auth status",
    description:
      "Returns per-provider auth health: config key, env var, OAuth profiles (metadata only — tokens never exposed), cooldown/billing status.",
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              ok: z.boolean(),
              data: z.object({
                providers: z.record(
                  z.string(),
                  z.object({
                    hasEnvKey: z.boolean(),
                    envVar: z.string().optional(),
                    profiles: z.array(
                      z.object({
                        id: z.string(),
                        type: z.enum(["oauth", "api_key"]),
                        email: z.string().optional(),
                        expires: z.number().optional(),
                        expired: z.boolean(),
                        hasRefresh: z.boolean(),
                        lastUsed: z.string().optional(),
                        createdAt: z.string(),
                        status: z.enum(["active", "cooldown", "billing_disabled", "expired"]),
                        cooldownUntil: z.number().optional(),
                        disabledUntil: z.number().optional(),
                        lastErrorReason: z.string().optional(),
                        disabledReason: z.string().optional(),
                        errorCount: z.number().optional(),
                      }),
                    ),
                    oauthAvailable: z.boolean(),
                    oauthProviderName: z.string().optional(),
                    oauthFlow: z.string().optional(),
                  }),
                ),
              }),
            }),
          },
        },
        description: "Auth status per provider",
      },
    },
  });

  app.openapi(statusRoute, async (c) => {
    const deps = getDeps();
    const config = deps.getConfig();
    const configProviders = config?.providers ?? {};

    // Dynamic import auth store (auth is optional — may not be installed in all envs)
    let getAllProfiles: (() => { id: string; profile: { provider: string; type: string; email?: string; expires?: number; refresh?: string; lastUsed?: string; createdAt: string } }[]) | undefined;
    let getUsageStats: ((id: string) => { lastUsed?: number; cooldownUntil?: number; errorCount?: number; lastErrorReason?: string; disabledUntil?: number; disabledReason?: string } | undefined) | undefined;
    let OAUTH_PROVIDERS: { id: string; name: string; flow: string }[] = [];

    try {
      const authStore = await import("../../auth/store.js");
      const authTypes = await import("../../auth/types.js");
      getAllProfiles = authStore.getAllProfiles;
      getUsageStats = authStore.getUsageStats;
      OAUTH_PROVIDERS = authTypes.OAUTH_PROVIDERS;
    } catch {
      // Auth module not available — continue without profiles
    }

    const now = Date.now();
    const allProfiles = getAllProfiles?.() ?? [];

    // Group profiles by provider
    const profilesByProvider = new Map<string, typeof allProfiles>();
    for (const entry of allProfiles) {
      const provider = entry.profile.provider;
      const list = profilesByProvider.get(provider) ?? [];
      list.push(entry);
      profilesByProvider.set(provider, list);
    }

    // Collect all relevant provider names
    const allProviderNames = new Set<string>();
    for (const name of Object.keys(configProviders)) allProviderNames.add(name);
    for (const name of Object.keys(PROVIDER_ENV_MAP)) allProviderNames.add(name);
    for (const name of profilesByProvider.keys()) allProviderNames.add(name);

    type ProfileStatus = "active" | "cooldown" | "billing_disabled" | "expired";
    type ProfileType = "oauth" | "api_key";

    interface ProfileMeta {
      id: string;
      type: ProfileType;
      email?: string;
      expires?: number;
      expired: boolean;
      hasRefresh: boolean;
      lastUsed?: string;
      createdAt: string;
      status: ProfileStatus;
      cooldownUntil?: number;
      disabledUntil?: number;
      lastErrorReason?: string;
      disabledReason?: string;
      errorCount?: number;
    }

    interface ProviderAuthInfo {
      hasEnvKey: boolean;
      envVar?: string;
      profiles: ProfileMeta[];
      oauthAvailable: boolean;
      oauthProviderName?: string;
      oauthFlow?: string;
    }

    // Build status per provider
    const providers: Record<string, ProviderAuthInfo> = {};

    for (const name of allProviderNames) {
      const envVar = PROVIDER_ENV_MAP[name];
      const hasEnvKey = envVar ? !!process.env[envVar] : false;
      const providerProfiles = profilesByProvider.get(name) ?? [];
      const oauthInfo = OAUTH_PROVIDERS.find((p) => p.id === name);

      const profiles = providerProfiles.map((entry) => {
        const p = entry.profile;
        const stats = getUsageStats?.(entry.id);
        const expired = p.expires ? now >= p.expires : false;
        const inCooldown = stats?.cooldownUntil ? now < stats.cooldownUntil : false;
        const billingDisabled = stats?.disabledUntil ? now < stats.disabledUntil : false;

        const status = billingDisabled ? "billing_disabled" as const
          : inCooldown ? "cooldown" as const
          : (expired && !p.refresh) ? "expired" as const
          : "active" as const;

        return {
          id: entry.id,
          type: p.type as "oauth" | "api_key",
          email: p.email,
          expires: p.expires,
          expired,
          hasRefresh: !!p.refresh,
          lastUsed: p.lastUsed,
          createdAt: p.createdAt,
          status,
          cooldownUntil: inCooldown ? stats!.cooldownUntil : undefined,
          disabledUntil: billingDisabled ? stats!.disabledUntil : undefined,
          lastErrorReason: stats?.lastErrorReason,
          disabledReason: stats?.disabledReason,
          errorCount: stats?.errorCount,
        };
      });

      // Only include providers that have at least one of: env key, profiles, or oauth support
      if (hasEnvKey || profiles.length > 0 || oauthInfo) {
        providers[name] = {
          hasEnvKey,
          envVar,
          profiles,
          oauthAvailable: !!oauthInfo,
          oauthProviderName: oauthInfo?.name,
          oauthFlow: oauthInfo?.flow,
        };
      }
    }

    return c.json({ ok: true, data: { providers } }, 200);
  });

  return app;
}
