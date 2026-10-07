/**
 * Creates the workspace an agent's tools run in, from the settings cascade
 * (instance → agent → mission → task), and adapts it to the Shell the tools already use.
 */
import type { Shell, ShellOptions, ShellResult } from "@polpo-ai/core/shell";
import {
  resolveSandbox,
  type EffectiveSandbox,
  type SandboxCascade,
  type SandboxProvider,
  type SandboxSettings,
  type StorageMountSpec,
  type Workspace,
} from "@polpo-ai/core/sandbox";
import type { NetworkDenial } from "./net-proxy.js";
import { bashSafeEnv } from "../tools/safe-env.js";
import { DockerWorkspace, dockerAvailable } from "./docker.js";
import { BwrapWorkspace, LocalWorkspace, bwrapAvailable, type HostWorkspaceOptions } from "./workspaces.js";
import { configuredRemoteProviders } from "./remote-providers.js";
import { createRemoteWorkspace, type RemoteWorkspaceOptions } from "./remote.js";

/** Providers this machine can run right now. */
export function availableProviders(): Set<SandboxProvider> {
  const out = new Set<SandboxProvider>(["local"]);
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
  mounts?: StorageMountSpec[];
  hide?: string[];
  onNetworkDenied?: (denial: NetworkDenial) => void;
  /** Remote sandboxes: VM ready, files synced, problems. */
  onRemoteEvent?: RemoteWorkspaceOptions["onEvent"];
}

/** Resolve the cascade for a request on this machine. */
export function effectiveSandbox(req: Pick<WorkspaceRequest, "scope" | "cascade" | "agentTools">): EffectiveSandbox {
  return resolveSandbox(req.cascade, { scope: req.scope, agentTools: req.agentTools, available: availableProviders() });
}

/** Create the workspace for an already resolved sandbox. Remote providers come with their adapters. */
export function createWorkspace(sandbox: EffectiveSandbox, req: Omit<WorkspaceRequest, "scope" | "cascade" | "agentTools">): Workspace {
  const opts: HostWorkspaceOptions = {
    root: req.root, writable: req.writable, readable: req.readable, mounts: req.mounts, hide: req.hide, sandbox, onNetworkDenied: req.onNetworkDenied,
  };
  if (sandbox.provider === "local") return new LocalWorkspace(opts, bashSafeEnv);
  if (sandbox.provider === "bwrap") return new BwrapWorkspace(opts);
  if (sandbox.provider === "docker" && dockerAvailable()) return new DockerWorkspace(opts);
  if ((sandbox.provider === "daytona" || sandbox.provider === "e2b") && configuredRemoteProviders().includes(sandbox.provider)) {
    return createRemoteWorkspace(sandbox.provider, {
      root: req.root, writable: req.writable, readable: req.readable, mounts: req.mounts, sandbox, onEvent: req.onRemoteEvent,
    });
  }
  // a provider that is not available here: never fall back to weaker isolation silently
  if (bwrapAvailable()) return new BwrapWorkspace({ ...opts, sandbox: { ...sandbox, provider: "bwrap" } });
  throw new Error(`Sandbox provider "${sandbox.provider}" is not available on this server`);
}

/** The Shell the system tools use (bash, grep, glob), running inside a workspace. */
export class WorkspaceShell implements Shell {
  constructor(private readonly workspace: Workspace) {}
  async execute(command: string, options: ShellOptions = {}): Promise<ShellResult> {
    const result = await this.workspace.exec(command, { cwd: options.cwd, env: options.env, timeoutMs: options.timeout });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }
}

export { normalizeSandboxSettings } from "@polpo-ai/core/sandbox";

/** Remote workspaces keep files in the VM: file tools must go through the workspace. */
export function isRemoteWorkspace(workspace: Workspace | undefined): boolean {
  return workspace?.provider === "daytona" || workspace?.provider === "e2b";
}
