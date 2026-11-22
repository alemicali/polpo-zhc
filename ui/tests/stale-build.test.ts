import { describe, it, expect, vi, beforeEach } from "vitest";
import { isStaleChunkError, reloadForNewBuild } from "@/lib/stale-build";

describe("stale build recovery", () => {
  beforeEach(() => { sessionStorage.clear(); });

  it("recognises the errors of chunks from a previous deploy", () => {
    expect(isStaleChunkError(new TypeError("Failed to fetch dynamically imported module: https://x/assets/changelog-OLD.js"))).toBe(true);
    expect(isStaleChunkError(new TypeError("error loading dynamically imported module"))).toBe(true);
    expect(isStaleChunkError(new Error("Importing a module script failed."))).toBe(true);
    expect(isStaleChunkError(new Error("Cannot read properties of undefined"))).toBe(false);
  });

  it("reloads once, then not again within a minute (no loop)", () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, reload }, writable: true });
    expect(reloadForNewBuild()).toBe(true);
    expect(reloadForNewBuild()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
