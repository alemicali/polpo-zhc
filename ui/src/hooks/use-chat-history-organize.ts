/**
 * How the chat history is organized: "chat" (Recents by time, the default) or "agent" (one
 * section per agent). This person's choice, kept in this browser.
 *
 * Storage may be unavailable (private mode, blocked): every read and write is guarded and the
 * in-memory copy keeps working for the visit. Every mounted history (the drill-in sidebar, the
 * chat page's panel) follows the same value.
 */

import { useSyncExternalStore } from "react";

export type ChatHistoryOrganize = "chat" | "agent";
export const CHAT_HISTORY_ORGANIZE_KEY = "polpo-chat-history-organize";
export const DEFAULT_CHAT_HISTORY_ORGANIZE: ChatHistoryOrganize = "chat";

export function isChatHistoryOrganize(value: unknown): value is ChatHistoryOrganize {
  return value === "chat" || value === "agent";
}

function read(): ChatHistoryOrganize {
  try {
    const stored = localStorage.getItem(CHAT_HISTORY_ORGANIZE_KEY);
    return isChatHistoryOrganize(stored) ? stored : DEFAULT_CHAT_HISTORY_ORGANIZE;
  } catch {
    return DEFAULT_CHAT_HISTORY_ORGANIZE;
  }
}

let current: ChatHistoryOrganize = read();
const listeners = new Set<() => void>();

function emit(next: ChatHistoryOrganize) {
  current = next;
  listeners.forEach((cb) => cb());
}

let watching = false;
function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!watching && typeof window !== "undefined") {
    watching = true;
    // another tab changed it
    window.addEventListener("storage", (event) => {
      if (event.key === CHAT_HISTORY_ORGANIZE_KEY || event.key === null) emit(read());
    });
  }
  return () => { listeners.delete(cb); };
}

function getSnapshot(): ChatHistoryOrganize {
  return current;
}

export function useChatHistoryOrganize(): ChatHistoryOrganize {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function setChatHistoryOrganize(value: ChatHistoryOrganize): void {
  if (value === current) return;
  try { localStorage.setItem(CHAT_HISTORY_ORGANIZE_KEY, value); } catch { /* storage unavailable: memory carries the visit */ }
  emit(value);
}

/** Tests: re-read storage. */
export function resetChatHistoryOrganizeForTests(): void {
  emit(read());
}
