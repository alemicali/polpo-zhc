/**
 * Media: image generation and editing (the media primitive, docs/media.md).
 *
 *   POST /api/v1/media/images                 { prompt, size?, n?, model?, referenceImages?, seed? } → the images (saved as assets)
 *   POST /api/v1/media/images/edits           { image, prompt, mask?, size?, n?, model? } → the images
 *   GET  /api/v1/media/images                 the media log: ?limit&cursor&caller&callerId&status&kind
 *   GET  /api/v1/media/images/{id}            one request with its provenance and images
 *   GET  /api/v1/media/images/{id}/{index}    an image's bytes (?thumb=1: the preview; ?download=1)
 *   GET  /api/v1/media/status                 what is configured (model, gateway, fallback, where the key is: never the key)
 *   GET  /api/v1/media/nodes                  missions' image nodes (generating, done, failed)
 */
import { readFileSync } from "node:fs";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { ImageNodeState, MediaCaller } from "@polpo-ai/core";
import { currentEventOrigin } from "../../core/events.js";
import { MediaError, type MediaService } from "../../media/service.js";

export interface MediaRouteDeps {
  service: () => MediaService | undefined;
  nodes: () => ImageNodeState[];
}

// ── Schemas (OpenAPI) ─────────────────────────────────────────────────

const imageInputSchema = z.union([
  z.string().openapi({ description: "An https URL, a data: URL, a media image (img_…#index) or a file path of the project / .polpo" }),
  z.object({ base64: z.string(), mimeType: z.string().optional() }),
  z.object({ url: z.string() }),
  z.object({ mediaId: z.string(), index: z.number().int().optional() }),
  z.object({ path: z.string() }),
]).openapi("ImageInput");
const commonFields = {
  prompt: z.string().openapi({ example: "A lighthouse at dawn, watercolor" }),
  size: z.string().optional().openapi({ description: "WIDTHxHEIGHT (e.g. 1024x1024) or auto", example: "1024x1024" }),
  n: z.number().int().min(1).max(10).optional().openapi({ description: "How many variants (default 1; at most settings.media.maxImages)" }),
  model: z.string().optional().openapi({ description: "Another model than settings.imageModel: gateway:provider/model", example: "vercel-ai-gateway:bfl/flux-2-pro" }),
  providerOptions: z.record(z.string(), z.unknown()).optional().openapi({ description: "Passed to the gateway as is (e.g. { blackForestLabs: { outputFormat: \"jpeg\" } })" }),
};
const generateSchema = z.object({
  ...commonFields,
  referenceImages: z.array(imageInputSchema).optional().openapi({ description: "Images the result should follow (up to 16): the request goes to the gateway's edits endpoint" }),
  seed: z.number().int().optional(),
}).openapi("GenerateImageRequest");
const editSchema = z.object({
  ...commonFields,
  image: z.union([imageInputSchema, z.array(imageInputSchema)]).openapi({ description: "The image to change, or several to compose" }),
  mask: imageInputSchema.optional().openapi({ description: "Transparent areas mark the region to replace (same size as the image)" }),
}).openapi("EditImageRequest");
const usageSchema = z.object({ inputTokens: z.number().optional(), outputTokens: z.number().optional(), images: z.number().optional() });
const assetShape = {
  index: z.number(), path: z.string().openapi({ description: "Relative to the .polpo folder" }), mimeType: z.string(), bytes: z.number(),
  width: z.number().optional(), height: z.number().optional(), sha256: z.string(), revisedPrompt: z.string().optional(), thumbPath: z.string().optional(),
};
const assetSchema = z.object(assetShape).openapi("MediaAsset");
const resultSchema = z.object({
  id: z.string(), kind: z.enum(["generate", "edit"]), model: z.string(), usedFallback: z.boolean(), costUsd: z.number(), latencyMs: z.number(), warnings: z.array(z.string()),
  images: z.array(z.object({ ...assetShape, file: z.string(), url: z.string().openapi({ description: "GET it (authenticated)" }) })),
}).openapi("MediaResult");
const callerKinds = ["api", "mcp", "chat", "agent", "mission", "playground"] as const;
const callerSchema = z.object({
  kind: z.enum(callerKinds), id: z.string().optional(), label: z.string().optional(), by: z.string().optional(),
  taskId: z.string().optional(), missionId: z.string().optional(), sessionId: z.string().optional(), triggerId: z.string().optional(),
});
const entrySchema = z.object({
  id: z.string(), at: z.string(), kind: z.enum(["generate", "edit"]), caller: callerSchema, status: z.enum(["ok", "error"]), error: z.string().optional(),
  model: z.string(), gateway: z.string().optional(), usedFallback: z.boolean().optional(), prompt: z.string(), promptTruncated: z.boolean().optional(),
  size: z.string().optional(), n: z.number(), seed: z.number().optional(), inputs: z.array(z.string()).optional(), latencyMs: z.number(), costUsd: z.number(),
  usage: usageSchema, warnings: z.array(z.string()).optional(), assets: z.array(assetSchema),
}).openapi("MediaLogEntry");
const statusSchema = z.object({
  configured: z.boolean(), model: z.string().optional(), gateway: z.object({ id: z.string(), label: z.string() }).optional(), fallbackModel: z.string().optional(),
  key: z.object({ ok: z.boolean(), source: z.enum(["vault", "env"]).optional(), detail: z.string() }).optional(), error: z.string().optional(),
  maxImages: z.number(), retention: z.number(), retentionDays: z.number(), analysis: z.literal("chat"),
  gateways: z.array(z.object({ id: z.string(), label: z.string(), envVar: z.string(), docsUrl: z.string().optional() })),
}).openapi("MediaStatus");
const nodeSchema = z.object({
  group: z.string(), missionId: z.string().optional(), node: z.string(), status: z.enum(["generating", "done", "failed"]),
  mediaId: z.string().optional(), files: z.array(z.string()).optional(), error: z.string().optional(), startedAt: z.string(), finishedAt: z.string().optional(),
}).openapi("ImageNodeState");

const errorSchema = z.object({ ok: z.literal(false), error: z.string(), code: z.string().optional(), details: z.array(z.string()).optional() });
const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const okOf = <T extends z.ZodTypeAny>(schema: T) => z.object({ ok: z.literal(true), data: schema });
const body = <T extends z.ZodTypeAny>(schema: T) => ({ body: { content: { "application/json": { schema } } } });
const failures = {
  400: json(errorSchema, "Invalid request"), 409: json(errorSchema, "No image model (or its key) is configured"),
  429: json(errorSchema, "The gateway is rate limiting"), 502: json(errorSchema, "The image model failed"), 503: json(errorSchema, "Not available"),
  504: json(errorSchema, "The image model was too slow"),
};

/** Who asked, from the request's origin (MCP and Polpo's chat tools come through the same API). */
function callerOf(sessionId?: string): MediaCaller {
  const o = currentEventOrigin();
  const kind: MediaCaller["kind"] = o?.scopes ? "mcp" : o?.source === "polpo" ? "chat" : o?.source === "agent" ? "agent" : "api";
  return { kind, ...(o?.by ? { by: o.by } : {}), ...(sessionId ? { sessionId } : {}) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each route's own response union
async function guard(c: any, fn: () => Promise<Response> | Response): Promise<any> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MediaError) return c.json({ ok: false, error: err.message, code: err.code, ...(err.problems ? { details: err.problems } : {}) }, err.status);
    throw err;
  }
}

export function mediaRoutes(deps: MediaRouteDeps): OpenAPIHono {
  const app = new OpenAPIHono();
  const need = () => {
    const s = deps.service();
    if (!s) throw new MediaError("Polpo is not initialized", 503, "UNAVAILABLE");
    return s;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const session = (c: any): string | undefined => c.req.header("x-session-id") || undefined;

  app.openapi(createRoute({
    method: "post", path: "/images", tags: ["Media"], summary: "Generate images",
    description: "Generate images from a prompt with the image model (settings.imageModel, e.g. vercel-ai-gateway:openai/gpt-image-2) through the shared gateway resolver: "
      + "Vercel AI Gateway's OpenAI-compatible Images API. With referenceImages the request goes to its edits endpoint. The fallback model (settings.media.fallbackModel) "
      + "is tried once when the model fails. Every image is saved as an asset with its provenance in the media log; the cost is recorded as model usage (source image). "
      + "Without an image model: 409 with a link to Settings → Media.",
    request: body(generateSchema),
    responses: { 200: json(okOf(resultSchema), "The images"), ...failures },
  }), (c) => guard(c, async () => c.json({ ok: true as const, data: await need().generateImage(c.req.valid("json"), callerOf(session(c))) }, 200)));

  app.openapi(createRoute({
    method: "post", path: "/images/edits", tags: ["Media"], summary: "Edit an image",
    description: "Change an image (or compose several) with a prompt, optionally inside a mask: the gateway's edits endpoint (models that take image inputs, e.g. openai/gpt-image-2, bfl/flux-kontext-pro).",
    request: body(editSchema),
    responses: { 200: json(okOf(resultSchema), "The images"), ...failures },
  }), (c) => guard(c, async () => c.json({ ok: true as const, data: await need().editImage(c.req.valid("json"), callerOf(session(c))) }, 200)));

  app.openapi(createRoute({
    method: "get", path: "/images", tags: ["Media"], summary: "The media log",
    description: "Every image request (who asked and from where, the prompt, the model, the size, the seed, the cost, its images), newest first.",
    request: {
      query: z.object({
        limit: z.string().optional(), cursor: z.string().optional(), caller: z.enum(callerKinds).optional(), callerId: z.string().optional(),
        status: z.enum(["ok", "error"]).optional(), kind: z.enum(["generate", "edit"]).optional(),
      }),
    },
    responses: { 200: json(okOf(z.object({ entries: z.array(entrySchema), nextCursor: z.string().optional(), total: z.number() })), "A page of the log") },
  }), (c) => guard(c, () => {
    const q = c.req.valid("query");
    return c.json({
      ok: true as const,
      data: need().store.list({
        ...(q.limit ? { limit: Number(q.limit) || 50 } : {}), ...(q.cursor ? { cursor: q.cursor } : {}), ...(q.caller ? { caller: q.caller } : {}),
        ...(q.callerId ? { callerId: q.callerId } : {}), ...(q.status ? { status: q.status } : {}), ...(q.kind ? { kind: q.kind } : {}),
      }),
    }, 200);
  }));

  app.openapi(createRoute({
    method: "get", path: "/status", tags: ["Media"], summary: "Media status",
    description: "The image model, its gateway, the fallback, where the gateway's key comes from (a vault entry or the env var; never the key) and whether it resolves, the limits and the log's retention.",
    responses: { 200: json(okOf(statusSchema), "Status") },
  }), (c) => guard(c, async () => c.json({ ok: true as const, data: await need().status() }, 200)));

  app.openapi(createRoute({
    method: "get", path: "/nodes", tags: ["Media"], summary: "Mission image nodes",
    description: "Missions' image nodes of the runs in progress: generating, done (the media entry and files) or failed.",
    responses: { 200: json(okOf(z.array(nodeSchema)), "Nodes") },
  }), (c) => guard(c, () => c.json({ ok: true as const, data: deps.nodes() }, 200)));

  app.openapi(createRoute({
    method: "get", path: "/images/{id}", tags: ["Media"], summary: "One image request",
    request: { params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) }) },
    responses: { 200: json(okOf(entrySchema), "The request"), 404: json(errorSchema, "No such request (or no longer kept)") },
  }), (c) => guard(c, () => {
    const id = c.req.valid("param").id;
    const e = need().store.get(id);
    if (!e) throw new MediaError(`No image request "${id}" (or no longer kept)`, 404, "NOT_FOUND");
    return c.json({ ok: true as const, data: e }, 200);
  }));

  app.openapi(createRoute({
    method: "get", path: "/images/{id}/{index}", tags: ["Media"], summary: "An image's bytes",
    request: {
      params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }), index: z.string().openapi({ param: { name: "index", in: "path" } }) }),
      query: z.object({ thumb: z.string().optional().openapi({ description: "1: the preview (webp, 512 px), when there is one" }), download: z.string().optional() }),
    },
    responses: { 200: { description: "The image", content: { "image/png": { schema: z.any() } } }, 404: json(errorSchema, "No such image") },
  }), (c) => guard(c, () => {
    const { id, index } = c.req.valid("param");
    const q = c.req.valid("query");
    const f = /^\d+$/.test(index) ? need().imageFile(id, Number(index), { thumb: q.thumb === "1" }) : undefined;
    if (!f) throw new MediaError(`No image ${id}/${index}`, 404, "NOT_FOUND");
    let bytes: Buffer;
    try { bytes = readFileSync(f.file); } catch { throw new MediaError(`No image ${id}/${index}`, 404, "NOT_FOUND"); }
    const ext = f.mimeType.split("/")[1] === "jpeg" ? "jpg" : f.mimeType.split("/")[1];
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "content-type": f.mimeType, "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff",
        ...(q.download ? { "content-disposition": `attachment; filename="${id}-${index}.${ext}"` } : {}),
      },
    });
  }));

  return app;
}
