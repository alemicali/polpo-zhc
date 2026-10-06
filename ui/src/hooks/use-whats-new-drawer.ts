/**
 * The What's new drawer: one for the app, opened from the top bar or the "Novità" nav item.
 */
import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();
const set = (next: boolean) => {
  if (open === next) return;
  open = next;
  listeners.forEach((l) => l());
};

export const openWhatsNew = () => set(true);
export const closeWhatsNew = () => set(false);
export const setWhatsNewOpen = (next: boolean) => set(next);

export function useWhatsNewOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
    () => false,
  );
}
