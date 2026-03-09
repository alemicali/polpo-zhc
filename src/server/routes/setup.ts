import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { loadPolpoConfig, savePolpoConfig, generatePolpoConfigDefault } from "../../core/config.js";
import { PROVIDER_ENV_MAP, listModels } from "../../llm/pi-client.js";

// ── Route definitions ─────────────────────────────────────────────────

const getSetupStatusRoute = createRoute({
  method: "get",
  path: "/status",
  tags: ["Setup"],
  summary: "Check if Polpo is configured",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            data: z.object({
              needsSetup: z.boolean(),
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
      description: "Setup status",
    },
  },
});

const getProvidersRoute = createRoute({
  method: "get",
  path: "/providers",
  tags: ["Setup"],
  summary: "List available LLM providers",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            data: z.array(z.object({
              name: z.string(),
              envVar: z.string(),
              hasKey: z.boolean(),
            })),
          }),
        },
      },
      description: "Available providers",
    },
  },
});

const getModelsRoute = createRoute({
  method: "get",
  path: "/models",
  tags: ["Setup"],
  summary: "List available models for a provider",
  request: {
    query: z.object({
      provider: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            data: z.array(z.any()),
          }),
        },
      },
      description: "Available models",
    },
  },
});

const saveApiKeyRoute = createRoute({
  method: "post",
  path: "/api-key",
  tags: ["Setup"],
  summary: "Save an API key for a provider",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            provider: z.string(),
            apiKey: z.string(),
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
      description: "API key saved",
    },
    400: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), error: z.string() }),
        },
      },
      description: "Invalid provider",
    },
  },
});

const saveConfigRoute = createRoute({
  method: "post",
  path: "/complete",
  tags: ["Setup"],
  summary: "Complete setup — save config and restart orchestrator",
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
      description: "Setup complete",
    },
  },
});

// OAuth routes (not OpenAPI — simpler for the stateful flow)

const oauthStartRoute = createRoute({
  method: "post",
  path: "/oauth/start",
  tags: ["Setup"],
  summary: "Start an OAuth login flow",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ provider: z.string() }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            data: z.object({ flowId: z.string() }),
          }),
        },
      },
      description: "OAuth flow started",
    },
    400: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), error: z.string() }),
        },
      },
      description: "Invalid provider",
    },
  },
});

const oauthStatusRoute = createRoute({
  method: "get",
  path: "/oauth/status/{flowId}",
  tags: ["Setup"],
  summary: "Check OAuth flow status",
  request: {
    params: z.object({ flowId: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            data: z.object({
              status: z.string(),
              authUrl: z.string().optional(),
              instructions: z.string().optional(),
              promptMessage: z.string().optional(),
              promptPlaceholder: z.string().optional(),
              progressMessage: z.string().optional(),
              profileId: z.string().optional(),
              error: z.string().optional(),
            }),
          }),
        },
      },
      description: "OAuth flow status",
    },
    404: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), error: z.string() }),
        },
      },
      description: "Flow not found",
    },
  },
});

const oauthInputRoute = createRoute({
  method: "post",
  path: "/oauth/input/{flowId}",
  tags: ["Setup"],
  summary: "Send user input for an OAuth flow",
  request: {
    params: z.object({ flowId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ value: z.string() }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean() }),
        },
      },
      description: "Input received",
    },
    404: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), error: z.string() }),
        },
      },
      description: "Flow not found",
    },
  },
});

const oauthProvidersRoute = createRoute({
  method: "get",
  path: "/oauth/providers",
  tags: ["Setup"],
  summary: "List available OAuth providers",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            data: z.array(z.object({
              id: z.string(),
              name: z.string(),
              flow: z.string(),
              free: z.boolean(),
            })),
          }),
        },
      },
      description: "OAuth providers",
    },
  },
});

// ── .env persistence ────────────────────────────────────────────────

function persistToEnvFile(polpoDir: string, envVar: string, value: string): void {
  if (!existsSync(polpoDir)) mkdirSync(polpoDir, { recursive: true });
  const envPath = join(polpoDir, ".env");

  let content = "";
  if (existsSync(envPath)) {
    content = readFileSync(envPath, "utf-8");
    const regex = new RegExp(`^${envVar}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${envVar}=${value}`);
      writeFileSync(envPath, content, "utf-8");
      try { chmodSync(envPath, 0o600); } catch { /* best-effort */ }
      return;
    }
  }

  const line = `${envVar}=${value}\n`;
  writeFileSync(envPath, content ? `${content.trimEnd()}\n${line}` : line, "utf-8");
  try { chmodSync(envPath, 0o600); } catch { /* best-effort */ }
}

// ── Provider detection ──────────────────────────────────────────────

/** Check which providers have stored OAuth profiles */
function getOAuthProviders(): Set<string> {
  const oauthProviders = new Set<string>();
  try {
    const dir = process.env.POLPO_STATE_DIR || join(homedir(), ".polpo");
    const raw = readFileSync(join(dir, "auth-profiles.json"), "utf-8");
    const data = JSON.parse(raw);
    if (data?.profiles && typeof data.profiles === "object") {
      for (const profile of Object.values(data.profiles)) {
        if ((profile as any)?.provider) {
          oauthProviders.add((profile as any).provider);
        }
      }
    }
  } catch {
    // No profiles file — that's fine
  }
  return oauthProviders;
}

function detectProviders(): Array<{ name: string; envVar: string; hasKey: boolean; source: string }> {
  const oauthProviders = getOAuthProviders();
  return Object.entries(PROVIDER_ENV_MAP)
    // Deduplicate by env var (e.g. openai and openai-codex share OPENAI_API_KEY)
    .filter(([, envVar], idx, arr) => arr.findIndex(([, ev]) => ev === envVar) === idx)
    .map(([name, envVar]) => {
      const hasEnvKey = !!process.env[envVar];
      const hasOAuth = oauthProviders.has(name);
      return {
        name,
        envVar,
        hasKey: hasEnvKey || hasOAuth,
        source: hasEnvKey ? "env" : hasOAuth ? "oauth" : "none",
      };
    });
}

// ── OAuth flow state ────────────────────────────────────────────────

interface OAuthFlowState {
  provider: string;
  status: "pending" | "awaiting_browser" | "awaiting_input" | "in_progress" | "complete" | "error";
  authUrl?: string;
  instructions?: string;
  promptMessage?: string;
  promptPlaceholder?: string;
  progressMessage?: string;
  profileId?: string;
  error?: string;
  // Resolver for onPrompt — called when user sends input
  promptResolve?: (value: string) => void;
}

const oauthFlows = new Map<string, OAuthFlowState>();

// Clean up stale flows after 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, flow] of oauthFlows) {
    if (flow.status === "complete" || flow.status === "error") {
      oauthFlows.delete(id);
    }
  }
}, 600_000);

// ── Route handlers ──────────────────────────────────────────────────

/**
 * Setup routes — no auth required.
 * Used by the dashboard setup wizard for first-time configuration.
 */
export function setupRoutes(workDir: string, onSetupComplete?: (workDir: string) => Promise<void>): OpenAPIHono {
  const app = new OpenAPIHono();
  const polpoDir = resolve(workDir, ".polpo");

  // GET /setup/status — check if configured
  app.openapi(getSetupStatusRoute, (c) => {
    const hasConfig = existsSync(join(polpoDir, "polpo.json"));
    const providers = detectProviders();
    const hasProviders = providers.some((p) => p.hasKey);

    return c.json({
      ok: true,
      data: {
        needsSetup: !hasConfig,
        hasConfig,
        hasProviders,
        detectedProviders: providers,
        workDir,
        orgName: basename(workDir),
      },
    });
  });

  // GET /setup/providers — list all providers with key status
  app.openapi(getProvidersRoute, (c) => {
    return c.json({ ok: true, data: detectProviders() });
  });

  // GET /setup/models?provider=xxx — list models
  app.openapi(getModelsRoute, (c) => {
    const provider = c.req.query("provider");
    const models = listModels(provider || undefined)
      .sort((a, b) => a.cost.input - b.cost.input);
    return c.json({ ok: true, data: models });
  });

  // POST /setup/api-key — save an API key
  app.openapi(saveApiKeyRoute, (c: any) => {
    const { provider, apiKey } = c.req.valid("json");
    const envVar = PROVIDER_ENV_MAP[provider];
    if (!envVar) {
      return c.json({ ok: false, error: `Unknown provider: ${provider}` }, 400);
    }

    // Set in current process
    process.env[envVar] = apiKey;
    // Persist to .polpo/.env
    persistToEnvFile(polpoDir, envVar, apiKey);

    return c.json({ ok: true, data: { message: `${envVar} saved to .polpo/.env` } });
  });

  // GET /setup/oauth/providers — list OAuth providers with free/paid info
  app.openapi(oauthProvidersRoute, async (c) => {
    const { OAUTH_PROVIDERS } = await import("../../auth/types.js");
    const freeProviders = ["google-antigravity", "google-gemini-cli"];
    return c.json({
      ok: true,
      data: OAUTH_PROVIDERS.map((p) => ({
        id: p.id,
        name: p.name,
        flow: p.flow,
        free: freeProviders.includes(p.id),
      })),
    });
  });

  // POST /setup/oauth/start — start an OAuth login flow
  app.openapi(oauthStartRoute, async (c: any) => {
    const { provider } = c.req.valid("json");
    const { OAUTH_PROVIDERS } = await import("../../auth/types.js");
    const match = OAUTH_PROVIDERS.find((p: { id: string }) => p.id === provider);
    if (!match) {
      return c.json({ ok: false, error: `Unknown OAuth provider: ${provider}` }, 400);
    }

    const flowId = randomUUID();
    const flow: OAuthFlowState = { provider, status: "pending" };
    oauthFlows.set(flowId, flow);

    // Start OAuth in background
    (async () => {
      try {
        const { oauthLogin } = await import("../../auth/index.js");
        type OAuthProviderName = Parameters<typeof oauthLogin>[0];

        const profileId = await oauthLogin(provider as OAuthProviderName, {
          onAuthUrl: (url: string, instructions?: string) => {
            flow.authUrl = url;
            flow.instructions = instructions;
            flow.status = "awaiting_browser";
          },
          onPrompt: (message: string, placeholder?: string): Promise<string> => {
            flow.promptMessage = message;
            flow.promptPlaceholder = placeholder;
            flow.status = "awaiting_input";
            // Wait for user input via the /oauth/input endpoint
            return new Promise<string>((resolve) => {
              flow.promptResolve = resolve;
            });
          },
          onProgress: (message: string) => {
            flow.progressMessage = message;
            if (flow.status === "awaiting_browser") {
              flow.status = "in_progress";
            }
          },
        });

        flow.profileId = profileId;
        flow.status = "complete";
      } catch (err: unknown) {
        flow.error = err instanceof Error ? err.message : "Unknown error";
        flow.status = "error";
      }
    })();

    return c.json({ ok: true, data: { flowId } });
  });

  // GET /setup/oauth/status/:flowId — poll flow status
  app.openapi(oauthStatusRoute, (c: any) => {
    const { flowId } = c.req.valid("param");
    const flow = oauthFlows.get(flowId);
    if (!flow) {
      return c.json({ ok: false, error: "Flow not found" }, 404);
    }

    return c.json({
      ok: true,
      data: {
        status: flow.status,
        authUrl: flow.authUrl,
        instructions: flow.instructions,
        promptMessage: flow.promptMessage,
        promptPlaceholder: flow.promptPlaceholder,
        progressMessage: flow.progressMessage,
        profileId: flow.profileId,
        error: flow.error,
      },
    });
  });

  // POST /setup/oauth/input/:flowId — send user input
  app.openapi(oauthInputRoute, (c: any) => {
    const { flowId } = c.req.valid("param");
    const { value } = c.req.valid("json");
    const flow = oauthFlows.get(flowId);
    if (!flow) {
      return c.json({ ok: false, error: "Flow not found" }, 404);
    }

    if (flow.promptResolve) {
      flow.promptResolve(value);
      flow.promptResolve = undefined;
      flow.status = "in_progress";
    }

    return c.json({ ok: true });
  });

  // POST /setup/complete — save config and init orchestrator
  app.openapi(saveConfigRoute, async (c) => {
    const body = c.req.valid("json");
    const targetDir = body.workDir ? resolve(body.workDir) : workDir;
    const targetPolpoDir = resolve(targetDir, ".polpo");
    const org = body.orgName || basename(targetDir);

    const config = generatePolpoConfigDefault(org, {
      model: body.model || undefined,
      agentName: body.agentName || undefined,
      agentRole: body.agentRole || undefined,
    });

    savePolpoConfig(targetPolpoDir, config);

    // Init orchestrator on-the-fly — no restart needed
    if (onSetupComplete) {
      try {
        await onSetupComplete(targetDir);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[Setup] Failed to initialize orchestrator: ${msg}`);
      }
    }

    return c.json({
      ok: true,
      data: { message: "Setup complete! Dashboard is ready.", workDir: targetDir },
    });
  });

  return app;
}
