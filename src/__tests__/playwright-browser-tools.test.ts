/**
 * Tests for playwright-browser-tools.ts — persistent browser profile tools.
 *
 * These tests verify the factory logic and tool structure without requiring
 * a real browser (no playwright chromium needed). For integration tests
 * that actually launch a browser, use a separate E2E suite.
 */

import { describe, it, expect } from "vitest";
import {
  createPlaywrightBrowserTools,
  cleanupPlaywrightContext,
} from "../tools/playwright-browser-tools.js";

const FAKE_PROFILE = "/tmp/polpo-test-profile-" + Date.now();

describe("createPlaywrightBrowserTools", () => {
  it("creates all 18 browser tools when no filter is provided", () => {
    const tools = createPlaywrightBrowserTools("/tmp/cwd", FAKE_PROFILE);
    expect(tools).toHaveLength(18);
    const names = tools.map(t => t.name);
    expect(names).toContain("browser_navigate");
    expect(names).toContain("browser_snapshot");
    expect(names).toContain("browser_click");
    expect(names).toContain("browser_fill");
    expect(names).toContain("browser_type");
    expect(names).toContain("browser_press");
    expect(names).toContain("browser_screenshot");
    expect(names).toContain("browser_get");
    expect(names).toContain("browser_select");
    expect(names).toContain("browser_hover");
    expect(names).toContain("browser_scroll");
    expect(names).toContain("browser_wait");
    expect(names).toContain("browser_eval");
    expect(names).toContain("browser_close");
    expect(names).toContain("browser_back");
    expect(names).toContain("browser_forward");
    expect(names).toContain("browser_reload");
    expect(names).toContain("browser_tabs");
  });

  it("filters tools when allowedTools is provided", () => {
    const tools = createPlaywrightBrowserTools("/tmp/cwd", FAKE_PROFILE, [
      "browser_navigate",
      "browser_click",
      "browser_screenshot",
    ]);
    expect(tools).toHaveLength(3);
    const names = tools.map(t => t.name);
    expect(names).toEqual(["browser_navigate", "browser_click", "browser_screenshot"]);
  });

  it("returns empty array when allowedTools has no matching browser tools", () => {
    const tools = createPlaywrightBrowserTools("/tmp/cwd", FAKE_PROFILE, [
      "read_file",
      "write_file",
    ]);
    expect(tools).toHaveLength(0);
  });

  it("all tools have required properties", () => {
    const tools = createPlaywrightBrowserTools("/tmp/cwd", FAKE_PROFILE);
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.label).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.parameters).toBeTruthy();
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("tool names match the browser-tools.ts naming convention", () => {
    const tools = createPlaywrightBrowserTools("/tmp/cwd", FAKE_PROFILE);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^browser_/);
    }
  });

  it("cleanupPlaywrightContext handles non-existent profile gracefully", async () => {
    // Should not throw for a profile that was never opened
    await expect(cleanupPlaywrightContext("/tmp/nonexistent-profile-xyz")).resolves.toBeUndefined();
  });
});
