/**
 * Chat sessions (the dashboard's conversations with Polpo and with agents): list, read, rename,
 * star, delete. Talking in one is polpo_ask / polpo_agent_chat with its session_id.
 */
import { z } from "zod";
import {
  BAD_CURSOR, DESTRUCTIVE, READ, UPDATE, apiError, apiGet, apiSend, confirmParam, cursorParam, decodeCursor, enc, encodeCursor, fail,
  limitParam, ok, pageBackwards, pageOutput, short,
  type McpDeps, type Register,
} from "./kit.js";

type Session = { id: string; title?: string; createdAt: string; updatedAt: string; messageCount: number; agent?: string | null; starred?: boolean; scope?: string; parentSessionId?: string };
type Message = { id: string; role: string; content: unknown; ts: string; toolCalls?: Array<{ name: string; state?: string }>; attachments?: Array<{ filename?: string; path?: string }> };

const sessionItem = z.object({
  id: z.string(), title: z.string().optional(), agent: z.string().optional(), starred: z.boolean().optional(),
  message_count: z.number().int(), updated_at: z.string(), created_at: z.string(), scope: z.string().optional(),
});
const messageItem = z.object({ id: z.string(), role: z.string(), ts: z.string(), text: z.string(), tools: z.array(z.string()).optional(), attachments: z.array(z.string()).optional() });

const sessionView = (s: Session) => ({
  id: s.id, ...(s.title ? { title: s.title } : {}), ...(s.agent ? { agent: s.agent } : {}), ...(s.starred ? { starred: true } : {}),
  message_count: s.messageCount ?? 0, updated_at: s.updatedAt, created_at: s.createdAt, ...(s.scope ? { scope: s.scope } : {}),
});
const sessionLine = (s: ReturnType<typeof sessionView>) => `- ${s.id}${s.starred ? " ★" : ""} "${short(s.title ?? "(untitled)", 80)}" with ${s.agent ?? "Polpo"}, ${s.message_count} messages, ${s.updated_at.slice(0, 16).replace("T", " ")}`;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).filter(Boolean).join("\n");
  return content === undefined || content === null ? "" : JSON.stringify(content);
}

/** A message as the model reads it: its text (cut), the tools it used, its attachments; never tool arguments. */
const messageView = (m: Message, full: boolean) => ({
  id: m.id, role: m.role, ts: m.ts, text: full ? textOf(m.content) : short(textOf(m.content), 2000),
  ...(m.toolCalls?.length ? { tools: m.toolCalls.map((t) => t.name) } : {}),
  ...(m.attachments?.length ? { attachments: m.attachments.map((a) => a.filename ?? a.path ?? "file") } : {}),
});

async function loadSessions(deps: McpDeps) {
  const r = await apiGet(deps, "/chat/sessions");
  return r.ok ? { ok: true as const, sessions: ((r.data as { sessions?: Session[] })?.sessions ?? []) } : r;
}

const notFound = (id: string) => fail(`There is no chat session ${id}. Find the id with polpo_chat_sessions_list.`);

export function registerChatTools(tool: Register, deps: McpDeps): void {
  tool("chat", "polpo_chat_sessions_list", {
    title: "List chat sessions",
    description: "Conversations with Polpo and with agents, most recent first (starred first with starred: true): id, title, agent, messages. "
      + "Continue one with polpo_ask or polpo_agent_chat and its session_id; read it with polpo_chat_messages.",
    inputSchema: {
      agent: z.string().optional().describe("Only conversations with this agent ('polpo' for Polpo's own)"),
      starred: z.boolean().optional().describe("true: only starred ones"),
      text: z.string().optional().describe("Words in the title"),
      limit: limitParam(20, 100),
      cursor: cursorParam(),
    },
    outputSchema: pageOutput(sessionItem),
    annotations: READ,
  }, async ({ agent, starred, text, limit, cursor }) => {
    const c = decodeCursor(cursor);
    if (!c) return fail(BAD_CURSOR);
    const r = await loadSessions(deps);
    if (!r.ok) return apiError(r, "Listing chat sessions");
    const words = (text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const all = r.sessions
      .filter((s) => (agent === undefined || (agent === "polpo" ? !s.agent : s.agent === agent))
        && (starred === undefined || !!s.starred === starred)
        && words.every((w) => (s.title ?? "").toLowerCase().includes(w)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(sessionView);
    const n = limit ?? 20;
    const start = c.o ?? 0;
    const items = all.slice(start, start + n);
    const next = start + n < all.length ? encodeCursor({ o: start + n }) : null;
    return ok(`${items.map(sessionLine).join("\n") || "No conversations match."}${next ? `\n(more: cursor ${next})` : ""}`, { items, next_cursor: next, total: all.length });
  });

  tool("chat", "polpo_chat_messages", {
    title: "Read a chat session",
    description: "The messages of a conversation, oldest first within the page: the latest page first, older ones with cursor. "
      + "Each message has its text, the tools it used and its attachments (never tool arguments or secrets).",
    inputSchema: {
      id: z.string().min(1).describe("The session's id (polpo_chat_sessions_list, or session_id of polpo_ask / polpo_agent_chat)"),
      full_text: z.boolean().optional().describe("true: whole messages (default: long ones are cut at 2000 characters)"),
      limit: limitParam(20, 100),
      cursor: cursorParam(),
    },
    outputSchema: { ...pageOutput(messageItem), session: sessionItem },
    annotations: READ,
  }, async ({ id, full_text, limit, cursor }) => {
    const r = await apiGet(deps, `/chat/sessions/${enc(id)}/messages`);
    if (!r.ok) return r.status === 404 ? notFound(id) : apiError(r, `Reading chat session ${id}`);
    const data = r.data as { session: Session; messages: Message[] };
    const p = pageBackwards((data.messages ?? []).map((m) => messageView(m, !!full_text)), limit ?? 20, cursor);
    if (!p) return fail(BAD_CURSOR);
    const session = sessionView(data.session);
    const lines = p.items.map((m) => `[${m.id}] ${m.ts.slice(0, 16).replace("T", " ")} ${m.role}${m.tools ? ` (tools: ${m.tools.join(", ")})` : ""}: ${m.text}`);
    return ok(`${sessionLine(session).slice(2)}\n\n${lines.join("\n\n") || "No messages."}${p.next_cursor ? `\n(older: cursor ${p.next_cursor})` : ""}`, { ...p, session });
  });

  tool("chat", "polpo_chat_session_update", {
    title: "Rename or star a chat session",
    description: "Rename a conversation, or star / unstar it (starred ones are shown first in the dashboard).",
    inputSchema: {
      id: z.string().min(1).describe("The session's id"),
      title: z.string().trim().min(1).max(200).optional().describe("The new title"),
      starred: z.boolean().optional().describe("true to star it, false to unstar it"),
    },
    outputSchema: { session: sessionItem },
    annotations: UPDATE,
  }, async ({ id, title, starred }) => {
    if (title === undefined && starred === undefined) return fail("Nothing to change: give title or starred.");
    const r = await apiSend(deps, "PATCH", `/chat/sessions/${enc(id)}`, { ...(title !== undefined ? { title } : {}), ...(starred !== undefined ? { starred } : {}) });
    if (!r.ok) return r.status === 404 ? notFound(id) : apiError(r, `Updating chat session ${id}`);
    const all = await loadSessions(deps);
    const s = all.ok ? all.sessions.find((x) => x.id === id) : undefined;
    const session = s ? sessionView(s) : { id, ...(title ? { title } : {}), ...(starred ? { starred } : {}), message_count: 0, updated_at: "", created_at: "" };
    return ok(`Updated ${id}${title ? `: "${title}"` : ""}${starred !== undefined ? (starred ? " (starred)" : " (unstarred)") : ""}.`, { session });
  });

  tool("chat", "polpo_chat_session_delete", {
    title: "Delete a chat session",
    description: "Delete a conversation and its messages (a reply still running in it is dropped). It cannot be undone. Needs confirm: true.",
    inputSchema: { id: z.string().min(1).describe("The session's id"), confirm: confirmParam("delete the conversation") },
    outputSchema: { id: z.string(), deleted: z.boolean() },
    annotations: DESTRUCTIVE,
  }, async ({ id, confirm }) => {
    const all = await loadSessions(deps);
    if (!all.ok) return apiError(all, "Listing chat sessions");
    const s = all.sessions.find((x) => x.id === id);
    if (!s) return notFound(id);
    if (confirm !== true) return fail(`Deleting "${s.title ?? id}" (${s.messageCount} messages with ${s.agent ?? "Polpo"}) cannot be undone: ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "DELETE", `/chat/sessions/${enc(id)}`);
    if (!r.ok) return apiError(r, `Deleting chat session ${id}`);
    return ok(`Deleted chat session ${id}.`, { id, deleted: true });
  });
}
