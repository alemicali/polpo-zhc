import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * R2 / S3-compatible sync target.
 *
 * Stored at `<polpoDir>/sync-config.json` — out of `polpo.json` because
 * those credentials are operator-scoped and shouldn't end up in any
 * repo-checked-in project config. Treated as plain JSON for now (the
 * polpoDir is already user-only on disk).
 */
export type R2Config = {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Optional path prefix inside the bucket. The whole workDir syncs to
   * `<bucket>/<prefix>/`. Useful to share one bucket across hosts. */
  prefix?: string;
};

export type SyncSchedule = {
  enabled: boolean;
  /** Cron expression (5- or 6-field). Croner picks up "every 15m" via
   * \"every-15min cron\", "daily 03:00" via "0 3 * * *", etc. */
  cron: string;
  /** Direction is always push for scheduled runs (the use case is
   * automated backup of the workDir up to R2). Mode is locked to copy
   * `--update` so we never auto-delete remote files. */
};

export type SyncConfig = {
  r2?: R2Config;
  /** Last successful sync timestamps (ISO). Lets the UI surface "Last
   * pushed 3m ago" without server-side timers. */
  lastPushedAt?: string;
  lastPulledAt?: string;
  /** Optional auto-push schedule. Lives in the same JSON so it
   * rehydrates on server restart. */
  schedule?: SyncSchedule;
  /** rclone-style filter patterns to skip during every push/pull.
   * Applied at every directory level (e.g. `node_modules/**` matches a
   * node_modules folder anywhere in the tree). Empty = no filtering. */
  excludes?: string[];
};

export const DEFAULT_SYNC_CONFIG: SyncConfig = {};

const FILE_NAME = "sync-config.json";

function configPath(polpoDir: string): string {
  return join(polpoDir, FILE_NAME);
}

export function readSyncConfig(polpoDir: string): SyncConfig {
  const file = configPath(polpoDir);
  if (!existsSync(file)) return DEFAULT_SYNC_CONFIG;
  try {
    return normalize(JSON.parse(readFileSync(file, "utf-8")));
  } catch {
    return DEFAULT_SYNC_CONFIG;
  }
}

export function writeSyncConfig(polpoDir: string, patch: Partial<SyncConfig>): SyncConfig {
  if (!existsSync(polpoDir)) mkdirSync(polpoDir, { recursive: true });
  const current = readSyncConfig(polpoDir);
  const next = normalize({ ...current, ...patch });
  const file = configPath(polpoDir);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), "utf-8");
  renameSync(tmp, file);
  return next;
}

function normalize(value: unknown): SyncConfig {
  if (!value || typeof value !== "object") return DEFAULT_SYNC_CONFIG;
  const record = value as Record<string, unknown>;
  return {
    r2: normalizeR2(record.r2),
    lastPushedAt: typeof record.lastPushedAt === "string" ? record.lastPushedAt : undefined,
    lastPulledAt: typeof record.lastPulledAt === "string" ? record.lastPulledAt : undefined,
    schedule: normalizeSchedule(record.schedule),
    excludes: Array.isArray(record.excludes)
      ? record.excludes.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => p.trim())
      : [],
  };
}

function normalizeSchedule(value: unknown): SyncSchedule | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  const cron = typeof r.cron === "string" ? r.cron.trim() : "";
  if (!cron) return undefined;
  return { enabled: r.enabled === true, cron };
}

function normalizeR2(value: unknown): R2Config | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  const get = (k: string) => (typeof r[k] === "string" ? (r[k] as string).trim() : "");
  const endpoint = get("endpoint");
  const accessKeyId = get("accessKeyId");
  const secretAccessKey = get("secretAccessKey");
  const bucket = get("bucket");
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) return undefined;
  const prefix = get("prefix");
  return { endpoint, accessKeyId, secretAccessKey, bucket, prefix: prefix || undefined };
}

/** Redact the secret before sending the config back to the UI. */
export function publicSyncConfig(cfg: SyncConfig): SyncConfig & { r2?: R2Config & { secretAccessKey: string } } {
  if (!cfg.r2) return cfg;
  const masked = cfg.r2.secretAccessKey
    ? cfg.r2.secretAccessKey.length <= 8
      ? "********"
      : `${cfg.r2.secretAccessKey.slice(0, 4)}…${cfg.r2.secretAccessKey.slice(-4)}`
    : "";
  return { ...cfg, r2: { ...cfg.r2, secretAccessKey: masked } };
}
