import { useCallback, useEffect, useState } from "react";
import { config } from "@/lib/config";
import { appearanceKit, type BootCustom, type InstanceAppearance, type KitWindow, type ResolvedAppearance, type TokenMap } from "@/lib/appearance-kit";

/**
 * The dashboard's look. Three layers, field by field (theme, palette, custom colours): what this
 * browser chose, else the instance's default (settings.appearance, shared by everyone, set by an
 * admin), else the built-in default. lib/appearance-kit.ts resolves and applies them, the same code
 * index.html runs inline before the first paint.
 */

export type AppearanceMode = "light" | "dark";
/** A mode's design tokens (any subset; see kit.TOKENS). */
export type AppearanceThemeSettings = TokenMap;
export type AppearanceSettings = BootCustom;
export type { InstanceAppearance, ResolvedAppearance };

export const kit = appearanceKit();

export const APPEARANCE_SCOPE_EVENT = "polpo-appearance-scope-change";
/** Fired when any layer changes (a choice in this browser, the instance default): hooks re-read. */
export const APPEARANCE_CHANGE_EVENT = "polpo-appearance-change";

/** No custom tokens: the palette's own. */
export const DEFAULT_APPEARANCE: AppearanceSettings = { enabled: false, derive: true, light: {}, dark: {} };

function win(): KitWindow {
  return window as unknown as KitWindow;
}

function apiScope(): string {
  return kit.apiScope(config.baseUrl, typeof window !== "undefined" ? window.location.origin : "");
}

function storageGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* storage may be unavailable (private mode) */ }
}

// The instance this API serves: remembered from the last visit so the first paint uses its choices.
let currentScope = storageGet(`${kit.LAST_SCOPE_KEY}:${apiScope()}`) || "default";

export function instanceScope(): string {
  return currentScope;
}

export function scopedStorageKey(key: string): string {
  return kit.scopedKey(key, apiScope(), instanceScope());
}

function notify(): void {
  window.dispatchEvent(new Event(APPEARANCE_CHANGE_EVENT));
}

/** Resolve the three layers and put the result on the page. */
export function refreshAppearance(): ResolvedAppearance {
  const resolved = kit.resolve(kit.read(win(), config.baseUrl, currentScope));
  kit.apply(window.document as unknown as Parameters<typeof kit.apply>[0], resolved, import.meta.env.BASE_URL || "/");
  return resolved;
}

export function currentAppearance(): ResolvedAppearance {
  return kit.resolve(kit.read(win(), config.baseUrl, currentScope));
}

export function setAppearanceScope(scope: { org?: string; project?: string }): void {
  const nextScope = kit.slug(scope.org ?? scope.project ?? "default");
  storageSet(`${kit.LAST_SCOPE_KEY}:${apiScope()}`, nextScope);
  if (currentScope === nextScope) return;
  currentScope = nextScope;
  refreshAppearance();
  window.dispatchEvent(new Event(APPEARANCE_SCOPE_EVENT));
}

// ── The instance default ─────────────────────────────────────────────

/** The instance's default look as known now (runtime-config.js, else the cached copy). */
export function getInstanceAppearance(): InstanceAppearance | null {
  return kit.instanceDefault(win(), apiScope());
}

/** A new instance default (from the API, or just saved by an admin): cached and applied. */
export function setInstanceAppearance(value: InstanceAppearance | null): void {
  const next = value && typeof value === "object" ? value : {};
  const rc = (globalThis.__POLPO_RUNTIME_CONFIG__ ??= {});
  const same = JSON.stringify(rc.appearance ?? null) === JSON.stringify(next);
  rc.appearance = next;
  storageSet(`${kit.INSTANCE_KEY}:${apiScope()}`, JSON.stringify(next));
  if (same) return;
  refreshAppearance();
  notify();
}

/** Fetch the instance default (public route, no sign-in needed); older servers without it are ignored. */
export async function loadInstanceAppearance(): Promise<void> {
  try {
    const res = await fetch(`${config.baseUrl}/api/v1/config/appearance`);
    if (!res.ok) return;
    const body = await res.json() as { ok?: boolean; data?: InstanceAppearance };
    if (body?.ok && body.data && typeof body.data === "object") setInstanceAppearance(body.data);
  } catch { /* offline or an older server: keep what we have */ }
}

// ── This browser's choices ───────────────────────────────────────────

/** Does this browser override any part of the instance default? */
export function isBrowserCustomized(): boolean {
  const { sources } = currentAppearance();
  return sources.theme === "browser" || sources.palette === "browser" || sources.custom === "browser";
}

/** Forget this browser's choices: the instance default applies again. */
export function followInstanceDefault(): void {
  for (const key of Object.values(kit.KEYS)) storageSet(scopedStorageKey(key), null);
  refreshAppearance();
  notify();
}

/** Keep the current look as this browser's own choice (it no longer follows the instance default). */
export function customizeInBrowser(): void {
  const r = currentAppearance();
  storageSet(scopedStorageKey(kit.KEYS.theme), r.theme);
  storageSet(scopedStorageKey(kit.KEYS.palette), r.palette);
  storageSet(scopedStorageKey(kit.KEYS.custom), JSON.stringify(r.custom));
  refreshAppearance();
  notify();
}

/** Save one of this browser's choices and apply it. */
export function setBrowserChoice(field: keyof typeof kit.KEYS, value: string): void {
  storageSet(scopedStorageKey(kit.KEYS[field]), value);
  refreshAppearance();
  notify();
}

/** The current look as an instance default (what "Save as instance default" sends). */
export function appearanceAsInstanceDefault(r: ResolvedAppearance = currentAppearance()): Required<InstanceAppearance> {
  return { theme: r.theme, palette: r.palette, custom: r.custom };
}

/** Re-read the layers whenever any of them changes. */
export function useResolvedAppearance(): ResolvedAppearance {
  const [resolved, setResolved] = useState<ResolvedAppearance>(currentAppearance);
  useEffect(() => {
    const sync = () => setResolved(currentAppearance());
    window.addEventListener(APPEARANCE_CHANGE_EVENT, sync);
    window.addEventListener(APPEARANCE_SCOPE_EVENT, sync);
    return () => {
      window.removeEventListener(APPEARANCE_CHANGE_EVENT, sync);
      window.removeEventListener(APPEARANCE_SCOPE_EVENT, sync);
    };
  }, []);
  return resolved;
}

export function applyAppearance(settings: AppearanceSettings): void {
  setBrowserChoice("custom", JSON.stringify(kit.normalizeCustom(settings)));
}

/** The custom colours (this browser's, else the instance's), and setting them in this browser. */
export function useAppearance() {
  const resolved = useResolvedAppearance();
  const appearance = resolved.custom;

  const setAppearance = useCallback((next: AppearanceSettings) => {
    setBrowserChoice("custom", JSON.stringify(kit.normalizeCustom(next)));
  }, []);

  const resetAppearance = useCallback(() => {
    setBrowserChoice("custom", JSON.stringify(DEFAULT_APPEARANCE));
  }, []);

  return { appearance, setAppearance, resetAppearance } as const;
}

/**
 * Apply the look before React mounts (index.html already did, inline; this repeats it with the
 * app's own config) and keep it current: the OS theme, another tab, the instance default.
 */
export function bootstrapAppearance(): void {
  refreshAppearance();
  try {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (currentAppearance().theme === "system") { refreshAppearance(); notify(); }
    });
  } catch { /* old browsers */ }
  window.addEventListener("storage", (event) => {
    if (event.key && Object.values(kit.KEYS).some((k) => event.key!.startsWith(`${k}:`))) { refreshAppearance(); notify(); }
  });
  void loadInstanceAppearance();
}
