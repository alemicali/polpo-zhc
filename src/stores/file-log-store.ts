import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { LogStore, LogEntry, SessionInfo } from "../core/log-store.js";

/**
 * File-backed LogStore.
 * Writes JSONL files to `.polpo/logs/`, one per session.
 *
 * File naming: `{sessionId}.jsonl`
 * First line of each file: `{"_session":true,"sessionId":"...","startedAt":"..."}`
 */
export class FileLogStore implements LogStore {
  private readonly logsDir: string;
  private sessionId?: string;

  constructor(polpoDir: string) {
    this.logsDir = join(polpoDir, "logs");
  }

  async startSession(): Promise<string> {
    if (!existsSync(this.logsDir)) {
      mkdirSync(this.logsDir, { recursive: true });
    }
    this.sessionId = nanoid(10);
    const header = JSON.stringify({
      _session: true,
      sessionId: this.sessionId,
      startedAt: new Date().toISOString(),
    });
    appendFileSync(this.sessionFile(this.sessionId), header + "\n", "utf-8");
    return this.sessionId;
  }

  async getSessionId(): Promise<string | undefined> {
    return this.sessionId;
  }

  async append(entry: LogEntry): Promise<void> {
    if (!this.sessionId) return;
    try {
      const line = JSON.stringify(entry);
      appendFileSync(this.sessionFile(this.sessionId), line + "\n", "utf-8");
    } catch { /* best-effort: non-critical */
    }
  }

  async getSessionEntries(sessionId?: string): Promise<LogEntry[]> {
    const sid = sessionId ?? this.sessionId;
    if (!sid) return [];
    const file = this.sessionFile(sid);
    if (!existsSync(file)) return [];
    try {
      const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
      const entries: LogEntry[] = [];
      for (const line of lines) {
        const obj = JSON.parse(line);
        // Skip session header
        if (obj._session) continue;
        entries.push(obj as LogEntry);
      }
      return entries;
    } catch { /* unreadable log file */
      return [];
    }
  }

  async listSessions(): Promise<SessionInfo[]> {
    if (!existsSync(this.logsDir)) return [];
    const files = readdirSync(this.logsDir)
      .filter(f => f.endsWith(".jsonl"))
      .sort()
      .reverse(); // most recent first (nanoid is not time-sorted, so use file mtime)

    // Sort by modification time (most recent first)
    const withMtime = files.map(f => ({
      file: f,
      mtime: statSync(join(this.logsDir, f)).mtimeMs,
    }));
    withMtime.sort((a, b) => b.mtime - a.mtime);

    const sessions: SessionInfo[] = [];
    for (const { file } of withMtime) {
      const filePath = join(this.logsDir, file);
      try {
        const content = readFileSync(filePath, "utf-8");
        const lines = content.split("\n").filter(Boolean);
        const header = JSON.parse(lines[0]);
        sessions.push({
          sessionId: header.sessionId ?? file.replace(".jsonl", ""),
          startedAt: header.startedAt ?? new Date(statSync(filePath).mtimeMs).toISOString(),
          entries: lines.length - 1, // exclude header
        });
      } catch { /* skip corrupt file */
      }
    }
    return sessions;
  }

  async prune(keepSessions: number): Promise<number> {
    const sessions = await this.listSessions();
    if (sessions.length <= keepSessions) return 0;
    const toRemove = sessions.slice(keepSessions);
    let removed = 0;
    for (const s of toRemove) {
      // Don't prune current session
      if (s.sessionId === this.sessionId) continue;
      try {
        unlinkSync(this.sessionFile(s.sessionId));
        removed++;
      } catch { /* file already removed */ }
    }
    return removed;
  }

  async close(): Promise<void> {
    // No resources to release for file-based store
    this.sessionId = undefined;
  }

  private sessionFile(sessionId: string): string {
    return join(this.logsDir, `${sessionId}.jsonl`);
  }
}
