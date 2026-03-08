/**
 * Custom hooks that complement the @lumea-technologies/polpo-react.
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
import { usePolpo, useSessions } from "@lumea-technologies/polpo-react";
import type { ChatMessage, ChatCompletionMessage, PolpoConfig } from "@lumea-technologies/polpo-react";
import type { ChatCompletionStream } from "@lumea-technologies/polpo-react";

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

// Local mirror of SDK tool call types
export type ToolCallState = "preparing" | "calling" | "completed" | "error" | "interrupted";

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

/** A chat message enriched with optional ask_user questions, tool calls, mission preview, vault preview, and client-side actions */
export interface ChatMessageWithQuestions extends ChatMessage {
  askUserQuestions?: AskUserQuestion[];
  missionPreview?: MissionPreviewData;
  vaultPreview?: VaultPreviewData;
  openFile?: OpenFileData;
  navigateTo?: NavigateToData;
  openTab?: OpenTabData;
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
  /** True while loading messages for an existing session (distinguishes from empty "new chat" state) */
  const [messagesLoading, setMessagesLoading] = useState(false);
  /** Questions waiting for user response (null = no pending questions) */
  const [pendingQuestions, setPendingQuestions] = useState<AskUserQuestion[] | null>(null);
  /** Mission preview waiting for user action (null = no pending preview) */
  const [pendingMission, setPendingMission] = useState<MissionPreviewData | null>(null);
  /** Vault entry preview waiting for user confirmation (null = no pending vault) */
  const [pendingVault, setPendingVault] = useState<VaultPreviewData | null>(null);
  /** Client-side open_file — path of file to open in preview dialog */
  const [pendingOpenFile, setPendingOpenFile] = useState<OpenFileData | null>(null);
  /** Client-side navigate_to — target page + params (consumed immediately) */
  const [pendingNavigateTo, setPendingNavigateTo] = useState<NavigateToData | null>(null);
  /** Client-side open_tab — opens URL in new browser tab (consumed immediately) */
  const [pendingOpenTab, setPendingOpenTab] = useState<OpenTabData | null>(null);
  const initialLoadDone = useRef(false);
  /** Conversation history sent to the completions endpoint */
  const conversationRef = useRef<ChatCompletionMessage[]>([]);
  /** Currently active stream (for abort support) */
  const streamRef = useRef<ChatCompletionStream | null>(null);
  /** True when the user explicitly requested a new session — consumed on first send */
  const wantsNewSessionRef = useRef(false);

  // Reconstruct interactive state from persisted "interrupted" tool calls on the last assistant message.
  // If the last message is an assistant with an interrupted ask_user/create_mission, restore the pending state.
  const restoreInteractiveState = (msgs: ChatMessageWithQuestions[]) => {
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
          setPendingQuestions(questions);
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
        setPendingMission(preview);
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
        setPendingVault(vaultPreview);
      // NOTE: open_file, navigate_to, open_tab are one-shot navigation actions.
      // They must NOT be restored as pending because:
      // 1. They were already consumed when originally fired (navigate + streamCompletion).
      // 2. Restoring them triggers the useEffect in ChatPage → consume* → new
      //    streamCompletion, creating an infinite loop on every visibility change
      //    or session reload.
      // Only interactive prompts (ask_user, create_mission, set_vault_entry) that
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
      }
    }
  };

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
      setMessagesLoading(true);
      setPendingQuestions(null);
      setPendingMission(null);
      setPendingVault(null);
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
        // Restore any pending interactive state (ask_user / mission preview) from the last message
        restoreInteractiveState(msgs);
        setMessages(msgs);
        conversationRef.current = msgs.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }));
      } catch {
        setMessages([]);
        conversationRef.current = [];
      } finally {
        setMessagesLoading(false);
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
            // Restore any pending interactive state on visibility change
            restoreInteractiveState(msgs);
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
    setPendingMission(null);
    setPendingVault(null);
    conversationRef.current = [];
    wantsNewSessionRef.current = true;
  }, [setSessionId]);

  // Core streaming function (shared between send and answerQuestions)
  const streamCompletion = useCallback(
    async (assistantId: string) => {
      // If user explicitly requested a new session, send "new" sentinel to force server-side creation.
      // Otherwise send the current sessionId (or undefined to let server auto-select).
      const effectiveSessionId = wantsNewSessionRef.current ? "new" : (sessionId ?? undefined);
      wantsNewSessionRef.current = false;
      const stream = client.chatCompletionsStream({
        messages: conversationRef.current,
        sessionId: effectiveSessionId,
      });
      streamRef.current = stream;

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
              // Update existing tool call (preparing → calling → completed/error)
              existing.state = tc.state;
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
        setPendingMission(null);
        conversationRef.current.push({ role: "assistant", content: fullContent });
      } else if (stream.missionPreview) {
        // Mission preview — show interactive card for user to Execute/Draft/Refine/Cancel
        const preview: MissionPreviewData = {
          name: stream.missionPreview.name,
          data: stream.missionPreview.data,
          prompt: stream.missionPreview.prompt ?? undefined,
        };
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: fullContent, missionPreview: preview, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, segments: [...segments] }
              : m
          )
        );
        setPendingMission(preview);
        setPendingQuestions(null);
        setPendingVault(null);
        conversationRef.current.push({ role: "assistant", content: fullContent });
      } else if (stream.vaultPreview) {
        // Vault preview — show interactive card for user to Confirm/Cancel
        const vaultData: VaultPreviewData = {
          agent: stream.vaultPreview.agent,
          service: stream.vaultPreview.service,
          type: stream.vaultPreview.type,
          label: stream.vaultPreview.label ?? undefined,
          credentials: stream.vaultPreview.credentials,
        };
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: fullContent, vaultPreview: vaultData, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, segments: [...segments] }
              : m
          )
        );
        setPendingVault(vaultData);
        setPendingQuestions(null);
        setPendingMission(null);
        conversationRef.current.push({ role: "assistant", content: fullContent });
      } else if ((stream as any).openFile) {
        // Client-side open_file — open file preview dialog
        const of = (stream as any).openFile;
        const openFileData: OpenFileData = {
          path: of.path,
        };
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: fullContent, openFile: openFileData, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, segments: [...segments] }
              : m
          )
        );
        setPendingOpenFile(openFileData);
        setPendingQuestions(null);
        setPendingMission(null);
        setPendingVault(null);
        conversationRef.current.push({ role: "assistant", content: fullContent });
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
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: fullContent, navigateTo: navData, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, segments: [...segments] }
              : m
          )
        );
        setPendingNavigateTo(navData);
        setPendingQuestions(null);
        setPendingMission(null);
        setPendingVault(null);
        conversationRef.current.push({ role: "assistant", content: fullContent });
      } else if ((stream as any).openTab) {
        // Client-side open_tab — open URL in new browser tab
        const tab = (stream as any).openTab;
        const openTabData: OpenTabData = {
          url: tab.url,
          label: tab.label,
        };
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: fullContent, openTab: openTabData, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, segments: [...segments] }
              : m
          )
        );
        setPendingOpenTab(openTabData);
        setPendingQuestions(null);
        setPendingMission(null);
        setPendingVault(null);
        conversationRef.current.push({ role: "assistant", content: fullContent });
      } else {
        setPendingQuestions(null);
        setPendingMission(null);
        setPendingVault(null);
        setPendingOpenFile(null);
        setPendingNavigateTo(null);
        setPendingOpenTab(null);
        conversationRef.current.push({ role: "assistant", content: fullContent });
      }

      streamRef.current = null;
      refetchSessions();
      return fullContent;
    },
    [client, sessionId, setSessionId, refetchSessions]
  );

  // Send a message (streaming). Optionally attach images (data URLs).
  const send = useCallback(
    async (message: string, images?: { url: string; mimeType: string }[]) => {
      setPendingQuestions(null);
      setPendingMission(null);
      setPendingVault(null);

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

      // Optimistic user message (display always shows text only)
      const userMsg: ChatMessageWithQuestions = {
        id: `temp-${Date.now()}`,
        role: "user",
        content: message,
        ts: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);
      conversationRef.current.push({ role: "user", content });

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
        // Don't show error for user-initiated abort
        if (streamRef.current?.aborted) {
          streamRef.current = null;
        } else {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: `Error: ${(e as Error).message}` }
                : m
            )
          );
        }
      } finally {
        setIsLoading(false);
      }
    },
    [streamCompletion]
  );

  // Stop the current streaming response
  const stop = useCallback(() => {
    const stream = streamRef.current;
    if (stream) {
      stream.abort();
      streamRef.current = null;
    }
    setIsLoading(false);
  }, []);

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
        if (streamRef.current?.aborted) {
          streamRef.current = null;
        } else {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: `Error: ${(e as Error).message}` }
                : m
            )
          );
        }
      } finally {
        setIsLoading(false);
      }
    },
    [pendingQuestions, streamCompletion]
  );

  // Respond to a mission preview.
  // Execute/Draft call the REST API directly (same pattern as TUI).
  // Refine sends feedback back to the LLM for re-planning.
  // Cancel just clears the state.
  const respondToMission = useCallback(
    async (action: MissionPreviewAction, feedback?: string): Promise<{ missionId?: string; error?: string }> => {
      if (!pendingMission) return {};

      const missionData = pendingMission.data as Record<string, unknown>;
      const dataStr = typeof missionData === "string" ? missionData : JSON.stringify(missionData);

      // Helper: send a user message to the orchestrator and stream the LLM response
      const sendAndStream = async (userContent: string): Promise<void> => {
        const userMsg: ChatMessageWithQuestions = {
          id: `temp-${Date.now()}`,
          role: "user",
          content: userContent,
          ts: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, userMsg]);
        conversationRef.current.push({ role: "user", content: userContent });

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
      };

      // ── Execute: save as draft, execute, then inform orchestrator ──
      if (action === "execute") {
        setPendingMission(null);
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
          setMessages((prev) => [...prev, errorConfirm]);
          return { error: errMsg };
        }
      }

      // ── Draft: save, then inform orchestrator ──
      if (action === "draft") {
        setPendingMission(null);
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
          setMessages((prev) => [...prev, errorConfirm]);
          return { error: errMsg };
        }
      }

      // ── Cancel: inform orchestrator ──
      if (action === "cancel") {
        setPendingMission(null);
        await sendAndStream(
          `I decided not to proceed with the proposed mission "${pendingMission.name}". Let's move on.`
        );
        return {};
      }

      // ── Refine: send feedback back to the LLM for re-planning ──
      if (action === "refine" && feedback?.trim()) {
        setPendingMission(null);
        await sendAndStream(`Please refine the mission plan with these changes:\n${feedback.trim()}`);
      }

      return {};
    },
    [pendingMission, client, streamCompletion]
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

      setPendingVault(null);

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

        const userMsg: ChatMessageWithQuestions = {
          id: `temp-${Date.now()}`,
          role: "user",
          content: responseText,
          ts: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, userMsg]);
        conversationRef.current.push({ role: "user", content: responseText });

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
      } else {
        // Cancel — tell the LLM the user declined
        const cancelText = `Declined saving vault entry for "${pendingVault.service}" on agent "${pendingVault.agent}".`;
        const userMsg: ChatMessageWithQuestions = {
          id: `temp-${Date.now()}`,
          role: "user",
          content: cancelText,
          ts: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, userMsg]);
        conversationRef.current.push({ role: "user", content: cancelText });

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
      }
    },
    [pendingVault, client, streamCompletion]
  );

  // Consume the preview_file pending state after the dialog is opened.
  // The dialog is opened by the page component; this resumes the LLM conversation.
  const consumeOpenFile = useCallback(() => {
    if (!pendingOpenFile) return;
    const data = pendingOpenFile;
    setPendingOpenFile(null);

    const responseText = `File "${data.path}" opened for user.`;
    const userMsg: ChatMessageWithQuestions = {
      id: `temp-${Date.now()}`,
      role: "user",
      content: responseText,
      ts: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    conversationRef.current.push({ role: "user", content: responseText });

    const assistantId = `temp-${Date.now()}-a`;
    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: "assistant", content: "", ts: new Date().toISOString() },
    ]);
    setIsLoading(true);

    streamCompletion(assistantId)
      .catch((e) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: `Error: ${(e as Error).message}` }
              : m
          )
        );
      })
      .finally(() => setIsLoading(false));
  }, [pendingOpenFile, streamCompletion]);

  // Consume navigate_to — build a human-readable description and resume conversation
  const consumeNavigateTo = useCallback(() => {
    if (!pendingNavigateTo) return;
    const data = pendingNavigateTo;
    setPendingNavigateTo(null);

    // Build a descriptive response
    let label = data.target;
    if (data.id) label += ` "${data.id}"`;
    if (data.name) label += ` "${data.name}"`;
    if (data.path) label += ` (${data.path})`;
    const responseText = `Navigated to ${label}.`;
    const userMsg: ChatMessageWithQuestions = {
      id: `temp-${Date.now()}`,
      role: "user",
      content: responseText,
      ts: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    conversationRef.current.push({ role: "user", content: responseText });

    const assistantId = `temp-${Date.now()}-a`;
    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: "assistant", content: "", ts: new Date().toISOString() },
    ]);
    setIsLoading(true);

    streamCompletion(assistantId)
      .catch((e) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: `Error: ${(e as Error).message}` }
              : m
          )
        );
      })
      .finally(() => setIsLoading(false));
  }, [pendingNavigateTo, streamCompletion]);

  // Consume open_tab — open URL in new tab and resume conversation
  const consumeOpenTab = useCallback(() => {
    if (!pendingOpenTab) return;
    const data = pendingOpenTab;
    setPendingOpenTab(null);

    const label = data.label ?? data.url;
    const responseText = `Opened tab: ${label}`;
    const userMsg: ChatMessageWithQuestions = {
      id: `temp-${Date.now()}`,
      role: "user",
      content: responseText,
      ts: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    conversationRef.current.push({ role: "user", content: responseText });

    const assistantId = `temp-${Date.now()}-a`;
    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: "assistant", content: "", ts: new Date().toISOString() },
    ]);
    setIsLoading(true);

    streamCompletion(assistantId)
      .catch((e) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: `Error: ${(e as Error).message}` }
              : m
          )
        );
      })
      .finally(() => setIsLoading(false));
  }, [pendingOpenTab, streamCompletion]);

  // Delete a session — clear messages if active
  const deleteSession = useCallback(
    async (id: string) => {
      try {
        await sdkDeleteSession(id);
        if (sessionId === id) {
          setMessages([]);
          conversationRef.current = [];
          setPendingQuestions(null);
          setPendingMission(null);
          setPendingVault(null);
          setPendingOpenFile(null);
          setPendingOpenTab(null);
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
    setPendingMission(null);
    setPendingVault(null);
    setPendingOpenFile(null);
    setPendingOpenTab(null);
    conversationRef.current = [];
  }, [setSessionId]);

  return {
    messages,
    isLoading,
    messagesLoading,
    sessionId,
    sessions,
    sessionsLoading,
    pendingQuestions,
    pendingMission,
    pendingVault,
    pendingOpenFile,
    pendingNavigateTo,
    pendingOpenTab,
    send,
    stop,
    answerQuestions,
    respondToMission,
    respondToVault,
    consumeOpenFile,
    consumeNavigateTo,
    consumeOpenTab,
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
  const [info, setInfo] = useState<{ project: string; version?: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      client.getState().catch(() => null),
      client.getHealth().catch(() => null),
    ]).then(([state, health]) => {
      if (cancelled) return;
      const project = state?.project;
      if (project) {
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
