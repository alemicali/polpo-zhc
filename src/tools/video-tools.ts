/**
 * The video tool: video_generate, through fal.ai's queue API (direct fetch, the agent's vault
 * "fal-ai" / "key" or FAL_KEY).
 *
 * Images moved to the media primitive (image-tools.ts → src/media/service.ts, through the shared
 * gateway resolver). Video is next with the same shape (docs/media.md, "Next"); until then this
 * tool keeps its fal.ai call unchanged.
 */

import { resolve } from "node:path";
import type { FileSystem } from "@polpo-ai/core/filesystem";
import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { assertPathAllowed } from "./path-sandbox.js";
import { writeBytes } from "./tool-fs.js";
import type { ResolvedVault } from "../vault/index.js";

type ToolResult = AgentToolResult<any>;

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

export function createVideoGenerateTool(cwd: string, sandbox: string[], fs: FileSystem, vault?: ResolvedVault): AgentTool<typeof VideoGenerateSchema> {
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
        return await generateVideo(fs, filePath, params, vault, signal);
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
  fs: FileSystem,
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

  await writeBytes(fs, filePath, buffer);

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
