/**
 * Where an agent's browser goes out to the internet: through a named egress proxy (e.g. "home",
 * a residential line reached over Tailscale, `socks5://100.101.55.7:1080`) instead of the server's
 * own address, which some sites block (datacenter IP ranges).
 *
 * Settings: `settings.egressProxies: { home: "socks5://100.101.55.7:1080" }`; per agent:
 * `browserEgress: "home"`. Only the browser of those agents uses it (web search and HTTP tools
 * keep their own providers).
 *
 * The proxy may be off (a computer at home): then the browser goes out directly, from the server,
 * except for a profile that was signed in through the proxy. A logged-in account seen from
 * another place may be flagged, so that profile's browser pauses until the proxy is back.
 *
 * A remote computer (Daytona, E2B) with `egress` reaches the proxy through Tailscale inside its VM
 * (src/sandbox/tailnet-egress.ts): its browser, which runs in the VM, uses the forwarder there
 * (socks5://127.0.0.1:1081), with the same fallback and pause rules (decideRemoteEgress).
 */
import { existsSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import type { FileSystem } from "@polpo-ai/core/filesystem";
import type { Shell } from "@polpo-ai/core/shell";
import type { TailnetEgressRef } from "@polpo-ai/core/sandbox";
import { TAILNET_BROWSER_PROXY, tailnetEgress, type TailnetHost, type TailnetStatus } from "../sandbox/tailnet-egress.js";

/** Marks a profile used through an egress proxy: `<profile>/.polpo-egress` holds the proxy name. */
export const EGRESS_MARKER = ".polpo-egress";
const REACHABILITY_TTL_MS = 30_000;
const CONNECT_TIMEOUT_MS = 2_500;

export interface BrowserEgressConfig {
  /** The proxy's name in settings.egressProxies. */
  name: string;
  /** socks5://host:port or http://host:port */
  url: string;
  /** A remote computer's egress: through Tailscale in its VM (the browser runs there). */
  tailnet?: TailnetEgressRef;
}

export interface EgressDecision {
  /** Proxy for the browser; undefined: go out directly. */
  proxy?: string;
  /** Why the browser must not run now. */
  refusal?: string;
  /** For logs and the agent: "via home", "direct (home unreachable)". */
  label: string;
}

const reachability = new Map<string, { ok: boolean; at: number }>();

/** Can a TCP connection be opened to the proxy (cached a little)? */
export async function proxyReachable(url: string, now = Date.now()): Promise<boolean> {
  const hit = reachability.get(url);
  if (hit && now - hit.at < REACHABILITY_TTL_MS) return hit.ok;
  let host: string;
  let port: number;
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^\[|\]$/g, "");
    port = Number(u.port) || (u.protocol.startsWith("socks") ? 1080 : 8080);
  } catch {
    return false;
  }
  const ok = await new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    const done = (result: boolean) => { socket.destroy(); resolve(result); };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
  reachability.set(url, { ok, at: now });
  return ok;
}

/** Forget cached reachability (tests, or after a settings change). */
export function resetEgressReachability(): void {
  reachability.clear();
}

/** The proxy URL of an agent's egress, from settings; undefined when not configured. */
export function resolveBrowserEgress(
  agent: { browserEgress?: string },
  proxies: Record<string, string> | undefined,
): BrowserEgressConfig | undefined {
  const name = agent.browserEgress?.trim();
  if (!name) return undefined;
  const url = proxies?.[name];
  return url ? { name, url } : undefined;
}

/** What a decision needs to know about where the browser runs (this server, or a remote computer's VM). */
export interface EgressProbe {
  /** The proxy answers now. */
  reachable(): Promise<boolean>;
  /** The proxy URL the browser is started with when it does. */
  proxy: string;
  /** The profile was used through the proxy (EGRESS_MARKER in it). */
  markerExists(): Promise<boolean>;
  /** Mark the profile (when it exists): it is being used through the proxy. */
  writeMarker(): Promise<void>;
}

/** Decide, for the next browser call, where it goes out (the rules, wherever the browser runs). */
export async function decideEgressWith(egress: Pick<BrowserEgressConfig, "name">, probe: EgressProbe): Promise<EgressDecision> {
  if (await probe.reachable()) {
    await probe.writeMarker().catch(() => undefined);
    return { proxy: probe.proxy, label: `via ${egress.name}` };
  }
  if (await probe.markerExists().catch(() => false)) {
    return {
      label: `paused (${egress.name} unreachable)`,
      refusal: `The "${egress.name}" connection is unreachable (the computer it runs on may be off). `
        + "This browser profile is signed in through it, and a logged-in account showing up from another place may be flagged, "
        + "so the browser stays paused: try again later, or tell the person.",
    };
  }
  return { label: `direct (${egress.name} unreachable)` };
}

/** Decide for a browser on this server (the profile is a local directory). */
export async function decideEgress(egress: BrowserEgressConfig, profileDir: string | undefined): Promise<EgressDecision> {
  return decideEgressWith(egress, {
    proxy: egress.url,
    reachable: () => proxyReachable(egress.url),
    markerExists: async () => !!profileDir && existsSync(join(profileDir, EGRESS_MARKER)),
    writeMarker: async () => {
      if (profileDir && existsSync(profileDir)) {
        try { writeFileSync(join(profileDir, EGRESS_MARKER), egress.name); } catch { /* best effort */ }
      }
    },
  });
}

/** How much longer than its own timeout a call into a remote VM is waited for on this side. */
export const REMOTE_DEADLINE_GRACE_MS = 5_000;
/** A file upload into a remote VM (the tailnet's forwarder script, its key file). */
const REMOTE_WRITE_DEADLINE_MS = 30_000;
/**
 * The longest a browser call waits for its egress decision (the tailnet check): a bootstrap that
 * takes longer goes on in the background and the call decides without it (the next use waits for
 * the same check, never a second one).
 */
export const EGRESS_DECISION_DEADLINE_MS = 45_000;

/**
 * `promise`, or `onTimeout()` (its value, or what it throws) when it has not settled within `ms`:
 * this side's deadline, so a provider call that never returns, whatever timeout it was given, no
 * longer holds a tool call for minutes.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => { try { resolve(onTimeout()); } catch (err) { reject(err); } }, ms);
    timer.unref?.();
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** A command in a remote VM, waited for at most its timeout plus a grace on this side (exit 124 after). */
export function execWithin(
  shell: Shell, command: string, o: { timeoutMs: number; env?: Record<string, string>; cwd?: string },
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }> {
  return withDeadline(
    shell.execute(command, { timeout: o.timeoutMs, ...(o.env ? { env: o.env } : {}), ...(o.cwd ? { cwd: o.cwd } : {}) }),
    o.timeoutMs + REMOTE_DEADLINE_GRACE_MS,
    () => ({ exitCode: 124, stdout: "", stderr: `no answer from the computer within ${Math.round((o.timeoutMs + REMOTE_DEADLINE_GRACE_MS) / 1000)} s`, timedOut: true }),
  );
}

/** A run's shell and files in a remote VM, as a host for the tailnet runtime (every call bounded on this side). */
export function shellHost(shell: Shell, fs: FileSystem | undefined): TailnetHost {
  return {
    exec: async (command, o = {}) => execWithin(shell, command, { timeoutMs: o.timeoutMs ?? 30_000, ...(o.env ? { env: o.env } : {}) }),
    writeFile: async (path, data) => {
      const bounded = (p: Promise<void>) => withDeadline(p, REMOTE_WRITE_DEADLINE_MS, () => { throw new Error(`Could not write ${path} in the VM: no answer within ${REMOTE_WRITE_DEADLINE_MS / 1000} s`); });
      // through the provider's file API: contents never go through a command line
      if (fs?.writeFileBuffer) return bounded(fs.writeFileBuffer(path, data));
      if (fs) return bounded(fs.writeFile(path, new TextDecoder().decode(data)));
      // no file API: the bytes come from the command's environment (never its command line)
      const r = await shell.execute(`umask 077; printf '%s' "$POLPO_TAILNET_FILE" > '${path.replace(/'/g, `'\\''`)}'`, { env: { POLPO_TAILNET_FILE: new TextDecoder().decode(data) }, timeout: 30_000 });
      if (r.exitCode !== 0) throw new Error(`Could not write ${path} in the VM`);
    },
  };
}

/** Profiles marked as used through the tailnet in a VM (per shell: written once). */
const remoteMarked = new WeakMap<object, Set<string>>();

/**
 * Decide for a browser in a remote computer's VM: through the tailnet (brought up when needed)
 * while the proxy answers there, else directly from the VM, or paused for a profile signed in
 * through it. `profilePath`: the profile directory in the VM, relative to $HOME.
 */
export async function decideRemoteEgress(
  egress: BrowserEgressConfig & { tailnet: TailnetEgressRef },
  host: TailnetHost & { key?: object },
  profilePath: string | undefined,
  onStatus?: (status: TailnetStatus) => void,
): Promise<EgressDecision> {
  const dir = profilePath ? `"$HOME"/'${profilePath.replace(/'/g, `'\\''`)}'` : undefined;
  const key = host.key ?? host;
  let status: TailnetStatus | undefined;
  const decision = await decideEgressWith(egress, {
    proxy: TAILNET_BROWSER_PROXY,
    reachable: async () => {
      // bounded: a bootstrap that takes longer goes on (shared with the next use); this call decides without it
      status = await withDeadline(tailnetEgress.ensure(host, egress.tailnet), EGRESS_DECISION_DEADLINE_MS, () => ({
        computerId: egress.tailnet.computerId, tailnet: "starting", proxyReachable: false, checkedAt: new Date().toISOString(),
        error: `The tailnet check of computer "${egress.tailnet.computerId}" is taking longer than ${EGRESS_DECISION_DEADLINE_MS / 1000} s (it goes on; the next browser call uses it)`,
      }));
      onStatus?.(status);
      return status.tailnet === "up" && status.proxyReachable;
    },
    markerExists: async () => {
      if (!dir) return false;
      if (remoteMarked.get(key)?.has(dir)) return true;
      return (await host.exec(`test -f ${dir}/${EGRESS_MARKER}`, { timeoutMs: 15_000 })).exitCode === 0;
    },
    writeMarker: async () => {
      if (!dir || remoteMarked.get(key)?.has(dir)) return;
      const r = await host.exec(`if [ -d ${dir} ]; then printf '%s' '${egress.name}' > ${dir}/${EGRESS_MARKER} && echo marked; fi`, { timeoutMs: 15_000 });
      if (r.exitCode === 0 && r.stdout.includes("marked")) {
        let set = remoteMarked.get(key);
        if (!set) remoteMarked.set(key, (set = new Set()));
        set.add(dir);
      }
    },
  });
  if (!decision.proxy && !decision.refusal && status?.error) return { ...decision, label: `${decision.label}: ${status.error}` };
  // a paused profile: the agent sees why (e.g. re-joining the tailnet failed, tried again on the next use)
  if (decision.refusal && status?.error) return { ...decision, refusal: `${decision.refusal} (${status.error})` };
  return decision;
}
