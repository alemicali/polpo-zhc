/**
 * After a deploy, a tab (or the service worker) can still run the previous build and ask for
 * chunks that no longer exist: lazy pages then fail with "Failed to fetch dynamically imported
 * module". Reload once to pick up the new build; never loop (one reload per 60 s).
 */
const KEY = "polpo:stale-build-reload";
const WINDOW_MS = 60_000;

const STALE_CHUNK = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Expected a JavaScript-or-Wasm module script/i;

export function isStaleChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return STALE_CHUNK.test(message);
}

/** Reload once to load the current build; false when a reload just happened (don't loop). */
export function reloadForNewBuild(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (Date.now() - last < WINDOW_MS) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch { /* storage blocked: still reload once */ }
  void navigator.serviceWorker?.getRegistration?.().then((r) => r?.update()).catch(() => undefined);
  window.location.reload();
  return true;
}

export function installStaleBuildRecovery(): void {
  window.addEventListener("vite:preloadError", (event) => {
    if (reloadForNewBuild()) event.preventDefault();
  });
  window.addEventListener("unhandledrejection", (event) => {
    if (isStaleChunkError(event.reason)) reloadForNewBuild();
  });
}
