/**
 * Remote workspaces (Daytona, E2B): a task's commands and file tools run in a VM elsewhere.
 *
 * The VM is created on first use, at the same absolute paths as on this server, so the agent's
 * paths need no translation. Context goes over once (the working directory as a tarball, without
 * node_modules, .polpo and whatever .gitignore excludes — secrets in .env stay here), and the
 * files changed in the VM come back when the workspace is disposed. Storage mounts are mounted in
 * the VM with rclone, using the limited keys the storage feature hands out for remote targets.
 *
 * Lifecycle (the "lease"): the VM is acquired on the first tool call — from the pool (a VM the
 * same agent used before, its working directory reset), from the warm VMs, or created — and can
 * be suspended while no tool runs (the model is thinking) and resumed on the next call. At the
 * end it goes back to the pool suspended or is deleted, as the sandbox lifecycle says. Running
 * time is measured (the billable part).
 *
 * The provider-specific part is in remote-adapters.ts; everything else is built on exec.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { nanoid } from "nanoid";
import {
  DEFAULT_LIFECYCLE,
  type EffectiveSandbox, type ExecOptions, type ExecResult, type RemoteSandboxProvider, type StorageMountSpec, type Workspace, type WorkspaceEntry, type WorkspaceFileStat,
} from "@polpo-ai/core/sandbox";
import { remoteAdapter, type RemoteAdapter, type RemoteDriver } from "./remote-adapters.js";
import { SandboxPool, instanceLabel, poolFilePath, poolKey } from "./pool.js";

export type { RemoteDriver } from "./remote-adapters.js";

/** Context larger than this is refused rather than uploaded slowly (compressed bytes). */
const MAX_CONTEXT_BYTES = 300 * 1024 * 1024;
const CONTEXT_EXCLUDES = ["node_modules", ".polpo", ".venv", "__pycache__", ".next", ".turbo", "dist/.cache"];
const DEFAULT_TIMEOUT_MIN = 60;
/** Kept across reuse: installed dependencies are the point of reusing a VM. */
const KEEP_ON_RESET = ["node_modules", ".venv"];

export type RemoteWorkspaceEvent =
  | { kind: "ready"; message: string; durationMs: number; steps: Record<string, number>; remoteId: string; source: "created" | "pool" | "warm" }
  | { kind: "synced"; message: string; durationMs: number }
  | { kind: "warning"; message: string }
  | { kind: "suspended"; remoteId: string; idleMs: number }
  | { kind: "resumed"; remoteId: string; durationMs: number }
  | { kind: "released"; remoteId: string; outcome: "pooled" | "destroyed"; runningMs: number; durationMs: number };

export interface RemoteWorkspaceOptions {
  root: string;
  writable?: string[];
  readable?: string[];
  mounts?: StorageMountSpec[];
  sandbox: EffectiveSandbox;
  /** Progress and problems (VM ready, sync done, suspended, mount failed…). */
  onEvent?: (event: RemoteWorkspaceEvent) => void;
  /** The project's pool (reuse, warm VMs, orphan recovery). Without it the VM is created and deleted. */
  pool?: { polpoDir: string; owner: string; scope: "task" | "chat"; runId?: string; sessionKey?: string };
  /** Chats: bring changed files back after every command, not only at the end. */
  syncEachExec?: boolean;
  /** Provider adapter (tests inject one). */
  adapter?: RemoteAdapter;
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

export class RemoteWorkspace implements Workspace {
  readonly id = `ws-${nanoid(10)}`;
  readonly root: string;
  readonly paths: Array<{ path: string; readOnly: boolean }>;
  private driver?: RemoteDriver;
  private starting?: Promise<RemoteDriver>;
  private disposed = false;
  private marker = `/tmp/.polpo-context-${nanoid(8)}`;
  private readonly lifecycle;
  private readonly pool?: SandboxPool;
  private readonly adapter: RemoteAdapter;
  // lease: in-flight operations, idle suspend, running time
  private inFlight = 0;
  private suspended = false;
  private resuming?: Promise<void>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private idleSince = 0;
  private runningSince = 0;
  private runningMs = 0;
  private acquiredAt = 0;

  constructor(readonly provider: RemoteSandboxProvider, protected readonly opts: RemoteWorkspaceOptions) {
    this.root = resolve(opts.root);
    this.paths = [
      ...(opts.writable ?? []).map((path) => ({ path: resolve(path), readOnly: false })),
      ...(opts.readable ?? []).map((path) => ({ path: resolve(path), readOnly: true })),
      ...(opts.mounts ?? []).filter((m) => m.remote).map((m) => ({ path: m.path, readOnly: m.readOnly })),
    ];
    this.lifecycle = { ...DEFAULT_LIFECYCLE, ...(opts.sandbox.lifecycle ?? {}) };
    this.pool = opts.pool ? new SandboxPool(poolFilePath(opts.pool.polpoDir)) : undefined;
    this.adapter = opts.adapter ?? remoteAdapter(provider);
  }

  /** Time the VM actually ran (acquired and not suspended), so far. */
  get runningTimeMs(): number {
    return this.runningMs + (this.driver && !this.suspended && this.runningSince ? Date.now() - this.runningSince : 0);
  }

  /** The provider's id of the VM, once acquired. */
  get remoteId(): string | undefined {
    return this.driver?.remoteId;
  }

  /** The VM, acquired and filled on first use. */
  protected async vm(): Promise<RemoteDriver> {
    if (this.disposed) throw new Error("This sandbox has been closed");
    if (this.driver) return this.driver;
    this.starting ??= this.start().then((d) => (this.driver = d)).catch((err) => { this.starting = undefined; throw err; });
    return this.starting;
  }

  /** Every operation on the VM: acquire, resume if suspended, count it in flight. */
  private async op<T>(fn: (driver: RemoteDriver) => Promise<T>): Promise<T> {
    const driver = await this.vm();
    this.clearIdle();
    this.inFlight++;
    try {
      if (this.suspended) await this.resumeVm(driver);
      return await fn(driver);
    } finally {
      this.inFlight--;
      if (this.inFlight === 0) this.armIdle(driver);
    }
  }

  private armIdle(driver: RemoteDriver): void {
    const seconds = this.lifecycle.suspendAfterIdleSeconds;
    if (!seconds || this.disposed) return;
    this.idleSince = Date.now();
    this.idleTimer = setTimeout(() => { void this.suspendVm(driver); }, seconds * 1000);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private async suspendVm(driver: RemoteDriver): Promise<void> {
    if (this.inFlight > 0 || this.suspended || this.disposed) return;
    this.suspended = true;
    this.runningMs += Date.now() - this.runningSince;
    try {
      await driver.suspend();
      this.opts.onEvent?.({ kind: "suspended", remoteId: driver.remoteId, idleMs: Date.now() - this.idleSince });
    } catch (err) {
      this.suspended = false;
      this.runningSince = Date.now();
      this.opts.onEvent?.({ kind: "warning", message: `The sandbox could not be suspended: ${(err as Error).message}` });
    }
  }

  private async resumeVm(driver: RemoteDriver): Promise<void> {
    this.resuming ??= (async () => {
      const t0 = Date.now();
      await driver.resume();
      this.suspended = false;
      this.runningSince = Date.now();
      this.opts.onEvent?.({ kind: "resumed", remoteId: driver.remoteId, durationMs: Date.now() - t0 });
    })().finally(() => { this.resuming = undefined; });
    return this.resuming;
  }

  private labels(): Record<string, string> {
    const pool = this.opts.pool;
    return {
      polpo: "1",
      ...(pool ? { "polpo-instance": instanceLabel(pool.polpoDir), "polpo-agent": pool.owner || "-", "polpo-scope": pool.scope } : { "polpo-scope": "adhoc" }),
    };
  }

  /** From the pool (same agent), from the warm VMs, or new. */
  private async acquire(): Promise<{ driver: RemoteDriver; source: "created" | "pool" | "warm" }> {
    const key = poolKey(this.provider, this.opts.sandbox);
    const pool = this.pool;
    const lease = { runId: this.opts.pool?.runId, sessionKey: this.opts.pool?.sessionKey };
    if (pool && this.lifecycle.isolation === "reuse") {
      for (let attempt = 0; attempt < 2; attempt++) {
        const entry = await pool.takeIdle(this.provider, key, this.opts.pool!.owner, lease);
        if (!entry) break;
        try { return { driver: await this.adapter.connect(entry.remoteId), source: "pool" }; }
        catch { await pool.remove(entry.remoteId); await this.adapter.remove(entry.remoteId).catch(() => undefined); }
      }
    }
    if (pool) {
      const entry = await pool.takeWarm(this.provider, key, this.opts.pool!.owner, lease);
      if (entry) {
        try { return { driver: await this.adapter.connect(entry.remoteId), source: "warm" }; }
        catch { await pool.remove(entry.remoteId); await this.adapter.remove(entry.remoteId).catch(() => undefined); }
      }
    }
    const keep = !!pool && this.lifecycle.onRelease === "pool";
    const driver = await this.adapter.create({
      sandbox: this.opts.sandbox, labels: this.labels(), lifetimeMinutes: lifetimeMinutes(this.opts.sandbox),
      deleteAfterStopMinutes: this.lifecycle.deleteAfterStopMinutes, keep,
    });
    if (pool) await pool.addLeased({ remoteId: driver.remoteId, provider: this.provider, key, owner: this.opts.pool!.owner, ...lease }).catch(() => undefined);
    return { driver, source: "created" };
  }

  private async start(): Promise<RemoteDriver> {
    const t0 = Date.now();
    const { driver, source } = await this.acquire();
    const created = Date.now() - t0;
    this.acquiredAt = Date.now();
    this.runningSince = Date.now();
    try {
      // same absolute paths as here, owned by the VM's user; a reused VM is reset first
      const dirs = [this.root, ...this.paths.filter((p) => !this.isMount(p.path)).map((p) => p.path)];
      const keep = KEEP_ON_RESET.map((k) => `! -name ${q(k)}`).join(" ");
      const reset = source === "created" ? "" : `find "$d" -mindepth 1 -maxdepth 1 ${keep} -exec rm -rf {} + 2>/dev/null; `;
      const mk = await driver.exec(`for d in ${dirs.map(q).join(" ")}; do mkdir -p "$d" 2>/dev/null || { sudo mkdir -p "$d" && sudo chown "$(id -u):$(id -g)" "$d"; }; ${reset}done`, {});
      if (mk.exitCode !== 0) throw new Error(`Could not prepare the working directory: ${(mk.stderr || mk.stdout).trim().slice(0, 300)}`);

      const t1 = Date.now();
      let uploaded = 0;
      for (const dir of dirs) {
        if (!existsSync(dir)) continue;
        uploaded += await this.uploadTree(driver, dir);
      }
      await driver.exec(`touch ${q(this.marker)}`, {});
      const synced = Date.now() - t1;

      const t2 = Date.now();
      await this.mountStorage(driver);
      const mounted = Date.now() - t2;

      this.opts.onEvent?.({
        kind: "ready", remoteId: driver.remoteId, source,
        message: `${this.provider} sandbox ${driver.remoteId} ready (${source === "created" ? "new" : source === "pool" ? "reused" : "warm"}, ${Math.round(uploaded / 1024)} KB of context)`,
        durationMs: Date.now() - t0, steps: { acquireMs: created, syncMs: synced, mountMs: mounted },
      });
      return driver;
    } catch (err) {
      await driver.destroy().catch(() => undefined);
      await this.pool?.remove(driver.remoteId).catch(() => undefined);
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
    return this.op(async (driver) => {
      const t0 = Date.now();
      const timeoutMs = opts.timeoutMs ?? (this.opts.sandbox.resources.timeoutMin ? this.opts.sandbox.resources.timeoutMin * 60_000 : undefined);
      const script = opts.stdin !== undefined ? `printf %s ${q(opts.stdin)} | (${command})` : command;
      const r = await driver.exec(script, { cwd: opts.cwd ?? this.root, env: opts.env, timeoutMs });
      if (r.stdout) opts.onOutput?.(r.stdout);
      if (this.opts.syncEachExec) await this.syncBackSafely(driver);
      return { exitCode: r.timedOut ? 124 : r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut, durationMs: Date.now() - t0 };
    });
  }

  async readFile(path: string): Promise<Uint8Array> {
    return this.op((driver) => driver.readFile(path));
  }

  async writeFile(path: string, data: Uint8Array | string, opts?: { mode?: number }): Promise<void> {
    return this.op(async (driver) => {
      const parent = path.slice(0, path.lastIndexOf("/")) || "/";
      await driver.exec(`mkdir -p ${q(parent)}`, {});
      await driver.writeFile(path, typeof data === "string" ? Buffer.from(data) : data);
      if (opts?.mode) await driver.exec(`chmod ${opts.mode.toString(8)} ${q(path)}`, {});
      if (this.opts.syncEachExec) await this.syncBackSafely(driver);
    });
  }

  async stat(path: string): Promise<WorkspaceFileStat | null> {
    const r = await this.op((driver) => driver.exec(`stat -c '%F|%s|%Y' -- ${q(path)} 2>/dev/null`, {}));
    if (r.exitCode !== 0 || !r.stdout.trim()) return null;
    const [kind, size, mtime] = r.stdout.trim().split("|");
    const type = kind === "directory" ? "dir" : kind?.includes("regular") ? "file" : kind === "symbolic link" ? "symlink" : "other";
    return { type, size: Number(size), mtimeMs: Number(mtime) * 1000 };
  }

  async list(path: string, opts?: { recursive?: boolean; maxEntries?: number }): Promise<WorkspaceEntry[]> {
    const depth = opts?.recursive ? "" : "-maxdepth 1";
    const r = await this.op((driver) => driver.exec(`find ${q(path)} -mindepth 1 ${depth} -printf '%y|%s|%p\\n' 2>/dev/null | head -n ${opts?.maxEntries ?? 10000}`, {}));
    return r.stdout.split("\n").filter(Boolean).map((line) => {
      const [y, size, ...rest] = line.split("|");
      const type = y === "d" ? "dir" : y === "f" ? "file" : y === "l" ? "symlink" : "other";
      return { path: rest.join("|"), type, size: Number(size) } as WorkspaceEntry;
    });
  }

  async mkdir(path: string): Promise<void> {
    await this.op((driver) => driver.exec(`mkdir -p ${q(path)}`, {}));
  }

  async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await this.op(async (driver) => {
      await driver.exec(`rm -f${opts?.recursive ? "r" : ""} -- ${q(path)}`, {});
    });
  }

  async upload(hostPath: string, path: string): Promise<void> {
    await this.writeFile(path, await hostRun(["cat", hostPath]));
  }

  async download(path: string, hostPath: string): Promise<void> {
    const data = await this.readFile(path);
    await hostRun(["sh", "-c", `mkdir -p "$(dirname "$1")" && cat > "$1"`, "sh", hostPath], data);
  }

  /** Copy back what changed in the VM now (chats after each command; host tools before reading). */
  async syncNow(): Promise<void> {
    if (!this.driver || this.disposed) return;
    await this.op((driver) => this.syncBackSafely(driver));
  }

  /**
   * Bring back what changed in the VM (working directory and writable paths), then return the
   * VM to the pool suspended or delete it, as the lifecycle says.
   */
  async dispose(reason?: string): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.clearIdle();
    const driver = this.driver ?? (this.starting ? await this.starting.catch(() => undefined) : undefined);
    if (!driver) return;
    try {
      if (this.suspended) await this.resumeVm(driver);
      await this.syncBack(driver);
    } catch (err) {
      this.opts.onEvent?.({ kind: "warning", message: `Files changed in the sandbox could not be copied back: ${(err as Error).message}` });
    }
    if (!this.suspended) this.runningMs += Date.now() - this.runningSince;
    let outcome: "pooled" | "destroyed" = "destroyed";
    if (this.pool && this.lifecycle.onRelease === "pool" && reason !== "error") {
      try {
        if (!this.suspended) await driver.suspend();
        await this.pool.release(driver.remoteId, this.lifecycle.deleteAfterStopMinutes);
        outcome = "pooled";
      } catch {
        outcome = "destroyed";
      }
    }
    if (outcome === "destroyed") {
      await driver.destroy().catch(() => undefined);
      await this.pool?.remove(driver.remoteId).catch(() => undefined);
    }
    this.opts.onEvent?.({ kind: "released", remoteId: driver.remoteId, outcome, runningMs: this.runningMs, durationMs: Date.now() - this.acquiredAt });
  }

  private async syncBackSafely(driver: RemoteDriver): Promise<void> {
    try {
      await this.syncBack(driver);
    } catch (err) {
      this.opts.onEvent?.({ kind: "warning", message: `Files changed in the sandbox could not be copied back: ${(err as Error).message}` });
    }
  }

  private async syncBack(driver: RemoteDriver): Promise<void> {
    const t0 = Date.now();
    const targets = [this.root, ...this.paths.filter((p) => !p.readOnly && !this.isMount(p.path)).map((p) => p.path)];
    const prune = CONTEXT_EXCLUDES.filter((e) => !e.includes("/")).map((e) => `-name ${q(e)} -prune`).join(" -o ");
    const tarPath = `/tmp/.polpo-back-${nanoid(8)}.tgz`;
    // the next sync starts from now: a fresh marker before listing
    const nextMarker = `/tmp/.polpo-context-${nanoid(8)}`;
    const find = `find ${targets.map(q).join(" ")} \\( ${prune} \\) -o -type f -newer ${q(this.marker)} -print0 2>/dev/null`;
    const r = await driver.exec(`touch ${q(nextMarker)}; ${find} | tar -czf ${q(tarPath)} --null -T - 2>/dev/null; echo ok`, { timeoutMs: 300_000 });
    if (!r.stdout.includes("ok")) throw new Error((r.stderr || r.stdout).trim().slice(0, 200));
    const tarball = await driver.readFile(tarPath);
    await driver.exec(`rm -f ${q(tarPath)} ${q(this.marker)}`, {}).catch(() => undefined);
    this.marker = nextMarker;
    if (tarball.length > MAX_CONTEXT_BYTES) throw new Error("Changed files exceed the transfer limit");
    // only entries inside the paths the agent could write
    const listed = (await hostRun(["tar", "-tzf", "-"], tarball, 64 * 1024 * 1024)).toString().split("\n").filter(Boolean);
    const allowed = targets.map((t) => t.replace(/^\/+/, ""));
    const bad = listed.find((entry) => entry.includes("..") || !allowed.some((a) => entry === a || entry.startsWith(a.endsWith("/") ? a : a + "/")));
    if (bad) throw new Error(`Refusing to copy back "${bad}": outside the writable paths`);
    if (listed.length) await hostRun(["tar", "-xzf", "-", "-C", "/", "--no-same-owner", "--no-overwrite-dir"], tarball);
    if (listed.length) this.opts.onEvent?.({ kind: "synced", message: `${listed.length} changed file(s) copied back`, durationMs: Date.now() - t0 });
  }
}

/** Remote VM lifetime: the task timeout plus a margin, so a forgotten VM stops by itself. */
export function lifetimeMinutes(sandbox: EffectiveSandbox): number {
  return (sandbox.resources.timeoutMin ?? DEFAULT_TIMEOUT_MIN) + 15;
}

export function createRemoteWorkspace(provider: RemoteSandboxProvider, opts: RemoteWorkspaceOptions): RemoteWorkspace {
  return new RemoteWorkspace(provider, opts);
}

/** True when `path` is the root or inside it. */
export function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}
