import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createAudioTools } from "../tools/audio-tools.js";

const TEST_DIR = join("/tmp", "polpo-audio-tools-test");

/** Extract text from tool result */
const txt = (r: any): string => (r.content[0] as any).text as string;

/**
 * Real integration test: generates speech via OpenAI TTS, then transcribes it back via Whisper.
 * Requires OPENAI_API_KEY env var.
 */
describe("Audio Tools — TTS → STT round-trip (OpenAI)", () => {
  const shouldRun = !!process.env.OPENAI_API_KEY;

  beforeAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  const tools = createAudioTools(TEST_DIR, [TEST_DIR]);
  const speakTool = tools.find(t => t.name === "audio_speak")!;
  const transcribeTool = tools.find(t => t.name === "audio_transcribe")!;

  it.skipIf(!shouldRun)("generates speech audio from text", async () => {
    const result = await speakTool.execute("t1", {
      text: "The quick brown fox jumps over the lazy dog.",
      path: "round-trip.mp3",
      provider: "openai",
      model: "tts-1",
      voice: "alloy",
    });

    const output = txt(result);
    expect(output).toContain("Speech audio saved");
    expect(output).toContain("round-trip.mp3");
    expect(result.details.provider).toBe("openai");
    expect(result.details.model).toBe("tts-1");
    expect(result.details.voice).toBe("alloy");
    expect(result.details.bytes).toBeGreaterThan(1000);

    // File actually exists and has content
    const filePath = join(TEST_DIR, "round-trip.mp3");
    expect(existsSync(filePath)).toBe(true);
    expect(statSync(filePath).size).toBeGreaterThan(1000);
  }, 30_000);

  it.skipIf(!shouldRun)("transcribes the generated audio back to text", async () => {
    const result = await transcribeTool.execute("t2", {
      path: "round-trip.mp3",
      provider: "openai",
      model: "whisper-1",
      language: "en",
    });

    const output = txt(result);
    expect(output).toContain("Model: whisper-1");

    // The transcription should contain the original words (case-insensitive)
    const lower = output.toLowerCase();
    expect(lower).toContain("quick");
    expect(lower).toContain("brown");
    expect(lower).toContain("fox");
    expect(lower).toContain("lazy");
    expect(lower).toContain("dog");

    expect(result.details.provider).toBe("openai");
    expect(result.details.textLength).toBeGreaterThan(10);
  }, 30_000);

  // ── Sandbox enforcement ──

  it("rejects audio_speak outside sandbox", async () => {
    await expect(
      speakTool.execute("t3", {
        text: "nope",
        path: "/etc/evil.mp3",
      }),
    ).rejects.toThrow("sandbox");
  });

  it("rejects audio_transcribe outside sandbox", async () => {
    await expect(
      transcribeTool.execute("t4", {
        path: "/etc/passwd",
      }),
    ).rejects.toThrow("sandbox");
  });
});
