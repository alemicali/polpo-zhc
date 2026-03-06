/**
 * ChatProvider — lifts the useChat() hook into a React context so that chat
 * state (messages, session, streaming, pending interactive tools) persists
 * across route changes.
 *
 * Without this, navigating away from /chat unmounts ChatPage and destroys all
 * state. With the provider, the state lives at the app root and can be consumed
 * by both the dedicated ChatPage and the ChatSidebar.
 *
 * Split into two contexts to prevent re-render cascades:
 * - ChatStateContext: reactive data (messages, loading, pending*, sessions)
 * - ChatActionsContext: stable callback refs (send, stop, loadSession, etc.)
 *
 * Components that only dispatch actions (e.g., prompt input) subscribe to
 * ChatActionsContext and never re-render when messages update.
 *
 * Sidebar open/closed state is managed separately via a lightweight external
 * store (useSyncExternalStore) so that Header and ChatSidebar can subscribe
 * to it without re-rendering on every chat state change.
 */

import { createContext, use, useMemo, useSyncExternalStore } from "react";
import { useChat } from "./use-polpo";
import type {
  AskUserQuestion,
  MissionPreviewData,
  VaultPreviewData,
  OpenFileData,
  NavigateToData,
  OpenTabData,
  ChatMessageWithQuestions,
  AskUserAnswer,
  MissionPreviewAction,
  VaultPreviewAction,
} from "./use-polpo";

// ═══════════════════════════════════════════════════════
//  Sidebar store — external, no context, no re-render cascade
// ═══════════════════════════════════════════════════════

let _sidebarOpen: boolean;
try {
  _sidebarOpen = localStorage.getItem("polpo-chat-sidebar") === "true";
} catch {
  _sidebarOpen = false;
}

const listeners = new Set<() => void>();
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
function getSnapshot() { return _sidebarOpen; }

function setSidebarOpen(open: boolean) {
  if (_sidebarOpen === open) return;
  _sidebarOpen = open;
  try { localStorage.setItem("polpo-chat-sidebar", String(open)); } catch { /* ignore */ }
  listeners.forEach(cb => cb());
}

function toggleSidebar() {
  setSidebarOpen(!_sidebarOpen);
}

/** Hook to read sidebar open state — only re-renders when sidebar state changes */
export function useSidebarOpen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Imperative sidebar controls — stable references, never cause re-renders */
export const sidebarActions = { setSidebarOpen, toggleSidebar } as const;

// ═══════════════════════════════════════════════════════
//  Chat contexts — split state from actions
// ═══════════════════════════════════════════════════════

/** Reactive state — changes on every message, loading toggle, etc. */
export interface ChatStateValue {
  messages: ChatMessageWithQuestions[];
  isLoading: boolean;
  messagesLoading: boolean;
  sessionId: string | null;
  sessions: { id: string; title?: string; createdAt: string; updatedAt: string; messageCount: number }[];
  sessionsLoading: boolean;
  pendingQuestions: AskUserQuestion[] | null;
  pendingMission: MissionPreviewData | null;
  pendingVault: VaultPreviewData | null;
  pendingOpenFile: OpenFileData | null;
  pendingNavigateTo: NavigateToData | null;
  pendingOpenTab: OpenTabData | null;
}

/** Stable action callbacks — never change identity (wrapped in useCallback upstream) */
export interface ChatActionsValue {
  send: (message: string, images?: { url: string; mimeType: string }[]) => Promise<void>;
  stop: () => void;
  answerQuestions: (answers: AskUserAnswer[]) => Promise<void>;
  respondToMission: (action: MissionPreviewAction, feedback?: string) => Promise<{ missionId?: string; error?: string }>;
  respondToVault: (action: VaultPreviewAction, editedCredentials?: Record<string, string>) => Promise<void>;
  consumeOpenFile: () => void;
  consumeNavigateTo: () => void;
  consumeOpenTab: () => void;
  clear: () => void;
  loadSession: (id: string) => Promise<void>;
  newSession: () => void;
  deleteSession: (id: string) => Promise<void>;
}

const ChatStateContext = createContext<ChatStateValue | null>(null);
const ChatActionsContext = createContext<ChatActionsValue | null>(null);

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const chat = useChat();

  // Split into state (reactive) and actions (stable)
  const state: ChatStateValue = useMemo(() => ({
    messages: chat.messages,
    isLoading: chat.isLoading,
    messagesLoading: chat.messagesLoading,
    sessionId: chat.sessionId,
    sessions: chat.sessions,
    sessionsLoading: chat.sessionsLoading,
    pendingQuestions: chat.pendingQuestions,
    pendingMission: chat.pendingMission,
    pendingVault: chat.pendingVault,
    pendingOpenFile: chat.pendingOpenFile,
    pendingNavigateTo: chat.pendingNavigateTo,
    pendingOpenTab: chat.pendingOpenTab,
  }), [
    chat.messages, chat.isLoading, chat.messagesLoading,
    chat.sessionId, chat.sessions, chat.sessionsLoading,
    chat.pendingQuestions, chat.pendingMission, chat.pendingVault,
    chat.pendingOpenFile, chat.pendingNavigateTo,
    chat.pendingOpenTab,
  ]);

  const actions: ChatActionsValue = useMemo(() => ({
    send: chat.send,
    stop: chat.stop,
    answerQuestions: chat.answerQuestions,
    respondToMission: chat.respondToMission,
    respondToVault: chat.respondToVault,
    consumeOpenFile: chat.consumeOpenFile,
    consumeNavigateTo: chat.consumeNavigateTo,
    consumeOpenTab: chat.consumeOpenTab,
    clear: chat.clear,
    loadSession: chat.loadSession,
    newSession: chat.newSession,
    deleteSession: chat.deleteSession,
  }), [
    chat.send, chat.stop, chat.answerQuestions,
    chat.respondToMission, chat.respondToVault,
    chat.consumeOpenFile, chat.consumeNavigateTo,
    chat.consumeOpenTab,
    chat.clear, chat.loadSession, chat.newSession, chat.deleteSession,
  ]);

  return (
    <ChatStateContext.Provider value={state}>
      <ChatActionsContext.Provider value={actions}>
        {children}
      </ChatActionsContext.Provider>
    </ChatStateContext.Provider>
  );
}

/** Access reactive chat state. Re-renders when messages, loading, pending* change. */
export function useChatState(): ChatStateValue {
  const ctx = use(ChatStateContext);
  if (!ctx) throw new Error("useChatState must be used within a <ChatProvider>");
  return ctx;
}

/** Access stable chat actions. Never re-renders due to message/state changes. */
export function useChatActions(): ChatActionsValue {
  const ctx = use(ChatActionsContext);
  if (!ctx) throw new Error("useChatActions must be used within a <ChatProvider>");
  return ctx;
}

/**
 * Derived hook — true when the chat input should be disabled.
 * Centralises the boolean chain so consumers don't repeat it.
 */
export function useChatInputDisabled(): boolean {
  const {
    isLoading, pendingQuestions, pendingMission, pendingVault,
    pendingOpenFile, pendingNavigateTo, pendingOpenTab,
  } = useChatState();
  return (
    isLoading || !!pendingQuestions || !!pendingMission || !!pendingVault
    || !!pendingOpenFile || !!pendingNavigateTo || !!pendingOpenTab
  );
}


