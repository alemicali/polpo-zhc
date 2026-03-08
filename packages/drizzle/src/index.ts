/**
 * @polpo-ai/drizzle — Drizzle ORM store implementations for Polpo.
 *
 * Supports PostgreSQL (via postgres.js) and SQLite (via better-sqlite3).
 *
 * Usage:
 *   import { createPgStores } from "@polpo-ai/drizzle";
 *   import { drizzle } from "drizzle-orm/postgres-js";
 *   import postgres from "postgres";
 *
 *   const sql = postgres("postgres://...");
 *   const db = drizzle(sql);
 *   const stores = createPgStores(db);
 */

// ── Re-exports ────────────────────────────────────────────────────────

export * from "./stores/index.js";
export * from "./schema/index.js";
export { ensurePgSchema } from "./migrate.js";
export type { Dialect } from "./utils.js";

// ── Schema sets ───────────────────────────────────────────────────────

import {
  tasksPg, missionsPg, metadataPg, processesPg,
  tasksSqlite, missionsSqlite, metadataSqlite, processesSqlite,
} from "./schema/tasks.js";
import { runsPg, runsSqlite } from "./schema/runs.js";
import { sessionsPg, messagesPg, sessionsSqlite, messagesSqlite } from "./schema/sessions.js";
import { notificationsPg, notificationsSqlite } from "./schema/notifications.js";
import { logSessionsPg, logEntriesPg, logSessionsSqlite, logEntriesSqlite } from "./schema/logs.js";
import { approvalsPg, approvalsSqlite } from "./schema/approvals.js";
import { memoryPg, memorySqlite } from "./schema/memory.js";
import {
  peersPg, peerAllowlistPg, pairingRequestsPg, peerSessionsPg,
  peersSqlite, peerAllowlistSqlite, pairingRequestsSqlite, peerSessionsSqlite,
} from "./schema/peers.js";

// ── Store classes ─────────────────────────────────────────────────────

import { DrizzleTaskStore } from "./stores/task-store.js";
import { DrizzleRunStore } from "./stores/run-store.js";
import { DrizzleSessionStore } from "./stores/session-store.js";
import { DrizzleNotificationStore } from "./stores/notification-store.js";
import { DrizzleLogStore } from "./stores/log-store.js";
import { DrizzleApprovalStore } from "./stores/approval-store.js";
import { DrizzleMemoryStore } from "./stores/memory-store.js";
import { DrizzlePeerStore } from "./stores/peer-store.js";
import { DrizzleCheckpointStore } from "./stores/checkpoint-store.js";
import { DrizzleDelayStore } from "./stores/delay-store.js";
import { DrizzleConfigStore } from "./stores/config-store.js";

// ── Store bundle type ─────────────────────────────────────────────────

import type { TaskStore } from "@polpo-ai/core/task-store";
import type { RunStore } from "@polpo-ai/core/run-store";
import type { SessionStore } from "@polpo-ai/core/session-store";
import type { NotificationStore } from "@polpo-ai/core/notification-store";
import type { LogStore } from "@polpo-ai/core/log-store";
import type { ApprovalStore } from "@polpo-ai/core/approval-store";
import type { MemoryStore } from "@polpo-ai/core/memory-store";
import type { PeerStore } from "@polpo-ai/core/peer-store";
import type { CheckpointStore } from "@polpo-ai/core/checkpoint-store";
import type { DelayStore } from "@polpo-ai/core/delay-store";
import type { ConfigStore } from "@polpo-ai/core/config-store";

export interface DrizzleStores {
  taskStore: TaskStore;
  runStore: RunStore;
  sessionStore: SessionStore;
  notificationStore: NotificationStore;
  logStore: LogStore;
  approvalStore: ApprovalStore;
  memoryStore: MemoryStore;
  peerStore: PeerStore;
  checkpointStore: CheckpointStore;
  delayStore: DelayStore;
  configStore: ConfigStore;
}

// ── PostgreSQL factory ────────────────────────────────────────────────

/**
 * Create all Drizzle stores backed by PostgreSQL.
 *
 * @param db A Drizzle database instance (e.g. from `drizzle(postgres(...))`)
 */
export function createPgStores(db: any): DrizzleStores {
  return {
    taskStore: new DrizzleTaskStore(db, {
      tasks: tasksPg, missions: missionsPg, metadata: metadataPg, processes: processesPg,
    }, "pg"),
    runStore: new DrizzleRunStore(db, runsPg, "pg"),
    sessionStore: new DrizzleSessionStore(db, sessionsPg, messagesPg, "pg"),
    notificationStore: new DrizzleNotificationStore(db, notificationsPg, "pg"),
    logStore: new DrizzleLogStore(db, logSessionsPg, logEntriesPg, "pg"),
    approvalStore: new DrizzleApprovalStore(db, approvalsPg, "pg"),
    memoryStore: new DrizzleMemoryStore(db, memoryPg),
    peerStore: new DrizzlePeerStore(db, {
      peers: peersPg, peerAllowlist: peerAllowlistPg,
      pairingRequests: pairingRequestsPg, peerSessions: peerSessionsPg,
    }),
    checkpointStore: new DrizzleCheckpointStore(db, metadataPg, "pg"),
    delayStore: new DrizzleDelayStore(db, metadataPg, "pg"),
    configStore: new DrizzleConfigStore(db, metadataPg, "pg"),
  };
}

// ── SQLite factory ────────────────────────────────────────────────────

/**
 * Create all Drizzle stores backed by SQLite (better-sqlite3).
 *
 * @param db A Drizzle database instance (e.g. from `drizzle(new Database(...))`)
 */
export function createSqliteStores(db: any): DrizzleStores {
  return {
    taskStore: new DrizzleTaskStore(db, {
      tasks: tasksSqlite, missions: missionsSqlite, metadata: metadataSqlite, processes: processesSqlite,
    }, "sqlite"),
    runStore: new DrizzleRunStore(db, runsSqlite, "sqlite"),
    sessionStore: new DrizzleSessionStore(db, sessionsSqlite, messagesSqlite, "sqlite"),
    notificationStore: new DrizzleNotificationStore(db, notificationsSqlite, "sqlite"),
    logStore: new DrizzleLogStore(db, logSessionsSqlite, logEntriesSqlite, "sqlite"),
    approvalStore: new DrizzleApprovalStore(db, approvalsSqlite, "sqlite"),
    memoryStore: new DrizzleMemoryStore(db, memorySqlite),
    peerStore: new DrizzlePeerStore(db, {
      peers: peersSqlite, peerAllowlist: peerAllowlistSqlite,
      pairingRequests: pairingRequestsSqlite, peerSessions: peerSessionsSqlite,
    }),
    checkpointStore: new DrizzleCheckpointStore(db, metadataSqlite, "sqlite"),
    delayStore: new DrizzleDelayStore(db, metadataSqlite, "sqlite"),
    configStore: new DrizzleConfigStore(db, metadataSqlite, "sqlite"),
  };
}

// ── All PG table references (for drizzle-kit migrations) ──────────────

export const pgSchema = {
  tasks: tasksPg,
  missions: missionsPg,
  metadata: metadataPg,
  processes: processesPg,
  runs: runsPg,
  sessions: sessionsPg,
  messages: messagesPg,
  notifications: notificationsPg,
  logSessions: logSessionsPg,
  logEntries: logEntriesPg,
  approvals: approvalsPg,
  memory: memoryPg,
  peers: peersPg,
  peerAllowlist: peerAllowlistPg,
  pairingRequests: pairingRequestsPg,
  peerSessions: peerSessionsPg,
};

export const sqliteSchema = {
  tasks: tasksSqlite,
  missions: missionsSqlite,
  metadata: metadataSqlite,
  processes: processesSqlite,
  runs: runsSqlite,
  sessions: sessionsSqlite,
  messages: messagesSqlite,
  notifications: notificationsSqlite,
  logSessions: logSessionsSqlite,
  logEntries: logEntriesSqlite,
  approvals: approvalsSqlite,
  memory: memorySqlite,
  peers: peersSqlite,
  peerAllowlist: peerAllowlistSqlite,
  pairingRequests: pairingRequestsSqlite,
  peerSessions: peerSessionsSqlite,
};
