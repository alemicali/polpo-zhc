/**
 * Storage: registry, grants, credentials in the vault, the S3 client, mounts and tools.
 *
 * Integration parts run against a local S3 server (`rclone serve s3` over a temp directory) and,
 * when FUSE is usable, real `rclone mount`s. They are skipped when rclone is not installed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STORAGE_VAULT_OWNER,
  assertStorageAccess,
  normalizeStoragePath,
  normalizeStoragePrefix,
  scopeStorageListing,
  storageAccessFor,
  validateStorageEntry,
  type CreateStorageEntry,
  type StorageEntry,
} from "@polpo-ai/core/storage-registry";
import type { VaultEntry } from "@polpo-ai/core";
import type { VaultStore } from "../core/vault-store.js";
import { FileStorageRegistryStore } from "../stores/file-storage-registry-store.js";
import { StorageRuntime } from "../storage/runtime.js";
import { StorageMountManager } from "../storage/mount-manager.js";
import { S3Client, parseListing, s3TargetFor } from "../storage/s3.js";
import { childEnv, findBinary, fusermountBinary, isMounted, rcloneMountArgs, rcloneRemoteEnv, rcloneRemotePath } from "../storage/rclone.js";
import { storageRoutes } from "../server/routes/storage.js";
import { createStorageAgentTools, executeStorageTool } from "../tools/storage-tools.js";

// ── Helpers ────────────────────────────────────────────────────────────

class MemoryVault {
  data = new Map<string, VaultEntry>();
  async get(agent: string, service: string) { return this.data.get(`${agent}/${service}`); }
  async set(agent: string, service: string, entry: VaultEntry) { this.data.set(`${agent}/${service}`, entry); }
  async remove(agent: string, service: string) { return this.data.delete(`${agent}/${service}`); }
}

const roots: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function entryInput(overrides: Partial<CreateStorageEntry> = {}): CreateStorageEntry {
  return {
    name: "Docs", slug: "docs", provider: "s3", bucket: "bucket1", driver: "rclone", readOnly: false, enabled: true,
    grants: [], ...overrides,
  };
}

const RCLONE = findBinary("rclone");
const FUSE = !!RCLONE && !!fusermountBinary() && existsSync("/dev/fuse");
const AK = "test-access-key";
const SK = "test-secret-key-0123456789";

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolvePort(port));
    });
  });
}

// ── Pure rules ─────────────────────────────────────────────────────────

describe("storage grants and prefixes", () => {
  const entry = {
    name: "Docs", readOnly: false,
    grants: [
      { id: "1", agent: "alice", access: "write" as const, prefix: "/clients/acme" },
      { id: "2", agent: "bob", access: "read" as const },
      { id: "3", agent: "*", access: "read" as const, prefix: "public/" },
    ],
  };

  it("normalizes prefixes and paths and rejects traversal", () => {
    expect(normalizeStoragePrefix("/a//b/")).toBe("a/b/");
    expect(normalizeStoragePrefix("")).toBe("");
    expect(normalizeStoragePath("/a/./b.txt")).toBe("a/b.txt");
    expect(() => normalizeStoragePath("a/../../etc/passwd")).toThrow(/\.\./);
    expect(() => normalizeStoragePrefix("../x")).toThrow(/\.\./);
  });

  it("resolves the grant of an agent, the * grant, and full access for Polpo", () => {
    expect(storageAccessFor(entry, "alice")).toEqual({ access: "write", prefix: "clients/acme/" });
    expect(storageAccessFor(entry, "bob")).toEqual({ access: "read", prefix: "" });
    expect(storageAccessFor(entry, "carol")).toEqual({ access: "read", prefix: "public/" });
    expect(storageAccessFor({ ...entry, grants: [] }, "carol")).toBeNull();
    expect(storageAccessFor(entry, undefined)).toEqual({ access: "write", prefix: "" });
    expect(storageAccessFor({ ...entry, readOnly: true }, "alice")).toEqual({ access: "read", prefix: "clients/acme/" });
    expect(storageAccessFor({ ...entry, readOnly: true }, undefined)?.access).toBe("read");
  });

  it("checks access and prefix per operation", () => {
    expect(assertStorageAccess(entry, "alice", "clients/acme/x.txt", "write")).toBe("clients/acme/x.txt");
    expect(() => assertStorageAccess(entry, "alice", "clients/acmeco/x.txt", "read")).toThrow(/outside the allowed prefix/);
    expect(() => assertStorageAccess(entry, "bob", "x.txt", "write")).toThrow(/read-only grant/);
    expect(() => assertStorageAccess({ ...entry, readOnly: true }, "alice", "clients/acme/x", "write")).toThrow(/is read-only/);
    expect(() => assertStorageAccess({ ...entry, grants: [] }, "zed", "x", "read")).toThrow(/no grant/);
  });

  it("scopes listings to the grant prefix", () => {
    expect(scopeStorageListing("clients/acme/", undefined)).toBe("clients/acme/");
    expect(scopeStorageListing("clients/acme/", "clients")).toBe("clients/acme/");
    expect(scopeStorageListing("clients/acme/", "clients/acme/2026")).toBe("clients/acme/2026/");
    expect(() => scopeStorageListing("clients/acme/", "other")).toThrow(/outside/);
    expect(scopeStorageListing("", "any/where")).toBe("any/where/");
  });

  it("validates entries", () => {
    const base = { slug: "docs", bucket: "b", driver: "rclone" as const, readOnly: false, grants: [] };
    expect(validateStorageEntry(base)).toBeUndefined();
    expect(validateStorageEntry({ ...base, slug: "Bad Slug" })).toMatch(/Slug/);
    expect(validateStorageEntry({ ...base, bucket: "a/b" })).toMatch(/Bucket/);
    expect(validateStorageEntry({ ...base, driver: "mountpoint-s3" })).toMatch(/read-only/);
    expect(validateStorageEntry({ ...base, driver: "mountpoint-s3", readOnly: true })).toBeUndefined();
    expect(validateStorageEntry({ ...base, endpoint: "not a url" })).toMatch(/URL/);
    expect(validateStorageEntry({ ...base, grants: [{ id: "1", agent: "a", access: "read" }, { id: "2", agent: "a", access: "write" }] })).toMatch(/more than one/);
  });
});

describe("S3 targets and rclone configuration", () => {
  it("derives AWS, R2 and custom endpoints", () => {
    expect(s3TargetFor({ bucket: "b", region: "eu-central-1" })).toEqual({ endpoint: "https://s3.eu-central-1.amazonaws.com", region: "eu-central-1", bucket: "b", pathStyle: false });
    expect(s3TargetFor({ bucket: "b", endpoint: "https://acct.r2.cloudflarestorage.com/" })).toMatchObject({ endpoint: "https://acct.r2.cloudflarestorage.com", region: "auto", pathStyle: true });
    expect(s3TargetFor({ bucket: "b", endpoint: "http://minio:9000", pathStyle: false })).toMatchObject({ region: "us-east-1", pathStyle: false });
  });

  it("passes credentials through environment variables only", () => {
    const entry = { ...entryInput({ endpoint: "https://acct.r2.cloudflarestorage.com", prefix: "team/" }), id: "e1", createdAt: "", updatedAt: "" } as StorageEntry;
    const env = rcloneRemoteEnv(entry, { accessKeyId: AK, secretAccessKey: SK });
    expect(env).toMatchObject({ RCLONE_CONFIG_POLPO_TYPE: "s3", RCLONE_CONFIG_POLPO_PROVIDER: "Cloudflare", RCLONE_CONFIG_POLPO_REGION: "auto", RCLONE_CONFIG_POLPO_SECRET_ACCESS_KEY: SK });
    const args = rcloneMountArgs(entry, "/m", "/c");
    expect(args.join(" ")).not.toContain(SK);
    expect(args.join(" ")).not.toContain(AK);
    expect(rcloneRemotePath(entry)).toBe("polpo:bucket1/team");
    expect(rcloneMountArgs({ ...entry, readOnly: true, cache: { mode: "full", maxSizeMb: 300 } }, "/m", "/c")).toEqual(expect.arrayContaining(["--read-only", "full", "300M"]));
    const child = childEnv({ X: "1" });
    expect(Object.keys(child).every((key) => ["PATH", "HOME", "LANG", "TZ", "TMPDIR", "X"].includes(key))).toBe(true);
  });

  it("parses ListObjectsV2 responses", () => {
    const listing = parseListing(`<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t&amp;1</NextContinuationToken>
      <Contents><Key>a &amp; b.txt</Key><Size>3</Size><LastModified>2026-01-01T00:00:00Z</LastModified><ETag>"x"</ETag></Contents>
      <CommonPrefixes><Prefix>dir/</Prefix></CommonPrefixes></ListBucketResult>`);
    expect(listing).toEqual({
      objects: [{ key: "a & b.txt", size: 3, lastModified: "2026-01-01T00:00:00Z", etag: "x" }],
      prefixes: ["dir/"], truncated: true, nextToken: "t&1",
    });
  });

  it("presigns GET URLs without the secret", () => {
    const client = new S3Client(s3TargetFor({ bucket: "b", region: "us-east-1" }), { accessKeyId: AK, secretAccessKey: SK });
    const url = client.presignGet("dir/a b.txt", 600, new Date("2026-10-06T00:00:00Z"));
    expect(url).toMatch(/^https:\/\/b\.s3\.us-east-1\.amazonaws\.com\/dir\/a%20b\.txt\?X-Amz-Algorithm=AWS4-HMAC-SHA256/);
    expect(url).toContain("X-Amz-Expires=600");
    expect(url).not.toContain(SK);
  });
});

// ── File registry store ────────────────────────────────────────────────

describe("FileStorageRegistryStore", () => {
  afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

  it("creates, finds, updates and deletes entries in storage.json, with unique slugs and events", async () => {
    const polpoDir = await tempDir("polpo-storage-file-");
    const events: string[] = [];
    const store = new FileStorageRegistryStore(polpoDir, (event) => events.push(`${event.action}:${event.slug}`));
    const docs = await store.create(entryInput());
    const assets = await store.create(entryInput({ name: "Assets", slug: "assets" }));
    expect((await store.list()).map((e) => e.slug)).toEqual(["assets", "docs"]);
    expect((await store.get(docs.id))?.slug).toBe("docs");
    expect((await store.get("assets"))?.id).toBe(assets.id);
    await expect(store.create(entryInput())).rejects.toThrow(/already exists/);
    await expect(store.update("assets", { slug: "docs" })).rejects.toThrow(/already exists/);
    expect((await store.update("docs", { readOnly: true }))?.readOnly).toBe(true);
    expect(await store.delete("docs")).toBe(true);
    expect(await store.delete("docs")).toBe(false);
    const file = JSON.parse(await readFile(join(polpoDir, "storage.json"), "utf8"));
    expect(file.entries.map((e: StorageEntry) => e.slug)).toEqual(["assets"]);
    expect(events).toEqual(["created:docs", "created:assets", "updated:docs", "deleted:docs"]);
  });
});

// ── Runtime, API and tools against a local S3 server ─────────────────

describe.skipIf(!RCLONE)("storage against a local S3 server", () => {
  let server: ChildProcess;
  let endpoint: string;
  let s3root: string;
  let polpoDir: string;
  let vault: MemoryVault;
  let events: Array<{ name: string; action: string; error?: string }>;
  const runtimes: StorageRuntime[] = [];

  beforeAll(async () => {
    s3root = await mkdtemp(join(tmpdir(), "polpo-s3-"));
    await mkdir(join(s3root, "bucket1", "clients", "acme"), { recursive: true });
    await mkdir(join(s3root, "bucket1", "public"), { recursive: true });
    await writeFile(join(s3root, "bucket1", "clients", "acme", "brief.md"), "# Acme brief\n");
    await writeFile(join(s3root, "bucket1", "clients", "other.txt"), "other client\n");
    await writeFile(join(s3root, "bucket1", "public", "logo.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    await writeFile(join(s3root, "bucket1", "public", "big.txt"), "x".repeat(300 * 1024));
    const port = await freePort();
    endpoint = `http://127.0.0.1:${port}`;
    server = spawn(RCLONE!, ["serve", "s3", s3root, "--addr", `127.0.0.1:${port}`, "--auth-key", `${AK},${SK}`, "--config", ""], { stdio: "ignore", env: childEnv({}) });
    const deadline = Date.now() + 10_000;
    for (;;) {
      try { await fetch(endpoint); break; } catch { if (Date.now() > deadline) throw new Error("rclone serve s3 did not start"); await new Promise((r) => setTimeout(r, 100)); }
    }
  }, 20_000);

  afterAll(async () => {
    for (const runtime of runtimes) await runtime.shutdown().catch(() => undefined);
    server?.kill("SIGTERM");
    await rm(s3root, { recursive: true, force: true });
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function setup(grants: StorageEntry["grants"] = [], overrides: Partial<CreateStorageEntry> = {}) {
    polpoDir = await tempDir("polpo-storage-");
    vault = new MemoryVault();
    events = [];
    const runtime = new StorageRuntime(polpoDir, vault as unknown as VaultStore, (payload) => events.push(payload), { backoffMs: 200, maxBackoffMs: 400 });
    runtimes.push(runtime);
    const entry = await runtime.create(entryInput({ endpoint, region: "us-east-1", grants, ...overrides }), { credentials: { accessKeyId: AK, secretAccessKey: SK } });
    return { runtime, entry };
  }

  it("stores credentials in the $storage vault namespace and only reports whether they are set", async () => {
    const { runtime, entry } = await setup();
    expect(entry).toMatchObject({ credentials: "set", sandboxCredentials: "not set" });
    expect(JSON.stringify(entry)).not.toContain(SK);
    expect(vault.data.get(`${STORAGE_VAULT_OWNER}/storage:${entry.id}`)?.credentials.secretAccessKey).toBe(SK);
    await runtime.update(entry.id, {}, { sandboxCredentials: { accessKeyId: "sbx", secretAccessKey: "sbx-secret" } });
    expect((await runtime.get("docs"))?.sandboxCredentials).toBe("set");
    await runtime.update(entry.id, {}, { sandboxCredentials: null });
    expect((await runtime.get("docs"))?.sandboxCredentials).toBe("not set");
    expect(await runtime.delete("docs")).toBe(true);
    expect(vault.data.size).toBe(0);
    expect(events.map((e) => e.action)).toEqual(["created", "updated", "updated", "deleted"]);
  });

  it("tests the connection with one listed object, and reports bad credentials", async () => {
    const { runtime, entry } = await setup();
    const result = await runtime.test(entry.id);
    expect(result.ok).toBe(true);
    expect(result.sampleKey).toBeTruthy();
    await runtime.update(entry.id, {}, { credentials: { accessKeyId: AK, secretAccessKey: "wrong-secret" } });
    await expect(runtime.test(entry.id)).rejects.toThrow(/SignatureDoesNotMatch|403/);
  });

  it("lists, reads, writes, deletes and presigns within an agent's grant", async () => {
    const { runtime } = await setup([
      { id: "a", agent: "alice", access: "write", prefix: "clients/acme/" },
      { id: "b", agent: "bob", access: "read" },
    ]);
    // Alice is scoped to her prefix even when she lists the root.
    const alice = await runtime.listObjects("alice", "docs", {});
    expect(alice.items.map((i) => i.path)).toEqual(["clients/acme/brief.md"]);
    await expect(runtime.listObjects("alice", "docs", { prefix: "public" })).rejects.toThrow(/outside/);
    await expect(runtime.readObject("alice", "docs", "clients/other.txt", { saveDir: polpoDir })).rejects.toThrow(/outside/);
    expect(await runtime.readObject("alice", "docs", "clients/acme/brief.md", { saveDir: polpoDir })).toMatchObject({ kind: "text", text: "# Acme brief\n" });
    await runtime.writeObject("alice", "docs", "clients/acme/notes.txt", { text: "hello" });
    expect(await readFile(join(s3root, "bucket1", "clients", "acme", "notes.txt"), "utf8")).toBe("hello");
    await expect(runtime.writeObject("bob", "docs", "public/x.txt", { text: "no" })).rejects.toThrow(/read-only grant/);
    await expect(runtime.listObjects("carol", "docs")).rejects.toThrow(/not found or not available/);
    // Bob sees everything, one level at a time or recursively.
    const top = await runtime.listObjects("bob", "docs", {});
    expect(top.items).toEqual(expect.arrayContaining([{ path: "clients/", type: "dir" }, { path: "public/", type: "dir" }]));
    const all = await runtime.listObjects("bob", "docs", { recursive: true, limit: 2 });
    expect(all.items).toHaveLength(2);
    expect(all.truncated).toBe(true);
    // Binary and large files are saved locally.
    const binary = await runtime.readObject("bob", "docs", "public/logo.bin", { saveDir: polpoDir });
    expect(binary.kind).toBe("file");
    if (binary.kind === "file") expect([...await readFile(binary.savedTo)]).toEqual([0, 1, 2, 3, 0, 255]);
    const big = await runtime.readObject("bob", "docs", "public/big.txt", { saveDir: polpoDir });
    expect(big).toMatchObject({ kind: "file", size: 300 * 1024 });
    // Presigned links work without credentials.
    const { url } = await runtime.presign("bob", "docs", "clients/acme/notes.txt", 120);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello");
    await runtime.deleteObject("alice", "docs", "clients/acme/notes.txt");
    expect(existsSync(join(s3root, "bucket1", "clients", "acme", "notes.txt"))).toBe(false);
  });

  it("applies the entry prefix to every operation", async () => {
    const { runtime } = await setup([{ id: "b", agent: "bob", access: "write" }], { prefix: "clients/" });
    const listing = await runtime.listObjects("bob", "docs", {});
    expect(listing.items.map((i) => i.path).sort()).toEqual(["acme/", "other.txt"]);
    expect(await runtime.readObject("bob", "docs", "other.txt", { saveDir: polpoDir })).toMatchObject({ kind: "text", text: "other client\n" });
  });

  it("gives remote mounts only to entries with sandbox credentials, and host mounts only when mounted", async () => {
    const { runtime, entry } = await setup([{ id: "a", agent: "alice", access: "write", prefix: "clients/acme/" }, { id: "b", agent: "bob", access: "read" }], { prefix: "team" });
    expect(await runtime.mountsFor("alice", "remote")).toEqual([]);
    expect(await runtime.mountsFor("alice", "host")).toEqual([]);
    await runtime.update(entry.id, {}, { sandboxCredentials: { accessKeyId: "sbx", secretAccessKey: "sbx-secret" } });
    expect(await runtime.mountsFor("alice", "remote")).toEqual([{
      name: "docs", path: "/mnt/storage/docs", readOnly: false,
      remote: { driver: "rclone", endpoint, region: "us-east-1", bucket: "bucket1", prefix: "team/clients/acme/", pathStyle: true, credentials: { accessKeyId: "sbx", secretAccessKey: "sbx-secret" } },
    }]);
    expect((await runtime.mountsFor("bob", "remote"))[0]).toMatchObject({ readOnly: true, remote: { prefix: "team/" } });
    expect(await runtime.mountsFor("carol", "remote")).toEqual([]);
    await runtime.update(entry.id, { enabled: false });
    expect(await runtime.mountsFor("alice", "remote")).toEqual([]);
  });

  it("serves the API without ever returning credentials", async () => {
    const { runtime } = await setup();
    const app = storageRoutes(() => runtime);
    const created = await app.request("/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Media", slug: "media", endpoint, bucket: "bucket1", readOnly: true,
        grants: [{ agent: "bob", access: "read", prefix: "public" }],
        credentials: { accessKeyId: AK, secretAccessKey: SK },
        sandboxCredentials: { accessKeyId: "sbx-key", secretAccessKey: "sbx-secret-value" },
      }),
    });
    expect(created.status).toBe(201);
    const body = await created.text();
    expect(body).not.toContain(SK);
    expect(body).not.toContain("sbx-secret-value");
    expect(JSON.parse(body).data).toMatchObject({ slug: "media", credentials: "set", sandboxCredentials: "set", grants: [{ agent: "bob", access: "read", prefix: "public" }] });
    const list = await (await app.request("/")).text();
    expect(list).not.toContain(SK);
    expect(list).not.toContain(AK);
    expect(JSON.parse(list).data.map((e: StorageEntry) => e.slug)).toEqual(["docs", "media"]);
    const test = await app.request("/media/test", { method: "POST" });
    expect(await test.json()).toMatchObject({ ok: true, data: { ok: true } });
    const invalid = await app.request("/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X", slug: "x", bucket: "b", driver: "mountpoint-s3", readOnly: false }),
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toMatch(/read-only/);
    const credentials = await app.request("/media/credentials", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ sandboxCredentials: null }),
    });
    expect((await credentials.json()).data.sandboxCredentials).toBe("not set");
    expect((await app.request("/missing")).status).toBe(404);
    expect((await app.request("/media", { method: "DELETE" })).status).toBe(200);
    expect((await app.request("/media")).status).toBe(404);
  });

  it("exposes agent tools only through allowedTools, with grants enforced", async () => {
    const { runtime } = await setup([{ id: "a", agent: "alice", access: "write", prefix: "clients/acme/" }]);
    expect(createStorageAgentTools(polpoDir, "alice", ["read", "data_*"])).toEqual([]);
    expect(createStorageAgentTools(polpoDir, "alice", ["storage_read"]).map((t) => t.name)).toEqual(["storage_read"]);
    const tools = createStorageAgentTools(polpoDir, "alice", ["storage_*"], { vaultStore: vault as unknown as VaultStore, cwd: polpoDir });
    expect(tools.map((t) => t.name)).toEqual(["storage_list", "storage_read", "storage_write", "storage_delete", "storage_presign"]);
    const run = async (name: string, params: Record<string, unknown>) => {
      const result = await tools.find((t) => t.name === name)!.execute("call", params as any);
      return (result.content[0] as { text: string }).text;
    };
    const storages = JSON.parse(await run("storage_list", {}));
    expect(storages.storages).toEqual([{ name: "Docs", slug: "docs", access: "write", prefix: "clients/acme/" }]);
    expect(await run("storage_read", { storage: "docs", path: "clients/acme/brief.md" })).toBe("# Acme brief\n");
    const local = join(polpoDir, "upload.txt");
    await writeFile(local, "from a file");
    expect(JSON.parse(await run("storage_write", { storage: "docs", path: "clients/acme/up.txt", fromFile: local }))).toMatchObject({ written: true, size: 11 });
    expect(await readFile(join(s3root, "bucket1", "clients", "acme", "up.txt"), "utf8")).toBe("from a file");
    expect(await run("storage_write", { storage: "docs", path: "clients/acme/x.txt", fromFile: "/etc/hostname" })).toMatch(/outside your allowed folders/);
    expect(await run("storage_write", { storage: "docs", path: "public/x.txt", content: "x" })).toMatch(/outside the allowed prefix/);
    expect(await run("storage_delete", { storage: "docs", path: "clients/acme/up.txt" })).toContain('"deleted": true');
    // Admin tools are Polpo's only.
    await expect(executeStorageTool("storage_list_entries", {}, { polpoDir, agent: "alice", vaultStore: vault as unknown as VaultStore })).rejects.toThrow(/reserved to Polpo/);
    const entries = await executeStorageTool("storage_list_entries", {}, { polpoDir, vaultStore: vault as unknown as VaultStore });
    expect(entries).not.toContain(SK);
    expect(JSON.parse(entries)[0]).toMatchObject({ slug: "docs", credentials: "set", mount: { state: "unmounted" } });
    void runtime;
  });

  it("reports a missing mountpoint-s3 driver and missing credentials as mount errors", async () => {
    const { runtime, entry } = await setup([], { driver: "mountpoint-s3", readOnly: true });
    const status = await runtime.mount(entry.id);
    expect(status.state).toBe("error");
    expect(status.error).toMatch(/Driver not installed: mountpoint-s3/);
    expect(events.at(-1)).toMatchObject({ name: "docs", action: "mount-failed" });
    const other = await runtime.create(entryInput({ name: "Other", slug: "other", endpoint }));
    expect((await runtime.mount(other.id)).error).toBe("Credentials are not set");
  });

  describe.skipIf(!FUSE)("real FUSE mounts", () => {
    it("mounts, exposes the bucket as files, restarts after a crash and unmounts", async () => {
      const { runtime, entry } = await setup([{ id: "a", agent: "alice", access: "write", prefix: "clients/acme/" }, { id: "b", agent: "bob", access: "read" }]);
      const status = await runtime.mount(entry.id);
      expect(status.state, status.error).toBe("mounted");
      const mountPath = join(polpoDir, "mounts", "docs");
      expect(isMounted(mountPath)).toBe(true);
      expect(await readFile(join(mountPath, "clients", "acme", "brief.md"), "utf8")).toBe("# Acme brief\n");
      expect(existsSync(join(polpoDir, "cache", "storage", "docs"))).toBe(true);
      expect(events.some((e) => e.action === "mounted" && e.name === "docs")).toBe(true);

      expect(await runtime.mountsFor("alice", "host")).toEqual([{ name: "docs", path: join(mountPath, "clients/acme/"), hostPath: join(mountPath, "clients/acme/"), readOnly: false }]);
      expect(await runtime.mountsFor("bob", "host")).toEqual([{ name: "docs", path: mountPath, hostPath: mountPath, readOnly: true }]);
      expect(await runtime.mountsFor(undefined, "host")).toHaveLength(1);

      // Writes through the mount reach the bucket (vfs-cache-mode writes uploads on close).
      await writeFile(join(mountPath, "clients", "acme", "via-mount.txt"), "mounted write");
      const target = join(s3root, "bucket1", "clients", "acme", "via-mount.txt");
      for (let i = 0; i < 100 && !existsSync(target); i++) await new Promise((r) => setTimeout(r, 100));
      expect(await readFile(target, "utf8")).toBe("mounted write");

      // Crash: the child dies, the state goes to error, then it is mounted again.
      const pid = status.pid!;
      process.kill(pid, "SIGKILL");
      for (let i = 0; i < 50 && runtime.mountStatus(entry).state !== "error"; i++) await new Promise((r) => setTimeout(r, 50));
      expect(runtime.mountStatus(entry).state).toBe("error");
      expect(events.some((e) => e.action === "mount-failed")).toBe(true);
      for (let i = 0; i < 100 && runtime.mountStatus(entry).state !== "mounted"; i++) await new Promise((r) => setTimeout(r, 100));
      expect(runtime.mountStatus(entry)).toMatchObject({ state: "mounted", restarts: 1 });
      expect(runtime.mountStatus(entry).pid).not.toBe(pid);
      expect(await readFile(join(mountPath, "clients", "acme", "brief.md"), "utf8")).toBe("# Acme brief\n");

      // Disabling unmounts; enabling mounts again; deleting unmounts and forgets.
      await runtime.update(entry.id, { enabled: false });
      expect(isMounted(mountPath)).toBe(false);
      expect(runtime.mountStatus(entry).state).toBe("unmounted");
      expect(await runtime.mountsFor("bob", "host")).toEqual([]);
      await runtime.update(entry.id, { enabled: true });
      expect(runtime.mountStatus(entry).state).toBe("mounted");
      await runtime.delete(entry.id);
      expect(isMounted(mountPath)).toBe(false);
      expect(events.filter((e) => e.action === "unmounted").length).toBeGreaterThanOrEqual(2);
    }, 60_000);

    it("mounts read-only entries read-only and cleans up at shutdown", async () => {
      const { runtime, entry } = await setup([], { readOnly: true });
      await runtime.startMounts();
      const mountPath = join(polpoDir, "mounts", "docs");
      expect(runtime.mountStatus(entry).state).toBe("mounted");
      await expect(writeFile(join(mountPath, "nope.txt"), "x")).rejects.toThrow(/EROFS|EPERM|EACCES/);
      await runtime.shutdown();
      expect(isMounted(mountPath)).toBe(false);
      expect(await readdir(mountPath)).toEqual([]);
    }, 60_000);

    it("refuses a non-empty mount directory", async () => {
      const dir = await tempDir("polpo-storage-mm-");
      await mkdir(join(dir, "mounts", "docs"), { recursive: true });
      await writeFile(join(dir, "mounts", "docs", "stray.txt"), "x");
      const manager = new StorageMountManager({ polpoDir: dir, credentialsFor: async () => ({ accessKeyId: AK, secretAccessKey: SK }) });
      const status = await manager.mount({ ...entryInput({ endpoint }), id: "x", createdAt: "", updatedAt: "" } as StorageEntry);
      expect(status.state).toBe("error");
      expect(status.error).toMatch(/not empty/);
    });
  });
});
