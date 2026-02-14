/**
 * Chat mode handler for Ink TUI — queries Claude for Q&A about Polpo state.
 * Persists conversation history via SessionStore for cross-session continuity.
 */

import chalk from "chalk";
import type { CommandContext } from "../context.js";
import { querySDKText } from "../../llm/query.js";
import { buildChatSystemPrompt } from "../../llm/prompts.js";
import { useTUIStore } from "../store.js";
import type { SessionStore } from "../../core/session-store.js";
import type { Message } from "../../core/session-store.js";

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_HISTORY_MESSAGES = 20;

export async function handleChatInput(ctx: CommandContext, input: string): Promise<void> {
  const store = useTUIStore.getState();

  // Resolve or create session
  const sessionStore = ctx.orchestrator.getSessionStore();
  const sessionId = resolveSession(sessionStore, store.activeSessionId);
  if (sessionId && store.activeSessionId !== sessionId) {
    store.setActiveSessionId(sessionId);
    // Load existing messages into TUI
    if (sessionStore) {
      const existing = sessionStore.getMessages(sessionId);
      store.setChatMessages(existing.map(m => ({
        role: m.role,
        content: m.content,
        ts: new Date(m.ts).getTime(),
      })));
    }
  }

  // Show user message
  store.addChatMessage({ role: "user", content: input, ts: Date.now() });
  store.logAlways(input);
  store.logAlways("");
  ctx.setProcessing(true, "Thinking");

  // Persist user message
  if (sessionStore && sessionId) {
    sessionStore.addMessage(sessionId, "user", input);
    ctx.orchestrator.emit("message:added", {
      sessionId,
      messageId: "",
      role: "user" as const,
    });
  }

  try {
    // Build prompt with conversation history
    const history = sessionStore && sessionId
      ? sessionStore.getRecentMessages(sessionId, MAX_HISTORY_MESSAGES)
      : [];
    const response = await queryChatResponse(ctx, input, history);
    ctx.setProcessing(false);

    if (response) {
      // Persist assistant response
      if (sessionStore && sessionId) {
        sessionStore.addMessage(sessionId, "assistant", response);
        ctx.orchestrator.emit("message:added", {
          sessionId,
          messageId: "",
          role: "assistant" as const,
        });
      }

      // Update TUI
      for (const line of response.split("\n")) {
        store.addChatMessage({ role: "assistant", content: line, ts: Date.now() });
        store.logAlways(`  ${line}`);
      }
    } else {
      store.logAlways(chalk.gray("No response"));
    }
    store.logAlways("");
  } catch (err: unknown) {
    ctx.setProcessing(false);
    const msg = err instanceof Error ? err.message : String(err);
    store.logAlways(chalk.red(`Chat error: ${msg}`));
  }
}

/**
 * Resolve the active session: reuse recent one or create new.
 */
function resolveSession(
  sessionStore: SessionStore | undefined,
  activeSessionId: string | null,
): string | null {
  if (!sessionStore) return null;

  // Already have an active session
  if (activeSessionId) {
    const session = sessionStore.getSession(activeSessionId);
    if (session) return activeSessionId;
  }

  // Look for a recent session (< 30min old)
  const latest = sessionStore.getLatestSession();
  if (latest) {
    const age = Date.now() - new Date(latest.updatedAt).getTime();
    if (age < SESSION_TIMEOUT_MS) return latest.id;
  }

  // Create new session
  return sessionStore.create();
}

/**
 * Build prompt with conversation history and query LLM.
 */
async function queryChatResponse(
  ctx: CommandContext,
  input: string,
  history: Message[],
): Promise<string> {
  ctx.loadState();

  const parts: string[] = [
    buildChatSystemPrompt(ctx.orchestrator, ctx.getState(), ctx.workDir),
  ];

  // Inject conversation history (skip the last user message — it's the current input)
  const pastMessages = history.filter(m => !(m.role === "user" && m.content === input));
  if (pastMessages.length > 0) {
    parts.push("", "## Conversation History (last messages)", "");
    for (const m of pastMessages) {
      parts.push(`${m.role === "user" ? "User" : "Assistant"}: ${m.content}`);
    }
  }

  parts.push("", "---", "", `User question: ${input}`, "", `Answer concisely based on the current Polpo state. Use plain text, no markdown.`);

  return querySDKText(
    parts.join("\n"),
    ctx.workDir,
    ctx.orchestrator.getConfig()?.settings?.orchestratorModel,
  );
}
