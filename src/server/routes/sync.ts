import { OpenAPIHono } from "@hono/zod-openapi";
import { streamText } from "hono/streaming";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { publicSyncConfig, readSyncConfig, writeSyncConfig, type R2Config } from "../sync-config-store.js";
import { appendHistoryEntry, readHistory } from "../sync-history-store.js";

/** Module-level handle to the in-flight rclone process. Only one sync is
 * allowed at a time (the UI already enforces that), so a single ref is
 * enough — POST /cancel kills it. */
let activeChild: { process: ChildProcess; cancelled: boolean } | null = null;

/** In-memory snapshot of the current sync — polled by UIs that re-mount
 * (navigate away & back) so they can re-attach to a still-running rclone
 * without losing the bar. Updated by streamRclone on every stats line.
 *
 * SSE broadcast would be cleaner but polling is plenty fast for a 1s
 * stats cadence and avoids a second per-process channel. */
type ActiveSync = {
  id: string;
  direction: "push" | "pull";
  mode: "copy" | "sync";
  startedAt: string;
  bytes?: number;
  totalBytes?: number;
  transfers?: number;
  totalTransfers?: number;
  speed?: number;
  eta?: number;
  current?: string;
  recent: string[];
};
let activeSync: ActiveSync | null = null;

const R2ConfigSchema = z.object({
  endpoint: z.string().trim().min(1),
  accessKeyId: z.string().trim().min(1),
  // The UI sends back a masked placeholder when the user hasn't touched
  // the secret — keep the previous value in that case (handled below).
  secretAccessKey: z.string(),
  bucket: z.string().trim().min(1),
  prefix: z.string().trim().optional(),
});

const SyncConfigPatchSchema = z.object({
  r2: R2ConfigSchema.nullable().optional(),
});

export function syncRoutes(getDeps: () => { polpoDir: string; workDir: string }): OpenAPIHono {
  const app = new OpenAPIHono();

  app.get("/config", (c) => {
    return c.json({ ok: true, data: publicSyncConfig(readSyncConfig(getDeps().polpoDir)) });
  });

  app.put("/config", async (c) => {
    const parsed = SyncConfigPatchSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ ok: false, error: "Invalid sync config" }, 400);
    const current = readSyncConfig(getDeps().polpoDir);
    let r2: R2Config | undefined = current.r2;
    if (parsed.data.r2 === null) {
      r2 = undefined;
    } else if (parsed.data.r2) {
      const incoming = parsed.data.r2;
      // If the secret looks like the masked placeholder we sent down,
      // keep the existing one instead of clobbering it.
      const isMasked = isMaskedSecret(incoming.secretAccessKey);
      const secret = isMasked && current.r2 ? current.r2.secretAccessKey : incoming.secretAccessKey;
      r2 = {
        endpoint: incoming.endpoint,
        accessKeyId: incoming.accessKeyId,
        secretAccessKey: secret,
        bucket: incoming.bucket,
        prefix: incoming.prefix || undefined,
      };
    }
    const next = writeSyncConfig(getDeps().polpoDir, { r2 });
    return c.json({ ok: true, data: publicSyncConfig(next) });
  });

  app.post("/test", async (c) => {
    const cfg = readSyncConfig(getDeps().polpoDir);
    if (!cfg.r2) return c.json({ ok: false, error: "No R2 config" }, 400);
    const result = await rcloneOnce(cfg.r2, ["lsd", "r2:"]);
    return c.json(result.ok
      ? { ok: true, data: { stdout: result.stdout } }
      : { ok: false, error: result.stderr || "rclone test failed" });
  });

  app.post("/push", async (c) => {
    const { polpoDir, workDir } = getDeps();
    const cfg = readSyncConfig(polpoDir);
    if (!cfg.r2) return c.json({ ok: false, error: "Configure R2 in Settings first." }, 400);
    const mode = await readModeFlag(c);
    const remote = `r2:${joinRemote(cfg.r2.bucket, cfg.r2.prefix)}`;
    const args = baseArgs(mode, workDir, remote);
    return streamRclone(c, cfg.r2, args, {
      direction: "push",
      mode,
      polpoDir,
      onSuccess: () => writeSyncConfig(polpoDir, { lastPushedAt: new Date().toISOString() }),
    });
  });

  app.post("/pull", async (c) => {
    const { polpoDir, workDir } = getDeps();
    const cfg = readSyncConfig(polpoDir);
    if (!cfg.r2) return c.json({ ok: false, error: "Configure R2 in Settings first." }, 400);
    const mode = await readModeFlag(c);
    const remote = `r2:${joinRemote(cfg.r2.bucket, cfg.r2.prefix)}`;
    const args = baseArgs(mode, remote, workDir);
    return streamRclone(c, cfg.r2, args, {
      direction: "pull",
      mode,
      polpoDir,
      onSuccess: () => writeSyncConfig(polpoDir, { lastPulledAt: new Date().toISOString() }),
    });
  });

  // Snapshot of the in-flight sync for clients that just navigated back
  // to /config — lets them re-render the progress block without owning
  // the original streaming response.
  app.get("/active", (c) => {
    return c.json({ ok: true, data: activeSync });
  });

  // Cancel the in-flight sync, if any. Sends SIGTERM so rclone exits
  // gracefully (closing partial transfers); the streaming endpoint then
  // emits the {type:"done"} event and writes a "cancelled" history row.
  app.post("/cancel", (c) => {
    if (!activeChild) return c.json({ ok: false, error: "No sync in progress" }, 404);
    activeChild.cancelled = true;
    activeChild.process.kill("SIGTERM");
    return c.json({ ok: true });
  });

  // Append-only history of every sync run — direction, mode, file count,
  // bytes, duration, ok flag. Newest first.
  app.get("/history", (c) => {
    const limit = Math.max(1, Math.min(500, Number.parseInt(c.req.query("limit") ?? "100", 10) || 100));
    return c.json({ ok: true, data: readHistory(getDeps().polpoDir, limit) });
  });

  return app;
}

function baseArgs(mode: "copy" | "sync", source: string, dest: string): string[] {
  // copy --update keeps only newer files (non-destructive); sync makes the
  // destination an exact mirror (deletes extras). --use-json-log + 1s stats
  // give us machine-parseable progress to stream to the UI.
  const verb = mode === "sync" ? "sync" : "copy";
  const args = [verb, "--fast-list", "--use-json-log", "--stats=1s", "--stats-log-level", "INFO", "--verbose"];
  if (mode === "copy") args.push("--update");
  return [...args, source, dest];
}

async function readModeFlag(c: { req: { json: () => Promise<unknown> } }): Promise<"copy" | "sync"> {
  try {
    const body = await c.req.json();
    if (body && typeof body === "object" && (body as Record<string, unknown>).mode === "sync") {
      return "sync";
    }
  } catch { /* no body / invalid JSON — default to copy */ }
  return "copy";
}

/** Spawn rclone and stream its JSON-log output back to the client as
 * NDJSON. Each line is one of:
 *   - {"type":"log", ...rclone json log fields}
 *   - {"type":"done", "ok":bool, "code":number}
 * The temp config file with the R2 creds is removed once rclone exits.
 */
function streamRclone(
  c: Parameters<typeof streamText>[0],
  r2: R2Config,
  args: string[],
  meta: {
    direction: "push" | "pull";
    mode: "copy" | "sync";
    polpoDir: string;
    onSuccess?: () => void;
  },
) {
  return streamText(c, async (sse) => {
    if (!commandExists("rclone")) {
      await sse.writeln(JSON.stringify({ type: "done", ok: false, code: -1, error: "rclone is not installed on this server." }));
      return;
    }
    const startedAt = new Date();
    const id = `${startedAt.getTime()}-${Math.random().toString(36).slice(2, 6)}`;
    const tmp = mkdtempSync(join(tmpdir(), "polpo-rclone-"));
    const configFile = join(tmp, "rclone.conf");
    writeFileSync(configFile, renderRcloneConfig(r2), { mode: 0o600 });
    const child = spawn("rclone", ["--config", configFile, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChild = { process: child, cancelled: false };
    activeSync = {
      id,
      direction: meta.direction,
      mode: meta.mode,
      startedAt: startedAt.toISOString(),
      recent: [],
    };

    // Track the last seen stats payload — at exit it tells us how many
    // files / bytes actually went through, which is what we want in the
    // history table (rclone reports cumulatives).
    const stats: { files?: number; bytes?: number; lastError?: string } = {};

    const relay = (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          // Capture stats on each accounting/stats message — keep both
          // local cumulatives (for history) and the broadcast snapshot
          // (`activeSync`) in sync.
          if (parsed?.stats) {
            const s = parsed.stats;
            if (typeof s.transfers === "number") stats.files = s.transfers;
            if (typeof s.bytes === "number") stats.bytes = s.bytes;
            if (activeSync) {
              const tx = Array.isArray(s.transferring) ? s.transferring[0] : null;
              activeSync = {
                ...activeSync,
                bytes: typeof s.bytes === "number" ? s.bytes : activeSync.bytes,
                totalBytes: typeof s.totalBytes === "number" ? s.totalBytes : activeSync.totalBytes,
                transfers: typeof s.transfers === "number" ? s.transfers : activeSync.transfers,
                totalTransfers: typeof s.totalTransfers === "number" ? s.totalTransfers : activeSync.totalTransfers,
                speed: typeof s.speed === "number" ? s.speed : activeSync.speed,
                eta: typeof s.eta === "number" ? s.eta : activeSync.eta,
                current: tx?.name ?? activeSync.current,
              };
            }
          }
          // Per-file events get appended to the rolling tail so navigating
          // back also restores recent activity.
          if (activeSync && typeof parsed?.object === "string" && /Copied|Updated|Deleted/i.test(parsed.msg ?? "")) {
            activeSync = {
              ...activeSync,
              recent: [`${parsed.msg}: ${parsed.object}`, ...activeSync.recent].slice(0, 8),
            };
          }
          // Capture latest error message (rclone may emit multiple).
          if (parsed?.level === "error" && typeof parsed.msg === "string") {
            stats.lastError = parsed.msg;
          }
          void sse.writeln(JSON.stringify({ type: "log", ...parsed }));
        } catch {
          void sse.writeln(JSON.stringify({ type: "log", level: "info", msg: line }));
        }
      }
    };

    child.stdout.on("data", relay);
    child.stderr.on("data", relay);

    const code = await new Promise<number>((resolve) => {
      child.once("exit", (c2) => resolve(c2 ?? -1));
      child.once("error", () => resolve(-1));
    });

    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

    const cancelled = activeChild?.process === child && activeChild.cancelled;
    if (activeChild?.process === child) activeChild = null;
    if (activeSync?.id === id) activeSync = null;

    const endedAt = new Date();
    const ok = code === 0;
    if (ok && meta.onSuccess) meta.onSuccess();

    const errorMsg = cancelled
      ? "Cancelled by user"
      : ok
        ? undefined
        : (stats.lastError ?? `rclone exited with code ${code}`);

    appendHistoryEntry(meta.polpoDir, {
      id,
      direction: meta.direction,
      mode: meta.mode,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: endedAt.getTime() - startedAt.getTime(),
      ok,
      files: stats.files ?? 0,
      bytes: stats.bytes ?? 0,
      ...(errorMsg ? { error: errorMsg } : {}),
    });

    await sse.writeln(JSON.stringify({ type: "done", ok, code, cancelled, error: errorMsg }));
  });
}

/** Run rclone once with a temporary config file holding the R2 creds.
 * Using a config file (rather than --s3-* flags) keeps the secret out
 * of `ps` output. The temp dir is cleaned up unconditionally. */
async function rcloneOnce(r2: R2Config, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  if (!existsSync("/usr/bin/rclone") && !commandExists("rclone")) {
    return { ok: false, stdout: "", stderr: "rclone is not installed on this server. Install it on the host." };
  }
  const tmp = mkdtempSync(join(tmpdir(), "polpo-rclone-"));
  const configFile = join(tmp, "rclone.conf");
  try {
    writeFileSync(configFile, renderRcloneConfig(r2), { mode: 0o600 });
    const r = spawnSync("rclone", ["--config", configFile, ...args], {
      encoding: "utf-8",
      timeout: 30 * 60_000,
      maxBuffer: 50 * 1024 * 1024,
    });
    return {
      ok: r.status === 0,
      stdout: (r.stdout ?? "").trim(),
      stderr: (r.stderr ?? "").trim(),
    };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function renderRcloneConfig(r2: R2Config): string {
  // R2 = S3-compatible. `provider = Cloudflare` enables R2-friendly
  // defaults inside rclone (e.g., region "auto").
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

function isMaskedSecret(s: string): boolean {
  // The redacted form sent by publicSyncConfig.
  return s === "********" || /^.{4}….{4}$/.test(s);
}

function commandExists(cmd: string): boolean {
  const r = spawnSync("which", [cmd], { encoding: "utf-8" });
  return r.status === 0 && !!(r.stdout ?? "").trim();
}
