/**
 * Audio tools for speech-to-text (STT) and text-to-speech (TTS).
 *
 * Provides agent capabilities to:
 * - Transcribe audio files to text (audio_transcribe)
 * - Generate speech audio from text (audio_speak)
 *
 * Architecture: direct fetch() to provider REST APIs — zero vendor SDK dependencies.
 *
 * Supported providers:
 *   STT: openai (Whisper), deepgram
 *   TTS: openai (gpt-4o-mini-tts / tts-1), elevenlabs
 *
 * Environment variables:
 *   OPENAI_API_KEY    — required for openai provider
 *   DEEPGRAM_API_KEY  — required for deepgram provider
 *   ELEVENLABS_API_KEY — required for elevenlabs provider
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

// Re-export with concrete generic to avoid "requires 1 type argument" errors
type ToolResult = AgentToolResult<any>;
import { resolveAllowedPaths, assertPathAllowed } from "./path-sandbox.js";

// ─── Constants ───

const MAX_AUDIO_SIZE = 25 * 1024 * 1024; // 25 MB (OpenAI Whisper limit)
const DEFAULT_TIMEOUT = 120_000; // 2 min for audio processing

// ─── Helpers ───

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing environment variable: ${key}. Set it before using this tool.`);
  return val;
}

/** Build a FormData-like multipart body for fetch (Node 18+). */
function audioFormData(
  fileBuffer: Buffer,
  filename: string,
  fields: Record<string, string>,
): { body: FormData; } {
  const form = new FormData();
  const blob = new Blob([new Uint8Array(fileBuffer)], { type: mimeFromExt(extname(filename)) });
  form.append("file", blob, filename);
  for (const [k, v] of Object.entries(fields)) {
    form.append(k, v);
  }
  return { body: form };
}

function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".webm": "audio/webm",
    ".mp4": "audio/mp4",
    ".mpeg": "audio/mpeg",
    ".mpga": "audio/mpeg",
  };
  return map[ext.toLowerCase()] ?? "application/octet-stream";
}

// ─── Tool: audio_transcribe ───

const AudioTranscribeSchema = Type.Object({
  path: Type.String({ description: "Path to the audio file to transcribe (mp3, wav, flac, ogg, m4a, webm)" }),
  provider: Type.Optional(Type.Union([
    Type.Literal("openai"),
    Type.Literal("deepgram"),
  ], { description: "STT provider (default: openai)" })),
  model: Type.Optional(Type.String({ description: "Model name. OpenAI: 'whisper-1' (default). Deepgram: 'nova-3' (default)." })),
  language: Type.Optional(Type.String({ description: "ISO 639-1 language code (e.g. 'en', 'it', 'es'). Helps accuracy." })),
  prompt: Type.Optional(Type.String({ description: "Optional context/prompt to guide transcription (OpenAI only)" })),
});

function createTranscribeTool(cwd: string, sandbox: string[]): AgentTool<typeof AudioTranscribeSchema> {
  return {
    name: "audio_transcribe",
    label: "Transcribe Audio",
    description: "Transcribe an audio file to text using speech-to-text AI. " +
      "Supports mp3, wav, flac, ogg, m4a, webm formats. Max file size: 25 MB. " +
      "Providers: openai (Whisper, default), deepgram (Nova). " +
      "Requires OPENAI_API_KEY or DEEPGRAM_API_KEY env var.",
    parameters: AudioTranscribeSchema,
    async execute(_id, params, signal) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "audio_transcribe");

      const provider = params.provider ?? "openai";
      let fileBuffer: Buffer;
      try {
        fileBuffer = readFileSync(filePath);
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error reading audio file: ${err.message}` }],
          details: { error: "file_read_error" },
        };
      }

      if (fileBuffer.byteLength > MAX_AUDIO_SIZE) {
        return {
          content: [{ type: "text", text: `Audio file too large: ${(fileBuffer.byteLength / 1024 / 1024).toFixed(1)} MB (max ${MAX_AUDIO_SIZE / 1024 / 1024} MB)` }],
          details: { error: "file_too_large", size: fileBuffer.byteLength },
        };
      }

      try {
        if (provider === "openai") {
          return await transcribeOpenAI(filePath, fileBuffer, params, signal);
        } else {
          return await transcribeDeepgram(filePath, fileBuffer, params, signal);
        }
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Transcription error (${provider}): ${err.message}` }],
          details: { provider, error: err.message },
        };
      }
    },
  };
}

async function transcribeOpenAI(
  filePath: string,
  fileBuffer: Buffer,
  params: { model?: string; language?: string; prompt?: string },
  signal?: AbortSignal,
): Promise<ToolResult> {
  const apiKey = requireEnv("OPENAI_API_KEY");
  const model = params.model ?? "whisper-1";

  const fields: Record<string, string> = { model };
  if (params.language) fields.language = params.language;
  if (params.prompt) fields.prompt = params.prompt;
  fields.response_format = "verbose_json";

  const { body } = audioFormData(fileBuffer, filePath.split("/").pop()!, fields);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
    signal: controller.signal,
  });

  clearTimeout(timer);

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI API ${response.status}: ${errText}`);
  }

  const data = await response.json() as {
    text: string;
    language?: string;
    duration?: number;
    segments?: { start: number; end: number; text: string }[];
  };

  const info = [
    `Language: ${data.language ?? "unknown"}`,
    `Duration: ${data.duration ? `${data.duration.toFixed(1)}s` : "unknown"}`,
    `Model: ${model}`,
  ].join(" | ");

  return {
    content: [{ type: "text", text: `${info}\n\n${data.text}` }],
    details: {
      provider: "openai",
      model,
      language: data.language,
      duration: data.duration,
      textLength: data.text.length,
    },
  };
}

async function transcribeDeepgram(
  filePath: string,
  fileBuffer: Buffer,
  params: { model?: string; language?: string },
  signal?: AbortSignal,
): Promise<ToolResult> {
  const apiKey = requireEnv("DEEPGRAM_API_KEY");
  const model = params.model ?? "nova-3";

  const queryParams = new URLSearchParams({
    model,
    smart_format: "true",
    punctuate: "true",
  });
  if (params.language) queryParams.set("language", params.language);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

  const ext = extname(filePath).toLowerCase();
  const mime = mimeFromExt(ext);

  const response = await fetch(`https://api.deepgram.com/v1/listen?${queryParams}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": mime,
    },
    body: new Uint8Array(fileBuffer),
    signal: controller.signal,
  });

  clearTimeout(timer);

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Deepgram API ${response.status}: ${errText}`);
  }

  const data = await response.json() as {
    results?: {
      channels?: {
        alternatives?: { transcript?: string; confidence?: number }[];
      }[];
    };
    metadata?: { duration?: number; models?: string[] };
  };

  const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
  const confidence = data.results?.channels?.[0]?.alternatives?.[0]?.confidence;
  const duration = data.metadata?.duration;

  const info = [
    `Confidence: ${confidence ? `${(confidence * 100).toFixed(1)}%` : "unknown"}`,
    `Duration: ${duration ? `${duration.toFixed(1)}s` : "unknown"}`,
    `Model: ${model}`,
  ].join(" | ");

  return {
    content: [{ type: "text", text: `${info}\n\n${transcript}` }],
    details: {
      provider: "deepgram",
      model,
      confidence,
      duration,
      textLength: transcript.length,
    },
  };
}

// ─── Tool: audio_speak ───

const AudioSpeakSchema = Type.Object({
  text: Type.String({ description: "Text to convert to speech" }),
  path: Type.String({ description: "Output file path (e.g. 'output.mp3'). Format inferred from extension." }),
  provider: Type.Optional(Type.Union([
    Type.Literal("openai"),
    Type.Literal("elevenlabs"),
  ], { description: "TTS provider (default: openai)" })),
  model: Type.Optional(Type.String({ description: "Model name. OpenAI: 'tts-1' (default), 'tts-1-hd', 'gpt-4o-mini-tts'. ElevenLabs: 'eleven_multilingual_v2' (default)." })),
  voice: Type.Optional(Type.String({ description: "Voice name/ID. OpenAI: alloy, echo, fable, onyx, nova, shimmer (default: alloy). ElevenLabs: voice ID." })),
  speed: Type.Optional(Type.Number({ description: "Playback speed 0.25-4.0 (OpenAI only, default: 1.0)" })),
  instructions: Type.Optional(Type.String({ description: "Voice style instructions (OpenAI gpt-4o-mini-tts only, e.g. 'Speak in a cheerful tone')" })),
});

function createSpeakTool(cwd: string, sandbox: string[]): AgentTool<typeof AudioSpeakSchema> {
  return {
    name: "audio_speak",
    label: "Text to Speech",
    description: "Generate speech audio from text using text-to-speech AI. " +
      "Output format is inferred from file extension (mp3, wav, flac, opus, aac, pcm). " +
      "Providers: openai (default), elevenlabs. " +
      "Requires OPENAI_API_KEY or ELEVENLABS_API_KEY env var.",
    parameters: AudioSpeakSchema,
    async execute(_id, params, signal) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "audio_speak");

      const provider = params.provider ?? "openai";

      try {
        if (provider === "openai") {
          return await speakOpenAI(filePath, params, signal);
        } else {
          return await speakElevenLabs(filePath, params, signal);
        }
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `TTS error (${provider}): ${err.message}` }],
          details: { provider, error: err.message },
        };
      }
    },
  };
}

async function speakOpenAI(
  filePath: string,
  params: { text: string; model?: string; voice?: string; speed?: number; instructions?: string },
  signal?: AbortSignal,
): Promise<ToolResult> {
  const apiKey = requireEnv("OPENAI_API_KEY");
  const model = params.model ?? "tts-1";
  const voice = params.voice ?? "alloy";

  const ext = extname(filePath).toLowerCase().replace(".", "");
  const formatMap: Record<string, string> = {
    mp3: "mp3", wav: "wav", flac: "flac", opus: "opus", aac: "aac", pcm: "pcm",
  };
  const responseFormat = formatMap[ext] ?? "mp3";

  const body: Record<string, unknown> = {
    model,
    input: params.text,
    voice,
    response_format: responseFormat,
  };
  if (params.speed !== undefined) body.speed = params.speed;
  if (params.instructions) body.instructions = params.instructions;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
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
    throw new Error(`OpenAI TTS API ${response.status}: ${errText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, buffer);

  return {
    content: [{ type: "text", text: `Speech audio saved: ${filePath} (${(buffer.byteLength / 1024).toFixed(1)} KB, ${responseFormat}, voice: ${voice}, model: ${model})` }],
    details: {
      provider: "openai",
      model,
      voice,
      format: responseFormat,
      path: filePath,
      bytes: buffer.byteLength,
      textLength: params.text.length,
    },
  };
}

async function speakElevenLabs(
  filePath: string,
  params: { text: string; model?: string; voice?: string },
  signal?: AbortSignal,
): Promise<ToolResult> {
  const apiKey = requireEnv("ELEVENLABS_API_KEY");
  const model = params.model ?? "eleven_multilingual_v2";
  // ElevenLabs default voice: "Rachel" (21m00Tcm4TlvDq8ikWAM)
  const voiceId = params.voice ?? "21m00Tcm4TlvDq8ikWAM";

  const ext = extname(filePath).toLowerCase().replace(".", "");
  const formatMap: Record<string, string> = {
    mp3: "mp3_44100_128", wav: "pcm_44100", flac: "flac",
  };
  const outputFormat = formatMap[ext] ?? "mp3_44100_128";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${outputFormat}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: params.text,
        model_id: model,
      }),
      signal: controller.signal,
    },
  );

  clearTimeout(timer);

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ElevenLabs API ${response.status}: ${errText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, buffer);

  return {
    content: [{ type: "text", text: `Speech audio saved: ${filePath} (${(buffer.byteLength / 1024).toFixed(1)} KB, voice: ${voiceId}, model: ${model})` }],
    details: {
      provider: "elevenlabs",
      model,
      voiceId,
      format: outputFormat,
      path: filePath,
      bytes: buffer.byteLength,
      textLength: params.text.length,
    },
  };
}

// ─── Factory ───

export type AudioToolName = "audio_transcribe" | "audio_speak";

export const ALL_AUDIO_TOOL_NAMES: AudioToolName[] = ["audio_transcribe", "audio_speak"];

/**
 * Create audio tools for speech-to-text and text-to-speech.
 *
 * @param cwd - Working directory for resolving file paths
 * @param allowedPaths - Sandbox paths for file validation
 * @param allowedTools - Optional filter
 */
export function createAudioTools(
  cwd: string,
  allowedPaths?: string[],
  allowedTools?: string[],
): AgentTool<any>[] {
  const sandbox = resolveAllowedPaths(cwd, allowedPaths);

  const factories: Record<AudioToolName, () => AgentTool<any>> = {
    audio_transcribe: () => createTranscribeTool(cwd, sandbox),
    audio_speak: () => createSpeakTool(cwd, sandbox),
  };

  const names = allowedTools
    ? ALL_AUDIO_TOOL_NAMES.filter(n => allowedTools.some(a => a.toLowerCase() === n))
    : ALL_AUDIO_TOOL_NAMES;

  return names.map(n => factories[n]());
}
