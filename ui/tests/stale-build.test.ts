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

  it("reloads once, then not again within a minute (no loop)", async () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, reload }, writable: true });
    expect(reloadForNewBuild()).toBe(true);
    expect(reloadForNewBuild()).toBe(false);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it("tells a waiting service worker to take over before reloading", async () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, reload }, writable: true });
    const listeners: Record<string, () => void> = {};
    const waiting = { postMessage: vi.fn(() => listeners.controllerchange?.()) };
    const registration = { update: vi.fn(async () => undefined), waiting, installing: null };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistration: vi.fn(async () => registration),
        addEventListener: (type: string, fn: () => void) => { listeners[type] = fn; },
      },
    });
    expect(reloadForNewBuild()).toBe(true);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(registration.update).toHaveBeenCalled();
  });
});
