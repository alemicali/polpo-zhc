/**
 * The sandbox network rule for the browser tools.
 *
 * The browser runs on the host, outside the sandbox jail, so it needs its own enforcement of the
 * agent's network rule ("allowlist", "deny" or "open" on a provider that isolates). Two layers:
 * the target of a navigation is checked up front (clear message to the agent), and the browser
 * is started behind a TCP instance of the sandbox proxy, so page subresources, redirects and
 * scripts obey the same rule. Not enforced when the provider is "local" (no isolation) or the
 * network is "unrestricted".
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import type { EffectiveSandbox } from "@polpo-ai/core/sandbox";
import { authorizeDestination, startTcpNetworkProxy, type NetworkDenial, type NetworkRule, type Resolver, type TcpNetworkProxy } from "../sandbox/net-proxy.js";

/** The rule that applies to a browser, or undefined when it is not enforced. */
export function browserRuleFor(sandbox: EffectiveSandbox | undefined): NetworkRule | undefined {
  if (!sandbox || sandbox.provider === "local") return undefined;
  const { mode, allow } = sandbox.network;
  if (mode === "unrestricted") return undefined;
  if (mode === "deny") return { mode: "allowlist", allow: [] };
  return mode === "allowlist" ? { mode, allow: allow ?? [] } : { mode: "open" };
}

export interface BrowserNetworkGuard {
  /** A refusal message for the agent when the URL's host is not reachable under the rule. */
  checkUrl(url: string): Promise<string | undefined>;
  /** Proxy URL to start the browser with (starts the proxy on first use). */
  proxyUrl(): Promise<string>;
  close(): Promise<void>;
}

export interface BrowserNetworkGuardOptions {
  sandbox: EffectiveSandbox | undefined;
  /** agent-browser session: closed once when the proxy starts, so a browser left running without the proxy restarts behind it. */
  session?: string;
  onDenied?: (denial: NetworkDenial) => void;
  resolve?: Resolver;
}

export function createBrowserNetworkGuard(opts: BrowserNetworkGuardOptions): BrowserNetworkGuard | undefined {
  const rule = browserRuleFor(opts.sandbox);
  if (!rule) return undefined;
  const sandbox = opts.sandbox!;
  let proxy: Promise<TcpNetworkProxy> | undefined;

  const explain = (host: string, reason: NetworkDenial["reason"]): string => {
    if (reason === "private-address") return `Network rule: ${host} is a local or private address; the sandbox network never reaches those.`;
    return sandbox.network.mode === "deny"
      ? `Network rule: this agent's sandbox has no network, so ${host} cannot be reached.`
      : `Network rule: ${host} is not in this agent's allowed hosts (${(sandbox.network.allow ?? []).join(", ") || "none"}). A person can allow it in Settings → Sandbox.`;
  };

  return {
    async checkUrl(url) {
      let parsed: URL;
      try { parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`); } catch { return undefined; }
      // other schemes (about:, data:, file:) are the URL guard's business, not the network's
      if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return undefined;
      const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
      const port = Number(parsed.port || (parsed.protocol === "https:" || parsed.protocol === "wss:" ? 443 : 80));
      const result = await authorizeDestination(rule, host, port, opts.resolve);
      if (result.ok || !("reason" in result)) return undefined; // unreachable hosts fail by themselves
      opts.onDenied?.({ host, port, reason: result.reason });
      return explain(host, result.reason);
    },
    proxyUrl() {
      proxy ??= startTcpNetworkProxy({ rule, onDenied: opts.onDenied, resolve: opts.resolve }).then(async (p) => {
        if (opts.session) await new Promise<void>((done) => execFile("agent-browser", ["--session", opts.session!, "close"], { timeout: 10_000 }, () => done()));
        return p;
      });
      return proxy.then((p) => p.url);
    },
    async close() {
      const p = await proxy?.catch(() => undefined);
      proxy = undefined;
      await p?.close();
    },
  };
}

/** The proxy the current agent-side browser call must use (set by the guarded tools, read by the CLI bridge). */
export const browserProxyContext = new AsyncLocalStorage<{ proxy: string }>();

/** Browser args that route a page's traffic through the proxy; Chromium bypasses loopback unless told not to. */
export function proxyArgs(proxy: string | undefined): string[] {
  return proxy ? ["--proxy", proxy, "--proxy-bypass", "<-loopback>"] : [];
}
