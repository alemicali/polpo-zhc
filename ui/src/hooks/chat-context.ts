/**
 * Chat contexts, consumer hooks and sidebar stores. The ChatProvider component
 * lives in ./chat-provider.tsx (kept separate so Fast Refresh works).
 *
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

import { createContext, use, useSyncExternalStore } from "react";
import type {
  AskUserQuestion,
  MissionPreviewData,
  VaultPreviewData,
  WhatsAppPreviewData,
  EmailPreviewData,
  OpenFileData,
  NavigateToData,
  OpenTabData,
  SetDesignData,
  ChatMessageWithQuestions,
  AskUserAnswer,
  MissionPreviewAction,
  VaultPreviewAction,
  SendPreviewAction,
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
//  Dedicated /chat page session sidebar store
// ═══════════════════════════════════════════════════════

let _chatPageSessionsOpen = false;
const chatPageSessionsListeners = new Set<() => void>();

function chatPageSessionsSubscribe(cb: () => void) {
  chatPageSessionsListeners.add(cb);
  return () => { chatPageSessionsListeners.delete(cb); };
}

function getChatPageSessionsSnapshot() {
  return _chatPageSessionsOpen;
}

export function setChatPageSessionsOpen(open: boolean) {
  if (_chatPageSessionsOpen === open) return;
  _chatPageSessionsOpen = open;
  chatPageSessionsListeners.forEach((cb) => cb());
}

function toggleChatPageSessions() {
  setChatPageSessionsOpen(!_chatPageSessionsOpen);
}

export function useChatPageSessionsOpen(): boolean {
  return useSyncExternalStore(
    chatPageSessionsSubscribe,
    getChatPageSessionsSnapshot,
    getChatPageSessionsSnapshot,
  );
}

export const chatPageSessionActions = {
  setOpen: setChatPageSessionsOpen,
  toggle: toggleChatPageSessions,
} as const;

// ═══════════════════════════════════════════════════════
//  Chat contexts — split state from actions
// ═══════════════════════════════════════════════════════

/** Reactive state — changes on every message, loading toggle, etc. */
export interface ChatStateValue {
  messages: ChatMessageWithQuestions[];
  isLoading: boolean;
  messagesLoading: boolean;
  sessionId: string | null;
  sessions: { id: string; title?: string; createdAt: string; updatedAt: string; messageCount: number; agent?: string; starred?: boolean }[];
  sessionsLoading: boolean;
  streamingSessionIds: string[];
  pendingQuestions: AskUserQuestion[] | null;
  pendingMission: MissionPreviewData | null;
  pendingVault: VaultPreviewData | null;
  pendingWhatsApp: WhatsAppPreviewData | null;
  pendingEmail: EmailPreviewData | null;
  pendingOpenFile: OpenFileData | null;
  pendingNavigateTo: NavigateToData | null;
  pendingOpenTab: OpenTabData | null;
  pendingSetDesign: SetDesignData | null;
  /** Currently selected agent for agent-direct chat. null = orchestrator. */
  selectedAgent: string | null;
}

/** Stable action callbacks — never change identity (wrapped in useCallback upstream) */
export interface ChatActionsValue {
  send: (message: string, images?: { url: string; mimeType: string }[], context?: string, options?: { onAccepted?: () => void }) => Promise<void>;
  stop: () => void;
  answerQuestions: (answers: AskUserAnswer[]) => Promise<void>;
  respondToMission: (action: MissionPreviewAction, feedback?: string) => Promise<{ missionId?: string; error?: string }>;
  respondToVault: (action: VaultPreviewAction, editedCredentials?: Record<string, string>) => Promise<void>;
  respondToWhatsApp: (action: SendPreviewAction, feedback?: string) => Promise<{ id?: string; error?: string }>;
  respondToEmail: (action: SendPreviewAction, feedback?: string) => Promise<{ id?: string; error?: string }>;
  consumeOpenFile: () => void;
  consumeNavigateTo: () => void;
  consumeOpenTab: () => void;
  consumeSetDesign: (result?: { applied: boolean; description: string }) => void;
  clear: () => void;
  loadSession: (id: string) => Promise<void>;
  newSession: () => void;
  deleteSession: (id: string) => Promise<void>;
  /** Rename a session (PATCH title). Silent catch — dialog handles the error UX. */
  renameSession: (id: string, title: string) => Promise<void>;
  /** Toggle the star flag (PATCH starred). Does NOT bump updatedAt. */
  setStarred: (id: string, starred: boolean) => Promise<void>;
  setSelectedAgent: (agent: string | null) => void;
}

export const ChatStateContext = createContext<ChatStateValue | null>(null);
export const ChatActionsContext = createContext<ChatActionsValue | null>(null);

export type ChatSessionStateValue = Pick<ChatStateValue,
  | "sessionId"
  | "sessions"
  | "sessionsLoading"
  | "streamingSessionIds"
  | "messagesLoading"
  | "selectedAgent"
>;

export const ChatSessionStateContext = createContext<ChatSessionStateValue | null>(null);

/** Access reactive chat state. Re-renders when messages, loading, pending* change. */
export function useChatState(): ChatStateValue {
  const ctx = use(ChatStateContext);
  if (!ctx) throw new Error("useChatState must be used within a <ChatProvider>");
  return ctx;
}

/** Session metadata without subscribing to message/token updates. */
export function useChatSessionState(): ChatSessionStateValue {
  const ctx = use(ChatSessionStateContext);
  if (!ctx) throw new Error("useChatSessionState must be used within a <ChatProvider>");
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
export function useChatInputDisabled(options?: { includeLoading?: boolean }): boolean {
  const {
    isLoading, pendingQuestions, pendingMission, pendingVault,
    pendingWhatsApp, pendingEmail,
    pendingOpenFile, pendingNavigateTo, pendingOpenTab, pendingSetDesign,
  } = useChatState();
  const includeLoading = options?.includeLoading ?? true;
  return (
    (includeLoading && isLoading) || !!pendingQuestions || !!pendingMission || !!pendingVault
    || !!pendingWhatsApp || !!pendingEmail
    || !!pendingOpenFile || !!pendingNavigateTo || !!pendingOpenTab || !!pendingSetDesign
  );
}
