/**
 * Registry of remote sandbox VMs, shared by the server and the task runners of one project.
 *
 * Task runners are separate processes, so the pool cannot live in memory: it is a small JSON
 * file next to the project's state, changed only under a lock file. It records
 *   - "leased" VMs: in use by a process (pid), so a crashed runner's VM can be found and deleted;
 *   - "idle" VMs: suspended after a run, kept for the same agent's next run until deleteAt;
 *   - "warm" VMs: created ahead of time for nobody in particular (instance setting "warm").
 * The server's reaper deletes expired and orphaned VMs and refills the warm ones.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { EffectiveSandbox, RemoteSandboxProvider } from "@polpo-ai/core/sandbox";

export type PoolEntryState = "leased" | "idle" | "warm";

export interface PoolEntry {
  remoteId: string;
  provider: RemoteSandboxProvider;
  /** Image + network + limits: a VM is only reused for the same key (network rules are fixed at creation). */
  key: string;
  /** Agent the VM belongs to ("" for warm VMs, which belong to nobody until taken). */
  owner: string;
  state: PoolEntryState;
  createdAt: string;
  /** Leased: the process using it. */
  pid?: number;
  host?: string;
  leasedAt?: string;
  runId?: string;
  sessionKey?: string;
  /** Idle/warm: suspended since, and when the reaper deletes it if nobody takes it. */
  idleSince?: string;
  deleteAt?: string;
}

interface PoolFile { version: 1; entries: PoolEntry[] }

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

export function poolFilePath(polpoDir: string): string {
  return join(polpoDir, "sandbox-pool.json");
}

/** Key for reuse: provider image/template, network rule and limits. */
export function poolKey(provider: RemoteSandboxProvider, sandbox: Pick<EffectiveSandbox, "network" | "resources" | "providerOptions">): string {
  const image = String(sandbox.providerOptions.snapshot ?? sandbox.providerOptions.template ?? "default");
  const network = sandbox.network.mode === "allowlist" ? `allowlist:${[...(sandbox.network.allow ?? [])].sort().join(",")}` : sandbox.network.mode;
  const { cpus, memoryMb, diskMb } = sandbox.resources;
  const raw = JSON.stringify({ provider, image, network, cpus, memoryMb, diskMb });
  return `${provider}:${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
}

/** A short, stable id for this project, used in VM labels (find our VMs, never anyone else's). */
export function instanceLabel(polpoDir: string): string {
  return createHash("sha256").update(polpoDir).digest("hex").slice(0, 12);
}

export class SandboxPool {
  constructor(readonly file: string, private readonly hostname = process.env.HOSTNAME ?? "") {}

  /** Run fn on the registry under the lock; fn's changes are saved. */
  async update<T>(fn: (entries: PoolEntry[]) => T | Promise<T>): Promise<T> {
    const release = await this.lock();
    try {
      const data = this.read();
      const result = await fn(data.entries);
      this.write(data);
      return result;
    } finally {
      release();
    }
  }

  list(): PoolEntry[] {
    return this.read().entries;
  }

  /** Take an idle VM this owner used before (same key), marking it leased by this process. */
  takeIdle(provider: RemoteSandboxProvider, key: string, owner: string, lease: Partial<PoolEntry> = {}): Promise<PoolEntry | undefined> {
    return this.update((entries) => {
      const now = Date.now();
      const entry = entries
        .filter((e) => e.state === "idle" && e.provider === provider && e.key === key && e.owner === owner && (!e.deleteAt || Date.parse(e.deleteAt) > now))
        .sort((a, b) => Date.parse(b.idleSince ?? b.createdAt) - Date.parse(a.idleSince ?? a.createdAt))[0];
      if (!entry) return undefined;
      Object.assign(entry, this.leaseFields(lease), { owner, idleSince: undefined, deleteAt: undefined });
      return { ...entry };
    });
  }

  /** Take a warm VM (owned by nobody) with this key. */
  takeWarm(provider: RemoteSandboxProvider, key: string, owner: string, lease: Partial<PoolEntry> = {}): Promise<PoolEntry | undefined> {
    return this.update((entries) => {
      const entry = entries.find((e) => e.state === "warm" && e.provider === provider && e.key === key);
      if (!entry) return undefined;
      Object.assign(entry, this.leaseFields(lease), { owner, idleSince: undefined, deleteAt: undefined });
      return { ...entry };
    });
  }

  /** Record a VM this process just created. */
  addLeased(entry: Omit<PoolEntry, "state" | "createdAt" | "pid" | "host" | "leasedAt"> & Partial<PoolEntry>): Promise<void> {
    return this.update((entries) => {
      const existing = entries.findIndex((e) => e.remoteId === entry.remoteId);
      const record: PoolEntry = { createdAt: new Date().toISOString(), ...entry, ...this.leaseFields(entry), state: "leased" };
      if (existing >= 0) entries[existing] = record; else entries.push(record);
    });
  }

  /** Back to the pool, suspended, until deleteAt. */
  release(remoteId: string, deleteAfterMinutes: number): Promise<void> {
    return this.update((entries) => {
      const entry = entries.find((e) => e.remoteId === remoteId);
      if (!entry) return;
      const now = Date.now();
      Object.assign(entry, { state: "idle" as const, idleSince: new Date(now).toISOString(), deleteAt: new Date(now + deleteAfterMinutes * 60_000).toISOString(), pid: undefined, host: undefined, leasedAt: undefined, runId: undefined, sessionKey: undefined });
    });
  }

  /** A warm VM ready for anyone. */
  addWarm(entry: Pick<PoolEntry, "remoteId" | "provider" | "key">, deleteAfterMinutes: number): Promise<void> {
    return this.update((entries) => {
      const now = Date.now();
      entries.push({ ...entry, owner: "", state: "warm", createdAt: new Date(now).toISOString(), idleSince: new Date(now).toISOString(), deleteAt: new Date(now + deleteAfterMinutes * 60_000).toISOString() });
    });
  }

  remove(remoteId: string): Promise<void> {
    return this.update((entries) => {
      const i = entries.findIndex((e) => e.remoteId === remoteId);
      if (i >= 0) entries.splice(i, 1);
    });
  }

  private leaseFields(lease: Partial<PoolEntry>): Partial<PoolEntry> {
    return { state: "leased", pid: lease.pid ?? process.pid, host: this.hostname, leasedAt: new Date().toISOString(), runId: lease.runId, sessionKey: lease.sessionKey };
  }

  private read(): PoolFile {
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as PoolFile;
      return Array.isArray(data?.entries) ? data : { version: 1, entries: [] };
    } catch {
      return { version: 1, entries: [] };
    }
  }

  private write(data: PoolFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private async lock(): Promise<() => void> {
    const lockPath = `${this.file}.lock`;
    mkdirSync(dirname(lockPath), { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const fd = openSync(lockPath, "wx", 0o600);
        writeFileSync(fd, String(process.pid));
        closeSync(fd);
        return () => { try { unlinkSync(lockPath); } catch { /* already gone */ } };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        try {
          if (existsSync(lockPath) && Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath);
        } catch { /* raced with another process */ }
        if (Date.now() > deadline) throw new Error("The sandbox pool is locked by another process");
        await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
      }
    }
  }
}
