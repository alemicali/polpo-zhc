import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock node:fs before imports
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    statSync: vi.fn(),
    readdirSync: vi.fn(),
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

import { statSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { SessionWatcher } from "../bridge/watcher.js";
import { SessionTracker, decodeProjectDir } from "../bridge/tracker.js";
import { BridgeManager, DEFAULT_BRIDGE_CONFIG } from "../bridge/index.js";
import type { BridgeConfig } from "../bridge/types.js";

const MOCK_HOME = homedir();
const CLAUDE_PROJECTS = join(MOCK_HOME, ".claude", "projects");

// Minimal JSONL content for a Claude Code session
const MOCK_JSONL = [
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello, working on the task."},{"type":"tool_use","name":"Read","input":{"file_path":"src/main.ts"}},{"type":"tool_use","name":"Write","input":{"file_path":"src/new.ts"}},{"type":"tool_use","name":"Edit","input":{"file_path":"src/main.ts"}}]}}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done with changes."}]}}',
].join("\n");

function makeConfig(overrides?: Partial<BridgeConfig>): BridgeConfig {
  return {
    ...DEFAULT_BRIDGE_CONFIG,
    pollInterval: 100, // fast for tests
    sessionTimeout: 500,
    ...overrides,
  };
}

describe("decodeProjectDir", () => {
  it("decodes Claude Code encoded path", () => {
    expect(decodeProjectDir("-home-user-my-project")).toBe("/home/user/my/project");
  });

  it("returns non-encoded paths as-is", () => {
    expect(decodeProjectDir("some-dir")).toBe("some-dir");
  });
});

describe("SessionWatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("discovers new JSONL files", () => {
    const config = makeConfig();
    const watcher = new SessionWatcher(config);

    // Mock: ~/.claude/projects exists with one project dir
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockImplementation(((p: string, opts?: any) => {
      if (p === CLAUDE_PROJECTS && opts?.withFileTypes) {
        return [{ name: "-home-user-project", isDirectory: () => true }] as any;
      }
      if (p === join(CLAUDE_PROJECTS, "-home-user-project")) {
        return ["abc123.jsonl"];
      }
      return [];
    }) as any);
    vi.mocked(statSync).mockReturnValue({ size: 1024 } as any);

    const discovered: any[] = [];
    watcher.on("file:discovered", (e) => discovered.push(e));

    watcher.start();
    watcher.stop();

    expect(discovered).toHaveLength(1);
    expect(discovered[0].transcriptPath).toContain("abc123.jsonl");
    expect(discovered[0].fileSize).toBe(1024);
  });

  it("emits file:updated when file size grows", () => {
    const config = makeConfig();
    const watcher = new SessionWatcher(config);

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockImplementation(((p: string, opts?: any) => {
      if (p === CLAUDE_PROJECTS && opts?.withFileTypes) {
        return [{ name: "-home-user-project", isDirectory: () => true }] as any;
      }
      if (p === join(CLAUDE_PROJECTS, "-home-user-project")) {
        return ["session1.jsonl"];
      }
      return [];
    }) as any);

    let callCount = 0;
    vi.mocked(statSync).mockImplementation(() => {
      callCount++;
      return { size: callCount === 1 ? 500 : 1000 } as any;
    });

    const discovered: any[] = [];
    const updated: any[] = [];
    watcher.on("file:discovered", (e) => discovered.push(e));
    watcher.on("file:updated", (e) => updated.push(e));

    // First scan: discovers
    watcher.start();
    watcher.stop();

    expect(discovered).toHaveLength(1);
    expect(updated).toHaveLength(0);

    // Second scan: file grew → updated
    watcher.start();
    watcher.stop();

    expect(updated).toHaveLength(1);
    expect(updated[0].previousSize).toBe(500);
    expect(updated[0].fileSize).toBe(1000);
  });

  it("ignores unchanged files", () => {
    const config = makeConfig();
    const watcher = new SessionWatcher(config);

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockImplementation(((p: string, opts?: any) => {
      if (p === CLAUDE_PROJECTS && opts?.withFileTypes) {
        return [{ name: "-home-user-project", isDirectory: () => true }] as any;
      }
      if (p === join(CLAUDE_PROJECTS, "-home-user-project")) {
        return ["session1.jsonl"];
      }
      return [];
    }) as any);
    vi.mocked(statSync).mockReturnValue({ size: 500 } as any);

    const updated: any[] = [];
    watcher.on("file:updated", (e) => updated.push(e));

    // Two scans with same size
    watcher.start();
    watcher.stop();
    watcher.start();
    watcher.stop();

    expect(updated).toHaveLength(0);
  });

  it("skips empty files", () => {
    const config = makeConfig();
    const watcher = new SessionWatcher(config);

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockImplementation(((p: string, opts?: any) => {
      if (opts?.withFileTypes) {
        return [{ name: "-proj", isDirectory: () => true }] as any;
      }
      return ["empty.jsonl"];
    }) as any);
    vi.mocked(statSync).mockReturnValue({ size: 0 } as any);

    const discovered: any[] = [];
    watcher.on("file:discovered", (e) => discovered.push(e));

    watcher.start();
    watcher.stop();

    expect(discovered).toHaveLength(0);
  });
});

describe("SessionTracker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readFileSync).mockReturnValue(MOCK_JSONL);
    vi.mocked(existsSync).mockReturnValue(true);
  });

  it("handles discovered session and emits events", () => {
    const tracker = new SessionTracker(makeConfig());
    const events: any[] = [];

    tracker.on("bridge:session:discovered", (e) => events.push({ type: "discovered", ...e }));
    tracker.on("bridge:session:activity", (e) => events.push({ type: "activity", ...e }));

    tracker.handleDiscovered("/mock/path/abc123.jsonl", "-home-user-project", 1024);

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("discovered");
    expect(events[0].sessionId).toBe("abc123");
    expect(events[1].type).toBe("activity");
    expect(events[1].messageCount).toBe(2);
    expect(events[1].toolCalls).toContain("Read");
    expect(events[1].filesCreated).toContain("src/new.ts");
    expect(events[1].filesEdited).toContain("src/main.ts");
  });

  it("handles updated session and refreshes summary", () => {
    const tracker = new SessionTracker(makeConfig());

    tracker.handleDiscovered("/mock/path/s1.jsonl", "-proj", 500);

    const activityEvents: any[] = [];
    tracker.on("bridge:session:activity", (e) => activityEvents.push(e));

    tracker.handleUpdated("/mock/path/s1.jsonl", "-proj", 1000);

    expect(activityEvents).toHaveLength(1);
    expect(activityEvents[0].messageCount).toBe(2);
  });

  it("marks sessions completed after timeout", async () => {
    const config = makeConfig({ sessionTimeout: 100 });
    const tracker = new SessionTracker(config);

    tracker.handleDiscovered("/mock/path/s1.jsonl", "-proj", 500);

    const completedEvents: any[] = [];
    tracker.on("bridge:session:completed", (e) => completedEvents.push(e));

    // Wait past timeout
    await new Promise(r => setTimeout(r, 150));
    tracker.checkTimeouts();

    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].sessionId).toBe("s1");
    expect(completedEvents[0].duration).toBeGreaterThanOrEqual(0);
  });

  it("transitions active → idle → completed", async () => {
    const config = makeConfig({ sessionTimeout: 200 });
    const tracker = new SessionTracker(config);

    tracker.handleDiscovered("/mock/path/s1.jsonl", "-proj", 500);

    const sessions = tracker.getSessions();
    expect(sessions[0].status).toBe("active");

    // After half the timeout → idle
    await new Promise(r => setTimeout(r, 120));
    tracker.checkTimeouts();

    expect(tracker.getSessions()[0].status).toBe("idle");

    // After full timeout → completed
    await new Promise(r => setTimeout(r, 120));
    tracker.checkTimeouts();

    expect(tracker.getSessions()[0].status).toBe("completed");
  });

  it("getStats returns correct counts", () => {
    const tracker = new SessionTracker(makeConfig());

    tracker.handleDiscovered("/mock/p1.jsonl", "-a", 100);
    tracker.handleDiscovered("/mock/p2.jsonl", "-b", 200);

    const stats = tracker.getStats();
    expect(stats.total).toBe(2);
    expect(stats.active).toBe(2);
    expect(stats.idle).toBe(0);
    expect(stats.completed).toBe(0);
  });
});

describe("BridgeManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readFileSync).mockReturnValue(MOCK_JSONL);
  });

  it("lifecycle: start and stop without errors", () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const manager = new BridgeManager(makeConfig());
    manager.start();
    manager.stop();

    expect(manager.getStats().total).toBe(0);
  });

  it("forwards events from watcher → tracker → emitter", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockImplementation(((p: string, opts?: any) => {
      if (opts?.withFileTypes) {
        return [{ name: "-home-user-proj", isDirectory: () => true }] as any;
      }
      return ["sess1.jsonl"];
    }) as any);
    vi.mocked(statSync).mockReturnValue({ size: 2048 } as any);

    const config = makeConfig();
    const manager = new BridgeManager(config);

    const events: string[] = [];
    manager.emitter.on("bridge:session:discovered", () => events.push("discovered"));
    manager.emitter.on("bridge:session:activity", () => events.push("activity"));

    manager.start();
    manager.stop();

    expect(events).toContain("discovered");
    expect(events).toContain("activity");
    expect(manager.getSessions()).toHaveLength(1);
  });
});

describe("readSessionSummaryFromPath", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses JSONL and extracts summary fields", async () => {
    vi.mocked(readFileSync).mockReturnValue(MOCK_JSONL);

    // Import after mocking
    const { readSessionSummaryFromPath } = await import("../core/session-reader.js");
    const summary = readSessionSummaryFromPath("/fake/path/mysession.jsonl");

    expect(summary).not.toBeNull();
    expect(summary!.sessionId).toBe("mysession");
    expect(summary!.messageCount).toBe(2);
    expect(summary!.toolCalls).toEqual(["Read", "Write", "Edit"]);
    expect(summary!.filesCreated).toEqual(["src/new.ts"]);
    expect(summary!.filesEdited).toEqual(["src/main.ts"]);
    expect(summary!.lastMessage).toBe("Done with changes.");
  });

  it("returns null for unreadable files", async () => {
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error("ENOENT"); });

    const { readSessionSummaryFromPath } = await import("../core/session-reader.js");
    const summary = readSessionSummaryFromPath("/fake/nonexistent.jsonl");

    expect(summary).toBeNull();
  });
});
