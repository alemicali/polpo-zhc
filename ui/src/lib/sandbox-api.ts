/**
 * Sandbox — where agents' tools run (this machine, a bubblewrap jail, a container, a remote VM).
 *
 * Thin client for /api/v1/sandbox plus the settings and agent updates that carry a `sandbox`
 * block. Same envelope ({ ok, data } / { ok, error }) as the other page-level clients.
 */
import { apiUrl, config } from "@/lib/config";
import type { VaultRef } from "@/lib/vault-ref";

export type SandboxProvider = "local" | "bwrap" | "docker" | "daytona" | "e2b";
export type SandboxNetworkMode = "deny" | "allowlist" | "open" | "unrestricted";

export interface SandboxSettings {
  provider?: SandboxProvider;
  allowedProviders?: SandboxProvider[];
  network?: { mode: SandboxNetworkMode; allow?: string[] };
  resources?: { cpus?: number; memoryMb?: number; diskMb?: number; timeoutMin?: number };
  confineExternalContent?: boolean;
  allowLocal?: boolean;
  chatIdleMinutes?: number;
  /** Opt-in "Cowork": chats may run their sandbox tools on a remote provider (Daytona, E2B). */
  chatRemote?: boolean;
  /** Remote VMs: reuse (same agent) or fresh, keep (pool) or delete at the end, idle suspend, expiry. */
  lifecycle?: SandboxLifecycle;
  /** Instance: remote VMs kept ready per provider (cost money while they exist). */
  warm?: Partial<Record<"daytona" | "e2b", number>>;
  /** Per-provider options; for Daytona/E2B the vault entry with the key (a reference) and non-secret settings. */
  providers?: Partial<Record<SandboxProvider, Record<string, unknown>>>;
}

export interface SandboxLifecycle {
  isolation?: "reuse" | "fresh";
  onRelease?: "pool" | "destroy";
  suspendAfterIdleSeconds?: number;
  deleteAfterStopMinutes?: number;
}

export const DEFAULT_LIFECYCLE: Required<SandboxLifecycle> = {
  isolation: "reuse", onRelease: "pool", suspendAfterIdleSeconds: 0, deleteAfterStopMinutes: 30,
};

/** Where each tool runs (same list as the server, TOOL_PLACEMENT in @polpo-ai/core/sandbox). */
export type ToolPlacement = "sandbox" | "bridged" | "host";
const SANDBOX_TOOLS = ["bash", "grep", "glob", "ls", "read", "write", "edit", "run_command"];
const BRIDGED_TOOLS = ["pdf_*", "excel_*", "docx_*", "http_download", "image_generate", "video_generate", "audio_speak", "audio_transcribe",
  "email_download_attachment", "whatsapp_send_file", "browser_screenshot", "storage_read", "storage_write", "register_outcome", "read_attachment"];
const matches = (pattern: string, name: string) => pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
export function toolPlacement(name: string): ToolPlacement {
  if (SANDBOX_TOOLS.some((p) => matches(p, name))) return "sandbox";
  if (BRIDGED_TOOLS.some((p) => matches(p, name))) return "bridged";
  return "host";
}
export const PLACEMENT_INFO: Record<ToolPlacement, { label: string; description: string }> = {
  sandbox: { label: "In the sandbox", description: "Commands and the working files: they run where the sandbox is (bubblewrap here, or the remote VM)." },
  bridged: { label: "Here, files bridged", description: "Run on this machine (a library or a key) but use the working files: with a remote VM, input files are fetched from it and produced files are copied into it." },
  host: { label: "Here, keys stay here", description: "Use keys or integrations (vault, email, messaging, storage, data sources…) that never reach the sandbox." },
};

export interface EffectiveSandbox {
  provider: SandboxProvider;
  network: { mode: SandboxNetworkMode; allow?: string[] };
  resources: { cpus?: number; memoryMb?: number; diskMb?: number; timeoutMin?: number };
}

export interface SandboxOverview {
  available: SandboxProvider[];
  settings: SandboxSettings | null;
  polpo: EffectiveSandbox;
  agents: Array<{ name: string; settings: SandboxSettings | null; task: EffectiveSandbox; chat: EffectiveSandbox }>;
}

export const SANDBOX_PROVIDERS: Array<{ id: SandboxProvider; label: string; description: string; remote?: boolean }> = [
  { id: "local", label: "This machine", description: "No isolation: commands see everything the server user sees." },
  { id: "bwrap", label: "Bubblewrap", description: "A jail on this machine: only the working folder, granted paths and storage mounts." },
  { id: "docker", label: "Container", description: "A container on this machine." },
  { id: "daytona", label: "Daytona", description: "A remote sandbox (tasks only).", remote: true },
  { id: "e2b", label: "E2B", description: "A remote sandbox (tasks only).", remote: true },
];

export const NETWORK_MODES: Array<{ id: SandboxNetworkMode; label: string; description: string }> = [
  { id: "open", label: "Open", description: "Any public destination, through a proxy. Never this machine's own services, private networks or Tailscale." },
  { id: "allowlist", label: "Allowlist", description: "Only the listed hosts (through a proxy)." },
  { id: "deny", label: "None", description: "No network at all." },
  { id: "unrestricted", label: "Unrestricted", description: "The whole network of this machine, local services included. Risky." },
];

/** A destination the sandbox network rule refused recently (GET /sandbox/network-denied). */
export interface NetworkDeniedEntry {
  agentName?: string;
  scope: "chat" | "task";
  host: string;
  port?: number;
  reason: "not-allowed" | "private-address";
  count: number;
  lastAt: string;
}

export function providerLabel(id: SandboxProvider): string {
  return SANDBOX_PROVIDERS.find((p) => p.id === id)?.label ?? id;
}

export function describeSandbox(sandbox: EffectiveSandbox): string {
  const network = sandbox.network.mode === "allowlist"
    ? `allowlist (${sandbox.network.allow?.length ?? 0})`
    : NETWORK_MODES.find((m) => m.id === sandbox.network.mode)?.label.toLowerCase() ?? sandbox.network.mode;
  const limits = [
    sandbox.resources.memoryMb ? `${sandbox.resources.memoryMb} MB` : null,
    sandbox.resources.cpus ? `${sandbox.resources.cpus} CPU` : null,
    sandbox.resources.timeoutMin ? `${sandbox.resources.timeoutMin} min` : null,
  ].filter(Boolean).join(", ");
  return `${providerLabel(sandbox.provider)} · network ${network}${limits ? ` · ${limits}` : ""}`;
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
    const error = typeof body?.error === "string"
      ? body.error
      : (body?.error as { message?: string } | undefined)?.message;
    throw new Error(error || `Sandbox request failed (${response.status})`);
  }
  return body.data as T;
}

export type RemoteProviderId = "daytona" | "e2b";

/** settings.sandbox.providers.<id> for Daytona/E2B: no secrets, the key stays in the referenced vault entry. */
export interface RemoteProviderSettings {
  credential?: VaultRef;
  /** Daytona: API URL. */
  apiUrl?: string;
  /** Daytona: region. */
  target?: string;
  /** E2B: custom domain (self-hosted). */
  domain?: string;
  /** E2B: default template. */
  template?: string;
}

export interface RemoteProviderStatus extends RemoteProviderSettings {
  id: RemoteProviderId;
  /** A vault entry is chosen. */
  configured: boolean;
  /** The chosen entry exists and holds a key. */
  keyFound: boolean;
  lastTest?: { ok: boolean; at: string; durationMs?: number; error?: string };
}

/**
 * The instance sandbox settings with one remote provider set (or removed with null): the rest of
 * the sandbox settings and the other providers are kept as they are.
 */
export function withRemoteProvider(current: SandboxSettings | null | undefined, id: RemoteProviderId, settings: RemoteProviderSettings | null): SandboxSettings {
  const providers = { ...(current?.providers ?? {}) };
  if (settings) {
    const clean = Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined && v !== null && v !== ""));
    providers[id] = clean;
  } else {
    delete providers[id];
  }
  const next: SandboxSettings = { ...(current ?? {}) };
  if (Object.keys(providers).length) next.providers = providers;
  else delete next.providers;
  return next;
}

export const sandboxApi = {
  overview: () => request<SandboxOverview>("/sandbox"),
  providers: () => request<RemoteProviderStatus[]>("/sandbox/providers"),
  /**
   * Save one remote provider (null disconnects it) with the other sandbox settings: reads the
   * current instance settings first so nothing else changes.
   */
  saveProvider: async (id: RemoteProviderId, settings: RemoteProviderSettings | null) => {
    const { settings: current } = await request<SandboxOverview>("/sandbox");
    const next = withRemoteProvider(current, id, settings);
    return request<unknown>("/config/settings", { method: "PATCH", body: JSON.stringify({ sandbox: Object.keys(next).length ? next : null }) });
  },
  testProvider: (id: RemoteProviderId) =>
    request<NonNullable<RemoteProviderStatus["lastTest"]>>(`/sandbox/providers/${id}/test`, { method: "POST" }),
  /** Destinations refused recently, newest first. */
  networkDenied: () => request<NetworkDeniedEntry[]>("/sandbox/network-denied"),
  /** Instance defaults; null removes them. */
  saveInstance: (sandbox: SandboxSettings | null) =>
    request<unknown>("/config/settings", { method: "PATCH", body: JSON.stringify({ sandbox }) }),
  /** Agent overrides; an empty object means "inherit everything". */
  saveAgent: (name: string, sandbox: SandboxSettings) =>
    request<unknown>(`/agents/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ sandbox }) }),
};

/** Drop empty fields so "inherit" is stored as absence. */
export function compactSandbox(s: SandboxSettings): SandboxSettings {
  const out: SandboxSettings = {};
  if (s.provider) out.provider = s.provider;
  if (s.allowedProviders?.length) out.allowedProviders = s.allowedProviders;
  if (s.network) out.network = s.network.mode === "allowlist" ? { mode: "allowlist", allow: (s.network.allow ?? []).filter(Boolean) } : { mode: s.network.mode };
  const resources = Object.fromEntries(Object.entries(s.resources ?? {}).filter(([, v]) => typeof v === "number" && v > 0));
  if (Object.keys(resources).length) out.resources = resources;
  if (s.allowLocal) out.allowLocal = true;
  if (s.confineExternalContent) out.confineExternalContent = true;
  if (s.chatIdleMinutes && s.chatIdleMinutes > 0) out.chatIdleMinutes = s.chatIdleMinutes;
  if (s.chatRemote) out.chatRemote = true;
  if (s.lifecycle) {
    const lc = Object.fromEntries(Object.entries(s.lifecycle).filter(([, v]) => v !== undefined && v !== null && v !== ""));
    if (Object.keys(lc).length) out.lifecycle = lc as SandboxLifecycle;
  }
  if (s.warm) {
    const warm = Object.fromEntries(Object.entries(s.warm).filter(([, v]) => typeof v === "number" && v > 0));
    if (Object.keys(warm).length) out.warm = warm;
  }
  // provider options (remote providers' vault references) are edited elsewhere: keep them
  if (s.providers && Object.keys(s.providers).length) out.providers = s.providers;
  return out;
}

// ── Approving a refused destination ──────────────────────────────────────

/** The allowlist entry for a refused destination: the host, with the port only when it is not plain web traffic. */
export function allowEntryFor(entry: Pick<NetworkDeniedEntry, "host" | "port">): string {
  return entry.port && entry.port !== 80 && entry.port !== 443 ? `${entry.host}:${entry.port}` : entry.host;
}

/** True when an allowlist ("host", "*.host", "host:port") covers host:port (same rule as the server's proxy). */
export function allowlistCovers(allow: string[] | undefined, host: string, port?: number): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return (allow ?? []).some((raw) => {
    const m = /^(.*):(\d{1,5})$/.exec(raw.trim().toLowerCase());
    const withPort = m && !m[1]!.includes(":");
    const pattern = withPort ? m![1]! : raw.trim().toLowerCase();
    if (withPort && Number(m![2]) !== port) return false;
    return pattern.startsWith("*.") ? h === pattern.slice(2) || h.endsWith(pattern.slice(1)) : h === pattern;
  });
}

/** Add a host to the allowlist of one level, starting from `base` when that level has no allowlist of its own. */
export function withAllowedHost(settings: SandboxSettings, host: string, base: string[] = []): SandboxSettings {
  const current = settings.network?.mode === "allowlist" ? settings.network.allow ?? [] : base;
  return { ...settings, network: { mode: "allowlist", allow: current.includes(host) ? current : [...current, host] } };
}

/** Why an entry cannot be approved with one click, or null when it can. */
export function approvalBlocker(entry: NetworkDeniedEntry): string | null {
  return entry.reason === "private-address"
    ? "A local or private address: the proxy never reaches those. To allow one deliberately, write its IP in an agent's allowlist (Sandbox tab), or choose Unrestricted."
    : null;
}

/** The agent's settings after "Allow for <agent>": its own allowlist, or a new one that starts from the instance list. */
export function planAllowForAgent(overview: SandboxOverview, entry: NetworkDeniedEntry): { name: string; settings: SandboxSettings } | null {
  const agent = overview.agents.find((a) => a.name === entry.agentName);
  if (!agent) return null;
  const instance = overview.settings?.network;
  const base = instance?.mode === "allowlist" ? instance.allow ?? [] : [];
  return { name: agent.name, settings: compactSandbox(withAllowedHost(agent.settings ?? {}, allowEntryFor(entry), base)) };
}

/**
 * "Allow for everyone": the instance allowlist, and every agent that has an allowlist of its own
 * (those do not inherit the instance's). Null when the instance has no allowlist to extend (open).
 */
export function planAllowForEveryone(overview: SandboxOverview, entry: NetworkDeniedEntry):
  { instance: SandboxSettings; agents: Array<{ name: string; settings: SandboxSettings }> } | null {
  const mode = overview.settings?.network?.mode;
  if (mode !== "allowlist" && mode !== "deny") return null;
  const host = allowEntryFor(entry);
  return {
    instance: compactSandbox(withAllowedHost(overview.settings ?? {}, host)),
    agents: overview.agents
      .filter((a) => a.settings?.network?.mode === "allowlist")
      .map((a) => ({ name: a.name, settings: compactSandbox(withAllowedHost(a.settings!, host)) })),
  };
}

/** True once the agent's effective allowlist covers the destination (the approval took effect). */
export function alreadyAllowed(overview: SandboxOverview, entry: NetworkDeniedEntry): boolean {
  const effective = entry.agentName === "polpo" || !entry.agentName
    ? overview.polpo
    : overview.agents.find((a) => a.name === entry.agentName)?.[entry.scope];
  return !!effective && effective.network.mode === "allowlist" && allowlistCovers(effective.network.allow, entry.host, entry.port);
}
