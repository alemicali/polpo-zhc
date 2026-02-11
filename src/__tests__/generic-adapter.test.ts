import { describe, it, expect } from "vitest";
import { shellEscape } from "../adapters/generic.js";

describe("shellEscape", () => {
  it("wraps in single quotes", () => {
    expect(shellEscape("hello")).toBe("'hello'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
  });

  it("handles empty string", () => {
    expect(shellEscape("")).toBe("''");
  });

  it("handles special characters", () => {
    const input = 'echo "hello" && rm -rf /';
    const escaped = shellEscape(input);
    expect(escaped).toBe(`'echo "hello" && rm -rf /'`);
  });

  it("handles newlines", () => {
    const input = "line1\nline2";
    const escaped = shellEscape(input);
    expect(escaped).toBe("'line1\nline2'");
  });

  it("handles multiple single quotes", () => {
    expect(shellEscape("it's a 'test'")).toBe("'it'\\''s a '\\''test'\\'''");
  });
});
