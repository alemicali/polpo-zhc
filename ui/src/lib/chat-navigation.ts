/**
 * Chat navigation preferences — "where I was" in the chat, per person and
 * per instance: the open chat (thread, group or new chat), the open tabs,
 * the right-hand chat panel and the thread list.
 *
 * Source of truth is the server (GET/PATCH /api/v1/preferences, per member),
 * so the state follows the person across devices. A localStorage copy keyed
 * by instance + member makes the first paint instant and covers offline use.
 *
 * Drafts and scroll positions are device-local and live in `createLocalCache`
 * caches (localStorage, same instance + member scope).
 *
 * Everything here is an external store (useSyncExternalStore) so headers and
 * panels subscribe without re-rendering on chat updates. All storage access
 * is wrapped: a private window or blocked storage just means no persistence.
 */
import { useSyncExternalStore } from "react";
import { config } from "./config";

export interface ChatNavigation {
  /** Thread open in the chat; null = a new, unsaved chat; undefined = never recorded. */
  lastSessionId?: string | null;
  /** Group open in the chat (wins over the thread), or null. */
  lastRoomId?: string | null;
  /** Agent picked for the new chat when lastSessionId is null. */
  lastAgent?: string | null;
  /** Thread ids open as tabs, left to right. */
  openTabs?: string[];
  /** Right-hand chat panel shown on other pages. */
  sidePanelOpen?: boolean;
  /** Thread list shown next to the chat (desktop). */
  threadsOpen?: boolean;
}

/** Saves a patch on the server; set by the chat once the API client exists. */
export type ChatNavigationSaver = (patch: ChatNavigation) => Promise<unknown>;

const PREFIX = "polpo:chat-nav:v1";
const SHARED_MEMBER = "_shared";
const SAVE_DELAY_MS = 400;

// ── Storage helpers (never throw) ─────────────────────────────────────

function storageGet(key: string): string | null {
  try { return typeof localStorage === "undefined" ? null : localStorage.getItem(key); } catch { return null; }
}
function storageSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* quota or blocked */ }
}
function storageRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* blocked */ }
}

/** The instance this dashboard talks to (API base URL, or this origin). */
export function chatInstanceKey(): string {
  const origin = typeof window !== "undefined" && window.location ? window.location.origin : "";
  const raw = (config.baseUrl || origin || "local").replace(/\/+$/, "");
  return raw.toLowerCase().replace(/[^a-z0-9.:-]+/g, "_");
}

const memberPointerKey = () => `${PREFIX}:${chatInstanceKey()}:member`;
const navKey = (member: string) => `${PREFIX}:${chatInstanceKey()}:${member}:nav`;

function sanitize(input: unknown): ChatNavigation {
  if (!input || typeof input !== "object") return {};
  const src = input as Record<string, unknown>;
  const out: ChatNavigation = {};
  const idOrNull = (v: unknown) => (v === null || (typeof v === "string" && v.length > 0) ? v as string | null : undefined);
  const session = idOrNull(src.lastSessionId);
  if (session !== undefined) out.lastSessionId = session;
  const room = idOrNull(src.lastRoomId);
  if (room !== undefined) out.lastRoomId = room;
  const agent = idOrNull(src.lastAgent);
  if (agent !== undefined) out.lastAgent = agent;
  if (Array.isArray(src.openTabs)) out.openTabs = src.openTabs.filter((t): t is string => typeof t === "string" && t.length > 0);
  if (typeof src.sidePanelOpen === "boolean") out.sidePanelOpen = src.sidePanelOpen;
  if (typeof src.threadsOpen === "boolean") out.threadsOpen = src.threadsOpen;
  return out;
}

/** Pre-member-scoping keys: read once so nobody loses their tabs or panel on upgrade. */
function readLegacy(): ChatNavigation {
  const out: ChatNavigation = {};
  try {
    const tabs = JSON.parse(storageGet("polpo:chat:tabs") ?? "null") as unknown;
    if (Array.isArray(tabs)) out.openTabs = tabs.filter((t): t is string => typeof t === "string");
  } catch { /* ignore */ }
  const panel = storageGet("polpo-chat-sidebar");
  if (panel === "true" || panel === "false") out.sidePanelOpen = panel === "true";
  return out;
}

function readCached(member: string): ChatNavigation | null {
  const raw = storageGet(navKey(member));
  if (!raw) return null;
  try { return sanitize(JSON.parse(raw)); } catch { return null; }
}

// ── Store state ───────────────────────────────────────────────────────

let member: string = storageGet(memberPointerKey()) || SHARED_MEMBER;
let state: ChatNavigation = readCached(member) ?? readLegacy();
/** True once the server answered (or failed) — the chat restores only then. */
let hydrated = false;
let saver: ChatNavigationSaver | null = null;
let pending: ChatNavigation = {};
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const scopeListeners = new Set<() => void>();

function emit() { listeners.forEach((cb) => cb()); }

function persistLocal() {
  storageSet(navKey(member), JSON.stringify(state));
}

function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!saver || !hydrated || Object.keys(pending).length === 0) return;
  const patch = pending;
  pending = {};
  void saver(patch).catch(() => {
    // Keep it for the next write; newer values for the same field win.
    pending = { ...patch, ...pending };
  });
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, SAVE_DELAY_MS);
}

if (typeof window !== "undefined") {
  // Leaving or hiding the page: don't lose the last change to the debounce.
  window.addEventListener("pagehide", flushSave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSave();
  });
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}

/** Current navigation preferences (stable reference until something changes). */
export function getChatNavigation(): ChatNavigation {
  return state;
}

/** Merge fields into the preferences: local copy now, server shortly after. */
export function updateChatNavigation(patch: ChatNavigation): void {
  const changed = (Object.keys(patch) as (keyof ChatNavigation)[])
    .filter((k) => patch[k] !== undefined && !sameValue(state[k], patch[k]));
  if (changed.length === 0) return;
  const applied: ChatNavigation = {};
  for (const k of changed) (applied as Record<string, unknown>)[k] = patch[k];
  state = { ...state, ...applied };
  pending = { ...pending, ...applied };
  persistLocal();
  emit();
  scheduleSave();
}

/**
 * Apply the server's copy for `serverMember` (null = shared, no instance auth).
 * Changes made locally before the answer arrived are kept and sent.
 */
export function hydrateChatNavigation(serverMember: string | null, prefs: ChatNavigation | undefined): void {
  const nextMember = serverMember?.trim().toLowerCase() || SHARED_MEMBER;
  const scopeChanged = nextMember !== member;
  if (scopeChanged) {
    member = nextMember;
    storageSet(memberPointerKey(), member);
    // Another person signed in on this browser: their own state, never the previous one's.
    pending = {};
  }
  const server = sanitize(prefs);
  const base = scopeChanged ? (readCached(member) ?? {}) : state;
  // Server wins across devices, except for what this tab changed meanwhile.
  state = { ...base, ...server, ...pending };
  // First visit on the server: keep what this browser already had (and send it up).
  if (!prefs || Object.keys(server).length === 0) {
    pending = { ...base, ...pending };
  }
  hydrated = true;
  persistLocal();
  if (scopeChanged) scopeListeners.forEach((cb) => cb());
  emit();
  scheduleSave();
}

/** The server could not be reached: go on with the local copy. */
export function markChatNavigationOffline(): void {
  if (hydrated) return;
  hydrated = true;
  emit();
}

export function isChatNavigationHydrated(): boolean {
  return hydrated;
}

export function setChatNavigationSaver(next: ChatNavigationSaver | null): void {
  saver = next;
  if (next) scheduleSave();
}

/** Storage scope (instance + member) for device-local caches. */
export function chatStorageScope(): string {
  return `${chatInstanceKey()}:${member}`;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Listen to any change of the navigation preferences (or hydration). */
export const subscribeChatNavigation = subscribe;

export function useChatNavigation(): ChatNavigation {
  return useSyncExternalStore(subscribe, getChatNavigation, getChatNavigation);
}

export function useChatNavigationHydrated(): boolean {
  return useSyncExternalStore(subscribe, isChatNavigationHydrated, isChatNavigationHydrated);
}

// ── Initial selection claim ───────────────────────────────────────────
//
// Exactly one thing decides which chat opens first: a link (/chat?session=,
// ?room=), an explicit pick by the person, or — if neither happened — the
// restore of the last chat. Whoever claims first wins.

let initialSelectionClaimed = false;

/** Returns true for the first caller only. */
export function claimInitialChatSelection(): boolean {
  if (initialSelectionClaimed) return false;
  initialSelectionClaimed = true;
  return true;
}

export function isInitialChatSelectionClaimed(): boolean {
  return initialSelectionClaimed;
}

// Groups have their own claim: a group link (/chat?room=) still lets the
// thread underneath be restored, and any explicit group change (open, leave)
// stops the last group from being reopened.
let initialRoomClaimed = false;

/** Returns true for the first caller only. */
export function claimInitialRoomSelection(): boolean {
  if (initialRoomClaimed) return false;
  initialRoomClaimed = true;
  return true;
}

// ── Device-local caches (drafts, scroll positions) ────────────────────

export interface LocalCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  delete(key: string): void;
  /** Write pending changes now (also done on pagehide). */
  flush(): void;
}

/**
 * A small Map persisted in localStorage under the current instance + member,
 * bounded to `maxEntries` (least recently written dropped first). Writes are
 * batched; reads are always from memory.
 */
export function createLocalCache<T>(name: string, opts: { maxEntries: number; maxBytes?: number }): LocalCache<T> {
  let loadedScope: string | null = null;
  let entries = new Map<string, T>();
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const keyFor = (scope: string) => `polpo:chat-${name}:v1:${scope}`;

  const load = () => {
    const scope = chatStorageScope();
    if (scope === loadedScope) return;
    loadedScope = scope;
    entries = new Map();
    try {
      const parsed = JSON.parse(storageGet(keyFor(scope)) ?? "null") as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, T>)) entries.set(k, v);
      }
    } catch { /* corrupted — start empty */ }
  };

  const write = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty || loadedScope === null) return;
    dirty = false;
    while (entries.size > opts.maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    if (entries.size === 0) { storageRemove(keyFor(loadedScope)); return; }
    let json = JSON.stringify(Object.fromEntries(entries));
    // Too big for comfort: drop the oldest until it fits.
    while (opts.maxBytes && json.length > opts.maxBytes && entries.size > 1) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
      json = JSON.stringify(Object.fromEntries(entries));
    }
    storageSet(keyFor(loadedScope), json);
  };

  const schedule = () => {
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(write, 300);
  };

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", write);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") write();
    });
  }
  scopeListeners.add(() => { write(); loadedScope = null; });

  return {
    get(key) { load(); return entries.get(key); },
    set(key, value) {
      load();
      entries.delete(key); // re-insert: most recent last
      entries.set(key, value);
      schedule();
    },
    delete(key) {
      load();
      if (!entries.delete(key)) return;
      schedule();
    },
    flush: write,
  };
}

// ── Thread list open/closed ───────────────────────────────────────────

const DESKTOP_QUERY = "(min-width: 1024px)";

function isDesktop(): boolean {
  try { return typeof window !== "undefined" && !!window.matchMedia?.(DESKTOP_QUERY).matches; } catch { return false; }
}

/**
 * Open/closed store for a thread list next to the chat. On desktop it is the
 * person's saved preference (`threadsOpen`); on phones the list covers the
 * chat, so it stays a per-visit state that starts closed and is never saved.
 */
export function createThreadsOpenStore() {
  let mobileOpen = false;
  const getSnapshot = () => (isDesktop() ? getChatNavigation().threadsOpen ?? false : mobileOpen);
  const localListeners = new Set<() => void>();
  const subscribeThreads = (cb: () => void) => {
    localListeners.add(cb);
    const unsubscribeNav = subscribe(cb);
    let media: MediaQueryList | undefined;
    try { media = typeof window !== "undefined" ? window.matchMedia?.(DESKTOP_QUERY) : undefined; } catch { media = undefined; }
    media?.addEventListener?.("change", cb);
    return () => {
      localListeners.delete(cb);
      unsubscribeNav();
      media?.removeEventListener?.("change", cb);
    };
  };
  const setOpen = (open: boolean) => {
    if (isDesktop()) {
      updateChatNavigation({ threadsOpen: open });
      return;
    }
    if (mobileOpen === open) return;
    mobileOpen = open;
    localListeners.forEach((cb) => cb());
  };
  return {
    getSnapshot,
    setOpen,
    toggle: () => setOpen(!getSnapshot()),
    useOpen: () => useSyncExternalStore(subscribeThreads, getSnapshot, getSnapshot),
  };
}

/** Test hook: back to a fresh, unhydrated store reading storage again. */
export function resetChatNavigationForTests(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  member = storageGet(memberPointerKey()) || SHARED_MEMBER;
  state = readCached(member) ?? readLegacy();
  hydrated = false;
  saver = null;
  pending = {};
  initialSelectionClaimed = false;
  initialRoomClaimed = false;
  scopeListeners.forEach((cb) => cb());
  emit();
}
