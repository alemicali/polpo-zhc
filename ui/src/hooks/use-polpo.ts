/**
 * Custom hooks that complement the @openpolpo/react-sdk.
 *
 * The SDK provides: useTasks, useTask, usePlans, usePlan, useAgents,
 * useProcesses, useEvents, useStats, useMemory, useLogs, useOrchestra,
 * useSessions.
 *
 * This file provides hooks the SDK doesn't cover:
 * - useChat — session-aware chat with message history + calls client.chat()
 * - useProjectInfo — fetches project info (name, workDir) from the API
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { useOrchestra, useSessions, OrchestraClient } from "@openpolpo/react-sdk";
import type { ProjectInfo, ChatMessage } from "@openpolpo/react-sdk";
import { config } from "@/lib/config";

// ── useChat (session-aware) ──
// Builds on the SDK's useSessions hook for session management,
// adds message state + client.chat() for the messaging layer.

export function useChat() {
  const { client } = useOrchestra();
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

  // Auto-select most recent session on first load
  useEffect(() => {
    if (initialLoadDone.current || sessionsLoading) return;
    initialLoadDone.current = true;
    if (sessions.length > 0) {
      const latest = sessions[0]; // sorted by updatedAt desc from server
      loadSession(latest.id);
    }
  }, [sessions, sessionsLoading]);

  // Load a specific session's messages
  const loadSession = useCallback(
    async (id: string) => {
      setSessionId(id);
      try {
        const msgs = await getMessages(id);
        setMessages(msgs);
      } catch {
        setMessages([]);
      }
    },
    [setSessionId, getMessages]
  );

  // Start a new empty session
  const newSession = useCallback(() => {
    setSessionId(null);
    setMessages([]);
  }, [setSessionId]);

  // Send a message
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
      setIsLoading(true);
      try {
        const data = await client.chat(message, sessionId ?? undefined);
        const assistantMsg: ChatMessage = {
          id: `temp-${Date.now()}-a`,
          role: "assistant",
          content: data.response,
          ts: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, assistantMsg]);

        // Track session
        if (data.sessionId && data.sessionId !== sessionId) {
          setSessionId(data.sessionId);
          // Refresh session list (new session may have been created)
          refetchSessions();
        }
      } catch (e) {
        const errMsg: ChatMessage = {
          id: `temp-${Date.now()}-e`,
          role: "assistant",
          content: `Error: ${(e as Error).message}`,
          ts: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, errMsg]);
      } finally {
        setIsLoading(false);
      }
    },
    [client, sessionId, setSessionId, refetchSessions]
  );

  // Delete a session — clear messages if active
  const deleteSession = useCallback(
    async (id: string) => {
      try {
        await sdkDeleteSession(id);
        if (sessionId === id) {
          setMessages([]);
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
  const [info, setInfo] = useState<{
    project: string;
    workDir: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const projects = await OrchestraClient.listProjects(
          config.baseUrl,
          config.apiKey
        );
        if (!cancelled && projects.length > 0) {
          const proj =
            projects.find((p: ProjectInfo) => p.id === config.projectId) ??
            projects[0];
          setInfo({ project: proj.name, workDir: proj.workDir });
        }
      } catch {
        // silent
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return { info, loading };
}
