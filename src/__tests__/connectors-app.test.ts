/**
 * Connectors in the full app: the API needs the key, the OAuth callback and the client metadata
 * document do not (the browser and the authorization server reach them without it).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";

const KEY = "connectors-app-test-key";
const previousVaultKey = process.env.POLPO_VAULT_KEY;
let tmpDir: string;
let app: Hono;

beforeAll(async () => {
  process.env.POLPO_VAULT_KEY = randomBytes(32).toString("hex");
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-connectors-app-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({
    project: "connectors-app", team: { name: "t", agents: [{ name: "agent-1", role: "Test agent" }] }, settings: { logLevel: "quiet" },
  }));
  const { Orchestrator } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");
  const orchestrator = new Orchestrator(tmpDir);
  await orchestrator.initInteractive("connectors-app", { name: "t", agents: [{ name: "agent-1", role: "Test agent" }] });
  app = createApp(orchestrator, new SSEBridge(orchestrator), { workDir: tmpDir, apiKeys: [KEY] });
}, 30_000);

afterAll(async () => {
  if (previousVaultKey === undefined) delete process.env.POLPO_VAULT_KEY;
  else process.env.POLPO_VAULT_KEY = previousVaultKey;
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

const auth = { authorization: `Bearer ${KEY}` };
const publicHeaders = { "x-forwarded-host": "polpo.example.com", "x-forwarded-proto": "https" };

describe("connectors in the app", () => {
  it("the API needs the key", async () => {
    expect((await app.request("/api/v1/connectors")).status).toBe(401);
    const res = await app.request("/api/v1/connectors", { headers: auth });
    expect(res.status).toBe(200);
    expect((await res.json()).data.connectors).toEqual([]);
  });

  it("the catalog gives the redirect URI to register, as people reach the instance", async () => {
    const res = await app.request("/api/v1/connectors/catalog", { headers: { ...auth, ...publicHeaders } });
    const body = await res.json();
    expect(body.data.redirectUri).toBe("https://polpo.example.com/api/v1/connectors/oauth/callback");
    expect(body.data.entries.length).toBeGreaterThan(100);
  });

  it("the OAuth callback is public, and refuses an unknown state", async () => {
    const res = await app.request("/api/v1/connectors/oauth/callback?code=abc&state=unknown");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Unknown or expired authorization");
  });

  it("the client metadata document is public", async () => {
    const res = await app.request("/api/v1/connectors/oauth/client-metadata.json", { headers: publicHeaders });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      client_id: "https://polpo.example.com/api/v1/connectors/oauth/client-metadata.json",
      redirect_uris: ["https://polpo.example.com/api/v1/connectors/oauth/callback"],
    });
  });

  it("with a path-prefixed POLPO_PUBLIC_URL, the dashboard calling on another port still gets public provider URLs", async () => {
    const saved = { public: process.env.POLPO_PUBLIC_URL, dashboard: process.env.POLPO_DASHBOARD_URL };
    process.env.POLPO_PUBLIC_URL = "https://lumea-dev.example.ts.net/lumea";
    process.env.POLPO_DASHBOARD_URL = "https://lumea-dev.example.ts.net:5174";
    const privatePort = { "x-forwarded-host": "lumea-dev.example.ts.net:3001", "x-forwarded-proto": "https" };
    try {
      const catalog = await (await app.request("/api/v1/connectors/catalog", { headers: { ...auth, ...privatePort } })).json();
      expect(catalog.data.redirectUri).toBe("https://lumea-dev.example.ts.net/lumea/api/v1/connectors/oauth/callback");
      const doc = await (await app.request("/api/v1/connectors/oauth/client-metadata.json", { headers: privatePort })).json();
      expect(doc).toMatchObject({
        client_id: "https://lumea-dev.example.ts.net/lumea/api/v1/connectors/oauth/client-metadata.json",
        redirect_uris: ["https://lumea-dev.example.ts.net/lumea/api/v1/connectors/oauth/callback"],
      });
      // the callback page sends the browser back to the dashboard, not to the API origin
      const callback = await (await app.request("/api/v1/connectors/oauth/callback?error=access_denied&state=x", { headers: { host: "lumea-dev.example.ts.net" } })).text();
      expect(callback).toContain("https://lumea-dev.example.ts.net:5174/connectors");
    } finally {
      for (const [key, value] of [["POLPO_PUBLIC_URL", saved.public], ["POLPO_DASHBOARD_URL", saved.dashboard]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("creates a connector and never returns its secrets", async () => {
    const res = await app.request("/api/v1/connectors", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ catalogId: "github", auth: { type: "bearer" }, secrets: { bearerToken: "ghp_test_secret_value" }, access: { agents: ["agent-1"] } }),
    });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain("ghp_test_secret_value");
    expect(JSON.parse(text).data).toMatchObject({ id: "github", auth: { type: "bearer" }, secrets: { bearerToken: true } });
    const list = await (await app.request("/api/v1/connectors", { headers: auth })).text();
    expect(list).not.toContain("ghp_test_secret_value");
    // the vault's reserved namespace is not reachable through the vault API
    const vault = await app.request("/api/v1/vault/%24connectors", { headers: auth });
    expect(await vault.text()).not.toContain("ghp_test_secret_value");
  });
});
