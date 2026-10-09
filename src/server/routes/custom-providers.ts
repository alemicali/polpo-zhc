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
  providerSecretsSchema,
  validateCustomProvider,
  type DiscoveryKind,
} from "@polpo-ai/core/provider-config";
import type { ProviderConfig } from "../../core/types.js";
import type { VaultStore } from "../../core/vault-store.js";
import { isRedactedValue } from "@polpo-ai/core/secret-redaction";
import { loadPolpoConfig, mutatePolpoProviders } from "../../core/config.js";
import {
  allowedProviderEnvVar,
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

/**
 * Explicit admin confirmation to reuse a built-in provider's env key (ANTHROPIC_API_KEY /
 * OPENAI_API_KEY) for a "proxy for a built-in provider" endpoint.
 */
const ConfirmSchema = z.boolean().optional();

const CreateSchema = z.object({
  id: z.string(),
  provider: z.unknown(),
  secrets: providerSecretsSchema.optional(),
  confirmEnvReuse: ConfirmSchema,
});

const UpdateSchema = z.object({
  provider: z.unknown(),
  secrets: providerSecretsSchema.optional(),
  confirmEnvReuse: ConfirmSchema,
});

const DraftSchema = z.object({
  confirmEnvReuse: ConfirmSchema,
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

function validate(input: unknown, confirmEnvReuse?: boolean): { ok: true; config: ProviderConfig } | { ok: false; error: string } {
  const result = validateCustomProvider(input, { confirmedBuiltinReuse: confirmEnvReuse === true });
  if (!result.ok) return { ok: false, error: result.errors.join("; ") };
  const violations = secretHeaderViolations(result.config);
  if (violations.length > 0) {
    return { ok: false, error: `Header(s) ${violations.join(", ")} look secret — add them as secret headers (stored in the vault), not static headers` };
  }
  return result;
}

function originOf(url: string | undefined): string | undefined {
  try {
    const u = new URL(url ?? "");
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Where the key ends up: endpoint origin + auth header target. */
function secretTarget(cfg: ProviderConfig): string {
  const auth = effectiveAuth(cfg);
  const header = auth.type === "header" ? `${auth.headerName ?? ""}|${auth.prefix ?? ""}`.toLowerCase() : "";
  return `${originOf(cfg.baseUrl) ?? "?"}|${auth.type}|${header}`;
}

/**
 * Stored secrets (vault key, secret headers) may only travel to the endpoint they were saved
 * for: same origin (scheme + host + port) and same auth target. Otherwise they must be
 * entered again.
 */
export function sameSecretTarget(a: ProviderConfig, b: ProviderConfig): boolean {
  return !!originOf(a.baseUrl) && secretTarget(a) === secretTarget(b);
}

/**
 * GET /config masks provider header values ("••••"). If such a masked value comes back,
 * restore it from the saved provider when the secret target is unchanged; otherwise refuse
 * (never persist or send a mask, never move a saved value to a new target).
 */
function restoreMaskedHeaders(cfg: ProviderConfig, saved: ProviderConfig | undefined): { ok: true; config: ProviderConfig } | { ok: false; error: string } {
  const masked = Object.entries(cfg.headers ?? {}).filter(([, v]) => isRedactedValue(v));
  if (masked.length === 0) return { ok: true, config: cfg };
  const sameTarget = !!saved && sameSecretTarget(saved, cfg);
  const headers = { ...(cfg.headers ?? {}) };
  for (const [name] of masked) {
    const original = sameTarget
      ? Object.entries(saved!.headers ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1]
      : undefined;
    if (original === undefined || isRedactedValue(original)) {
      return { ok: false, error: `Header "${name}" contains a masked value — enter the real value again` };
    }
    headers[name] = original;
  }
  return { ok: true, config: { ...cfg, headers } };
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
  const envVar = allowedProviderEnvVar(id, cfg);
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
  /** Ids with a create in flight (per route instance). */
  const creating = new Set<string>();

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
    const result = await testCustomProvider({ id: resolved.id, config: resolved.config, secrets: resolved.secrets, model: body.data.model, allowEnv: resolved.allowEnv });
    return c.json({ ok: true, data: result });
  });

  // POST /providers/custom/discover — discover models for a draft (or saved) provider
  app.post("/discover", async (c) => {
    const body = DraftSchema.safeParse(await readJson(c));
    if (!body.success) return fail(c, 400, body.error.issues.map((i) => i.message).join("; "));
    const resolved = await resolveDraft(body.data);
    if ("error" in resolved) return fail(c, resolved.status, resolved.error);
    try {
      const result = await discoverCustomProviderModels({ id: resolved.id, config: resolved.config, secrets: resolved.secrets, kind: body.data.kind as DiscoveryKind | undefined, allowEnv: resolved.allowEnv });
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
    if (getCustomProviderConfig(id) || creating.has(id)) return fail(c, 409, `Custom provider "${id}" already exists`);
    const validated = validate(body.data.provider, body.data.confirmEnvReuse);
    if (!validated.ok) return fail(c, 400, validated.error);
    const v = restoreMaskedHeaders(validated.config, undefined);
    if (!v.ok) return fail(c, 400, v.error);
    // Claim the id synchronously so concurrent creates for the same id cannot both pass.
    creating.add(id);
    try {
      const net = await checkEndpoint(v.config.baseUrl!, { allowPrivateNetwork: !!v.config.allowPrivateNetwork });
      if (!net.ok) return fail(c, 400, net.error ?? "Endpoint not allowed", { addressClass: net.addressClass });
      if (getCustomProviderConfig(id)) return fail(c, 409, `Custom provider "${id}" already exists`);
      return await save(c, deps, id, v.config, body.data.secrets, net.unresolved ? [net.error!] : [], 201, "create");
    } finally {
      creating.delete(id);
    }
  });

  // PUT /providers/custom/:id — replace definition; secrets are a write-only patch
  app.put("/:id", async (c) => {
    const deps = getDeps();
    const id = c.req.param("id");
    const current = getCustomProviderConfig(id);
    if (!current) return fail(c, 404, `Custom provider "${id}" not found`);
    const body = UpdateSchema.safeParse(await readJson(c));
    if (!body.success) return fail(c, 400, body.error.issues.map((i) => i.message).join("; "));
    const validated = validate(body.data.provider, body.data.confirmEnvReuse);
    if (!validated.ok) return fail(c, 400, validated.error);
    const v = restoreMaskedHeaders(validated.config, current);
    if (!v.ok) return fail(c, 400, v.error);
    const net = await checkEndpoint(v.config.baseUrl!, { allowPrivateNetwork: !!v.config.allowPrivateNetwork });
    if (!net.ok) return fail(c, 400, net.error ?? "Endpoint not allowed", { addressClass: net.addressClass });
    const warnings = net.unresolved ? [net.error!] : [];
    let secrets = body.data.secrets;
    if (!sameSecretTarget(current, v.config)) {
      // Endpoint origin or auth target changed: stored secrets must not follow to the new
      // target. Drop everything that was not re-entered in this request.
      const stored = await readProviderSecrets(deps.getVaultStore(), id).catch(() => undefined);
      const secretHeaders: Record<string, string | null> = {};
      for (const name of Object.keys(stored?.headers ?? {})) secretHeaders[name] = null;
      Object.assign(secretHeaders, secrets?.secretHeaders ?? {});
      const reentered = secrets?.apiKey !== undefined && secrets.apiKey.trim() !== "";
      if ((stored?.apiKey && !reentered) || Object.values(secretHeaders).some((x) => x === null)) {
        warnings.push("Endpoint or auth method changed — stored secrets were removed; enter the key again");
      }
      secrets = { apiKey: reentered ? secrets!.apiKey : "", secretHeaders };
    }
    return save(c, deps, id, v.config, secrets, warnings, 200, "update");
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
    { id: string; config: ProviderConfig; secrets: ProviderSecrets; allowEnv: boolean } | { error: string; status: 400 | 404 }
  > {
    const deps = getDeps();
    const requestedId = body.id?.trim();
    const saved = requestedId ? getCustomProviderConfig(requestedId) : undefined;
    if (requestedId && !saved) {
      if (body.provider === undefined) return { error: `Custom provider "${requestedId}" not found`, status: 404 };
      const idError = checkId(requestedId);
      if (idError) return { error: idError, status: 400 };
    }
    let config: ProviderConfig;
    if (body.provider !== undefined) {
      const validated = validate(body.provider, body.confirmEnvReuse);
      if (!validated.ok) return { error: validated.error, status: 400 };
      const v = restoreMaskedHeaders(validated.config, saved);
      if (!v.ok) return { error: v.error, status: 400 };
      config = v.config;
    } else {
      config = saved!;
    }
    // Stored secrets / env fallback are only reused for the SAME saved provider, and only while
    // the draft still targets the same origin + auth header (and the same env var). Otherwise
    // the caller must provide the secret again.
    let stored: ProviderSecrets | undefined;
    let allowEnv = false;
    if (saved && requestedId && sameSecretTarget(saved, config)) {
      stored = await readProviderSecrets(deps.getVaultStore(), requestedId).catch(() => undefined);
      const savedEnv = allowedProviderEnvVar(requestedId, saved);
      allowEnv = !!savedEnv && savedEnv === allowedProviderEnvVar(requestedId, config);
    }
    const id = requestedId ?? "draft";
    return { id, config, secrets: overlaySecrets(stored, body.secrets), allowEnv };
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
  mode: "create" | "update",
) {
  const vault = deps.getVaultStore();
  if (mode === "create") {
    // The id may exist in polpo.json without being registered yet (hand edit): never let a
    // create overwrite another provider's secrets.
    const raw = loadPolpoConfig(deps.getPolpoDir())?.providers as Record<string, unknown> | undefined;
    if (raw && Object.prototype.hasOwnProperty.call(raw, id)) return fail(c, 409, `Custom provider "${id}" already exists`);
  }
  // Secrets first: if the vault is unavailable we refuse before touching polpo.json.
  let secretStatus;
  try {
    secretStatus = await writeProviderSecrets(vault, id, secrets ?? {});
  } catch (err) {
    return fail(c, 503, (err as Error).message);
  }
  try {
    mutatePolpoProviders(deps.getPolpoDir(), (providers) => {
      if (mode === "create" && Object.prototype.hasOwnProperty.call(providers, id)) throw new ConflictError(id);
      providers[id] = config;
    });
  } catch (err) {
    if (err instanceof ConflictError) return fail(c, 409, err.message);
    return fail(c, 500, `Failed to update polpo.json: ${(err as Error).message}`);
  }
  setCustomProviderSecretStatus(id, secretStatus);
  await deps.applyProviders();
  const auth = effectiveAuth(config);
  if (auth.type !== "none" && !customProviderHasCredentials(id)) {
    const envVar = allowedProviderEnvVar(id, config);
    warnings.push(`No key stored${envVar ? ` and ${envVar} is not set` : ""} — requests will fail until a key is added`);
  }
  return c.json({ ok: true, data: { ...(await publicView(id, config, vault)), warnings } }, status);
}

class ConflictError extends Error {
  constructor(id: string) {
    super(`Custom provider "${id}" already exists`);
  }
}

/** Re-export for the OpenAPI-less schema consumers (tests). */
export { customProviderSchema };
