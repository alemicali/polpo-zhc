/**
 * Node.js Spawner implementation — wraps child_process.spawn.
 *
 * Default implementation for self-hosted mode. Spawns runner as a detached
 * subprocess with config written to a temporary JSON file.
 *
 * Drop-in replacement pattern: swap with SandboxSpawner for cloud.
 */
import { join, dirname } from "node:path";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { spawn as cpSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Spawner, SpawnResult } from "../core/spawner.js";
import type { RunnerConfig } from "../core/types.js";

export class NodeSpawner implements Spawner {
  private polpoDir: string;
  private cwd: string;

  constructor(opts: { polpoDir: string; cwd: string }) {
    this.polpoDir = opts.polpoDir;
    this.cwd = opts.cwd;
  }

  async spawn(config: RunnerConfig): Promise<SpawnResult> {
    // Ensure output and tmp directories exist
    const outputDir = config.outputDir;
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const tmpDir = join(this.polpoDir, "tmp");
    if (!existsSync(tmpDir)) {
      mkdirSync(tmpDir, { recursive: true });
    }

    // Write config to temp file
    const configPath = join(tmpDir, `run-${config.runId}.json`);
    writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });

    // Resolve runner path: prefer compiled .js, fall back to .ts via tsx (dev mode)
    const baseDir = dirname(fileURLToPath(import.meta.url));
    const coreDir = join(baseDir, "../core");
    const runnerJs = join(coreDir, "runner.js");
    const runnerTs = join(coreDir, "runner.ts");
    const useTs = !existsSync(runnerJs) && existsSync(runnerTs);
    const runnerPath = useTs ? runnerTs : runnerJs;

    let spawnArgs: string[];
    if (useTs) {
      const tsxCli = join(baseDir, "../../node_modules/tsx/dist/cli.mjs");
      spawnArgs = existsSync(tsxCli)
        ? [process.execPath, tsxCli, runnerPath, "--config", configPath]
        : [process.execPath, runnerPath, "--config", configPath];
    } else {
      spawnArgs = [process.execPath, runnerPath, "--config", configPath];
    }

    const child = cpSpawn(spawnArgs[0], spawnArgs.slice(1), {
      detached: true,
      stdio: "ignore",
      cwd: this.cwd,
    });
    child.unref();

    return {
      pid: child.pid ?? 0,
      configPath,
    };
  }

  isAlive(pid: number): boolean {
    if (pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  kill(pid: number): void {
    if (pid <= 0) return;
    try {
      process.kill(pid, "SIGTERM");
      setTimeout(() => {
        try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
      }, 3000);
    } catch { /* process already dead */ }
  }
}
