/**
 * The agents' image tools: thin wrappers over the media primitive (src/media/service.ts).
 *
 *   image_generate  a prompt (and reference images) → images, saved as instance assets with their
 *                   provenance in the media log and copied to the agent's `path`
 *   image_edit      change an image of the workspace (optionally inside a mask) → the same
 *   image_analyze   look at an image of the workspace: a turn of the chat pipeline with the image
 *                   attached (the agent's own model, or the one asked for), without tools
 *   video_generate  unchanged (video-tools.ts): the next media type, same shape later
 *
 * No provider is called from here: the model, the gateway and its key are the instance's
 * (settings.imageModel through the shared gateway resolver), every call is in the media log with the
 * agent (and its task) as caller and its cost recorded as model usage. Given with the tool's name in
 * the agent's allowedTools (or image_*), as before.
 */

import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { FileSystem } from "@polpo-ai/core/filesystem";
import { sniffImageMime, type ImageInput, type MediaCaller } from "@polpo-ai/core/media";
import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { resolveAllowedPaths, assertPathAllowed, TOOL_PATH_HINT } from "./path-sandbox.js";
import { readBytes, toolFs, writeBytes } from "./tool-fs.js";
import type { ResolvedVault } from "../vault/index.js";
import { mediaServiceFor, type MediaResult, type MediaService } from "../media/service.js";
import { createVideoGenerateTool } from "./video-tools.js";

type ToolResult = AgentToolResult<any>;

const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB

const EXT_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};

/** Where the agent's image tools reach the media service and who they act for. */
export interface ImageToolsContext {
  polpoDir?: string;
  agent?: string;
  taskId?: string;
  missionId?: string;
  sessionId?: string;
}

const errorResult = (text: string, details: Record<string, unknown> = {}): ToolResult => ({ content: [{ type: "text", text }], details: { error: true, ...details } });

function serviceOf(ctx: ImageToolsContext): MediaService | undefined {
  return ctx.polpoDir ? mediaServiceFor(ctx.polpoDir) : undefined;
}

function callerOf(ctx: ImageToolsContext): MediaCaller {
  return {
    kind: "agent", ...(ctx.agent ? { id: ctx.agent } : {}), ...(ctx.taskId ? { taskId: ctx.taskId, label: `task ${ctx.taskId}` } : {}),
    ...(ctx.missionId ? { missionId: ctx.missionId } : {}), ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
  };
}

/**
 * The model asked for: "gateway:provider/model" or "provider/model" go to the media service; the old
 * fal.ai ids ("fal-ai/flux/dev"…) are no longer called directly: the instance's image model answers.
 */
function modelParam(model: string | undefined): { model?: string; note?: string } {
  if (!model?.trim()) return {};
  if (/^fal-ai\//.test(model.trim())) return { note: `The fal.ai model "${model}" is no longer called directly: the instance's image model was used (Settings → Media).` };
  return { model: model.trim() };
}

/** An image of the workspace as inline bytes for the media service. */
async function workspaceImage(fs: FileSystem, file: string): Promise<{ base64: string; mimeType: string }> {
  const bytes = await readBytes(fs, file);
  if (bytes.byteLength > MAX_IMAGE_SIZE) throw new Error(`Image file too large: ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB (max ${MAX_IMAGE_SIZE / 1024 / 1024} MB)`);
  const mimeType = sniffImageMime(new Uint8Array(bytes)) ?? EXT_MIME[extname(file).toLowerCase()] ?? "image/png";
  return { base64: Buffer.from(bytes).toString("base64"), mimeType };
}

/** The output files: path for the first image, path-2, path-3… for the next (with each image's own extension). */
function outputPaths(filePath: string, result: MediaResult): string[] {
  const ext = extname(filePath);
  const stem = ext ? filePath.slice(0, -ext.length) : filePath;
  return result.images.map((img, i) => {
    const own = `.${img.path.split(".").pop() ?? "png"}`;
    const wanted = ext && (EXT_MIME[ext.toLowerCase()] === img.mimeType) ? ext : own;
    return i === 0 ? `${stem}${wanted}` : `${stem}-${i + 1}${wanted}`;
  });
}

/** Copy the result's images to the agent's workspace and describe them. */
async function deliver(fs: FileSystem, filePath: string, result: MediaResult, note?: string): Promise<ToolResult> {
  const paths = outputPaths(filePath, result);
  for (const [i, img] of result.images.entries()) {
    await writeBytes(fs, paths[i], readFileSync(img.file));
  }
  const lines = [
    ...result.images.map((img, i) => `Image saved: ${paths[i]} (${(img.bytes / 1024).toFixed(1)} KB${img.width && img.height ? `, ${img.width}x${img.height}` : ""})`),
    `Model: ${result.model}${result.usedFallback ? " (fallback)" : ""} · cost $${result.costUsd.toFixed(4)} · media ${result.id}`,
    ...(result.warnings.length ? [`Warnings: ${result.warnings.join("; ")}`] : []),
    ...(note ? [note] : []),
  ];
  const first = result.images[0];
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      provider: "media", model: result.model, mediaId: result.id, path: paths[0], paths, bytes: first?.bytes,
      ...(first?.width && first?.height ? { size: `${first.width}x${first.height}` } : {}), costUsd: result.costUsd,
    },
  };
}

// ─── Tool: image_generate ───

const ImageGenerateSchema = Type.Object({
  prompt: Type.String({ description: "Text prompt describing the image to generate" }),
  path: Type.String({ description: "Output file path (e.g. 'output.png'). Several images: output.png, output-2.png…" }),
  model: Type.Optional(Type.String({ description: "Another image model than the instance's: 'gateway:provider/model' (e.g. 'vercel-ai-gateway:bfl/flux-2-pro'). Default: Settings → Media." })),
  size: Type.Optional(Type.String({ description: "Image size as 'WIDTHxHEIGHT' (e.g. '1024x1024', '1536x1024'). Default: the model's." })),
  n: Type.Optional(Type.Number({ description: "How many variants (default 1)." })),
  seed: Type.Optional(Type.Number({ description: "Random seed for reproducible results (models that support it)." })),
  reference_images: Type.Optional(Type.Array(Type.String(), { description: "Image files of the workspace the result should follow (style, subject)." })),
  num_inference_steps: Type.Optional(Type.Number({ description: "Deprecated (fal.ai only): ignored." })),
  guidance_scale: Type.Optional(Type.Number({ description: "Deprecated (fal.ai only): ignored." })),
});

function createGenerateTool(cwd: string, sandbox: string[], fs: FileSystem, ctx: ImageToolsContext): AgentTool<typeof ImageGenerateSchema> {
  return {
    name: "image_generate",
    label: "Generate Image",
    description: "Generate images from a text prompt with the instance's image model (Settings → Media). "
      + "The images are kept as assets with their provenance (Media page) and saved to `path` in your workspace. "
      + "Optional reference_images (workspace files) guide style or subject. " + TOOL_PATH_HINT,
    parameters: ImageGenerateSchema,
    async execute(_id, params) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "image_generate");
      const service = serviceOf(ctx);
      if (!service) return errorResult("Image generation error: the media service is not available on this server");
      try {
        const refs: ImageInput[] = [];
        for (const p of params.reference_images ?? []) {
          const f = resolve(cwd, p);
          assertPathAllowed(f, sandbox, "image_generate");
          refs.push(await workspaceImage(fs, f));
        }
        const m = modelParam(params.model);
        const result = await service.generateImage({
          prompt: params.prompt, ...(params.size ? { size: params.size } : {}), ...(params.n ? { n: params.n } : {}),
          ...(params.seed !== undefined ? { seed: params.seed } : {}), ...(m.model ? { model: m.model } : {}), ...(refs.length ? { referenceImages: refs } : {}),
        }, callerOf(ctx));
        return await deliver(fs, filePath, result, m.note);
      } catch (err: any) {
        return errorResult(`Image generation error: ${err.message}`, { message: err.message });
      }
    },
  };
}

// ─── Tool: image_edit ───

const ImageEditSchema = Type.Object({
  image: Type.Union([Type.String(), Type.Array(Type.String())], { description: "The image file to change (or several to compose), in your workspace" }),
  prompt: Type.String({ description: "What to change, e.g. 'Add a watercolor effect'" }),
  path: Type.String({ description: "Output file path (e.g. 'edited.png')" }),
  mask: Type.Optional(Type.String({ description: "A mask image file: its transparent areas mark the region to replace (same size as the image)" })),
  model: Type.Optional(Type.String({ description: "Another image model than the instance's: 'gateway:provider/model' (it must take image inputs)." })),
  size: Type.Optional(Type.String({ description: "Output size 'WIDTHxHEIGHT'" })),
  n: Type.Optional(Type.Number({ description: "How many variants (default 1)." })),
});

function createEditTool(cwd: string, sandbox: string[], fs: FileSystem, ctx: ImageToolsContext): AgentTool<typeof ImageEditSchema> {
  return {
    name: "image_edit",
    label: "Edit Image",
    description: "Change an image of your workspace with a prompt (or compose several images), optionally inside a mask, with the instance's image model "
      + "(it must take image inputs, e.g. openai/gpt-image-2). The result is kept as an asset (Media page) and saved to `path`. " + TOOL_PATH_HINT,
    parameters: ImageEditSchema,
    async execute(_id, params) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "image_edit");
      const service = serviceOf(ctx);
      if (!service) return errorResult("Image edit error: the media service is not available on this server");
      try {
        const read = async (p: string) => { const f = resolve(cwd, p); assertPathAllowed(f, sandbox, "image_edit"); return workspaceImage(fs, f); };
        const sources = await Promise.all((Array.isArray(params.image) ? params.image : [params.image]).map(read));
        const mask = params.mask ? await read(params.mask) : undefined;
        const m = modelParam(params.model);
        const result = await service.editImage({
          image: sources.length === 1 ? sources[0] : sources, prompt: params.prompt, ...(mask ? { mask } : {}),
          ...(params.size ? { size: params.size } : {}), ...(params.n ? { n: params.n } : {}), ...(m.model ? { model: m.model } : {}),
        }, callerOf(ctx));
        return await deliver(fs, filePath, result, m.note);
      } catch (err: any) {
        return errorResult(`Image edit error: ${err.message}`, { message: err.message });
      }
    },
  };
}

// ─── Tool: image_analyze ───

const ImageAnalyzeSchema = Type.Object({
  path: Type.String({ description: "Path to the image file to analyze (on a remote computer: a file of that computer, e.g. /home/…, /tmp/…, /volumes/<name>/…)" }),
  prompt: Type.Optional(Type.String({ description: "Question or instruction about the image (default: 'Describe this image in detail')" })),
  provider: Type.Optional(Type.String({ description: "With model: the model's provider (e.g. openai, anthropic). Default: your own model." })),
  model: Type.Optional(Type.String({ description: "A vision-capable model to look with ('provider:model', or a model of `provider`). Default: your own model." })),
  max_tokens: Type.Optional(Type.Number({ description: "Deprecated: ignored (the chat's limits apply)." })),
});

function createAnalyzeTool(cwd: string, sandbox: string[], fs: FileSystem, ctx: ImageToolsContext): AgentTool<typeof ImageAnalyzeSchema> {
  return {
    name: "image_analyze",
    label: "Analyze Image",
    description: "Look at an image of your workspace and answer about it: describe it, read its text (OCR), answer questions, read charts. "
      + "It is a chat turn with the image attached, with your own model by default (it must see images) or a vision model you name. " + TOOL_PATH_HINT,
    parameters: ImageAnalyzeSchema,
    async execute(_id, params) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "image_analyze");
      let image: { base64: string; mimeType: string };
      try {
        image = await workspaceImage(fs, filePath);
      } catch (err: any) {
        return errorResult(`Error reading image file: ${err.message}`, { message: "file_read_error" });
      }
      const service = serviceOf(ctx);
      if (!service) return errorResult("Image analysis error: the media service is not available on this server");
      const model = params.model?.trim() ? (params.model.includes(":") ? params.model.trim() : `${params.provider ?? "openai"}:${params.model.trim()}`) : undefined;
      try {
        const r = await service.analyzeImage({
          prompt: params.prompt ?? "Describe this image in detail.", image: { data: image.base64, mimeType: image.mimeType },
          ...(model ? { model } : {}), ...(ctx.agent && !model ? { agent: ctx.agent } : {}),
        });
        return {
          content: [{ type: "text", text: r.text }],
          details: { provider: "chat", ...(r.model ? { model: r.model } : {}), path: filePath, imageSize: Buffer.from(image.base64, "base64").byteLength, ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}) },
        };
      } catch (err: any) {
        return errorResult(`Image analysis error: ${err.message}`, { message: err.message });
      }
    },
  };
}

// ─── Factory ───

export type ImageToolName = "image_generate" | "image_edit" | "image_analyze" | "video_generate";

export const ALL_IMAGE_TOOL_NAMES: ImageToolName[] = ["image_generate", "image_edit", "image_analyze", "video_generate"];

/**
 * Create the image tools (and video_generate).
 *
 * @param cwd - Working directory for resolving file paths
 * @param allowedPaths - Sandbox paths for file validation
 * @param allowedTools - Optional filter — only include tools whose names appear here (wildcards expanded upstream).
 * @param vault - The agent's vault (video_generate's fal.ai key).
 * @param fs - Where images are read and saved (default: this machine's disk).
 * @param ctx - The media service's .polpo directory and who the tools act for (agent, task, mission, chat).
 */
export function createImageTools(
  cwd: string,
  allowedPaths?: string[],
  allowedTools?: string[],
  vault?: ResolvedVault,
  fs?: FileSystem,
  ctx: ImageToolsContext = {},
): AgentTool<any>[] {
  const sandbox = resolveAllowedPaths(cwd, allowedPaths);
  const _fs = toolFs(fs);

  const factories: Record<ImageToolName, () => AgentTool<any>> = {
    image_generate: () => createGenerateTool(cwd, sandbox, _fs, ctx),
    image_edit: () => createEditTool(cwd, sandbox, _fs, ctx),
    image_analyze: () => createAnalyzeTool(cwd, sandbox, _fs, ctx),
    video_generate: () => createVideoGenerateTool(cwd, sandbox, _fs, vault),
  };

  const names = allowedTools
    ? ALL_IMAGE_TOOL_NAMES.filter(n => allowedTools.some(a => a.toLowerCase() === n))
    : ALL_IMAGE_TOOL_NAMES;

  return names.map(n => factories[n]());
}

