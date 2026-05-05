/**
 * Custom hooks that complement the @polpo-ai/react.
 *
 * The SDK provides: useTasks, useTask, useMissions, useMission, useAgents,
 * useProcesses, useEvents, useStats, useMemory, useLogs, usePolpo,
 * useSessions.
 *
 * This file provides hooks the SDK doesn't cover:
 * - useChat — session-aware chat with streaming via /v1/chat/completions
 * - useProjectInfo — fetches project name from orchestrator state
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { usePolpo, useSessions } from "@polpo-ai/react";
import type { ChatMessage, ChatCompletionMessage, PolpoConfig } from "@polpo-ai/react";
import type { ChatCompletionStream } from "@polpo-ai/react";
import { config as appConfig } from "@/lib/config";
import { setAppearanceScope } from "@/lib/appearance";

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

// Local mirror of SDK mission preview types
export interface MissionPreviewData {
  name: string;
  data: unknown;
  prompt?: string;
}

export type MissionPreviewAction = "execute" | "draft" | "refine" | "cancel";

// Local mirror of SDK vault preview types
export interface VaultPreviewData {
  agent: string;
  service: string;
  type: "smtp" | "imap" | "oauth" | "api_key" | "login" | "custom";
  label?: string;
  credentials: Record<string, string>;
}

export type VaultPreviewAction = "confirm" | "cancel";

// Client-side tool types
export interface OpenFileData {
  path: string;
}

export interface NavigateToData {
  target: string;
  id?: string;
  name?: string;
  path?: string;
  highlight?: string;
}

export interface OpenTabData {
  url: string;
  label?: string;
}

export interface DesignThemeData {
  primary?: string;
  secondary?: string;
  text?: string;
  radius?: number;
  fontFamily?: string;
}

export interface SetDesignData extends DesignThemeData {
  enabled?: boolean;
  light?: DesignThemeData;
  dark?: DesignThemeData;
}

// Local mirror of SDK tool call types
export type ToolCallState = "preparing" | "calling" | "completed" | "error" | "interrupted";

export interface ToolCallInfo {
  id: string;
  name: string;
  argumentsText?: string;
  arguments?: Record<string, unknown>;
  result?: string;
  state: ToolCallState;
}

/** Ordered segment — text, model thinking, or a tool invocation */
export type MessageSegment =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool"; tool: ToolCallInfo };

/** A chat message enriched with optional ask_user questions, tool calls, mission preview, vault preview, and client-side actions */
export interface ChatMessageWithQuestions extends ChatMessage {
  askUserQuestions?: AskUserQuestion[];
  missionPreview?: MissionPreviewData;
  vaultPreview?: VaultPreviewData;
  openFile?: OpenFileData;
  navigateTo?: NavigateToData;
  openTab?: OpenTabData;
  setDesign?: SetDesignData;
  toolCalls?: ToolCallInfo[];
  thinkingText?: string;
  /** Chronologically ordered segments (text interleaved with tool calls) */
  segments?: MessageSegment[];
}

// ── useChat (session-aware + streaming) ──
// Builds on the SDK's useSessions hook for session management,
// uses chatCompletionsStream() for real-time streaming responses.

const NEW_SESSION_KEY_PREFIX = "__polpo_new_session__";

const createLocalNewSessionKey = () =>
  `${NEW_SESSION_KEY_PREFIX}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

const isLocalNewSessionKey = (key: string) =>
  key === NEW_SESSION_KEY_PREFIX || key.startsWith(`${NEW_SESSION_KEY_PREFIX}:`);

interface SessionPendingState {
  questions: AskUserQuestion[] | null;
  mission: MissionPreviewData | null;
  vault: VaultPreviewData | null;
  openFile: OpenFileData | null;
  navigateTo: NavigateToData | null;
  openTab: OpenTabData | null;
  setDesign: SetDesignData | null;
}

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

  const [messagesBySession, setMessagesBySession] = useState<Record<string, ChatMessageWithQuestions[]>>({});
  const [streamingBySession, setStreamingBySession] = useState<Record<string, boolean>>({});
  const [pendingBySession, setPendingBySession] = useState<Record<string, SessionPendingState>>({});
  /** True while loading messages for an existing session (distinguishes from empty "new chat" state) */
  const [messagesLoading, setMessagesLoading] = useState(false);
  /** Selected agent for agent-direct chat mode. null = orchestrator (default). */
  const [selectedAgent, setSelectedAgentState] = useState<string | null>(null);
  const selectedAgentRef = useRef<string | null>(null);
  const initialLoadDone = useRef(false);
  const [localNewSessionKey, setLocalNewSessionKey] = useState(createLocalNewSessionKey);
  const activeSessionKey = sessionId ?? localNewSessionKey;
  const activeSessionKeyRef = useRef(activeSessionKey);
  /** Conversation history sent to the completions endpoint, keyed by session. */
  const conversationBySessionRef = useRef<Map<string, ChatCompletionMessage[]>>(new Map());
  /** Active client streams, keyed by session. */
  const streamsBySessionRef = useRef<Map<string, ChatCompletionStream>>(new Map());
  /** True when the user explicitly requested a new session — consumed on first send */
  const wantsNewSessionRef = useRef(false);
  /** Active turn IDs, keyed by session, used by stop() to abort server-side. */
  const turnIdsBySessionRef = useRef<Map<string, string>>(new Map());
  /** Abort controllers for in-flight resume SSE streams, keyed by session. */
  const resumeAbortBySessionRef = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    activeSessionKeyRef.current = activeSessionKey;
  }, [activeSessionKey]);

  const setSelectedAgent = useCallback((agent: string | null) => {
    selectedAgentRef.current = agent;
    setSelectedAgentState(agent);
  }, []);

  const messages = messagesBySession[activeSessionKey] ?? [];
  const isLoading = streamingBySession[activeSessionKey] ?? false;
  const pendingState = pendingBySession[activeSessionKey];
  const pendingQuestions = pendingState?.questions ?? null;
  const pendingMission = pendingState?.mission ?? null;
  const pendingVault = pendingState?.vault ?? null;
  const pendingOpenFile = pendingState?.openFile ?? null;
  const pendingNavigateTo = pendingState?.navigateTo ?? null;
  const pendingOpenTab = pendingState?.openTab ?? null;
  const pendingSetDesign = pendingState?.setDesign ?? null;
  const streamingSessionIds = Object.entries(streamingBySession)
    .filter(([key, active]) => active && !isLocalNewSessionKey(key))
    .map(([key]) => key);

  const updateSessionMessages = useCallback((
    key: string,
    updater: ChatMessageWithQuestions[] | ((prev: ChatMessageWithQuestions[]) => ChatMessageWithQuestions[]),
  ) => {
    setMessagesBySession((prev) => {
      const current = prev[key] ?? [];
      const next = typeof updater === "function" ? updater(current) : updater;
      return { ...prev, [key]: next };
    });
  }, []);

  const setActiveMessages = useCallback((
    updater: ChatMessageWithQuestions[] | ((prev: ChatMessageWithQuestions[]) => ChatMessageWithQuestions[]),
  ) => updateSessionMessages(activeSessionKeyRef.current, updater), [updateSessionMessages]);

  const setSessionStreaming = useCallback((key: string, active: boolean) => {
    setStreamingBySession((prev) => {
      if ((prev[key] ?? false) === active) return prev;
      return { ...prev, [key]: active };
    });
  }, []);

  const setSessionPending = useCallback((key: string, patch: Partial<SessionPendingState>) => {
    setPendingBySession((prev) => {
      const current = prev[key] ?? {
        questions: null,
        mission: null,
        vault: null,
        openFile: null,
        navigateTo: null,
        openTab: null,
        setDesign: null,
      };
      return {
        ...prev,
        [key]: {
          ...current,
          ...patch,
        },
      };
    });
  }, []);

  const clearSessionPending = useCallback((key: string) => {
    setSessionPending(key, {
      questions: null,
      mission: null,
      vault: null,
      openFile: null,
      navigateTo: null,
      openTab: null,
      setDesign: null,
    });
  }, [setSessionPending]);

  const setConversation = useCallback((key: string, conversation: ChatCompletionMessage[]) => {
    conversationBySessionRef.current.set(key, conversation);
  }, []);

  const appendConversation = useCallback((key: string, message: ChatCompletionMessage) => {
    const current = conversationBySessionRef.current.get(key) ?? [];
    conversationBySessionRef.current.set(key, [...current, message]);
  }, []);

  const migrateSessionKey = useCallback((fromKey: string, toKey: string) => {
    if (fromKey === toKey) return;

    setMessagesBySession((prev) => {
      const fromMessages = prev[fromKey];
      if (!fromMessages) return prev;
      const next = { ...prev, [toKey]: fromMessages };
      delete next[fromKey];
      return next;
    });
    setStreamingBySession((prev) => {
      if (!(fromKey in prev)) return prev;
      const next = { ...prev, [toKey]: prev[fromKey] };
      delete next[fromKey];
      return next;
    });
    setPendingBySession((prev) => {
      const fromPending = prev[fromKey];
      if (!fromPending) return prev;
      const next = { ...prev, [toKey]: fromPending };
      delete next[fromKey];
      return next;
    });

    const conversation = conversationBySessionRef.current.get(fromKey);
    if (conversation) {
      conversationBySessionRef.current.set(toKey, conversation);
      conversationBySessionRef.current.delete(fromKey);
    }
    const stream = streamsBySessionRef.current.get(fromKey);
    if (stream) {
      streamsBySessionRef.current.set(toKey, stream);
      streamsBySessionRef.current.delete(fromKey);
    }
    const turnId = turnIdsBySessionRef.current.get(fromKey);
    if (turnId) {
      turnIdsBySessionRef.current.set(toKey, turnId);
      turnIdsBySessionRef.current.delete(fromKey);
    }
    const resumeAbort = resumeAbortBySessionRef.current.get(fromKey);
    if (resumeAbort) {
      resumeAbortBySessionRef.current.set(toKey, resumeAbort);
      resumeAbortBySessionRef.current.delete(fromKey);
    }
  }, []);

  const resetToLocalNewSession = useCallback((opts?: { selectedAgent?: string | null }) => {
    const nextKey = createLocalNewSessionKey();
    activeSessionKeyRef.current = nextKey;
    wantsNewSessionRef.current = true;
    setLocalNewSessionKey(nextKey);
    setSessionId(null);
    updateSessionMessages(nextKey, []);
    clearSessionPending(nextKey);
    setSelectedAgent(opts?.selectedAgent ?? null);
    conversationBySessionRef.current.delete(nextKey);
  }, [clearSessionPending, setSelectedAgent, setSessionId, updateSessionMessages]);

  // Reconstruct interactive state from persisted "interrupted" tool calls on the last assistant message.
    // If the last message is an assistant with an interrupted interactive tool, restore the pending state.
  const restoreInteractiveState = useCallback((msgs: ChatMessageWithQuestions[], key: string) => {
    if (msgs.length === 0) return;
    const lastMsg = msgs[msgs.length - 1];
    // Only restore if the last message is from the assistant (no user reply yet)
    if (lastMsg.role !== "assistant" || !lastMsg.toolCalls) return;

    for (const tc of lastMsg.toolCalls) {
      if (tc.state !== "interrupted") continue;

      if (tc.name === "ask_user" && tc.arguments) {
        const questions = (tc.arguments as any)?.questions as AskUserQuestion[] ?? [];
        if (questions.length > 0) {
          lastMsg.askUserQuestions = questions;
          setSessionPending(key, { questions });
        }
      } else if (tc.name === "create_mission" && tc.arguments) {
        const args = tc.arguments as Record<string, unknown>;
        let missionData: unknown;
        try { missionData = typeof args.data === "string" ? JSON.parse(args.data) : args.data; } catch { missionData = args.data; }
        const preview: MissionPreviewData = {
          name: (args.name as string) ?? "Mission",
          data: missionData,
          prompt: args.prompt as string | undefined,
        };
        lastMsg.missionPreview = preview;
        setSessionPending(key, { mission: preview });
      } else if (tc.name === "set_vault_entry" && tc.arguments) {
        const args = tc.arguments as Record<string, unknown>;
        const vaultPreview: VaultPreviewData = {
          agent: (args.agent as string) ?? "",
          service: (args.service as string) ?? "",
          type: (args.type as VaultPreviewData["type"]) ?? "custom",
          label: args.label as string | undefined,
          credentials: (args.credentials as Record<string, string>) ?? {},
        };
        lastMsg.vaultPreview = vaultPreview;
        setSessionPending(key, { vault: vaultPreview });
      // NOTE: open_file, navigate_to, open_tab are one-shot navigation actions.
      // They must NOT be restored as pending because:
      // 1. They were already consumed when originally fired (navigate + streamCompletion).
      // 2. Restoring them triggers the useEffect in ChatPage → consume* → new
      //    streamCompletion, creating an infinite loop on every visibility change
      //    or session reload.
      // Only interactive prompts (ask_user, create_mission, set_vault_entry, set_design) that
      // require explicit user input should be restored.
      } else if (tc.name === "open_file" && tc.arguments) {
        const args = tc.arguments as Record<string, unknown>;
        lastMsg.openFile = { path: (args.path as string) ?? "" };
      } else if (tc.name === "navigate_to" && tc.arguments) {
        const args = tc.arguments as Record<string, unknown>;
        lastMsg.navigateTo = {
          target: (args.target as string) ?? "dashboard",
          id: args.id as string | undefined,
          name: args.name as string | undefined,
          path: args.path as string | undefined,
          highlight: args.highlight as string | undefined,
        };
      } else if (tc.name === "open_tab" && tc.arguments) {
        // Display-only — do NOT set pending state (one-shot action)
        const args = tc.arguments as Record<string, unknown>;
        lastMsg.openTab = {
          url: (args.url as string) ?? "",
          label: args.label as string | undefined,
        };
      } else if (tc.name === "set_design" && tc.arguments) {
        const args = tc.arguments as Record<string, unknown>;
        const setDesign: SetDesignData = {
          enabled: args.enabled as boolean | undefined,
          light: args.light as DesignThemeData | undefined,
          dark: args.dark as DesignThemeData | undefined,
          primary: args.primary as string | undefined,
          secondary: args.secondary as string | undefined,
          text: args.text as string | undefined,
          radius: args.radius as number | undefined,
          fontFamily: args.fontFamily as string | undefined,
        };
        lastMsg.setDesign = setDesign;
        setSessionPending(key, { setDesign });
      }
    }
  }, [setSessionPending]);

  // Reconstruct segments from persisted toolCalls + text content.
  // Since we can't know exact interleaving, show tool calls before text.
  const reconstructSegments = (msg: ChatMessageWithQuestions): MessageSegment[] | undefined => {
    if (msg.role !== "assistant" || (!msg.toolCalls?.length && !msg.thinkingText)) return undefined;
    const segments: MessageSegment[] = [];
    if (msg.thinkingText) {
      segments.push({ type: "thinking", content: msg.thinkingText });
    }
    for (const tc of msg.toolCalls ?? []) {
      segments.push({ type: "tool", tool: tc });
    }
    if (msg.content.trim()) {
      segments.push({ type: "text", content: msg.content });
    }
    return segments;
  };

  const toUiMessages = useCallback((raw: ChatMessage[]): ChatMessageWithQuestions[] => raw
    .filter((m) => m.content.trim().length > 0)
    .map((m) => {
      const enriched: ChatMessageWithQuestions = { ...m };
      const serverMsg = m as ChatMessageWithQuestions;
      if (serverMsg.toolCalls && serverMsg.toolCalls.length > 0) {
        enriched.toolCalls = serverMsg.toolCalls;
        enriched.segments = reconstructSegments(enriched);
      }
      return enriched;
    }), []);

  const conversationFromMessages = useCallback((msgs: ChatMessageWithQuestions[]): ChatCompletionMessage[] => msgs.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  })), []);

  const applyServerMessages = useCallback((key: string, raw: ChatMessage[]) => {
    const msgs = toUiMessages(raw);
    clearSessionPending(key);
    restoreInteractiveState(msgs, key);
    updateSessionMessages(key, msgs);
    setConversation(key, conversationFromMessages(msgs));
    return msgs;
  }, [clearSessionPending, conversationFromMessages, restoreInteractiveState, setConversation, toUiMessages, updateSessionMessages]);

  /**
   * Re-attach to an in-flight server-side turn. Replays buffered deltas
   * accumulated server-side while the client was disconnected, then tails
   * live deltas until the turn completes.
   *
   * UI-wise: writes everything into `assistantId` (a placeholder pushed by
   * the caller). On finish, refetches messages from the server (the source
   * of truth — picks up the persisted message with full toolCalls etc.).
   */
  const runResume = useCallback(async (turnId: string, assistantId: string, sid: string) => {
    const base = appConfig.baseUrl || "";
    const headers: Record<string, string> = {};
    if (appConfig.apiKey) headers["Authorization"] = `Bearer ${appConfig.apiKey}`;
    const ac = new AbortController();
    resumeAbortBySessionRef.current.set(sid, ac);
    turnIdsBySessionRef.current.set(sid, turnId);
    setSessionStreaming(sid, true);

    let fullContent = "";
    let thinkingText = "";
    const toolCalls: ToolCallInfo[] = [];
    const segments: MessageSegment[] = [];
    let currentTextIdx = -1;
    let currentThinkingIdx = -1;

    const messagePatch = () => ({
      content: fullContent,
      thinkingText: thinkingText || undefined,
      toolCalls: toolCalls.length > 0 ? [...toolCalls] : undefined,
      segments: [...segments],
    });

    const updateMsg = () => {
      updateSessionMessages(sid, (prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, ...messagePatch() }
            : m
        )
      );
    };

    try {
      const res = await fetch(`${base}/v1/chat/completions/resume/${turnId}`, {
        method: "GET",
        headers,
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Resume failed: ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      readLoop: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") break readLoop;
          let chunk: any;
          try { chunk = JSON.parse(data); } catch { continue; }
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          const thinking = choice?.thinking as string | undefined;
          if (thinking) {
            thinkingText += thinking;
            if (currentThinkingIdx >= 0 && segments[currentThinkingIdx]?.type === "thinking") {
              (segments[currentThinkingIdx] as { type: "thinking"; content: string }).content += thinking;
            } else {
              segments.push({ type: "thinking", content: thinking });
              currentThinkingIdx = segments.length - 1;
            }
            currentTextIdx = -1;
            updateMsg();
          }
          if (delta?.content) {
            fullContent += delta.content;
            if (currentTextIdx >= 0 && segments[currentTextIdx]?.type === "text") {
              (segments[currentTextIdx] as { type: "text"; content: string }).content += delta.content;
            } else {
              segments.push({ type: "text", content: delta.content });
              currentTextIdx = segments.length - 1;
            }
            currentThinkingIdx = -1;
            updateMsg();
          }
          const tc = choice?.tool_call as ToolCallInfo | undefined;
          if (tc) {
            const existing = toolCalls.find((t) => t.id === tc.id);
            if (existing) {
              existing.state = tc.state;
              if (tc.argumentsText !== undefined) existing.argumentsText = tc.argumentsText;
              if (tc.arguments !== undefined) existing.arguments = tc.arguments;
              if (tc.result !== undefined) existing.result = tc.result;
              const segIdx = segments.findIndex((s) => s.type === "tool" && s.tool.id === tc.id);
              if (segIdx >= 0) {
                (segments[segIdx] as { type: "tool"; tool: ToolCallInfo }).tool = { ...existing };
              }
            } else {
              const info = { ...tc };
              toolCalls.push(info);
              segments.push({ type: "tool", tool: info });
              currentTextIdx = -1;
              currentThinkingIdx = -1;
            }
            updateMsg();
          }
        }
      }

      // Refetch from server — picks up the canonical persisted message
      // (the server may have appended tool calls or a final stop frame
      // we missed if we joined late).
      try {
        const raw = await getMessages(sid);
        applyServerMessages(sid, raw);
      } catch { /* ignore — keep what we streamed */ }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.warn("[resume] failed:", err);
      }
    } finally {
      setSessionStreaming(sid, false);
      turnIdsBySessionRef.current.delete(sid);
      resumeAbortBySessionRef.current.delete(sid);
    }
  }, [applyServerMessages, getMessages, setSessionStreaming, updateSessionMessages]);

  // Load a specific session's messages
  const loadSession = useCallback(
    async (id: string) => {
      activeSessionKeyRef.current = id;
      wantsNewSessionRef.current = false;
      setSessionId(id);
      setMessagesLoading(true);
      clearSessionPending(id);
      // Restore agent scope from the loaded session
      const session = sessions.find((s) => s.id === id);
      setSelectedAgent(session?.agent ?? null);

      if (streamsBySessionRef.current.has(id) || resumeAbortBySessionRef.current.has(id)) {
        setMessagesLoading(false);
        return;
      }

      try {
        const raw = await getMessages(id);
        const msgs = applyServerMessages(id, raw);

        // Resume detection: if the server has an in-flight turn for this
        // session (because the previous client disconnected), reattach to
        // the buffered stream and tail it live.
        try {
          const base = appConfig.baseUrl || "";
          const headers: Record<string, string> = {};
          if (appConfig.apiKey) headers["Authorization"] = `Bearer ${appConfig.apiKey}`;
          const r = await fetch(`${base}/v1/chat/completions/active-turn?sessionId=${encodeURIComponent(id)}`, { headers });
          if (r.ok) {
            const j = await r.json() as { ok: boolean; data?: { turnId: string | null } };
            if (j.ok && j.data?.turnId) {
              // Append a placeholder for the in-progress assistant turn and
              // start replaying. The trailing assistant message in `msgs`
              // (if any) is the partial placeholder reserved server-side —
              // we reuse its id when present, otherwise allocate a temp.
              const trailing = msgs.length > 0 && msgs[msgs.length - 1].role === "assistant"
                ? msgs[msgs.length - 1]
                : null;
              const assistantId = trailing?.id ?? `temp-${Date.now()}-resume`;
              if (!trailing) {
                updateSessionMessages(id, (prev) => [
                  ...prev,
                  { id: assistantId, role: "assistant", content: "", ts: new Date().toISOString() },
                ]);
              }
              // fire-and-forget — runResume manages its own loading state
              void runResume(j.data.turnId, assistantId, id);
            }
          }
        } catch { /* offline or endpoint missing — silent */ }
      } catch {
        updateSessionMessages(id, []);
        conversationBySessionRef.current.delete(id);
      } finally {
        setMessagesLoading(false);
      }
    },
    [applyServerMessages, clearSessionPending, getMessages, runResume, sessions, setSelectedAgent, setSessionId, updateSessionMessages]
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
      // Don't clobber an in-flight stream — local state is fresher than the server snapshot.
      if (streamsBySessionRef.current.has(activeSessionKeyRef.current) || resumeAbortBySessionRef.current.has(activeSessionKeyRef.current)) return;
      if (sessionId) {
        getMessages(sessionId)
          .then((raw) => { applyServerMessages(sessionId, raw); })
          .catch(() => { /* silent */ });
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [applyServerMessages, sessionId, getMessages, refetchSessions]);

  // Start a new empty session
  const newSession = useCallback(() => {
    resetToLocalNewSession();
  }, [resetToLocalNewSession]);

  // Core streaming function (shared between send and answerQuestions)
  const streamCompletion = useCallback(
    async (assistantId: string, options: { sessionKey: string; requestSessionId?: string; agent?: string | null }) => {
      let streamSessionKey = options.sessionKey;
      const stream = client.chatCompletionsStream({
        messages: conversationBySessionRef.current.get(streamSessionKey) ?? [],
        sessionId: options.requestSessionId,
        ...(options.agent ? { agent: options.agent } : {}),
      });
      streamsBySessionRef.current.set(streamSessionKey, stream);
      setSessionStreaming(streamSessionKey, true);
      // turnId is populated by the SDK after the first network exchange — refresh
      // it on every chunk loop iteration. Used by stop() and by other tabs that
      // want to abort this turn from elsewhere.
      turnIdsBySessionRef.current.delete(streamSessionKey);

      let fullContent = "";
      let thinkingText = "";
      const toolCalls: ToolCallInfo[] = [];
      // Chronologically ordered segments for interleaved rendering
      const segments: MessageSegment[] = [];
      // Track index of the current text segment (if last segment is text, append to it)
      let currentTextIdx = -1;
      let currentThinkingIdx = -1;

      const messagePatch = () => ({
        content: fullContent,
        thinkingText: thinkingText || undefined,
        toolCalls: toolCalls.length > 0 ? [...toolCalls] : undefined,
        segments: [...segments],
      });

      const updateMsg = () => {
        updateSessionMessages(streamSessionKey, (prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, ...messagePatch() }
              : m
          )
        );
      };

      const syncServerIds = () => {
        const nextSessionId = stream.sessionId;
        if (nextSessionId && nextSessionId !== streamSessionKey) {
          const wasActive = activeSessionKeyRef.current === streamSessionKey;
          migrateSessionKey(streamSessionKey, nextSessionId);
          streamSessionKey = nextSessionId;
          if (wasActive) {
            setSessionId(nextSessionId);
          }
        }
        if (stream.turnId) {
          turnIdsBySessionRef.current.set(streamSessionKey, stream.turnId);
        }
      };

      for await (const chunk of stream) {
        syncServerIds();
        const choice = chunk.choices[0];
        const delta = choice?.delta;
        const thinking = choice?.thinking as string | undefined;

        if (thinking) {
          thinkingText += thinking;
          if (currentThinkingIdx >= 0 && segments[currentThinkingIdx]?.type === "thinking") {
            (segments[currentThinkingIdx] as { type: "thinking"; content: string }).content += thinking;
          } else {
            segments.push({ type: "thinking", content: thinking });
            currentThinkingIdx = segments.length - 1;
          }
          currentTextIdx = -1;
          updateMsg();
        }

        // Text content — append to current text segment or create a new one
        if (delta?.content) {
          fullContent += delta.content;
          if (currentTextIdx >= 0 && segments[currentTextIdx]?.type === "text") {
            (segments[currentTextIdx] as { type: "text"; content: string }).content += delta.content;
          } else {
            segments.push({ type: "text", content: delta.content });
            currentTextIdx = segments.length - 1;
          }
          currentThinkingIdx = -1;
          updateMsg();
        }

        // Tool call events — insert/update tool segment
        const tc = (choice as any)?.tool_call as ToolCallInfo | undefined;
        if (tc) {
          const existing = toolCalls.find((t) => t.id === tc.id);
            if (existing) {
              // Update existing tool call (preparing → calling → completed/error)
              existing.state = tc.state;
              if (tc.argumentsText !== undefined) existing.argumentsText = tc.argumentsText;
              if (tc.arguments !== undefined) existing.arguments = tc.arguments;
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
            currentThinkingIdx = -1;
          }
          updateMsg();
        }
      }

      syncServerIds();

      // Check if the LLM is asking questions
      if (stream.askUser && stream.askUser.questions.length > 0) {
        updateSessionMessages(streamSessionKey, (prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, ...messagePatch(), askUserQuestions: stream.askUser!.questions }
            : m
          )
        );
        setSessionPending(streamSessionKey, { questions: stream.askUser.questions, mission: null, vault: null, openFile: null, navigateTo: null, openTab: null, setDesign: null });
        appendConversation(streamSessionKey, { role: "assistant", content: fullContent });
      } else if (stream.missionPreview) {
        // Mission preview — show interactive card for user to Execute/Draft/Refine/Cancel
        const preview: MissionPreviewData = {
          name: stream.missionPreview.name,
          data: stream.missionPreview.data,
          prompt: stream.missionPreview.prompt ?? undefined,
        };
        updateSessionMessages(streamSessionKey, (prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, ...messagePatch(), missionPreview: preview }
            : m
          )
        );
        setSessionPending(streamSessionKey, { mission: preview, questions: null, vault: null, openFile: null, navigateTo: null, openTab: null, setDesign: null });
        appendConversation(streamSessionKey, { role: "assistant", content: fullContent });
      } else if (stream.vaultPreview) {
        // Vault preview — show interactive card for user to Confirm/Cancel
        const vaultData: VaultPreviewData = {
          agent: stream.vaultPreview.agent,
          service: stream.vaultPreview.service,
          type: stream.vaultPreview.type,
          label: stream.vaultPreview.label ?? undefined,
          credentials: stream.vaultPreview.credentials,
        };
        updateSessionMessages(streamSessionKey, (prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, ...messagePatch(), vaultPreview: vaultData }
            : m
          )
        );
        setSessionPending(streamSessionKey, { vault: vaultData, questions: null, mission: null, openFile: null, navigateTo: null, openTab: null, setDesign: null });
        appendConversation(streamSessionKey, { role: "assistant", content: fullContent });
      } else if ((stream as any).openFile) {
        // Client-side open_file — open file preview dialog
        const of = (stream as any).openFile;
        const openFileData: OpenFileData = {
          path: of.path,
        };
        updateSessionMessages(streamSessionKey, (prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, ...messagePatch(), openFile: openFileData }
            : m
          )
        );
        setSessionPending(streamSessionKey, { openFile: openFileData, questions: null, mission: null, vault: null, navigateTo: null, openTab: null, setDesign: null });
        appendConversation(streamSessionKey, { role: "assistant", content: fullContent });
      } else if ((stream as any).navigateTo) {
        // Client-side navigate_to — navigate the UI to a specific page
        const nav = (stream as any).navigateTo;
        const navData: NavigateToData = {
          target: nav.target,
          id: nav.id,
          name: nav.name,
          path: nav.path,
          highlight: nav.highlight,
        };
        updateSessionMessages(streamSessionKey, (prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, ...messagePatch(), navigateTo: navData }
            : m
          )
        );
        setSessionPending(streamSessionKey, { navigateTo: navData, questions: null, mission: null, vault: null, openFile: null, openTab: null, setDesign: null });
        appendConversation(streamSessionKey, { role: "assistant", content: fullContent });
      } else if ((stream as any).openTab) {
        // Client-side open_tab — open URL in new browser tab
        const tab = (stream as any).openTab;
        const openTabData: OpenTabData = {
          url: tab.url,
          label: tab.label,
        };
        updateSessionMessages(streamSessionKey, (prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, ...messagePatch(), openTab: openTabData }
            : m
          )
        );
        setSessionPending(streamSessionKey, { openTab: openTabData, questions: null, mission: null, vault: null, openFile: null, navigateTo: null, setDesign: null });
        appendConversation(streamSessionKey, { role: "assistant", content: fullContent });
      } else if ((stream as any).setDesign) {
        // Client-side set_design — show preview card and wait for user confirmation
        const design = (stream as any).setDesign;
        const setDesignData: SetDesignData = {
          enabled: design.enabled,
          light: design.light,
          dark: design.dark,
          primary: design.primary,
          secondary: design.secondary,
          text: design.text,
          radius: design.radius,
          fontFamily: design.fontFamily,
        };
        updateSessionMessages(streamSessionKey, (prev) => {
          let attached = false;
          const patched = prev.map((m) => {
            if (m.id !== assistantId) return m;
            attached = true;
            return { ...m, ...messagePatch(), setDesign: setDesignData };
          });

          if (attached) return patched;

          let lastAssistantIndex = -1;
          for (let index = patched.length - 1; index >= 0; index -= 1) {
            if (patched[index]?.role === "assistant") {
              lastAssistantIndex = index;
              break;
            }
          }
          if (lastAssistantIndex >= 0) {
            return patched.map((m, index) =>
              index === lastAssistantIndex
                ? { ...m, ...messagePatch(), setDesign: setDesignData }
                : m
            );
          }

          return [
            ...patched,
            {
              id: assistantId,
              role: "assistant",
              ts: new Date().toISOString(),
              ...messagePatch(),
              setDesign: setDesignData,
            },
          ];
        });
        setSessionPending(streamSessionKey, { setDesign: setDesignData, questions: null, mission: null, vault: null, openFile: null, navigateTo: null, openTab: null });
        appendConversation(streamSessionKey, { role: "assistant", content: fullContent });
      } else {
        clearSessionPending(streamSessionKey);
        appendConversation(streamSessionKey, { role: "assistant", content: fullContent });
      }

      streamsBySessionRef.current.delete(streamSessionKey);
      turnIdsBySessionRef.current.delete(streamSessionKey);
      setSessionStreaming(streamSessionKey, false);
      refetchSessions();
      return fullContent;
    },
    [appendConversation, clearSessionPending, client, migrateSessionKey, refetchSessions, setSessionId, setSessionPending, setSessionStreaming, updateSessionMessages]
  );

  const appendUserAndStream = useCallback(async (
    userContent: string,
    conversationContent: ChatCompletionMessage["content"] = userContent,
    opts?: { forceNew?: boolean },
  ) => {
    const sessionKey = activeSessionKeyRef.current;
    const requestSessionId = opts?.forceNew || isLocalNewSessionKey(sessionKey)
      ? "new"
      : sessionKey;
    const agent = selectedAgentRef.current;

    const userMsg: ChatMessageWithQuestions = {
      id: `temp-${Date.now()}`,
      role: "user",
      content: userContent,
      ts: new Date().toISOString(),
    };
    const assistantId = `temp-${Date.now()}-a`;
    updateSessionMessages(sessionKey, (prev) => [
      ...prev,
      userMsg,
      { id: assistantId, role: "assistant", content: "", ts: new Date().toISOString() },
    ]);
    appendConversation(sessionKey, { role: "user", content: conversationContent });

    try {
      await streamCompletion(assistantId, { sessionKey, requestSessionId, agent });
    } catch (e) {
      const stream = streamsBySessionRef.current.get(sessionKey);
      if (stream?.aborted) {
        streamsBySessionRef.current.delete(sessionKey);
      } else {
        updateSessionMessages(sessionKey, (prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: `Error: ${(e as Error).message}` }
              : m
          )
        );
      }
      setSessionStreaming(sessionKey, false);
    }
  }, [appendConversation, setSessionStreaming, streamCompletion, updateSessionMessages]);

  const appendSystemAndStream = useCallback(async (content: string) => {
    const sessionKey = activeSessionKeyRef.current;
    const requestSessionId = isLocalNewSessionKey(sessionKey) ? "new" : sessionKey;
    const agent = selectedAgentRef.current;
    const assistantId = `temp-${Date.now()}-a`;

    updateSessionMessages(sessionKey, (prev) => [
      ...prev,
      { id: assistantId, role: "assistant", content: "", ts: new Date().toISOString() },
    ]);
    appendConversation(sessionKey, { role: "system", content });

    try {
      await streamCompletion(assistantId, { sessionKey, requestSessionId, agent });
    } catch (e) {
      const stream = streamsBySessionRef.current.get(sessionKey);
      if (stream?.aborted) {
        streamsBySessionRef.current.delete(sessionKey);
      } else {
        updateSessionMessages(sessionKey, (prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: `Error: ${(e as Error).message}` }
              : m
          )
        );
      }
      setSessionStreaming(sessionKey, false);
    }
  }, [appendConversation, setSessionStreaming, streamCompletion, updateSessionMessages]);

  // Send a message (streaming). Optionally attach images (data URLs).
  const send = useCallback(
    async (message: string, images?: { url: string; mimeType: string }[]) => {
      const sessionKey = activeSessionKeyRef.current;
      clearSessionPending(sessionKey);

      // Build content: plain string or multimodal content parts
      const content: ChatCompletionMessage["content"] =
        images && images.length > 0
          ? [
              { type: "text" as const, text: message },
              ...images.map((img) => ({
                type: "image_url" as const,
                image_url: { url: img.url },
              })),
            ]
          : message;

      const forceNew = wantsNewSessionRef.current;
      wantsNewSessionRef.current = false;
      await appendUserAndStream(message, content, { forceNew });
    },
    [appendUserAndStream, clearSessionPending]
  );

  // Stop the current streaming response.
  //
  // Server-first abort: with resumable streams enabled, simply closing the
  // local SSE no longer cancels the LLM (the server keeps generating into
  // its buffer). So we POST to /abort/:turnId, then close the local stream.
  const stop = useCallback(() => {
    const key = activeSessionKeyRef.current;
    const turnId = turnIdsBySessionRef.current.get(key);
    const stream = streamsBySessionRef.current.get(key);
    const resumeAc = resumeAbortBySessionRef.current.get(key);

    if (turnId) {
      const base = appConfig.baseUrl || "";
      const headers: Record<string, string> = {};
      if (appConfig.apiKey) headers["Authorization"] = `Bearer ${appConfig.apiKey}`;
      // fire-and-forget — best effort
      void fetch(`${base}/v1/chat/completions/abort/${turnId}`, { method: "POST", headers })
        .catch(() => { /* server may already be done — ignore */ });
    }
    if (stream) {
      stream.abort();
      streamsBySessionRef.current.delete(key);
    }
    if (resumeAc) {
      resumeAc.abort();
      resumeAbortBySessionRef.current.delete(key);
    }
    turnIdsBySessionRef.current.delete(key);
    setSessionStreaming(key, false);
  }, [setSessionStreaming]);

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
        const value = parts.length > 0
          ? parts.join(" — ")
          : "Skipped — decide on your own based on best practices";
        return `${label}: ${value}`;
      });
      const answerText = answerLines.join("\n");

      setSessionPending(activeSessionKeyRef.current, { questions: null });
      await appendUserAndStream(answerText);
    },
    [appendUserAndStream, pendingQuestions, setSessionPending]
  );

  // Respond to a mission preview.
  // Execute/Draft call the REST API directly.
  // Refine sends feedback back to the LLM for re-planning.
  // Cancel just clears the state.
  const respondToMission = useCallback(
    async (action: MissionPreviewAction, feedback?: string): Promise<{ missionId?: string; error?: string }> => {
      if (!pendingMission) return {};

      const missionData = pendingMission.data as Record<string, unknown>;
      const dataStr = typeof missionData === "string" ? missionData : JSON.stringify(missionData);

      // Helper: send a user message to the orchestrator and stream the LLM response
      const sendAndStream = async (userContent: string): Promise<void> => {
        await appendUserAndStream(userContent);
      };

      // ── Execute: save as draft, execute, then inform orchestrator ──
      if (action === "execute") {
        setSessionPending(activeSessionKeyRef.current, { mission: null });
        try {
          const mission = await client.createMission({
            data: dataStr,
            name: pendingMission.name,
            prompt: pendingMission.prompt,
            status: "draft",
          });
          await client.executeMission(mission.id);
          // Continue conversational flow: tell the orchestrator what happened
          await sendAndStream(
            `I approved and executed the mission "${mission.name}" (ID: ${mission.id}). ` +
            `It's now running. Please acknowledge and let me know if there's anything else to do.`
          );
          return { missionId: mission.id };
        } catch (e) {
          const errMsg = (e as Error).message;
          const errorConfirm: ChatMessageWithQuestions = {
            id: `temp-${Date.now()}-err`,
            role: "assistant",
            content: `Failed to execute mission: ${errMsg}`,
            ts: new Date().toISOString(),
          };
          setActiveMessages((prev) => [...prev, errorConfirm]);
          return { error: errMsg };
        }
      }

      // ── Draft: save, then inform orchestrator ──
      if (action === "draft") {
        setSessionPending(activeSessionKeyRef.current, { mission: null });
        try {
          const mission = await client.createMission({
            data: dataStr,
            name: pendingMission.name,
            prompt: pendingMission.prompt,
            status: "draft",
          });
          // Continue conversational flow: tell the orchestrator what happened
          await sendAndStream(
            `I saved the mission "${mission.name}" (ID: ${mission.id}) as draft. ` +
            `Don't execute it yet — I might want to review or schedule it first.`
          );
          return { missionId: mission.id };
        } catch (e) {
          const errMsg = (e as Error).message;
          const errorConfirm: ChatMessageWithQuestions = {
            id: `temp-${Date.now()}-err`,
            role: "assistant",
            content: `Failed to save mission: ${errMsg}`,
            ts: new Date().toISOString(),
          };
          setActiveMessages((prev) => [...prev, errorConfirm]);
          return { error: errMsg };
        }
      }

      // ── Cancel: inform orchestrator ──
      if (action === "cancel") {
        setSessionPending(activeSessionKeyRef.current, { mission: null });
        await sendAndStream(
          `I decided not to proceed with the proposed mission "${pendingMission.name}". Let's move on.`
        );
        return {};
      }

      // ── Refine: send feedback back to the LLM for re-planning ──
      if (action === "refine" && feedback?.trim()) {
        setSessionPending(activeSessionKeyRef.current, { mission: null });
        await sendAndStream(`Please refine the mission plan with these changes:\n${feedback.trim()}`);
      }

      return {};
    },
    [appendUserAndStream, client, pendingMission, setActiveMessages, setSessionPending]
  );

  // Respond to a vault preview.
  // Confirm saves credentials directly via REST API (bypasses LLM entirely).
  // Cancel tells the LLM the user declined to save.
  //
  // SECURITY: Credentials NEVER flow back through the LLM or chat persistence.
  // The REST endpoint encrypts them at rest (AES-256-GCM) and returns only metadata.
  const respondToVault = useCallback(
    async (action: VaultPreviewAction, editedCredentials?: Record<string, string>) => {
      if (!pendingVault) return;

      setSessionPending(activeSessionKeyRef.current, { vault: null });

      if (action === "confirm") {
        const creds = editedCredentials ?? pendingVault.credentials;
        const credKeys = Object.keys(creds).join(", ");

        // Save directly via REST — credentials go to encrypted store, NOT to the LLM
        let saveError: string | undefined;
        try {
          await client.saveVaultEntry({
            agent: pendingVault.agent,
            service: pendingVault.service,
            type: pendingVault.type,
            label: pendingVault.label,
            credentials: creds,
          });
        } catch (e) {
          saveError = (e as Error).message;
        }

        // Tell the LLM the result — NO credentials in the message, only metadata
        const responseText = saveError
          ? `Failed to save vault entry "${pendingVault.service}" for agent "${pendingVault.agent}": ${saveError}`
          : `Vault entry "${pendingVault.service}" (${pendingVault.type}) saved for agent "${pendingVault.agent}". Credential fields: ${credKeys}`;

        await appendUserAndStream(responseText);
      } else {
        // Cancel — tell the LLM the user declined
        const cancelText = `Declined saving vault entry for "${pendingVault.service}" on agent "${pendingVault.agent}".`;
        await appendUserAndStream(cancelText);
      }
    },
    [appendUserAndStream, client, pendingVault, setSessionPending]
  );

  // Consume the preview_file pending state after the dialog is opened.
  // The dialog is opened by the page component; this resumes the LLM conversation.
  const consumeOpenFile = useCallback(() => {
    if (!pendingOpenFile) return;
    const data = pendingOpenFile;
    setSessionPending(activeSessionKeyRef.current, { openFile: null });

    void appendSystemAndStream(
      `Client-side tool open_file completed successfully for path "${data.path}". Do not call open_file again for this same request. Continue with the final answer.`,
    );
  }, [appendSystemAndStream, pendingOpenFile, setSessionPending]);

  // Consume navigate_to — build a human-readable description and resume conversation
  const consumeNavigateTo = useCallback(() => {
    if (!pendingNavigateTo) return;
    const data = pendingNavigateTo;
    setSessionPending(activeSessionKeyRef.current, { navigateTo: null });

    // Build a descriptive response
    let label = data.target;
    if (data.id) label += ` "${data.id}"`;
    if (data.name) label += ` "${data.name}"`;
    if (data.path) label += ` (${data.path})`;
    void appendSystemAndStream(
      `Client-side tool navigate_to completed successfully. Destination: ${label}. Do not call navigate_to again for this same request. Continue with the final answer.`,
    );
  }, [appendSystemAndStream, pendingNavigateTo, setSessionPending]);

  // Consume open_tab — open URL in new tab and resume conversation
  const consumeOpenTab = useCallback(() => {
    if (!pendingOpenTab) return;
    const data = pendingOpenTab;
    setSessionPending(activeSessionKeyRef.current, { openTab: null });

    const label = data.label ?? data.url;
    void appendSystemAndStream(
      `Client-side tool open_tab completed successfully. Opened: ${label}. Do not call open_tab again for this same request. Continue with the final answer.`,
    );
  }, [appendSystemAndStream, pendingOpenTab, setSessionPending]);

  // Consume set_design — the UI previews the design, then resumes after apply/cancel
  const consumeSetDesign = useCallback((result?: { applied: boolean; description: string }) => {
    if (!pendingSetDesign) return;
    setSessionPending(activeSessionKeyRef.current, { setDesign: null });

    const responseText = result?.applied
      ? `Design updated: ${result.description}.`
      : `Design update cancelled: ${result?.description ?? "not applied"}.`;
    void appendUserAndStream(responseText);
  }, [appendUserAndStream, pendingSetDesign, setSessionPending]);

  // Delete a session — clear messages if active
  const deleteSession = useCallback(
    async (id: string) => {
      try {
        await sdkDeleteSession(id);
        if (sessionId === id) {
          updateSessionMessages(id, []);
          conversationBySessionRef.current.delete(id);
          clearSessionPending(id);
        }
        streamsBySessionRef.current.get(id)?.abort();
        streamsBySessionRef.current.delete(id);
        resumeAbortBySessionRef.current.get(id)?.abort();
        resumeAbortBySessionRef.current.delete(id);
        turnIdsBySessionRef.current.delete(id);
        setSessionStreaming(id, false);
      } catch {
        // silent
      }
    },
    [clearSessionPending, sdkDeleteSession, sessionId, setSessionStreaming, updateSessionMessages]
  );

  const clear = useCallback(() => {
    updateSessionMessages(activeSessionKeyRef.current, []);
    clearSessionPending(activeSessionKeyRef.current);
    conversationBySessionRef.current.delete(activeSessionKeyRef.current);
    resetToLocalNewSession({ selectedAgent: selectedAgentRef.current });
  }, [clearSessionPending, resetToLocalNewSession, updateSessionMessages]);

  return {
    messages,
    isLoading,
    messagesLoading,
    sessionId,
    sessions,
    sessionsLoading,
    streamingSessionIds,
    pendingQuestions,
    pendingMission,
    pendingVault,
    pendingOpenFile,
    pendingNavigateTo,
    pendingOpenTab,
    pendingSetDesign,
    send,
    stop,
    answerQuestions,
    respondToMission,
    respondToVault,
    consumeOpenFile,
    consumeNavigateTo,
    consumeOpenTab,
    consumeSetDesign,
    clear,
    loadSession,
    newSession,
    deleteSession,
    selectedAgent,
    setSelectedAgent,
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

function inferProjectNameFromConfig(value: unknown): string | null {
  const config = value as {
    project?: unknown;
    teams?: Array<{
      name?: unknown;
      agents?: Array<{
        identity?: { company?: unknown };
      }>;
    }>;
  } | null | undefined;

  const project = typeof config?.project === "string" ? config.project.trim() : "";
  if (project) return project;

  for (const team of config?.teams ?? []) {
    for (const agent of team.agents ?? []) {
      const company = typeof agent.identity?.company === "string" ? agent.identity.company.trim() : "";
      if (company) return company;
    }
  }

  for (const team of config?.teams ?? []) {
    const teamName = typeof team.name === "string" ? team.name.trim() : "";
    if (teamName && teamName.toLowerCase() !== "default") return teamName;
  }

  return null;
}

export function useProjectInfo() {
  const { client } = usePolpo();
  const [info, setInfo] = useState<{ project: string; version?: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      client.getState().catch(() => null),
      client.getConfig().catch(() => null),
      client.getHealth().catch(() => null),
    ]).then(([state, config, health]) => {
      if (cancelled) return;
      const project = inferProjectNameFromConfig(state) ?? inferProjectNameFromConfig(config);
      if (project) {
        setAppearanceScope({ project });
        setInfo({ project, version: health?.version });
      }
    }).finally(() => {
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
  const initialLoadDone = useRef(false);

  const refetch = useCallback(async () => {
    // Only show full loading spinner on initial load, not on refetch
    if (!initialLoadDone.current) setIsLoading(true);
    setError(null);
    try {
      const cfg = await client.getConfig();
      setConfig(cfg);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsLoading(false);
      initialLoadDone.current = true;
    }
  }, [client]);

  /** Optimistically set config without fetching (avoids extra network round-trip). */
  const setOptimistic = useCallback((cfg: PolpoConfig) => {
    setConfig(cfg);
    setError(null);
  }, []);

  useEffect(() => { refetch(); }, [refetch]);

  return { config, isLoading, error, refetch, setOptimistic };
}
