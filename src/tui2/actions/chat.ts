/**
 * Chat action — tool-based agentic loop for conversational interaction.
 * Streams response chunks in real-time via the pi-tui ChatLog.
 * The LLM can use orchestrator tools to manage tasks, plans, and state.
 * Write tools may require user approval depending on approval mode.
 *
 * Port of src/tui/actions/chat.ts for the pi-tui imperative TUI2.
 */

import type { Orchestrator } from "../../core/orchestrator.js";
import type { SessionStore } from "../../core/session-store.js";
import type { Message } from "@mariozechner/pi-ai";
import type { TUIContext } from "../types.js";
import { theme } from "../theme.js";

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const MAX_HISTORY = 20;
const MAX_TURNS = 20;

/**
 * Start a chat interaction with the orchestrator's LLM.
 * Implements an agentic tool loop with streaming.
 */
export async function startChat(
  message: string,
  polpo: Orchestrator,
  tui: TUIContext,
  _agentOverride?: string,
): Promise<void> {
  // Resolve or create session
  const sessionStore = polpo.getSessionStore();
  const sessionId = resolveSession(sessionStore, tui.activeSessionId);
  if (sessionId && tui.activeSessionId !== sessionId) {
    tui.activeSessionId = sessionId;
  }

  // Persist user message
  if (sessionStore && sessionId) {
    sessionStore.addMessage(sessionId, "user", message);
  }

  tui.setStreaming(true);
  tui.setProcessing(true, "Thinking…");

  try {
    // Dynamic imports to avoid heavy loading at startup
    const { streamSimple } = await import("@mariozechner/pi-ai");
    const { buildChatSystemPrompt } = await import("../../llm/prompts.js");
    const { resolveModel, resolveApiKey, resolveModelSpec } = await import("../../llm/pi-client.js");
    const {
      ALL_ORCHESTRATOR_TOOLS,
      needsApproval,
      executeOrchestratorTool,
      formatToolDescription,
      formatToolDetails,
    } = await import("../../llm/orchestrator-tools.js");

    // Build system prompt with current state
    const state = (() => {
      try { return polpo.getStore()?.getState() ?? null; }
      catch { return null; }
    })();
    const systemPrompt = buildChatSystemPrompt(polpo, state);

    // Build pi-ai messages from session history
    const history = sessionStore && sessionId
      ? sessionStore.getRecentMessages(sessionId, MAX_HISTORY)
      : [];

    const messages: Message[] = [];

    // Add past messages as a single user turn (pi-ai AssistantMessage needs extra fields)
    const past = history.filter((m) => !(m.role === "user" && m.content === message));
    if (past.length > 0) {
      const historyText = past
        .map(h => `${h.role === "user" ? "User" : "Assistant"}: ${h.content}`)
        .join("\n\n");
      messages.push({
        role: "user" as const,
        content: `[Conversation history]\n${historyText}\n[End of history]`,
        timestamp: Date.now() - 1,
      });
    }

    // Add current user message
    messages.push({ role: "user", content: message, timestamp: Date.now() });

    const model = resolveModelSpec(polpo.getConfig()?.settings?.orchestratorModel);
    const m = resolveModel(model);
    const apiKey = resolveApiKey(m.provider);
    const streamOpts = apiKey ? { apiKey } : undefined;

    // ── Agentic tool loop with streaming ──
    // allText collects text across all turns for session persistence.
    // turnText collects text for the current turn (displayed live).
    const allTextParts: string[] = [];
    let turnText = "";
    const RUN_ID = `chat-${Date.now()}`;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      tui.setProcessing(true, turn > 0 ? "Continuing…" : "Thinking…");

      let estimatedOutputTokens = 0;
      let providerReportedTotal = 0;
      let lastReportedToStore = 0;

      const stream = streamSimple(m, {
        systemPrompt,
        messages,
        tools: ALL_ORCHESTRATOR_TOOLS,
      }, streamOpts);

      // Stream text deltas chunk by chunk
      turnText = "";
      for await (const event of stream) {
        if (event.type === "text_delta") {
          tui.setProcessing(false);
          turnText += event.delta;
          // Update streaming assistant message in ChatLog
          tui.logResponse([{ text: turnText }]);
          tui.requestRender();

          // Estimate output tokens from streamed characters (~4 chars ≈ 1 token)
          estimatedOutputTokens += Math.ceil(event.delta.length / 4);
        }

        // Read provider-reported usage when available
        let reportedTotal = 0;
        if ("partial" in event && event.partial?.usage) {
          reportedTotal = (event.partial.usage as { totalTokens?: number }).totalTokens ?? 0;
        } else if (event.type === "done" && "message" in event) {
          const msg = event.message as { usage?: { totalTokens?: number } };
          reportedTotal = msg.usage?.totalTokens ?? 0;
        }

        if (reportedTotal > providerReportedTotal) {
          providerReportedTotal = reportedTotal;
        }

        // Push the best available count
        const bestTotal = Math.max(providerReportedTotal, estimatedOutputTokens);
        if (bestTotal > lastReportedToStore) {
          tui.updateStreamingTokens(bestTotal - lastReportedToStore);
          lastReportedToStore = bestTotal;
        }
      }

      // Get the final complete message
      const response = await stream.result();
      messages.push(response);

      // Collect text from this turn
      if (turnText.trim()) {
        allTextParts.push(turnText.trim());
        // Finalize this turn's assistant message so next turn gets a fresh bubble
        tui.finalizeAssistant(turnText, RUN_ID);
      }

      // Reconcile with exact final count from provider
      if ("usage" in response && response.usage && typeof response.usage === "object") {
        const u = response.usage as { totalTokens?: number };
        const finalTotal = u.totalTokens ?? 0;
        if (finalTotal > lastReportedToStore) {
          tui.updateStreamingTokens(finalTotal - lastReportedToStore);
        }
      }

      // Extract tool calls
      const toolCalls = response.content.filter(
        (c): c is { type: "toolCall"; id: string; name: string; arguments: Record<string, any> } =>
          c.type === "toolCall"
      );

      if (toolCalls.length === 0) break; // Done — no more tools

      // Execute each tool call
      for (const call of toolCalls) {
        // Check if write tool needs approval
        if (needsApproval(call.name) && tui.approvalMode === "approval") {
          const description = formatToolDescription(call.name, call.arguments, polpo);
          const details = formatToolDetails(call.name, call.arguments, polpo);
          tui.setProcessing(false);

          // Show approval overlay and wait for user decision
          const approved = await tui.showApproval({
            toolName: call.name,
            description,
            details: details.main,
            extraDetails: details.extra.length > 0 ? details.extra : undefined,
          });

          if (!approved) {
            tui.logSystem(`${theme.failed("✗")} Rejected: ${description}`);
            tui.requestRender();
            messages.push({
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: "text", text: "User denied this action." }],
              isError: true,
              timestamp: Date.now(),
            } as any);
            continue;
          }
          tui.logSystem(`${theme.done("✓")} Approved: ${description}`);
        }

        // Show tool card (pending state)
        const toolDesc = formatToolDescription(call.name, call.arguments, polpo);
        tui.startTool(call.id, call.name, call.arguments);
        tui.setProcessing(true, `Executing ${toolDesc}…`);
        tui.requestRender();

        // Execute the tool
        const result = executeOrchestratorTool(call.name, call.arguments, polpo);
        const isError = result.startsWith("Error:");

        // Update tool card with result
        tui.updateToolResult(call.id, result, { isError });

        messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: result }],
          isError,
          timestamp: Date.now(),
        } as any);
      }
    }

    // Warn if max turns exhausted
    if (allTextParts.length === 0 && turnText.trim()) {
      allTextParts.push(turnText.trim());
    }

    tui.setProcessing(false);
    tui.setStreaming(false);

    // Persist all collected text
    const finalText = allTextParts.join("\n\n");
    if (finalText && sessionStore && sessionId) {
      sessionStore.addMessage(sessionId, "assistant", finalText);
    }
    if (!finalText) {
      tui.dropAssistant(RUN_ID);
      tui.logSystem(theme.dim("(No text response)"));
    }
    tui.requestRender();
  } catch (err: unknown) {
    tui.setProcessing(false);
    tui.setStreaming(false);
    tui.setPendingApproval(null);
    const msg = err instanceof Error ? err.message : String(err);
    tui.logSystem(`${theme.error("✗")} Chat error: ${msg}`);
    tui.requestRender();
  }
}

function resolveSession(
  sessionStore: SessionStore | undefined,
  activeId: string | null,
): string | null {
  if (!sessionStore) return null;

  // Reuse active session
  if (activeId) {
    const session = sessionStore.getSession(activeId);
    if (session) return activeId;
  }

  // Look for recent session (< 30min old)
  const latest = sessionStore.getLatestSession();
  if (latest) {
    const age = Date.now() - new Date(latest.updatedAt).getTime();
    if (age < SESSION_TIMEOUT_MS) return latest.id;
  }

  // Create new
  return sessionStore.create();
}
