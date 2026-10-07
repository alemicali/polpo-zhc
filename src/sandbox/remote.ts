/**
 * Remote workspaces (Daytona, E2B): a task's commands and file tools run in a VM elsewhere.
 *
 * The VM is created on first use, at the same absolute paths as on this server, so the agent's
 * paths need no translation. Context goes over once (the working directory as a tarball, without
 * node_modules, .polpo and whatever .gitignore excludes — secrets in .env stay here), and the
 * files changed in the VM come back when the workspace is disposed. Storage mounts are mounted in
 * the VM with rclone, using the limited keys the storage feature hands out for remote targets.
 *
 * The provider-specific part is a small driver (create, exec, read, write, destroy); everything
 * else is built on exec.
 */
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { nanoid } from "nanoid";
import type {
  EffectiveSandbox, ExecOptions, ExecResult, StorageMountSpec, Workspace, WorkspaceEntry, WorkspaceFileStat,
} from "@polpo-ai/core/sandbox";
import { remoteProviderCredentials, type RemoteProviderId } from "./remote-providers.js";

/** Context larger than this is refused rather than uploaded slowly (compressed bytes). */
const MAX_CONTEXT_BYTES = 300 * 1024 * 1024;
const CONTEXT_EXCLUDES = ["node_modules", ".polpo", ".venv", "__pycache__", ".next", ".turbo", "dist/.cache"];
const DEFAULT_TIMEOUT_MIN = 60;
/** DNS resolvers Daytona VMs use (/etc/resolv.conf): kept reachable in allowlist mode. */
const DAYTONA_RESOLVERS = ["1.1.1.1/32", "1.0.0.1/32", "8.8.8.8/32", "100.65.160.1/32"];

export interface RemoteDriver {
  /** Run a shell command line in the VM. */
  exec(command: string, opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  destroy(): Promise<void>;
  /** Provider's id for the VM (shown in events). */
  readonly remoteId: string;
}

export interface RemoteWorkspaceOptions {
  root: string;
  writable?: string[];
  readable?: string[];
  mounts?: StorageMountSpec[];
  sandbox: EffectiveSandbox;
  /** Progress and problems (VM ready, sync done, mount failed…). */
  onEvent?: (event: { kind: "ready" | "synced" | "warning"; message: string; durationMs?: number; steps?: Record<string, number> }) => void;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Run a host command and collect its stdout as bytes. */
function hostRun(argv: string[], input?: Uint8Array, maxBytes = MAX_CONTEXT_BYTES): Promise<Buffer> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) { child.kill("SIGKILL"); reject(new Error(`More than ${Math.round(maxBytes / 1048576)} MB to transfer`)); return; }
      chunks.push(c);
    });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolveRun(Buffer.concat(chunks)) : reject(new Error(stderr.trim() || `${argv[0]} exited with ${code}`)));
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

export abstract class RemoteWorkspace implements Workspace {
  readonly id = `ws-${nanoid(10)}`;
  abstract readonly provider: "daytona" | "e2b";
  readonly root: string;
  readonly paths: Array<{ path: string; readOnly: boolean }>;
  private driver?: RemoteDriver;
  private starting?: Promise<RemoteDriver>;
  private disposed = false;
  private readonly marker = `/tmp/.polpo-context-${nanoid(8)}`;

  constructor(protected readonly opts: RemoteWorkspaceOptions) {
    this.root = resolve(opts.root);
    this.paths = [
      ...(opts.writable ?? []).map((path) => ({ path: resolve(path), readOnly: false })),
      ...(opts.readable ?? []).map((path) => ({ path: resolve(path), readOnly: true })),
      ...(opts.mounts ?? []).filter((m) => m.remote).map((m) => ({ path: m.path, readOnly: m.readOnly })),
    ];
  }

  protected abstract createDriver(): Promise<RemoteDriver>;

  /** The VM, created and filled on first use. */
  protected async vm(): Promise<RemoteDriver> {
    if (this.disposed) throw new Error("This sandbox has been closed");
    if (this.driver) return this.driver;
    this.starting ??= this.start().then((d) => (this.driver = d)).catch((err) => { this.starting = undefined; throw err; });
    return this.starting;
  }

  private async start(): Promise<RemoteDriver> {
    const t0 = Date.now();
    const driver = await this.createDriver();
    const created = Date.now() - t0;
    try {
      // same absolute paths as here, owned by the VM's user
      const dirs = [this.root, ...this.paths.filter((p) => !this.isMount(p.path)).map((p) => p.path)];
      const mk = await driver.exec(`for d in ${dirs.map(q).join(" ")}; do mkdir -p "$d" 2>/dev/null || { sudo mkdir -p "$d" && sudo chown "$(id -u):$(id -g)" "$d"; }; done`, {});
      if (mk.exitCode !== 0) throw new Error(`Could not prepare the working directory: ${(mk.stderr || mk.stdout).trim().slice(0, 300)}`);

      const t1 = Date.now();
      let uploaded = 0;
      for (const dir of [this.root, ...this.paths.filter((p) => !this.isMount(p.path)).map((p) => p.path)]) {
        if (!existsSync(dir)) continue;
        uploaded += await this.uploadTree(driver, dir);
      }
      await driver.exec(`touch ${q(this.marker)}`, {});
      const synced = Date.now() - t1;

      const t2 = Date.now();
      await this.mountStorage(driver);
      const mounted = Date.now() - t2;

      this.opts.onEvent?.({ kind: "ready", message: `${this.provider} sandbox ${driver.remoteId} ready (${Math.round(uploaded / 1024)} KB of context)`, durationMs: Date.now() - t0, steps: { createMs: created, syncMs: synced, mountMs: mounted } });
      return driver;
    } catch (err) {
      await driver.destroy().catch(() => undefined);
      throw err;
    }
  }

  private isMount(path: string): boolean {
    return (this.opts.mounts ?? []).some((m) => m.remote && m.path === path);
  }

  /** Copy a host directory into the VM at the same path (tarball, ignoring dependencies and ignored files). */
  private async uploadTree(driver: RemoteDriver, dir: string): Promise<number> {
    const excludes = CONTEXT_EXCLUDES.flatMap((e) => ["--exclude", e]);
    const tarball = await hostRun(["tar", "-czf", "-", "--exclude-vcs-ignores", ...excludes, "-C", dir, "."]);
    const remoteTar = `/tmp/.polpo-up-${nanoid(8)}.tgz`;
    await driver.writeFile(remoteTar, tarball);
    const r = await driver.exec(`tar -xzf ${q(remoteTar)} -C ${q(dir)} && rm -f ${q(remoteTar)}`, {});
    if (r.exitCode !== 0) throw new Error(`Could not unpack the context in the sandbox: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    return tarball.length;
  }

  /** Mount the granted buckets in the VM with rclone (installed on the fly when missing). */
  private async mountStorage(driver: RemoteDriver): Promise<void> {
    const mounts = (this.opts.mounts ?? []).filter((m) => m.remote);
    if (!mounts.length) return;
    if (this.opts.sandbox.network.mode === "deny") {
      this.opts.onEvent?.({ kind: "warning", message: "Storage is not mounted: the sandbox has no network" });
      return;
    }
    const install = await driver.exec("command -v rclone >/dev/null || (curl -fsSL https://rclone.org/install.sh | sudo bash) >/dev/null 2>&1; command -v rclone", { timeoutMs: 180_000 });
    if (install.exitCode !== 0) {
      this.opts.onEvent?.({ kind: "warning", message: "Storage is not mounted: rclone could not be installed in the sandbox" });
      return;
    }
    for (const m of mounts) {
      const r = m.remote!;
      const env: Record<string, string> = {
        RCLONE_CONFIG_POLPO_TYPE: "s3",
        RCLONE_CONFIG_POLPO_PROVIDER: "Other",
        RCLONE_CONFIG_POLPO_ACCESS_KEY_ID: r.credentials.accessKeyId,
        RCLONE_CONFIG_POLPO_SECRET_ACCESS_KEY: r.credentials.secretAccessKey,
        ...(r.credentials.sessionToken ? { RCLONE_CONFIG_POLPO_SESSION_TOKEN: r.credentials.sessionToken } : {}),
        ...(r.endpoint ? { RCLONE_CONFIG_POLPO_ENDPOINT: r.endpoint } : {}),
        ...(r.region ? { RCLONE_CONFIG_POLPO_REGION: r.region } : {}),
        ...(r.pathStyle ? { RCLONE_CONFIG_POLPO_FORCE_PATH_STYLE: "true" } : {}),
      };
      const source = `polpo:${r.bucket}${r.prefix ? `/${r.prefix.replace(/^\/+|\/+$/g, "")}` : ""}`;
      const flags = ["--daemon", "--vfs-cache-mode", "writes", "--dir-cache-time", "30s", ...(m.readOnly ? ["--read-only"] : [])];
      const cmd = `sudo mkdir -p ${q(m.path)} && sudo chown "$(id -u):$(id -g)" ${q(m.path)} && rclone mount ${q(source)} ${q(m.path)} ${flags.join(" ")} && sleep 1 && mountpoint -q ${q(m.path)}`;
      const res = await driver.exec(cmd, { env, timeoutMs: 60_000 });
      if (res.exitCode !== 0) {
        this.opts.onEvent?.({ kind: "warning", message: `Storage "${m.name}" could not be mounted in the sandbox: ${(res.stderr || res.stdout).trim().slice(0, 200) || "FUSE not available"}` });
      }
    }
  }

  // ── Workspace ─────────────────────────────────────────────────────────

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const driver = await this.vm();
    const t0 = Date.now();
    const timeoutMs = opts.timeoutMs ?? (this.opts.sandbox.resources.timeoutMin ? this.opts.sandbox.resources.timeoutMin * 60_000 : undefined);
    const script = opts.stdin !== undefined ? `printf %s ${q(opts.stdin)} | (${command})` : command;
    const r = await driver.exec(script, { cwd: opts.cwd ?? this.root, env: opts.env, timeoutMs });
    if (r.stdout) opts.onOutput?.(r.stdout);
    return { exitCode: r.timedOut ? 124 : r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut, durationMs: Date.now() - t0 };
  }

  async readFile(path: string): Promise<Uint8Array> {
    return (await this.vm()).readFile(path);
  }

  async writeFile(path: string, data: Uint8Array | string, opts?: { mode?: number }): Promise<void> {
    const driver = await this.vm();
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    await driver.exec(`mkdir -p ${q(parent)}`, {});
    await driver.writeFile(path, typeof data === "string" ? Buffer.from(data) : data);
    if (opts?.mode) await driver.exec(`chmod ${opts.mode.toString(8)} ${q(path)}`, {});
  }

  async stat(path: string): Promise<WorkspaceFileStat | null> {
    const r = await (await this.vm()).exec(`stat -c '%F|%s|%Y' -- ${q(path)} 2>/dev/null`, {});
    if (r.exitCode !== 0 || !r.stdout.trim()) return null;
    const [kind, size, mtime] = r.stdout.trim().split("|");
    const type = kind === "directory" ? "dir" : kind?.includes("regular") ? "file" : kind === "symbolic link" ? "symlink" : "other";
    return { type, size: Number(size), mtimeMs: Number(mtime) * 1000 };
  }

  async list(path: string, opts?: { recursive?: boolean; maxEntries?: number }): Promise<WorkspaceEntry[]> {
    const depth = opts?.recursive ? "" : "-maxdepth 1";
    const r = await (await this.vm()).exec(`find ${q(path)} -mindepth 1 ${depth} -printf '%y|%s|%p\\n' 2>/dev/null | head -n ${opts?.maxEntries ?? 10000}`, {});
    return r.stdout.split("\n").filter(Boolean).map((line) => {
      const [y, size, ...rest] = line.split("|");
      const type = y === "d" ? "dir" : y === "f" ? "file" : y === "l" ? "symlink" : "other";
      return { path: rest.join("|"), type, size: Number(size) } as WorkspaceEntry;
    });
  }

  async mkdir(path: string): Promise<void> {
    await (await this.vm()).exec(`mkdir -p ${q(path)}`, {});
  }

  async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await (await this.vm()).exec(`rm -f${opts?.recursive ? "r" : ""} -- ${q(path)}`, {});
  }

  async upload(hostPath: string, path: string): Promise<void> {
    await this.writeFile(path, await hostRun(["cat", hostPath]));
  }

  async download(path: string, hostPath: string): Promise<void> {
    const data = await this.readFile(path);
    await hostRun(["sh", "-c", `mkdir -p "$(dirname "$1")" && cat > "$1"`, "sh", hostPath], data);
  }

  /** Bring back what changed in the VM (working directory and writable paths), then destroy it. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const driver = this.driver ?? (this.starting ? await this.starting.catch(() => undefined) : undefined);
    if (!driver) return;
    try {
      await this.syncBack(driver);
    } catch (err) {
      this.opts.onEvent?.({ kind: "warning", message: `Files changed in the sandbox could not be copied back: ${(err as Error).message}` });
    } finally {
      await driver.destroy().catch(() => undefined);
    }
  }

  private async syncBack(driver: RemoteDriver): Promise<void> {
    const t0 = Date.now();
    const targets = [this.root, ...this.paths.filter((p) => !p.readOnly && !this.isMount(p.path)).map((p) => p.path)];
    const prune = CONTEXT_EXCLUDES.filter((e) => !e.includes("/")).map((e) => `-name ${q(e)} -prune`).join(" -o ");
    const tarPath = `/tmp/.polpo-back-${nanoid(8)}.tgz`;
    const find = `find ${targets.map(q).join(" ")} \\( ${prune} \\) -o -type f -newer ${q(this.marker)} -print0 2>/dev/null`;
    const r = await driver.exec(`${find} | tar -czf ${q(tarPath)} --null -T - 2>/dev/null; echo ok`, { timeoutMs: 300_000 });
    if (!r.stdout.includes("ok")) throw new Error((r.stderr || r.stdout).trim().slice(0, 200));
    const tarball = await driver.readFile(tarPath);
    if (tarball.length > MAX_CONTEXT_BYTES) throw new Error("Changed files exceed the transfer limit");
    // only entries inside the paths the agent could write
    const listed = (await hostRun(["tar", "-tzf", "-"], tarball, 64 * 1024 * 1024)).toString().split("\n").filter(Boolean);
    const allowed = targets.map((t) => t.replace(/^\/+/, ""));
    const bad = listed.find((entry) => entry.includes("..") || !allowed.some((a) => entry === a || entry.startsWith(a.endsWith("/") ? a : a + "/")));
    if (bad) throw new Error(`Refusing to copy back "${bad}": outside the writable paths`);
    if (listed.length) await hostRun(["tar", "-xzf", "-", "-C", "/", "--no-same-owner", "--no-overwrite-dir"], tarball);
    this.opts.onEvent?.({ kind: "synced", message: `${listed.length} changed file(s) copied back`, durationMs: Date.now() - t0 });
  }
}

/** Remote VM lifetime: the task timeout plus a margin, so a forgotten VM stops by itself. */
function lifetimeMinutes(sandbox: EffectiveSandbox): number {
  return (sandbox.resources.timeoutMin ?? DEFAULT_TIMEOUT_MIN) + 15;
}

/** Allowlist entries as host names (drop ports and wildcards' leading "*."). */
function allowHosts(sandbox: EffectiveSandbox): string[] {
  return (sandbox.network.allow ?? []).map((a) => a.trim().replace(/:\d+$/, "")).filter(Boolean);
}

// ── Daytona ─────────────────────────────────────────────────────────────

export class DaytonaWorkspace extends RemoteWorkspace {
  readonly provider = "daytona" as const;

  protected async createDriver(): Promise<RemoteDriver> {
    const creds = await remoteProviderCredentials("daytona");
    if (!creds?.apiKey) throw new Error("Daytona has no API key: choose its vault entry in Settings → Sandbox");
    const { Daytona } = await import("@daytonaio/sdk");
    const client = new Daytona({ apiKey: creds.apiKey, apiUrl: creds.apiUrl || undefined, target: creds.target || undefined });
    const { network } = this.opts.sandbox;
    const params: Record<string, unknown> = {
      autoStopInterval: lifetimeMinutes(this.opts.sandbox),
      ephemeral: true,
      labels: { polpo: "task" },
      ...(this.opts.sandbox.providerOptions.snapshot ? { snapshot: String(this.opts.sandbox.providerOptions.snapshot) } : {}),
    };
    if (network.mode === "deny") params.networkBlockAll = true;
    if (network.mode === "allowlist") {
      // Daytona filters by address: resolve the names now (wildcards resolve their base domain)
      const cidrs = new Set<string>();
      for (const host of allowHosts(this.opts.sandbox)) {
        const name = host.replace(/^\*\./, "");
        if (/^[\d.]+(\/\d+)?$/.test(name)) { cidrs.add(name.includes("/") ? name : `${name}/32`); continue; }
        const addrs = await lookup(name, { all: true, family: 4 }).catch(() => []);
        for (const a of addrs) cidrs.add(`${a.address}/32`);
      }
      // the VM resolves names through public resolvers: without them nothing resolves
      if (cidrs.size) for (const dns of DAYTONA_RESOLVERS) cidrs.add(dns);
      if (cidrs.size) params.networkAllowList = [...cidrs].slice(0, 50).join(",");
      else params.networkBlockAll = true;
    }
    const sandbox = await client.create(params as any, { timeout: 180 });
    return {
      remoteId: sandbox.id,
      async exec(command, opts) {
        const seconds = opts.timeoutMs ? Math.max(1, Math.ceil(opts.timeoutMs / 1000)) : undefined;
        try {
          const r = await sandbox.process.executeCommand(`bash -c ${q(command)}`, opts.cwd, opts.env, seconds);
          return { exitCode: r.exitCode, stdout: r.result ?? "", stderr: "" };
        } catch (err) {
          const message = (err as Error).message ?? String(err);
          if (/timeout|timed out/i.test(message)) return { exitCode: 124, stdout: "", stderr: message, timedOut: true };
          throw err;
        }
      },
      readFile: async (path) => new Uint8Array(await sandbox.fs.downloadFile(path)),
      writeFile: async (path, data) => { await sandbox.fs.uploadFile(Buffer.from(data), path); },
      destroy: async () => { await sandbox.delete(); },
    };
  }
}

// ── E2B ─────────────────────────────────────────────────────────────────

export class E2BWorkspace extends RemoteWorkspace {
  readonly provider = "e2b" as const;

  protected async createDriver(): Promise<RemoteDriver> {
    const creds = await remoteProviderCredentials("e2b");
    if (!creds?.apiKey) throw new Error("E2B has no API key: choose its vault entry in Settings → Sandbox");
    const { Sandbox, CommandExitError } = await import("e2b");
    const { network } = this.opts.sandbox;
    const opts: Record<string, unknown> = {
      apiKey: creds.apiKey,
      ...(creds.domain ? { domain: creds.domain } : {}),
      timeoutMs: lifetimeMinutes(this.opts.sandbox) * 60_000,
      metadata: { polpo: "task" },
    };
    if (network.mode === "deny") opts.allowInternetAccess = false;
    if (network.mode === "allowlist") opts.network = { allowOut: allowHosts(this.opts.sandbox), denyOut: ["0.0.0.0/0"] };
    const template = (this.opts.sandbox.providerOptions.template as string | undefined) || creds.template || undefined;
    const sbx = template ? await Sandbox.create(template, opts as any) : await Sandbox.create(opts as any);
    return {
      remoteId: sbx.sandboxId,
      async exec(command, o) {
        try {
          const r = await sbx.commands.run(command, { cwd: o.cwd, envs: o.env, timeoutMs: o.timeoutMs ?? 0 });
          return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
        } catch (err) {
          if (err instanceof CommandExitError) return { exitCode: err.exitCode, stdout: err.stdout, stderr: err.stderr };
          const message = (err as Error).message ?? String(err);
          if (/timeout|deadline/i.test(message)) return { exitCode: 124, stdout: "", stderr: message, timedOut: true };
          throw err;
        }
      },
      readFile: async (path) => new Uint8Array(await sbx.files.read(path, { format: "bytes" })),
      writeFile: async (path, data) => { await sbx.files.write(path, new Blob([new Uint8Array(data)])); },
      destroy: async () => { await sbx.kill(); },
    };
  }
}

export function createRemoteWorkspace(provider: RemoteProviderId, opts: RemoteWorkspaceOptions): RemoteWorkspace {
  return provider === "daytona" ? new DaytonaWorkspace(opts) : new E2BWorkspace(opts);
}

/** True when `path` is the root or inside it. */
export function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}
