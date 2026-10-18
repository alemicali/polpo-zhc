import { describe, expect, it } from "vitest";
import { channelTurnPrompt } from "../server/channel-turn-prompt.js";

describe("channelTurnPrompt", () => {
  it("keeps the Telegram guidance for Telegram turns (and the reaction hint)", () => {
    const text = channelTurnPrompt("telegram", "React with 👍 when…")!;
    expect(text).toContain("This turn comes from Telegram");
    expect(text).toContain("React with 👍 when…");
  });

  it("falls back to the Telegram guidance for channels without their own (previous behaviour)", () => {
    expect(channelTurnPrompt(undefined, "hint")).toContain("Telegram");
  });

  it("tells the agent a voice turn is heard aloud: short, spoken, no markdown, transcript may be imperfect", () => {
    const text = channelTurnPrompt("voice", "React with 👍 when…")!;
    expect(text).not.toContain("Telegram");
    expect(text).not.toContain("React with");
    expect(text).toMatch(/spoken|aloud/i);
    expect(text).toMatch(/short/i);
    expect(text).toMatch(/markdown/i);
    expect(text).toMatch(/transcri/i);
  });
});
