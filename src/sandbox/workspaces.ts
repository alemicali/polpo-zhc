/**
 * Workspaces on this machine: "local" (commands run as the server user, as before) and "bwrap"
 * (each command runs in a fresh bubblewrap jail that sees only the working directory, the
 * allowed paths and the mounted storage, with a clean environment and the network the cascade
 * allows). Both share the host filesystem for the paths they expose, at the same absolute paths,
 * so file tools and commands see the same files.
 */
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { readFile, writeFile, mkdir, rm, copyFile, cp } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { nanoid } from "nanoid";
import type {
  EffectiveSandbox, ExecOptions, ExecResult, StorageMountSpec, Workspace, WorkspaceEntry, WorkspaceFileStat,
} from "@polpo-ai/core/sandbox";
import { startNetworkProxy, type NetworkProxy } from "./net-proxy.js";

/** Output kept in memory per stream; the bash tool offloads anything big to a file anyway. */
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;

export interface HostWorkspaceOptions {
  /** The agent's working directory (read-write). */
  root: string;
  /** Other read-write directories (task output dir…). */
  writable?: string[];
  /** Read-only directories (tool output offload dir, skills…). */
  readable?: string[];
  /** Storage mounts with a host path. */
  mounts?: StorageMountSpec[];
  sandbox: EffectiveSandbox;
  /** Called when the network proxy refuses a host. */
  onNetworkDenied?: (host: string) => void;
}

/** Shared filesystem operations: the paths the agent sees are the host's own. */
abstract class HostFsWorkspace implements Workspace {
  readonly id = `ws-${nanoid(10)}`;
  abstract readonly provider: Workspace["provider"];
  readonly root: string;
  readonly paths: Array<{ path: string; readOnly: boolean }>;

  constructor(protected readonly opts: HostWorkspaceOptions) {
    this.root = resolve(opts.root);
    this.paths = [
      ...(opts.writable ?? []).map((path) => ({ path: resolve(path), readOnly: false })),
      ...(opts.readable ?? []).map((path) => ({ path: resolve(path), readOnly: true })),
      // host mounts appear at their host path, so file tools and commands see the same files
      ...(opts.mounts ?? []).filter((m) => m.hostPath).map((m) => ({ path: resolve(m.hostPath!), readOnly: m.readOnly })),
    ];
  }

  async readFile(path: string): Promise<Uint8Array> { return readFile(path); }
  async writeFile(path: string, data: Uint8Array | string, opts?: { mode?: number }): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, opts?.mode ? { mode: opts.mode } : undefined);
  }
  async stat(path: string): Promise<WorkspaceFileStat | null> {
    try {
      const s = lstatSync(path);
      return { type: s.isFile() ? "file" : s.isDirectory() ? "dir" : s.isSymbolicLink() ? "symlink" : "other", size: s.size, mtimeMs: s.mtimeMs };
    } catch { return null; }
  }
  async list(path: string, opts?: { recursive?: boolean; maxEntries?: number }): Promise<WorkspaceEntry[]> {
    const out: WorkspaceEntry[] = [];
    const max = opts?.maxEntries ?? 10_000;
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (out.length >= max) return;
        const full = join(dir, entry.name);
        const type = entry.isFile() ? "file" : entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "symlink" : "other";
        out.push({ path: full, type, ...(type === "file" ? { size: statSync(full).size } : {}) });
        if (opts?.recursive && type === "dir") walk(full);
      }
    };
    walk(path);
    return out;
  }
  async mkdir(path: string): Promise<void> { await mkdir(path, { recursive: true }); }
  async remove(path: string, opts?: { recursive?: boolean }): Promise<void> { await rm(path, { recursive: !!opts?.recursive, force: true }); }
  async upload(hostPath: string, path: string): Promise<void> {
    if (resolve(hostPath) === resolve(path)) return;
    await mkdir(dirname(path), { recursive: true });
    if (statSync(hostPath).isDirectory()) await cp(hostPath, path, { recursive: true }); else await copyFile(hostPath, path);
  }
  async download(path: string, hostPath: string): Promise<void> { await this.upload(path, hostPath); }
  abstract exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  async dispose(): Promise<void> { /* nothing held */ }
}

/** Run argv, capture output, enforce the timeout (killing the whole process group). */
function run(argv: string[], opts: ExecOptions & { env: Record<string, string>; cwd?: string }): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolveRun) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const collect = (which: "out" | "err") => (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      opts.onOutput?.(text);
      if (which === "out") { if (stdout.length < MAX_CAPTURE_BYTES) stdout += text; }
      else if (stderr.length < MAX_CAPTURE_BYTES) stderr += text;
    };
    child.stdout.on("data", collect("out"));
    child.stderr.on("data", collect("err"));
    const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs) : undefined;
    opts.signal?.addEventListener("abort", kill, { once: true });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin); else child.stdin.end();
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolveRun({ exitCode: 127, stdout, stderr: `${stderr}${error.message}`, durationMs: Date.now() - started });
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      const exitCode = code ?? (signal ? 128 + 9 : 1);
      if (timedOut && !stderr) stderr = `Command timed out after ${opts.timeoutMs}ms`;
      resolveRun({ exitCode: timedOut && exitCode === 0 ? 124 : exitCode, stdout, stderr, ...(timedOut ? { timedOut } : {}), durationMs: Date.now() - started });
    });
  });
}

/** Commands run as the server user, with the filtered environment tools already used. */
export class LocalWorkspace extends HostFsWorkspace {
  readonly provider = "local" as const;
  constructor(opts: HostWorkspaceOptions, private readonly baseEnv: () => Record<string, string>) { super(opts); }
  exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    return run(["/bin/bash", "-c", command], { ...opts, cwd: opts.cwd ?? this.root, env: { ...this.baseEnv(), ...(opts.env ?? {}) } });
  }
}

/** System directories bound read-only into every jail (all exist on Debian/Ubuntu with usrmerge). */
const SYSTEM_RO = ["/usr", "/etc/alternatives", "/etc/ssl", "/etc/ca-certificates", "/etc/pki", "/etc/resolv.conf", "/etc/hosts",
  "/etc/nsswitch.conf", "/etc/passwd", "/etc/group", "/etc/localtime", "/etc/ld.so.cache", "/etc/ld.so.conf", "/etc/ld.so.conf.d",
  "/etc/mime.types", "/etc/gitconfig", "/opt"];
/** User-level tool directories (global npm packages, browser engines): no secrets live there. */
const DEFAULT_TOOL_DIRS = [".npm-global", ".local/bin", ".cache/ms-playwright", ".bun"];

export function bwrapAvailable(): boolean {
  return existsSync("/usr/bin/bwrap") || existsSync("/bin/bwrap");
}

export class BwrapWorkspace extends HostFsWorkspace {
  readonly provider = "bwrap" as const;
  private proxy?: NetworkProxy;
  private proxyStarting?: Promise<NetworkProxy>;
  private readonly bridgePort = 3128;

  constructor(opts: HostWorkspaceOptions) {
    super(opts);
    for (const dir of [this.root, ...(opts.writable ?? [])]) if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  private async networkProxy(): Promise<NetworkProxy> {
    this.proxyStarting ??= startNetworkProxy(this.opts.sandbox.network.allow ?? [], this.opts.onNetworkDenied).then((p) => (this.proxy = p));
    return this.proxyStarting;
  }

  /** The bwrap command line for one command (exported for tests). */
  async argv(command: string, opts: ExecOptions = {}): Promise<string[]> {
    const { network, resources, providerOptions } = this.opts.sandbox;
    const home = homedir();
    const toolDirs = ((providerOptions.toolDirs as string[] | undefined) ?? DEFAULT_TOOL_DIRS).map((d) => d.startsWith("/") ? d : join(home, d));
    const args: string[] = ["/usr/bin/bwrap", "--die-with-parent", "--new-session", "--unshare-all"];
    if (network.mode === "open") args.push("--share-net");
    args.push("--clearenv");

    // a minimal system: read-only /usr and the few /etc files programs need
    args.push("--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/sbin", "/sbin");
    if (existsSync("/usr/lib64")) args.push("--symlink", "usr/lib64", "/lib64");
    if (existsSync("/usr/lib32")) args.push("--symlink", "usr/lib32", "/lib32");
    for (const path of SYSTEM_RO) args.push("--ro-bind-try", path, path);
    for (const dir of toolDirs) args.push("--ro-bind-try", dir, dir);
    args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/run");

    // what the agent works on (same paths as on the host)
    for (const p of this.paths) {
      if (!existsSync(p.path)) continue;
      args.push(p.readOnly ? "--ro-bind" : "--bind", p.path, p.path);
    }
    args.push("--bind", this.root, this.root);

    const env: Record<string, string> = {
      PATH: [...toolDirs.filter((d) => d.endsWith("bin")), join(home, ".npm-global/bin"), "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin"].join(":"),
      HOME: this.root, USER: process.env.USER ?? "agent", LANG: process.env.LANG ?? "C.UTF-8", TERM: "dumb", TMPDIR: "/tmp",
      PLAYWRIGHT_BROWSERS_PATH: join(home, ".cache/ms-playwright"),
    };
    let script = command;
    if (network.mode === "allowlist") {
      const proxy = await this.networkProxy();
      args.push("--ro-bind", proxy.dir, "/run/polpo-net");
      const url = `http://127.0.0.1:${this.bridgePort}`;
      Object.assign(env, { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, ALL_PROXY: url,
        NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1", NODE_USE_ENV_PROXY: "1",
        npm_config_proxy: url, npm_config_https_proxy: url });
      // the bridge lives as long as the command; wait until it listens
      script = `/usr/bin/node /run/polpo-net/bridge.cjs ${this.bridgePort} /run/polpo-net/proxy.sock >/dev/null 2>&1 &
__polpo_bridge=$!; trap 'kill $__polpo_bridge 2>/dev/null' EXIT
for __i in $(seq 1 50); do (exec 3<>/dev/tcp/127.0.0.1/${this.bridgePort}) 2>/dev/null && break; sleep 0.05; done
${command}`;
    }
    // the caller's variables come last (they may, for instance, clear NO_PROXY)
    for (const [key, value] of Object.entries({ ...env, ...(opts.env ?? {}) })) args.push("--setenv", key, value);
    args.push("--chdir", opts.cwd ?? this.root, "/bin/bash", "-c", script);

    // memory and CPU limits through a transient systemd scope (cgroups), when asked
    if ((resources.memoryMb || resources.cpus) && existsSync("/usr/bin/systemd-run")) {
      const limits = ["/usr/bin/systemd-run", "--user", "--scope", "-q", "--collect"];
      if (resources.memoryMb) limits.push("-p", `MemoryMax=${resources.memoryMb}M`, "-p", "MemorySwapMax=0");
      if (resources.cpus) limits.push("-p", `CPUQuota=${Math.round(resources.cpus * 100)}%`);
      return [...limits, ...args];
    }
    return args;
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const argv = await this.argv(command, opts);
    // the jail gets its environment from --setenv; the launcher itself needs only PATH and the user's runtime dir
    const launcherEnv: Record<string, string> = { PATH: "/usr/bin:/bin" };
    for (const key of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "HOME", "USER"]) if (process.env[key]) launcherEnv[key] = process.env[key]!;
    const timeoutMs = opts.timeoutMs ?? (this.opts.sandbox.resources.timeoutMin ? this.opts.sandbox.resources.timeoutMin * 60_000 : undefined);
    return run(argv, { ...opts, env: launcherEnv, timeoutMs });
  }

  async dispose(): Promise<void> {
    await this.proxy?.close().catch(() => undefined);
    this.proxy = undefined;
    this.proxyStarting = undefined;
  }
}

/** True when `path` is inside one of `roots` (used to keep host paths inside what the jail binds). */
export function insideAny(path: string, roots: string[]): boolean {
  const p = resolve(path);
  return roots.some((root) => p === resolve(root) || p.startsWith(resolve(root) + sep));
}
