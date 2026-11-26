/**
 * The media primitive: request mapping and response parsing (Vercel AI Gateway's OpenAI-compatible
 * Images API) through the shared gateway resolver, settings and the fallback model, provenance and
 * storage of every image, the media log with its retention, cost recorded as model usage, the
 * agents' image tools as thin wrappers (backward compatible params, image_analyze as a chat turn),
 * and a guard: the image tools no longer call any provider themselves. All calls are mocked.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MediaError, imageEditBody, imageGenerationBody, missionImageProblems, normalizeMediaSettings, parseImageModel, parseImagesResponse, renderImageNodePrompt,
  sniffImageMime, validateEditImageInput, validateGenerateImageInput, type PolpoSettings,
} from "@polpo-ai/core";
import { MediaService, registerMediaService, type MediaServiceDeps } from "../media/service.js";
import { createImageTools } from "../tools/image-tools.js";

/** A 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const GATEWAY_KEY = "vck_media_test_secret";

describe("core: settings, validation, wire shape", () => {
  test("image model: gateway:provider/model, a bare provider/model goes to Vercel AI Gateway", () => {
    expect(parseImageModel("vercel-ai-gateway:openai/gpt-image-2")).toEqual({ gateway: "vercel-ai-gateway", model: "openai/gpt-image-2" });
    expect(parseImageModel("bfl/flux-2-pro")).toEqual({ gateway: "vercel-ai-gateway", model: "bfl/flux-2-pro" });
    expect(parseImageModel(undefined)).toBeUndefined();
    expect(() => parseImageModel("vercel-ai-gateway:")).toThrow(MediaError);
    expect(normalizeMediaSettings({ fallbackModel: "bfl/flux-2-pro", maxImages: 50, retention: 0, retentionDays: 7, junk: 1, credentialRef: { owner: "polpo-infra", service: "vercel-ai-gateway" } }))
      .toEqual({ fallbackModel: "bfl/flux-2-pro", maxImages: 10, retentionDays: 7, credentialRef: { owner: "polpo-infra", service: "vercel-ai-gateway" } });
  });

  test("generate / edit requests are checked; reference images make an edit", () => {
    expect(validateGenerateImageInput({ prompt: "a cat" })).toMatchObject({ kind: "generate", prompt: "a cat", n: 1, images: [] });
    expect(validateGenerateImageInput({ prompt: "a cat", referenceImages: ["https://x.test/a.png", "img_abcdef123#1"] })).toMatchObject({
      kind: "edit", images: [{ url: "https://x.test/a.png" }, { mediaId: "img_abcdef123", index: 1 }],
    });
    try { validateGenerateImageInput({ prompt: "", size: "big", n: 9, seed: 1.5 }); throw new Error("no"); } catch (err) {
      expect((err as MediaError).problems).toEqual([
        "prompt is required", 'size must be "WIDTHxHEIGHT" (e.g. 1024x1024) or "auto"', "n must be a whole number from 1 to 4", "seed must be a whole number",
      ]);
    }
    expect(() => validateEditImageInput({ prompt: "x" })).toThrow(/image is required/);
    expect(validateEditImageInput({ prompt: "x", image: { base64: "AAAA" }, mask: { path: "m.png" } })).toMatchObject({ kind: "edit", mask: { path: "m.png" } });
  });

  test("the documented OpenAI-compatible bodies and the response (b64_json, usage, gateway cost)", () => {
    expect(imageGenerationBody("openai/gpt-image-2", { prompt: "p", n: 2, size: "1024x1024", seed: 7 }))
      .toEqual({ model: "openai/gpt-image-2", prompt: "p", n: 2, response_format: "b64_json", size: "1024x1024", seed: 7 });
    expect(imageGenerationBody("m", { prompt: "p", n: 1, size: "auto" })).not.toHaveProperty("size");
    expect(imageEditBody("m", { prompt: "p", n: 1 }, ["data:image/png;base64,AAA"], "https://x.test/mask.png"))
      .toEqual({ model: "m", prompt: "p", n: 1, response_format: "b64_json", images: [{ image_url: "data:image/png;base64,AAA" }], mask: { image_url: "https://x.test/mask.png" } });
    const r = parseImagesResponse({
      data: [{ b64_json: PNG.toString("base64"), revised_prompt: "a cat, watercolor" }, { url: "data:image/jpeg;base64,/9j/" }],
      usage: { input_tokens: 12, output_tokens: 3000 }, providerMetadata: { gateway: { cost: "0.04" } }, warnings: [{ type: "unsupported", feature: "seed" }],
    });
    expect(r).toMatchObject({ usage: { inputTokens: 12, outputTokens: 3000, images: 2 }, costUsd: 0.04, warnings: ["unsupported: seed"] });
    expect(r.images[0].revisedPrompt).toBe("a cat, watercolor");
    expect(r.images[1]).toMatchObject({ b64: "/9j/", mimeType: "image/jpeg" });
    expect(() => parseImagesResponse({ data: [] })).toThrow(/no image/);
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(JPEG)).toBe("image/jpeg");
  });

  test("image nodes: prompt template and problems", () => {
    expect(renderImageNodePrompt({ prompt: "Cover for: {{tasks.Write}}" }, [{ title: "Write", status: "done", result: { stdout: " Spring sale " } }])).toBe("Cover for: Spring sale");
    const titles = new Set(["Write", "Send"]);
    const deps = new Map([["Write", new Set<string>()], ["Send", new Set(["Write"])]]);
    expect(missionImageProblems({ name: "cover", afterTasks: ["Write"], prompt: "x", forTasks: ["Send"] }, titles, deps)).toEqual([]);
    expect(missionImageProblems({ name: "cover", afterTasks: ["Send"], prompt: "", forTasks: ["Write", "Nope"], size: "x" }, titles, deps)).toEqual([
      'image "cover": prompt is required', 'image "cover": an after task depends on "Write": the image could never be made',
      'image "cover": forTasks references unknown task "Nope"', 'image "cover": size must be "WIDTHxHEIGHT" or "auto"',
    ]);
  });
});

describe("the media service (mocked gateway)", () => {
  let dir: string;
  let settings: PolpoSettings;
  let env: Record<string, string | undefined>;
  const calls: Array<{ url: string; init: RequestInit; body: any }> = [];
  const usage: any[] = [];
  const events: any[] = [];
  let respond: (body: any, url: string) => Response;
  let service: MediaService;

  const fetchMock: typeof fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, init: init!, body });
    return respond(body, url);
  }) as typeof fetch;

  const make = (extra: Partial<MediaServiceDeps> = {}) => new MediaService({
    polpoDir: () => join(dir, ".polpo"), workDir: () => dir, settings: () => settings, vault: () => undefined, env: () => env, fetch: fetchMock,
    recordUsage: async (u) => { usage.push(u); }, emit: (p) => events.push(p),
    inspect: async () => ({ width: 1, height: 1, thumb: new Uint8Array([1, 2, 3]) }), ...extra,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polpo-media-"));
    mkdirSync(join(dir, ".polpo"), { recursive: true });
    settings = {} as PolpoSettings;
    env = { AI_GATEWAY_API_KEY: GATEWAY_KEY };
    calls.length = 0; usage.length = 0; events.length = 0;
    respond = (body) => new Response(JSON.stringify({
      data: Array.from({ length: body.n }, () => ({ b64_json: PNG.toString("base64") })), usage: { input_tokens: 10, output_tokens: 100 },
      providerMetadata: { gateway: { cost: 0.04 * body.n } },
    }), { status: 200 });
    service = make();
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("unconfigured: 409 with the Settings link, nothing called", async () => {
    await expect(service.generateImage({ prompt: "a cat" }, { kind: "api" })).rejects.toMatchObject({ status: 409, code: "NOT_CONFIGURED", message: expect.stringContaining("/config?section=media") });
    expect(calls).toEqual([]);
    expect(await service.status()).toMatchObject({ configured: false, analysis: "chat", gateways: [{ id: "vercel-ai-gateway", envVar: "AI_GATEWAY_API_KEY" }] });
  });

  test("generate: POST /v1/images/generations through the resolver; images stored with provenance; usage and the log recorded", async () => {
    settings = { imageModel: "vercel-ai-gateway:openai/gpt-image-2" } as PolpoSettings;
    const r = await service.generateImage({ prompt: "a lighthouse", n: 2, size: "1024x1024", seed: 3 }, { kind: "agent", id: "writer", taskId: "t1", missionId: "m1" });
    const call = calls[0];
    expect(call.url).toBe("https://ai-gateway.vercel.sh/v1/images/generations");
    expect((call.init.headers as Record<string, string>).authorization).toBe(`Bearer ${GATEWAY_KEY}`);
    expect(call.init.redirect).toBe("error");
    expect(call.body).toEqual({ model: "openai/gpt-image-2", prompt: "a lighthouse", n: 2, response_format: "b64_json", size: "1024x1024", seed: 3 });
    expect(r).toMatchObject({ kind: "generate", model: "vercel-ai-gateway:openai/gpt-image-2", usedFallback: false, costUsd: 0.08 });
    expect(r.images).toHaveLength(2);
    for (const img of r.images) {
      expect(readFileSync(img.file)).toEqual(PNG);
      expect(img).toMatchObject({ mimeType: "image/png", width: 1, height: 1, url: `/api/v1/media/images/${r.id}/${img.index}` });
      expect(img.path).toMatch(new RegExp(`^media/images/${r.id}/${img.index}\\.png$`));
      expect(existsSync(join(dir, ".polpo", img.thumbPath!))).toBe(true);
    }
    const entry = service.store.get(r.id)!;
    expect(entry).toMatchObject({
      kind: "generate", status: "ok", prompt: "a lighthouse", size: "1024x1024", seed: 3, n: 2, costUsd: 0.08,
      caller: { kind: "agent", id: "writer", taskId: "t1", missionId: "m1" }, usage: { inputTokens: 10, outputTokens: 100, images: 2 },
    });
    expect(entry.assets[0].sha256).toHaveLength(64);
    expect(usage).toEqual([{ provider: "vercel-ai-gateway", model: "openai/gpt-image-2", inputTokens: 10, outputTokens: 100, cost: 0.08 }]);
    expect(events).toEqual([expect.objectContaining({ id: r.id, kind: "generate", caller: "agent", callerId: "writer", images: 2, status: "ok" })]);
    expect(service.imageFile(r.id, 0, { thumb: true })?.mimeType).toBe("image/webp");
    expect(JSON.stringify(entry)).not.toContain(GATEWAY_KEY);
  });

  test("reference images and edits go to /v1/images/edits as data: URLs (files, earlier images, inline)", async () => {
    settings = { imageModel: "vercel-ai-gateway:openai/gpt-image-2" } as PolpoSettings;
    writeFileSync(join(dir, "ref.jpg"), JPEG);
    const first = await service.generateImage({ prompt: "base" }, { kind: "api" });
    await service.generateImage({ prompt: "like these", referenceImages: [{ path: "ref.jpg" }, `${first.id}#0`] }, { kind: "api" });
    const ref = calls[1];
    expect(ref.url).toBe("https://ai-gateway.vercel.sh/v1/images/edits");
    expect(ref.body.images.map((i: any) => /^data:(image\/[a-z]+);base64,/.exec(i.image_url)?.[1])).toEqual(["image/jpeg", "image/png"]);
    const edit = await service.editImage({ image: { base64: PNG.toString("base64") }, prompt: "watercolor", mask: "https://x.test/mask.png" }, { kind: "mcp" });
    expect(calls[2].body).toMatchObject({ prompt: "watercolor", mask: { image_url: "https://x.test/mask.png" } });
    expect(service.store.get(edit.id)).toMatchObject({ kind: "edit", inputs: ["inline image (0 KB)", "mask: https://x.test/mask.png"] });
    await expect(service.generateImage({ prompt: "x", referenceImages: [{ path: "../outside.png" }] }, { kind: "api" })).rejects.toMatchObject({ status: 400 });
  });

  test("the fallback model answers when the image model fails; refusals keep their status; errors are logged without the key", async () => {
    settings = { imageModel: "vercel-ai-gateway:openai/gpt-image-2", media: { fallbackModel: "bfl/flux-2-pro" } } as PolpoSettings;
    const ok = respond;
    respond = (body, url) => body.model === "openai/gpt-image-2" ? new Response(JSON.stringify({ error: { message: `overloaded ${GATEWAY_KEY}` } }), { status: 503 }) : ok(body, url);
    const r = await service.generateImage({ prompt: "x" }, { kind: "api" });
    expect(calls.map((c) => c.body.model)).toEqual(["openai/gpt-image-2", "bfl/flux-2-pro"]);
    expect(r).toMatchObject({ model: "vercel-ai-gateway:bfl/flux-2-pro", usedFallback: true });
    expect(service.store.get(r.id)).toMatchObject({ usedFallback: true });

    respond = () => new Response(JSON.stringify({ error: { message: `slow down ${GATEWAY_KEY}` } }), { status: 429 });
    const err = await service.generateImage({ prompt: "y" }, { kind: "api" }).catch((e) => e);
    expect(err).toMatchObject({ status: 429, code: "UPSTREAM" });
    expect(err.message).not.toContain(GATEWAY_KEY);
    const failed = service.store.list({ status: "error" });
    expect(failed.total).toBe(1);
    expect(JSON.stringify(failed)).not.toContain(GATEWAY_KEY);
  });

  test("the key: the vault entry chosen in settings.media wins over the env var; a missing entry is a 409", async () => {
    settings = { imageModel: "openai/gpt-image-2", media: { credentialRef: { owner: "polpo-infra", service: "vercel-ai-gateway" }, credentialField: "token" } } as PolpoSettings;
    env = {};
    const vault = { get: async (o: string, s: string) => (o === "polpo-infra" && s === "vercel-ai-gateway" ? { type: "api_key", credentials: { token: "vck_from_vault" } } : undefined) };
    const s = make({ vault: () => vault as never });
    expect(await s.status()).toMatchObject({ configured: true, key: { ok: true, source: "vault", detail: "vault polpo-infra / vercel-ai-gateway (token)" } });
    await s.generateImage({ prompt: "x" }, { kind: "api" });
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer vck_from_vault");
    const none = make({ vault: () => ({ get: async () => undefined }) as never });
    await expect(none.generateImage({ prompt: "x" }, { kind: "api" })).rejects.toMatchObject({ status: 409 });
  });

  test("retention: the oldest entries go with their images", async () => {
    settings = { imageModel: "openai/gpt-image-2", media: { retention: 2 } } as PolpoSettings;
    const a = await service.generateImage({ prompt: "a" }, { kind: "api" });
    await service.generateImage({ prompt: "b" }, { kind: "api" });
    await service.generateImage({ prompt: "c" }, { kind: "api" });
    expect(service.store.list().entries.map((e) => e.prompt)).toEqual(["c", "b"]);
    expect(existsSync(service.store.imagesDir(a.id))).toBe(false);
  });
});

describe("the agents' image tools: thin wrappers", () => {
  let dir: string;
  let polpoDir: string;
  const visionTurn = vi.fn(async (req: { prompt: string; image: { data: string; mimeType: string }; model?: string; agent?: string }) => ({ text: `saw ${req.image.mimeType}`, model: "Polpo (m)", costUsd: 0.001 }));
  const calls: any[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polpo-media-tools-"));
    polpoDir = join(dir, ".polpo");
    mkdirSync(polpoDir, { recursive: true });
    calls.length = 0;
    visionTurn.mockClear();
    registerMediaService(polpoDir, new MediaService({
      polpoDir: () => polpoDir, workDir: () => dir, settings: () => ({ imageModel: "vercel-ai-gateway:openai/gpt-image-2" }) as PolpoSettings,
      vault: () => undefined, env: () => ({ AI_GATEWAY_API_KEY: GATEWAY_KEY }), inspect: async () => undefined, visionTurn,
      fetch: (async (url: any, init: any) => {
        const body = JSON.parse(init.body);
        calls.push({ url: String(url), body });
        return new Response(JSON.stringify({ data: Array.from({ length: body.n }, () => ({ b64_json: PNG.toString("base64") })) }));
      }) as typeof fetch,
    }));
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const tool = (tools: any[], name: string) => tools.find((t) => t.name === name)!;
  const text = (r: any) => r.content.map((c: any) => c.text).join("\n");

  test("image_generate keeps its params: path, size, seed, the old fal ids (the instance's model answers), and logs the agent and task", async () => {
    const tools = createImageTools(dir, undefined, ["image_generate"], undefined, undefined, { polpoDir, agent: "designer", taskId: "t9" });
    expect(tools.map((t) => t.name)).toEqual(["image_generate"]);
    const out = await tool(tools, "image_generate").execute("1", { prompt: "a fox", path: "art/fox.png", size: "512x512", seed: 4, n: 2, model: "fal-ai/flux/dev", guidance_scale: 3 });
    expect(text(out)).toContain("Image saved:");
    expect(text(out)).toContain("no longer called directly");
    expect(readFileSync(join(dir, "art/fox.png"))).toEqual(PNG);
    expect(readFileSync(join(dir, "art/fox-2.png"))).toEqual(PNG);
    expect(calls[0].body).toMatchObject({ model: "openai/gpt-image-2", prompt: "a fox", size: "512x512", seed: 4, n: 2 });
    expect(out.details).toMatchObject({ provider: "media", path: join(dir, "art/fox.png"), mediaId: expect.stringMatching(/^img_/) });
    const entry = mediaLog(polpoDir)[0];
    expect(entry.caller).toEqual({ kind: "agent", id: "designer", taskId: "t9", label: "task t9" });
    // the sandbox still applies
    await expect(tool(tools, "image_generate").execute("2", { prompt: "x", path: "/etc/x.png" })).rejects.toThrow();
  });

  test("image_edit reads the workspace image (and mask) and saves the result; only when allowed", async () => {
    expect(createImageTools(dir, undefined, ["image_generate"], undefined, undefined, { polpoDir }).map((t) => t.name)).not.toContain("image_edit");
    writeFileSync(join(dir, "in.png"), PNG);
    const tools = createImageTools(dir, undefined, ["image_edit"], undefined, undefined, { polpoDir, agent: "designer" });
    const out = await tool(tools, "image_edit").execute("1", { image: "in.png", mask: "in.png", prompt: "make it blue", path: "out.png" });
    expect(text(out)).toContain("Image saved:");
    expect(calls[0].url).toBe("https://ai-gateway.vercel.sh/v1/images/edits");
    expect(calls[0].body.images[0].image_url.startsWith("data:image/png;base64,")).toBe(true);
    expect(calls[0].body.mask.image_url.startsWith("data:image/png;base64,")).toBe(true);
    expect(existsSync(join(dir, "out.png"))).toBe(true);
  });

  test("image_analyze is a chat turn with the image: the agent's own model, or the one named (provider + model kept)", async () => {
    writeFileSync(join(dir, "pic.png"), PNG);
    const tools = createImageTools(dir, undefined, ["image_analyze"], undefined, undefined, { polpoDir, agent: "reader" });
    const out = await tool(tools, "image_analyze").execute("1", { path: "pic.png", prompt: "What is it?" });
    expect(text(out)).toBe("saw image/png");
    expect(visionTurn).toHaveBeenLastCalledWith({ prompt: "What is it?", image: { data: PNG.toString("base64"), mimeType: "image/png" }, agent: "reader" });
    await tool(tools, "image_analyze").execute("2", { path: "pic.png", provider: "anthropic", model: "claude-sonnet-4-5" });
    expect(visionTurn.mock.calls[1][0]).toMatchObject({ model: "anthropic:claude-sonnet-4-5", prompt: "Describe this image in detail." });
    expect(calls).toEqual([]); // no image model call
  });

  test("without the media service the tools say so instead of calling a provider", async () => {
    const tools = createImageTools(dir, undefined, ["image_generate"], undefined, undefined, { polpoDir: join(dir, "elsewhere") });
    expect(text(await tool(tools, "image_generate").execute("1", { prompt: "x", path: "x.png" }))).toContain("media service is not available");
  });
});

function mediaLog(polpoDir: string): any[] {
  return JSON.parse(readFileSync(join(polpoDir, "media", "index.json"), "utf-8")).entries;
}

describe("guard: no direct provider call for images", () => {
  test("the image tools and the media service never fetch a provider host themselves", () => {
    const tools = readFileSync(join(__dirname, "..", "tools", "image-tools.ts"), "utf-8");
    expect(tools).not.toMatch(/\bfetch\s*\(/);
    for (const host of ["fal.run", "api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com", "api.bfl.ai", "replicate.com"]) {
      expect(tools, host).not.toContain(host);
    }
    const service = readFileSync(join(__dirname, "..", "media", "service.ts"), "utf-8");
    // the only gateway URL is built by the resolver (gatewayUrl: allowed hosts, https)
    expect(service).toContain("gatewayUrl(g,");
    expect(service).not.toMatch(/https:\/\/[a-z0-9.-]+\.(ai|com|run|sh)\//i);
  });
});
