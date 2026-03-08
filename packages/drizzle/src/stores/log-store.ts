import { eq, desc, asc, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { LogStore, LogEntry, SessionInfo } from "@polpo/core/log-store";
import { type Dialect, serializeJson, deserializeJson } from "../utils.js";

type AnyTable = any;

export class DrizzleLogStore implements LogStore {
  private currentSessionId: string | undefined;

  constructor(
    private db: any,
    private logSessions: AnyTable,
    private logEntries: AnyTable,
    private dialect: Dialect,
  ) {}

  async startSession(): Promise<string> {
    const id = nanoid(10);
    const now = new Date().toISOString();
    await this.db.insert(this.logSessions).values({ id, startedAt: now });
    this.currentSessionId = id;
    return id;
  }

  async getSessionId(): Promise<string | undefined> {
    return this.currentSessionId;
  }

  async append(entry: LogEntry): Promise<void> {
    if (!this.currentSessionId) {
      await this.startSession();
    }
    await this.db.insert(this.logEntries).values({
      id: nanoid(),
      sessionId: this.currentSessionId!,
      ts: entry.ts,
      event: entry.event,
      data: serializeJson(entry.data, this.dialect),
    });
  }

  async getSessionEntries(sessionId?: string): Promise<LogEntry[]> {
    const sid = sessionId ?? this.currentSessionId;
    if (!sid) return [];

    const rows: any[] = await this.db.select().from(this.logEntries)
      .where(eq(this.logEntries.sessionId, sid))
      .orderBy(asc(this.logEntries.ts));

    return rows.map((r) => ({
      ts: r.ts,
      event: r.event,
      data: deserializeJson(r.data, null, this.dialect),
    }));
  }

  async listSessions(): Promise<SessionInfo[]> {
    const rows: any[] = await this.db
      .select({
        sessionId: this.logSessions.id,
        startedAt: this.logSessions.startedAt,
        entries: sql<number>`count(${this.logEntries.id})`,
      })
      .from(this.logSessions)
      .leftJoin(this.logEntries, eq(this.logSessions.id, this.logEntries.sessionId))
      .groupBy(this.logSessions.id)
      .orderBy(desc(this.logSessions.startedAt));

    return rows.map((r) => ({
      sessionId: r.sessionId,
      startedAt: r.startedAt,
      entries: Number(r.entries),
    }));
  }

  async prune(keepSessions: number): Promise<number> {
    const all: any[] = await this.db.select({ id: this.logSessions.id })
      .from(this.logSessions)
      .orderBy(desc(this.logSessions.startedAt));

    if (all.length <= keepSessions) return 0;

    const toDelete = all.slice(keepSessions).map((r) => r.id);
    let deleted = 0;
    for (const id of toDelete) {
      // Entries cascade-deleted via FK
      await this.db.delete(this.logSessions).where(eq(this.logSessions.id, id));
      deleted++;
    }
    return deleted;
  }

  async close(): Promise<void> {
    this.currentSessionId = undefined;
  }
}
