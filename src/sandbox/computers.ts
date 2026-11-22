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
 *   (Daytona v0 container) or pauses it (E2B, Daytona v0 VM class, memory kept). It is NEVER
 *   deleted automatically: only reset (delete + recreate) and delete, both asked for by a person.
 * - Daytona v2 hibernates instead (its Linux VMs cannot pause, and their wall clock, at most
 *   24 h, deletes them): stop/idle = a memory and disk snapshot, ready in seconds, then the VM is
 *   deleted ("hibernated") and older snapshots beyond providers.daytona.hibernate.keepSnapshots
 *   go; the next use (or start) makes a VM from the newest snapshot (files and running processes
 *   kept, ~3 s), re-applies its network rule and checks its tailnet again, and only then deletes
 *   older snapshots (keepSnapshots). A failed
 *   snapshot keeps the VM running (retried later). While it runs: a safety snapshot every few
 *   hours, and before the wall clock ends a rotation (snapshot, new VM) at a quiet moment. A VM
 *   that vanished anyway is restored from the last snapshot (with a notice). Commands that arrive
 *   while it hibernates or rotates wait for the new VM.
 * - The working directory is not wiped between runs (see remote.ts: computers skip the reset).
 * - Runtime state (status, remote id, last use, uptime as a rough cost signal) lives in
 *   .polpo/computers-state.json; the provider is the truth, the file a cache for the dashboard.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMPUTER_LABEL, computerEgressProblem, computerIdleStopMinutes, isRemoteComputer, tailnetEgressFor,
  type ComputerConfig, type ComputerStatus, type EffectiveSandbox, type RemoteSandboxProvider,
} from "@polpo-ai/core/sandbox";
import { acquireFileLock } from "./file-lock.js";
import { instanceLabel } from "./pool.js";
import { remoteAdapter, snapshotFailed, type Hibernation, type MachineSnapshot, type RemoteAdapter, type RemoteDriver, type RemoteVmSummary } from "./remote-adapters.js";
import { onComputerStarted, tailnetEgress, type TailnetHost, type TailnetStatus } from "./tailnet-egress.js";
import { liveHarnessSessions } from "../harness/live-sessions.js";

/** A computer's machine as a host for the tailnet runtime (commands and uploads through the provider). */
export function driverHost(driver: RemoteDriver): TailnetHost {
  return {
    exec: async (command, o = {}) => {
      const r = await driver.exec(command, { env: o.env, timeoutMs: o.timeoutMs });
      return { exitCode: r.timedOut ? 124 : r.exitCode, stdout: r.stdout, stderr: r.stderr };
    },
    writeFile: (path, data) => driver.writeFile(path, data),
  };
}

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
  /** Daytona v2: this computer's snapshots, oldest first (the newest ready one is what it wakes from). */
  snapshots?: ComputerSnapshotRecord[];
  /** Daytona v2: the snapshot the current machine was made from. */
  restoredFrom?: string;
  /** Daytona v2: when the current machine's wall clock deletes it (it is rotated before). */
  timeoutAt?: string;
  /** Daytona v2: no hibernation or safety snapshot before this (the last one failed). */
  retryAt?: string;
  /** Something worth knowing that is not an error (a VM restored after it vanished, a forced rotation). */
  notice?: string;
  /** Daytona v2: its VM vanished while it ran (found by a refresh); the next wake says so. */
  vanished?: boolean;
  /**
   * The computer was deleted (a tombstone): nothing may create a machine for it again (a run,
   * a tailnet check or a rotation that was still on its way). Cleared when it is created again.
   */
  deletedAt?: string;
  /**
   * When a refresh found that its machine (and, Daytona v2, every snapshot of it) was deleted at
   * the provider, outside Polpo (status "deleted"). Cleared when it gets a machine again.
   */
  deletedAtProvider?: string;
  /** What happened to it lately, oldest first (status changes and notices; the last ACTIVITY_KEEP). */
  activity?: ComputerActivityEntry[];
  updatedAt: string;
}

/** One line of a computer's activity: a status change, or a notice (a wake, a rotation, a failed snapshot). */
export interface ComputerActivityEntry {
  at: string;
  kind: "status" | "notice";
  status?: ComputerStatus;
  /** The status before (status changes). */
  from?: ComputerStatus;
  level?: "info" | "warn";
  message?: string;
  remoteId?: string;
}

/** Activity lines kept per computer. */
export const ACTIVITY_KEEP = 40;

/** A memory and disk snapshot of a computer's VM (Daytona v2). */
export interface ComputerSnapshotRecord {
  id: string;
  name: string;
  /** When it was taken. */
  at: string;
  status: "building" | "ready";
  diskBytes?: number;
  memoryBytes?: number;
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
  /** Daytona v2: the newest snapshot of its VM (what it wakes from when hibernated). */
  lastSnapshot?: { at: string; diskBytes?: number; memoryBytes?: number };
  /** Daytona v2: how many ready snapshots it keeps (snapshot storage is billed). */
  snapshotCount?: number;
  /** Something worth knowing that is not an error (a VM restored after it vanished, a forced rotation). */
  notice?: string;
  /** Status "deleted": when Polpo found its machine deleted at the provider. */
  deletedAtProvider?: string;
}

/** Between two checks that the machine still runs (a long chat may outlive the idle stop). */
const VERIFY_EVERY_MS = 60_000;
/** lastUsedAt is written at most this often per computer. */
const TOUCH_EVERY_MS = 30_000;
/** While a command runs, it keeps the computer in use this often. */
const HEARTBEAT_MS = 60_000;

/** The provider-side name of a computer's machine (Daytona v2 get-or-create): stable per instance and id. */
export function computerMachineName(labelValue: string): string {
  const slug = labelValue.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `polpo-computer-${slug}`.slice(0, 63);
}

/** A snapshot's name: `polpo-computer-<instance>-<id>-<UTC yyyymmddhhmmssSSS>` (snapshots carry no labels). */
export function computerSnapshotName(labelValue: string, at: number): string {
  return `${computerMachineName(labelValue)}-${new Date(at).toISOString().replace(/\D/g, "").slice(0, 17)}`;
}

/** Whether a snapshot name is one of this computer's (never another computer's or instance's). */
export function isComputerSnapshotName(labelValue: string, name: string): boolean {
  const prefix = `${computerMachineName(labelValue)}-`;
  return name.startsWith(prefix) && /^\d{17}$/.test(name.slice(prefix.length));
}

/** When a snapshot was taken, from its name (0 when it has none). */
function snapshotStamp(name: string): number {
  const m = /-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})$/.exec(name);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!, +m[7]!) : 0;
}

const READY = /^(ready|active|available)$/i;

/** Statuses of a machine being made or changed: another process may not have it listed yet. */
const TRANSITIONAL = new Set<ComputerStatus>(["creating", "starting", "stopping"]);
/** How long such a status is trusted without a machine to show for it. */
const TRANSITION_MS = 10 * 60_000;

/**
 * Whether the state knew a machine (or snapshots) for the computer: when the provider has none,
 * it was deleted outside Polpo ("deleted"), not "missing" (never made, or wiped by a reset).
 */
function hadMachine(rt: ComputerRuntime | undefined): boolean {
  if (!rt || rt.status === "missing") return false;
  if (rt.status === "deleted") return true;
  return !!rt.remoteId || !!rt.createdAt || !!rt.snapshots?.length || ["running", "stopped", "paused", "hibernated", "archived"].includes(rt.status);
}

/** The newest ready snapshot of a computer's runtime. */
function lastReady(rt: Pick<ComputerRuntime, "snapshots"> | undefined): ComputerSnapshotRecord | undefined {
  return [...(rt?.snapshots ?? [])].filter((x) => x.status === "ready").sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
}

function snapshotView(x: ComputerSnapshotRecord): NonNullable<ComputerLive["lastSnapshot"]> {
  return { at: x.at, ...(x.diskBytes !== undefined ? { diskBytes: x.diskBytes } : {}), ...(x.memoryBytes !== undefined ? { memoryBytes: x.memoryBytes } : {}) };
}

/** Provider states as computer statuses (Daytona v0 and v2 share most names). */
export function computerStatusOf(provider: RemoteSandboxProvider, state: string | undefined): ComputerStatus {
  const s = String(state ?? "").toLowerCase();
  if (provider === "e2b") return s === "running" ? "running" : s === "paused" ? "paused" : s ? "unknown" : "missing";
  switch (s) {
    case "started": return "running";
    case "stopped": return "stopped";
    case "paused": return "paused";
    case "hibernated": return "hibernated";
    case "archived": return "archived";
    case "queued": case "creating": case "pending_build": case "building_snapshot": case "pulling_snapshot": return "creating";
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
  /** Tests inject adapters, a clock and the waits. */
  adapter?: (provider: RemoteSandboxProvider) => RemoteAdapter;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** How often a building snapshot is checked. */
const SNAPSHOT_POLL_MS = 1_000;
/** How long a hibernation waits for the commands of this process to finish (a forced rotation: then it goes on). */
const DRAIN_MS = 60_000;
/** What a computer says after a new machine replaced one deleted at the provider. */
export const RECREATED_NOTICE = "Its machine had been deleted at the provider: a new one was made from the image (the files, tools and sign-ins it had are lost)";

/** How long a refresh's answer from the provider is reused (the list page asks for every computer). */
export const REFRESH_TTL_MS = 15_000;
/** How often the server checks every computer against its provider (one listing per provider). */
export const RECONCILE_EVERY_MS = 5 * 60_000;
/** The same when every provider in use pushes its machines' events (webhooks): a safety net. */
export const RECONCILE_WITH_WEBHOOKS_MS = 20 * 60_000;

/** A reset whose wipe is done tries this many times to make the new machine (the provider may lag a deletion). */
const RESET_CREATE_ATTEMPTS = 3;

/** A reset that wiped the computer but could not make its new machine yet (it is made on its next use). */
export class ComputerResetIncompleteError extends Error {
  constructor(readonly computerId: string, reason: string) {
    super(`Computer "${computerId}" was reset (its old machine, disk and snapshots are deleted), but its new machine could not be created yet: ${reason}. It is created on its next use or start; nothing else needs to be reset`);
    this.name = "ComputerResetIncompleteError";
  }
}

/** A computer that was deleted (or is being deleted): no machine is made for it. */
export class ComputerDeletedError extends Error {
  constructor(readonly computerId: string) {
    super(`Computer "${computerId}" was deleted: no machine is made for it (create it again to use it)`);
    this.name = "ComputerDeletedError";
  }
}

export class ComputerManager {
  /** Called when a computer's status, machine or error changes (the server emits computer:changed). */
  onChange?: (id: string, live: ComputerLive) => void;
  /** Hibernation news for the logs (rotations, failed snapshots, restored VMs). */
  onNotice?: (id: string, level: "info" | "warn", message: string) => void;
  private readonly file: string;
  private readonly instance: string;
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly touched = new Map<string, number>();
  /** Commands running now per computer (this process). */
  private readonly inFlight = new Map<string, number>();
  /** A hibernation or rotation in progress: commands wait for it. */
  private readonly gates = new Map<string, Promise<void>>();
  /** Bumped when a computer's VM is replaced or deleted (attached drivers reconnect). */
  private readonly epochs = new Map<string, number>();
  /** The sandbox each computer last ran with (a rotation makes the new VM with it). */
  private readonly sandboxes = new Map<string, EffectiveSandbox>();
  /** Computers being deleted, or deleted, by this process: nothing makes a machine for them again. */
  private readonly deleting = new Set<string>();
  private lastSeen = "";
  /**
   * Whether a computer is still in the configuration (the server sets it). A computer that is not
   * gets no machine; without it (task runners) the state file's tombstone (deletedAt) decides.
   */
  isConfigured?: (id: string) => boolean;

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

  private sleep(ms: number): Promise<void> {
    if (this.opts.sleep) return this.opts.sleep(ms);
    return new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString();
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
      if (next) {
        const at = new Date(this.now()).toISOString();
        // its history outlives a reset or a tombstone (they rewrite the runtime)
        let activity = next.activity ?? cur.activity;
        if (before ? before.status !== next.status : next.status !== "missing") {
          const entry: ComputerActivityEntry = {
            at, kind: "status", status: next.status, ...(before ? { from: before.status } : {}),
            ...(next.remoteId ? { remoteId: next.remoteId } : {}),
            ...(next.status === "error" && next.lastError ? { message: next.lastError } : {}),
          };
          activity = [...(activity ?? []), entry].slice(-ACTIVITY_KEEP);
        }
        all[id] = after = { ...next, ...(activity?.length ? { activity } : {}), updatedAt: at };
      }
      else delete all[id];
      mkdirSync(this.polpoDir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, computers: all } satisfies StateFile, null, 2));
      renameSync(tmp, this.file);
    } finally {
      release();
    }
    if (!after || before?.status !== after.status || before?.remoteId !== after.remoteId || before?.lastError !== after.lastError || before?.notice !== after.notice) {
      this.announce(id, after);
    }
    return after;
  }

  /** A notice for the logs (onNotice) and the computer's activity. */
  private notify(c: ComputerConfig, level: "info" | "warn", message: string): void {
    try { this.onNotice?.(c.id, level, message); } catch { /* listeners never change the operation */ }
    if (this.deleting.has(c.id)) return;
    void this.update(c.id, c.kind as RemoteSandboxProvider, (cur) => ({
      ...cur, activity: [...(cur.activity ?? []), { at: this.iso(), kind: "notice" as const, level, message }].slice(-ACTIVITY_KEEP),
    })).catch(() => undefined);
  }

  /** What the computer's page shows beyond its live status: snapshots, activity (newest first), timestamps. */
  detail(id: string): { snapshots: ComputerSnapshotRecord[]; activity: ComputerActivityEntry[]; updatedAt?: string; runningSince?: string; timeoutAt?: string; restoredFrom?: string } {
    const rt = this.read()[id];
    return {
      snapshots: [...(rt?.snapshots ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
      activity: [...(rt?.activity ?? [])].reverse(),
      ...(rt?.updatedAt ? { updatedAt: rt.updatedAt } : {}),
      ...(rt?.runningSince ? { runningSince: rt.runningSince } : {}),
      ...(rt?.timeoutAt ? { timeoutAt: rt.timeoutAt } : {}),
      ...(rt?.restoredFrom ? { restoredFrom: rt.restoredFrom } : {}),
    };
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
      ...(lastReady(rt) ? { lastSnapshot: snapshotView(lastReady(rt)!) } : {}),
      ...(rt?.snapshots?.some((x) => x.status === "ready") ? { snapshotCount: rt.snapshots.filter((x) => x.status === "ready").length } : {}),
      ...(rt?.notice ? { notice: rt.notice } : {}),
      ...(rt?.status === "deleted" && rt.deletedAtProvider ? { deletedAtProvider: rt.deletedAtProvider } : {}),
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
      if (status !== "deleted") delete next.deletedAtProvider;
      // its "deleted at the provider" notice ends with that status
      if (cur.status === "deleted" && status !== "deleted" && !("notice" in extra)) delete next.notice;
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

  /** Hibernation, when the computer's provider (as configured now) hibernates instead of pausing (Daytona v2). */
  private async hibernation(c: ComputerConfig): Promise<Hibernation | undefined> {
    if (c.kind !== "daytona") return undefined;
    try {
      return await this.adapter("daytona").hibernation?.();
    } catch {
      return undefined;
    }
  }

  /**
   * This computer's machines at the provider (normally one): running first, then the one the state
   * file knows, then newest. With hibernation the known machine is also read by id (the label
   * search may lag a VM made seconds ago).
   */
  private async machines(c: ComputerConfig, h?: Hibernation): Promise<RemoteVmSummary[]> {
    const provider = c.kind as RemoteSandboxProvider;
    const label = this.labelValue(c.id);
    let vms = (await this.adapter(provider).list({ [COMPUTER_LABEL]: label }))
      .filter((v) => v.labels?.[COMPUTER_LABEL] === label && computerStatusOf(provider, v.state) !== "missing");
    if (h) {
      // the label search lags (Daytona v2): a VM deleted seconds ago (a hibernation, a reset) is
      // still listed as started. Each hit is read again by id: a destroyed or deleted one is gone,
      // and the state is the current one
      const confirmed = await Promise.all(vms.map(async (v) => {
        const m = await h.machine(v.remoteId);
        return m && computerStatusOf(provider, m.state) !== "missing" ? { ...v, state: m.state } : undefined;
      }));
      vms = confirmed.filter((v): v is RemoteVmSummary => !!v);
    }
    const known = this.read()[c.id]?.remoteId;
    if (h && known && !vms.some((v) => v.remoteId === known)) {
      const m = await h.machine(known);
      if (m) vms.push({ remoteId: known, state: m.state, labels: { [COMPUTER_LABEL]: label } });
    }
    const rank = (v: RemoteVmSummary) => (computerStatusOf(provider, v.state) === "running" ? 0 : 2) + (v.remoteId === known ? 0 : 1);
    return vms.sort((a, b) => rank(a) - rank(b) || Date.parse(b.createdAt ?? "0") - Date.parse(a.createdAt ?? "0"));
  }

  /** Find by label; start or resume; create only when there is none. Call under exclusive(). */
  private async ensureLocked(c: ComputerConfig, sandbox: EffectiveSandbox, onWarning?: (message: string) => void, onProgress?: (message: string) => void): Promise<RemoteDriver> {
    const provider = c.kind as RemoteSandboxProvider;
    const adapter = this.adapter(provider);
    const idle = computerIdleStopMinutes(c);
    // under the computer's lock: a delete that ran before this (or a config without it) wins
    this.assertWanted(c);
    try {
      const h = await this.hibernation(c);
      if (h) return await this.ensureHibernating(c, sandbox, h, onWarning, onProgress);
      const before = this.read()[c.id];
      const [found] = await this.machines(c);
      if (found) {
        const wasRunning = computerStatusOf(provider, found.state) === "running";
        if (!wasRunning) await this.setStatus(c, "starting", { remoteId: found.remoteId });
        const driver = await adapter.connect(found.remoteId, { timeoutMs: idle * 60_000 });
        // where the provider can change it (Daytona v2), a computer follows its current network rule
        // when it starts or resumes (not on every check of a running one)
        if (!wasRunning && adapter.updateNetwork) {
          await adapter.updateNetwork(driver.remoteId, sandbox.network).catch((err) => onWarning?.(`Could not apply the computer's network rule: ${(err as Error).message}`));
        }
        await this.setStatus(c, "running", { remoteId: driver.remoteId, lastUsedAt: this.iso(), ...(found.createdAt ? { createdAt: found.createdAt } : {}) });
        // started or resumed: its tailnet daemons may be gone (checked again, brought up in the background)
        if (!wasRunning) this.started(c, driver);
        return driver;
      }
      // none: first use, or its machine was deleted outside Polpo (the state still knew one)
      const lost = !!before && (before.status === "deleted" || (!!before.remoteId && before.status !== "missing"));
      await this.setStatus(c, "creating", { remoteId: undefined });
      const driver = await this.createMachine(c, sandbox, onWarning, onProgress);
      const now = this.iso();
      await this.setStatus(c, "running", { remoteId: driver.remoteId, lastUsedAt: now, createdAt: now, notice: lost ? RECREATED_NOTICE : undefined });
      if (lost) this.recreated(c, onWarning);
      this.started(c, driver);
      return driver;
    } catch (err) {
      if (!(err instanceof ComputerDeletedError)) await this.setStatus(c, "error", { lastError: (err as Error).message ?? String(err) }).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Throws ComputerDeletedError when no machine may be made for the computer: it is being deleted
   * (or was, by this process), it is no longer in the configuration, or (another process) the
   * state file holds its tombstone.
   */
  private assertWanted(c: ComputerConfig): void {
    if (this.deleting.has(c.id)) throw new ComputerDeletedError(c.id);
    if (this.isConfigured) {
      if (!this.isConfigured(c.id)) throw new ComputerDeletedError(c.id);
      return;
    }
    if (this.read()[c.id]?.deletedAt) throw new ComputerDeletedError(c.id);
  }

  /** Whether this process deleted the computer (or is deleting it). */
  isDeleted(id: string): boolean {
    return this.deleting.has(id);
  }

  /** A computer created again with a deleted one's id: machines may be made for it again. */
  async revive(id: string): Promise<void> {
    this.deleting.delete(id);
    const rt = this.read()[id];
    if (rt?.deletedAt) await this.update(id, rt.provider, () => null);
  }

  /** A new machine from the image or snapshot of the settings. */
  private createMachine(c: ComputerConfig, sandbox: EffectiveSandbox, onWarning?: (message: string) => void, onProgress?: (message: string) => void): Promise<RemoteDriver> {
    const idle = computerIdleStopMinutes(c);
    const name = computerMachineName(this.labelValue(c.id));
    return this.adapter(c.kind as RemoteSandboxProvider).create({
      sandbox, labels: this.labels(c.id), lifetimeMinutes: idle, keep: true, onWarning, onProgress,
      // Daytona v2: a stable name (labels.name) for the machine; v0 and E2B ignore it. Its create
      // key is fresh per machine: a named create's own key is permanent, and the same name gets
      // a new machine after a hibernation, a reset or a lost VM
      name,
      idempotencyKey: `${name}:${this.now()}`,
      persistent: { idleStopMinutes: idle, ...(c.lifecycle?.autoArchiveDays ? { autoArchiveDays: c.lifecycle.autoArchiveDays } : {}) },
    });
  }

  // ── Hibernation (Daytona v2) ────────────────────────────────────────

  /**
   * ensure() where machines hibernate: the running VM; else wake from the newest snapshot; else a
   * new VM from the image. Call under exclusive().
   */
  private async ensureHibernating(c: ComputerConfig, sandbox: EffectiveSandbox, h: Hibernation, onWarning?: (message: string) => void, onProgress?: (message: string) => void): Promise<RemoteDriver> {
    const provider = c.kind as RemoteSandboxProvider;
    const adapter = this.adapter(provider);
    const before = this.read()[c.id];
    const machines = await this.machines(c, h);
    const live = machines.find((m) => ["running", "creating", "starting"].includes(computerStatusOf(provider, m.state)));
    let driver: RemoteDriver | undefined;
    if (live) {
      try {
        driver = await adapter.connect(live.remoteId, { timeoutMs: computerIdleStopMinutes(c) * 60_000 });
      } catch (err) {
        // deleted between the read and the connect (a hibernation or a reset): it wakes instead
        if ((await h.machine(live.remoteId).catch(() => "unknown")) !== undefined) throw err;
      }
    }
    if (driver) {
      const fresh = before?.status !== "running" || before.remoteId !== driver.remoteId;
      const timeoutAt = fresh || !before?.timeoutAt ? (await h.machine(driver.remoteId).catch(() => undefined))?.timeoutAt : before.timeoutAt;
      await this.setStatus(c, "running", { remoteId: driver.remoteId, lastUsedAt: this.iso(), ...(timeoutAt ? { timeoutAt } : {}) });
      if (fresh) this.started(c, driver);
      return driver;
    }
    // a VM of this computer that failed goes (its snapshots stay); one in another state (not seen
    // on v2) is left alone: a VM is never deleted without a snapshot (reset and delete remove it)
    for (const m of machines.filter((x) => computerStatusOf(provider, x.state) === "error")) await adapter.remove(m.remoteId).catch(() => undefined);
    // its VM was there (not hibernated by us): it vanished (wall clock, provider)
    const vanished = !!before?.vanished || (!!before?.remoteId && ["running", "starting", "stopping"].includes(before.status));
    return this.wake(c, sandbox, h, { vanished, deleted: before?.status === "deleted", onWarning, onProgress });
  }

  /**
   * The snapshots it may wake from, newest first: the ones the state knows and the provider's
   * listing of this computer's names (the state file may be lost; the listing may lag).
   */
  private async wakeCandidates(c: ComputerConfig, h: Hibernation): Promise<Array<ComputerSnapshotRecord & { tracked: boolean }>> {
    const tracked = (this.read()[c.id]?.snapshots ?? []).map((x) => ({ ...x, tracked: true }));
    const label = this.labelValue(c.id);
    const listed = (await h.listSnapshots((name) => isComputerSnapshotName(label, name)).catch(() => [] as MachineSnapshot[]))
      .filter((x) => READY.test(x.status) && !tracked.some((t) => t.id === x.id))
      .map((x) => ({ ...this.record(x, snapshotStamp(x.name) || Date.parse(x.createdAt ?? "") || 0), tracked: false }));
    return [...tracked, ...listed].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }

  private record(x: MachineSnapshot, at: number): ComputerSnapshotRecord {
    return {
      id: x.id, name: x.name, at: this.iso(at), status: READY.test(x.status) ? "ready" : "building",
      ...(x.bytes !== undefined ? { diskBytes: x.bytes } : {}), ...(x.memoryBytes !== undefined ? { memoryBytes: x.memoryBytes } : {}),
    };
  }

  /**
   * A new VM from the newest snapshot that still exists, with the computer's name, labels and
   * network rule; its tailnet is checked again; only then older snapshots are deleted. No snapshot
   * at all: a new VM from the image.
   */
  private async wake(c: ComputerConfig, sandbox: EffectiveSandbox, h: Hibernation, o: { vanished?: boolean; deleted?: boolean; onWarning?: (message: string) => void; onProgress?: (message: string) => void }): Promise<RemoteDriver> {
    this.assertWanted(c);
    const label = this.labelValue(c.id);
    const name = computerMachineName(label);
    const candidates = await this.wakeCandidates(c, h);
    const lost: string[] = [];
    for (const cand of candidates) {
      let snap = await h.getSnapshot(cand.id);
      if (snap && !READY.test(snap.status) && !snapshotFailed(snap.status)) snap = await this.waitReady(h, cand.id).catch(() => undefined);
      if (!snap || !READY.test(snap.status)) {
        // one the listing still shows after its deletion is not news; one the state knew is
        if (cand.tracked) lost.push(cand.name);
        await this.forgetSnapshot(c, cand.id);
        continue;
      }
      await this.setStatus(c, "starting", { remoteId: undefined, timeoutAt: undefined });
      o.onProgress?.(`Waking the computer from its snapshot of ${cand.at}`);
      const driver = await h.restore(cand.id, { name, labels: this.labels(c.id), network: sandbox.network, idempotencyKey: `${name}:wake:${cand.id}:${this.now()}` });
      const timeoutAt = (await h.machine(driver.remoteId).catch(() => undefined))?.timeoutAt;
      const notice = o.vanished
        ? `Its VM was gone (wall clock or provider): restored from the snapshot of ${cand.at}; changes made after it are lost`
        : lost.length ? `Newer snapshots were gone (${lost.join(", ")}): woke from the snapshot of ${cand.at}` : undefined;
      const { tracked: _tracked, ...rec } = cand;
      await this.update(c.id, "daytona", (cur) => ({ ...cur, snapshots: (cur.snapshots ?? []).some((x) => x.id === rec.id) ? cur.snapshots : [...(cur.snapshots ?? []), { ...rec, status: "ready" }] }));
      await this.setStatus(c, "running", {
        remoteId: driver.remoteId, restoredFrom: cand.id, lastUsedAt: this.iso(), timeoutAt, notice, retryAt: undefined, vanished: undefined,
      });
      this.bump(c.id);
      if (notice) this.notify(c, "warn", notice);
      // its tailnet daemons came back with the memory: checked again (brought up when they did not)
      this.started(c, driver);
      // older snapshots go only now that a VM runs from this one
      await this.pruneSnapshots(c, h, cand.id).catch((err) => this.notify(c, "warn", `Could not delete old snapshots: ${(err as Error).message}`));
      return driver;
    }
    // first use, or every snapshot is gone: a new VM from the image
    await this.setStatus(c, "creating", { remoteId: undefined, timeoutAt: undefined, restoredFrom: undefined });
    const driver = await this.createMachine(c, sandbox, o.onWarning, o.onProgress);
    const timeoutAt = (await h.machine(driver.remoteId).catch(() => undefined))?.timeoutAt;
    const notice = o.deleted ? RECREATED_NOTICE : o.vanished || lost.length ? `Its VM and its snapshots were gone: a new VM from the image (its files are lost)` : undefined;
    const now = this.iso();
    await this.setStatus(c, "running", { remoteId: driver.remoteId, lastUsedAt: now, createdAt: now, timeoutAt, notice, retryAt: undefined, vanished: undefined });
    this.bump(c.id);
    if (o.deleted) this.recreated(c, o.onWarning);
    else if (notice) this.notify(c, "warn", notice);
    this.started(c, driver);
    return driver;
  }

  /** A new machine replaced one deleted at the provider: the logs and the run that asked hear it. */
  private recreated(c: ComputerConfig, onWarning?: (message: string) => void): void {
    this.notify(c, "warn", RECREATED_NOTICE);
    try { onWarning?.(`Computer "${c.id}": ${RECREATED_NOTICE}`); } catch { /* never changes the start */ }
  }

  private bump(id: string): void {
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
  }

  /** Wait until a snapshot is ready (bounded by snapshotTimeoutSeconds); throws when it fails or takes too long. */
  private async waitReady(h: Hibernation, id: string): Promise<MachineSnapshot> {
    const deadline = this.now() + h.settings.snapshotTimeoutSeconds * 1000;
    for (;;) {
      const snap = await h.getSnapshot(id);
      if (!snap) throw new Error("the snapshot is gone");
      if (READY.test(snap.status)) return snap;
      if (snapshotFailed(snap.status)) throw new Error(`the snapshot ${snap.status}${snap.error ? `: ${snap.error}` : ""}`);
      if (this.now() >= deadline) throw new Error(`the snapshot was not ready after ${h.settings.snapshotTimeoutSeconds} s (still ${snap.status || "building"})`);
      await this.sleep(SNAPSHOT_POLL_MS);
    }
  }

  /**
   * A memory and disk snapshot of the running VM, ready (the VM keeps running). Recorded in the
   * state while it builds; a failed one is deleted and forgotten, and the error thrown.
   */
  private async takeSnapshot(c: ComputerConfig, h: Hibernation, remoteId: string): Promise<ComputerSnapshotRecord> {
    const at = this.now();
    const name = computerSnapshotName(this.labelValue(c.id), at);
    const started = await h.snapshot(remoteId, name);
    const building = this.record(started, at);
    await this.update(c.id, "daytona", (cur) => ({ ...cur, snapshots: [...(cur.snapshots ?? []), { ...building, status: "building" }] }));
    try {
      const ready = READY.test(started.status) ? started : await this.waitReady(h, started.id);
      const rec = { ...this.record(ready, at), status: "ready" as const };
      await this.update(c.id, "daytona", (cur) => ({ ...cur, snapshots: (cur.snapshots ?? []).map((x) => (x.id === rec.id ? rec : x)) }));
      return rec;
    } catch (err) {
      await h.deleteSnapshot(started.id).catch(() => undefined);
      await this.forgetSnapshot(c, started.id);
      throw err;
    }
  }

  private forgetSnapshot(c: ComputerConfig, id: string): Promise<unknown> {
    return this.update(c.id, "daytona", (cur) => ({ ...cur, snapshots: (cur.snapshots ?? []).filter((x) => x.id !== id) }));
  }

  /**
   * Delete this computer's snapshots but the newest keepSnapshots ready ones and `keep` (the one
   * its VM runs from). Only snapshots named for this computer are ever touched.
   */
  private async pruneSnapshots(c: ComputerConfig, h: Hibernation, keep?: string): Promise<void> {
    const label = this.labelValue(c.id);
    const tracked = this.read()[c.id]?.snapshots ?? [];
    const listed = await h.listSnapshots((name) => isComputerSnapshotName(label, name)).catch(() => [] as MachineSnapshot[]);
    const all = new Map<string, { id: string; at: number; ready: boolean }>();
    for (const x of listed) if (!/building|pending|creat/i.test(x.status)) all.set(x.id, { id: x.id, at: snapshotStamp(x.name), ready: READY.test(x.status) });
    for (const x of tracked) if (x.status === "ready") all.set(x.id, { id: x.id, at: Date.parse(x.at), ready: true });
    const newest = [...all.values()].filter((x) => x.ready).sort((a, b) => b.at - a.at).slice(0, h.settings.keepSnapshots).map((x) => x.id);
    const keepIds = new Set([...newest, ...(keep ? [keep] : [])]);
    for (const x of all.values()) {
      if (keepIds.has(x.id)) continue;
      await h.deleteSnapshot(x.id);
      await this.forgetSnapshot(c, x.id);
    }
  }

  /** Every snapshot of this computer (tracked or listed by its name): reset and delete. */
  private async deleteSnapshots(c: ComputerConfig, h: Hibernation): Promise<void> {
    const label = this.labelValue(c.id);
    const ids = new Set((this.read()[c.id]?.snapshots ?? []).map((x) => x.id));
    for (const x of await h.listSnapshots((name) => isComputerSnapshotName(label, name))) ids.add(x.id);
    for (const id of ids) {
      await h.deleteSnapshot(id);
      await this.forgetSnapshot(c, id);
    }
  }

  /** Commands of this process on the computer finish (at most maxMs). */
  private async drain(id: string, maxMs: number): Promise<boolean> {
    const until = this.now() + maxMs;
    while ((this.inFlight.get(id) ?? 0) > 0) {
      if (this.now() >= until) return false;
      await this.sleep(250);
    }
    return true;
  }

  /** Run fn while commands on the computer wait (they reconnect after it). */
  private async gated<T>(id: string, fn: () => Promise<T>): Promise<T> {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const prev = this.gates.get(id);
    this.gates.set(id, gate);
    try {
      await prev;
      return await fn();
    } finally {
      open();
      if (this.gates.get(id) === gate) this.gates.delete(id);
    }
  }

  /**
   * Hibernate (call under exclusive and gated): a ready snapshot of the running VM, then the VM is
   * deleted. When the snapshot fails the VM keeps running (lastError, retried after retryMinutes)
   * and the error is thrown.
   */
  private async hibernateLocked(c: ComputerConfig, h: Hibernation, why: "stop" | "idle" | "rotate", force = false): Promise<"hibernated" | "nothing"> {
    const provider = c.kind as RemoteSandboxProvider;
    const running = (await this.machines(c, h)).filter((m) => computerStatusOf(provider, m.state) === "running");
    const [m] = running;
    if (!m) {
      await this.refreshLocked(c, h);
      return "nothing";
    }
    if (!(await this.drain(c.id, force ? DRAIN_MS : why === "rotate" ? DRAIN_MS / 2 : DRAIN_MS))) {
      if (!force) throw new Error("commands are still running on it");
      this.notify(c, "warn", "Rotating while commands still run: they are cut");
    }
    // agent harnesses on it detach (their bridge lives on in the snapshot) and re-attach to the new VM
    await liveHarnessSessions.beforeVmGoes(c.id, "memory", why);
    await this.setStatus(c, "stopping", { remoteId: m.remoteId });
    try {
      await this.takeSnapshot(c, h, m.remoteId);
    } catch (err) {
      const message = `Could not hibernate (${why}): ${(err as Error).message}. It keeps running; tried again in ${h.settings.retryMinutes} min`;
      await this.setStatus(c, "running", { remoteId: m.remoteId, lastError: message, retryAt: this.iso(this.now() + h.settings.retryMinutes * 60_000) });
      throw new Error(message);
    }
    // its memory and disk saved: the VM can go (only that one: a VM is never deleted without a snapshot)
    tailnetEgress.invalidate(c.id);
    try {
      await this.adapter(provider).remove(m.remoteId);
    } catch (err) {
      const message = `Its snapshot is saved, but its VM could not be deleted (${why}): ${(err as Error).message}. It keeps running; tried again in ${h.settings.retryMinutes} min`;
      await this.setStatus(c, "running", { remoteId: m.remoteId, lastError: message, retryAt: this.iso(this.now() + h.settings.retryMinutes * 60_000) });
      throw new Error(message);
    }
    this.bump(c.id);
    await this.setStatus(c, "hibernated", { remoteId: undefined, timeoutAt: undefined, retryAt: undefined, notice: undefined, restoredFrom: undefined });
    // its VM is gone and the new snapshot is ready: a hibernated computer keeps only the newest
    // keepSnapshots (before, the one it had woken from stayed too until the next wake)
    await this.pruneSnapshots(c, h).catch((err) => this.notify(c, "warn", `Could not delete old snapshots: ${(err as Error).message}`));
    return "hibernated";
  }

  /**
   * Before the VM's wall clock deletes it: snapshot it and make the new VM from that snapshot
   * (a pause of a few seconds; commands wait). Without a sandbox to make the VM with, it stays
   * hibernated until its next use.
   */
  private async rotate(c: ComputerConfig, h: Hibernation, sandbox: EffectiveSandbox | undefined, force: boolean): Promise<void> {
    await this.gated(c.id, () => this.exclusive(c.id, async () => {
      if ((await this.hibernateLocked(c, h, "rotate", force)) !== "hibernated") return;
      const message = force
        ? "Rotated through a snapshot before its VM's wall clock while it was busy: a pause of a few seconds"
        : "Rotated through a snapshot before its VM's wall clock";
      this.notify(c, force ? "warn" : "info", message);
      if (!sandbox) return;
      await this.wake(c, sandbox, h, {});
      if (force) await this.update(c.id, "daytona", (cur) => ({ ...cur, notice: message }));
    }));
  }

  /** A safety snapshot while it runs (the VM keeps running); older ones are pruned. */
  private async safetySnapshot(c: ComputerConfig, h: Hibernation): Promise<void> {
    await this.exclusive(c.id, async () => {
      const provider = c.kind as RemoteSandboxProvider;
      const m = (await this.machines(c, h)).find((x) => computerStatusOf(provider, x.state) === "running");
      if (!m) return;
      try {
        await this.takeSnapshot(c, h, m.remoteId);
      } catch (err) {
        const message = `Safety snapshot failed: ${(err as Error).message}. Tried again in ${h.settings.retryMinutes} min`;
        await this.update(c.id, "daytona", (cur) => ({ ...cur, retryAt: this.iso(this.now() + h.settings.retryMinutes * 60_000) }));
        this.notify(c, "warn", message);
        return;
      }
      await this.pruneSnapshots(c, h, this.read()[c.id]?.restoredFrom).catch(() => undefined);
    });
  }

  /** After a start, resume or create (tests replace it). */
  started(c: ComputerConfig, driver: RemoteDriver): void {
    try { onComputerStarted(c, driverHost(driver)); } catch { /* never changes the start */ }
  }

  /**
   * Run fn on the computer's machine when it is running now (never starts or resumes it):
   * undefined when it is not running.
   */
  async whenRunning<T>(c: ComputerConfig, fn: (driver: RemoteDriver) => Promise<T>): Promise<T | undefined> {
    if (!isRemoteComputer(c)) return undefined;
    const provider = c.kind as RemoteSandboxProvider;
    const running = (await this.machines(c, await this.hibernation(c))).find((m) => computerStatusOf(provider, m.state) === "running");
    if (!running) return undefined;
    const driver = await this.adapter(provider).connect(running.remoteId, { timeoutMs: computerIdleStopMinutes(c) * 60_000 });
    return fn(driver);
  }

  /** The computer's machine, running (started, resumed, woken from its snapshot or created). */
  async ensure(c: ComputerConfig, sandbox: EffectiveSandbox, onWarning?: (message: string) => void, onProgress?: (message: string) => void): Promise<RemoteDriver> {
    if (!isRemoteComputer(c)) throw new Error(`Computer "${c.id}" is this server: there is no machine to start`);
    this.assertWanted(c);
    this.sandboxes.set(c.id, sandbox);
    return this.exclusive(c.id, () => this.ensureLocked(c, sandbox, onWarning, onProgress));
  }

  /**
   * A driver for a run (chat or task) on the computer: commands and file operations keep it in use
   * and, after a minute, check it still runs (starting it again if it was stopped meanwhile).
   * While it hibernates or rotates, commands wait and then go to the new VM.
   * Suspending and destroying are no-ops: the computer outlives every run.
   */
  async attach(c: ComputerConfig, sandbox: EffectiveSandbox, onWarning?: (message: string) => void, onProgress?: (message: string) => void): Promise<RemoteDriver> {
    let inner = await this.ensure(c, sandbox, onWarning, onProgress);
    let epoch = this.epochs.get(c.id) ?? 0;
    let verifiedAt = this.now();
    const fresh = async (force = false): Promise<RemoteDriver> => {
      await this.gates.get(c.id);
      if (force || (this.epochs.get(c.id) ?? 0) !== epoch || this.now() - verifiedAt > VERIFY_EVERY_MS) {
        inner = await this.ensure(c, sandbox, onWarning, onProgress);
        epoch = this.epochs.get(c.id) ?? 0;
        verifiedAt = this.now();
      }
      return inner;
    };
    const use = async <T>(fn: (d: RemoteDriver) => Promise<T>): Promise<T> => {
      let d = await fresh();
      this.inFlight.set(c.id, (this.inFlight.get(c.id) ?? 0) + 1);
      this.touch(c, d);
      const beat = setInterval(() => this.touch(c, d, true), HEARTBEAT_MS);
      beat.unref?.();
      try {
        let out: T;
        try {
          out = await fn(d);
        } catch (err) {
          // its VM was replaced or hibernated meanwhile (by another process), or deleted at the
          // provider (outside Polpo): once more on the new one (ensure makes it again)
          const now = this.read()[c.id];
          const replaced = !!now && now.remoteId !== d.remoteId && ["running", "hibernated"].includes(now.status);
          if (!replaced && (this.deleting.has(c.id) || await this.machineRuns(c, d.remoteId))) throw err;
          d = await fresh(true);
          out = await fn(d);
        }
        verifiedAt = this.now();
        return out;
      } finally {
        clearInterval(beat);
        this.inFlight.set(c.id, Math.max(0, (this.inFlight.get(c.id) ?? 1) - 1));
        this.touch(c, d);
      }
    };
    // long-running processes and port endpoints go to the current VM (a new one after a wake) but
    // do not count as a command in flight: a harness turn holds the computer instead (hold)
    const current = async (): Promise<RemoteDriver> => {
      const d = await fresh();
      this.touch(c, d);
      return d;
    };
    // a process or a port on a machine that was deleted at the provider: on a new one
    const onCurrent = async <T>(fn: (d: RemoteDriver) => Promise<T>): Promise<T> => {
      const d = await current();
      try {
        return await fn(d);
      } catch (err) {
        if (this.deleting.has(c.id) || await this.machineRuns(c, d.remoteId)) throw err;
        return fn(await fresh(true));
      }
    };
    const missing = (what: string) => new Error(`Computer "${c.id}" (${c.kind}) cannot ${what}: its provider has no process API here (agent harnesses need a Daytona v2 computer)`);
    return {
      get remoteId() { return inner.remoteId; },
      exec: (command, o) => use((d) => d.exec(command, o)),
      readFile: (path) => use((d) => d.readFile(path)),
      writeFile: (path, data) => use((d) => d.writeFile(path, data)),
      suspend: async () => {},
      resume: async () => {},
      keepAlive: async () => {},
      destroy: async () => {},
      ...(inner.spawn ? {
        spawn: (command: string, o: { cwd?: string; env?: Record<string, string> }) => onCurrent((d) => {
          if (!d.spawn) throw missing("start processes");
          return d.spawn(command, o);
        }),
        connectProcess: async (id: string) => {
          const d = await current();
          if (!d.connectProcess) throw missing("follow processes");
          return d.connectProcess(id);
        },
        portEndpoint: (port: number, o?: { protocol?: "http" | "https" | "ws"; ttlSeconds?: number }) => onCurrent((d) => {
          if (!d.portEndpoint) throw missing("expose ports");
          return d.portEndpoint(port, o);
        }),
      } : {}),
      hold: () => this.hold(c, () => inner),
    };
  }

  /**
   * The computer is in use until the returned function is called (a harness turn: the model works
   * in the VM through its own process, without Polpo commands): it counts as a command in flight
   * (an idle hibernation waits, a rotation drains it) and keeps lastUsedAt fresh.
   */
  hold(c: ComputerConfig, driver: () => RemoteDriver | undefined = () => undefined): () => void {
    this.inFlight.set(c.id, (this.inFlight.get(c.id) ?? 0) + 1);
    this.touch(c, driver(), true);
    const beat = setInterval(() => this.touch(c, driver(), true), HEARTBEAT_MS);
    beat.unref?.();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      clearInterval(beat);
      this.inFlight.set(c.id, Math.max(0, (this.inFlight.get(c.id) ?? 1) - 1));
      this.touch(c, driver());
    };
  }

  /**
   * Whether a machine still runs at the provider: false when it is gone (deleted outside Polpo) or
   * not running. When the provider cannot be asked: true (the caller's error stands).
   */
  async machineRuns(c: ComputerConfig, remoteId: string): Promise<boolean> {
    const provider = c.kind as RemoteSandboxProvider;
    try {
      const h = await this.hibernation(c);
      if (h) {
        const m = await h.machine(remoteId);
        return !!m && computerStatusOf(provider, m.state) === "running";
      }
      return (await this.machines(c)).some((v) => v.remoteId === remoteId && computerStatusOf(provider, v.state) === "running");
    } catch {
      return true;
    }
  }

  /** In use now: lastUsedAt (at most every 30 s) and the provider's idle timer. */
  touch(c: ComputerConfig, driver?: RemoteDriver, force = false): void {
    if (this.deleting.has(c.id)) return;
    const now = this.now();
    if (!force && now - (this.touched.get(c.id) ?? 0) < TOUCH_EVERY_MS) return;
    this.touched.set(c.id, now);
    void driver?.keepAlive?.(computerIdleStopMinutes(c) * 60_000).catch(() => undefined);
    void this.update(c.id, c.kind as RemoteSandboxProvider, (cur) => ({ ...cur, lastUsedAt: new Date(now).toISOString() })).catch(() => undefined);
  }

  // ── Explicit operations (people, Polpo, MCP) ────────────────────────

  /** Start, resume, or wake from its snapshot (Daytona v2). */
  async start(c: ComputerConfig, sandbox: EffectiveSandbox): Promise<ComputerLive> {
    await this.ensure(c, sandbox);
    return this.live(c.id);
  }

  /**
   * Stop (Daytona v0 container: disk kept), pause (E2B, Daytona v0 VM: memory kept) or hibernate
   * (Daytona v2: memory and disk snapshot, then the VM is deleted). Never loses the machine.
   */
  async stop(c: ComputerConfig, why: "stop" | "idle" = "stop"): Promise<ComputerLive> {
    if (!isRemoteComputer(c)) throw new Error(`Computer "${c.id}" is this server: it cannot be stopped`);
    if (this.deleting.has(c.id)) return this.live(c.id);
    const h = await this.hibernation(c);
    if (h) {
      await this.gated(c.id, () => this.exclusive(c.id, () => this.hibernateLocked(c, h, why)));
      return this.live(c.id);
    }
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

  /** Delete the machine (and, Daytona v2, every snapshot of it) and create a new one: everything on its disk is lost. */
  async reset(c: ComputerConfig, sandbox: EffectiveSandbox): Promise<ComputerLive> {
    if (!isRemoteComputer(c)) throw new Error(`Computer "${c.id}" is this server: it cannot be reset`);
    this.sandboxes.set(c.id, sandbox);
    this.assertWanted(c);
    return this.exclusive(c.id, async () => {
      await this.removeMachines(c);
      await this.update(c.id, c.kind as RemoteSandboxProvider, (cur) => ({ provider: cur.provider, status: "missing", uptimeMs: 0, updatedAt: cur.updatedAt }));
      // its disk is gone now: from the person's view the reset succeeds, or says that the wipe is
      // done. The new machine is tried a few times (the provider may still list the deleted VM)
      let last: unknown;
      for (let attempt = 1; attempt <= RESET_CREATE_ATTEMPTS; attempt++) {
        try {
          await this.ensureLocked(c, sandbox);
          return this.live(c.id);
        } catch (err) {
          if (err instanceof ComputerDeletedError) throw err;
          last = err;
          if (attempt < RESET_CREATE_ATTEMPTS) await this.sleep(2_000 * attempt);
        }
      }
      // nothing to retry by the person: its next use or start makes the machine
      await this.setStatus(c, "missing", { lastError: undefined }).catch(() => undefined);
      throw new ComputerResetIncompleteError(c.id, (last as Error)?.message ?? String(last));
    });
  }

  /** Delete the machine for good (and its snapshots and runtime state). */
  async delete(c: ComputerConfig): Promise<void> {
    if (!isRemoteComputer(c)) return;
    // from now on nothing makes a machine for it: a run, a tailnet check or a wake queued behind
    // this delete (or started after it) fails instead of bringing its VM back
    this.deleting.add(c.id);
    tailnetEgress.invalidate(c.id);
    try {
      await this.exclusive(c.id, async () => {
        await this.removeMachines(c);
        // a tombstone for other processes (task runners): no machine for it until it is created again
        await this.update(c.id, c.kind as RemoteSandboxProvider, (cur) => ({ provider: cur.provider, status: "missing", uptimeMs: 0, deletedAt: this.iso(), updatedAt: cur.updatedAt }));
      });
    } catch (err) {
      // its machine may still be there: the computer is not deleted (it can be used, or deleted again)
      this.deleting.delete(c.id);
      throw err;
    }
    this.sandboxes.delete(c.id);
    this.touched.delete(c.id);
  }

  /** Its machines (leaving the tailnet first) and, where it hibernates, every snapshot of it. */
  private async removeMachines(c: ComputerConfig): Promise<void> {
    const provider = c.kind as RemoteSandboxProvider;
    // its processes are lost: agent harnesses on it stop (their next turn starts a new bridge)
    await liveHarnessSessions.beforeVmGoes(c.id, "disk", "reset");
    const h = await this.hibernation(c);
    const machines = await this.machines(c, h);
    // the one the state knows too (a VM made seconds ago may not be listed yet)
    const known = this.read()[c.id]?.remoteId;
    if (h && known && !machines.some((m) => m.remoteId === known)) {
      const m = await h.machine(known).catch(() => undefined);
      if (m) machines.push({ remoteId: known, state: m.state, labels: { [COMPUTER_LABEL]: this.labelValue(c.id) } });
    }
    for (const m of machines) {
      // a machine in the tailnet leaves it first (best effort; an ephemeral node also goes by itself)
      if (c.egress && computerStatusOf(provider, m.state) === "running") await this.leaveTailnet(c, m.remoteId);
      await this.adapter(provider).remove(m.remoteId);
    }
    if (h) await this.deleteSnapshots(c, h);
    this.bump(c.id);
    tailnetEgress.invalidate(c.id);
  }

  private async leaveTailnet(c: ComputerConfig, remoteId: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const driver = await this.adapter(c.kind as RemoteSandboxProvider).connect(remoteId, { timeoutMs: computerIdleStopMinutes(c) * 60_000 });
      await Promise.race([tailnetEgress.logout(driverHost(driver), c.id), new Promise((r) => { timer = setTimeout(r, 30_000); })]);
    } catch { /* best effort */ } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Live status from the provider (the state file follows it). `snapshot`: the Daytona snapshot a
   * new machine would come from; when the computer has no machine (or failed) and that snapshot
   * is not active, the answer says so (snapshotState).
   */
  async refresh(c: ComputerConfig, snapshot?: string, o: { force?: boolean } = {}): Promise<ComputerLive> {
    if (!isRemoteComputer(c)) return { id: c.id, status: "running", uptimeMinutes: 0 };
    if (this.deleting.has(c.id)) return this.live(c.id);
    // an operation in progress here writes the state itself (no flicker from a half-done hibernation)
    if (this.chains.has(c.id)) return this.live(c.id);
    // asked a moment ago: the state file has the answer (operations write it too)
    const asked = this.refreshedAt.get(c.id);
    let live: ComputerLive;
    if (!o.force && asked !== undefined && this.now() - asked < REFRESH_TTL_MS) live = this.live(c.id);
    else {
      live = await this.refreshLocked(c, await this.hibernation(c));
      if (live.status !== "unknown") this.refreshedAt.set(c.id, this.now());
    }
    if (c.kind === "daytona" && snapshot && (live.status === "missing" || live.status === "deleted" || live.status === "error")) {
      const state = await this.snapshotState(snapshot);
      if (state && state !== "active") return { ...live, snapshotState: state };
    }
    return live;
  }

  private readonly snapshotStates = new Map<string, { state: string | undefined; at: number }>();
  /** When each computer was last checked at its provider (refresh's cache). */
  private readonly refreshedAt = new Map<string, number>();

  /** A Daytona snapshot's state, cached for a minute. */
  async snapshotState(name: string): Promise<string | undefined> {
    const cached = this.snapshotStates.get(name);
    if (cached && this.now() - cached.at < 60_000) return cached.state;
    const state = await this.adapter("daytona").snapshotState?.(name).catch(() => undefined);
    this.snapshotStates.set(name, { state, at: this.now() });
    return state;
  }

  /**
   * The provider's view written to the state. Where machines hibernate, no machine but a ready
   * snapshot is "hibernated"; a VM that vanished while running says so (its next use restores it).
   */
  private async refreshLocked(c: ComputerConfig, h?: Hibernation): Promise<ComputerLive> {
    const provider = c.kind as RemoteSandboxProvider;
    let machines: RemoteVmSummary[];
    let snap: ComputerSnapshotRecord | undefined;
    const before = this.read()[c.id];
    try {
      machines = await this.machines(c, h);
      // another process is making or changing its machine (not listed yet): left to it
      if (!machines.length && before && TRANSITIONAL.has(before.status) && this.now() - Date.parse(before.updatedAt) < TRANSITION_MS) return this.live(c.id);
      // where it hibernates, the snapshot it would wake from must still be there (it may have been
      // deleted at the provider): checked by id, else found in the provider's listing
      if (!machines.length && h) snap = await this.verifiedSnapshot(c, h);
    } catch (err) {
      return { ...this.live(c.id), status: "unknown", lastError: (err as Error).message ?? String(err) };
    }
    const [m] = machines;
    const cur = this.read()[c.id];
    let status: ComputerStatus = m ? computerStatusOf(provider, m.state) : "missing";
    let notice: string | undefined;
    if (!m && snap) {
      status = "hibernated";
      if (cur?.remoteId && cur.status === "running") {
        notice = `Its VM is gone (wall clock or provider): its next use restores it from the snapshot of ${snap.at}`;
      }
    } else if (!m && hadMachine(cur)) {
      status = "deleted";
    }
    if (status === "deleted" && cur?.status !== "deleted") {
      await this.deletedAtProvider(c, !!h);
    } else if (!cur || cur.status !== status || cur.remoteId !== m?.remoteId) {
      await this.setStatus(c, status, m
        ? { remoteId: m.remoteId, ...(m.createdAt ? { createdAt: m.createdAt } : {}) }
        : { remoteId: undefined, timeoutAt: undefined, ...(notice ? { notice, vanished: true } : {}) });
      if (notice) this.notify(c, "warn", notice);
    }
    return this.live(c.id);
  }

  /**
   * Its machine (and, where it hibernates, every snapshot) was deleted at the provider: the state
   * says so (status "deleted", no machine, no snapshots), the logs too, and agent harnesses on it
   * stop (their next turn starts a new bridge on the machine its next use makes).
   */
  private async deletedAtProvider(c: ComputerConfig, hibernates: boolean): Promise<void> {
    const notice = `Its machine${hibernates ? " and its snapshots were" : " was"} deleted at the provider, outside Polpo: `
      + "its next use (or Recreate) makes a new one from the image, without its files; or remove it from Polpo";
    await this.setStatus(c, "deleted", {
      remoteId: undefined, timeoutAt: undefined, restoredFrom: undefined, retryAt: undefined, vanished: undefined,
      snapshots: [], notice, deletedAtProvider: this.iso(),
    });
    this.bump(c.id);
    tailnetEgress.invalidate(c.id);
    this.notify(c, "warn", notice);
    void liveHarnessSessions.beforeVmGoes(c.id, "disk", "deleted at the provider").catch(() => undefined);
  }

  /**
   * The newest ready snapshot of the computer that still exists at the provider (Daytona v2). The
   * ones the state knows are read by id (newest first; a gone one is forgotten); without any, the
   * provider's listing of its names (the state file may be lost) — the newest is recorded.
   */
  private async verifiedSnapshot(c: ComputerConfig, h: Hibernation): Promise<ComputerSnapshotRecord | undefined> {
    const tracked = [...(this.read()[c.id]?.snapshots ?? [])].filter((x) => x.status === "ready").sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    for (const x of tracked) {
      const snap = await h.getSnapshot(x.id);
      if (snap && READY.test(snap.status)) return x;
      await this.forgetSnapshot(c, x.id);
    }
    const label = this.labelValue(c.id);
    const [newest] = (await h.listSnapshots((name) => isComputerSnapshotName(label, name)))
      .filter((x) => READY.test(x.status))
      .sort((a, b) => snapshotStamp(b.name) - snapshotStamp(a.name));
    if (!newest) return undefined;
    const rec: ComputerSnapshotRecord = { ...this.record(newest, snapshotStamp(newest.name) || Date.parse(newest.createdAt ?? "") || this.now()), status: "ready" };
    await this.update(c.id, "daytona", (cur) => ({ ...cur, snapshots: [...(cur.snapshots ?? []).filter((x) => x.id !== rec.id), rec] }));
    return rec;
  }

  /**
   * Every computer against its provider, cheaply: one listing of this instance's computer machines
   * per provider (and, Daytona v2, one listing of snapshots when a computer hibernates). A computer
   * whose state disagrees with the listing (its machine or snapshot gone, a machine it did not know,
   * another state) is refreshed (the full check, which also confirms what a lagging listing says).
   * A provider that cannot be asked teaches nothing: its computers are left as they are.
   */
  async reconcile(computers: readonly ComputerConfig[]): Promise<string[]> {
    const state = this.read();
    const groups = new Map<RemoteSandboxProvider, ComputerConfig[]>();
    for (const c of computers) {
      if (!isRemoteComputer(c) || this.deleting.has(c.id) || this.chains.has(c.id) || state[c.id]?.deletedAt) continue;
      const p = c.kind as RemoteSandboxProvider;
      groups.set(p, [...(groups.get(p) ?? []), c]);
    }
    const prefix = `${this.instance}:`;
    const checked: string[] = [];
    for (const [provider, list] of groups) {
      let vms: RemoteVmSummary[];
      let h: Hibernation | undefined;
      try {
        h = await this.hibernation(list[0]!);
        vms = await this.adapter(provider).list({ "polpo-scope": "computer" });
      } catch {
        continue;
      }
      const found = new Map<string, RemoteVmSummary[]>();
      for (const v of vms) {
        const value = v.labels?.[COMPUTER_LABEL];
        if (!value?.startsWith(prefix) || computerStatusOf(provider, v.state) === "missing") continue;
        const id = value.slice(prefix.length);
        found.set(id, [...(found.get(id) ?? []), v]);
      }
      let listed: Set<string> | undefined;
      for (const c of list) {
        const rt = state[c.id];
        const status = rt?.status ?? "missing";
        const mine = found.get(c.id) ?? [];
        let suspect: boolean;
        if (mine.length) suspect = !mine.some((v) => v.remoteId === rt?.remoteId && computerStatusOf(provider, v.state) === status);
        else if (rt?.remoteId) suspect = !(TRANSITIONAL.has(status) && this.now() - Date.parse(rt.updatedAt) < TRANSITION_MS);
        else if (status === "hibernated" && h) {
          if (!listed) {
            const labels = list.map((x) => this.labelValue(x.id));
            listed = new Set((await h.listSnapshots((name) => labels.some((l) => isComputerSnapshotName(l, name))).catch(() => undefined) ?? [])
              .filter((x) => READY.test(x.status)).map((x) => x.id));
          }
          const newest = lastReady(rt);
          suspect = !newest || !listed.has(newest.id);
        } else suspect = ["running", "stopped", "paused", "archived"].includes(status);
        if (!suspect) continue;
        checked.push(c.id);
        await this.refresh(c, undefined, { force: true }).catch(() => undefined);
      }
    }
    return checked;
  }

  /**
   * A provider pushed an event about this computer's machine (a webhook): the activity says what it
   * reported when that differs from what Polpo knew, then the computer is checked at its provider
   * (the event is a hint; the provider is the truth). Idempotent.
   */
  async providerEvent(c: ComputerConfig, e: { type: string; state?: string; from?: string; gone: boolean; remoteId?: string; snapshotName?: string }): Promise<ComputerLive> {
    if (!isRemoteComputer(c) || this.deleting.has(c.id)) return this.live(c.id);
    const cur = this.read()[c.id];
    const machineGone = e.gone && !e.snapshotName;
    const hinted = machineGone ? "missing" : e.state && !e.snapshotName ? computerStatusOf(c.kind as RemoteSandboxProvider, e.state) : undefined;
    const known = cur?.status === "deleted" ? "missing" : cur?.status;
    if ((hinted && hinted !== known) || (e.snapshotName && e.gone)) {
      const change = [e.from, e.state].filter(Boolean).join(" → ");
      this.notify(c, "info", `The provider reported ${e.type}${change ? ` (${change})` : ""}${e.snapshotName ? ` for snapshot ${e.snapshotName}` : e.remoteId ? ` for ${e.remoteId}` : ""}`);
    }
    return this.refresh(c, undefined, { force: true });
  }

  // ── Server upkeep ──────────────────────────────────────────────────

  /**
   * Stop computers nobody used for their idle time (never delete; Daytona v2: hibernate), keep
   * running v2 computers safe (safety snapshots, rotation before the wall clock), and announce
   * changes other processes (task runners) made to the state file. `sandboxFor`: the sandbox a
   * rotated computer's new VM is made with (else the one it last ran with).
   */
  async idleTick(computers: readonly ComputerConfig[], sandboxFor?: (c: ComputerConfig) => EffectiveSandbox | { error: string } | undefined): Promise<void> {
    const state = this.read();
    for (const c of computers) {
      if (!isRemoteComputer(c) || this.deleting.has(c.id)) continue;
      const rt = state[c.id];
      if (rt?.status !== "running" || rt.deletedAt) continue;
      const now = this.now();
      const idleMs = now - Date.parse(rt.lastUsedAt ?? rt.runningSince ?? rt.updatedAt);
      const h = await this.hibernation(c);
      if (!h) {
        if (idleMs >= computerIdleStopMinutes(c) * 60_000) await this.stop(c, "idle").catch(() => undefined);
        continue;
      }
      try {
        await this.upkeepHibernating(c, h, rt, idleMs, sandboxFor);
      } catch (err) {
        this.notify(c, "warn", (err as Error).message);
      }
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

  /** One minute of a running Daytona v2 computer: hibernate when idle, rotate before the wall clock, safety snapshots. */
  private async upkeepHibernating(
    c: ComputerConfig, h: Hibernation, rt: ComputerRuntime, idleMs: number,
    sandboxFor?: (c: ComputerConfig) => EffectiveSandbox | { error: string } | undefined,
  ): Promise<void> {
    const now = this.now();
    const s = h.settings;
    const retrying = !!rt.retryAt && now < Date.parse(rt.retryAt);
    // the wall clock: read again when it looks close (a re-armed policy may have pushed it)
    let left = rt.timeoutAt ? Date.parse(rt.timeoutAt) - now : Infinity;
    if (left < s.rotateBeforeMinutes * 60_000 && rt.remoteId) {
      const m = await h.machine(rt.remoteId).catch(() => undefined);
      if (m?.timeoutAt && m.timeoutAt !== rt.timeoutAt) {
        await this.update(c.id, "daytona", (cur) => ({ ...cur, timeoutAt: m.timeoutAt }));
        left = Date.parse(m.timeoutAt) - now;
      }
    }
    const busy = (this.inFlight.get(c.id) ?? 0) > 0;
    if (idleMs >= computerIdleStopMinutes(c) * 60_000 && !busy) {
      if (!retrying || left < s.forceRotateMinutes * 60_000) await this.stop(c, "idle");
      return;
    }
    if (left < s.rotateBeforeMinutes * 60_000) {
      const force = left < s.forceRotateMinutes * 60_000;
      const quiet = !busy && idleMs >= s.rotateIdleGapSeconds * 1000;
      if (force || (quiet && !retrying)) {
        const asked = sandboxFor?.(c);
        const sandbox = asked && !("error" in asked) ? asked : this.sandboxes.get(c.id);
        await this.rotate(c, h, sandbox, force);
      }
      return;
    }
    if (s.safetySnapshotHours > 0 && !retrying) {
      const since = Math.max(Date.parse(lastReady(rt)?.at ?? "") || 0, Date.parse(rt.runningSince ?? "") || 0);
      if (now - since >= s.safetySnapshotHours * 3_600_000) await this.safetySnapshot(c, h);
    }
  }
}

/** A remote computer's egress through the tailnet, as people and Polpo see it. */
export interface ComputerEgressStatus extends Partial<Omit<TailnetStatus, "computerId" | "tailnet">> {
  computerId: string;
  /** The proxy's name (settings.egressProxies). */
  proxy: string;
  /** "off": the computer is not running (its tailnet comes up when it is next used). */
  tailnet: TailnetStatus["tailnet"] | "off" | "unknown";
  proxyReachable: boolean;
  /** Where its browser goes out now: "via home", "direct (home unreachable)"… */
  effective: string;
  /** The computer's machine status. */
  machine: ComputerStatus;
}

/**
 * The tailnet egress of a remote computer with `egress` (undefined otherwise). Looks inside the
 * machine only when it is running (never starts or resumes it).
 */
export async function computerEgressStatus(
  manager: ComputerManager,
  c: ComputerConfig,
  settings: { egressProxies?: Record<string, string>; tailscale?: unknown } | undefined,
  instance?: string,
): Promise<ComputerEgressStatus | undefined> {
  if (!isRemoteComputer(c) || !c.egress) return undefined;
  const proxy = c.egress;
  const egress = tailnetEgressFor(c, settings, instance);
  const machine = manager.live(c.id).status;
  if (!egress) {
    const error = computerEgressProblem(c, settings) ?? "Tailscale is not set up (settings.tailscale)";
    return { computerId: c.id, proxy, tailnet: "unknown", proxyReachable: false, effective: `direct (${proxy} not usable)`, machine, error };
  }
  const label = (s: { tailnet: string; proxyReachable: boolean }) => (s.tailnet === "up" && s.proxyReachable ? `via ${proxy}` : `direct (${proxy} unreachable; profiles signed in through it pause)`);
  let live: TailnetStatus | undefined;
  try {
    live = await manager.whenRunning(c, (d) => tailnetEgress.inspect(driverHost(d), egress.tailnet));
  } catch (err) {
    return { computerId: c.id, proxy, tailnet: "unknown", proxyReachable: false, effective: label({ tailnet: "unknown", proxyReachable: false }), machine, error: (err as Error).message };
  }
  if (!live) {
    const last = tailnetEgress.last(c.id);
    const state = machine === "running" ? "stopped" : machine;
    return {
      computerId: c.id, proxy, tailnet: "off", proxyReachable: false, machine: state,
      // not checked (nothing runs to check from): never "not reachable"
      effective: state === "hibernated" ? "checked again when it wakes" : `checked again when it next starts (it is ${state})`,
      ...(last?.node ? { node: last.node } : {}), ...(last?.checkedAt ? { checkedAt: last.checkedAt } : {}),
    };
  }
  const { computerId: _id, ...rest } = live;
  return { computerId: c.id, proxy, ...rest, effective: label(live), machine: "running" };
}

const capital = (s: string) => `${s[0]?.toUpperCase() ?? ""}${s.slice(1)}`;

/**
 * One line about a remote computer's egress, for people and models: "computer nina (daytona) →
 * home: Hibernated: egress is checked again when it wakes", or, while it runs, the tailnet, the
 * path, whether the proxy answers and where its browser goes out.
 */
export function describeComputerEgress(c: Pick<ComputerConfig, "id" | "kind">, s: ComputerEgressStatus): string {
  const head = `computer ${c.id} (${c.kind}) → ${s.proxy}`;
  if (s.tailnet === "off") {
    const node = s.node ? ` (last seen in the tailnet as ${s.node})` : "";
    return s.machine === "hibernated"
      ? `${head}: Hibernated: egress is checked again when it wakes${node}`
      : `${head}: ${capital(s.machine)}: egress is checked again when it next starts${node}`;
  }
  const path = s.path ? `, path ${s.path === "derp" ? `DERP relay${s.relay ? ` ${s.relay}` : ""}` : s.path}` : "";
  return `${head}: tailnet ${s.tailnet}${s.node ? ` as ${s.node}` : ""}${path}, proxy ${s.proxyReachable ? "reachable" : "not reachable"}; `
    + `its browser goes out ${s.effective}${s.error ? ` (${s.error})` : ""}`;
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

/**
 * The project's manager, announcing status changes as computer:changed (once per process) and,
 * given `log`, hibernation news (rotations, failed snapshots, restored VMs) as log lines.
 */
export function computerManagerWithEvents(
  polpoDir: string,
  emit: (payload: { id: string; action: "status"; status: ComputerStatus; remoteId?: string; error?: string; notice?: string }) => void,
  log?: (level: "info" | "warn", message: string) => void,
  /** The configured computers: one that is not among them never gets a machine (a deleted one). */
  configured?: () => readonly ComputerConfig[],
): ComputerManager {
  const m = computerManager(polpoDir);
  if (configured) m.isConfigured ??= (id) => configured().some((c) => c.id === id);
  m.onChange ??= (id, live) => emit({
    id, action: "status", status: live.status,
    ...(live.remoteId ? { remoteId: live.remoteId } : {}), ...(live.lastError ? { error: live.lastError } : {}), ...(live.notice ? { notice: live.notice } : {}),
  });
  if (log) m.onNotice ??= (id, level, message) => log(level, `Computer "${id}": ${message}`);
  return m;
}

/** Tests: replace the manager of a project. */
export function setComputerManager(polpoDir: string, manager: ComputerManager | undefined): void {
  if (manager) managers.set(polpoDir, manager);
  else managers.delete(polpoDir);
}

/**
 * Server upkeep, once a minute: the idle stop (or hibernation) of every computer, Daytona v2 safety
 * snapshots and rotations; every few minutes (reconcileEveryMs) every computer is checked against
 * its provider (reconcile: a machine deleted outside Polpo shows as "deleted").
 */
export class ComputerUpkeep {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private reconciledAt = 0;
  constructor(
    private readonly manager: ComputerManager,
    private readonly computers: () => readonly ComputerConfig[],
    private readonly onError?: (message: string) => void,
    /** The sandbox a rotated computer's new VM is made with. */
    private readonly sandboxFor?: (c: ComputerConfig) => EffectiveSandbox | { error: string } | undefined,
    /** reconcileEveryMs: a number, or asked at each tick (slower when providers push their events). */
    private readonly opts: { reconcileEveryMs?: number | (() => number | Promise<number>); now?: () => number; beforeReconcile?: () => Promise<void> } = {},
  ) {}

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
    try {
      await this.manager.idleTick(this.computers(), this.sandboxFor);
      const now = (this.opts.now ?? Date.now)();
      const every = typeof this.opts.reconcileEveryMs === "function" ? await this.opts.reconcileEveryMs() : this.opts.reconcileEveryMs ?? RECONCILE_EVERY_MS;
      if (now - this.reconciledAt >= every) {
        this.reconciledAt = now;
        await this.opts.beforeReconcile?.().catch(() => undefined);
        await this.manager.reconcile(this.computers());
      }
    } catch (err) {
      this.onError?.(`Computers upkeep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
