/**
 * The theme tokens shadowButtonPrimary (the primary button's glow) and shadowDialog (dialogs and
 * sheets) through MCP polpo_branding_update and the REST settings route, on its own instance.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";

const MCP_KEY = "mcp-key-for-branding-shadows";
let tmpDir: string;
let app: Hono;

beforeAll(async () => {
  process.env.POLPO_PUBLIC_URL = "https://polpo.example.com";
  process.env.POLPO_MCP_KEY = MCP_KEY;
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-mcp-shadows-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({
    project: "mcp-shadows", team: { name: "t", agents: [{ name: "agent-1", role: "Test agent" }] }, settings: { logLevel: "quiet" },
  }));
  const { Orchestrator } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");
  const orchestrator = new Orchestrator(tmpDir);
  await orchestrator.initInteractive("mcp-shadows", { name: "t", agents: [{ name: "agent-1", role: "Test agent" }] });
  app = createApp(orchestrator, new SSEBridge(orchestrator), { workDir: tmpDir });
}, 30_000);

afterAll(async () => {
  delete process.env.POLPO_PUBLIC_URL;
  delete process.env.POLPO_MCP_KEY;
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool results are checked field by field
const tool = async (name: string, args: Record<string, unknown> = {}): Promise<any> => (await (await app.request("/mcp", {
  method: "POST",
  headers: { "x-forwarded-host": "polpo.example.com", "x-forwarded-proto": "https", "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${MCP_KEY}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
})).json()).result;

describe("the primary button's glow and the dialogs' shadow", () => {
  it("takes the primary button's glow and the dialogs' shadow per mode, and refuses unsafe ones (MCP and REST)", async () => {
    const r = await tool("polpo_branding_update", { tokens: {
      light: { shadowButtonPrimary: "0 0 20px oklch(0.6 0.2 290 / 40%)", shadowDialog: "0 10px 15px -3px rgb(0 0 0 / 10%), 0 4px 6px -4px rgb(0 0 0 / 10%)" },
      dark: { shadowButtonPrimary: "none" },
    } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.changed).toEqual(expect.arrayContaining([
      "appearance.custom.light.shadowButtonPrimary", "appearance.custom.light.shadowDialog", "appearance.custom.dark.shadowButtonPrimary",
    ]));
    expect(r.structuredContent.appearance.custom).toMatchObject({
      light: { shadowButtonPrimary: "0 0 20px oklch(0.6 0.2 290 / 40%)" }, dark: { shadowButtonPrimary: "none" },
    });
    expect((await tool("polpo_branding_get")).structuredContent.tokens).toEqual(expect.arrayContaining(["shadowButtonPrimary", "shadowDialog"]));
    for (const tokens of [{ light: { shadowButtonPrimary: "0 0 20px red; color: red" } }, { dark: { shadowDialog: "0 0 1px url(https://evil)" } }]) {
      const bad = await tool("polpo_branding_update", { tokens });
      expect(bad.isError, JSON.stringify(tokens)).toBe(true);
    }
    const rest = await app.request("/api/v1/config/settings", {
      method: "PATCH", headers: { authorization: `Bearer ${MCP_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ appearance: { custom: { enabled: true, light: { shadowDialog: "0 0 0 1px url(x)" } } } }),
    });
    expect(rest.status).toBe(400);
    expect((await tool("polpo_branding_update", { reset_appearance: true })).isError).toBeFalsy();
  });
});
