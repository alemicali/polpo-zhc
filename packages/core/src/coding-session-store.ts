export interface CodingWorkspace {
  id: string;
  name: string;
  cwd: string;
}

export interface CodingTerminal {
  id: string;
  workspaceId: string;
  /** Optional user-given label. The UI can fall back to branch/cwd when empty. */
  label: string;
  /** Client-side bump used to restart the terminal session. */
  revision: number;
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
