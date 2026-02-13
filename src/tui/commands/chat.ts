/**
 * Chat mode handler — queries Claude for Q&A about Polpo state.
 * Persists conversation history via SessionStore for cross-session continuity.
 */

import type { CommandContext } from "../context.js";
import { querySDKText } from "../../llm/query.js";
import { buildChatSystemPrompt } from "../../llm/prompts.js";
import { fmtUserMsg } from "../formatters.js";
import type { SessionStore } from "../../core/session-store.js";
import type { Message } from "../../core/session-store.js";
import { useTUIStore } from "../store.js";

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_HISTORY_MESSAGES = 20;

/** Write to chat display if available, otherwise fall back to logAlways */
function chatLine(ctx: CommandContext, msg: string): void {
  ctx.addChatLine ? ctx.addChatLine(msg) : ctx.logAlways(msg);
}

export async function handleChatInput(ctx: CommandContext, input: string): Promise<void> {
  const store = useTUIStore.getState();

  // Resolve or create session
  const sessionStore = ctx.orchestrator.getSessionStore();
  const sessionId = resolveSession(sessionStore, store.activeSessionId);
  if (sessionId && store.activeSessionId !== sessionId) {
    store.setActiveSessionId(sessionId);
    if (sessionStore) {
      const existing = sessionStore.getMessages(sessionId);
      store.setChatMessages(existing.map(m => ({
        role: m.role,
        content: m.content,
        ts: new Date(m.ts).getTime(),
      })));
    }
  }

  store.addChatMessage({ role: "user", content: input, ts: Date.now() });
  chatLine(ctx, fmtUserMsg(input));
  chatLine(ctx, "");
  ctx.setProcessing(true, "Thinking");

  // Persist user message
  if (sessionStore && sessionId) {
    sessionStore.addMessage(sessionId, "user", input);
  }

  try {
    const history = sessionStore && sessionId
      ? sessionStore.getRecentMessages(sessionId, MAX_HISTORY_MESSAGES)
      : [];
    const response = await queryChatResponse(ctx, input, history);
    ctx.setProcessing(false);

    if (response) {
      if (sessionStore && sessionId) {
        sessionStore.addMessage(sessionId, "assistant", response);
      }

      for (const line of response.split("\n")) {
        store.addChatMessage({ role: "assistant", content: line, ts: Date.now() });
        chatLine(ctx, `  ${line}`);
      }
    } else {
      chatLine(ctx, "{grey-fg}No response{/grey-fg}");
    }
    chatLine(ctx, "");
  } catch (err: unknown) {
    ctx.setProcessing(false);
    const msg = err instanceof Error ? err.message : String(err);
    chatLine(ctx, `{red-fg}Chat error: ${msg}{/red-fg}`);
  }
}

function resolveSession(
  sessionStore: SessionStore | undefined,
  activeSessionId: string | null,
): string | null {
  if (!sessionStore) return null;

  if (activeSessionId) {
    const session = sessionStore.getSession(activeSessionId);
    if (session) return activeSessionId;
  }

  const latest = sessionStore.getLatestSession();
  if (latest) {
    const age = Date.now() - new Date(latest.updatedAt).getTime();
    if (age < SESSION_TIMEOUT_MS) return latest.id;
  }

  return sessionStore.create();
}

async function queryChatResponse(
  ctx: CommandContext,
  input: string,
  history: Message[],
): Promise<string> {
  ctx.loadState();

  const parts: string[] = [
    buildChatSystemPrompt(ctx.orchestrator, ctx.getState(), ctx.workDir),
  ];

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
