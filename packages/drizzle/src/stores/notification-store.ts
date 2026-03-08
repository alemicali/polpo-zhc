import { eq, desc, sql } from "drizzle-orm";
import type { NotificationStore, NotificationRecord, NotificationStatus } from "@polpo-ai/core/notification-store";
import { type Dialect, serializeJson, deserializeJson } from "../utils.js";

type AnyTable = any;

export class DrizzleNotificationStore implements NotificationStore {
  constructor(
    private db: any,
    private notifications: AnyTable,
    private dialect: Dialect,
  ) {}

  private rowToRecord(row: any): NotificationRecord {
    return {
      id: row.id,
      timestamp: row.timestamp,
      ruleId: row.ruleId,
      ruleName: row.ruleName,
      channel: row.channel,
      channelType: row.channelType,
      status: row.status as NotificationStatus,
      error: row.error ?? undefined,
      title: row.title,
      body: row.body,
      severity: row.severity,
      sourceEvent: row.sourceEvent,
      attachmentCount: row.attachmentCount,
      attachmentTypes: deserializeJson(row.attachmentTypes, undefined, this.dialect),
    };
  }

  async append(record: NotificationRecord): Promise<void> {
    await this.db.insert(this.notifications).values({
      id: record.id,
      timestamp: record.timestamp,
      ruleId: record.ruleId,
      ruleName: record.ruleName,
      channel: record.channel,
      channelType: record.channelType,
      status: record.status,
      error: record.error ?? null,
      title: record.title,
      body: record.body,
      severity: record.severity,
      sourceEvent: record.sourceEvent,
      attachmentCount: record.attachmentCount,
      attachmentTypes: serializeJson(record.attachmentTypes, this.dialect),
    });
  }

  async list(limit?: number): Promise<NotificationRecord[]> {
    let q = this.db.select().from(this.notifications)
      .orderBy(desc(this.notifications.timestamp));
    if (limit) q = q.limit(limit);
    const rows: any[] = await q;
    return rows.map((r) => this.rowToRecord(r));
  }

  async listByChannel(channelId: string, limit?: number): Promise<NotificationRecord[]> {
    let q = this.db.select().from(this.notifications)
      .where(eq(this.notifications.channel, channelId))
      .orderBy(desc(this.notifications.timestamp));
    if (limit) q = q.limit(limit);
    const rows: any[] = await q;
    return rows.map((r) => this.rowToRecord(r));
  }

  async listByRule(ruleId: string, limit?: number): Promise<NotificationRecord[]> {
    let q = this.db.select().from(this.notifications)
      .where(eq(this.notifications.ruleId, ruleId))
      .orderBy(desc(this.notifications.timestamp));
    if (limit) q = q.limit(limit);
    const rows: any[] = await q;
    return rows.map((r) => this.rowToRecord(r));
  }

  async listByStatus(status: NotificationStatus, limit?: number): Promise<NotificationRecord[]> {
    let q = this.db.select().from(this.notifications)
      .where(eq(this.notifications.status, status))
      .orderBy(desc(this.notifications.timestamp));
    if (limit) q = q.limit(limit);
    const rows: any[] = await q;
    return rows.map((r) => this.rowToRecord(r));
  }

  async count(status?: NotificationStatus): Promise<number> {
    let q;
    if (status) {
      q = this.db.select({ count: sql<number>`count(*)` }).from(this.notifications)
        .where(eq(this.notifications.status, status));
    } else {
      q = this.db.select({ count: sql<number>`count(*)` }).from(this.notifications);
    }
    const rows: any[] = await q;
    return Number(rows[0]?.count ?? 0);
  }

  async prune(keep: number): Promise<number> {
    const all: any[] = await this.db.select({ id: this.notifications.id })
      .from(this.notifications)
      .orderBy(desc(this.notifications.timestamp));

    if (all.length <= keep) return 0;

    const toDelete = all.slice(keep).map((r) => r.id);
    let deleted = 0;
    for (const id of toDelete) {
      await this.db.delete(this.notifications).where(eq(this.notifications.id, id));
      deleted++;
    }
    return deleted;
  }

  async close(): Promise<void> {}
}
