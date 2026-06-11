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
    const remainingSubscriptions = this.store.count();
    if (remainingSubscriptions === 0) {
      throw new Error("All push subscriptions are expired or invalid. Enable notifications from this browser again.");
    }
    if (failures.length === results.length) {
      const first = failures[0] as PromiseRejectedResult | undefined;
      const msg = first?.reason instanceof Error ? first.reason.message : "Push delivery failed";
      throw new Error(msg);
    }
  }

  async test(): Promise<boolean> {
    if (!this.vapid.publicKey || !this.vapid.privateKey) {
      throw new Error("Push VAPID keys are missing");
    }
    if (this.store.count() === 0) {
      throw new Error("No push subscriptions registered for this project. Enable notifications from this browser first.");
    }
    return true;
  }

  async sendTest(): Promise<void> {
    await this.send({
      id: "push-test",
      channel: "push",
      title: "Polpo push test",
      body: "Push notifications are working for this browser.",
      severity: "info",
      sourceEvent: "notification:test",
      sourceData: { test: true },
      ruleId: "push-test",
      timestamp: new Date().toISOString(),
    });
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
