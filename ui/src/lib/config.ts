/**
 * Static config from env vars.
 */
export const config = {
  baseUrl: import.meta.env.VITE_POLPO_API_URL ?? "",
  apiKey: import.meta.env.VITE_POLPO_API_KEY ?? undefined,
  terminalCore: import.meta.env.VITE_POLPO_TERMINAL_CORE === "wterm" ? "wterm" : "ghostty",
} as const;

export function apiUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${config.baseUrl}${normalized}`;
}

/** Hostname the UI is talking to — used by the "local vs remote" badge. */
export function endpointHost(): string {
  const target = config.baseUrl || window.location.origin;
  try {
    return new URL(target, window.location.href).host;
  } catch {
    return target;
  }
}

/** True when the API endpoint resolves to a loopback host. */
export function isLocalEndpoint(): boolean {
  try {
    const url = new URL(config.baseUrl || window.location.origin, window.location.href);
    const host = url.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host.endsWith(".local");
  } catch {
    return false;
  }
}

export function websocketUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (!config.baseUrl) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}${normalized}`;
  }

  const url = new URL(config.baseUrl, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = normalized;
  url.search = "";
  url.hash = "";
  return url.toString();
}
