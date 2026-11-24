/**
 * The What's new drawer: one for the app, opened from the sidebar's What's new cards, the
 * chat-first header or the top bar. It may open at an entry (a card: that entry, unfolded).
 */
import { useSyncExternalStore } from "react";

let open = false;
/** The entry to unfold and scroll to when the drawer opens (null: the default view). */
let focusId: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const set = (next: boolean) => {
  if (open === next) return;
  open = next;
  if (!next) focusId = null;
  emit();
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};

export const openWhatsNew = () => set(true);
/** Open the drawer at an entry (unfolded and scrolled into view). */
export const openWhatsNewAt = (entryId: string) => {
  focusId = entryId;
  if (open) emit();
  else set(true);
};
export const closeWhatsNew = () => set(false);
export const setWhatsNewOpen = (next: boolean) => set(next);

export function useWhatsNewOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open, () => false);
}

/** The entry the drawer was opened at, if any. */
export function useWhatsNewFocus(): string | null {
  return useSyncExternalStore(subscribe, () => focusId, () => null);
}
