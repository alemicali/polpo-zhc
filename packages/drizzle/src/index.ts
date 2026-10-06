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
export { migratePg, migrateSqlite, configureSqlite, ensurePgSchema, type MigrationResult } from "./migrate.js";
export type { Dialect } from "./utils.js";
export { pgSafe } from "./utils.js";

// ── Schema sets ───────────────────────────────────────────────────────

import {
  tasksPg, missionsPg, metadataPg, processesPg,
  tasksSqlite, missionsSqlite, metadataSqlite, processesSqlite,
} from "./schema/tasks.js";
import { runsPg, runsSqlite } from "./schema/runs.js";
import {
  taskDirectionsPg, agentCheckpointsPg, backgroundWaitsPg,
  taskDirectionsSqlite, agentCheckpointsSqlite, backgroundWaitsSqlite,
} from "./schema/task-control.js";
import { sessionsPg, messagesPg, sessionsSqlite, messagesSqlite } from "./schema/sessions.js";
import { notificationsPg, notificationsSqlite } from "./schema/notifications.js";
import { logSessionsPg, logEntriesPg, logSessionsSqlite, logEntriesSqlite } from "./schema/logs.js";
import { approvalsPg, approvalsSqlite } from "./schema/approvals.js";
import { memoryPg, memorySqlite } from "./schema/memory.js";
import {
  peersPg, peerAllowlistPg, pairingRequestsPg, peerSessionsPg,
  peersSqlite, peerAllowlistSqlite, pairingRequestsSqlite, peerSessionsSqlite,
} from "./schema/peers.js";
import {
  teamsPg, agentsPg,
  teamsSqlite, agentsSqlite,
} from "./schema/teams.js";
import { vaultPg, vaultSqlite } from "./schema/vault.js";
import { playbooksPg, playbooksSqlite } from "./schema/playbooks.js";
import { attachmentsPg, attachmentsSqlite } from "./schema/attachments.js";
import { codingSessionsPg, codingSessionsSqlite } from "./schema/coding-sessions.js";
import { expoTokensPg, expoTokensSqlite } from "./schema/expo-tokens.js";
import {
  pushSubscriptionsPg, pushSubscriptionsSqlite,
  pushVapidPg, pushVapidSqlite,
} from "./schema/push-subscriptions.js";
import { tokenUsagePg, tokenUsageSqlite, contextCheckpointsPg, contextCheckpointsSqlite } from "./schema/usage.js";
import {
  appsPg, appsSqlite,
  dataSourcesPg, dataSourcesSqlite, dataViewsPg, dataViewsSqlite, dataActivityPg, dataActivitySqlite,
} from "./schema/registries.js";
import { brainItemsPg, brainItemsSqlite } from "./schema/company-brain.js";
import {
  whatsappMessagesPg, whatsappMessagesSqlite, whatsappContactsPg, whatsappContactsSqlite,
} from "./schema/whatsapp.js";
import {
  chatQueueItemsPg, chatQueueItemsSqlite, chatQueueSettingsPg, chatQueueSettingsSqlite,
} from "./schema/chat-queue.js";
import { roomsPg, roomsSqlite, roomMessagesPg, roomMessagesSqlite } from "./schema/rooms.js";

// ── Store classes ─────────────────────────────────────────────────────

import { DrizzleTaskStore } from "./stores/task-store.js";
import { DrizzleRunStore } from "./stores/run-store.js";
import { DrizzleTaskControlStore } from "./stores/task-control-store.js";
import { DrizzleSessionStore } from "./stores/session-store.js";
import { DrizzleNotificationStore } from "./stores/notification-store.js";
import { DrizzleLogStore } from "./stores/log-store.js";
import { DrizzleApprovalStore } from "./stores/approval-store.js";
import { DrizzleMemoryStore } from "./stores/memory-store.js";
import { DrizzlePeerStore } from "./stores/peer-store.js";
import { DrizzleCheckpointStore } from "./stores/checkpoint-store.js";
import { DrizzleDelayStore } from "./stores/delay-store.js";
import { DrizzleConfigStore } from "./stores/config-store.js";
import { DrizzleTeamStore } from "./stores/team-store.js";
import { DrizzleAgentStore } from "./stores/agent-store.js";
import { DrizzleVaultStore } from "./stores/vault-store.js";
import { DrizzlePlaybookStore } from "./stores/playbook-store.js";
import { DrizzleAttachmentStore } from "./stores/attachment-store.js";
import {
  DrizzleCodingSessionStore,
  type CodingSessionStoreLike,
} from "./stores/coding-session-store.js";
import { DrizzleExpoTokenStore } from "./stores/expo-token-store.js";
import { DrizzlePushSubscriptionStore } from "./stores/push-subscription-store.js";
import { DrizzleTokenUsageStore } from "./stores/token-usage-store.js";
import { DrizzleContextCheckpointStore } from "./stores/context-checkpoint-store.js";
import { DrizzleAppRegistryStore } from "./stores/app-registry-store.js";
import { DrizzleDataRegistryStore } from "./stores/data-registry-store.js";
import { DrizzleCompanyBrainStore } from "./stores/company-brain-store.js";
import { DrizzleWhatsAppStore } from "./stores/whatsapp-store.js";
import { DrizzleChatQueueStore } from "./stores/chat-queue-store.js";
import { DrizzleRoomStore } from "./stores/room-store.js";

// ── Store bundle type ─────────────────────────────────────────────────

import type { TaskStore } from "@polpo-ai/core/task-store";
import type { RunStore } from "@polpo-ai/core/run-store";
import type { BackgroundWaitStore, TaskControlStore } from "@polpo-ai/core";
import type { ChatQueueStore, SessionStore } from "@polpo-ai/core/session-store";
import type { RoomStore } from "@polpo-ai/core/room-store";
import type { NotificationStore } from "@polpo-ai/core/notification-store";
import type { LogStore } from "@polpo-ai/core/log-store";
import type { ApprovalStore } from "@polpo-ai/core/approval-store";
import type { MemoryStore } from "@polpo-ai/core/memory-store";
import type { PeerStore } from "@polpo-ai/core/peer-store";
import type { CheckpointStore } from "@polpo-ai/core/checkpoint-store";
import type { DelayStore } from "@polpo-ai/core/delay-store";
import type { ConfigStore } from "@polpo-ai/core/config-store";
import type { TeamStore } from "@polpo-ai/core/team-store";
import type { AgentStore } from "@polpo-ai/core/agent-store";
import type { VaultStore } from "@polpo-ai/core/vault-store";
import type { PlaybookStore } from "@polpo-ai/core/playbook-store";
import type { AttachmentStore } from "@polpo-ai/core/attachment-store";
import type { TokenUsageStore } from "@polpo-ai/core/token-usage";
import type { ContextCheckpointStore } from "@polpo-ai/core/context-checkpoint";
import type { AppRegistryStore } from "@polpo-ai/core/app-registry";
import type { DataRegistryStore } from "@polpo-ai/core/data-registry";
import type { CompanyBrainStore } from "@polpo-ai/core/company-brain";
import type { WhatsAppMessageStore } from "@polpo-ai/core/whatsapp-store";

export interface DrizzleStores {
  taskStore: TaskStore;
  runStore: RunStore;
  taskControlStore: TaskControlStore & BackgroundWaitStore;
  sessionStore: SessionStore;
  notificationStore: NotificationStore;
  logStore: LogStore;
  approvalStore: ApprovalStore;
  memoryStore: MemoryStore;
  peerStore: PeerStore;
  checkpointStore: CheckpointStore;
  delayStore: DelayStore;
  configStore: ConfigStore;
  teamStore: TeamStore;
  agentStore: AgentStore;
  vaultStore: VaultStore;
  playbookStore: PlaybookStore;
  attachmentStore: AttachmentStore;
  codingSessionStore: CodingSessionStoreLike;
  expoTokenStore: DrizzleExpoTokenStore;
  pushSubscriptionStore: DrizzlePushSubscriptionStore;
  tokenUsageStore: DrizzleTokenUsageStore & TokenUsageStore;
  contextCheckpointStore: ContextCheckpointStore;
  appRegistryStore: DrizzleAppRegistryStore & AppRegistryStore;
  dataRegistryStore: DrizzleDataRegistryStore & DataRegistryStore;
  companyBrainStore: CompanyBrainStore;
  whatsappStore: WhatsAppMessageStore;
  chatQueueStore: ChatQueueStore;
  roomStore: RoomStore;
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
    taskControlStore: new DrizzleTaskControlStore(db, taskDirectionsPg, agentCheckpointsPg, backgroundWaitsPg, "pg"),
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
    teamStore: new DrizzleTeamStore(db, teamsPg, agentsPg, "pg"),
    agentStore: new DrizzleAgentStore(db, agentsPg, "pg"),
    vaultStore: new DrizzleVaultStore(db, vaultPg),
    playbookStore: new DrizzlePlaybookStore(db, playbooksPg, "pg"),
    attachmentStore: new DrizzleAttachmentStore(db, attachmentsPg, "pg"),
    codingSessionStore: new DrizzleCodingSessionStore(db, codingSessionsPg, "pg"),
    expoTokenStore: new DrizzleExpoTokenStore(db, expoTokensPg, "pg"),
    pushSubscriptionStore: new DrizzlePushSubscriptionStore(db, pushSubscriptionsPg, pushVapidPg, "pg"),
    tokenUsageStore: new DrizzleTokenUsageStore(db, tokenUsagePg, "pg"),
    contextCheckpointStore: new DrizzleContextCheckpointStore(db, contextCheckpointsPg, "pg"),
    appRegistryStore: new DrizzleAppRegistryStore(db, appsPg, "pg"),
    dataRegistryStore: new DrizzleDataRegistryStore(db, { sources: dataSourcesPg, views: dataViewsPg, activity: dataActivityPg }, "pg"),
    companyBrainStore: new DrizzleCompanyBrainStore(db, brainItemsPg, "pg"),
    whatsappStore: new DrizzleWhatsAppStore(db, { messages: whatsappMessagesPg, contacts: whatsappContactsPg }, "pg"),
    chatQueueStore: new DrizzleChatQueueStore(db, chatQueueItemsPg, chatQueueSettingsPg, "pg"),
    roomStore: new DrizzleRoomStore(db, roomsPg, roomMessagesPg, "pg"),
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
    taskControlStore: new DrizzleTaskControlStore(db, taskDirectionsSqlite, agentCheckpointsSqlite, backgroundWaitsSqlite, "sqlite"),
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
    teamStore: new DrizzleTeamStore(db, teamsSqlite, agentsSqlite, "sqlite"),
    agentStore: new DrizzleAgentStore(db, agentsSqlite, "sqlite"),
    vaultStore: new DrizzleVaultStore(db, vaultSqlite),
    playbookStore: new DrizzlePlaybookStore(db, playbooksSqlite, "sqlite"),
    attachmentStore: new DrizzleAttachmentStore(db, attachmentsSqlite, "sqlite"),
    codingSessionStore: new DrizzleCodingSessionStore(db, codingSessionsSqlite, "sqlite"),
    expoTokenStore: new DrizzleExpoTokenStore(db, expoTokensSqlite, "sqlite"),
    pushSubscriptionStore: new DrizzlePushSubscriptionStore(db, pushSubscriptionsSqlite, pushVapidSqlite, "sqlite"),
    tokenUsageStore: new DrizzleTokenUsageStore(db, tokenUsageSqlite, "sqlite"),
    contextCheckpointStore: new DrizzleContextCheckpointStore(db, contextCheckpointsSqlite, "sqlite"),
    appRegistryStore: new DrizzleAppRegistryStore(db, appsSqlite, "sqlite"),
    dataRegistryStore: new DrizzleDataRegistryStore(db, { sources: dataSourcesSqlite, views: dataViewsSqlite, activity: dataActivitySqlite }, "sqlite"),
    companyBrainStore: new DrizzleCompanyBrainStore(db, brainItemsSqlite, "sqlite"),
    whatsappStore: new DrizzleWhatsAppStore(db, { messages: whatsappMessagesSqlite, contacts: whatsappContactsSqlite }, "sqlite"),
    chatQueueStore: new DrizzleChatQueueStore(db, chatQueueItemsSqlite, chatQueueSettingsSqlite, "sqlite"),
    roomStore: new DrizzleRoomStore(db, roomsSqlite, roomMessagesSqlite, "sqlite"),
  };
}

// ── All PG table references (for drizzle-kit migrations) ──────────────

export const pgSchema = {
  tasks: tasksPg,
  missions: missionsPg,
  metadata: metadataPg,
  processes: processesPg,
  runs: runsPg,
  backgroundWaits: backgroundWaitsPg,
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
  teams: teamsPg,
  agents: agentsPg,
  vault: vaultPg,
  playbooks: playbooksPg,
  attachments: attachmentsPg,
  codingSessions: codingSessionsPg,
  expoTokens: expoTokensPg,
  pushSubscriptions: pushSubscriptionsPg,
  pushVapid: pushVapidPg,
  tokenUsage: tokenUsagePg,
  contextCheckpoints: contextCheckpointsPg,
  apps: appsPg,
  dataSources: dataSourcesPg,
  dataViews: dataViewsPg,
  dataActivity: dataActivityPg,
  brainItems: brainItemsPg,
  whatsappMessages: whatsappMessagesPg,
  whatsappContacts: whatsappContactsPg,
  chatQueueItems: chatQueueItemsPg,
  chatQueueSettings: chatQueueSettingsPg,
  rooms: roomsPg,
  roomMessages: roomMessagesPg,
};

export const sqliteSchema = {
  tasks: tasksSqlite,
  missions: missionsSqlite,
  metadata: metadataSqlite,
  processes: processesSqlite,
  runs: runsSqlite,
  backgroundWaits: backgroundWaitsSqlite,
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
  teams: teamsSqlite,
  agents: agentsSqlite,
  vault: vaultSqlite,
  playbooks: playbooksSqlite,
  attachments: attachmentsSqlite,
  codingSessions: codingSessionsSqlite,
  expoTokens: expoTokensSqlite,
  pushSubscriptions: pushSubscriptionsSqlite,
  pushVapid: pushVapidSqlite,
  tokenUsage: tokenUsageSqlite,
  contextCheckpoints: contextCheckpointsSqlite,
  apps: appsSqlite,
  dataSources: dataSourcesSqlite,
  dataViews: dataViewsSqlite,
  dataActivity: dataActivitySqlite,
  brainItems: brainItemsSqlite,
  whatsappMessages: whatsappMessagesSqlite,
  whatsappContacts: whatsappContactsSqlite,
  chatQueueItems: chatQueueItemsSqlite,
  chatQueueSettings: chatQueueSettingsSqlite,
  rooms: roomsSqlite,
  roomMessages: roomMessagesSqlite,
};
