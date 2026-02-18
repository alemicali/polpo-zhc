import { execSync, spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { unlinkSync, statSync, createReadStream } from "node:fs";
import { randomBytes } from "node:crypto";

export interface RecordingHandle {
  process: ChildProcess;
  filePath: string;
}

/** Check if sox/rec is available, auto-install on Debian/Ubuntu */
function ensureSox(): boolean {
  try {
    execSync("which rec", { stdio: "ignore" });
    return true;
  } catch {
    try {
      console.log("Installing sox for voice recording...");
      execSync("sudo apt-get install -y sox", { stdio: "inherit" });
      return true;
    } catch {
      return false;
    }
  }
}

/** Start recording audio via sox */
export function startRecording(tmpDir?: string): RecordingHandle | null {
  if (!ensureSox()) return null;

  const dir = tmpDir ?? tmpdir();
  const id = randomBytes(4).toString("hex");
  const filePath = resolve(dir, `polpo-voice-${id}.wav`);

  const proc = spawn("rec", [
    filePath,
    "rate", "16k",
    "channels", "1",
    "bits", "16",
  ], {
    stdio: "ignore",
    detached: false,
  });

  return { process: proc, filePath };
}

/** Stop recording and transcribe via OpenAI Whisper */
export async function stopAndTranscribe(handle: RecordingHandle): Promise<string | null> {
  // Gracefully stop recording
  handle.process.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    handle.process.on("close", () => resolve());
    setTimeout(() => resolve(), 2000); // timeout fallback
  });

  try {
    const stat = statSync(handle.filePath);
    if (stat.size < 100) {
      unlinkSync(handle.filePath);
      return null;
    }

    const text = await transcribe(handle.filePath);
    unlinkSync(handle.filePath);
    return text;
  } catch {
    try { unlinkSync(handle.filePath); } catch { /* ignore */ }
    return null;
  }
}

/** Transcribe audio file via OpenAI Whisper API */
async function transcribe(filePath: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const model = process.env.POLPO_STT_MODEL ?? "gpt-4o-mini-transcribe";
  const lang = process.env.POLPO_STT_LANG;

  // Build multipart form data manually (no external deps)
  const boundary = `----polpo${randomBytes(8).toString("hex")}`;
  const fileStream = createReadStream(filePath);
  const chunks: Buffer[] = [];
  for await (const chunk of fileStream) {
    chunks.push(chunk as Buffer);
  }
  const fileBuffer = Buffer.concat(chunks);

  const parts: Buffer[] = [];
  // model field
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`
  ));
  // language field (optional)
  if (lang) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${lang}\r\n`
    ));
  }
  // file field
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`
  ));
  parts.push(fileBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Whisper API error: ${response.status} ${await response.text()}`);
  }

  const result = await response.json() as { text?: string };
  return result.text?.trim() ?? "";
}
