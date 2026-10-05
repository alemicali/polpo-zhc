import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One Expo push registration. We treat (deviceId + token) as the natural
 * identity — re-registering the same pair just bumps `lastSeenAt` instead
 * of inserting a duplicate. The store self-disables tokens after three
 * consecutive delivery failures so a dead device doesn't keep churning the
 * Expo push service.
 */
export interface ExpoTokenRecord {
  token: string;
  platform: "ios" | "android";
  deviceId: string;
  createdAt: string;
  lastSeenAt: string;
  failureCount: number;
  disabled: boolean;
}

interface ExpoTokenStoreFile {
  tokens?: ExpoTokenRecord[];
}

const FAILURE_THRESHOLD = 3;

/**
 * Filesystem-backed Expo push token store.
 *
 * Persists in `<polpoDir>/expo-tokens.json`. Designed to mirror the public
 * surface of FilePushSubscriptionStore (Web Push) so the Expo channel can
 * follow the same handle/disable/cleanup pattern without sharing storage.
 *
 * 1 token = 1 anonymous device — no auth, no user binding. This is fine for
 * the MVP: any client that knows the device id and current token can hit
 * /register-token to claim it.
 */
export class FileExpoTokenStore {
  private filePath: string;
  private data: ExpoTokenStoreFile;

  constructor(polpoDir: string) {
    if (!existsSync(polpoDir)) mkdirSync(polpoDir, { recursive: true });
    this.filePath = join(polpoDir, "expo-tokens.json");
    this.data = this.load();
  }

  /**
   * Idempotent insert/update.
   *
   * If a record with the same (deviceId, token) pair exists, we bump
   * `lastSeenAt` and clear the failure counter (the client wouldn't be
   * registering again unless it's healthy). Otherwise we insert a fresh row.
   *
   * If the same deviceId arrives with a *different* token (token rotation),
   * older rows for that deviceId are left in place but disabled — Expo
   * will reject pushes to stale tokens with a `DeviceNotRegistered` ticket
   * which is the canonical signal to call `removeToken()`.
   */
  saveToken(input: { token: string; platform: "ios" | "android"; deviceId: string }): ExpoTokenRecord {
    this.refresh();
    const now = new Date().toISOString();
    const records = this.data.tokens ?? [];
    const existing = records.find(
      (r) => r.deviceId === input.deviceId && r.token === input.token,
    );
    if (existing) {
      existing.lastSeenAt = now;
      existing.failureCount = 0;
      existing.disabled = false;
      existing.platform = input.platform;
      this.data.tokens = records;
      this.save();
      return existing;
    }
    const record: ExpoTokenRecord = {
      token: input.token,
      platform: input.platform,
      deviceId: input.deviceId,
      createdAt: now,
      lastSeenAt: now,
      failureCount: 0,
      disabled: false,
    };
    records.push(record);
    this.data.tokens = records;
    this.save();
    return record;
  }

  removeToken(token: string): boolean {
    this.refresh();
    const records = this.data.tokens ?? [];
    const next = records.filter((r) => r.token !== token);
    if (next.length === records.length) return false;
    this.data.tokens = next;
    this.save();
    return true;
  }

  removeByDevice(deviceId: string): number {
    this.refresh();
    const records = this.data.tokens ?? [];
    const next = records.filter((r) => r.deviceId !== deviceId);
    const removed = records.length - next.length;
    if (removed > 0) {
      this.data.tokens = next;
      this.save();
    }
    return removed;
  }

  /** All registered tokens (active + disabled). Channel implementations
   *  should filter on `!record.disabled` before sending. */
  listAll(): ExpoTokenRecord[] {
    this.refresh();
    return [...(this.data.tokens ?? [])];
  }

  listActive(): ExpoTokenRecord[] {
    return this.listAll().filter((r) => !r.disabled);
  }

  count(): number {
    this.refresh();
    return this.data.tokens?.length ?? 0;
  }

  countActive(): number {
    return this.listActive().length;
  }

  markFailed(token: string): void {
    this.refresh();
    const record = this.data.tokens?.find((r) => r.token === token);
    if (!record) return;
    record.failureCount = (record.failureCount ?? 0) + 1;
    if (record.failureCount >= FAILURE_THRESHOLD) {
      record.disabled = true;
    }
    this.save();
  }

  markSuccess(token: string): void {
    this.refresh();
    const record = this.data.tokens?.find((r) => r.token === token);
    if (!record) return;
    record.failureCount = 0;
    record.lastSeenAt = new Date().toISOString();
    record.disabled = false;
    this.save();
  }

  private refresh(): void {
    this.data = this.load();
  }

  private load(): ExpoTokenStoreFile {
    if (!existsSync(this.filePath)) return { tokens: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf-8"));
      return {
        tokens: Array.isArray(parsed?.tokens) ? parsed.tokens.filter(isExpoTokenRecord) : [],
      };
    } catch {
      return { tokens: [] };
    }
  }

  private save(): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf-8");
    renameSync(tmp, this.filePath);
  }
}

function isExpoTokenRecord(value: unknown): value is ExpoTokenRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return typeof r.token === "string"
    && (r.platform === "ios" || r.platform === "android")
    && typeof r.deviceId === "string"
    && typeof r.createdAt === "string"
    && typeof r.lastSeenAt === "string";
}
