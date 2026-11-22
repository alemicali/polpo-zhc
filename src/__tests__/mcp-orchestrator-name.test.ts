// Split from mcp-config-sections.test.ts: one app per file keeps each under the server's 200 req/min limit.
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
  harnesses: { read: ["polpo_harnesses_get", "polpo_harness_sessions_list"], write: ["polpo_harnesses_update"] },
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

