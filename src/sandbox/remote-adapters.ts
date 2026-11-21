/**
 * Remote sandbox providers behind one small interface: create a VM, reconnect to one by id
 * (resuming it when suspended), list ours by label, delete by id. A connected VM is a driver:
 * exec, read, write, suspend, resume, destroy. Everything else (context transfer, pool, lease)
 * is provider-neutral and lives in remote.ts / pool.ts.
 *
 * Measured on 2026-10-07: E2B create 0.4 s, pause 0.24 s, resume 0.73 s (memory kept);
 * Daytona create 0.8 s, pause not supported on container sandboxes, stop 0.9 s / start 0.6 s
 * (files kept).
 */
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { splitHostPort, type DaytonaV2HibernateSettings, type EffectiveSandbox, type RemoteSandboxProvider, type SandboxNetwork } from "@polpo-ai/core/sandbox";
import { remoteProviderCredentials } from "./remote-providers.js";

export interface RemoteExecResult { exitCode: number; stdout: string; stderr: string; timedOut?: boolean }

export interface RemoteDriver {
  /** Provider's id for the VM. */
  readonly remoteId: string;
  /** Run a shell command line in the VM. */
  exec(command: string, opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<RemoteExecResult>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Free CPU/RAM, keep the files (E2B pause; Daytona pause, or stop where pause is not supported). */
  suspend(): Promise<void>;
  /** Make a suspended VM runnable again. */
  resume(): Promise<void>;
  /** Keep a running VM alive this long from now (pooled VMs wait for reuse); optional. */
  keepAlive?(ms: number): Promise<void>;
  destroy(): Promise<void>;
}

export interface CreateSpec {
  sandbox: EffectiveSandbox;
  /** Labels/metadata to find our VMs again (instance, agent, scope). */
  labels: Record<string, string>;
  /** Provider-side safety net: the VM stops by itself after this many idle minutes. */
  lifetimeMinutes: number;
  /** Provider-side safety net for pooled VMs: deleted after being stopped this long (Daytona). */
  deleteAfterStopMinutes?: number;
  /** True when the VM may outlive this run (pool/warm): it must not be ephemeral. */
  keep: boolean;
  /** Something requested could not be applied as asked (e.g. resources fixed by the image). */
  onWarning?: (message: string) => void;
  /**
   * A computer (persistent): never deleted by the provider, stopped (Daytona container) or
   * paused (E2B, Daytona VM class) after idleStopMinutes without use; Daytona archives it after
   * autoArchiveDays stopped.
   */
  persistent?: { idleStopMinutes: number; autoArchiveDays?: number };
  /** Slow steps worth telling (e.g. reactivating an inactive Daytona snapshot). */
  onProgress?: (message: string) => void;
  /**
   * A stable provider-side name (computers on Daytona v2): creating twice with the same name and
   * options returns the same machine, so a lost race or a lagging search never makes a second one.
   */
  name?: string;
  /**
   * The provider's create idempotency key (Daytona v2). A named v2 create derives a permanent
   * key from the name, so a computer that gets a new machine under the same name (after a
   * hibernation, a reset or a lost VM) passes a fresh key per machine.
   */
  idempotencyKey?: string;
}

/** A saved machine: a memory and disk snapshot of a VM (Daytona v2 hibernation). */
export interface MachineSnapshot {
  id: string;
  name: string;
  /** "building", then "ready"; a failure otherwise ("failed", "error"…: see snapshotFailed). */
  status: string;
  error?: string;
  createdAt?: string;
  /** Disk bytes. */
  bytes?: number;
  memoryBytes?: number;
  /** The VM it was taken from. */
  sandboxId?: string;
}

/** A snapshot status that will never become ready. */
export function snapshotFailed(status: string | undefined): boolean {
  return /fail|error|cancel|delet/i.test(String(status ?? ""));
}

/** How a VM is made again from a snapshot. */
export interface RestoreSpec {
  /** The machine's stable name (labels.name). */
  name: string;
  labels: Record<string, string>;
  /** Re-applied once the VM runs (a snapshot create takes no network policy). */
  network: SandboxNetwork;
  idempotencyKey?: string;
}

/**
 * Hibernation, where a VM cannot pause (Daytona v2 Linux VMs): the VM is saved as a memory and
 * disk snapshot and deleted; later a new VM is created from the snapshot, with its files and
 * running processes. Snapshots are found by name (they carry no labels).
 */
export interface Hibernation {
  readonly settings: DaytonaV2HibernateSettings;
  /** Start a snapshot of a running VM (resolves while it is still building; the VM keeps running). */
  snapshot(remoteId: string, name: string): Promise<MachineSnapshot>;
  /** A snapshot by id; undefined when it does not exist (any more). */
  getSnapshot(id: string): Promise<MachineSnapshot | undefined>;
  /** Snapshots whose name matches (the provider's listing may lag a fresh snapshot). */
  listSnapshots(match: (name: string) => boolean): Promise<MachineSnapshot[]>;
  /** Delete a snapshot (one already gone is not an error). */
  deleteSnapshot(id: string): Promise<void>;
  /** A new running VM from a ready snapshot, with the computer's name, labels and network rule. */
  restore(snapshotId: string, spec: RestoreSpec): Promise<RemoteDriver>;
  /** A VM's state and when its wall clock deletes it; undefined when it is gone. */
  machine(remoteId: string): Promise<{ state: string; timeoutAt?: string } | undefined>;
}

export interface RemoteVmSummary { remoteId: string; state: string; labels: Record<string, string>; createdAt?: string }

export interface RemoteAdapter {
  readonly provider: RemoteSandboxProvider;
  /** Suspending is cheap enough to do while the model thinks (E2B pause/resume ≈ 0.2–0.7 s). */
  readonly fastSuspend: boolean;
  /** Stop/pause a VM by id (the reaper stops idle pooled VMs). */
  suspendById(remoteId: string): Promise<void>;
  create(spec: CreateSpec): Promise<RemoteDriver>;
  /** Reconnect (starting/resuming it); `timeoutMs`: E2B's idle timeout from now (computers). */
  connect(remoteId: string, opts?: { timeoutMs?: number }): Promise<RemoteDriver>;
  list(labels: Record<string, string>): Promise<RemoteVmSummary[]>;
  remove(remoteId: string): Promise<void>;
  /** Daytona: a snapshot's state ("active", "inactive", …), undefined when it cannot be read. */
  snapshotState?(name: string): Promise<string | undefined>;
  /**
   * Change a VM's network rule while it exists (Daytona v2). Resolves false where the provider
   * fixes the rule at create (nothing changed); absent: same.
   */
  updateNetwork?(remoteId: string, network: SandboxNetwork): Promise<boolean>;
  /** Hibernation, when the provider (as configured now) saves VMs as snapshots instead of pausing them. */
  hibernation?(): Promise<Hibernation | undefined>;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Daytona deactivates snapshots nobody used for a while: creating from one then fails. */
export function isInactiveSnapshotError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /snapshot\b.*\bis inactive|snapshot\b.*\binactive\b|inactive snapshot/i.test(message);
}

/** A Daytona snapshot that is inactive and could not be activated (or did not become active in time). */
export class SnapshotActivationError extends Error {
  constructor(readonly snapshot: string, reason: string) {
    super(`Daytona snapshot "${snapshot}" is inactive and could not be activated: ${reason}. Activate it in the Daytona dashboard (Snapshots), or choose another snapshot in Settings → Sandbox.`);
    this.name = "SnapshotActivationError";
  }
}

/** How long a snapshot may take to become active again, and how often its state is checked. */
export const SNAPSHOT_ACTIVATION = { timeoutMs: 5 * 60_000, pollMs: 3_000 };

/** A network rule this provider cannot enforce as written: the VM is not created. */
export class SandboxNetworkConfigError extends Error {
  constructor(message: string) { super(message); this.name = "SandboxNetworkConfigError"; }
}

/** Daytona API limits (https://www.daytona.io/docs/en/network-limits). */
export const DAYTONA_NETWORK_LIMITS = { cidrs: 10, domains: 100 } as const;

const HOSTNAME = /^(\*\.)?([a-z0-9_]([a-z0-9_-]*[a-z0-9_])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export interface AllowEntry { kind: "domain" | "ipv4" | "ipv6" | "invalid"; value: string; raw: string }

/** Allowlist entries without ports (remote providers filter by host), classified and deduplicated. */
export function classifyAllowEntries(allow: string[] | undefined): AllowEntry[] {
  const out = new Map<string, AllowEntry>();
  for (const raw of allow ?? []) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const host = splitHostPort(trimmed.toLowerCase()).host.replace(/\.$/, "");
    const [addr = "", prefix, extra] = host.split("/");
    let entry: AllowEntry;
    if (extra === undefined && isIP(addr) === 4 && (prefix === undefined || (/^\d{1,2}$/.test(prefix) && Number(prefix) <= 32))) {
      entry = { kind: "ipv4", value: prefix === undefined ? `${addr}/32` : host, raw: trimmed };
    } else if (extra === undefined && isIP(addr) === 6) {
      entry = { kind: "ipv6", value: host, raw: trimmed };
    } else if (prefix === undefined && HOSTNAME.test(host)) {
      entry = { kind: "domain", value: host, raw: trimmed };
    } else {
      entry = { kind: "invalid", value: host, raw: trimmed };
    }
    if (!out.has(entry.value)) out.set(entry.value, entry);
  }
  return [...out.values()];
}

/**
 * Daytona network fields for a rule. Host names go to `domainAllowList` (max 100; "*.x" covers
 * x and its subdomains; Daytona filters by name, so nothing is resolved here and CDN address
 * changes do not matter); IPv4 entries go to `networkAllowList` (max 10 CIDRs). Daytona takes
 * only one of the two per sandbox, and neither takes ports or IPv6: whatever it cannot enforce
 * as written is an error, never a silently shorter list.
 */
export function daytonaNetworkParams(network: SandboxNetwork): { networkBlockAll?: true; networkAllowList?: string; domainAllowList?: string } {
  if (network.mode === "deny") return { networkBlockAll: true };
  if (network.mode !== "allowlist") return {};
  const entries = classifyAllowEntries(network.allow);
  if (!entries.length) return { networkBlockAll: true };
  const where = "Daytona sandbox network allowlist";
  const invalid = entries.filter((e) => e.kind === "invalid");
  if (invalid.length) throw new SandboxNetworkConfigError(`${where}: not a host name or IPv4 address: ${invalid.map((e) => `"${e.raw}"`).join(", ")}`);
  const ipv6 = entries.filter((e) => e.kind === "ipv6");
  if (ipv6.length) throw new SandboxNetworkConfigError(`${where}: Daytona does not filter IPv6 addresses (${ipv6.map((e) => e.raw).join(", ")}); use host names or IPv4 addresses`);
  const domains = entries.filter((e) => e.kind === "domain").map((e) => e.value);
  const cidrs = entries.filter((e) => e.kind === "ipv4").map((e) => e.value);
  if (domains.length && cidrs.length) {
    throw new SandboxNetworkConfigError(`${where}: Daytona accepts host names or IP addresses in one sandbox, not both (${domains.length} host name(s); addresses ${cidrs.join(", ")}). Remove the addresses or the host names, or use E2B`);
  }
  if (domains.length > DAYTONA_NETWORK_LIMITS.domains) {
    throw new SandboxNetworkConfigError(`${where}: ${domains.length} host names, Daytona accepts at most ${DAYTONA_NETWORK_LIMITS.domains} (group them with wildcards such as "*.example.com")`);
  }
  if (cidrs.length > DAYTONA_NETWORK_LIMITS.cidrs) {
    throw new SandboxNetworkConfigError(`${where}: ${cidrs.length} IP addresses or ranges, Daytona accepts at most ${DAYTONA_NETWORK_LIMITS.cidrs} (merge them into CIDR ranges, or use host names)`);
  }
  return domains.length ? { domainAllowList: domains.join(",") } : { networkAllowList: cidrs.join(",") };
}

/**
 * E2B network options for a rule. E2B filters by host name or address itself (`allowOut` wins
 * over `denyOut`). "*.x" also lists x: in Polpo a wildcard covers the base domain too.
 */
export function e2bNetworkOpts(network: SandboxNetwork): { allowInternetAccess?: false; network?: { allowOut: string[]; denyOut: string[] } } {
  if (network.mode === "deny") return { allowInternetAccess: false };
  if (network.mode !== "allowlist") return {};
  const allowOut = new Set<string>();
  for (const e of classifyAllowEntries(network.allow)) {
    if (e.kind === "invalid") throw new SandboxNetworkConfigError(`E2B sandbox network allowlist: not a host name or IP address: "${e.raw}"`);
    if (e.kind === "domain" && e.value.startsWith("*.")) allowOut.add(e.value.slice(2));
    allowOut.add(e.kind === "ipv4" && e.value.endsWith("/32") ? e.value.slice(0, -3) : e.value);
  }
  return { network: { allowOut: [...allowOut], denyOut: ["0.0.0.0/0"] } };
}

/**
 * Daytona CPU/memory/disk for a create (cores, GiB, GiB). Daytona sizes a sandbox only when it
 * is created from an image (`providerOptions.image`); a snapshot (ours: polpo-runner-*) comes
 * with its own size, so the request is reported instead of being sent and rejected.
 */
export function daytonaResources(sandbox: Pick<EffectiveSandbox, "resources" | "providerOptions">): { resources?: { cpu?: number; memory?: number; disk?: number }; warning?: string } {
  const { cpus, memoryMb, diskMb } = sandbox.resources;
  if (!cpus && !memoryMb && !diskMb) return {};
  const image = typeof sandbox.providerOptions.image === "string" && sandbox.providerOptions.image ? sandbox.providerOptions.image : undefined;
  const snapshot = sandbox.providerOptions.snapshot ? String(sandbox.providerOptions.snapshot) : undefined;
  if (!image || snapshot) {
    const asked = [cpus ? `${cpus} CPU` : "", memoryMb ? `${memoryMb} MB memory` : "", diskMb ? `${diskMb} MB disk` : ""].filter(Boolean).join(", ");
    return { warning: `Daytona sandboxes created from a snapshot (${snapshot ?? "Daytona's default"}) have the snapshot's size: ${asked} not applied. To choose the size, set providers.daytona.image instead of a snapshot.` };
  }
  return {
    resources: {
      ...(cpus ? { cpu: Math.max(1, Math.ceil(cpus)) } : {}),
      ...(memoryMb ? { memory: Math.max(1, Math.ceil(memoryMb / 1024)) } : {}),
      ...(diskMb ? { disk: Math.max(1, Math.ceil(diskMb / 1024)) } : {}),
    },
  };
}

/**
 * Daytona's executeCommand returns stdout and stderr as one string. The command runs with its
 * stderr in a file, printed after a marker only this call knows: both come back apart in one
 * round trip, with the command's exit code.
 */
export function daytonaExecWrapper(command: string, marker: string): string {
  return `f=$(mktemp 2>/dev/null || echo "/tmp/.polpo-stderr-$$"); bash -c ${q(command)} 2>"$f"; rc=$?; printf '%s' ${q(marker)}; cat "$f" 2>/dev/null; rm -f "$f"; exit $rc`;
}

/** Undo daytonaExecWrapper: what came before the marker is stdout, after it stderr. */
export function splitDaytonaOutput(result: string, marker: string): { stdout: string; stderr: string } {
  const at = result.lastIndexOf(marker);
  if (at < 0) return { stdout: result, stderr: "" };
  return { stdout: result.slice(0, at), stderr: result.slice(at + marker.length) };
}

// ── Daytona ─────────────────────────────────────────────────────────────

/**
 * Daytona behind one adapter: each call goes to the v0 or the v2 service, as
 * settings.sandbox.providers.daytona.api says now (a person may switch it while the server runs;
 * VMs of the other service are then simply not found).
 */
class DaytonaAdapter implements RemoteAdapter {
  readonly provider = "daytona" as const;
  // neither suspends between tool calls (v0 containers cannot pause; v2 pauses on idle by policy)
  readonly fastSuspend = false;
  private v0?: DaytonaV0Adapter;
  private v2?: RemoteAdapter;

  private async pick(): Promise<RemoteAdapter> {
    const creds = await Promise.resolve(remoteProviderCredentials("daytona"));
    if (creds?.api === "v2") {
      if (!this.v2) {
        const { DaytonaV2Adapter } = await import("./daytona-v2.js");
        this.v2 = new DaytonaV2Adapter();
      }
      return this.v2;
    }
    return (this.v0 ??= new DaytonaV0Adapter());
  }

  async suspendById(remoteId: string) { return (await this.pick()).suspendById(remoteId); }
  async create(spec: CreateSpec) { return (await this.pick()).create(spec); }
  async connect(remoteId: string, opts?: { timeoutMs?: number }) { return (await this.pick()).connect(remoteId, opts); }
  async list(labels: Record<string, string>) { return (await this.pick()).list(labels); }
  async remove(remoteId: string) { return (await this.pick()).remove(remoteId); }
  /** v0 snapshots only (v2 has images, and "snapshot" there means a saved machine). */
  async snapshotState(name: string): Promise<string | undefined> {
    const adapter = await this.pick();
    return adapter instanceof DaytonaV0Adapter ? adapter.snapshotState(name) : undefined;
  }
  async updateNetwork(remoteId: string, network: SandboxNetwork): Promise<boolean> {
    const adapter = await this.pick();
    return adapter.updateNetwork ? adapter.updateNetwork(remoteId, network) : false;
  }
  /** v2 only: its Linux VMs cannot pause, computers hibernate as snapshots. */
  async hibernation(): Promise<Hibernation | undefined> {
    const adapter = await this.pick();
    return adapter.hibernation ? adapter.hibernation() : undefined;
  }
}

/** Daytona v0 (app.daytona.io or a custom API URL) through @daytona/sdk 0.x. */
class DaytonaV0Adapter implements RemoteAdapter {
  readonly provider = "daytona" as const;
  // container sandboxes cannot pause; stop/start (≈1 s each) is too slow between tool calls
  readonly fastSuspend = false;
  private cached?: { fingerprint: string; client: any };

  /** A client for the current key (the key lives in a vault entry a person may change). */
  private async client(): Promise<any> {
    const creds = await Promise.resolve(remoteProviderCredentials("daytona"));
    if (!creds?.apiKey) throw new Error("Daytona has no API key (Settings → Sandbox)");
    const fingerprint = JSON.stringify([creds.apiKey, creds.apiUrl, creds.target]);
    if (this.cached?.fingerprint !== fingerprint) {
      const { Daytona } = await import("@daytona/sdk");
      this.cached = { fingerprint, client: new Daytona({ apiKey: creds.apiKey, apiUrl: creds.apiUrl || undefined, target: creds.target || undefined }) };
    }
    return this.cached.client;
  }

  async create(spec: CreateSpec): Promise<RemoteDriver> {
    const { network } = spec.sandbox;
    // network rules are checked before anything is created
    const networkParams = daytonaNetworkParams(network);
    const client = await this.client();
    const persistent = spec.persistent;
    const params: Record<string, unknown> = {
      autoStopInterval: persistent ? persistent.idleStopMinutes : spec.lifetimeMinutes,
      labels: spec.labels,
      // a computer is never deleted by Daytona (negative: auto-delete off); archived after N days stopped
      ...(persistent
        ? { autoDeleteInterval: -1, ...(persistent.autoArchiveDays ? { autoArchiveInterval: persistent.autoArchiveDays * 24 * 60 } : {}) }
        : spec.keep ? { autoDeleteInterval: spec.deleteAfterStopMinutes ?? 60 } : { ephemeral: true }),
      ...(spec.sandbox.providerOptions.snapshot ? { snapshot: String(spec.sandbox.providerOptions.snapshot) } : {}),
    };
    Object.assign(params, networkParams);
    const sized = daytonaResources(spec.sandbox);
    const image = typeof spec.sandbox.providerOptions.image === "string" && spec.sandbox.providerOptions.image ? spec.sandbox.providerOptions.image : undefined;
    // an image (no snapshot) is built by Daytona once and sized per sandbox
    if (image && !params.snapshot) params.image = image;
    if (sized.resources) params.resources = sized.resources;
    if (sized.warning) spec.onWarning?.(sized.warning);
    let sandbox: any;
    try {
      sandbox = await client.create(params, { timeout: 180 });
    } catch (err) {
      // the snapshot was deactivated (unused for a while): activate it, wait, try once more
      if (!params.snapshot || !isInactiveSnapshotError(err)) throw err;
      await this.activateSnapshot(client, String(params.snapshot), spec.onProgress);
      sandbox = await client.create(params, { timeout: 180 });
    }
    // VM-class snapshots (linux-vm) pause instead of stopping: memory and processes survive
    if (persistent && sandbox.sandboxClass === "linux-vm") {
      try {
        await sandbox.setAutostopInterval(0);
        await sandbox.setAutoPauseInterval(persistent.idleStopMinutes);
      } catch (err) {
        spec.onWarning?.(`Daytona: could not switch the computer to auto-pause (${(err as Error).message}); it stops after ${persistent.idleStopMinutes} idle minutes instead`);
      }
    }
    return this.driver(sandbox);
  }

  /** Activate an inactive snapshot and wait (bounded) until it is active. */
  private async activateSnapshot(client: any, name: string, onProgress?: (message: string) => void): Promise<void> {
    const t0 = Date.now();
    onProgress?.(`Daytona snapshot "${name}" is inactive: activating it (this can take a few minutes)…`);
    try {
      await client.snapshot.activate(name);
    } catch (err) {
      // already being activated by someone else is fine: wait for it below
      if (!/already|activ/i.test((err as Error).message ?? "")) throw new SnapshotActivationError(name, (err as Error).message ?? String(err));
    }
    let state = "";
    let reported = t0;
    while (Date.now() - t0 < SNAPSHOT_ACTIVATION.timeoutMs) {
      try {
        state = String((await client.snapshot.get(name))?.state ?? "");
      } catch (err) {
        throw new SnapshotActivationError(name, (err as Error).message ?? String(err));
      }
      if (state === "active") {
        onProgress?.(`Daytona snapshot "${name}" is active again (${Math.round((Date.now() - t0) / 1000)} s)`);
        return;
      }
      if (state === "error" || state === "build_failed") throw new SnapshotActivationError(name, `its state is ${state}`);
      if (Date.now() - reported >= 30_000) {
        reported = Date.now();
        onProgress?.(`Daytona snapshot "${name}" is still ${state || "activating"} (${Math.round((Date.now() - t0) / 1000)} s)…`);
      }
      await new Promise((r) => setTimeout(r, SNAPSHOT_ACTIVATION.pollMs));
    }
    throw new SnapshotActivationError(name, `still ${state || "inactive"} after ${Math.round(SNAPSHOT_ACTIVATION.timeoutMs / 60_000)} minutes`);
  }

  async snapshotState(name: string): Promise<string | undefined> {
    const client = await this.client();
    try {
      return String((await client.snapshot.get(name))?.state ?? "") || undefined;
    } catch {
      return undefined;
    }
  }

  async connect(remoteId: string): Promise<RemoteDriver> {
    const client = await this.client();
    const sandbox = await client.get(remoteId);
    // stopped, paused and archived sandboxes all start with start() (archived ones take longer)
    if (sandbox.state !== "started") await sandbox.start(sandbox.state === "archived" ? 600 : 120);
    return this.driver(sandbox);
  }

  async list(labels: Record<string, string>): Promise<RemoteVmSummary[]> {
    const client = await this.client();
    const out: RemoteVmSummary[] = [];
    for await (const sb of client.list({ labels })) {
      out.push({ remoteId: sb.id, state: String(sb.state), labels: sb.labels ?? {}, createdAt: sb.createdAt });
    }
    return out;
  }

  async remove(remoteId: string): Promise<void> {
    const client = await this.client();
    const sandbox = await client.get(remoteId).catch(() => undefined);
    if (sandbox) await sandbox.delete();
  }

  async suspendById(remoteId: string): Promise<void> {
    const client = await this.client();
    const sandbox = await client.get(remoteId);
    if (sandbox.state === "started") await sandbox.pause(60).catch(() => sandbox.stop(120));
  }

  private driver(sandbox: any): RemoteDriver {
    return {
      remoteId: sandbox.id,
      async exec(command, opts) {
        const seconds = opts.timeoutMs ? Math.max(1, Math.ceil(opts.timeoutMs / 1000)) : undefined;
        try {
          const marker = `\n__POLPO_STDERR_${randomBytes(9).toString("hex")}__\n`;
          const r = await sandbox.process.executeCommand(`bash -c ${q(daytonaExecWrapper(command, marker))}`, opts.cwd, opts.env, seconds);
          return { exitCode: r.exitCode, ...splitDaytonaOutput(r.result ?? "", marker) };
        } catch (err) {
          const message = (err as Error).message ?? String(err);
          if (/timeout|timed out/i.test(message)) return { exitCode: 124, stdout: "", stderr: message, timedOut: true };
          throw err;
        }
      },
      readFile: async (path) => new Uint8Array(await sandbox.fs.downloadFile(path)),
      writeFile: async (path, data) => { await sandbox.fs.uploadFile(Buffer.from(data), path); },
      // pause keeps memory but container sandboxes do not support it: stop keeps the files
      suspend: async () => { await sandbox.pause(60).catch(() => sandbox.stop(120)); },
      // activity resets Daytona's auto-stop timer
      keepAlive: async () => { await sandbox.refreshActivity?.(); },
      resume: async () => { await sandbox.refreshData?.().catch(() => undefined); if (sandbox.state !== "started") await sandbox.start(120); },
      destroy: async () => { await sandbox.delete(); },
    };
  }
}

// ── E2B ─────────────────────────────────────────────────────────────────

class E2BAdapter implements RemoteAdapter {
  readonly provider = "e2b" as const;
  readonly fastSuspend = true;

  private async sdk() {
    const creds = await Promise.resolve(remoteProviderCredentials("e2b"));
    if (!creds?.apiKey) throw new Error("E2B has no API key (Settings → Sandbox)");
    const mod = await import("e2b");
    const conn = { apiKey: creds.apiKey, ...(creds.domain ? { domain: creds.domain } : {}) };
    return { mod, conn, template: creds.template };
  }

  async create(spec: CreateSpec): Promise<RemoteDriver> {
    const { mod, conn, template: defaultTemplate } = await this.sdk();
    const { network } = spec.sandbox;
    // pooled VMs pause when their timeout hits (files kept) instead of dying; the reaper deletes them later
    // computers pause too, and are never deleted
    const minutes = spec.persistent ? spec.persistent.idleStopMinutes : spec.lifetimeMinutes;
    const opts: Record<string, unknown> = { ...conn, timeoutMs: minutes * 60_000, metadata: spec.labels, ...(spec.keep || spec.persistent ? { lifecycle: { onTimeout: "pause" } } : {}) };
    Object.assign(opts, e2bNetworkOpts(network));
    const { cpus, memoryMb, diskMb } = spec.sandbox.resources;
    if (cpus || memoryMb || diskMb) {
      spec.onWarning?.("E2B sizes a sandbox by its template: the requested CPU/memory/disk are not applied (build a template with the size you need).");
    }
    const template = (spec.sandbox.providerOptions.template as string | undefined) || defaultTemplate || undefined;
    const sbx = template ? await mod.Sandbox.create(template, opts as any) : await mod.Sandbox.create(opts as any);
    return this.driver(mod, conn, sbx, minutes);
  }

  async connect(remoteId: string, o?: { timeoutMs?: number }): Promise<RemoteDriver> {
    const { mod, conn } = await this.sdk();
    // connecting resumes a paused sandbox
    const sbx = await mod.Sandbox.connect(remoteId, { ...conn, ...(o?.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) } as any);
    return this.driver(mod, conn, sbx, o?.timeoutMs ? o.timeoutMs / 60_000 : undefined);
  }

  async list(labels: Record<string, string>): Promise<RemoteVmSummary[]> {
    const { mod, conn } = await this.sdk();
    const paginator = mod.Sandbox.list({ ...conn, query: { metadata: labels, state: ["running", "paused"] } } as any);
    const out: RemoteVmSummary[] = [];
    while (paginator.hasNext) {
      for (const s of await paginator.nextItems()) {
        out.push({ remoteId: s.sandboxId, state: String(s.state), labels: (s.metadata ?? {}) as Record<string, string>, createdAt: s.startedAt ? new Date(s.startedAt).toISOString() : undefined });
      }
    }
    return out;
  }

  async remove(remoteId: string): Promise<void> {
    const { mod, conn } = await this.sdk();
    await mod.Sandbox.kill(remoteId, conn as any);
  }

  async suspendById(remoteId: string): Promise<void> {
    const { mod, conn } = await this.sdk();
    await mod.Sandbox.pause(remoteId, conn as any);
  }

  private driver(mod: any, conn: Record<string, unknown>, initial: any, lifetimeMinutes: number | undefined): RemoteDriver {
    let sbx = initial;
    return {
      remoteId: sbx.sandboxId,
      async exec(command, o) {
        try {
          const r = await sbx.commands.run(command, { cwd: o.cwd, envs: o.env, timeoutMs: o.timeoutMs ?? 0 });
          return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
        } catch (err) {
          if (err instanceof mod.CommandExitError) { const e = err as any; return { exitCode: e.exitCode, stdout: e.stdout, stderr: e.stderr }; }
          const message = (err as Error).message ?? String(err);
          if (/timeout|deadline/i.test(message)) return { exitCode: 124, stdout: "", stderr: message, timedOut: true };
          throw err;
        }
      },
      readFile: async (path) => new Uint8Array(await sbx.files.read(path, { format: "bytes" })),
      writeFile: async (path, data) => { await sbx.files.write(path, new Blob([new Uint8Array(data)])); },
      suspend: async () => { await sbx.pause(); },
      keepAlive: async (ms) => { await sbx.setTimeout(ms); },
      resume: async () => {
        sbx = await mod.Sandbox.connect(sbx.sandboxId, { ...conn, ...(lifetimeMinutes ? { timeoutMs: lifetimeMinutes * 60_000 } : {}) } as any);
      },
      destroy: async () => { await sbx.kill(); },
    };
  }
}

const adapters = new Map<RemoteSandboxProvider, RemoteAdapter>();

/** The adapter for a provider (one per process; it reads the key on first use). */
export function remoteAdapter(provider: RemoteSandboxProvider): RemoteAdapter {
  let adapter = adapters.get(provider);
  if (!adapter) {
    adapter = provider === "daytona" ? new DaytonaAdapter() : new E2BAdapter();
    adapters.set(provider, adapter);
  }
  return adapter;
}

/** Forget cached clients (the key changed). */
export function resetRemoteAdapters(): void {
  adapters.clear();
}
