import { and, eq } from "drizzle-orm";
import { type Dialect } from "../utils.js";

export interface ExpoTokenRecord {
  token: string;
  platform: "ios" | "android";
  deviceId: string;
  createdAt: string;
  lastSeenAt: string;
  failureCount: number;
  disabled: boolean;
}

type AnyTable = any;

const FAILURE_THRESHOLD = 3;

/**
 * Drizzle implementation of the Expo push token store.
 *
 * The on-disk file store keyed on (deviceId, token); we keep the same identity
 * semantics — a `saveToken` for an existing row only bumps `lastSeenAt` and
 * resets the failure counter, otherwise inserts a fresh row.
 */
export class DrizzleExpoTokenStore {
  constructor(
    private db: any,
    private tokens: AnyTable,
    private dialect: Dialect,
  ) {}

  private rowToRecord(row: any): ExpoTokenRecord {
    return {
      token: row.token,
      platform: row.platform as "ios" | "android",
      deviceId: row.deviceId,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      failureCount: row.failureCount ?? 0,
      disabled: row.disabled === true || row.disabled === 1,
    };
  }

  async saveToken(input: { token: string; platform: "ios" | "android"; deviceId: string }): Promise<ExpoTokenRecord> {
    const now = new Date().toISOString();
    const existing: any[] = await this.db.select().from(this.tokens)
      .where(and(eq(this.tokens.deviceId, input.deviceId), eq(this.tokens.token, input.token)));
    if (existing.length > 0) {
      await this.db.update(this.tokens)
        .set({ lastSeenAt: now, failureCount: 0, disabled: false, platform: input.platform })
        .where(eq(this.tokens.token, input.token));
      return this.rowToRecord({ ...existing[0], lastSeenAt: now, failureCount: 0, disabled: false, platform: input.platform });
    }
    await this.db.insert(this.tokens).values({
      token: input.token,
      platform: input.platform,
      deviceId: input.deviceId,
      createdAt: now,
      lastSeenAt: now,
      failureCount: 0,
      disabled: false,
    });
    return {
      token: input.token,
      platform: input.platform,
      deviceId: input.deviceId,
      createdAt: now,
      lastSeenAt: now,
      failureCount: 0,
      disabled: false,
    };
  }

  async removeToken(token: string): Promise<boolean> {
    const result: any = await this.db.delete(this.tokens).where(eq(this.tokens.token, token));
    // SQLite returns { changes: N }; PG returns { count: N }.
    const changes = result?.changes ?? result?.rowCount ?? 0;
    return changes > 0;
  }

  async removeByDevice(deviceId: string): Promise<number> {
    const result: any = await this.db.delete(this.tokens).where(eq(this.tokens.deviceId, deviceId));
    return result?.changes ?? result?.rowCount ?? 0;
  }

  async listAll(): Promise<ExpoTokenRecord[]> {
    const rows: any[] = await this.db.select().from(this.tokens);
    return rows.map((r) => this.rowToRecord(r));
  }

  async listActive(): Promise<ExpoTokenRecord[]> {
    const all = await this.listAll();
    return all.filter((r) => !r.disabled);
  }

  async count(): Promise<number> {
    return (await this.listAll()).length;
  }

  async countActive(): Promise<number> {
    return (await this.listActive()).length;
  }

  async markFailed(token: string): Promise<void> {
    const rows: any[] = await this.db.select().from(this.tokens).where(eq(this.tokens.token, token));
    if (rows.length === 0) return;
    const current = rows[0];
    const next = (current.failureCount ?? 0) + 1;
    await this.db.update(this.tokens)
      .set({ failureCount: next, disabled: next >= FAILURE_THRESHOLD })
      .where(eq(this.tokens.token, token));
  }

  async markSuccess(token: string): Promise<void> {
    await this.db.update(this.tokens)
      .set({ failureCount: 0, disabled: false, lastSeenAt: new Date().toISOString() })
      .where(eq(this.tokens.token, token));
  }
}
