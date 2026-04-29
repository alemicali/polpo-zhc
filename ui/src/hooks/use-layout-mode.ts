/**
 * Layout mode store — switches between "sidebar" (traditional nav sidebar)
 * and "chat-first" (chat panel + resizable nav panel).
 *
 * Uses useSyncExternalStore so subscribers only re-render on mode change.
 * Persisted in localStorage.
 */

import { useSyncExternalStore } from "react";

export type LayoutMode = "sidebar" | "chat-first";

const STORAGE_KEY = "polpo-layout-mode";

let _mode: LayoutMode;
try {
  const stored = localStorage.getItem(STORAGE_KEY);
  _mode = stored === "chat-first" ? "chat-first" : "sidebar";
} catch {
  _mode = "sidebar";
}

const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function getSnapshot(): LayoutMode {
  return _mode;
}

export function setLayoutMode(mode: LayoutMode) {
  if (_mode === mode) return;
  _mode = mode;
  try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* ignore */ }
  listeners.forEach((cb) => cb());
}

export function toggleLayoutMode() {
  setLayoutMode(_mode === "sidebar" ? "chat-first" : "sidebar");
}

/** Hook to read the current layout mode. Only re-renders when mode changes. */
export function useLayoutMode(): LayoutMode {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ═══════════════════════════════════════════════════════
//  Chat-first sessions panel store (open/close the session sidebar)
// ═══════════════════════════════════════════════════════

let _sessionsOpen = false;
const sessionsListeners = new Set<() => void>();

function sessionsSubscribe(cb: () => void) {
  sessionsListeners.add(cb);
  return () => { sessionsListeners.delete(cb); };
}
function getSessionsSnapshot() { return _sessionsOpen; }

export function setChatFirstSessionsOpen(open: boolean) {
  if (_sessionsOpen === open) return;
  _sessionsOpen = open;
  sessionsListeners.forEach((cb) => cb());
}

export function toggleChatFirstSessions() {
  setChatFirstSessionsOpen(!_sessionsOpen);
}

/** Hook to read whether the chat-first session panel is open. */
export function useChatFirstSessionsOpen(): boolean {
  return useSyncExternalStore(sessionsSubscribe, getSessionsSnapshot, getSessionsSnapshot);
}
