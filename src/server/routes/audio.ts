/**
 * Audio REST API — direct TTS endpoint for the chat UI.
 *
 * POST /audio/speak — Generate speech audio from text using edge-tts.
 *
 * Bypasses the agent/LLM loop: takes text, returns audio bytes. Uses
 * Microsoft Edge neural TTS via the `edge-tts` Python CLI (free, no API key).
 *
 * Reuses helpers from src/tools/audio-tools.ts (edgeTtsAvailable, resolveEdgeVoice)
 * to stay consistent with the audio_speak agent tool.
 */

import { Hono } from "hono";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveEdgeTtsBin, resolveEdgeVoice } from "../../tools/audio-tools.js";

const TTS_TIMEOUT_MS = 60_000;
const MAX_TEXT_LENGTH = 5000;

interface SpeakBody {
  text?: string;
  language?: string;
  voice?: string;
  gender?: "male" | "female";
}

export function audioRoutes(): Hono {
  const app = new Hono();

  app.post("/speak", async (c) => {
    let body: SpeakBody;
    try {
      body = await c.req.json<SpeakBody>();
    } catch {
      return c.json({ ok: false, error: "Invalid JSON body" }, 400);
    }

    const text = (body.text ?? "").trim();
    if (!text) return c.json({ ok: false, error: "text is required" }, 400);
    if (text.length > MAX_TEXT_LENGTH) {
      return c.json({ ok: false, error: `text too long (max ${MAX_TEXT_LENGTH} chars)` }, 400);
    }

    const bin = resolveEdgeTtsBin();
    if (!bin) {
      return c.json({
        ok: false,
        error: "edge-tts CLI is not installed on the server. Install with: pip install edge-tts",
      }, 503);
    }

    const voice = resolveEdgeVoice(body.voice, body.language, body.gender);
    const tmpDir = mkdtempSync(join(tmpdir(), "polpo-tts-"));
    const filePath = join(tmpDir, "out.mp3");

    try {
      await new Promise<void>((resolvePromise, reject) => {
        const child = execFile(
          bin,
          ["--text", text, "--voice", voice, "--write-media", filePath],
          { timeout: TTS_TIMEOUT_MS },
          (err, _stdout, stderr) => {
            if (err) reject(new Error(`edge-tts failed: ${err.message}${stderr ? ` — ${stderr}` : ""}`));
            else resolvePromise();
          },
        );
        const onAbort = () => child.kill();
        c.req.raw.signal?.addEventListener("abort", onAbort, { once: true });
      });

      const buffer = readFileSync(filePath);
      return new Response(new Uint8Array(buffer) as any, {
        status: 200,
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Length": String(buffer.length),
          "Cache-Control": "no-store",
          "X-TTS-Voice": voice,
        },
      });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message ?? "TTS generation failed" }, 500);
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  return app;
}
