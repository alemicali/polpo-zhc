/**
 * "docker" workspace (also podman): each command runs in a fresh, throwaway container that sees
 * the same host paths as the bubblewrap jail does (working directory read-write at its own
 * absolute path, granted directories and storage mounts with their read-only flags, the
 * project's .polpo hidden), on a read-only root filesystem, as the server's own user.
 */
import { existsSync, mkdirSync, statSync, accessSync, constants } from "node:fs";
import { delimiter, join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { nanoid } from "nanoid";
import type { ExecOptions, ExecResult } from "@polpo-ai/core/sandbox";
import { startNetworkProxy, type NetworkProxy } from "./net-proxy.js";
import { HostFsWorkspace, insideAny, networkBridge, run, type HostWorkspaceOptions } from "./workspaces.js";

export const DEFAULT_DOCKER_IMAGE = "node:22-bookworm-slim";

/** The container CLI on PATH ("docker" first, then "podman"), or undefined. */
export function containerBinary(pathEnv: string | undefined = process.env.PATH): string | undefined {
  for (const name of ["docker", "podman"]) {
    for (const dir of (pathEnv ?? "").split(delimiter).filter(Boolean)) {
      const full = join(dir, name);
      try { if (statSync(full).isFile()) { accessSync(full, constants.X_OK); return full; } } catch { /* next */ }
    }
  }
  return undefined;
}

export function dockerAvailable(): boolean {
  return containerBinary() !== undefined;
}

export class DockerWorkspace extends HostFsWorkspace {
  readonly provider = "docker" as const;
  private proxy?: NetworkProxy;
  private proxyStarting?: Promise<NetworkProxy>;
  private readonly bridgePort = 3128;

  /** `binary` and `user` are injectable for tests. */
  constructor(opts: HostWorkspaceOptions, private readonly binary: string | undefined = containerBinary(),
    private readonly user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`) {
    super(opts);
    for (const dir of [this.root, ...(opts.writable ?? [])]) if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  private async networkProxy(): Promise<NetworkProxy> {
    this.proxyStarting ??= startNetworkProxy(this.opts.sandbox.network.allow ?? [], this.opts.onNetworkDenied).then((p) => (this.proxy = p));
    return this.proxyStarting;
  }

  /** The `docker run` command line for one command (exported for tests). */
  async argv(command: string, opts: ExecOptions = {}, name = `polpo-${nanoid(10)}`): Promise<string[]> {
    if (!this.binary) throw new Error("Neither docker nor podman was found on PATH");
    const { network, resources, providerOptions } = this.opts.sandbox;
    const image = typeof providerOptions.image === "string" && providerOptions.image ? providerOptions.image : DEFAULT_DOCKER_IMAGE;
    const podman = this.binary.endsWith("podman");
    const args: string[] = [this.binary, "run", "--rm", "--init", "--name", name, "--user", this.user];
    if (podman) args.push("--userns=keep-id");
    args.push("--read-only", "--tmpfs", "/tmp:rw,exec,mode=1777", "--cap-drop", "ALL", "--security-opt", "no-new-privileges");
    if (network.mode !== "open") args.push("--network", "none");
    if (resources.memoryMb) args.push("--memory", `${resources.memoryMb}m`, "--memory-swap", `${resources.memoryMb}m`);
    if (resources.cpus) args.push("--cpus", String(resources.cpus));

    // same view as the bubblewrap jail: parents before children, hidden directories masked
    // before the paths granted inside them are bound again
    type Op = { path: string; kind: "rw" | "ro" | "hide" };
    const binds: Op[] = [{ path: this.root, kind: "rw" }];
    for (const p of this.paths) if (existsSync(p.path)) binds.push({ path: p.path, kind: p.readOnly ? "ro" : "rw" });
    const bound = binds.map((b) => b.path);
    const hides: Op[] = (this.opts.hide ?? []).map((h) => resolve(h))
      .filter((h) => existsSync(h) && bound.some((b) => h !== b && insideAny(h, [b])))
      .map((path) => ({ path, kind: "hide" }));
    const depth = (p: string) => p.split(sep).length;
    const ops = [...binds, ...hides].sort((a, b) => depth(a.path) - depth(b.path) || (a.kind === "hide" ? -1 : b.kind === "hide" ? 1 : 0));
    for (const op of ops) {
      if (/[:,]/.test(op.path)) throw new Error(`Path not supported in a container mount: ${op.path}`);
      if (op.kind === "hide") args.push("--tmpfs", op.path);
      else args.push("-v", `${op.path}:${op.path}${op.kind === "ro" ? ":ro" : ""}`);
    }

    const env: Record<string, string> = {
      HOME: this.root, USER: process.env.USER ?? "agent", LANG: process.env.LANG ?? "C.UTF-8", TERM: "dumb", TMPDIR: "/tmp",
    };
    let script = command;
    if (network.mode === "allowlist") {
      const proxy = await this.networkProxy();
      args.push("-v", `${proxy.dir}:/run/polpo-net:ro`);
      const bridge = networkBridge(command, this.bridgePort, "node");
      Object.assign(env, bridge.env);
      script = bridge.script;
    }
    for (const [key, value] of Object.entries({ ...env, ...(opts.env ?? {}) })) args.push("-e", `${key}=${value}`);
    args.push("--workdir", opts.cwd ?? this.root, image, "/bin/bash", "-c", script);
    return args;
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const name = `polpo-${nanoid(10)}`;
    const argv = await this.argv(command, opts, name);
    // the container gets its environment from -e; the CLI itself needs PATH and its config location
    const launcherEnv: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
    for (const key of ["HOME", "XDG_RUNTIME_DIR", "DOCKER_HOST", "DOCKER_CONFIG", "CONTAINER_HOST"]) if (process.env[key]) launcherEnv[key] = process.env[key]!;
    const timeoutMs = opts.timeoutMs ?? (this.opts.sandbox.resources.timeoutMin ? this.opts.sandbox.resources.timeoutMin * 60_000 : undefined);
    const result = await run(argv, { ...opts, env: launcherEnv, timeoutMs });
    // killing the CLI leaves the container running: remove it explicitly after a timeout or abort
    if (result.timedOut || opts.signal?.aborted) {
      await new Promise<void>((done) => {
        const rm = spawn(this.binary!, ["rm", "-f", name], { stdio: "ignore", env: launcherEnv });
        rm.on("error", () => done());
        rm.on("close", () => done());
      });
    }
    return result;
  }

  async dispose(): Promise<void> {
    await this.proxy?.close().catch(() => undefined);
    this.proxy = undefined;
    this.proxyStarting = undefined;
  }
}
