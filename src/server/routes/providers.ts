import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { PROVIDER_ENV_MAP, listModels } from "../../llm/pi-client.js";
import {
  detectProviders,
  persistToEnvFile,
  removeFromEnvFile,
  getOAuthProviderList,
  startOAuthLogin,
} from "../../setup/index.js";

// ── Route definitions ─────────────────────────────────────────────

const listProvidersRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Providers"],
  summary: "List all LLM providers with credential status",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            data: z.array(z.object({
              name: z.string(),
              envVar: z.string().optional(),
              hasKey: z.boolean(),
              source: z.enum(["env", "oauth", "none"]),
            })),
          }),
        },
      },
      description: "Provider list with credential status",
    },
  },
});

const allModelsRoute = createRoute({
  method: "get",
  path: "/models",
  tags: ["Providers"],
  summary: "List all available models, optionally filtered by provider",
  request: {
    query: z.object({ provider: z.string().optional() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }),
        },
      },
      description: "Model list",
    },
  },
});

const oauthListRoute = createRoute({
  method: "get",
  path: "/oauth",
  tags: ["Providers"],
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
      description: "OAuth provider list",
    },
  },
});

const oauthStartRoute = createRoute({
  method: "post",
  path: "/oauth/start",
  tags: ["Providers"],
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
          schema: z.object({ ok: z.boolean(), data: z.object({ flowId: z.string() }) }),
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
  tags: ["Providers"],
  summary: "Poll OAuth flow status",
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
  tags: ["Providers"],
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
      content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
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

const providerModelsRoute = createRoute({
  method: "get",
  path: "/{name}/models",
  tags: ["Providers"],
  summary: "List models for a specific provider",
  request: {
    params: z.object({ name: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }),
        },
      },
      description: "Provider models",
    },
  },
});

const saveApiKeyRoute = createRoute({
  method: "post",
  path: "/{name}/api-key",
  tags: ["Providers"],
  summary: "Save an API key for a provider",
  request: {
    params: z.object({ name: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            apiKey: z.string(),
            workDir: z.string().optional(),
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
      description: "Unknown provider",
    },
  },
});

const deleteApiKeyRoute = createRoute({
  method: "delete",
  path: "/{name}/api-key",
  tags: ["Providers"],
  summary: "Remove an API key for a provider",
  request: {
    params: z.object({ name: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ workDir: z.string().optional() }).optional(),
        },
      },
      required: false,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), data: z.object({ message: z.string() }) }),
        },
      },
      description: "API key removed",
    },
    400: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), error: z.string() }),
        },
      },
      description: "Unknown provider",
    },
  },
});

const disconnectRoute = createRoute({
  method: "delete",
  path: "/{name}/disconnect",
  tags: ["Providers"],
  summary: "Disconnect a provider — removes API key and OAuth profiles",
  request: {
    params: z.object({ name: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ workDir: z.string().optional() }).optional(),
        },
      },
      required: false,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), data: z.object({ message: z.string() }) }),
        },
      },
      description: "Provider disconnected",
    },
    400: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), error: z.string() }),
        },
      },
      description: "Unknown provider",
    },
  },
});

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
  promptResolve?: (value: string) => void;
}

const oauthFlows = new Map<string, OAuthFlowState>();

setInterval(() => {
  for (const [id, flow] of oauthFlows) {
    if (flow.status === "complete" || flow.status === "error") {
      oauthFlows.delete(id);
    }
  }
}, 600_000);

// ── Route handlers ──────────────────────────────────────────────────

/**
 * Provider management routes — always available.
 * Auth is handled by the middleware in app.ts (conditional on setup mode).
 */
export function providerRoutes(polpoDir: string): OpenAPIHono {
  const app = new OpenAPIHono();

  // ── Static paths first (before /:name wildcard) ──

  // GET /providers
  app.openapi(listProvidersRoute, (c) => {
    return c.json({ ok: true, data: detectProviders() });
  });

  // GET /providers/models
  app.openapi(allModelsRoute, (c) => {
    const provider = c.req.query("provider");
    const models = listModels(provider || undefined)
      .sort((a, b) => a.cost.input - b.cost.input);
    return c.json({ ok: true, data: models });
  });

  // GET /providers/oauth
  app.openapi(oauthListRoute, (c) => {
    return c.json({ ok: true, data: getOAuthProviderList() });
  });

  // POST /providers/oauth/start
  app.openapi(oauthStartRoute, async (c: any) => {
    const { provider } = c.req.valid("json");
    const flowId = randomUUID();
    const flow: OAuthFlowState = { provider, status: "pending" };
    oauthFlows.set(flowId, flow);

    (async () => {
      try {
        const profileId = await startOAuthLogin(provider, {
          onAuthUrl: (url: string, instructions?: string) => {
            flow.authUrl = url;
            flow.instructions = instructions;
            flow.status = "awaiting_browser";
          },
          onPrompt: (message: string, placeholder?: string): Promise<string> => {
            flow.promptMessage = message;
            flow.promptPlaceholder = placeholder;
            flow.status = "awaiting_input";
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

  // GET /providers/oauth/status/:flowId
  app.openapi(oauthStatusRoute, (c: any) => {
    const { flowId } = c.req.valid("param");
    const flow = oauthFlows.get(flowId);
    if (!flow) return c.json({ ok: false, error: "Flow not found" }, 404);

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

  // POST /providers/oauth/input/:flowId
  app.openapi(oauthInputRoute, (c: any) => {
    const { flowId } = c.req.valid("param");
    const { value } = c.req.valid("json");
    const flow = oauthFlows.get(flowId);
    if (!flow) return c.json({ ok: false, error: "Flow not found" }, 404);

    if (flow.promptResolve) {
      flow.promptResolve(value);
      flow.promptResolve = undefined;
      flow.status = "in_progress";
    }
    return c.json({ ok: true });
  });

  // ── Dynamic /:name paths ──

  // GET /providers/:name/models
  app.openapi(providerModelsRoute, (c: any) => {
    const { name } = c.req.valid("param");
    const models = listModels(name).sort((a, b) => a.cost.input - b.cost.input);
    return c.json({ ok: true, data: models });
  });

  // POST /providers/:name/api-key
  app.openapi(saveApiKeyRoute, (c: any) => {
    const { name } = c.req.valid("param");
    const { apiKey, workDir: bodyWorkDir } = c.req.valid("json");
    const envVar = PROVIDER_ENV_MAP[name];
    if (!envVar) return c.json({ ok: false, error: `Unknown provider: ${name}` }, 400);

    process.env[envVar] = apiKey;
    const targetDir = bodyWorkDir ? resolve(bodyWorkDir, ".polpo") : polpoDir;
    persistToEnvFile(targetDir, envVar, apiKey);

    return c.json({ ok: true, data: { message: `${envVar} saved to .polpo/.env` } });
  });

  // DELETE /providers/:name/api-key
  app.openapi(deleteApiKeyRoute, (c: any) => {
    const { name } = c.req.valid("param");
    let bodyWorkDir: string | undefined;
    try {
      const body = c.req.valid("json");
      bodyWorkDir = body?.workDir;
    } catch { /* no body is fine for DELETE */ }

    const envVar = PROVIDER_ENV_MAP[name];
    if (!envVar) return c.json({ ok: false, error: `Unknown provider: ${name}` }, 400);

    delete process.env[envVar];
    const targetDir = bodyWorkDir ? resolve(bodyWorkDir, ".polpo") : polpoDir;
    removeFromEnvFile(targetDir, envVar);

    return c.json({ ok: true, data: { message: `${envVar} removed` } });
  });

  // DELETE /providers/:name/disconnect — remove env key + OAuth profiles
  app.openapi(disconnectRoute, async (c: any) => {
    const { name } = c.req.valid("param");
    let bodyWorkDir: string | undefined;
    try {
      const body = c.req.valid("json");
      bodyWorkDir = body?.workDir;
    } catch { /* no body is fine for DELETE */ }

    const actions: string[] = [];

    // Remove env var from process + .env file
    const envVar = PROVIDER_ENV_MAP[name];
    if (envVar && process.env[envVar]) {
      delete process.env[envVar];
      const targetDir = bodyWorkDir ? resolve(bodyWorkDir, ".polpo") : polpoDir;
      removeFromEnvFile(targetDir, envVar);
      actions.push("API key removed");
    }

    // Remove OAuth profiles for this provider (exact name match — no mapping needed)
    try {
      const { deleteProviderProfiles } = await import("../../auth/store.js");
      const removed = deleteProviderProfiles(name);
      if (removed > 0) actions.push(`${removed} OAuth profile(s) removed`);
    } catch { /* auth module not available */ }

    return c.json({
      ok: true,
      data: { message: actions.length > 0 ? actions.join(", ") : "No credentials found" },
    });
  });

  return app;
}
