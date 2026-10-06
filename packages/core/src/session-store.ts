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

/** Ordered assistant render timeline. Tool segments reference toolCalls by id. */
export type MessageSegment =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool"; toolId: string };

export interface Message {
  id: string;              // nanoid(10)
  role: MessageRole;
  content: string;
  ts: string;              // ISO timestamp
  /** Tool calls executed during this assistant message (only for role=assistant) */
  toolCalls?: ToolCallInfo[];
  /** Ordered render timeline preserving text/reasoning/tool interleaving. */
  segments?: MessageSegment[];
}

export interface Session {
  id: string;              // nanoid(10)
  title?: string;          // first 60 chars of first message
  createdAt: string;       // ISO timestamp
  updatedAt: string;       // ISO timestamp
  messageCount: number;
  /** Agent name when this session targets a specific agent (agent-direct mode). Null/undefined for orchestrator sessions. */
  agent?: string;
  /** Whether the session is starred. When true, the UI surfaces it in a dedicated section above the normal list. */
  starred?: boolean;
  /**
   * Channel conversation the session belongs to (e.g. "telegram:group:-100…" for a Telegram group).
   * Scoped sessions are never resumed as someone's "latest" chat: what is said there stays there.
   */
  scope?: string;
  /** Session this one was branched from ("fork from here"). */
  parentSessionId?: string;
  /** Message of the parent session the branch starts after (the last message copied). */
  forkMessageId?: string;
}

export interface CreateSessionOptions {
  scope?: string;
}

export interface ForkSessionOptions {
  /** Title of the new session (defaults to the parent's title). */
  title?: string;
}

export interface ForkSessionResult {
  session: Session;
  /** Parent message id → id of its copy in the new session, for every copied message. */
  messageIds: Record<string, string>;
}

export interface SessionStore {
  create(title?: string, agent?: string, opts?: CreateSessionOptions): Promise<string>;
  addMessage(sessionId: string, role: MessageRole, content: string, toolCalls?: ToolCallInfo[], segments?: MessageSegment[]): Promise<Message>;
  /** Update the content of an existing message (e.g. finalize a streaming response). */
  updateMessage(sessionId: string, messageId: string, content: string, toolCalls?: ToolCallInfo[], segments?: MessageSegment[]): Promise<boolean>;
  getMessages(sessionId: string): Promise<Message[]>;
  getRecentMessages(sessionId: string, limit: number): Promise<Message[]>;
  /**
   * Messages after `messageId` in getMessages() order, or undefined when that message is not in
   * the session. Optional: callers fall back to getMessages().
   */
  getMessagesAfter?(sessionId: string, messageId: string): Promise<Message[] | undefined>;
  listSessions(): Promise<Session[]>;
  getSession(sessionId: string): Promise<Session | undefined>;
  /**
   * Get the most recent unscoped session, optionally filtered by agent name. Pass `null` to match
   * only orchestrator sessions. Sessions with a scope (group conversations) are skipped.
   */
  getLatestSession(agent?: string | null): Promise<Session | undefined>;
  /** Rename (update the title of) an existing session. */
  renameSession(sessionId: string, title: string): Promise<boolean>;
  /** Star or unstar a session. Does NOT bump updatedAt (preserves recent ordering). */
  setStarred(sessionId: string, starred: boolean): Promise<boolean>;
  deleteSession(sessionId: string): Promise<boolean>;
  /**
   * Branch a conversation: a new session (same agent and scope) holding copies of every message
   * up to and including `messageId`, with new ids and the original timestamps, written at once.
   * Returns undefined when the session or the message does not exist. Optional for custom stores.
   */
  forkSession?(sessionId: string, messageId: string, opts?: ForkSessionOptions): Promise<ForkSessionResult | undefined>;
  prune(keepSessions: number): Promise<number>;
  close(): Promise<void> | void;
}

// ── Chat queue ─────────────────────────────────────────────────────────

/** A prompt waiting to be sent to a chat session after the running turn. */
export interface ChatQueueItem {
  id: string;
  sessionId: string;
  content: string;
  createdAt: string;
}

export interface ChatQueueState {
  /** Items in send order (head first). */
  items: ChatQueueItem[];
  /** Send the head automatically when a turn completes (default true). */
  autoSend: boolean;
}

/**
 * Per-session prompt queue, kept on the server so it survives reloads and is shared by every
 * device looking at the session.
 */
export interface ChatQueueStore {
  get(sessionId: string): Promise<ChatQueueState>;
  /** Append (or, with `front`, prepend) an item. */
  add(sessionId: string, content: string, opts?: { front?: boolean }): Promise<ChatQueueItem>;
  update(sessionId: string, id: string, content: string): Promise<ChatQueueItem | undefined>;
  remove(sessionId: string, id: string): Promise<ChatQueueItem | undefined>;
  /** Reorder: `ids` lists the items in their new order; ids not listed keep their relative order after them. */
  reorder(sessionId: string, ids: string[]): Promise<ChatQueueItem[]>;
  clear(sessionId: string): Promise<number>;
  /** Remove and return the head, if any. */
  shift(sessionId: string): Promise<ChatQueueItem | undefined>;
  setAutoSend(sessionId: string, autoSend: boolean): Promise<void>;
  /** Drop the queue and its settings (the session was deleted). */
  deleteSession(sessionId: string): Promise<void>;
}
