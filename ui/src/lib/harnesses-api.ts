/**
 * Agent harnesses (Claude Code, Codex, OpenCode as an agent's engine) — thin client for /api/v1/harnesses,
 * the settings (PATCH /config/settings { harnesses }) and an agent's engine (PATCH /agents/:name).
 * Credentials are vault references only (owner + service); values never reach the dashboard.
 *
 * Mirrors packages/core/src/harnesses.ts.
 */
import { apiUrl, config } from "@/lib/config";
import type { VaultRef } from "@/lib/vault-ref";

export type HarnessId = "claude-code" | "codex" | "opencode";
export const HARNESS_IDS: readonly HarnessId[] = ["claude-code", "codex", "opencode"];
export const HARNESS_NAMES: Record<HarnessId, string> = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode" };
export type ClaudeCodeAuth = "api-key" | "bedrock" | "vertex" | "ai-gateway" | "gateway";
export const CLAUDE_CODE_AUTH_LABELS: Record<ClaudeCodeAuth, string> = {
  "api-key": "Anthropic API key", bedrock: "Amazon Bedrock", vertex: "Google Vertex AI", "ai-gateway": "Vercel AI Gateway", gateway: "Model gateway",
};
export type CodexAuth = "api-key" | "ai-gateway" | "gateway";
export const CODEX_AUTH_LABELS: Record<CodexAuth, string> = { "api-key": "OpenAI API key", "ai-gateway": "Vercel AI Gateway", gateway: "Model gateway" };
export type OpenCodeAuth = "api-key" | "bedrock" | "ai-gateway" | "gateway";
export const OPENCODE_AUTH_LABELS: Record<OpenCodeAuth, string> = {
  "api-key": "Provider API key", bedrock: "Amazon Bedrock (API key)", "ai-gateway": "Vercel AI Gateway", gateway: "Model gateway",
};
/** OpenCode's providers with an API key (packages/core OPENCODE_PROVIDERS): id, name, an example model. */
export const OPENCODE_PROVIDERS = [
  { id: "anthropic", name: "Anthropic", example: "claude-sonnet-4-5" },
  { id: "openai", name: "OpenAI", example: "gpt-5" },
  { id: "google", name: "Google Gemini", example: "gemini-2.5-pro" },
  { id: "xai", name: "xAI", example: "grok-4" },
  { id: "mistral", name: "Mistral", example: "devstral-medium-2507" },
  { id: "groq", name: "Groq", example: "moonshotai/kimi-k2-instruct-0905" },
  { id: "deepseek", name: "DeepSeek", example: "deepseek-chat" },
  { id: "openrouter", name: "OpenRouter", example: "moonshotai/kimi-k2" },
  { id: "moonshotai", name: "Moonshot AI", example: "kimi-k2-0905-preview" },
  { id: "zai", name: "Z.ai", example: "glm-4.6" },
] as const;
export type OpenCodeProviderId = (typeof OPENCODE_PROVIDERS)[number]["id"];
/** An example model for an OpenCode setting (the form's placeholder). */
export function openCodeModelExample(s: { auth?: string; provider?: string } | undefined): string {
  if (s?.auth === "bedrock") return "global.moonshotai.kimi-k3.1";
  if (s?.auth === "ai-gateway") return "moonshotai/kimi-k2";
  if (s?.auth === "gateway") return "the gateway's model id";
  return OPENCODE_PROVIDERS.find((p) => p.id === s?.provider)?.example ?? "provider model id";
}
export type HarnessPermissionMode = "allow-all" | "allow-edits" | "allow-reads";
export type HarnessEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type GatewayFormat = "anthropic" | "openai-responses" | "openai-chat";
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

/** The CLI engine: the official Claude Code / Codex program signed in with a person's own plan. */
export type CliId = "claude" | "codex";
export const CLI_NAMES: Record<CliId, string> = { claude: "Claude Code (CLI)", codex: "Codex (CLI)" };
export interface AgentCliEngine {
  type: "cli";
  cli: CliId;
  account?: string;
  model?: string;
  permissionMode?: HarnessPermissionMode;
  effort?: HarnessEffort;
  /** Claude Code only: --max-budget-usd. */
  maxBudgetUsd?: number;
  args?: string[];
}
export interface CliAccount { id: string; cli: CliId; computer: string; configDir: string; owner: string; label?: string }
export interface CliSettings { accounts: CliAccount[]; allowInstanceCodex?: boolean }
export interface CliAccountReport {
  installed: boolean;
  version?: string;
  status?: { signedIn: boolean; who?: string; method?: string; plan?: string; detail?: string };
  error?: string;
}
export interface CliAccountView extends CliAccount { report?: CliAccountReport; agents: string[]; manageable: boolean }
export interface CliOverview { accounts: CliAccountView[]; allowInstanceCodex: boolean }
export type CliLogin =
  | { mode: "terminal"; terminal: { agent: "cli-login"; cli_account: string }; command: string; computer?: string; note?: string }
  | { mode: "command"; computer: string; command: string; note: string };

export function isCliEngine(e: unknown): e is AgentCliEngine {
  return !!e && typeof e === "object" && (e as { type?: unknown }).type === "cli";
}

export interface ClaudeCodeSetting { auth: ClaudeCodeAuth; credentialRef?: VaultRef; gateway?: HarnessGateway; bedrock?: { region: string }; vertex?: { region: string; projectId: string }; model?: string }
export interface CodexSetting { auth: CodexAuth; credentialRef?: VaultRef; gateway?: HarnessGateway; model?: string }
export interface OpenCodeSetting { auth: OpenCodeAuth; provider?: OpenCodeProviderId; credentialRef?: VaultRef; gateway?: HarnessGateway; bedrock?: { region: string }; model?: string }

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
  /** OpenCode with an API key: the model provider. */
  provider?: string;
  gateway?: HarnessGateway;
  /** The setting as saved (vault references only). */
  settings?: ClaudeCodeSetting | CodexSetting | OpenCodeSetting;
  /** How the model key reaches the model: Polpo's relay, in the VM (no public URL), or not brokerable (Claude Code on Bedrock / Vertex). */
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
  /** The CLI engine's accounts as saved (kept when the harness settings are saved). */
  cli?: CliSettings;
}

export interface HarnessSession {
  key: string;
  agent: string;
  harness: HarnessId;
  /** "cli": a CLI engine run (the official program signed in with a person's account). */
  engine?: "harness" | "cli";
  cli?: CliId;
  account?: string;
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
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  chatSessionId?: string;
  lastError?: string;
  createdAt?: string;
  updatedAt: string;
}

/** settings.harnesses as saved. */
export interface HarnessesSettings {
  enabled: HarnessId[];
  allowHost?: boolean;
  "claude-code"?: ClaudeCodeSetting;
  codex?: CodexSetting;
  opencode?: OpenCodeSetting;
  cli?: CliSettings;
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
  /** An agent's engine: "polpo" (Polpo's own), a harness, or the CLI engine. */
  setEngine: (agent: string, engine: "polpo" | AgentHarnessEngine | AgentCliEngine) => request<unknown>(`/agents/${encodeURIComponent(agent)}`, json("PATCH", { engine })),
  // ── CLI accounts (personal sign-ins; Polpo never sees a token) ──
  cliAccounts: (o: { status?: boolean } = {}) => request<CliOverview>(`/harnesses/cli/accounts${o.status === false ? "?status=0" : ""}`),
  addCliAccount: (a: { cli: CliId; computer?: string; label?: string; id?: string }) => request<CliAccount>("/harnesses/cli/accounts", json("POST", a)),
  updateCliAccount: (id: string, patch: { label?: string; owner?: string }) => request<CliAccount>(`/harnesses/cli/accounts/${encodeURIComponent(id)}`, json("PATCH", patch)),
  removeCliAccount: (id: string) => request<unknown>(`/harnesses/cli/accounts/${encodeURIComponent(id)}`, json("DELETE")),
  cliStatus: (id: string) => request<CliAccountReport>(`/harnesses/cli/accounts/${encodeURIComponent(id)}/status`),
  cliLogout: (id: string) => request<{ ok: boolean; output: string }>(`/harnesses/cli/accounts/${encodeURIComponent(id)}/logout`, json("POST")),
  cliLogin: (id: string) => request<CliLogin>(`/harnesses/cli/accounts/${encodeURIComponent(id)}/login`),
  cliInstall: (cli: CliId, computer?: string) => request<{ ok: boolean; output: string; version?: string }>("/harnesses/cli/install", json("POST", { cli, ...(computer ? { computer } : {}) })),
  setCliSettings: (s: { allowInstanceCodex: boolean }) => request<unknown>("/harnesses/cli/settings", json("PATCH", s)),
};

/** The settings as saved, from the overview (what the form edits). */
export function settingsFromOverview(o: HarnessesOverview): HarnessesSettings {
  const cc = o.harnesses.find((h) => h.id === "claude-code");
  const cx = o.harnesses.find((h) => h.id === "codex");
  const oc = o.harnesses.find((h) => h.id === "opencode");
  const strip = <T extends { gateway?: HarnessGateway }>(s: T): T => s.gateway?.headers
    ? { ...s, gateway: { ...s.gateway, headers: s.gateway.headers.map(({ credentialFound: _f, ...h }) => h) } }
    : s;
  return {
    enabled: o.harnesses.filter((h) => h.enabled).map((h) => h.id),
    ...(o.allowHost ? { allowHost: true } : {}),
    ...(cc?.settings ? { "claude-code": strip(cc.settings as ClaudeCodeSetting) } : {}),
    ...(cx?.settings ? { codex: strip(cx.settings as CodexSetting) } : {}),
    ...(oc?.settings ? { opencode: strip(oc.settings as OpenCodeSetting) } : {}),
    // the CLI accounts are kept as they are (they change through /harnesses/cli)
    ...(o.cli ? { cli: o.cli } : {}),
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
    baseUrl: (h, f) => `https://gateway.ai.cloudflare.com/v1/${f.account || "<account>"}/${f.gateway || "<gateway>"}/${h === "codex" ? "openai" : h === "opencode" ? "compat" : "anthropic"}`,
    authScheme: "none",
    headers: () => [{ name: "cf-aig-authorization", prefix: "Bearer " }],
    hint: "Authenticated gateway: cf-aig-authorization carries the gateway token (vault). Provider keys stored in Cloudflare (BYOK): auth none; to send your own provider key, choose x-api-key (Claude) or bearer (Codex).",
  },
  {
    id: "openrouter", label: "OpenRouter", baseUrl: (h) => (h === "claude-code" ? "https://openrouter.ai/api" : "https://openrouter.ai/api/v1"), authScheme: "bearer",
    hint: "OpenRouter key as a Bearer token; model ids like anthropic/claude-sonnet-4.5. Non-Claude models: tick \"non-Claude models\".",
  },
  {
    id: "litellm", label: "LiteLLM", baseUrl: (h) => (h === "claude-code" ? "https://litellm.example.com" : "https://litellm.example.com/v1"), authScheme: "bearer",
    hint: "Your LiteLLM proxy's URL; its virtual key as a Bearer token. Model ids are the proxy's model names.",
  },
  {
    id: "portkey", label: "Portkey", baseUrl: (h) => (h === "claude-code" ? "https://api.portkey.ai" : "https://api.portkey.ai/v1"), authScheme: "none",
    headers: (h) => [{ name: "x-portkey-api-key" }, { name: "x-portkey-provider", value: h === "claude-code" ? "anthropic" : "openai" }],
    hint: "x-portkey-api-key from the vault; x-portkey-provider is a provider or an @integration slug (not a secret).",
  },
  {
    id: "kong", label: "Kong AI Gateway", baseUrl: (h) => (h === "claude-code" ? "https://kong.example.com/ai" : "https://kong.example.com/ai/v1"), authScheme: "bearer",
    hint: "Your Kong route's URL; the key as your Kong key-auth plugin expects it (Bearer, x-api-key, or a header).",
  },
  { id: "custom", label: "Custom", baseUrl: (h) => (h === "claude-code" ? "https://gateway.example.com" : "https://gateway.example.com/v1"), authScheme: "bearer", hint: "Any gateway with the Anthropic Messages API (Claude Code), the OpenAI Responses API (Codex) or, for OpenCode, any of these or OpenAI Chat Completions." },
];

/** Cloudflare account and gateway ids back from a base URL (to edit them). */
export function cloudflareIds(baseUrl: string | undefined): { account?: string; gateway?: string } {
  const m = baseUrl?.match(/^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/([^/]+)\/([^/]+)\//);
  return m ? { account: m[1], gateway: m[2] } : {};
}

export const TEST_ERROR_LABELS: Record<NonNullable<HarnessTestResult["errorKind"]>, string> = {
  config: "Configuration", auth: "Authentication", model: "Model", network: "Network", timeout: "Timeout", protocol: "Protocol", upstream: "Upstream",
};

// ── The form as the server takes it ─────────────────────────────────────

export const isGatewayAuth = (auth: string | undefined): auth is "ai-gateway" | "gateway" => auth === "ai-gateway" || auth === "gateway";

/** A gateway as the server takes it: empty headers and model slots dropped; the AI Gateway keeps its two fields. */
function cleanGateway(auth: "ai-gateway" | "gateway", g: HarnessGateway | undefined): HarnessGateway | undefined {
  if (!g) return undefined;
  if (auth === "ai-gateway") return { ...(g.baseUrl ? { baseUrl: g.baseUrl } : {}), ...(g.credentialRef ? { credentialRef: g.credentialRef } : {}) };
  const out: HarnessGateway = { ...g };
  const headers = (g.headers ?? []).filter((h) => h.name).map(({ credentialFound: _f, ...h }) => h);
  if (headers.length) out.headers = headers; else delete out.headers;
  if (g.models) {
    const m = Object.fromEntries(Object.entries(g.models).filter(([, v]) => !!v)) as NonNullable<HarnessGateway["models"]>;
    if (m.main) out.models = m; else delete out.models;
  }
  if (out.authScheme === "none") delete out.credentialRef;
  return out;
}

/** The form as the server takes it (incomplete harness settings left out). */
export function cleanHarnessSettings(form: HarnessesSettings): HarnessesSettings {
  const out: HarnessesSettings = { ...form };
  const cc = out["claude-code"] ? { ...out["claude-code"] } : undefined;
  if (cc) {
    if (isGatewayAuth(cc.auth)) { cc.gateway = cleanGateway(cc.auth, cc.gateway); delete cc.credentialRef; } else delete cc.gateway;
    if (cc.auth !== "bedrock") delete cc.bedrock;
    if (cc.auth !== "vertex") delete cc.vertex;
    if (isGatewayAuth(cc.auth) ? !cc.gateway : !cc.credentialRef) delete out["claude-code"]; else out["claude-code"] = cc;
  }
  const cx = out.codex ? { ...out.codex } : undefined;
  if (cx) {
    if (isGatewayAuth(cx.auth)) { cx.gateway = cleanGateway(cx.auth, cx.gateway); delete cx.credentialRef; } else delete cx.gateway;
    if (isGatewayAuth(cx.auth) ? !cx.gateway : !cx.credentialRef) delete out.codex; else out.codex = cx;
  }
  const oc = out.opencode ? { ...out.opencode } : undefined;
  if (oc) {
    if (isGatewayAuth(oc.auth)) {
      const g = cleanGateway(oc.auth, oc.gateway);
      if (g) { delete g.nonClaude; if (g.models) g.models = { main: g.models.main }; }
      oc.gateway = g;
      delete oc.credentialRef;
    } else delete oc.gateway;
    if (oc.auth !== "bedrock") delete oc.bedrock;
    if (oc.auth !== "api-key") delete oc.provider;
    if (!oc.model) delete oc.model;
    if (isGatewayAuth(oc.auth) ? !oc.gateway : !oc.credentialRef) delete out.opencode; else out.opencode = oc;
  }
  return out;
}
