/**
 * Custom hooks that complement the @openpolpo/react-sdk.
 *
 * The SDK provides: useTasks, useTask, usePlans, usePlan, useAgents,
 * useProcesses, useEvents, useStats, useMemory, useLogs, usePolpo,
 * useSessions.
 *
 * This file provides hooks the SDK doesn't cover:
 * - useChat — session-aware chat with streaming via /v1/chat/completions
 * - useProjectInfo — fetches project name from orchestrator state
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { usePolpo, useSessions } from "@openpolpo/react-sdk";
import type { ChatMessage, ChatCompletionMessage } from "@openpolpo/react-sdk";

// ── useChat (session-aware + streaming) ──
// Builds on the SDK's useSessions hook for session management,
// uses chatCompletionsStream() for real-time streaming responses.

export function useChat() {
  const { client } = usePolpo();
  const {
    sessions,
    isLoading: sessionsLoading,
    activeSessionId: sessionId,
    setActiveSessionId: setSessionId,
    getMessages,
    deleteSession: sdkDeleteSession,
    refetch: refetchSessions,
  } = useSessions();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const initialLoadDone = useRef(false);
  /** Conversation history sent to the completions endpoint */
  const conversationRef = useRef<ChatCompletionMessage[]>([]);

  // Load a specific session's messages
  const loadSession = useCallback(
    async (id: string) => {
      setSessionId(id);
      try {
        const msgs = await getMessages(id);
        setMessages(msgs);
        // Rebuild conversation history from loaded messages
        conversationRef.current = msgs.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }));
      } catch {
        setMessages([]);
        conversationRef.current = [];
      }
    },
    [setSessionId, getMessages]
  );

  // Auto-select most recent session on first load
  useEffect(() => {
    if (initialLoadDone.current || sessionsLoading) return;
    initialLoadDone.current = true;
    if (sessions.length > 0) {
      const latest = sessions[0]; // sorted by updatedAt desc from server
      loadSession(latest.id);
    }
  }, [sessions, sessionsLoading, loadSession]);

  // Start a new empty session
  const newSession = useCallback(() => {
    setSessionId(null);
    setMessages([]);
    conversationRef.current = [];
  }, [setSessionId]);

  // Send a message (streaming)
  const send = useCallback(
    async (message: string) => {
      // Optimistic user message
      const userMsg: ChatMessage = {
        id: `temp-${Date.now()}`,
        role: "user",
        content: message,
        ts: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);

      // Add to conversation history
      conversationRef.current.push({ role: "user", content: message });

      // Create placeholder for streaming assistant response
      const assistantId = `temp-${Date.now()}-a`;
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        ts: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
      setIsLoading(true);

      try {
        const stream = client.chatCompletionsStream({
          messages: conversationRef.current,
        });

        let fullContent = "";

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          if (delta?.content) {
            fullContent += delta.content;
            // Update the streaming message in-place
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, content: fullContent } : m
              )
            );
          }
        }

        // Add completed response to conversation history
        conversationRef.current.push({ role: "assistant", content: fullContent });

        // Refresh session list (server may have created a new session)
        refetchSessions();
      } catch (e) {
        // Replace the streaming placeholder with an error
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: `Error: ${(e as Error).message}` }
              : m
          )
        );
      } finally {
        setIsLoading(false);
      }
    },
    [client, refetchSessions]
  );

  // Delete a session — clear messages if active
  const deleteSession = useCallback(
    async (id: string) => {
      try {
        await sdkDeleteSession(id);
        if (sessionId === id) {
          setMessages([]);
          conversationRef.current = [];
        }
      } catch {
        // silent
      }
    },
    [sdkDeleteSession, sessionId]
  );

  const clear = useCallback(() => {
    setMessages([]);
    setSessionId(null);
    conversationRef.current = [];
  }, [setSessionId]);

  return {
    messages,
    isLoading,
    sessionId,
    sessions,
    sessionsLoading,
    send,
    clear,
    loadSession,
    newSession,
    deleteSession,
  };
}

// ── useProjectInfo ──

export function useProjectInfo() {
  const { client } = usePolpo();
  const [info, setInfo] = useState<{ project: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    client
      .getState()
      .then((state) => {
        if (!cancelled && state.project) {
          setInfo({ project: state.project });
        }
      })
      .catch(() => {
        // silent
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client]);

  return { info, loading };
}
