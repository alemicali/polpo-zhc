// Copied from lumea-labs/polpo (packages/node/src/sandbox/lease.test.ts) at 8ef8e9c.
// Copyright 2026-present Lumea Labs. Licensed under the Apache License, Version 2.0:
// http://www.apache.org/licenses/LICENSE-2.0
// Unmodified: keep it in sync with upstream rather than editing it here.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  SandboxProvider,
  SandboxRuntimeEvent,
  SandboxSession,
  SandboxUsage,
} from "@polpo-ai/core";
import { SandboxLease } from "./lease.js";
import { LocalSandboxProvider } from "./local-provider.js";

function fakeProvider(opts: {
  withLifecycle?: boolean;
  omitOptional?: boolean;
  withLifecycleInfo?: boolean;
} = {}) {
  const suspend = vi.fn(async () => {});
  const resume = vi.fn(async () => {});
  const dispose = vi.fn(async () => {});
  const readFile = vi.fn(async (p: string) => `content:${p}`);
  const readdir = vi.fn(async (_p: string) => ["a", "b"]);
  let opens = 0;
  let released = false;

  const fs: any = {
    readFile,
    writeFile: vi.fn(async () => {}),
    exists: vi.fn(async () => true),
    readdir,
    mkdir: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ size: 1, isDirectory: false, isFile: true, modifiedAt: undefined })),
    rename: vi.fn(async () => {}),
  };
  if (!opts.omitOptional) {
    fs.readdirWithTypes = vi.fn(async () => [{ name: "a", isDirectory: false, isFile: true, size: 3 }]);
    fs.readFileBuffer = vi.fn(async () => new Uint8Array([1, 2, 3]));
    fs.writeFileBuffer = vi.fn(async () => {});
  }

  const provider: SandboxProvider = {
    open(): SandboxSession {
      opens++;
      return {
        fs,
        shell: { execute: vi.fn(async () => ({ stdout: "ok", stderr: "", exitCode: 0 })) },
        lifecycle: opts.withLifecycle ? { suspend, resume } : undefined,
        lifecycleInfo: opts.withLifecycleInfo
          ? () => ({
              acquisitionSource: "created",
              ...(released ? { releaseOutcome: "pooled" as const } : {}),
            })
          : undefined,
        dispose: async () => {
          await dispose();
          released = true;
        },
      };
    },
  };
  return { provider, suspend, resume, dispose, readFile, readdir, fs, opens: () => opens };
}

describe("SandboxLease", () => {
  it("emits one ordered lifecycle trace for acquire and release", async () => {
    const onUsage = vi.fn();
    const onEvent = vi.fn();
    const { provider } = fakeProvider({ withLifecycleInfo: true });
    const lease = new SandboxLease(provider, "r1", { onEvent, onUsage, projectId: "p1" });

    await lease.fs.readFile("/a");
    await lease.dispose();
    await lease.dispose();

    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "sandbox.acquire.started",
      "sandbox.acquired",
      "sandbox.release.started",
      "sandbox.released",
    ]);
    expect(onEvent.mock.calls[1]![0]).toMatchObject({
      runId: "r1",
      projectId: "p1",
      source: "created",
    });
    expect(onEvent.mock.calls[3]![0]).toMatchObject({ outcome: "pooled" });
    expect(onUsage.mock.calls[0]![0].events).toEqual(
      onEvent.mock.calls.map(([event]) => event),
    );
  });

  it("checkpoints through the provider session and acquires lazily", async () => {
    const checkpointVolume = vi.fn(async () => undefined);
    const base = fakeProvider();
    const provider: SandboxProvider = {
      open: () => ({
        ...(base.provider.open("r1") as SandboxSession),
        checkpointVolume,
      }),
    };
    const lease = new SandboxLease(provider, "r1");

    await lease.checkpointVolume("workspace");

    expect(checkpointVolume).toHaveBeenCalledWith("workspace");
    expect(base.opens()).toBe(1);
  });

  it("fails clearly when the provider does not support checkpoints", async () => {
    const { provider } = fakeProvider();
    const lease = new SandboxLease(provider, "r1");

    await expect(lease.checkpointVolume()).rejects.toThrow(
      "Sandbox volume checkpoints are not supported by this provider.",
    );
  });

  it("records acquisition failures and keeps telemetry best-effort", async () => {
    const onEvent = vi.fn(() => { throw new Error("sink unavailable"); });
    const onUsage = vi.fn(() => { throw new Error("usage sink unavailable"); });
    const provider: SandboxProvider = {
      open: vi.fn(async () => { throw new Error("capacity exhausted"); }),
    };
    const lease = new SandboxLease(provider, "r1", { onEvent, onUsage });

    await expect(lease.fs.readFile("/a")).rejects.toThrow("capacity exhausted");
    await expect(lease.dispose()).resolves.toBeUndefined();
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({
      acquired: false,
      events: [
        expect.objectContaining({ type: "sandbox.acquire.started" }),
        expect.objectContaining({
          type: "sandbox.error",
          operation: "acquire",
          error: "capacity exhausted",
        }),
      ],
    }));
  });

  it("records release failures and still emits usage once", async () => {
    const onEvent = vi.fn();
    const onUsage = vi.fn();
    const { provider, dispose } = fakeProvider();
    dispose.mockRejectedValueOnce(new Error("delete failed"));
    const lease = new SandboxLease(provider, "r1", { onEvent, onUsage });

    await lease.fs.readFile("/a");
    await expect(lease.dispose()).rejects.toThrow("delete failed");
    await expect(lease.dispose()).resolves.toBeUndefined();

    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "sandbox.acquire.started",
      "sandbox.acquired",
      "sandbox.release.started",
      "sandbox.error",
    ]);
    expect(onEvent.mock.calls[3]![0]).toMatchObject({
      operation: "release",
      error: "delete failed",
    });
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it("merges provider volume events produced during session disposal", async () => {
    const onEvent = vi.fn();
    const onUsage = vi.fn();
    const providerEvents: SandboxRuntimeEvent[] = [];
    const base = fakeProvider();
    const provider: SandboxProvider = {
      open: () => {
        const session = base.provider.open("r1") as SandboxSession;
        return {
          ...session,
          usage: () => ({
            runId: "r1",
            acquired: true,
            sandboxMs: 0,
            sandboxId: "sandbox-1",
            events: [...providerEvents],
          }),
          dispose: async () => {
            providerEvents.push({
              type: "sandbox.volume.finalized",
              runId: "r1",
              occurredAt: "2026-08-14T10:00:00.000Z",
              projectId: "p1",
              sandboxId: "sandbox-1",
              operation: "finalize",
              details: { volume: "workspace", changed: true },
            });
            await session.dispose();
          },
        };
      },
    };
    const lease = new SandboxLease(provider, "r1", { onEvent, onUsage, projectId: "p1" });

    await lease.fs.readFile("/a");
    await lease.dispose();

    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "sandbox.volume.finalized",
      details: { volume: "workspace", changed: true },
    }));
    expect(onUsage.mock.calls[0]![0].events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "sandbox.volume.finalized" }),
    ]));
  });

  it("keeps provider volume failure events when disposal rejects", async () => {
    const onUsage = vi.fn();
    const providerEvents: SandboxRuntimeEvent[] = [];
    const base = fakeProvider();
    const provider: SandboxProvider = {
      open: () => {
        const session = base.provider.open("r1") as SandboxSession;
        return {
          ...session,
          usage: () => ({
            runId: "r1",
            acquired: true,
            sandboxMs: 0,
            sandboxId: "sandbox-1",
            events: [...providerEvents],
          }),
          dispose: async () => {
            providerEvents.push({
              type: "sandbox.volume.conflict",
              runId: "r1",
              occurredAt: "2026-08-14T10:00:00.000Z",
              projectId: "p1",
              sandboxId: "sandbox-1",
              operation: "finalize",
              error: "revision conflict",
              details: { volume: "workspace" },
            });
            throw new Error("revision conflict");
          },
        };
      },
    };
    const lease = new SandboxLease(provider, "r1", { onUsage, projectId: "p1" });

    await lease.fs.readFile("/a");
    await expect(lease.dispose()).rejects.toThrow("revision conflict");

    expect(onUsage.mock.calls[0]![0].events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "sandbox.volume.conflict",
        error: "revision conflict",
      }),
    ]));
  });

  it("never opens a session when fs/shell are untouched (lazy acquire)", async () => {
    const onUsage = vi.fn();
    const { provider, opens } = fakeProvider();
    const lease = new SandboxLease(provider, "r1", { onUsage, projectId: "p1" });
    await lease.dispose();
    expect(opens()).toBe(0);
    expect(lease.wasAcquired).toBe(false);
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "r1", projectId: "p1", acquired: false, sandboxMs: 0 }),
    );
  });

  it("opens once and delegates fs ops", async () => {
    const { provider, readFile, opens } = fakeProvider();
    const lease = new SandboxLease(provider, "r1");
    expect(await lease.fs.readFile("/x")).toBe("content:/x");
    expect(await lease.fs.readFile("/y")).toBe("content:/y");
    expect(opens()).toBe(1); // acquired once, shared
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(lease.wasAcquired).toBe(true);
  });

  it("shares one session + one resume across parallel ops", async () => {
    const { provider, resume, opens } = fakeProvider({ withLifecycle: true });
    const lease = new SandboxLease(provider, "r1");
    await Promise.all([lease.fs.readFile("/a"), lease.fs.readFile("/b"), lease.fs.readFile("/c")]);
    expect(opens()).toBe(1);
    expect(resume).not.toHaveBeenCalled(); // already running from acquire
  });

  it("meters sandboxMs as the acquire→release hold when there is no lifecycle", async () => {
    const onUsage = vi.fn();
    let t = 0;
    const { provider } = fakeProvider(); // no lifecycle
    const lease = new SandboxLease(provider, "r1", { now: () => t, onUsage });
    t = 100;
    await lease.fs.readFile("/a"); // acquires at t=100
    t = 400;
    await lease.dispose(); // releases at t=400
    const usage = onUsage.mock.calls[0]![0] as SandboxUsage;
    expect(usage.acquired).toBe(true);
    expect(usage.sandboxMs).toBe(300);
  });

  it("disposes the underlying session and is idempotent", async () => {
    const onUsage = vi.fn();
    const { provider, dispose } = fakeProvider();
    const lease = new SandboxLease(provider, "r1", { onUsage });
    await lease.fs.readFile("/a");
    await lease.dispose();
    await lease.dispose(); // second call = no-op
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  describe("optional method fallbacks (backend without them)", () => {
    it("falls back readdirWithTypes → readdir, buffers → string", async () => {
      const { provider, readdir } = fakeProvider({ omitOptional: true });
      const lease = new SandboxLease(provider, "r1");
      const entries = await lease.fs.readdirWithTypes!("/d");
      expect(readdir).toHaveBeenCalled();
      expect(entries).toEqual([
        { name: "a", isDirectory: false, isFile: true },
        { name: "b", isDirectory: false, isFile: true },
      ]);
      const buf = await lease.fs.readFileBuffer!("/f");
      expect(new TextDecoder().decode(buf)).toBe("content:/f");
    });
  });

  describe("idle suspend/resume", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("suspends after idle, resumes on next op, and excludes the idle gap from sandboxMs", async () => {
      const onUsage = vi.fn();
      const onEvent = vi.fn();
      let t = 0;
      const { provider, suspend, resume } = fakeProvider({ withLifecycle: true });
      const lease = new SandboxLease(provider, "r1", {
        now: () => t,
        onUsage,
        onEvent,
        idleSuspendMs: 1000,
      });

      await lease.fs.readFile("/a"); // acquires + runs at t=0; op ends → idle armed
      t = 200; // it ran 200ms of active work
      await vi.advanceTimersByTimeAsync(1000); // idle fires → suspend at t=200
      expect(suspend).toHaveBeenCalledTimes(1);

      t = 5000; // 4800ms of "model thinking" while suspended
      await lease.fs.readFile("/b"); // resumes at t=5000
      expect(resume).toHaveBeenCalledTimes(1);
      t = 5100; // 100ms more active work
      await lease.dispose();

      const usage = onUsage.mock.calls[0]![0] as SandboxUsage;
      // 200ms (before suspend) + 100ms (after resume) = 300ms; the 4800ms gap excluded
      expect(usage.sandboxMs).toBe(300);
      expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual([
        "sandbox.acquire.started",
        "sandbox.acquired",
        "sandbox.suspended",
        "sandbox.resumed",
        "sandbox.release.started",
        "sandbox.released",
      ]);
    });

    it("records lifecycle failures without reporting a transition that did not happen", async () => {
      const onEvent = vi.fn();
      const { provider, suspend } = fakeProvider({ withLifecycle: true });
      suspend.mockRejectedValueOnce(new Error("provider unavailable"));
      const lease = new SandboxLease(provider, "r1", { onEvent, idleSuspendMs: 1000 });

      await lease.fs.readFile("/a");
      await vi.advanceTimersByTimeAsync(1000);
      await lease.dispose();

      expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual([
        "sandbox.acquire.started",
        "sandbox.acquired",
        "sandbox.error",
        "sandbox.release.started",
        "sandbox.released",
      ]);
      expect(onEvent.mock.calls[2]![0]).toMatchObject({
        operation: "suspend",
        error: "provider unavailable",
      });
    });

    it("retries resume after a transient failure without leaking in-flight activity", async () => {
      const onEvent = vi.fn();
      const { provider, resume, suspend } = fakeProvider({ withLifecycle: true });
      resume.mockRejectedValueOnce(new Error("resume unavailable"));
      const lease = new SandboxLease(provider, "r1", { onEvent, idleSuspendMs: 1000 });

      await lease.fs.readFile("/a");
      await vi.advanceTimersByTimeAsync(1000);
      await expect(lease.fs.readFile("/b")).rejects.toThrow("resume unavailable");
      await expect(lease.fs.readFile("/c")).resolves.toBe("content:/c");
      await vi.advanceTimersByTimeAsync(1000);
      await lease.dispose();

      expect(resume).toHaveBeenCalledTimes(2);
      expect(suspend).toHaveBeenCalledTimes(2);
      expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual([
        "sandbox.acquire.started",
        "sandbox.acquired",
        "sandbox.suspended",
        "sandbox.error",
        "sandbox.resumed",
        "sandbox.suspended",
        "sandbox.release.started",
        "sandbox.released",
      ]);
    });
  });
});

describe("LocalSandboxProvider", () => {
  it("opens a session with a real fs + shell, no lifecycle, no-op dispose", async () => {
    const session = new LocalSandboxProvider().open("r1");
    expect(typeof session.fs.readFile).toBe("function");
    expect(typeof session.shell.execute).toBe("function");
    expect(session.lifecycle).toBeUndefined();
    await session.dispose(); // must not throw
  });

  it("under a lease never suspends (behaves like today's local execution)", async () => {
    const onUsage = vi.fn();
    const lease = new SandboxLease(new LocalSandboxProvider(), "r1", { onUsage });
    // A real shell op — the local machine actually runs it.
    const res = await lease.shell.execute("echo hi");
    expect(res.stdout.trim()).toBe("hi");
    await lease.dispose();
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ acquired: true }));
  });
});
