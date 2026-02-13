/**
 * Chat session management commands for blessed TUI.
 */

import type { CommandContext } from "../context.js";
import { useTUIStore } from "../store.js";

/** Write to chat display if available, otherwise fall back to logAlways */
function chatLine(ctx: CommandContext, msg: string): void {
  ctx.addChatLine ? ctx.addChatLine(msg) : ctx.logAlways(msg);
}

/**
 * /sessions — List and resume chat sessions.
 */
export function cmdSessions(ctx: CommandContext): void {
  const store = useTUIStore.getState();
  const sessionStore = ctx.orchestrator.getSessionStore();
  if (!sessionStore) {
    chatLine(ctx, "Session store not available");
    return;
  }

  const sessions = sessionStore.listSessions();
  if (sessions.length === 0) {
    chatLine(ctx, "No chat sessions yet. Use chat mode to start one.");
    return;
  }

  chatLine(ctx, "");
  chatLine(ctx, "{bold}Chat Sessions:{/bold}");
  for (const s of sessions) {
    const date = new Date(s.createdAt);
    const dateStr = date.toLocaleDateString("it-IT", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
    const current = s.id === store.activeSessionId ? " {green-fg}(active){/green-fg}" : "";
    const title = s.title ? ` ${s.title.slice(0, 40)}` : "";
    chatLine(ctx, `  {cyan-fg}${dateStr}{/cyan-fg}  {grey-fg}${s.messageCount} msgs{/grey-fg}${title}${current}`);
  }
  chatLine(ctx, "");
  chatLine(ctx, "{grey-fg}Use /new-chat to start a new session{/grey-fg}");
}

/**
 * /new-chat — Start a fresh chat session.
 */
export function cmdNewChat(ctx: CommandContext): void {
  const store = useTUIStore.getState();
  const sessionStore = ctx.orchestrator.getSessionStore();
  if (!sessionStore) {
    chatLine(ctx, "Session store not available");
    return;
  }

  const newId = sessionStore.create();
  store.setActiveSessionId(newId);
  store.setChatMessages([]);
  ctx.setInputMode("chat");
  chatLine(ctx, "New chat session started");
}
