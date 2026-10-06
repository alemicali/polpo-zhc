/**
 * Sandboxes: where an agent's "hands" run (shell, files, browser, code), isolated from the host.
 *
 * The agent loop (model calls, vault, database, memory, events) always stays on the host; the
 * tools that act on files and processes go through a Workspace, whose adapter decides where they
 * run: the host itself ("local"), a bubblewrap jail ("bwrap"), a container ("docker"), or a
 * remote sandbox ("daytona", "e2b": task runs only).
 *
 * Design: /home/alessio/dev/polpo/polpo-arch/SANDBOX.md
 */

// ── Workspace ────────────────────────────────────────────────────────────

export interface ExecOptions {
  /** Working directory inside the workspace (default: its root). */
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
  signal?: AbortSignal;
  /** Streamed output (stdout and stderr interleaved). */
  onOutput?: (chunk: string) => void;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  durationMs: number;
}

export interface WorkspaceFileStat {
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  mtimeMs: number;
}

export interface WorkspaceEntry {
  path: string;
  type: "file" | "dir" | "symlink" | "other";
  size?: number;
}

/** A place where an agent's tools act. Paths are absolute inside the workspace. */
export interface Workspace {
  readonly id: string;
  readonly provider: SandboxProvider;
  /** The agent's working directory, as the agent sees it. */
  readonly root: string;
  /** Extra directories the agent can read (and maybe write), as the agent sees them. */
  readonly paths: Array<{ path: string; readOnly: boolean }>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string, opts?: { mode?: number }): Promise<void>;
  stat(path: string): Promise<WorkspaceFileStat | null>;
  list(path: string, opts?: { recursive?: boolean; maxEntries?: number }): Promise<WorkspaceEntry[]>;
  mkdir(path: string): Promise<void>;
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  /** Host ↔ workspace copies (context transfer for remote sandboxes; no-ops when shared). */
  upload(hostPath: string, path: string): Promise<void>;
  download(path: string, hostPath: string): Promise<void>;
  dispose(): Promise<void>;
}

// ── Settings and the cascade ─────────────────────────────────────────────

export type SandboxProvider = "local" | "bwrap" | "docker" | "daytona" | "e2b";
export type SandboxNetworkMode = "deny" | "allowlist" | "open";

/** Providers that run on this machine (usable by chats). */
export const LOCAL_PROVIDERS: ReadonlySet<SandboxProvider> = new Set(["local", "bwrap", "docker"]);

/** Isolation strength, weakest first: "tightening" means moving right. */
export const PROVIDER_ISOLATION: Record<SandboxProvider, number> = { local: 0, bwrap: 1, docker: 2, daytona: 3, e2b: 3 };
const NETWORK_STRICTNESS: Record<SandboxNetworkMode, number> = { open: 0, allowlist: 1, deny: 2 };

export interface SandboxNetwork {
  mode: SandboxNetworkMode;
  /** Domains for "allowlist" ("example.com", "*.example.com"). */
  allow?: string[];
}

export interface SandboxResources {
  cpus?: number;
  memoryMb?: number;
  diskMb?: number;
  timeoutMin?: number;
}

/** One level of the cascade (instance, agent, mission, task). Every field is optional. */
export interface SandboxSettings {
  provider?: SandboxProvider;
  /** Instance and agent levels only: the providers lower levels may pick. */
  allowedProviders?: SandboxProvider[];
  network?: SandboxNetwork;
  resources?: SandboxResources;
  /**
   * Agent level only, set by a person: allow "local" even though the agent reads external
   * content (web, email, messaging). Without it such agents get at least "bwrap".
   */
  allowLocal?: boolean;
  /** Chat workspaces close after this idle time (instance level). */
  chatIdleMinutes?: number;
  /** Provider-specific options (image, template, region…); never secrets. */
  providers?: Partial<Record<SandboxProvider, Record<string, unknown>>>;
}

/** The settings a workspace is created with, after the cascade. */
export interface EffectiveSandbox {
  provider: SandboxProvider;
  network: SandboxNetwork;
  resources: SandboxResources;
  providerOptions: Record<string, unknown>;
  /** Requests a lower level made that were not allowed (they became the stricter option). */
  denied: Array<{ level: "mission" | "task"; field: string; requested: unknown; applied: unknown }>;
}

export interface SandboxCascade {
  instance?: SandboxSettings;
  agent?: SandboxSettings;
  mission?: SandboxSettings;
  task?: SandboxSettings;
}

/** Tools that bring other people's content into the agent's context (prompt-injection risk). */
export const EXTERNAL_CONTENT_TOOLS = [
  "browser_*", "http_fetch", "http_download", "search_*", "email_*", "whatsapp_*", "web_*",
];

function matches(pattern: string, name: string): boolean {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
}

/** True when an agent's allowed tools include one that reads external content. */
export function readsExternalContent(allowedTools: string[] | undefined): boolean {
  if (!allowedTools?.length) return false;
  return allowedTools.some((tool) => EXTERNAL_CONTENT_TOOLS.some((pattern) =>
    matches(pattern, tool) || (tool.endsWith("*") && pattern.startsWith(tool.slice(0, -1)))));
}

function domainAllowed(domain: string, allow: string[]): boolean {
  return allow.some((pattern) => pattern === domain || (pattern.startsWith("*.") && (domain === pattern.slice(2) || domain.endsWith(pattern.slice(1)))));
}

/**
 * Resolve the cascade instance → agent → mission → task for a chat or a task run.
 *
 * Instance and agent (written by people) set and loosen; mission and task (often written by a
 * model) may only pick among what is allowed and tighten. Whatever they request beyond that is
 * replaced by the stricter option and reported in `denied`.
 */
export function resolveSandbox(
  cascade: SandboxCascade,
  context: { scope: "chat" | "task"; agentTools?: string[]; available?: ReadonlySet<SandboxProvider> },
): EffectiveSandbox {
  const instance = cascade.instance ?? {};
  const agent = cascade.agent ?? {};
  const denied: EffectiveSandbox["denied"] = [];

  const allowed = new Set<SandboxProvider>(agent.allowedProviders ?? instance.allowedProviders ?? ["local", "bwrap", "docker", "daytona", "e2b"]);
  let provider: SandboxProvider = agent.provider ?? instance.provider ?? "local";
  allowed.add(provider);
  let network: SandboxNetwork = agent.network ?? instance.network ?? { mode: "open" };
  const resources: SandboxResources = { ...(instance.resources ?? {}), ...(agent.resources ?? {}) };
  const ceiling: SandboxResources = { ...resources };

  for (const level of ["mission", "task"] as const) {
    const s = cascade[level];
    if (!s) continue;
    if (s.provider && s.provider !== provider) {
      if (allowed.has(s.provider) && PROVIDER_ISOLATION[s.provider] >= PROVIDER_ISOLATION[provider]) provider = s.provider;
      else denied.push({ level, field: "provider", requested: s.provider, applied: provider });
    }
    if (s.network) {
      const stricter = NETWORK_STRICTNESS[s.network.mode] > NETWORK_STRICTNESS[network.mode];
      const sameModeSubset = s.network.mode === "allowlist" && network.mode === "allowlist"
        && (s.network.allow ?? []).every((d) => domainAllowed(d, network.allow ?? []));
      const subsetOfOpen = s.network.mode === "allowlist" && network.mode === "open";
      if (stricter || sameModeSubset || subsetOfOpen || s.network.mode === network.mode && s.network.mode !== "allowlist") {
        network = s.network.mode === "allowlist" && network.mode === "allowlist"
          ? { mode: "allowlist", allow: (s.network.allow ?? []).filter((d) => domainAllowed(d, network.allow ?? [])) }
          : s.network;
      } else denied.push({ level, field: "network", requested: s.network, applied: network });
    }
    for (const key of ["cpus", "memoryMb", "diskMb", "timeoutMin"] as const) {
      const requested = s.resources?.[key];
      if (requested === undefined) continue;
      const max = ceiling[key];
      if (max === undefined || requested <= max) resources[key] = requested;
      else { resources[key] = max; denied.push({ level, field: `resources.${key}`, requested, applied: max }); }
    }
  }

  // Agents that read other people's content never run unconfined, unless a person said so.
  if (provider === "local" && readsExternalContent(context.agentTools) && !agent.allowLocal) {
    provider = "bwrap";
  }
  // Chats stay on this machine: a remote provider falls back to the best local isolation.
  if (context.scope === "chat" && !LOCAL_PROVIDERS.has(provider)) {
    provider = context.available?.has("docker") ? "docker" : "bwrap";
  }
  // A provider this host cannot run falls back to the next stronger local one, never weaker.
  if (context.available && !context.available.has(provider)) {
    const fallback = (["bwrap", "docker"] as SandboxProvider[]).find((p) => context.available!.has(p) && PROVIDER_ISOLATION[p] >= Math.min(PROVIDER_ISOLATION[provider], 1));
    if (fallback) provider = fallback;
  }

  return {
    provider,
    network,
    resources,
    providerOptions: { ...(instance.providers?.[provider] ?? {}), ...(agent.providers?.[provider] ?? {}) },
    denied,
  };
}

// ── Storage mounts (provided by the storage feature, applied by the workspace) ─────────

/** A bucket (or part of it) to show as a directory inside a workspace. */
export interface StorageMountSpec {
  /** Storage entry name. */
  name: string;
  /** Where the agent sees it (default /mnt/storage/<name>). */
  path: string;
  readOnly: boolean;
  /** Mounted on the host (local, bwrap, docker bind it in). */
  hostPath?: string;
  /**
   * For remote sandboxes: mount inside the sandbox with FUSE. Credentials are the dedicated,
   * limited "sandbox credentials" of the storage entry; a bucket without them is not mounted
   * remotely.
   */
  remote?: {
    driver: "rclone" | "mountpoint-s3";
    endpoint?: string;
    region?: string;
    bucket: string;
    prefix?: string;
    pathStyle?: boolean;
    credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  };
}

/** What a workspace asks the storage feature: the mounts this agent may see. */
export interface StorageMountProvider {
  mountsFor(agentName: string | undefined, target: "host" | "remote"): Promise<StorageMountSpec[]>;
}
