import { Cron } from "croner";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendHistoryEntry } from "./sync-history-store.js";
import { readSyncConfig, writeSyncConfig, type R2Config, type SyncConfig } from "./sync-config-store.js";

/**
 * Auto-push scheduler.
 *
 * Reads the schedule out of `<polpoDir>/sync-config.json` (which already
 * survives server restarts) and registers a croner Cron. Each tick
 * shells out to `rclone copy --update` against the configured R2 target;
 * the run is recorded in the same sync-history.jsonl as manual runs so
 * the UI table treats them uniformly.
 *
 * Concurrency: if a sync is already running (manual or previous tick
 * still hasn't finished) we skip the tick. The single `running` flag
 * also prevents two scheduled tasks from doubling up.
 */
export class SyncScheduler {
  private cron: Cron | null = null;
  private running = false;

  constructor(
    private readonly polpoDir: string,
    private readonly workDir: string,
    /** When the scheduler kicks off rclone, we want to coexist with the
     * manual /push and /pull endpoints — share their "is something
     * running?" gate so two ptys don't try to copy the same files. */
    private readonly isManualSyncActive: () => boolean,
  ) {}

  /** Read config + (re)register the timer. Idempotent. */
  reload(): void {
    this.stop();
    const cfg = readSyncConfig(this.polpoDir);
    if (!cfg.schedule || !cfg.schedule.enabled || !cfg.r2) return;
    try {
      this.cron = new Cron(cfg.schedule.cron, () => void this.tick());
    } catch (err) {
      console.warn("[sync-scheduler] invalid cron:", cfg.schedule.cron, err instanceof Error ? err.message : err);
      this.cron = null;
    }
  }

  stop(): void {
    if (this.cron) {
      try { this.cron.stop(); } catch { /* ignore */ }
      this.cron = null;
    }
  }

  /** Earliest time the schedule will fire next, in ISO. Useful for the
   * UI to render "Next run at: …" without re-parsing the cron itself. */
  nextRunAt(): string | null {
    if (!this.cron) return null;
    try {
      const d = this.cron.nextRun();
      return d ? d.toISOString() : null;
    } catch { return null; }
  }

  private async tick(): Promise<void> {
    if (this.running || this.isManualSyncActive()) {
      // Skip — don't queue. The next tick will get its turn if the
      // current run wraps up by then.
      return;
    }
    const cfg = readSyncConfig(this.polpoDir);
    if (!cfg.r2) return;
    this.running = true;
    try {
      await runScheduledPush(this.polpoDir, this.workDir, cfg);
    } catch (err) {
      console.warn("[sync-scheduler] push failed:", err instanceof Error ? err.message : err);
    } finally {
      this.running = false;
    }
  }
}

/** Standalone push driver — no streaming, just runs rclone and records
 * the entry in history. Mirrors the body of streamRclone but trimmed of
 * the SSE / cancellation plumbing (auto-runs aren't user-cancellable). */
async function runScheduledPush(polpoDir: string, workDir: string, cfg: SyncConfig): Promise<void> {
  if (!cfg.r2) return;
  const tmp = mkdtempSync(join(tmpdir(), "polpo-rclone-cron-"));
  const configFile = join(tmp, "rclone.conf");
  writeFileSync(configFile, renderRcloneConfig(cfg.r2), { mode: 0o600 });
  const remote = `r2:${joinRemote(cfg.r2.bucket, cfg.r2.prefix)}`;
  const startedAt = new Date();
  const id = `cron-${startedAt.getTime()}`;
  const stats: { files: number; bytes: number; lastError?: string } = { files: 0, bytes: 0 };

  const args = [
    "--config", configFile,
    "copy", "--update", "--fast-list", "--use-json-log",
    "--stats=10s", "--stats-log-level", "INFO",
  ];
  for (const pattern of cfg.excludes ?? []) {
    args.push("--exclude", pattern);
  }
  args.push(workDir, remote);

  const child = spawn("rclone", args, { stdio: ["ignore", "pipe", "pipe"] });

  const onLine = (line: string) => {
    if (!line) return;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.stats) {
        if (typeof parsed.stats.transfers === "number") stats.files = parsed.stats.transfers;
        if (typeof parsed.stats.bytes === "number") stats.bytes = parsed.stats.bytes;
      }
      if (parsed?.level === "error" && typeof parsed.msg === "string") {
        stats.lastError = parsed.msg;
      }
    } catch { /* non-JSON */ }
  };
  const drain = (chunk: Buffer) => {
    for (const line of chunk.toString("utf-8").split(/\r?\n/)) onLine(line.trim());
  };
  child.stdout.on("data", drain);
  child.stderr.on("data", drain);

  const code = await new Promise<number>((resolve) => {
    child.once("exit", (c) => resolve(c ?? -1));
    child.once("error", () => resolve(-1));
  });
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

  const endedAt = new Date();
  const ok = code === 0;
  if (ok) writeSyncConfig(polpoDir, { lastPushedAt: endedAt.toISOString() });

  appendHistoryEntry(polpoDir, {
    id,
    direction: "push",
    mode: "copy",
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    ok,
    files: stats.files,
    bytes: stats.bytes,
    ...(ok ? {} : { error: stats.lastError ?? `rclone exited with code ${code}` }),
  });
}

function renderRcloneConfig(r2: R2Config): string {
  return [
    "[r2]",
    "type = s3",
    "provider = Cloudflare",
    `access_key_id = ${r2.accessKeyId}`,
    `secret_access_key = ${r2.secretAccessKey}`,
    `endpoint = ${r2.endpoint}`,
    "region = auto",
    "",
  ].join("\n");
}

function joinRemote(bucket: string, prefix?: string): string {
  const cleanPrefix = (prefix ?? "").replace(/^\/+|\/+$/g, "");
  return cleanPrefix ? `${bucket}/${cleanPrefix}` : bucket;
}
