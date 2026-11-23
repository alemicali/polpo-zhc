/**
 * Creates the workspace an agent's tools run in, from the settings cascade
 * (instance → agent → mission → task), and adapts it to the Shell the tools already use.
 */
import type { Shell, ShellOptions, ShellResult } from "@polpo-ai/core/shell";
import {
  resolveSandbox,
  type EffectiveSandbox,
  type SandboxCascade,
  type SandboxProviderId,
  type SandboxSettings,
  type ResolvedSandboxVolume,
  type StorageMountSpec,
  type Workspace,
  type ComputerContext,
  type ComputerConfig,
  normalizeSandboxSettings,
  daytonaApiVersion,
} from "@polpo-ai/core/sandbox";
import { classifyAllowEntries, daytonaNetworkParams, e2bNetworkOpts, SandboxNetworkConfigError } from "./remote-adapters.js";
import { daytonaV2NetworkPolicy } from "./daytona-v2.js";
import type { NetworkDenial } from "./net-proxy.js";
import { bashSafeEnv } from "../tools/safe-env.js";
import { DockerWorkspace, dockerAvailable } from "./docker.js";
import { BwrapWorkspace, LocalWorkspace, bwrapAvailable, type HostWorkspaceOptions } from "./workspaces.js";
import { configuredRemoteProviders } from "./remote-providers.js";
import { createRemoteWorkspace, type RemoteWorkspaceOptions } from "./remote.js";

/** Providers this machine can run right now. */
export function availableProviders(): Set<SandboxProviderId> {
  const out = new Set<SandboxProviderId>(["local"]);
  if (bwrapAvailable()) out.add("bwrap");
  if (dockerAvailable()) out.add("docker");
  // remote providers are available once their vault entry is chosen (Settings → Sandbox)
  for (const id of configuredRemoteProviders()) out.add(id);
  return out;
}

export interface WorkspaceRequest {
  scope: "chat" | "task";
  cascade: SandboxCascade;
  agentTools?: string[];
  root: string;
  writable?: string[];
  readable?: string[];
  /** Selected volumes (resolved for this machine or for a remote VM). */
  volumes?: ResolvedSandboxVolume[];
  hide?: string[];
  onNetworkDenied?: (denial: NetworkDenial) => void;
  /** Remote sandboxes: VM ready, files synced, suspended, released, problems. */
  onRemoteEvent?: RemoteWorkspaceOptions["onEvent"];
  /** Remote sandboxes: the project's pool (reuse, warm, orphan recovery). */
  pool?: RemoteWorkspaceOptions["pool"];
  /** Remote sandboxes in chats: bring changed files back after every command. */
  syncEachExec?: boolean;
  /** Remote sandboxes: suspend after this long without tools (default: by provider). */
  idleSuspendMs?: number;
}

/**
 * On this machine a volume is the bucket mounted here, seen at its host directory (local
 * workspaces share the host's paths); volumes not mounted here are left out.
 */
export function hostVolumeMounts(volumes: ResolvedSandboxVolume[] | undefined): StorageMountSpec[] {
  return (volumes ?? []).filter((v) => v.hostPath).map((v) => ({ name: v.name, path: v.hostPath!, hostPath: v.hostPath, readOnly: v.access === "read-only" }));
}

/** Resolve the cascade (and the agent's computer, when given) for a request on this machine. */
export function effectiveSandbox(req: Pick<WorkspaceRequest, "scope" | "cascade" | "agentTools"> & { computers?: ComputerContext }): EffectiveSandbox {
  return resolveSandbox(req.cascade, { scope: req.scope, agentTools: req.agentTools, available: availableProviders(), computers: req.computers });
}

const PROVIDER_NAMES: Record<SandboxProviderId, string> = { local: "this machine", bwrap: "bubblewrap", docker: "Docker", daytona: "Daytona", e2b: "E2B" };

/** The text shown when a sandbox runs with weaker isolation than its settings ask for. */
export function isolationFallbackMessage(from: SandboxProviderId, to: SandboxProviderId): string {
  return `${PROVIDER_NAMES[from]} is not available where this runs (${from === "daytona" || from === "e2b" ? "no API key chosen in Settings → Sandbox" : "not installed"}): commands run in ${PROVIDER_NAMES[to]} on this server instead, which isolates less`;
}

const loggedFallbacks = new Set<string>();

/** Every run that falls back gets the warning event; the server log gets it once per process. */
function warnIsolationFallback(from: SandboxProviderId, to: SandboxProviderId, onRemoteEvent?: WorkspaceRequest["onRemoteEvent"]): void {
  const message = isolationFallbackMessage(from, to);
  if (!loggedFallbacks.has(`${from}>${to}`)) {
    loggedFallbacks.add(`${from}>${to}`);
    console.warn(`[sandbox] ${message}`);
  }
  onRemoteEvent?.({ kind: "warning", message });
}

/** Create the workspace for an already resolved sandbox. Remote providers come with their adapters. */
export function createWorkspace(sandbox: EffectiveSandbox, req: Omit<WorkspaceRequest, "scope" | "cascade" | "agentTools">): Workspace {
  // the settings chose a provider this server cannot run: resolveSandbox picked a local jail
  if (sandbox.fallback) warnIsolationFallback(sandbox.fallback.from, sandbox.provider, req.onRemoteEvent);
  const opts: HostWorkspaceOptions = {
    root: req.root, writable: req.writable, readable: req.readable, mounts: hostVolumeMounts(req.volumes), hide: req.hide, sandbox, onNetworkDenied: req.onNetworkDenied,
  };
  if (sandbox.provider === "local") return new LocalWorkspace(opts, bashSafeEnv);
  if (sandbox.provider === "bwrap") return new BwrapWorkspace(opts);
  if (sandbox.provider === "docker" && dockerAvailable()) return new DockerWorkspace(opts);
  if ((sandbox.provider === "daytona" || sandbox.provider === "e2b") && configuredRemoteProviders().includes(sandbox.provider)) {
    return createRemoteWorkspace(sandbox.provider, {
      root: req.root, writable: req.writable, readable: req.readable, volumes: req.volumes, sandbox, onEvent: req.onRemoteEvent,
      pool: req.pool, syncEachExec: req.syncEachExec, idleSuspendMs: req.idleSuspendMs,
    });
  }
  // A provider that is not available here falls back to bubblewrap on this server. For a remote
  // provider (or docker) that is WEAKER isolation than the settings ask for: say so, every time.
  if (bwrapAvailable()) {
    warnIsolationFallback(sandbox.provider, "bwrap", req.onRemoteEvent);
    return new BwrapWorkspace({ ...opts, sandbox: { ...sandbox, provider: "bwrap", fallback: { from: sandbox.provider, reason: "unavailable" } } });
  }
  throw new Error(`Sandbox provider "${sandbox.provider}" is not available on this server`);
}

/** The Shell the system tools use (bash, grep, glob), running inside a workspace. */
export class WorkspaceShell implements Shell {
  constructor(private readonly workspace: Workspace) {}
  /** Remote VM: the browser and other programs next to the files run through this shell. */
  async isRemote(): Promise<boolean> {
    return isRemoteWorkspace(this.workspace);
  }
  async execute(command: string, options: ShellOptions = {}): Promise<ShellResult> {
    const result = await this.workspace.exec(command, { cwd: options.cwd, env: options.env, timeoutMs: options.timeout, signal: options.signal });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, ...(result.timedOut ? { timedOut: true } : {}) };
  }
}

export { normalizeSandboxSettings } from "@polpo-ai/core/sandbox";

/** Remote workspaces keep files in the VM: file tools must go through the workspace. */
export function isRemoteWorkspace(workspace: Workspace | undefined): boolean {
  return workspace?.provider === "daytona" || workspace?.provider === "e2b";
}

/**
 * The sandbox a computer's machine is created and started with (explicit start, reset), or why
 * it cannot be: its provider has no API key on this server.
 */
export function computerSandbox(computer: ComputerConfig, settings: { sandbox?: unknown } | undefined): EffectiveSandbox | { error: string } {
  const s = effectiveSandbox({
    scope: "task",
    cascade: { instance: normalizeSandboxSettings(settings?.sandbox) },
    computers: { computers: [computer], defaultComputer: computer.id, allowed: [computer.id] },
  });
  if (s.computer?.id === computer.id && s.provider === computer.kind) return s;
  const name = PROVIDER_NAMES[computer.kind as SandboxProviderId] ?? computer.kind;
  return { error: `${name} has no API key on this server: choose one in Settings → Sandbox` };
}

/** Whether a computer runs on Daytona v2 with these settings (Linux VMs that hibernate). */
export function isDaytonaV2Computer(computer: Pick<ComputerConfig, "kind">, settings: { sandbox?: unknown } | undefined): boolean {
  if (computer.kind !== "daytona") return false;
  const providers = (settings?.sandbox as { providers?: Record<string, Record<string, unknown> | undefined> } | undefined)?.providers;
  return daytonaApiVersion(providers?.daytona) === "v2";
}

/** Why Daytona v2 cannot take an allowlist's IP addresses and ranges (seen live: its VMs reach none of them). */
export const DAYTONA_V2_DOMAINS_ONLY = "Daytona v2 applies domain rules only; use host names";

/**
 * Why a computer's network rule cannot work on its provider (null: it can), checked with the same
 * rules its machine is created with, so a bad entry is refused when it is saved and not when the
 * computer next starts. Daytona v2 also refuses IP addresses and ranges: its VMs do not enforce them.
 */
export function computerNetworkProblem(computer: ComputerConfig, settings: { sandbox?: unknown } | undefined): string | null {
  if (computer.kind !== "daytona" && computer.kind !== "e2b") return null;
  const s = computerSandbox(computer, settings);
  const network = "error" in s ? computer.network : s.network;
  if (!network || network.mode !== "allowlist") return null;
  try {
    if (computer.kind === "e2b") {
      e2bNetworkOpts(network);
    } else if (isDaytonaV2Computer(computer, settings)) {
      const entries = classifyAllowEntries(network.allow);
      const invalid = entries.filter((e) => e.kind === "invalid");
      if (invalid.length) return `Network allowlist of computer "${computer.id}": not a host name: ${invalid.map((e) => `"${e.raw}"`).join(", ")}`;
      const addresses = entries.filter((e) => e.kind !== "domain");
      if (addresses.length) {
        return `Network allowlist of computer "${computer.id}": ${DAYTONA_V2_DOMAINS_ONLY} (${addresses.map((e) => e.raw).join(", ")} would not be reachable from its VM)`;
      }
      daytonaV2NetworkPolicy(network);
    } else {
      daytonaNetworkParams(network);
    }
  } catch (err) {
    if (err instanceof SandboxNetworkConfigError) return `Computer "${computer.id}": ${err.message}`;
    throw err;
  }
  return null;
}

/**
 * When a change to a computer's image, size or network reaches its machine, said for its provider:
 * Daytona v2 applies a new network rule when the VM next starts or wakes (stop and start it to
 * apply it now); the rest (and everything elsewhere) needs a new machine (a reset loses the disk).
 */
export function computerChangeNote(computer: ComputerConfig, changed: string[], settings: { sandbox?: unknown } | undefined): string | undefined {
  if (!changed.length) return undefined;
  const atWake: string[] = isDaytonaV2Computer(computer, settings) ? changed.filter((k) => k === "network") : [];
  const atReset = changed.filter((k) => !atWake.includes(k));
  const parts: string[] = [];
  if (atWake.length) parts.push("the network rule applies when it next starts or wakes (stop and start it to apply it now; no reset needed)");
  if (atReset.length) parts.push(`${atReset.join(", ")} apply to a new machine: reset the computer to use them (its disk is lost)`);
  return parts.join("; ");
}
