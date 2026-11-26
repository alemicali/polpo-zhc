/**
 * Codex signed in with ChatGPT through MCP (and so Polpo's chat tools), on a real instance
 * (createApp, the real routes): polpo_harnesses_update takes auth chatgpt (no setup link for a key:
 * a sign-in instead), codex_chatgpt_login gives the sign-in terminal and capture refuses a target
 * it cannot reach; polpo_harnesses_get says signed in or not, never the login. No model is called.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";

const PUBLIC = "https://polpo.example.com";
const MCP_KEY = "mcp-key-for-codex-chatgpt";
let tmpDir: string;
let app: Hono;

beforeAll(async () => {
  process.env.POLPO_PUBLIC_URL = PUBLIC;
  process.env.POLPO_MCP_KEY = MCP_KEY;
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-mcp-codex-chatgpt-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({
    project: "mcp-codex-chatgpt", team: { name: "t", agents: [{ name: "agent-1", role: "Test agent" }] }, settings: { logLevel: "quiet" },
  }));
  const { Orchestrator } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");
  const orchestrator = new Orchestrator(tmpDir);
  await orchestrator.initInteractive("mcp-codex-chatgpt", { name: "t", agents: [{ name: "agent-1", role: "Test agent" }] });
  app = createApp(orchestrator, new SSEBridge(orchestrator), { workDir: tmpDir });
}, 30_000);

afterAll(async () => {
  delete process.env.POLPO_PUBLIC_URL;
  delete process.env.POLPO_MCP_KEY;
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

const request = (name: string, args: Record<string, unknown> = {}) => app.request("/mcp", {
  method: "POST",
  headers: { "x-forwarded-host": "polpo.example.com", "x-forwarded-proto": "https", "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${MCP_KEY}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool results are checked field by field
const tool = async (name: string, args: Record<string, unknown> = {}): Promise<any> => (await (await request(name, args)).json()).result;
const text = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? "").join("");
const settingsFile = async () => (await (await app.request("/api/v1/config", { headers: { authorization: `Bearer ${MCP_KEY}` } })).json());

describe("Codex with a ChatGPT login through MCP", () => {
  it("auth chatgpt, the sign-in terminal, the status; never the login", async () => {
    const r = await tool("polpo_harnesses_update", {
      enabled: ["codex"], allow_host: true, codex: { auth: "chatgpt", credential_ref: { owner: "agent-1", service: "codex-chatgpt" } },
    });
    expect(r.isError).toBeFalsy();
    // nothing to paste: no vault setup link, a sign-in instead
    expect(r.structuredContent.setup_id).toBeUndefined();
    expect(text(r)).toMatch(/nobody has signed in yet/);
    expect((await settingsFile()).data.settings.harnesses.codex).toEqual({ auth: "chatgpt", credentialRef: { owner: "agent-1", service: "codex-chatgpt" } });
    const got = await tool("polpo_harnesses_get");
    expect(got.structuredContent.harnesses.find((h: { id: string }) => h.id === "codex")).toMatchObject({ enabled: true, auth: "chatgpt", chatgpt: { signedIn: false } });
    expect(text(got)).toMatch(/ChatGPT sign-in in agent-1 \/ codex-chatgpt: NOT signed in/);

    const login = await tool("polpo_harnesses_update", { codex_chatgpt_login: { agent: "agent-1" } });
    expect(login.isError).toBeFalsy();
    expect(text(login)).toMatch(/codex login --device-auth/);
    expect(login.structuredContent.sign_in_url).toMatch(/\/config\?section=harnesses&codexChatgptLogin=agent-1$/);
    expect(login.structuredContent.command).toContain(".polpo-harness/codex/agent-1");

    // nothing signed in on this server's isolated harness HOME yet
    const cap = await tool("polpo_harnesses_update", { codex_chatgpt_login: { agent: "agent-1", capture: true } });
    expect(cap.isError).toBeFalsy();
    expect(text(cap)).toMatch(/No ChatGPT login on the agent's computer yet/);
    expect((await tool("polpo_harnesses_update", { codex_chatgpt_login: { agent: "nobody" } })).isError).toBe(true);
  });
});
