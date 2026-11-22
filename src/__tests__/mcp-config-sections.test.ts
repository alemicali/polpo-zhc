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
/** The dashboard on its own origin (the UI server): setup links point there. */
const DASHBOARD = "https://dash.example.com:5174";
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
  process.env.POLPO_DASHBOARD_URL = DASHBOARD;
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
  delete process.env.POLPO_DASHBOARD_URL;
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
    const { toolScopeMatrix, TOOLSETS, resolveToolsets } = await import("../server/mcp.js");
    // on by default: every section is reachable without configuring toolsets
    expect(TOOLSETS.settings.default).toBe(true);
    expect(resolveToolsets()).toContain("settings");
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

  it("takes the bundled Inter Tight as a font token", async () => {
    const r = await tool("polpo_branding_update", { tokens: { light: { fontFamily: "\"Inter Tight\", sans-serif", headingFont: "Inter Tight" } } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.appearance.custom.light).toMatchObject({ fontFamily: "\"Inter Tight\", sans-serif", headingFont: "Inter Tight" });
    expect((await tool("polpo_branding_update", { reset_appearance: true })).isError).toBeFalsy();
  });

  it("frames the logo in a box or shows it bare (logo_frame), publicly; the REST route checks the value", async () => {
    expect((await tool("polpo_branding_get")).structuredContent.logoFrame).toBeUndefined(); // default: box
    const bare = await tool("polpo_branding_update", { logo_frame: "none" });
    expect(bare.isError).toBeFalsy();
    expect(bare.structuredContent).toMatchObject({ changed: ["logo_frame"], branding: { logoFrame: "none" } });
    expect((await tool("polpo_branding_get")).structuredContent.logoFrame).toBe("none");
    expect(text(await tool("polpo_branding_get"))).toContain("frame: none");
    // public, before sign-in (runtime-config.js, the sign-in page): only the display fields
    expect((await (await app.request("/api/v1/config/branding")).json()).data).toMatchObject({ logoFrame: "none" });
    expect((await tool("polpo_branding_update", { logo_frame: "none" })).structuredContent.changed).toEqual([]);
    // an invalid value never reaches the config
    expect(await tool("polpo_branding_update", { logo_frame: "circle" })).toMatchObject({ isError: true });
    const bad = await app.request("/api/v1/config/settings", {
      method: "PATCH", headers: { authorization: `Bearer ${MCP_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ branding: { logoFrame: "circle" } }),
    });
    expect(bad.status).toBe(400);
    const viaRest = await app.request("/api/v1/config/settings", {
      method: "PATCH", headers: { authorization: `Bearer ${MCP_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ branding: { logoFrame: "box" } }),
    });
    expect(viaRest.status).toBe(200);
    expect((await tool("polpo_branding_get")).structuredContent.logoFrame).toBe("box");
    const reset = await tool("polpo_branding_update", { logo_frame: null });
    expect(reset.structuredContent.changed).toEqual(["logo_frame"]);
    expect(reset.structuredContent.branding.logoFrame).toBeUndefined();
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
    expect(text(keys)).toMatch(/no vault entry agent-1\/missing/);
    const compaction = await tool("polpo_config_update", { compaction: { thresholdPct: 0.7 }, connectors: { toolTimeoutMs: 30_000 } });
    expect(compaction.structuredContent.changed.sort()).toEqual(["compaction", "connectors"]);
  });
});

describe("the orchestrator's name", () => {
  const patch = (body: unknown) => app.request("/api/v1/config/settings", {
    method: "PATCH", headers: { authorization: `Bearer ${MCP_KEY}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const publicName = async () => (await (await app.request("/api/v1/config/orchestrator")).json()).data.name;

  it("is Polpo by default, set and validated through PATCH /config/settings, public for the first paint", async () => {
    expect(await publicName()).toBe("Polpo");
    const get = await tool("polpo_config_get");
    expect(get.structuredContent.settings.orchestratorName).toBe("Polpo");
    expect(text(get)).toContain("orchestrator name: Polpo (default)");

    expect((await patch({ orchestratorName: "x".repeat(41) })).status).toBe(400);
    expect((await patch({ orchestratorName: "two\nlines" })).status).toBe(400);
    const saved = await patch({ orchestratorName: "  Ada  " });
    expect(saved.status).toBe(200);
    expect((await settingsFile()).data.settings.orchestratorName).toBe("Ada");
    expect(await publicName()).toBe("Ada");
    // the branding never renames the orchestrator
    expect((await patch({ branding: { productName: "Lumea" } })).status).toBe(200);
    expect(await publicName()).toBe("Ada");
    expect((await patch({ orchestratorName: null })).status).toBe(200);
    expect((await settingsFile()).data.settings.orchestratorName).toBeUndefined();
    expect(await publicName()).toBe("Polpo");
    expect((await patch({ branding: { productName: "" } })).status).toBe(200);
  });

  it("is changed with polpo_config_update (admin) and read back with polpo_config_get", async () => {
    const r = await tool("polpo_config_update", { orchestrator_name: "Ada" });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.changed).toEqual(["orchestratorName"]);
    expect((await tool("polpo_config_get")).structuredContent.settings.orchestratorName).toBe("Ada");
    expect(await tool("polpo_config_update", { orchestrator_name: "x".repeat(41) })).toMatchObject({ isError: true });
    const reset = await tool("polpo_config_update", { orchestrator_name: null });
    expect(reset.structuredContent.changed).toEqual(["orchestratorName"]);
    expect((await tool("polpo_config_get")).structuredContent.settings.orchestratorName).toBe("Polpo");
    const { toolScopeMatrix } = await import("../server/mcp.js");
    expect(toolScopeMatrix().find((t) => t.name === "polpo_config_update")?.scope).toBe("polpo:admin");
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

  it("answers 400, not 500, when a rule's or gate's id in the body is not the URL's", async () => {
    const put = (path: string, body: unknown) => app.request(`/api/v1/config/${path}`, {
      method: "PUT", headers: { authorization: `Bearer ${MCP_KEY}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const rule = await put("rules/r1", { id: "other", events: ["task:failed"], channels: ["x"] });
    expect(rule.status).toBe(400);
    expect((await rule.json()).error).toMatch(/must match/);
    const gate = await put("gates/g1", { id: "other", name: "G", handler: "auto", hook: "task:complete" });
    expect(gate.status).toBe(400);
  });
});

describe("channels' setup without secrets", () => {
  it("creates a channel from its non-secret fields and names the secrets it still needs", async () => {
    const r = await tool("polpo_channel_save", { name: "ops", type: "telegram", chat_id: "-1001", gateway: { enableInbound: true, dmPolicy: "allowlist", allowFrom: ["42"] }, bot_token: "should-be-ignored" });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      created: true, needs_secrets: ["botToken"], channel: { name: "ops", type: "telegram", chatId: "-1001" },
      setup_url: `${DASHBOARD}/config?section=channels&channel=ops&focus=botToken&setup=channel%3Aops%3AbotToken`,
      setup_id: "channel:ops:botToken", next_step: expect.stringContaining("polpo_setup_wait"),
    });
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

/**
 * Configuration → Channels, action by action (ui/src/pages/config.tsx ChannelsTab and
 * components/config/telegram-connect.tsx) → the MCP tool that does it.
 */
export const CHANNEL_UI_ACTIONS: Record<string, string> = {
  "list channels and WhatsApp profiles": "polpo_channels_list",
  "create or edit a channel (fields)": "polpo_channel_save",
  "enter a bot token, API key, webhook URL, secret headers (the dashboard link, then wait)": "polpo_setup_wait",
  "inbound gateway: DM policy, allow from, sessions": "polpo_channel_save",
  "dedicated agent, reply through another channel, group replies, per-agent sessions": "polpo_channel_route_set",
  "see who answers where": "polpo_channel_routes_list",
  "delete a channel": "polpo_channel_remove",
  "test a channel": "polpo_channel_test",
  "check a Telegram bot token": "polpo_telegram_verify",
  "connect a chat to the bot (Connect my Telegram)": "polpo_channel_invite",
  "Connect my Telegram (invite link) and its status": "polpo_channel_invite",
  "peers, allowlist and pending pairings": "polpo_channel_peers",
  "allow or remove a peer": "polpo_channel_allowlist",
  "approve or reject a pairing": "polpo_channel_pairing",
  "WhatsApp: show the QR code, cancel": "polpo_whatsapp_login",
  "WhatsApp: wait for the scan": "polpo_whatsapp_login_wait",
  "WhatsApp: sign out": "polpo_whatsapp_logout",
  "notification rules": "polpo_notification_rule_save",
  "delete a rule": "polpo_notification_rule_delete",
};

describe("channels end to end", () => {
  it("has a tool for every Channels action, on by default, changes and people-naming reads admin-only", async () => {
    const { toolScopeMatrix, resolveToolsets } = await import("../server/mcp.js");
    const m = Object.fromEntries(toolScopeMatrix().filter((t) => resolveToolsets().includes(t.toolset)).map((t) => [t.name, t]));
    for (const [action, name] of Object.entries(CHANNEL_UI_ACTIONS)) {
      expect(m[name], `${action}: ${name}`).toBeDefined();
      if (!m[name].readOnly) expect(m[name].scope, name).toBe(name === "polpo_channel_test" ? "polpo:messages" : "polpo:admin");
    }
    for (const name of ["polpo_channel_peers", "polpo_whatsapp_login_wait"]) expect(m[name].scope).toBe("polpo:admin");
  });

  it("takes no secrets: hands off to the dashboard, waits for the person, never reads the value", async () => {
    const TOKEN = "987654:SECRET-ENTERED-IN-DASHBOARD";
    // secret fields are not parameters: dropped, nothing stored
    const tg = await tool("polpo_channel_save", { name: "tg", type: "telegram", chat_id: "-100", secrets: { bot_token: "typed-in-chat" }, botToken: "typed-in-chat" });
    expect(tg.isError, text(tg)).toBeFalsy();
    expect(tg.structuredContent).toMatchObject({ needs_secrets: ["botToken"], setup_id: "channel:tg:botToken" });
    expect(text(tg)).toContain(`${DASHBOARD}/config?section=channels&channel=tg&focus=botToken`);
    const { loadPolpoConfig } = await import("../core/config.js");
    expect(JSON.stringify(loadPolpoConfig(join(tmpDir, ".polpo")))).not.toContain("typed-in-chat");

    // pending until the person saves it
    const pending = await tool("polpo_setup_wait", { setup_id: "channel:tg:botToken", timeout_seconds: 0 });
    expect(pending.structuredContent).toEqual({ status: "pending", items: [{ setup_id: "channel:tg:botToken", done: false }], timed_out: true });
    // the person saves it in the dashboard while the assistant waits
    const waiting = tool("polpo_setup_wait", { setup_ids: ["channel:tg:botToken"], timeout_seconds: 10 });
    await new Promise((r) => setTimeout(r, 300));
    const saved = await app.request("/api/v1/config/channels/tg", {
      method: "PUT", headers: { authorization: `Bearer ${MCP_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "telegram", chatId: "-100", botToken: TOKEN }),
    });
    expect(saved.status).toBe(200);
    const done = await waiting;
    expect(done.structuredContent).toEqual({ status: "done", items: [{ setup_id: "channel:tg:botToken", done: true }], timed_out: false });
    for (const res of [done, await tool("polpo_channel_save", { name: "tg", chat_id: "-200" }), await tool("polpo_channels_list")]) expect(JSON.stringify(res)).not.toContain(TOKEN);
    expect(loadPolpoConfig(join(tmpDir, ".polpo"))?.settings.notifications?.channels?.tg).toMatchObject({ botToken: TOKEN, chatId: "-200" });

    // a webhook channel for the routes below; bad ids are refused
    await tool("polpo_channel_save", { name: "hook", type: "webhook" });
    await app.request("/api/v1/config/channels/hook", {
      method: "PUT", headers: { authorization: `Bearer ${MCP_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "webhook", url: "https://hooks.example.com/abc", headers: { "x-token": "hdr-WRITE-ONLY-VALUE" } }),
    });
    expect(await tool("polpo_setup_wait", { setup_id: "nonsense" })).toMatchObject({ isError: true });
    expect(await tool("polpo_setup_wait", {})).toMatchObject({ isError: true });
  });

  it("builds setup links and ids for every kind of secret", async () => {
    const { setupHandoff, setupPath, parseSetupId } = await import("../server/mcp-server/setup.js");
    const deps = { api: async () => ({ status: 503, body: null, headers: new Headers() }), version: "x" };
    expect(setupPath({ kind: "provider", item: "openai" })).toBe("/config?section=providers&provider=openai&focus=apiKey&setup=provider%3Aopenai");
    expect(setupPath({ kind: "sandbox", item: "daytona", field: "credential" })).toBe("/config?section=sandbox&provider=daytona&focus=credential&setup=sandbox%3Adaytona%3Acredential");
    expect(setupPath({ kind: "sync", item: "r2", field: "secretAccessKey" })).toBe("/config?section=sync&focus=secretAccessKey&setup=sync%3Ar2%3AsecretAccessKey");
    expect(setupPath({ kind: "vault", item: "agent-1", field: "gmail" })).toBe("/agents/agent-1?tab=credentials&service=gmail&setup=vault%3Aagent-1%3Agmail");
    expect(setupPath({ kind: "connector", item: "linear", field: "bearerToken" })).toBe("/connectors?connector=linear&focus=bearerToken&setup=connector%3Alinear%3AbearerToken");
    expect(parseSetupId("channel:ops:webhookUrl|apiKey")).toEqual({ kind: "channel", item: "ops", field: "webhookUrl|apiKey" });
    expect(parseSetupId("nope:x")).toBeNull();
    // absolute with the dashboard's URL; else the API's origin; else relative, with a note
    expect(setupHandoff({ ...deps, dashboardUrl: "https://ui.example.com/", publicUrl: PUBLIC }, { kind: "sync" }, "R2 keys").setup_url).toMatch(/^https:\/\/ui\.example\.com\/config\?section=sync/);
    expect(setupHandoff({ ...deps, publicUrl: PUBLIC }, { kind: "sync" }, "R2 keys").setup_url).toMatch(/^https:\/\/polpo\.example\.com\/config/);
    const rel = setupHandoff(deps, { kind: "provider", item: "openai" }, "OpenAI key");
    expect(rel.setup_url.startsWith("/config")).toBe(true);
    expect(rel.next_step).toContain("POLPO_DASHBOARD_URL");
    // the other areas hand off too, with what to wait for
    const sync = await tool("polpo_sync_status");
    expect(sync.structuredContent).toMatchObject({ setup_id: "sync:r2:secretAccessKey", setup_url: expect.stringContaining(`${DASHBOARD}/config?section=sync`) });
    const providers = await tool("polpo_providers_list", { configured: false });
    expect(providers.structuredContent.items[0]).toMatchObject({ setup_id: expect.stringMatching(/^provider:/), setup_url: expect.stringContaining("focus=apiKey") });
    expect((await tool("polpo_setup_wait", { setup_id: "sync:r2:secretAccessKey", timeout_seconds: 0 })).structuredContent.status).toBe("pending");
  });

  it("routes: who answers on a channel, merged, with checks", async () => {
    expect(await tool("polpo_channel_route_set", { channel: "nope", agent: "agent-1" })).toMatchObject({ isError: true });
    expect(await tool("polpo_channel_route_set", { channel: "hook", agent: "ghost" })).toMatchObject({ isError: true });
    const set = await tool("polpo_channel_route_set", { channel: "hook", inbound: false, agent: "agent-1", reply_to: { channel: "tg" }, group_replies: "mentions", agent_sessions: { "agent-1": { sessionMode: "shared" } } });
    expect(set.isError, text(set)).toBeFalsy();
    expect(set.structuredContent.route).toMatchObject({ channel: "hook", inbound: false, agent: "agent-1", reply_to: { channel: "tg" }, agent_sessions: { "agent-1": { sessionMode: "shared" } } });
    const list = (await tool("polpo_channel_routes_list")).structuredContent.routes;
    expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ channel: "hook", agent: "agent-1" })]));
    const back = await tool("polpo_channel_route_set", { channel: "hook", inbound: false, agent: null, agent_sessions: { "agent-1": null } });
    expect(back.structuredContent.route.agent).toBeNull();
    expect(back.structuredContent.route.agent_sessions).toBeUndefined();
    // the secrets survived the route changes
    const { loadPolpoConfig } = await import("../core/config.js");
    expect(loadPolpoConfig(join(tmpDir, ".polpo"))?.settings.notifications?.channels?.hook).toMatchObject({ headers: { "x-token": "hdr-WRITE-ONLY-VALUE" } });
  });

  it("guards Telegram and WhatsApp actions", async () => {
    expect(await tool("polpo_telegram_verify", {})).toMatchObject({ isError: true });
    expect(text(await tool("polpo_channel_allowlist", { action: "remove", peer_id: "telegram:1" }))).toMatch(/confirm: true/);
    expect(await tool("polpo_channel_pairing", { code: "NOPE", approve: true })).toMatchObject({ isError: true });
    expect(text(await tool("polpo_whatsapp_logout", {}))).toMatch(/confirm: true/);
    expect(await tool("polpo_whatsapp_login", { cancel: true })).toMatchObject({ isError: true });
    expect(text(await tool("polpo_whatsapp_login_wait", { session_id: "nope", timeout_seconds: 1 }))).toMatch(/No WhatsApp login/);
  });

  it("shows the WhatsApp QR code as an image to scan", async () => {
    const { loginResult } = await import("../server/mcp-server/channel-setup.js");
    const r = await loginResult({ id: "s1", profileDir: "default", status: "qr", qr: "2@abc,def,ghi" }, "scan it");
    expect(r.content[0]).toMatchObject({ type: "text", text: "scan it" });
    expect(r.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(Buffer.from((r.content[1] as { data: string }).data, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(r.structuredContent).toMatchObject({ session_id: "s1", status: "qr", has_qr: true });
    expect((await loginResult({ id: "s1", profileDir: "default", status: "connected" }, "ok")).content).toHaveLength(1);
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
    expect(s.structuredContent.setup_url).toBe(`${DASHBOARD}/config?section=sync&focus=secretAccessKey&setup=sync%3Ar2%3AsecretAccessKey`);
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
