/**
 * Whether the search palette (⌘K) is open, and with what query: an external store, so the sidebar
 * field, the mobile header icon and the shortcut open the same palette without a provider.
 */
import { useEffect, useSyncExternalStore } from "react";

interface PaletteState {
  open: boolean;
  /** The query to start with (a prefix like ">" or "@"), or "". */
  query: string;
  /** Bumped on every open: the palette resets its input to `query`. */
  seq: number;
}

let state: PaletteState = { open: false, query: "", seq: 0 };
const listeners = new Set<() => void>();

function set(next: PaletteState) {
  state = next;
  for (const l of listeners) l();
}

export function openSearchPalette(query = ""): void {
  set({ open: true, query, seq: state.seq + 1 });
}

export function closeSearchPalette(): void {
  if (state.open) set({ ...state, open: false });
}

export function toggleSearchPalette(): void {
  if (state.open) closeSearchPalette();
  else openSearchPalette();
}

export function useSearchPalette(): PaletteState {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => state,
    () => state,
  );
}

/** The shortcut's label for this platform: ⌘K on Apple devices, Ctrl K elsewhere. */
export function searchShortcutLabel(): string {
  const platform = typeof navigator === "undefined" ? "" : ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "");
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘K" : "Ctrl K";
}

/** Where Ctrl+K belongs to the page (a terminal's "kill line"): the shortcut leaves it alone there. */
function ownsCtrlK(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(".xterm, [data-search-shortcut='off']");
}

/** ⌘K / Ctrl+K anywhere opens (or closes) the palette. Mounted once, by the layout. */
export function useSearchShortcut(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || e.altKey || e.shiftKey || !(e.metaKey || e.ctrlKey)) return;
      if (e.ctrlKey && !e.metaKey && ownsCtrlK(e.target)) return;
      e.preventDefault();
      toggleSearchPalette();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

/** For tests: back to closed. */
export function resetSearchPaletteForTests(): void {
  state = { open: false, query: "", seq: 0 };
}
