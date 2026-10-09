/**
 * ChatProvider — see ./chat-context.ts for the contexts, consumer hooks and
 * the rationale behind the state/actions/session split.
 */

import { useMemo } from "react";
import { useChat } from "./use-polpo";
import {
  ChatActionsContext,
  ChatSessionStateContext,
  ChatStateContext,
  type ChatActionsValue,
  type ChatSessionStateValue,
  type ChatStateValue,
} from "./chat-context";

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const chat = useChat();

  // Split into state (reactive) and actions (stable)
  const state: ChatStateValue = useMemo(() => ({
    messages: chat.messages,
    isLoading: chat.isLoading,
    messagesLoading: chat.messagesLoading,
    activeSessionKey: chat.activeSessionKey,
    sessionId: chat.sessionId,
    sessions: chat.sessions,
    sessionsLoading: chat.sessionsLoading,
    streamingSessionIds: chat.streamingSessionIds,
    pendingQuestions: chat.pendingQuestions,
    pendingMission: chat.pendingMission,
    pendingVault: chat.pendingVault,
    pendingWhatsApp: chat.pendingWhatsApp,
    pendingEmail: chat.pendingEmail,
    pendingOpenFile: chat.pendingOpenFile,
    pendingNavigateTo: chat.pendingNavigateTo,
    pendingOpenTab: chat.pendingOpenTab,
    pendingSetDesign: chat.pendingSetDesign,
    selectedAgent: chat.selectedAgent,
  }), [
    chat.messages, chat.isLoading, chat.messagesLoading, chat.activeSessionKey,
    chat.sessionId, chat.sessions, chat.sessionsLoading, chat.streamingSessionIds,
    chat.pendingQuestions, chat.pendingMission, chat.pendingVault,
    chat.pendingWhatsApp, chat.pendingEmail,
    chat.pendingOpenFile, chat.pendingNavigateTo,
    chat.pendingOpenTab, chat.pendingSetDesign, chat.selectedAgent,
  ]);

  const actions: ChatActionsValue = useMemo(() => ({
    send: chat.send,
    stop: chat.stop,
    answerQuestions: chat.answerQuestions,
    respondToMission: chat.respondToMission,
    respondToVault: chat.respondToVault,
    respondToWhatsApp: chat.respondToWhatsApp,
    respondToEmail: chat.respondToEmail,
    consumeOpenFile: chat.consumeOpenFile,
    consumeNavigateTo: chat.consumeNavigateTo,
    consumeOpenTab: chat.consumeOpenTab,
    consumeSetDesign: chat.consumeSetDesign,
    clear: chat.clear,
    loadSession: chat.loadSession,
    newSession: chat.newSession,
    deleteSession: chat.deleteSession,
    renameSession: chat.renameSession,
    setStarred: chat.setStarred,
    setSelectedAgent: chat.setSelectedAgent,
    steer: chat.steer,
    cancelSteer: chat.cancelSteer,
    forkSession: chat.forkSession,
    undoFork: chat.undoFork,
  }), [
    chat.send, chat.stop, chat.answerQuestions,
    chat.respondToMission, chat.respondToVault,
    chat.respondToWhatsApp, chat.respondToEmail,
    chat.consumeOpenFile, chat.consumeNavigateTo,
    chat.consumeOpenTab, chat.consumeSetDesign,
    chat.clear, chat.loadSession, chat.newSession, chat.deleteSession,
    chat.renameSession, chat.setStarred,
    chat.setSelectedAgent,
    chat.steer, chat.cancelSteer, chat.forkSession, chat.undoFork,
  ]);

  // Session chrome must not re-render for every streamed token. Keep this
  // narrow context independent from the message-heavy state context.
  const sessionState: ChatSessionStateValue = useMemo(() => ({
    sessionId: chat.sessionId,
    sessions: chat.sessions,
    sessionsLoading: chat.sessionsLoading,
    streamingSessionIds: chat.streamingSessionIds,
    messagesLoading: chat.messagesLoading,
    selectedAgent: chat.selectedAgent,
  }), [
    chat.sessionId,
    chat.sessions,
    chat.sessionsLoading,
    chat.streamingSessionIds,
    chat.messagesLoading,
    chat.selectedAgent,
  ]);

  return (
    <ChatSessionStateContext.Provider value={sessionState}>
      <ChatStateContext.Provider value={state}>
        <ChatActionsContext.Provider value={actions}>
          {children}
        </ChatActionsContext.Provider>
      </ChatStateContext.Provider>
    </ChatSessionStateContext.Provider>
  );
}
