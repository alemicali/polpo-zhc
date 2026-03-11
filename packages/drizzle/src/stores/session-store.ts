import { eq, desc, asc, count as drizzleCount, isNull, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { SessionStore, Session, Message, MessageRole, ToolCallInfo } from "@polpo-ai/core/session-store";
import { type Dialect, deserializeJson } from "../utils.js";

type AnyTable = any;

export class DrizzleSessionStore implements SessionStore {
  constructor(
    private db: any,
    private sessions: AnyTable,
    private messages: AnyTable,
    private dialect: Dialect,
  ) {}

  private rowToSession(row: any, messageCount: number): Session {
    return {
      id: row.id,
      title: row.title ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      messageCount,
      ...(row.agent ? { agent: row.agent } : {}),
    };
  }

  private rowToMessage(row: any): Message {
    return {
      id: row.id,
      role: row.role as MessageRole,
      content: row.content,
      ts: row.ts,
      toolCalls: deserializeJson<ToolCallInfo[] | undefined>(row.toolCalls, undefined, this.dialect),
    };
  }

  async create(title?: string, agent?: string): Promise<string> {
    const id = nanoid(10);
    const now = new Date().toISOString();
    await this.db.insert(this.sessions).values({
      id,
      title: title ?? null,
      agent: agent ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  async addMessage(sessionId: string, role: MessageRole, content: string): Promise<Message> {
    const id = nanoid();
    const ts = new Date().toISOString();
    await this.db.insert(this.messages).values({
      id,
      sessionId,
      role,
      content,
      ts,
      toolCalls: null,
    });
    await this.db.update(this.sessions)
      .set({ updatedAt: ts })
      .where(eq(this.sessions.id, sessionId));

    return { id, role, content, ts };
  }

  async updateMessage(sessionId: string, messageId: string, content: string, toolCalls?: ToolCallInfo[]): Promise<boolean> {
    const now = new Date().toISOString();
    const tcValue = toolCalls
      ? (this.dialect === "sqlite" ? JSON.stringify(toolCalls) : toolCalls)
      : null;

    const result = await this.db.update(this.messages)
      .set({ content, toolCalls: tcValue })
      .where(eq(this.messages.id, messageId));

    const changed = (result?.rowCount ?? result?.changes ?? 0) > 0;
    if (changed) {
      await this.db.update(this.sessions)
        .set({ updatedAt: now })
        .where(eq(this.sessions.id, sessionId));
    }
    return changed;
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    const rows: any[] = await this.db.select().from(this.messages)
      .where(eq(this.messages.sessionId, sessionId))
      .orderBy(asc(this.messages.ts));
    return rows.map((r) => this.rowToMessage(r));
  }

  async getRecentMessages(sessionId: string, limit: number): Promise<Message[]> {
    const rows: any[] = await this.db.select().from(this.messages)
      .where(eq(this.messages.sessionId, sessionId))
      .orderBy(desc(this.messages.ts))
      .limit(limit);
    return rows.reverse().map((r) => this.rowToMessage(r));
  }

  async listSessions(): Promise<Session[]> {
    const rows: any[] = await this.db
      .select({
        id: this.sessions.id,
        title: this.sessions.title,
        agent: this.sessions.agent,
        createdAt: this.sessions.createdAt,
        updatedAt: this.sessions.updatedAt,
        messageCount: drizzleCount(this.messages.id),
      })
      .from(this.sessions)
      .leftJoin(this.messages, eq(this.sessions.id, this.messages.sessionId))
      .groupBy(this.sessions.id)
      .orderBy(desc(this.sessions.updatedAt));

    return rows.map((r) => this.rowToSession(r, Number(r.messageCount)));
  }

  async getSession(sessionId: string): Promise<Session | undefined> {
    const rows: any[] = await this.db
      .select({
        id: this.sessions.id,
        title: this.sessions.title,
        agent: this.sessions.agent,
        createdAt: this.sessions.createdAt,
        updatedAt: this.sessions.updatedAt,
        messageCount: drizzleCount(this.messages.id),
      })
      .from(this.sessions)
      .leftJoin(this.messages, eq(this.sessions.id, this.messages.sessionId))
      .where(eq(this.sessions.id, sessionId))
      .groupBy(this.sessions.id);

    return rows.length > 0 ? this.rowToSession(rows[0], Number(rows[0].messageCount)) : undefined;
  }

  async getLatestSession(agent?: string | null): Promise<Session | undefined> {
    let query = this.db
      .select({
        id: this.sessions.id,
        title: this.sessions.title,
        agent: this.sessions.agent,
        createdAt: this.sessions.createdAt,
        updatedAt: this.sessions.updatedAt,
        messageCount: drizzleCount(this.messages.id),
      })
      .from(this.sessions)
      .leftJoin(this.messages, eq(this.sessions.id, this.messages.sessionId));

    // Filter by agent scope
    if (agent === null) {
      // Orchestrator sessions only (no agent)
      query = query.where(isNull(this.sessions.agent));
    } else if (agent !== undefined) {
      // Agent-specific sessions
      query = query.where(eq(this.sessions.agent, agent));
    }
    // agent === undefined → no filter, return most recent regardless

    const rows: any[] = await query
      .groupBy(this.sessions.id)
      .orderBy(desc(this.sessions.updatedAt))
      .limit(1);

    return rows.length > 0 ? this.rowToSession(rows[0], Number(rows[0].messageCount)) : undefined;
  }

  async renameSession(sessionId: string, title: string): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.db.update(this.sessions)
      .set({ title, updatedAt: now })
      .where(eq(this.sessions.id, sessionId));
    return (result?.rowCount ?? result?.changes ?? 0) > 0;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    // Messages are cascade-deleted via FK
    const result = await this.db.delete(this.sessions)
      .where(eq(this.sessions.id, sessionId));
    return (result?.rowCount ?? result?.changes ?? 0) > 0;
  }

  async prune(keepSessions: number): Promise<number> {
    const all: any[] = await this.db.select({ id: this.sessions.id })
      .from(this.sessions)
      .orderBy(desc(this.sessions.updatedAt));

    if (all.length <= keepSessions) return 0;

    const toDelete = all.slice(keepSessions).map((r) => r.id);
    let deleted = 0;
    for (const id of toDelete) {
      await this.db.delete(this.sessions).where(eq(this.sessions.id, id));
      deleted++;
    }
    return deleted;
  }

  async close(): Promise<void> {
    // Connection lifecycle managed externally
  }
}
