import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type {
  CodingSessionState,
  CodingSessionStore,
  CodingCodeServerSession,
  CodingTerminal,
  CodingWorkspace,
} from "../core/coding-session-store.js";

/**
 * File-backed CodingSessionStore.
 *
 * Persists the Coding page workspace/session model in `.polpo/coding-sessions.json`.
 * This is operational UI state tied to the project, so it stays out of polpo.json.
 */
export class FileCodingSessionStore implements CodingSessionStore {
  private readonly filePath: string;

  constructor(private readonly polpoDir: string) {
    this.filePath = join(polpoDir, "coding-sessions.json");
  }

  async getState(): Promise<{ state: CodingSessionState; initialized: boolean }> {
    if (!existsSync(this.filePath)) {
      return { state: defaultCodingSessionState(), initialized: false };
    }

    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf-8"));
      return { state: normalizeCodingSessionState(parsed), initialized: true };
    } catch {
      return { state: defaultCodingSessionState(), initialized: false };
    }
  }

  async saveState(state: CodingSessionState): Promise<CodingSessionState> {
    if (!existsSync(this.polpoDir)) mkdirSync(this.polpoDir, { recursive: true });
    const normalized = normalizeCodingSessionState(state);
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(normalized, null, 2), "utf-8");
    renameSync(tmp, this.filePath);
    return normalized;
  }
}

function defaultCodingSessionState(): CodingSessionState {
  const workspaceId = `workspace_${nanoid(8)}`;
  const terminalId = `terminal_${nanoid(8)}`;
  return {
    workspaces: [{ id: workspaceId, name: "Workspace", cwd: "." }],
    terminals: [{ id: terminalId, workspaceId, label: "", revision: 0 }],
    codeServers: [],
    activeId: terminalId,
  };
}

function normalizeCodingSessionState(value: unknown): CodingSessionState {
  if (!value || typeof value !== "object") return defaultCodingSessionState();
  const record = value as Record<string, unknown>;
  const workspaces = Array.isArray(record.workspaces)
    ? record.workspaces.map(normalizeWorkspace).filter(Boolean) as CodingWorkspace[]
    : [];
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const terminals = Array.isArray(record.terminals)
    ? record.terminals.map((terminal) => normalizeTerminal(terminal, workspaceIds)).filter(Boolean) as CodingTerminal[]
    : [];
  const codeServers = Array.isArray(record.codeServers)
    ? record.codeServers.map((session) => normalizeCodeServerSession(session, workspaceIds)).filter(Boolean) as CodingCodeServerSession[]
    : [];

  if (workspaces.length === 0 || terminals.length === 0) return defaultCodingSessionState();

  const activeId = typeof record.activeId === "string" && terminals.some((terminal) => terminal.id === record.activeId)
    ? record.activeId
    : terminals[0].id;

  return { workspaces, terminals, codeServers, activeId };
}

function normalizeWorkspace(value: unknown): CodingWorkspace | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  return {
    id: record.id,
    name: typeof record.name === "string" && record.name.trim() ? record.name : "Workspace",
    cwd: typeof record.cwd === "string" && record.cwd.trim() ? record.cwd : ".",
  };
}

function normalizeTerminal(value: unknown, workspaceIds: Set<string>): CodingTerminal | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  if (typeof record.workspaceId !== "string" || !workspaceIds.has(record.workspaceId)) return null;
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    label: typeof record.label === "string" ? record.label : typeof record.name === "string" ? record.name : "",
    revision: typeof record.revision === "number" && Number.isFinite(record.revision) ? record.revision : 0,
    ...(typeof record.agentKind === "string" && (record.agentKind === "claude" || record.agentKind === "codex" || record.agentKind === "terminal")
      ? { agentKind: record.agentKind }
      : {}),
    ...(typeof record.agentSessionId === "string" && record.agentSessionId ? { agentSessionId: record.agentSessionId } : {}),
    ...(typeof record.agentCommand === "string" && record.agentCommand ? { agentCommand: record.agentCommand } : {}),
    ...(typeof record.cwdOverride === "string" && record.cwdOverride ? { cwdOverride: record.cwdOverride } : {}),
    ...(typeof record.branch === "string" && record.branch ? { branch: record.branch } : {}),
  };
}

function normalizeCodeServerSession(value: unknown, workspaceIds: Set<string>): CodingCodeServerSession | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  if (typeof record.workspaceId !== "string" || !workspaceIds.has(record.workspaceId)) return null;
  const now = new Date().toISOString();
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    cwd: typeof record.cwd === "string" && record.cwd.trim() ? record.cwd : ".",
    createdAt: typeof record.createdAt === "string" ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : now,
  };
}
