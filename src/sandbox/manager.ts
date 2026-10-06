/**
 * Creates the workspace an agent's tools run in, from the settings cascade
 * (instance → agent → mission → task), and adapts it to the Shell the tools already use.
 */
import { existsSync } from "node:fs";
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
import { bashSafeEnv } from "../tools/safe-env.js";
import { BwrapWorkspace, LocalWorkspace, bwrapAvailable, type HostWorkspaceOptions } from "./workspaces.js";

/** Providers this machine can run right now. */
export function availableProviders(): Set<SandboxProvider> {
  const out = new Set<SandboxProvider>(["local"]);
  if (bwrapAvailable()) out.add("bwrap");
  if (existsSync("/usr/bin/docker") || existsSync("/usr/bin/podman")) out.add("docker");
  // remote providers join this list with their adapters (Daytona, then E2B)
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
  onNetworkDenied?: (host: string) => void;
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
  switch (sandbox.provider) {
    case "bwrap": return new BwrapWorkspace(opts);
    case "local": return new LocalWorkspace(opts, bashSafeEnv);
    default:
      // docker, daytona and e2b adapters are not available yet: never fall back to weaker isolation silently
      if (bwrapAvailable()) return new BwrapWorkspace({ ...opts, sandbox: { ...sandbox, provider: "bwrap" } });
      throw new Error(`Sandbox provider "${sandbox.provider}" is not available on this server`);
  }
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
