import type { NotificationChannel, Notification } from "../types.js";
import type { NotificationChannelConfig } from "../../core/types.js";
import { resolveEnvVar } from "./webhook.js";
import { speakableText } from "../speech.js";


/**
 * Voice channel: a smart speaker (XiaoZhi firmware) reached through its voice bridge.
 * Outbound notifications are spoken on the device by the bridge (POST <url>/notify);
 * conversations come in through POST /api/v1/channels/<name>/voice/chat/completions.
 *
 * Configuration:
 *   url:      bridge base URL (e.g. http://127.0.0.1:8765), "${ENV}" allowed
 *   apiKey:   bearer token the bridge expects, "${ENV}" allowed
 *   chatId:   default device id (MAC) for notifications without a conversation
 */
export class VoiceChannel implements NotificationChannel {
  readonly type = "voice";
  private url: string;
  private token: string;
  private defaultDevice?: string;

  constructor(config: NotificationChannelConfig) {
    const url = resolveEnvVar(config.url ?? "").replace(/\/+$/, "");
    if (!url) throw new Error("Voice channel requires url (the voice bridge)");
    this.url = url;
    this.token = resolveEnvVar(config.apiKey ?? "");
    this.defaultDevice = config.chatId;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  /** The device of the conversation that produced the notification, else the channel default. */
  private deviceFor(notification: Notification): string | undefined {
    const data = notification.sourceData as { chatId?: unknown } | null | undefined;
    const fromConversation = data && typeof data === "object" && typeof data.chatId === "string" ? data.chatId : undefined;
    return fromConversation || this.defaultDevice;
  }

  async send(notification: Notification): Promise<void> {
    const device = this.deviceFor(notification);
    if (!device) throw new Error("Voice notification has no target device (set chatId on the channel)");
    const text = speakableText(notification.body ?? "") || speakableText(notification.title ?? "");
    const response = await fetch(`${this.url}/notify`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ id: notification.id, device, text, title: notification.title, severity: notification.severity }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Voice bridge failed: ${response.status} ${detail}`.trim());
    }
  }

  async test(): Promise<boolean> {
    try {
      const response = await fetch(`${this.url}/healthz`, { headers: this.headers() });
      return response.ok;
    } catch {
      return false;
    }
  }
}
