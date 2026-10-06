import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:net";
import { startNotificationServer, notifyRunComplete, getSocketPath } from "../core/notification.js";

describe("run completion notification socket", () => {
  let dir: string | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("uses a named pipe on Windows and a socket file in .polpo elsewhere", () => {
    const polpoDir = join(tmpdir(), "polpo-notify-path", ".polpo");
    const path = getSocketPath(polpoDir);
    if (process.platform === "win32") {
      expect(path).toMatch(/^\\\\\.\\pipe\\polpo-[0-9a-f]{16}$/);
      expect(getSocketPath(polpoDir)).toBe(path);
      expect(getSocketPath(join(tmpdir(), "other", ".polpo"))).not.toBe(path);
    } else {
      expect(path).toBe(join(polpoDir, "orchestrator.sock"));
    }
  });

  it("delivers a run_complete message from the runner to the orchestrator", async () => {
    dir = mkdtempSync(join(tmpdir(), "polpo-notify-"));
    const received = new Promise<[string, string, string]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no notification received")), 5_000);
      server = startNotificationServer(dir!, (runId, taskId, status) => {
        clearTimeout(timer);
        resolve([runId, taskId, status]);
      });
      server.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
    await new Promise<void>((r) => (server!.listening ? r() : server!.once("listening", () => r())));

    notifyRunComplete(getSocketPath(dir), "run-1", "task-1", "done");

    await expect(received).resolves.toEqual(["run-1", "task-1", "done"]);
  });
});
