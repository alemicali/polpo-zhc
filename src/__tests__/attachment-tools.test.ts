import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAttachmentTools } from "../tools/attachment-tools.js";

// ── Helpers ──────────────────────────────────────────

let testDir: string;

function getTool() {
  const tools = createAttachmentTools(testDir);
  const tool = tools.find(t => t.name === "read_attachment");
  if (!tool) throw new Error("read_attachment tool not found");
  return tool;
}

// ── Setup / Teardown ─────────────────────────────────

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "polpo-att-tools-"));
});

afterEach(() => {
  try { rmSync(testDir, { recursive: true }); } catch { /* ok */ }
});

// ── Tests ────────────────────────────────────────────

describe("read_attachment tool", () => {
  describe("tool metadata", () => {
    it("has correct name and description", () => {
      const tool = getTool();
      expect(tool.name).toBe("read_attachment");
      expect(tool.description).toContain("Read a file attached by the user");
      expect(tool.description).toContain("images");
    });

    it("is included by default when no allowedTools filter", () => {
      const tools = createAttachmentTools(testDir);
      expect(tools.map(t => t.name)).toContain("read_attachment");
    });

    it("is excluded when allowedTools does not include it", () => {
      const tools = createAttachmentTools(testDir, undefined, ["some_other_tool"]);
      expect(tools.map(t => t.name)).not.toContain("read_attachment");
    });
  });

  describe("text file reading", () => {
    it("reads a .txt file and returns text content", async () => {
      const filePath = join(testDir, "hello.txt");
      writeFileSync(filePath, "Hello, world!");

      const tool = getTool();
      const result = await tool.execute("call-1", { path: filePath });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as { type: "text"; text: string }).text).toBe("Hello, world!");
    });

    it("reads a .json file and returns text content", async () => {
      const jsonData = JSON.stringify({ name: "polpo", version: "1.0" }, null, 2);
      const filePath = join(testDir, "data.json");
      writeFileSync(filePath, jsonData);

      const tool = getTool();
      const result = await tool.execute("call-2", { path: filePath });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as { type: "text"; text: string }).text).toBe(jsonData);
    });

    it("reads a .csv file and returns text content", async () => {
      const csvData = "name,age,city\nAlice,30,NYC\nBob,25,LA";
      const filePath = join(testDir, "people.csv");
      writeFileSync(filePath, csvData);

      const tool = getTool();
      const result = await tool.execute("call-3", { path: filePath });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as { type: "text"; text: string }).text).toBe(csvData);
    });

    it("reads a .tsv file and returns text content", async () => {
      const tsvData = "name\tage\nAlice\t30";
      const filePath = join(testDir, "data.tsv");
      writeFileSync(filePath, tsvData);

      const tool = getTool();
      const result = await tool.execute("call-4", { path: filePath });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as { type: "text"; text: string }).text).toBe(tsvData);
    });

    it("reads a file with no recognized extension as plain text", async () => {
      const filePath = join(testDir, "readme.md");
      writeFileSync(filePath, "# Title\n\nSome markdown content.");

      const tool = getTool();
      const result = await tool.execute("call-5", { path: filePath });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect((result.content[0] as { type: "text"; text: string }).text).toContain("# Title");
    });
  });

  describe("image file reading", () => {
    it("reads a .png file and returns ImageContent with base64 data", async () => {
      // Create a minimal valid PNG (1x1 pixel, red)
      const pngBuffer = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
        "base64",
      );
      const filePath = join(testDir, "image.png");
      writeFileSync(filePath, pngBuffer);

      const tool = getTool();
      const result = await tool.execute("call-img-1", { path: filePath });

      expect(result.content).toHaveLength(2);

      // First content block should be the image
      const imageContent = result.content[0] as { type: "image"; data: string; mimeType: string };
      expect(imageContent.type).toBe("image");
      expect(imageContent.mimeType).toBe("image/png");
      expect(imageContent.data).toBeTruthy();
      // Verify the base64 data round-trips correctly
      expect(Buffer.from(imageContent.data, "base64").length).toBe(pngBuffer.length);

      // Second content block should be the text description
      const textContent = result.content[1] as { type: "text"; text: string };
      expect(textContent.type).toBe("text");
      expect(textContent.text).toContain("image.png");
      expect(textContent.text).toContain("image/png");
      expect(textContent.text).toContain(`${pngBuffer.byteLength} bytes`);
    });

    it("reads a .jpg file and returns ImageContent with correct mime type", async () => {
      // Minimal JPEG header (not a fully valid JPEG, but enough for the tool)
      const jpgBuffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
      const filePath = join(testDir, "photo.jpg");
      writeFileSync(filePath, jpgBuffer);

      const tool = getTool();
      const result = await tool.execute("call-img-2", { path: filePath });

      expect(result.content).toHaveLength(2);
      const imageContent = result.content[0] as { type: "image"; data: string; mimeType: string };
      expect(imageContent.type).toBe("image");
      expect(imageContent.mimeType).toBe("image/jpeg");
    });

    it("reads a .webp file and returns ImageContent with correct mime type", async () => {
      const webpBuffer = Buffer.from([0x52, 0x49, 0x46, 0x46]); // RIFF header start
      const filePath = join(testDir, "image.webp");
      writeFileSync(filePath, webpBuffer);

      const tool = getTool();
      const result = await tool.execute("call-img-3", { path: filePath });

      const imageContent = result.content[0] as { type: "image"; data: string; mimeType: string };
      expect(imageContent.type).toBe("image");
      expect(imageContent.mimeType).toBe("image/webp");
    });
  });

  describe("error handling", () => {
    it("returns error content for non-existent file", async () => {
      const tool = getTool();
      const result = await tool.execute("call-err-1", { path: join(testDir, "does-not-exist.txt") });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Error reading attachment");
    });

    it("throws for path outside sandbox", async () => {
      const outsidePath = "/etc/passwd";
      const tool = getTool();

      // assertPathAllowed fires before the try/catch, so it throws
      await expect(tool.execute("call-err-2", { path: outsidePath }))
        .rejects.toThrow("[sandbox] read_attachment: access denied");
    });
  });

  describe("truncation", () => {
    it("truncates text content exceeding 50,000 characters", async () => {
      const longContent = "x".repeat(60_000);
      const filePath = join(testDir, "huge.txt");
      writeFileSync(filePath, longContent);

      const tool = getTool();
      const result = await tool.execute("call-trunc-1", { path: filePath });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text.length).toBeLessThan(longContent.length);
      expect(text).toContain("...(truncated)");
    });
  });
});
