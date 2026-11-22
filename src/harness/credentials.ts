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
 */
import {
  CLAUDE_SUBSCRIPTION_REFUSAL, CREDENTIAL_NAMES, DEFAULT_AI_GATEWAY_BASE_URL, HARNESS_NAMES, harnessCredentialRef, pickCredential, resolveVaultRef,
  type AgentHarnessEngine, type GatewayAuthScheme, type HarnessesSettings, type HarnessGatewaySettings, type VaultRef, type VaultStore,
} from "@polpo-ai/core";
import type { HarnessAuth } from "./types.js";

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
  format: "anthropic" | "openai-responses";
  mode: "direct" | "ai-gateway" | "gateway";
  upstream: string;
  scheme?: GatewayAuthScheme;
  /** The key itself (the connection test; never into the VM when brokered). Undefined for scheme "none". */
  key?: string;
  headers: Record<string, string>;
  baseUrlEnv: "ANTHROPIC_BASE_URL" | "AI_GATEWAY_BASE_URL" | "OPENAI_BASE_URL";
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
  provider: "anthropic" | "bedrock" | "vertex" | "openai";
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

const where = (h: "claude-code" | "codex") => (h === "claude-code" ? 'settings.harnesses["claude-code"]' : "settings.harnesses.codex");

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
  // the agent's own credential (cost separation) replaces the main one
  const mainRef = engine.credentialRef ?? harnessCredentialRef(h);
  const refWhere = engine.credentialRef ? "the agent's engine.credentialRef" : h.gateway ? `${w}.gateway.credentialRef` : `${w}.credentialRef`;
  const g = h.gateway;
  const model = engine.model ?? g?.models?.main ?? h.model;
  const secrets: string[] = [];

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
  if (!a.route || mode === "none") {
    const headers = a.route && Object.keys(a.route.headers).length ? a.route.headers : undefined;
    if (a.route?.scheme === "x-api-key" && a.route.format === "openai-responses") {
      throw new HarnessCredentialError("Codex sends its key as Authorization: Bearer; a gateway that wants x-api-key needs Polpo's model relay (set POLPO_PUBLIC_URL and expose its relay path)");
    }
    // the direct Anthropic / OpenAI routes keep the runtime's own base URL (none in the environment)
    const auth = { ...a.auth };
    if (a.route?.mode === "direct") delete auth[a.route.baseUrlEnv];
    return { ...a, auth, ...(headers ? { headers } : {}) };
  }
  const auth = { ...a.auth };
  if (mode === "relay") {
    if (!relayBaseUrl) throw new Error("brokeredHarnessAuth: the relay base URL is required");
    auth[a.route.baseUrlEnv] = relayBaseUrl;
  } else if (a.route.mode === "direct") {
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
