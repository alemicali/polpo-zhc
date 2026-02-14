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
import type { SessionStore, Session, Message, MessageRole } from "../core/session-store.js";

/**
 * File-backed SessionStore.
 * Writes JSONL files to `.polpo/sessions/`, one per session.
 *
 * File naming: `{sessionId}.jsonl`
 * First line of each file: `{"_session":true,"id":"...","title":"...","createdAt":"..."}`
 */
export class FileSessionStore implements SessionStore {
  private readonly sessionsDir: string;

  constructor(orchestraDir: string) {
    this.sessionsDir = join(orchestraDir, "sessions");
  }

  create(title?: string): string {
    if (!existsSync(this.sessionsDir)) {
      mkdirSync(this.sessionsDir, { recursive: true });
    }
    const sessionId = nanoid(10);
    const header = JSON.stringify({
      _session: true,
      id: sessionId,
      title,
      createdAt: new Date().toISOString(),
    });
    try {
      appendFileSync(this.sessionFile(sessionId), header + "\n", "utf-8");
    } catch { /* best-effort: non-critical */
    }
    return sessionId;
  }

  addMessage(sessionId: string, role: MessageRole, content: string): Message {
    const message: Message = {
      id: nanoid(10),
      role,
      content,
      ts: new Date().toISOString(),
    };
    try {
      const line = JSON.stringify(message);
      appendFileSync(this.sessionFile(sessionId), line + "\n", "utf-8");
    } catch { /* best-effort: non-critical */
    }
    return message;
  }

  getMessages(sessionId: string): Message[] {
    const file = this.sessionFile(sessionId);
    if (!existsSync(file)) return [];
    try {
      const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
      const messages: Message[] = [];
      for (const line of lines) {
        const obj = JSON.parse(line);
        // Skip session header
        if (obj._session) continue;
        messages.push(obj as Message);
      }
      return messages;
    } catch { /* unreadable session file */
      return [];
    }
  }

  getRecentMessages(sessionId: string, limit: number): Message[] {
    const messages = this.getMessages(sessionId);
    return messages.slice(-limit);
  }

  listSessions(): Session[] {
    if (!existsSync(this.sessionsDir)) return [];
    const files = readdirSync(this.sessionsDir)
      .filter(f => f.endsWith(".jsonl"));

    // Sort by modification time (most recent first)
    const withMtime = files.map(f => ({
      file: f,
      mtime: statSync(join(this.sessionsDir, f)).mtimeMs,
    }));
    withMtime.sort((a, b) => b.mtime - a.mtime);

    const sessions: Session[] = [];
    for (const { file } of withMtime) {
      const filePath = join(this.sessionsDir, file);
      try {
        const content = readFileSync(filePath, "utf-8");
        const lines = content.split("\n").filter(Boolean);
        const header = JSON.parse(lines[0]);
        const messageCount = lines.length - 1; // exclude header
        const updatedAt = new Date(statSync(filePath).mtimeMs).toISOString();
        sessions.push({
          id: header.id ?? file.replace(".jsonl", ""),
          title: header.title,
          createdAt: header.createdAt ?? updatedAt,
          updatedAt,
          messageCount,
        });
      } catch { /* skip corrupt file */
      }
    }
    return sessions;
  }

  getSession(sessionId: string): Session | undefined {
    const file = this.sessionFile(sessionId);
    if (!existsSync(file)) return undefined;
    try {
      const content = readFileSync(file, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      const header = JSON.parse(lines[0]);
      const messageCount = lines.length - 1; // exclude header
      const updatedAt = new Date(statSync(file).mtimeMs).toISOString();
      return {
        id: header.id ?? sessionId,
        title: header.title,
        createdAt: header.createdAt ?? updatedAt,
        updatedAt,
        messageCount,
      };
    } catch { /* unreadable session file */
      return undefined;
    }
  }

  getLatestSession(): Session | undefined {
    const sessions = this.listSessions();
    return sessions[0];
  }

  deleteSession(sessionId: string): boolean {
    const file = this.sessionFile(sessionId);
    if (!existsSync(file)) return false;
    try {
      unlinkSync(file);
      return true;
    } catch { /* file already removed */
      return false;
    }
  }

  prune(keepSessions: number): number {
    const sessions = this.listSessions();
    if (sessions.length <= keepSessions) return 0;
    const toRemove = sessions.slice(keepSessions);
    let removed = 0;
    for (const s of toRemove) {
      try {
        unlinkSync(this.sessionFile(s.id));
        removed++;
      } catch { /* file already removed */ }
    }
    return removed;
  }

  close(): void {
    // No resources to release for file-based store
  }

  private sessionFile(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.jsonl`);
  }
}
