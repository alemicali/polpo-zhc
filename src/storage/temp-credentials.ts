/**
 * Temporary bucket keys for remote sandboxes: minted per task run, valid for the task's time,
 * limited to the bucket, the agent's prefix and read-only or read-write.
 *
 *  - Cloudflare R2: POST /accounts/{accountId}/r2/temp-access-credentials (Bearer API token).
 *    Request: { bucket, parentAccessKeyId, permission: "object-read-only" | "object-read-write",
 *    ttlSeconds, prefixes? }; response: { result: { accessKeyId, secretAccessKey, sessionToken } }.
 *  - AWS S3, MinIO and other S3-compatible servers: STS AssumeRole with an inline session policy,
 *    signed with the entry's main keys.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes } from "node:crypto";
import type { StorageCredentials, StorageEntry, StorageTemporaryCredentials } from "@polpo-ai/core/storage-registry";
import { signRequestV4, xmlValue } from "./s3.js";

export const DEFAULT_TEMP_TTL_SECONDS = 2 * 3600;
export const MAX_TEMP_TTL_SECONDS = 12 * 3600;
/** STS accepts at least 15 minutes. */
export const MIN_TEMP_TTL_SECONDS = 900;
/** Cached keys are replaced this long before they expire. */
export const TEMP_REFRESH_MARGIN_MS = 5 * 60_000;
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 30_000;

export interface MintedCredentials {
  credentials: StorageCredentials & { sessionToken: string };
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface MintRequest {
  bucket: string;
  /** Key prefixes the keys may touch (the entry's prefix plus the agent's grant prefix); empty = whole bucket. */
  prefix: string;
  readOnly: boolean;
  ttlSeconds: number;
}

export function clampTtl(ttlSeconds: number | undefined): number {
  const wanted = Number.isFinite(ttlSeconds) && ttlSeconds! > 0 ? Math.floor(ttlSeconds!) : DEFAULT_TEMP_TTL_SECONDS;
  return Math.max(MIN_TEMP_TTL_SECONDS, Math.min(wanted, MAX_TEMP_TTL_SECONDS));
}

interface HttpResult { status: number; text: string }

function post(url: URL, headers: Record<string, string>, body: string): Promise<HttpResult> {
  const doRequest = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = doRequest(url, { method: "POST", headers: { ...headers, "content-length": String(Buffer.byteLength(body)) }, timeout: TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", (error) => reject(new Error(`Could not reach ${url.host}: ${error.message}`)));
    req.end(body);
  });
}

// ── Cloudflare R2 ────────────────────────────────────────────────────

export async function mintR2(
  settings: Extract<StorageTemporaryCredentials, { kind: "r2" }>, apiToken: string, req: MintRequest, apiBase = CLOUDFLARE_API,
): Promise<MintedCredentials> {
  const url = new URL(`${apiBase.replace(/\/+$/, "")}/accounts/${encodeURIComponent(settings.accountId)}/r2/temp-access-credentials`);
  const body = JSON.stringify({
    bucket: req.bucket,
    parentAccessKeyId: settings.parentAccessKeyId,
    permission: req.readOnly ? "object-read-only" : "object-read-write",
    ttlSeconds: req.ttlSeconds,
    ...(req.prefix ? { prefixes: [req.prefix] } : {}),
  });
  const res = await post(url, { authorization: `Bearer ${apiToken}`, "content-type": "application/json" }, body);
  let json: any;
  try { json = JSON.parse(res.text); } catch { /* not JSON */ }
  const result = json?.result;
  if (res.status >= 300 || json?.success === false || !result?.accessKeyId || !result.secretAccessKey || !result.sessionToken) {
    const detail = json?.errors?.[0]?.message ?? `HTTP ${res.status}`;
    throw new Error(`Cloudflare temporary credentials failed: ${String(detail).slice(0, 200)}`);
  }
  return {
    credentials: { accessKeyId: result.accessKeyId, secretAccessKey: result.secretAccessKey, sessionToken: result.sessionToken },
    expiresAt: Date.now() + req.ttlSeconds * 1000,
  };
}

// ── STS AssumeRole ───────────────────────────────────────────────────

/** The inline session policy: list the bucket (within the prefix), read, and when read-write write and delete. */
export function sessionPolicy(bucket: string, prefix: string, readOnly: boolean): string {
  const objects = ["s3:GetObject", ...(readOnly ? [] : ["s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"])];
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["s3:ListBucket"],
        Resource: [`arn:aws:s3:::${bucket}`],
        ...(prefix ? { Condition: { StringLike: { "s3:prefix": [`${prefix}*`] } } } : {}),
      },
      { Effect: "Allow", Action: objects, Resource: [`arn:aws:s3:::${bucket}/${prefix}*`] },
    ],
  });
}

export async function mintSts(
  settings: Extract<StorageTemporaryCredentials, { kind: "sts" }>,
  mainCredentials: StorageCredentials,
  entry: Pick<StorageEntry, "endpoint" | "region">,
  req: MintRequest,
  sessionName: string,
): Promise<MintedCredentials> {
  const region = entry.region?.trim() && entry.region.trim() !== "auto" ? entry.region.trim() : "us-east-1";
  const endpoint = settings.endpoint?.trim() || entry.endpoint?.trim() || `https://sts.${region}.amazonaws.com`;
  const url = new URL(endpoint);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  const form = new URLSearchParams({
    Action: "AssumeRole",
    Version: "2011-06-15",
    RoleArn: settings.roleArn,
    RoleSessionName: sessionName.replace(/[^\w+=,.@-]/g, "-").slice(0, 64) || "polpo",
    DurationSeconds: String(req.ttlSeconds),
    Policy: sessionPolicy(req.bucket, req.prefix, req.readOnly),
  });
  const body = form.toString();
  const headers = signRequestV4({
    method: "POST", url, body, headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    credentials: mainCredentials, region, service: "sts",
  });
  const res = await post(url, headers, body);
  const accessKeyId = xmlValue(res.text, "AccessKeyId");
  const secretAccessKey = xmlValue(res.text, "SecretAccessKey");
  const sessionToken = xmlValue(res.text, "SessionToken");
  if (res.status >= 300 || !accessKeyId || !secretAccessKey || !sessionToken) {
    const detail = xmlValue(res.text, "Message") ?? xmlValue(res.text, "Code") ?? `HTTP ${res.status}`;
    throw new Error(`STS AssumeRole failed: ${detail.slice(0, 200)}`);
  }
  const expiration = Date.parse(xmlValue(res.text, "Expiration") ?? "");
  return {
    credentials: { accessKeyId, secretAccessKey, sessionToken },
    expiresAt: Number.isFinite(expiration) ? expiration : Date.now() + req.ttlSeconds * 1000,
  };
}

export function sessionNameFor(agent: string | undefined): string {
  return `polpo-${agent ?? "run"}-${randomBytes(3).toString("hex")}`;
}

// ── Cache ────────────────────────────────────────────────────────────

/** Keys minted for an agent and entry, reused while they have time left (5 minutes before expiry they are replaced). */
export class TemporaryCredentialCache {
  private readonly items = new Map<string, MintedCredentials & { ttlSeconds: number }>();

  get(key: string, ttlSeconds: number, now = Date.now()): MintedCredentials | undefined {
    const item = this.items.get(key);
    if (!item) return undefined;
    const remaining = item.expiresAt - now;
    // a run that needs hours must not get keys that are about to expire
    if (remaining <= TEMP_REFRESH_MARGIN_MS || remaining < (ttlSeconds * 1000) / 2) {
      this.items.delete(key);
      return undefined;
    }
    return item;
  }

  set(key: string, value: MintedCredentials, ttlSeconds: number): void {
    this.items.set(key, { ...value, ttlSeconds });
  }

  clear(prefix = ""): void {
    for (const key of [...this.items.keys()]) if (key.startsWith(prefix)) this.items.delete(key);
  }
}
