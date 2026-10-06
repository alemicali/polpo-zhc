/**
 * Custom LLM providers / AI gateways — CRUD, connection test, model discovery.
 *
 * Mounted at /api/v1/providers/custom behind the instance auth gate (same as the other
 * provider/config routes). Requires an initialized instance: secrets go to the vault
 * (owner "$providers"), definitions to polpo.json `providers`.
 *
 * Responses never contain secrets: only `hasKey`, an optional 4-char `keyHint`, and the
 * NAMES of secret headers.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import {
  PROVIDER_ID_RE,
  customProviderSchema,
  effectiveAuth,
  defaultProviderEnvVar,
  providerSecretsSchema,
  validateCustomProvider,
  type DiscoveryKind,
} from "@polpo-ai/core/provider-config";
import type { ProviderConfig } from "../../core/types.js";
import type { VaultStore } from "../../core/vault-store.js";
import { mutatePolpoProviders } from "../../core/config.js";
import {
  customProviderHasCredentials,
  getCustomProviderConfig,
  isBuiltinProvider,
  listCustomProviderIds,
  setCustomProviderSecretStatus,
} from "../../llm/custom-providers.js";
import { discoverCustomProviderModels, testCustomProvider } from "../../llm/custom-provider-probe.js";
import { checkEndpoint } from "../../llm/endpoint-guard.js";
import {
  readProviderSecrets,
  removeProviderSecrets,
  secretStatusOf,
  writeProviderSecrets,
  type ProviderSecrets,
} from "../../llm/provider-secrets.js";

export interface CustomProviderRouteDeps {
  isInitialized: () => boolean;
  getPolpoDir: () => string;
  getVaultStore: () => VaultStore | undefined;
  /** Re-read polpo.json providers and re-register them at runtime. */
  applyProviders: () => Promise<void>;
  /** Model specs currently referenced by agents/settings (for delete warnings). */
  getModelUsage?: () => Promise<string[]>;
}

/** Ids that would collide with /providers/* routes. */
const RESERVED_IDS = new Set(["custom", "oauth", "models", "presets", "draft"]);

/** Header names that almost certainly carry secrets — must go to secretHeaders, not headers. */
const SECRET_HEADER_RE = /(authorization|api[-_]?key|token|secret|password|cookie|session)/i;

const DiscoveryKindSchema = z.enum(["openai", "anthropic", "litellm", "openrouter", "ollama", "none"]);

const CreateSchema = z.object({
  id: z.string(),
  provider: z.unknown(),
  secrets: providerSecretsSchema.optional(),
});

const UpdateSchema = z.object({
  provider: z.unknown(),
  secrets: providerSecretsSchema.optional(),
});

const DraftSchema = z.object({
  /** Saved provider id (uses stored secrets as a base). */
  id: z.string().optional(),
  /** Draft definition; when omitted, the saved definition of `id` is used. */
  provider: z.unknown().optional(),
  secrets: providerSecretsSchema.optional(),
  model: z.string().max(200).optional(),
  kind: DiscoveryKindSchema.optional(),
});

function fail(c: any, status: 400 | 404 | 409 | 500 | 503, error: string, extra?: Record<string, unknown>) {
  return c.json({ ok: false, error, ...extra }, status);
}

async function readJson(c: any): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function checkId(id: string): string | undefined {
  if (!PROVIDER_ID_RE.test(id)) return "Provider id must be 2-41 chars: lowercase letters, digits and dashes (starting with a letter or digit)";
  if (RESERVED_IDS.has(id)) return `"${id}" is reserved`;
  if (isBuiltinProvider(id)) return `"${id}" is a built-in provider — pick another id (e.g. "${id}-gw")`;
  return undefined;
}

function secretHeaderViolations(cfg: ProviderConfig): string[] {
  return Object.keys(cfg.headers ?? {}).filter((h) => SECRET_HEADER_RE.test(h));
}

function validate(input: unknown): { ok: true; config: ProviderConfig } | { ok: false; error: string } {
  const result = validateCustomProvider(input);
  if (!result.ok) return { ok: false, error: result.errors.join("; ") };
  const violations = secretHeaderViolations(result.config);
  if (violations.length > 0) {
    return { ok: false, error: `Header(s) ${violations.join(", ")} look secret — add them as secret headers (stored in the vault), not static headers` };
  }
  return result;
}

/** Merge stored secrets with a write-only patch, without persisting (for drafts). */
function overlaySecrets(stored: ProviderSecrets | undefined, patch: z.infer<typeof providerSecretsSchema> | undefined): ProviderSecrets {
  const out: ProviderSecrets = { apiKey: stored?.apiKey, headers: { ...(stored?.headers ?? {}) } };
  if (patch?.apiKey !== undefined) out.apiKey = patch.apiKey.trim() || undefined;
  for (const [k, v] of Object.entries(patch?.secretHeaders ?? {})) {
    for (const existing of Object.keys(out.headers)) if (existing.toLowerCase() === k.toLowerCase()) delete out.headers[existing];
    if (v) out.headers[k] = v;
  }
  return out;
}

async function publicView(id: string, cfg: ProviderConfig, vault: VaultStore | undefined) {
  const secrets = await readProviderSecrets(vault, id).catch(() => undefined);
  const status = secretStatusOf(secrets);
  const auth = effectiveAuth(cfg);
  const envVar = auth.type === "none" ? undefined : (auth.envVar ?? defaultProviderEnvVar(id));
  const envKeyPresent = envVar ? !!process.env[envVar] : false;
  return {
    id,
    ...cfg,
    auth,
    hasKey: status.hasKey,
    keyHint: status.keyHint,
    secretHeaderNames: status.secretHeaderNames,
    envVar,
    envKeyPresent,
    keySource: auth.type === "none" ? "none" : status.hasKey ? "vault" : envKeyPresent ? "env" : undefined,
    configured: auth.type === "none" || status.hasKey || envKeyPresent,
  };
}

export function customProviderRoutes(getDeps: () => CustomProviderRouteDeps): OpenAPIHono {
  const app = new OpenAPIHono();

  app.use("*", async (c, next) => {
    if (!getDeps().isInitialized()) return fail(c, 409, "Instance not initialized — finish setup first");
    return next();
  });

  // GET /providers/custom — list custom providers (no secrets)
  app.get("/", async (c) => {
    const deps = getDeps();
    const vault = deps.getVaultStore();
    const data = [];
    for (const id of listCustomProviderIds()) data.push(await publicView(id, getCustomProviderConfig(id)!, vault));
    return c.json({ ok: true, data });
  });

  // POST /providers/custom/test — test a draft or a saved provider
  app.post("/test", async (c) => {
    const body = DraftSchema.safeParse(await readJson(c));
    if (!body.success) return fail(c, 400, body.error.issues.map((i) => i.message).join("; "));
    const resolved = await resolveDraft(body.data);
    if ("error" in resolved) return fail(c, resolved.status, resolved.error);
    const result = await testCustomProvider({ id: resolved.id, config: resolved.config, secrets: resolved.secrets, model: body.data.model });
    return c.json({ ok: true, data: result });
  });

  // POST /providers/custom/discover — discover models for a draft (or saved) provider
  app.post("/discover", async (c) => {
    const body = DraftSchema.safeParse(await readJson(c));
    if (!body.success) return fail(c, 400, body.error.issues.map((i) => i.message).join("; "));
    const resolved = await resolveDraft(body.data);
    if ("error" in resolved) return fail(c, resolved.status, resolved.error);
    try {
      const result = await discoverCustomProviderModels({ id: resolved.id, config: resolved.config, secrets: resolved.secrets, kind: body.data.kind as DiscoveryKind | undefined });
      return c.json({ ok: true, data: result });
    } catch (err) {
      return fail(c, 400, (err as Error).message);
    }
  });

  // GET /providers/custom/:id
  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    const cfg = getCustomProviderConfig(id);
    if (!cfg) return fail(c, 404, `Custom provider "${id}" not found`);
    return c.json({ ok: true, data: await publicView(id, cfg, getDeps().getVaultStore()) });
  });

  // POST /providers/custom — create
  app.post("/", async (c) => {
    const deps = getDeps();
    const body = CreateSchema.safeParse(await readJson(c));
    if (!body.success) return fail(c, 400, body.error.issues.map((i) => i.message).join("; "));
    const id = body.data.id.trim();
    const idError = checkId(id);
    if (idError) return fail(c, 400, idError);
    if (getCustomProviderConfig(id)) return fail(c, 409, `Custom provider "${id}" already exists`);
    const v = validate(body.data.provider);
    if (!v.ok) return fail(c, 400, v.error);
    const net = await checkEndpoint(v.config.baseUrl!, { allowPrivateNetwork: !!v.config.allowPrivateNetwork });
    if (!net.ok) return fail(c, 400, net.error ?? "Endpoint not allowed", { addressClass: net.addressClass });
    return save(c, deps, id, v.config, body.data.secrets, net.unresolved ? [net.error!] : [], 201);
  });

  // PUT /providers/custom/:id — replace definition; secrets are a write-only patch
  app.put("/:id", async (c) => {
    const deps = getDeps();
    const id = c.req.param("id");
    if (!getCustomProviderConfig(id)) return fail(c, 404, `Custom provider "${id}" not found`);
    const body = UpdateSchema.safeParse(await readJson(c));
    if (!body.success) return fail(c, 400, body.error.issues.map((i) => i.message).join("; "));
    const v = validate(body.data.provider);
    if (!v.ok) return fail(c, 400, v.error);
    const net = await checkEndpoint(v.config.baseUrl!, { allowPrivateNetwork: !!v.config.allowPrivateNetwork });
    if (!net.ok) return fail(c, 400, net.error ?? "Endpoint not allowed", { addressClass: net.addressClass });
    return save(c, deps, id, v.config, body.data.secrets, net.unresolved ? [net.error!] : [], 200);
  });

  // DELETE /providers/custom/:id — remove definition + vault secrets
  app.delete("/:id", async (c) => {
    const deps = getDeps();
    const id = c.req.param("id");
    if (!getCustomProviderConfig(id)) return fail(c, 404, `Custom provider "${id}" not found`);
    const inUse = (await deps.getModelUsage?.().catch(() => []) ?? []).filter((spec) => spec.startsWith(`${id}:`));
    try {
      mutatePolpoProviders(deps.getPolpoDir(), (providers) => { delete providers[id]; });
    } catch (err) {
      return fail(c, 500, `Failed to update polpo.json: ${(err as Error).message}`);
    }
    await removeProviderSecrets(deps.getVaultStore(), id);
    setCustomProviderSecretStatus(id, undefined);
    await deps.applyProviders();
    return c.json({
      ok: true,
      data: {
        id,
        removed: true,
        warnings: inUse.length > 0 ? [`Still referenced by: ${[...new Set(inUse)].join(", ")} — those calls will fail until you pick another model`] : [],
      },
    });
  });

  // POST /providers/custom/:id/discover — discover models for a saved provider
  app.post("/:id/discover", async (c) => {
    const id = c.req.param("id");
    const cfg = getCustomProviderConfig(id);
    if (!cfg) return fail(c, 404, `Custom provider "${id}" not found`);
    const body = z.object({ kind: DiscoveryKindSchema.optional() }).safeParse((await readJson(c)) ?? {});
    try {
      const secrets = await readProviderSecrets(getDeps().getVaultStore(), id);
      const result = await discoverCustomProviderModels({ id, config: cfg, secrets, kind: body.success ? body.data.kind : undefined });
      return c.json({ ok: true, data: result });
    } catch (err) {
      return fail(c, 400, (err as Error).message);
    }
  });

  async function resolveDraft(body: z.infer<typeof DraftSchema>): Promise<
    { id: string; config: ProviderConfig; secrets: ProviderSecrets } | { error: string; status: 400 | 404 }
  > {
    const deps = getDeps();
    const savedId = body.id?.trim();
    const saved = savedId ? getCustomProviderConfig(savedId) : undefined;
    if (savedId && !saved && body.provider === undefined) return { error: `Custom provider "${savedId}" not found`, status: 404 };
    let config: ProviderConfig;
    if (body.provider !== undefined) {
      const v = validate(body.provider);
      if (!v.ok) return { error: v.error, status: 400 };
      config = v.config;
    } else {
      config = saved!;
    }
    // Stored secrets are only reused for the SAME saved provider (never for another id).
    const stored = saved && savedId ? await readProviderSecrets(deps.getVaultStore(), savedId).catch(() => undefined) : undefined;
    const id = savedId && PROVIDER_ID_RE.test(savedId) ? savedId : "draft";
    return { id, config, secrets: overlaySecrets(stored, body.secrets) };
  }

  return app;
}

async function save(
  c: any,
  deps: CustomProviderRouteDeps,
  id: string,
  config: ProviderConfig,
  secrets: z.infer<typeof providerSecretsSchema> | undefined,
  warnings: string[],
  status: 200 | 201,
) {
  const vault = deps.getVaultStore();
  // Secrets first: if the vault is unavailable we refuse before touching polpo.json.
  let secretStatus;
  try {
    secretStatus = await writeProviderSecrets(vault, id, secrets ?? {});
  } catch (err) {
    return fail(c, 503, (err as Error).message);
  }
  try {
    mutatePolpoProviders(deps.getPolpoDir(), (providers) => { providers[id] = config; });
  } catch (err) {
    return fail(c, 500, `Failed to update polpo.json: ${(err as Error).message}`);
  }
  setCustomProviderSecretStatus(id, secretStatus);
  await deps.applyProviders();
  const auth = effectiveAuth(config);
  if (auth.type !== "none" && !customProviderHasCredentials(id)) {
    warnings.push(`No key stored and ${auth.envVar ?? defaultProviderEnvVar(id)} is not set — requests will fail until a key is added`);
  }
  return c.json({ ok: true, data: { ...(await publicView(id, config, vault)), warnings } }, status);
}

/** Re-export for the OpenAPI-less schema consumers (tests). */
export { customProviderSchema };
