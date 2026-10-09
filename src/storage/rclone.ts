/**
 * Host helpers for mounting buckets: rclone remote configuration through environment variables
 * (credentials go to the rclone child only, never on its command line or in a config file),
 * mount arguments for rclone and mountpoint-s3, FUSE mount detection and unmounting.
 */

import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { StorageCredentials, StorageEntry } from "@polpo-ai/core/storage-registry";
import { normalizeStoragePrefix } from "@polpo-ai/core/storage-registry";
import { s3TargetFor } from "./s3.js";

/** Name of the rclone remote defined through RCLONE_CONFIG_POLPO_* variables. */
export const RCLONE_REMOTE = "polpo";

/** The executable's path, or undefined when it is not on PATH. */
export function findBinary(name: string, path = process.env.PATH ?? ""): string | undefined {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* not here */ }
  }
  return undefined;
}

/** "fusermount3" when present (FUSE 3), else "fusermount", else undefined. */
export function fusermountBinary(): string | undefined {
  return findBinary("fusermount3") ?? findBinary("fusermount");
}

/** rclone's S3 provider for an endpoint (it adjusts a few defaults per vendor). */
export function rcloneProvider(entry: Pick<StorageEntry, "endpoint">): string {
  if (!entry.endpoint) return "AWS";
  const host = (() => { try { return new URL(entry.endpoint).hostname; } catch { return ""; } })();
  if (/\.r2\.cloudflarestorage\.com$/i.test(host)) return "Cloudflare";
  if (/amazonaws\.com$/i.test(host)) return "AWS";
  if (/wasabisys\.com$/i.test(host)) return "Wasabi";
  return "Other";
}

/** RCLONE_CONFIG_POLPO_* variables defining the remote, credentials included. */
export function rcloneRemoteEnv(entry: StorageEntry, credentials: StorageCredentials): Record<string, string> {
  const target = s3TargetFor(entry);
  const key = `RCLONE_CONFIG_${RCLONE_REMOTE.toUpperCase()}_`;
  const env: Record<string, string> = {
    [`${key}TYPE`]: "s3",
    [`${key}PROVIDER`]: rcloneProvider(entry),
    [`${key}ENV_AUTH`]: "false",
    [`${key}ACCESS_KEY_ID`]: credentials.accessKeyId,
    [`${key}SECRET_ACCESS_KEY`]: credentials.secretAccessKey,
    [`${key}REGION`]: target.region,
    [`${key}FORCE_PATH_STYLE`]: String(target.pathStyle),
    // The bucket exists already: never try to create it.
    [`${key}NO_CHECK_BUCKET`]: "true",
  };
  if (entry.endpoint) env[`${key}ENDPOINT`] = target.endpoint;
  if (credentials.sessionToken) env[`${key}SESSION_TOKEN`] = credentials.sessionToken;
  return env;
}

/** "polpo:bucket/prefix" (no trailing slash). */
export function rcloneRemotePath(entry: Pick<StorageEntry, "bucket" | "prefix">): string {
  const prefix = normalizeStoragePrefix(entry.prefix).replace(/\/$/, "");
  return `${RCLONE_REMOTE}:${entry.bucket}${prefix ? `/${prefix}` : ""}`;
}

/**
 * Environment of a mount child: just what it needs. The server's own environment (database
 * URLs, API keys…) is not passed on.
 */
export function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
  for (const name of ["HOME", "LANG", "TZ", "TMPDIR"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return { ...env, ...extra };
}

export function rcloneMountArgs(entry: StorageEntry, mountPath: string, cacheDir: string): string[] {
  const cache = entry.cache ?? {};
  const args = [
    "mount", rcloneRemotePath(entry), mountPath,
    // Remote defined by environment variables only; never read or write an rclone.conf.
    "--config", "",
    "--cache-dir", cacheDir,
    "--vfs-cache-mode", cache.mode ?? "writes",
    "--vfs-cache-max-size", `${Math.max(64, Math.floor(cache.maxSizeMb ?? 1024))}M`,
    "--vfs-cache-max-age", `${Math.max(1, Math.floor(cache.maxAgeHours ?? 24))}h`,
    // Objects written through the storage_* tools or by other machines show up within this time.
    "--dir-cache-time", "30s",
    "--poll-interval", "0",
    "--log-level", "NOTICE",
  ];
  if (entry.readOnly) args.push("--read-only");
  return args;
}

/** mountpoint-s3 ("mount-s3"): read-only, credentials through AWS_* variables. */
export function mountpointS3Args(entry: StorageEntry, mountPath: string, cacheDir: string): string[] {
  const target = s3TargetFor(entry);
  const args = [entry.bucket, mountPath, "--foreground", "--read-only", "--region", target.region, "--cache", cacheDir];
  const prefix = normalizeStoragePrefix(entry.prefix);
  if (prefix) args.push("--prefix", prefix);
  if (entry.endpoint) args.push("--endpoint-url", target.endpoint);
  if (target.pathStyle) args.push("--force-path-style");
  if (entry.cache?.maxSizeMb) args.push("--max-cache-size", String(Math.floor(entry.cache.maxSizeMb)));
  return args;
}

export function mountpointS3Env(credentials: StorageCredentials): Record<string, string> {
  return {
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    ...(credentials.sessionToken ? { AWS_SESSION_TOKEN: credentials.sessionToken } : {}),
  };
}

/** Mount points of this process' namespace (from /proc/self/mountinfo). */
export function mountedPaths(): Set<string> {
  try {
    const lines = readFileSync("/proc/self/mountinfo", "utf8").split("\n");
    // Field 5 is the mount point; spaces and other characters are octal-escaped (\040).
    return new Set(lines.map((line) => line.split(" ")[4]).filter((p): p is string => !!p)
      .map((p) => p.replace(/\\([0-7]{3})/g, (_m, octal) => String.fromCharCode(parseInt(octal, 8)))));
  } catch {
    return new Set();
  }
}

export function isMounted(path: string): boolean {
  return mountedPaths().has(path);
}

/** fusermount -u (or -uz when `lazy`: detaches even if busy). Resolves to whether it worked. */
export function fuseUnmount(path: string, lazy = false): Promise<{ ok: boolean; error?: string }> {
  const binary = fusermountBinary();
  if (!binary) return Promise.resolve({ ok: false, error: "fusermount is not installed" });
  return new Promise((resolvePromise) => {
    const child = spawn(binary, [lazy ? "-uz" : "-u", path], { stdio: ["ignore", "ignore", "pipe"], env: childEnv({}) });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => resolvePromise({ ok: false, error: error.message }));
    child.on("close", (code) => resolvePromise(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `exit code ${code}` }));
  });
}
