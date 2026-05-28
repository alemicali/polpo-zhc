/**
 * Tiny stale-while-revalidate localStorage cache for list-style hooks.
 *
 * Why: over Tailscale HTTPS (100-300ms baseline RTT), the cold-load
 * latency to first paint on Dashboard/Tasks/Missions is dominated by
 * a single round-trip. If we already have a "good enough" snapshot
 * from a previous visit, we can render IMMEDIATELY, kick a background
 * fetch, and swap when fresh data lands. Combined with HTTP ETag
 * (server-side), the background fetch is usually a 304 (sub-KB) so
 * the swap is invisible.
 *
 * Keys are namespaced `polpo:swr:<entity>:<filter-hash>` so different
 * filtered views of the same entity coexist. Payload is a JSON
 * envelope with the data and the ETag (so the next request can send
 * If-None-Match).
 *
 * Design choices:
 *  - Synchronous read on mount (no `useEffect`) — that's the whole
 *    point: zero-frame paint with stale data.
 *  - Best-effort writes — failures (quota, private mode) are silent.
 *  - No TTL — we always revalidate, the cache is for the loading
 *    state, not freshness.
 */

export interface CachedSnapshot<T> {
  data: T;
  etag?: string;
  cachedAt: number;
}

const PREFIX = "polpo:swr:";

function key(entity: string, filter: unknown): string {
  if (!filter) return `${PREFIX}${entity}`;
  // Stable JSON.stringify is fine here — filter shapes are small and
  // controlled by the SDK hooks, not user-supplied.
  return `${PREFIX}${entity}:${JSON.stringify(filter)}`;
}

export function readCached<T>(entity: string, filter?: unknown): CachedSnapshot<T> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key(entity, filter));
    if (!raw) return null;
    return JSON.parse(raw) as CachedSnapshot<T>;
  } catch {
    return null;
  }
}

export function writeCached<T>(entity: string, data: T, etag?: string, filter?: unknown): void {
  if (typeof window === "undefined") return;
  try {
    const envelope: CachedSnapshot<T> = { data, etag, cachedAt: Date.now() };
    window.localStorage.setItem(key(entity, filter), JSON.stringify(envelope));
  } catch {
    // Silently drop — quota errors etc. The fetch result is still in memory.
  }
}

export function clearCached(entity?: string): void {
  if (typeof window === "undefined") return;
  try {
    if (!entity) {
      // Bulk clear is rare (logout flow); iterate keys.
      const toRemove: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k && k.startsWith(PREFIX)) toRemove.push(k);
      }
      for (const k of toRemove) window.localStorage.removeItem(k);
      return;
    }
    // Partial-prefix clear for one entity.
    const prefix = `${PREFIX}${entity}`;
    const toRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(prefix)) toRemove.push(k);
    }
    for (const k of toRemove) window.localStorage.removeItem(k);
  } catch {
    // Silently ignore.
  }
}
