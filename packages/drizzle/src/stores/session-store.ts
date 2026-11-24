import { eq, desc, asc, count as drizzleCount, isNull, and, gte, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { CreateSessionOptions, ForkSessionOptions, ForkSessionResult, MessageSearchHit, MessageSearchQuery, SessionStore, Session, Message, MessageSegment, MessageRole, ToolCallInfo } from "@polpo-ai/core/session-store";
import { type Dialect, deserializeJson, affectedRows, pgSafe } from "../utils.js";

type AnyTable = any;

/** Characters of a message returned by searchMessages (enough for a snippet around the match). */
const SEARCH_CONTENT_CHARS = 4000;

/** A search term as the full-text syntaxes accept it: letters and digits only (no operators, quotes). */
function ftsTerm(term: string): string {
  return term.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

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
      ...(row.starred ? { starred: true } : {}),
      ...(row.scope ? { scope: row.scope } : {}),
      ...(row.parentSessionId ? { parentSessionId: row.parentSessionId } : {}),
      ...(row.forkMessageId ? { forkMessageId: row.forkMessageId } : {}),
    };
  }

  /** Columns of a session summary (the message count is joined in). */
  private summaryColumns() {
    return {
      id: this.sessions.id,
      title: this.sessions.title,
      agent: this.sessions.agent,
      createdAt: this.sessions.createdAt,
      updatedAt: this.sessions.updatedAt,
      starred: this.sessions.starred,
      scope: this.sessions.scope,
      parentSessionId: this.sessions.parentSessionId,
      forkMessageId: this.sessions.forkMessageId,
      messageCount: drizzleCount(this.messages.id),
    };
  }

  /**
   * Message order: by timestamp, then user before assistant, then id. Messages saved in the same
   * millisecond exist (a question and its answer stored together): ordered by timestamp alone they
   * come back in any order (Postgres does not keep ties stable), which reshuffles the conversation
   * sent to the model and invalidates its compaction checkpoint at every turn.
   */
  private messageOrder(direction: "asc" | "desc"): any[] {
    const m = this.messages;
    const rank = sql`case when ${m.role} = 'user' then 0 else 1 end`;
    // byte order on both dialects (Postgres would otherwise compare ids with the locale's collation)
    const id = this.dialect === "pg" ? sql`${m.id} collate "C"` : m.id;
    const by = direction === "asc" ? asc : desc;
    return [by(m.ts), by(rank), by(id)];
  }

  /**
   * Now, or 1 ms after the session's latest message when that is not earlier: messages added one
   * after the other never share a timestamp, so they keep the order they were added in.
   */
  private async nextMessageTs(sessionId: string): Promise<string> {
    const now = Date.now();
    const last: any[] = await this.db.select({ ts: this.messages.ts }).from(this.messages)
      .where(eq(this.messages.sessionId, sessionId))
      .orderBy(desc(this.messages.ts))
      .limit(1);
    const lastMs = last[0] ? Date.parse(last[0].ts) : NaN;
    return new Date(Number.isFinite(lastMs) && lastMs >= now ? lastMs + 1 : now).toISOString();
  }

  private rowToMessage(row: any): Message {
    return {
      id: row.id,
      role: row.role as MessageRole,
      content: row.content,
      ts: row.ts,
      toolCalls: deserializeJson<ToolCallInfo[] | undefined>(row.toolCalls, undefined, this.dialect),
      segments: deserializeJson<MessageSegment[] | undefined>(row.segments, undefined, this.dialect),
    };
  }

  async create(title?: string, agent?: string, opts?: CreateSessionOptions): Promise<string> {
    const id = nanoid(10);
    const now = new Date().toISOString();
    await this.db.insert(this.sessions).values({
      id,
      title: title ?? null,
      agent: agent ?? null,
      createdAt: now,
      updatedAt: now,
      scope: opts?.scope ?? null,
    });
    return id;
  }

  async addMessage(sessionId: string, role: MessageRole, content: string, toolCalls?: ToolCallInfo[], segments?: MessageSegment[]): Promise<Message> {
    const id = nanoid();
    const ts = await this.nextMessageTs(sessionId);
    const tcValue = toolCalls && toolCalls.length > 0 ? JSON.stringify(toolCalls) : null;
    const segmentsValue = segments && segments.length > 0 ? JSON.stringify(segments) : null;
    const storedContent = this.dialect === "pg" ? pgSafe(content) : content;
    await this.db.insert(this.messages).values({
      id,
      sessionId,
      role,
      content: storedContent,
      ts,
      toolCalls: tcValue,
      segments: segmentsValue,
    });
    await this.db.update(this.sessions)
      .set({ updatedAt: ts })
      .where(eq(this.sessions.id, sessionId));

    return {
      id,
      role,
      content,
      ts,
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
      ...(segments && segments.length > 0 ? { segments } : {}),
    };
  }

  async updateMessage(sessionId: string, messageId: string, content: string, toolCalls?: ToolCallInfo[], segments?: MessageSegment[]): Promise<boolean> {
    const now = new Date().toISOString();
    const tcValue = toolCalls && toolCalls.length > 0 ? JSON.stringify(toolCalls) : null;
    const segmentsValue = segments && segments.length > 0 ? JSON.stringify(segments) : null;

    const result = await this.db.update(this.messages)
      .set({ content: this.dialect === "pg" ? pgSafe(content) : content, toolCalls: tcValue, segments: segmentsValue })
      .where(eq(this.messages.id, messageId));

    const changed = affectedRows(result) > 0;
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
      .orderBy(...this.messageOrder("asc"));
    return rows.map((r) => this.rowToMessage(r));
  }

  async getMessagesAfter(sessionId: string, messageId: string): Promise<Message[] | undefined> {
    const m = this.messages;
    const anchor: any[] = await this.db.select({ ts: m.ts }).from(m)
      .where(and(eq(m.sessionId, sessionId), eq(m.id, messageId)));
    if (anchor.length === 0) return undefined;
    // From the anchor's timestamp on (ties included), then cut after the anchor itself.
    const rows: any[] = await this.db.select().from(m)
      .where(and(eq(m.sessionId, sessionId), gte(m.ts, anchor[0].ts)))
      .orderBy(...this.messageOrder("asc"));
    const index = rows.findIndex((r) => r.id === messageId);
    return rows.slice(index + 1).map((r) => this.rowToMessage(r));
  }

  async getRecentMessages(sessionId: string, limit: number): Promise<Message[]> {
    const rows: any[] = await this.db.select().from(this.messages)
      .where(eq(this.messages.sessionId, sessionId))
      .orderBy(...this.messageOrder("desc"))
      .limit(limit);
    return rows.reverse().map((r) => this.rowToMessage(r));
  }

  async listSessions(): Promise<Session[]> {
    const rows: any[] = await this.db
      .select(this.summaryColumns())
      .from(this.sessions)
      .leftJoin(this.messages, eq(this.sessions.id, this.messages.sessionId))
      .groupBy(this.sessions.id)
      .orderBy(desc(this.sessions.updatedAt));

    return rows.map((r) => this.rowToSession(r, Number(r.messageCount)));
  }

  async getSession(sessionId: string): Promise<Session | undefined> {
    const rows: any[] = await this.db
      .select(this.summaryColumns())
      .from(this.sessions)
      .leftJoin(this.messages, eq(this.sessions.id, this.messages.sessionId))
      .where(eq(this.sessions.id, sessionId))
      .groupBy(this.sessions.id);

    return rows.length > 0 ? this.rowToSession(rows[0], Number(rows[0].messageCount)) : undefined;
  }

  async getLatestSession(agent?: string | null): Promise<Session | undefined> {
    let query = this.db
      .select(this.summaryColumns())
      .from(this.sessions)
      .leftJoin(this.messages, eq(this.sessions.id, this.messages.sessionId));

    // Group conversations are never "the latest" chat; then filter by agent:
    // null → orchestrator sessions only, a name → that agent, undefined → any.
    const unscoped = isNull(this.sessions.scope);
    if (agent === null) {
      query = query.where(and(unscoped, isNull(this.sessions.agent)));
    } else if (agent !== undefined) {
      query = query.where(and(unscoped, eq(this.sessions.agent, agent)));
    } else {
      query = query.where(unscoped);
    }

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
    return affectedRows(result) > 0;
  }

  async setStarred(sessionId: string, starred: boolean): Promise<boolean> {
    // CRITICAL: do NOT update updatedAt. Starring must not reshuffle the
    // sidebar — "recent" ordering keys off updatedAt and users expect
    // pinning a chat to leave its chronological position untouched.
    const result = await this.db.update(this.sessions)
      .set({ starred })
      .where(eq(this.sessions.id, sessionId));
    return affectedRows(result) > 0;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    // Messages are cascade-deleted via FK
    const result = await this.db.delete(this.sessions)
      .where(eq(this.sessions.id, sessionId));
    return affectedRows(result) > 0;
  }

  async forkSession(sessionId: string, messageId: string, opts?: ForkSessionOptions): Promise<ForkSessionResult | undefined> {
    const parentRows: any[] = await this.db.select().from(this.sessions).where(eq(this.sessions.id, sessionId));
    if (parentRows.length === 0) return undefined;
    const parent = parentRows[0];
    const rows: any[] = await this.db.select().from(this.messages)
      .where(eq(this.messages.sessionId, sessionId))
      .orderBy(...this.messageOrder("asc"));
    const cut = rows.findIndex((r) => r.id === messageId);
    if (cut < 0) return undefined;
    const copied = rows.slice(0, cut + 1);

    const id = nanoid(10);
    const now = new Date().toISOString();
    const title = opts?.title ?? parent.title ?? null;
    const sessionRow = {
      id,
      title,
      agent: parent.agent ?? null,
      createdAt: now,
      updatedAt: now,
      starred: null,
      scope: parent.scope ?? null,
      parentSessionId: sessionId,
      forkMessageId: messageId,
    };
    const messageIds: Record<string, string> = {};
    // New ids, same timestamps: the copy sorts exactly like the original (the new ids increase in
    // the original order, so messages saved in the same millisecond keep their order too).
    const copyIds = copied.map(() => nanoid()).sort();
    const messageRows = copied.map((r, index) => {
      const copyId = copyIds[index]!;
      messageIds[r.id] = copyId;
      return { id: copyId, sessionId: id, role: r.role, content: r.content, ts: r.ts, toolCalls: r.toolCalls, segments: r.segments };
    });

    // One transaction: a branch is either complete or absent.
    if (this.dialect === "pg") {
      await this.db.transaction(async (tx: any) => {
        await tx.insert(this.sessions).values(sessionRow);
        for (let i = 0; i < messageRows.length; i += 500) {
          await tx.insert(this.messages).values(messageRows.slice(i, i + 500));
        }
      });
    } else {
      // better-sqlite3 transactions are synchronous.
      this.db.transaction((tx: any) => {
        tx.insert(this.sessions).values(sessionRow).run();
        for (let i = 0; i < messageRows.length; i += 500) {
          tx.insert(this.messages).values(messageRows.slice(i, i + 500)).run();
        }
      });
    }

    const session = await this.getSession(id);
    return session ? { session, messageIds } : undefined;
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

  /**
   * Full-text search over every message, newest first: SQLite through the FTS5 index
   * (messages_fts, unicode61 without diacritics), PostgreSQL through the GIN index on
   * to_tsvector('simple', content). Each term is a word prefix; all must match.
   */
  async searchMessages(query: MessageSearchQuery): Promise<MessageSearchHit[]> {
    const terms = [...new Set(query.terms.map(ftsTerm).filter((t) => t.length > 0))].slice(0, 8);
    if (!terms.length) return [];
    const limit = Math.max(1, Math.min(query.limit ?? 50, 500));
    const m = this.messages;
    const match = this.dialect === "pg"
      // the same expression as the index (literal config), so the planner uses it
      ? sql`to_tsvector('simple', ${m.content}) @@ to_tsquery('simple', ${terms.map((t) => `${t}:*`).join(" & ")})`
      : sql`rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${terms.map((t) => `"${t}"*`).join(" ")})`;
    const rows: any[] = await this.db
      .select({ id: m.id, sessionId: m.sessionId, role: m.role, ts: m.ts, content: sql<string>`substr(${m.content}, 1, ${SEARCH_CONTENT_CHARS})` })
      .from(m)
      .where(match)
      .orderBy(desc(m.ts))
      .limit(limit);
    return rows.map((r) => ({ sessionId: r.sessionId, messageId: r.id, role: r.role as MessageRole, content: r.content ?? "", ts: r.ts }));
  }

  async close(): Promise<void> {
    // Connection lifecycle managed externally
  }
}
