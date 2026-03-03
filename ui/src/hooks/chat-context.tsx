/**
 * ChatProvider — lifts the useChat() hook into a React context so that chat
 * state (messages, session, streaming, pending interactive tools) persists
 * across route changes.
 *
 * Without this, navigating away from /chat unmounts ChatPage and destroys all
 * state. With the provider, the state lives at the app root and can be consumed
 * by both the dedicated ChatPage and the ChatSidebar.
 */

import { createContext, useContext, useState, useCallback } from "react";
import { useChat } from "./use-polpo";

// ── Types ──

export type ChatContextValue = ReturnType<typeof useChat> & {
  /** Whether the right-side chat sidebar is open */
  sidebarOpen: boolean;
  /** Toggle the chat sidebar open/closed */
  setSidebarOpen: (open: boolean) => void;
  /** Toggle helper */
  toggleSidebar: () => void;
};

// ── Context ──

const ChatContext = createContext<ChatContextValue | null>(null);

// ── Provider ──

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const chat = useChat();

  // Sidebar open/closed state — persisted to localStorage
  const [sidebarOpen, setSidebarOpenRaw] = useState(() => {
    try {
      return localStorage.getItem("polpo-chat-sidebar") === "true";
    } catch {
      return false;
    }
  });

  const setSidebarOpen = useCallback((open: boolean) => {
    setSidebarOpenRaw(open);
    try {
      localStorage.setItem("polpo-chat-sidebar", String(open));
    } catch {
      // ignore
    }
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen(!sidebarOpen);
  }, [sidebarOpen, setSidebarOpen]);

  return (
    <ChatContext.Provider value={{ ...chat, sidebarOpen, setSidebarOpen, toggleSidebar }}>
      {children}
    </ChatContext.Provider>
  );
}

// ── Consumer hook ──

/**
 * Access the shared chat state. Must be called within <ChatProvider>.
 * This replaces direct `useChat()` calls in components that need shared state.
 */
export function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error("useChatContext must be used within a <ChatProvider>");
  }
  return ctx;
}
