/**
 * Chat action — tool-based agentic loop for conversational interaction.
 * Streams response chunks in real-time as plain text.
 * The LLM can use orchestrator tools to manage tasks, plans, and state.
 * Write tools may require user approval depending on approval mode.
 */

import type { Orchestrator } from "../../core/orchestrator.js";
import type { TUIStore } from "../store.js";
import type { SessionStore } from "../../core/session-store.js";
import { seg, parseMarkdown } from "../format.js";
import { resolveModel, resolveApiKey, resolveModelSpec } from "../../llm/pi-client.js";
import { buildChatSystemPrompt } from "../../llm/prompts.js";
import { streamSimple, type Message } from "@mariozechner/pi-ai";
import {
  ALL_ORCHESTRATOR_TOOLS,
  needsApproval,
  executeOrchestratorTool,
  formatToolDescription,
} from "../../llm/orchestrator-tools.js";

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const MAX_HISTORY = 20;
const MAX_TURNS = 20;

export async function startChat(
  message: string,
  polpo: Orchestrator,
  store: TUIStore,
): Promise<void> {
  const sessionStore = polpo.getSessionStore();
  const sessionId = resolveSession(sessionStore, store.activeSessionId);
  if (sessionId && store.activeSessionId !== sessionId) {
    store.setActiveSessionId(sessionId);
  }

  // Persist user message
  if (sessionStore && sessionId) {
    sessionStore.addMessage(sessionId, "user", message);
  }

  store.startStreaming();
  store.setProcessing(true, "Thinking...");

  try {
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

    // Prepare output line — plain text, updated chunk by chunk
    const ts = new Date().toISOString();
    store.pushLine({ type: "response", segs: [seg("...", "gray")], ts });
    let accumulated = "";

    // ── Agentic tool loop with streaming ──
    let sessionTokens = 0; // cumulative tokens across all turns
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      store.setProcessing(true, "Thinking...");
      let turnTokensReported = 0; // tokens already reported for this turn

      const stream = streamSimple(m, {
        systemPrompt,
        messages,
        tools: ALL_ORCHESTRATOR_TOOLS,
      }, streamOpts);

      // Stream text deltas chunk by chunk as plain text.
      // Track output tokens in real-time by counting characters (~4 chars ≈ 1 token).
      // We'll reconcile with the exact count from the provider at the end.
      let estimatedOutputTokens = 0;
      let providerReportedTotal = 0;
      let lastReportedToStore = 0;

      for await (const event of stream) {
        if (event.type === "text_delta") {
          store.setProcessing(false);
          accumulated += event.delta;
          store.updateLastLine(parseMarkdown(accumulated));

          // Estimate output tokens from streamed characters (~4 chars per token)
          estimatedOutputTokens += Math.ceil(event.delta.length / 4);
        }

        // Read provider-reported usage when available (on partial or done/error)
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

        // Push the best available count to the store:
        // use provider data if available, otherwise use our estimate
        const bestTotal = Math.max(providerReportedTotal, estimatedOutputTokens);
        if (bestTotal > lastReportedToStore) {
          store.updateStreamingTokens(bestTotal - lastReportedToStore);
          lastReportedToStore = bestTotal;
        }
      }

      // Get the final complete message
      const response = await stream.result();
      messages.push(response);

      // Reconcile with exact final count from provider
      if ("usage" in response && response.usage && typeof response.usage === "object") {
        const u = response.usage as { totalTokens?: number };
        const finalTotal = u.totalTokens ?? 0;
        if (finalTotal > lastReportedToStore) {
          store.updateStreamingTokens(finalTotal - lastReportedToStore);
          lastReportedToStore = finalTotal;
        }
        sessionTokens += finalTotal;
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
        if (needsApproval(call.name) && store.approvalMode === "approval") {
          const description = formatToolDescription(call.name, call.arguments, polpo);
          store.setProcessing(false);

          const approved = await new Promise<boolean>((resolve) => {
            store.setPendingApproval({
              toolName: call.name,
              args: call.arguments,
              description,
              onApprove: () => resolve(true),
              onReject: () => resolve(false),
            });
          });
          store.clearPendingApproval();

          if (!approved) {
            messages.push({
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: "text", text: "User denied this action." }],
              isError: true,
              timestamp: Date.now(),
            });
            continue;
          }
        }

        // Show tool indicator (● gray = in progress)
        const toolDesc = formatToolDescription(call.name, call.arguments, polpo);
        store.pushLine({
          type: "event",
          segs: [
            { text: "● ", color: "gray", dim: true },
            { text: toolDesc, color: "gray", dim: true },
          ],
          ts: new Date().toISOString(),
        });
        store.setProcessing(true, `Executing ${toolDesc}...`);

        // Execute the tool
        const result = executeOrchestratorTool(call.name, call.arguments, polpo);
        const isError = result.startsWith("Error:");

        // Update indicator to success/failure (● green/red)
        store.updateLastLine([
          { text: isError ? "✗ " : "✓ ", color: isError ? "red" : "green" },
          { text: toolDesc, color: isError ? "red" : "green", dim: isError },
        ]);

        messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: result }],
          isError,
          timestamp: Date.now(),
        });
      }

      // Start a fresh response entry for the next streaming turn
      store.pushLine({ type: "response", segs: [seg("", "gray")], ts: new Date().toISOString() });
      accumulated = "";
    }

    store.setProcessing(false);
    store.stopStreaming();

    // Persist final text
    const finalText = accumulated.trim();
    if (finalText) {
      if (sessionStore && sessionId) {
        sessionStore.addMessage(sessionId, "assistant", finalText);
      }
      store.updateLastLine(parseMarkdown(finalText));
    } else {
      store.updateLastLine([seg("No response", "gray")]);
    }
  } catch (err: unknown) {
    store.setProcessing(false);
    store.stopStreaming();
    store.clearPendingApproval();
    const msg = err instanceof Error ? err.message : String(err);
    store.log(`Chat error: ${msg}`, [seg(`Chat error: ${msg}`, "red")]);
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
