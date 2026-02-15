import type { NotificationSeverity } from "../core/types.js";

/**
 * A notification ready to be dispatched to a channel.
 */
export interface Notification {
  /** Unique notification ID. */
  id: string;
  /** Target channel ID (must match a key in NotificationsConfig.channels). */
  channel: string;
  /** Notification title/subject. */
  title: string;
  /** Notification body (may contain markdown). */
  body: string;
  /** Severity level. */
  severity: NotificationSeverity;
  /** The event that triggered this notification. */
  sourceEvent: string;
  /** The event payload. */
  sourceData: unknown;
  /** The rule that matched. */
  ruleId: string;
  /** ISO timestamp. */
  timestamp: string;
}

/**
 * Channel adapter interface — implementations handle delivery to a specific service.
 */
export interface NotificationChannel {
  /** Channel type identifier. */
  readonly type: string;
  /** Send a notification. Throws on failure. */
  send(notification: Notification): Promise<void>;
  /** Test connectivity. Returns true if the channel is reachable. */
  test(): Promise<boolean>;
}
