#!/usr/bin/env node

/**
 * Detached subprocess runner.
 * Spawned by the orchestrator for each agent task.
 * Lifecycle:
 *   1. Read --config <path> from args
 *   2. Open own SqliteRunStore connection
 *   3. Import adapters & spawn agent via adapter
 *   4. Poll activity, write to RunStore
 *   5. Await handle.done, write result
 *   6. Cleanup & exit
 */

import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { SqliteRunStore } from "./stores/sqlite-run-store.js";
import { getAdapter } from "./adapters/registry.js";
import type { RunRecord } from "./core/run-store.js";
import type { RunnerConfig, TaskResult } from "./core/types.js";

// Side-effect imports: register adapters
import "./adapters/claude-sdk.js";
import "./adapters/generic.js";

const ACTIVITY_POLL_MS = 1500;

function readConfig(): RunnerConfig {
  const idx = process.argv.indexOf("--config");
  if (idx < 0 || !process.argv[idx + 1]) {
    console.error("Usage: runner --config <path>");
    process.exit(1);
  }
  const configPath = process.argv[idx + 1];
  const raw = readFileSync(configPath, "utf-8");
  try {
    return JSON.parse(raw) as RunnerConfig;
  } catch (err) {
    console.error(`Failed to parse runner config at ${configPath}:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

function errorResult(err: unknown): TaskResult {
  const msg = err instanceof Error ? err.message : String(err);
  return { exitCode: 1, stdout: "", stderr: `Runner error: ${msg}`, duration: 0 };
}

async function main(): Promise<void> {
  const config = readConfig();
  const runStore = new SqliteRunStore(config.dbPath);

  const now = new Date().toISOString();
  const initialRecord: RunRecord = {
    id: config.runId,
    taskId: config.taskId,
    pid: process.pid,
    agentName: config.agent.name,
    adapterType: config.agent.adapter,
    status: "running",
    startedAt: now,
    updatedAt: now,
    activity: { filesCreated: [], filesEdited: [], toolCalls: 0, lastUpdate: now },
    configPath: join(process.argv[process.argv.indexOf("--config") + 1]),
  };
  runStore.upsertRun(initialRecord);

  let handle;
  try {
    const adapter = getAdapter(config.agent.adapter);
    handle = adapter.spawn(config.agent, config.task, config.cwd);
  } catch (err) {
    runStore.completeRun(config.runId, "failed", errorResult(err));
    runStore.close();
    process.exit(1);
  }

  // Activity polling
  const poll = setInterval(() => {
    try {
      runStore.updateActivity(config.runId, handle.activity);
    } catch {
      // DB may be temporarily locked — skip this tick
    }
  }, ACTIVITY_POLL_MS);

  // SIGTERM handler: graceful kill
  let sigterm = false;
  process.on("SIGTERM", () => {
    sigterm = true;
    handle.kill();
  });

  try {
    const result = await handle.done;
    clearInterval(poll);
    const status = sigterm ? "killed" : (result.exitCode === 0 ? "completed" : "failed");
    runStore.completeRun(config.runId, status, result);
  } catch (err) {
    clearInterval(poll);
    runStore.completeRun(config.runId, "failed", errorResult(err));
  }

  // Cleanup config file
  try { unlinkSync(join(process.argv[process.argv.indexOf("--config") + 1])); } catch { /* already gone */ }

  runStore.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Runner fatal error:", err);
  process.exit(1);
});
