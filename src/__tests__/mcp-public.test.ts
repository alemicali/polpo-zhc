import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";

// An instance with no API key on its dashboard and REST API that publishes only its MCP connector,
// mounted under a path by a public proxy (Tailscale Funnel: https://host/shoplix → http://127.0.0.1:3000).
const PUBLIC = "https://polpo.example.com/shoplix";
const MCP_KEY = "mcp-key-for-tests";
let tmpDir: string;
let app: Hono;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the orchestrator, for its events
let orchestrator: any;

beforeAll(async () => {
  process.env.POLPO_PUBLIC_URL = PUBLIC;
  process.env.POLPO_MCP_KEY = MCP_KEY;
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-mcp-public-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({
    project: "mcp-public", team: { name: "t", agents: [{ name: "agent-1", role: "Test agent" }] }, settings: { logLevel: "quiet" },
  }));
  const { Orchestrator } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");
  orchestrator = new Orchestrator(tmpDir);
  await orchestrator.initInteractive("mcp-public", { name: "t", agents: [{ name: "agent-1", role: "Test agent" }] });
  app = createApp(orchestrator, new SSEBridge(orchestrator), { workDir: tmpDir });
}, 30_000);

afterAll(async () => {
  delete process.env.POLPO_PUBLIC_URL;
  delete process.env.POLPO_MCP_KEY;
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

const publicHeaders = { "x-forwarded-host": "polpo.example.com", "x-forwarded-proto": "https" };
const initialize = (headers: Record<string, string>) => app.request("/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
});

describe("MCP connector published on its own", () => {
  it("needs the MCP key or a token, and points clients to the public URL", async () => {
    const res = await initialize(publicHeaders);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp", scope="polpo"`);
    expect((await initialize({ ...publicHeaders, authorization: `Bearer ${MCP_KEY}` })).status).toBe(200);
    expect((await initialize({ ...publicHeaders, authorization: "Bearer wrong" })).status).toBe(401);
  });

  it("the MCP key leaves the dashboard and REST API as they were", async () => {
    expect((await app.request("/api/v1/agents")).status).toBe(200);
  });

  it("the public URL applies only to requests through its host", async () => {
    const pub = await (await app.request("/.well-known/oauth-protected-resource/mcp", { headers: publicHeaders })).json();
    expect(pub).toMatchObject({ resource: `${PUBLIC}/mcp`, authorization_servers: [PUBLIC] });
    // the same instance on the tailnet, on its own port
    const tailnet = await (await app.request("/.well-known/oauth-protected-resource/mcp", {
      headers: { "x-forwarded-host": "lumea-dev.example.ts.net:3000", "x-forwarded-proto": "https" },
    })).json();
    expect(tailnet.resource).toBe("https://lumea-dev.example.ts.net:3000/mcp");
  });

  it("the consent page takes the MCP key, and posts back under the mount path", async () => {
    const reg = await (await app.request("/oauth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
    })).json();
    const challenge = createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url");
    const params = {
      response_type: "code", client_id: reg.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      code_challenge: challenge, code_challenge_method: "S256", state: "s1", resource: `${PUBLIC}/mcp`,
    };
    const page = await (await app.request(`/oauth/authorize?${new URLSearchParams(params)}`, { headers: publicHeaders })).text();
    expect(page).toContain('action="authorize"');
    expect(page).toContain('name="api_key"');
    const csrf = page.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
    const submit = (key: string) => app.request("/oauth/authorize", {
      method: "POST", headers: { ...publicHeaders, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, csrf, decision: "allow", api_key: key }).toString(),
    });
    expect((await submit("wrong")).status).toBe(401);
    expect((await submit(` POLPO_MCP_KEY=${MCP_KEY}\n`)).status).toBe(302);
    const ok = await submit(MCP_KEY);
    expect(ok.status).toBe(302);
    const back = new URL(ok.headers.get("location")!);
    expect(back.searchParams.get("code")).toMatch(/^polpo_code_/);
    expect(back.searchParams.get("iss")).toBe(PUBLIC);
  });
});

const call = async (name: string, args: Record<string, unknown>) => {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${MCP_KEY}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return (await res.json()).result as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string; resource?: { blob: string; mimeType: string } }>; isError?: boolean };
};
const textOf = (r: Awaited<ReturnType<typeof call>>) => r.content.map((c) => c.text ?? "").join("");

describe("files through the connector", () => {
  it("writes into new folders, lists, searches and reads text by lines", async () => {
    const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    expect(textOf(await call("polpo_file_write", { path: "reports/2026/notes.md", content: body }))).toMatch(/Wrote reports\/2026\/notes.md/);
    expect(textOf(await call("polpo_files_list", {}))).toMatch(/\.polpo/);
    expect(textOf(await call("polpo_files_list", { path: "reports" }))).toContain("2026/");
    expect(textOf(await call("polpo_files_list", { path: "reports/2026" }))).toMatch(/notes\.md\s+\d/);
    expect(textOf(await call("polpo_files_search", { q: "notes" }))).toContain("reports/2026/notes.md");
    const page = textOf(await call("polpo_file_read", { path: "reports/2026/notes.md", from_line: 5, lines: 3 }));
    expect(page).toMatch(/^line 5\nline 6\nline 7\n… \(lines 5-7 of 30; read on with from_line=8\)$/);
    // overwrite
    expect((await call("polpo_file_write", { path: "reports/2026/notes.md", content: "new" })).isError).toBe(true);
    expect(textOf(await call("polpo_file_write", { path: "reports/2026/notes.md", content: "new", overwrite: true }))).toMatch(/replacing/);
    expect(textOf(await call("polpo_file_read", { path: "reports/2026/notes.md" }))).toBe("new");
  });

  it("returns images and PDFs as they are, and describes other binaries", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
    await call("polpo_file_write", { path: "img/dot.png", content: png.toString("base64"), encoding: "base64" });
    const img = await call("polpo_file_read", { path: "img/dot.png" });
    expect(img.content[0]).toMatchObject({ type: "image", mimeType: "image/png", data: png.toString("base64") });
    await call("polpo_file_write", { path: "img/doc.pdf", content: Buffer.from("%PDF-1.4\n%%EOF").toString("base64"), encoding: "base64" });
    expect((await call("polpo_file_read", { path: "img/doc.pdf" })).content[0]?.resource).toMatchObject({ mimeType: "application/pdf" });
    await call("polpo_file_write", { path: "img/blob.bin", content: Buffer.from([0, 1, 2, 255]).toString("base64"), encoding: "base64" });
    expect(textOf(await call("polpo_file_read", { path: "img/blob.bin" }))).toMatch(/binary file/);
  });

  it("makes folders, renames and deletes", async () => {
    expect((await call("polpo_file_manage", { action: "mkdir", path: "tmp" })).isError).toBeFalsy();
    await call("polpo_file_write", { path: "tmp/a.txt", content: "a" });
    expect((await call("polpo_file_manage", { action: "rename", path: "tmp/a.txt", new_name: "b.txt" })).isError).toBeFalsy();
    expect(textOf(await call("polpo_file_read", { path: "tmp/b.txt" }))).toBe("a");
    const unconfirmed = await call("polpo_file_manage", { action: "delete", path: "tmp", recursive: true });
    expect(unconfirmed.isError).toBe(true);
    expect(textOf(unconfirmed)).toMatch(/confirm: true/);
    const notEmpty = await call("polpo_file_manage", { action: "delete", path: "tmp", confirm: true });
    expect(notEmpty.isError).toBe(true);
    expect((await call("polpo_file_manage", { action: "delete", path: "tmp", recursive: true, confirm: true })).isError).toBeFalsy();
    expect((await call("polpo_file_read", { path: "tmp/b.txt" })).isError).toBe(true);
    expect((await call("polpo_file_read", { path: "../etc/passwd" })).isError).toBe(true);
  });
});

/** An OAuth access token for the public /mcp, allowed by a person through a client named "Claude". */
async function oauthToken(subject: string): Promise<string> {
  const { OAuthServer } = await import("../server/oauth.js");
  const oauth = new OAuthServer(join(tmpDir, ".polpo"));
  const client = oauth.register({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const code = oauth.issueCode({ client_id: client.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: challenge }, `${PUBLIC}/mcp`, subject);
  return oauth.exchange({ grant_type: "authorization_code", code, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: verifier }).access_token;
}

const callAs = async (authorization: string, method: string, params: Record<string, unknown>, path = "/mcp") => {
  const res = await app.request(path, {
    method: "POST",
    headers: { ...publicHeaders, "content-type": "application/json", accept: "application/json, text/event-stream", authorization },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await res.json()).result;
};

describe("who acts through the connector", () => {
  it("records the MCP key as mcp-key, in events and on artifacts", async () => {
    const seen: Array<{ by?: string; source?: string }> = [];
    const onCreated = (p: { by?: string; source?: string }) => seen.push(p);
    orchestrator.on("task:created", onCreated);
    try {
      const created = await callAs(`Bearer ${MCP_KEY}`, "tools/call", { name: "polpo_task_create", arguments: { title: "Check the logs", description: "Look for errors", assignTo: "agent-1" } });
      expect(created.isError).toBeFalsy();
      expect(seen.at(-1)).toMatchObject({ source: "api", by: "mcp-key" });
    } finally {
      orchestrator.off("task:created", onCreated);
    }
    const artifact = await callAs(`Bearer ${MCP_KEY}`, "tools/call", { name: "polpo_artifact_create", arguments: { title: "Notes", type: "doc", content: "# Notes" } });
    expect(artifact.structuredContent.artifact.createdBy).toBe("person:mcp-key");
  });

  it("records an OAuth client as the person who allowed it and the client", async () => {
    const token = await oauthToken("ada@example.com");
    const artifact = await callAs(`Bearer ${token}`, "tools/call", { name: "polpo_artifact_create", arguments: { title: "Plan", type: "doc", content: "# Plan" } });
    expect(artifact.structuredContent.artifact.createdBy).toBe("person:ada@example.com via Claude");
  });

  it("offers the default toolsets: no admin tools, and no generic writes at all", async () => {
    const names = ((await callAs(`Bearer ${MCP_KEY}`, "tools/list", {})).tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["polpo_ask", "polpo_answer", "polpo_agent_show"]));
    expect(names).not.toContain("polpo_api_get");
    expect(names).not.toContain("call_operation");
  });
});

describe("the admin toolset", () => {
  it("POLPO_MCP_TOOLSETS turns it on; polpo_api_get reads and refuses writes", async () => {
    process.env.POLPO_MCP_TOOLSETS = "default,admin";
    try {
      const names = ((await callAs(`Bearer ${MCP_KEY}`, "tools/list", {})).tools as Array<{ name: string }>).map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["polpo_api_search", "polpo_api_get"]));
      const read = await callAs(`Bearer ${MCP_KEY}`, "tools/call", { name: "polpo_api_get", arguments: { path: "/agents" } });
      expect(read.isError).toBeFalsy();
      expect(JSON.stringify(read.structuredContent.data)).toContain("agent-1");
      const templated = await callAs(`Bearer ${MCP_KEY}`, "tools/call", { name: "polpo_api_get", arguments: { path: "/agents/{name}", params: { name: "agent-1" } } });
      expect(templated.isError).toBeFalsy();
      const write = await callAs(`Bearer ${MCP_KEY}`, "tools/call", { name: "polpo_api_get", arguments: { path: "/tasks/abc/retry" } });
      expect(write.isError).toBe(true);
      expect(write.content[0].text).toMatch(/cannot be read here \(it accepts POST\)/);
      expect((await callAs(`Bearer ${MCP_KEY}`, "tools/call", { name: "polpo_api_get", arguments: { path: "/events" } })).isError).toBe(true);
      const search = await callAs(`Bearer ${MCP_KEY}`, "tools/call", { name: "polpo_api_search", arguments: { q: "tasks retry" } });
      expect(search.structuredContent.items).toContainEqual(expect.objectContaining({ method: "POST", path: "/tasks/{taskId}/retry", readable: false }));
      // a connector URL can narrow the toolsets, never widen them
      const narrowed = await callAs(`Bearer ${MCP_KEY}`, "tools/list", {}, "/mcp?toolsets=admin");
      expect((narrowed.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(["polpo_api_search", "polpo_api_get"]);
    } finally {
      delete process.env.POLPO_MCP_TOOLSETS;
    }
    const widened = await callAs(`Bearer ${MCP_KEY}`, "tools/list", {}, "/mcp?toolsets=admin,tasks");
    const widenedNames = (widened.tools as Array<{ name: string }>).map((t) => t.name);
    expect(widenedNames.length).toBeGreaterThan(0);
    expect(widenedNames.every((n) => n.startsWith("polpo_task"))).toBe(true); // tasks only: admin is not configured
  });
});

describe("tasks, missions and configuration on a real instance", () => {
  const tool = async (name: string, args: Record<string, unknown> = {}) => callAs(`Bearer ${MCP_KEY}`, "tools/call", { name, arguments: args });

  it("creates, updates, waits for and stops a task", async () => {
    const created = await tool("polpo_task_create", { title: "Summarize the inbox", description: "Three bullet points", assignTo: "agent-1", draft: true });
    expect(created.isError).toBeFalsy();
    const id = created.structuredContent.task.id as string;
    expect(created.structuredContent.task.status).toBe("draft");
    const updated = await tool("polpo_task_update", { id, description: "Five bullet points", start: true });
    expect(updated.structuredContent.changed).toEqual(["description", "status"]);
    const waited = await tool("polpo_task_wait", { id, until: ["done"], timeout_seconds: 1 });
    expect(waited.structuredContent).toMatchObject({ timed_out: true, task: { id } });
    expect((await tool("polpo_task_get", { id })).structuredContent.task.description).toBe("Five bullet points");
    expect((await tool("polpo_tasks_list", { text: "inbox" })).structuredContent.items.map((t: { id: string }) => t.id)).toContain(id);
    expect((await tool("polpo_task_kill", { id })).isError).toBe(true);
    expect((await tool("polpo_task_kill", { id, confirm: true })).structuredContent).toMatchObject({ id, killed: true });
    expect((await tool("polpo_task_get", { id })).structuredContent.task.status).toBe("failed");
  });

  it("creates a mission from a plan, reads it and aborts it with confirm", async () => {
    const bad = await tool("polpo_mission_create", { name: "Launch", tasks: [{ title: "A", description: "a", dependsOn: ["Nope"] }, { title: "A", description: "b" }] });
    expect(bad.isError).toBe(true);
    const made = await tool("polpo_mission_create", { name: "Launch", goal: "Ship the page", tasks: [
      { title: "Write copy", description: "The landing copy", assignTo: "agent-1" },
      { title: "Review copy", description: "Check it", assignTo: "agent-1", dependsOn: ["Write copy"] },
    ] });
    expect(made.isError).toBeFalsy();
    const id = made.structuredContent.mission.id as string;
    const got = await tool("polpo_mission_get", { id });
    expect(got.structuredContent).toMatchObject({ mission: { name: "Launch", status: "draft" }, plan: { tasks: [{ title: "Write copy" }, { title: "Review copy" }] } });
    const renamed = await tool("polpo_mission_update", { id, name: "Launch v2" });
    expect(renamed.structuredContent).toMatchObject({ changed: ["name"], mission: { name: "Launch v2" } });
    expect((await tool("polpo_mission_run", { id })).isError).toBeFalsy();
    expect((await tool("polpo_mission_get", { id })).structuredContent.tasks).toHaveLength(2);
    expect((await tool("polpo_mission_abort", { id })).isError).toBe(true);
    expect((await tool("polpo_mission_abort", { id, confirm: true })).structuredContent.aborted_tasks).toBe(2);
  });

  it("changes the settings and the branding, logo included", async () => {
    const before = await tool("polpo_config_get");
    expect(before.structuredContent.project).toBe("mcp-public");
    const reasoning = await tool("polpo_config_update", { reasoning: "high" });
    expect(reasoning.structuredContent.changed).toEqual(["reasoning"]);
    expect((await tool("polpo_config_get")).structuredContent.settings.reasoning).toBe("high");

    const named = await tool("polpo_branding_update", { product_name: "Shoplix", tagline: "Agents for shops" });
    expect(named.structuredContent).toMatchObject({ changed: ["productName", "tagline"], branding: { productName: "Shoplix", tagline: "Agents for shops" } });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
    const logo = await tool("polpo_branding_update", { logo: { base64: png.toString("base64"), mime_type: "image/png" } });
    expect(logo.structuredContent.branding.logoUrl).toBe("/api/v1/config/branding/logo");
    const served = await app.request("/api/v1/config/branding/logo");
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await served.arrayBuffer()).equals(png)).toBe(true);
    // the name stays when only the logo changes; '' restores the default tagline
    const reset = await tool("polpo_branding_update", { tagline: "" });
    expect(reset.structuredContent.branding).toEqual({ productName: "Shoplix", logoUrl: "/api/v1/config/branding/logo" });
    expect((await tool("polpo_providers_list")).structuredContent.setup_url).toBe(`${PUBLIC}/config?section=providers`);
  });
});
