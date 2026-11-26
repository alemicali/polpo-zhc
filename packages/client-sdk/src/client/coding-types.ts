// ── Coding chats (Claude Code / Codex sessions in a worktree, on the person's own CLI account) ────

export type CodingChatKind = "claude" | "codex";
/** idle: waiting for a message; running: a turn is on; awaiting-approval: a risky action waits for the owner; error: the last turn failed. */
export type CodingChatStatus = "idle" | "running" | "awaiting-approval" | "error";
/** Why a turn could not run (no-account: sign in from Settings → Harnesses → CLI accounts). */
export type CodingChatErrorKind = "no-account" | "not-allowed" | "not-signed-in" | "usage-limit" | "not-installed" | "interrupted" | "other";
export type CodingRiskCategory = "network-install" | "network" | "git-push" | "outside-worktree" | "privileged" | "unknown-tool";

export interface CodingChatToolCall {
  id: string;
  /** The program's own tool (Edit, Bash, Read… / shell, apply_patch…). */
  name: string;
  input?: Record<string, unknown>;
  output?: string;
  /** Edits: a unified diff of the change. */
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
  text?: string;
  kind?: "prompt" | "steer";
  segments?: CodingChatSegment[];
  streaming?: boolean;
  model?: string;
  usage?: CodingChatUsage;
  costUsd?: number;
  error?: string;
  errorKind?: CodingChatErrorKind;
}

export interface CodingChatApproval {
  id: string;
  tool: string;
  toolUseId?: string;
  input?: unknown;
  summary: string;
  reason: string;
  category: CodingRiskCategory;
  state: "pending" | "approved" | "denied" | "expired";
  requestedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

interface CodingChatBase {
  id: string;
  kind: CodingChatKind;
  title: string;
  /** The worktree: the program's working directory. */
  cwd: string;
  workspaceId?: string;
  branch?: string;
  /** The member whose CLI account runs it. */
  owner?: string;
  account?: string;
  runtimeSessionId?: string;
  model?: string;
  status: CodingChatStatus;
  lastError?: string;
  errorKind?: CodingChatErrorKind;
  usage: CodingChatUsage;
  /** The CLI's own estimate (the plan pays). */
  costUsd: number;
  turns: number;
  createdAt: string;
  updatedAt: string;
}

export interface CodingChatSession extends CodingChatBase {
  messages: CodingChatMessage[];
  approvals: CodingChatApproval[];
}

export interface CodingChatSummary extends CodingChatBase {
  messageCount: number;
  pendingApprovals: number;
  preview?: string;
}

export interface CodingChatCreateRequest {
  kind: CodingChatKind;
  cwd: string;
  title?: string;
  workspaceId?: string;
  branch?: string;
  account?: string;
  model?: string;
  /** The first message: the turn starts at once. */
  prompt?: string;
}

export interface CodingChatAccountInfo {
  kind: CodingChatKind;
  account?: { id: string; owner: string; label?: string };
  problem?: string;
  code?: string;
  /** Where to add an account and sign in (a dashboard path). */
  signInUrl: string;
}

/** A coding chat's live events (GET /coding/chats/{id}/events). */
export type CodingChatEvent =
  | { type: "session"; session: CodingChatSummary }
  | { type: "message"; message: CodingChatMessage }
  | { type: "approval"; approval: CodingChatApproval }
  | { type: "files-changed"; tool: string }
  | { type: "deleted" };
