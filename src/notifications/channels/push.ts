import webpush from "web-push";
import type { NotificationChannel, Notification } from "../types.js";
import type { NotificationChannelConfig } from "../../core/types.js";
import { FilePushSubscriptionStore, type PushVapidConfig } from "../../stores/file-push-subscription-store.js";

/**
 * Web Push notification channel.
 *
 * Uses the browser Push API subscription records stored in `.polpo/push.json`.
 * Delivery goes through standard Web Push/VAPID, so it works with Chrome,
 * Firefox, Edge, Safari macOS and iOS/iPadOS Home Screen web apps.
 */
export class PushChannel implements NotificationChannel {
  readonly type = "push";
  private store: FilePushSubscriptionStore;
  private vapid: PushVapidConfig;
  private ttl: number;
  private urgency: "very-low" | "low" | "normal" | "high";

  constructor(config: NotificationChannelConfig, polpoDir: string) {
    this.store = new FilePushSubscriptionStore(polpoDir);
    const generated = this.store.ensureVapid(config.vapidSubject);
    this.vapid = {
      publicKey: resolveEnvVar(config.vapidPublicKey ?? generated.publicKey),
      privateKey: resolveEnvVar(config.vapidPrivateKey ?? generated.privateKey),
      subject: resolveEnvVar(config.vapidSubject ?? generated.subject),
    };
    if (!this.vapid.publicKey) throw new Error("Push channel requires vapidPublicKey");
    if (!this.vapid.privateKey) throw new Error("Push channel requires vapidPrivateKey");
    if (!this.vapid.subject) throw new Error("Push channel requires vapidSubject");
    this.ttl = config.ttl ?? 60 * 60;
    this.urgency = config.urgency ?? "normal";
    this.configureVapid();
  }

  async send(notification: Notification): Promise<void> {
    this.configureVapid();
    const subscriptions = this.store.list();
    if (subscriptions.length === 0) {
      throw new Error("No push subscriptions registered for this project");
    }

    const payload = JSON.stringify({
      title: notification.title,
      body: notification.body,
      severity: notification.severity,
      tag: notification.sourceEvent,
      data: {
        notificationId: notification.id,
        channel: notification.channel,
        event: notification.sourceEvent,
        ruleId: notification.ruleId,
        url: "/",
      },
      timestamp: notification.timestamp,
    });

    const results = await Promise.allSettled(
      subscriptions.map(async (subscription) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: subscription.endpoint,
              expirationTime: subscription.expirationTime ?? null,
              keys: subscription.keys,
            },
            payload,
            {
              TTL: this.ttl,
              urgency: this.urgency,
              topic: topicFrom(notification.sourceEvent),
            },
          );
          this.store.markSuccess(subscription.endpoint);
        } catch (err) {
          if (isExpiredSubscriptionError(err)) {
            this.store.remove(subscription.endpoint);
            return;
          }
          this.store.markFailure(subscription.endpoint);
          throw err;
        }
      }),
    );

    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length === results.length) {
      const first = failures[0] as PromiseRejectedResult | undefined;
      const msg = first?.reason instanceof Error ? first.reason.message : "Push delivery failed";
      throw new Error(msg);
    }
  }

  async test(): Promise<boolean> {
    return !!this.vapid.publicKey && !!this.vapid.privateKey && this.store.count() > 0;
  }

  private configureVapid(): void {
    webpush.setVapidDetails(this.vapid.subject, this.vapid.publicKey, this.vapid.privateKey);
  }
}

function resolveEnvVar(value: string): string {
  if (value.startsWith("${") && value.endsWith("}")) {
    const envKey = value.slice(2, -1);
    return process.env[envKey] ?? "";
  }
  return value;
}

function topicFrom(value: string): string {
  return Buffer.from(value).toString("base64url").slice(0, 32) || "polpo";
}

function isExpiredSubscriptionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const statusCode = (err as { statusCode?: unknown }).statusCode;
  return statusCode === 404 || statusCode === 410;
}
