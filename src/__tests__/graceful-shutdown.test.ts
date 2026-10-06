import { describe, it, expect, vi, afterEach } from "vitest";
import { TypedEmitter } from "../core/events.js";
import { PolpoServer } from "../server/index.js";
import type { LogStore } from "../core/log-store.js";

describe("graceful shutdown", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a failing log write never becomes an unhandled rejection", async () => {
    // With the database closed, every append rejects. Before the fix the rejection was unhandled,
    // the unhandledRejection handler logged it, which appended again: an endless microtask loop.
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const emitter = new TypedEmitter();
      // A plain function: vi.fn() observes the promises it returns, which would mark them handled.
      let appends = 0;
      const append = async () => { appends++; throw new Error("CONNECTION_ENDED"); };
      emitter.setLogSink({ append } as unknown as LogStore);
      const listener = vi.fn();
      emitter.on("log", listener);

      emitter.emit("log", { level: "info", message: "after the database closed" });
      await new Promise((r) => setTimeout(r, 20));

      expect(appends).toBe(1);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("a synchronous log store failure is swallowed too", () => {
    const emitter = new TypedEmitter();
    emitter.setLogSink({ append: () => { throw new Error("boom"); } } as unknown as LogStore);
    expect(() => emitter.emit("log", { level: "info", message: "x" })).not.toThrow();
  });

  it("setLogSink(undefined) stops writing", () => {
    const emitter = new TypedEmitter();
    const append = vi.fn(async () => {});
    emitter.setLogSink({ append } as unknown as LogStore);
    emitter.setLogSink(undefined);
    emitter.emit("log", { level: "info", message: "x" });
    expect(append).not.toHaveBeenCalled();
  });

  it("server.stop() called twice (two SIGTERM handlers) runs one shutdown", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const server = new PolpoServer({ port: 0, host: "127.0.0.1", workDir: process.cwd() } as any);
    let release!: () => void;
    const gracefulStop = vi.fn(() => new Promise<void>((r) => { release = r; }));
    (server as any).orchestrator = { isInitialized: true, gracefulStop };

    const first = server.stop();
    const second = server.stop();
    expect(second).toBe(first);
    release();
    await Promise.all([first, second]);
    expect(gracefulStop).toHaveBeenCalledTimes(1);
  });
});
