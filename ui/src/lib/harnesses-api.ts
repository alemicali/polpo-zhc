/**
 * Agent harnesses (Claude Code, Codex as an agent's engine) — thin client for /api/v1/harnesses,
 * the settings (PATCH /config/settings { harnesses }) and an agent's engine (PATCH /agents/:name).
 * Credentials are vault references only (owner + service); values never reach the dashboard.
 *
 * Mirrors packages/core/src/harnesses.ts.
 */
import { apiUrl, config } from "@/lib/config";
import type { VaultRef } from "@/lib/vault-ref";

export type HarnessId = "claude-code" | "codex";
export const HARNESS_NAMES: Record<HarnessId, string> = { "claude-code": "Claude Code", codex: "Codex" };
export type ClaudeCodeAuth = "api-key" | "bedrock" | "vertex" | "ai-gateway" | "gateway";
export const CLAUDE_CODE_AUTH_LABELS: Record<ClaudeCodeAuth, string> = {
  "api-key": "Anthropic API key", bedrock: "Amazon Bedrock", vertex: "Google Vertex AI", "ai-gateway": "Vercel AI Gateway", gateway: "Model gateway",
};
export type CodexAuth = "api-key" | "ai-gateway" | "gateway";
export const CODEX_AUTH_LABELS: Record<CodexAuth, string> = { "api-key": "OpenAI API key", "ai-gateway": "Vercel AI Gateway", gateway: "Model gateway" };
export type HarnessPermissionMode = "allow-all" | "allow-edits" | "allow-reads";
export type HarnessEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type GatewayFormat = "anthropic" | "openai-responses";
export type GatewayAuthScheme = "x-api-key" | "bearer" | "none";
export type GatewayPreset = "vercel" | "cloudflare" | "openrouter" | "litellm" | "portkey" | "kong" | "custom";

/** An extra header for every model request: a secret from the vault, or a literal that is not a secret. */
export interface GatewayHeader {
  name: string;
  credentialRef?: VaultRef;
  field?: string;
  prefix?: string;
  value?: string;
  /** Overview only: whether the vault entry exists. */
  credentialFound?: boolean;
}

export interface HarnessGateway {
  preset?: GatewayPreset;
  format?: GatewayFormat;
  baseUrl?: string;
  credentialRef?: VaultRef;
  authScheme?: GatewayAuthScheme;
  headers?: GatewayHeader[];
  models?: { main: string; haiku?: string; sonnet?: string; opus?: string };
  nonClaude?: boolean;
}

export interface AgentHarnessEngine {
  harness: HarnessId;
  model?: string;
  permissionMode?: HarnessPermissionMode;
  effort?: HarnessEffort;
  maxBudgetUsd?: number;
  /** This agent's own key (cost separation): replaces the harness's API key or gateway key. */
  credentialRef?: VaultRef;
}

export interface ClaudeCodeSetting { auth: ClaudeCodeAuth; credentialRef?: VaultRef; gateway?: HarnessGateway; bedrock?: { region: string }; vertex?: { region: string; projectId: string }; model?: string }
export interface CodexSetting { auth: CodexAuth; credentialRef?: VaultRef; gateway?: HarnessGateway; model?: string }

export interface HarnessItem {
  id: HarnessId;
  name: string;
  enabled: boolean;
  auth?: string;
  /** The main credential (the gateway's for gateways). */
  credentialRef?: VaultRef;
  credentialFound?: boolean;
  model?: string;
  bedrock?: { region: string };
  vertex?: { region: string; projectId: string };
  gateway?: HarnessGateway;
  /** The setting as saved (vault references only). */
  settings?: ClaudeCodeSetting | CodexSetting;
  /** How the model key reaches the model: Polpo's relay, in the VM (no public URL), or not brokerable (Bedrock / Vertex). */
  brokering?: "relay" | "in-vm" | "not-brokered";
  agents: string[];
}

export interface HarnessesOverview {
  allowHost: boolean;
  harnesses: HarnessItem[];
  /** Computers that can run a harness. */
  computers: string[];
  /** Polpo's model relay (credential brokering). */
  relay?: { available: boolean; url?: string; path: string; warning?: string };
}

export interface HarnessSession {
  key: string;
  agent: string;
  harness: HarnessId;
  computerId: string;
  scope: "task" | "chat";
  taskId?: string;
  state: string;
  live: boolean;
  bootstrappedAt?: string;
  bootstrapMs?: number;
  lastDetachAt?: string;
  lastResumeAt?: string;
  resumable: boolean;
  turns: number;
  costUsd: number;
  lastError?: string;
  updatedAt: string;
}

/** settings.harnesses as saved. */
export interface HarnessesSettings {
  enabled: HarnessId[];
  allowHost?: boolean;
  "claude-code"?: ClaudeCodeSetting;
  codex?: CodexSetting;
}

/** POST /harnesses/test: one tiny model request from the Polpo server. */
export interface HarnessTestResult {
  ok: boolean;
  harness: HarnessId;
  auth?: string;
  model?: string;
  endpoint?: string;
  latencyMs: number;
  status?: number;
  errorKind?: "config" | "auth" | "model" | "network" | "timeout" | "protocol" | "upstream";
  error?: string;
  note?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  if (config.apiKey) headers.set("authorization", `Bearer ${config.apiKey}`);
  let response: Response;
  try {
    response = await fetch(apiUrl(`/api/v1${path}`), { ...init, headers, credentials: "include" });
  } catch {
    throw new Error("Could not reach the Polpo server");
  }
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: unknown; error?: unknown } | null;
  if (!response.ok || !body?.ok) {
    const error = typeof body?.error === "string" ? body.error : (body?.error as { message?: string } | undefined)?.message;
    throw new Error(error || `Request failed (${response.status})`);
  }
  return body.data as T;
}

const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const harnessesApi = {
  overview: () => request<HarnessesOverview>("/harnesses"),
  sessions: (filter: { agent?: string; computer?: string } = {}) => {
    const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => !!v) as Array<[string, string]>);
    return request<{ sessions: HarnessSession[] }>(`/harnesses/sessions${q.size ? `?${q}` : ""}`).then((d) => d.sessions);
  },
  control: (key: string, action: "stop" | "reset") =>
    request<{ message: string }>(`/harnesses/sessions/${encodeURIComponent(key)}/${action}`, json("POST", action === "reset" ? { confirm: true } : undefined)),
  /** Replace settings.harnesses (null removes it). */
  save: (harnesses: HarnessesSettings | null) => request<unknown>("/config/settings", json("PATCH", { harnesses })),
  /** Test a harness's connection from the Polpo server: the saved settings, the ones being edited, or an agent's own credential. */
  test: (harness: HarnessId, o: { settings?: HarnessesSettings; agent?: string } = {}) =>
    request<HarnessTestResult>("/harnesses/test", json("POST", { harness, ...o })),
  /** An agent's engine: "polpo" (Polpo's own) or a harness. */
  setEngine: (agent: string, engine: "polpo" | AgentHarnessEngine) => request<unknown>(`/agents/${encodeURIComponent(agent)}`, json("PATCH", { engine })),
};

/** The settings as saved, from the overview (what the form edits). */
export function settingsFromOverview(o: HarnessesOverview): HarnessesSettings {
  const cc = o.harnesses.find((h) => h.id === "claude-code");
  const cx = o.harnesses.find((h) => h.id === "codex");
  const strip = <T extends { gateway?: HarnessGateway }>(s: T): T => s.gateway?.headers
    ? { ...s, gateway: { ...s.gateway, headers: s.gateway.headers.map(({ credentialFound: _f, ...h }) => h) } }
    : s;
  return {
    enabled: o.harnesses.filter((h) => h.enabled).map((h) => h.id),
    ...(o.allowHost ? { allowHost: true } : {}),
    ...(cc?.settings ? { "claude-code": strip(cc.settings as ClaudeCodeSetting) } : {}),
    ...(cx?.settings ? { codex: strip(cx.settings as CodexSetting) } : {}),
  };
}

// ── Gateway presets (Settings → Harnesses) ─────────────────────────────

export interface GatewayPresetInfo {
  id: GatewayPreset;
  label: string;
  /** Inputs that build the base URL (Cloudflare: account and gateway ids). */
  fields?: Array<{ key: "account" | "gateway"; label: string }>;
  /** The base URL for a harness (the runtime appends /v1/messages or /responses). */
  baseUrl: (harness: HarnessId, f: { account?: string; gateway?: string }) => string;
  authScheme: GatewayAuthScheme;
  /** Headers the preset adds (secret ones get their vault entry from the person). */
  headers?: (harness: HarnessId) => GatewayHeader[];
  hint: string;
}

export const GATEWAY_PRESET_INFO: GatewayPresetInfo[] = [
  {
    id: "vercel", label: "Vercel AI Gateway", baseUrl: () => "https://ai-gateway.vercel.sh", authScheme: "x-api-key",
    hint: "Uses the AI Gateway auth: model ids like anthropic/claude-sonnet-4.5 or openai/gpt-5.",
  },
  {
    id: "cloudflare", label: "Cloudflare AI Gateway", fields: [{ key: "account", label: "Account id" }, { key: "gateway", label: "Gateway id" }],
    baseUrl: (h, f) => `https://gateway.ai.cloudflare.com/v1/${f.account || "<account>"}/${f.gateway || "<gateway>"}/${h === "codex" ? "openai" : "anthropic"}`,
    authScheme: "none",
    headers: () => [{ name: "cf-aig-authorization", prefix: "Bearer " }],
    hint: "Authenticated gateway: cf-aig-authorization carries the gateway token (vault). Provider keys stored in Cloudflare (BYOK): auth none; to send your own provider key, choose x-api-key (Claude) or bearer (Codex).",
  },
  {
    id: "openrouter", label: "OpenRouter", baseUrl: (h) => (h === "codex" ? "https://openrouter.ai/api/v1" : "https://openrouter.ai/api"), authScheme: "bearer",
    hint: "OpenRouter key as a Bearer token; model ids like anthropic/claude-sonnet-4.5. Non-Claude models: tick \"non-Claude models\".",
  },
  {
    id: "litellm", label: "LiteLLM", baseUrl: (h) => (h === "codex" ? "https://litellm.example.com/v1" : "https://litellm.example.com"), authScheme: "bearer",
    hint: "Your LiteLLM proxy's URL; its virtual key as a Bearer token. Model ids are the proxy's model names.",
  },
  {
    id: "portkey", label: "Portkey", baseUrl: (h) => (h === "codex" ? "https://api.portkey.ai/v1" : "https://api.portkey.ai"), authScheme: "none",
    headers: (h) => [{ name: "x-portkey-api-key" }, { name: "x-portkey-provider", value: h === "codex" ? "openai" : "anthropic" }],
    hint: "x-portkey-api-key from the vault; x-portkey-provider is a provider or an @integration slug (not a secret).",
  },
  {
    id: "kong", label: "Kong AI Gateway", baseUrl: (h) => (h === "codex" ? "https://kong.example.com/ai/v1" : "https://kong.example.com/ai"), authScheme: "bearer",
    hint: "Your Kong route's URL; the key as your Kong key-auth plugin expects it (Bearer, x-api-key, or a header).",
  },
  { id: "custom", label: "Custom", baseUrl: (h) => (h === "codex" ? "https://gateway.example.com/v1" : "https://gateway.example.com"), authScheme: "bearer", hint: "Any gateway with the Anthropic Messages API (Claude Code) or the OpenAI Responses API (Codex)." },
];

/** Cloudflare account and gateway ids back from a base URL (to edit them). */
export function cloudflareIds(baseUrl: string | undefined): { account?: string; gateway?: string } {
  const m = baseUrl?.match(/^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/([^/]+)\/([^/]+)\//);
  return m ? { account: m[1], gateway: m[2] } : {};
}

export const TEST_ERROR_LABELS: Record<NonNullable<HarnessTestResult["errorKind"]>, string> = {
  config: "Configuration", auth: "Authentication", model: "Model", network: "Network", timeout: "Timeout", protocol: "Protocol", upstream: "Upstream",
};
