import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeSpawner } from "../adapters/node-spawner.js";
import type { RunnerConfig } from "../core/types.js";

describe("starting a runner", () => {
  test("a runner that cannot start fails the spawn with the reason, instead of ending the server", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "polpo-spawn-"));
    try {
      const spawner = new NodeSpawner({ polpoDir: join(tmp, ".polpo"), cwd: join(tmp, "no-such-folder") });
      const config = { runId: "r1", outputDir: join(tmp, "out") } as unknown as RunnerConfig;
      await expect(spawner.spawn(config)).rejects.toThrow(/no-such-folder/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
