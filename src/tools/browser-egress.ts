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

/** A run's shell and files in a remote VM, as a host for the tailnet runtime. */
export function shellHost(shell: Shell, fs: FileSystem | undefined): TailnetHost {
  return {
    exec: async (command, o = {}) => shell.execute(command, { ...(o.timeoutMs ? { timeout: o.timeoutMs } : {}), ...(o.env ? { env: o.env } : {}) }),
    writeFile: async (path, data) => {
      // through the provider's file API: contents never go through a command line
      if (fs?.writeFileBuffer) return fs.writeFileBuffer(path, data);
      if (fs) return fs.writeFile(path, new TextDecoder().decode(data));
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
      status = await tailnetEgress.ensure(host, egress.tailnet);
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
