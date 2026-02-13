import { createDatabase } from "./sqlite-compat.js";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { nanoid } from "nanoid";
import type { SessionStore, Session, Message, MessageRole } from "../core/session-store.js";

interface SessionRow {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  message_count?: number;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  ts: string;
}

export class SqliteSessionStore implements SessionStore {
  private db: any;

  private createSessionStmt: any;
  private addMessageStmt: any;
  private updateSessionStmt: any;
  private getMessagesStmt: any;
  private getRecentMessagesStmt: any;
  private listSessionsStmt: any;
  private getSessionStmt: any;
  private getLatestSessionStmt: any;
  private deleteSessionStmt: any;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = createDatabase(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.initSchema();

    this.createSessionStmt = this.db.prepare(`
      INSERT INTO sessions (id, title, created_at, updated_at)
      VALUES (@id, @title, @created_at, @updated_at)
    `);

    this.addMessageStmt = this.db.prepare(`
      INSERT INTO messages (id, session_id, role, content, ts)
      VALUES (@id, @session_id, @role, @content, @ts)
    `);

    this.updateSessionStmt = this.db.prepare(`
      UPDATE sessions SET updated_at = @updated_at WHERE id = @id
    `);

    this.getMessagesStmt = this.db.prepare(`
      SELECT * FROM messages WHERE session_id = ? ORDER BY ts ASC
    `);

    this.getRecentMessagesStmt = this.db.prepare(`
      SELECT * FROM messages WHERE session_id = ? ORDER BY ts DESC LIMIT ?
    `);

    this.listSessionsStmt = this.db.prepare(`
      SELECT s.id, s.title, s.created_at, s.updated_at, COUNT(m.id) as message_count
      FROM sessions s LEFT JOIN messages m ON s.id = m.session_id
      GROUP BY s.id ORDER BY s.updated_at DESC
    `);

    this.getSessionStmt = this.db.prepare(`
      SELECT s.id, s.title, s.created_at, s.updated_at, COUNT(m.id) as message_count
      FROM sessions s LEFT JOIN messages m ON s.id = m.session_id
      WHERE s.id = ?
      GROUP BY s.id
    `);

    this.getLatestSessionStmt = this.db.prepare(`
      SELECT s.id, s.title, s.created_at, s.updated_at, COUNT(m.id) as message_count
      FROM sessions s LEFT JOIN messages m ON s.id = m.session_id
      GROUP BY s.id ORDER BY s.updated_at DESC LIMIT 1
    `);

    this.deleteSessionStmt = this.db.prepare(`DELETE FROM sessions WHERE id = ?`);
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        ts TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ts);
    `);
  }

  private rowToSession(row: SessionRow): Session {
    return {
      id: row.id,
      title: row.title ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: row.message_count ?? 0,
    };
  }

  private rowToMessage(row: MessageRow): Message {
    return {
      id: row.id,
      role: row.role as MessageRole,
      content: row.content,
      ts: row.ts,
    };
  }

  create(title?: string): string {
    const id = nanoid(10);
    const now = new Date().toISOString();
    this.createSessionStmt.run({
      id,
      title: title ?? null,
      created_at: now,
      updated_at: now,
    });
    return id;
  }

  addMessage(sessionId: string, role: MessageRole, content: string): Message {
    const id = nanoid(10);
    const ts = new Date().toISOString();
    this.addMessageStmt.run({
      id,
      session_id: sessionId,
      role,
      content,
      ts,
    });
    this.updateSessionStmt.run({
      id: sessionId,
      updated_at: ts,
    });
    return { id, role, content, ts };
  }

  getMessages(sessionId: string): Message[] {
    const rows = this.getMessagesStmt.all(sessionId) as MessageRow[];
    return rows.map(r => this.rowToMessage(r));
  }

  getRecentMessages(sessionId: string, limit: number): Message[] {
    const rows = this.getRecentMessagesStmt.all(sessionId, limit) as MessageRow[];
    return rows.reverse().map(r => this.rowToMessage(r));
  }

  listSessions(): Session[] {
    const rows = this.listSessionsStmt.all() as SessionRow[];
    return rows.map(r => this.rowToSession(r));
  }

  getSession(sessionId: string): Session | undefined {
    const row = this.getSessionStmt.get(sessionId) as SessionRow | undefined;
    return row ? this.rowToSession(row) : undefined;
  }

  getLatestSession(): Session | undefined {
    const row = this.getLatestSessionStmt.get() as SessionRow | undefined;
    return row ? this.rowToSession(row) : undefined;
  }

  deleteSession(sessionId: string): boolean {
    const result = this.deleteSessionStmt.run(sessionId);
    return result.changes > 0;
  }

  prune(keepSessions: number): number {
    const allSessions = this.db.prepare(`
      SELECT id FROM sessions ORDER BY updated_at ASC
    `).all() as { id: string }[];

    const toDelete = allSessions.slice(0, Math.max(0, allSessions.length - keepSessions));
    let deleted = 0;
    for (const { id } of toDelete) {
      if (this.deleteSession(id)) {
        deleted++;
      }
    }
    return deleted;
  }

  close(): void {
    this.db.close();
  }
}
