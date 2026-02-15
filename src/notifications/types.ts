import type { NotificationSeverity, OutcomeType } from "../core/types.js";

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
 * An outcome file attachment to be sent alongside a notification.
 */
export interface OutcomeAttachment {
  /** Outcome label (human-readable). */
  label: string;
  /** Outcome type. */
  type: OutcomeType;
  /** Absolute file path on disk (for file/media outcomes). */
  filePath?: string;
  /** MIME type. */
  mimeType?: string;
  /** File size in bytes. */
  size?: number;
  /** File content as Buffer (loaded by the router before dispatch). */
  content?: Buffer;
  /** Text content (for text/json/url outcomes). */
  text?: string;
  /** URL (for url outcomes). */
  url?: string;
}

/**
 * Channel adapter interface — implementations handle delivery to a specific service.
 */
export interface NotificationChannel {
  /** Channel type identifier. */
  readonly type: string;
  /** Send a notification. Throws on failure. */
  send(notification: Notification): Promise<void>;
  /**
   * Send a notification with file/media attachments.
   * Optional — channels that don't support attachments fall back to `send()`.
   * Implementations should send the notification text first, then each attachment.
   */
  sendWithAttachments?(notification: Notification, attachments: OutcomeAttachment[]): Promise<void>;
  /** Test connectivity. Returns true if the channel is reachable. */
  test(): Promise<boolean>;
}
