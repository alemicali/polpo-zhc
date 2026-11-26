/**
 * A harness's credentials, resolved from the instance settings and the vault, explicitly. Nothing
 * comes from this server's environment or files (no ANTHROPIC_API_KEY / AWS_* / ~/.claude /
 * ~/.codex lookup): the settings point to a vault entry (owner + service) chosen by a person.
 *
 * Besides the runtime's authentication environment, the result says where model requests go
 * (`route`: the upstream base URL, how the key is presented, extra gateway headers). With that,
 * the harness engine brokers the credential (src/harness/relay.ts, or a provider's native egress
 * transformer): the VM gets a placeholder and the base URL of Polpo's relay, never the key.
 * Bedrock and Vertex sign their requests (SigV4, Google OAuth), so they are not brokered.
 * Codex signed in with ChatGPT (auth "chatgpt") gets no key at all: its login cache (auth.json,
 * from the vault) is written into the agent's CODEX_HOME in the computer (codex-chatgpt.ts).
 */
import { randomBytes } from "node:crypto";
import {
  CLAUDE_SUBSCRIPTION_REFUSAL, CODEX_AUTH_JSON_FIELD, CREDENTIAL_NAMES, DEFAULT_AI_GATEWAY_BASE_URL, HARNESS_NAMES, OPENCODE_AI_GATEWAY_PROVIDER, OPENCODE_BEDROCK_PROVIDER,
  OPENCODE_GATEWAY_PROVIDER, OPENCODE_PROVIDERS, harnessCredentialRef, openCodeModelId, pickCredential, resolveVaultRef,
  type AgentHarnessEngine, type GatewayAuthScheme, type HarnessesSettings, type HarnessGatewaySettings, type OpenCodeHarnessSettings, type OpenCodeKeyHeader,
  type OpenCodeWireFormat, type VaultRef, type VaultStore,
} from "@polpo-ai/core";
import type { HarnessAuth, RequestTransformation } from "./types.js";
import { codexAuthSecrets, parseCodexAuthJson } from "./codex-chatgpt.js";

export class HarnessCredentialError extends Error {
  constructor(message: string) { super(message); this.name = "HarnessCredentialError"; }
}

/** A file the runtime needs (Vertex service account): written under the session's HOME, its path in `envVar`. */
export interface HarnessCredentialFile { envVar: string; name: string; content: string }

/**
 * Where the runtime's model requests go, for brokering and for the connection test.
 * - `upstream`: the real base URL (the runtime appends /v1/messages, /responses…).
 * - `scheme`: how the brokered key must reach the upstream; undefined: as the runtime sends it.
 * - `headers`: extra gateway headers (secret ones resolved from the vault): injected outside the VM.
 * - `baseUrlEnv`: the auth variable that holds the base URL (the relay URL replaces it).
 */
export interface HarnessModelRoute {
  /** The wire format (OpenCode: also Chat Completions, Gemini, Bedrock Converse, the AI Gateway's own). */
  format: "anthropic" | "openai-responses" | "openai-chat" | "google" | "bedrock" | "ai-gateway";
  mode: "direct" | "ai-gateway" | "gateway";
  upstream: string;
  scheme?: GatewayAuthScheme;
  /** The key itself (the connection test; never into the VM when brokered). Undefined for scheme "none". */
  key?: string;
  headers: Record<string, string>;
  /** Claude Code / Codex: the auth variable with the base URL. OpenCode has none (its provider config holds it). */
  baseUrlEnv?: "ANTHROPIC_BASE_URL" | "AI_GATEWAY_BASE_URL" | "OPENAI_BASE_URL";
  /** Non-Claude models behind the Anthropic format. */
  nonClaude?: boolean;
}

export interface ResolvedHarnessAuth extends HarnessAuth {
  files: HarnessCredentialFile[];
  /** The model the runtime uses (agent's, else the gateway's or the harness setting's; undefined: the runtime's default). */
  model?: string;
  /** Where model requests go: set when the credential can be brokered (API keys and gateways; not Bedrock / Vertex). */
  route?: HarnessModelRoute;
  /** Extra model-request headers when they are NOT brokered (the runtime sends them from the VM). */
  headers?: Record<string, string>;
  /** Non-Claude models: no adaptive thinking or effort. */
  nonClaude?: boolean;
  /** Bedrock / Vertex details for the connection test. */
  cloud?: { kind: "bedrock"; region: string; bearer?: string; accessKeyId?: string; secretAccessKey?: string; sessionToken?: string } | { kind: "vertex"; region: string; projectId: string; serviceAccountJson: string };
  /** Where the model runs (error messages name it; gateways: the harness's provider format). */
  provider: "anthropic" | "bedrock" | "vertex" | "openai" | "other";
  /** The provider's name in messages ("Moonshot AI", "Vercel AI Gateway", "Gateway llm.example.com"). */
  providerLabel?: string;
  /** OpenCode: how Polpo writes its provider config (the provider, model, key option, region). */
  openCode?: OpenCodeProviderPlan;
  /** OpenCode, after brokering: the config handed to the runtime (provider section, model). */
  openCodeConfig?: Record<string, unknown>;
  /** OpenCode, brokered: Polpo's own credential rules (placeholder → key), for the relay or the provider. */
  credentialRules?: RequestTransformation[];
  /**
   * Codex signed in with ChatGPT: the vault entry that keeps the login cache, and its auth.json
   * (absent before the first sign-in). No API key, no route: Codex reads $CODEX_HOME/auth.json.
   */
  chatgpt?: { ref: VaultRef; authJson?: string };
}

/**
 * OpenCode's provider for a run. Polpo writes OpenCode's provider config itself (never the
 * adapter's environment lookup): the key option holds the key, or a placeholder when brokered,
 * and the base URL is Polpo's relay when it is the relay that brokers.
 */
export interface OpenCodeProviderPlan {
  /** OpenCode's provider id: the model's prefix (anthropic, openai, amazon-bedrock, vercel, polpo-gateway…). */
  provider: string;
  /** The provider's model id. */
  modelId: string;
  /** The AI SDK package of a custom gateway provider (OpenCode's catalog knows the others). */
  npm?: string;
  /** A name for a custom provider. */
  name?: string;
  /** The header OpenCode's provider SDK sends the key in (the placeholder's header). */
  sends: OpenCodeKeyHeader;
  /** The header the upstream wants it in ("none": the gateway takes no key). */
  keyHeader: OpenCodeKeyHeader | "none";
  /** The provider option with the key (@ai-sdk/anthropic: authToken sends it as a Bearer token). */
  keyOption: "apiKey" | "authToken";
  /** Bedrock's region. */
  region?: string;
  /** Write the base URL even when nothing is relayed (gateways). */
  explicitBaseUrl: boolean;
}

/** Claude subscription OAuth tokens (Pro/Max): refused by policy. */
const CLAUDE_OAUTH_TOKEN = /^sk-ant-oat/i;
/** What the runtime presents when a gateway takes no key (authScheme "none"): not a secret; the relay drops it. */
export const NO_KEY_PLACEHOLDER = "polpo-gateway-no-key";

/** Environment every Claude Code process gets (root VMs; no telemetry or self-update). */
const CLAUDE_CODE_BASE_ENV: Record<string, string> = {
  // the VM runs as root: Claude Code accepts bypassPermissions ("allow-all") only with IS_SANDBOX
  IS_SANDBOX: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
};

const where = (h: "claude-code" | "codex" | "opencode") => (h === "claude-code" ? 'settings.harnesses["claude-code"]' : `settings.harnesses.${h}`);

/** The secret headers of a gateway, resolved from the vault, and the literal ones. */
async function gatewayHeaders(g: HarnessGatewaySettings | undefined, vault: VaultStore | undefined, w: string, secrets: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const h of g?.headers ?? []) {
    if (h.value !== undefined) { out[h.name] = h.value; continue; }
    const creds = await resolveVaultRef(vault, h.credentialRef);
    if (!creds) throw new HarnessCredentialError(`${w}.gateway.headers (${h.name}): the vault entry ${h.credentialRef!.owner} / ${h.credentialRef!.service} is missing`);
    const v = h.field ? creds[h.field]?.trim() : pickCredential(creds, [...CREDENTIAL_NAMES.apiKey]);
    if (!v) throw new HarnessCredentialError(`${w}.gateway.headers (${h.name}): the vault entry ${h.credentialRef!.owner} / ${h.credentialRef!.service} has no ${h.field ? `field "${h.field}"` : "key (apiKey, key or token)"}`);
    secrets.push(v);
    out[h.name] = `${h.prefix ?? ""}${v}`;
  }
  return out;
}

async function keyFrom(ref: VaultRef | undefined, vault: VaultStore | undefined, names: string[], what: string): Promise<string> {
  if (!ref) throw new HarnessCredentialError(`${what}: no credential (credentialRef)`);
  const creds = await resolveVaultRef(vault, ref);
  if (!creds) throw new HarnessCredentialError(`${what}: the vault entry ${ref.owner} / ${ref.service} is missing`);
  const key = pickCredential(creds, names);
  if (!key) throw new HarnessCredentialError(`${what}: the vault entry ${ref.owner} / ${ref.service} has no API key (a field named apiKey, key or ${names[0]})`);
  return key;
}

/** Claude Code's model environment: the main model and the haiku / sonnet / opus aliases. */
function claudeModelEnv(model: string | undefined, g: HarnessGatewaySettings | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  if (model) env.ANTHROPIC_MODEL = model;
  const m = g?.models;
  // non-Claude models: every alias goes to a model the gateway has (Claude Code's background calls use haiku)
  const fallback = g?.nonClaude ? model : undefined;
  const haiku = m?.haiku ?? fallback;
  const sonnet = m?.sonnet ?? fallback;
  const opus = m?.opus ?? fallback;
  if (haiku) { env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haiku; env.ANTHROPIC_SMALL_FAST_MODEL = haiku; }
  if (sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnet;
  if (opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = opus;
  if (g?.nonClaude) {
    env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
    env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = "1";
  }
  return env;
}

/** The header an AI SDK provider package sends its key in. */
function sendsOf(format: OpenCodeWireFormat): OpenCodeKeyHeader {
  return format === "anthropic" ? "x-api-key" : format === "google" ? "x-goog-api-key" : "bearer";
}

/**
 * OpenCode's credential, explicitly from the vault: a provider API key, a Bedrock API key (bearer
 * token: SigV4 access keys are refused, they cannot be brokered), the Vercel AI Gateway key or a
 * custom gateway's key. Everything goes in OpenCode's provider config (resolveOpenCodeConfig).
 */
async function resolveOpenCodeAuth(engine: AgentHarnessEngine, h: OpenCodeHarnessSettings, vault: VaultStore | undefined): Promise<ResolvedHarnessAuth> {
  const w = "settings.harnesses.opencode";
  const mainRef = engine.credentialRef ?? harnessCredentialRef(h);
  const refWhere = engine.credentialRef ? "the agent's engine.credentialRef" : h.gateway ? `${w}.gateway.credentialRef` : `${w}.credentialRef`;
  const g = h.gateway;
  const secrets: string[] = [];
  const provider = h.auth === "api-key" ? h.provider! : h.auth === "bedrock" ? OPENCODE_BEDROCK_PROVIDER : h.auth === "ai-gateway" ? OPENCODE_AI_GATEWAY_PROVIDER : OPENCODE_GATEWAY_PROVIDER;
  const rawModel = engine.model ?? g?.models?.main ?? h.model;
  if (!rawModel) throw new HarnessCredentialError(`OpenCode needs a model: set ${w}.model${h.gateway ? " (or gateway.models.main)" : ""} or the agent's engine.model (e.g. ${h.auth === "api-key" ? OPENCODE_PROVIDERS[h.provider!].example : h.auth === "bedrock" ? "global.moonshotai.kimi-k3.1" : "moonshotai/kimi-k2"})`);
  const modelId = openCodeModelId(rawModel, provider);
  const model = `${provider}/${modelId}`;
  const what = `OpenCode (${refWhere})`;

  if (h.auth === "api-key") {
    const p = OPENCODE_PROVIDERS[h.provider!];
    const key = await keyFrom(mainRef, vault, [...p.keyNames, ...CREDENTIAL_NAMES.apiKey], what);
    if (h.provider === "anthropic" && CLAUDE_OAUTH_TOKEN.test(key)) throw new HarnessCredentialError(`OpenCode: that vault entry holds a Claude subscription token. ${CLAUDE_SUBSCRIPTION_REFUSAL}`);
    return {
      auth: {}, env: {}, secrets: [key], files: [], model,
      provider: h.provider === "anthropic" ? "anthropic" : h.provider === "openai" ? "openai" : "other", providerLabel: p.name,
      route: { format: p.format, mode: "direct", upstream: p.baseUrl, key, headers: {} },
      openCode: { provider, modelId, sends: sendsOf(p.format), keyHeader: p.keyHeader, keyOption: "apiKey", explicitBaseUrl: false },
    };
  }

  if (h.auth === "bedrock") {
    const region = h.bedrock?.region;
    if (!region) throw new HarnessCredentialError(`OpenCode on Bedrock needs ${w}.bedrock.region`);
    if (!mainRef) throw new HarnessCredentialError(`${what}: no credential (credentialRef)`);
    const creds = await resolveVaultRef(vault, mainRef);
    if (!creds) throw new HarnessCredentialError(`${what}: the vault entry ${mainRef.owner} / ${mainRef.service} is missing`);
    const bearer = pickCredential(creds, ["AWS_BEARER_TOKEN_BEDROCK", "bearerToken", "bedrockApiKey", ...CREDENTIAL_NAMES.apiKey]);
    if (!bearer) {
      const sigv4 = pickCredential(creds, [...CREDENTIAL_NAMES.accessKeyId]) && pickCredential(creds, [...CREDENTIAL_NAMES.secretAccessKey]);
      throw new HarnessCredentialError(`OpenCode on Bedrock: the vault entry ${mainRef.owner} / ${mainRef.service} needs a Bedrock API key (a field named apiKey or AWS_BEARER_TOKEN_BEDROCK)${sigv4 ? ": AWS access keys sign every request (SigV4) and cannot be kept out of the VM, so OpenCode takes a Bedrock API key only" : ""}`);
    }
    const upstream = `https://bedrock-runtime.${region}.amazonaws.com`;
    return {
      auth: {}, env: {}, secrets: [bearer], files: [], model, provider: "bedrock", providerLabel: "Bedrock",
      cloud: { kind: "bedrock", region, bearer },
      route: { format: "bedrock", mode: "direct", upstream, key: bearer, headers: {} },
      openCode: { provider, modelId, sends: "bearer", keyHeader: "bearer", keyOption: "apiKey", region, explicitBaseUrl: false },
    };
  }

  // gateways
  const scheme: GatewayAuthScheme = h.auth === "ai-gateway" ? "bearer" : (g?.authScheme ?? "bearer");
  const key = scheme === "none" ? undefined : await keyFrom(mainRef, vault, ["AI_GATEWAY_API_KEY", ...CREDENTIAL_NAMES.apiKey], what);
  if (key) {
    if (CLAUDE_OAUTH_TOKEN.test(key)) throw new HarnessCredentialError(`OpenCode: that vault entry holds a Claude subscription token. ${CLAUDE_SUBSCRIPTION_REFUSAL}`);
    secrets.push(key);
  }
  const headers = await gatewayHeaders(g, vault, w, secrets);
  if (h.auth === "ai-gateway") {
    const base = (g?.baseUrl ?? DEFAULT_AI_GATEWAY_BASE_URL).replace(/\/+$/, "");
    return {
      auth: {}, env: {}, secrets, files: [], model, provider: "other", providerLabel: "Vercel AI Gateway",
      route: { format: "ai-gateway", mode: "ai-gateway", upstream: `${base}/v1/ai`, ...(key ? { key } : {}), headers },
      openCode: { provider, modelId, sends: "bearer", keyHeader: "bearer", keyOption: "apiKey", explicitBaseUrl: true },
    };
  }
  const format = g!.format ?? "openai-chat";
  const upstream = format === "anthropic" ? `${g!.baseUrl!}/v1` : g!.baseUrl!;
  // @ai-sdk/anthropic sends apiKey as x-api-key and authToken as a Bearer token; the OpenAI ones send Bearer
  const keyOption = format === "anthropic" && scheme === "bearer" ? "authToken" : "apiKey";
  const sends: OpenCodeKeyHeader = format === "anthropic" ? (keyOption === "authToken" ? "bearer" : "x-api-key") : "bearer";
  return {
    auth: {}, env: {}, secrets, files: [], model, provider: "other", providerLabel: `Gateway ${new URL(g!.baseUrl!).host}`,
    route: { format, mode: "gateway", upstream, scheme, ...(key ? { key } : {}), headers },
    openCode: {
      provider, modelId, sends, keyHeader: scheme === "none" ? "none" : scheme, keyOption, explicitBaseUrl: true, name: "Polpo gateway",
      npm: format === "anthropic" ? "@ai-sdk/anthropic" : format === "openai-responses" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible",
    },
  };
}

/** Polpo's credential rules for OpenCode: requests carrying the placeholder get the key (as the upstream wants it). */
export function openCodeCredentialRules(o: { upstream: string; placeholder: string; sends: OpenCodeKeyHeader; keyHeader: OpenCodeKeyHeader | "none"; key?: string }): RequestTransformation[] {
  const host = new URL(o.upstream).hostname;
  const match = o.sends === "x-api-key" ? { key: { exact: "x-api-key" }, value: { exact: o.placeholder } }
    : o.sends === "x-goog-api-key" ? { key: { exact: "x-goog-api-key" }, value: { exact: o.placeholder } }
      : { key: { exact: "authorization" }, value: { exact: `Bearer ${o.placeholder}` } };
  const transform: Record<string, string> = o.keyHeader === "none" || !o.key ? { authorization: "", "x-api-key": "" }
    : o.keyHeader === "x-api-key" ? { "x-api-key": o.key, authorization: "" }
      : o.keyHeader === "x-goog-api-key" ? { "x-goog-api-key": o.key }
        : { authorization: `Bearer ${o.key}`, "x-api-key": "" };
  return [{ match: { host, headers: [match] }, transform: { headers: transform } }];
}

/**
 * OpenCode's config for one run: only the chosen provider (no other provider, no OpenCode Zen, no
 * login), the model (also the small model: titles and summaries stay on it), the key (or the
 * placeholder), the base URL (Polpo's relay when it brokers), gateway headers when not brokered.
 */
function brokeredOpenCodeAuth(a: ResolvedHarnessAuth, mode: HarnessBrokering, relayBaseUrl?: string): ResolvedHarnessAuth {
  const oc = a.openCode!;
  const route = a.route!;
  if (mode === "relay" && !relayBaseUrl) throw new Error("brokeredHarnessAuth: the relay base URL is required");
  if (mode === "none" && oc.keyHeader !== "none" && oc.keyHeader !== oc.sends && !(oc.keyHeader === "x-api-key" && oc.sends === "x-api-key")) {
    throw new HarnessCredentialError(`OpenCode sends this provider's key as ${oc.sends === "bearer" ? "Authorization: Bearer" : oc.sends}; a gateway that wants ${oc.keyHeader} needs Polpo's model relay (set POLPO_PUBLIC_URL and expose its relay path)`);
  }
  const placeholder = mode === "none" ? undefined : `polpo-placeholder-${randomBytes(24).toString("base64url")}`;
  const credential = placeholder ?? route.key ?? NO_KEY_PLACEHOLDER;
  const options: Record<string, unknown> = {};
  if (oc.region) options.region = oc.region;
  options[oc.keyOption] = credential;
  const base = mode === "relay" ? relayBaseUrl : oc.explicitBaseUrl ? route.upstream : undefined;
  if (base) options[oc.provider === OPENCODE_BEDROCK_PROVIDER ? "endpoint" : "baseURL"] = base;
  if (mode === "none" && Object.keys(route.headers).length) options.headers = { ...route.headers };
  const config: Record<string, unknown> = {
    enabled_providers: [oc.provider],
    model: a.model,
    small_model: a.model,
    provider: {
      [oc.provider]: {
        ...(oc.npm ? { npm: oc.npm } : {}),
        ...(oc.name ? { name: oc.name } : {}),
        options,
        // listed: a model OpenCode's catalog does not know yet still resolves (catalog data is kept)
        models: { [oc.modelId]: {} },
      },
    },
  };
  const credentialRules = placeholder
    ? openCodeCredentialRules({ upstream: route.upstream, placeholder, sends: oc.sends, keyHeader: oc.keyHeader, ...(route.key ? { key: route.key } : {}) })
    : undefined;
  const { headers: _unbrokered, ...rest } = a;
  return { ...rest, openCodeConfig: config, ...(credentialRules ? { credentialRules } : {}) };
}

export async function resolveHarnessAuth(
  engine: AgentHarnessEngine,
  settings: HarnessesSettings | undefined,
  vault: VaultStore | undefined,
): Promise<ResolvedHarnessAuth> {
  const name = HARNESS_NAMES[engine.harness];
  if (!settings?.enabled.includes(engine.harness)) throw new HarnessCredentialError(`${name} is not enabled on this instance (Settings → Harnesses)`);
  const w = where(engine.harness);
  const h = settings[engine.harness];
  if (!h) throw new HarnessCredentialError(`${name} has no settings (${w})`);
  if (engine.harness === "opencode") return resolveOpenCodeAuth(engine, h as OpenCodeHarnessSettings, vault);
  if (h.auth === "bedrock" && engine.harness !== "claude-code") throw new HarnessCredentialError(`${name} has no Bedrock authentication`);
  // the agent's own credential (cost separation) replaces the main one
  const mainRef = engine.credentialRef ?? harnessCredentialRef(h);
  const refWhere = engine.credentialRef ? "the agent's engine.credentialRef" : h.gateway ? `${w}.gateway.credentialRef` : `${w}.credentialRef`;
  const g = h.gateway;
  const model = engine.model ?? g?.models?.main ?? h.model;
  const secrets: string[] = [];

  // ── Codex signed in with ChatGPT: no key; the login cache goes into the agent's CODEX_HOME ──
  if (engine.harness === "codex" && h.auth === "chatgpt") {
    if (!mainRef) throw new HarnessCredentialError(`Codex (${refWhere}): no vault entry for the ChatGPT sign-in (credentialRef)`);
    const creds = await resolveVaultRef(vault, mainRef);
    const file = parseCodexAuthJson(creds?.[CODEX_AUTH_JSON_FIELD]);
    return {
      // an explicit, empty authentication environment: nothing from this server; Codex in the
      // computer reads its own $CODEX_HOME/auth.json (no OPENAI_BASE_URL, no CODEX_API_KEY)
      auth: {}, env: {}, secrets: codexAuthSecrets(file?.raw), files: [], provider: "openai", providerLabel: "ChatGPT",
      ...(model ? { model } : {}),
      chatgpt: { ref: mainRef, ...(file ? { authJson: file.raw } : {}) },
    };
  }

  // ── gateways (both harnesses) ──
  if (h.auth === "ai-gateway" || h.auth === "gateway") {
    const scheme: GatewayAuthScheme = h.auth === "ai-gateway" ? (engine.harness === "claude-code" ? "x-api-key" : "bearer") : (g?.authScheme ?? "bearer");
    const key = scheme === "none" ? undefined : await keyFrom(mainRef, vault, [engine.harness === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY", "AI_GATEWAY_API_KEY", ...CREDENTIAL_NAMES.apiKey], `${name} (${refWhere})`);
    if (key) {
      if (CLAUDE_OAUTH_TOKEN.test(key)) throw new HarnessCredentialError(`${name}: that vault entry holds a Claude subscription token. ${CLAUDE_SUBSCRIPTION_REFUSAL}`);
      secrets.push(key);
    }
    const headers = await gatewayHeaders(g, vault, w, secrets);
    const upstream = h.auth === "ai-gateway" ? (g?.baseUrl ?? DEFAULT_AI_GATEWAY_BASE_URL) : g!.baseUrl!;
    const credentialValue = key ?? NO_KEY_PLACEHOLDER;
    let auth: Record<string, string>;
    let baseUrlEnv: HarnessModelRoute["baseUrlEnv"];
    if (h.auth === "ai-gateway") {
      auth = { AI_GATEWAY_API_KEY: credentialValue, AI_GATEWAY_BASE_URL: upstream };
      baseUrlEnv = "AI_GATEWAY_BASE_URL";
    } else if (engine.harness === "claude-code") {
      auth = { [scheme === "x-api-key" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN"]: credentialValue, ANTHROPIC_BASE_URL: upstream };
      baseUrlEnv = "ANTHROPIC_BASE_URL";
    } else {
      auth = { CODEX_API_KEY: credentialValue, OPENAI_BASE_URL: upstream };
      baseUrlEnv = "OPENAI_BASE_URL";
    }
    const route: HarnessModelRoute = {
      format: engine.harness === "claude-code" ? "anthropic" : "openai-responses", mode: h.auth, upstream,
      ...(h.auth === "gateway" ? { scheme } : {}), ...(key ? { key } : {}), headers, baseUrlEnv, ...(g?.nonClaude ? { nonClaude: true } : {}),
    };
    const env = engine.harness === "claude-code" ? { ...CLAUDE_CODE_BASE_ENV, ...claudeModelEnv(model, g) } : {};
    return { auth, env, secrets, files: [], route, provider: engine.harness === "codex" ? "openai" : "anthropic", ...(model ? { model } : {}), ...(g?.nonClaude ? { nonClaude: true } : {}) };
  }

  if (engine.harness === "codex") {
    const key = await keyFrom(mainRef, vault, ["OPENAI_API_KEY", "openaiApiKey", "CODEX_API_KEY", ...CREDENTIAL_NAMES.apiKey], `Codex (${refWhere})`);
    return {
      auth: { OPENAI_API_KEY: key }, env: {}, secrets: [key], files: [], provider: "openai", ...(model ? { model } : {}),
      route: { format: "openai-responses", mode: "direct", upstream: "https://api.openai.com/v1", key, headers: {}, baseUrlEnv: "OPENAI_BASE_URL" },
    };
  }

  const cc = settings["claude-code"]!;
  if (cc.auth === "api-key") {
    const key = await keyFrom(mainRef, vault, ["ANTHROPIC_API_KEY", "anthropicApiKey", ...CREDENTIAL_NAMES.apiKey], `Claude Code (${refWhere})`);
    if (CLAUDE_OAUTH_TOKEN.test(key)) throw new HarnessCredentialError(`Claude Code: that vault entry holds a Claude subscription token. ${CLAUDE_SUBSCRIPTION_REFUSAL}`);
    return {
      auth: { ANTHROPIC_API_KEY: key },
      env: { ...CLAUDE_CODE_BASE_ENV, ...(model ? { ANTHROPIC_MODEL: model } : {}) },
      secrets: [key], files: [], provider: "anthropic", ...(model ? { model } : {}),
      route: { format: "anthropic", mode: "direct", upstream: "https://api.anthropic.com", key, headers: {}, baseUrlEnv: "ANTHROPIC_BASE_URL" },
    };
  }

  const creds = await resolveVaultRef(vault, cc.credentialRef);
  if (!creds) throw new HarnessCredentialError(`${name}: the vault entry ${cc.credentialRef?.owner} / ${cc.credentialRef?.service} (${w}.credentialRef) is missing`);

  if (cc.auth === "bedrock") {
    const region = cc.bedrock?.region;
    if (!region) throw new HarnessCredentialError("Claude Code on Bedrock needs settings.harnesses[\"claude-code\"].bedrock.region");
    const bearer = pickCredential(creds, ["AWS_BEARER_TOKEN_BEDROCK", "bearerToken", "bedrockApiKey", ...CREDENTIAL_NAMES.apiKey]);
    const accessKeyId = pickCredential(creds, [...CREDENTIAL_NAMES.accessKeyId]);
    const secretAccessKey = pickCredential(creds, [...CREDENTIAL_NAMES.secretAccessKey]);
    const sessionToken = pickCredential(creds, [...CREDENTIAL_NAMES.sessionToken]);
    const env: Record<string, string> = { ...CLAUDE_CODE_BASE_ENV, CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: region };
    let cloud: ResolvedHarnessAuth["cloud"];
    if (accessKeyId && secretAccessKey) {
      env.AWS_ACCESS_KEY_ID = accessKeyId;
      env.AWS_SECRET_ACCESS_KEY = secretAccessKey;
      if (sessionToken) env.AWS_SESSION_TOKEN = sessionToken;
      secrets.push(secretAccessKey, ...(sessionToken ? [sessionToken] : []));
      cloud = { kind: "bedrock", region, accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
    } else if (bearer) {
      env.AWS_BEARER_TOKEN_BEDROCK = bearer;
      secrets.push(bearer);
      cloud = { kind: "bedrock", region, bearer };
    } else {
      throw new HarnessCredentialError(`Claude Code on Bedrock: the vault entry ${cc.credentialRef!.owner} / ${cc.credentialRef!.service} needs a Bedrock API key (apiKey / AWS_BEARER_TOKEN_BEDROCK) or accessKeyId + secretAccessKey`);
    }
    if (model) {
      env.ANTHROPIC_MODEL = model;
      // a Haiku model id is also the small/fast model (otherwise Claude Code's Bedrock default)
      if (/haiku/i.test(model)) { env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model; env.ANTHROPIC_SMALL_FAST_MODEL = model; }
    }
    // auth {} = an explicit, empty authentication environment: no lookup on this server
    return { auth: {}, env, secrets, files: [], provider: "bedrock", cloud, ...(model ? { model } : {}) };
  }

  // vertex
  const v = cc.vertex;
  if (!v) throw new HarnessCredentialError("Claude Code on Vertex AI needs settings.harnesses[\"claude-code\"].vertex { region, projectId }");
  const json = pickCredential(creds, ["serviceAccountJson", "service_account_json", "GOOGLE_APPLICATION_CREDENTIALS", "credentialsJson", "json", "credentials"]);
  if (!json || !json.trim().startsWith("{")) throw new HarnessCredentialError(`Claude Code on Vertex AI: the vault entry ${cc.credentialRef!.owner} / ${cc.credentialRef!.service} needs a service account key (JSON) in a field named serviceAccountJson`);
  const env: Record<string, string> = {
    ...CLAUDE_CODE_BASE_ENV, CLAUDE_CODE_USE_VERTEX: "1", CLOUD_ML_REGION: v.region, ANTHROPIC_VERTEX_PROJECT_ID: v.projectId,
    ...(model ? { ANTHROPIC_MODEL: model } : {}),
  };
  let privateKey: string | undefined;
  try { privateKey = (JSON.parse(json) as { private_key?: string }).private_key; } catch { /* checked by Google */ }
  return {
    auth: {}, env, secrets: [json, ...(privateKey ? [privateKey] : [])],
    files: [{ envVar: "GOOGLE_APPLICATION_CREDENTIALS", name: "vertex-service-account.json", content: json }],
    cloud: { kind: "vertex", region: v.region, projectId: v.projectId, serviceAccountJson: json },
    provider: "vertex",
    ...(model ? { model } : {}),
  };
}

/**
 * How the credential reaches the model provider for one run:
 * - "relay": the VM's base URL is Polpo's model relay; the VM holds placeholders only.
 * - "native": the computer's provider rewrites the VM's outbound requests itself (same rules).
 * - "none": the key and the gateway headers go into the VM (no relay reachable, or Bedrock / Vertex).
 */
export type HarnessBrokering = "relay" | "native" | "none";

/**
 * The authentication for a brokered run: the base URL variable points to `relayBaseUrl` (relay) or
 * stays the upstream (native). The key stays in `auth` (the AI SDK turns it into a placeholder and a
 * request transformation); the gateway headers become Polpo's own transformation rules.
 * Unbrokered ("none"): the gateway headers go with the model requests from the VM.
 */
export function brokeredHarnessAuth(a: ResolvedHarnessAuth, mode: HarnessBrokering, relayBaseUrl?: string): ResolvedHarnessAuth {
  if (a.openCode) return brokeredOpenCodeAuth(a, mode, relayBaseUrl);
  if (!a.route || mode === "none") {
    const headers = a.route && Object.keys(a.route.headers).length ? a.route.headers : undefined;
    if (a.route?.scheme === "x-api-key" && a.route.format === "openai-responses") {
      throw new HarnessCredentialError("Codex sends its key as Authorization: Bearer; a gateway that wants x-api-key needs Polpo's model relay (set POLPO_PUBLIC_URL and expose its relay path)");
    }
    // the direct Anthropic / OpenAI routes keep the runtime's own base URL (none in the environment)
    const auth = { ...a.auth };
    if (a.route?.mode === "direct" && a.route.baseUrlEnv) delete auth[a.route.baseUrlEnv];
    return { ...a, auth, ...(headers ? { headers } : {}) };
  }
  const auth = { ...a.auth };
  if (mode === "relay") {
    if (!relayBaseUrl) throw new Error("brokeredHarnessAuth: the relay base URL is required");
    if (a.route.baseUrlEnv) auth[a.route.baseUrlEnv] = relayBaseUrl;
  } else if (a.route.mode === "direct" && a.route.baseUrlEnv) {
    // native: the VM calls the upstream itself (the provider swaps the placeholder on the way out)
    auth[a.route.baseUrlEnv] = a.route.upstream;
  }
  // Codex reads OPENAI_API_KEY or CODEX_API_KEY; the AI SDK brokers CODEX_API_KEY
  if (auth.OPENAI_API_KEY && !auth.CODEX_API_KEY) { auth.CODEX_API_KEY = auth.OPENAI_API_KEY; delete auth.OPENAI_API_KEY; }
  const { headers: _unbrokered, ...rest } = a;
  return { ...rest, auth };
}

/** Text with every secret replaced (transcripts, errors, logs). */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("<redacted>");
  return out;
}
