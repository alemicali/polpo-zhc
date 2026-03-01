/**
 * Voice input — record audio from system mic via sox, transcribe via STT API.
 * Sox is auto-installed if missing.
 *
 * Supports multiple STT providers with automatic fallback:
 *   1. deepgram  — Deepgram Nova-2 (fastest, best multilingual)
 *   2. groq      — Groq Whisper (OpenAI-compatible, free tier)
 *   3. openai    — OpenAI gpt-4o-transcribe (requires paid API key)
 *
 * Env vars:
 *   POLPO_STT_PROVIDER  — "deepgram" | "groq" | "openai" (default: auto-detect)
 *   POLPO_STT_MODEL     — model override (provider-specific)
 *   POLPO_STT_LANG      — language ISO-639-1 (default: auto)
 *   DEEPGRAM_API_KEY    — Deepgram API key
 *   GROQ_API_KEY        — Groq API key
 *   OPENAI_API_KEY      — OpenAI API key
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { mkdirSync, unlinkSync, readFileSync, statSync } from "node:fs";
import { resolveApiKey, resolveApiKeyAsync } from "../llm/pi-client.js";
import { safeEnv } from "../tools/safe-env.js";

// ─── Provider types ────────────────────────

export type SttProvider = "deepgram" | "groq" | "openai";

interface SttProviderConfig {
  provider: SttProvider;
  apiKey: string;
  model: string;
  apiUrl: string;
}

// ─── Default models per provider ───────────

const PROVIDER_DEFAULTS: Record<SttProvider, { model: string; apiUrl: string }> = {
  deepgram: {
    model: "nova-3",
    apiUrl: "https://api.deepgram.com/v1/listen",
  },
  groq: {
    model: "whisper-large-v3-turbo",
    apiUrl: "https://api.groq.com/openai/v1/audio/transcriptions",
  },
  openai: {
    model: "gpt-4o-transcribe",
    apiUrl: "https://api.openai.com/v1/audio/transcriptions",
  },
};

// ─── Mime type map ─────────────────────────

const MIME_MAP: Record<string, string> = {
  wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg",
  mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4",
  webm: "audio/webm", flac: "audio/flac",
};

// ─── Recording ─────────────────────────────

export interface RecordingHandle {
  child: ChildProcess;
  filePath: string;
}

/**
 * Ensure sox is installed, auto-install if missing.
 */
function ensureSox(): void {
  try {
    execSync("which rec", { stdio: "ignore" });
  } catch {
    // Try auto-install
    try {
      execSync("sudo apt-get install -y sox > /dev/null 2>&1", { stdio: "ignore", timeout: 30_000 });
    } catch {
      throw new Error("Could not install sox. Run: sudo apt install sox");
    }
  }
}

/**
 * Start recording from system microphone.
 * Auto-installs sox if missing. Returns a handle to stop recording later.
 */
export function startRecording(tmpDir: string): RecordingHandle {
  ensureSox();
  mkdirSync(tmpDir, { recursive: true });
  const filePath = join(tmpDir, `voice-${randomBytes(6).toString("hex")}.wav`);

  const child = spawn("rec", ["-c", "1", "-r", "16000", "-b", "16", filePath], {
    stdio: ["ignore", "ignore", "pipe"],
    env: safeEnv(),
  });

  // Suppress sox stderr noise (progress output)
  child.stderr?.resume();

  return { child, filePath };
}

/**
 * Stop recording and transcribe the audio.
 * Returns the transcribed text, or throws on error.
 */
export async function stopAndTranscribe(handle: RecordingHandle): Promise<string> {
  const { child, filePath } = handle;

  // Gracefully stop sox (it finalizes WAV header on SIGTERM)
  await new Promise<void>((resolve) => {
    child.on("close", () => resolve());
    child.kill("SIGTERM");
    // Force kill after 3s if not dead
    const timer = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      resolve();
    }, 3000);
    child.on("close", () => clearTimeout(timer));
  });

  try {
    return await transcribe(filePath);
  } finally {
    // Cleanup temp file
    try { unlinkSync(filePath); } catch { /* already gone */ }
  }
}

// ─── Provider detection ────────────────────

/**
 * Resolve which STT provider to use.
 * Priority: POLPO_STT_PROVIDER env → first available key (deepgram > groq > openai).
 * Checks env vars, polpo.json overrides, AND OAuth profiles.
 */
async function resolveProvider(): Promise<SttProviderConfig> {
  const explicit = process.env.POLPO_STT_PROVIDER as SttProvider | undefined;
  const modelOverride = process.env.POLPO_STT_MODEL;

  // Helper: build config for a provider if its API key is available
  const tryProvider = async (p: SttProvider): Promise<SttProviderConfig | undefined> => {
    let apiKey: string | undefined;
    if (p === "deepgram") {
      apiKey = process.env.DEEPGRAM_API_KEY || await resolveApiKeyAsync("deepgram");
    } else if (p === "groq") {
      apiKey = process.env.GROQ_API_KEY || await resolveApiKeyAsync("groq");
    } else {
      apiKey = await resolveApiKeyAsync("openai");
    }
    if (!apiKey) return undefined;
    const defaults = PROVIDER_DEFAULTS[p];
    return {
      provider: p,
      apiKey,
      model: modelOverride ?? defaults.model,
      apiUrl: defaults.apiUrl,
    };
  };

  // If explicit provider requested, use it or fail
  if (explicit) {
    const config = await tryProvider(explicit);
    if (!config) {
      const keyName = explicit === "deepgram" ? "DEEPGRAM_API_KEY"
        : explicit === "groq" ? "GROQ_API_KEY" : "OPENAI_API_KEY";
      throw new Error(`STT provider "${explicit}" selected but ${keyName} is not set`);
    }
    return config;
  }

  // Auto-detect: try providers in preference order
  const order: SttProvider[] = ["deepgram", "groq", "openai"];
  for (const p of order) {
    const config = await tryProvider(p);
    if (config) return config;
  }

  throw new Error(
    "No STT provider available. Set one of: DEEPGRAM_API_KEY, GROQ_API_KEY, or OPENAI_API_KEY",
  );
}

// ─── Transcription ─────────────────────────

/**
 * Transcribe an audio file. Auto-selects the best available STT provider.
 */
export async function transcribe(filePath: string): Promise<string> {
  const config = await resolveProvider();
  const language = process.env.POLPO_STT_LANG ?? "auto";

  // Check file exists and has content
  const stat = statSync(filePath);
  if (stat.size < 100) {
    throw new Error("Recording too short");
  }

  const fileBuffer = readFileSync(filePath);
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "wav";
  const mimeType = MIME_MAP[ext] ?? "audio/wav";

  if (config.provider === "deepgram") {
    return transcribeDeepgram(config, fileBuffer, mimeType, language);
  } else {
    // Groq and OpenAI both use OpenAI-compatible multipart API
    return transcribeOpenAICompat(config, fileBuffer, ext, mimeType, language);
  }
}

/**
 * Deepgram STT — sends raw audio bytes with Content-Type header.
 * Simple REST API, no multipart needed.
 */
async function transcribeDeepgram(
  config: SttProviderConfig,
  fileBuffer: Buffer,
  mimeType: string,
  language: string,
): Promise<string> {
  const params = new URLSearchParams({
    model: config.model,
    smart_format: "true",
    punctuate: "true",
  });
  if (language && language !== "auto") {
    params.set("language", language);
  } else {
    // Deepgram auto-detects language if not specified — enable detection
    params.set("detect_language", "true");
  }

  const url = `${config.apiUrl}?${params.toString()}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${config.apiKey}`,
      "Content-Type": mimeType,
    },
    body: fileBuffer as unknown as BodyInit,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Deepgram STT error ${res.status}: ${err}`);
  }

  const data = await res.json() as DeepgramResponse;
  const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  if (!transcript) {
    throw new Error("Deepgram returned empty transcript");
  }
  return transcript.trim();
}

interface DeepgramResponse {
  results?: {
    channels?: Array<{
      alternatives?: Array<{
        transcript?: string;
        confidence?: number;
      }>;
      detected_language?: string;
    }>;
  };
}

/**
 * OpenAI-compatible STT (OpenAI, Groq) — multipart form upload.
 */
async function transcribeOpenAICompat(
  config: SttProviderConfig,
  fileBuffer: Buffer,
  ext: string,
  mimeType: string,
  language: string,
): Promise<string> {
  const boundary = `----PolpoVoice${randomBytes(8).toString("hex")}`;
  const filename = `recording.${ext}`;

  const parts: Buffer[] = [];
  const addField = (name: string, value: string) => {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ));
  };
  const addFile = (name: string, fname: string, buf: Buffer, contentType: string) => {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${fname}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ));
    parts.push(buf);
    parts.push(Buffer.from("\r\n"));
  };

  addFile("file", filename, fileBuffer, mimeType);
  addField("model", config.model);
  if (language && language !== "auto") {
    addField("language", language);
  }
  addField("response_format", "text");
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const res = await fetch(config.apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${config.provider} STT error ${res.status}: ${err}`);
  }

  const text = await res.text();
  return text.trim();
}
