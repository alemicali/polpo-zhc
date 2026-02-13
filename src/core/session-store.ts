/**
 * Chat session storage — persists conversation threads across TUI restarts.
 * Nomenclature aligned with OpenCode: Session, Message, SessionStore.
 */

export type MessageRole = "user" | "assistant";

export interface Message {
  id: string;              // nanoid(10)
  role: MessageRole;
  content: string;
  ts: string;              // ISO timestamp
}

export interface Session {
  id: string;              // nanoid(10)
  title?: string;          // first 60 chars of first message
  createdAt: string;       // ISO timestamp
  updatedAt: string;       // ISO timestamp
  messageCount: number;
}

export interface SessionStore {
  create(title?: string): string;
  addMessage(sessionId: string, role: MessageRole, content: string): Message;
  getMessages(sessionId: string): Message[];
  getRecentMessages(sessionId: string, limit: number): Message[];
  listSessions(): Session[];
  getSession(sessionId: string): Session | undefined;
  getLatestSession(): Session | undefined;
  deleteSession(sessionId: string): boolean;
  prune(keepSessions: number): number;
  close(): void;
}
