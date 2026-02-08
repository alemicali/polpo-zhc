import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FileMemoryStore } from "../stores/file-memory-store.js";

const TEST_DIR = join(process.cwd(), ".test-orchestra-memory");

describe("FileMemoryStore", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("exists() returns false when no memory file", () => {
    const store = new FileMemoryStore(TEST_DIR);
    expect(store.exists()).toBe(false);
  });

  it("get() returns empty string when no memory file", () => {
    const store = new FileMemoryStore(TEST_DIR);
    expect(store.get()).toBe("");
  });

  it("save() creates directory and memory file", () => {
    const store = new FileMemoryStore(TEST_DIR);
    store.save("# Project Memory\n\nSome content.");

    expect(store.exists()).toBe(true);
    const raw = readFileSync(join(TEST_DIR, "memory.md"), "utf-8");
    expect(raw).toBe("# Project Memory\n\nSome content.");
  });

  it("get() returns saved content", () => {
    const store = new FileMemoryStore(TEST_DIR);
    store.save("Hello world");
    expect(store.get()).toBe("Hello world");
  });

  it("save() overwrites existing content", () => {
    const store = new FileMemoryStore(TEST_DIR);
    store.save("first");
    store.save("second");
    expect(store.get()).toBe("second");
  });

  it("append() adds timestamped line", () => {
    const store = new FileMemoryStore(TEST_DIR);
    store.save("# Memory");
    store.append("Agent completed auth refactor");

    const content = store.get();
    expect(content).toContain("# Memory");
    expect(content).toMatch(/\d{4}-\d{2}-\d{2}: Agent completed auth refactor/);
  });

  it("append() creates file if missing", () => {
    const store = new FileMemoryStore(TEST_DIR);
    expect(store.exists()).toBe(false);

    store.append("first entry");
    expect(store.exists()).toBe(true);
    expect(store.get()).toMatch(/first entry/);
  });

  it("survives separate instances (persistence)", () => {
    const store1 = new FileMemoryStore(TEST_DIR);
    store1.save("persistent data");

    const store2 = new FileMemoryStore(TEST_DIR);
    expect(store2.get()).toBe("persistent data");
  });

  it("handles empty save gracefully", () => {
    const store = new FileMemoryStore(TEST_DIR);
    store.save("");
    expect(store.exists()).toBe(true);
    expect(store.get()).toBe("");
  });

  it("handles multiline content", () => {
    const store = new FileMemoryStore(TEST_DIR);
    const content = "# Memory\n\n## Architecture\n- TypeScript\n- Node.js\n\n## Notes\n- Important thing";
    store.save(content);
    expect(store.get()).toBe(content);
  });
});
