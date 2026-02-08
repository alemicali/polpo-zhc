/**
 * Persistent log storage — captures orchestrator events across sessions.
 * Lives at the core level, independent of TUI or CLI.
 */

export interface LogEntry {
  ts: string;       // ISO timestamp
  event: string;    // event name (e.g. "task:created", "agent:spawned")
  data: unknown;    // event payload (serializable)
}

export interface SessionInfo {
  sessionId: string;
  startedAt: string;
  entries: number;
}

export interface LogStore {
  /** Start a new logging session. Returns session ID. */
  startSession(): string;
  /** Get current session ID (undefined if not started). */
  getSessionId(): string | undefined;
  /** Append a log entry to the current session. */
  append(entry: LogEntry): void;
  /** Read entries for a session (default: current). */
  getSessionEntries(sessionId?: string): LogEntry[];
  /** List all sessions, most recent first. */
  listSessions(): SessionInfo[];
  /** Remove old sessions, keeping the most recent N. Returns number pruned. */
  prune(keepSessions: number): number;
  /** Flush/close. */
  close(): void;
}
