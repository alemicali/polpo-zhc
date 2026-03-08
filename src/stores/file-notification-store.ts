import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import type {
  NotificationStore,
  NotificationRecord,
  NotificationStatus,
} from "../core/notification-store.js";

/**
 * Filesystem-based NotificationStore.
 *
 * All records are stored in a single JSON array file at
 * .polpo/notifications.json — simple, human-readable, no dependencies.
 *
 * Writes use atomic rename to avoid corruption.
 */
export class FileNotificationStore implements NotificationStore {
  private filePath: string;
  private records: NotificationRecord[];

  constructor(polpoDir: string) {
    if (!existsSync(polpoDir)) mkdirSync(polpoDir, { recursive: true });
    this.filePath = join(polpoDir, "notifications.json");
    this.records = this.load();
  }

  private load(): NotificationRecord[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    const tmp = this.filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.records, null, 2), "utf-8");
    renameSync(tmp, this.filePath);
  }

  async append(record: NotificationRecord): Promise<void> {
    this.records.push(record);
    this.save();
  }

  async list(limit = 100): Promise<NotificationRecord[]> {
    // Most recent first
    return this.records.slice(-limit).reverse();
  }

  async listByChannel(channelId: string, limit = 100): Promise<NotificationRecord[]> {
    return this.records
      .filter(r => r.channel === channelId)
      .slice(-limit)
      .reverse();
  }

  async listByRule(ruleId: string, limit = 100): Promise<NotificationRecord[]> {
    return this.records
      .filter(r => r.ruleId === ruleId)
      .slice(-limit)
      .reverse();
  }

  async listByStatus(status: NotificationStatus, limit = 100): Promise<NotificationRecord[]> {
    return this.records
      .filter(r => r.status === status)
      .slice(-limit)
      .reverse();
  }

  async count(status?: NotificationStatus): Promise<number> {
    if (!status) return this.records.length;
    return this.records.filter(r => r.status === status).length;
  }

  async prune(keep: number): Promise<number> {
    if (this.records.length <= keep) return 0;
    const pruned = this.records.length - keep;
    this.records = this.records.slice(-keep);
    this.save();
    return pruned;
  }

  async close(): Promise<void> {
    // No-op — writes are synchronous
  }
}
