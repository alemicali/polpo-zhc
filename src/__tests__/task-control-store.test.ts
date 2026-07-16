import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileTaskControlStore } from "../stores/file-task-control-store.js";

describe("FileTaskControlStore", () => {
  let dir: string;
  let store: FileTaskControlStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polpo-task-control-"));
    store = new FileTaskControlStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists and claims an unbound continuation for a new run", async () => {
    const direction = await store.enqueueDirection({
      taskId: "task-1",
      mode: "continue",
      message: "Continue from the existing files and add validation",
    });

    expect(direction.status).toBe("queued");
    expect(direction.runId).toBeUndefined();

    const claimed = await store.claimDirections("task-1", "run-2");

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      id: direction.id,
      runId: "run-2",
      status: "delivered",
    });
    await expect(store.claimDirections("task-1", "run-2")).resolves.toEqual([]);
  });

  it("only delivers directions bound to the active run", async () => {
    await store.enqueueDirection({
      taskId: "task-1",
      runId: "run-old",
      mode: "steer",
      message: "Old instruction",
    });
    await store.enqueueDirection({
      taskId: "task-1",
      runId: "run-current",
      mode: "steer",
      message: "Current instruction",
    });

    const claimed = await store.claimDirections("task-1", "run-current");

    expect(claimed.map((item) => item.message)).toEqual(["Current instruction"]);
  });

  it("round-trips the last consistent agent checkpoint by task", async () => {
    await store.saveCheckpoint({
      taskId: "task-1",
      runId: "run-1",
      messages: [
        { role: "user", content: [{ type: "text", text: "Build it" }], timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Done" }], timestamp: 2 },
      ],
      savedAt: "2026-07-15T10:00:00.000Z",
      turnCount: 1,
    });

    await expect(store.getCheckpoint("task-1")).resolves.toMatchObject({
      taskId: "task-1",
      runId: "run-1",
      turnCount: 1,
    });
  });

  it("records failed delivery without dropping direction history", async () => {
    const direction = await store.enqueueDirection({
      taskId: "task-1",
      runId: "run-1",
      mode: "steer",
      message: "Change approach",
    });

    await store.failDirection(direction.id, "runner stopped");

    await expect(store.listDirections("task-1")).resolves.toEqual([
      expect.objectContaining({ id: direction.id, status: "failed", error: "runner stopped" }),
    ]);
  });

  it("requeues an interrupted continuation without keeping the dead run binding", async () => {
    const direction = await store.enqueueDirection({
      taskId: "task-1",
      mode: "continue",
      message: "Keep going",
    });
    await store.claimDirections("task-1", "dead-run");

    await store.requeueDirection(direction.id);

    const requeued = await store.listDirections("task-1");
    expect(requeued).toEqual([
      expect.objectContaining({ id: direction.id, status: "queued" }),
    ]);
    expect(requeued[0]).not.toHaveProperty("runId");
    await expect(store.claimDirections("task-1", "replacement-run")).resolves.toEqual([
      expect.objectContaining({ id: direction.id, status: "delivered", runId: "replacement-run" }),
    ]);
  });
});
