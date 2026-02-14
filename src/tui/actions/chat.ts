/**
 * Chat action — sends message to LLM for conversational interaction.
 * Persists conversation history via SessionStore.
 */

import type { Orchestrator } from "../../core/orchestrator.js";
import type { TUIStore } from "../store.js";
import type { SessionStore } from "../../core/session-store.js";
import { seg } from "../format.js";
import { querySDKText } from "../../llm/query.js";
import { buildChatSystemPrompt } from "../../llm/prompts.js";

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const MAX_HISTORY = 20;

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

  store.setProcessing(true, "Thinking...");

  try {
    // Build prompt with history
    const history = sessionStore && sessionId
      ? sessionStore.getRecentMessages(sessionId, MAX_HISTORY)
      : [];

    const state = (() => {
      try { return polpo.getStore()?.getState() ?? null; }
      catch { return null; }
    })();

    const systemPrompt = buildChatSystemPrompt(polpo, state);
    const parts: string[] = [systemPrompt];

    // Inject conversation history (skip current message)
    const past = history.filter((m) => !(m.role === "user" && m.content === message));
    if (past.length > 0) {
      parts.push("", "## Conversation History", "");
      for (const m of past) {
        parts.push(`${m.role === "user" ? "User" : "Assistant"}: ${m.content}`);
      }
    }

    parts.push(
      "", "---", "",
      `User question: ${message}`,
      "",
      "Answer concisely based on the current Polpo state. Use plain text, no markdown.",
    );

    const model = polpo.getConfig()?.settings?.orchestratorModel;
    const response = await querySDKText(parts.join("\n"), polpo.getWorkDir(), model);

    store.setProcessing(false);

    if (response) {
      // Persist assistant response
      if (sessionStore && sessionId) {
        sessionStore.addMessage(sessionId, "assistant", response);
      }

      // Show response
      for (const line of response.split("\n")) {
        store.log(line, [seg("  ", "gray"), seg(line)]);
      }
    } else {
      store.log("No response", [seg("No response", "gray")]);
    }
  } catch (err: unknown) {
    store.setProcessing(false);
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
