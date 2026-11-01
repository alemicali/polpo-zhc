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
  const orchestrator = new Orchestrator(tmpDir);
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
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`);
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
    expect(textOf(await call("write_file", { path: "reports/2026/notes.md", content: body }))).toMatch(/Wrote reports\/2026\/notes.md/);
    expect(textOf(await call("list_files", {}))).toMatch(/\.polpo/);
    expect(textOf(await call("list_files", { path: "reports" }))).toContain("2026/");
    expect(textOf(await call("list_files", { path: "reports/2026" }))).toMatch(/notes\.md\s+\d/);
    expect(textOf(await call("search_files", { q: "notes" }))).toContain("reports/2026/notes.md");
    const page = textOf(await call("read_file", { path: "reports/2026/notes.md", from_line: 5, lines: 3 }));
    expect(page).toMatch(/^line 5\nline 6\nline 7\n… \(lines 5-7 of 30; read on with from_line=8\)$/);
    // overwrite
    await call("write_file", { path: "reports/2026/notes.md", content: "new" });
    expect(textOf(await call("read_file", { path: "reports/2026/notes.md" }))).toBe("new");
  });

  it("returns images and PDFs as they are, and describes other binaries", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
    await call("write_file", { path: "img/dot.png", content: png.toString("base64"), encoding: "base64" });
    const img = await call("read_file", { path: "img/dot.png" });
    expect(img.content[0]).toMatchObject({ type: "image", mimeType: "image/png", data: png.toString("base64") });
    await call("write_file", { path: "img/doc.pdf", content: Buffer.from("%PDF-1.4\n%%EOF").toString("base64"), encoding: "base64" });
    expect((await call("read_file", { path: "img/doc.pdf" })).content[0]?.resource).toMatchObject({ mimeType: "application/pdf" });
    await call("write_file", { path: "img/blob.bin", content: Buffer.from([0, 1, 2, 255]).toString("base64"), encoding: "base64" });
    expect(textOf(await call("read_file", { path: "img/blob.bin" }))).toMatch(/binary file/);
  });

  it("makes folders, renames and deletes", async () => {
    expect((await call("manage_file", { action: "mkdir", path: "tmp" })).isError).toBeFalsy();
    await call("write_file", { path: "tmp/a.txt", content: "a" });
    expect((await call("manage_file", { action: "rename", path: "tmp/a.txt", new_name: "b.txt" })).isError).toBeFalsy();
    expect(textOf(await call("read_file", { path: "tmp/b.txt" }))).toBe("a");
    const notEmpty = await call("manage_file", { action: "delete", path: "tmp" });
    expect(notEmpty.isError).toBe(true);
    expect((await call("manage_file", { action: "delete", path: "tmp", recursive: true })).isError).toBeFalsy();
    expect((await call("read_file", { path: "tmp/b.txt" })).isError).toBe(true);
    expect((await call("read_file", { path: "../etc/passwd" })).isError).toBe(true);
  });
});
