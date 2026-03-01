/**
 * Image & video tools for generation and vision/analysis.
 *
 * Provides agent capabilities to:
 * - Generate images from text prompts (image_generate) — via fal.ai
 * - Generate videos from text prompts (video_generate) — via fal.ai
 * - Analyze/describe images using vision models (image_analyze) — via OpenAI/Anthropic
 *
 * Architecture: direct fetch() to provider REST APIs — zero vendor SDK dependencies.
 *
 * Providers:
 *   Image generation: fal.ai (FLUX models — fal-ai/flux/dev default)
 *   Video generation: fal.ai (Wan 2.2 — fal-ai/wan/v2.2-1.3b/text-to-video default)
 *   Vision/analysis:  openai (gpt-4.1-mini), anthropic (Claude)
 *
 * Credential resolution order (same as email tools):
 *   1. Agent vault (per-agent credentials — e.g. service "fal" with key "key")
 *   2. Environment variables (global fallback)
 *
 * Environment variables (fallback):
 *   FAL_KEY             — fal.ai image/video generation
 *   OPENAI_API_KEY      — openai vision provider
 *   ANTHROPIC_API_KEY   — anthropic vision provider
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { resolveAllowedPaths, assertPathAllowed } from "./path-sandbox.js";
import type { ResolvedVault } from "../vault/index.js";

type ToolResult = AgentToolResult<any>;

// ─── Constants ───

const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB
const DEFAULT_TIMEOUT = 120_000; // 2 min for image generation
const VIDEO_TIMEOUT = 300_000; // 5 min for video generation
const FAL_QUEUE_POLL_INTERVAL = 3_000; // 3 sec polling for async queue

// ─── Helpers ───

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing environment variable: ${key}. Set it before using this tool.`);
  return val;
}

/** Resolve fal.ai API key: vault (service "fal-ai", key "key") > FAL_KEY env var. */
function resolveFalKey(vault?: ResolvedVault): string {
  const fromVault = vault?.getKey("fal-ai", "key");
  if (fromVault) return fromVault;
  return requireEnv("FAL_KEY");
}

function imageMime(ext: string): string {
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
  };
  return map[ext.toLowerCase()] ?? "image/png";
}

/**
 * Submit a request to fal.ai queue and poll until completion.
 * Uses the queue endpoint (POST https://queue.fal.run/<model>) for reliability,
 * then polls the status endpoint until the result is ready.
 */
async function falQueueRequest(
  modelId: string,
  input: Record<string, unknown>,
  apiKey: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

  try {
    // Submit to queue
    const submitResp = await fetch(`https://queue.fal.run/${modelId}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    });

    if (!submitResp.ok) {
      const errText = await submitResp.text();
      throw new Error(`fal.ai queue submit ${submitResp.status}: ${errText}`);
    }

    const queueData = await submitResp.json() as {
      request_id: string;
      status_url?: string;
      response_url?: string;
    };

    const requestId = queueData.request_id;
    const statusUrl = queueData.status_url ?? `https://queue.fal.run/${modelId}/requests/${requestId}/status`;
    const responseUrl = queueData.response_url ?? `https://queue.fal.run/${modelId}/requests/${requestId}`;

    // Poll for completion
    while (true) {
      await new Promise(r => setTimeout(r, FAL_QUEUE_POLL_INTERVAL));

      const statusResp = await fetch(statusUrl, {
        headers: { Authorization: `Key ${apiKey}` },
        signal: controller.signal,
      });

      if (!statusResp.ok) {
        throw new Error(`fal.ai status poll ${statusResp.status}`);
      }

      const status = await statusResp.json() as {
        status: string;
        error?: string;
      };

      if (status.status === "COMPLETED") {
        break;
      }
      if (status.status === "FAILED") {
        throw new Error(`fal.ai request failed: ${status.error ?? "unknown error"}`);
      }
      // IN_QUEUE or IN_PROGRESS — keep polling
    }

    // Fetch result
    const resultResp = await fetch(responseUrl, {
      headers: { Authorization: `Key ${apiKey}` },
      signal: controller.signal,
    });

    if (!resultResp.ok) {
      const errText = await resultResp.text();
      throw new Error(`fal.ai result fetch ${resultResp.status}: ${errText}`);
    }

    return await resultResp.json() as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Tool: image_generate ───

const ImageGenerateSchema = Type.Object({
  prompt: Type.String({ description: "Text prompt describing the image to generate" }),
  path: Type.String({ description: "Output file path (e.g. 'output.png'). Format inferred from extension." }),
  model: Type.Optional(Type.String({
    description: "fal.ai model ID. Default: 'fal-ai/flux/dev'. " +
      "Other options: 'fal-ai/flux-pro/v1.1' (higher quality), 'fal-ai/flux/schnell' (faster).",
  })),
  size: Type.Optional(Type.String({
    description: "Image size as 'WIDTHxHEIGHT' (e.g. '1024x1024', '1024x768', '768x1024'). Default: '1024x1024'.",
  })),
  num_inference_steps: Type.Optional(Type.Number({
    description: "Number of inference steps (higher = better quality, slower). Default varies by model (typically 28).",
  })),
  guidance_scale: Type.Optional(Type.Number({
    description: "Guidance scale / CFG — how closely to follow the prompt. Default: 3.5.",
  })),
  seed: Type.Optional(Type.Number({
    description: "Random seed for reproducible results. Omit for random.",
  })),
});

function createGenerateTool(cwd: string, sandbox: string[], vault?: ResolvedVault): AgentTool<typeof ImageGenerateSchema> {
  return {
    name: "image_generate",
    label: "Generate Image",
    description: "Generate an image from a text prompt using fal.ai (FLUX models). " +
      "Output format inferred from file extension (png, jpg, webp). " +
      "Models: fal-ai/flux/dev (default, balanced), fal-ai/flux-pro/v1.1 (best quality), " +
      "fal-ai/flux/schnell (fastest). Credentials resolved from: agent vault > FAL_KEY env var.",
    parameters: ImageGenerateSchema,
    async execute(_id, params, signal) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "image_generate");

      try {
        return await generateFal(filePath, params, vault, signal);
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Image generation error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

async function generateFal(
  filePath: string,
  params: {
    prompt: string;
    model?: string;
    size?: string;
    num_inference_steps?: number;
    guidance_scale?: number;
    seed?: number;
  },
  vault?: ResolvedVault,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const apiKey = resolveFalKey(vault);
  const model = params.model ?? "fal-ai/flux/dev";

  // Parse size into width/height
  let width = 1024, height = 1024;
  if (params.size) {
    const parts = params.size.split("x").map(Number);
    if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) {
      width = parts[0];
      height = parts[1];
    }
  }

  const input: Record<string, unknown> = {
    prompt: params.prompt,
    image_size: { width, height },
    num_images: 1,
  };
  if (params.num_inference_steps != null) input.num_inference_steps = params.num_inference_steps;
  if (params.guidance_scale != null) input.guidance_scale = params.guidance_scale;
  if (params.seed != null) input.seed = params.seed;

  const result = await falQueueRequest(model, input, apiKey, DEFAULT_TIMEOUT, signal);

  // fal.ai FLUX response: { images: [{ url, width, height, content_type }], ... }
  const images = result.images as { url: string; width: number; height: number; content_type?: string }[] | undefined;
  if (!images || images.length === 0) {
    throw new Error("No images in fal.ai response");
  }

  const imageUrl = images[0].url;
  const imgResp = await fetch(imageUrl);
  if (!imgResp.ok) throw new Error(`Failed to download generated image: ${imgResp.status}`);
  const buffer = Buffer.from(await imgResp.arrayBuffer());

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, buffer);

  const info = [
    `Image saved: ${filePath}`,
    `Size: ${(buffer.byteLength / 1024).toFixed(1)} KB`,
    `Model: ${model}`,
    `Dimensions: ${images[0].width}x${images[0].height}`,
  ];

  return {
    content: [{ type: "text", text: info.join("\n") }],
    details: {
      provider: "fal",
      model,
      size: `${images[0].width}x${images[0].height}`,
      path: filePath,
      bytes: buffer.byteLength,
    },
  };
}

// ─── Tool: video_generate ───

const VideoGenerateSchema = Type.Object({
  prompt: Type.String({ description: "Text prompt describing the video to generate" }),
  path: Type.String({ description: "Output file path (e.g. 'output.mp4')." }),
  model: Type.Optional(Type.String({
    description: "fal.ai video model ID. Default: 'fal-ai/wan/v2.2-1.3b/text-to-video'. " +
      "Other options: 'fal-ai/wan/v2.2-a14b/text-to-video' (higher quality, slower).",
  })),
  num_frames: Type.Optional(Type.Number({
    description: "Number of frames to generate. Default: 81 (~5 seconds at 16fps).",
  })),
  resolution: Type.Optional(Type.String({
    description: "Video resolution as 'WIDTHxHEIGHT' (e.g. '854x480', '1280x720'). Default: '854x480' (480p).",
  })),
  num_inference_steps: Type.Optional(Type.Number({
    description: "Number of inference steps (higher = better quality, slower). Default: 30.",
  })),
  guidance_scale: Type.Optional(Type.Number({
    description: "Guidance scale — how closely to follow the prompt. Default: 5.0.",
  })),
  seed: Type.Optional(Type.Number({
    description: "Random seed for reproducible results. Omit for random.",
  })),
});

function createVideoGenerateTool(cwd: string, sandbox: string[], vault?: ResolvedVault): AgentTool<typeof VideoGenerateSchema> {
  return {
    name: "video_generate",
    label: "Generate Video",
    description: "Generate a video from a text prompt using fal.ai (Wan 2.2 models). " +
      "Output saved as MP4. Models: fal-ai/wan/v2.2-1.3b/text-to-video (default, faster), " +
      "fal-ai/wan/v2.2-a14b/text-to-video (best quality). " +
      "Video generation takes 1-5 minutes depending on model and resolution. " +
      "Credentials resolved from: agent vault > FAL_KEY env var.",
    parameters: VideoGenerateSchema,
    async execute(_id, params, signal) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "video_generate");

      try {
        return await generateVideo(filePath, params, vault, signal);
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Video generation error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

async function generateVideo(
  filePath: string,
  params: {
    prompt: string;
    model?: string;
    num_frames?: number;
    resolution?: string;
    num_inference_steps?: number;
    guidance_scale?: number;
    seed?: number;
  },
  vault?: ResolvedVault,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const apiKey = resolveFalKey(vault);
  const model = params.model ?? "fal-ai/wan/v2.2-1.3b/text-to-video";

  const input: Record<string, unknown> = {
    prompt: params.prompt,
  };

  if (params.num_frames != null) input.num_frames = params.num_frames;
  if (params.num_inference_steps != null) input.num_inference_steps = params.num_inference_steps;
  if (params.guidance_scale != null) input.guidance_scale = params.guidance_scale;
  if (params.seed != null) input.seed = params.seed;

  // Parse resolution
  if (params.resolution) {
    const parts = params.resolution.split("x").map(Number);
    if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) {
      input.resolution = { width: parts[0], height: parts[1] };
    }
  }

  const result = await falQueueRequest(model, input, apiKey, VIDEO_TIMEOUT, signal);

  // fal.ai video response: { video: { url, content_type, file_name, file_size } }
  const video = result.video as { url: string; content_type?: string; file_name?: string; file_size?: number } | undefined;
  if (!video?.url) {
    throw new Error("No video in fal.ai response");
  }

  const videoResp = await fetch(video.url);
  if (!videoResp.ok) throw new Error(`Failed to download generated video: ${videoResp.status}`);
  const buffer = Buffer.from(await videoResp.arrayBuffer());

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, buffer);

  const sizeMB = (buffer.byteLength / 1024 / 1024).toFixed(2);
  const info = [
    `Video saved: ${filePath}`,
    `Size: ${sizeMB} MB`,
    `Model: ${model}`,
  ];

  return {
    content: [{ type: "text", text: info.join("\n") }],
    details: {
      provider: "fal",
      model,
      path: filePath,
      bytes: buffer.byteLength,
    },
  };
}

// ─── Tool: image_analyze ───

const ImageAnalyzeSchema = Type.Object({
  path: Type.String({ description: "Path to the image file to analyze" }),
  prompt: Type.Optional(Type.String({ description: "Question or instruction for the vision model (default: 'Describe this image in detail')" })),
  provider: Type.Optional(Type.Union([
    Type.Literal("openai"),
    Type.Literal("anthropic"),
  ], { description: "Vision provider (default: openai)" })),
  model: Type.Optional(Type.String({ description: "Model name. OpenAI: 'gpt-4.1-mini' (default). Anthropic: 'claude-sonnet-4-20250514' (default)." })),
  max_tokens: Type.Optional(Type.Number({ description: "Max tokens in response (default: 1024)" })),
});

function createAnalyzeTool(cwd: string, sandbox: string[], vault?: ResolvedVault): AgentTool<typeof ImageAnalyzeSchema> {
  return {
    name: "image_analyze",
    label: "Analyze Image",
    description: "Analyze an image using AI vision models. Can describe contents, extract text (OCR), " +
      "answer questions about the image, identify objects, read charts, etc. " +
      "Providers: openai (GPT-4.1-mini, default), anthropic (Claude). " +
      "Credentials resolved from: agent vault > OPENAI_API_KEY or ANTHROPIC_API_KEY env var.",
    parameters: ImageAnalyzeSchema,
    async execute(_id, params, signal) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "image_analyze");

      let fileBuffer: Buffer;
      try {
        fileBuffer = readFileSync(filePath);
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error reading image file: ${err.message}` }],
          details: { error: "file_read_error" },
        };
      }

      if (fileBuffer.byteLength > MAX_IMAGE_SIZE) {
        return {
          content: [{ type: "text", text: `Image file too large: ${(fileBuffer.byteLength / 1024 / 1024).toFixed(1)} MB (max ${MAX_IMAGE_SIZE / 1024 / 1024} MB)` }],
          details: { error: "file_too_large", size: fileBuffer.byteLength },
        };
      }

      const provider = params.provider ?? "openai";

      try {
        if (provider === "openai") {
          return await analyzeOpenAI(filePath, fileBuffer, params, vault, signal);
        } else {
          return await analyzeAnthropic(filePath, fileBuffer, params, vault, signal);
        }
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Image analysis error (${provider}): ${err.message}` }],
          details: { provider, error: err.message },
        };
      }
    },
  };
}

async function analyzeOpenAI(
  filePath: string,
  fileBuffer: Buffer,
  params: { prompt?: string; model?: string; max_tokens?: number },
  vault?: ResolvedVault,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const apiKey = vault?.getKey("openai", "key") ?? requireEnv("OPENAI_API_KEY");
  const model = params.model ?? "gpt-4.1-mini";
  const prompt = params.prompt ?? "Describe this image in detail.";
  const maxTokens = params.max_tokens ?? 1024;

  const ext = extname(filePath).toLowerCase();
  const mime = imageMime(ext);
  const base64 = fileBuffer.toString("base64");
  const dataUrl = `data:${mime};base64,${base64}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl, detail: "auto" } },
          ],
        },
      ],
    }),
    signal: controller.signal,
  });

  clearTimeout(timer);

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI Vision API ${response.status}: ${errText}`);
  }

  const data = await response.json() as {
    choices: { message: { content: string } }[];
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };

  const analysis = data.choices[0]?.message?.content ?? "";
  const usage = data.usage;

  return {
    content: [{ type: "text", text: analysis }],
    details: {
      provider: "openai",
      model,
      path: filePath,
      imageSize: fileBuffer.byteLength,
      tokens: usage?.total_tokens,
      promptTokens: usage?.prompt_tokens,
      completionTokens: usage?.completion_tokens,
    },
  };
}

async function analyzeAnthropic(
  filePath: string,
  fileBuffer: Buffer,
  params: { prompt?: string; model?: string; max_tokens?: number },
  vault?: ResolvedVault,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const apiKey = vault?.getKey("anthropic", "key") ?? requireEnv("ANTHROPIC_API_KEY");
  const model = params.model ?? "claude-sonnet-4-20250514";
  const prompt = params.prompt ?? "Describe this image in detail.";
  const maxTokens = params.max_tokens ?? 1024;

  const ext = extname(filePath).toLowerCase();
  const mime = imageMime(ext);
  const base64 = fileBuffer.toString("base64");

  // Anthropic only supports specific media types
  const supportedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  const mediaType = supportedTypes.includes(mime) ? mime : "image/png";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType,
                data: base64,
              },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
    signal: controller.signal,
  });

  clearTimeout(timer);

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic Vision API ${response.status}: ${errText}`);
  }

  const data = await response.json() as {
    content: { type: string; text?: string }[];
    usage?: { input_tokens: number; output_tokens: number };
  };

  const analysis = data.content
    .filter(b => b.type === "text" && b.text)
    .map(b => b.text)
    .join("\n");

  const usage = data.usage;

  return {
    content: [{ type: "text", text: analysis }],
    details: {
      provider: "anthropic",
      model,
      path: filePath,
      imageSize: fileBuffer.byteLength,
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
    },
  };
}

// ─── Factory ───

export type ImageToolName = "image_generate" | "image_analyze" | "video_generate";

export const ALL_IMAGE_TOOL_NAMES: ImageToolName[] = ["image_generate", "image_analyze", "video_generate"];

/**
 * Create image & video tools for generation, vision analysis, and video creation.
 *
 * @param cwd - Working directory for resolving file paths
 * @param allowedPaths - Sandbox paths for file validation
 * @param allowedTools - Optional filter — only include tools whose names appear here.
 *   Supports wildcards expanded upstream (e.g. "image_*", "video_*").
 * @param vault - Resolved vault for credential resolution (fal-ai, openai, anthropic).
 *   Credentials are resolved as: vault > environment variable.
 */
export function createImageTools(
  cwd: string,
  allowedPaths?: string[],
  allowedTools?: string[],
  vault?: ResolvedVault,
): AgentTool<any>[] {
  const sandbox = resolveAllowedPaths(cwd, allowedPaths);

  const factories: Record<ImageToolName, () => AgentTool<any>> = {
    image_generate: () => createGenerateTool(cwd, sandbox, vault),
    image_analyze: () => createAnalyzeTool(cwd, sandbox, vault),
    video_generate: () => createVideoGenerateTool(cwd, sandbox, vault),
  };

  const names = allowedTools
    ? ALL_IMAGE_TOOL_NAMES.filter(n => allowedTools.some(a => a.toLowerCase() === n))
    : ALL_IMAGE_TOOL_NAMES;

  return names.map(n => factories[n]());
}
