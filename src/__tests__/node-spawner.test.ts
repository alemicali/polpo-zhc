import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerConfig } from "../core/types.js";

// A child that starts: NodeSpawner waits for its "spawn" event before it returns.
const spawnMock = vi.hoisted(() => vi.fn(() => {
  const child = {
    pid: 4242,
    unref: () => undefined,
    once: (event: string, listener: () => void) => { if (event === "spawn") queueMicrotask(listener); return child; },
  };
  return child;
}));
// When set, the runner script (runner.js / runner.ts) is missing, as inside a compiled binary.
const runnerMissing = vi.hoisted(() => ({ value: false }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    existsSync: (path: Parameters<typeof fs.existsSync>[0]) =>
      runnerMissing.value && /runner\.(js|ts)$/.test(String(path)) ? false : fs.existsSync(path),
  };
});

const { NodeSpawner } = await import("../adapters/node-spawner.js");
const { RUNNER_COMMAND } = await import("../core/runner-command.js");

describe("NodeSpawner", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polpo-spawner-"));
    spawnMock.mockClear();
    runnerMissing.value = false;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const config = () => ({ runId: "run-1", outputDir: join(dir, "output") }) as unknown as RunnerConfig;

  it("starts the runner script when it is on disk", async () => {
    const spawner = new NodeSpawner({ polpoDir: dir, cwd: dir });
    const { configPath } = await spawner.spawn(config());

    const [command, args] = spawnMock.mock.calls[0] as unknown as [string, string[]];
    expect(command).toBe(process.execPath);
    expect(args).not.toContain(RUNNER_COMMAND);
    expect(args.some((a) => /runner\.(js|ts)$/.test(a))).toBe(true);
    expect(args.slice(-2)).toEqual(["--config", configPath]);
  });

  it("starts itself with the runner command when there is no runner script (compiled binary)", async () => {
    runnerMissing.value = true;
    const spawner = new NodeSpawner({ polpoDir: dir, cwd: dir });
    const { configPath, pid } = await spawner.spawn(config());

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [RUNNER_COMMAND, "--config", configPath],
      expect.objectContaining({ detached: true, cwd: dir }),
    );
    expect(pid).toBe(4242);
  });
});
