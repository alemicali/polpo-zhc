/**
 * Chat session storage — persists conversation threads across TUI restarts.
 * Nomenclature aligned with OpenCode: Session, Message, SessionStore.
 */

export type MessageRole = "user" | "assistant";

export type ToolCallState = "preparing" | "calling" | "completed" | "error" | "interrupted";

export interface ToolCallInfo {
  /** Tool call ID from the LLM */
  id: string;
  /** Tool name (e.g. "create_task", "get_status") */
  name: string;
  /** Tool input arguments (present when state was "calling") */
  arguments?: Record<string, unknown>;
  /** Tool execution result (present when state is "completed" or "error") */
  result?: string;
  /** Final state of the tool call */
  state: ToolCallState;
}

export interface Message {
  id: string;              // nanoid(10)
  role: MessageRole;
  content: string;
  ts: string;              // ISO timestamp
  /** Tool calls executed during this assistant message (only for role=assistant) */
  toolCalls?: ToolCallInfo[];
}

export interface Session {
  id: string;              // nanoid(10)
  title?: string;          // first 60 chars of first message
  createdAt: string;       // ISO timestamp
  updatedAt: string;       // ISO timestamp
  messageCount: number;
}

export interface SessionStore {
  create(title?: string): Promise<string>;
  addMessage(sessionId: string, role: MessageRole, content: string): Promise<Message>;
  /** Update the content of an existing message (e.g. finalize a streaming response). */
  updateMessage(sessionId: string, messageId: string, content: string, toolCalls?: ToolCallInfo[]): Promise<boolean>;
  getMessages(sessionId: string): Promise<Message[]>;
  getRecentMessages(sessionId: string, limit: number): Promise<Message[]>;
  listSessions(): Promise<Session[]>;
  getSession(sessionId: string): Promise<Session | undefined>;
  getLatestSession(): Promise<Session | undefined>;
  /** Rename (update the title of) an existing session. */
  renameSession(sessionId: string, title: string): Promise<boolean>;
  deleteSession(sessionId: string): Promise<boolean>;
  prune(keepSessions: number): Promise<number>;
  close(): Promise<void> | void;
}
