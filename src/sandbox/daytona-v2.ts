/**
 * Daytona v2 (settings.sandbox.providers.daytona.api = "v2"): Daytona's new service through
 * `@daytona/sdk` 2.x (`new Daytona({ apiKey }).v2`), installed under the npm alias
 * `@daytona/sdk-v2` next to the 0.x SDK that the v0 adapter keeps using (2.x cannot take a custom
 * API URL, which v0 settings allow).
 *
 * What changes from v0 (see remote-adapters.ts for the v0 adapter):
 * - Every sandbox is a Linux VM (`sandboxClass` "linux"; Polpo calls the class "linux-vm"): it
 *   pauses with its memory and processes and resumes; a Linux v2 sandbox cannot be "stopped".
 *   Our "suspend"/"stop" is a pause.
 * - It is created from a registered image (`providers.daytona.image`, default the Polpo runner
 *   image `DAYTONA_V2_RUNNER_IMAGE`) and sized per sandbox (`resources`), whatever the image.
 * - Lifecycle is a policy set at create: a wall-clock timeout (cannot be disabled, re-armed on
 *   every start/resume) and an idle timeout, each with an action (pause or delete). Computers are
 *   never deleted by it: both actions pause them.
 * - Network: `networkPolicy` with domains and CIDRs together (default-deny once a list is given),
 *   changeable while the sandbox runs (`updateNetwork`).
 * - exec returns stdout, stderr and the exit code apart: no stderr wrapper as on v0.
 *
 * Types come from the 2.x typings (`@daytona/sdk-v2/v2`); the SDK is imported lazily.
 */
import type { NetworkPolicyInput, LifecyclePolicyOptions, Resources, Sandbox, SandboxState } from "@daytona/sdk-v2/v2";
import type { DaytonaV2Client } from "@daytona/sdk-v2";
import { DAYTONA_V2_RUNNER_IMAGE, type EffectiveSandbox, type SandboxNetwork } from "@polpo-ai/core/sandbox";
import { remoteProviderCredentials } from "./remote-providers.js";
import {
  classifyAllowEntries, SandboxNetworkConfigError,
  type CreateSpec, type RemoteAdapter, type RemoteDriver, type RemoteExecResult, type RemoteVmSummary,
} from "./remote-adapters.js";

/** Size of a v2 sandbox when nothing is asked: the v0 runner snapshot's (2 vCPU, 4 GiB, 10 GiB). */
export const DAYTONA_V2_DEFAULT_RESOURCES = { cpus: 2, memoryMb: 4096, diskMb: 10240 } as const;
/**
 * A computer's wall-clock budget per start/resume (v2 requires one): after a day running without
 * a pause it is paused (memory kept), never deleted. Re-armed whenever we reconnect.
 */
/** A computer's wall-clock budget (re-armed on every use; Linux cannot pause on it). */
export const DAYTONA_V2_COMPUTER_TIMEOUT_SECONDS = 20 * 24 * 60 * 60;
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
 * - Computer: no idle action (the reaper pauses it); a long wall clock, re-armed on every use, with
 *   the class default action. Never deleted by us.
 * - Pooled/warm VM (may outlive the run): no idle action (the reaper pauses, then deletes it);
 *   wall clock → delete after lifetime + deleteAfterStop.
 * - One-run VM: idle or wall clock → delete after the run's lifetime.
 */
export function daytonaV2Lifecycle(spec: Pick<CreateSpec, "persistent" | "keep" | "lifetimeMinutes" | "deleteAfterStopMinutes">): LifecyclePolicyOptions {
  if (spec.persistent) {
    return { timeoutSeconds: DAYTONA_V2_COMPUTER_TIMEOUT_SECONDS, idleExpirySeconds: DAYTONA_V2_DISABLED };
  }
  const lifetime = Math.max(60, spec.lifetimeMinutes * 60);
  if (spec.keep) {
    return { timeoutSeconds: lifetime + (spec.deleteAfterStopMinutes ?? 60) * 60, onTimeout: "delete", idleExpirySeconds: DAYTONA_V2_DISABLED };
  }
  return { timeoutSeconds: lifetime, onTimeout: "delete", idleExpirySeconds: lifetime, onIdleTimeout: "delete" };
}

export class DaytonaV2Adapter implements RemoteAdapter {
  readonly provider = "daytona" as const;
  // a pause/resume round trip between two tool calls is not worth it; the idle policy pauses
  readonly fastSuspend = false;
  private cached?: { key: string; client: DaytonaV2Client; image?: string; region?: string };

  /** The v2 client for the current key (a project API key; the vault entry may change). */
  private async client(): Promise<{ client: DaytonaV2Client; image?: string; region?: string }> {
    const creds = await Promise.resolve(remoteProviderCredentials("daytona"));
    if (!creds?.apiKey) throw new Error("Daytona has no API key (Settings → Sandbox)");
    if (this.cached?.key !== creds.apiKey) {
      const { Daytona } = await import("@daytona/sdk-v2");
      this.cached = { key: creds.apiKey, client: new Daytona({ apiKey: creds.apiKey }).v2 };
    }
    return { client: this.cached.client, image: creds.image, region: creds.region };
  }

  async create(spec: CreateSpec): Promise<RemoteDriver> {
    // network rules are checked before anything is created
    const networkPolicy = daytonaV2NetworkPolicy(spec.sandbox.network);
    const { client, image: instanceImage, region } = await this.client();
    const opts = spec.sandbox.providerOptions;
    const image = (typeof opts.image === "string" && opts.image.trim()) || instanceImage || DAYTONA_V2_RUNNER_IMAGE;
    const sandboxRegion = (typeof opts.region === "string" && opts.region.trim()) || region;
    let sandbox: Sandbox;
    try {
      sandbox = await client.create(image, {
        ...(spec.name ? { name: spec.name } : {}),
        labels: spec.labels,
        resources: daytonaV2Resources(spec.sandbox),
        lifecyclePolicy: daytonaV2Lifecycle(spec),
        ...(networkPolicy ? { networkPolicy } : {}),
        ...(sandboxRegion ? { region: sandboxRegion } : {}),
        waitSeconds: WAIT_SECONDS,
      });
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
      if (!isNotFound(err)) throw err;
    }
  }

  /** Pause (memory and processes kept): a Linux v2 sandbox cannot be stopped. */
  async suspendById(remoteId: string): Promise<void> {
    const { client } = await this.client();
    const sandbox = await client.get(remoteId);
    if (sandbox.state === "started") await sandbox.pause({ timeoutSeconds: WAIT_SECONDS });
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
      // a Linux VM pauses with its memory; there is no stop
      suspend: async () => { await sandbox.pause({ timeoutSeconds: WAIT_SECONDS }); },
      resume: async () => {
        await sandbox.refreshData().catch(() => undefined);
        if (sandbox.state !== "started") await sandbox.start({ timeoutSeconds: WAIT_SECONDS });
      },
      // activity pushes the idle timeout
      keepAlive: async () => { await sandbox.resetIdleTimer(); },
      destroy: async () => { await sandbox.delete({ timeoutSeconds: WAIT_SECONDS }); },
    };
  }
}
