/**
 * Storage runtime of a project: the registry of buckets, the vault entries holding their keys
 * (references: owner + service, resolved here and never returned), the host mounts (server process only) and the object operations behind the storage_* tools.
 *
 * It is also the StorageMountProvider workspaces ask for the mounts an agent may see.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { StorageMountOptions, StorageMountProvider, StorageMountSpec } from "@polpo-ai/core/sandbox";
import {
  assertStorageAccess,
  normalizeStoragePrefix,
  scopeStorageListing,
  storageAccessFor,
  validateStorageEntry,
  type StorageTemporaryCredentials,
  type CreateStorageEntry,
  type StorageAccess,
  type StorageCredentialStatus,
  type StorageCredentials,
  type StorageEntry,
  type StorageRegistryStore,
} from "@polpo-ai/core/storage-registry";
import type { VaultStore } from "../core/vault-store.js";
import { CREDENTIAL_NAMES, normalizeVaultRef, pickCredential, resolveVaultRef, type VaultRef } from "@polpo-ai/core/vault-ref";
import { databaseStoresFor } from "../core/storage.js";
import { FileStorageRegistryStore } from "../stores/file-storage-registry-store.js";
import { StorageMountManager, type MountManagerOptions, type MountStatus } from "./mount-manager.js";
import { S3Client, s3TargetFor } from "./s3.js";
import { TemporaryCredentialCache, clampTtl, mintR2, mintSts, sessionNameFor, type MintedCredentials } from "./temp-credentials.js";

export type StorageChangeAction = "created" | "updated" | "deleted" | "mounted" | "unmounted" | "mount-failed";
/** Emits "storage:changed" (the orchestrator adds the event origin). */
export type StorageEventEmitter = (payload: { name: string; action: StorageChangeAction; error?: string }) => void;

/** An entry as APIs return it: settings (with the vault references), whether each referenced key resolves (never its value), mount state. */
export interface PublicStorageEntry extends StorageEntry {
  keys: StorageCredentialStatus;
  mount: MountStatus;
}

/** Where agents see buckets inside sandboxes (remote ones mount there with FUSE). */
export const REMOTE_MOUNT_ROOT = "/mnt/storage";

/** Text read inline by storage_read; larger objects are saved to a file. */
export const STORAGE_READ_INLINE_BYTES = 256 * 1024;
/** Largest single upload (S3 single PUT). */
const MAX_PUT_BYTES = 5 * 1024 ** 3;

/** Mount-related settings: changing one of them remounts the entry. */
const MOUNT_FIELDS = ["endpoint", "region", "bucket", "prefix", "pathStyle", "driver", "readOnly", "cache", "enabled", "slug"] as const;

export interface StorageListItem {
  path: string;
  type: "file" | "dir";
  size?: number;
  lastModified?: string;
}

export class StorageRuntime implements StorageMountProvider {
  readonly store: StorageRegistryStore;
  private readonly tempCache = new TemporaryCredentialCache();
  /** Cloudflare API base URL (tests point it at a local server). */
  cloudflareApi?: string;
  private mountManager?: StorageMountManager;

  constructor(
    readonly polpoDir: string,
    private vaultStore?: VaultStore,
    private emit?: StorageEventEmitter,
    /** Mount manager overrides (binaries, timeouts; tests). */
    private mountOptions: Partial<Omit<MountManagerOptions, "polpoDir" | "credentialsFor" | "onEvent">> = {},
  ) {
    this.store = databaseStoresFor(polpoDir)?.storageRegistryStore ?? new FileStorageRegistryStore(polpoDir);
    this.store.setEmitter?.((event) => this.emit?.({ name: event.slug, action: event.action }));
  }

  setVaultStore(store?: VaultStore): void {
    if (store) this.vaultStore = store;
  }

  setEmitter(emit?: StorageEventEmitter): void {
    if (emit) this.emit = emit;
  }

  // ── Mounts (host) ──────────────────────────────────────────────────

  /** The mount manager; mounting is started explicitly by the server (never in runners or the CLI). */
  get mounts(): StorageMountManager {
    this.mountManager ??= new StorageMountManager({
      ...this.mountOptions,
      polpoDir: this.polpoDir,
      credentialsFor: (entry) => this.credentials(entry),
      onEvent: (entry, action, error) => this.emit?.({ name: entry.slug, action, ...(error ? { error } : {}) }),
    });
    return this.mountManager;
  }

  /** True once the server started mounting (only then do registry changes touch mounts). */
  get mountingActive(): boolean {
    return !!this.mountManager;
  }

  /** Mount every enabled entry (server start). */
  async startMounts(): Promise<void> {
    await this.mounts.sync(await this.store.list());
  }

  async shutdown(): Promise<void> {
    await this.mountManager?.shutdown();
  }

  mountStatus(entry: Pick<StorageEntry, "id" | "slug">): MountStatus {
    return this.mountManager?.status(entry) ?? {
      entryId: entry.id, slug: entry.slug, state: "unmounted",
      path: join(this.polpoDir, "mounts", entry.slug), since: new Date(0).toISOString(), restarts: 0,
    };
  }

  // ── StorageMountProvider ───────────────────────────────────────────

  /**
   * The mounts an agent may see. "host": the host mount directories that are mounted now (path
   * = hostPath; read-only unless the agent has a write grant; with a grant prefix the path
   * points inside it). "remote": FUSE specs with the entry's sandbox credentials, only for
   * entries that have them.
   */
  async mountsFor(agentName: string | undefined, target: "host" | "remote", options: StorageMountOptions = {}): Promise<StorageMountSpec[]> {
    const specs: StorageMountSpec[] = [];
    for (const entry of await this.store.list()) {
      if (!entry.enabled) continue;
      const grant = storageAccessFor(entry, agentName);
      if (!grant) continue;
      const readOnly = grant.access !== "write";
      if (target === "host") {
        const status = this.mountStatus(entry);
        if (status.state !== "mounted") continue;
        const hostPath = grant.prefix ? join(status.path, grant.prefix) : status.path;
        specs.push({ name: entry.slug, path: hostPath, hostPath, readOnly });
        continue;
      }
      const s3 = s3TargetFor(entry);
      const prefix = `${normalizeStoragePrefix(entry.prefix)}${grant.prefix}`;
      const credentials = await this.remoteCredentials(entry, agentName, prefix, readOnly, options.ttlSeconds);
      if (!credentials) continue;
      specs.push({
        name: entry.slug,
        path: `${REMOTE_MOUNT_ROOT}/${entry.slug}`,
        readOnly,
        remote: {
          driver: entry.driver,
          ...(entry.endpoint ? { endpoint: s3.endpoint } : {}),
          region: s3.region,
          bucket: entry.bucket,
          ...(prefix ? { prefix } : {}),
          pathStyle: s3.pathStyle,
          credentials,
        },
      });
    }
    return specs;
  }

  /**
   * Keys a remote sandbox mounts with: temporary ones minted for this run when the entry has them
   * (cached per agent and entry), else, or when minting fails, the entry's fixed sandbox key.
   */
  private async remoteCredentials(entry: StorageEntry, agent: string | undefined, prefix: string, readOnly: boolean, ttlSeconds?: number): Promise<StorageCredentials | undefined> {
    const fixed = await this.sandboxCredentials(entry);
    if (!entry.temporaryCredentials) return fixed;
    const ttl = clampTtl(ttlSeconds);
    const cacheKey = `${entry.id}|${agent ?? ""}|${readOnly ? "ro" : "rw"}|${prefix}`;
    try {
      let minted: MintedCredentials | undefined = this.tempCache.get(cacheKey, ttl);
      if (!minted) {
        minted = await this.mint(entry, entry.temporaryCredentials, agent, { bucket: entry.bucket, prefix, readOnly, ttlSeconds: ttl });
        this.tempCache.set(cacheKey, minted, ttl);
      }
      return minted.credentials;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[storage] temporary keys for "${entry.slug}" could not be minted${fixed ? ", using the fixed sandbox key" : ""}: ${message}`);
      this.emit?.({ name: entry.slug, action: "mount-failed", error: `Temporary keys: ${message}` });
      return fixed;
    }
  }

  private async mint(entry: StorageEntry, settings: StorageTemporaryCredentials, agent: string | undefined, req: Parameters<typeof mintR2>[2]): Promise<MintedCredentials> {
    if (settings.kind === "r2") {
      const token = pickCredential(await resolveVaultRef(this.vaultStore, settings.token), [...CREDENTIAL_NAMES.apiToken]);
      if (!token) throw new Error("the Cloudflare API token is not set (choose its vault entry)");
      return mintR2(settings, token, req, this.cloudflareApi);
    }
    const main = await this.credentials(entry);
    if (!main) throw new Error("the entry's main credentials are not set");
    return mintSts(settings, main, entry, req, sessionNameFor(agent));
  }

  // ── Registry (admin: API and Polpo) ────────────────────────────────

  async list(): Promise<PublicStorageEntry[]> {
    return Promise.all((await this.store.list()).map((entry) => this.toPublic(entry)));
  }

  async get(idOrSlug: string): Promise<PublicStorageEntry | null> {
    const entry = await this.store.get(idOrSlug);
    return entry ? this.toPublic(entry) : null;
  }

  async toPublic(entry: StorageEntry): Promise<PublicStorageEntry> {
    return { ...entry, keys: await this.credentialStatus(entry), mount: this.mountStatus(entry) };
  }

  async create(input: CreateStorageEntry): Promise<PublicStorageEntry> {
    const entry = await this.store.create(prepareEntry(input) as CreateStorageEntry);
    if (this.mountingActive && entry.enabled) await this.mounts.mount(entry);
    return this.toPublic(entry);
  }

  async update(idOrSlug: string, patch: Partial<Omit<StorageEntry, "id" | "createdAt" | "updatedAt">>): Promise<PublicStorageEntry | null> {
    const current = await this.store.get(idOrSlug);
    if (!current) return null;
    const updated = (await this.store.update(current.id, prepareEntry(patch, current)))!;
    const keysChanged = ["credentials", "sandboxCredentials", "temporaryCredentials"].some((f) => JSON.stringify((current as any)[f]) !== JSON.stringify((updated as any)[f]));
    if (keysChanged) this.tempCache.clear(`${updated.id}|`);
    const mountChanged = MOUNT_FIELDS.some((field) => JSON.stringify(current[field]) !== JSON.stringify(updated[field]))
      || JSON.stringify(current.credentials) !== JSON.stringify(updated.credentials);
    if (this.mountingActive && mountChanged) {
      if (current.slug !== updated.slug) await this.mounts.remove(current);
      if (updated.enabled) await this.mounts.mount(updated);
      else await this.mounts.unmount(updated);
    }
    return this.toPublic(updated);
  }

  async delete(idOrSlug: string): Promise<boolean> {
    const current = await this.store.get(idOrSlug);
    if (!current) return false;
    if (this.mountManager) await this.mountManager.remove(current);
    const deleted = await this.store.delete(current.id);
    this.tempCache.clear(`${current.id}|`);
    return deleted;
  }

  async mount(idOrSlug: string): Promise<MountStatus> {
    return this.mounts.mount(await this.require(idOrSlug));
  }

  async unmount(idOrSlug: string): Promise<MountStatus> {
    return this.mounts.unmount(await this.require(idOrSlug));
  }

  /** Connection test: list at most one object with the host credentials. */
  async test(idOrSlug: string): Promise<{ ok: true; latencyMs: number; sampleKey?: string }> {
    const entry = await this.require(idOrSlug);
    const started = Date.now();
    const listing = await (await this.client(entry)).list({ prefix: normalizeStoragePrefix(entry.prefix) || undefined, maxKeys: 1 });
    const sample = listing.objects[0]?.key ?? listing.prefixes[0];
    return { ok: true, latencyMs: Date.now() - started, ...(sample ? { sampleKey: sample } : {}) };
  }

  // ── Credentials ────────────────────────────────────────────────────

  /** Whether each referenced vault entry exists and holds what it should (never the values). */
  async credentialStatus(entry: StorageEntry): Promise<StorageCredentialStatus> {
    const token = entry.temporaryCredentials?.kind === "r2"
      ? pickCredential(await resolveVaultRef(this.vaultStore, entry.temporaryCredentials.token), [...CREDENTIAL_NAMES.apiToken])
      : undefined;
    return {
      credentials: (await this.credentials(entry)) ? "set" : "not set",
      sandboxCredentials: (await this.sandboxCredentials(entry)) ? "set" : "not set",
      temporaryToken: token ? "set" : "not set",
    };
  }

  /** Host credentials, from the referenced vault entry (never returned by APIs or given to agents). */
  async credentials(entry: StorageEntry): Promise<StorageCredentials | undefined> {
    return this.readCredentials(entry.credentials);
  }

  /** The dedicated, limited credentials for remote sandboxes, from the referenced vault entry. */
  async sandboxCredentials(entry: StorageEntry): Promise<StorageCredentials | undefined> {
    return this.readCredentials(entry.sandboxCredentials);
  }

  private async readCredentials(ref: VaultRef | undefined): Promise<StorageCredentials | undefined> {
    const c = await resolveVaultRef(this.vaultStore, ref);
    const accessKeyId = pickCredential(c, [...CREDENTIAL_NAMES.accessKeyId]);
    const secretAccessKey = pickCredential(c, [...CREDENTIAL_NAMES.secretAccessKey]);
    if (!accessKeyId || !secretAccessKey) return undefined;
    const sessionToken = pickCredential(c, [...CREDENTIAL_NAMES.sessionToken]);
    return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
  }

  // ── Object operations (storage_* tools; host-side, credentials stay here) ──

  /** Entries an agent can use, with its access and the mount path when mounted. */
  async accessibleEntries(agent: string | undefined): Promise<Array<{ name: string; slug: string; description?: string; access: StorageAccess; prefix?: string; mountPath?: string }>> {
    const result = [];
    for (const entry of await this.store.list()) {
      if (!entry.enabled) continue;
      const grant = storageAccessFor(entry, agent);
      if (!grant) continue;
      const status = this.mountStatus(entry);
      result.push({
        name: entry.name, slug: entry.slug, ...(entry.description ? { description: entry.description } : {}),
        access: grant.access, ...(grant.prefix ? { prefix: grant.prefix } : {}),
        ...(status.state === "mounted" ? { mountPath: grant.prefix ? join(status.path, grant.prefix) : status.path } : {}),
      });
    }
    return result;
  }

  async listObjects(agent: string | undefined, idOrSlug: string, opts: { prefix?: string; recursive?: boolean; limit?: number } = {}): Promise<{ items: StorageListItem[]; truncated: boolean }> {
    const entry = await this.requireUsable(idOrSlug, agent);
    const grant = storageAccessFor(entry, agent)!;
    const prefix = scopeStorageListing(grant.prefix, opts.prefix);
    const root = normalizeStoragePrefix(entry.prefix);
    const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 200), 1000));
    const client = await this.client(entry);
    const items: StorageListItem[] = [];
    let token: string | undefined;
    let truncated = false;
    do {
      const page = await client.list({ prefix: `${root}${prefix}` || undefined, delimiter: opts.recursive ? undefined : "/", maxKeys: Math.min(1000, limit - items.length + 1), continuationToken: token });
      for (const dir of page.prefixes) items.push({ path: dir.slice(root.length), type: "dir" });
      for (const object of page.objects) {
        if (object.key.endsWith("/") && object.size === 0) continue; // folder markers
        items.push({ path: object.key.slice(root.length), type: "file", size: object.size, ...(object.lastModified ? { lastModified: object.lastModified } : {}) });
      }
      token = page.truncated ? page.nextToken : undefined;
    } while (token && items.length <= limit);
    if (items.length > limit || token) truncated = true;
    return { items: items.slice(0, limit), truncated };
  }

  /**
   * Read an object: text up to `maxBytes` inline; binary or larger objects are saved under
   * `saveDir` and the path returned.
   */
  async readObject(agent: string | undefined, idOrSlug: string, path: string, opts: { saveDir: string; maxBytes?: number }): Promise<
    { kind: "text"; text: string; size: number } | { kind: "file"; savedTo: string; size: number; contentType?: string }
  > {
    const entry = await this.requireUsable(idOrSlug, agent);
    const key = assertStorageAccess(entry, agent, path, "read");
    if (!key) throw new Error("A file path is required");
    const fullKey = `${normalizeStoragePrefix(entry.prefix)}${key}`;
    const client = await this.client(entry);
    const head = await client.head(fullKey);
    if (!head) throw new Error(`"${key}" not found in storage "${entry.name}"`);
    const inline = Math.max(1, Math.min(opts.maxBytes ?? STORAGE_READ_INLINE_BYTES, STORAGE_READ_INLINE_BYTES));
    if (head.size <= inline && isTextual(head.contentType, key)) {
      const { body } = await client.get(fullKey);
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(chunk as Buffer);
      const buffer = Buffer.concat(chunks);
      if (!buffer.includes(0)) return { kind: "text", text: buffer.toString("utf8"), size: buffer.length };
    }
    const target = join(opts.saveDir, "storage", entry.slug, `${Date.now()}-${basename(key)}`);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const { body } = await client.get(fullKey);
    await pipeline(body, createWriteStream(target, { mode: 0o600 }));
    return { kind: "file", savedTo: target, size: head.size, ...(head.contentType ? { contentType: head.contentType } : {}) };
  }

  /** Write an object from text or from a host file (the caller checks the file is allowed). */
  async writeObject(agent: string | undefined, idOrSlug: string, path: string, source: { text: string } | { file: string }, contentType?: string): Promise<{ path: string; size: number }> {
    const entry = await this.requireUsable(idOrSlug, agent);
    const key = assertStorageAccess(entry, agent, path, "write");
    if (!key) throw new Error("A file path is required");
    const fullKey = `${normalizeStoragePrefix(entry.prefix)}${key}`;
    const client = await this.client(entry);
    const type = contentType ?? guessContentType(key);
    if ("text" in source) {
      const body = Buffer.from(source.text, "utf8");
      await client.put(fullKey, body, type);
      return { path: key, size: body.length };
    }
    const info = await stat(source.file);
    if (!info.isFile()) throw new Error(`"${source.file}" is not a file`);
    if (info.size > MAX_PUT_BYTES) throw new Error("Files larger than 5 GB cannot be uploaded with storage_write");
    await client.put(fullKey, { stream: createReadStream(source.file), length: info.size }, type);
    return { path: key, size: info.size };
  }

  async deleteObject(agent: string | undefined, idOrSlug: string, path: string): Promise<{ path: string }> {
    const entry = await this.requireUsable(idOrSlug, agent);
    const key = assertStorageAccess(entry, agent, path, "write");
    if (!key) throw new Error("A file path is required");
    await (await this.client(entry)).delete(`${normalizeStoragePrefix(entry.prefix)}${key}`);
    return { path: key };
  }

  async presign(agent: string | undefined, idOrSlug: string, path: string, expiresSeconds = 3600): Promise<{ url: string; expiresAt: string }> {
    const entry = await this.requireUsable(idOrSlug, agent);
    const key = assertStorageAccess(entry, agent, path, "read");
    if (!key) throw new Error("A file path is required");
    const seconds = Math.max(60, Math.min(Math.floor(expiresSeconds), 7 * 24 * 3600));
    const url = (await this.client(entry)).presignGet(`${normalizeStoragePrefix(entry.prefix)}${key}`, seconds);
    return { url, expiresAt: new Date(Date.now() + seconds * 1000).toISOString() };
  }

  /** Host mount path of an object, when its entry is mounted (for file:changed events). */
  hostPathOf(entry: Pick<StorageEntry, "id" | "slug">, key: string): string | undefined {
    const status = this.mountStatus(entry);
    return status.state === "mounted" ? join(status.path, key) : undefined;
  }

  async entry(idOrSlug: string): Promise<StorageEntry | null> {
    return this.store.get(idOrSlug);
  }

  // ── Internals ──────────────────────────────────────────────────────

  private async require(idOrSlug: string): Promise<StorageEntry> {
    const entry = await this.store.get(idOrSlug);
    if (!entry) throw new Error(`Storage "${idOrSlug}" not found`);
    return entry;
  }

  /** An entry the agent may use (unknown and forbidden look the same to agents). */
  private async requireUsable(idOrSlug: string, agent: string | undefined): Promise<StorageEntry> {
    const entry = await this.store.get(idOrSlug);
    if (!entry || (agent !== undefined && !storageAccessFor(entry, agent))) throw new Error(`Storage "${idOrSlug}" not found or not available to you`);
    if (!entry.enabled) throw new Error(`Storage "${entry.name}" is disabled`);
    return entry;
  }

  private async client(entry: StorageEntry): Promise<S3Client> {
    const credentials = await this.credentials(entry);
    if (!credentials) throw new Error(`Credentials for storage "${entry.name}" are not set`);
    return new S3Client(s3TargetFor(entry), credentials);
  }
}

type EntryPatch = Partial<Omit<StorageEntry, "id" | "createdAt" | "updatedAt">>;

/**
 * Normalize the vault references of a create/update (null clears one; a malformed reference or a
 * system "$" owner is refused) and validate the resulting entry.
 */
function prepareEntry<T extends EntryPatch>(patch: T, current?: StorageEntry): T {
  const out = { ...patch } as T & Record<string, unknown>;
  const ref = (value: unknown, what: string): VaultRef | undefined => {
    if (value === null || value === undefined) return undefined;
    const normalized = normalizeVaultRef(value);
    if (!normalized) throw new Error(`${what}: choose an agent's vault entry (owner and service)`);
    return normalized;
  };
  if ("credentials" in out) out.credentials = ref(out.credentials, "Main keys");
  if ("sandboxCredentials" in out) out.sandboxCredentials = ref(out.sandboxCredentials, "Sandbox keys");
  if ("temporaryCredentials" in out) {
    const temp = out.temporaryCredentials as StorageTemporaryCredentials | null | undefined;
    if (!temp) out.temporaryCredentials = undefined;
    else if (temp.kind === "r2") {
      const { token, ...rest } = temp;
      const normalized = ref(token, "Cloudflare API token");
      out.temporaryCredentials = { ...rest, ...(normalized ? { token: normalized } : {}) };
    }
  }
  const merged = { ...current, ...out } as StorageEntry;
  const problem = validateStorageEntry({ ...merged, grants: merged.grants ?? [] });
  if (problem) throw new Error(problem);
  return out;
}

const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|hpp|sh|sql|log|ini|cfg|conf|env|svg)$/i;

function isTextual(contentType: string | undefined, key: string): boolean {
  if (contentType && (/^text\//.test(contentType) || /json|xml|yaml|javascript|csv/.test(contentType))) return true;
  return TEXT_EXTENSIONS.test(key) || !/\.[a-z0-9]{1,8}$/i.test(key);
}

const CONTENT_TYPES: Record<string, string> = {
  txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8", csv: "text/csv; charset=utf-8",
  json: "application/json", html: "text/html; charset=utf-8", xml: "application/xml", yaml: "text/yaml", yml: "text/yaml",
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", mp3: "audio/mpeg", mp4: "video/mp4", zip: "application/zip",
};

function guessContentType(key: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(key)?.[1]?.toLowerCase();
  return (ext && CONTENT_TYPES[ext]) || "application/octet-stream";
}

// ── Per-project runtimes ─────────────────────────────────────────────

const runtimes = new Map<string, StorageRuntime>();

export function getStorageRuntime(polpoDir: string, vaultStore?: VaultStore, emit?: StorageEventEmitter): StorageRuntime {
  let runtime = runtimes.get(polpoDir);
  // Rebuilt if the project's database was opened (or closed) after the runtime was created,
  // unless it is mounting (its mount manager must survive).
  if (runtime && !runtime.mountingActive && (runtime.store === databaseStoresFor(polpoDir)?.storageRegistryStore) !== !!databaseStoresFor(polpoDir)) runtime = undefined;
  if (!runtime) {
    runtime = new StorageRuntime(polpoDir, vaultStore, emit);
    runtimes.set(polpoDir, runtime);
  } else {
    runtime.setVaultStore(vaultStore);
    runtime.setEmitter(emit);
  }
  return runtime;
}

/** Forget the cached runtimes (tests). */
export function resetStorageRuntimes(): void {
  runtimes.clear();
}
