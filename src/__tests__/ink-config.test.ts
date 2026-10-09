import { afterEach, describe, expect, it } from "vitest";
import { inkApiUrl, inkRegistry } from "../core/ink-config.js";

describe("ink config", () => {
  const saved = { api: process.env.POLPO_INK_API_URL, registry: process.env.POLPO_INK_REGISTRY };
  afterEach(() => {
    if (saved.api === undefined) delete process.env.POLPO_INK_API_URL; else process.env.POLPO_INK_API_URL = saved.api;
    if (saved.registry === undefined) delete process.env.POLPO_INK_REGISTRY; else process.env.POLPO_INK_REGISTRY = saved.registry;
  });

  it("defaults to the public hub and registry", () => {
    delete process.env.POLPO_INK_API_URL;
    delete process.env.POLPO_INK_REGISTRY;
    expect(inkApiUrl()).toBe("https://polpo.sh/api");
    expect(inkRegistry()).toBe("lumea-labs/ink-registry");
  });

  it("follows a self-hosted hub and registry", () => {
    process.env.POLPO_INK_API_URL = "http://127.0.0.1:3700/api/";
    process.env.POLPO_INK_REGISTRY = "lumea-labs/polpo-ink-registry";
    expect(inkApiUrl()).toBe("http://127.0.0.1:3700/api");
    expect(inkRegistry()).toBe("lumea-labs/polpo-ink-registry");
  });
});
