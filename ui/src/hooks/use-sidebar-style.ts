/**
 * Sidebar style — "classic" (every page in one list) or "drill-in" (top-level entries open their
 * pages as a second level inside the sidebar).
 *
 * Two layers, like the layout mode and the look:
 * - this person's choice, kept in this browser (localStorage; unset = follow the instance);
 * - the instance default, settings.appearance.sidebarStyle (Configuration → Appearance, REST
 *   PATCH /config/settings { appearance }, MCP polpo_branding_update sidebar_style), drill-in when
 *   unset (classic only when the instance sets it or the person picks it).
 *
 * Storage may be unavailable (private mode, blocked): every read and write is guarded and the
 * in-memory copy keeps working for the visit. The banners' dismissal lives here too.
 */

import { useSyncExternalStore } from "react";
import { APPEARANCE_CHANGE_EVENT, APPEARANCE_SCOPE_EVENT, getInstanceAppearance } from "@/lib/appearance";

export type SidebarStyle = "classic" | "drill-in";
export const SIDEBAR_STYLES: readonly SidebarStyle[] = ["classic", "drill-in"];
/** The built-in default (settings.appearance.sidebarStyle unset): the drill-in sidebar. */
export const DEFAULT_SIDEBAR_STYLE: SidebarStyle = "drill-in";

export const SIDEBAR_STYLE_STORAGE_KEY = "polpo-sidebar-style";
export const SIDEBAR_BANNER_STORAGE_KEY = "polpo-sidebar-style-banner-dismissed";

export function isSidebarStyle(value: unknown): value is SidebarStyle {
  return value === "classic" || value === "drill-in";
}

function storageGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* storage unavailable: the in-memory copy carries the visit */ }
}

function readInstance(): SidebarStyle | null {
  try {
    const value = getInstanceAppearance()?.sidebarStyle;
    return isSidebarStyle(value) ? value : null;
  } catch {
    return null;
  }
}

function readUser(): SidebarStyle | null {
  const stored = storageGet(SIDEBAR_STYLE_STORAGE_KEY);
  return isSidebarStyle(stored) ? stored : null;
}

function readDismissed(): Set<SidebarStyle> {
  const raw = storageGet(SIDEBAR_BANNER_STORAGE_KEY);
  return new Set((raw ?? "").split(",").filter(isSidebarStyle));
}

export interface SidebarStyleState {
  /** What this browser shows. */
  style: SidebarStyle;
  /** This person's own choice, or null when following the instance. */
  user: SidebarStyle | null;
  /** The instance default (drill-in when the instance sets none). */
  instance: SidebarStyle;
  /** The banners dismissed (one per style). */
  dismissed: ReadonlySet<SidebarStyle>;
}

function compute(user: SidebarStyle | null, instance: SidebarStyle | null, dismissed: Set<SidebarStyle>): SidebarStyleState {
  const inst = instance ?? DEFAULT_SIDEBAR_STYLE;
  return { style: user ?? inst, user, instance: inst, dismissed };
}

let state: SidebarStyleState = compute(readUser(), readInstance(), readDismissed());
const listeners = new Set<() => void>();

function emit(next: SidebarStyleState) {
  state = next;
  listeners.forEach((cb) => cb());
}

function refreshInstance() {
  const instance = readInstance() ?? DEFAULT_SIDEBAR_STYLE;
  if (instance !== state.instance) emit(compute(state.user, instance, new Set(state.dismissed)));
}

let watching = false;
function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!watching && typeof window !== "undefined") {
    watching = true;
    // the instance default arrives with the appearance (runtime config, then the API)
    window.addEventListener(APPEARANCE_CHANGE_EVENT, refreshInstance);
    window.addEventListener(APPEARANCE_SCOPE_EVENT, refreshInstance);
    // another tab changed this person's choice
    window.addEventListener("storage", (event) => {
      if (event.key === SIDEBAR_STYLE_STORAGE_KEY || event.key === SIDEBAR_BANNER_STORAGE_KEY || event.key === null) {
        emit(compute(readUser(), readInstance(), readDismissed()));
      }
    });
  }
  return () => { listeners.delete(cb); };
}

function getSnapshot(): SidebarStyleState {
  return state;
}

/** This person's choice; null follows the instance default again. */
export function setSidebarStyle(style: SidebarStyle | null): void {
  if (style === state.user) return;
  storageSet(SIDEBAR_STYLE_STORAGE_KEY, style);
  emit(compute(style, state.instance, new Set(state.dismissed)));
}

/** Hide the banner shown with a style (the switch stays in Configuration → Appearance). */
export function dismissSidebarStyleBanner(style: SidebarStyle): void {
  if (state.dismissed.has(style)) return;
  const dismissed = new Set(state.dismissed).add(style);
  storageSet(SIDEBAR_BANNER_STORAGE_KEY, [...dismissed].join(","));
  emit(compute(state.user, state.instance, dismissed));
}

/** The sidebar style shown in this browser. */
export function useSidebarStyle(): SidebarStyle {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot).style;
}

/** Every layer of the preference (Configuration → Appearance, the banners). */
export function useSidebarStyleState(): SidebarStyleState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Tests: re-read storage and the instance default. */
export function resetSidebarStyleForTests(): void {
  emit(compute(readUser(), readInstance(), readDismissed()));
}
