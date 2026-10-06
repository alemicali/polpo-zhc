import { describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertWebUrl } from "../tools/browser-url-guard.js";
import { createBrowserTools } from "../tools/browser-tools.js";

describe("assertWebUrl", () => {
  test.each([
    "https://example.com/a?b=c", "http://localhost:3000/x", "HTTPS://EXAMPLE.COM", "example.com", "example.com:8080/path",
    "localhost:3000", "/relative/path", "//cdn.example.com/x", "about:blank", "  https://example.com  ", "https://example.com/a%3Ab",
  ])("allows %s", (url) => { expect(() => assertWebUrl(url)).not.toThrow(); });

  test.each([
    "file:///etc/passwd", "FILE:///etc/passwd", "FiLe:///etc/passwd", "  file:///etc/passwd", "\t\nfile:///etc/passwd", "\u0000file:///etc/passwd",
    "fi\tle:///etc/passwd", "fi\nle:///etc/passwd", "%66ile:///etc/passwd", "file%3A///etc/passwd", "%2566ile:///etc/passwd", "file%253A///etc/passwd",
    "view-source:https://example.com", "chrome://settings", "chrome-extension://abc/x.html", "devtools://devtools/bundled/inspector.html",
    "javascript:alert(1)", "javascript:1/alert(1)", "JaVaScRiPt:alert(1)", "ftp://example.com/x", "data:text/html,<h1>x</h1>", "blob:https://x/y",
    "about:config", "about:blank#x", "intranet:8080",
  ])("refuses %j", (url) => { expect(() => assertWebUrl(url)).toThrow(/only http and https/); });

  test("returns the cleaned URL", () => {
    expect(assertWebUrl("  https://example.com/x\n")).toBe("https://example.com/x");
  });
});

describe("browser tools", () => {
  const root = mkdtempSync(join(tmpdir(), "polpo-browser-"));
  const tool = (name: string, allowedPaths?: string[]) => createBrowserTools(root, "t", [name], undefined, join(root, "out"), allowedPaths)[0]!;

  test("navigate and new tab refuse local files before any browser starts", async () => {
    await expect(tool("browser_navigate").execute("1", { url: "file:///etc/passwd" } as any)).rejects.toThrow(/only http and https/);
    await expect(tool("browser_tabs").execute("1", { action: "new", url: "view-source:https://a.com" } as any)).rejects.toThrow(/only http and https/);
  });

  test("screenshots obey the allowed paths", async () => {
    await expect(tool("browser_screenshot", [root]).execute("1", { path: "/etc/shot.png" } as any)).rejects.toThrow(/access denied/);
    await expect(tool("browser_screenshot", [root]).execute("1", { path: "../x.png" } as any)).rejects.toThrow(/access denied/);
  });
});
