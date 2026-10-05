import { eq, sql } from "drizzle-orm";
import { type Dialect } from "../utils.js";

export interface PushSubscriptionKeys { p256dh: string; auth: string }

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

type AnyTable = any;

const VAPID_SINGLETON_ID = 1;

/**
 * Drizzle implementation of the Web Push subscription store + VAPID config.
 *
 * VAPID key generation is delegated to the `web-push` package only when the
 * caller invokes `ensureVapid` — we don't take a hard dependency on it from
 * this package so it stays optional for callers who never use push.
 */
export class DrizzlePushSubscriptionStore {
  constructor(
    private db: any,
    private subscriptions: AnyTable,
    private vapid: AnyTable,
    private dialect: Dialect,
  ) {}

  private rowToRecord(row: any): PushSubscriptionRecord {
    return {
      endpoint: row.endpoint,
      expirationTime: row.expirationTime ?? undefined,
      keys: { p256dh: row.p256dh, auth: row.auth },
      userAgent: row.userAgent ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastSuccessAt: row.lastSuccessAt ?? undefined,
      lastFailureAt: row.lastFailureAt ?? undefined,
      failureCount: row.failureCount ?? 0,
    };
  }

  async getVapid(): Promise<PushVapidConfig | undefined> {
    const rows: any[] = await this.db.select().from(this.vapid).where(eq(this.vapid.id, VAPID_SINGLETON_ID));
    if (rows.length === 0) return undefined;
    return {
      publicKey: rows[0].publicKey,
      privateKey: rows[0].privateKey,
      subject: rows[0].subject,
    };
  }

  /**
   * Lazy-generate and persist a VAPID keypair on first call. The web-push
   * import is dynamic so this package keeps web-push as an optional peer.
   */
  async ensureVapid(subject = "mailto:hello@polpo.ai"): Promise<PushVapidConfig> {
    const existing = await this.getVapid();
    if (existing) return existing;
    const webpush = await import("web-push" as any).then((m: any) => m.default ?? m);
    const keys = webpush.generateVAPIDKeys();
    const next: PushVapidConfig = { publicKey: keys.publicKey, privateKey: keys.privateKey, subject };
    await this.db.insert(this.vapid).values({ id: VAPID_SINGLETON_ID, ...next })
      .onConflictDoNothing({ target: this.vapid.id });
    return next;
  }

  /** Replace whatever VAPID config is on disk — used by the migration path. */
  async setVapid(config: PushVapidConfig): Promise<void> {
    await this.db.insert(this.vapid).values({ id: VAPID_SINGLETON_ID, ...config })
      .onConflictDoUpdate({ target: this.vapid.id, set: { publicKey: config.publicKey, privateKey: config.privateKey, subject: config.subject } });
  }

  async upsert(subscription: { endpoint: string; expirationTime?: number | null; keys: PushSubscriptionKeys }, userAgent?: string): Promise<PushSubscriptionRecord> {
    const now = new Date().toISOString();
    const existing: any[] = await this.db.select().from(this.subscriptions).where(eq(this.subscriptions.endpoint, subscription.endpoint));
    if (existing.length > 0) {
      await this.db.update(this.subscriptions)
        .set({
          expirationTime: subscription.expirationTime ?? null,
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
          userAgent: userAgent ?? existing[0].userAgent ?? null,
          updatedAt: now,
          failureCount: 0,
          lastFailureAt: null,
        })
        .where(eq(this.subscriptions.endpoint, subscription.endpoint));
      const updated = await this.db.select().from(this.subscriptions).where(eq(this.subscriptions.endpoint, subscription.endpoint));
      return this.rowToRecord(updated[0]);
    }
    await this.db.insert(this.subscriptions).values({
      endpoint: subscription.endpoint,
      expirationTime: subscription.expirationTime ?? null,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent: userAgent ?? null,
      createdAt: now,
      updatedAt: now,
      failureCount: 0,
    });
    return {
      endpoint: subscription.endpoint,
      expirationTime: subscription.expirationTime,
      keys: subscription.keys,
      userAgent,
      createdAt: now,
      updatedAt: now,
      failureCount: 0,
    };
  }

  async remove(endpoint: string): Promise<boolean> {
    const result: any = await this.db.delete(this.subscriptions).where(eq(this.subscriptions.endpoint, endpoint));
    const changes = result?.changes ?? result?.rowCount ?? 0;
    return changes > 0;
  }

  async list(): Promise<PushSubscriptionRecord[]> {
    const rows: any[] = await this.db.select().from(this.subscriptions);
    return rows.map((r) => this.rowToRecord(r));
  }

  async count(): Promise<number> {
    const rows: any[] = await this.db.select({ c: sql<number>`count(*)` }).from(this.subscriptions);
    return Number(rows[0]?.c ?? 0);
  }

  async markSuccess(endpoint: string): Promise<void> {
    await this.db.update(this.subscriptions)
      .set({ lastSuccessAt: new Date().toISOString(), failureCount: 0, lastFailureAt: null })
      .where(eq(this.subscriptions.endpoint, endpoint));
  }

  async markFailure(endpoint: string): Promise<void> {
    const rows: any[] = await this.db.select().from(this.subscriptions).where(eq(this.subscriptions.endpoint, endpoint));
    if (rows.length === 0) return;
    const next = (rows[0].failureCount ?? 0) + 1;
    await this.db.update(this.subscriptions)
      .set({ lastFailureAt: new Date().toISOString(), failureCount: next })
      .where(eq(this.subscriptions.endpoint, endpoint));
  }
}
