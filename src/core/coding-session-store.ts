export interface CodingWorkspace {
  id: string;
  name: string;
  cwd: string;
}

/** Coding agent CLI launched inside the terminal session. */
export type CodingAgentKind = "terminal" | "claude" | "codex";

export interface CodingTerminal {
  id: string;
  workspaceId: string;
  /** Optional user-given label. The UI can fall back to branch/cwd when empty. */
  label: string;
  /** Client-side bump used to restart the terminal session. */
  revision: number;
  /** Which coding agent runs in this terminal — defaults to a raw shell. */
  agentKind?: CodingAgentKind;
  /** Stable id used by the agent CLI for `--continue` / `--resume` semantics. */
  agentSessionId?: string;
  /** Override the shell command for this session — set by the workspace
   * "PR" button so it can pin a one-shot prompt. */
  agentCommand?: string;
  /** Override cwd — set when the terminal lives inside a dedicated worktree. */
  cwdOverride?: string;
  /** Branch checked out in this terminal's worktree, if it owns a worktree. */
  branch?: string;
}

export interface CodingCodeServerSession {
  id: string;
  workspaceId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodingSessionState {
  workspaces: CodingWorkspace[];
  terminals: CodingTerminal[];
  codeServers: CodingCodeServerSession[];
  activeId: string;
}

export interface CodingSessionStore {
  getState(): Promise<{ state: CodingSessionState; initialized: boolean }>;
  saveState(state: CodingSessionState): Promise<CodingSessionState>;
}
