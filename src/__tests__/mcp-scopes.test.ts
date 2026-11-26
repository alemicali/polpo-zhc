/**
 * Per-area scopes for Polpo's MCP connector: the scope model and its tool matrix, tools/list per
 * scope, the 403 step-up for a missing scope, OAuth consent and tokens with scopes, grants, and
 * MCP keys with their scopes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ALL_SCOPES, DEFAULT_SCOPES, handleMcpRequest, hasScope, normalizeScopes, scopeMatrixMarkdown, stepUpScopes, toolScopeMatrix,
  type McpDeps, type McpPrincipal,
} from "../server/mcp.js";
import {
  authorizationServerMetadata, consentPage, consentScopes, OAuthServer, protectedResourceMetadata,
} from "../server/oauth.js";
import { McpKeyRing, parseMcpKeyConfigs } from "../server/mcp-keys.js";

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); });
const RESOURCE = "https://polpo.example.com/mcp";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

function oauthServer() {
  const dir = mkdtempSync(join(tmpdir(), "polpo-scopes-"));
  dirs.push(dir);
  return { oauth: new OAuthServer(dir), dir };
}
function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
/** Allow a client with these scopes (undefined: what it asked for) and exchange the code. */
function allow(oauth: OAuthServer, clientId: string, opts: { asked?: string; granted?: string[]; subject?: string } = {}) {
  const { verifier, challenge } = pkce();
  const q = { client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, ...(opts.asked ? { scope: opts.asked } : {}) };
  const code = oauth.issueCode(q, RESOURCE, opts.subject ?? "ada@example.com", opts.granted);
  return oauth.exchange({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier });
}

const principal = (scopes: string[], kind: McpPrincipal["kind"] = "oauth"): McpPrincipal => ({ kind, actor: "ada@example.com via Claude", scopes });
const api: McpDeps["api"] = async () => ({ status: 200, body: { ok: true, data: [] }, headers: new Headers() });
const rpc = (deps: McpDeps, method: string, params: Record<string, unknown> = {}, id: number | string = 7) => handleMcpRequest(new Request("http://localhost/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
  body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
}), deps);
const toolNames = async (scopes: string[], toolsets: string[] = ["all"]) =>
  ((await (await rpc({ api, version: "x", toolsets, principal: principal(scopes) }, "tools/list")).json()).result.tools as Array<{ name: string }>).map((t) => t.name);

describe("the scope model", () => {
  it("normalizes scopes: known ones in order, read added, the old umbrella is every scope", () => {
    expect(normalizeScopes("polpo:work")).toEqual(["polpo:read", "polpo:work"]);
    expect(normalizeScopes("polpo:files,polpo:work bogus")).toEqual(["polpo:read", "polpo:work", "polpo:files"]);
    expect(normalizeScopes("polpo")).toEqual(ALL_SCOPES);
    expect(normalizeScopes("")).toEqual([]);
    expect(normalizeScopes(["offline_access"])).toEqual([]);
    expect(ALL_SCOPES.length).toBeLessThanOrEqual(8);
    expect(DEFAULT_SCOPES).toEqual(["polpo:read", "polpo:work"]);
  });

  it("admin and the umbrella hold everything; an area holds read but not work; work holds no area", () => {
    for (const scope of ALL_SCOPES) {
      expect(hasScope({ scopes: ["polpo:admin"] }, scope)).toBe(true);
      expect(hasScope({ scopes: ["polpo"] }, scope)).toBe(true);
    }
    expect(hasScope({ scopes: ["polpo:files"] }, "polpo:read")).toBe(true);
    expect(hasScope({ scopes: ["polpo:files"] }, "polpo:work")).toBe(false);
    expect(hasScope({ scopes: ["polpo:read", "polpo:work"] }, "polpo:files")).toBe(false);
    expect(hasScope({ scopes: ["polpo:read", "polpo:work"] }, "polpo:admin")).toBe(false);
    expect(hasScope({ scopes: [] }, "polpo:read")).toBe(false);
  });

  it("every tool has one scope; reads need read, destructive tools the write scope of their area", () => {
    const m = toolScopeMatrix();
    expect(new Set(m.map((t) => t.name)).size).toBe(m.length);
    const by = Object.fromEntries(m.map((t) => [t.name, t.scope]));
    for (const t of m) {
      if (t.destructive) expect(t.scope, t.name).not.toBe("polpo:read");
      // reads need read, except the vault's, the REST fallback, and the lists that name people and their access (admin)
      const adminReads = ["polpo_members_list", "polpo_mcp_access_list", "polpo_channel_peers", "polpo_peer_presence", "polpo_whatsapp_login_wait"];
      if (t.readOnly && t.toolset !== "vault" && t.toolset !== "admin") expect(t.scope, t.name).toBe(adminReads.includes(t.name) ? "polpo:admin" : "polpo:read");
    }
    expect(by).toMatchObject({
      polpo_file_read: "polpo:read", polpo_file_write: "polpo:files", polpo_file_manage: "polpo:files",
      polpo_message_send: "polpo:messages", polpo_channel_test: "polpo:messages", polpo_notification_rule_save: "polpo:admin",
      polpo_connector_add: "polpo:connectors", polpo_connector_remove: "polpo:connectors", polpo_connectors_list: "polpo:read",
      polpo_computer_save: "polpo:computers", polpo_computer_delete: "polpo:computers", polpo_computers_list: "polpo:read",
      polpo_vault_list: "polpo:vault", polpo_vault_delete: "polpo:vault",
      polpo_task_create: "polpo:work", polpo_ask: "polpo:work", polpo_agent_create: "polpo:admin", polpo_api_get: "polpo:admin",
      polpo_agent_show: "polpo:read", agent_intention_decide: "polpo:work",
    });
  });

  it("docs/mcp.md carries the matrix generated from the code", () => {
    const doc = readFileSync(join(__dirname, "../../docs/mcp.md"), "utf-8");
    expect(doc, "run: ./node_modules/.bin/tsc && node scripts/generate-mcp-scopes.mjs").toContain(scopeMatrixMarkdown());
  });
});

describe("tools/list per scope", () => {
  it("offers only the tools the scopes allow", async () => {
    const read = await toolNames(["polpo:read"]);
    expect(read).toContain("polpo_file_read");
    expect(read).not.toContain("polpo_task_create");
    expect(read).not.toContain("polpo_vault_list");

    const work = await toolNames(["polpo:read", "polpo:work"]);
    expect(work).toContain("polpo_task_create");
    for (const n of ["polpo_file_write", "polpo_message_send", "polpo_connector_add", "polpo_computer_save", "polpo_vault_list", "polpo_agent_create"]) expect(work).not.toContain(n);

    // Configuration sections: reads offered, changes and the lists of people only with admin
    for (const n of ["polpo_sandbox_get", "polpo_policies_get", "polpo_sync_status", "polpo_custom_providers_list"]) expect(work).toContain(n);
    for (const n of ["polpo_sandbox_update", "polpo_channel_save", "polpo_approval_gate_save", "polpo_sync_run", "polpo_members_list", "polpo_mcp_access_list", "polpo_mcp_grant_revoke"]) {
      expect(work).not.toContain(n);
    }

    const files = await toolNames(["polpo:read", "polpo:work", "polpo:files"]);
    expect(files).toEqual(expect.arrayContaining(["polpo_file_write", "polpo_file_manage", "polpo_task_create"]));
    expect(files).not.toContain("polpo_agent_create");

    // an area alone: its tools and the reads, no work
    const vault = await toolNames(["polpo:vault"]);
    expect(vault).toEqual(expect.arrayContaining(["polpo_vault_list", "polpo_vault_delete", "polpo_tasks_list"]));
    expect(vault).not.toContain("polpo_task_create");

    const admin = await toolNames(["polpo:admin"]);
    const legacy = await toolNames(["polpo"]);
    expect(admin.length).toBe(toolScopeMatrix().length);
    expect(legacy).toEqual(admin);
  });
});

describe("step-up: a call without the scope", () => {
  const deps = (scopes: string[], kind: McpPrincipal["kind"] = "oauth"): McpDeps => ({
    api, version: "x", toolsets: ["all"], principal: principal(scopes, kind), resourceMetadataUrl: "https://polpo.example.com/.well-known/oauth-protected-resource/mcp",
  });

  it("is a 403 with WWW-Authenticate insufficient_scope (what it holds plus what it needs) and a JSON-RPC error", async () => {
    const res = await rpc(deps(["polpo:read", "polpo:work"]), "tools/call", { name: "polpo_file_write", arguments: { path: "a.txt", content: "x" } }, "call-1");
    expect(res.status).toBe(403);
    const header = res.headers.get("www-authenticate")!;
    expect(header).toMatch(/^Bearer error="insufficient_scope", scope="polpo:read polpo:work polpo:files", resource_metadata="https:\/\/polpo\.example\.com\/\.well-known\/oauth-protected-resource\/mcp", error_description="/);
    const body = await res.json();
    expect(body).toMatchObject({ jsonrpc: "2.0", id: "call-1", error: { code: -32003, data: { error: "insufficient_scope", required_scope: "polpo:files", scope: "polpo:read polpo:work polpo:files" } } });
    expect(body.error.message).toMatch(/polpo_file_write needs the polpo:files scope.*Reconnect the connector/);
  });

  it("tells a key what to change; asks a read-only token for read and the missing scope", async () => {
    const res = await rpc(deps(["polpo:read"], "key"), "tools/call", { name: "polpo_agent_create", arguments: {} });
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toMatch(/POLPO_MCP_KEY_SCOPES|settings\.mcp\.keys/);
    expect(stepUpScopes(principal(["polpo:read"]), "polpo:admin")).toEqual(["polpo:read", "polpo:admin"]);
  });

  it("lets allowed calls through, and leaves unknown tools and toolsets that are off to the server", async () => {
    const allowed = await rpc(deps(["polpo:read", "polpo:work", "polpo:files"]), "tools/call", { name: "polpo_files_list", arguments: {} });
    expect(allowed.status).toBe(200);
    const unknown = await rpc(deps(["polpo:read"]), "tools/call", { name: "nope", arguments: {} });
    expect(unknown.status).toBe(200);
    const off = await rpc({ ...deps(["polpo:read"]), toolsets: ["core"] }, "tools/call", { name: "polpo_file_write", arguments: {} });
    expect(off.status).toBe(200);
    // the old umbrella still calls anything
    expect((await rpc(deps(["polpo"]), "tools/call", { name: "polpo_vault_list", arguments: {} })).status).toBe(200);
  });
});

describe("OAuth with scopes", () => {
  it("publishes the scopes in both metadata documents, never the old umbrella", () => {
    expect(protectedResourceMetadata("https://polpo.example.com").scopes_supported).toEqual(ALL_SCOPES);
    const as = authorizationServerMetadata("https://polpo.example.com").scopes_supported;
    expect(as).toEqual([...ALL_SCOPES, "offline_access"]);
    expect(as).not.toContain("polpo");
  });

  it("a client asking for nothing gets read and work; the umbrella asks for every scope", () => {
    const { oauth } = oauthServer();
    expect(oauth.requestedScopes(undefined)).toEqual(["polpo:read", "polpo:work"]);
    expect(oauth.requestedScopes("offline_access")).toEqual(["polpo:read", "polpo:work"]);
    expect(oauth.requestedScopes("polpo")).toEqual(ALL_SCOPES);
    expect(oauth.requestedScopes("polpo:read")).toEqual(["polpo:read"]);
  });

  it("stores what the person allowed with the token and returns it in the token response", () => {
    const { oauth } = oauthServer();
    const client = oauth.register({ client_name: "Claude", redirect_uris: [REDIRECT] });
    // asked for everything, the person kept read and files
    const tokens = allow(oauth, client.client_id, { asked: "polpo", granted: ["polpo:files"] });
    expect(tokens.scope).toBe("polpo:read polpo:files");
    expect(oauth.verifyAccessToken(tokens.access_token, RESOURCE)?.scope).toBe("polpo:read polpo:files");
    // a refresh keeps them, may narrow them, never widen them
    const same = oauth.exchange({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    expect(same.scope).toBe("polpo:read polpo:files");
    expect(() => oauth.exchange({ grant_type: "refresh_token", refresh_token: same.refresh_token, scope: "polpo:admin" })).toThrow(/cannot ask for scopes/);
    // the failed attempt did not use the refresh token up
    const narrower = oauth.exchange({ grant_type: "refresh_token", refresh_token: same.refresh_token, scope: "polpo:read" });
    expect(narrower.scope).toBe("polpo:read");
  });

  it("keeps tokens issued with the old umbrella working, with every scope", () => {
    const { oauth, dir } = oauthServer();
    const client = oauth.register({ client_name: "Claude", redirect_uris: [REDIRECT] });
    const tokens = allow(oauth, client.client_id);
    // rewrite the stored scope as tokens issued before scopes had it
    const file = join(dir, "oauth.json");
    const state = JSON.parse(readFileSync(file, "utf-8"));
    state.tokens = state.tokens.map((t: { scope: string }) => ({ ...t, scope: "polpo" }));
    delete state.grants;
    writeFileSync(file, JSON.stringify(state));
    const grant = oauth.verifyAccessToken(tokens.access_token, RESOURCE)!;
    expect(grant.scope).toBe("polpo");
    expect(hasScope({ scopes: grant.scope.split(" ") }, "polpo:admin")).toBe(true);
    const refreshed = oauth.exchange({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    expect(refreshed.scope).toBe("polpo");
    const [listed] = oauth.listGrants();
    expect(listed).toMatchObject({ client_name: "Claude", scopes: ALL_SCOPES, legacy: true });
  });

  it("lists grants with client, person, scopes, dates; revoking one ends its tokens", () => {
    vi.useFakeTimers({ now: new Date("2026-11-20T10:00:00Z"), toFake: ["Date"] });
    try {
      const { oauth } = oauthServer();
      const claude = oauth.register({ client_name: "Claude", redirect_uris: [REDIRECT] });
      const chatgpt = oauth.register({ client_name: "ChatGPT", redirect_uris: [REDIRECT] });
      const a = allow(oauth, claude.client_id, { granted: ["polpo:work", "polpo:files"] });
      const b = allow(oauth, chatgpt.client_id, { subject: "api-key" });
      vi.setSystemTime(new Date("2026-11-20T10:30:00Z"));
      oauth.verifyAccessToken(a.access_token, RESOURCE);
      const grants = oauth.listGrants();
      expect(grants).toHaveLength(2);
      const g = grants.find((x) => x.client_name === "Claude")!;
      expect(g).toMatchObject({ subject: "ada@example.com", scopes: ["polpo:read", "polpo:work", "polpo:files"], legacy: false, created_at: "2026-11-20T10:00:00.000Z", last_used_at: "2026-11-20T10:30:00.000Z" });
      expect(grants[0]!.id).toBe(g.id); // most recently used first
      expect(grants.find((x) => x.client_name === "ChatGPT")).toMatchObject({ subject: "api-key", scopes: ["polpo:read", "polpo:work"] });
      expect(JSON.stringify(grants)).not.toContain(a.access_token);

      expect(oauth.revokeGrant(g.id)).toBe(true);
      expect(oauth.verifyAccessToken(a.access_token, RESOURCE)).toBeNull();
      expect(() => oauth.exchange({ grant_type: "refresh_token", refresh_token: a.refresh_token })).toThrow(/invalid or expired/);
      expect(oauth.verifyAccessToken(b.access_token, RESOURCE)).not.toBeNull();
      expect(oauth.listGrants().map((x) => x.client_name)).toEqual(["ChatGPT"]);
      expect(oauth.revokeGrant(g.id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the consent page offers every scope in plain words: asked ones checked, read always", () => {
    const html = consentPage({
      client: { client_id: "c", client_name: "Claude", redirect_uris: [REDIRECT], source: "dcr", created_at: "" },
      redirectUri: REDIRECT, params: {}, method: "session", email: "ada@example.com", requested: ["polpo:read", "polpo:work"],
    });
    const box = (scope: string) => html.match(new RegExp(`<input type="checkbox" id="scope-${scope.replace(":", "-")}"[^>]*>`))?.[0] ?? "";
    expect(box("polpo:read")).toMatch(/checked disabled/);
    expect(box("polpo:work")).toMatch(/ checked/);
    for (const s of ["polpo:files", "polpo:messages", "polpo:connectors", "polpo:computers", "polpo:vault", "polpo:admin"]) expect(box(s), s).not.toMatch(/checked/);
    expect(html).toContain("Send messages on any channel (Telegram, WhatsApp, email, Slack");
    expect(html).toContain('<input type="hidden" name="grant_scope" value="polpo:read">');
    expect(html).toContain("(not asked for)");
  });

  it("the boxes the person left checked are what is granted; the umbrella never comes from the form", () => {
    expect(consentScopes(["polpo:read", "polpo:work"])).toEqual(["polpo:read", "polpo:work"]);
    expect(consentScopes("polpo:files")).toEqual(["polpo:read", "polpo:files"]);
    expect(consentScopes(undefined)).toEqual(["polpo:read"]);
    expect(consentScopes(["polpo", "polpo:work"])).toEqual(["polpo:read", "polpo:work"]);
  });
});

describe("MCP keys with scopes", () => {
  const vaultOf = (entries: Record<string, Record<string, string>>) => ({
    get: async (owner: string, service: string) => entries[`${owner}/${service}`] ? { type: "api_key", credentials: entries[`${owner}/${service}`] } : undefined,
  }) as never;

  it("the legacy POLPO_MCP_KEY keeps every scope, with one warning that recommends narrowing it", async () => {
    const warn = vi.fn();
    const ring = new McpKeyRing({ apiKeys: () => [], env: () => ({ POLPO_MCP_KEY: "legacy-secret" }), settings: () => undefined, vault: () => null, warn });
    const key = await ring.match(new Request("http://x/mcp", { headers: { authorization: "Bearer legacy-secret" } }));
    expect(key).toMatchObject({ name: "POLPO_MCP_KEY", source: "env", scopes: ALL_SCOPES, explicit: false });
    await ring.match("legacy-secret");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/POLPO_MCP_KEY_SCOPES/);
    expect(await ring.match("wrong")).toBeUndefined();
  });

  it("POLPO_MCP_KEY_SCOPES narrows it (no warning)", async () => {
    const warn = vi.fn();
    const ring = new McpKeyRing({ apiKeys: () => [], env: () => ({ POLPO_MCP_KEY: "k1,k2", POLPO_MCP_KEY_SCOPES: "polpo:work polpo:files" }), settings: () => undefined, vault: () => null, warn });
    expect(await ring.match("k2")).toMatchObject({ name: "POLPO_MCP_KEY 2", scopes: ["polpo:read", "polpo:work", "polpo:files"], explicit: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it("named keys come from the vault with their scopes (default read and work); the list never shows values", async () => {
    const settings = parseMcpKeyConfigs([
      { name: "ci", keyRef: { owner: "ops", service: "mcp-ci" }, scopes: ["polpo:read"] },
      { name: "assistant", keyRef: { owner: "ops", service: "mcp-assistant" } },
      { name: "gone", keyRef: { owner: "ops", service: "missing" }, scopes: "polpo:admin" },
      { name: "ci", keyRef: { owner: "ops", service: "dup" } },
      { name: "bad" },
    ]);
    expect(settings.map((k) => k.name)).toEqual(["ci", "assistant", "gone"]);
    const ring = new McpKeyRing({
      apiKeys: () => ["api-secret"], env: () => ({}), settings: () => settings,
      vault: () => vaultOf({ "ops/mcp-ci": { key: "ci-secret" }, "ops/mcp-assistant": { token: "assistant-secret" } }),
    });
    expect(await ring.match("ci-secret")).toMatchObject({ name: "ci", source: "settings", scopes: ["polpo:read"], explicit: true, ref: "ops / mcp-ci" });
    expect(await ring.match("assistant-secret")).toMatchObject({ name: "assistant", scopes: ["polpo:read", "polpo:work"], explicit: false });
    expect(await ring.match("api-secret")).toMatchObject({ source: "api-key", scopes: ALL_SCOPES });
    const list = await ring.list();
    expect(list.map((k) => k.name)).toEqual(["API key", "ci", "assistant", "gone"]);
    expect(list.find((k) => k.name === "gone")).toMatchObject({ scopes: ["polpo:read", "polpo:admin"], problem: expect.stringMatching(/No key found/) });
    const text = JSON.stringify(list);
    for (const secret of ["api-secret", "ci-secret", "assistant-secret"]) expect(text).not.toContain(secret);
  });
});
