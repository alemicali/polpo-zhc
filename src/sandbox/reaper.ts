/**
 * Server-side upkeep of the remote sandbox pool (one per project):
 *   - delete idle and warm VMs past their deleteAt;
 *   - delete VMs leased by a process that no longer exists (a crashed task runner);
 *   - keep the instance's warm VMs topped up (settings.sandbox.warm, default none);
 *   - at start and every few minutes, delete VMs labelled with this project that the registry
 *     does not know (left behind by a crash between creation and bookkeeping).
 * Provider-side safety nets stay on as well: VMs stop after their lifetime and pooled Daytona VMs
 * delete themselves after being stopped too long.
 */
import { hostname } from "node:os";
import {
  DEFAULT_LIFECYCLE, REMOTE_SANDBOX_PROVIDERS, resolveSandbox, normalizeSandboxSettings,
  type RemoteSandboxProvider, type SandboxSettings,
} from "@polpo-ai/core/sandbox";
import { SandboxPool, instanceLabel, poolFilePath, poolKey, type PoolEntry } from "./pool.js";
import { remoteAdapter, type RemoteAdapter } from "./remote-adapters.js";
import { configuredRemoteProviders } from "./remote-providers.js";
import { lifetimeMinutes } from "./remote.js";

const TICK_MS = 60_000;
const RECONCILE_EVERY_TICKS = 10;
/** A labelled VM younger than this may be between creation and bookkeeping: left alone. */
const ORPHAN_GRACE_MS = 5 * 60_000;
/** Warm VMs are replaced after this long, so they follow image updates. */
const WARM_MAX_AGE_MINUTES = 12 * 60;

export interface ReaperEvents {
  onDeleted?: (entry: { remoteId: string; provider: RemoteSandboxProvider; reason: "expired" | "orphan"; owner?: string }) => void;
  onWarmCreated?: (entry: { remoteId: string; provider: RemoteSandboxProvider }) => void;
  onStopped?: (entry: { remoteId: string; provider: RemoteSandboxProvider; owner?: string }) => void;
  onError?: (message: string) => void;
}

export interface ReaperOptions extends ReaperEvents {
  polpoDir: string;
  /** The instance's current sandbox settings. */
  settings: () => SandboxSettings | undefined;
  /** Tests inject adapters and a clock; providers without a key are skipped. */
  adapter?: (provider: RemoteSandboxProvider) => RemoteAdapter;
  configured?: () => RemoteSandboxProvider[];
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class SandboxReaper {
  private timer?: ReturnType<typeof setInterval>;
  private ticks = 0;
  private running = false;
  readonly pool: SandboxPool;
  private readonly instance: string;
  private readonly host = hostname();

  constructor(private readonly opts: ReaperOptions) {
    this.pool = new SandboxPool(poolFilePath(opts.polpoDir), process.env.HOSTNAME ?? "");
    this.instance = instanceLabel(opts.polpoDir);
  }

  start(): void {
    if (this.timer) return;
    void this.tick(true);
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private adapter(p: RemoteSandboxProvider): RemoteAdapter {
    return (this.opts.adapter ?? remoteAdapter)(p);
  }

  private configured(): RemoteSandboxProvider[] {
    return (this.opts.configured ?? configuredRemoteProviders)() as RemoteSandboxProvider[];
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** One pass: expire, recover orphans, top up warm VMs; reconcile with the providers every few passes. */
  async tick(reconcile = false): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.expire();
      await this.refillWarm();
      if (reconcile || ++this.ticks % RECONCILE_EVERY_TICKS === 0) await this.reconcile();
    } catch (err) {
      this.opts.onError?.(`Sandbox pool upkeep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Idle VMs (and shared ones nobody uses): stop them at stopAt, delete them deleteAfterStopMinutes
   * after stopping. VMs leased by dead processes on this host are orphans: deleted. Shared VMs
   * lose holders whose process died.
   */
  async expire(): Promise<void> {
    const alive = this.opts.isAlive ?? processAlive;
    const localHost = process.env.HOSTNAME ?? "";
    const now = this.now();
    const { doomed, toStop } = await this.pool.update((entries) => {
      const doomed: Array<PoolEntry & { reason: "expired" | "orphan" }> = [];
      const toStop: PoolEntry[] = [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i]!;
        if (e.state === "leased") {
          if (e.pid && (!e.host || e.host === localHost) && !alive(e.pid)) { doomed.push({ ...e, reason: "orphan" }); entries.splice(i, 1); }
          continue;
        }
        if (e.state === "shared" && e.holders?.length) {
          e.holders = e.holders.filter((h) => !((!h.host || h.host === localHost) && !alive(h.pid)));
          if (e.holders.length) continue;
          Object.assign(e, { idleSince: new Date(now).toISOString(), stopAt: new Date(now + DEFAULT_LIFECYCLE.stopAfterIdleMinutes * 60_000).toISOString(), deleteAfterStopMinutes: e.deleteAfterStopMinutes ?? DEFAULT_LIFECYCLE.deleteAfterStopMinutes });
        }
        if (e.deleteAt && Date.parse(e.deleteAt) <= now) { doomed.push({ ...e, reason: "expired" }); entries.splice(i, 1); continue; }
        if (!e.stoppedAt && e.stopAt && Date.parse(e.stopAt) <= now) {
          toStop.push({ ...e });
          e.stoppedAt = new Date(now).toISOString();
          e.deleteAt = new Date(now + (e.deleteAfterStopMinutes ?? DEFAULT_LIFECYCLE.deleteAfterStopMinutes) * 60_000).toISOString();
        }
      }
      return { doomed, toStop };
    });
    for (const e of toStop) {
      await this.adapter(e.provider).suspendById(e.remoteId).catch((err) => this.opts.onError?.(`Could not stop ${e.provider} VM ${e.remoteId}: ${(err as Error).message}`));
      this.opts.onStopped?.({ remoteId: e.remoteId, provider: e.provider, owner: e.owner || undefined });
    }
    for (const e of doomed) {
      await this.adapter(e.provider).remove(e.remoteId).catch((err) => this.opts.onError?.(`Could not delete ${e.provider} VM ${e.remoteId}: ${(err as Error).message}`));
      this.opts.onDeleted?.({ remoteId: e.remoteId, provider: e.provider, reason: e.reason, owner: e.owner || undefined });
    }
  }

  /** Keep settings.sandbox.warm[provider] VMs ready, suspended, with the instance's default rules. */
  async refillWarm(): Promise<void> {
    const settings = normalizeSandboxSettings(this.opts.settings());
    const configured = new Set(this.configured());
    for (const provider of REMOTE_SANDBOX_PROVIDERS) {
      const wanted = configured.has(provider) ? settings?.warm?.[provider] ?? 0 : 0;
      const sandbox = resolveSandbox({ instance: { ...(settings ?? {}), provider } }, { scope: "task", available: new Set([provider]) });
      sandbox.provider = provider;
      const key = poolKey(provider, sandbox);
      const warm = this.pool.list().filter((e) => e.state === "warm" && e.provider === provider);
      // warm VMs with another key (settings changed) or too old go away
      const stale = warm.filter((e) => e.key !== key);
      for (const e of stale) {
        await this.pool.remove(e.remoteId);
        await this.adapter(provider).remove(e.remoteId).catch(() => undefined);
      }
      let have = warm.length - stale.length;
      // surplus (the setting went down)
      for (const e of warm.filter((x) => x.key === key).slice(wanted)) {
        await this.pool.remove(e.remoteId);
        await this.adapter(provider).remove(e.remoteId).catch(() => undefined);
        have--;
      }
      for (; have < wanted; have++) {
        try {
          const driver = await this.adapter(provider).create({
            sandbox, lifetimeMinutes: lifetimeMinutes(sandbox), keep: true,
            deleteAfterStopMinutes: WARM_MAX_AGE_MINUTES,
            labels: { polpo: "1", "polpo-instance": this.instance, "polpo-agent": "-", "polpo-scope": "warm" },
          });
          await driver.suspend().catch(() => undefined);
          await this.pool.addWarm({ remoteId: driver.remoteId, provider, key }, WARM_MAX_AGE_MINUTES);
          this.opts.onWarmCreated?.({ remoteId: driver.remoteId, provider });
        } catch (err) {
          this.opts.onError?.(`Could not prepare a warm ${provider} VM: ${(err as Error).message}`);
          break;
        }
      }
    }
  }

  /** Delete VMs labelled with this project that the registry does not know. */
  async reconcile(): Promise<void> {
    const known = new Set(this.pool.list().map((e) => e.remoteId));
    for (const provider of this.configured()) {
      let vms;
      try {
        vms = await this.adapter(provider).list({ "polpo-instance": this.instance });
      } catch (err) {
        this.opts.onError?.(`Could not list ${provider} VMs: ${(err as Error).message}`);
        continue;
      }
      for (const vm of vms) {
        if (known.has(vm.remoteId)) continue;
        if (vm.labels["polpo-instance"] !== this.instance) continue;
        const age = vm.createdAt ? this.now() - Date.parse(vm.createdAt) : Infinity;
        if (age < ORPHAN_GRACE_MS) continue;
        await this.adapter(provider).remove(vm.remoteId).catch((err) => this.opts.onError?.(`Could not delete orphan ${provider} VM ${vm.remoteId}: ${(err as Error).message}`));
        this.opts.onDeleted?.({ remoteId: vm.remoteId, provider, reason: "orphan", owner: vm.labels["polpo-agent"] });
      }
    }
  }
}

export { DEFAULT_LIFECYCLE };
