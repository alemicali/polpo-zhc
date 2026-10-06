/**
 * A small S3 client (Signature V4) for the host-side storage tools and the connection test:
 * list (bounded, paged), get, head, put, delete and presigned GET URLs. It works with AWS S3,
 * Cloudflare R2, MinIO, B2, Wasabi and any S3-compatible server.
 *
 * Credentials stay in this process: they are never logged, never put in URLs (presigned URLs
 * carry only the access key id and a signature) and never returned to callers.
 */

import { createHash, createHmac } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import type { StorageCredentials, StorageEntry } from "@polpo-ai/core/storage-registry";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const UNSIGNED = "UNSIGNED-PAYLOAD";
const REQUEST_TIMEOUT_MS = 60_000;

export interface S3Target {
  /** Base URL without the bucket (https://s3.eu-central-1.amazonaws.com, https://<acct>.r2.cloudflarestorage.com). */
  endpoint: string;
  region: string;
  bucket: string;
  pathStyle: boolean;
}

/** Where an entry's bucket is reached. AWS when no endpoint; path style by default for custom endpoints. */
export function s3TargetFor(entry: Pick<StorageEntry, "endpoint" | "region" | "bucket" | "pathStyle">): S3Target {
  const custom = entry.endpoint?.trim().replace(/\/+$/, "");
  const isR2 = !!custom && /\.r2\.cloudflarestorage\.com$/i.test(new URL(custom).hostname);
  const region = entry.region?.trim() || (isR2 ? "auto" : "us-east-1");
  return {
    endpoint: custom || `https://s3.${region}.amazonaws.com`,
    region,
    bucket: entry.bucket,
    pathStyle: entry.pathStyle ?? !!custom,
  };
}

export interface S3Object {
  key: string;
  size: number;
  lastModified?: string;
  etag?: string;
}

export interface S3Listing {
  objects: S3Object[];
  /** "Directories" (common prefixes) when listing with a delimiter. */
  prefixes: string[];
  truncated: boolean;
  nextToken?: string;
}

export class S3Error extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

interface RawResponse {
  status: number;
  headers: IncomingMessage["headers"];
  body: IncomingMessage;
}

export class S3Client {
  constructor(private readonly target: S3Target, private readonly credentials: StorageCredentials) {}

  async list(opts: { prefix?: string; delimiter?: string; maxKeys?: number; continuationToken?: string } = {}): Promise<S3Listing> {
    const query: Record<string, string> = { "list-type": "2" };
    if (opts.prefix) query.prefix = opts.prefix;
    if (opts.delimiter) query.delimiter = opts.delimiter;
    if (opts.maxKeys) query["max-keys"] = String(opts.maxKeys);
    if (opts.continuationToken) query["continuation-token"] = opts.continuationToken;
    const xml = await this.text("GET", "", { query });
    return parseListing(xml);
  }

  /** Object metadata, or null when the object does not exist. */
  async head(key: string): Promise<{ size: number; contentType?: string; lastModified?: string } | null> {
    const response = await this.send("HEAD", key, {});
    response.body.resume();
    if (response.status === 404) return null;
    if (response.status >= 300) throw new S3Error(`HEAD failed with HTTP ${response.status}`, response.status);
    return {
      size: Number(response.headers["content-length"] ?? 0),
      contentType: header(response.headers["content-type"]),
      lastModified: header(response.headers["last-modified"]),
    };
  }

  /** The object's body as a stream (optionally a byte range, end inclusive). */
  async get(key: string, range?: { start: number; end: number }): Promise<{ body: Readable; size: number; contentType?: string; totalSize?: number }> {
    const headers: Record<string, string> = range ? { range: `bytes=${range.start}-${range.end}` } : {};
    const response = await this.send("GET", key, { headers });
    if (response.status === 416) {
      response.body.resume();
      return { body: emptyStream(), size: 0, totalSize: 0 };
    }
    if (response.status >= 300) throw await errorFrom(response, `GET ${key}`);
    const total = /\/(\d+)$/.exec(header(response.headers["content-range"]) ?? "")?.[1];
    return {
      body: response.body,
      size: Number(response.headers["content-length"] ?? 0),
      contentType: header(response.headers["content-type"]),
      totalSize: total ? Number(total) : undefined,
    };
  }

  /** Upload a buffer, or a stream of known length (single PUT: up to 5 GB). */
  async put(key: string, body: Buffer | { stream: Readable; length: number }, contentType = "application/octet-stream"): Promise<void> {
    const response = Buffer.isBuffer(body)
      ? await this.send("PUT", key, {
        headers: { "content-type": contentType, "content-length": String(body.length) },
        body,
        payloadHash: sha256Hex(body),
      })
      : await this.send("PUT", key, {
        headers: { "content-type": contentType, "content-length": String(body.length) },
        body: body.stream,
        payloadHash: UNSIGNED,
      });
    if (response.status >= 300) throw await errorFrom(response, `PUT ${key}`);
    response.body.resume();
  }

  async delete(key: string): Promise<void> {
    const response = await this.send("DELETE", key, {});
    if (response.status >= 300 && response.status !== 404) throw await errorFrom(response, `DELETE ${key}`);
    response.body.resume();
  }

  /** A temporary GET URL (SigV4 query signing). `expiresSeconds` is 1 s to 7 days. */
  presignGet(key: string, expiresSeconds: number, now = new Date()): string {
    const expires = Math.max(1, Math.min(Math.floor(expiresSeconds), 7 * 24 * 3600));
    const url = this.url(key);
    const { amzDate, date } = timestamps(now);
    const scope = `${date}/${this.target.region}/s3/aws4_request`;
    const query: Record<string, string> = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${this.credentials.accessKeyId}/${scope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(expires),
      "X-Amz-SignedHeaders": "host",
    };
    if (this.credentials.sessionToken) query["X-Amz-Security-Token"] = this.credentials.sessionToken;
    const canonicalQuery = canonicalQueryString(query);
    const canonical = ["GET", url.pathname, canonicalQuery, `host:${url.host}\n`, "host", UNSIGNED].join("\n");
    const signature = this.signature(canonical, amzDate, date, scope);
    return `${url.origin}${url.pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  // ── Internals ──────────────────────────────────────────────────────

  private url(key: string, query: Record<string, string> = {}): URL {
    const base = new URL(this.target.endpoint);
    const encodedKey = key.split("/").map(encodeRfc3986).join("/");
    const basePath = base.pathname.replace(/\/+$/, "");
    let pathname: string;
    if (this.target.pathStyle) {
      pathname = `${basePath}/${encodeRfc3986(this.target.bucket)}${key ? `/${encodedKey}` : ""}`;
    } else {
      base.hostname = `${this.target.bucket}.${base.hostname}`;
      pathname = `${basePath}/${encodedKey}`;
    }
    const url = new URL(base.origin);
    url.pathname = pathname;
    const search = canonicalQueryString(query);
    if (search) url.search = `?${search}`;
    return url;
  }

  private async text(method: string, key: string, opts: { query?: Record<string, string> }): Promise<string> {
    const response = await this.send(method, key, opts);
    if (response.status >= 300) throw await errorFrom(response, `${method} ${key || this.target.bucket}`);
    return readAll(response.body);
  }

  private send(method: string, key: string, opts: {
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: Buffer | Readable;
    payloadHash?: string;
  }): Promise<RawResponse> {
    const url = this.url(key, opts.query ?? {});
    const { amzDate, date } = timestamps(new Date());
    const payloadHash = opts.payloadHash ?? EMPTY_SHA256;
    const headers: Record<string, string> = {
      ...Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    if (this.credentials.sessionToken) headers["x-amz-security-token"] = this.credentials.sessionToken;
    const signed = Object.keys(headers).sort();
    const canonicalHeaders = signed.map((name) => `${name}:${headers[name]!.trim().replace(/\s+/g, " ")}\n`).join("");
    const canonical = [method, url.pathname, url.search.slice(1), canonicalHeaders, signed.join(";"), payloadHash].join("\n");
    const scope = `${date}/${this.target.region}/s3/aws4_request`;
    const signature = this.signature(canonical, amzDate, date, scope);
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.credentials.accessKeyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${signature}`;

    const doRequest = url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise<RawResponse>((resolvePromise, reject) => {
      const req = doRequest(url, { method, headers, timeout: REQUEST_TIMEOUT_MS }, (res) => {
        resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body: res });
      });
      req.on("timeout", () => req.destroy(new Error(`S3 request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`)));
      req.on("error", (error) => reject(new Error(`Could not reach ${url.host}: ${error.message}`)));
      const body = opts.body;
      if (!body) req.end();
      else if (Buffer.isBuffer(body)) req.end(body);
      else {
        body.on("error", (error) => req.destroy(error));
        body.pipe(req);
      }
    });
  }

  private signature(canonicalRequest: string, amzDate: string, date: string, scope: string): string {
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
    let key: Buffer = hmac(`AWS4${this.credentials.secretAccessKey}`, date);
    key = hmac(key, this.target.region);
    key = hmac(key, "s3");
    key = hmac(key, "aws4_request");
    return createHmac("sha256", key).update(stringToSign).digest("hex");
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function timestamps(now: Date): { amzDate: string; date: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, date: amzDate.slice(0, 8) };
}

/** RFC 3986 encoding as SigV4 wants it (unreserved characters kept, everything else %XX). */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQueryString(query: Record<string, string>): string {
  return Object.keys(query).sort().map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(query[k]!)}`).join("&");
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readAll(stream: Readable, limit = 16 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += (chunk as Buffer).length;
    if (size > limit) { stream.destroy(); throw new Error("S3 response too large"); }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function emptyStream(): Readable {
  return Readable.from([]);
}

async function errorFrom(response: RawResponse, what: string): Promise<S3Error> {
  const body = await readAll(response.body, 64 * 1024).catch(() => "");
  const code = xmlValue(body, "Code");
  const message = xmlValue(body, "Message");
  const hint = response.status === 403 ? " (check the access key, secret and permissions)"
    : response.status === 404 && code === "NoSuchBucket" ? " (check the bucket name and endpoint)" : "";
  return new S3Error(`${what} failed: ${code ?? `HTTP ${response.status}`}${message ? ` — ${message}` : ""}${hint}`, response.status, code);
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function xmlValue(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? xmlUnescape(match[1]!) : undefined;
}

function xmlBlocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]!);
}

/** Parse a ListObjectsV2 response. */
export function parseListing(xml: string): S3Listing {
  return {
    objects: xmlBlocks(xml, "Contents").map((block) => ({
      key: xmlValue(block, "Key") ?? "",
      size: Number(xmlValue(block, "Size") ?? 0),
      lastModified: xmlValue(block, "LastModified"),
      etag: xmlValue(block, "ETag")?.replace(/"/g, ""),
    })),
    prefixes: xmlBlocks(xml, "CommonPrefixes").map((block) => xmlValue(block, "Prefix") ?? "").filter(Boolean),
    truncated: xmlValue(xml, "IsTruncated") === "true",
    nextToken: xmlValue(xml, "NextContinuationToken"),
  };
}
