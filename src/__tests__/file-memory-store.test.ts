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

  it("exists() returns false when no memory file", async () => {
    const store = new FileMemoryStore(TEST_DIR);
    expect(await store.exists()).toBe(false);
  });

  it("get() returns empty string when no memory file", async () => {
    const store = new FileMemoryStore(TEST_DIR);
    expect(await store.get()).toBe("");
  });

  it("save() creates directory and memory file", async () => {
    const store = new FileMemoryStore(TEST_DIR);
    await store.save("# Project Memory\n\nSome content.");

    expect(await store.exists()).toBe(true);
    const raw = readFileSync(join(TEST_DIR, "memory.md"), "utf-8");
    expect(raw).toBe("# Project Memory\n\nSome content.");
  });

  it("get() returns saved content", async () => {
    const store = new FileMemoryStore(TEST_DIR);
    await store.save("Hello world");
    expect(await store.get()).toBe("Hello world");
  });

  it("save() overwrites existing content", async () => {
    const store = new FileMemoryStore(TEST_DIR);
    await store.save("first");
    await store.save("second");
    expect(await store.get()).toBe("second");
  });

  it("append() adds timestamped line", async () => {
    const store = new FileMemoryStore(TEST_DIR);
    await store.save("# Memory");
    await store.append("Agent completed auth refactor");

    const content = await store.get();
    expect(content).toContain("# Memory");
    expect(content).toMatch(/\d{4}-\d{2}-\d{2}: Agent completed auth refactor/);
  });

  it("append() creates file if missing", async () => {
    const store = new FileMemoryStore(TEST_DIR);
    expect(await store.exists()).toBe(false);

    await store.append("first entry");
    expect(await store.exists()).toBe(true);
    expect(await store.get()).toMatch(/first entry/);
  });

  it("survives separate instances (persistence)", async () => {
    const store1 = new FileMemoryStore(TEST_DIR);
    await store1.save("persistent data");

    const store2 = new FileMemoryStore(TEST_DIR);
    expect(await store2.get()).toBe("persistent data");
  });

  it("handles empty save gracefully", async () => {
    const store = new FileMemoryStore(TEST_DIR);
    await store.save("");
    expect(await store.exists()).toBe(true);
    expect(await store.get()).toBe("");
  });

  it("handles multiline content", async () => {
    const store = new FileMemoryStore(TEST_DIR);
    const content = "# Memory\n\n## Architecture\n- TypeScript\n- Node.js\n\n## Notes\n- Important thing";
    await store.save(content);
    expect(await store.get()).toBe(content);
  });
});
