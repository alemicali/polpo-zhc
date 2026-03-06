import { describe, it, expect } from "vitest";
import { seg } from "../tui/format.js";

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


