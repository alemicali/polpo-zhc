/**
 * Coding chats: a Claude Code or Codex session in a worktree of the Coding app, run through the CLI
 * engine (the official program, the person's own sign-in) and shown as a chat.
 */
import type { CodingRiskCategory } from "../cli-engine/coding-policy.js";

export type CodingChatKind = "claude" | "codex";
export const CODING_CHAT_KINDS: readonly CodingChatKind[] = ["claude", "codex"];

/** idle: waiting for a message; running: a turn is on; awaiting-approval: the turn waits for a person; error: the last turn failed. */
export type CodingChatStatus = "idle" | "running" | "awaiting-approval" | "error";

/** Why a turn could not run, for the chat to say what to do. */
export type CodingChatErrorKind = "no-account" | "not-allowed" | "not-signed-in" | "usage-limit" | "not-installed" | "interrupted" | "other";

export interface CodingChatToolCall {
  id: string;
  /** The program's own tool name (Edit, Bash, Read… / shell, apply_patch…). */
  name: string;
  input?: Record<string, unknown>;
  output?: string;
  /** A unified diff of what an edit changes (Edit, MultiEdit, Write, apply_patch). */
  diff?: string;
  state: "running" | "completed" | "error" | "interrupted";
}

export type CodingChatSegment =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; tool: CodingChatToolCall }
  | { type: "approval"; approvalId: string };

export interface CodingChatUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface CodingChatMessage {
  id: string;
  role: "user" | "assistant";
  ts: string;
  /** user: what the person wrote. */
  text?: string;
  /** user: "steer" when it reached a running turn. */
  kind?: "prompt" | "steer";
  /** assistant: what the program did, in order. */
  segments?: CodingChatSegment[];
  /** assistant: the turn is still being written. */
  streaming?: boolean;
  model?: string;
  usage?: CodingChatUsage;
  /** The CLI's own cost estimate for the turn (informational: the plan pays). */
  costUsd?: number;
  error?: string;
  errorKind?: CodingChatErrorKind;
}

export interface CodingChatApproval {
  id: string;
  /** The program's tool (Bash, Edit… / commandExecution, fileChange). */
  tool: string;
  toolUseId?: string;
  input?: unknown;
  /** One line: the command or the file. */
  summary: string;
  reason: string;
  category: CodingRiskCategory;
  state: "pending" | "approved" | "denied" | "expired";
  requestedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface CodingChatSession {
  id: string;
  kind: CodingChatKind;
  title: string;
  /** The worktree (absolute): the program's working directory. */
  cwd: string;
  /** The Coding app's project and worktree it belongs to. */
  workspaceId?: string;
  branch?: string;
  /** The member who opened it (their CLI account runs it); undefined on a personal installation. */
  owner?: string;
  /** The CLI account of the last turn. */
  account?: string;
  /** The program's conversation (Claude session id, Codex thread id): every turn resumes it. */
  runtimeSessionId?: string;
  model?: string;
  status: CodingChatStatus;
  lastError?: string;
  errorKind?: CodingChatErrorKind;
  messages: CodingChatMessage[];
  approvals: CodingChatApproval[];
  usage: CodingChatUsage;
  costUsd: number;
  turns: number;
  /** Opened from a terminal session of the Coding app ("Open as chat"): what it continues. */
  continuedFrom?: CodingChatContinuation;
  createdAt: string;
  updatedAt: string;
}

/**
 * A chat continuing a terminal session: the program's conversation is resumed when its id is known
 * (Claude Code: the terminal's --session-id) and the opener's account can read it; otherwise the
 * chat starts a new conversation in the same worktree, and the note says why.
 */
export interface CodingChatContinuation {
  terminalId: string;
  label?: string;
  /** The program's conversation the chat resumes (Claude Code's session id). */
  resumeSessionId?: string;
  /** pending: not tried yet; resumed: the first turn continued it; new: a new conversation started. */
  status: "pending" | "resumed" | "new";
  /** What the chat shows first ("Continued from terminal session …"). */
  note: string;
}

/** A session without its transcript (lists). */
export type CodingChatSummary = Omit<CodingChatSession, "messages" | "approvals"> & {
  messageCount: number;
  pendingApprovals: number;
  /** The last thing said (one line). */
  preview?: string;
};

/** What a session's live stream carries. */
export type CodingChatEvent =
  | { type: "session"; session: CodingChatSummary }
  | { type: "message"; message: CodingChatMessage }
  | { type: "approval"; approval: CodingChatApproval }
  /** The program changed files in the worktree (an edit, a command): the changes panel refreshes. */
  | { type: "files-changed"; tool: string }
  | { type: "deleted" };

export const ZERO_CODING_USAGE: CodingChatUsage = Object.freeze({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 });
