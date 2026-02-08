import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JsonConfigStore } from "../stores/json-config-store.js";
import type { ProjectConfig } from "../core/types.js";

const TEST_DIR = join(process.cwd(), ".test-orchestra-config");

describe("JsonConfigStore", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("exists() returns false when no config file", () => {
    const store = new JsonConfigStore(TEST_DIR);
    expect(store.exists()).toBe(false);
  });

  it("get() returns undefined when no config file", () => {
    const store = new JsonConfigStore(TEST_DIR);
    expect(store.get()).toBeUndefined();
  });

  it("save() creates directory and config file", () => {
    const store = new JsonConfigStore(TEST_DIR);
    const config: ProjectConfig = { project: "test", judge: "claude-sdk", agent: "generic", model: "haiku" };
    store.save(config);

    expect(store.exists()).toBe(true);
    const raw = readFileSync(join(TEST_DIR, "config.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.judge).toBe("claude-sdk");
    expect(parsed.agent).toBe("generic");
    expect(parsed.model).toBe("haiku");
  });

  it("get() returns saved config", () => {
    const store = new JsonConfigStore(TEST_DIR);
    const config: ProjectConfig = { project: "test", judge: "claude-sdk", agent: "claude-sdk", model: "sonnet" };
    store.save(config);

    const loaded = store.get();
    expect(loaded).toEqual(config);
  });

  it("save() overwrites existing config", () => {
    const store = new JsonConfigStore(TEST_DIR);
    store.save({ project: "p", judge: "a", agent: "b", model: "c" });
    store.save({ project: "p", judge: "x", agent: "y", model: "z" });

    const loaded = store.get();
    expect(loaded?.judge).toBe("x");
    expect(loaded?.agent).toBe("y");
    expect(loaded?.model).toBe("z");
  });

  it("get() returns undefined for corrupted JSON", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(TEST_DIR, "config.json"), "not json", "utf-8");

    const store = new JsonConfigStore(TEST_DIR);
    expect(store.exists()).toBe(true);
    expect(store.get()).toBeUndefined();
  });

  it("get() returns undefined for JSON missing required fields", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(TEST_DIR, "config.json"), JSON.stringify({ foo: "bar" }), "utf-8");

    const store = new JsonConfigStore(TEST_DIR);
    expect(store.exists()).toBe(true);
    expect(store.get()).toBeUndefined();
  });

  it("survives separate instances (persistence)", () => {
    const store1 = new JsonConfigStore(TEST_DIR);
    store1.save({ project: "test", judge: "claude-sdk", agent: "generic", model: "opus" });

    const store2 = new JsonConfigStore(TEST_DIR);
    const loaded = store2.get();
    expect(loaded?.model).toBe("opus");
  });
});
