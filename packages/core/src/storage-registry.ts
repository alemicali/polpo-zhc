/**
 * Storage: S3-compatible buckets (AWS S3, Cloudflare R2, MinIO, Backblaze B2, Wasabi…) registered
 * once and shown to agents as directories (FUSE mounts) and through host-side storage_* tools.
 *
 * The registry holds only non-secret settings. Keys stay in the vault: an entry references the
 * vault entries that hold them (owner + service), chosen by a person; APIs never return values.
 *
 * Design: polpo-arch/SANDBOX.md, "Storage: bucket montati con FUSE".
 */
import type { VaultRef } from "./vault-ref.js";

export type StorageProvider = "s3";
export type StorageDriver = "rclone" | "mountpoint-s3";
export type StorageAccess = "read" | "write";

/** One agent's access to a storage entry. `agent: "*"` applies to every agent without its own grant. */
export interface StorageGrant {
  id: string;
  agent: string;
  access: StorageAccess;
  /** Limit the grant to keys under this prefix (relative to the entry's own prefix), e.g. "clients/acme/". */
  prefix?: string;
}

export interface StorageCacheOptions {
  /** rclone VFS cache mode: "writes" (default) caches files open for writing, "full" also caches reads. */
  mode?: "writes" | "full";
  /** Upper bound of the local cache (rclone --vfs-cache-max-size). */
  maxSizeMb?: number;
  /** How long unused cached files are kept (rclone --vfs-cache-max-age). */
  maxAgeHours?: number;
}

/**
 * Optional: remote sandboxes get temporary keys minted per task run (scoped to the bucket, the
 * agent's prefix and read-only or read-write) instead of the entry's fixed sandbox key.
 * Non-secret settings only; the Cloudflare API token is in the referenced vault entry.
 */
export type StorageTemporaryCredentials =
  /** Cloudflare R2: POST /accounts/{accountId}/r2/temp-access-credentials. */
  | { kind: "r2"; accountId: string; parentAccessKeyId: string; /** Vault entry with the API token. */ token?: VaultRef }
  /** AWS S3, MinIO and other S3-compatible: STS AssumeRole signed with the entry's main keys. */
  | { kind: "sts"; roleArn: string; /** Default: AWS regional STS, or the entry's endpoint. */ endpoint?: string };

export interface StorageEntry {
  id: string;
  name: string;
  slug: string;
  description?: string;
  provider: StorageProvider;
  /** S3 endpoint URL; empty for AWS S3 (derived from the region). R2: https://<account>.r2.cloudflarestorage.com */
  endpoint?: string;
  /** Region ("auto" for R2, e.g. "eu-central-1" for AWS). */
  region?: string;
  bucket: string;
  /** Only this part of the bucket is visible (e.g. "team/shared/"). */
  prefix?: string;
  /** Path-style addressing (https://endpoint/bucket/key): needed by MinIO and most self-hosted servers. */
  pathStyle?: boolean;
  driver: StorageDriver;
  readOnly: boolean;
  cache?: StorageCacheOptions;
  /** Vault entry with the main keys (access key id + secret): host mounts and storage_* tools. */
  credentials?: VaultRef;
  /** Vault entry with dedicated, limited keys for remote sandboxes. */
  sandboxCredentials?: VaultRef;
  /** Per-run temporary keys for remote sandboxes (default: the fixed sandbox key). */
  temporaryCredentials?: StorageTemporaryCredentials;
  /** Enabled entries are mounted on the host at server start. */
  enabled: boolean;
  grants: StorageGrant[];
  createdAt: string;
  updatedAt: string;
}

export type CreateStorageEntry = Omit<StorageEntry, "id" | "createdAt" | "updatedAt"> & { id?: string };

export interface StorageRegistryChangeEvent {
  entryId: string;
  slug: string;
  action: "created" | "updated" | "deleted";
  timestamp: string;
}

export type StorageRegistryChangeEmitter = (event: StorageRegistryChangeEvent) => void;

export interface StorageRegistryStore {
  list(): Promise<StorageEntry[]>;
  /** By id or slug (an id wins over another entry's slug). */
  get(idOrSlug: string): Promise<StorageEntry | null>;
  create(input: CreateStorageEntry): Promise<StorageEntry>;
  update(idOrSlug: string, input: Partial<Omit<StorageEntry, "id" | "createdAt">>): Promise<StorageEntry | null>;
  delete(idOrSlug: string): Promise<boolean>;
  setEmitter?(emitChange?: StorageRegistryChangeEmitter): void;
}

// ── Credentials (in the referenced vault entries, never in the registry) ─

export interface StorageCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** What APIs say about credentials: whether they are set, never their value. */
export interface StorageCredentialStatus {
  credentials: "set" | "not set";
  sandboxCredentials: "set" | "not set";
  /** The API token for minting temporary keys (R2). */
  temporaryToken: "set" | "not set";
}

// ── Paths, prefixes and grants ──────────────────────────────────────────

export const STORAGE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function segments(value: string, what: string): string[] {
  if (value.includes("\0")) throw new Error(`Invalid ${what}`);
  const parts = value.replace(/\\/g, "/").split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === "..")) throw new Error(`Invalid ${what}: ".." is not allowed`);
  return parts;
}

/** "a/b" | "/a/b/" → "a/b/"; "" | "/" → "". Rejects "..". */
export function normalizeStoragePrefix(prefix: string | undefined): string {
  const parts = segments(prefix ?? "", "prefix");
  return parts.length ? `${parts.join("/")}/` : "";
}

/** An object key relative to the entry root: "/a//b.txt" → "a/b.txt". Rejects "..". */
export function normalizeStoragePath(path: string | undefined): string {
  return segments(path ?? "", "path").join("/");
}

export interface StorageAccessGrant {
  access: StorageAccess;
  /** Normalized prefix ("" = the whole entry). */
  prefix: string;
}

/** The grant that applies to an agent: its own, else the "*" grant. */
export function storageGrantFor(entry: Pick<StorageEntry, "grants">, agent: string): StorageGrant | undefined {
  return entry.grants.find((grant) => grant.agent === agent) ?? entry.grants.find((grant) => grant.agent === "*");
}

/**
 * What an agent may do on an entry. No agent means Polpo itself / a person (full access, read-only
 * when the entry is). A read-only entry turns every grant into read.
 */
export function storageAccessFor(entry: Pick<StorageEntry, "grants" | "readOnly">, agent: string | undefined): StorageAccessGrant | null {
  if (agent === undefined) return { access: entry.readOnly ? "read" : "write", prefix: "" };
  const grant = storageGrantFor(entry, agent);
  if (!grant) return null;
  return { access: entry.readOnly ? "read" : grant.access, prefix: normalizeStoragePrefix(grant.prefix) };
}

/** True when `path` (an object key or a listing prefix) is inside the grant prefix. */
export function storagePathAllowed(grantPrefix: string, path: string): boolean {
  if (!grantPrefix) return true;
  const key = normalizeStoragePath(path);
  return `${key}/`.startsWith(grantPrefix) || key.startsWith(grantPrefix);
}

/**
 * Check an operation against an agent's access; returns the normalized path or throws.
 * `need: "write"` covers writing and deleting.
 */
export function assertStorageAccess(
  entry: Pick<StorageEntry, "grants" | "readOnly" | "name">,
  agent: string | undefined,
  path: string,
  need: StorageAccess,
): string {
  const grant = storageAccessFor(entry, agent);
  if (!grant) throw new Error(`Access denied: no grant on storage "${entry.name}"`);
  if (need === "write" && grant.access !== "write") {
    throw new Error(entry.readOnly ? `Storage "${entry.name}" is read-only` : `Access denied: read-only grant on storage "${entry.name}"`);
  }
  const key = normalizeStoragePath(path);
  if (!storagePathAllowed(grant.prefix, key)) throw new Error(`Access denied: "${key}" is outside the allowed prefix "${grant.prefix}"`);
  return key;
}

/**
 * The prefix a listing may use: inside the grant prefix as asked, or (when the request is at or
 * above it, e.g. the root) the grant prefix itself. Throws for prefixes elsewhere.
 */
export function scopeStorageListing(grantPrefix: string, requested: string | undefined): string {
  const asked = normalizeStoragePrefix(requested);
  if (!grantPrefix || asked.startsWith(grantPrefix)) return asked;
  if (grantPrefix.startsWith(asked)) return grantPrefix;
  throw new Error(`Access denied: "${asked}" is outside the allowed prefix "${grantPrefix}"`);
}

/** Validation shared by the API, the tools and the stores' callers. Returns the first problem. */
export function validateStorageEntry(entry: Pick<StorageEntry, "slug" | "bucket" | "driver" | "readOnly" | "endpoint" | "grants"> & { temporaryCredentials?: StorageTemporaryCredentials }): string | undefined {
  if (!STORAGE_SLUG_PATTERN.test(entry.slug)) return "Slug must be lowercase letters, digits and dashes";
  if (!entry.bucket.trim() || /[\s/]/.test(entry.bucket)) return "Bucket must be a bucket name (no spaces or slashes)";
  if (entry.driver === "mountpoint-s3" && !entry.readOnly) return 'The "mountpoint-s3" driver is allowed only for read-only storage';
  if (entry.endpoint) {
    try {
      const url = new URL(entry.endpoint);
      if (url.protocol !== "https:" && url.protocol !== "http:") return "Endpoint must be an http(s) URL";
    } catch { return "Endpoint must be a URL, e.g. https://<account>.r2.cloudflarestorage.com"; }
  }
  const temp = entry.temporaryCredentials;
  if (temp) {
    if (temp.kind === "r2" && (!temp.accountId?.trim() || !temp.parentAccessKeyId?.trim())) return "Temporary keys on R2 need the account id and the parent access key id";
    if (temp.kind === "sts") {
      if (!/^arn:\S+$/.test(temp.roleArn ?? "")) return "Temporary keys need an IAM role ARN (arn:aws:iam::<account>:role/<name>)";
      if (temp.endpoint) {
        try { if (!/^https?:$/.test(new URL(temp.endpoint).protocol)) return "STS endpoint must be an http(s) URL"; } catch { return "STS endpoint must be a URL"; }
      }
    }
  }
  const agents = new Set<string>();
  for (const grant of entry.grants) {
    if (!grant.agent.trim()) return "Every grant needs an agent";
    if (agents.has(grant.agent)) return `Agent "${grant.agent}" has more than one grant`;
    agents.add(grant.agent);
    try { normalizeStoragePrefix(grant.prefix); } catch (error) { return (error as Error).message; }
  }
  return undefined;
}
