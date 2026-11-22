/**
 * OpenCode through MCP, on a real instance (createApp, the real routes): polpo_harnesses_update
 * takes its settings (provider API key, Bedrock API key) and refuses logins; an agent goes on it
 * with polpo_agent_update engine. No model is called.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";

const PUBLIC = "https://polpo.example.com";
const MCP_KEY = "mcp-key-for-opencode";
let tmpDir: string;
let app: Hono;

beforeAll(async () => {
  process.env.POLPO_PUBLIC_URL = PUBLIC;
  process.env.POLPO_MCP_KEY = MCP_KEY;
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-mcp-opencode-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({
    project: "mcp-opencode", team: { name: "t", agents: [{ name: "agent-1", role: "Test agent" }] }, settings: { logLevel: "quiet" },
  }));
  const { Orchestrator } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");
  const orchestrator = new Orchestrator(tmpDir);
  await orchestrator.initInteractive("mcp-opencode", { name: "t", agents: [{ name: "agent-1", role: "Test agent" }] });
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

describe("OpenCode through MCP", () => {
  it("Bedrock with an open-weight model, a provider API key, refusals of logins; an agent on it", async () => {
    const sub = await tool("polpo_harnesses_update", { opencode: { auth: "subscription" } });
    expect(sub.isError).toBe(true);
    expect(text(sub)).toMatch(/explicit credential only/);

    const r = await tool("polpo_harnesses_update", {
      enabled: ["opencode"], allow_host: true,
      opencode: { auth: "bedrock", credential_ref: { owner: "agent-1", service: "bedrock-oc" }, bedrock_region: "us-east-1", model: "amazon-bedrock/global.moonshotai.kimi-k3.1" },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.setup_id).toBe("vault:agent-1:bedrock-oc");
    expect(text(r)).toMatch(/Bedrock API key/);
    expect((await settingsFile()).data.settings.harnesses.opencode).toEqual({
      auth: "bedrock", credentialRef: { owner: "agent-1", service: "bedrock-oc" }, bedrock: { region: "us-east-1" }, model: "global.moonshotai.kimi-k3.1",
    });
    const got = await tool("polpo_harnesses_get");
    // Bedrock API keys are brokered by Polpo's relay for OpenCode (a bearer token, not a signature)
    expect(got.structuredContent.harnesses.find((h: { id: string }) => h.id === "opencode")).toMatchObject({ enabled: true, auth: "bedrock", bedrock: { region: "us-east-1" }, brokering: "relay" });

    // a provider API key: the provider is kept, the Bedrock region dropped
    const k = await tool("polpo_harnesses_update", { opencode: { auth: "api-key", provider: "moonshotai", credential_ref: { owner: "agent-1", service: "moonshot" }, model: "kimi-k2-0905-preview" } });
    expect(k.isError).toBeFalsy();
    expect((await settingsFile()).data.settings.harnesses.opencode).toEqual({ auth: "api-key", provider: "moonshotai", credentialRef: { owner: "agent-1", service: "moonshot" }, model: "kimi-k2-0905-preview" });
    expect(text(await tool("polpo_harnesses_get"))).toMatch(/OpenCode \(opencode\): enabled, auth api-key \(moonshotai\)/);

    const set = await tool("polpo_agent_update", { name: "agent-1", engine: { harness: "opencode", model: "kimi-k2-turbo-preview" } });
    expect(set.isError).toBeFalsy();
    expect(set.structuredContent.agent.engine).toEqual({ harness: "opencode", model: "kimi-k2-turbo-preview" });
    // a harness its agents use cannot be disabled
    expect(text(await tool("polpo_harnesses_update", { enabled: [] }))).toMatch(/agent-1 \(OpenCode\)/);
    expect((await tool("polpo_agent_update", { name: "agent-1", engine: "polpo" })).isError).toBeFalsy();
    expect((await tool("polpo_harnesses_update", { enabled: [], opencode: null })).isError).toBeFalsy();
  });
});
