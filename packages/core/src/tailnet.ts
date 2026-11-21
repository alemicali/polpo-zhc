/**
 * Tailscale inside remote computers (settings.tailscale): a remote computer (Daytona, E2B) joins
 * the tailnet from inside its VM so its browser can go out through a proxy that only the tailnet
 * reaches (settings.egressProxies, e.g. "home" = socks5://100.101.55.7:1080 on a machine at home).
 *
 * The auth key is never in the settings: they hold a vault reference (owner + service), as the
 * remote providers' API keys do. The key should be ephemeral (the node disappears when the VM
 * goes away), reusable (every computer and every restart uses it), pre-approved and tagged
 * (tag:polpo-sandbox by default), so an ACL can let sandboxes reach the proxy port and nothing else.
 *
 * The rules shared by the config file, the API and the agents' tools live here; the runtime in the
 * VM is src/sandbox/tailnet-egress.ts.
 */
import { normalizeVaultRef, type VaultRef } from "./vault-ref.js";

export interface TailscaleSettings {
  /** Vault entry holding the auth key (any of authKey, auth_key, key, token). */
  authKey: VaultRef;
  /** Tags the sandbox nodes advertise (the auth key must be allowed to use them). Default ["tag:polpo-sandbox"]. */
  tags?: string[];
  /** Node names: `<hostnamePrefix>-<instance>-<computer>`. Default "polpo-sbx". */
  hostnamePrefix?: string;
}

export const DEFAULT_TAILSCALE_TAGS: readonly string[] = ["tag:polpo-sandbox"];
export const DEFAULT_TAILSCALE_HOSTNAME_PREFIX = "polpo-sbx";
/** Names an auth key may have in its vault entry. */
export const TAILSCALE_AUTH_KEY_NAMES = ["authKey", "auth_key", "authkey", "key", "token", "apiKey", "secret"];

const TAG = /^tag:[a-z0-9][a-z0-9-]{0,62}$/i;
const PREFIX = /^[a-z0-9][a-z0-9-]{0,29}$/;

/** settings.tailscale from raw input (config file or API), or an error naming the field. */
export function parseTailscaleSettings(raw: unknown): TailscaleSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("settings.tailscale must be an object { authKey: { owner, service }, tags?, hostnamePrefix? }");
  const r = raw as Record<string, unknown>;
  if (typeof r.authKey === "string") {
    throw new Error("settings.tailscale.authKey must be a vault reference { owner, service }, never the key itself: store the key in an agent's vault and point to that entry");
  }
  const authKey = normalizeVaultRef(r.authKey);
  if (!authKey) throw new Error("settings.tailscale.authKey must be a vault reference { owner: <agent>, service: <entry> } (the entry holds the auth key)");
  const out: TailscaleSettings = { authKey };
  if (r.tags !== undefined && r.tags !== null) {
    if (!Array.isArray(r.tags) || r.tags.some((t) => typeof t !== "string" || !TAG.test(t.trim()))) {
      throw new Error("settings.tailscale.tags must be a list of tags like \"tag:polpo-sandbox\"");
    }
    const tags = [...new Set((r.tags as string[]).map((t) => t.trim().toLowerCase()))];
    if (tags.length) out.tags = tags;
  }
  if (r.hostnamePrefix !== undefined && r.hostnamePrefix !== null && r.hostnamePrefix !== "") {
    const prefix = typeof r.hostnamePrefix === "string" ? r.hostnamePrefix.trim().toLowerCase() : "";
    if (!PREFIX.test(prefix)) throw new Error("settings.tailscale.hostnamePrefix must be lowercase letters, digits and - (up to 30), e.g. \"polpo-sbx\"");
    out.hostnamePrefix = prefix;
  }
  return out;
}

/** The parsed settings, or undefined when absent or malformed (runtime paths never throw on them). */
export function tailscaleSettingsOf(settings: { tailscale?: unknown } | undefined): TailscaleSettings | undefined {
  if (!settings?.tailscale) return undefined;
  try { return parseTailscaleSettings(settings.tailscale); } catch { return undefined; }
}

/** 100.64.0.0/10: the addresses Tailscale gives its nodes. */
export function isTailnetIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number) as [number, number, number, number];
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 100 && b >= 64 && b <= 127;
}

/**
 * A host only the tailnet reaches: a Tailscale address (100.64.0.0/10) or a MagicDNS name (a
 * machine name such as "ahp0", or "<machine>.<tailnet>.ts.net").
 */
export function isTailnetHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (isTailnetIPv4(h)) return true;
  if (/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(h) && !/^\d+$/.test(h) && h !== "localhost") return true;
  return /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/.test(h);
}

/** Host and port of a proxy URL (socks default 1080, http 8080). */
export function proxyEndpoint(url: string): { scheme: string; host: string; port: number } | undefined {
  try {
    const u = new URL(url);
    const scheme = u.protocol.replace(/:$/, "");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (!host) return undefined;
    return { scheme, host, port: Number(u.port) || (scheme.startsWith("socks") ? 1080 : 8080) };
  } catch {
    return undefined;
  }
}

/**
 * Why a remote computer cannot go out through this proxy (null: it can): Tailscale must be set up
 * (settings.tailscale), and the proxy must be a SOCKS5 proxy on a tailnet address.
 */
export function remoteEgressProblem(proxyName: string, proxyUrl: string | undefined, settings: { tailscale?: unknown } | undefined): string | null {
  if (!proxyUrl) return `There is no egress proxy "${proxyName}" (settings.egressProxies)`;
  if (!settings?.tailscale) {
    return `A remote computer reaches the "${proxyName}" proxy through Tailscale inside its VM: set up settings.tailscale first `
      + "(an auth key in the vault: ephemeral, reusable, tagged tag:polpo-sandbox; see docs/residential-egress.md)";
  }
  try { parseTailscaleSettings(settings.tailscale); } catch (err) { return (err as Error).message; }
  const ep = proxyEndpoint(proxyUrl);
  if (!ep) return `The "${proxyName}" proxy URL cannot be read: ${proxyUrl}`;
  if (ep.scheme !== "socks5" && ep.scheme !== "socks5h") {
    return `The "${proxyName}" proxy is ${ep.scheme}: remote computers go out through SOCKS5 proxies only for now (socks5://<tailnet address>:<port>)`;
  }
  if (!isTailnetHost(ep.host)) {
    return `The "${proxyName}" proxy (${ep.host}) is not a tailnet address: remote computers reach only Tailscale addresses (100.64.0.0/10) or MagicDNS names through their tailnet`;
  }
  return null;
}

/** A remote computer's tailnet egress, as a run carries it (no secret: the key's vault reference). */
export interface TailnetEgressRef {
  computerId: string;
  /** Node name in the tailnet: `<prefix>-<instance>-<computer>`. */
  hostname: string;
  tags: string[];
  authKey: VaultRef;
  /** The proxy behind the tailnet. */
  proxyHost: string;
  proxyPort: number;
}

/** A DNS label from free text: lowercase letters, digits and -. */
function label(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** `<prefix>-<instance>-<computer>`, at most 63 characters (the computer id is kept whole). */
export function tailnetHostname(prefix: string | undefined, instance: string | undefined, computerId: string): string {
  const head = label(prefix || DEFAULT_TAILSCALE_HOSTNAME_PREFIX) || DEFAULT_TAILSCALE_HOSTNAME_PREFIX;
  const id = label(computerId).slice(0, 40);
  const room = 63 - head.length - id.length - 2;
  const inst = room > 0 ? label(instance ?? "").slice(0, room).replace(/-+$/, "") : "";
  return [head, inst, id].filter(Boolean).join("-");
}

/**
 * The tailnet egress of a remote computer with `egress`, or undefined (host computer, no egress,
 * Tailscale not set up, or a proxy remote computers cannot use: see remoteEgressProblem).
 */
export function tailnetEgressFor(
  computer: { id: string; kind: string; egress?: string } | undefined,
  settings: { tailscale?: unknown; egressProxies?: Record<string, string> } | undefined,
  instance?: string,
): { name: string; url: string; tailnet: TailnetEgressRef } | undefined {
  if (!computer?.egress || (computer.kind !== "daytona" && computer.kind !== "e2b")) return undefined;
  const url = settings?.egressProxies?.[computer.egress];
  if (remoteEgressProblem(computer.egress, url, settings)) return undefined;
  const ts = parseTailscaleSettings(settings!.tailscale);
  const ep = proxyEndpoint(url!)!;
  return {
    name: computer.egress,
    url: url!,
    tailnet: {
      computerId: computer.id,
      hostname: tailnetHostname(ts.hostnamePrefix, instance, computer.id),
      tags: ts.tags ?? [...DEFAULT_TAILSCALE_TAGS],
      authKey: ts.authKey,
      proxyHost: ep.host,
      proxyPort: ep.port,
    },
  };
}
