/** Temporary bucket keys for remote sandboxes, against local mock servers (no cloud calls). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { VaultEntry } from "@polpo-ai/core";
import { STORAGE_VAULT_OWNER, type CreateStorageEntry } from "@polpo-ai/core/storage-registry";
import type { VaultStore } from "../core/vault-store.js";
import { StorageRuntime } from "../storage/runtime.js";
import { TemporaryCredentialCache, sessionPolicy } from "../storage/temp-credentials.js";

class MemoryVault {
  data = new Map<string, VaultEntry>();
  async get(agent: string, service: string) { return this.data.get(`${agent}/${service}`); }
  async set(agent: string, service: string, entry: VaultEntry) { this.data.set(`${agent}/${service}`, entry); }
  async remove(agent: string, service: string) { return this.data.delete(`${agent}/${service}`); }
}

interface Seen { method?: string; url?: string; headers: IncomingMessage["headers"]; body: string }
let server: Server;
let base: string;
let seen: Seen[] = [];
let fail = false;
let counter = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      const n = ++counter;
      if (fail) { res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ success: false, errors: [{ message: "denied" }] })); return; }
      if (req.url?.includes("/r2/temp-access-credentials")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, result: { accessKeyId: `r2-ak-${n}`, secretAccessKey: `r2-sk-${n}`, sessionToken: `r2-st-${n}` } }));
      } else {
        res.writeHead(200, { "content-type": "text/xml" });
        res.end(`<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>sts-ak-${n}</AccessKeyId><SecretAccessKey>sts-sk-${n}</SecretAccessKey><SessionToken>sts-st-${n}</SessionToken><Expiration>${new Date(Date.now() + 3600_000).toISOString()}</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });
beforeEach(() => { seen = []; fail = false; counter = 0; });

const roots: string[] = [];
afterAll(async () => { await Promise.all(roots.map((d) => rm(d, { recursive: true, force: true }))); });

async function setup(overrides: Partial<CreateStorageEntry> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "polpo-temp-"));
  roots.push(dir);
  const vault = new MemoryVault();
  const events: Array<{ name: string; action: string; error?: string }> = [];
  const runtime = new StorageRuntime(dir, vault as unknown as VaultStore, (e) => events.push(e));
  runtime.cloudflareApi = `${base}/client/v4`;
  const entry = await runtime.create({
    name: "Docs", slug: "docs", provider: "s3", bucket: "bucket1", driver: "rclone", readOnly: false, enabled: true, prefix: "team",
    endpoint: base, region: "us-east-1",
    grants: [{ id: "a", agent: "alice", access: "write", prefix: "clients/acme/" }, { id: "b", agent: "bob", access: "read" }], ...overrides,
  }, { credentials: { accessKeyId: "MAINKEY", secretAccessKey: "main-secret" }, sandboxCredentials: { accessKeyId: "fixed-ak", secretAccessKey: "fixed-sk" } });
  return { runtime, entry, vault, events };
}

describe("temporary keys: Cloudflare R2", () => {
  const r2 = { kind: "r2" as const, accountId: "acct1", parentAccessKeyId: "parent-key", apiToken: "cf-token-secret" };

  it("mints keys scoped to bucket, prefix and permission, and returns them instead of the fixed key", async () => {
    const { runtime, entry } = await setup();
    const status = await runtime.update(entry.id, {}, { temporary: r2 });
    expect(status!.temporaryCredentials).toEqual({ kind: "r2", accountId: "acct1", parentAccessKeyId: "parent-key" });
    expect(status!.temporaryToken).toBe("set");
    expect(JSON.stringify(status)).not.toContain("cf-token-secret");

    const [alice] = await runtime.mountsFor("alice", "remote", { ttlSeconds: 3600 });
    expect(alice!.remote!.credentials).toEqual({ accessKeyId: "r2-ak-1", secretAccessKey: "r2-sk-1", sessionToken: "r2-st-1" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/client/v4/accounts/acct1/r2/temp-access-credentials" });
    expect(seen[0]!.headers.authorization).toBe("Bearer cf-token-secret");
    expect(JSON.parse(seen[0]!.body)).toEqual({
      bucket: "bucket1", parentAccessKeyId: "parent-key", permission: "object-read-write", ttlSeconds: 3600, prefixes: ["team/clients/acme/"],
    });

    const [bob] = await runtime.mountsFor("bob", "remote");
    expect(bob!.readOnly).toBe(true);
    expect(JSON.parse(seen[1]!.body)).toMatchObject({ permission: "object-read-only", ttlSeconds: 7200, prefixes: ["team/"] });
  });

  it("caches per agent and entry, then mints again when the keys are about to expire", async () => {
    const { runtime, entry } = await setup();
    await runtime.update(entry.id, {}, { temporary: r2 });
    await runtime.mountsFor("alice", "remote");
    await runtime.mountsFor("alice", "remote");
    expect(seen).toHaveLength(1);
    await runtime.mountsFor("bob", "remote");
    expect(seen).toHaveLength(2);
    // changing the settings drops the cached keys
    await runtime.update(entry.id, {}, { temporary: { ...r2, parentAccessKeyId: "other" } });
    await runtime.mountsFor("alice", "remote");
    expect(seen).toHaveLength(3);
  });

  it("falls back to the fixed key when minting fails, and says so", async () => {
    const { runtime, entry, events } = await setup();
    await runtime.update(entry.id, {}, { temporary: r2 });
    fail = true;
    const [alice] = await runtime.mountsFor("alice", "remote");
    expect(alice!.remote!.credentials).toEqual({ accessKeyId: "fixed-ak", secretAccessKey: "fixed-sk" });
    expect(events).toContainEqual({ name: "docs", action: "mount-failed", error: "Temporary keys: Cloudflare temporary credentials failed: denied" });
  });

  it("requires the API token the first time, keeps it afterwards, and removes it with the settings", async () => {
    const { runtime, entry, vault } = await setup();
    await expect(runtime.update(entry.id, {}, { temporary: { ...r2, apiToken: undefined } })).rejects.toThrow(/API token is required/);
    await runtime.update(entry.id, {}, { temporary: r2 });
    await runtime.update(entry.id, {}, { temporary: { ...r2, apiToken: undefined, accountId: "acct2" } });
    expect(vault.data.get(`${STORAGE_VAULT_OWNER}/storage-temp:${entry.id}`)?.credentials.apiToken).toBe("cf-token-secret");
    const fixed = await runtime.update(entry.id, {}, { temporary: null });
    expect(fixed!.temporaryCredentials).toBeUndefined();
    expect(fixed!.temporaryToken).toBe("not set");
    const [alice] = await runtime.mountsFor("alice", "remote");
    expect(alice!.remote!.credentials.accessKeyId).toBe("fixed-ak");
  });
});

describe("temporary keys: STS AssumeRole (AWS S3, MinIO)", () => {
  const sts = { kind: "sts" as const, roleArn: "arn:aws:iam::123456789012:role/polpo-sandbox" };

  it("signs AssumeRole with the main keys and limits the session policy to the bucket and prefix", async () => {
    const { runtime, entry } = await setup();
    await runtime.update(entry.id, {}, { temporary: sts });
    const [alice] = await runtime.mountsFor("alice", "remote", { ttlSeconds: 5400 });
    expect(alice!.remote!.credentials).toEqual({ accessKeyId: "sts-ak-1", secretAccessKey: "sts-sk-1", sessionToken: "sts-st-1" });

    const req = seen[0]!;
    expect(req.method).toBe("POST");
    expect(req.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=MAINKEY\/\d{8}\/us-east-1\/sts\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(req.headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    const form = new URLSearchParams(req.body);
    expect(form.get("Action")).toBe("AssumeRole");
    expect(form.get("Version")).toBe("2011-06-15");
    expect(form.get("RoleArn")).toBe(sts.roleArn);
    expect(form.get("DurationSeconds")).toBe("5400");
    expect(form.get("RoleSessionName")).toMatch(/^polpo-alice-[0-9a-f]{6}$/);
    const policy = JSON.parse(form.get("Policy")!);
    expect(policy.Statement).toEqual([
      { Effect: "Allow", Action: ["s3:ListBucket"], Resource: ["arn:aws:s3:::bucket1"], Condition: { StringLike: { "s3:prefix": ["team/clients/acme/*"] } } },
      { Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"], Resource: ["arn:aws:s3:::bucket1/team/clients/acme/*"] },
    ]);
    expect(req.body).not.toContain("main-secret");
  });

  it("read-only grants get a policy without write actions", () => {
    const policy = JSON.parse(sessionPolicy("b", "", true));
    expect(policy.Statement[0].Condition).toBeUndefined();
    expect(policy.Statement[1]).toEqual({ Effect: "Allow", Action: ["s3:GetObject"], Resource: ["arn:aws:s3:::b/*"] });
  });

  it("clamps the lifetime to 15 minutes .. 12 hours, and uses the settings' STS endpoint when given", async () => {
    const { runtime, entry } = await setup({ endpoint: undefined, region: "eu-west-1" });
    await runtime.update(entry.id, {}, { temporary: { ...sts, endpoint: `${base}/sts` } });
    await runtime.mountsFor("alice", "remote", { ttlSeconds: 99 * 3600 });
    expect(seen[0]!.url).toBe("/sts/");
    expect(seen[0]!.headers.authorization).toContain("/eu-west-1/sts/aws4_request");
    expect(new URLSearchParams(seen[0]!.body).get("DurationSeconds")).toBe("43200");
  });

  it("falls back to the fixed key when STS refuses", async () => {
    const { runtime, entry } = await setup();
    await runtime.update(entry.id, {}, { temporary: sts });
    fail = true;
    const [alice] = await runtime.mountsFor("alice", "remote");
    expect(alice!.remote!.credentials.accessKeyId).toBe("fixed-ak");
  });

  it("an entry without a fixed key and without working temporary keys is not mounted remotely", async () => {
    const { runtime, entry } = await setup();
    await runtime.update(entry.id, {}, { sandboxCredentials: null, temporary: sts });
    fail = true;
    expect(await runtime.mountsFor("alice", "remote")).toEqual([]);
  });

  it("rejects settings without a role ARN", async () => {
    const { runtime, entry } = await setup();
    await expect(runtime.update(entry.id, {}, { temporary: { kind: "sts", roleArn: "nope" } })).rejects.toThrow(/role ARN/);
  });
});

describe("TemporaryCredentialCache", () => {
  const value = (expiresAt: number) => ({ credentials: { accessKeyId: "a", secretAccessKey: "s", sessionToken: "t" }, expiresAt });
  it("drops keys 5 minutes before expiry, or when too short for the new run", () => {
    const cache = new TemporaryCredentialCache();
    const now = 1_000_000;
    cache.set("k", value(now + 3600_000), 3600);
    expect(cache.get("k", 3600, now + 1000_000)).toBeDefined();
    expect(cache.get("k", 3600, now + 3600_000 - 299_000)).toBeUndefined();
    cache.set("k", value(now + 3600_000), 3600);
    expect(cache.get("k", 12 * 3600, now)).toBeUndefined();
  });
});
