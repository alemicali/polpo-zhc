/**
 * Triggers: public endpoints (POST /hooks/{id}) that receive events from outside — a form
 * submission (Tally, Typeform), a webhook from any service — check who sent them (a secret, an HMAC
 * signature, an IP allowlist), parse and validate them against a contract, filter and de-duplicate
 * them, and record each one as a delivery with the values an action would receive (mapping).
 *
 * This is the primitive only: registration and reception. What a trigger DOES (start a mission, a
 * playbook, a task, an agent turn, a notification) arrives later with the action engine, which will
 * subscribe to the `trigger:delivery` event. Nothing is executed today.
 */

export type TriggerContentType = "json" | "form" | "multipart" | "text";
export const TRIGGER_CONTENT_TYPES: readonly TriggerContentType[] = ["json", "form", "multipart", "text"];

export type TriggerDeliveryStatus = "accepted" | "rejected" | "filtered" | "duplicate" | "rate_limited";
export const TRIGGER_DELIVERY_STATUSES: readonly TriggerDeliveryStatus[] = ["accepted", "rejected", "filtered", "duplicate", "rate_limited"];

export type TriggerHmacAlgorithm = "sha256" | "sha1";
export type TriggerHmacEncoding = "hex" | "base64";

export const TRIGGER_LIMITS = {
  /** Default body cap. */
  defaultMaxBodyBytes: 256 * 1024,
  /** The most a trigger may accept (multipart with files included). */
  maxBodyBytes: 10 * 1024 * 1024,
  /** Default per-file cap for multipart. */
  defaultMaxFileBytes: 5 * 1024 * 1024,
  /** The body kept on a delivery (larger ones are kept truncated). */
  storedBodyBytes: 64 * 1024,
  /** Deliveries kept per trigger by default, and the most one may keep. */
  defaultRetention: 500,
  maxRetention: 5000,
  /** Default and most requests per minute. */
  defaultRateLimitPerMinute: 60,
  maxRateLimitPerMinute: 6000,
  /** HMAC timestamp tolerance (seconds). */
  defaultToleranceSeconds: 300,
  /** Overlap a rotated secret keeps working (seconds): default one day, at most a week. */
  defaultOverlapSeconds: 24 * 3600,
  maxOverlapSeconds: 7 * 24 * 3600,
  /** Dedupe window (seconds): at most a week. */
  maxDedupeTtlSeconds: 7 * 24 * 3600,
  /** Dedupe keys remembered per trigger. */
  maxDedupeKeys: 20_000,
  /** Contract revisions kept per trigger. */
  contractRevisionsKept: 50,
  /** Mapping fields per trigger. */
  maxMappingFields: 50,
  /** Filter conditions per trigger. */
  maxFilterConditions: 20,
  /** IP allowlist entries. */
  maxIpAllowlist: 50,
} as const;

/** An HMAC signature check: the sender signs the raw body (optionally with a timestamp) with a shared secret. */
export interface TriggerHmacConfig {
  /** The header carrying the signature, e.g. x-hub-signature-256, typeform-signature, x-signature. */
  header: string;
  algorithm: TriggerHmacAlgorithm;
  encoding: TriggerHmacEncoding;
  /** Stripped before comparing, e.g. "sha256=". */
  prefix?: string;
  /** The header carrying the signing time (unix seconds or ms, or ISO); replays outside the tolerance are refused. */
  timestampHeader?: string;
  /** Seconds a timestamp may be off (default 300). */
  toleranceSeconds?: number;
  /**
   * What is signed: `{body}` (default) or a template with `{timestamp}`, e.g. `{timestamp}.{body}`
   * (Stripe-style) or `v0:{timestamp}:{body}` (Slack-style). `{body}` is the raw body, byte for byte.
   */
  signedPayload?: string;
}

/** How a delivery is authenticated. Every configured method must pass. */
export interface TriggerAuth {
  /** Require Polpo's generated secret: `Authorization: Bearer <secret>` or `X-Polpo-Secret: <secret>`. */
  secret: boolean;
  /** Also accept `?token=<secret>` (for senders that cannot set headers). Off by default: URLs end up in logs. */
  allowQueryToken?: boolean;
  /** An HMAC signature; its secret is in the vault (never returned). */
  hmac?: TriggerHmacConfig;
  /** Only these addresses (CIDR or single IPs, v4 or v6); empty or absent: any. */
  ipAllowlist?: string[];
}

/** One generated secret, as stored: its hash only. */
export interface TriggerSecretRecord {
  id: string;
  /** sha256 of the secret (hex). */
  hash: string;
  /** The first characters, to recognise it ("pts_Ab12…"). */
  hint: string;
  createdAt: string;
  /** A rotated-out secret keeps working until then. */
  expiresAt?: string;
}

/** What a delivery must look like. */
export interface TriggerContract {
  contentTypes: TriggerContentType[];
  maxBodyBytes: number;
  /** Multipart: per file. */
  maxFileBytes?: number;
  /** A JSON Schema the parsed body must satisfy (validated with the repo's validator). */
  schema?: Record<string, unknown>;
}

/** A contract as it was at a version. */
export interface TriggerContractRevision {
  version: number;
  contract: TriggerContract;
  createdAt: string;
  by?: string;
  note?: string;
}

export type TriggerFilterOp = "equals" | "not_equals" | "contains" | "in" | "gte" | "lte" | "exists" | "not_exists";
export const TRIGGER_FILTER_OPS: readonly TriggerFilterOp[] = ["equals", "not_equals", "contains", "in", "gte", "lte", "exists", "not_exists"];

/** A condition on the delivery: a path into body / headers / query (`body.answers[0].value`). */
export interface TriggerFilterCondition {
  path: string;
  op: TriggerFilterOp;
  value?: unknown;
}

export interface TriggerFilter {
  /** all (default): every condition must hold; any: one is enough. */
  mode?: "all" | "any";
  conditions: TriggerFilterCondition[];
}

export interface TriggerDedupe {
  /** A template over body / headers / query, e.g. `{{body.submission_id}}` or `{{headers.x-request-id}}`. */
  key: string;
  /** How long a key is remembered (seconds). */
  ttlSeconds: number;
}

/** A trigger as stored. */
export interface Trigger {
  /** A slug with a random suffix (tally-signup-3f9a1c2e): the endpoint is not guessable. */
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  /** Who owns it (an email, an agent, "polpo"). */
  owner?: string;
  createdAt: string;
  updatedAt: string;
  auth: TriggerAuth;
  /** Generated secrets (hashes): the current one and, during an overlap, the previous. */
  secrets: TriggerSecretRecord[];
  contract: TriggerContract;
  contractVersion: number;
  filter?: TriggerFilter;
  dedupe?: TriggerDedupe;
  rateLimitPerMinute: number;
  /** Named fields → templates over body / headers / query: what an action would receive. */
  mapping?: Record<string, string>;
  /** Deliveries kept (newest). */
  retention: number;
}

/** A trigger's HMAC secret as the API shows it: set or not, never the value. */
export interface TriggerHmacSecretStatus {
  secretSet: boolean;
  /** A previous secret still accepted until then (rotation overlap). */
  previousUntil?: string;
}

/** A trigger as the API returns it: no hashes, the endpoint URL, the delivery counts. */
export interface TriggerView extends Omit<Trigger, "secrets"> {
  secrets: Array<Omit<TriggerSecretRecord, "hash">>;
  hmacSecret?: TriggerHmacSecretStatus;
  /** POLPO_PUBLIC_URL + /hooks/{id}, when the public URL is known; else the path. */
  endpoint: string;
  /** The path to publish (Tailscale Funnel: /<instance>/hooks/). */
  path: string;
  stats: TriggerStats;
}

export interface TriggerStats {
  /** Deliveries kept, per status. */
  counts: Record<TriggerDeliveryStatus, number>;
  total: number;
  lastDeliveryAt?: string;
  lastStatus?: TriggerDeliveryStatus;
}

export interface TriggerFileMeta {
  field: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
}

/** One received (or test) request, as recorded. */
export interface TriggerDelivery {
  id: string;
  triggerId: string;
  receivedAt: string;
  status: TriggerDeliveryStatus;
  /** What the sender was answered. */
  httpStatus: number;
  /** Why it was rejected / filtered / a duplicate (one line each). */
  reasons: string[];
  /** Contract errors (JSON Schema), one per line. */
  errors?: string[];
  /** Sent from the dashboard, the API or a tool, not by the sender. */
  test?: boolean;
  /** The source IP (as seen through the proxy). */
  ip?: string;
  /** How it authenticated. */
  auth?: { secret?: "header" | "bearer" | "query"; secretId?: string; hmac?: "current" | "previous" };
  contentType?: string;
  kind?: TriggerContentType;
  bytes: number;
  /** Headers with secrets removed. */
  headers: Record<string, string>;
  /** The query string (a `token` removed). */
  query: Record<string, string | string[]>;
  /** The parsed body (keys that look secret redacted), capped. */
  body?: unknown;
  bodyTruncated?: boolean;
  files?: TriggerFileMeta[];
  /** The mapping's values. */
  mapped?: Record<string, unknown>;
  mappingErrors?: string[];
  /** The contract version it was checked against. */
  contractVersion: number;
  /** A hash of the dedupe key (never the key itself). */
  dedupeHash?: string;
  /** A duplicate: the original delivery. */
  duplicateOf?: string;
  /** rate_limited: refusals counted in this record (one record per minute). */
  count?: number;
}

/** A delivery in the list (no body, headers, files or mapped values). */
export type TriggerDeliverySummary = Omit<TriggerDelivery, "body" | "headers" | "query" | "files" | "mapped">;

export interface TriggerDeliveryPage {
  deliveries: TriggerDeliverySummary[];
  nextCursor?: string;
  total: number;
  counts: Record<TriggerDeliveryStatus, number>;
}

/** The result of running a sample (or a stored delivery) through a contract, filter, dedupe and mapping without recording it. */
export interface TriggerDryRun {
  status: TriggerDeliveryStatus;
  reasons: string[];
  errors: string[];
  /** The filter held (or there is none). */
  filterMatched: boolean;
  /** The dedupe key's value (what would be remembered). */
  dedupeKey?: string;
  /** It would be a duplicate of this delivery now. */
  duplicateOf?: string;
  mapped?: Record<string, unknown>;
  mappingErrors?: string[];
  contractVersion: number;
}

export const emptyStatusCounts = (): Record<TriggerDeliveryStatus, number> => ({ accepted: 0, rejected: 0, filtered: 0, duplicate: 0, rate_limited: 0 });
