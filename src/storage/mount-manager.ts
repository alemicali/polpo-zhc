/**
 * Supervised FUSE mounts of storage entries on the host: one `rclone mount` (or `mount-s3`)
 * child per enabled entry at <polpoDir>/mounts/<slug>, with its VFS cache in
 * <polpoDir>/cache/storage/<slug>.
 *
 * A child that dies is restarted with exponential backoff; every entry has a state (mounting,
 * mounted, unmounted, error + message). Credentials reach the child through its environment only.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { StorageCredentials, StorageEntry } from "@polpo-ai/core/storage-registry";
import {
  childEnv, findBinary, fuseUnmount, fusermountBinary, isMounted, mountpointS3Args, mountpointS3Env,
  rcloneMountArgs, rcloneRemoteEnv,
} from "./rclone.js";

export type MountState = "unmounted" | "mounting" | "mounted" | "error";

export interface MountStatus {
  entryId: string;
  slug: string;
  state: MountState;
  /** Host directory of the mount. */
  path: string;
  error?: string;
  /** When the current state began. */
  since: string;
  /** Restarts after a crash since the last manual mount. */
  restarts: number;
  pid?: number;
}

export type MountEventAction = "mounted" | "unmounted" | "mount-failed";

export interface MountManagerOptions {
  polpoDir: string;
  credentialsFor(entry: StorageEntry): Promise<StorageCredentials | undefined>;
  onEvent?(entry: StorageEntry, action: MountEventAction, error?: string): void;
  /** Binary overrides (tests). */
  rcloneBinary?: string;
  mountpointS3Binary?: string;
  /** How long a mount may take to appear (default 20 s). */
  mountTimeoutMs?: number;
  /** First restart delay (default 2 s), doubled up to maxBackoffMs (default 5 min). */
  backoffMs?: number;
  maxBackoffMs?: number;
}

interface MountRecord {
  entry: StorageEntry;
  status: MountStatus;
  child?: ChildProcess;
  stopping: boolean;
  restartTimer?: NodeJS.Timeout;
  stableTimer?: NodeJS.Timeout;
  stderr: string;
}

const STDERR_TAIL = 4_000;

export class StorageMountManager {
  private readonly records = new Map<string, MountRecord>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private shuttingDown = false;

  constructor(private readonly opts: MountManagerOptions) {}

  mountPath(entry: Pick<StorageEntry, "slug">): string {
    return join(this.opts.polpoDir, "mounts", entry.slug);
  }

  cacheDir(entry: Pick<StorageEntry, "slug">): string {
    return join(this.opts.polpoDir, "cache", "storage", entry.slug);
  }

  status(entry: Pick<StorageEntry, "id" | "slug">): MountStatus {
    return this.records.get(entry.id)?.status
      ?? { entryId: entry.id, slug: entry.slug, state: "unmounted", path: this.mountPath(entry), since: new Date(0).toISOString(), restarts: 0 };
  }

  statuses(): MountStatus[] {
    return [...this.records.values()].map((record) => record.status);
  }

  /** Mount (or remount with the entry's current settings). */
  mount(entry: StorageEntry): Promise<MountStatus> {
    return this.serial(entry.id, async () => {
      await this.stop(entry.id, false);
      return this.start(entry, 0);
    });
  }

  unmount(entry: Pick<StorageEntry, "id" | "slug">): Promise<MountStatus> {
    return this.serial(entry.id, async () => {
      await this.stop(entry.id, true);
      return this.status(entry);
    });
  }

  /** Forget an entry (after it was deleted): unmount it and drop its state. */
  async remove(entry: Pick<StorageEntry, "id" | "slug">): Promise<void> {
    await this.unmount(entry);
    this.records.delete(entry.id);
  }

  /** Mount every enabled entry, unmount the rest. */
  async sync(entries: StorageEntry[]): Promise<void> {
    const ids = new Set(entries.map((entry) => entry.id));
    for (const record of [...this.records.values()]) {
      if (!ids.has(record.entry.id)) await this.remove(record.entry);
    }
    await Promise.all(entries.map((entry) => (entry.enabled ? this.mount(entry) : this.unmount(entry))));
  }

  /** Unmount everything (server shutdown). */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all([...this.records.values()].map((record) => this.unmount(record.entry)));
  }

  // ── Internals ──────────────────────────────────────────────────────

  private serial<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    this.queues.set(id, next.catch(() => undefined));
    return next;
  }

  private setState(record: MountRecord, state: MountState, error?: string): void {
    record.status = { ...record.status, state, error, since: new Date().toISOString(), pid: record.child?.pid };
  }

  private async start(entry: StorageEntry, restarts: number): Promise<MountStatus> {
    const path = this.mountPath(entry);
    const record: MountRecord = this.records.get(entry.id) ?? {
      entry, stopping: false, stderr: "",
      status: { entryId: entry.id, slug: entry.slug, state: "unmounted", path, since: new Date().toISOString(), restarts },
    };
    record.entry = entry;
    record.stopping = false;
    record.stderr = "";
    record.status = { ...record.status, slug: entry.slug, path, restarts };
    this.records.set(entry.id, record);
    if (this.shuttingDown) return record.status;

    const fail = (message: string): MountStatus => {
      this.setState(record, "error", message);
      this.opts.onEvent?.(entry, "mount-failed", message);
      return record.status;
    };

    this.setState(record, "mounting");
    const isRclone = entry.driver !== "mountpoint-s3";
    const binary = isRclone ? (this.opts.rcloneBinary ?? findBinary("rclone")) : (this.opts.mountpointS3Binary ?? findBinary("mount-s3"));
    if (!binary) {
      return fail(isRclone
        ? "Driver not installed: rclone is not installed on this server"
        : 'Driver not installed: mountpoint-s3 ("mount-s3") is not installed on this server. Install it or use the rclone driver.');
    }
    if (!fusermountBinary()) return fail("FUSE is not available: fusermount is not installed on this server");
    if (entry.driver === "mountpoint-s3" && !entry.readOnly) return fail('The "mountpoint-s3" driver is allowed only for read-only storage');
    const credentials = await this.opts.credentialsFor(entry).catch(() => undefined);
    if (!credentials?.accessKeyId || !credentials.secretAccessKey) return fail("Credentials are not set");

    const cacheDir = this.cacheDir(entry);
    try {
      await mkdir(path, { recursive: true });
      await mkdir(cacheDir, { recursive: true });
      // A mount left behind by a process that died: detach it before mounting again.
      if (isMounted(path)) await fuseUnmount(path, true);
      if ((await readdir(path)).length > 0) {
        return fail(`The mount directory ${path} is not empty: move its files away and mount again`);
      }
    } catch (error) {
      return fail(`Could not prepare ${path}: ${(error as Error).message}`);
    }

    const args = isRclone ? rcloneMountArgs(entry, path, cacheDir) : mountpointS3Args(entry, path, cacheDir);
    const env = childEnv(isRclone ? rcloneRemoteEnv(entry, credentials) : mountpointS3Env(credentials));
    let child: ChildProcess;
    try {
      child = spawn(binary, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      return fail(`Could not start ${isRclone ? "rclone" : "mount-s3"}: ${(error as Error).message}`);
    }
    record.child = child;
    record.status.pid = child.pid;
    child.stderr?.on("data", (chunk) => { record.stderr = (record.stderr + String(chunk)).slice(-STDERR_TAIL); });

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolveExit) => {
      child.once("error", (error) => resolveExit({ code: null, signal: null, error }));
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    void exited.then((result) => this.onExit(record, child, result));

    // Ready when the mount shows up in the mount table (rclone has no readiness signal).
    const deadline = Date.now() + (this.opts.mountTimeoutMs ?? 20_000);
    let alive = true;
    void exited.then(() => { alive = false; });
    while (alive && Date.now() < deadline && !isMounted(path)) await new Promise((r) => setTimeout(r, 100));
    if (record.child !== child) return record.status;
    if (alive && isMounted(path)) {
      this.setState(record, "mounted");
      this.opts.onEvent?.(entry, "mounted");
      // After a minute up, a later crash starts the backoff from the beginning again.
      record.stableTimer = setTimeout(() => { if (record.child === child) record.status.restarts = 0; }, 60_000);
      record.stableTimer.unref?.();
      return record.status;
    }
    if (alive) {
      child.kill("SIGTERM");
      await exited;
      return fail(`The mount did not appear within ${Math.round((this.opts.mountTimeoutMs ?? 20_000) / 1000)}s${this.stderrTail(record)}`);
    }
    // It exited before mounting: onExit recorded the error (and scheduled a retry).
    await exited;
    await new Promise((r) => setImmediate(r));
    return record.status;
  }

  private onExit(record: MountRecord, child: ChildProcess, result: { code: number | null; signal: NodeJS.Signals | null; error?: Error }): void {
    if (record.child !== child) return;
    record.child = undefined;
    if (record.stableTimer) clearTimeout(record.stableTimer);
    const path = record.status.path;
    // The child is gone; a mount still listed is dead ("transport endpoint is not connected").
    if (isMounted(path)) void fuseUnmount(path, true);
    if (record.stopping || this.shuttingDown) return;
    const reason = result.error?.message
      ?? (result.signal ? `stopped by ${result.signal}` : `exited with code ${result.code}`);
    const message = `${record.entry.driver === "mountpoint-s3" ? "mount-s3" : "rclone"} ${reason}${this.stderrTail(record)}`;
    this.setState(record, "error", message);
    this.opts.onEvent?.(record.entry, "mount-failed", message);
    // Restart with backoff, unless someone mounts/unmounts it in the meantime.
    const restarts = record.status.restarts + 1;
    const delay = Math.min((this.opts.backoffMs ?? 2_000) * 2 ** (restarts - 1), this.opts.maxBackoffMs ?? 300_000);
    record.status = { ...record.status, restarts, error: `${message} (retrying in ${Math.round(delay / 1000)}s)` };
    record.restartTimer = setTimeout(() => {
      record.restartTimer = undefined;
      void this.serial(record.entry.id, async () => {
        if (record.stopping || this.shuttingDown || record.child) return record.status;
        return this.start(record.entry, restarts);
      });
    }, delay);
    record.restartTimer.unref?.();
  }

  private stderrTail(record: MountRecord): string {
    const text = record.stderr.trim().split("\n").slice(-3).join(" | ").trim();
    return text ? `: ${text}` : "";
  }

  /** Stop the child and unmount. `emit`: report "unmounted" when something was mounted. */
  private async stop(id: string, emit: boolean): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    record.stopping = true;
    if (record.restartTimer) { clearTimeout(record.restartTimer); record.restartTimer = undefined; }
    if (record.stableTimer) clearTimeout(record.stableTimer);
    const wasActive = record.status.state === "mounted" || record.status.state === "mounting";
    const child = record.child;
    const path = record.status.path;
    if (isMounted(path)) {
      const result = await fuseUnmount(path);
      // Busy (a process has a file open): detach lazily, it disappears when released.
      if (!result.ok) await fuseUnmount(path, true);
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((r) => child.once("exit", () => r()));
      const waited = await Promise.race([exited.then(() => true), sleep(5_000).then(() => false)]);
      if (!waited) {
        child.kill("SIGTERM");
        const stopped = await Promise.race([exited.then(() => true), sleep(5_000).then(() => false)]);
        if (!stopped) child.kill("SIGKILL");
      }
    }
    record.child = undefined;
    const previousError = record.status.state === "error";
    this.setState(record, "unmounted");
    record.status.restarts = 0;
    if (emit && (wasActive || previousError)) this.opts.onEvent?.(record.entry, "unmounted");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
}
