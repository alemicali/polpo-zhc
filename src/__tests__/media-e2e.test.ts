/**
 * Media end to end on a real instance (orchestrator + createApp): Settings (imageModel, media with
 * a vault entry), POST /api/v1/media/images through the shared gateway resolver to a mocked Vercel
 * AI Gateway (no real call), the image bytes, the media log and status, the token usage (source
 * image), the event on the bus, the MCP tools with their scopes and the media card.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Orchestrator } from "../core/orchestrator.js";
import { handleMcpRequest, type McpDeps } from "../server/mcp.js";

let tmpDir: string;
let app: any;
let orchestrator: Orchestrator;
const KEY = "test-api-key";
const GATEWAY_KEY = "vck_media_e2e_secret";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const gatewayCalls: Array<{ url: string; auth?: string; body: any }> = [];

const api = (path: string, init?: { method?: string; body?: unknown }) => app.request(`/api/v1${path}`, {
  method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
  headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
  ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
});
const json = async (res: Response) => (await res.json()) as { ok: boolean; data: any; error?: string; code?: string; details?: string[] };

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-media-e2e-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({ project: "media-e2e", team: { name: "t", agents: [] }, settings: { logLevel: "quiet" } }));
  const { Orchestrator: O } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");
  orchestrator = new O(tmpDir);
  await orchestrator.initInteractive("media-e2e", { name: "t", agents: [] });
  const bridge = new SSEBridge(orchestrator);
  bridge.start();
  app = createApp(orchestrator, bridge, { apiKeys: [KEY] });
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://ai-gateway.vercel.sh/")) return real(input, init);
    const body = JSON.parse(init.body);
    gatewayCalls.push({ url, auth: init.headers?.authorization, body });
    return new Response(JSON.stringify({
      data: Array.from({ length: body.n }, () => ({ b64_json: PNG.toString("base64") })),
      usage: { input_tokens: 20, output_tokens: 1000 }, providerMetadata: { gateway: { cost: 0.042 } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("media over REST on a real instance", () => {
  test("not configured → 409 with the Settings link; configured with a vault entry → images from the gateway, stored, logged, costed", async () => {
    const none = await api("/media/images", { body: { prompt: "a cat" } });
    expect(none.status).toBe(409);
    expect((await json(none)).error).toContain("/config?section=media");
    expect((await json(await api("/media/status"))).data).toMatchObject({ configured: false, gateways: [{ id: "vercel-ai-gateway" }], analysis: "chat" });

    await orchestrator.getVaultStore()!.set("polpo-infra", "vercel-ai-gateway", { type: "api_key", credentials: { token: GATEWAY_KEY } });
    expect((await api("/config/settings", { method: "PATCH", body: { imageModel: "openrouter:x" } })).status).toBe(400);
    const saved = await api("/config/settings", { method: "PATCH", body: {
      imageModel: "vercel-ai-gateway:openai/gpt-image-2",
      media: { fallbackModel: "vercel-ai-gateway:bfl/flux-2-pro", credentialRef: { owner: "polpo-infra", service: "vercel-ai-gateway" }, credentialField: "token", retention: 50 },
    } });
    expect(saved.status).toBe(200);
    const status = (await json(await api("/media/status"))).data;
    expect(status).toMatchObject({ configured: true, model: "vercel-ai-gateway:openai/gpt-image-2", fallbackModel: "vercel-ai-gateway:bfl/flux-2-pro", key: { ok: true, source: "vault" }, retention: 50 });
    expect(JSON.stringify(status)).not.toContain(GATEWAY_KEY);

    const seen: any[] = [];
    const on = (p: any) => seen.push(p);
    orchestrator.on("media:generated", on);
    const r = await json(await api("/media/images", { body: { prompt: "A lighthouse at dawn", n: 2, size: "1024x1024" } }));
    orchestrator.off("media:generated", on);
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ kind: "generate", model: "vercel-ai-gateway:openai/gpt-image-2", costUsd: 0.042 });
    expect(r.data.images).toHaveLength(2);
    const call = gatewayCalls.at(-1)!;
    expect(call.url).toBe("https://ai-gateway.vercel.sh/v1/images/generations");
    expect(call.auth).toBe(`Bearer ${GATEWAY_KEY}`);
    expect(call.body).toMatchObject({ model: "openai/gpt-image-2", prompt: "A lighthouse at dawn", n: 2, size: "1024x1024", response_format: "b64_json" });
    expect(seen).toEqual([expect.objectContaining({ id: r.data.id, caller: "api", status: "ok", images: 2 })]);

    const img = await api(`/media/images/${r.data.id}/1`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await img.arrayBuffer())).toEqual(PNG);
    expect((await api(`/media/images/${r.data.id}/7`)).status).toBe(404);
    expect((await api(`/media/images/${r.data.id}/0?download=1`)).headers.get("content-disposition")).toContain(`${r.data.id}-0.png`);

    const log = (await json(await api("/media/images"))).data;
    expect(log.entries[0]).toMatchObject({ id: r.data.id, caller: { kind: "api" }, prompt: "A lighthouse at dawn", size: "1024x1024", n: 2 });
    expect((await json(await api(`/media/images/${r.data.id}`))).data.assets).toHaveLength(2);
    expect((await api("/media/images/img_000000000000")).status).toBe(404);
    expect((await json(await api("/media/images", { body: { prompt: "" } }))).code).toBe("INVALID");
    expect((await json(await api("/media/nodes"))).data).toEqual([]);

    // the gateway's cost is model usage (source "image")
    const usage = (await json(await api("/token-usage"))).data;
    expect(usage).toMatchObject({ cost: 0.042, calls: 1, inputTokens: 20, outputTokens: 1000 });
  }, 30_000);

  test("edits: POST /media/images/edits with an earlier image", async () => {
    const first = (await json(await api("/media/images", { body: { prompt: "base" } }))).data;
    const r = await json(await api("/media/images/edits", { body: { image: { mediaId: first.id, index: 0 }, prompt: "make it night" } }));
    expect(r.ok).toBe(true);
    expect(gatewayCalls.at(-1)!.url).toBe("https://ai-gateway.vercel.sh/v1/images/edits");
    expect(gatewayCalls.at(-1)!.body.images[0].image_url.startsWith("data:image/png;base64,")).toBe(true);
    expect((await json(await api(`/media/images/${r.data.id}`))).data).toMatchObject({ kind: "edit", inputs: [`media ${first.id}#0`] });
  }, 30_000);
});

describe("media over MCP (on the real instance)", () => {
  const mcp = (scopes: string[]) => {
    const deps: McpDeps = {
      version: "x", toolsets: ["all"], principal: { kind: "oauth", actor: "ada@example.com via Claude", scopes },
      api: async (method, path, body) => {
        const res = await app.request(path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
        const type = res.headers.get("content-type") ?? "";
        if (type.startsWith("image/")) {
          const bytes = new Uint8Array(await res.arrayBuffer());
          return { status: res.status, body: undefined, headers: res.headers, bytes };
        }
        return { status: res.status, body: await res.json(), headers: res.headers };
      },
    };
    const rpc = (method: string, params: Record<string, unknown>) => handleMcpRequest(new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }), deps).then(async (res) => (await res.json()).result);
    return { call: (name: string, args: Record<string, unknown>) => rpc("tools/call", { name, arguments: args }), list: () => rpc("tools/list", {}) };
  };

  test("read sees the log, the status and the card; work generates; the card carries the previews", async () => {
    const names = async (scopes: string[]) => ((await mcp(scopes).list()).tools as Array<{ name: string }>).map((t) => t.name).filter((n) => n.startsWith("polpo_image") || n.startsWith("polpo_media"));
    expect((await names(["polpo:read"])).sort()).toEqual(["polpo_image_show", "polpo_media_log", "polpo_media_status"]);
    expect((await names(["polpo:work"])).sort()).toEqual(["polpo_image_edit", "polpo_image_generate", "polpo_image_show", "polpo_media_log", "polpo_media_status"]);

    const work = mcp(["polpo:work"]);
    const r = await work.call("polpo_image_generate", { prompt: "A fox in the snow" });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("image 0:");
    const id = r.structuredContent.id as string;

    const read = mcp(["polpo:read"]);
    const log = await read.call("polpo_media_log", {});
    expect(log.content[0].text).toContain(id);
    const one = await read.call("polpo_media_log", { id });
    expect(one.content[0].text).toContain("prompt: A fox in the snow");
    expect(one.content[0].text).toContain("asked by: api"); // this test's MCP deps call the API with a plain key
    expect((await read.call("polpo_media_status", {})).content[0].text).toContain("image model: vercel-ai-gateway:openai/gpt-image-2");
    const card = await read.call("polpo_image_show", { id });
    expect(card.structuredContent).toMatchObject({ kind: "image", entry: { id, prompt: "A fox in the snow", images: [{ index: 0, src: expect.stringMatching(/^data:image\/(webp|png);base64,/) }] } });
    expect(card.content[0].text).toContain("prompt: A fox in the snow");
    expect((await read.call("polpo_image_show", {})).structuredContent.kind).toBe("media");
  }, 30_000);
});
