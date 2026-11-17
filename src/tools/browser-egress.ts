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
 */
import { existsSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

/** Marks a profile used through an egress proxy: `<profile>/.polpo-egress` holds the proxy name. */
export const EGRESS_MARKER = ".polpo-egress";
const REACHABILITY_TTL_MS = 30_000;
const CONNECT_TIMEOUT_MS = 2_500;

export interface BrowserEgressConfig {
  /** The proxy's name in settings.egressProxies. */
  name: string;
  /** socks5://host:port or http://host:port */
  url: string;
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

/** Decide, for the next browser call, where it goes out. */
export async function decideEgress(egress: BrowserEgressConfig, profileDir: string | undefined): Promise<EgressDecision> {
  if (await proxyReachable(egress.url)) {
    if (profileDir && existsSync(profileDir)) {
      try { writeFileSync(join(profileDir, EGRESS_MARKER), egress.name); } catch { /* best effort */ }
    }
    return { proxy: egress.url, label: `via ${egress.name}` };
  }
  const signedInThrough = profileDir && existsSync(join(profileDir, EGRESS_MARKER));
  if (signedInThrough) {
    return {
      label: `paused (${egress.name} unreachable)`,
      refusal: `The "${egress.name}" connection is unreachable (the computer it runs on may be off). `
        + "This browser profile is signed in through it, and a logged-in account showing up from another place may be flagged, "
        + "so the browser stays paused: try again later, or tell the person.",
    };
  }
  return { label: `direct (${egress.name} unreachable)` };
}
