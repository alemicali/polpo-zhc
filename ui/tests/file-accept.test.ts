import { expect, test } from "vitest";
import { fileMatchesAccept, fileMediaType } from "../src/components/ai-elements/file-accept";

const f = (name: string, type: string) => ({ name, type });

test("*/* accepts any file, including one the browser gives no type (a Telegram .ogg export)", () => {
  for (const file of [f("audio_2026-11-03_05-18-45.ogg", ""), f("a.ogg", "audio/ogg"), f("a.ogg", "video/ogg"), f("x.pdf", "application/pdf"), f("p.png", "image/png")]) {
    expect(fileMatchesAccept(file, "*/*")).toBe(true);
  }
  expect(fileMatchesAccept(f("a.ogg", ""), undefined)).toBe(true);
});

test("families, exact types and extensions", () => {
  expect(fileMatchesAccept(f("p.png", "image/png"), "image/*")).toBe(true);
  expect(fileMatchesAccept(f("a.ogg", "audio/ogg"), "image/*")).toBe(false);
  expect(fileMatchesAccept(f("a.ogg", ""), "image/*, .ogg")).toBe(true);
  expect(fileMatchesAccept(f("A.OGG", ""), ".ogg")).toBe(true);
  expect(fileMatchesAccept(f("x.pdf", "application/pdf"), "application/pdf")).toBe(true);
});

test("the media type comes from the name when the browser does not know it", () => {
  expect(fileMediaType(f("audio_2026-11-03_05-18-45.ogg", ""))).toBe("audio/ogg");
  expect(fileMediaType(f("memo.m4a", ""))).toBe("audio/mp4");
  expect(fileMediaType(f("a.ogg", "video/ogg"))).toBe("video/ogg");
  expect(fileMediaType(f("blob", ""))).toBe("application/octet-stream");
});
