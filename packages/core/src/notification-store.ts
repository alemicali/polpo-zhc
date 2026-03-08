/**
 * Persistent notification storage — tracks every notification sent or failed.
 *
 * Follows the same pattern as LogStore / RunStore:
 *   - Interface lives in core/
 *   - Implementations in stores/ (file + sqlite)
 */

import type { NotificationSeverity, OutcomeType } from "./types.js";

export type NotificationStatus = "sent" | "failed";

export interface NotificationRecord {
  /** Unique notification ID. */
  id: string;
  /** ISO timestamp when the notification was dispatched. */
  timestamp: string;
  /** The notification rule that triggered this. */
  ruleId: string;
  /** Rule name (human-readable). */
  ruleName: string;
  /** Target channel ID. */
  channel: string;
  /** Channel type (telegram, slack, email, webhook). */
  channelType: string;
  /** Delivery status. */
  status: NotificationStatus;
  /** Error message (only for failed notifications). */
  error?: string;
  /** Notification title. */
  title: string;
  /** Notification body (may contain markdown/HTML). */
  body: string;
  /** Severity level. */
  severity: NotificationSeverity;
  /** The event that triggered this notification. */
  sourceEvent: string;
  /** Number of outcome attachments sent (0 if none). */
  attachmentCount: number;
  /** Outcome types attached (if any). */
  attachmentTypes?: OutcomeType[];
}

export interface NotificationStore {
  /** Persist a notification record (sent or failed). */
  append(record: NotificationRecord): Promise<void>;
  /** Get all notifications, most recent first. Optional limit (default 100). */
  list(limit?: number): Promise<NotificationRecord[]>;
  /** Get notifications by channel ID. */
  listByChannel(channelId: string, limit?: number): Promise<NotificationRecord[]>;
  /** Get notifications by rule ID. */
  listByRule(ruleId: string, limit?: number): Promise<NotificationRecord[]>;
  /** Get notifications by status. */
  listByStatus(status: NotificationStatus, limit?: number): Promise<NotificationRecord[]>;
  /** Count notifications by status. */
  count(status?: NotificationStatus): Promise<number>;
  /** Prune old records, keeping the most recent N. Returns number pruned. */
  prune(keep: number): Promise<number>;
  /** Flush/close. */
  close(): Promise<void> | void;
}
