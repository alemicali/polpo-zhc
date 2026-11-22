/**
 * The whole Configuration page through MCP, on a real instance (createApp, the real routes): every
 * section has a read tool and, where the dashboard edits it, a write tool; the instance appearance
 * (theme, palette, design tokens) and the dark-mode logo; secrets never pass through.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";

const PUBLIC = "https://polpo.example.com";
const MCP_KEY = "mcp-key-for-config-sections";
let tmpDir: string;
let app: Hono;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

/**
 * Configuration → section: the tools that read it and the tools that change it. A section the
 * dashboard edits has at least one of each; the test checks every tool exists.
 */
export const CONFIG_SECTION_TOOLS: Record<string, { read: string[]; write: string[] }> = {
  general: { read: ["polpo_config_get"], write: ["polpo_config_update"] },
  members: { read: ["polpo_members_list"], write: ["polpo_members_invite", "polpo_members_remove"] },
  agent: { read: ["polpo_config_get", "polpo_models_list"], write: ["polpo_config_update"] },
  providers: { read: ["polpo_providers_list", "polpo_custom_providers_list", "polpo_models_list"], write: ["polpo_custom_provider_save", "polpo_custom_provider_remove", "polpo_provider_disconnect"] },
  channels: { read: ["polpo_channels_list"], write: ["polpo_channel_save", "polpo_channel_remove", "polpo_channel_test"] },
  rules: { read: ["polpo_channels_list", "polpo_config_get"], write: ["polpo_notification_rule_save", "polpo_notification_rule_delete"] },
  policies: { read: ["polpo_policies_get"], write: ["polpo_approval_gate_save", "polpo_approval_gate_delete", "polpo_policies_update"] },
  sandbox: { read: ["polpo_sandbox_get"], write: ["polpo_sandbox_update", "polpo_sandbox_provider_test"] },
  mcp: { read: ["polpo_mcp_access_list"], write: ["polpo_mcp_grant_revoke", "polpo_config_update"] },
  appearance: { read: ["polpo_branding_get"], write: ["polpo_branding_update"] },
  sync: { read: ["polpo_sync_status"], write: ["polpo_sync_update", "polpo_sync_run", "polpo_sync_test", "polpo_sync_disconnect"] },
};

beforeAll(async () => {
  process.env.POLPO_PUBLIC_URL = PUBLIC;
  process.env.POLPO_MCP_KEY = MCP_KEY;
  process.env.POLPO_MCP_TOOLSETS = "all";
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-mcp-config-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({
    project: "mcp-config", team: { name: "t", agents: [{ name: "agent-1", role: "Test agent" }] }, settings: { logLevel: "quiet" },
  }));
  const { Orchestrator } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");
  const orchestrator = new Orchestrator(tmpDir);
  await orchestrator.initInteractive("mcp-config", { name: "t", agents: [{ name: "agent-1", role: "Test agent" }] });
  app = createApp(orchestrator, new SSEBridge(orchestrator), { workDir: tmpDir });
}, 30_000);

afterAll(async () => {
  delete process.env.POLPO_PUBLIC_URL;
  delete process.env.POLPO_MCP_KEY;
  delete process.env.POLPO_MCP_TOOLSETS;
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

const request = (authorization: string, name: string, args: Record<string, unknown> = {}) => app.request("/mcp", {
  method: "POST",
  headers: { "x-forwarded-host": "polpo.example.com", "x-forwarded-proto": "https", "content-type": "application/json", accept: "application/json, text/event-stream", authorization },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool results are checked field by field
const tool = async (name: string, args: Record<string, unknown> = {}): Promise<any> => (await (await request(`Bearer ${MCP_KEY}`, name, args)).json()).result;
const text = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? "").join("");
const settingsFile = async () => (await (await app.request("/api/v1/config", { headers: { authorization: `Bearer ${MCP_KEY}` } })).json());

async function oauthToken(subject: string): Promise<string> {
  const { OAuthServer } = await import("../server/oauth.js");
  const oauth = new OAuthServer(join(tmpDir, ".polpo"));
  const client = oauth.register({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const code = oauth.issueCode({ client_id: client.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: challenge }, `${PUBLIC}/mcp`, subject);
  return oauth.exchange({ grant_type: "authorization_code", code, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: verifier }).access_token;
}

describe("every Configuration section through MCP", () => {
  it("has a read tool and, where editable, write tools, with the right scopes", async () => {
    const { toolScopeMatrix } = await import("../server/mcp.js");
    const m = Object.fromEntries(toolScopeMatrix().map((t) => [t.name, t]));
    for (const [section, { read, write }] of Object.entries(CONFIG_SECTION_TOOLS)) {
      expect(read.length, section).toBeGreaterThan(0);
      expect(write.length, section).toBeGreaterThan(0);
      for (const name of read) {
        expect(m[name], `${section}: ${name}`).toBeDefined();
        expect(m[name].readOnly, name).toBe(true);
      }
      for (const name of write) {
        expect(m[name], `${section}: ${name}`).toBeDefined();
        expect(m[name].readOnly, name).toBe(false);
        // configuration writes need admin (a channel test sends a message: messages)
        expect(m[name].scope, name).toBe(name === "polpo_channel_test" ? "polpo:messages" : "polpo:admin");
      }
    }
    // who has access to the instance is itself admin-only, reads too
    expect(m.polpo_members_list.scope).toBe("polpo:admin");
    expect(m.polpo_mcp_access_list.scope).toBe("polpo:admin");
    for (const name of ["polpo_members_remove", "polpo_mcp_grant_revoke", "polpo_channel_remove", "polpo_approval_gate_delete", "polpo_sync_run", "polpo_sync_disconnect", "polpo_custom_provider_remove", "polpo_provider_disconnect"]) {
      expect(m[name].destructive, name).toBe(true);
    }
  });

  it("refuses a configuration change to a connection without the admin scope", async () => {
    const token = await oauthToken("ada@example.com");
    for (const name of ["polpo_branding_update", "polpo_sandbox_update", "polpo_members_list"]) {
      const res = await request(`Bearer ${token}`, name, {});
      expect(res.status, name).toBe(403);
      expect((await res.json()).error.data.required_scope).toBe("polpo:admin");
    }
  });
});

describe("appearance and the dark-mode logo", () => {
  it("sets the instance's default look, says what changed, and serves it publicly", async () => {
    const r = await tool("polpo_branding_update", {
      theme: "light", palette: "claude",
      tokens: { light: { primary: "#c96442", background: "oklch(0.98 0.01 80)", fontFamily: "\"Inter\", sans-serif", radius: 12 }, dark: { primary: "hsl(20 70% 60%)" } },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.changed).toEqual(expect.arrayContaining([
      "appearance.theme", "appearance.palette", "appearance.custom.enabled", "appearance.custom.light.primary", "appearance.custom.light.radius", "appearance.custom.dark.primary",
    ]));
    expect(r.structuredContent.appearance).toEqual({
      theme: "light", palette: "claude",
      custom: { enabled: true, light: { primary: "#c96442", background: "oklch(0.98 0.01 80)", fontFamily: "\"Inter\", sans-serif", radius: 12 }, dark: { primary: "hsl(20 70% 60%)" } },
    });
    // public, before sign-in: the UI server inlines it into runtime-config.js
    const pub = await (await app.request("/api/v1/config/appearance")).json();
    expect(pub).toEqual({ ok: true, data: r.structuredContent.appearance });

    // merge: one token removed (null), another added; derive off
    const merged = await tool("polpo_branding_update", { tokens: { derive: false, light: { radius: null, ring: "#000000" } } });
    expect(merged.structuredContent.changed.sort()).toEqual(["appearance.custom.derive", "appearance.custom.light.radius", "appearance.custom.light.ring"]);
    expect(merged.structuredContent.appearance.custom).toMatchObject({ derive: false, light: { ring: "#000000" } });
    expect(merged.structuredContent.appearance.custom.light.radius).toBeUndefined();
    expect((await tool("polpo_branding_get")).structuredContent.appearance.palette).toBe("claude");
  });

  it("refuses invalid tokens, changing nothing", async () => {
    const before = (await tool("polpo_branding_get")).structuredContent.appearance;
    for (const tokens of [
      { light: { primary: "red; background: url(x)" } },
      { light: { fontFamily: "Inter; } body { display:none" } },
      { light: { shadowCard: "0 0 1px url(https://evil)" } },
    ]) {
      const r = await tool("polpo_branding_update", { tokens, product_name: "Should not change" });
      expect(r.isError, JSON.stringify(tokens)).toBe(true);
      expect(text(r)).toMatch(/Nothing was changed/);
    }
    expect(await tool("polpo_branding_update", { tokens: { light: { radius: 99 } } })).toMatchObject({ isError: true });
    expect((await tool("polpo_branding_get")).structuredContent).toMatchObject({ appearance: before });
    expect((await tool("polpo_branding_get")).structuredContent.productName).not.toBe("Should not change");
    // the REST route checks the same rules
    const bad = await app.request("/api/v1/config/settings", {
      method: "PATCH", headers: { authorization: `Bearer ${MCP_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ appearance: { palette: "nope" } }),
    });
    expect(bad.status).toBe(400);
  });

  it("uploads, serves and removes the dark-mode logo; reset_appearance drops the look", async () => {
    const up = await tool("polpo_branding_update", { logo_dark: { base64: PNG.toString("base64"), mime_type: "image/png" } });
    expect(up.structuredContent).toMatchObject({ changed: ["logo_dark"], branding: { logoDarkUrl: "/api/v1/config/branding/logo-dark" } });
    const served = await app.request("/api/v1/config/branding/logo-dark");
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await app.request("/api/v1/config/branding/logo")).status).toBe(404);
    expect((await tool("polpo_branding_get")).structuredContent.logo_dark_link).toBe(`${PUBLIC}/api/v1/config/branding/logo-dark`);
    const removed = await tool("polpo_branding_update", { logo_dark: null });
    expect(removed.structuredContent.changed).toEqual(["logo_dark"]);
    expect(removed.structuredContent.branding.logoDarkUrl).toBeUndefined();
    expect((await app.request("/api/v1/config/branding/logo-dark")).status).toBe(404);

    const reset = await tool("polpo_branding_update", { reset_appearance: true });
    expect(reset.structuredContent.appearance).toEqual({});
    expect((await (await app.request("/api/v1/config/appearance")).json()).data).toEqual({});
  });
});

describe("general settings", () => {
  it("changes them and says what changed; vault references must exist", async () => {
    const r = await tool("polpo_config_update", { general: { maxRetries: 5, logLevel: "verbose", voiceReplies: "voice", maxConcurrency: 4, emailAllowedDomains: ["example.com"] } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.changed.sort()).toEqual(["emailAllowedDomains", "logLevel", "maxConcurrency", "maxRetries", "voiceReplies"]);
    const s = (await tool("polpo_config_get")).structuredContent.settings;
    expect(s).toMatchObject({ maxRetries: 5, logLevel: "verbose", voiceReplies: "voice", maxConcurrency: 4 });
    expect((await tool("polpo_config_update", { general: { maxConcurrency: null } })).structuredContent.changed).toEqual(["maxConcurrency"]);
    expect(await tool("polpo_config_update", { general: { maxRetries: 500 } })).toMatchObject({ isError: true });
    const toolsets = await tool("polpo_config_update", { mcp: { toolsets: ["default", "nonsense"] } });
    expect(text(toolsets)).toMatch(/Unknown toolset nonsense/);
    const keys = await tool("polpo_config_update", { mcp: { keys: [{ name: "ci", key_ref: { owner: "agent-1", service: "missing" } }] } });
    expect(keys.isError).toBe(true);
    expect(text(keys)).toMatch(/No vault entry agent-1\/missing/);
    const compaction = await tool("polpo_config_update", { compaction: { thresholdPct: 0.7 }, connectors: { toolTimeoutMs: 30_000 } });
    expect(compaction.structuredContent.changed.sort()).toEqual(["compaction", "connectors"]);
  });
});

describe("policies", () => {
  it("saves and deletes approval gates, and the escalation policy and SLA", async () => {
    const saved = await tool("polpo_approval_gate_save", { id: "ship", name: "Ship check", handler: "human", hook: "task:complete", condition: "task.title.includes('deploy')", timeout_ms: 60_000, timeout_action: "reject" });
    expect(saved.structuredContent).toMatchObject({ created: true, gate: { id: "ship", condition: { expression: "task.title.includes('deploy')" } } });
    expect((await tool("polpo_approval_gate_save", { id: "ship", name: "Ship check 2", handler: "auto", hook: "task:complete" })).structuredContent.created).toBe(false);
    expect((await tool("polpo_policies_get")).structuredContent.gates).toEqual([expect.objectContaining({ id: "ship", name: "Ship check 2", handler: "auto" })]);
    expect(await tool("polpo_approval_gate_save", { id: "x", name: "x", handler: "human", hook: "task:complete", notify_channels: ["nope"] })).toMatchObject({ isError: true });
    expect((await tool("polpo_approval_gate_delete", { id: "ship" })).isError).toBe(true);
    expect((await tool("polpo_approval_gate_delete", { id: "ship", confirm: true })).structuredContent).toEqual({ id: "ship", deleted: true });

    expect(await tool("polpo_policies_update", { sla: { warningChannels: ["nope"] } })).toMatchObject({ isError: true });
    const p = await tool("polpo_policies_update", {
      escalation_policy: { name: "Default", levels: [{ level: 0, handler: "agent", target: "agent-1" }, { level: 1, handler: "orchestrator" }] },
      sla: { warningThreshold: 0.75, violationAction: "notify" },
    });
    expect(p.structuredContent.changed.sort()).toEqual(["escalationPolicy", "sla"]);
    const got = (await tool("polpo_policies_get")).structuredContent;
    expect(got.escalation_policy).toMatchObject({ name: "Default" });
    expect(got.sla).toMatchObject({ warningThreshold: 0.75 });
    expect((await tool("polpo_policies_update", { sla: null })).structuredContent.sla).toBeNull();
  });
});

describe("channels' setup without secrets", () => {
  it("creates a channel from its non-secret fields and names the secrets it still needs", async () => {
    const r = await tool("polpo_channel_save", { name: "ops", type: "telegram", chat_id: "-1001", gateway: { enableInbound: true, dmPolicy: "allowlist", allowFrom: ["42"] }, bot_token: "should-be-ignored" });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ created: true, needs_secrets: ["botToken"], setup_url: `${PUBLIC}/config?section=channels`, channel: { name: "ops", type: "telegram", chatId: "-1001" } });
    expect(JSON.stringify(r)).not.toContain("should-be-ignored");
  });

  it("keeps a secret set in the dashboard and never returns it", async () => {
    // the person sets the token in the dashboard
    const put = await app.request("/api/v1/config/channels/ops", {
      method: "PUT", headers: { authorization: `Bearer ${MCP_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "telegram", chatId: "-1001", botToken: "123456:SECRET-TOKEN-VALUE" }),
    });
    expect(put.status).toBe(200);
    const r = await tool("polpo_channel_save", { name: "ops", chat_id: "-1002" });
    expect(r.structuredContent).toMatchObject({ created: false, needs_secrets: [], channel: { chatId: "-1002", secrets_set: ["botToken"] } });
    for (const res of [r, await tool("polpo_channels_list"), await tool("polpo_config_get")]) expect(JSON.stringify(res)).not.toContain("SECRET-TOKEN-VALUE");
    // the stored token is still the real one
    const { loadPolpoConfig } = await import("../core/config.js");
    expect(loadPolpoConfig(join(tmpDir, ".polpo"))?.settings.notifications?.channels?.ops).toMatchObject({ chatId: "-1002", botToken: "123456:SECRET-TOKEN-VALUE" });
  });

  it("removes a channel only with confirm", async () => {
    expect((await tool("polpo_channel_remove", { name: "ops" })).isError).toBe(true);
    expect((await tool("polpo_channel_remove", { name: "ops", confirm: true })).structuredContent).toMatchObject({ name: "ops", removed: true });
    expect(await tool("polpo_channel_save", { name: "nobody" })).toMatchObject({ isError: true });
  });
});

describe("sandbox", () => {
  it("merges settings and provider options, a key only as a vault reference", async () => {
    const r = await tool("polpo_sandbox_update", {
      network: { mode: "allowlist", allow: ["example.com"] }, chat_idle_minutes: 30, isolation: "fresh",
      providers: { daytona: { api: "v2", region: "eu", credential: { owner: "agent-1", service: "daytona" } } },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.changed).toEqual(expect.arrayContaining(["network", "chatIdleMinutes", "isolation", "providers.daytona"]));
    expect(r.structuredContent.settings).toMatchObject({ network: { mode: "allowlist", allow: ["example.com"] }, providers: { daytona: { api: "v2", region: "eu" } } });
    const more = await tool("polpo_sandbox_update", { providers: { daytona: { image: "polpo-runner:1" } }, isolation: null });
    expect(more.structuredContent.settings.providers.daytona).toMatchObject({ api: "v2", region: "eu", image: "polpo-runner:1" });
    expect(more.structuredContent.settings.isolation).toBeUndefined();
    // v2 takes no API URL: refused, nothing saved
    expect(await tool("polpo_sandbox_update", { providers: { daytona: { apiUrl: "https://daytona.example.com" } } })).toMatchObject({ isError: true });
    expect((await tool("polpo_sandbox_get")).structuredContent.settings.providers.daytona.apiUrl).toBeUndefined();
  });
});

describe("members, MCP access, cloud sync, providers", () => {
  it("lists, adds and removes members (removing needs confirm)", async () => {
    const list = await tool("polpo_members_list");
    expect(list.isError).toBeFalsy();
    const add = await tool("polpo_members_invite", { email: "ada@example.com", send_invite: false });
    expect(add.structuredContent.members).toEqual(expect.arrayContaining([{ email: "ada@example.com" }]));
    await tool("polpo_members_invite", { email: "bob@example.com", send_invite: false });
    expect((await tool("polpo_members_remove", { email: "bob@example.com" })).isError).toBe(true);
    const removed = await tool("polpo_members_remove", { email: "bob@example.com", confirm: true });
    expect(removed.structuredContent).toMatchObject({ removed: true });
    expect(removed.structuredContent.members).not.toContainEqual({ email: "bob@example.com" });
  });

  it("lists MCP grants and keys without values, and revokes a grant", async () => {
    await oauthToken("grace@example.com");
    const list = await tool("polpo_mcp_access_list");
    const grant = list.structuredContent.grants.find((g: { subject?: string }) => g.subject === "grace@example.com");
    expect(grant).toBeDefined();
    expect(JSON.stringify(list)).not.toContain(MCP_KEY);
    expect(await tool("polpo_mcp_grant_revoke", { id: "nope", confirm: true })).toMatchObject({ isError: true });
    expect((await tool("polpo_mcp_grant_revoke", { id: grant.id, confirm: true })).structuredContent).toEqual({ id: grant.id, revoked: true });
  });

  it("cloud sync: status without keys, settings need a bucket first, runs need confirm", async () => {
    const s = await tool("polpo_sync_status");
    expect(s.structuredContent.sync.configured).toBe(false);
    expect(s.structuredContent.setup_url).toBe(`${PUBLIC}/config?section=sync`);
    expect(text(await tool("polpo_sync_update", { bucket: "b" }))).toMatch(/not set up/);
    const ex = await tool("polpo_sync_update", { excludes: ["node_modules/**"], schedule: { enabled: false, cron: "0 3 * * *" } });
    expect(ex.structuredContent.changed.sort()).toEqual(["excludes", "schedule"]);
    expect(text(await tool("polpo_sync_run", { direction: "push" }))).toMatch(/confirm: true/);
    expect(await tool("polpo_sync_run", { direction: "push", confirm: true })).toMatchObject({ isError: true });
    // with keys set in the dashboard: they never come back, the bucket can change
    const { writeSyncConfig } = await import("../server/sync-config-store.js");
    writeSyncConfig(join(tmpDir, ".polpo"), { r2: { endpoint: "https://acct.r2.cloudflarestorage.com", accessKeyId: "AKID-VISIBLE-NOWHERE", secretAccessKey: "R2-SECRET-VALUE-123456", bucket: "a" } });
    const moved = await tool("polpo_sync_update", { bucket: "b", prefix: "polpo" });
    expect(moved.structuredContent.sync.r2).toEqual({ endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "b", prefix: "polpo", has_credentials: true });
    for (const res of [moved, await tool("polpo_sync_status")]) {
      expect(JSON.stringify(res)).not.toContain("R2-SECRET");
      expect(JSON.stringify(res)).not.toContain("AKID-VISIBLE-NOWHERE");
    }
    const { readSyncConfig } = await import("../server/sync-config-store.js");
    expect(readSyncConfig(join(tmpDir, ".polpo")).r2).toMatchObject({ secretAccessKey: "R2-SECRET-VALUE-123456", bucket: "b" });
    expect((await tool("polpo_sync_disconnect")).isError).toBe(true);
    expect((await tool("polpo_sync_disconnect", { confirm: true })).structuredContent).toEqual({ disconnected: true });
  });

  it("custom providers: saves a definition without keys, refuses secret fields, removes with confirm", async () => {
    const bad = await tool("polpo_custom_provider_save", { id: "gw", provider: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-nope" } });
    expect(text(bad)).toMatch(/cannot be sent/);
    const made = await tool("polpo_custom_provider_save", { id: "gw", provider: { baseUrl: "http://127.0.0.1:9/v1", allowPrivateNetwork: true, models: [{ id: "m1" }] } });
    expect(made.isError, text(made)).toBeFalsy();
    expect(made.structuredContent).toMatchObject({ id: "gw", created: true, needs_key: true });
    const renamed = await tool("polpo_custom_provider_save", { id: "gw", provider: { label: "Gateway" } });
    expect(renamed.structuredContent).toMatchObject({ created: false, provider: { label: "Gateway", baseUrl: expect.stringContaining("127.0.0.1"), models: [expect.objectContaining({ id: "m1" })] } });
    expect((await tool("polpo_custom_providers_list")).structuredContent.items).toEqual([expect.objectContaining({ id: "gw" })]);
    expect((await tool("polpo_custom_provider_remove", { id: "gw" })).isError).toBe(true);
    expect((await tool("polpo_custom_provider_remove", { id: "gw", confirm: true })).structuredContent).toMatchObject({ id: "gw", removed: true });
    expect((await tool("polpo_provider_disconnect", { name: "openai" })).isError).toBe(true);
    expect(JSON.stringify(await settingsFile())).not.toContain("sk-nope");
  });
});
