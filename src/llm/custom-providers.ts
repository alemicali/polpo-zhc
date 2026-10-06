/**
 * Runtime registry for custom LLM providers / AI gateways.
 *
 * Every non-built-in entry of polpo.json `providers` is registered as a pi-ai provider
 * (`createModels()` + `createProvider()`), with an app-owned `ApiKeyAuth` that resolves
 * the key from the vault ("$providers" owner) → env var → keyless. Requests go through a
 * guarded fetch that enforces the private-network policy on the connected address.
 */

import {
  createModels,
  createProvider,
  lazyStream,
  type Api,
  type ApiKeyAuth,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type AuthResult,
  type Context,
  type Model,
  type MutableModels,
  type ProviderHeaders,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { getBuiltinModel, getBuiltinProviders, type BuiltinProvider } from "@earendil-works/pi-ai/providers/all";
import {
  defaultProviderEnvVar,
  effectiveAuth,
  sanitizeCompat,
} from "@polpo-ai/core/provider-config";
import type { CustomModelDef, ProviderApi, ProviderAuthConfig, ProviderConfig } from "../core/types.js";
import { checkEndpoint, createGuardedFetch } from "./endpoint-guard.js";
import type { ProviderSecrets, ProviderSecretStatus } from "./provider-secrets.js";

export const DEFAULT_CUSTOM_BASE_URL = "http://localhost:11434/v1";
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 8192;

/** Placeholder passed to SDKs that insist on an API key; the real auth header (or none) overrides it. */
const KEY_PLACEHOLDER = "polpo-no-key";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// ── Built-in detection ─────────────────────────────────────────────

let builtinIds: Set<string> | undefined;

export function isBuiltinProvider(id: string): boolean {
  builtinIds ??= new Set(getBuiltinProviders() as string[]);
  return builtinIds.has(id);
}

// ── State ──────────────────────────────────────────────────────────

let customConfigs: Record<string, ProviderConfig> = {};
let modelsInstance: MutableModels | undefined;

/** Lazily created so importing this module has no side effects (and mocks of pi-ai stay simple). */
function registry(): MutableModels {
  modelsInstance ??= createModels();
  return modelsInstance;
}

export interface ProviderSecretsSource {
  get(id: string): Promise<ProviderSecrets | undefined>;
}

let secretsSource: ProviderSecretsSource | undefined;
const secretStatus = new Map<string, ProviderSecretStatus>();

/** Install the vault-backed secrets source (set by the orchestrator once the vault is ready). */
export function setProviderSecretsSource(source: ProviderSecretsSource | undefined): void {
  secretsSource = source;
}

/** Cache of "is a key stored" per provider — used by synchronous validation paths. */
export function setCustomProviderSecretStatus(id: string, status: ProviderSecretStatus | undefined): void {
  if (status) secretStatus.set(id, status);
  else secretStatus.delete(id);
}

export function getCustomProviderSecretStatus(id: string): ProviderSecretStatus | undefined {
  return secretStatus.get(id);
}

/** Reload the key-presence cache for all custom providers from the secrets source. */
export async function refreshCustomProviderSecretStatus(): Promise<void> {
  if (!secretsSource) return;
  for (const id of Object.keys(customConfigs)) {
    try {
      const s = await secretsSource.get(id);
      secretStatus.set(id, {
        hasKey: !!s?.apiKey,
        keyHint: s?.apiKey && s.apiKey.length >= 16 ? s.apiKey.slice(-4) : undefined,
        secretHeaderNames: Object.keys(s?.headers ?? {}).sort(),
      });
    } catch {
      /* vault unavailable — keep previous status */
    }
  }
}

/** Custom (non-built-in) provider ids currently configured. */
export function listCustomProviderIds(): string[] {
  return Object.keys(customConfigs);
}

export function getCustomProviderConfig(id: string): ProviderConfig | undefined {
  return customConfigs[id];
}

export function isCustomProvider(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(customConfigs, id);
}

/**
 * Register custom providers from the polpo.json `providers` map (built-in ids are
 * overrides, handled elsewhere). Replaces the previous registration entirely.
 */
export function syncCustomProviders(all: Record<string, ProviderConfig> | undefined): void {
  const next: Record<string, ProviderConfig> = {};
  for (const [id, cfg] of Object.entries(all ?? {})) {
    if (!cfg || isBuiltinProvider(id)) continue;
    next[id] = cfg;
  }
  customConfigs = next;
  if (modelsInstance || Object.keys(next).length > 0) {
    const models = registry();
    models.clearProviders();
    for (const [id, cfg] of Object.entries(next)) {
      models.setProvider(buildProvider(id, cfg));
    }
  }
  for (const id of [...secretStatus.keys()]) if (!next[id]) secretStatus.delete(id);
}

// ── Auth ───────────────────────────────────────────────────────────

/** Header the SDK for `api` derives from `apiKey`. */
function nativeAuthHeader(api: ProviderApi): string {
  if (api === "anthropic-messages") return "x-api-key";
  if (api === "azure-openai-responses") return "api-key";
  return "authorization";
}

/**
 * Translate (auth config, key) into the `{ apiKey, headers }` pair the pi-ai adapters expect.
 * The SDK always gets an apiKey (some refuse to start without one); when the key must travel
 * in a different header, the SDK's native header is suppressed with a null override.
 */
export function buildRequestAuth(api: ProviderApi, auth: ProviderAuthConfig, key: string | undefined): { apiKey: string; headers: ProviderHeaders } {
  const native = nativeAuthHeader(api);
  if (auth.type === "none" || !key) {
    const headers: ProviderHeaders = { [native]: null };
    if (native !== "authorization") headers.authorization = null;
    return { apiKey: KEY_PLACEHOLDER, headers };
  }
  let target: string;
  let value: string;
  switch (auth.type) {
    case "bearer":
      target = "authorization";
      value = `Bearer ${key}`;
      break;
    case "x-api-key":
      target = "x-api-key";
      value = key;
      break;
    default:
      target = (auth.headerName ?? "authorization").toLowerCase();
      value = `${auth.prefix ?? ""}${key}`;
  }
  const nativeFormat = native === "authorization" ? `Bearer ${key}` : key;
  if (target === native && value === nativeFormat) {
    // The SDK's own header is exactly what we want.
    return { apiKey: key, headers: native === "authorization" ? {} : { authorization: null } };
  }
  const headers: ProviderHeaders = { [native]: null, [target]: value };
  if (target !== "authorization" && native !== "authorization") headers.authorization = null;
  return { apiKey: KEY_PLACEHOLDER, headers };
}

export interface ResolvedCustomAuth {
  apiKey: string;
  headers: ProviderHeaders;
  source: "vault" | "env" | "none";
  envVar?: string;
}

/**
 * Resolve request auth for a custom provider: vault → env var → keyless.
 * Returns undefined when a key is required but none is available.
 */
export async function resolveCustomProviderAuth(
  id: string,
  cfg: ProviderConfig,
  overrides?: { apiKey?: string; secrets?: ProviderSecrets },
): Promise<ResolvedCustomAuth | undefined> {
  const api = cfg.api ?? "openai-completions";
  const auth = effectiveAuth(cfg);
  const secrets = overrides?.secrets ?? (secretsSource ? await secretsSource.get(id).catch(() => undefined) : undefined);
  const secretHeaders: ProviderHeaders = { ...(secrets?.headers ?? {}) };
  if (auth.type === "none") {
    const built = buildRequestAuth(api, auth, undefined);
    return { apiKey: built.apiKey, headers: { ...built.headers, ...secretHeaders }, source: "none" };
  }
  const envVar = auth.envVar ?? defaultProviderEnvVar(id);
  let key = overrides?.apiKey || secrets?.apiKey;
  let source: ResolvedCustomAuth["source"] = "vault";
  if (!key) {
    key = process.env[envVar] || undefined;
    source = "env";
  }
  if (!key) return undefined;
  const built = buildRequestAuth(api, auth, key);
  return { apiKey: built.apiKey, headers: { ...built.headers, ...secretHeaders }, source, envVar: source === "env" ? envVar : undefined };
}

/** Synchronous "is this custom provider usable" check (vault presence cache + env + keyless). */
export function customProviderHasCredentials(id: string): boolean {
  const cfg = customConfigs[id];
  if (!cfg) return false;
  const auth = effectiveAuth(cfg);
  if (auth.type === "none") return true;
  if (secretStatus.get(id)?.hasKey) return true;
  return !!process.env[auth.envVar ?? defaultProviderEnvVar(id)];
}

function apiKeyAuthFor(id: string): ApiKeyAuth {
  return {
    name: `${id} API key`,
    resolve: async ({ credential }): Promise<AuthResult | undefined> => {
      const cfg = customConfigs[id];
      if (!cfg) return undefined;
      const resolved = await resolveCustomProviderAuth(id, cfg, { apiKey: credential?.key });
      if (!resolved) return undefined;
      return {
        auth: { apiKey: resolved.apiKey, headers: resolved.headers },
        source: resolved.source === "env" ? resolved.envVar : resolved.source,
      };
    },
  };
}

// ── Models ─────────────────────────────────────────────────────────

const API_IMPLS: Record<ProviderApi, () => ProviderStreams> = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
  "azure-openai-responses": azureOpenAIResponsesApi,
};

/** Build the pi-ai Model for a custom provider model id (defined or ad-hoc). */
export function buildCustomModel(id: string, cfg: ProviderConfig, modelId: string, def?: CustomModelDef): Model<Api> {
  const api = cfg.api ?? "openai-completions";
  const custom = def ?? cfg.models?.find((m) => m.id === modelId);
  let catalog: Model<Api> | undefined;
  if (cfg.proxyFor && isBuiltinProvider(cfg.proxyFor)) {
    try {
      catalog = getBuiltinModel(cfg.proxyFor as BuiltinProvider, modelId as never) as Model<Api> | undefined;
    } catch {
      catalog = undefined;
    }
  }
  const sameApi = catalog?.api === api;
  const compat = {
    ...(sameApi ? (catalog?.compat as Record<string, unknown> | undefined) : undefined),
    ...(sanitizeCompat(api, cfg.compat) ?? {}),
    ...(sanitizeCompat(api, custom?.compat) ?? {}),
  };
  const model: Model<Api> = {
    id: modelId,
    name: custom?.name ?? catalog?.name ?? modelId,
    api,
    provider: id,
    baseUrl: cfg.baseUrl || DEFAULT_CUSTOM_BASE_URL,
    reasoning: custom?.reasoning ?? catalog?.reasoning ?? false,
    input: custom?.input ?? catalog?.input ?? ["text"],
    cost: custom?.cost ?? catalog?.cost ?? { ...ZERO_COST },
    contextWindow: custom?.contextWindow ?? catalog?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: custom?.maxTokens ?? catalog?.maxTokens ?? DEFAULT_MAX_TOKENS,
  } as Model<Api>;
  if (sameApi && catalog?.thinkingLevelMap) model.thinkingLevelMap = catalog.thinkingLevelMap;
  if (Object.keys(compat).length > 0) (model as Model<Api> & { compat?: unknown }).compat = compat;
  if (cfg.headers && Object.keys(cfg.headers).length > 0) model.headers = { ...cfg.headers };
  return model;
}

let transportFetchOverride: typeof fetch | undefined;

/** Test hook: capture outgoing requests instead of hitting the network. */
export function setCustomProviderFetchForTests(f: typeof fetch | undefined): void {
  transportFetchOverride = f;
}

/** Inject transport policy (guarded fetch, timeouts, Azure pinning) into every request. */
function withTransport(cfg: ProviderConfig, base: ProviderStreams): ProviderStreams {
  const guardedFetch = createGuardedFetch({ allowPrivateNetwork: !!cfg.allowPrivateNetwork });
  const decorate = <T extends StreamOptions | SimpleStreamOptions | undefined>(model: Model<Api>, options: T): T => {
    const next: Record<string, unknown> = { ...(options ?? {}), fetch: transportFetchOverride ?? guardedFetch };
    if (cfg.timeoutMs !== undefined && next.timeoutMs === undefined) next.timeoutMs = cfg.timeoutMs;
    if (cfg.maxRetries !== undefined && next.maxRetries === undefined) next.maxRetries = cfg.maxRetries;
    if (model.api === "azure-openai-responses") {
      // Never let ambient AZURE_OPENAI_* env vars redirect a custom provider.
      next.azureBaseUrl = model.baseUrl;
      next.azureDeploymentName ??= model.id;
    }
    return next as T;
  };
  return {
    stream: (model, context, options) => base.stream(model, context, decorate(model, options)),
    streamSimple: (model, context, options) => base.streamSimple(model, context, decorate(model, options)),
  };
}

function buildProvider(id: string, cfg: ProviderConfig) {
  const api = cfg.api ?? "openai-completions";
  return createProvider({
    id,
    name: cfg.label ?? id,
    baseUrl: cfg.baseUrl,
    auth: { apiKey: apiKeyAuthFor(id) },
    models: (cfg.models ?? []).map((m) => buildCustomModel(id, cfg, m.id, m)),
    api: { [api]: withTransport(cfg, API_IMPLS[api]()) } as Partial<Record<Api, ProviderStreams>>,
  });
}

// ── Request entry points ───────────────────────────────────────────

function stripAuthOptions<T>(options: T): T {
  if (!options || typeof options !== "object" || !("apiKey" in options)) return options;
  const { apiKey: _ignored, ...rest } = options as { apiKey?: string };
  return rest as T;
}

function notConfiguredError(id: string, cfg: ProviderConfig): Error {
  const auth = effectiveAuth(cfg);
  const envVar = auth.envVar ?? defaultProviderEnvVar(id);
  return new Error(
    `No API key for custom provider "${id}". Add one in Settings → Providers (stored encrypted in the vault) or set ${envVar}.`,
  );
}

const preflightCache = new Map<string, { at: number; error?: string }>();
const PREFLIGHT_TTL_MS = 30_000;

/**
 * Policy pre-check with a readable error. The SDKs turn fetch rejections into a generic
 * "Connection error.", so blocked targets are reported here first. Enforcement itself
 * happens at connect time in the guarded fetch (this check is only for the message).
 */
async function preflight(cfg: ProviderConfig): Promise<void> {
  if (transportFetchOverride) return;
  const baseUrl = cfg.baseUrl || DEFAULT_CUSTOM_BASE_URL;
  const key = `${baseUrl}|${cfg.allowPrivateNetwork ? 1 : 0}`;
  const cached = preflightCache.get(key);
  let error = cached && Date.now() - cached.at < PREFLIGHT_TTL_MS ? cached.error : undefined;
  if (!cached || Date.now() - cached.at >= PREFLIGHT_TTL_MS) {
    const check = await checkEndpoint(baseUrl, { allowPrivateNetwork: !!cfg.allowPrivateNetwork });
    error = check.ok ? undefined : check.error;
    preflightCache.set(key, { at: Date.now(), error });
  }
  if (error) throw new Error(error);
}

async function assertConfigured(id: string): Promise<void> {
  const cfg = customConfigs[id];
  if (!cfg) throw new Error(`Unknown custom provider "${id}"`);
  if (effectiveAuth(cfg).type !== "none" && !(await resolveCustomProviderAuth(id, cfg))) throw notConfiguredError(id, cfg);
  await preflight(cfg);
}

/** Stream through the custom-provider registry (auth + transport policy applied). */
export function streamCustomProvider(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  return lazyStream(model, async () => {
    await assertConfigured(model.provider as string);
    return registry().streamSimple(model, context, stripAuthOptions(options));
  });
}

export async function completeCustomProvider(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> {
  return streamCustomProvider(model, context, options).result();
}

/** Full (non-simple) completion — used when callers need provider options such as toolChoice. */
export async function completeCustomProviderRaw(
  model: Model<Api>,
  context: Context,
  options?: StreamOptions & Record<string, unknown>,
): Promise<AssistantMessage> {
  return lazyStream(model, async () => {
    await assertConfigured(model.provider as string);
    return registry().stream(model, context, stripAuthOptions(options) as never);
  }).result();
}

/**
 * One-off request against a draft config (test connection) without registering it.
 * Uses its own Models instance so the live registry is untouched.
 */
export function streamWithDraftProvider(
  id: string,
  cfg: ProviderConfig,
  secrets: ProviderSecrets | undefined,
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const draftModels = createModels();
  const api = cfg.api ?? "openai-completions";
  const draftSecrets = secrets ?? { headers: {} };
  draftModels.setProvider(createProvider({
    id,
    name: cfg.label ?? id,
    auth: {
      apiKey: {
        name: `${id} API key`,
        resolve: async () => {
          const r = await resolveCustomProviderAuth(id, cfg, { secrets: draftSecrets });
          return r ? { auth: { apiKey: r.apiKey, headers: r.headers }, source: r.source } : undefined;
        },
      },
    },
    models: [model],
    api: { [api]: withTransport(cfg, API_IMPLS[api]()) } as Partial<Record<Api, ProviderStreams>>,
  }));
  return lazyStream(model, async () => {
    if (effectiveAuth(cfg).type !== "none" && !(await resolveCustomProviderAuth(id, cfg, { secrets: draftSecrets }))) {
      throw notConfiguredError(id, cfg);
    }
    return draftModels.streamSimple(model, context, stripAuthOptions(options));
  });
}

/** Test hook: reset registry state. */
export function resetCustomProvidersForTests(): void {
  customConfigs = {};
  modelsInstance = undefined;
  secretsSource = undefined;
  secretStatus.clear();
  preflightCache.clear();
  transportFetchOverride = undefined;
}
