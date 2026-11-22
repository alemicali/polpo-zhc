/**
 * The appearance extras through MCP (polpo_branding_get / polpo_branding_update), on a real
 * instance: web fonts (Google Fonts or an allowed stylesheet host), the button gradient, the card /
 * control radius and the sidebar's translucency. Its own instance: the config sections test uses
 * most of the per-minute request budget.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";

const PUBLIC = "https://polpo.example.com";
const DASHBOARD = "https://dash.example.com:5174";
const MCP_KEY = "mcp-key-for-appearance-extras";
let tmpDir: string;
let app: Hono;

beforeAll(async () => {
  process.env.POLPO_PUBLIC_URL = PUBLIC;
  process.env.POLPO_MCP_KEY = MCP_KEY;
  process.env.POLPO_DASHBOARD_URL = DASHBOARD;
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-mcp-appearance-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({
    project: "mcp-appearance", team: { name: "t", agents: [{ name: "agent-1", role: "Test agent" }] }, settings: { logLevel: "quiet" },
  }));
  const { Orchestrator } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");
  const orchestrator = new Orchestrator(tmpDir);
  await orchestrator.initInteractive("mcp-appearance", { name: "t", agents: [{ name: "agent-1", role: "Test agent" }] });
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

describe("appearance extras", () => {
  it("says where fonts come from, loads web fonts, and warns about a family it does not load", async () => {
    const got = await tool("polpo_branding_get");
    expect(got.structuredContent.font_sources).toMatchObject({ bundled: ["Inter Tight"], web_font_hosts: expect.arrayContaining(["fonts.googleapis.com", "fonts.bunny.net"]) });
    const warned = await tool("polpo_branding_update", { tokens: { light: { fontFamily: "\"Manrope\", sans-serif" } } });
    expect(warned.structuredContent.unloaded_fonts).toEqual(["Manrope"]);
    expect(warned.content[0].text).toContain("Manrope is not loaded");
    const r = await tool("polpo_branding_update", {
      fonts: [{ family: "Manrope", source: "google", weights: "700, 400;600" }, { family: "Inter Display", source: "url", url: "https://rsms.me/inter/inter.css" }],
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.appearance.fonts).toEqual([
      { family: "Manrope", source: "google", weights: "400;600;700" },
      { family: "Inter Display", source: "url", url: "https://rsms.me/inter/inter.css" },
    ]);
    expect(r.structuredContent.changed).toEqual(["appearance.fonts.Manrope", "appearance.fonts.Inter Display"]);
    expect(r.structuredContent.unloaded_fonts).toBeUndefined();
    expect((await (await app.request("/api/v1/config/appearance")).json()).data.fonts).toHaveLength(2);
    // a host not on the list, http, or a bad weight: refused, nothing changes
    for (const fonts of [
      [{ family: "Evil", source: "url", url: "https://evil.example.com/font.css" }],
      [{ family: "Plain", source: "url", url: "http://fonts.googleapis.com/css2?family=Plain" }],
      [{ family: "Manrope", source: "google", weights: "950" }],
    ]) {
      expect(await tool("polpo_branding_update", { fonts })).toMatchObject({ isError: true });
    }
    expect((await tool("polpo_branding_get")).structuredContent.appearance.fonts).toHaveLength(2);
    expect((await tool("polpo_branding_update", { fonts: null })).structuredContent.appearance.fonts).toBeUndefined();
    expect((await tool("polpo_branding_update", { reset_appearance: true })).isError).toBeFalsy();
  });

  it("takes the button gradient, card / control radius and sidebar translucency tokens", async () => {
    const r = await tool("polpo_branding_update", {
      tokens: { light: { buttonGradient: { from: "#7c3aed", to: "#db2777" }, radiusCard: 20, radiusControl: 4, sidebarOpacity: 0.8, sidebarBlur: 12 } },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.appearance.custom.light).toMatchObject({
      buttonGradient: { from: "#7c3aed", to: "#db2777", angle: 135 }, radiusCard: 20, radiusControl: 4, sidebarOpacity: 0.8, sidebarBlur: 12,
    });
    expect(await tool("polpo_branding_update", { tokens: { light: { buttonGradient: { from: "red; }", to: "#000000" } } } })).toMatchObject({ isError: true });
    expect(await tool("polpo_branding_update", { tokens: { light: { radiusCard: 40 } } })).toMatchObject({ isError: true });
    expect(await tool("polpo_branding_update", { tokens: { light: { sidebarOpacity: 0.2 } } })).toMatchObject({ isError: true });
    expect((await tool("polpo_branding_update", { reset_appearance: true })).isError).toBeFalsy();
  });

});
