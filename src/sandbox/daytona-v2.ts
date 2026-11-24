/**
 * Daytona v2 (settings.sandbox.providers.daytona.api = "v2"): Daytona's new service through
 * `@daytona/sdk` 2.x (`new Daytona({ apiKey }).v2`), installed under the npm alias
 * `@daytona/sdk-v2` next to the 0.x SDK that the v0 adapter keeps using (2.x cannot take a custom
 * API URL, which v0 settings allow).
 *
 * What changes from v0 (see remote-adapters.ts for the v0 adapter):
 * - Every sandbox is a Linux VM (`sandboxClass` "linux"; Polpo calls the class "linux-vm"). On the
 *   plans seen live it is NOT persistent: pause(), stop() and fork() are refused (409 "sandbox is
 *   not persistent"), so Polpo never pauses a v2 VM: suspend is a no-op and the reaper's idle stop
 *   deletes a pooled VM. Computers (persistent machines) hibernate instead (`hibernation()`): a
 *   memory and disk snapshot (`createSnapshot`, ready in seconds), then the VM is deleted; the
 *   next use creates a VM from the snapshot (`createFromSnapshot`, files and running processes
 *   kept, ~3 s). The ComputerManager drives it (computers.ts).
 * - It is created from a registered image (`providers.daytona.image`, default the Polpo runner
 *   image `DAYTONA_V2_RUNNER_IMAGE`) and sized per sandbox (`resources`), whatever the image.
 * - Lifecycle is a policy set at create: a wall-clock timeout (cannot be disabled; capped at
 *   providers.daytona.maxTimeoutSeconds, default 86400, the plan's maximum) and an idle timeout;
 *   Linux VMs accept only "delete" as an action, and the timeout deletes the VM (a computer is
 *   rotated through a snapshot before that).
 * - Network: `networkPolicy` with domains and CIDRs together (default-deny once a list is given),
 *   changeable while the sandbox runs (`updateNetwork`).
 * - exec returns stdout, stderr and the exit code apart: no stderr wrapper as on v0.
 *
 * Types come from the 2.x typings (`@daytona/sdk-v2/v2`); the SDK is imported lazily.
 */
import type { NetworkPolicyInput, LifecyclePolicyOptions, Resources, Sandbox, SandboxState, Snapshot as SdkSnapshot } from "@daytona/sdk-v2/v2";
import type { DaytonaV2Client } from "@daytona/sdk-v2";
import { COMPUTER_LABEL, DAYTONA_V2_MAX_TIMEOUT_SECONDS, DAYTONA_V2_PREVIOUS_RUNNER_IMAGE, DAYTONA_V2_RUNNER_IMAGE, daytonaV2HibernateSettings, type DaytonaV2HibernateSettings, type EffectiveSandbox, type SandboxNetwork } from "@polpo-ai/core/sandbox";
import { remoteProviderCredentials } from "./remote-providers.js";
import {
  classifyAllowEntries, SandboxNetworkConfigError,
  type CreateSpec, type Hibernation, type MachineSnapshot, type RemoteAdapter, type RemoteDriver, type RemoteExecResult, type RemoteVmSummary, type RestoreSpec,
  type RemoteProcess, type RemotePortEndpoint,
} from "./remote-adapters.js";

/** Size of a v2 sandbox when nothing is asked: the v0 runner snapshot's (2 vCPU, 4 GiB, 10 GiB). */
export const DAYTONA_V2_DEFAULT_RESOURCES = { cpus: 2, memoryMb: 4096, diskMb: 10240 } as const;
/** A computer's VM never lives longer than this (then it is rotated through a snapshot), whatever maxTimeoutSeconds says. */
export const DAYTONA_V2_COMPUTER_TIMEOUT_SECONDS = 86_400;
/** Why a computer's VM is never paused or deleted by an idle stop on v2. */
export const DAYTONA_V2_COMPUTER_HIBERNATES = "A Daytona v2 computer hibernates (memory and disk snapshot, then its VM is deleted) instead of pausing: stop it as a computer";
/** The SDK's DISABLED (-1): clears an idle trigger instead of inheriting the project default. */
export const DAYTONA_V2_DISABLED = -1;
/** Waits for create/start/resume/pause/delete, in seconds. */
const WAIT_SECONDS = 180;

/** States of a sandbox that is gone (not listed, not reachable). */
const GONE: ReadonlySet<string> = new Set(["destroying", "destroyed"]);
const LIVE_STATES: Exclude<SandboxState, "unknown">[] = ["queued", "creating", "starting", "started", "pausing", "stopping", "stopped", "paused", "error"];

function errorCode(err: unknown): { status?: number; code?: string; message: string } {
  const e = err as { statusCode?: number; code?: string; message?: string } | undefined;
  return { status: e?.statusCode, code: e?.code, message: e?.message ?? String(err ?? "") };
}

function isNotFound(err: unknown): boolean {
  const { status, code } = errorCode(err);
  return status === 404 || code === "NOT_FOUND";
}

function isImageNotFound(err: unknown): boolean {
  const { code, message } = errorCode(err);
  return code === "IMAGE_NOT_FOUND" || /IMAGE_NOT_FOUND|image\b.*\bnot found/i.test(message);
}

/**
 * The v2 network policy for a rule. "deny": no egress. "allowlist": host names go to
 * `allowDomains` (Daytona filters by name; "*.x" as written), IP addresses and ranges to
 * `allowCidrs`; both may be combined (unlike v0). Only addresses: CIDR-only mode. "open" and
 * "unrestricted": no policy (Daytona's default egress for the project's tier).
 */
export function daytonaV2NetworkPolicy(network: SandboxNetwork): NetworkPolicyInput | undefined {
  if (network.mode === "deny") return { blockAll: true };
  if (network.mode !== "allowlist") return undefined;
  const entries = classifyAllowEntries(network.allow);
  if (!entries.length) return { blockAll: true };
  const invalid = entries.filter((e) => e.kind === "invalid");
  if (invalid.length) throw new SandboxNetworkConfigError(`Daytona sandbox network allowlist: not a host name or IP address: ${invalid.map((e) => `"${e.raw}"`).join(", ")}`);
  const allowDomains = entries.filter((e) => e.kind === "domain").map((e) => e.value);
  const allowCidrs = entries.filter((e) => e.kind !== "domain").map((e) => (e.kind === "ipv6" && !e.value.includes("/") ? `${e.value}/128` : e.value));
  return { blockAll: true, ...(allowDomains.length ? { allowDomains } : {}), ...(allowCidrs.length ? { allowCidrs } : {}) };
}

/**
 * v2 sizing from our resources (vCPUs, MB): the limits (`cpuMax` in cores of 2 vCPUs, a multiple
 * of 0.5; `memoryMax`/`diskMax` in GiB) are the shape the VM boots with; the requests (billing
 * floor) are left to the platform minimums. Unset values take DAYTONA_V2_DEFAULT_RESOURCES.
 */
export function daytonaV2Resources(sandbox: Pick<EffectiveSandbox, "resources">): Resources {
  const cpus = sandbox.resources.cpus ?? DAYTONA_V2_DEFAULT_RESOURCES.cpus;
  const memoryMb = sandbox.resources.memoryMb ?? DAYTONA_V2_DEFAULT_RESOURCES.memoryMb;
  const diskMb = sandbox.resources.diskMb ?? DAYTONA_V2_DEFAULT_RESOURCES.diskMb;
  return {
    cpuMax: Math.max(1, Math.ceil(cpus)) / 2,
    memoryMax: Math.max(1, Math.ceil(memoryMb / 1024)),
    diskMax: Math.max(1, Math.ceil(diskMb / 1024)),
  };
}

/**
 * The v2 lifecycle policy for a create. Linux VMs accept only "delete" as a policy action (pause is
 * an explicit call, which our idle reaper makes), and fields left out are inherited from the
 * project's dashboard defaults, so the idle trigger is always set: armed with "delete", or DISABLED.
 * - Computer: no idle action (the ComputerManager hibernates it); a wall clock of
 *   min(maxTimeoutSeconds, 86400) that deletes the VM: the manager rotates it through a snapshot
 *   before that, and keeps safety snapshots meanwhile.
 * - Pooled/warm VM (may outlive the run): no idle action (the reaper deletes it);
 *   wall clock → delete after lifetime + deleteAfterStop.
 * - One-run VM: idle or wall clock → delete after the run's lifetime.
 */
export function daytonaV2Lifecycle(
  spec: Pick<CreateSpec, "persistent" | "keep" | "lifetimeMinutes" | "deleteAfterStopMinutes">,
  maxTimeoutSeconds: number = DAYTONA_V2_MAX_TIMEOUT_SECONDS,
): LifecyclePolicyOptions {
  // the plan caps a sandbox's wall clock (86400 s on the plans seen so far): a longer one is refused
  const cap = (seconds: number) => Math.min(seconds, maxTimeoutSeconds);
  if (spec.persistent) {
    return { timeoutSeconds: cap(DAYTONA_V2_COMPUTER_TIMEOUT_SECONDS), onTimeout: "delete", idleExpirySeconds: DAYTONA_V2_DISABLED };
  }
  const lifetime = cap(Math.max(60, spec.lifetimeMinutes * 60));
  if (spec.keep) {
    return { timeoutSeconds: cap(lifetime + (spec.deleteAfterStopMinutes ?? 60) * 60), onTimeout: "delete", idleExpirySeconds: DAYTONA_V2_DISABLED };
  }
  return { timeoutSeconds: lifetime, onTimeout: "delete", idleExpirySeconds: lifetime, onIdleTimeout: "delete" };
}

export class DaytonaV2Adapter implements RemoteAdapter {
  readonly provider = "daytona" as const;
  // a pause/resume round trip between two tool calls is not worth it; the idle policy pauses
  readonly fastSuspend = false;
  private cached?: { key: string; client: DaytonaV2Client; image?: string; region?: string };

  /** The v2 client for the current key (a project API key; the vault entry may change). */
  private async client(): Promise<{ client: DaytonaV2Client; image?: string; region?: string; maxTimeoutSeconds: number; hibernate: DaytonaV2HibernateSettings }> {
    const creds = await Promise.resolve(remoteProviderCredentials("daytona"));
    if (!creds?.apiKey) throw new Error("Daytona has no API key (Settings → Sandbox)");
    if (this.cached?.key !== creds.apiKey) {
      const { Daytona } = await import("@daytona/sdk-v2");
      this.cached = { key: creds.apiKey, client: new Daytona({ apiKey: creds.apiKey }).v2 };
    }
    return {
      client: this.cached.client, image: creds.image, region: creds.region,
      maxTimeoutSeconds: creds.maxTimeoutSeconds ?? DAYTONA_V2_MAX_TIMEOUT_SECONDS,
      hibernate: creds.hibernate ?? daytonaV2HibernateSettings(undefined),
    };
  }

  async create(spec: CreateSpec): Promise<RemoteDriver> {
    // network rules are checked before anything is created
    const networkPolicy = daytonaV2NetworkPolicy(spec.sandbox.network);
    const { client, image: instanceImage, region, maxTimeoutSeconds } = await this.client();
    const opts = spec.sandbox.providerOptions;
    const image = (typeof opts.image === "string" && opts.image.trim()) || instanceImage || DAYTONA_V2_RUNNER_IMAGE;
    const sandboxRegion = (typeof opts.region === "string" && opts.region.trim()) || region;
    let sandbox: Sandbox;
    const createFrom = (name: string) => client.create(name, {
      ...(spec.name ? { name: spec.name } : {}),
      labels: spec.labels,
      resources: daytonaV2Resources(spec.sandbox),
      lifecyclePolicy: daytonaV2Lifecycle(spec, maxTimeoutSeconds),
      ...(networkPolicy ? { networkPolicy } : {}),
      ...(sandboxRegion ? { region: sandboxRegion } : {}),
      ...(spec.idempotencyKey ? { idempotencyKey: spec.idempotencyKey } : {}),
      waitSeconds: WAIT_SECONDS,
    });
    try {
      try {
        sandbox = await createFrom(image);
      } catch (err) {
        // the default runner image of this release is not built in the project yet: the previous one
        if (!isImageNotFound(err) || image !== DAYTONA_V2_RUNNER_IMAGE) throw err;
        spec.onWarning?.(`Daytona v2 image "${image}" is not built in this project yet: using "${DAYTONA_V2_PREVIOUS_RUNNER_IMAGE}" (build it with \`node scripts/build-sandbox-images.mjs --provider daytona-v2\`)`);
        sandbox = await createFrom(DAYTONA_V2_PREVIOUS_RUNNER_IMAGE);
      }
    } catch (err) {
      if (isImageNotFound(err)) {
        throw new Error(`Daytona v2 image "${image}" not found in this project. Build it with \`node scripts/build-sandbox-images.mjs --provider daytona-v2\`, or set providers.daytona.image to an image of the project (Settings → Sandbox). (${errorCode(err).message})`);
      }
      throw err;
    }
    // create() returns the handle when its wait ends, started or not
    if (sandbox.state !== "started") await sandbox.wait({ until: "started", timeoutSeconds: WAIT_SECONDS });
    if (sandbox.sandboxClass && sandbox.sandboxClass !== "linux") {
      spec.onWarning?.(`Daytona v2 created a "${sandbox.rawSandboxClass ?? sandbox.sandboxClass}" sandbox, not a Linux VM: pause/resume may not keep its memory`);
    }
    return this.driver(sandbox);
  }

  async connect(remoteId: string): Promise<RemoteDriver> {
    const { client } = await this.client();
    const sandbox = await client.get(remoteId);
    if (GONE.has(sandbox.state)) throw new Error(`Daytona sandbox ${remoteId} is ${sandbox.state}`);
    // start() resumes a paused sandbox (and waits out a pause still in progress); resuming re-arms the timeout
    if (sandbox.state !== "started") await sandbox.start({ timeoutSeconds: WAIT_SECONDS });
    else await this.rearm(sandbox);
    return this.driver(sandbox);
  }

  /** A sandbox reused while running: give it its full wall-clock budget again (when less than half is left). */
  private async rearm(sandbox: Sandbox): Promise<void> {
    const policy = sandbox.lifecyclePolicy;
    if (!policy?.timeoutSeconds || !policy.timeoutAt) return;
    const left = Date.parse(policy.timeoutAt) - Date.now();
    if (Number.isFinite(left) && left > (policy.timeoutSeconds * 1000) / 2) return;
    await sandbox.updateLifecyclePolicy({ timeoutSeconds: policy.timeoutSeconds }).catch(() => undefined);
  }

  async list(labels: Record<string, string>): Promise<RemoteVmSummary[]> {
    const { client } = await this.client();
    const out: RemoteVmSummary[] = [];
    const add = (sb: Sandbox) => {
      if (GONE.has(sb.state)) return;
      const have = sb.labels ?? {};
      if (Object.entries(labels).some(([k, v]) => have[k] !== v)) return;
      out.push({ remoteId: sb.id, state: String(sb.state), labels: { ...have } });
    };
    try {
      let cursor: string | undefined;
      do {
        const page = await client.search({ labels, states: LIVE_STATES, limit: 200, ...(cursor ? { cursor } : {}) });
        page.items.forEach(add);
        cursor = page.nextCursor;
      } while (cursor);
    } catch (err) {
      // a deployment without search: walk every sandbox and filter here
      if (errorCode(err).status !== 501 && errorCode(err).code !== "SEARCH_NOT_CONFIGURED") throw err;
      for await (const sb of client.iter()) add(sb);
    }
    return out;
  }

  async remove(remoteId: string): Promise<void> {
    const { client } = await this.client();
    try {
      await client.delete(remoteId, { timeoutSeconds: WAIT_SECONDS });
    } catch (err) {
      if (isNotFound(err)) return;
      // already destroyed (or being destroyed) by another delete: that is what was asked
      const state = await client.get(remoteId).then((sb) => String(sb.state), (e) => (isNotFound(e) ? "destroyed" : undefined));
      if (state && GONE.has(state)) return;
      throw err;
    }
  }

  /**
   * The reaper's idle stop of a pooled VM. A Linux v2 sandbox is not persistent (pause and stop are
   * refused with 409), so it is deleted instead: the pool then finds it gone and makes a new one.
   * A computer's machine is never deleted here: it hibernates through the ComputerManager.
   */
  async suspendById(remoteId: string): Promise<void> {
    const { client } = await this.client();
    let sandbox: Sandbox;
    try {
      sandbox = await client.get(remoteId);
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
    if (GONE.has(sandbox.state)) return;
    if (sandbox.labels?.[COMPUTER_LABEL]) throw new Error(DAYTONA_V2_COMPUTER_HIBERNATES);
    await this.remove(remoteId);
  }

  /** Change a sandbox's network rule while it exists (full replacement; "open" resets it). */
  async updateNetwork(remoteId: string, network: SandboxNetwork): Promise<boolean> {
    const policy = daytonaV2NetworkPolicy(network);
    const { client } = await this.client();
    const sandbox = await client.get(remoteId);
    const { etag, desired } = await sandbox.getNetworkPolicy();
    const same = (a: readonly string[] | null | undefined, b: readonly string[] | null | undefined) => [...(a ?? [])].sort().join(",") === [...(b ?? [])].sort().join(",");
    if (!policy ? !desired : !!desired && desired.blockAll === !!policy.blockAll && same(desired.allowDomains, policy.allowDomains) && same(desired.allowCidrs, policy.allowCidrs)) return false;
    if (policy) await sandbox.updateNetworkPolicy(policy, { ifMatch: etag });
    else await sandbox.resetNetworkPolicy({ ifMatch: etag });
    return true;
  }

  /** Computers hibernate: memory and disk snapshots, VMs made again from them. */
  async hibernation(): Promise<Hibernation> {
    const { client, maxTimeoutSeconds, hibernate } = await this.client();
    const snap = (x: SdkSnapshot): MachineSnapshot => ({
      id: x.id, name: x.name, status: String(x.status ?? ""),
      ...(x.error ? { error: x.error } : {}),
      ...(x.createdAt ? { createdAt: x.createdAt } : {}),
      ...(typeof x.bytes === "number" ? { bytes: x.bytes } : {}),
      ...(typeof x.memoryBytes === "number" ? { memoryBytes: x.memoryBytes } : {}),
      ...(x.sandboxId ? { sandboxId: x.sandboxId } : {}),
    });
    return {
      settings: hibernate,
      snapshot: async (remoteId, name) => {
        const sandbox = await client.get(remoteId);
        return snap(await sandbox.createSnapshot(name));
      },
      getSnapshot: async (id) => {
        try {
          return snap(await client.snapshots.get(id));
        } catch (err) {
          if (isNotFound(err)) return undefined;
          throw err;
        }
      },
      listSnapshots: async (match) => {
        const out: MachineSnapshot[] = [];
        for await (const x of client.snapshots.iter()) if (match(x.name)) out.push(snap(x));
        return out;
      },
      deleteSnapshot: async (id) => {
        try {
          await client.snapshots.delete(id);
        } catch (err) {
          if (!isNotFound(err)) throw err;
        }
      },
      restore: (snapshotId, spec) => this.restore(client, snapshotId, spec, maxTimeoutSeconds),
      machine: async (remoteId) => {
        try {
          const sandbox = await client.get(remoteId);
          if (GONE.has(sandbox.state)) return undefined;
          return { state: String(sandbox.state), ...(sandbox.lifecyclePolicy?.timeoutAt ? { timeoutAt: sandbox.lifecyclePolicy.timeoutAt } : {}) };
        } catch (err) {
          if (isNotFound(err)) return undefined;
          throw err;
        }
      },
    };
  }

  /**
   * A computer's VM from its snapshot: started, with the computer's lifecycle (the same as at
   * create), then its network rule applied (a snapshot create takes none). When the rule cannot
   * be applied the VM is deleted again: it never runs with a wider network than asked.
   */
  private async restore(client: DaytonaV2Client, snapshotId: string, spec: RestoreSpec, maxTimeoutSeconds: number): Promise<RemoteDriver> {
    daytonaV2NetworkPolicy(spec.network); // a rule the provider cannot enforce: refused before anything is created
    const sandbox = await client.createFromSnapshot(snapshotId, {
      name: spec.name,
      labels: spec.labels,
      lifecyclePolicy: daytonaV2Lifecycle({ persistent: { idleStopMinutes: 0 }, keep: true, lifetimeMinutes: 0 }, maxTimeoutSeconds),
      ...(spec.idempotencyKey ? { idempotencyKey: spec.idempotencyKey } : {}),
      waitSeconds: WAIT_SECONDS,
    });
    try {
      if (sandbox.state !== "started") await sandbox.wait({ until: "started", timeoutSeconds: WAIT_SECONDS });
      await this.updateNetwork(sandbox.id, spec.network);
    } catch (err) {
      await this.remove(sandbox.id).catch(() => undefined);
      throw new Error(`The VM made from snapshot ${snapshotId} could not start with the computer's network rule (deleted again): ${errorCode(err).message}`);
    }
    return this.driver(sandbox);
  }

  private driver(sandbox: Sandbox): RemoteDriver {
    return {
      remoteId: sandbox.id,
      async exec(command, opts): Promise<RemoteExecResult> {
        const seconds = opts.timeoutMs ? Math.max(1, Math.ceil(opts.timeoutMs / 1000)) : undefined;
        try {
          // argv, not a shell string: the same bash -c as everywhere else, no image shell guessing
          const r = await sandbox.exec({ argv: ["bash", "-c", command] }, {
            ...(opts.cwd ? { cwd: opts.cwd } : {}),
            ...(opts.env && Object.keys(opts.env).length ? { env: opts.env } : {}),
            ...(seconds ? { timeoutSeconds: seconds, executionTimeoutSeconds: seconds } : {}),
          });
          if (r.reason === "timed_out") return { exitCode: 124, stdout: r.stdout, stderr: r.stderr || `timed out after ${seconds} s`, timedOut: true };
          const exitCode = r.exitCode ?? (r.signal ? 128 + (({ KILL: 9, TERM: 15, INT: 2, HUP: 1, QUIT: 3 } as Record<string, number>)[r.signal] ?? 0) : 1);
          return { exitCode, stdout: r.stdout, stderr: r.stderr };
        } catch (err) {
          const { code, message } = errorCode(err);
          if (code === "REQUEST_TIMEOUT" || /timeout|timed out/i.test(message)) return { exitCode: 124, stdout: "", stderr: message, timedOut: true };
          throw err;
        }
      },
      readFile: async (path) => sandbox.fs.readBytes(path),
      writeFile: async (path, data) => { await sandbox.fs.writeBytes(path, data); },
      // never paused: a Linux v2 sandbox is not persistent (pause and stop are refused); an idle
      // pooled or warm VM keeps running until the reaper deletes it or its wall clock does
      suspend: async () => {},
      resume: async () => {
        await sandbox.refreshData().catch(() => undefined);
        if (sandbox.state !== "started") await sandbox.start({ timeoutSeconds: WAIT_SECONDS });
      },
      // activity pushes the idle timeout
      keepAlive: async () => { await sandbox.resetIdleTimer(); },
      destroy: async () => { await sandbox.delete({ timeoutSeconds: WAIT_SECONDS }); },
      spawn: async (command, opts) => {
        const handle = await sandbox.process.start({ argv: ["bash", "-c", command] }, {
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          ...(opts.env && Object.keys(opts.env).length ? { env: opts.env } : {}),
          // open input: the CLI engine streams its protocol to the program's stdin
          ...(opts.stdin ? { stdin: "open" as const } : {}),
          keepLogs: "until_cleanup",
        });
        return followDaytonaProcess(handle as unknown as DaytonaProcessHandleLike, { stdin: !!opts.stdin });
      },
      pty: async (command, opts) => {
        const { handle, connection } = await sandbox.pty.attach(`bash -lc ${shq(command)}`, {
          terminal: { cols: opts.cols, rows: opts.rows },
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          ...(opts.env && Object.keys(opts.env).length ? { env: opts.env } : {}),
        });
        const done = handle.wait().then(
          (w) => ({ exitCode: w.exitCode ?? (w.signal ? 128 + (SIGNALS[w.signal] ?? 0) : 1) }),
          () => ({ exitCode: 137 }),
        ).finally(() => { try { connection.close(); } catch { /* closed */ } });
        return {
          output: connection.readable,
          write: async (data) => { connection.write(data); },
          resize: async (cols, rows) => { await handle.resize(cols, rows); },
          kill: async () => { await handle.kill({ signal: "TERM", escalateAfterSeconds: 3, escalateTo: "KILL" }).catch(() => undefined); },
          wait: () => done,
        };
      },
      connectProcess: async (id) => followDaytonaProcess(sandbox.process.connect(id) as unknown as DaytonaProcessHandleLike),
      portEndpoint: (port, opts) => daytonaV2PortEndpoint(sandbox, port, opts),
    };
  }
}

/** Preview tokens (header form) expire after about an hour: longer uses take a signed link. */
const PREVIEW_HEADER_TTL_SECONDS = 50 * 60;
/** Signed preview links live at most this long (the VM's wall clock is at most 24 h). */
const MAX_SIGNED_LINK_SECONDS = 24 * 3600;

/**
 * A VM port as seen from this server: a signed preview link (the token in the host name, valid up
 * to 24 h, no headers) when the caller needs it longer than a preview token lasts, else the
 * preview URL with its token header. WebSocket upgrades work through both; the process must
 * listen on 0.0.0.0 (127.0.0.1 gets a 502 from the proxy).
 */
export async function daytonaV2PortEndpoint(
  sandbox: Pick<Sandbox, "ports">, port: number, opts: { protocol?: "http" | "https" | "ws"; ttlSeconds?: number } = {},
): Promise<RemotePortEndpoint> {
  const ws = opts.protocol === "ws";
  const toProtocol = (url: string) => (ws ? url.replace(/^http/, "ws") : url);
  const ttl = opts.ttlSeconds ?? MAX_SIGNED_LINK_SECONDS;
  if (ttl > PREVIEW_HEADER_TTL_SECONDS) {
    const link = await sandbox.ports.signedPreviewLink(port, { expiresInSeconds: Math.min(ttl, MAX_SIGNED_LINK_SECONDS) });
    return { url: toProtocol(link.url), headers: { "X-Daytona-Skip-Preview-Warning": "true" }, expiresAt: link.expiresAt };
  }
  const link = await sandbox.ports.previewLink(port);
  return {
    url: toProtocol(link.url),
    headers: { "X-Daytona-Skip-Preview-Warning": "true", ...(link.token ? { "X-Daytona-Preview-Token": link.token } : {}) },
    ...(link.expiresAt ? { expiresAt: link.expiresAt } : {}),
  };
}

const SIGNALS: Record<string, number> = { KILL: 9, TERM: 15, INT: 2, HUP: 1, QUIT: 3 };

/** The parts of a Daytona v2 process handle a followed process uses. */
export interface DaytonaProcessHandleLike {
  readonly id: string;
  streamLogs(options?: { signal?: AbortSignal; cursor?: string }): AsyncIterable<{ type: string; cursor?: string; frame?: { cursor?: string; channel?: string; data?: string } }>;
  wait(): Promise<{ exitCode?: number | null; signal?: string | null }>;
  kill(options?: { signal?: "TERM" | "KILL"; escalateAfterSeconds?: number; escalateTo?: "KILL" }): Promise<void>;
  writeStdin?(data: string | Uint8Array): Promise<void>;
  closeStdin?(): Promise<void>;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * A Daytona v2 process as a RemoteProcess: stdout and stderr from its log stream (SSE, resumed
 * from the last cursor when the connection drops), its exit from wait(). A VM that went away under
 * it (hibernated, deleted) reads as killed: wait() resolves 137 and never rejects (an unhandled
 * rejection there crashed the host in the spike).
 */
export function followDaytonaProcess(handle: DaytonaProcessHandleLike, o: { stdin?: boolean } = {}): RemoteProcess {
  const enc = new TextEncoder();
  let outCtl!: ReadableStreamDefaultController<Uint8Array>;
  let errCtl!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({ start(c) { outCtl = c; } });
  const stderr = new ReadableStream<Uint8Array>({ start(c) { errCtl = c; } });
  const ac = new AbortController();
  const close = () => {
    try { outCtl.close(); } catch { /* closed */ }
    try { errCtl.close(); } catch { /* closed */ }
  };
  const pump = (async () => {
    let cursor: string | undefined;
    for (let attempt = 0; attempt < 20 && !ac.signal.aborted; attempt++) {
      try {
        for await (const ev of handle.streamLogs({ signal: ac.signal, ...(cursor ? { cursor } : {}) })) {
          if (ev.type === "log" && ev.frame) {
            cursor = ev.frame.cursor ?? cursor;
            const ctl = ev.frame.channel === "stderr" ? errCtl : outCtl;
            try { ctl.enqueue(enc.encode(ev.frame.data ?? "")); } catch { /* reader gone */ }
          } else if (ev.cursor) {
            cursor = ev.cursor;
          }
          if (ev.type === "eof") return;
        }
        return;
      } catch {
        if (ac.signal.aborted) return;
        await new Promise((r) => setTimeout(r, 500)); // a cut stream: resume from the cursor
      }
    }
  })().finally(close);
  const done = (async () => {
    const w = await handle.wait();
    // the last frames may arrive after the exit: give the stream a moment
    await Promise.race([pump, new Promise((r) => setTimeout(r, 3000))]);
    ac.abort();
    return { exitCode: w.exitCode ?? (w.signal ? 128 + (SIGNALS[w.signal] ?? 0) : 1) };
  })().catch(() => {
    ac.abort();
    return { exitCode: 137 };
  });
  return {
    id: handle.id,
    stdout,
    stderr,
    wait: () => done,
    kill: async () => { await handle.kill({ signal: "TERM", escalateAfterSeconds: 3, escalateTo: "KILL" }).catch(() => undefined); },
    detach: () => ac.abort(),
    ...(o.stdin && handle.writeStdin && handle.closeStdin ? {
      writeStdin: async (data: string) => { await handle.writeStdin!(data); },
      closeStdin: async () => { await handle.closeStdin!(); },
    } : {}),
  };
}
