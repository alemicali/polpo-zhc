import { and, asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { ChatQueueItem, ChatQueueState, ChatQueueStore } from "@polpo-ai/core/session-store";
import { type Dialect, affectedRows, pgSafe } from "../utils.js";

type AnyTable = any;

/** Per-session prompt queue (see ChatQueueStore). */
export class DrizzleChatQueueStore implements ChatQueueStore {
  constructor(
    private db: any,
    private items: AnyTable,
    private settings: AnyTable,
    private dialect: Dialect,
  ) {}

  private toItem(row: any): ChatQueueItem {
    return { id: row.id, sessionId: row.sessionId, content: row.content, createdAt: row.createdAt };
  }

  private async rows(sessionId: string): Promise<any[]> {
    return this.db.select().from(this.items)
      .where(eq(this.items.sessionId, sessionId))
      .orderBy(asc(this.items.position), asc(this.items.createdAt));
  }

  async get(sessionId: string): Promise<ChatQueueState> {
    const [rows, settings] = await Promise.all([
      this.rows(sessionId),
      this.db.select().from(this.settings).where(eq(this.settings.sessionId, sessionId)) as Promise<any[]>,
    ]);
    return { items: rows.map((r) => this.toItem(r)), autoSend: settings[0]?.autoSend ?? true };
  }

  async add(sessionId: string, content: string, opts?: { front?: boolean }): Promise<ChatQueueItem> {
    const rows = await this.rows(sessionId);
    const position = rows.length === 0
      ? 0
      : opts?.front ? Number(rows[0].position) - 1 : Number(rows[rows.length - 1].position) + 1;
    const item = { id: nanoid(12), sessionId, content, createdAt: new Date().toISOString() };
    await this.db.insert(this.items).values({
      ...item,
      content: this.dialect === "pg" ? pgSafe(content) : content,
      position,
    });
    return item;
  }

  async update(sessionId: string, id: string, content: string): Promise<ChatQueueItem | undefined> {
    const result = await this.db.update(this.items)
      .set({ content: this.dialect === "pg" ? pgSafe(content) : content })
      .where(and(eq(this.items.sessionId, sessionId), eq(this.items.id, id)));
    if (affectedRows(result) === 0) return undefined;
    const rows: any[] = await this.db.select().from(this.items).where(eq(this.items.id, id));
    return rows[0] ? this.toItem(rows[0]) : undefined;
  }

  async remove(sessionId: string, id: string): Promise<ChatQueueItem | undefined> {
    const rows: any[] = await this.db.select().from(this.items)
      .where(and(eq(this.items.sessionId, sessionId), eq(this.items.id, id)));
    if (rows.length === 0) return undefined;
    const result = await this.db.delete(this.items)
      .where(and(eq(this.items.sessionId, sessionId), eq(this.items.id, id)));
    // Someone else (another device, the dispatcher) took it first.
    return affectedRows(result) > 0 ? this.toItem(rows[0]) : undefined;
  }

  async reorder(sessionId: string, ids: string[]): Promise<ChatQueueItem[]> {
    const rows = await this.rows(sessionId);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const listed = [...new Set(ids)].filter((id) => byId.has(id));
    const order = [...listed, ...rows.map((r) => r.id).filter((id) => !listed.includes(id))];
    for (let position = 0; position < order.length; position++) {
      if (Number(byId.get(order[position])!.position) === position) continue;
      await this.db.update(this.items).set({ position }).where(eq(this.items.id, order[position]));
    }
    return order.map((id) => this.toItem(byId.get(id)));
  }

  async clear(sessionId: string): Promise<number> {
    const result = await this.db.delete(this.items).where(eq(this.items.sessionId, sessionId));
    return affectedRows(result);
  }

  async shift(sessionId: string): Promise<ChatQueueItem | undefined> {
    // Retry when a concurrent remover wins the head: the next one is ours.
    for (let attempt = 0; attempt < 5; attempt++) {
      const rows = await this.rows(sessionId);
      if (rows.length === 0) return undefined;
      const result = await this.db.delete(this.items).where(eq(this.items.id, rows[0].id));
      if (affectedRows(result) > 0) return this.toItem(rows[0]);
    }
    return undefined;
  }

  async setAutoSend(sessionId: string, autoSend: boolean): Promise<void> {
    await this.db.insert(this.settings)
      .values({ sessionId, autoSend })
      .onConflictDoUpdate({ target: this.settings.sessionId, set: { autoSend } });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.db.delete(this.items).where(eq(this.items.sessionId, sessionId));
    await this.db.delete(this.settings).where(eq(this.settings.sessionId, sessionId));
  }
}
