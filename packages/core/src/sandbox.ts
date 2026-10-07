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
/**
 * "unrestricted": the full network of this machine, local services included. "open": every
 * public destination, through the proxy (no loopback, private, Tailscale or metadata addresses).
 * "allowlist": only the listed hosts. "deny": nothing.
 */
export type SandboxNetworkMode = "deny" | "allowlist" | "open" | "unrestricted";

/** Providers that run on this machine (usable by chats). */
export const LOCAL_PROVIDERS: ReadonlySet<SandboxProvider> = new Set(["local", "bwrap", "docker"]);

/** Isolation strength, weakest first: "tightening" means moving right. */
export const PROVIDER_ISOLATION: Record<SandboxProvider, number> = { local: 0, bwrap: 1, docker: 2, daytona: 3, e2b: 3 };
const NETWORK_STRICTNESS: Record<SandboxNetworkMode, number> = { unrestricted: 0, open: 1, allowlist: 2, deny: 3 };

export interface SandboxNetwork {
  mode: SandboxNetworkMode;
  /** Hosts for "allowlist": "example.com", "*.example.com", optionally with a port ("example.com:22"). */
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
   * Instance level, opt-in: agents that read external content (web, email, messaging, or no
   * tool list) and Polpo itself run at least in "bwrap", even when the default is "local".
   */
  confineExternalContent?: boolean;
  /**
   * Set by a person, only meaningful with confineExternalContent: on an agent, let it run on
   * "local" anyway; on the instance, the same for Polpo.
   */
  allowLocal?: boolean;
  /** Chat workspaces close after this idle time (instance level). */
  chatIdleMinutes?: number;
  /**
   * Opt-in "Cowork" chats: a chat with this agent (or, on the instance, with every agent) may run
   * its sandbox tools on a remote provider (Daytona, E2B). Without it chats stay on this machine.
   */
  chatRemote?: boolean;
  /**
   * How a run gets its remote sandbox (open Polpo semantics): "reuse" takes a warm sandbox this
   * agent released (exclusive while in use), "fresh" a clean one for the run, "shared" a
   * project-scoped sandbox that concurrent runs may use together.
   */
  isolation?: SandboxIsolation;
  /** What happens after the run releases the sandbox (pool or destroy, idle stop, deletion). */
  lifecycle?: SandboxLifecycleSettings;
  /**
   * Persistent volumes for this run, by name (open Polpo semantics): the first level that sets
   * them defines the list, lower levels may only remove volumes or narrow them (read-only,
   * manual write-back). A name must also be granted to the agent on its storage entry.
   */
  volumes?: SandboxVolumeSelection[];
  /** Instance level: remote VMs kept ready per provider (default 0: none, they cost money). */
  warm?: Partial<Record<RemoteSandboxProvider, number>>;
  /** Provider-specific options (image, template, region…); never secrets. */
  providers?: Partial<Record<SandboxProvider, Record<string, unknown>>>;
}

/** The settings a workspace is created with, after the cascade. */
export type RemoteSandboxProvider = "daytona" | "e2b";
export const REMOTE_SANDBOX_PROVIDERS: readonly RemoteSandboxProvider[] = ["daytona", "e2b"];

export type SandboxIsolation = "reuse" | "fresh" | "shared";
export type SandboxReleasePolicy = "pool" | "destroy";
export type SandboxVolumeAccess = "read-only" | "read-write";
export type SandboxVolumeWriteBack = "auto" | "manual";
export type SandboxVolumeStrategy = "mounted" | "hydrated";

export const SANDBOX_VOLUME_NAME_PATTERN = /^[a-z][a-z0-9_-]{1,62}$/;
export const SANDBOX_VOLUMES_MAX = 32;
export const SANDBOX_IDLE_TTL_MINUTES_MAX = 7 * 24 * 60;
/** Where every volume appears inside a sandbox (and in bubblewrap jails on this machine). */
export const SANDBOX_VOLUME_ROOT = "/volumes";

/** What happens after a run releases its remote sandbox (open Polpo names). */
export interface SandboxLifecycleSettings {
  onRelease?: SandboxReleasePolicy;
  /** Stop a pooled sandbox after this many minutes without activity. */
  stopAfterIdleMinutes?: number;
  /** Delete a stopped sandbox after this many minutes (0 = right after stopping). */
  deleteAfterStopMinutes?: number;
  /** @deprecated legacy single control: stop after this idle time and delete right away. */
  idleTtlMinutes?: number;
}

export interface SandboxVolumeSelection {
  name: string;
  access?: SandboxVolumeAccess;
  writeBack?: SandboxVolumeWriteBack;
}

export class SandboxVolumeGrantError extends Error {
  readonly code = "sandbox_volume_not_granted";
  constructor(readonly volumeName: string) {
    super(`Sandbox volume is not granted by the parent policy: ${volumeName}`);
    this.name = "SandboxVolumeGrantError";
  }
}

export const DEFAULT_ISOLATION: SandboxIsolation = "reuse";
export const DEFAULT_LIFECYCLE: Required<Omit<SandboxLifecycleSettings, "idleTtlMinutes">> = {
  onRelease: "pool",
  stopAfterIdleMinutes: 5,
  deleteAfterStopMinutes: 30,
};

/** Effective lifecycle (legacy idleTtlMinutes = stop after it, delete right away). */
export function effectiveLifecycle(l: SandboxLifecycleSettings | undefined): Required<Omit<SandboxLifecycleSettings, "idleTtlMinutes">> {
  if (l?.idleTtlMinutes !== undefined && l.stopAfterIdleMinutes === undefined && l.deleteAfterStopMinutes === undefined) {
    return { onRelease: l.onRelease ?? DEFAULT_LIFECYCLE.onRelease, stopAfterIdleMinutes: l.idleTtlMinutes, deleteAfterStopMinutes: 0 };
  }
  return { ...DEFAULT_LIFECYCLE, ...Object.fromEntries(Object.entries(l ?? {}).filter(([k, v]) => k !== "idleTtlMinutes" && v !== undefined)) };
}

function narrowVolumeSelection(inherited: SandboxVolumeSelection, requested: SandboxVolumeSelection): SandboxVolumeSelection {
  const access: SandboxVolumeAccess | undefined =
    inherited.access === "read-only" || requested.access === "read-only" ? "read-only" : requested.access ?? inherited.access;
  const writeBack: SandboxVolumeWriteBack | undefined = access === "read-only"
    ? undefined
    : inherited.writeBack === "manual" || requested.writeBack === "manual" ? "manual" : requested.writeBack ?? inherited.writeBack;
  return { name: inherited.name, ...(access === undefined ? {} : { access }), ...(writeBack === undefined ? {} : { writeBack }) };
}

/**
 * Volume selections through the cascade: the first level that sets them defines the list,
 * every later level may only select a subset and narrow access/write-back.
 */
export function narrowVolumeSelections(levels: Array<SandboxVolumeSelection[] | undefined>): SandboxVolumeSelection[] | undefined {
  let merged: SandboxVolumeSelection[] | undefined;
  for (const level of levels) {
    if (level === undefined) continue;
    if (merged === undefined) { merged = level.map((v) => ({ ...v })); continue; }
    const grants = new Map(merged.map((v) => [v.name, v]));
    merged = level.map((v) => {
      const grant = grants.get(v.name);
      if (!grant) throw new SandboxVolumeGrantError(v.name);
      return narrowVolumeSelection(grant, v);
    });
  }
  return merged;
}

export interface EffectiveSandbox {
  provider: SandboxProvider;
  network: SandboxNetwork;
  resources: SandboxResources;
  providerOptions: Record<string, unknown>;
  /** Requests a lower level made that were not allowed (they became the stricter option). */
  denied: Array<{ level: "mission" | "task"; field: string; requested: unknown; applied: unknown }>;
  /** Remote providers: how the sandbox is acquired and released (absent on older callers = defaults). */
  isolation?: SandboxIsolation;
  lifecycle?: Required<Omit<SandboxLifecycleSettings, "idleTtlMinutes">>;
  /** Selected volumes (names, narrowed); resolved against the agent's grants by the host. */
  volumes?: SandboxVolumeSelection[];
}

export interface SandboxCascade {
  instance?: SandboxSettings;
  agent?: SandboxSettings;
  mission?: SandboxSettings;
  task?: SandboxSettings;
}

// ── Where each tool runs ─────────────────────────────────────────────────

/**
 * Same semantics as open Polpo's `requiresSandbox` (packages/tools/src/runtime-requirements.ts):
 *
 * - "sandbox": works on the agent's files or runs programs, so it acts in the agent's sandbox.
 *   Commands (and the browser, with a remote VM) run there; the other tools read and write the
 *   agent's files through the sandbox's FileSystem, so with a remote VM the bytes live in the VM.
 * - "host": runs on this machine because it uses keys or integrations that must not reach the
 *   sandbox (vault, email, messaging, storage, data sources…), or manages the instance.
 */
export type ToolPlacement = "sandbox" | "host";

export const TOOL_PLACEMENT: ReadonlyArray<{ pattern: string; placement: ToolPlacement }> = [
  ...["read", "write", "edit", "bash", "glob", "grep", "ls", "http_download", "email_download_attachment", "run_command",
    "browser_*", "image_*", "video_*", "audio_*", "excel_*", "pdf_*", "docx_*"].map((pattern) => ({ pattern, placement: "sandbox" as const })),
];

export function toolPlacement(name: string): ToolPlacement {
  for (const { pattern, placement } of TOOL_PLACEMENT) {
    if (pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name) return placement;
  }
  return "host";
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
  // No list means every core tool, http_fetch and http_download included.
  if (allowedTools === undefined) return true;
  if (!allowedTools.length) return false;
  return allowedTools.some((tool) => EXTERNAL_CONTENT_TOOLS.some((pattern) =>
    matches(pattern, tool) || (tool.endsWith("*") && pattern.startsWith(tool.slice(0, -1)))));
}

/** "host" or "host:port" (the port is the digits after the last colon, so IPv6 literals stay whole). */
export function splitHostPort(entry: string): { host: string; port?: number } {
  const e = entry.trim();
  const m = /^(.*):(\d{1,5})$/.exec(e);
  // a bare IPv6 literal has colons of its own: with a port it must be written [::1]:22
  const withPort = m && (!m[1]!.includes(":") || (m[1]!.startsWith("[") && m[1]!.endsWith("]")));
  const host = (withPort ? m![1]! : e).replace(/^\[(.*)\]$/, "$1");
  return withPort ? { host, port: Number(m![2]) } : { host };
}

/** True when an upper-level allowlist entry covers the requested one (same or broader host, same or any port). */
function domainAllowed(requested: string, allow: string[]): boolean {
  const want = splitHostPort(requested);
  return allow.some((entry) => {
    const have = splitHostPort(entry);
    if (have.port !== undefined && have.port !== want.port) return false;
    const pattern = have.host;
    return pattern === want.host || (pattern.startsWith("*.") && (want.host === pattern.slice(2) || want.host.endsWith(pattern.slice(1))));
  });
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
  // isolation, lifecycle and volumes follow open Polpo's resolution: later levels override
  // isolation and lifecycle fields; volumes can only be removed or narrowed
  let isolation: SandboxIsolation = DEFAULT_ISOLATION;
  let lifecycleRaw: SandboxLifecycleSettings = {};
  for (const level of [cascade.instance, cascade.agent, cascade.mission, cascade.task]) {
    if (level?.isolation) isolation = level.isolation;
    if (level?.lifecycle) {
      if (level.lifecycle.onRelease === "destroy") lifecycleRaw = { onRelease: "destroy" };
      else {
        if (level.lifecycle.onRelease) lifecycleRaw.onRelease = level.lifecycle.onRelease;
        if (level.lifecycle.idleTtlMinutes !== undefined) { delete lifecycleRaw.stopAfterIdleMinutes; delete lifecycleRaw.deleteAfterStopMinutes; lifecycleRaw.idleTtlMinutes = level.lifecycle.idleTtlMinutes; }
        for (const k of ["stopAfterIdleMinutes", "deleteAfterStopMinutes"] as const) {
          if (level.lifecycle[k] !== undefined) { delete lifecycleRaw.idleTtlMinutes; lifecycleRaw[k] = level.lifecycle[k]; }
        }
      }
    }
  }
  const lifecycle = effectiveLifecycle(lifecycleRaw);
  const volumes = narrowVolumeSelections([cascade.instance?.volumes, cascade.agent?.volumes, cascade.mission?.volumes, cascade.task?.volumes]);

  for (const level of ["mission", "task"] as const) {
    const s = cascade[level];
    if (!s) continue;
    if (s.provider && s.provider !== provider) {
      if (allowed.has(s.provider) && PROVIDER_ISOLATION[s.provider] >= PROVIDER_ISOLATION[provider]) provider = s.provider;
      else denied.push({ level, field: "provider", requested: s.provider, applied: provider });
    }
    if (s.network) {
      if (s.network.mode === "allowlist" && (network.mode === "allowlist" || network.mode === "open" || network.mode === "unrestricted")) {
        // An allowlist below an allowlist keeps only the domains the upper level allows.
        const requested = s.network.allow ?? [];
        const kept = network.mode === "open" || network.mode === "unrestricted" ? requested : requested.filter((d) => domainAllowed(d, network.allow ?? []));
        if (kept.length < requested.length) denied.push({ level, field: "network", requested: s.network, applied: { mode: "allowlist", allow: kept } });
        network = { mode: "allowlist", allow: kept };
      } else if (NETWORK_STRICTNESS[s.network.mode] >= NETWORK_STRICTNESS[network.mode]) {
        network = s.network;
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

  // Opt-in: agents that read other people's content never run unconfined, unless a person said so.
  if (provider === "local" && instance.confineExternalContent && readsExternalContent(context.agentTools) && !agent.allowLocal) {
    provider = "bwrap";
  }
  // Chats stay on this machine unless a person opted in to remote chats ("Cowork"): then a
  // remote provider is kept; otherwise it falls back to the best local isolation.
  const chatRemote = agent.chatRemote ?? instance.chatRemote ?? false;
  if (context.scope === "chat" && !LOCAL_PROVIDERS.has(provider) && !chatRemote) {
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
    isolation,
    lifecycle,
    ...(volumes ? { volumes } : {}),
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

export interface StorageMountOptions {
  /**
   * How long remote mounts must work (the task's timeout): the lifetime of temporary keys, for
   * entries that mint them. Default 2 hours, at most 12.
   */
  ttlSeconds?: number;
}

/** Object in the volume's prefix holding its revision (bumped by every hydrated write-back). */
export const VOLUME_REVISION_OBJECT = ".polpo-volume.json";

/**
 * A selected volume resolved by the host (open Polpo's ResolvedSandboxVolumeAttachment): where it
 * appears, how it gets there, and — for remote sandboxes — the limited keys to reach its bucket.
 */
export interface ResolvedSandboxVolume {
  name: string;
  strategy: SandboxVolumeStrategy;
  /** Where the run sees it: /volumes/<name> in remote VMs, the host mount directory on this machine. */
  mountPath: string;
  access: SandboxVolumeAccess;
  writeBack?: SandboxVolumeWriteBack;
  /** Mount driver for "mounted" volumes. */
  driver: "rclone" | "mountpoint-s3";
  /** The bucket mounted on this machine (local sandboxes bind it at mountPath). */
  hostPath?: string;
  /** Remote sandboxes: the bucket (prefix) and keys; absent when the entry has no sandbox keys. */
  remote?: {
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
  /**
   * The volumes a run selected, checked against the agent's grants and narrowed by them; throws
   * SandboxVolumeGrantError for a name that is not a volume granted to the agent.
   */
  volumesFor(agentName: string | undefined, selections: SandboxVolumeSelection[], target: "host" | "remote", options?: StorageMountOptions): Promise<ResolvedSandboxVolume[]>;
  mountsFor(agentName: string | undefined, target: "host" | "remote", options?: StorageMountOptions): Promise<StorageMountSpec[]>;
}

/** Keep only well-formed sandbox settings (unknown keys and wrong types are dropped). */
export function normalizeSandboxSettings(raw: unknown): SandboxSettings | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, any>;
  const providers: SandboxProvider[] = ["local", "bwrap", "docker", "daytona", "e2b"];
  const isProvider = (v: unknown): v is SandboxProvider => typeof v === "string" && (providers as string[]).includes(v);
  const out: SandboxSettings = {};
  if (isProvider(r.provider)) out.provider = r.provider;
  if (Array.isArray(r.allowedProviders)) {
    const list = r.allowedProviders.filter(isProvider);
    if (list.length) out.allowedProviders = list;
  }
  if (r.network && typeof r.network === "object" && ["deny", "allowlist", "open", "unrestricted"].includes(r.network.mode)) {
    out.network = { mode: r.network.mode };
    if (Array.isArray(r.network.allow)) out.network.allow = r.network.allow.filter((d: unknown) => typeof d === "string" && d.trim()).map((d: string) => d.trim());
  }
  if (r.resources && typeof r.resources === "object") {
    const res: Record<string, number> = {};
    for (const key of ["cpus", "memoryMb", "diskMb", "timeoutMin"]) {
      if (typeof r.resources[key] === "number" && r.resources[key] > 0) res[key] = r.resources[key];
    }
    if (Object.keys(res).length) out.resources = res;
  }
  if (typeof r.allowLocal === "boolean") out.allowLocal = r.allowLocal;
  if (typeof r.confineExternalContent === "boolean") out.confineExternalContent = r.confineExternalContent;
  if (typeof r.chatIdleMinutes === "number" && r.chatIdleMinutes > 0) out.chatIdleMinutes = r.chatIdleMinutes;
  if (typeof r.chatRemote === "boolean") out.chatRemote = r.chatRemote;
  if (r.isolation === "reuse" || r.isolation === "fresh" || r.isolation === "shared") out.isolation = r.isolation;
  // settings saved before the names were aligned with open Polpo (lifecycle.isolation)
  else if (r.lifecycle?.isolation === "reuse" || r.lifecycle?.isolation === "fresh") out.isolation = r.lifecycle.isolation;
  if (r.lifecycle && typeof r.lifecycle === "object") {
    const l: SandboxLifecycleSettings = {};
    if (r.lifecycle.onRelease === "pool" || r.lifecycle.onRelease === "destroy") l.onRelease = r.lifecycle.onRelease;
    if (l.onRelease !== "destroy") {
      const minutes = (v: unknown, min: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= SANDBOX_IDLE_TTL_MINUTES_MAX;
      if (minutes(r.lifecycle.idleTtlMinutes, 1)) l.idleTtlMinutes = r.lifecycle.idleTtlMinutes;
      else {
        if (minutes(r.lifecycle.stopAfterIdleMinutes, 1)) l.stopAfterIdleMinutes = r.lifecycle.stopAfterIdleMinutes;
        if (minutes(r.lifecycle.deleteAfterStopMinutes, 0)) l.deleteAfterStopMinutes = r.lifecycle.deleteAfterStopMinutes;
      }
    }
    if (Object.keys(l).length) out.lifecycle = l;
  }
  if (Array.isArray(r.volumes) && r.volumes.length <= SANDBOX_VOLUMES_MAX) {
    const names = new Set<string>();
    const vols: SandboxVolumeSelection[] = [];
    let ok = true;
    for (const v of r.volumes) {
      if (!v || typeof v !== "object" || typeof v.name !== "string" || !SANDBOX_VOLUME_NAME_PATTERN.test(v.name) || names.has(v.name)) { ok = false; break; }
      if (v.access !== undefined && v.access !== "read-only" && v.access !== "read-write") { ok = false; break; }
      if (v.writeBack !== undefined && v.writeBack !== "auto" && v.writeBack !== "manual") { ok = false; break; }
      if (v.access === "read-only" && v.writeBack !== undefined) { ok = false; break; }
      names.add(v.name);
      vols.push({ name: v.name, ...(v.access ? { access: v.access } : {}), ...(v.writeBack ? { writeBack: v.writeBack } : {}) });
    }
    if (ok) out.volumes = vols;
  }
  if (r.warm && typeof r.warm === "object") {
    const w: Partial<Record<RemoteSandboxProvider, number>> = {};
    for (const p of REMOTE_SANDBOX_PROVIDERS) {
      const v = r.warm[p];
      if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 20) w[p] = v;
    }
    if (Object.keys(w).length) out.warm = w;
  }
  if (r.providers && typeof r.providers === "object") {
    const opts: SandboxSettings["providers"] = {};
    for (const p of providers) if (r.providers[p] && typeof r.providers[p] === "object") opts[p] = r.providers[p];
    if (Object.keys(opts).length) out.providers = opts;
  }
  return Object.keys(out).length ? out : undefined;
}
