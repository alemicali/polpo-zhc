import { useEffect, useSyncExternalStore } from "react";
import { config } from "@/lib/config";
import { appearanceKit, type InstanceBranding, type KitWindow } from "@/lib/appearance-kit";

/**
 * The instance's branding (settings.branding: product name, tagline, logos, logo frame), known
 * synchronously from the first render: the UI server inlines it into runtime-config.js and
 * index.html's inline script already put the title and a logo preload on the page; without it
 * (Electron, nginx) the copy cached in this browser. The API refreshes it once the app runs.
 */

export type { InstanceBranding };

const kit = appearanceKit();

export const DEFAULT_PRODUCT_NAME = kit.DEFAULT_PRODUCT_NAME;
export const DEFAULT_PRODUCT_TAGLINE = kit.DEFAULT_PRODUCT_TAGLINE;
export const BRANDING_CHANGE_EVENT = "polpo:instance-branding-change";

function win(): KitWindow {
  return window as unknown as KitWindow;
}

function apiScope(): string {
  return kit.apiScope(config.baseUrl, typeof window !== "undefined" ? window.location.origin : "");
}

function cacheKey(): string {
  return `${kit.BRANDING_KEY}:${apiScope()}`;
}

function sameBranding(a: InstanceBranding | null, b: InstanceBranding | null): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

let current: InstanceBranding | null = typeof window !== "undefined" ? kit.instanceBranding(win(), apiScope()) : null;

/** The branding as known now (runtime-config.js, else the cached copy; null when never known). */
export function getInstanceBranding(): InstanceBranding | null {
  return current;
}

function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

/** The page the app shows (the browser tab carries it after the product name). */
let currentPage = "";

/** Put the branding on the page: the title, the home-screen name, the logo preload. */
export function applyInstanceBranding(b: InstanceBranding | null = current): void {
  kit.applyBranding(document as unknown as Parameters<typeof kit.applyBranding>[0], b ?? {}, isDark(), config.baseUrl, currentPage);
}

/** The browser tab title for a page: "<product name> · <page>" (just the name without a page). */
export function documentTitle(page?: string, b: InstanceBranding | null = current): string {
  return kit.brandingTitle(b, page);
}

/** Keep the browser tab on "<product name> · <page>" while mounted; the branding changing updates it too. */
export function useDocumentTitle(page: string): void {
  useEffect(() => {
    currentPage = page;
    applyInstanceBranding();
    return () => {
      if (currentPage === page) currentPage = "";
    };
  }, [page]);
}

/** A new branding (from the API, or just saved by an admin): cached, applied, announced. */
export function setInstanceBranding(value: InstanceBranding | null | undefined): void {
  const next = kit.normalizeBranding(value ?? {});
  const rc = (globalThis.__POLPO_RUNTIME_CONFIG__ ??= {});
  rc.branding = next;
  try { localStorage.setItem(cacheKey(), JSON.stringify(next)); } catch { /* storage may be unavailable */ }
  if (sameBranding(current, next) && current !== null) return;
  current = next;
  applyInstanceBranding(next);
  window.dispatchEvent(new Event(BRANDING_CHANGE_EVENT));
}

/** Fetch the branding (public route, no sign-in needed); an older server or offline keeps what we have. */
export async function loadInstanceBranding(): Promise<void> {
  try {
    const res = await fetch(`${config.baseUrl}/api/v1/config/branding`);
    if (!res.ok) return;
    const body = await res.json() as { ok?: boolean; data?: InstanceBranding };
    if (body?.ok && body.data && typeof body.data === "object") setInstanceBranding(body.data);
  } catch { /* keep what we have */ }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(BRANDING_CHANGE_EVENT, onChange);
  return () => window.removeEventListener(BRANDING_CHANGE_EVENT, onChange);
}

/** The instance branding, right from the first render; re-renders when it changes. */
export function useInstanceBranding(): InstanceBranding | undefined {
  return useSyncExternalStore(subscribe, getInstanceBranding, getInstanceBranding) ?? undefined;
}

/** The product name to show ("Polpo ZHC" when none is set). */
export function productName(b: InstanceBranding | null | undefined): string {
  return b?.productName || DEFAULT_PRODUCT_NAME;
}

/** The tagline to show ("AI Factory" when none is set). */
export function productTagline(b: InstanceBranding | null | undefined): string {
  return b?.tagline || DEFAULT_PRODUCT_TAGLINE;
}

/**
 * Before React mounts: the title and logo preload again with the app's config (the inline script did
 * it already when it ran), then ask the API for the latest.
 */
export function bootstrapBranding(): void {
  applyInstanceBranding();
  void loadInstanceBranding();
}
