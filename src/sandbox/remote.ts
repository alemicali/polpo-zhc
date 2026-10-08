/**
 * Remote workspaces (Daytona, E2B): a run's commands and file tools run in a VM elsewhere, the
 * agent's brain stays here (open Polpo's proxy model).
 *
 * Files (open Polpo semantics): the VM's working directory is the sandbox's own scratch space —
 * it starts empty and is not copied back. Deliverables go to the task's output directory (copied
 * back at the end, or after every command in Cowork chats). Persistent files live on volumes:
 * buckets selected by name (sandbox.volumes), "mounted" live in the VM (rclone or mountpoint-s3)
 * or "hydrated" (copied in at start, written back at the end or on sandbox_volume_checkpoint,
 * guarded by the volume's revision so concurrent writers produce a conflict, not a loss).
 *
 * Lifecycle (the "lease"): the VM is acquired on the first tool call according to isolation —
 * "reuse" a VM this agent released, "fresh" a clean one (a warm one when available), "shared"
 * the project-scoped VM concurrent runs use together. Where suspending is cheap (E2B) it is
 * suspended while no tool runs and resumed on the next call. On release it goes back to the pool
 * (running until stopAfterIdleMinutes, then stopped, deleted deleteAfterStopMinutes later) or is
 * destroyed. Running time is measured (the billable part).
 *
 * The provider-specific part is in remote-adapters.ts; everything else is built on exec.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { nanoid } from "nanoid";
import {
  DEFAULT_ISOLATION, VOLUME_REVISION_OBJECT, effectiveLifecycle,
  type EffectiveSandbox, type ResolvedSandboxVolume, type SandboxIsolation, type SandboxLifecycleSettings, type ExecOptions, type ExecResult, type RemoteSandboxProvider, type StorageMountSpec, type Workspace, type WorkspaceEntry, type WorkspaceFileStat,
} from "@polpo-ai/core/sandbox";
import type { FileSystem, SandboxLifecycle, SandboxLifecycleInfo, SandboxProvider, SandboxSession, SandboxUsage, Shell } from "@polpo-ai/core";
import { remoteAdapter, type RemoteAdapter, type RemoteDriver } from "./remote-adapters.js";
import { SandboxLease, DEFAULT_IDLE_SUSPEND_MS } from "./lease.js";
import { ShellBackedFileSystem } from "./shell-backed-fs.js";
import { SandboxPool, instanceLabel, poolFilePath, poolKey } from "./pool.js";

export type { RemoteDriver } from "./remote-adapters.js";

/** Context larger than this is refused rather than uploaded slowly (compressed bytes). */
const MAX_CONTEXT_BYTES = 300 * 1024 * 1024;
const CONTEXT_EXCLUDES = ["node_modules", ".polpo", ".venv", "__pycache__", ".next", ".turbo", "dist/.cache"];
const DEFAULT_TIMEOUT_MIN = 60;
/** Kept across reuse: installed dependencies are the point of reusing a VM. */
const KEEP_ON_RESET = ["node_modules", ".venv"];
export { DEFAULT_IDLE_SUSPEND_MS } from "./lease.js";

export type RemoteWorkspaceEvent =
  | { kind: "ready"; message: string; durationMs: number; steps: Record<string, number>; remoteId: string; source: "created" | "pool" | "warm" | "shared" }
  | { kind: "synced"; message: string; durationMs: number }
  | { kind: "warning"; message: string }
  | { kind: "suspended"; remoteId: string; idleMs: number }
  | { kind: "resumed"; remoteId: string; durationMs: number }
  | { kind: "released"; remoteId: string; outcome: "pooled" | "destroyed" | "shared"; runningMs: number; durationMs: number }
  | { kind: "volume"; step: "prepared" | "checkpointed" | "finalized" | "conflict"; name: string; revision?: number; message?: string };

export interface RemoteWorkspaceOptions {
  root: string;
  writable?: string[];
  readable?: string[];
  /** Selected volumes resolved by the host (only those with a remote bucket and keys are used). */
  volumes?: ResolvedSandboxVolume[];
  sandbox: EffectiveSandbox;
  /** Suspend after this long without tools (default: 1.5 s where suspending is cheap, else never). */
  idleSuspendMs?: number;
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

/**
 * One run's VM as an open Polpo SandboxSession: acquired and prepared by RemoteVmProvider.open,
 * driven by Polpo's SandboxLease (lazy acquire, idle suspend, metering) through RemoteWorkspace.
 */
export class RemoteVmSession implements SandboxSession {
  readonly fs: FileSystem;
  readonly shell: Shell;
  readonly lifecycle?: SandboxLifecycle;
  /** Why the run ends ("error" → destroyed rather than pooled). */
  releaseReason?: string;
  private driver!: RemoteDriver;
  private source: "created" | "pool" | "warm" | "shared" = "created";
  private releaseOutcome?: "pooled" | "destroyed" | "shared";
  private marker = `/tmp/.polpo-context-${nanoid(8)}`;
  private shared = false;
  /** Hydrated volumes: the revision each was copied at. */
  private readonly volumeBase = new Map<string, number>();
  private acquiredAt = 0;
  private suspendedAt = 0;

  constructor(private readonly vm: RemoteVmProvider, readonly runId: string) {
    this.shell = {
      execute: async (command, opts = {}) => {
        const r = await this.driver.exec(command, { cwd: opts.cwd ?? this.vm.root, env: opts.env, timeoutMs: opts.timeout ?? this.vm.defaultTimeoutMs });
        if (this.vm.opts.syncEachExec) await this.syncBackSafely();
        return { exitCode: r.timedOut ? 124 : r.exitCode, stdout: r.stdout, stderr: r.stderr };
      },
      isRemote: async () => true,
    };
    // open Polpo's shell-backed FileSystem, with the provider's native transfer for file contents
    const shellFs = new ShellBackedFileSystem(this.shell);
    const native = {
      readFileBuffer: (path: string) => this.driver.readFile(path),
      readFile: async (path: string) => Buffer.from(await this.driver.readFile(path)).toString("utf8"),
      writeFileBuffer: async (path: string, data: Uint8Array) => { await this.driver.writeFile(path, data); if (this.vm.opts.syncEachExec) await this.syncBackSafely(); },
      writeFile: async (path: string, content: string) => { await this.driver.writeFile(path, Buffer.from(content)); if (this.vm.opts.syncEachExec) await this.syncBackSafely(); },
    };
    this.fs = Object.assign(Object.create(shellFs) as FileSystem, native);
    // suspending between tools only where it is cheap (E2B pause/resume); a shared VM never
    if (this.vm.idleSuspendMs > 0) {
      this.lifecycle = {
        suspend: async () => {
          if (this.shared) return;
          await this.driver.suspend();
          this.suspendedAt = Date.now();
          this.vm.emit({ kind: "suspended", remoteId: this.driver.remoteId, idleMs: this.vm.idleSuspendMs });
        },
        resume: async () => {
          if (!this.suspendedAt) return;
          const t0 = Date.now();
          await this.driver.resume();
          this.suspendedAt = 0;
          this.vm.emit({ kind: "resumed", remoteId: this.driver.remoteId, durationMs: Date.now() - t0 });
        },
      };
    }
  }

  get remoteId(): string {
    return this.driver.remoteId;
  }

  usage(): SandboxUsage {
    return { runId: this.runId, acquired: true, sandboxMs: 0, sandboxId: this.driver?.remoteId };
  }

  lifecycleInfo(): SandboxLifecycleInfo {
    return {
      acquisitionSource: this.source === "warm" ? "pool" : this.source,
      ...(this.releaseOutcome ? { releaseOutcome: this.releaseOutcome === "shared" ? "pooled" : this.releaseOutcome } : {}),
    };
  }

  get outcome(): "pooled" | "destroyed" | "shared" | undefined {
    return this.releaseOutcome;
  }

  get durationMs(): number {
    return this.acquiredAt ? Date.now() - this.acquiredAt : 0;
  }

  private labels(): Record<string, string> {
    const pool = this.vm.opts.pool;
    return {
      polpo: "1",
      ...(pool ? { "polpo-instance": instanceLabel(pool.polpoDir), "polpo-agent": pool.owner || "-", "polpo-scope": pool.scope } : { "polpo-scope": "adhoc" }),
    };
  }

  /** By isolation: the shared VM, a VM this agent released (reuse), a warm VM, or a new one. */
  private async acquire(): Promise<{ driver: RemoteDriver; source: "created" | "pool" | "warm" | "shared" }> {
    const key = poolKey(this.vm.provider, this.vm.opts.sandbox);
    const pool = this.vm.pool;
    const lease = { runId: this.vm.opts.pool?.runId, sessionKey: this.vm.opts.pool?.sessionKey };
    const discard = async (remoteId: string) => { await pool?.remove(remoteId); await this.vm.adapter.remove(remoteId).catch(() => undefined); };
    if (pool && this.vm.isolation === "shared") {
      const entry = await pool.takeShared(this.vm.provider, key, { ...lease, holderId: this.vm.workspaceId });
      if (entry) {
        try { this.shared = true; return { driver: await this.vm.adapter.connect(entry.remoteId), source: "shared" }; }
        catch { this.shared = false; await discard(entry.remoteId); }
      }
    }
    if (pool && this.vm.isolation === "reuse") {
      for (let attempt = 0; attempt < 2; attempt++) {
        const entry = await pool.takeIdle(this.vm.provider, key, this.vm.opts.pool!.owner, lease);
        if (!entry) break;
        try { return { driver: await this.vm.adapter.connect(entry.remoteId), source: "pool" }; }
        catch { await discard(entry.remoteId); }
      }
    }
    if (pool && this.vm.isolation !== "shared") {
      const entry = await pool.takeWarm(this.vm.provider, key, this.vm.opts.pool!.owner, lease);
      if (entry) {
        try { return { driver: await this.vm.adapter.connect(entry.remoteId), source: "warm" }; }
        catch { await discard(entry.remoteId); }
      }
    }
    const keep = !!pool && (this.vm.releaseTimes.onRelease === "pool" || this.vm.isolation === "shared");
    const driver = await this.vm.adapter.create({
      sandbox: this.vm.opts.sandbox, labels: this.labels(), lifetimeMinutes: lifetimeMinutes(this.vm.opts.sandbox),
      deleteAfterStopMinutes: this.vm.releaseTimes.deleteAfterStopMinutes, keep,
    });
    if (pool && this.vm.isolation === "shared") {
      this.shared = true;
      await pool.addShared({ remoteId: driver.remoteId, provider: this.vm.provider, key }, { ...lease, holderId: this.vm.workspaceId }).catch(() => undefined);
    } else if (pool) {
      await pool.addLeased({ remoteId: driver.remoteId, provider: this.vm.provider, key, owner: this.vm.opts.pool!.owner, ...lease }).catch(() => undefined);
    }
    return { driver, source: "created" };
  }

  /** Acquire (by isolation) and prepare the VM: empty working directory, context, volumes. */
  async start(): Promise<void> {
    const t0 = Date.now();
    const { driver, source } = await this.acquire();
    const created = Date.now() - t0;
    this.driver = driver;
    this.source = source;
    this.acquiredAt = Date.now();
    try {
      // The working directory is the sandbox's own scratch space (empty, at the same path as
      // here); a reused VM is reset first (installed dependencies kept). A shared VM is shared.
      const writable = this.vm.paths.filter((p) => !p.readOnly && !this.isVolume(p.path)).map((p) => p.path);
      const readable = this.vm.paths.filter((p) => p.readOnly && !this.isVolume(p.path)).map((p) => p.path);
      const keep = KEEP_ON_RESET.map((k) => `! -name ${q(k)}`).join(" ");
      const reset = source === "pool" || source === "warm" ? `find "$d" -mindepth 1 -maxdepth 1 ${keep} -exec rm -rf {} + 2>/dev/null; ` : "";
      const dirs = [this.vm.root, ...writable, ...readable];
      const mk = await driver.exec(`for d in ${dirs.map(q).join(" ")}; do mkdir -p "$d" 2>/dev/null || { sudo mkdir -p "$d" && sudo chown "$(id -u):$(id -g)" "$d"; }; ${reset}done`, {});
      if (mk.exitCode !== 0) throw new Error(`Could not prepare the working directory: ${(mk.stderr || mk.stdout).trim().slice(0, 300)}`);

      // read-only context the agent may need (skills, playbooks): small, copied in
      const t1 = Date.now();
      let uploaded = 0;
      for (const dir of readable) {
        if (!existsSync(dir)) continue;
        uploaded += await this.uploadTree(driver, dir);
      }
      await driver.exec(`touch ${q(this.marker)}`, {});
      const synced = Date.now() - t1;

      const t2 = Date.now();
      await this.prepareVolumes(driver);
      const mounted = Date.now() - t2;

      this.vm.emit({
        kind: "ready", remoteId: driver.remoteId, source,
        message: `${this.vm.provider} sandbox ${driver.remoteId} ready (${source === "created" ? "new" : source === "pool" ? "reused" : source}, ${this.remoteVolumes().length} volume(s), ${Math.round(uploaded / 1024)} KB of context)`,
        durationMs: Date.now() - t0, steps: { acquireMs: created, syncMs: synced, volumesMs: mounted },
      });
    } catch (err) {
      if (this.shared) {
        await this.vm.pool?.leaveShared(driver.remoteId, this.vm.releaseTimes, this.vm.workspaceId).catch(() => undefined);
      } else {
        await driver.destroy().catch(() => undefined);
        await this.vm.pool?.remove(driver.remoteId).catch(() => undefined);
      }
      throw err;
    }
  }

  /** Volumes this VM can attach: those with a remote bucket and keys. */
  private remoteVolumes(): ResolvedSandboxVolume[] {
    return (this.vm.opts.volumes ?? []).filter((v) => v.remote);
  }

  private isVolume(path: string): boolean {
    return this.remoteVolumes().some((v) => v.mountPath === path);
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

  // ── Volumes ───────────────────────────────────────────────────────────

  /** rclone remote "polpo" for a volume's bucket, as environment variables (keys never on disk). */
  private rcloneEnv(v: ResolvedSandboxVolume): Record<string, string> {
    const r = v.remote!;
    return {
      RCLONE_CONFIG_POLPO_TYPE: "s3",
      RCLONE_CONFIG_POLPO_PROVIDER: "Other",
      RCLONE_CONFIG_POLPO_ACCESS_KEY_ID: r.credentials.accessKeyId,
      RCLONE_CONFIG_POLPO_SECRET_ACCESS_KEY: r.credentials.secretAccessKey,
      ...(r.credentials.sessionToken ? { RCLONE_CONFIG_POLPO_SESSION_TOKEN: r.credentials.sessionToken } : {}),
      ...(r.endpoint ? { RCLONE_CONFIG_POLPO_ENDPOINT: r.endpoint } : {}),
      ...(r.region ? { RCLONE_CONFIG_POLPO_REGION: r.region } : {}),
      ...(r.pathStyle ? { RCLONE_CONFIG_POLPO_FORCE_PATH_STYLE: "true" } : {}),
    };
  }

  private remoteSource(v: ResolvedSandboxVolume, sub = ""): string {
    const r = v.remote!;
    const prefix = (r.prefix ?? "").replace(/^\/+|\/+$/g, "");
    return `polpo:${r.bucket}${prefix ? `/${prefix}` : ""}${sub ? `/${sub}` : ""}`;
  }

  private async ensureTool(driver: RemoteDriver, tool: "rclone" | "mount-s3"): Promise<boolean> {
    const install = tool === "rclone"
      ? "curl -fsSL https://rclone.org/install.sh | sudo bash"
      : "curl -fsSL -o /tmp/mount-s3.deb https://s3.amazonaws.com/mountpoint-s3-release/latest/x86_64/mount-s3.deb && sudo apt-get install -y /tmp/mount-s3.deb";
    const r = await driver.exec(`command -v ${tool} >/dev/null || (${install}) >/dev/null 2>&1; command -v ${tool}`, { timeoutMs: 300_000 });
    return r.exitCode === 0;
  }

  /** The volume's revision in its bucket (.polpo-volume.json; 0 when absent). */
  private async readRevision(driver: RemoteDriver, v: ResolvedSandboxVolume): Promise<number> {
    const r = await driver.exec(`rclone cat ${q(this.remoteSource(v, VOLUME_REVISION_OBJECT))} 2>/dev/null || true`, { env: this.rcloneEnv(v), timeoutMs: 60_000 });
    try { return Number(JSON.parse(r.stdout || "{}").revision) || 0; } catch { return 0; }
  }

  /** Attach every selected volume: mounted live, or hydrated (copied in at its current revision). */
  private async prepareVolumes(driver: RemoteDriver): Promise<void> {
    const volumes = this.remoteVolumes();
    for (const v of (this.vm.opts.volumes ?? []).filter((x) => !x.remote)) {
      this.vm.emit({ kind: "warning", message: v.kind === "local"
        ? `Volume "${v.name}" is a folder on this server: it stays here and is not attached to remote sandboxes`
        : `Volume "${v.name}" is not attached: its bucket has no keys for sandboxes` });
    }
    if (!volumes.length) return;
    if (this.vm.opts.sandbox.network.mode === "deny") {
      this.vm.emit({ kind: "warning", message: "Volumes are not attached: the sandbox has no network" });
      return;
    }
    const needsRclone = volumes.some((v) => v.strategy === "hydrated" || v.driver === "rclone");
    if (needsRclone && !(await this.ensureTool(driver, "rclone"))) throw new Error("rclone could not be installed in the sandbox (needed for volumes)");
    for (const v of volumes) {
      const env = this.rcloneEnv(v);
      const readOnly = v.access === "read-only";
      const mk = `{ mkdir -p ${q(v.mountPath)} 2>/dev/null || { sudo mkdir -p ${q(v.mountPath)} && sudo chown "$(id -u):$(id -g)" ${q(v.mountPath)}; }; }`;
      if (v.strategy === "mounted") {
        let cmd: string;
        if (v.driver === "mountpoint-s3") {
          if (!(await this.ensureTool(driver, "mount-s3"))) throw new Error(`mountpoint-s3 could not be installed in the sandbox (volume "${v.name}")`);
          const r = v.remote!;
          const prefix = (r.prefix ?? "").replace(/^\/+|\/+$/g, "");
          const flags = [
            ...(prefix ? ["--prefix", q(`${prefix}/`)] : []), ...(r.endpoint ? ["--endpoint-url", q(r.endpoint)] : []),
            ...(r.region ? ["--region", q(r.region)] : []), ...(r.pathStyle ? ["--force-path-style"] : []),
            ...(readOnly ? ["--read-only"] : ["--allow-overwrite", "--allow-delete"]),
          ];
          const awsEnv = { AWS_ACCESS_KEY_ID: r.credentials.accessKeyId, AWS_SECRET_ACCESS_KEY: r.credentials.secretAccessKey, ...(r.credentials.sessionToken ? { AWS_SESSION_TOKEN: r.credentials.sessionToken } : {}) };
          cmd = `${mk} && mount-s3 ${q(r.bucket)} ${q(v.mountPath)} ${flags.join(" ")}`;
          const res = await driver.exec(cmd, { env: awsEnv, timeoutMs: 120_000 });
          if (res.exitCode !== 0) throw new Error(`Volume "${v.name}" could not be mounted: ${(res.stderr || res.stdout).trim().slice(0, 300)}`);
        } else {
          const flags = ["--daemon", "--vfs-cache-mode", "writes", "--dir-cache-time", "30s", ...(readOnly ? ["--read-only"] : [])];
          cmd = `${mk} && rclone mount ${q(this.remoteSource(v))} ${q(v.mountPath)} ${flags.join(" ")} && sleep 1 && mountpoint -q ${q(v.mountPath)}`;
          const res = await driver.exec(cmd, { env, timeoutMs: 120_000 });
          if (res.exitCode !== 0) throw new Error(`Volume "${v.name}" could not be mounted: ${(res.stderr || res.stdout).trim().slice(0, 300) || "FUSE not available"}`);
        }
        this.vm.emit({ kind: "volume", step: "prepared", name: v.name });
      } else {
        const revision = await this.readRevision(driver, v);
        const res = await driver.exec(`${mk} && rclone copy ${q(this.remoteSource(v))} ${q(v.mountPath)} --exclude ${q(VOLUME_REVISION_OBJECT)} --exclude '.conflicts/**'${readOnly ? ` && chmod -R a-w ${q(v.mountPath)}` : ""}`, { env, timeoutMs: 900_000 });
        if (res.exitCode !== 0) throw new Error(`Volume "${v.name}" could not be copied in: ${(res.stderr || res.stdout).trim().slice(0, 300)}`);
        this.volumeBase.set(v.name, revision);
        this.vm.emit({ kind: "volume", step: "prepared", name: v.name, revision });
      }
    }
  }

  /**
   * Write a hydrated read-write volume back to its bucket, guarded by its revision: if another
   * run wrote it since we copied it, our changes go to .conflicts/<workspace id>/ instead.
   */
  private async writeBackVolume(driver: RemoteDriver, v: ResolvedSandboxVolume, step: "checkpointed" | "finalized"): Promise<void> {
    const env = this.rcloneEnv(v);
    const base = this.volumeBase.get(v.name) ?? 0;
    const current = await this.readRevision(driver, v);
    if (current !== base) {
      const target = this.remoteSource(v, `.conflicts/${this.vm.workspaceId}`);
      await driver.exec(`rclone copy ${q(v.mountPath)} ${q(target)}`, { env, timeoutMs: 900_000 });
      this.vm.emit({ kind: "volume", step: "conflict", name: v.name, revision: current, message: `Volume "${v.name}" changed elsewhere (revision ${base} → ${current}): this run's version was saved under .conflicts/${this.vm.workspaceId}/` });
      this.volumeBase.set(v.name, current);
      return;
    }
    const next = base + 1;
    const res = await driver.exec(
      `rclone sync ${q(v.mountPath)} ${q(this.remoteSource(v))} --exclude ${q(VOLUME_REVISION_OBJECT)} --exclude '.conflicts/**' && ` +
      `printf %s ${q(JSON.stringify({ revision: next, updatedAt: new Date().toISOString(), by: this.vm.opts.pool?.owner ?? "" }))} | rclone rcat ${q(this.remoteSource(v, VOLUME_REVISION_OBJECT))}`,
      { env, timeoutMs: 900_000 },
    );
    if (res.exitCode !== 0) throw new Error(`Volume "${v.name}" could not be written back: ${(res.stderr || res.stdout).trim().slice(0, 300)}`);
    this.volumeBase.set(v.name, next);
    this.vm.emit({ kind: "volume", step, name: v.name, revision: next });
  }

  /** sandbox_volume_checkpoint: persist one (or every) hydrated read-write volume now. */
  async checkpointVolume(name?: string): Promise<void> {
    const targets = this.remoteVolumes().filter((v) => v.strategy === "hydrated" && v.access === "read-write" && (!name || v.name === name));
    if (name && !targets.length) throw new Error(`No hydrated read-write volume named "${name}" in this sandbox`);
    for (const v of targets) await this.writeBackVolume(this.driver, v, "checkpointed");
  }

  /** Detach volumes before the VM is pooled or shared on: unmount, drop copies (and their keys). */
  private async detachVolumes(driver: RemoteDriver): Promise<void> {
    const volumes = this.remoteVolumes();
    if (!volumes.length) return;
    const paths = volumes.map((v) => q(v.mountPath)).join(" ");
    await driver.exec(`for d in ${paths}; do if mountpoint -q "$d" 2>/dev/null; then fusermount -u "$d" 2>/dev/null || sudo umount "$d"; fi; chmod -R u+w "$d" 2>/dev/null; rm -rf "$d" 2>/dev/null || sudo rm -rf "$d"; done; true`, { timeoutMs: 60_000 }).catch(() => undefined);
  }

  /** Copy back what changed in the output directory now. */
  async syncNow(): Promise<void> {
    await this.syncBackSafely();
  }

  /**
   * Release (open Polpo's finalize): bring back the output directory, write back the hydrated
   * volumes with automatic write-back, detach the volumes, then — by isolation and lifecycle —
   * leave the shared VM, return the VM to the pool (running until stopAfterIdleMinutes, then
   * stopped by the reaper and deleted deleteAfterStopMinutes later) or destroy it.
   */
  async dispose(): Promise<void> {
    if (this.releaseOutcome) return;
    const driver = this.driver;
    try {
      if (this.suspendedAt) await this.lifecycle?.resume();
      await this.syncBack(driver);
    } catch (err) {
      this.vm.emit({ kind: "warning", message: `Files changed in the sandbox could not be copied back: ${(err as Error).message}` });
    }
    for (const v of this.remoteVolumes().filter((x) => x.strategy === "hydrated" && x.access === "read-write" && x.writeBack !== "manual")) {
      try { await this.writeBackVolume(driver, v, "finalized"); }
      catch (err) { this.vm.emit({ kind: "warning", message: (err as Error).message }); }
    }
    await this.detachVolumes(driver);
    let outcome: "pooled" | "destroyed" | "shared" = "destroyed";
    if (this.shared && this.vm.pool) {
      await this.vm.pool.leaveShared(driver.remoteId, this.vm.releaseTimes, this.vm.workspaceId).catch(() => undefined);
      outcome = "shared";
    } else if (this.vm.pool && this.vm.releaseTimes.onRelease === "pool" && this.releaseReason !== "error") {
      try {
        // keeps running until the reaper stops it (E2B: its own timeout pauses it as well)
        await driver.keepAlive?.((this.vm.releaseTimes.stopAfterIdleMinutes + 2) * 60_000).catch(() => undefined);
        await this.vm.pool.release(driver.remoteId, this.vm.releaseTimes);
        outcome = "pooled";
      } catch {
        outcome = "destroyed";
      }
    }
    if (outcome === "destroyed") {
      await driver.destroy().catch(() => undefined);
      await this.vm.pool?.remove(driver.remoteId).catch(() => undefined);
    }
    this.releaseOutcome = outcome;
  }

  private async syncBackSafely(driver: RemoteDriver = this.driver): Promise<void> {
    try {
      await this.syncBack(driver);
    } catch (err) {
      this.vm.emit({ kind: "warning", message: `Files changed in the sandbox could not be copied back: ${(err as Error).message}` });
    }
  }

  private async syncBack(driver: RemoteDriver): Promise<void> {
    const t0 = Date.now();
    // the scratch working directory stays in the sandbox; deliverables come back from the
    // writable paths (the task's output directory)
    const targets = this.vm.paths.filter((p) => !p.readOnly && !this.isVolume(p.path)).map((p) => p.path);
    if (!targets.length) return;
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
    if (listed.length) this.vm.emit({ kind: "synced", message: `${listed.length} changed file(s) copied back`, durationMs: Date.now() - t0 });
  }
}

/**
 * Daytona/E2B behind open Polpo's SandboxProvider port: open() acquires the VM (by isolation:
 * shared, reused, warm or new) and prepares it. What it does is ours (open Polpo leaves the
 * remote providers, the pool and the volume sync to the host); the port is theirs.
 */
export class RemoteVmProvider implements SandboxProvider {
  readonly root: string;
  readonly paths: Array<{ path: string; readOnly: boolean }>;
  readonly releaseTimes: Required<Omit<SandboxLifecycleSettings, "idleTtlMinutes">>;
  readonly isolation: SandboxIsolation;
  readonly pool?: SandboxPool;
  readonly adapter: RemoteAdapter;
  readonly idleSuspendMs: number;
  readonly defaultTimeoutMs?: number;
  /** The session once open (one per run). */
  session?: RemoteVmSession;

  constructor(readonly provider: RemoteSandboxProvider, readonly opts: RemoteWorkspaceOptions, readonly workspaceId: string) {
    this.root = resolve(opts.root);
    this.paths = [
      ...(opts.writable ?? []).map((path) => ({ path: resolve(path), readOnly: false })),
      ...(opts.readable ?? []).map((path) => ({ path: resolve(path), readOnly: true })),
      ...(opts.volumes ?? []).filter((v) => v.remote).map((v) => ({ path: v.mountPath, readOnly: v.access === "read-only" })),
    ];
    this.releaseTimes = opts.sandbox.lifecycle ?? effectiveLifecycle(undefined);
    this.isolation = opts.sandbox.isolation ?? DEFAULT_ISOLATION;
    this.pool = opts.pool ? new SandboxPool(poolFilePath(opts.pool.polpoDir)) : undefined;
    this.adapter = opts.adapter ?? remoteAdapter(provider);
    this.idleSuspendMs = opts.idleSuspendMs ?? (this.adapter.fastSuspend ? DEFAULT_IDLE_SUSPEND_MS : 0);
    this.defaultTimeoutMs = opts.sandbox.resources.timeoutMin ? opts.sandbox.resources.timeoutMin * 60_000 : undefined;
  }

  /** Progress and problems for the host (read at call time: callers may set it later). */
  emit(event: RemoteWorkspaceEvent): void {
    try { this.opts.onEvent?.(event); } catch { /* telemetry never changes the run */ }
  }

  async open(runId: string): Promise<RemoteVmSession> {
    const session = new RemoteVmSession(this, runId);
    await session.start();
    this.session = session;
    return session;
  }
}

/**
 * A remote sandbox as this repository's Workspace (what WorkspaceShell and WorkspaceFileSystem
 * use), run through open Polpo's SandboxLease: the VM is acquired on the first operation,
 * suspended while no tool runs (where the provider suspends cheaply) and resumed on demand;
 * its running time is measured.
 */
export class RemoteWorkspace implements Workspace {
  readonly id = `ws-${nanoid(10)}`;
  readonly root: string;
  readonly paths: Array<{ path: string; readOnly: boolean }>;
  private readonly vm: RemoteVmProvider;
  private readonly lease: SandboxLease;
  private disposed = false;
  private runningMs = 0;

  constructor(readonly provider: RemoteSandboxProvider, protected readonly opts: RemoteWorkspaceOptions) {
    this.vm = new RemoteVmProvider(provider, opts, this.id);
    this.root = this.vm.root;
    this.paths = this.vm.paths;
    this.lease = new SandboxLease(this.vm, opts.pool?.runId ?? this.id, {
      idleSuspendMs: this.vm.idleSuspendMs || DEFAULT_IDLE_SUSPEND_MS,
      onUsage: (usage) => { this.runningMs = usage.sandboxMs; },
    });
  }

  /** Time the VM actually ran (acquired and not suspended), as measured by the lease at release. */
  get runningTimeMs(): number {
    return this.runningMs;
  }

  /** The provider's id of the VM, once acquired. */
  get remoteId(): string | undefined {
    return this.vm.session?.remoteId;
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (this.disposed) throw new Error("This sandbox has been closed");
    const t0 = Date.now();
    const script = opts.stdin !== undefined ? `printf %s ${q(opts.stdin)} | (${command})` : command;
    const r = await this.lease.shell.execute(script, { cwd: opts.cwd ?? this.root, env: opts.env, timeout: opts.timeoutMs });
    if (r.stdout) opts.onOutput?.(r.stdout);
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.exitCode === 124, durationMs: Date.now() - t0 };
  }

  async readFile(path: string): Promise<Uint8Array> {
    return this.lease.fs.readFileBuffer!(path);
  }

  async writeFile(path: string, data: Uint8Array | string, opts?: { mode?: number }): Promise<void> {
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    await this.lease.fs.mkdir(parent);
    await this.lease.fs.writeFileBuffer!(path, typeof data === "string" ? Buffer.from(data) : data);
    if (opts?.mode) await this.lease.shell.execute(`chmod ${opts.mode.toString(8)} ${q(path)}`);
  }

  async stat(path: string): Promise<WorkspaceFileStat | null> {
    const r = await this.lease.shell.execute(`stat -c '%F|%s|%Y' -- ${q(path)} 2>/dev/null`);
    if (r.exitCode !== 0 || !r.stdout.trim()) return null;
    const [kind, size, mtime] = r.stdout.trim().split("|");
    const type = kind === "directory" ? "dir" : kind?.includes("regular") ? "file" : kind === "symbolic link" ? "symlink" : "other";
    return { type, size: Number(size), mtimeMs: Number(mtime) * 1000 };
  }

  async list(path: string, opts?: { recursive?: boolean; maxEntries?: number }): Promise<WorkspaceEntry[]> {
    const depth = opts?.recursive ? "" : "-maxdepth 1";
    const r = await this.lease.shell.execute(`find ${q(path)} -mindepth 1 ${depth} -printf '%y|%s|%p\\n' 2>/dev/null | head -n ${opts?.maxEntries ?? 10000}`);
    return r.stdout.split("\n").filter(Boolean).map((line) => {
      const [y, size, ...rest] = line.split("|");
      const type = y === "d" ? "dir" : y === "f" ? "file" : y === "l" ? "symlink" : "other";
      return { path: rest.join("|"), type, size: Number(size) } as WorkspaceEntry;
    });
  }

  async mkdir(path: string): Promise<void> {
    await this.lease.fs.mkdir(path);
  }

  async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await this.lease.shell.execute(`rm -f${opts?.recursive ? "r" : ""} -- ${q(path)}`);
  }

  async upload(hostPath: string, path: string): Promise<void> {
    await this.writeFile(path, await hostRun(["cat", hostPath]));
  }

  async download(path: string, hostPath: string): Promise<void> {
    const data = await this.readFile(path);
    await hostRun(["sh", "-c", `mkdir -p "$(dirname "$1")" && cat > "$1"`, "sh", hostPath], data);
  }

  /** sandbox_volume_checkpoint (through the lease, as in open Polpo). */
  async checkpointVolume(name?: string): Promise<void> {
    await this.lease.checkpointVolume(name);
  }

  /** Copy back what changed in the output directory now (chats after each command). */
  async syncNow(): Promise<void> {
    if (!this.vm.session || this.disposed) return;
    await this.lease.shell.execute(":");
    await this.vm.session.syncNow();
  }

  /** End the run: the lease releases the session (finalize) and reports the running time. */
  async dispose(reason?: string): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const session = this.vm.session;
    if (session) session.releaseReason = reason;
    await this.lease.dispose().catch((err) => this.vm.emit({ kind: "warning", message: `The sandbox could not be released: ${(err as Error).message}` }));
    if (session?.outcome) {
      this.vm.emit({ kind: "released", remoteId: session.remoteId, outcome: session.outcome, runningMs: this.runningMs, durationMs: session.durationMs });
    }
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
