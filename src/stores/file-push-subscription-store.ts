import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import webpush from "web-push";

export interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

export interface PushSubscriptionRecord {
  endpoint: string;
  expirationTime?: number | null;
  keys: PushSubscriptionKeys;
  userAgent?: string;
  createdAt: string;
  updatedAt: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  failureCount?: number;
}

export interface PushVapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

interface PushStoreFile {
  vapid?: PushVapidConfig;
  subscriptions?: PushSubscriptionRecord[];
}

const DEFAULT_VAPID_SUBJECT = "mailto:hello@polpo.ai";

/**
 * Filesystem-backed Web Push state.
 *
 * Stores VAPID keys and browser subscriptions in `.polpo/push.json`.
 * The subscription endpoint is treated as secret application state and never
 * needs to live in `polpo.json`.
 */
export class FilePushSubscriptionStore {
  private filePath: string;
  private data: PushStoreFile;

  constructor(polpoDir: string) {
    if (!existsSync(polpoDir)) mkdirSync(polpoDir, { recursive: true });
    this.filePath = join(polpoDir, "push.json");
    this.data = this.load();
  }

  ensureVapid(subject = process.env.POLPO_PUSH_VAPID_SUBJECT ?? DEFAULT_VAPID_SUBJECT): PushVapidConfig {
    this.refresh();
    if (this.data.vapid?.publicKey && this.data.vapid.privateKey) {
      return this.data.vapid;
    }
    const keys = webpush.generateVAPIDKeys();
    this.data.vapid = {
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subject,
    };
    this.save();
    return this.data.vapid;
  }

  getVapid(): PushVapidConfig | undefined {
    this.refresh();
    return this.data.vapid;
  }

  upsert(subscription: {
    endpoint: string;
    expirationTime?: number | null;
    keys: PushSubscriptionKeys;
  }, userAgent?: string): PushSubscriptionRecord {
    this.refresh();
    const now = new Date().toISOString();
    const records = this.data.subscriptions ?? [];
    const existing = records.find((record) => record.endpoint === subscription.endpoint);
    if (existing) {
      existing.expirationTime = subscription.expirationTime;
      existing.keys = subscription.keys;
      existing.userAgent = userAgent ?? existing.userAgent;
      existing.updatedAt = now;
      existing.failureCount = 0;
      existing.lastFailureAt = undefined;
      this.data.subscriptions = records;
      this.save();
      return existing;
    }

    const record: PushSubscriptionRecord = {
      endpoint: subscription.endpoint,
      expirationTime: subscription.expirationTime,
      keys: subscription.keys,
      userAgent,
      createdAt: now,
      updatedAt: now,
      failureCount: 0,
    };
    records.push(record);
    this.data.subscriptions = records;
    this.save();
    return record;
  }

  remove(endpoint: string): boolean {
    this.refresh();
    const records = this.data.subscriptions ?? [];
    const next = records.filter((record) => record.endpoint !== endpoint);
    if (next.length === records.length) return false;
    this.data.subscriptions = next;
    this.save();
    return true;
  }

  list(): PushSubscriptionRecord[] {
    this.refresh();
    return [...(this.data.subscriptions ?? [])];
  }

  count(): number {
    this.refresh();
    return this.data.subscriptions?.length ?? 0;
  }

  markSuccess(endpoint: string): void {
    this.refresh();
    const record = this.data.subscriptions?.find((item) => item.endpoint === endpoint);
    if (!record) return;
    record.lastSuccessAt = new Date().toISOString();
    record.failureCount = 0;
    record.lastFailureAt = undefined;
    this.save();
  }

  markFailure(endpoint: string): void {
    this.refresh();
    const record = this.data.subscriptions?.find((item) => item.endpoint === endpoint);
    if (!record) return;
    record.lastFailureAt = new Date().toISOString();
    record.failureCount = (record.failureCount ?? 0) + 1;
    this.save();
  }

  private refresh(): void {
    this.data = this.load();
  }

  private load(): PushStoreFile {
    if (!existsSync(this.filePath)) return { subscriptions: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf-8"));
      return {
        vapid: isVapidConfig(parsed?.vapid) ? parsed.vapid : undefined,
        subscriptions: Array.isArray(parsed?.subscriptions)
          ? parsed.subscriptions.filter(isPushSubscriptionRecord)
          : [],
      };
    } catch {
      return { subscriptions: [] };
    }
  }

  private save(): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf-8");
    renameSync(tmp, this.filePath);
  }
}

function isVapidConfig(value: unknown): value is PushVapidConfig {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.publicKey === "string"
    && typeof record.privateKey === "string"
    && typeof record.subject === "string";
}

function isPushSubscriptionRecord(value: unknown): value is PushSubscriptionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const keys = record.keys as Record<string, unknown> | undefined;
  return typeof record.endpoint === "string"
    && !!keys
    && typeof keys.p256dh === "string"
    && typeof keys.auth === "string";
}
