/**
 * Image tools for generation and vision/analysis.
 *
 * Provides agent capabilities to:
 * - Generate images from text prompts (image_generate)
 * - Analyze/describe images using vision models (image_analyze)
 *
 * Architecture: direct fetch() to provider REST APIs — zero vendor SDK dependencies.
 *
 * Supported providers:
 *   Generation: openai (gpt-image-1 / dall-e-3 / dall-e-2), replicate (Flux)
 *   Vision:     openai (gpt-4.1-mini / gpt-4.1), anthropic (Claude)
 *
 * Environment variables:
 *   OPENAI_API_KEY      — required for openai provider
 *   REPLICATE_API_TOKEN — required for replicate provider
 *   ANTHROPIC_API_KEY   — required for anthropic vision provider
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { resolveAllowedPaths, assertPathAllowed } from "./path-sandbox.js";

type ToolResult = AgentToolResult<any>;

// ─── Constants ───

const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB
const DEFAULT_TIMEOUT = 120_000; // 2 min for image generation
const REPLICATE_POLL_INTERVAL = 2_000; // 2 sec polling for async predictions

// ─── Helpers ───

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing environment variable: ${key}. Set it before using this tool.`);
  return val;
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

// ─── Tool: image_generate ───

const ImageGenerateSchema = Type.Object({
  prompt: Type.String({ description: "Text prompt describing the image to generate" }),
  path: Type.String({ description: "Output file path (e.g. 'output.png'). Format inferred from extension." }),
  provider: Type.Optional(Type.Union([
    Type.Literal("openai"),
    Type.Literal("replicate"),
  ], { description: "Image generation provider (default: openai)" })),
  model: Type.Optional(Type.String({ description: "Model name. OpenAI: 'gpt-image-1' (default), 'dall-e-3', 'dall-e-2'. Replicate: 'black-forest-labs/flux-1.1-pro' (default)." })),
  size: Type.Optional(Type.String({ description: "Image size. OpenAI: '1024x1024' (default), '1536x1024', '1024x1536', '256x256', '512x512'. Replicate: 'width x height'." })),
  quality: Type.Optional(Type.Union([
    Type.Literal("auto"),
    Type.Literal("high"),
    Type.Literal("medium"),
    Type.Literal("low"),
  ], { description: "Image quality (OpenAI only, default: auto)" })),
  style: Type.Optional(Type.Union([
    Type.Literal("vivid"),
    Type.Literal("natural"),
  ], { description: "Image style (OpenAI dall-e-3 only, default: vivid)" })),
  n: Type.Optional(Type.Number({ description: "Number of images to generate (default: 1, max varies by model)" })),
});

function createGenerateTool(cwd: string, sandbox: string[]): AgentTool<typeof ImageGenerateSchema> {
  return {
    name: "image_generate",
    label: "Generate Image",
    description: "Generate an image from a text prompt using AI. " +
      "Providers: openai (gpt-image-1/DALL-E 3, default), replicate (Flux). " +
      "Output format inferred from file extension (png, jpg, webp). " +
      "Requires OPENAI_API_KEY or REPLICATE_API_TOKEN env var.",
    parameters: ImageGenerateSchema,
    async execute(_id, params, signal) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "image_generate");

      const provider = params.provider ?? "openai";

      try {
        if (provider === "openai") {
          return await generateOpenAI(filePath, params, signal);
        } else {
          return await generateReplicate(filePath, params, signal);
        }
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Image generation error (${provider}): ${err.message}` }],
          details: { provider, error: err.message },
        };
      }
    },
  };
}

async function generateOpenAI(
  filePath: string,
  params: { prompt: string; model?: string; size?: string; quality?: string; style?: string; n?: number },
  signal?: AbortSignal,
): Promise<ToolResult> {
  const apiKey = requireEnv("OPENAI_API_KEY");
  const model = params.model ?? "gpt-image-1";
  const size = params.size ?? "1024x1024";
  const n = params.n ?? 1;

  const body: Record<string, unknown> = {
    model,
    prompt: params.prompt,
    size,
    n,
  };

  // gpt-image-1 uses output_format; dall-e-3/2 use response_format
  const ext = extname(filePath).toLowerCase().replace(".", "");
  if (model === "gpt-image-1") {
    body.output_format = ext === "jpg" || ext === "jpeg" ? "jpeg" : ext === "webp" ? "webp" : "png";
    if (params.quality) body.quality = params.quality;
  } else {
    body.response_format = "b64_json";
    if (params.quality) body.quality = params.quality === "high" ? "hd" : "standard";
    if (params.style) body.style = params.style;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  });

  clearTimeout(timer);

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI Images API ${response.status}: ${errText}`);
  }

  const data = await response.json() as {
    data: { b64_json?: string; url?: string; revised_prompt?: string }[];
  };

  const imageData = data.data[0];
  let buffer: Buffer;

  if (imageData.b64_json) {
    buffer = Buffer.from(imageData.b64_json, "base64");
  } else if (imageData.url) {
    // For gpt-image-1, the response contains b64_json by default when output_format is set
    // But just in case there's a URL, download it
    const imgResp = await fetch(imageData.url);
    buffer = Buffer.from(await imgResp.arrayBuffer());
  } else {
    throw new Error("No image data in OpenAI response");
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, buffer);

  const revisedPrompt = imageData.revised_prompt;
  const info = [
    `Image saved: ${filePath}`,
    `Size: ${(buffer.byteLength / 1024).toFixed(1)} KB`,
    `Model: ${model}`,
    `Dimensions: ${size}`,
  ];
  if (revisedPrompt) info.push(`Revised prompt: ${revisedPrompt}`);

  return {
    content: [{ type: "text", text: info.join("\n") }],
    details: {
      provider: "openai",
      model,
      size,
      path: filePath,
      bytes: buffer.byteLength,
      revisedPrompt,
    },
  };
}

async function generateReplicate(
  filePath: string,
  params: { prompt: string; model?: string; size?: string },
  signal?: AbortSignal,
): Promise<ToolResult> {
  const apiToken = requireEnv("REPLICATE_API_TOKEN");
  const model = params.model ?? "black-forest-labs/flux-1.1-pro";

  // Parse size into width/height
  let width = 1024, height = 1024;
  if (params.size) {
    const parts = params.size.split("x").map(Number);
    if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) {
      width = parts[0];
      height = parts[1];
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT * 2); // Replicate can be slower
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

  // Create prediction
  const createResp = await fetch("https://api.replicate.com/v1/models/" + model + "/predictions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      Prefer: "wait",
    },
    body: JSON.stringify({
      input: {
        prompt: params.prompt,
        width,
        height,
      },
    }),
    signal: controller.signal,
  });

  if (!createResp.ok) {
    clearTimeout(timer);
    const errText = await createResp.text();
    throw new Error(`Replicate API ${createResp.status}: ${errText}`);
  }

  let prediction = await createResp.json() as {
    id: string;
    status: string;
    output?: string | string[];
    error?: string;
    urls?: { get?: string };
  };

  // Poll if not yet completed (the Prefer: wait header should handle most cases)
  while (prediction.status === "starting" || prediction.status === "processing") {
    await new Promise(r => setTimeout(r, REPLICATE_POLL_INTERVAL));
    const pollUrl = prediction.urls?.get ?? `https://api.replicate.com/v1/predictions/${prediction.id}`;
    const pollResp = await fetch(pollUrl, {
      headers: { Authorization: `Bearer ${apiToken}` },
      signal: controller.signal,
    });
    if (!pollResp.ok) {
      clearTimeout(timer);
      throw new Error(`Replicate poll ${pollResp.status}`);
    }
    prediction = await pollResp.json() as typeof prediction;
  }

  clearTimeout(timer);

  if (prediction.status === "failed") {
    throw new Error(`Replicate prediction failed: ${prediction.error ?? "unknown error"}`);
  }

  // Output is typically a URL or array of URLs
  const outputUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
  if (!outputUrl || typeof outputUrl !== "string") {
    throw new Error("No output URL in Replicate response");
  }

  // Download the generated image
  const imgResp = await fetch(outputUrl);
  if (!imgResp.ok) throw new Error(`Failed to download generated image: ${imgResp.status}`);
  const buffer = Buffer.from(await imgResp.arrayBuffer());

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, buffer);

  return {
    content: [{ type: "text", text: `Image saved: ${filePath} (${(buffer.byteLength / 1024).toFixed(1)} KB, model: ${model}, ${width}x${height})` }],
    details: {
      provider: "replicate",
      model,
      size: `${width}x${height}`,
      path: filePath,
      bytes: buffer.byteLength,
      predictionId: prediction.id,
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

function createAnalyzeTool(cwd: string, sandbox: string[]): AgentTool<typeof ImageAnalyzeSchema> {
  return {
    name: "image_analyze",
    label: "Analyze Image",
    description: "Analyze an image using AI vision models. Can describe contents, extract text (OCR), " +
      "answer questions about the image, identify objects, read charts, etc. " +
      "Providers: openai (GPT-4.1-mini, default), anthropic (Claude). " +
      "Requires OPENAI_API_KEY or ANTHROPIC_API_KEY env var.",
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
          return await analyzeOpenAI(filePath, fileBuffer, params, signal);
        } else {
          return await analyzeAnthropic(filePath, fileBuffer, params, signal);
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
  signal?: AbortSignal,
): Promise<ToolResult> {
  const apiKey = requireEnv("OPENAI_API_KEY");
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
  signal?: AbortSignal,
): Promise<ToolResult> {
  const apiKey = requireEnv("ANTHROPIC_API_KEY");
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

export type ImageToolName = "image_generate" | "image_analyze";

export const ALL_IMAGE_TOOL_NAMES: ImageToolName[] = ["image_generate", "image_analyze"];

/**
 * Create image tools for generation and vision analysis.
 *
 * @param cwd - Working directory for resolving file paths
 * @param allowedPaths - Sandbox paths for file validation
 * @param allowedTools - Optional filter
 */
export function createImageTools(
  cwd: string,
  allowedPaths?: string[],
  allowedTools?: string[],
): AgentTool<any>[] {
  const sandbox = resolveAllowedPaths(cwd, allowedPaths);

  const factories: Record<ImageToolName, () => AgentTool<any>> = {
    image_generate: () => createGenerateTool(cwd, sandbox),
    image_analyze: () => createAnalyzeTool(cwd, sandbox),
  };

  const names = allowedTools
    ? ALL_IMAGE_TOOL_NAMES.filter(n => allowedTools.some(a => a.toLowerCase() === n))
    : ALL_IMAGE_TOOL_NAMES;

  return names.map(n => factories[n]());
}
