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
import { lookup } from "node:dns/promises";
import type { EffectiveSandbox, RemoteSandboxProvider } from "@polpo-ai/core/sandbox";
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
}

export interface RemoteVmSummary { remoteId: string; state: string; labels: Record<string, string>; createdAt?: string }

export interface RemoteAdapter {
  readonly provider: RemoteSandboxProvider;
  create(spec: CreateSpec): Promise<RemoteDriver>;
  connect(remoteId: string): Promise<RemoteDriver>;
  list(labels: Record<string, string>): Promise<RemoteVmSummary[]>;
  remove(remoteId: string): Promise<void>;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** DNS resolvers Daytona VMs use (/etc/resolv.conf): kept reachable in allowlist mode. */
const DAYTONA_RESOLVERS = ["1.1.1.1/32", "1.0.0.1/32", "8.8.8.8/32", "100.65.160.1/32"];

/** Allowlist entries as host names (drop ports). */
function allowHosts(sandbox: EffectiveSandbox): string[] {
  return (sandbox.network.allow ?? []).map((a) => a.trim().replace(/:\d+$/, "")).filter(Boolean);
}

// ── Daytona ─────────────────────────────────────────────────────────────

class DaytonaAdapter implements RemoteAdapter {
  readonly provider = "daytona" as const;
  private cached?: { fingerprint: string; client: any };

  /** A client for the current key (the key lives in a vault entry a person may change). */
  private async client(): Promise<any> {
    const creds = await Promise.resolve(remoteProviderCredentials("daytona"));
    if (!creds?.apiKey) throw new Error("Daytona has no API key (Settings → Sandbox)");
    const fingerprint = JSON.stringify([creds.apiKey, creds.apiUrl, creds.target]);
    if (this.cached?.fingerprint !== fingerprint) {
      const { Daytona } = await import("@daytonaio/sdk");
      this.cached = { fingerprint, client: new Daytona({ apiKey: creds.apiKey, apiUrl: creds.apiUrl || undefined, target: creds.target || undefined }) };
    }
    return this.cached.client;
  }

  async create(spec: CreateSpec): Promise<RemoteDriver> {
    const client = await this.client();
    const { network } = spec.sandbox;
    const params: Record<string, unknown> = {
      autoStopInterval: spec.lifetimeMinutes,
      labels: spec.labels,
      ...(spec.keep ? { autoDeleteInterval: spec.deleteAfterStopMinutes ?? 60 } : { ephemeral: true }),
      ...(spec.sandbox.providerOptions.snapshot ? { snapshot: String(spec.sandbox.providerOptions.snapshot) } : {}),
    };
    if (network.mode === "deny") params.networkBlockAll = true;
    if (network.mode === "allowlist") {
      // Daytona filters by address: resolve the names now (wildcards resolve their base domain)
      const cidrs = new Set<string>();
      for (const host of allowHosts(spec.sandbox)) {
        const name = host.replace(/^\*\./, "");
        if (/^[\d.]+(\/\d+)?$/.test(name)) { cidrs.add(name.includes("/") ? name : `${name}/32`); continue; }
        const addrs = await lookup(name, { all: true, family: 4 }).catch(() => []);
        for (const a of addrs) cidrs.add(`${a.address}/32`);
      }
      // the VM resolves names through public resolvers: without them nothing resolves
      if (cidrs.size) for (const dns of DAYTONA_RESOLVERS) cidrs.add(dns);
      if (cidrs.size) params.networkAllowList = [...cidrs].slice(0, 50).join(",");
      else params.networkBlockAll = true;
    }
    return this.driver(await client.create(params, { timeout: 180 }));
  }

  async connect(remoteId: string): Promise<RemoteDriver> {
    const client = await this.client();
    const sandbox = await client.get(remoteId);
    if (sandbox.state !== "started") await sandbox.start(120);
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

  private driver(sandbox: any): RemoteDriver {
    return {
      remoteId: sandbox.id,
      async exec(command, opts) {
        const seconds = opts.timeoutMs ? Math.max(1, Math.ceil(opts.timeoutMs / 1000)) : undefined;
        try {
          const r = await sandbox.process.executeCommand(`bash -c ${q(command)}`, opts.cwd, opts.env, seconds);
          return { exitCode: r.exitCode, stdout: r.result ?? "", stderr: "" };
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
      resume: async () => { await sandbox.refreshData?.().catch(() => undefined); if (sandbox.state !== "started") await sandbox.start(120); },
      destroy: async () => { await sandbox.delete(); },
    };
  }
}

// ── E2B ─────────────────────────────────────────────────────────────────

class E2BAdapter implements RemoteAdapter {
  readonly provider = "e2b" as const;

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
    const opts: Record<string, unknown> = { ...conn, timeoutMs: spec.lifetimeMinutes * 60_000, metadata: spec.labels };
    if (network.mode === "deny") opts.allowInternetAccess = false;
    if (network.mode === "allowlist") opts.network = { allowOut: allowHosts(spec.sandbox), denyOut: ["0.0.0.0/0"] };
    const template = (spec.sandbox.providerOptions.template as string | undefined) || defaultTemplate || undefined;
    const sbx = template ? await mod.Sandbox.create(template, opts as any) : await mod.Sandbox.create(opts as any);
    return this.driver(mod, conn, sbx, spec.lifetimeMinutes);
  }

  async connect(remoteId: string): Promise<RemoteDriver> {
    const { mod, conn } = await this.sdk();
    // connecting resumes a paused sandbox
    return this.driver(mod, conn, await mod.Sandbox.connect(remoteId, conn as any), undefined);
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
