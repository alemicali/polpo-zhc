/**
 * vault_create_login: logins whose password Polpo generates and the model never sees.
 * Generator, the core service, the agent tool (owner from context, no password in the result,
 * masker, same-run vault), the task-run wire handler, the REST route and the file store.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  generateVaultPassword, generateVaultLogin,
  VAULT_PASSWORD_LOWER, VAULT_PASSWORD_UPPER, VAULT_PASSWORD_DIGITS, VAULT_PASSWORD_SYMBOLS,
  type VaultEntry,
} from "@polpo-ai/core";
import { vaultRoutes } from "@polpo-ai/server";
import { createVaultLoginTools, createVaultToolsCore, localVaultLoginAccess, agentHasVaultLoginTool } from "../tools/vault-tools.js";
import { handleVaultLoginWire } from "../core/vault-login-bridge.js";
import { resolveAgentVault } from "../vault/resolver.js";
import { createRunSecrets, resolveEnvFromVault } from "../vault/env-from-vault.js";
import { EncryptedVaultStore } from "../vault/encrypted-store.js";

/** A minimal in-memory VaultStore (agent → service → entry). */
function memoryStore() {
  const data: Record<string, Record<string, VaultEntry>> = {};
  return {
    data,
    async get(agent: string, service: string) { return data[agent]?.[service]; },
    async set(agent: string, service: string, entry: VaultEntry) { (data[agent] ??= {})[service] = structuredClone(entry); },
    async list(agent: string) {
      return Object.entries(data[agent] ?? {}).map(([service, e]) => ({
        service, type: e.type, label: e.label, keys: Object.keys(e.credentials),
        ...(e.metadata?.createdBy ? { createdBy: e.metadata.createdBy } : {}),
        ...(e.metadata?.createdAt ? { createdAt: e.metadata.createdAt } : {}),
      }));
    },
  };
}

const FORBIDDEN = /["'`\\\s]/;

describe("generateVaultPassword", () => {
  it("has the requested length and every character class", () => {
    for (const length of [16, 24, 40, 64]) {
      for (let i = 0; i < 50; i++) {
        const p = generateVaultPassword({ length });
        expect(p).toHaveLength(length);
        expect([...p].some((c) => VAULT_PASSWORD_LOWER.includes(c))).toBe(true);
        expect([...p].some((c) => VAULT_PASSWORD_UPPER.includes(c))).toBe(true);
        expect([...p].some((c) => VAULT_PASSWORD_DIGITS.includes(c))).toBe(true);
        expect([...p].some((c) => VAULT_PASSWORD_SYMBOLS.includes(c))).toBe(true);
        expect(p).not.toMatch(FORBIDDEN);
      }
    }
    expect(generateVaultPassword()).toHaveLength(24);
  });

  it("without symbols uses letters and digits only", () => {
    for (let i = 0; i < 100; i++) expect(generateVaultPassword({ symbols: false })).toMatch(/^[A-Za-z0-9]{24}$/);
  });

  it("the symbol set has no quotes, backslash, backtick or space", () => {
    expect(VAULT_PASSWORD_SYMBOLS).not.toMatch(FORBIDDEN);
  });

  it("refuses lengths outside 16–64", () => {
    expect(() => generateVaultPassword({ length: 15 })).toThrow(/between 16 and 64/);
    expect(() => generateVaultPassword({ length: 65 })).toThrow(/between 16 and 64/);
    expect(() => generateVaultPassword({ length: 20.5 })).toThrow(/integer/);
  });

  it("is random: no repeats, every symbol of the alphabet shows up, roughly uniform", () => {
    const N = 2000;
    const all = Array.from({ length: N }, () => generateVaultPassword({ length: 32 }));
    expect(new Set(all).size).toBe(N);
    const alphabet = VAULT_PASSWORD_LOWER + VAULT_PASSWORD_UPPER + VAULT_PASSWORD_DIGITS + VAULT_PASSWORD_SYMBOLS;
    const counts = new Map<string, number>();
    for (const p of all) for (const c of p) counts.set(c, (counts.get(c) ?? 0) + 1);
    expect([...counts.keys()].sort().join("")).toBe([...alphabet].sort().join(""));
    // 64 000 draws over 90 characters (plus the class minimums): ~711 each; far from uniform would be a bias
    for (const n of counts.values()) {
      expect(n).toBeGreaterThan(450);
      expect(n).toBeLessThan(1100);
    }
  });

  it("uses an injected random source (deterministic with a fixed one)", () => {
    let i = 0;
    const seq = (b: Uint8Array) => { for (let k = 0; k < b.length; k++) b[k] = (i++ * 37) % 256; return b; };
    const p = generateVaultPassword({ length: 20 }, seq);
    expect(p).toHaveLength(20);
  });
});

describe("generateVaultLogin", () => {
  it("creates a login with provenance and the default label", async () => {
    const store = memoryStore();
    const r = await generateVaultLogin(store, "ada", { service: "sitoinchat", email: "ops@acme.com", url: "https://sitoinchat.it" },
      { kind: "agent", agent: "ada", taskId: "t1" }, { ownerDisplayName: "Ada Lovelace", now: () => new Date("2026-11-27T10:00:00Z") });
    expect(r).toMatchObject({ ok: true, service: "sitoinchat", action: "created", keys: ["email", "password", "url"] });
    const e = store.data.ada!.sitoinchat!;
    expect(e.type).toBe("login");
    expect(e.label).toBe("Sitoinchat – Ada Lovelace");
    expect(e.credentials.password).toHaveLength(24);
    expect(e.metadata).toEqual({ createdBy: { kind: "agent", agent: "ada", taskId: "t1" }, createdAt: "2026-11-27T10:00:00.000Z", generated: ["password"] });
  });

  it("refuses an existing entry without rotate", async () => {
    const store = memoryStore();
    await store.set("ada", "site", { type: "login", credentials: { username: "ada", password: "old-password-1" } });
    const r = await generateVaultLogin(store, "ada", { service: "site" }, { kind: "agent", agent: "ada" });
    expect(r).toMatchObject({ ok: false, code: "exists" });
    expect(store.data.ada!.site!.credentials.password).toBe("old-password-1");
  });

  it("rotate keeps username, email and url, changes the password and records rotatedAt", async () => {
    const store = memoryStore();
    await store.set("ada", "site", {
      type: "login", credentials: { username: "ada", email: "a@x.io", password: "old-password-1", url: "https://x.io" },
      metadata: { createdBy: { kind: "person" }, createdAt: "2026-01-01T00:00:00.000Z" },
    });
    const r = await generateVaultLogin(store, "ada", { service: "site", rotate: true, username: "someone-else", symbols: false },
      { kind: "agent", agent: "ada" }, { now: () => new Date("2026-11-27T12:00:00Z") });
    expect(r).toMatchObject({ ok: true, action: "rotated" });
    const e = store.data.ada!.site!;
    expect(e.credentials.username).toBe("ada");
    expect(e.credentials.email).toBe("a@x.io");
    expect(e.credentials.url).toBe("https://x.io");
    expect(e.credentials.password).not.toBe("old-password-1");
    expect(e.credentials.password).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(e.metadata).toMatchObject({ createdBy: { kind: "person" }, createdAt: "2026-01-01T00:00:00.000Z", rotatedAt: "2026-11-27T12:00:00.000Z", generated: ["password"] });
  });

  it("rotate needs an existing login", async () => {
    const store = memoryStore();
    expect(await generateVaultLogin(store, "ada", { service: "nope", rotate: true }, { kind: "person" })).toMatchObject({ ok: false, code: "not_found" });
    await store.set("ada", "api", { type: "api_key", credentials: { key: "k-123456" } });
    expect(await generateVaultLogin(store, "ada", { service: "api", rotate: true }, { kind: "person" })).toMatchObject({ ok: false, code: "not_login" });
  });

  it("refuses bad input and reserved owners", async () => {
    const store = memoryStore();
    expect(await generateVaultLogin(store, "ada", { service: "has.dot" }, { kind: "person" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await generateVaultLogin(store, "ada", { service: "ok", length: 8 }, { kind: "person" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await generateVaultLogin(store, "ada", { service: "ok", url: "javascript:alert(1)" }, { kind: "person" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await generateVaultLogin(store, "$data", { service: "ok" }, { kind: "person" })).toMatchObject({ ok: false, code: "reserved" });
    expect(store.data).toEqual({});
  });
});

describe("vault_create_login tool", () => {
  const agent = { name: "ada", allowedTools: ["browser_*", "vault_create_login"], identity: { displayName: "Ada" } };

  it("is offered only with vault_create_login or vault_* in allowedTools", () => {
    const access = localVaultLoginAccess(memoryStore(), agent);
    expect(createVaultLoginTools({ name: "x" }, access)).toEqual([]);
    expect(createVaultLoginTools({ name: "x", allowedTools: ["browser_*"] }, access)).toEqual([]);
    expect(createVaultLoginTools({ name: "x", allowedTools: ["vault_*"] }, access).map((t) => t.name)).toEqual(["vault_create_login"]);
    expect(agentHasVaultLoginTool(agent)).toBe(true);
    expect(createVaultLoginTools(agent, undefined)).toEqual([]);
  });

  it("writes the context's agent vault (never one named in the call), returns no password, masks it, and the run sees it at once", async () => {
    const store = memoryStore();
    const vault = resolveAgentVault({});
    const secrets = createRunSecrets();
    const [tool] = createVaultLoginTools(agent, localVaultLoginAccess(store, agent, { taskId: "t9", runId: "r9" }), { vault, secrets });
    const r = await tool!.execute("call-1", { service: "sitoinchat", email: "ops@acme.com", agent: "mallory", owner: "mallory" } as any);

    expect(store.data.mallory).toBeUndefined();
    const entry = store.data.ada!.sitoinchat!;
    const password = entry.credentials.password!;
    expect(entry.metadata?.createdBy).toEqual({ kind: "agent", agent: "ada", taskId: "t9", runId: "r9" });

    // the result: names and the fill hint, never the value
    const text = JSON.stringify(r);
    expect(text).not.toContain(password);
    expect(r.details).toMatchObject({ service: "sitoinchat", keys: ["email", "password"], created: true });
    expect(r.content[0]).toMatchObject({ text: expect.stringContaining('browser_fill { from_vault: "sitoinchat.password" }') });

    // the masker has it
    expect(secrets.values()).toContain(password);
    expect(secrets.mask(`typed ${password} in the form`)).toBe("typed *** in the form");
    expect(secrets.maskDeep({ type: "tool_result", content: [`x${password}x`] })).toEqual({ type: "tool_result", content: ["x***x"] });

    // browser_fill / env_from_vault resolve it in the same run
    const env = resolveEnvFromVault({ PW: "sitoinchat.password" }, vault);
    expect(env.errors).toEqual([]);
    expect(env.env.PW).toBe(password);

    // vault_get never shows a generated value, even without a sandbox
    const get = createVaultToolsCore(vault).find((t) => t.name === "vault_get")!;
    const shown = await get.execute("call-2", { service: "sitoinchat" });
    expect(JSON.stringify(shown)).not.toContain(password);
    expect(JSON.stringify(shown)).toContain("ops@acme.com");
  });

  it("refuses an existing entry without rotate and reports the error to the model", async () => {
    const store = memoryStore();
    await store.set("ada", "site", { type: "login", credentials: { username: "ada", password: "old-password-1" } });
    const [tool] = createVaultLoginTools(agent, localVaultLoginAccess(store, agent));
    const r = await tool!.execute("c", { service: "site" });
    expect(r.content[0]).toMatchObject({ text: expect.stringMatching(/^Error: .*already exists.*rotate: true/) });
    expect(store.data.ada!.site!.credentials.password).toBe("old-password-1");
  });
});

describe("task runs: vault_login over the socket", () => {
  const agent = { name: "ada", role: "", allowedTools: ["vault_*"] } as any;
  const deps = (store: ReturnType<typeof memoryStore>, run: any) => ({
    vaultStore: store,
    run: async () => run,
    task: async () => ({ id: "t1" } as any),
    agentFor: async (r: any) => (r.agentName === "ada" ? agent : { name: r.agentName, role: "" } as any),
  });

  it("writes the vault of the run's agent, with the task and run as provenance", async () => {
    const store = memoryStore();
    const r = await handleVaultLoginWire({ type: "vault_login", runId: "r1", service: "site", username: "ada" },
      deps(store, { agentName: "ada", taskId: "t1", status: "running" }));
    expect(r).toMatchObject({ ok: true, action: "created" });
    expect(store.data.ada!.site!.metadata?.createdBy).toEqual({ kind: "agent", agent: "ada", taskId: "t1", runId: "r1" });
  });

  it("refuses runs that are not running and agents without the tool", async () => {
    const store = memoryStore();
    expect(await handleVaultLoginWire({ type: "vault_login", runId: "r1", service: "site" }, deps(store, { agentName: "ada", taskId: "t1", status: "done" })))
      .toMatchObject({ ok: false });
    expect(await handleVaultLoginWire({ type: "vault_login", runId: "r1", service: "site" }, deps(store, { agentName: "bob", taskId: "t1", status: "running" })))
      .toMatchObject({ ok: false, error: expect.stringMatching(/not among this agent's tools/) });
    expect(store.data).toEqual({});
  });
});

describe("REST: POST /vault/entries/{agent}/{service}/generate", () => {
  const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("creates a login, returns no secret, 409 when it exists, lists provenance", async () => {
    const store = memoryStore();
    const app = vaultRoutes(() => ({ vaultStore: store, agentDisplayName: (a: string) => (a === "ada" ? "Ada" : undefined) }));
    const res = await app.request("/entries/ada/sitoinchat/generate", post({ email: "ops@acme.com", length: 32 }));
    expect(res.status).toBe(200);
    const raw = await res.text();
    const password = store.data.ada!.sitoinchat!.credentials.password!;
    expect(password).toHaveLength(32);
    expect(raw).not.toContain(password);
    expect(JSON.parse(raw)).toMatchObject({
      ok: true,
      data: { agent: "ada", service: "sitoinchat", action: "created", keys: ["email", "password"], label: "Sitoinchat – Ada", createdBy: { kind: "person" } },
    });

    expect((await app.request("/entries/ada/sitoinchat/generate", post({}))).status).toBe(409);
    const rot = await app.request("/entries/ada/sitoinchat/generate", post({ rotate: true }));
    expect(rot.status).toBe(200);
    expect(store.data.ada!.sitoinchat!.credentials.password).not.toBe(password);
    expect(store.data.ada!.sitoinchat!.credentials.email).toBe("ops@acme.com");

    expect((await app.request("/entries/ada/sitoinchat/generate", post({ length: 10 }))).status).toBe(400);
    expect((await app.request("/entries/%24data/x/generate", post({}))).status).toBe(400);

    const list = await (await app.request("/entries/ada")).json();
    expect(list.data[0]).toMatchObject({ service: "sitoinchat", createdBy: { kind: "person" }, createdAt: expect.any(String) });
  });
});

describe("EncryptedVaultStore keeps provenance", () => {
  let dir: string;
  const prevKey = process.env.POLPO_VAULT_KEY;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polpo-vault-login-"));
    process.env.POLPO_VAULT_KEY = randomBytes(32).toString("hex");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.POLPO_VAULT_KEY; else process.env.POLPO_VAULT_KEY = prevKey;
  });

  it("persists metadata, lists it, and a patch keeps it (minus the replaced generated keys)", async () => {
    const store = new EncryptedVaultStore(dir);
    const r = await generateVaultLogin(store, "ada", { service: "site", username: "ada" }, { kind: "agent", agent: "ada", sessionId: "s1" });
    expect(r.ok).toBe(true);
    const reopened = new EncryptedVaultStore(dir);
    const listed = (await reopened.list("ada"))[0]!;
    expect(listed).toMatchObject({ service: "site", type: "login", keys: ["username", "password"], createdBy: { kind: "agent", agent: "ada", sessionId: "s1" }, generated: ["password"] });
    expect(JSON.stringify(listed)).not.toContain((await reopened.get("ada", "site"))!.credentials.password!);
    await reopened.patch("ada", "site", { label: "Renamed" });
    expect((await reopened.get("ada", "site"))!.metadata?.generated).toEqual(["password"]);
    await reopened.patch("ada", "site", { credentials: { password: "typed-by-hand-123" } });
    const after = (await reopened.get("ada", "site"))!;
    expect(after.metadata?.generated).toBeUndefined();
    expect(after.metadata?.createdBy).toEqual({ kind: "agent", agent: "ada", sessionId: "s1" });
  });
});
