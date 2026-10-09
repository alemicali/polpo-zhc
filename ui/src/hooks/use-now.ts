import { useSyncExternalStore } from "react";

/**
 * Shared "current time" store for render-time comparisons (overdue badges,
 * relative times). Reading Date.now() during render is impure; this exposes
 * a snapshot that ticks while at least one component is subscribed.
 */

const TICK_MS = 30_000;

let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function tick() {
  now = Date.now();
  listeners.forEach((cb) => cb());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!timer) {
    // Refresh a possibly stale snapshot when the first subscriber arrives.
    now = Date.now();
    timer = setInterval(tick, TICK_MS);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot() {
  return now;
}

/** Current epoch milliseconds, refreshed every 30 seconds. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
