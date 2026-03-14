#!/usr/bin/env node

/**
 * Detached subprocess runner.
 * Spawned by the orchestrator for each agent task.
 * Lifecycle:
 *   1. Read --config <path> from args
 *   2. Open own RunStore connection (Drizzle SQLite or PG)
 *   3. Spawn agent via built-in engine
 *   4. Poll activity, write to RunStore
 *   5. Await handle.done, write result
 *   6. Cleanup & exit
 */

import { readFileSync, unlinkSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { FileRunStore } from "../stores/file-run-store.js";
import { spawnEngine } from "../adapters/engine.js";
import type { RunStore, RunRecord } from "./run-store.js";
import type { LogStore } from "./log-store.js";
import type { RunnerConfig, TaskResult } from "./types.js";
import { notifyRunComplete } from "./notification.js";
import { sanitizeTranscriptEntry } from "../server/security.js";
import { EncryptedVaultStore } from "../vault/encrypted-store.js";
import type { VaultStore } from "./vault-store.js";
import type { WhatsAppStore } from "../stores/whatsapp-store.js";

const ACTIVITY_POLL_MS = 1500;

function readConfigFromFile(): RunnerConfig {
  const idx = process.argv.indexOf("--config");
  if (idx < 0 || !process.argv[idx + 1]) {
    console.error("Usage: runner --config <path> | --run-id <id> --db <url>");
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

/**
 * Cloud mode: read RunnerConfig from Neon DB via RunStore.
 * Usage: runner --run-id <id> --db <postgres-url>
 */
async function readConfigFromDb(): Promise<RunnerConfig> {
  const runIdIdx = process.argv.indexOf("--run-id");
  const dbIdx = process.argv.indexOf("--db");
  if (runIdIdx < 0 || dbIdx < 0 || !process.argv[runIdIdx + 1] || !process.argv[dbIdx + 1]) {
    console.error("Usage: runner --run-id <id> --db <postgres-url>");
    process.exit(1);
  }
  const runId = process.argv[runIdIdx + 1];
  const dbUrl = process.argv[dbIdx + 1];

  const { createPgStores } = await import("@polpo-ai/drizzle");
  const postgres = (await import("postgres")).default;
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const sql = postgres(dbUrl);
  const db = drizzle(sql);
  const store = createPgStores(db).runStore;

  const run = await store.getRun(runId);
  if (!run?.config) {
    console.error(`Run ${runId} not found or has no config in DB`);
    await sql.end();
    process.exit(1);
  }

  await sql.end();
  return run.config;
}

function errorResult(err: unknown): TaskResult {
  const msg = err instanceof Error ? err.message : String(err);
  return { exitCode: 1, stdout: "", stderr: `Runner error: ${msg}`, duration: 0 };
}

/** Persistent per-run activity log (JSONL file in .polpo/logs/) */
class RunActivityLog {
  private logPath: string;
  private lastSnapshot = "";

  constructor(polpoDir: string, runId: string, taskId: string, agentName: string) {
    const logsDir = join(polpoDir, "logs");
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

  /** Log a transcript entry from the engine (assistant text, tool_use, tool_result, etc.) */
  logTranscript(entry: Record<string, unknown>): void {
    this.write({ ts: new Date().toISOString(), ...sanitizeTranscriptEntry(entry) });
  }

  /** Log a lifecycle event */
  logEvent(event: string, data?: Record<string, unknown>): void {
    this.write({ ts: new Date().toISOString(), event, ...(data ? { data } : {}) });
  }

  private write(obj: Record<string, unknown>): void {
    try { appendFileSync(this.logPath, JSON.stringify(obj) + "\n", "utf-8"); } catch { /* best effort */ }
  }
}

interface RunnerStores {
  runStore: RunStore;
  logStore?: LogStore;
}

async function createStores(config: RunnerConfig): Promise<RunnerStores> {
  if (config.storage === "postgres" && config.databaseUrl) {
    const { createPgStores } = await import("@polpo-ai/drizzle");
    const postgres = (await import("postgres")).default;
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const sql = postgres(config.databaseUrl);
    const db = drizzle(sql);
    const stores = createPgStores(db);
    return { runStore: stores.runStore, logStore: stores.logStore };
  }
  if (config.storage === "sqlite") {
    const { createSqliteStores } = await import("@polpo-ai/drizzle");
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const Database = req("better-sqlite3");
    const dbPath = join(config.polpoDir, "state.db");
    const sqlite = new Database(dbPath);
    sqlite.exec("PRAGMA journal_mode = WAL");
    sqlite.exec("PRAGMA synchronous = NORMAL");
    sqlite.exec("PRAGMA foreign_keys = ON");
    const { ensureSqliteSchema } = await import("./drizzle-sqlite-schema.js");
    ensureSqliteSchema(sqlite);
    const { drizzle } = await import("drizzle-orm/better-sqlite3");
    const db = drizzle(sqlite);
    const stores = createSqliteStores(db);
    return { runStore: stores.runStore, logStore: stores.logStore };
  }
  return { runStore: new FileRunStore(config.polpoDir) };
}

async function main(): Promise<void> {
  const isDbMode = process.argv.includes("--run-id");
  const config = isDbMode ? await readConfigFromDb() : readConfigFromFile();
  const { runStore, logStore } = await createStores(config);
  const actLog = new RunActivityLog(config.polpoDir, config.runId, config.taskId, config.agent.name);

  // When LogStore is available (postgres/sqlite), persist transcript to DB.
  // This ensures transcript survives sandbox destruction in cloud mode.
  let logSessionId: string | undefined;
  if (logStore) {
    logSessionId = await logStore.startSession();
  }

  const now = new Date().toISOString();
  const initialRecord: RunRecord = {
    id: config.runId,
    taskId: config.taskId,
    pid: process.pid,
    agentName: config.agent.name,
    status: "running",
    startedAt: now,
    updatedAt: now,
    activity: { filesCreated: [], filesEdited: [], toolCalls: 0, totalTokens: 0, lastUpdate: now },
    configPath: isDbMode ? `db://${config.runId}` : join(process.argv[process.argv.indexOf("--config") + 1]),
  };
  // In DB mode, run record already exists (created by cloud spawner) — update it with PID
  await runStore.upsertRun(initialRecord);
  actLog.logEvent("spawning", { task: config.task.title });

  let handle;
  try {
    let vaultStore: VaultStore | undefined;
    try { vaultStore = new EncryptedVaultStore(config.polpoDir); } catch { /* vault unavailable */ }

    // WhatsApp store + send function (if configured)
    let waStore: WhatsAppStore | undefined;
    let waSendMessage: ((jid: string, text: string) => Promise<string | undefined>) | undefined;
    if (config.whatsappDbPath && config.whatsappProfilePath) {
      try {
        const { WhatsAppStore: WAStore } = await import("../stores/whatsapp-store.js");
        waStore = new WAStore(config.whatsappDbPath);

        // Lazy Baileys connection for sending — only connects when first send is called
        let waSock: any;
        waSendMessage = async (jid: string, text: string): Promise<string | undefined> => {
          if (!waSock) {
            const {
              default: makeWASocket,
              useMultiFileAuthState,
              fetchLatestBaileysVersion,
              makeCacheableSignalKeyStore,
            } = await import("@whiskeysockets/baileys");
            const { state, saveCreds } = await useMultiFileAuthState(config.whatsappProfilePath!);
            const { version } = await fetchLatestBaileysVersion();
            waSock = makeWASocket({
              version,
              auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, undefined as any) },
              printQRInTerminal: false,
              browser: ["Polpo Agent", "Desktop", "1.0.0"],
              generateHighQualityLinkPreview: false,
              syncFullHistory: false,
            });
            waSock.ev.on("creds.update", saveCreds);
            // Wait for connection
            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error("WhatsApp connection timeout")), 15000);
              waSock.ev.on("connection.update", (update: any) => {
                if (update.connection === "open") { clearTimeout(timeout); resolve(); }
                if (update.connection === "close") { clearTimeout(timeout); reject(new Error("WhatsApp connection closed")); }
              });
            });
          }
          const result = await waSock.sendMessage(jid, { text });
          return result?.key?.id ?? undefined;
        };
      } catch { /* WhatsApp unavailable in runner — tools will be skipped */ }
    }

    const spawnCtx = {
      polpoDir: config.polpoDir,
      outputDir: config.outputDir,
      emailAllowedDomains: config.emailAllowedDomains,
      reasoning: config.reasoning,
      vaultStore,
      whatsappStore: waStore,
      whatsappSendMessage: waSendMessage,
    };
    handle = spawnEngine(config.agent, config.task, config.cwd, spawnCtx);
    // Wire transcript persistence — every agent message gets written to the run log
    handle.onTranscript = (entry) => {
      actLog.logTranscript(entry);
      // Persist transcript to DB when LogStore is available (cloud mode)
      if (logStore && logSessionId) {
        const event = entry.role === "assistant" ? "transcript:assistant"
          : entry.role === "tool_result" ? "transcript:tool_result"
          : entry.role === "tool_use" ? "transcript:tool_use"
          : `transcript:${entry.role ?? "unknown"}`;
        logStore.append({ ts: new Date().toISOString(), event, data: sanitizeTranscriptEntry(entry) })
          .catch(() => {}); // best-effort, don't block engine
      }
    };
    actLog.logEvent("spawned");
  } catch (err) {
    const result = errorResult(err);
    actLog.logEvent("error", { message: result.stderr });
    await runStore.completeRun(config.runId, "failed", result);
    if (config.notifySocket) {
      notifyRunComplete(config.notifySocket, config.runId, config.taskId, "failed");
    }
    await runStore.close();
    process.exit(1);
  }

  // Activity polling + persistent logging
  const poll = setInterval(async () => {
    try {
      await runStore.updateActivity(config.runId, handle.activity);
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
    try { await runStore.updateActivity(config.runId, handle.activity); } catch { /* best effort */ }
    actLog.logActivity({ ...handle.activity });

    // Store auto-collected outcomes on the run record
    if (handle.outcomes && handle.outcomes.length > 0) {
      try { await runStore.updateOutcomes(config.runId, handle.outcomes); } catch { /* best effort */ }
      actLog.logEvent("outcomes", { count: handle.outcomes.length, types: handle.outcomes.map((o: any) => o.type) });
    }

    // If we received SIGTERM (timeout/shutdown), force exitCode=1 regardless of
    // what the engine returned — an aborted task is not a successful task.
    if (sigterm) {
      result.exitCode = 1;
      result.stderr = (result.stderr ? result.stderr + "\n" : "") + "Killed by SIGTERM (timeout or shutdown)";
    }
    const status = sigterm ? "killed" : (result.exitCode === 0 ? "completed" : "failed");
    actLog.logEvent("done", { status, exitCode: result.exitCode, duration: result.duration });
    await runStore.completeRun(config.runId, status, result);
    if (config.notifySocket) {
      notifyRunComplete(config.notifySocket, config.runId, config.taskId, status);
    }
  } catch (err) {
    clearInterval(poll);
    try { await runStore.updateActivity(config.runId, handle.activity); } catch { /* best effort */ }
    actLog.logEvent("error", { message: err instanceof Error ? err.message : String(err) });
    await runStore.completeRun(config.runId, "failed", errorResult(err));
    if (config.notifySocket) {
      notifyRunComplete(config.notifySocket, config.runId, config.taskId, "failed");
    }
  }

  // Cleanup config file (only in file mode, not DB mode)
  if (!isDbMode) {
    try { unlinkSync(join(process.argv[process.argv.indexOf("--config") + 1])); } catch { /* already gone */ }
  }

  await runStore.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Runner fatal error:", err);
  process.exit(1);
});
