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
  void activateNewWorkerThenReload();
  return true;
}

/**
 * The previous build is often served by the service worker while the new one waits: tell the
 * waiting worker to take over (SKIP_WAITING), wait for it to control the page (at most 3 s), then
 * reload. Without a service worker this is a plain reload.
 */
async function activateNewWorkerThenReload(): Promise<void> {
  try {
    const sw = navigator.serviceWorker;
    const reg = await sw?.getRegistration?.();
    if (sw && reg) {
      await reg.update().catch(() => undefined);
      const waiting = reg.waiting ?? reg.installing;
      if (waiting) {
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          sw.addEventListener("controllerchange", done, { once: true });
          setTimeout(done, 3000);
          waiting.postMessage({ type: "SKIP_WAITING" });
        });
      }
    }
  } catch { /* fall through to the reload */ }
  window.location.reload();
}

export function installStaleBuildRecovery(): void {
  window.addEventListener("vite:preloadError", (event) => {
    if (reloadForNewBuild()) event.preventDefault();
  });
  window.addEventListener("unhandledrejection", (event) => {
    if (isStaleChunkError(event.reason)) reloadForNewBuild();
  });
}
