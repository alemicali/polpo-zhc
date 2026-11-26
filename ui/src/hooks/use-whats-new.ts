/**
 * Which changelog entries the person has already seen (or dismissed).
 *
 * Kept in localStorage by entry id, behind an external store so the banner,
 * the nav dot and the changelog page stay in sync (also across tabs via the
 * `storage` event). Every storage access is wrapped: private mode or blocked
 * site data just means "nothing seen yet" for this visit.
 */
import { useMemo, useState, useSyncExternalStore } from "react";
import {
  CHANGELOG,
  sortChangelogByOnline,
  unseenEntries,
  unseenHighlights,
  type ChangelogEntry,
  type ChangelogPublishedAt,
} from "@/lib/changelog";

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

/**
 * When each entry went online on this instance: recorded by the UI server the first time it served
 * a build containing it, inlined into runtime-config.js. Empty in dev (entries' own `publishedAt` apply).
 */
export function changelogPublishedAtMap(): ChangelogPublishedAt {
  const raw: unknown = globalThis.__POLPO_RUNTIME_CONFIG__?.whatsNewPublishedAt;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && !Number.isNaN(new Date(value).getTime())) out[id] = value;
  }
  return out;
}

/** Unseen entries, newest first (by day, then by when they went online). */
export function useUnseenChangelog(entries: ChangelogEntry[] = CHANGELOG): ChangelogEntry[] {
  const seenIds = useSeenChangelogIds();
  return useMemo(() => sortChangelogByOnline(unseenEntries(entries, seenIds), changelogPublishedAtMap()), [entries, seenIds]);
}

/** Unseen highlighted entries (for the banner), newest first. */
export function useUnseenHighlights(entries: ChangelogEntry[] = CHANGELOG): ChangelogEntry[] {
  const seenIds = useSeenChangelogIds();
  return useMemo(() => sortChangelogByOnline(unseenHighlights(entries, seenIds), changelogPublishedAtMap()), [entries, seenIds]);
}

/**
 * The entries that arrived since the person's last visit, captured when `active` becomes true (the
 * page mounts, the drawer opens) — before opening marks everything as seen — and kept while it stays
 * open. Empty on a first visit (nothing seen yet: there is no "last visit" to compare with).
 */
export function useChangelogUnreadSnapshot(active: boolean, entries: ChangelogEntry[] = CHANGELOG): ReadonlySet<string> {
  const seenIds = useSeenChangelogIds();
  const capture = () => (seenIds.size === 0 ? new Set<string>() : new Set(unseenEntries(entries, seenIds).map((e) => e.id)));
  const [snapshot, setSnapshot] = useState<ReadonlySet<string>>(() => (active ? capture() : new Set()));
  const [wasActive, setWasActive] = useState(active);
  if (active !== wasActive) {
    setWasActive(active);
    if (active) setSnapshot(capture());
  }
  return snapshot;
}

/** True while at least one entry is unseen (nav dot). */
export function useHasUnseenChangelog(entries: ChangelogEntry[] = CHANGELOG): boolean {
  return useUnseenChangelog(entries).length > 0;
}

/** The sidebar's What's new cards: unread entries first, then the most recent, `size` at most. */
export function whatsNewStackEntries(entries: ChangelogEntry[], seen: ReadonlySet<string>, size = 5): ChangelogEntry[] {
  const sorted = sortChangelogByOnline(entries, changelogPublishedAtMap());
  return [...sorted.filter((e) => !seen.has(e.id)), ...sorted.filter((e) => seen.has(e.id))].slice(0, size);
}
