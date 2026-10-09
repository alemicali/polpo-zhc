import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_LEASE_MS, sessionLeases } from "@polpo-ai/server";

afterEach(() => { vi.useRealTimers(); });

describe("session leases", () => {
  it("one holder at a time; release wakes a waiter", async () => {
    expect(sessionLeases.tryAcquire("s-a", "one")).toBe(true);
    expect(sessionLeases.tryAcquire("s-a", "two")).toBe(false);
    const waiting = sessionLeases.acquire("s-a", "two", { waitMs: 2000 });
    sessionLeases.release("s-a", "two"); // not the holder: no effect
    expect(sessionLeases.holder("s-a")?.owner).toBe("one");
    sessionLeases.release("s-a", "one");
    expect(await waiting).toBe(true);
    expect(sessionLeases.holder("s-a")?.owner).toBe("two");
    expect(sessionLeases.transfer("s-a", "two", "three")).toBe(true);
    sessionLeases.release("s-a", "three");
    expect(sessionLeases.isHeld("s-a")).toBe(false);
  });

  it("a live holder keeps its lease past the takeover age; a silent one loses it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    expect(sessionLeases.tryAcquire("s-long", "turn")).toBe(true);
    const stop = sessionLeases.heartbeat("s-long", "turn", 60_000);
    vi.advanceTimersByTime(MAX_LEASE_MS + 5 * 60_000);
    expect(sessionLeases.tryAcquire("s-long", "intruder")).toBe(false);
    stop();
    vi.advanceTimersByTime(MAX_LEASE_MS + 1000);
    expect(sessionLeases.tryAcquire("s-long", "intruder")).toBe(true);
    sessionLeases.release("s-long", "intruder");
  });
});
