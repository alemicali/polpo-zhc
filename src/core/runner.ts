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

import { readFileSync, unlinkSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { SqliteRunStore } from "../stores/sqlite-run-store.js";
import { getAdapter } from "../adapters/registry.js";
import type { RunRecord } from "./run-store.js";
import type { RunnerConfig, TaskResult } from "./types.js";

// Side-effect imports: register adapters
import "../adapters/native.js";
import "../adapters/claude-sdk.js";
import "../adapters/generic.js";

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

/** Persistent per-run activity log (JSONL file in .polpo/logs/) */
class RunActivityLog {
  private logPath: string;
  private lastSnapshot = "";

  constructor(dbPath: string, runId: string, taskId: string, agentName: string) {
    const logsDir = join(dirname(dbPath), "logs");
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    this.logPath = join(logsDir, `run-${runId}.jsonl`);
    // Write header
    this.write({ _run: true, runId, taskId, agentName, startedAt: new Date().toISOString(), pid: process.pid });
  }

  /** Log activity diff — only writes if something changed */
  logActivity(activity: Record<string, unknown>): void {
    const snapshot = JSON.stringify(activity);
    if (snapshot === this.lastSnapshot) return;
    this.lastSnapshot = snapshot;
    this.write({ ts: new Date().toISOString(), event: "activity", data: activity });
  }

  /** Log a transcript entry from the adapter (assistant text, tool_use, tool_result, etc.) */
  logTranscript(entry: Record<string, unknown>): void {
    this.write({ ts: new Date().toISOString(), ...entry });
  }

  /** Log a lifecycle event */
  logEvent(event: string, data?: Record<string, unknown>): void {
    this.write({ ts: new Date().toISOString(), event, ...(data ? { data } : {}) });
  }

  private write(obj: Record<string, unknown>): void {
    try { appendFileSync(this.logPath, JSON.stringify(obj) + "\n", "utf-8"); } catch { /* best effort */ }
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  const runStore = new SqliteRunStore(config.dbPath);
  const actLog = new RunActivityLog(config.dbPath, config.runId, config.taskId, config.agent.name);

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
  actLog.logEvent("spawning", { adapter: config.agent.adapter, task: config.task.title });

  let handle;
  try {
    const adapter = getAdapter(config.agent.adapter);
    handle = adapter.spawn(config.agent, config.task, config.cwd);
    // Wire transcript persistence — every agent message gets written to the run log
    handle.onTranscript = (entry) => actLog.logTranscript(entry);
    actLog.logEvent("spawned");
  } catch (err) {
    const result = errorResult(err);
    actLog.logEvent("error", { message: result.stderr });
    runStore.completeRun(config.runId, "failed", result);
    runStore.close();
    process.exit(1);
  }

  // Activity polling + persistent logging
  const poll = setInterval(() => {
    try {
      runStore.updateActivity(config.runId, handle.activity);
      actLog.logActivity({ ...handle.activity });
    } catch { /* DB temporarily locked */
    }
  }, ACTIVITY_POLL_MS);

  // SIGTERM handler: graceful kill
  let sigterm = false;
  process.on("SIGTERM", () => {
    sigterm = true;
    actLog.logEvent("sigterm");
    handle.kill();
  });

  try {
    const result = await handle.done;
    clearInterval(poll);
    // Final activity + sessionId flush before marking terminal
    try { runStore.updateActivity(config.runId, handle.activity); } catch { /* best effort */ }
    actLog.logActivity({ ...handle.activity });
    const status = sigterm ? "killed" : (result.exitCode === 0 ? "completed" : "failed");
    actLog.logEvent("done", { status, exitCode: result.exitCode, duration: result.duration });
    runStore.completeRun(config.runId, status, result);
  } catch (err) {
    clearInterval(poll);
    try { runStore.updateActivity(config.runId, handle.activity); } catch { /* best effort */ }
    actLog.logEvent("error", { message: err instanceof Error ? err.message : String(err) });
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
