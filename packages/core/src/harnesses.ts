/**
 * Agent harnesses (settings.harnesses + agent.engine): an agent may run on an official agent
 * runtime (Claude Code, Codex) instead of Polpo's own engine. The runtime runs inside the agent's
 * computer (a remote VM), Polpo's tools are offered to it as host tools, and its usage is metered
 * as Polpo's own.
 *
 * Rules shared by the config file, the API, the MCP tools and the dashboard live here; the
 * runtime is src/harness/ and src/adapters/harness-engine.ts.
 *
 * - The instance enables harnesses explicitly (settings.harnesses.enabled) and gives each one an
 *   explicit credential: a vault reference (owner + service), never a secret in the config.
 * - Claude Code: an Anthropic API key, Amazon Bedrock, Google Vertex AI, the Vercel AI Gateway or a
 *   custom model gateway (Cloudflare AI Gateway, OpenRouter, LiteLLM, Portkey, Kong…). A Claude
 *   subscription (Pro/Max login, OAuth token) is refused: Anthropic's terms do not allow it in a
 *   product that serves other people. Codex: an OpenAI API key, the Vercel AI Gateway or a custom
 *   gateway that speaks the OpenAI Responses API (ChatGPT login is not supported yet).
 * - Gateway keys and secret gateway headers are vault references too. At run time Polpo's model
 *   relay (src/harness/relay.ts) injects them outside the VM; the VM only sees placeholders.
 * - An agent on a harness needs a sandboxed computer: a remote computer (Daytona v2), or this
 *   server only when the instance allows it (settings.harnesses.allowHost), and then with an
 *   isolated HOME under the run's working directory (never the server's ~/.claude or ~/.codex).
 */
import { normalizeVaultRef, type VaultRef } from "./vault-ref.js";
import { HOST_COMPUTER_ID, isRemoteComputer, type ComputerConfig } from "./computers.js";

export type HarnessId = "claude-code" | "codex";
export const HARNESS_IDS: readonly HarnessId[] = ["claude-code", "codex"];
export const HARNESS_NAMES: Record<HarnessId, string> = { "claude-code": "Claude Code", codex: "Codex" };

export type ClaudeCodeAuth = "api-key" | "bedrock" | "vertex" | "ai-gateway" | "gateway";
export const CLAUDE_CODE_AUTHS: readonly ClaudeCodeAuth[] = ["api-key", "bedrock", "vertex", "ai-gateway", "gateway"];
export type CodexAuth = "api-key" | "ai-gateway" | "gateway";
export const CODEX_AUTHS: readonly CodexAuth[] = ["api-key", "ai-gateway", "gateway"];

/** The wire format a custom gateway speaks: Anthropic Messages (Claude Code) or OpenAI Responses (Codex). */
export type GatewayFormat = "anthropic" | "openai-responses";
export const GATEWAY_FORMATS: readonly GatewayFormat[] = ["anthropic", "openai-responses"];
/** How the gateway key is presented: x-api-key, Authorization: Bearer, or not at all (auth in a header). */
export type GatewayAuthScheme = "x-api-key" | "bearer" | "none";
export const GATEWAY_AUTH_SCHEMES: readonly GatewayAuthScheme[] = ["x-api-key", "bearer", "none"];
/** The dashboard's presets (a label only: the URL, scheme and headers are what count). */
export type GatewayPreset = "vercel" | "cloudflare" | "openrouter" | "litellm" | "portkey" | "kong" | "custom";
export const GATEWAY_PRESETS: readonly GatewayPreset[] = ["vercel", "cloudflare", "openrouter", "litellm", "portkey", "kong", "custom"];
/** The Vercel AI Gateway (auth "ai-gateway" without a baseUrl). */
export const DEFAULT_AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";

/**
 * An extra header for every model request through a gateway. A secret value comes from the vault
 * (credentialRef + optional field, with an optional prefix such as "Bearer "); a literal `value`
 * must not look like a secret.
 */
export interface GatewayHeader {
  name: string;
  credentialRef?: VaultRef;
  /** The entry's field (default: its apiKey / key / token). */
  field?: string;
  /** Put before the secret (e.g. "Bearer "). */
  prefix?: string;
  /** A literal, non-secret value (e.g. Portkey's x-portkey-provider). */
  value?: string;
}

/** Model ids on a gateway: the main one, and what Claude Code's haiku / sonnet / opus aliases become. */
export interface GatewayModels { main: string; haiku?: string; sonnet?: string; opus?: string }

/**
 * A gateway between the runtime and the model provider.
 * - auth "ai-gateway" (Vercel AI Gateway): { baseUrl? (default https://ai-gateway.vercel.sh), credentialRef }.
 * - auth "gateway" (any gateway): { format, baseUrl, credentialRef?, authScheme, headers?, models?, nonClaude? }.
 */
export interface HarnessGatewaySettings {
  preset?: GatewayPreset;
  format?: GatewayFormat;
  baseUrl?: string;
  credentialRef?: VaultRef;
  authScheme?: GatewayAuthScheme;
  headers?: GatewayHeader[];
  models?: GatewayModels;
  /** Non-Claude models behind the Anthropic format: no experimental betas, no adaptive thinking or effort. */
  nonClaude?: boolean;
}

/** Auth values people try that are refused, with the reason. */
const CLAUDE_SUBSCRIPTION_AUTHS = new Set(["subscription", "pro", "max", "oauth", "claude-ai", "claude.ai", "login", "native"]);
export const CLAUDE_SUBSCRIPTION_REFUSAL =
  "A Claude subscription (Pro/Max login or OAuth token) cannot run Claude Code for Polpo agents: Anthropic's terms do not allow a consumer subscription in a product that runs agents for other people. Use an Anthropic API key, Amazon Bedrock, Google Vertex AI or a model gateway";
export const CODEX_CHATGPT_REFUSAL =
  "Codex with a ChatGPT login is not supported yet: use an OpenAI API key or a model gateway";

export interface ClaudeCodeHarnessSettings {
  auth: ClaudeCodeAuth;
  /**
   * Vault entry with the credential: api-key → apiKey; bedrock → apiKey (a Bedrock API key / bearer
   * token); vertex → a service account JSON. Gateways keep theirs in gateway.credentialRef.
   */
  credentialRef?: VaultRef;
  gateway?: HarnessGatewaySettings;
  bedrock?: { region: string };
  vertex?: { region: string; projectId: string };
  /** Default model id (an agent may choose its own). */
  model?: string;
}

export interface CodexHarnessSettings {
  auth: CodexAuth;
  /** api-key: the OpenAI API key's entry. Gateways keep theirs in gateway.credentialRef. */
  credentialRef?: VaultRef;
  gateway?: HarnessGatewaySettings;
  model?: string;
}

export interface HarnessesSettings {
  enabled: HarnessId[];
  /** Agents on this server (computer "host") may use a harness; it runs with an isolated HOME. Default false. */
  allowHost?: boolean;
  "claude-code"?: ClaudeCodeHarnessSettings;
  codex?: CodexHarnessSettings;
}

/** The harness's main credential reference (the gateway's for gateways), if any. */
export function harnessCredentialRef(h: { credentialRef?: VaultRef; gateway?: HarnessGatewaySettings } | undefined): VaultRef | undefined {
  return h?.gateway?.credentialRef ?? h?.credentialRef;
}

/** Every vault reference a harness setting uses: its credential and its secret gateway headers. */
export function harnessVaultRefs(h: { credentialRef?: VaultRef; gateway?: HarnessGatewaySettings } | undefined): Array<{ ref: VaultRef; field?: string; where: string }> {
  const out: Array<{ ref: VaultRef; field?: string; where: string }> = [];
  const main = harnessCredentialRef(h);
  if (main) out.push({ ref: main, where: h?.gateway?.credentialRef ? "gateway.credentialRef" : "credentialRef" });
  for (const [i, x] of (h?.gateway?.headers ?? []).entries()) {
    if (x.credentialRef) out.push({ ref: x.credentialRef, ...(x.field ? { field: x.field } : {}), where: `gateway.headers[${i}] (${x.name})` });
  }
  return out;
}

/** The model ids a harness setting serves (gateway models first, then the harness model). */
export function harnessMainModel(h: { model?: string; gateway?: HarnessGatewaySettings } | undefined): string | undefined {
  return h?.gateway?.models?.main ?? h?.model;
}

export type HarnessPermissionMode = "allow-all" | "allow-edits" | "allow-reads";
export const HARNESS_PERMISSION_MODES: readonly HarnessPermissionMode[] = ["allow-all", "allow-edits", "allow-reads"];
export type HarnessEffort = "low" | "medium" | "high" | "xhigh" | "max";
export const HARNESS_EFFORTS: readonly HarnessEffort[] = ["low", "medium", "high", "xhigh", "max"];

export interface AgentHarnessEngine {
  harness: HarnessId;
  /** Model id for the runtime (default: the harness setting's model, then the runtime's own). */
  model?: string;
  /** Default "allow-all" (the runtime works unattended in its sandbox). */
  permissionMode?: HarnessPermissionMode;
  effort?: HarnessEffort;
  /** Stop a run when its estimated spend passes this (USD). */
  maxBudgetUsd?: number;
  /**
   * This agent's own credential (cost separation): replaces the harness setting's main credential
   * (the API key, or the gateway key) for its runs. A vault reference, never the key.
   */
  credentialRef?: VaultRef;
}

/** agent.engine: "polpo" (default) or a harness. */
export type AgentEngine = "polpo" | AgentHarnessEngine;

export class HarnessConfigError extends Error {
  constructor(message: string) { super(message); this.name = "HarnessConfigError"; }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const MODEL = /^[A-Za-z0-9._:/@\[\]-]{1,200}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$|^global$|^[a-z]+-[a-z]+\d$/;
/** An HTTP header name (RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,100}$/;
/** Headers a gateway setting may not set: the relay and the runtime own them. */
const RESERVED_HEADER = /^(host|content-length|content-type|transfer-encoding|connection|keep-alive|upgrade|te|trailer|proxy-.*|authorization|x-api-key|cookie|anthropic-.*|x-stainless-.*)$/i;

function parseRef(raw: unknown, where: string): VaultRef {
  if (typeof raw === "string") {
    throw new HarnessConfigError(`${where} must be a vault reference { owner, service }, never the key itself: store the key in an agent's vault and point to that entry`);
  }
  const ref = normalizeVaultRef(raw);
  if (!ref) throw new HarnessConfigError(`${where} must be a vault reference { owner: <agent>, service: <entry> }`);
  return ref;
}

function parseModel(raw: unknown, where: string): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const m = str(raw);
  if (!m || !MODEL.test(m)) throw new HarnessConfigError(`${where} must be a model id`);
  return m;
}

/** Secret-looking fields that never belong in the settings. */
const SECRET_KEYS = /^(api[-_]?key|apikey|key|token|secret|password|accessKey|secretAccessKey|bearer|oauthToken)$/i;

function refuseSecrets(r: Record<string, unknown>, where: string): void {
  for (const k of Object.keys(r)) {
    if (SECRET_KEYS.test(k)) throw new HarnessConfigError(`${where}.${k}: secrets never go in the settings; store it in the vault and set credentialRef { owner, service }`);
  }
}

/**
 * A literal header value that looks like a credential (it must come from the vault instead):
 * a known key prefix, a bearer/basic token, a JWT, or a long random-looking string.
 */
export function looksLikeSecret(value: string): boolean {
  const v = value.trim();
  if (/^(bearer|basic|token)\s+\S/i.test(v)) return true;
  if (/^(sk|pk|rk)[-_]|^(xox[abpr]-|ghp_|gho_|ghs_|github_pat_|glpat-|AKIA|ASIA|AIza|ya29\.|eyJ)|^sk-ant-|^vck_|^cfut_/.test(v)) return true;
  if (v.length >= 24 && /^[A-Za-z0-9_\-+/=.:]+$/.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v)) return true;
  return false;
}

/**
 * A gateway base URL: https, no user info, no query or fragment; returned without a trailing slash.
 * http is allowed only for localhost (a gateway on this server, e.g. LiteLLM in development).
 */
export function parseGatewayBaseUrl(raw: unknown, where: string): string {
  const s = str(raw);
  if (!s) throw new HarnessConfigError(`${where} must be the gateway's base URL (https://…)`);
  let u: URL;
  try { u = new URL(s); } catch { throw new HarnessConfigError(`${where} must be a URL (https://…)`); }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new HarnessConfigError(`${where} must use https`);
  if (u.username || u.password) throw new HarnessConfigError(`${where} must not carry a user or password (put the key in the vault: credentialRef)`);
  if (u.search || u.hash || s.includes("?") || s.includes("#")) throw new HarnessConfigError(`${where} must not have a query string or fragment (keys go in the vault, headers in gateway.headers)`);
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** Cloudflare AI Gateway's OpenAI endpoint: https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/openai (no /v1 at the end). */
const CLOUDFLARE_OPENAI = /^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/[^/]+\/[^/]+\/(openai|compat)$/;

function parseGatewayHeaders(raw: unknown, where: string): GatewayHeader[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new HarnessConfigError(`${where} must be a list of { name, credentialRef?, field?, prefix?, value? }`);
  if (raw.length > 20) throw new HarnessConfigError(`${where}: at most 20 headers`);
  const seen = new Set<string>();
  const out = raw.map((h, i): GatewayHeader => {
    const w = `${where}[${i}]`;
    if (!h || typeof h !== "object" || Array.isArray(h)) throw new HarnessConfigError(`${w} must be { name, credentialRef?, field?, prefix?, value? }`);
    const r = h as Record<string, unknown>;
    refuseSecrets(Object.fromEntries(Object.entries(r).filter(([k]) => !["name", "credentialRef", "field", "prefix", "value"].includes(k))), w);
    const name = str(r.name);
    if (!name || !HEADER_NAME.test(name)) throw new HarnessConfigError(`${w}.name must be an HTTP header name`);
    if (RESERVED_HEADER.test(name)) throw new HarnessConfigError(`${w}.name "${name}" is managed by Polpo and the runtime (the key goes in credentialRef with authScheme; anthropic-* headers come from the runtime)`);
    if (seen.has(name.toLowerCase())) throw new HarnessConfigError(`${w}.name "${name}" appears twice`);
    seen.add(name.toLowerCase());
    const hasRef = r.credentialRef !== undefined && r.credentialRef !== null;
    const value = typeof r.value === "string" ? r.value : undefined;
    if (hasRef === (value !== undefined)) throw new HarnessConfigError(`${w} needs either credentialRef (a secret, from the vault) or value (a literal that is not a secret)`);
    const out: GatewayHeader = { name };
    if (hasRef) {
      out.credentialRef = parseRef(r.credentialRef, `${w}.credentialRef`);
      const field = str(r.field);
      if (field) {
        if (!/^[A-Za-z0-9_.-]{1,100}$/.test(field)) throw new HarnessConfigError(`${w}.field must be a field name of the vault entry`);
        out.field = field;
      }
      if (r.prefix !== undefined && r.prefix !== null && r.prefix !== "") {
        if (typeof r.prefix !== "string" || r.prefix.length > 40 || /[\r\n]/.test(r.prefix) || looksLikeSecret(r.prefix)) throw new HarnessConfigError(`${w}.prefix must be a short literal such as "Bearer "`);
        out.prefix = r.prefix;
      }
    } else {
      if (/[\r\n\0]/.test(value!) || value!.length > 500) throw new HarnessConfigError(`${w}.value must be one line`);
      if (looksLikeSecret(value!)) throw new HarnessConfigError(`${w}.value looks like a secret: store it in the vault and set credentialRef (and prefix, e.g. "Bearer ") instead`);
      out.value = value!.trim();
      if (r.field !== undefined || r.prefix !== undefined) throw new HarnessConfigError(`${w}: field and prefix go with credentialRef`);
    }
    return out;
  });
  return out.length ? out : undefined;
}

function parseGatewayModels(raw: unknown, where: string): GatewayModels | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new HarnessConfigError(`${where} must be { main, haiku?, sonnet?, opus? }`);
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!["main", "haiku", "sonnet", "opus"].includes(k)) throw new HarnessConfigError(`${where}.${k} is not a model slot (main, haiku, sonnet, opus)`);
  const main = parseModel(r.main, `${where}.main`);
  if (!main) throw new HarnessConfigError(`${where}.main is required (the gateway's model id)`);
  const out: GatewayModels = { main };
  for (const k of ["haiku", "sonnet", "opus"] as const) {
    const m = parseModel(r[k], `${where}.${k}`);
    if (m) out[k] = m;
  }
  return out;
}

/** gateway for auth "ai-gateway" / "gateway" of one harness. */
function parseGateway(raw: unknown, auth: "ai-gateway" | "gateway", harness: HarnessId, where: string, harnessModel: string | undefined): HarnessGatewaySettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HarnessConfigError(auth === "ai-gateway"
      ? `${where} must be { baseUrl?, credentialRef } (the Vercel AI Gateway key's vault entry)`
      : `${where} must be { format, baseUrl, credentialRef?, authScheme, headers?, models?, nonClaude? }`);
  }
  const r = raw as Record<string, unknown>;
  refuseSecrets(r, where);
  const preset = str(r.preset);
  if (preset && !(GATEWAY_PRESETS as string[]).includes(preset)) throw new HarnessConfigError(`${where}.preset must be one of ${GATEWAY_PRESETS.join(", ")}`);
  if (auth === "ai-gateway") {
    for (const k of Object.keys(r)) if (!["baseUrl", "credentialRef", "preset"].includes(k)) throw new HarnessConfigError(`${where}.${k} is not an AI Gateway setting (baseUrl, credentialRef): use auth "gateway" for a custom gateway`);
    const out: HarnessGatewaySettings = { credentialRef: parseRef(r.credentialRef, `${where}.credentialRef`) };
    if (r.baseUrl !== undefined && r.baseUrl !== null && r.baseUrl !== "") {
      const url = parseGatewayBaseUrl(r.baseUrl, `${where}.baseUrl`);
      if (/\/v1\/messages$/.test(url)) throw new HarnessConfigError(`${where}.baseUrl must be the gateway's base URL, without /v1/messages`);
      out.baseUrl = url;
    }
    return out;
  }
  const format = str(r.format);
  const wanted: GatewayFormat = harness === "claude-code" ? "anthropic" : "openai-responses";
  if (!format || !(GATEWAY_FORMATS as string[]).includes(format)) throw new HarnessConfigError(`${where}.format must be "${wanted}" for ${HARNESS_NAMES[harness]}`);
  if (format !== wanted) throw new HarnessConfigError(`${where}.format: ${HARNESS_NAMES[harness]} speaks "${wanted}", not "${format}"`);
  const baseUrl = parseGatewayBaseUrl(r.baseUrl, `${where}.baseUrl`);
  if (harness === "claude-code" && /\/v1\/messages$/.test(baseUrl)) {
    throw new HarnessConfigError(`${where}.baseUrl must be the base URL Claude Code adds /v1/messages to (drop /v1/messages)`);
  }
  if (harness === "codex" && !/\/v1$/.test(baseUrl) && !CLOUDFLARE_OPENAI.test(baseUrl)) {
    throw new HarnessConfigError(`${where}.baseUrl must end in /v1 (Codex calls <base>/responses), e.g. https://openrouter.ai/api/v1`);
  }
  const authScheme = str(r.authScheme) ?? "bearer";
  if (!(GATEWAY_AUTH_SCHEMES as string[]).includes(authScheme)) throw new HarnessConfigError(`${where}.authScheme must be one of ${GATEWAY_AUTH_SCHEMES.join(", ")}`);
  const out: HarnessGatewaySettings = { ...(preset ? { preset: preset as GatewayPreset } : {}), format: format as GatewayFormat, baseUrl, authScheme: authScheme as GatewayAuthScheme };
  if (r.credentialRef !== undefined && r.credentialRef !== null) out.credentialRef = parseRef(r.credentialRef, `${where}.credentialRef`);
  if (authScheme !== "none" && !out.credentialRef) throw new HarnessConfigError(`${where}.credentialRef is required with authScheme "${authScheme}" (the gateway key's vault entry)`);
  if (authScheme === "none" && out.credentialRef) throw new HarnessConfigError(`${where}.credentialRef: authScheme "none" sends no key (put the gateway's auth in a header instead), or choose "x-api-key" / "bearer"`);
  const headers = parseGatewayHeaders(r.headers, `${where}.headers`);
  if (headers) out.headers = headers;
  const models = parseGatewayModels(r.models, `${where}.models`);
  if (models) out.models = models;
  if (r.nonClaude !== undefined && r.nonClaude !== null) {
    if (typeof r.nonClaude !== "boolean") throw new HarnessConfigError(`${where}.nonClaude must be true or false`);
    if (r.nonClaude) {
      if (harness !== "claude-code") throw new HarnessConfigError(`${where}.nonClaude is for Claude Code (Codex models are always the gateway's)`);
      out.nonClaude = true;
    }
  }
  if ((out.nonClaude || format === "openai-responses") && !models?.main && !harnessModel) {
    throw new HarnessConfigError(`${where}.models.main is required ${out.nonClaude ? "for non-Claude models" : "for the OpenAI Responses format"} (the gateway's model id)`);
  }
  return out;
}

function parseClaudeCode(raw: unknown, where: string): ClaudeCodeHarnessSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HarnessConfigError(`${where} must be an object { auth, credentialRef | gateway, bedrock?, vertex?, model? }`);
  const r = raw as Record<string, unknown>;
  refuseSecrets(r, where);
  const auth = str(r.auth)?.toLowerCase();
  if (auth && CLAUDE_SUBSCRIPTION_AUTHS.has(auth)) throw new HarnessConfigError(`${where}.auth "${auth}": ${CLAUDE_SUBSCRIPTION_REFUSAL}`);
  if (!auth || !(CLAUDE_CODE_AUTHS as string[]).includes(auth)) throw new HarnessConfigError(`${where}.auth must be one of ${CLAUDE_CODE_AUTHS.join(", ")}`);
  const model = parseModel(r.model, `${where}.model`);
  const out: ClaudeCodeHarnessSettings = { auth: auth as ClaudeCodeAuth };
  if (auth === "ai-gateway" || auth === "gateway") {
    out.gateway = parseGateway(r.gateway, auth, "claude-code", `${where}.gateway`, model);
    // a top-level credentialRef is the gateway's key when the gateway has none
    if (r.credentialRef !== undefined && r.credentialRef !== null) {
      const ref = parseRef(r.credentialRef, `${where}.credentialRef`);
      if (!out.gateway.credentialRef && out.gateway.authScheme !== "none") out.gateway.credentialRef = ref;
    }
  } else {
    if (r.gateway !== undefined && r.gateway !== null) throw new HarnessConfigError(`${where}.gateway is only for auth "ai-gateway" or "gateway"`);
    out.credentialRef = parseRef(r.credentialRef, `${where}.credentialRef`);
  }
  if (auth === "bedrock") {
    const region = str((r.bedrock as Record<string, unknown> | undefined)?.region);
    if (!region || !REGION.test(region)) throw new HarnessConfigError(`${where}.bedrock.region must be an AWS region, e.g. "us-east-1"`);
    out.bedrock = { region };
  } else if (r.bedrock !== undefined && r.bedrock !== null) {
    throw new HarnessConfigError(`${where}.bedrock is only for auth "bedrock"`);
  }
  if (auth === "vertex") {
    const v = (r.vertex ?? {}) as Record<string, unknown>;
    const region = str(v.region);
    const projectId = str(v.projectId);
    if (!region || !REGION.test(region)) throw new HarnessConfigError(`${where}.vertex.region must be a Google Cloud region, e.g. "us-east5" or "global"`);
    if (!projectId || !/^[a-z][a-z0-9-]{4,29}$/.test(projectId)) throw new HarnessConfigError(`${where}.vertex.projectId must be a Google Cloud project id`);
    out.vertex = { region, projectId };
  } else if (r.vertex !== undefined && r.vertex !== null) {
    throw new HarnessConfigError(`${where}.vertex is only for auth "vertex"`);
  }
  if (model) out.model = model;
  return out;
}

function parseCodex(raw: unknown, where: string): CodexHarnessSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HarnessConfigError(`${where} must be an object { auth, credentialRef | gateway, model? }`);
  const r = raw as Record<string, unknown>;
  refuseSecrets(r, where);
  const auth = str(r.auth)?.toLowerCase() ?? "api-key";
  if (auth === "chatgpt" || auth === "subscription" || auth === "login" || auth === "oauth") throw new HarnessConfigError(`${where}.auth "${auth}": ${CODEX_CHATGPT_REFUSAL}`);
  if (!(CODEX_AUTHS as string[]).includes(auth)) throw new HarnessConfigError(`${where}.auth must be one of ${CODEX_AUTHS.join(", ")}`);
  const model = parseModel(r.model, `${where}.model`);
  const out: CodexHarnessSettings = { auth: auth as CodexAuth };
  if (auth === "ai-gateway" || auth === "gateway") {
    out.gateway = parseGateway(r.gateway, auth, "codex", `${where}.gateway`, model);
    if (r.credentialRef !== undefined && r.credentialRef !== null) {
      const ref = parseRef(r.credentialRef, `${where}.credentialRef`);
      if (!out.gateway.credentialRef && out.gateway.authScheme !== "none") out.gateway.credentialRef = ref;
    }
  } else {
    if (r.gateway !== undefined && r.gateway !== null) throw new HarnessConfigError(`${where}.gateway is only for auth "ai-gateway" or "gateway"`);
    out.credentialRef = parseRef(r.credentialRef, `${where}.credentialRef`);
  }
  if (model) out.model = model;
  return out;
}

/** settings.harnesses from raw input (config file or API), or an error naming the field. */
export function parseHarnessesSettings(raw: unknown): HarnessesSettings {
  const where = "settings.harnesses";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HarnessConfigError(`${where} must be an object { enabled: ["claude-code" | "codex"], "claude-code"?: {...}, codex?: {...} }`);
  const r = raw as Record<string, unknown>;
  const enabledRaw = r.enabled ?? [];
  if (!Array.isArray(enabledRaw) || enabledRaw.some((h) => typeof h !== "string" || !(HARNESS_IDS as string[]).includes(h))) {
    throw new HarnessConfigError(`${where}.enabled must be a list of ${HARNESS_IDS.map((h) => `"${h}"`).join(", ")}`);
  }
  const out: HarnessesSettings = { enabled: [...new Set(enabledRaw as HarnessId[])] };
  if (r.allowHost !== undefined && r.allowHost !== null) {
    if (typeof r.allowHost !== "boolean") throw new HarnessConfigError(`${where}.allowHost must be true or false`);
    if (r.allowHost) out.allowHost = true;
  }
  if (r["claude-code"] !== undefined && r["claude-code"] !== null) out["claude-code"] = parseClaudeCode(r["claude-code"], `${where}["claude-code"]`);
  if (r.codex !== undefined && r.codex !== null) out.codex = parseCodex(r.codex, `${where}.codex`);
  for (const h of out.enabled) {
    if (!out[h]) throw new HarnessConfigError(`${where}: ${HARNESS_NAMES[h]} is enabled but has no settings (${where}${h === "codex" ? ".codex" : `["${h}"]`}: { auth, credentialRef })`);
  }
  return out;
}

/** The parsed settings, or undefined when absent or malformed (runtime paths never throw on them). */
export function harnessesSettingsOf(settings: { harnesses?: unknown } | undefined): HarnessesSettings | undefined {
  if (!settings?.harnesses) return undefined;
  try { return parseHarnessesSettings(settings.harnesses); } catch { return undefined; }
}

/**
 * The vault references of these settings that are not in the vault (secret gateway headers must
 * be there to save: unlike the main credential, they have no setup link). `field`: the entry must
 * have that field. Returns readable problems, [] when all resolve.
 */
export async function harnessesVaultProblems(
  settings: HarnessesSettings,
  vault: { get(owner: string, service: string): Promise<{ credentials?: Record<string, string> } | undefined> } | undefined,
  opts: { includeMain?: boolean } = {},
): Promise<string[]> {
  if (!vault) return [];
  const problems: string[] = [];
  for (const id of HARNESS_IDS) {
    const h = settings[id];
    if (!h) continue;
    const refs = harnessVaultRefs(h).filter((x) => opts.includeMain || x.where.startsWith("gateway.headers"));
    for (const x of refs) {
      const entry = await vault.get(x.ref.owner, x.ref.service).catch(() => undefined);
      if (!entry) { problems.push(`${HARNESS_NAMES[id]} ${x.where}: the vault entry ${x.ref.owner} / ${x.ref.service} does not exist`); continue; }
      if (x.field && !Object.keys(entry.credentials ?? {}).some((k) => k === x.field)) {
        problems.push(`${HARNESS_NAMES[id]} ${x.where}: the vault entry ${x.ref.owner} / ${x.ref.service} has no field "${x.field}"`);
      }
    }
  }
  return problems;
}

/** agent.engine from raw input: undefined for "polpo" (the default), or an error naming the field. */
export function parseAgentEngine(raw: unknown, where = "engine"): AgentHarnessEngine | undefined {
  if (raw === undefined || raw === null || raw === "" || raw === "polpo") return undefined;
  if (typeof raw === "string") {
    if ((HARNESS_IDS as string[]).includes(raw)) return { harness: raw as HarnessId };
    throw new HarnessConfigError(`${where} must be "polpo" or { harness: ${HARNESS_IDS.map((h) => `"${h}"`).join(" | ")}, model?, permissionMode?, effort?, maxBudgetUsd?, credentialRef? }`);
  }
  if (typeof raw !== "object" || Array.isArray(raw)) throw new HarnessConfigError(`${where} must be "polpo" or an object { harness, ... }`);
  const r = raw as Record<string, unknown>;
  refuseSecrets(r, where);
  const harness = str(r.harness);
  if (!harness || !(HARNESS_IDS as string[]).includes(harness)) throw new HarnessConfigError(`${where}.harness must be one of ${HARNESS_IDS.join(", ")}`);
  const out: AgentHarnessEngine = { harness: harness as HarnessId };
  const model = parseModel(r.model, `${where}.model`);
  if (model) out.model = model;
  if (r.permissionMode !== undefined && r.permissionMode !== null) {
    if (typeof r.permissionMode !== "string" || !(HARNESS_PERMISSION_MODES as string[]).includes(r.permissionMode)) {
      throw new HarnessConfigError(`${where}.permissionMode must be one of ${HARNESS_PERMISSION_MODES.join(", ")}`);
    }
    out.permissionMode = r.permissionMode as HarnessPermissionMode;
  }
  if (r.effort !== undefined && r.effort !== null) {
    if (typeof r.effort !== "string" || !(HARNESS_EFFORTS as string[]).includes(r.effort)) throw new HarnessConfigError(`${where}.effort must be one of ${HARNESS_EFFORTS.join(", ")}`);
    out.effort = r.effort as HarnessEffort;
  }
  if (r.maxBudgetUsd !== undefined && r.maxBudgetUsd !== null) {
    if (typeof r.maxBudgetUsd !== "number" || !(r.maxBudgetUsd > 0) || r.maxBudgetUsd > 10_000) throw new HarnessConfigError(`${where}.maxBudgetUsd must be a positive number of US dollars`);
    out.maxBudgetUsd = r.maxBudgetUsd;
  }
  if (r.credentialRef !== undefined && r.credentialRef !== null) out.credentialRef = parseRef(r.credentialRef, `${where}.credentialRef`);
  return out;
}

/** The agent's harness engine, or undefined when it runs on Polpo's engine (never throws). */
export function agentHarness(agent: { engine?: unknown } | undefined): AgentHarnessEngine | undefined {
  try { return parseAgentEngine(agent?.engine); } catch { return undefined; }
}

/**
 * Why an agent cannot run on its harness with these settings (null: it can, or it is on Polpo's
 * engine). Checked when an agent or the settings are saved, and again before every run.
 * `daytonaApi` says which Daytona API the instance uses ("v2" computers can run harnesses).
 */
export function agentEngineProblem(
  agent: { name?: string; engine?: unknown; defaultComputer?: string },
  settings: { harnesses?: unknown; computers?: unknown } | undefined,
  opts: { daytonaApi?: "v0" | "v2" } = {},
): string | null {
  let engine: AgentHarnessEngine | undefined;
  try { engine = parseAgentEngine(agent.engine); } catch (err) { return (err as Error).message; }
  if (!engine) return null;
  const who = agent.name ? `Agent "${agent.name}"` : "This agent";
  const name = HARNESS_NAMES[engine.harness];
  let h: HarnessesSettings | undefined;
  try { h = settings?.harnesses ? parseHarnessesSettings(settings.harnesses) : undefined; } catch (err) { return (err as Error).message; }
  if (!h?.enabled.includes(engine.harness)) {
    return `${who}: ${name} is not enabled on this instance (Settings → Harnesses: enable it and choose its credential)`;
  }
  if (engine.credentialRef) {
    const s = h[engine.harness];
    if (s && (s.auth === "bedrock" || s.auth === "vertex")) return `${who}: its own credential (engine.credentialRef) replaces an API key or a gateway key; ${name} uses ${s.auth} here`;
    if (s?.gateway?.authScheme === "none") return `${who}: its own credential (engine.credentialRef) replaces the gateway key, and this gateway sends none (authScheme "none")`;
  }
  const computerId = agent.defaultComputer && agent.defaultComputer !== HOST_COMPUTER_ID ? agent.defaultComputer : undefined;
  if (!computerId) {
    if (h.allowHost) return null;
    return `${who}: ${name} runs inside the agent's computer, and this agent works on this server. Give it a remote computer (defaultComputer), or allow harnesses on this server (settings.harnesses.allowHost: they run with an isolated HOME, never the server's)`;
  }
  const computers = Array.isArray(settings?.computers) ? (settings!.computers as ComputerConfig[]) : [];
  const c = computers.find((x) => x?.id === computerId);
  if (!c) return `${who}: unknown computer "${computerId}"`;
  if (c.kind === "host") {
    return h.allowHost ? null : `${who}: computer "${c.id}" is this server; harnesses run there only with settings.harnesses.allowHost (isolated HOME)`;
  }
  if (!isRemoteComputer(c)) return `${who}: computer "${c.id}" cannot run ${name}`;
  if (c.kind === "e2b") return `${who}: ${name} does not run on E2B computers yet (computer "${c.id}"): use a Daytona v2 computer`;
  if (opts.daytonaApi && opts.daytonaApi !== "v2") return `${who}: ${name} needs Daytona v2 (settings.sandbox.providers.daytona.api "v2"); computer "${c.id}" runs on Daytona v0`;
  return null;
}

/** Agents whose harness these settings no longer allow (to refuse a settings change that breaks them). */
export function harnessUsers(harness: HarnessId, agents: ReadonlyArray<{ name: string; engine?: unknown }>): string[] {
  return agents.filter((a) => agentHarness(a)?.harness === harness).map((a) => a.name);
}
