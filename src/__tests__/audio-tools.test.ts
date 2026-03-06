import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { createAudioTools } from "../tools/audio-tools.js";

const TEST_DIR = join("/tmp", "polpo-audio-tools-test");

describe("Audio Tools — sandbox enforcement", () => {
  const tools = createAudioTools(TEST_DIR, [TEST_DIR]);
  const speakTool = tools.find(t => t.name === "audio_speak")!;
  const transcribeTool = tools.find(t => t.name === "audio_transcribe")!;

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
