/**
 * Computers' lifecycle: one persistent remote machine per computer (settings.computers).
 *
 * - Found by its provider label `polpo-computer=<instance>:<id>` (Daytona label, E2B metadata),
 *   never by the per-project pool file: it survives that file, restarts and other hosts.
 * - ensure(): start/resume it when stopped, paused or archived; create it only when the provider
 *   has none. Creating, starting, stopping and resetting are serialized per computer (in this
 *   process and across the task runners, with a lock file); commands run concurrently.
 * - Kept warm while used: every command or file operation touches it (lastUsedAt, and the
 *   provider's own idle timer); after lifecycle.idleStopMinutes without use the server stops it
 *   (Daytona container) or pauses it (E2B, Daytona VM class). It is NEVER deleted automatically:
 *   only reset (delete + recreate) and delete, both asked for by a person.
 * - The working directory is not wiped between runs (see remote.ts: computers skip the reset).
 * - Runtime state (status, remote id, last use, uptime as a rough cost signal) lives in
 *   .polpo/computers-state.json; the provider is the truth, the file a cache for the dashboard.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMPUTER_LABEL, computerIdleStopMinutes, isRemoteComputer,
  type ComputerConfig, type ComputerStatus, type EffectiveSandbox, type RemoteSandboxProvider,
} from "@polpo-ai/core/sandbox";
import { acquireFileLock } from "./file-lock.js";
import { instanceLabel } from "./pool.js";
import { remoteAdapter, type RemoteAdapter, type RemoteDriver, type RemoteVmSummary } from "./remote-adapters.js";

export interface ComputerRuntime {
  provider: RemoteSandboxProvider;
  remoteId?: string;
  status: ComputerStatus;
  lastUsedAt?: string;
  /** Since when it runs (status "running"): uptime counts from here. */
  runningSince?: string;
  /** Running time before runningSince (stopped periods excluded). */
  uptimeMs: number;
  createdAt?: string;
  lastError?: string;
  updatedAt: string;
}

interface StateFile { version: 1; computers: Record<string, ComputerRuntime> }

/** A computer as the API shows it: its runtime plus uptime in minutes. */
export interface ComputerLive {
  id: string;
  status: ComputerStatus;
  remoteId?: string;
  lastUsedAt?: string;
  uptimeMinutes: number;
  createdAt?: string;
  lastError?: string;
  /** Daytona: the snapshot a new machine would be created from is not active (it is activated on the next create). */
  snapshotState?: string;
}

/** Between two checks that the machine still runs (a long chat may outlive the idle stop). */
const VERIFY_EVERY_MS = 60_000;
/** lastUsedAt is written at most this often per computer. */
const TOUCH_EVERY_MS = 30_000;
/** While a command runs, it keeps the computer in use this often. */
const HEARTBEAT_MS = 60_000;

/** Provider states as computer statuses. */
export function computerStatusOf(provider: RemoteSandboxProvider, state: string | undefined): ComputerStatus {
  const s = String(state ?? "").toLowerCase();
  if (provider === "e2b") return s === "running" ? "running" : s === "paused" ? "paused" : s ? "unknown" : "missing";
  switch (s) {
    case "started": return "running";
    case "stopped": return "stopped";
    case "paused": return "paused";
    case "archived": return "archived";
    case "creating": case "pending_build": case "building_snapshot": case "pulling_snapshot": return "creating";
    case "starting": case "resuming": case "restoring": return "starting";
    case "stopping": case "pausing": case "archiving": return "stopping";
    case "error": case "build_failed": return "error";
    case "destroyed": case "destroying": case "": return "missing";
    default: return "unknown";
  }
}

export function uptimeMinutes(rt: Pick<ComputerRuntime, "uptimeMs" | "status" | "runningSince"> | undefined, now = Date.now()): number {
  if (!rt) return 0;
  const running = rt.status === "running" && rt.runningSince ? Math.max(0, now - Date.parse(rt.runningSince)) : 0;
  return Math.round((rt.uptimeMs + running) / 60_000);
}

export interface ComputerManagerOptions {
  /** Tests inject adapters and a clock. */
  adapter?: (provider: RemoteSandboxProvider) => RemoteAdapter;
  now?: () => number;
}

export class ComputerManager {
  /** Called when a computer's status, machine or error changes (the server emits computer:changed). */
  onChange?: (id: string, live: ComputerLive) => void;
  private readonly file: string;
  private readonly instance: string;
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly touched = new Map<string, number>();
  private lastSeen = "";

  constructor(readonly polpoDir: string, private readonly opts: ComputerManagerOptions = {}) {
    this.file = join(polpoDir, "computers-state.json");
    this.instance = instanceLabel(polpoDir);
  }

  private adapter(p: RemoteSandboxProvider): RemoteAdapter {
    return (this.opts.adapter ?? remoteAdapter)(p);
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** The label value that finds this computer's machine: `<instance>:<id>`. */
  labelValue(id: string): string {
    return `${this.instance}:${id}`;
  }

  labels(id: string): Record<string, string> {
    return { polpo: "1", [COMPUTER_LABEL]: this.labelValue(id), "polpo-scope": "computer" };
  }

  // ── State file ─────────────────────────────────────────────────────

  read(): Record<string, ComputerRuntime> {
    if (!existsSync(this.file)) return {};
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as StateFile;
      return data?.computers && typeof data.computers === "object" ? data.computers : {};
    } catch {
      return {};
    }
  }

  /** Change one computer's runtime under the state lock; announces status/machine/error changes. */
  private async update(id: string, provider: RemoteSandboxProvider, fn: (cur: ComputerRuntime) => ComputerRuntime | null): Promise<ComputerRuntime | undefined> {
    const release = await acquireFileLock(`${this.file}.lock`, { busyMessage: "The computers' state is locked by another process" });
    let before: ComputerRuntime | undefined;
    let after: ComputerRuntime | undefined;
    try {
      const all = this.read();
      before = all[id];
      const cur = before ?? { provider, status: "missing" as ComputerStatus, uptimeMs: 0, updatedAt: new Date(this.now()).toISOString() };
      const next = fn({ ...cur });
      if (next) all[id] = after = { ...next, updatedAt: new Date(this.now()).toISOString() };
      else delete all[id];
      mkdirSync(this.polpoDir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, computers: all } satisfies StateFile, null, 2));
      renameSync(tmp, this.file);
    } finally {
      release();
    }
    if (!after || before?.status !== after.status || before?.remoteId !== after.remoteId || before?.lastError !== after.lastError) {
      this.announce(id, after);
    }
    return after;
  }

  private announce(id: string, rt: ComputerRuntime | undefined): void {
    try { this.onChange?.(id, this.live(id, rt)); } catch { /* listeners never change the operation */ }
  }

  live(id: string, rt: ComputerRuntime | undefined = this.read()[id]): ComputerLive {
    return {
      id,
      status: rt?.status ?? "missing",
      ...(rt?.remoteId ? { remoteId: rt.remoteId } : {}),
      ...(rt?.lastUsedAt ? { lastUsedAt: rt.lastUsedAt } : {}),
      uptimeMinutes: uptimeMinutes(rt, this.now()),
      ...(rt?.createdAt ? { createdAt: rt.createdAt } : {}),
      ...(rt?.lastError ? { lastError: rt.lastError } : {}),
    };
  }

  /** New status; leaving "running" adds the running period to the uptime. */
  private setStatus(c: ComputerConfig, status: ComputerStatus, extra: Partial<ComputerRuntime> = {}): Promise<ComputerRuntime | undefined> {
    return this.update(c.id, c.kind as RemoteSandboxProvider, (cur) => {
      const now = this.now();
      const next: ComputerRuntime = { ...cur, ...extra, provider: c.kind as RemoteSandboxProvider, status };
      if (cur.status === "running" && status !== "running" && cur.runningSince) {
        next.uptimeMs = cur.uptimeMs + Math.max(0, now - Date.parse(cur.runningSince));
        delete next.runningSince;
      }
      if (status === "running" && (cur.status !== "running" || !cur.runningSince)) next.runningSince = new Date(now).toISOString();
      if (status !== "error" && extra.lastError === undefined) delete next.lastError;
      return next;
    });
  }

  // ── Serialization ──────────────────────────────────────────────────

  /** One create/start/stop/reset at a time per computer: in this process, and across processes. */
  private exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(id) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(async () => {
      const release = await acquireFileLock(join(this.polpoDir, "computers", `${id}.lock`), {
        staleMs: 60_000, waitMs: 15 * 60_000, busyMessage: `Computer "${id}" is busy (another process is starting or changing it)`,
      });
      try { return await fn(); } finally { release(); }
    });
    this.chains.set(id, run);
    void run.catch(() => undefined).finally(() => { if (this.chains.get(id) === run) this.chains.delete(id); });
    return run;
  }

  // ── Provider ───────────────────────────────────────────────────────

  /** This computer's machines at the provider (normally one), running first, then newest. */
  private async machines(c: ComputerConfig): Promise<RemoteVmSummary[]> {
    const label = this.labelValue(c.id);
    const vms = await this.adapter(c.kind as RemoteSandboxProvider).list({ [COMPUTER_LABEL]: label });
    return vms
      .filter((v) => v.labels?.[COMPUTER_LABEL] === label && computerStatusOf(c.kind as RemoteSandboxProvider, v.state) !== "missing")
      .sort((a, b) => {
        const ra = computerStatusOf(c.kind as RemoteSandboxProvider, a.state) === "running" ? 0 : 1;
        const rb = computerStatusOf(c.kind as RemoteSandboxProvider, b.state) === "running" ? 0 : 1;
        return ra - rb || Date.parse(b.createdAt ?? "0") - Date.parse(a.createdAt ?? "0");
      });
  }

  /** Find by label; start or resume; create only when there is none. Call under exclusive(). */
  private async ensureLocked(c: ComputerConfig, sandbox: EffectiveSandbox, onWarning?: (message: string) => void, onProgress?: (message: string) => void): Promise<RemoteDriver> {
    const provider = c.kind as RemoteSandboxProvider;
    const adapter = this.adapter(provider);
    const idle = computerIdleStopMinutes(c);
    try {
      const [found] = await this.machines(c);
      if (found) {
        if (computerStatusOf(provider, found.state) !== "running") await this.setStatus(c, "starting", { remoteId: found.remoteId });
        const driver = await adapter.connect(found.remoteId, { timeoutMs: idle * 60_000 });
        await this.setStatus(c, "running", { remoteId: driver.remoteId, lastUsedAt: new Date(this.now()).toISOString(), ...(found.createdAt ? { createdAt: found.createdAt } : {}) });
        return driver;
      }
      await this.setStatus(c, "creating");
      const driver = await adapter.create({
        sandbox, labels: this.labels(c.id), lifetimeMinutes: idle, keep: true, onWarning, onProgress,
        persistent: { idleStopMinutes: idle, ...(c.lifecycle?.autoArchiveDays ? { autoArchiveDays: c.lifecycle.autoArchiveDays } : {}) },
      });
      const now = new Date(this.now()).toISOString();
      await this.setStatus(c, "running", { remoteId: driver.remoteId, lastUsedAt: now, createdAt: now });
      return driver;
    } catch (err) {
      await this.setStatus(c, "error", { lastError: (err as Error).message ?? String(err) }).catch(() => undefined);
      throw err;
    }
  }

  /** The computer's machine, running (started, resumed or created). */
  ensure(c: ComputerConfig, sandbox: EffectiveSandbox, onWarning?: (message: string) => void, onProgress?: (message: string) => void): Promise<RemoteDriver> {
    if (!isRemoteComputer(c)) return Promise.reject(new Error(`Computer "${c.id}" is this server: there is no machine to start`));
    return this.exclusive(c.id, () => this.ensureLocked(c, sandbox, onWarning, onProgress));
  }

  /**
   * A driver for a run (chat or task) on the computer: commands and file operations keep it in use
   * and, after a minute, check it still runs (starting it again if it was stopped meanwhile).
   * Suspending and destroying are no-ops: the computer outlives every run.
   */
  async attach(c: ComputerConfig, sandbox: EffectiveSandbox, onWarning?: (message: string) => void, onProgress?: (message: string) => void): Promise<RemoteDriver> {
    let inner = await this.ensure(c, sandbox, onWarning, onProgress);
    let verifiedAt = this.now();
    const fresh = async (): Promise<RemoteDriver> => {
      if (this.now() - verifiedAt > VERIFY_EVERY_MS) {
        inner = await this.ensure(c, sandbox, onWarning, onProgress);
        verifiedAt = this.now();
      }
      return inner;
    };
    const use = async <T>(fn: (d: RemoteDriver) => Promise<T>): Promise<T> => {
      const d = await fresh();
      this.touch(c, d);
      const beat = setInterval(() => this.touch(c, d, true), HEARTBEAT_MS);
      beat.unref?.();
      try {
        const out = await fn(d);
        verifiedAt = this.now();
        return out;
      } finally {
        clearInterval(beat);
        this.touch(c, d);
      }
    };
    return {
      get remoteId() { return inner.remoteId; },
      exec: (command, o) => use((d) => d.exec(command, o)),
      readFile: (path) => use((d) => d.readFile(path)),
      writeFile: (path, data) => use((d) => d.writeFile(path, data)),
      suspend: async () => {},
      resume: async () => {},
      keepAlive: async () => {},
      destroy: async () => {},
    };
  }

  /** In use now: lastUsedAt (at most every 30 s) and the provider's idle timer. */
  touch(c: ComputerConfig, driver?: RemoteDriver, force = false): void {
    const now = this.now();
    if (!force && now - (this.touched.get(c.id) ?? 0) < TOUCH_EVERY_MS) return;
    this.touched.set(c.id, now);
    void driver?.keepAlive?.(computerIdleStopMinutes(c) * 60_000).catch(() => undefined);
    void this.update(c.id, c.kind as RemoteSandboxProvider, (cur) => ({ ...cur, lastUsedAt: new Date(now).toISOString() })).catch(() => undefined);
  }

  // ── Explicit operations (people, Polpo, MCP) ────────────────────────

  async start(c: ComputerConfig, sandbox: EffectiveSandbox): Promise<ComputerLive> {
    await this.ensure(c, sandbox);
    return this.live(c.id);
  }

  /** Stop (Daytona container: disk kept) or pause (E2B, Daytona VM: memory kept). Never deletes. */
  async stop(c: ComputerConfig): Promise<ComputerLive> {
    if (!isRemoteComputer(c)) throw new Error(`Computer "${c.id}" is this server: it cannot be stopped`);
    return this.exclusive(c.id, async () => {
      const provider = c.kind as RemoteSandboxProvider;
      const machines = await this.machines(c);
      for (const m of machines.filter((x) => computerStatusOf(provider, x.state) === "running")) {
        await this.setStatus(c, "stopping", { remoteId: m.remoteId });
        try {
          await this.adapter(provider).suspendById(m.remoteId);
        } catch (err) {
          await this.setStatus(c, "error", { lastError: `Could not stop it: ${(err as Error).message}` });
          throw err;
        }
      }
      return this.refreshLocked(c);
    });
  }

  async restart(c: ComputerConfig, sandbox: EffectiveSandbox): Promise<ComputerLive> {
    await this.stop(c);
    return this.start(c, sandbox);
  }

  /** Delete the machine and create a new one (everything on its disk is lost). */
  async reset(c: ComputerConfig, sandbox: EffectiveSandbox): Promise<ComputerLive> {
    if (!isRemoteComputer(c)) throw new Error(`Computer "${c.id}" is this server: it cannot be reset`);
    return this.exclusive(c.id, async () => {
      await this.removeMachines(c);
      await this.update(c.id, c.kind as RemoteSandboxProvider, (cur) => ({ provider: cur.provider, status: "missing", uptimeMs: 0, updatedAt: cur.updatedAt }));
      await this.ensureLocked(c, sandbox);
      return this.live(c.id);
    });
  }

  /** Delete the machine for good (and its runtime state). */
  async delete(c: ComputerConfig): Promise<void> {
    if (!isRemoteComputer(c)) return;
    await this.exclusive(c.id, async () => {
      await this.removeMachines(c);
      await this.update(c.id, c.kind as RemoteSandboxProvider, () => null);
    });
  }

  private async removeMachines(c: ComputerConfig): Promise<void> {
    const provider = c.kind as RemoteSandboxProvider;
    for (const m of await this.machines(c)) await this.adapter(provider).remove(m.remoteId);
  }

  /**
   * Live status from the provider (the state file follows it). `snapshot`: the Daytona snapshot a
   * new machine would come from; when the computer has no machine (or failed) and that snapshot
   * is not active, the answer says so (snapshotState).
   */
  async refresh(c: ComputerConfig, snapshot?: string): Promise<ComputerLive> {
    if (!isRemoteComputer(c)) return { id: c.id, status: "running", uptimeMinutes: 0 };
    const live = await this.refreshLocked(c);
    if (c.kind === "daytona" && snapshot && (live.status === "missing" || live.status === "error")) {
      const state = await this.snapshotState(snapshot);
      if (state && state !== "active") return { ...live, snapshotState: state };
    }
    return live;
  }

  private readonly snapshotStates = new Map<string, { state: string | undefined; at: number }>();

  /** A Daytona snapshot's state, cached for a minute. */
  async snapshotState(name: string): Promise<string | undefined> {
    const cached = this.snapshotStates.get(name);
    if (cached && this.now() - cached.at < 60_000) return cached.state;
    const state = await this.adapter("daytona").snapshotState?.(name).catch(() => undefined);
    this.snapshotStates.set(name, { state, at: this.now() });
    return state;
  }

  private async refreshLocked(c: ComputerConfig): Promise<ComputerLive> {
    const provider = c.kind as RemoteSandboxProvider;
    let machines: RemoteVmSummary[];
    try {
      machines = await this.machines(c);
    } catch (err) {
      return { ...this.live(c.id), status: "unknown", lastError: (err as Error).message ?? String(err) };
    }
    const [m] = machines;
    const status = m ? computerStatusOf(provider, m.state) : "missing";
    const cur = this.read()[c.id];
    if (!cur || cur.status !== status || cur.remoteId !== m?.remoteId) {
      await this.setStatus(c, status, m ? { remoteId: m.remoteId, ...(m.createdAt ? { createdAt: m.createdAt } : {}) } : { remoteId: undefined });
    }
    return this.live(c.id);
  }

  // ── Server upkeep ──────────────────────────────────────────────────

  /**
   * Stop computers nobody used for their idle time (never delete), and announce changes other
   * processes (task runners) made to the state file.
   */
  async idleTick(computers: readonly ComputerConfig[]): Promise<void> {
    const now = this.now();
    const state = this.read();
    for (const c of computers) {
      if (!isRemoteComputer(c)) continue;
      const rt = state[c.id];
      if (rt?.status !== "running") continue;
      const last = Date.parse(rt.lastUsedAt ?? rt.runningSince ?? rt.updatedAt);
      if (now - last < computerIdleStopMinutes(c) * 60_000) continue;
      await this.stop(c).catch(() => undefined);
    }
    // changes written by other processes
    const snapshot = JSON.stringify(this.read());
    if (this.lastSeen && snapshot !== this.lastSeen) {
      const before = JSON.parse(this.lastSeen) as Record<string, ComputerRuntime>;
      const after = JSON.parse(snapshot) as Record<string, ComputerRuntime>;
      for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const a = before[id];
        const b = after[id];
        if (a?.status !== b?.status || a?.remoteId !== b?.remoteId) this.announce(id, b);
      }
    }
    this.lastSeen = snapshot;
  }
}

const managers = new Map<string, ComputerManager>();

/** The computers of a project (one manager per .polpo directory and process). */
export function computerManager(polpoDir: string): ComputerManager {
  let m = managers.get(polpoDir);
  if (!m) {
    m = new ComputerManager(polpoDir);
    managers.set(polpoDir, m);
  }
  return m;
}

/** The project's manager, announcing status changes as computer:changed (once per process). */
export function computerManagerWithEvents(
  polpoDir: string,
  emit: (payload: { id: string; action: "status"; status: ComputerStatus; remoteId?: string; error?: string }) => void,
): ComputerManager {
  const m = computerManager(polpoDir);
  m.onChange ??= (id, live) => emit({ id, action: "status", status: live.status, ...(live.remoteId ? { remoteId: live.remoteId } : {}), ...(live.lastError ? { error: live.lastError } : {}) });
  return m;
}

/** Tests: replace the manager of a project. */
export function setComputerManager(polpoDir: string, manager: ComputerManager | undefined): void {
  if (manager) managers.set(polpoDir, manager);
  else managers.delete(polpoDir);
}

/** Server upkeep: the idle stop of every computer, once a minute. */
export class ComputerUpkeep {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(private readonly manager: ComputerManager, private readonly computers: () => readonly ComputerConfig[], private readonly onError?: (message: string) => void) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try { await this.manager.idleTick(this.computers()); }
    catch (err) { this.onError?.(`Computers upkeep failed: ${(err as Error).message}`); }
    finally { this.running = false; }
  }
}
