/**
 * Custom connectors' icons come from the API (GET /api/v1/connectors/:id/icon), which needs the
 * instance's auth (an API key header or the session cookie): they are fetched and shown as object
 * URLs, cached by their hashed URL (?v=…), so an entry never goes stale.
 */
import { apiUrl, config } from "@/lib/config";

const cache = new Map<string, Promise<string | null>>();

/** An API image as a displayable object URL (null when unavailable). */
export function loadApiImage(path: string): Promise<string | null> {
  let pending = cache.get(path);
  if (!pending) {
    pending = fetch(apiUrl(path), {
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
      credentials: "include",
    }).then(async (res) => (res.ok ? URL.createObjectURL(await res.blob()) : null)).catch(() => null);
    cache.set(path, pending);
    // a failure may be temporary (offline, signed out): try again next time
    void pending.then((url) => { if (!url) cache.delete(path); });
  }
  return pending;
}

/** Test hook. */
export function clearConnectorIconCache(): void {
  cache.clear();
}
