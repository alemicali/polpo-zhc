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

  append(record: NotificationRecord): void {
    this.records.push(record);
    this.save();
  }

  list(limit = 100): NotificationRecord[] {
    // Most recent first
    return this.records.slice(-limit).reverse();
  }

  listByChannel(channelId: string, limit = 100): NotificationRecord[] {
    return this.records
      .filter(r => r.channel === channelId)
      .slice(-limit)
      .reverse();
  }

  listByRule(ruleId: string, limit = 100): NotificationRecord[] {
    return this.records
      .filter(r => r.ruleId === ruleId)
      .slice(-limit)
      .reverse();
  }

  listByStatus(status: NotificationStatus, limit = 100): NotificationRecord[] {
    return this.records
      .filter(r => r.status === status)
      .slice(-limit)
      .reverse();
  }

  count(status?: NotificationStatus): number {
    if (!status) return this.records.length;
    return this.records.filter(r => r.status === status).length;
  }

  prune(keep: number): number {
    if (this.records.length <= keep) return 0;
    const pruned = this.records.length - keep;
    this.records = this.records.slice(-keep);
    this.save();
    return pruned;
  }

  close(): void {
    // No-op — writes are synchronous
  }
}
