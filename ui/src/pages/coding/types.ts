export type ConnectionState = "loading" | "connecting" | "connected" | "closed" | "error";

export type CodingWorkspace = {
  id: string;
  name: string;
  cwd: string;
};

export type CodingAgentKind = "terminal" | "claude" | "codex";

export type CodingCapabilities = {
  agents: Record<CodingAgentKind, {
    available: boolean;
    command: string;
  }>;
  terminal: {
    enabled: boolean;
    available: boolean;
    shell: string;
  };
  codeServer: {
    enabled: boolean;
    available: boolean;
    bin: string;
  };
};

export type CodingTerminal = {
  id: string;
  workspaceId: string;
  /** Optional user-given label. Falls back to git branch / cwd in the UI. */
  label: string;
  revision: number;
  /** Which coding agent runs in this terminal — defaults to a raw shell. */
  agentKind?: CodingAgentKind;
  /** Stable id used by the agent CLI for `--continue` / `--resume`. */
  agentSessionId?: string;
  /** Override cwd — set when the terminal lives inside a dedicated worktree. */
  cwdOverride?: string;
  /** Branch checked out in this terminal's worktree, if it owns one. */
  branch?: string;
};

export type CodingCodeServerSession = {
  id: string;
  workspaceId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
};

export type GitPullRequest = {
  number: number;
  title: string;
  url: string;
  state?: string;
};

export type GitFile = {
  path: string;
  /** Single-char status: M, A, D, R, C, U, ? */
  status: string;
  insertions: number;
  deletions: number;
  staged: boolean;
};

export type GitInfo = {
  branch: string | null;
  repo: string | null;
  ahead: number;
  behind: number;
  insertions: number;
  deletions: number;
  filesChanged: number;
  dirty: boolean;
  pr: GitPullRequest | null;
};
