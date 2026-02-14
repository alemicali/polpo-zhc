/**
 * Voice input — record audio from system mic via sox, transcribe via OpenAI API.
 * Sox is auto-installed if missing.
 *
 * Env vars:
 *   OPENAI_API_KEY      — required for transcription
 *   POLPO_STT_MODEL     — model (default: gpt-4o-mini-transcribe)
 *   POLPO_STT_LANG      — language ISO-639-1 (default: auto)
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { mkdirSync, unlinkSync, readFileSync, statSync } from "node:fs";
import { resolveApiKey } from "../llm/pi-client.js";

const DEFAULT_MODEL = "gpt-4o-mini-transcribe";
const DEFAULT_LANG = "auto";
const API_URL = "https://api.openai.com/v1/audio/transcriptions";

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
    env: { ...process.env },
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

/**
 * Transcribe an audio file using OpenAI transcription API.
 */
export async function transcribe(filePath: string): Promise<string> {
  const apiKey = resolveApiKey("openai");
  if (!apiKey) {
    throw new Error("Set OPENAI_API_KEY or configure openai provider in polpo.yml");
  }

  const model = process.env.POLPO_STT_MODEL ?? DEFAULT_MODEL;
  const language = process.env.POLPO_STT_LANG ?? DEFAULT_LANG;

  // Check file exists and has content
  const stat = statSync(filePath);
  if (stat.size < 100) {
    throw new Error("Recording too short");
  }

  // Build multipart form data manually (no external deps)
  const fileBuffer = readFileSync(filePath);
  const boundary = `----PolpoVoice${randomBytes(8).toString("hex")}`;

  const parts: Buffer[] = [];
  const addField = (name: string, value: string) => {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ));
  };
  const addFile = (name: string, filename: string, buf: Buffer) => {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: audio/wav\r\n\r\n`,
    ));
    parts.push(buf);
    parts.push(Buffer.from("\r\n"));
  };

  addFile("file", "recording.wav", fileBuffer);
  addField("model", model);
  if (language && language !== "auto") {
    addField("language", language);
  }
  addField("response_format", "text");
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`STT API error ${res.status}: ${err}`);
  }

  const text = await res.text();
  return text.trim();
}

