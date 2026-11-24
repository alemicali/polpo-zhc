/**
 * The CLI engine through MCP on a real instance (createApp, the real routes): polpo_harnesses_update
 * adds a CLI account (no secret, the sign-in is the person's), polpo_harnesses_get lists it with its
 * status, an agent goes on it with polpo_agent_update engine { type: "cli" }, and an unknown
 * account is refused. No CLI or model is called (status runs `claude --version` with no claude on PATH).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";

const MCP_KEY = "mcp-key-for-cli";
let tmpDir: string;
let app: Hono;
const PATH = process.env.PATH;
const HOME = process.env.HOME;

beforeAll(async () => {
  process.env.POLPO_MCP_KEY = MCP_KEY;
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-mcp-cli-"));
  // no real claude/codex reachable (PATH has only bash), and account directories under a throwaway home
  await mkdir(join(tmpDir, "bin"), { recursive: true });
  await symlink("/bin/bash", join(tmpDir, "bin", "bash"));
  process.env.PATH = join(tmpDir, "bin");
  process.env.HOME = tmpDir;
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({
    project: "mcp-cli", team: { name: "t", agents: [{ name: "agent-1", role: "Test agent" }] }, settings: { logLevel: "quiet" },
  }));
  const { Orchestrator } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");
  const orchestrator = new Orchestrator(tmpDir);
  await orchestrator.initInteractive("mcp-cli", { name: "t", agents: [{ name: "agent-1", role: "Test agent" }] });
  app = createApp(orchestrator, new SSEBridge(orchestrator), { workDir: tmpDir });
}, 30_000);

afterAll(async () => {
  delete process.env.POLPO_MCP_KEY;
  process.env.PATH = PATH;
  process.env.HOME = HOME;
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
const api = async (path: string) => (await (await app.request(`/api/v1${path}`, { headers: { authorization: `Bearer ${MCP_KEY}` } })).json());

describe("CLI engine through MCP and REST", () => {
  it("adds an account, lists it with its status, puts an agent on it, refuses unknown accounts", async () => {
    const add = await tool("polpo_harnesses_update", { cli: { add_account: { cli: "claude", id: "my-claude", label: "My Max" } } });
    expect(add.isError).toBeFalsy();
    expect(text(add)).toMatch(/Added CLI account my-claude.*Sign in.*claude auth login.*never sees the token/s);

    const saved = (await api("/config")).data.settings.harnesses.cli;
    expect(saved.accounts).toEqual([{ id: "my-claude", cli: "claude", computer: "host", configDir: "~/.polpo-cli/claude/my-claude", owner: "instance", label: "My Max" }]);

    const get = await tool("polpo_harnesses_get");
    expect(text(get)).toMatch(/CLI account my-claude \(My Max\): Claude Code on host, owner instance.*NOT installed/);
    expect(get.structuredContent.cli.accounts[0]).toMatchObject({ id: "my-claude", report: { installed: false } });

    const up = await tool("polpo_agent_update", { name: "agent-1", engine: { type: "cli", cli: "claude", account: "my-claude", model: "opus" } });
    expect(up.isError).toBeFalsy();
    const agent = (await api("/agents/agent-1")).data;
    expect(agent.engine).toEqual({ type: "cli", cli: "claude", account: "my-claude", model: "opus" });
    expect(text(await tool("polpo_agent_get", { name: "agent-1" }))).toMatch(/engine: claude CLI \(account my-claude\)/);

    const bad = await tool("polpo_agent_update", { name: "agent-1", engine: { type: "cli", cli: "codex", account: "nope" } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/unknown account "nope"/);

    // the account is in use: removing it is refused
    const rm = await tool("polpo_harnesses_update", { cli: { remove_account: "my-claude" } });
    expect(rm.isError).toBe(true);
    expect(text(rm)).toMatch(/Agents use this account: agent-1/);

    // the dashboard's harness save keeps the accounts (the overview carries them)
    const overview = (await api("/harnesses")).data;
    expect(overview.cli.accounts[0].id).toBe("my-claude");
  });
});
