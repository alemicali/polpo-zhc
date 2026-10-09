/**
 * Which changelog entries the person has already seen (or dismissed).
 *
 * Kept in localStorage by entry id, behind an external store so the banner,
 * the nav dot and the changelog page stay in sync (also across tabs via the
 * `storage` event). Every storage access is wrapped: private mode or blocked
 * site data just means "nothing seen yet" for this visit.
 */
import { useMemo, useSyncExternalStore } from "react";
import { CHANGELOG, unseenEntries, unseenHighlights, type ChangelogEntry } from "@/lib/changelog";

export const WHATS_NEW_STORAGE_KEY = "polpo-whats-new-seen";

function readStoredIds(): Set<string> {
  try {
    const raw = localStorage.getItem(WHATS_NEW_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function writeStoredIds(ids: Set<string>) {
  try {
    localStorage.setItem(WHATS_NEW_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Not persisted (private mode / blocked storage) — kept in memory for this visit.
  }
}

let seen: Set<string> | null = null;
const listeners = new Set<() => void>();

function getSeen(): Set<string> {
  if (!seen) seen = readStoredIds();
  return seen;
}

function emit() {
  listeners.forEach((cb) => cb());
}

function onStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== WHATS_NEW_STORAGE_KEY) return;
  seen = null;
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

/** Mark entries as seen (dismissed, CTA clicked, or shown on the changelog page). */
export function markChangelogSeen(ids: string[]) {
  const current = getSeen();
  if (ids.every((id) => current.has(id))) return;
  const next = new Set(current);
  for (const id of ids) next.add(id);
  seen = next;
  writeStoredIds(next);
  emit();
}

export function markAllChangelogSeen(entries: ChangelogEntry[] = CHANGELOG) {
  markChangelogSeen(entries.map((entry) => entry.id));
}

export function useSeenChangelogIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, getSeen, getSeen);
}

/** Unseen entries, newest first. */
export function useUnseenChangelog(entries: ChangelogEntry[] = CHANGELOG): ChangelogEntry[] {
  const seenIds = useSeenChangelogIds();
  return useMemo(() => unseenEntries(entries, seenIds), [entries, seenIds]);
}

/** Unseen highlighted entries (for the banner), newest first. */
export function useUnseenHighlights(entries: ChangelogEntry[] = CHANGELOG): ChangelogEntry[] {
  const seenIds = useSeenChangelogIds();
  return useMemo(() => unseenHighlights(entries, seenIds), [entries, seenIds]);
}

/** True while at least one entry is unseen (nav dot). */
export function useHasUnseenChangelog(entries: ChangelogEntry[] = CHANGELOG): boolean {
  return useUnseenChangelog(entries).length > 0;
}
