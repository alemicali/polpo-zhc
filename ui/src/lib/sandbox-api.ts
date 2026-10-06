/**
 * Sandbox — where agents' tools run (this machine, a bubblewrap jail, a container, a remote VM).
 *
 * Thin client for /api/v1/sandbox plus the settings and agent updates that carry a `sandbox`
 * block. Same envelope ({ ok, data } / { ok, error }) as the other page-level clients.
 */
import { apiUrl, config } from "@/lib/config";

export type SandboxProvider = "local" | "bwrap" | "docker" | "daytona" | "e2b";
export type SandboxNetworkMode = "deny" | "allowlist" | "open";

export interface SandboxSettings {
  provider?: SandboxProvider;
  allowedProviders?: SandboxProvider[];
  network?: { mode: SandboxNetworkMode; allow?: string[] };
  resources?: { cpus?: number; memoryMb?: number; diskMb?: number; timeoutMin?: number };
  allowLocal?: boolean;
  chatIdleMinutes?: number;
}

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
  { id: "open", label: "Open", description: "Any destination." },
  { id: "allowlist", label: "Allowlist", description: "Only the listed domains (through a proxy)." },
  { id: "deny", label: "None", description: "No network at all." },
];

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

export const sandboxApi = {
  overview: () => request<SandboxOverview>("/sandbox"),
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
  if (s.chatIdleMinutes && s.chatIdleMinutes > 0) out.chatIdleMinutes = s.chatIdleMinutes;
  return out;
}
