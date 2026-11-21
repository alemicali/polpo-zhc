/**
 * Named egress proxies for agents' browsers (settings.egressProxies, chosen by agent.browserEgress):
 * { home: "socks5://100.101.55.7:1080" }. The same rules for the config file and the API.
 */

/** A proxy's name: letters, digits, - and _. */
export const EGRESS_PROXY_NAME = /^[A-Za-z0-9_-]+$/;
/** A proxy URL: socks5, socks5h, socks4, http or https, a host and an optional port. */
export const EGRESS_PROXY_URL = /^(socks5h?|socks4|https?):\/\/[^\s/]+(:\d+)?\/?$/;

/** The proxies of a raw value, or an error naming the first bad one. */
export function parseEgressProxies(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("settings.egressProxies must be an object of name → proxy URL");
  const proxies: Record<string, string> = {};
  for (const [name, url] of Object.entries(raw as Record<string, unknown>)) {
    if (!EGRESS_PROXY_NAME.test(name) || typeof url !== "string" || !EGRESS_PROXY_URL.test(url)) {
      throw new Error(`settings.egressProxies.${name}: use a name of letters, digits, - and _, and a proxy URL like socks5://100.101.55.7:1080`);
    }
    proxies[name] = url;
  }
  return proxies;
}
