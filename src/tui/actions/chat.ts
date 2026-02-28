/**
 * Chat action — streams responses from the Polpo server's completions endpoint.
 *
 * Instead of calling the LLM directly via pi-ai, this routes through
 * POST /v1/chat/completions (OpenAI-compatible SSE) so that all agentic
 * tool logic stays server-side.
 */

import type { Orchestrator } from "../../core/orchestrator.js";
import type { TUIStore } from "../store.js";
import { seg, parseMarkdown } from "../format.js";
import { DEFAULT_SERVER_PORT, DEFAULT_SERVER_HOST } from "../../core/constants.js";

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

/**
 * Build a short info string from tool name + arguments for display in parentheses.
 * e.g. "read_file" + {path: "/foo/bar.ts"} → "/foo/bar.ts"
 */
function formatToolInfo(name: string, args?: Record<string, unknown>): string {
  if (!args || typeof args !== "object") return "";
  // Pick the most useful argument based on tool name
  const path = args.path ?? args.filePath ?? args.file ?? args.filename;
  if (typeof path === "string") {
    // Shorten to last 2 path segments
    const parts = path.split("/");
    return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : path;
  }
  const cmd = args.command ?? args.cmd;
  if (typeof cmd === "string") {
    return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
  }
  const query = args.query ?? args.pattern ?? args.search ?? args.url;
  if (typeof query === "string") {
    return query.length > 60 ? query.slice(0, 57) + "..." : query;
  }
  // Fallback: first string arg value
  for (const val of Object.values(args)) {
    if (typeof val === "string" && val.length > 0) {
      return val.length > 60 ? val.slice(0, 57) + "..." : val;
    }
  }
  return "";
}

/**
 * Get the server port from the orchestrator config or use the global default.
 */
function getServerPort(polpo: Orchestrator): number {
  const config = polpo.getConfig();
  return (config?.settings as any)?.serverPort ?? DEFAULT_SERVER_PORT;
}

export async function startChat(
  message: string,
  polpo: Orchestrator,
  store: TUIStore,
): Promise<void> {
  // Resolve or create session
  const sessionStore = polpo.getSessionStore();
  const sessionId = resolveSession(sessionStore, store.activeSessionId);
  if (sessionId && store.activeSessionId !== sessionId) {
    store.setActiveSessionId(sessionId);
  }

  store.startStreaming();
  store.setProcessing(true, "Thinking...");

  // Prepare response entry
  const ts = new Date().toISOString();
  store.pushLine({ type: "response", segs: [seg("...", "gray")], ts });
  let accumulated = "";

  try {
    const port = getServerPort(polpo);
    const url = `http://${DEFAULT_SERVER_HOST}:${port}/v1/chat/completions`;

    // Build messages array from session history
    const messages: { role: string; content: string }[] = [];

    if (sessionStore && sessionId) {
      const history = sessionStore.getRecentMessages(sessionId, 20);
      // Exclude the current message from history (we'll add it separately)
      const past = history.filter(
        (m) => !(m.role === "user" && m.content === message),
      );
      for (const m of past) {
        messages.push({ role: m.role, content: m.content });
      }
    }

    messages.push({ role: "user", content: message });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (sessionId) {
      headers["x-session-id"] = sessionId;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages,
        stream: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Server returned ${response.status}: ${errorText}`);
    }

    // Track session ID from response
    const returnedSessionId = response.headers.get("x-session-id");
    if (returnedSessionId && returnedSessionId !== store.activeSessionId) {
      store.setActiveSessionId(returnedSessionId);
    }

    // Parse SSE stream
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE lines
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;

        if (trimmed === "data: [DONE]") {
          // Stream complete
          continue;
        }

        if (trimmed.startsWith("data: ")) {
          const jsonStr = trimmed.slice(6);
          try {
            const chunk = JSON.parse(jsonStr);
            const choice = chunk.choices?.[0];
            if (!choice) continue;

            // Text content
            const delta = choice.delta?.content;
            if (delta) {
              store.setProcessing(false);
              accumulated += delta;
              store.updateLastLine(parseMarkdown(accumulated));
            }

            // Tool call notification
            const toolCall = choice.tool_call;
            if (toolCall) {
              if (toolCall.state === "calling") {
                // Build info string from tool arguments
                const info = formatToolInfo(toolCall.name, toolCall.arguments);
                store.pushLine({
                  type: "tool",
                  name: toolCall.name,
                  info,
                  state: "running",
                  ts: new Date().toISOString(),
                });
                store.setProcessing(true, `${toolCall.name}...`);
              } else if (
                toolCall.state === "completed" ||
                toolCall.state === "error"
              ) {
                const toolState = toolCall.state === "error" ? "error" as const : "done" as const;
                const info = formatToolInfo(toolCall.name, toolCall.arguments);
                store.updateLastTool(toolState, info);
                store.setProcessing(false);
              }
            }

            // Finish reason — handle special cases
            const finishReason = choice.finish_reason;
            if (finishReason === "ask_user" && choice.ask_user) {
              // Server is asking the user a question — show it inline
              const questions = choice.ask_user.questions ?? [];
              for (const q of questions) {
                store.pushLine({
                  type: "event",
                  segs: [
                    { text: "? ", color: "yellow", bold: true },
                    { text: q.question ?? q.text ?? String(q), color: "white" },
                  ],
                  ts: new Date().toISOString(),
                });
              }
            }

            if (finishReason === "mission_preview" && choice.mission_preview) {
              const mp = choice.mission_preview;
              store.pushLine({
                type: "event",
                segs: [
                  { text: "▶ ", color: "blue", bold: true },
                  { text: `Mission: ${mp.name}`, color: "white", bold: true },
                ],
                ts: new Date().toISOString(),
              });
            }

            // After finish_reason="stop", next text deltas (if any) are part of a new turn
            if (finishReason === "stop" || finishReason === "ask_user" || finishReason === "mission_preview" || finishReason === "vault_preview") {
              // Stream will end with [DONE]
            }
          } catch {
            // Ignore malformed JSON chunks
          }
        }
      }
    }

    store.setProcessing(false);
    store.stopStreaming();

    // Update final text and mark response as done (● turns white)
    const finalText = accumulated.trim();
    if (finalText) {
      store.updateLastLine(parseMarkdown(finalText));
    } else {
      store.updateLastLine([seg("No response", "gray")]);
    }
    store.markLastResponseDone();
  } catch (err: unknown) {
    store.setProcessing(false);
    store.stopStreaming();
    const msg = err instanceof Error ? err.message : String(err);

    // Friendly error if server is not running
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
      store.updateLastLine([
        seg("Server not running. ", "red"),
        seg("Start it with: ", "gray"),
        seg("polpo serve", "cyan", true),
      ]);
    } else {
      store.log(`Chat error: ${msg}`, [seg(`Chat error: ${msg}`, "red")]);
    }
  }
}

function resolveSession(
  sessionStore: import("../../core/session-store.js").SessionStore | undefined,
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
