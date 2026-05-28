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

// Local mirror of SDK whatsapp / email preview types — approval gate
// for side-effect tools (whatsapp_send, whatsapp_send_file, email_send).
// Same lifecycle as MissionPreview: server emits the chunk, UI shows a
// card, user picks Send / Refine / Cancel. Send fires the matching REST
// endpoint; Refine sends feedback back to the LLM; Cancel just informs
// the LLM the user declined.
export interface WhatsAppPreviewData {
  /** "text" → POST /whatsapp/send. "file" → POST /whatsapp/send-file. */
  kind: "text" | "file";
  to: string;
  message?: string;
  path?: string;
  caption?: string;
  mediaKind?: string;
  mimeType?: string;
  fileName?: string;
  viewOnce?: boolean;
}

export interface EmailPreviewData {
  to: string | string[];
  subject: string;
  body: string;
  html?: boolean;
  cc?: string | string[];
  bcc?: string | string[];
  from?: string;
  reply_to?: string;
  attachments?: Array<{ path: string; filename?: string }>;
}

/** Send → REST API. Refine → user feedback → LLM. Cancel → informs LLM. */
export type SendPreviewAction = "send" | "refine" | "cancel";

// Local mirror of SDK widget render types — display-only intercept.
// Renders self-contained HTML inside a sandboxed iframe; the turn ends
// after the widget is shown. No user response is required (unlike
// mission/vault), the user just views it.
export interface WidgetRenderData {
  html: string;
  title?: string | null;
  description?: string | null;
  /** Show card chrome (border + header). Default true. False = full canvas. */
  chrome?: boolean;
  /** Opt-in: was the widget invoked with stream:true on the LLM tool call?
   *  Drives whether the UI shows a chunk-by-chunk live preview during
   *  generation. Default false (atomic render only). */
  stream?: boolean;
  /** True while THIS specific instance is a live partial (extracted from
   *  argumentsText mid-stream). Distinct from `stream` (the model's
   *  intent flag). UI uses this to show a "Live" badge and skip the
   *  auto-height shim during preview iterations. */
  streaming?: boolean;
}

// Tolerant extractor: pulls a `boolean` value of a top-level field
// from an in-progress JSON object string. Returns null if not found
// (i.e. field absent or value not yet streamed). Tollerante: rispetta
// whitespace, non distingue le quote (cerca solo "true" / "false").
function extractPartialBooleanFromArgs(argsText: string, key: string): boolean | null {
  if (!argsText) return null;
  const re = new RegExp(`"${key}"\\s*:\\s*(true|false)\\b`);
  const m = argsText.match(re);
  if (!m) return null;
  return m[1] === "true";
}

// Tolerant extractor: pull a partial `html` value out of a JSON object's
// argumentsText that's still being streamed. We treat the JSON as a flat
// string and look for the first `"html"` key, then consume chars from
// after the opening quote until the closing quote (or end-of-buffer if
// the model hasn't closed it yet). Properly unescapes `\"` and \n etc.
// Returns null if the html field hasn't started arriving yet.
function extractPartialHtmlFromArgs(argsText: string): string | null {
  if (!argsText) return null;
  // Locate `"html"` key — be lenient with whitespace.
  const m = argsText.match(/"html"\s*:\s*"/);
  if (!m) return null;
  const startIdx = m.index! + m[0].length;
  let out = "";
  let i = startIdx;
  while (i < argsText.length) {
    const ch = argsText[i];
    if (ch === "\\" && i + 1 < argsText.length) {
      const next = argsText[i + 1];
      if (next === '"') out += '"';
      else if (next === "\\") out += "\\";
      else if (next === "n") out += "\n";
      else if (next === "r") out += "\r";
      else if (next === "t") out += "\t";
      else if (next === "/") out += "/";
      else if (next === "u" && i + 5 < argsText.length) {
        const hex = argsText.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        out += next;
      } else {
        out += next;
      }
      i += 2;
      continue;
    }
    if (ch === '"') return out; // closed
    out += ch;
    i += 1;
  }
  // Stream not closed — return what we got (partial).
  return out.length > 0 ? out : null;
}

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

/** A chat message enriched with optional ask_user questions, tool calls, mission preview, vault preview, and client-side actions.
 *  We Omit `segments` from the base `ChatMessage` because the SDK shape
 *  uses `{ type: "tool"; toolId: string }` (a reference) while the UI
 *  enriches it to `{ type: "tool"; tool: ToolCallInfo }` (the full
 *  tool-call so we can render arguments/results inline without a join). */
export interface ChatMessageWithQuestions extends Omit<ChatMessage, "segments"> {
  askUserQuestions?: AskUserQuestion[];
  missionPreview?: MissionPreviewData;
  vaultPreview?: VaultPreviewData;
  whatsappPreview?: WhatsAppPreviewData;
  emailPreview?: EmailPreviewData;
  /** Inline interactive HTML widgets emitted by render_widget. Multiple
   *  widgets can be emitted in the same turn — they're rendered in
   *  order, each as its own card/canvas. */
  widgets?: WidgetRenderData[];
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
  whatsapp: WhatsAppPreviewData | null;
  email: EmailPreviewData | null;
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
  /**
   * Sessions whose messages have been fetched into messagesBySession at least
   * once during this app lifetime. Used by loadSession to act like a
   * browser-tab switch (instant, in-memory) instead of re-fetching/clobbering
   * cached state when the user clicks back to an already-warm session via the
   * tab strip. The cache is invalidated on visibilitychange refresh, on
   * deleteSession, on clear(), and on logout (full unmount).
   */
  const loadedSessionsRef = useRef<Set<string>>(new Set());

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
  const pendingWhatsApp = pendingState?.whatsapp ?? null;
  const pendingEmail = pendingState?.email ?? null;
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
        whatsapp: null,
        email: null,
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
      whatsapp: null,
      email: null,
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
    if (loadedSessionsRef.current.has(fromKey)) {
      loadedSessionsRef.current.add(toKey);
      loadedSessionsRef.current.delete(fromKey);
    } else {
      // First send of a brand-new session migrates from the local placeholder
      // key to the server-assigned id; the in-memory cache is now the source
      // of truth for this id, so mark it loaded — re-clicking its tab must
      // not trigger a redundant getMessages round-trip.
      loadedSessionsRef.current.add(toKey);
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
      // Interactive intercepts arrivano con state="interrupted" (turn
      // bloccato in attesa input utente). render_widget è display-only,
      // arriva con state="completed" — accettiamo entrambi i casi.
      const isInteractiveInterrupted = tc.state === "interrupted";
      const isWidgetCompleted = tc.name === "render_widget" && tc.state === "completed";
      if (!isInteractiveInterrupted && !isWidgetCompleted) continue;

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
      } else if ((tc.name === "whatsapp_send" || tc.name === "whatsapp_send_file") && tc.arguments) {
        // Side-effect gate intercept survived a refresh — restore the
        // pending preview card so the user can still confirm/refine.
        const args = tc.arguments as Record<string, unknown>;
        const isFile = tc.name === "whatsapp_send_file";
        const wp: WhatsAppPreviewData = {
          kind: isFile ? "file" : "text",
          to: (args.to as string) ?? "",
          message: isFile ? undefined : ((args.message as string) ?? ""),
          path: isFile ? ((args.path as string) ?? "") : undefined,
          caption: args.caption as string | undefined,
          mediaKind: args.mediaKind as string | undefined,
          mimeType: args.mimeType as string | undefined,
          fileName: args.fileName as string | undefined,
          viewOnce: args.viewOnce as boolean | undefined,
        };
        lastMsg.whatsappPreview = wp;
        setSessionPending(key, { whatsapp: wp });
      } else if (tc.name === "email_send" && tc.arguments) {
        const args = tc.arguments as Record<string, unknown>;
        const ep: EmailPreviewData = {
          to: (args.to as string | string[]) ?? "",
          subject: (args.subject as string) ?? "",
          body: (args.body as string) ?? "",
          html: args.html as boolean | undefined,
          cc: args.cc as string | string[] | undefined,
          bcc: args.bcc as string | string[] | undefined,
          from: args.from as string | undefined,
          reply_to: args.reply_to as string | undefined,
          attachments: args.attachments as Array<{ path: string; filename?: string }> | undefined,
        };
        lastMsg.emailPreview = ep;
        setSessionPending(key, { email: ep });
      } else if (tc.name === "render_widget") {
        // Già gestito da toUiMessages (per ogni messaggio, non solo
        // l'ultimo). Niente da fare qui — render_widget non è una
        // pending intercept, è solo display.
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
    // Filtriamo SOLO i messaggi davvero vuoti (no content + no toolCalls):
    // un assistant message può legittimamente avere solo toolCalls
    // (es. render_widget) senza prose. Filtrando per content.trim()==='' si
    // perdevano tutti i messaggi "widget-only" al refresh.
    .filter((m) => {
      const serverMsg = m as ChatMessageWithQuestions;
      const hasText = m.content.trim().length > 0;
      const hasToolCalls = !!serverMsg.toolCalls && serverMsg.toolCalls.length > 0;
      return hasText || hasToolCalls;
    })
    .map((m) => {
      // Drop the server's `segments` from the spread — the SDK shape
      // (`{ type: "tool"; toolId }`) is incompatible with our enriched
      // shape (`{ type: "tool"; tool: ToolCallInfo }`). We re-derive
      // segments below from `toolCalls` via `reconstructSegments`.
      const { segments: _serverSegments, ...rest } = m;
      const enriched: ChatMessageWithQuestions = rest;
      const serverMsg = m as ChatMessageWithQuestions;
      if (serverMsg.toolCalls && serverMsg.toolCalls.length > 0) {
        enriched.toolCalls = serverMsg.toolCalls;
        enriched.segments = reconstructSegments(enriched);
        // Restore widgets[] da TUTTI i toolCall render_widget completed/interrupted
        // di QUESTO messaggio, in ordine. Nessun limite "solo l'ultimo
        // messaggio" come fa restoreInteractiveState — un turn passato
        // può aver prodotto widget e devono ricomparire al refresh.
        const widgets: WidgetRenderData[] = [];
        for (const tc of serverMsg.toolCalls) {
          if (tc.name !== "render_widget") continue;
          if (tc.state !== "completed" && tc.state !== "interrupted") continue;
          const args = tc.arguments as Record<string, unknown> | undefined;
          if (!args) continue;
          const html = typeof args.html === "string" ? args.html : "";
          if (!html) continue;
          widgets.push({
            html,
            title: (args.title as string | undefined) ?? null,
            description: (args.description as string | undefined) ?? null,
            chrome: (args.chrome as boolean | undefined) ?? true,
            stream: (args.stream as boolean | undefined) ?? false,
          });
        }
        if (widgets.length > 0) enriched.widgets = widgets;
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
    const widgets: WidgetRenderData[] = [];

    const messagePatch = () => ({
      content: fullContent,
      thinkingText: thinkingText || undefined,
      toolCalls: toolCalls.length > 0 ? [...toolCalls] : undefined,
      segments: [...segments],
      ...(widgets.length > 0 ? { widgets: [...widgets] } : {}),
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

          // Widget render intercept — display-only, just paint it onto the message.
          const wr = choice?.widget_render as
            | { html: string; title?: string | null; description?: string | null; chrome?: boolean; stream?: boolean }
            | undefined;
          if (wr && typeof wr.html === "string") {
            widgets.push({
              html: wr.html,
              title: wr.title ?? null,
              description: wr.description ?? null,
              chrome: wr.chrome ?? true,
              stream: wr.stream ?? false,
            });
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
      // Restore agent scope from the loaded session
      const session = sessions.find((s) => s.id === id);
      setSelectedAgent(session?.agent ?? null);

      if (streamsBySessionRef.current.has(id) || resumeAbortBySessionRef.current.has(id)) {
        // In-flight stream/resume — local state is the live source of truth.
        setMessagesLoading(false);
        return;
      }

      // ── Warm-cache fast path (browser-tab switch semantics) ──────────
      // If we've already loaded this session into the in-memory store and
      // there is no in-flight network operation for it, treat the click as
      // a pure tab switch: do NOT clobber the cached messages, do NOT show
      // the messages-loading skeleton, do NOT clear pending interactive
      // state (the user might have an open ask_user/mission/vault prompt
      // they're mid-way through reviewing). The visibilitychange handler
      // below still refreshes the active session opportunistically.
      if (loadedSessionsRef.current.has(id)) {
        setMessagesLoading(false);
        return;
      }

      setMessagesLoading(true);
      clearSessionPending(id);

      try {
        const raw = await getMessages(id);
        const msgs = applyServerMessages(id, raw);
        loadedSessionsRef.current.add(id);

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
      // Widget render intercept — array (multiple widget_render calls in
      // the same turn append in order, in lo stesso ordine di emit).
      const widgets: WidgetRenderData[] = [];

      const messagePatch = () => ({
        content: fullContent,
        thinkingText: thinkingText || undefined,
        toolCalls: toolCalls.length > 0 ? [...toolCalls] : undefined,
        segments: [...segments],
        ...(widgets.length > 0 ? { widgets: [...widgets] } : {}),
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

      // ── Live widget preview (throttled) ───────────────────────────────
      // Mentre il modello scrive gli `arguments` di render_widget arrivano
      // tool_call deltas con argumentsText cumulativo. Qui estraiamo il
      // valore del campo `html` (anche se non chiuso) e aggiorniamo un
      // widget preview ogni LIVE_THROTTLE_MS — l'iframe re-renderizza ad
      // ogni cambio srcDoc, quindi spammare a ogni token sarebbe troppo.
      // 1000ms ≈ 1 fps. Aggiornare l'iframe srcDoc ricostruisce TUTTO il
      // DOM, esegue da zero il <script>, riapplica CSP — costoso. Sotto a
      // ~1s su widget complessi affossa anche desktop. Throttle per ID
      // tool + dedup sull'html: se nei chunk successivi html non è
      // cambiato (il modello sta scrivendo gli ALTRI campi dopo `html`)
      // skippiamo il re-render senza nemmeno guardare l'orologio.
      const LIVE_THROTTLE_MS = 1000;
      const liveLastEmitAt = new Map<string, number>(); // toolCallId → ts
      const liveLastHtmlByTool = new Map<string, string>(); // toolCallId → ultimo html emesso
      const liveWidgetIdxByTool = new Map<string, number>(); // toolCallId → idx in widgets[]
      const tryEmitLivePreview = (toolId: string, argsText: string | undefined) => {
        if (!argsText) return false;
        // Live preview è OPT-IN: parte solo se il modello ha esplicitato
        // `stream: true` nei tool args. Altrimenti il widget appare solo
        // al final intercept (atomico) — è il default e il caso più
        // frequente perché il throttle dell'iframe rebuild è costoso.
        const streamOpt = extractPartialBooleanFromArgs(argsText, "stream");
        if (streamOpt !== true) return false;

        const html = extractPartialHtmlFromArgs(argsText);
        if (!html) return false;
        // Dedup cheap: se l'html parziale è identico all'ultimo emesso
        // (es. il modello sta ora scrivendo title/chrome DOPO l'html),
        // niente re-render dell'iframe. È il caso più frequente di
        // sofferenza percepita perché ogni token genera un chunk SSE.
        if (liveLastHtmlByTool.get(toolId) === html) return false;
        const now = Date.now();
        const last = liveLastEmitAt.get(toolId) ?? 0;
        if (now - last < LIVE_THROTTLE_MS) return false;
        liveLastEmitAt.set(toolId, now);
        liveLastHtmlByTool.set(toolId, html);

        // Estraiamo anche `chrome` dal JSON parziale così il preview
        // rispetta l'intent del modello.
        const chromeOpt = extractPartialBooleanFromArgs(argsText, "chrome");

        const liveData: WidgetRenderData = {
          html,
          title: null,
          description: null,
          chrome: chromeOpt ?? true,
          stream: true,
          streaming: true,
        };
        const existingIdx = liveWidgetIdxByTool.get(toolId);
        if (existingIdx !== undefined && widgets[existingIdx]) {
          widgets[existingIdx] = liveData;
        } else {
          widgets.push(liveData);
          liveWidgetIdxByTool.set(toolId, widgets.length - 1);
        }
        return true;
      };

      // Quando l'intercept finale `widget_render` arriva, sovrascriviamo
      // il preview live con il widget canonico (no più streaming flag).
      // Caso normale: il preview live e l'intercept hanno corrispondenza
      // 1:1 nell'ordine. Caso edge (più tool render_widget back-to-back):
      // appendiamo nuovo widget se nessun live preview è in attesa.
      let nextFinalSlot = 0;
      const promoteToFinal = (final: WidgetRenderData) => {
        // Trova il primo widget streaming=true a partire da nextFinalSlot.
        for (let i = nextFinalSlot; i < widgets.length; i += 1) {
          if (widgets[i]?.streaming) {
            widgets[i] = { ...final, streaming: false };
            nextFinalSlot = i + 1;
            return;
          }
        }
        // Nessun preview pending: append.
        widgets.push({ ...final, streaming: false });
        nextFinalSlot = widgets.length;
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
            const prevState = existing?.state;
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
          // Live preview throttled per render_widget tool calls — vedi
          // tryEmitLivePreview (1s + dedup html). Estrae l'html parziale
          // da argumentsText e mostra un widget "streaming" mentre il
          // modello ancora scrive.
          let didLive = false;
          const isWidgetTool = tc.name === "render_widget" && (tc.state === "preparing" || tc.state === "calling");
          if (isWidgetTool) {
            didLive = tryEmitLivePreview(tc.id, (existing?.argumentsText ?? tc.argumentsText));
          }
          // OTTIMIZZAZIONE: durante un tool render_widget in scrittura
          // (preparing/calling) i delta arrivano a centinaia. Ognuno
          // mutava `existing` in place + chiamava updateMsg → React
          // re-renderizzava TUTTO il messaggio (chat compresa) per
          // niente. Ora setState SOLO quando:
          //   - il preview live è effettivamente cambiato (didLive)
          //   - oppure il tool ha cambiato STATO (preparing→calling→
          //     completed→error) — evento raro, va sempre flushato
          //   - oppure NON è un tool render_widget (gli altri tool
          //     hanno UI live nella tool card e devono aggiornare)
          const stateChanged = prevState !== tc.state;
          if (!isWidgetTool || didLive || stateChanged) {
            updateMsg();
          }
        }

        // Widget render intercept — same shape as mission_preview/vault_preview
        // but display-only: turn ends, no user response expected.
        const wr = (choice as any)?.widget_render as
          | { html: string; title?: string | null; description?: string | null; chrome?: boolean; stream?: boolean }
          | undefined;
        if (wr && typeof wr.html === "string") {
          // Promuove l'eventuale live preview a widget definitivo.
          promoteToFinal({
            html: wr.html,
            title: wr.title ?? null,
            description: wr.description ?? null,
            chrome: wr.chrome ?? true,
            stream: wr.stream ?? false,
          });
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
        setSessionPending(streamSessionKey, { questions: stream.askUser.questions, mission: null, vault: null, whatsapp: null, email: null, openFile: null, navigateTo: null, openTab: null, setDesign: null });
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
        setSessionPending(streamSessionKey, { mission: preview, questions: null, vault: null, whatsapp: null, email: null, openFile: null, navigateTo: null, openTab: null, setDesign: null });
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
        setSessionPending(streamSessionKey, { vault: vaultData, questions: null, mission: null, whatsapp: null, email: null, openFile: null, navigateTo: null, openTab: null, setDesign: null });
        appendConversation(streamSessionKey, { role: "assistant", content: fullContent });
      } else if ((stream as any).whatsappPreview) {
        // WhatsApp preview — Side-effect approval gate. Server emitted
        // whatsapp_preview after intercepting whatsapp_send /
        // whatsapp_send_file. UI shows a card with Send/Refine/Cancel.
        const wp = (stream as any).whatsappPreview as WhatsAppPreviewData;
        updateSessionMessages(streamSessionKey, (prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, ...messagePatch(), whatsappPreview: wp }
            : m
          )
        );
        setSessionPending(streamSessionKey, { whatsapp: wp, questions: null, mission: null, vault: null, email: null, openFile: null, navigateTo: null, openTab: null, setDesign: null });
        appendConversation(streamSessionKey, { role: "assistant", content: fullContent });
      } else if ((stream as any).emailPreview) {
        // Email preview — Side-effect approval gate. Server emitted
        // email_preview after intercepting email_send.
        const ep = (stream as any).emailPreview as EmailPreviewData;
        updateSessionMessages(streamSessionKey, (prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, ...messagePatch(), emailPreview: ep }
            : m
          )
        );
        setSessionPending(streamSessionKey, { email: ep, questions: null, mission: null, vault: null, whatsapp: null, openFile: null, navigateTo: null, openTab: null, setDesign: null });
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
        setSessionPending(streamSessionKey, { openFile: openFileData, questions: null, mission: null, vault: null, whatsapp: null, email: null, navigateTo: null, openTab: null, setDesign: null });
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
        setSessionPending(streamSessionKey, { navigateTo: navData, questions: null, mission: null, vault: null, whatsapp: null, email: null, openFile: null, openTab: null, setDesign: null });
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
        setSessionPending(streamSessionKey, { openTab: openTabData, questions: null, mission: null, vault: null, whatsapp: null, email: null, openFile: null, navigateTo: null, setDesign: null });
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
        setSessionPending(streamSessionKey, { setDesign: setDesignData, questions: null, mission: null, vault: null, whatsapp: null, email: null, openFile: null, navigateTo: null, openTab: null });
        appendConversation(streamSessionKey, { role: "assistant", content: fullContent });
      } else if (widgets.length > 0 || (stream as any).widgetRender) {
        // Widget render — display-only intercept. N widget catturati in
        // ordine durante il chunk loop, OPPURE 1 widget esposto dallo SDK
        // come `stream.widgetRender` (fallback per quando il chunk loop
        // non lo cattura). Attach all'assistant message così sopravvive
        // a un refresh (oltre al restore da toolCall persistito).
        // Find-or-create pattern: il widget può arrivare PRIMA di qualunque
        // text delta, quindi assistantId potrebbe non esistere ancora.
        const allWidgets = widgets.length > 0
          ? [...widgets]
          : [(stream as any).widgetRender as WidgetRenderData];
        updateSessionMessages(streamSessionKey, (prev) => {
          let attached = false;
          const patched = prev.map((m) => {
            if (m.id !== assistantId) return m;
            attached = true;
            return { ...m, ...messagePatch(), widgets: allWidgets };
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
                ? { ...m, ...messagePatch(), widgets: allWidgets }
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
              widgets: allWidgets,
            },
          ];
        });
        clearSessionPending(streamSessionKey);
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

  // ── WhatsApp / Email approval-gate response handlers ───────────────
  // Same conversational loop as respondToMission: Send → REST API +
  // continue chat with a status message; Refine → user feedback to LLM;
  // Cancel → inform the LLM the user declined.

  const postJson = useCallback(async (path: string, body: unknown) => {
    const base = appConfig.baseUrl || "";
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (appConfig.apiKey) headers["Authorization"] = `Bearer ${appConfig.apiKey}`;
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      credentials: "include",
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.ok === false) {
      const msg = data?.error ?? `HTTP ${res.status}`;
      throw new Error(typeof msg === "string" ? msg : "Request failed");
    }
    return data?.data ?? data;
  }, []);

  const respondToWhatsApp = useCallback(
    async (action: SendPreviewAction, feedback?: string): Promise<{ id?: string; error?: string }> => {
      if (!pendingWhatsApp) return {};
      const wp = pendingWhatsApp;

      if (action === "send") {
        setSessionPending(activeSessionKeyRef.current, { whatsapp: null });
        try {
          const path = wp.kind === "file" ? "/api/v1/whatsapp/send-file" : "/api/v1/whatsapp/send";
          const body = wp.kind === "file"
            ? { to: wp.to, path: wp.path, caption: wp.caption, mediaKind: wp.mediaKind, mimeType: wp.mimeType, fileName: wp.fileName, viewOnce: wp.viewOnce }
            : { to: wp.to, message: wp.message };
          const result = await postJson(path, body) as { id?: string; jid?: string };
          await appendUserAndStream(
            `I confirmed the WhatsApp ${wp.kind === "file" ? "file " : ""}send to ${wp.to}. ` +
            `Message ${result.id ? `id ${result.id}` : "sent"}. Continue with the final answer.`,
          );
          return { id: result.id };
        } catch (e) {
          const errMsg = (e as Error).message;
          // Surface failure inline so the user sees what happened. The
          // LLM is also told so it can react / retry with different text.
          await appendUserAndStream(`WhatsApp send failed: ${errMsg}. Don't retry automatically — wait for new instructions.`);
          return { error: errMsg };
        }
      }

      if (action === "cancel") {
        setSessionPending(activeSessionKeyRef.current, { whatsapp: null });
        await appendUserAndStream(`I declined the WhatsApp send to ${wp.to}. Let's move on.`);
        return {};
      }

      if (action === "refine" && feedback?.trim()) {
        setSessionPending(activeSessionKeyRef.current, { whatsapp: null });
        await appendUserAndStream(`Please revise the WhatsApp message before sending: ${feedback.trim()}`);
      }

      return {};
    },
    [appendUserAndStream, pendingWhatsApp, postJson, setSessionPending],
  );

  const respondToEmail = useCallback(
    async (action: SendPreviewAction, feedback?: string): Promise<{ id?: string; error?: string }> => {
      if (!pendingEmail) return {};
      const ep = pendingEmail;

      if (action === "send") {
        setSessionPending(activeSessionKeyRef.current, { email: null });
        try {
          const result = await postJson("/api/v1/email/send", {
            ...ep,
            // Pass the agent scope so the REST endpoint resolves the
            // right vault + per-agent emailAllowedDomains override
            // (parity with email_send when run inside the agent loop).
            agent: selectedAgentRef.current ?? undefined,
          }) as { id?: string };
          const recipient = Array.isArray(ep.to) ? ep.to.join(", ") : ep.to;
          await appendUserAndStream(
            `I confirmed the email send to ${recipient} with subject "${ep.subject}". ` +
            `Message ${result.id ? `id ${result.id}` : "sent"}. Continue with the final answer.`,
          );
          return { id: result.id };
        } catch (e) {
          const errMsg = (e as Error).message;
          await appendUserAndStream(`Email send failed: ${errMsg}. Don't retry automatically — wait for new instructions.`);
          return { error: errMsg };
        }
      }

      if (action === "cancel") {
        setSessionPending(activeSessionKeyRef.current, { email: null });
        const recipient = Array.isArray(ep.to) ? ep.to.join(", ") : ep.to;
        await appendUserAndStream(`I declined the email send to ${recipient}. Let's move on.`);
        return {};
      }

      if (action === "refine" && feedback?.trim()) {
        setSessionPending(activeSessionKeyRef.current, { email: null });
        await appendUserAndStream(`Please revise the email before sending: ${feedback.trim()}`);
      }

      return {};
    },
    [appendUserAndStream, pendingEmail, postJson, setSessionPending],
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
        loadedSessionsRef.current.delete(id);
        setSessionStreaming(id, false);
      } catch {
        // silent
      }
    },
    [clearSessionPending, sdkDeleteSession, sessionId, setSessionStreaming, updateSessionMessages]
  );

  const clear = useCallback(() => {
    const key = activeSessionKeyRef.current;
    updateSessionMessages(key, []);
    clearSessionPending(key);
    conversationBySessionRef.current.delete(key);
    loadedSessionsRef.current.delete(key);
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
    pendingWhatsApp,
    pendingEmail,
    pendingOpenFile,
    pendingNavigateTo,
    pendingOpenTab,
    pendingSetDesign,
    send,
    stop,
    answerQuestions,
    respondToMission,
    respondToVault,
    respondToWhatsApp,
    respondToEmail,
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
