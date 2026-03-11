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

  // ── Agent-scoped memory ──

  describe("agent-scoped memory", () => {
    it("exists() returns false for unknown agent", async () => {
      const store = new FileMemoryStore(TEST_DIR);
      expect(await store.exists("agent:alice")).toBe(false);
    });

    it("get() returns empty string for unknown agent", async () => {
      const store = new FileMemoryStore(TEST_DIR);
      expect(await store.get("agent:alice")).toBe("");
    });

    it("save() creates agent memory file in memory/ subdirectory", async () => {
      const store = new FileMemoryStore(TEST_DIR);
      await store.save("Alice's notes", "agent:alice");

      expect(await store.exists("agent:alice")).toBe(true);
      const raw = readFileSync(join(TEST_DIR, "memory", "alice.md"), "utf-8");
      expect(raw).toBe("Alice's notes");
    });

    it("agent memory is isolated from shared memory", async () => {
      const store = new FileMemoryStore(TEST_DIR);
      await store.save("shared content");
      await store.save("agent content", "agent:bob");

      expect(await store.get()).toBe("shared content");
      expect(await store.get("agent:bob")).toBe("agent content");
    });

    it("different agents have separate memories", async () => {
      const store = new FileMemoryStore(TEST_DIR);
      await store.save("alice notes", "agent:alice");
      await store.save("bob notes", "agent:bob");

      expect(await store.get("agent:alice")).toBe("alice notes");
      expect(await store.get("agent:bob")).toBe("bob notes");
    });

    it("append() works for agent-scoped memory", async () => {
      const store = new FileMemoryStore(TEST_DIR);
      await store.save("# Agent Notes", "agent:alice");
      await store.append("learned something new", "agent:alice");

      const content = await store.get("agent:alice");
      expect(content).toContain("# Agent Notes");
      expect(content).toMatch(/learned something new/);
    });

    it("update() works for agent-scoped memory", async () => {
      const store = new FileMemoryStore(TEST_DIR);
      await store.save("prefer tabs over spaces", "agent:alice");

      const result = await store.update("tabs", "spaces", "agent:alice");
      expect(result).toBe(true);
      expect(await store.get("agent:alice")).toBe("prefer spaces over spaces");
    });

    it("listScopes() returns agent names with memory", async () => {
      const store = new FileMemoryStore(TEST_DIR);
      await store.save("a", "agent:alice");
      await store.save("b", "agent:bob");

      const scopes = await store.listScopes();
      expect(scopes.sort()).toEqual(["alice", "bob"]);
    });

    it("listScopes() returns empty array when no agent memory", async () => {
      const store = new FileMemoryStore(TEST_DIR);
      await store.save("shared only");

      const scopes = await store.listScopes();
      expect(scopes).toEqual([]);
    });
  });
});
