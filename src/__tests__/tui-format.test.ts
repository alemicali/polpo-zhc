import { describe, it, expect } from "vitest";
import { seg, statusIcon, statusColor, formatElapsed, providerLabel } from "../tui/format.js";

describe("seg", () => {
  it("creates segment with text only", () => {
    const s = seg("hello");
    expect(s).toEqual({ text: "hello", color: undefined, bold: undefined, dim: undefined });
  });

  it("creates segment with all properties", () => {
    const s = seg("err", "red", true, true);
    expect(s).toEqual({ text: "err", color: "red", bold: true, dim: true });
  });
});

describe("statusIcon", () => {
  it("returns correct icons for all statuses", () => {
    expect(statusIcon("pending")).toBe("○");
    expect(statusIcon("assigned")).toBe("◎");
    expect(statusIcon("in_progress")).toBe("●");
    expect(statusIcon("review")).toBe("◉");
    expect(statusIcon("done")).toBe("✓");
    expect(statusIcon("failed")).toBe("✗");
  });

  it("returns ? for unknown status", () => {
    expect(statusIcon("bogus" as any)).toBe("?");
  });
});

describe("statusColor", () => {
  it("returns correct colors for all statuses", () => {
    expect(statusColor("pending")).toBe("gray");
    expect(statusColor("assigned")).toBe("yellow");
    expect(statusColor("in_progress")).toBe("cyan");
    expect(statusColor("review")).toBe("magenta");
    expect(statusColor("done")).toBe("green");
    expect(statusColor("failed")).toBe("red");
  });

  it("returns white for unknown status", () => {
    expect(statusColor("bogus" as any)).toBe("white");
  });
});

describe("formatElapsed", () => {
  it("formats milliseconds", () => {
    expect(formatElapsed(500)).toBe("500ms");
    expect(formatElapsed(0)).toBe("0ms");
    expect(formatElapsed(999)).toBe("999ms");
  });

  it("formats seconds", () => {
    expect(formatElapsed(1000)).toBe("1.0s");
    expect(formatElapsed(5500)).toBe("5.5s");
    expect(formatElapsed(59999)).toBe("60.0s");
  });

  it("formats minutes", () => {
    expect(formatElapsed(60_000)).toBe("1.0m");
    expect(formatElapsed(90_000)).toBe("1.5m");
    expect(formatElapsed(300_000)).toBe("5.0m");
  });
});

describe("providerLabel", () => {
  it("returns human-readable labels for known providers", () => {
    expect(providerLabel("anthropic")).toBe("Anthropic");
    expect(providerLabel("openai")).toBe("OpenAI");
    expect(providerLabel("google")).toBe("Google");
    expect(providerLabel("openrouter")).toBe("OpenRouter");
    expect(providerLabel("opencode")).toBe("OpenCode");
  });

  it("returns raw id for unknown providers", () => {
    expect(providerLabel("custom")).toBe("custom");
  });
});
