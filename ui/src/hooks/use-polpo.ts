/**
 * Custom hooks that complement the @lumea-labs/polpo-react.
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
import { usePolpo, useSessions } from "@lumea-labs/polpo-react";
import type { ChatMessage, ChatCompletionMessage, PolpoConfig } from "@lumea-labs/polpo-react";

// Local mirror of SDK ask_user types (avoids build-order issues)
export interface AskUserOption {
  label: string;
  description?: string;
}

export interface AskUserQuestion {
  id: string;
  question: string;
  header?: string;
  options: AskUserOption[];
  multiple?: boolean;
  custom?: boolean;
}

export interface AskUserAnswer {
  questionId: string;
  selected: string[];
  customText?: string;
}

// Local mirror of SDK tool call types
export type ToolCallState = "calling" | "completed" | "error";

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  result?: string;
  state: ToolCallState;
}

/** Ordered segment — either a text chunk or a tool invocation */
export type MessageSegment =
  | { type: "text"; content: string }
  | { type: "tool"; tool: ToolCallInfo };

/** A chat message enriched with optional ask_user questions and tool calls */
export interface ChatMessageWithQuestions extends ChatMessage {
  askUserQuestions?: AskUserQuestion[];
  toolCalls?: ToolCallInfo[];
  /** Chronologically ordered segments (text interleaved with tool calls) */
  segments?: MessageSegment[];
}

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

  const [messages, setMessages] = useState<ChatMessageWithQuestions[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  /** Questions waiting for user response (null = no pending questions) */
  const [pendingQuestions, setPendingQuestions] = useState<AskUserQuestion[] | null>(null);
  const initialLoadDone = useRef(false);
  /** Conversation history sent to the completions endpoint */
  const conversationRef = useRef<ChatCompletionMessage[]>([]);

  // Reconstruct segments from persisted toolCalls + text content.
  // Since we can't know exact interleaving, show tool calls before text.
  const reconstructSegments = (msg: ChatMessageWithQuestions): MessageSegment[] | undefined => {
    if (msg.role !== "assistant" || !msg.toolCalls || msg.toolCalls.length === 0) return undefined;
    const segments: MessageSegment[] = [];
    for (const tc of msg.toolCalls) {
      segments.push({ type: "tool", tool: tc });
    }
    if (msg.content.trim()) {
      segments.push({ type: "text", content: msg.content });
    }
    return segments;
  };

  // Load a specific session's messages
  const loadSession = useCallback(
    async (id: string) => {
      setSessionId(id);
      setPendingQuestions(null);
      try {
        const raw = await getMessages(id);
        // Filter out empty placeholder messages (server saves them before streaming starts)
        const msgs: ChatMessageWithQuestions[] = raw
          .filter((m) => m.content.trim().length > 0)
          .map((m) => {
            const enriched: ChatMessageWithQuestions = { ...m };
            // Reconstruct toolCalls from server-persisted data (cast for SDK build-order safety)
            const serverMsg = m as ChatMessageWithQuestions;
            if (serverMsg.toolCalls && serverMsg.toolCalls.length > 0) {
              enriched.toolCalls = serverMsg.toolCalls;
              enriched.segments = reconstructSegments(enriched);
            }
            return enriched;
          });
        setMessages(msgs);
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

  // Auto-select most recent non-empty session on first load
  useEffect(() => {
    if (initialLoadDone.current || sessionsLoading) return;
    initialLoadDone.current = true;
    // Skip empty/orphan sessions (placeholder-only from failed streaming)
    const latest = sessions.find(
      (s) => s.messageCount > 1 || (s.messageCount === 1 && s.title),
    );
    if (latest) {
      loadSession(latest.id);
    }
  }, [sessions, sessionsLoading, loadSession]);

  // Re-fetch messages when the tab regains focus (server is source of truth)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      refetchSessions();
      if (sessionId) {
        getMessages(sessionId)
          .then((raw) => {
            const msgs: ChatMessageWithQuestions[] = raw
              .filter((m) => m.content.trim().length > 0)
              .map((m) => {
                const enriched: ChatMessageWithQuestions = { ...m };
                const serverMsg = m as ChatMessageWithQuestions;
                if (serverMsg.toolCalls && serverMsg.toolCalls.length > 0) {
                  enriched.toolCalls = serverMsg.toolCalls;
                  enriched.segments = reconstructSegments(enriched);
                }
                return enriched;
              });
            setMessages(msgs);
            conversationRef.current = msgs.map((m) => ({
              role: m.role as "user" | "assistant",
              content: m.content,
            }));
          })
          .catch(() => { /* silent */ });
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [sessionId, getMessages, refetchSessions]);

  // Start a new empty session
  const newSession = useCallback(() => {
    setSessionId(null);
    setMessages([]);
    setPendingQuestions(null);
    conversationRef.current = [];
  }, [setSessionId]);

  // Core streaming function (shared between send and answerQuestions)
  const streamCompletion = useCallback(
    async (assistantId: string) => {
      const stream = client.chatCompletionsStream({
        messages: conversationRef.current,
        sessionId: sessionId ?? undefined,
      });

      let fullContent = "";
      const toolCalls: ToolCallInfo[] = [];
      // Chronologically ordered segments for interleaved rendering
      const segments: MessageSegment[] = [];
      // Track index of the current text segment (if last segment is text, append to it)
      let currentTextIdx = -1;

      const updateMsg = () => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: fullContent, toolCalls: toolCalls.length > 0 ? [...toolCalls] : undefined, segments: [...segments] }
              : m
          )
        );
      };

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const delta = choice?.delta;

        // Text content — append to current text segment or create a new one
        if (delta?.content) {
          fullContent += delta.content;
          if (currentTextIdx >= 0 && segments[currentTextIdx]?.type === "text") {
            (segments[currentTextIdx] as { type: "text"; content: string }).content += delta.content;
          } else {
            segments.push({ type: "text", content: delta.content });
            currentTextIdx = segments.length - 1;
          }
          updateMsg();
        }

        // Tool call events — insert/update tool segment
        const tc = (choice as any)?.tool_call as ToolCallInfo | undefined;
        if (tc) {
          const existing = toolCalls.find((t) => t.id === tc.id);
          if (existing) {
            // Update existing tool call (calling → completed/error)
            existing.state = tc.state;
            if (tc.result !== undefined) existing.result = tc.result;
            // Also update the segment in-place
            const segIdx = segments.findIndex((s) => s.type === "tool" && s.tool.id === tc.id);
            if (segIdx >= 0) {
              (segments[segIdx] as { type: "tool"; tool: ToolCallInfo }).tool = { ...existing };
            }
          } else {
            // New tool call — push to flat list and add a new segment
            const info = { ...tc };
            toolCalls.push(info);
            segments.push({ type: "tool", tool: info });
            // Next text delta should start a new text segment
            currentTextIdx = -1;
          }
          updateMsg();
        }
      }

      // Capture session ID
      if (stream.sessionId && stream.sessionId !== sessionId) {
        setSessionId(stream.sessionId);
      }

      // Check if the LLM is asking questions
      if (stream.askUser && stream.askUser.questions.length > 0) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: fullContent, askUserQuestions: stream.askUser!.questions, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, segments: [...segments] }
              : m
          )
        );
        setPendingQuestions(stream.askUser.questions);
        conversationRef.current.push({ role: "assistant", content: fullContent });
      } else {
        setPendingQuestions(null);
        conversationRef.current.push({ role: "assistant", content: fullContent });
      }

      refetchSessions();
      return fullContent;
    },
    [client, sessionId, setSessionId, refetchSessions]
  );

  // Send a message (streaming)
  const send = useCallback(
    async (message: string) => {
      setPendingQuestions(null);

      // Optimistic user message
      const userMsg: ChatMessageWithQuestions = {
        id: `temp-${Date.now()}`,
        role: "user",
        content: message,
        ts: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);
      conversationRef.current.push({ role: "user", content: message });

      // Placeholder for streaming assistant response
      const assistantId = `temp-${Date.now()}-a`;
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "assistant", content: "", ts: new Date().toISOString() },
      ]);
      setIsLoading(true);

      try {
        await streamCompletion(assistantId);
      } catch (e) {
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
    [streamCompletion]
  );

  // Answer pending questions — formats answers as a user message and continues the conversation
  const answerQuestions = useCallback(
    async (answers: AskUserAnswer[]) => {
      if (!pendingQuestions) return;

      // Format answers as readable text for the conversation
      const answerLines = answers.map((a) => {
        const q = pendingQuestions.find((q) => q.id === a.questionId);
        const label = q?.header || q?.question || a.questionId;
        const parts: string[] = [];
        if (a.selected.length > 0) parts.push(a.selected.join(", "));
        if (a.customText) parts.push(a.customText);
        return `${label}: ${parts.join(" — ")}`;
      });
      const answerText = answerLines.join("\n");

      setPendingQuestions(null);

      // Add user answer as a visible message
      const userMsg: ChatMessageWithQuestions = {
        id: `temp-${Date.now()}`,
        role: "user",
        content: answerText,
        ts: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);
      conversationRef.current.push({ role: "user", content: answerText });

      // Placeholder for assistant continuation
      const assistantId = `temp-${Date.now()}-a`;
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "assistant", content: "", ts: new Date().toISOString() },
      ]);
      setIsLoading(true);

      try {
        await streamCompletion(assistantId);
      } catch (e) {
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
    [pendingQuestions, streamCompletion]
  );

  // Delete a session — clear messages if active
  const deleteSession = useCallback(
    async (id: string) => {
      try {
        await sdkDeleteSession(id);
        if (sessionId === id) {
          setMessages([]);
          conversationRef.current = [];
          setPendingQuestions(null);
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
    setPendingQuestions(null);
    conversationRef.current = [];
  }, [setSessionId]);

  return {
    messages,
    isLoading,
    sessionId,
    sessions,
    sessionsLoading,
    pendingQuestions,
    send,
    answerQuestions,
    clear,
    loadSession,
    newSession,
    deleteSession,
  };
}

// ── useAsyncAction ──
// Wraps an async callback with isPending state for button loading/disabled feedback.
// Prevents double-fires and tracks pending state for the UI.

export function useAsyncAction<T extends unknown[]>(
  fn: (...args: T) => Promise<void>,
): [(...args: T) => Promise<void>, boolean] {
  const [isPending, setIsPending] = useState(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const execute = useCallback(async (...args: T) => {
    if (isPending) return;
    setIsPending(true);
    try {
      await fnRef.current(...args);
    } finally {
      setIsPending(false);
    }
  }, [isPending]);

  return [execute, isPending];
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

// ── useConfig ──
// Fetches the full orchestrator config (read-only, redacted secrets).

export function useConfig() {
  const { client } = usePolpo();
  const [config, setConfig] = useState<PolpoConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(() => {
    setIsLoading(true);
    setError(null);
    client
      .getConfig()
      .then((cfg) => setConfig(cfg))
      .catch((e) => setError((e as Error).message))
      .finally(() => setIsLoading(false));
  }, [client]);

  useEffect(() => { fetch(); }, [fetch]);

  return { config, isLoading, error, refetch: fetch };
}
