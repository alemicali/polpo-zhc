/**
 * Layout mode store — switches between "sidebar" (traditional nav sidebar)
 * and "chat-first" (chat panel + resizable nav panel).
 *
 * Uses useSyncExternalStore so subscribers only re-render on mode change.
 * Persisted in localStorage.
 */

import { useSyncExternalStore } from "react";
import { createThreadsOpenStore } from "@/lib/chat-navigation";

export type LayoutMode = "sidebar" | "chat-first";
export type ChatFirstNavMode = "inline" | "grouped" | "more";

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
//  Chat-first page navigation mode
// ═══════════════════════════════════════════════════════

const CHAT_FIRST_NAV_STORAGE_KEY = "polpo-chat-first-nav-mode";

let _chatFirstNavMode: ChatFirstNavMode;
try {
  const stored = localStorage.getItem(CHAT_FIRST_NAV_STORAGE_KEY);
  _chatFirstNavMode = stored === "inline" || stored === "grouped" || stored === "more"
    ? stored
    : "more";
} catch {
  _chatFirstNavMode = "more";
}

const chatFirstNavListeners = new Set<() => void>();

function chatFirstNavSubscribe(cb: () => void) {
  chatFirstNavListeners.add(cb);
  return () => { chatFirstNavListeners.delete(cb); };
}

function getChatFirstNavSnapshot(): ChatFirstNavMode {
  return _chatFirstNavMode;
}

export function setChatFirstNavMode(mode: ChatFirstNavMode) {
  if (_chatFirstNavMode === mode) return;
  _chatFirstNavMode = mode;
  try { localStorage.setItem(CHAT_FIRST_NAV_STORAGE_KEY, mode); } catch { /* ignore */ }
  chatFirstNavListeners.forEach((cb) => cb());
}

export function useChatFirstNavMode(): ChatFirstNavMode {
  return useSyncExternalStore(
    chatFirstNavSubscribe,
    getChatFirstNavSnapshot,
    getChatFirstNavSnapshot,
  );
}

// ═══════════════════════════════════════════════════════
//  Chat-first sessions panel store (open/close the session sidebar)
//  Desktop: the saved `threadsOpen` preference. Phones: per visit.
// ═══════════════════════════════════════════════════════

const chatFirstThreads = createThreadsOpenStore();

export function setChatFirstSessionsOpen(open: boolean) {
  chatFirstThreads.setOpen(open);
}

export function toggleChatFirstSessions() {
  chatFirstThreads.toggle();
}

/** Hook to read whether the chat-first session panel is open. */
export function useChatFirstSessionsOpen(): boolean {
  return chatFirstThreads.useOpen();
}
