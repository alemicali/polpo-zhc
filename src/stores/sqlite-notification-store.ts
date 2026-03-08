import { createDatabase, type PolpoDatabase, type PolpoStatement } from "./sqlite-compat.js";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type {
  NotificationStore,
  NotificationRecord,
  NotificationStatus,
} from "../core/notification-store.js";

interface NotificationRow {
  id: string;
  timestamp: string;
  rule_id: string;
  rule_name: string;
  channel: string;
  channel_type: string;
  status: string;
  error: string | null;
  title: string;
  body: string;
  severity: string;
  source_event: string;
  attachment_count: number;
  attachment_types: string | null;
}

export class SqliteNotificationStore implements NotificationStore {
  private db: PolpoDatabase;

  private insertStmt: PolpoStatement;
  private listStmt: PolpoStatement;
  private listByChannelStmt: PolpoStatement;
  private listByRuleStmt: PolpoStatement;
  private listByStatusStmt: PolpoStatement;
  private countAllStmt: PolpoStatement;
  private countByStatusStmt: PolpoStatement;
  private pruneStmt: PolpoStatement;
  private countTotalStmt: PolpoStatement;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = createDatabase(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initSchema();

    this.insertStmt = this.db.prepare(`
      INSERT INTO notifications (id, timestamp, rule_id, rule_name, channel, channel_type, status, error, title, body, severity, source_event, attachment_count, attachment_types)
      VALUES (@id, @timestamp, @rule_id, @rule_name, @channel, @channel_type, @status, @error, @title, @body, @severity, @source_event, @attachment_count, @attachment_types)
    `);

    this.listStmt = this.db.prepare(`
      SELECT * FROM notifications ORDER BY timestamp DESC LIMIT ?
    `);

    this.listByChannelStmt = this.db.prepare(`
      SELECT * FROM notifications WHERE channel = ? ORDER BY timestamp DESC LIMIT ?
    `);

    this.listByRuleStmt = this.db.prepare(`
      SELECT * FROM notifications WHERE rule_id = ? ORDER BY timestamp DESC LIMIT ?
    `);

    this.listByStatusStmt = this.db.prepare(`
      SELECT * FROM notifications WHERE status = ? ORDER BY timestamp DESC LIMIT ?
    `);

    this.countAllStmt = this.db.prepare(`SELECT COUNT(*) as cnt FROM notifications`);
    this.countByStatusStmt = this.db.prepare(`SELECT COUNT(*) as cnt FROM notifications WHERE status = ?`);

    // Delete oldest records keeping only the most recent N
    this.pruneStmt = this.db.prepare(`
      DELETE FROM notifications WHERE id NOT IN (
        SELECT id FROM notifications ORDER BY timestamp DESC LIMIT ?
      )
    `);

    this.countTotalStmt = this.db.prepare(`SELECT COUNT(*) as cnt FROM notifications`);
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id               TEXT PRIMARY KEY,
        timestamp        TEXT NOT NULL,
        rule_id          TEXT NOT NULL,
        rule_name        TEXT NOT NULL,
        channel          TEXT NOT NULL,
        channel_type     TEXT NOT NULL,
        status           TEXT NOT NULL,
        error            TEXT,
        title            TEXT NOT NULL,
        body             TEXT NOT NULL,
        severity         TEXT NOT NULL,
        source_event     TEXT NOT NULL,
        attachment_count INTEGER NOT NULL DEFAULT 0,
        attachment_types TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_timestamp ON notifications(timestamp);
      CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status);
      CREATE INDEX IF NOT EXISTS idx_notifications_channel ON notifications(channel);
      CREATE INDEX IF NOT EXISTS idx_notifications_rule_id ON notifications(rule_id);
    `);
  }

  private rowToRecord(row: NotificationRow): NotificationRecord {
    return {
      id: row.id,
      timestamp: row.timestamp,
      ruleId: row.rule_id,
      ruleName: row.rule_name,
      channel: row.channel,
      channelType: row.channel_type,
      status: row.status as NotificationStatus,
      error: row.error ?? undefined,
      title: row.title,
      body: row.body,
      severity: row.severity as NotificationRecord["severity"],
      sourceEvent: row.source_event,
      attachmentCount: row.attachment_count,
      attachmentTypes: row.attachment_types
        ? JSON.parse(row.attachment_types)
        : undefined,
    };
  }

  async append(record: NotificationRecord): Promise<void> {
    this.insertStmt.run({
      id: record.id,
      timestamp: record.timestamp,
      rule_id: record.ruleId,
      rule_name: record.ruleName,
      channel: record.channel,
      channel_type: record.channelType,
      status: record.status,
      error: record.error ?? null,
      title: record.title,
      body: record.body,
      severity: record.severity,
      source_event: record.sourceEvent,
      attachment_count: record.attachmentCount,
      attachment_types: record.attachmentTypes
        ? JSON.stringify(record.attachmentTypes)
        : null,
    });
  }

  async list(limit = 100): Promise<NotificationRecord[]> {
    return (this.listStmt.all(limit) as NotificationRow[]).map(r =>
      this.rowToRecord(r),
    );
  }

  async listByChannel(channelId: string, limit = 100): Promise<NotificationRecord[]> {
    return (this.listByChannelStmt.all(channelId, limit) as NotificationRow[]).map(
      r => this.rowToRecord(r),
    );
  }

  async listByRule(ruleId: string, limit = 100): Promise<NotificationRecord[]> {
    return (this.listByRuleStmt.all(ruleId, limit) as NotificationRow[]).map(r =>
      this.rowToRecord(r),
    );
  }

  async listByStatus(status: NotificationStatus, limit = 100): Promise<NotificationRecord[]> {
    return (this.listByStatusStmt.all(status, limit) as NotificationRow[]).map(r =>
      this.rowToRecord(r),
    );
  }

  async count(status?: NotificationStatus): Promise<number> {
    if (!status) {
      return (this.countAllStmt.get() as { cnt: number }).cnt;
    }
    return (this.countByStatusStmt.get(status) as { cnt: number }).cnt;
  }

  async prune(keep: number): Promise<number> {
    const total = (this.countTotalStmt.get() as { cnt: number }).cnt;
    if (total <= keep) return 0;
    this.pruneStmt.run(keep);
    return total - keep;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
