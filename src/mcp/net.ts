/**
 * Network rules for remote connectors: https only (http only on localhost, and only when local
 * addresses are allowed), and no private / loopback / link-local / CGNAT (tailnet) address unless
 * `settings.connectors.allowPrivateNetwork` (or POLPO_CONNECTORS_ALLOW_PRIVATE=1) says so. A
 * connector URL is checked when it is saved and again before every connection.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPrivateAddress } from "../server/oauth.js";

export type ResolveHost = (hostname: string) => Promise<string[]>;
const defaultResolve: ResolveHost = async (hostname) => (await lookup(hostname, { all: true })).map((a) => a.address);

export class ConnectorUrlError extends Error {}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export interface UrlPolicy {
  allowPrivateNetwork?: boolean;
  resolve?: ResolveHost;
}

/** Whether private addresses are allowed, from settings or the environment. */
export function allowPrivateNetwork(settings?: { connectors?: { allowPrivateNetwork?: boolean } }): boolean {
  return settings?.connectors?.allowPrivateNetwork === true || process.env.POLPO_CONNECTORS_ALLOW_PRIVATE === "1";
}

/** Throws ConnectorUrlError when the URL may not be used for a remote connector. Returns the parsed URL. */
export async function checkConnectorUrl(raw: string, policy: UrlPolicy = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConnectorUrlError(`Not a valid URL: ${raw}`);
  }
  if (url.username || url.password) throw new ConnectorUrlError("Put credentials in the connector's auth, not in the URL");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (url.protocol === "http:") {
    if (!LOCAL_HOSTS.has(host) || !policy.allowPrivateNetwork) {
      throw new ConnectorUrlError("Connector URLs must use https (http only for localhost, when settings.connectors.allowPrivateNetwork is on)");
    }
  } else if (url.protocol !== "https:") {
    throw new ConnectorUrlError("Connector URLs must use https");
  }
  if (policy.allowPrivateNetwork) return url;
  const addresses = isIP(host) ? [host] : await (policy.resolve ?? defaultResolve)(host).catch(() => [] as string[]);
  if (addresses.length === 0) throw new ConnectorUrlError(`Cannot resolve ${host}`);
  if (LOCAL_HOSTS.has(host) || addresses.some(isPrivateAddress)) {
    throw new ConnectorUrlError(`${host} is a private or local network address; allow it with settings.connectors.allowPrivateNetwork`);
  }
  return url;
}
