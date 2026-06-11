import type { NotificationChannel, Notification } from "../types.js";
import type { FileExpoTokenStore } from "../../stores/file-expo-token-store.js";

/**
 * Minimal subset of expo-server-sdk we depend on. Re-declared here so the
 * channel file doesn't fail to type-check on a host where the optional dep
 * isn't installed yet — the import itself is dynamic and guarded.
 */
interface ExpoPushMessage {
  to: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  sound?: "default" | null;
  priority?: "default" | "normal" | "high";
  channelId?: string;
  badge?: number;
  ttl?: number;
}

interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

interface ExpoSdk {
  isExpoPushToken(token: unknown): boolean;
  chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][];
  sendPushNotificationsAsync(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]>;
}

interface ExpoSdkConstructor {
  new (opts?: { accessToken?: string }): ExpoSdk;
  isExpoPushToken(token: unknown): boolean;
}

let cachedExpo: ExpoSdkConstructor | null | undefined;

/**
 * Soft-load expo-server-sdk. Returns `null` when the dep isn't installed
 * (e.g. the user hasn't run `pnpm install` after pulling these changes),
 * which lets the channel construct without throwing — `send()` is the
 * place that surfaces a user-facing error if the dep is genuinely missing.
 */
async function loadExpoSdk(): Promise<ExpoSdkConstructor | null> {
  if (cachedExpo !== undefined) return cachedExpo;
  try {
    // Dynamic import with a string variable — TypeScript can't statically
    // resolve it, which is exactly what we want when the optional dep
    // isn't installed yet. The `as` casts let us strip module-resolution
    // errors that fire on hosts where node_modules/expo-server-sdk is
    // absent (it's a runtime concern, not a type one).
    const moduleName = "expo-server-sdk";
    const mod = (await import(moduleName)) as Record<string, unknown>;
    const Expo: ExpoSdkConstructor =
      (mod.Expo as ExpoSdkConstructor)
      ?? ((mod as { default?: ExpoSdkConstructor }).default as ExpoSdkConstructor);
    cachedExpo = Expo ?? null;
  } catch {
    cachedExpo = null;
  }
  return cachedExpo;
}

/** Public probe so the route can advertise whether the SDK is available. */
export async function isExpoSdkAvailable(): Promise<boolean> {
  return (await loadExpoSdk()) !== null;
}

export async function isExpoPushTokenSafe(token: unknown): Promise<boolean> {
  const Expo = await loadExpoSdk();
  if (!Expo) return typeof token === "string" && token.startsWith("ExponentPushToken[");
  return Expo.isExpoPushToken(token);
}

/**
 * Strip lightweight Markdown so the OS notification UI doesn't render
 * raw asterisks / backticks / link-syntax to the user. Notification
 * rules sometimes feed Markdown-ish bodies (carryover from email/web
 * channels); native push only renders plain text. Conservative: leaves
 * unknown punctuation alone, only handles the constructs the templates
 * actually emit (bold, italic, code, links, headers, blockquotes).
 */
function stripMarkdown(s: string | undefined): string | undefined {
  if (!s) return s;
  let out = s;
  // Code fences and inline code → drop the backticks, keep content.
  out = out.replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, "").trim());
  out = out.replace(/`([^`]+)`/g, "$1");
  // Links [text](url) → text. Images ![alt](url) → alt.
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Bold/italic: **x**, __x__, *x*, _x_ → x. Order matters (longest first).
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
  out = out.replace(/__([^_]+)__/g, "$1");
  out = out.replace(/\*([^*]+)\*/g, "$1");
  out = out.replace(/(?:^|[^_\w])_([^_]+)_(?!\w)/g, (_m, g1) => g1);
  // Strikethrough.
  out = out.replace(/~~([^~]+)~~/g, "$1");
  // Headers (ATX) at line start.
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  // Blockquotes.
  out = out.replace(/^\s{0,3}>\s?/gm, "");
  // Unordered list bullets.
  out = out.replace(/^\s{0,3}[-*+]\s+/gm, "");
  // Collapse 3+ newlines to 2.
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

/**
 * Expo Push channel — fan-outs a Polpo notification to every registered
 * Expo push token (one per device). Mirrors the contract of PushChannel
 * (Web Push) so the router can swap them transparently per rule.
 *
 * Failure handling:
 *   - Tickets with `status === "error"` increment the per-token failure
 *     counter; after 3 strikes the store auto-disables the token.
 *   - `DeviceNotRegistered` removes the token outright (Expo's signal that
 *     the user uninstalled the app or revoked permission).
 *
 * No receipts loop yet — that's a richer follow-up that requires a
 * background worker to poll Expo's receipts endpoint a few seconds after
 * dispatch. The MVP relies on tickets only.
 */
export class ExpoPushChannel implements NotificationChannel {
  readonly type = "expo-push";
  private store: FileExpoTokenStore;
  private accessToken?: string;

  constructor(store: FileExpoTokenStore, opts?: { accessToken?: string }) {
    this.store = store;
    this.accessToken = opts?.accessToken ?? process.env.EXPO_ACCESS_TOKEN;
  }

  async send(notification: Notification): Promise<void> {
    const Expo = await loadExpoSdk();
    if (!Expo) {
      throw new Error(
        "expo-server-sdk is not installed. Run `pnpm install` after pulling the latest dependencies.",
      );
    }

    const tokens = this.store.listActive();
    if (tokens.length === 0) {
      throw new Error(
        "No Expo push tokens registered. Register a device via POST /api/v1/expo-push/register-token first.",
      );
    }

    // Defensive: drop anything that doesn't look like an Expo token. The
    // store should never hold a malformed entry but mid-flight registry
    // races + manual edits to expo-tokens.json mean we can't assume it.
    const valid = tokens.filter((t) => Expo.isExpoPushToken(t.token));
    if (valid.length === 0) {
      throw new Error("All registered tokens failed Expo's format check.");
    }

    const messages: ExpoPushMessage[] = valid.map((t) => ({
      to: t.token,
      title: stripMarkdown(notification.title),
      body: stripMarkdown(notification.body),
      sound: "default",
      priority: "high",
      data: {
        notificationId: notification.id,
        channel: notification.channel,
        event: notification.sourceEvent,
        ruleId: notification.ruleId,
        severity: notification.severity,
        timestamp: notification.timestamp,
        // Pass the original event payload through. Mobile uses this to
        // deep-link the user to the right screen (task/mission/etc.) when
        // they tap the notification.
        sourceData: notification.sourceData ?? null,
      },
    }));

    const expo = new Expo({ accessToken: this.accessToken });
    const chunks = expo.chunkPushNotifications(messages);

    let anyDelivered = false;
    let allFailed = true;
    let firstErrorMessage: string | undefined;

    for (const chunk of chunks) {
      let tickets: ExpoPushTicket[];
      try {
        tickets = await expo.sendPushNotificationsAsync(chunk);
      } catch (err) {
        // Whole-chunk failure — Expo unreachable, auth issue, etc. Don't
        // mark individual tokens; the next round will retry naturally.
        allFailed = true;
        firstErrorMessage ??= err instanceof Error ? err.message : String(err);
        continue;
      }

      // tickets[i] aligns with chunk[i].to
      for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i];
        const message = chunk[i];
        if (!ticket || !message) continue;
        if (ticket.status === "ok") {
          anyDelivered = true;
          allFailed = false;
          this.store.markSuccess(message.to);
        } else {
          firstErrorMessage ??= ticket.message;
          // DeviceNotRegistered means the token is permanently dead —
          // remove it instead of just incrementing the failure counter.
          if (ticket.details?.error === "DeviceNotRegistered") {
            this.store.removeToken(message.to);
          } else {
            this.store.markFailed(message.to);
          }
        }
      }
    }

    if (allFailed && !anyDelivered) {
      throw new Error(firstErrorMessage ?? "Expo push delivery failed for all tokens");
    }
  }

  async test(): Promise<boolean> {
    const Expo = await loadExpoSdk();
    if (!Expo) {
      throw new Error("expo-server-sdk is not installed. Run `pnpm install`.");
    }
    if (this.store.countActive() === 0) {
      throw new Error("No active Expo push tokens registered.");
    }
    return true;
  }

  async sendTest(): Promise<void> {
    await this.send({
      id: "expo-push-test",
      channel: "expo-push",
      title: "Polpo push test",
      body: "Expo push notifications are working for this device.",
      severity: "info",
      sourceEvent: "notification:test",
      sourceData: { test: true },
      ruleId: "expo-push-test",
      timestamp: new Date().toISOString(),
    });
  }
}
