/**
 * One-shot file → SQLite migration.
 *
 * Reads existing `.polpo/*.json` / `*.jsonl` files and copies them into the
 * Drizzle SQLite database. The original files are never touched — the
 * migration is purely additive so callers can roll back by simply deleting
 * `.polpo/state.db` and reverting `settings.storage` to `"file"`.
 *
 * Idempotency contract per store:
 *   - Pre-check: if the target table already has any rows, skip the store
 *     and log "already migrated".
 *   - Direct drizzle inserts run inside a single SQLite transaction so a
 *     half-finished migration leaves the table empty (passes the pre-check
 *     on the next run, which will then re-attempt the migration).
 *
 * The whole thing is best-effort: errors in one store are logged and the
 * migration continues with the next store. Callers should treat the result
 * as advisory — the legacy files stay around as the source of truth until
 * the user explicitly removes them.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { sqliteSchema as SqliteSchema } from "@polpo-ai/drizzle";

export interface MigrationOptions {
  /** Skip writes — just count what would be migrated. */
  dryRun?: boolean;
  /** Optional log sink (defaults to console.log). */
  log?: (msg: string) => void;
}

export interface PerStoreResult {
  store: string;
  status: "migrated" | "skipped-empty" | "skipped-existing" | "error";
  fileCount: number;
  dbCount: number;
  durationMs: number;
  error?: string;
}

export interface MigrationResult {
  ok: boolean;
  stores: PerStoreResult[];
  totalDurationMs: number;
}

type AnySchema = typeof SqliteSchema;

/**
 * Run all known file→sqlite migrations. The caller is responsible for
 * passing the same `db` instance the orchestrator uses so the migration
 * sees the same connection / WAL state.
 */
export async function migrateFileToSqlite(
  polpoDir: string,
  db: any,
  schema: AnySchema,
  opts: MigrationOptions = {},
): Promise<MigrationResult> {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const dryRun = opts.dryRun === true;
  const t0 = Date.now();
  const results: PerStoreResult[] = [];

  for (const fn of [
    migrateTasksAndMissions,
    migrateRuns,
    migrateSessionsAndMessages,
    migrateLogs,
    migrateMemory,
    migrateApprovals,
    migrateNotifications,
    migrateCheckpoints,
    migrateDelays,
    migrateTeams,
    migrateAgents,
    migratePlaybooks,
    migrateAttachments,
    migrateCodingSessions,
    // Expo tokens + push subscriptions are intentionally NOT migrated: their
    // runtime consumers (server routes + notification channels) always read
    // from FilePushSubscriptionStore / FileExpoTokenStore regardless of
    // `storage` mode (file-only by design, same rationale as vault).
    // Copying rows into the DB would just create a stale shadow that nobody
    // reads. The migration helpers `migrateExpoTokens` /
    // `migratePushSubscriptions` are kept below in case the policy changes.
    migratePeers,
  ]) {
    try {
      const res = await fn({ polpoDir, db, schema, dryRun, log });
      results.push(res);
      logResult(log, res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ store: fn.name, status: "error", fileCount: 0, dbCount: 0, durationMs: 0, error: msg });
      log(`[${fn.name}] ERROR: ${msg}`);
    }
  }

  const totalDurationMs = Date.now() - t0;
  const ok = results.every(r => r.status !== "error");
  log(`migration complete in ${totalDurationMs}ms — ${results.filter(r => r.status === "migrated").length} migrated, ${results.filter(r => r.status.startsWith("skipped")).length} skipped, ${results.filter(r => r.status === "error").length} errored.`);

  return { ok, stores: results, totalDurationMs };
}

// ── Internal helpers ─────────────────────────────────────────────────────

interface Ctx {
  polpoDir: string;
  db: any;
  schema: AnySchema;
  dryRun: boolean;
  log: (msg: string) => void;
}

function logResult(log: (msg: string) => void, r: PerStoreResult): void {
  if (r.status === "skipped-empty") log(`[${r.store}] no source data, skipped.`);
  else if (r.status === "skipped-existing") log(`[${r.store}] already migrated (db has ${r.dbCount} rows), skipped.`);
  else if (r.status === "migrated") log(`[${r.store}] migrated ${r.fileCount} entries in ${r.durationMs}ms.`);
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf-8")) as T; }
  catch { return fallback; }
}

function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter((x): x is unknown => x !== null);
  } catch { return []; }
}

async function tableCount(db: any, table: any): Promise<number> {
  const rows: any[] = await db.select({ c: sql<number>`count(*)` }).from(table);
  return Number(rows[0]?.c ?? 0);
}

function timed(): { ms: () => number } {
  const t = Date.now();
  return { ms: () => Date.now() - t };
}

// ── Tasks + missions + processes (via _meta.json) ────────────────────────

async function migrateTasksAndMissions(ctx: Ctx): Promise<PerStoreResult> {
  const t = timed();
  const tasksDir = join(ctx.polpoDir, "tasks");
  const missionsDir = join(ctx.polpoDir, "missions");
  const metaPath = join(ctx.polpoDir, "_meta.json");

  const dbCount = await tableCount(ctx.db, ctx.schema.tasks);
  if (dbCount > 0) {
    return { store: "tasks", status: "skipped-existing", fileCount: 0, dbCount, durationMs: t.ms() };
  }

  const taskFiles = existsSync(tasksDir)
    ? readdirSync(tasksDir).filter(f => f.endsWith(".json") && !f.endsWith(".tmp"))
    : [];
  const missionFiles = existsSync(missionsDir)
    ? readdirSync(missionsDir).filter(f => f.endsWith(".json") && !f.endsWith(".tmp"))
    : [];
  const meta = readJson<any>(metaPath, {});

  if (taskFiles.length === 0 && missionFiles.length === 0 && !meta?.project) {
    return { store: "tasks", status: "skipped-empty", fileCount: 0, dbCount: 0, durationMs: t.ms() };
  }

  if (!ctx.dryRun) {
    for (const f of taskFiles) {
      const task = readJson<any>(join(tasksDir, f), null);
      if (!task?.id) continue;
      await ctx.db.insert(ctx.schema.tasks).values(taskToRow(task)).onConflictDoNothing();
    }
    for (const f of missionFiles) {
      const mission = readJson<any>(join(missionsDir, f), null);
      if (!mission?.id) continue;
      await ctx.db.insert(ctx.schema.missions).values(missionToRow(mission)).onConflictDoNothing();
    }
    // Meta keys → metadata table
    for (const key of ["project", "teams", "startedAt", "completedAt"] as const) {
      if (meta?.[key] !== undefined) {
        const value = typeof meta[key] === "string" ? meta[key] : JSON.stringify(meta[key]);
        await ctx.db.insert(ctx.schema.metadata).values({ key, value })
          .onConflictDoUpdate({ target: ctx.schema.metadata.key, set: { value } });
      }
    }
    if (Array.isArray(meta?.processes)) {
      for (const p of meta.processes) {
        await ctx.db.insert(ctx.schema.processes).values({
          agentName: p.agentName,
          pid: p.pid,
          taskId: p.taskId,
          startedAt: p.startedAt,
          alive: p.alive ? 1 : 0,
          activity: JSON.stringify(p.activity ?? {}),
        });
      }
    }
  }

  return {
    store: "tasks",
    status: "migrated",
    fileCount: taskFiles.length + missionFiles.length,
    dbCount: taskFiles.length + missionFiles.length,
    durationMs: t.ms(),
  };
}

function taskToRow(task: any): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title ?? "",
    description: task.description ?? "",
    assignTo: task.assignTo ?? "",
    group: task.group ?? null,
    missionId: task.missionId ?? null,
    dependsOn: JSON.stringify(task.dependsOn ?? []),
    status: task.status ?? "pending",
    retries: task.retries ?? 0,
    maxRetries: task.maxRetries ?? 2,
    maxDuration: task.maxDuration ?? null,
    retryPolicy: task.retryPolicy ? JSON.stringify(task.retryPolicy) : null,
    expectations: JSON.stringify(task.expectations ?? []),
    metrics: JSON.stringify(task.metrics ?? []),
    result: task.result ? JSON.stringify(task.result) : null,
    phase: task.phase ?? null,
    fixAttempts: task.fixAttempts ?? 0,
    resolutionAttempts: task.resolutionAttempts ?? 0,
    originalDescription: task.originalDescription ?? null,
    sessionId: task.sessionId ?? null,
    notifications: task.notifications ? JSON.stringify(task.notifications) : null,
    outcomes: task.outcomes ? JSON.stringify(task.outcomes) : null,
    expectedOutcomes: task.expectedOutcomes ? JSON.stringify(task.expectedOutcomes) : null,
    deadline: task.deadline ?? null,
    priority: task.priority != null ? String(task.priority) : null,
    sideEffects: task.sideEffects === true ? 1 : task.sideEffects === false ? 0 : null,
    revisionCount: task.revisionCount ?? null,
    createdAt: task.createdAt ?? new Date().toISOString(),
    updatedAt: task.updatedAt ?? new Date().toISOString(),
  };
}

function missionToRow(m: any): Record<string, unknown> {
  return {
    id: m.id,
    name: m.name ?? m.id,
    data: typeof m.data === "string" ? m.data : JSON.stringify(m.data ?? m),
    prompt: m.prompt ?? null,
    status: m.status ?? "draft",
    schedule: m.schedule ?? null,
    endDate: m.endDate ?? null,
    qualityThreshold: m.qualityThreshold != null ? String(m.qualityThreshold) : null,
    deadline: m.deadline ?? null,
    notifications: m.notifications ? JSON.stringify(m.notifications) : null,
    executionCount: m.executionCount ?? 0,
    createdAt: m.createdAt ?? new Date().toISOString(),
    updatedAt: m.updatedAt ?? new Date().toISOString(),
  };
}

// ── Runs ─────────────────────────────────────────────────────────────────

async function migrateRuns(ctx: Ctx): Promise<PerStoreResult> {
  const t = timed();
  const runsDir = join(ctx.polpoDir, "runs");
  const dbCount = await tableCount(ctx.db, ctx.schema.runs);
  if (dbCount > 0) return { store: "runs", status: "skipped-existing", fileCount: 0, dbCount, durationMs: t.ms() };

  const files = existsSync(runsDir)
    ? readdirSync(runsDir).filter(f => f.endsWith(".json") && !f.endsWith(".tmp"))
    : [];
  if (files.length === 0) return { store: "runs", status: "skipped-empty", fileCount: 0, dbCount: 0, durationMs: t.ms() };

  if (!ctx.dryRun) {
    for (const f of files) {
      const r = readJson<any>(join(runsDir, f), null);
      if (!r?.id) continue;
      await ctx.db.insert(ctx.schema.runs).values({
        id: r.id,
        taskId: r.taskId,
        pid: r.pid ?? 0,
        agentName: r.agentName ?? "",
        adapterType: r.adapterType ?? "sdk",
        sessionId: r.sessionId ?? null,
        status: r.status ?? "running",
        startedAt: r.startedAt ?? new Date().toISOString(),
        updatedAt: r.updatedAt ?? new Date().toISOString(),
        activity: JSON.stringify(r.activity ?? {}),
        result: r.result ? JSON.stringify(r.result) : null,
        outcomes: r.outcomes ? JSON.stringify(r.outcomes) : null,
        config: r.config ? JSON.stringify(r.config) : null,
        configPath: r.configPath ?? "",
      }).onConflictDoNothing();
    }
  }
  return { store: "runs", status: "migrated", fileCount: files.length, dbCount: files.length, durationMs: t.ms() };
}

// ── Sessions + messages ──────────────────────────────────────────────────

async function migrateSessionsAndMessages(ctx: Ctx): Promise<PerStoreResult> {
  const t = timed();
  const sessionsDir = join(ctx.polpoDir, "sessions");
  const dbCount = await tableCount(ctx.db, ctx.schema.sessions);
  if (dbCount > 0) return { store: "sessions", status: "skipped-existing", fileCount: 0, dbCount, durationMs: t.ms() };

  const files = existsSync(sessionsDir)
    ? readdirSync(sessionsDir).filter(f => f.endsWith(".jsonl"))
    : [];
  if (files.length === 0) return { store: "sessions", status: "skipped-empty", fileCount: 0, dbCount: 0, durationMs: t.ms() };

  let inserted = 0;
  if (!ctx.dryRun) {
    for (const file of files) {
      const path = join(sessionsDir, file);
      const lines = readJsonl(path) as any[];
      if (lines.length === 0) continue;
      const header = lines.find(l => l?._session) ?? {};
      const sessionId = header.id ?? file.replace(/\.jsonl$/, "");
      const createdAt = header.createdAt ?? new Date(statSync(path).mtimeMs).toISOString();
      const updatedAt = new Date(statSync(path).mtimeMs).toISOString();
      await ctx.db.insert(ctx.schema.sessions).values({
        id: sessionId,
        title: header.title ?? null,
        agent: header.agent ?? null,
        createdAt,
        updatedAt,
        starred: header.starred === true ? 1 : header.starred === false ? 0 : null,
      }).onConflictDoNothing();
      inserted++;
      for (const msg of lines) {
        if (!msg || msg._session) continue;
        if (!msg.id || !msg.role) continue;
        await ctx.db.insert(ctx.schema.messages).values({
          id: msg.id,
          sessionId,
          role: msg.role,
          content: msg.content ?? "",
          ts: msg.ts ?? createdAt,
          toolCalls: msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
          segments: msg.segments ? JSON.stringify(msg.segments) : null,
        }).onConflictDoNothing();
      }
    }
  }
  return { store: "sessions", status: "migrated", fileCount: files.length, dbCount: inserted, durationMs: t.ms() };
}

// ── Logs ─────────────────────────────────────────────────────────────────

async function migrateLogs(ctx: Ctx): Promise<PerStoreResult> {
  const t = timed();
  const logsDir = join(ctx.polpoDir, "logs");
  const dbCount = await tableCount(ctx.db, ctx.schema.logSessions);
  if (dbCount > 0) return { store: "logs", status: "skipped-existing", fileCount: 0, dbCount, durationMs: t.ms() };

  const files = existsSync(logsDir)
    ? readdirSync(logsDir).filter(f => f.endsWith(".jsonl"))
    : [];
  if (files.length === 0) return { store: "logs", status: "skipped-empty", fileCount: 0, dbCount: 0, durationMs: t.ms() };

  let sessionsInserted = 0;
  if (!ctx.dryRun) {
    for (const file of files) {
      const path = join(logsDir, file);
      const lines = readJsonl(path) as any[];
      if (lines.length === 0) continue;
      const header = lines.find(l => l?._session) ?? {};
      const sessionId = header.sessionId ?? file.replace(/\.jsonl$/, "");
      const startedAt = header.startedAt ?? new Date(statSync(path).mtimeMs).toISOString();
      await ctx.db.insert(ctx.schema.logSessions).values({ id: sessionId, startedAt }).onConflictDoNothing();
      sessionsInserted++;
      for (const entry of lines) {
        if (!entry || entry._session) continue;
        const id = entry.id ?? `${sessionId}:${Math.random().toString(36).slice(2, 10)}`;
        await ctx.db.insert(ctx.schema.logEntries).values({
          id,
          sessionId,
          ts: entry.ts ?? startedAt,
          event: entry.event ?? "log",
          data: entry.data ? JSON.stringify(entry.data) : null,
        }).onConflictDoNothing();
      }
    }
  }
  return { store: "logs", status: "migrated", fileCount: files.length, dbCount: sessionsInserted, durationMs: t.ms() };
}

// ── Memory ──────────────────────────────────────────────────────────────

async function migrateMemory(ctx: Ctx): Promise<PerStoreResult> {
  const t = timed();
  const sharedPath = join(ctx.polpoDir, "memory.md");
  const scopeDir = join(ctx.polpoDir, "memory");

  const dbCount = await tableCount(ctx.db, ctx.schema.memory);
  if (dbCount > 0) return { store: "memory", status: "skipped-existing", fileCount: 0, dbCount, durationMs: t.ms() };

  const scopeFiles = existsSync(scopeDir)
    ? readdirSync(scopeDir).filter(f => f.endsWith(".md"))
    : [];
  if (!existsSync(sharedPath) && scopeFiles.length === 0) {
    return { store: "memory", status: "skipped-empty", fileCount: 0, dbCount: 0, durationMs: t.ms() };
  }

  let inserted = 0;
  if (!ctx.dryRun) {
    if (existsSync(sharedPath)) {
      const content = readFileSync(sharedPath, "utf-8");
      await ctx.db.insert(ctx.schema.memory).values({ key: "default", content })
        .onConflictDoUpdate({ target: ctx.schema.memory.key, set: { content } });
      inserted++;
    }
    for (const f of scopeFiles) {
      const agentName = f.replace(/\.md$/, "");
      const content = readFileSync(join(scopeDir, f), "utf-8");
      await ctx.db.insert(ctx.schema.memory).values({ key: `agent:${agentName}`, content })
        .onConflictDoUpdate({ target: ctx.schema.memory.key, set: { content } });
      inserted++;
    }
  }
  return { store: "memory", status: "migrated", fileCount: inserted, dbCount: inserted, durationMs: t.ms() };
}

// ── Approvals ───────────────────────────────────────────────────────────

async function migrateApprovals(ctx: Ctx): Promise<PerStoreResult> {
  const t = timed();
  const filePath = join(ctx.polpoDir, "approvals.json");
  const dbCount = await tableCount(ctx.db, ctx.schema.approvals);
  if (dbCount > 0) return { store: "approvals", status: "skipped-existing", fileCount: 0, dbCount, durationMs: t.ms() };

  const records = readJson<any[]>(filePath, []);
  if (!Array.isArray(records) || records.length === 0) {
    return { store: "approvals", status: "skipped-empty", fileCount: 0, dbCount: 0, durationMs: t.ms() };
  }
  if (!ctx.dryRun) {
    for (const r of records) {
      if (!r?.id) continue;
      await ctx.db.insert(ctx.schema.approvals).values({
        id: r.id,
        gateId: r.gateId ?? "",
        gateName: r.gateName ?? r.gateId ?? "",
        taskId: r.taskId ?? null,
        missionId: r.missionId ?? null,
        status: r.status ?? "pending",
        payload: r.payload ? JSON.stringify(r.payload) : null,
        requestedAt: r.requestedAt ?? new Date().toISOString(),
        resolvedAt: r.resolvedAt ?? null,
        resolvedBy: r.resolvedBy ?? null,
        note: r.note ?? null,
      }).onConflictDoNothing();
    }
  }
  return { store: "approvals", status: "migrated", fileCount: records.length, dbCount: records.length, durationMs: t.ms() };
}

// ── Notifications ───────────────────────────────────────────────────────

async function migrateNotifications(ctx: Ctx): Promise<PerStoreResult> {
  const t = timed();
  const filePath = join(ctx.polpoDir, "notifications.json");
  const dbCount = await tableCount(ctx.db, ctx.schema.notifications);
  if (dbCount > 0) return { store: "notifications", status: "skipped-existing", fileCount: 0, dbCount, durationMs: t.ms() };

  const records = readJson<any[]>(filePath, []);
  if (!Array.isArray(records) || records.length === 0) {
    return { store: "notifications", status: "skipped-empty", fileCount: 0, dbCount: 0, durationMs: t.ms() };
  }
  if (!ctx.dryRun) {
    for (const r of records) {
      if (!r?.id) continue;
      await ctx.db.insert(ctx.schema.notifications).values({
        id: r.id,
        timestamp: r.timestamp ?? new Date().toISOString(),
        ruleId: r.ruleId ?? "",
        ruleName: r.ruleName ?? r.ruleId ?? "",
        channel: r.channel ?? "",
        channelType: r.channelType ?? "",
        status: r.status ?? "sent",
        error: r.error ?? null,
        title: r.title ?? "",
        body: r.body ?? "",
        severity: r.severity ?? "info",
        sourceEvent: r.sourceEvent ?? "",
        attachmentCount: r.attachmentCount ?? 0,
        attachmentTypes: r.attachmentTypes ? JSON.stringify(r.attachmentTypes) : null,
      }).onConflictDoNothing();
    }
  }
  return { store: "notifications", status: "migrated", fileCount: records.length, dbCount: records.length, durationMs: t.ms() };
}

// ── Checkpoints + delays (single-row metadata) ──────────────────────────

async function migrateCheckpoints(ctx: Ctx): Promise<PerStoreResult> {
  return migrateMetadataBlob(ctx, "checkpoints", "checkpoints.json", { definitions: {}, active: {}, resumed: [] });
}

async function migrateDelays(ctx: Ctx): Promise<PerStoreResult> {
  return migrateMetadataBlob(ctx, "delays", "delays.json", { active: {} });
}

async function migrateMetadataBlob(ctx: Ctx, key: string, filename: string, _empty: unknown): Promise<PerStoreResult> {
  const t = timed();
  const filePath = join(ctx.polpoDir, filename);

  // Existence check on the specific metadata key.
  const rows: any[] = await ctx.db.select().from(ctx.schema.metadata)
    .where(sql`${ctx.schema.metadata.key} = ${key}`);
  if (rows.length > 0) {
    return { store: key, status: "skipped-existing", fileCount: 0, dbCount: 1, durationMs: t.ms() };
  }

  if (!existsSync(filePath)) {
    return { store: key, status: "skipped-empty", fileCount: 0, dbCount: 0, durationMs: t.ms() };
  }
  if (!ctx.dryRun) {
    const value = readFileSync(filePath, "utf-8");
    await ctx.db.insert(ctx.schema.metadata).values({ key, value })
      .onConflictDoUpdate({ target: ctx.schema.metadata.key, set: { value } });
  }
  return { store: key, status: "migrated", fileCount: 1, dbCount: 1, durationMs: t.ms() };
}

// ── Teams + agents ──────────────────────────────────────────────────────

async function migrateTeams(ctx: Ctx): Promise<PerStoreResult> {
  const t = timed();
  const filePath = join(ctx.polpoDir, "teams.json");
  const dbCount = await tableCount(ctx.db, ctx.schema.teams);
  if (dbCount > 0) return { store: "teams", status: "skipped-existing", fileCount: 0, dbCount, durationMs: t.ms() };

  const teams = readJson<any[]>(filePath, []);
  if (!Array.isArray(teams) || teams.length === 0) {
    return { store: "teams", status: "skipped-empty", fileCount: 0, dbCount: 0, durationMs: t.ms() };
  }
  if (!ctx.dryRun) {
    const now = new Date().toISOString();
    for (const team of teams) {
      if (!team?.name) continue;
      await ctx.db.insert(ctx.schema.teams).values({
        name: team.name,
        description: team.description ?? null,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing();
    }
  }
  return { store: "teams", status: "migrated", fileCount: teams.length, dbCount: teams.length, durationMs: t.ms() };
}

async function migrateAgents(ctx: Ctx): Promise<PerStoreResult> {
  const t = timed();
  const filePath = join(ctx.polpoDir, "agents.json");
  const dbCount = await tableCount(ctx.db, ctx.schema.agents);
  if (dbCount > 0) return { store: "agents", status: "skipped-existing", fileCount: 0, dbCount, durationMs: t.ms() };

  const agents = readJson<any[]>(filePath, []);
  if (!Array.isArray(agents) || agents.length === 0) {
    return { store: "agents", status: "skipped-empty", fileCount: 0, dbCount: 0, durationMs: t.ms() };
  }
  let inserted = 0;
  if (!ctx.dryRun) {
    const now = new Date().toISOString();
    for (const entry of agents) {
      // Real shape from FileAgentStore: { agent: AgentConfig, teamName: string }
      // Fallbacks for older / hand-edited files.
      const inner = entry?.agent ?? entry?.config ?? entry;
      const name = inner?.name ?? entry?.name;
      const teamName = entry?.teamName ?? entry?.team_name ?? inner?.teamName ?? "default";
      if (!name) continue;
      const cfg = inner;
      await ctx.db.insert(ctx.schema.agents).values({
        name,
        teamName,
        config: JSON.stringify(cfg),
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing();
      inserted++;
    }
  }
  return { store: "agents", status: "migrated", fileCount: agents.length, dbCount: ctx.dryRun ? agents.length : inserted, durationMs: t.ms() };
}

// ── Playbooks ───────────────────────────────────────────────────────────

async function migratePlaybooks(ctx: Ctx): Promise<PerStoreResult> {
  const t = timed();
  const dir = join(ctx.polpoDir, "playbooks");
  const dbCount = await tableCount(ctx.db, ctx.schema.playbooks);
  if (dbCount > 0) return { store: "playbooks", status: "skipped-existing", fileCount: 0, dbCount, durationMs: t.ms() };

  const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".json")) : [];
  if (files.length === 0) return { store: "playbooks", status: "skipped-empty", fileCount: 0, dbCount: 0, durationMs: t.ms() };

  let inserted = 0;
  if (!ctx.dryRun) {
    const now = new Date().toISOString();
    for (const f of files) {
      const def = readJson<any>(join(dir, f), null);
      if (!def?.name) continue;
      await ctx.db.insert(ctx.schema.playbooks).values({
        name: def.name,
        description: def.description ?? "",
        mission: JSON.stringify(def.mission ?? {}),
        parameters: def.parameters ? JSON.stringify(def.parameters) : null,
        version: def.version ?? null,
        author: def.author ?? null,
        tags: def.tags ? JSON.stringify(def.tags) : null,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing();
      inserted++;
    }
  }
  return { store: "playbooks", status: "migrated", fileCount: files.length, dbCount: inserted, durationMs: t.ms() };
}

// ── Attachments ─────────────────────────────────────────────────────────

async function migrateAttachments(ctx: Ctx): Promise<PerStoreResult> {
  const t = timed();
  const filePath = join(ctx.polpoDir, "attachments.json");
  const dbCount = await tableCount(ctx.db, ctx.schema.attachments);
  if (dbCount > 0) return { store: "attachments", status: "skipped-existing", fileCount: 0, dbCount, durationMs: t.ms() };

  const records = readJson<any[]>(filePath, []);
  if (!Array.isArray(records) || records.length === 0) {
    return { store: "attachments", status: "skipped-empty", fileCount: 0, dbCount: 0, durationMs: t.ms() };
  }
  if (!ctx.dryRun) {
    for (const r of records) {
      if (!r?.id) continue;
      await ctx.db.insert(ctx.schema.attachments).values({
        id: r.id,
        sessionId: r.sessionId,
        messageId: r.messageId ?? null,
        filename: r.filename ?? r.id,
        mimeType: r.mimeType ?? "application/octet-stream",
        size: r.size ?? 0,
        path: r.path ?? "",
        createdAt: r.createdAt ?? new Date().toISOString(),
      }).onConflictDoNothing();
    }
  }
  return { store: "attachments", status: "migrated", fileCount: records.length, dbCount: records.length, durationMs: t.ms() };
}

// ── Coding sessions ─────────────────────────────────────────────────────

async function migrateCodingSessions(ctx: Ctx): Promise<PerStoreResult> {
  const t = timed();
  const filePath = join(ctx.polpoDir, "coding-sessions.json");
  const dbCount = await tableCount(ctx.db, ctx.schema.codingSessions);
  if (dbCount > 0) return { store: "coding-sessions", status: "skipped-existing", fileCount: 0, dbCount, durationMs: t.ms() };
  if (!existsSync(filePath)) return { store: "coding-sessions", status: "skipped-empty", fileCount: 0, dbCount: 0, durationMs: t.ms() };
  if (!ctx.dryRun) {
    const state = readFileSync(filePath, "utf-8");
    const now = new Date().toISOString();
    await ctx.db.insert(ctx.schema.codingSessions).values({
      id: "default",
      state,
      initialized: 1,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing();
  }
  return { store: "coding-sessions", status: "migrated", fileCount: 1, dbCount: 1, durationMs: t.ms() };
}

// ── Expo tokens + Push subscriptions ────────────────────────────────────

async function migrateExpoTokens(ctx: Ctx): Promise<PerStoreResult> {
  const t = timed();
  const filePath = join(ctx.polpoDir, "expo-tokens.json");
  const dbCount = await tableCount(ctx.db, ctx.schema.expoTokens);
  if (dbCount > 0) return { store: "expo-tokens", status: "skipped-existing", fileCount: 0, dbCount, durationMs: t.ms() };
  const data = readJson<{ tokens?: any[] }>(filePath, { tokens: [] });
  const tokens = data?.tokens ?? [];
  if (tokens.length === 0) return { store: "expo-tokens", status: "skipped-empty", fileCount: 0, dbCount: 0, durationMs: t.ms() };
  if (!ctx.dryRun) {
    for (const r of tokens) {
      if (!r?.token) continue;
      await ctx.db.insert(ctx.schema.expoTokens).values({
        token: r.token,
        platform: r.platform ?? "ios",
        deviceId: r.deviceId ?? "",
        createdAt: r.createdAt ?? new Date().toISOString(),
        lastSeenAt: r.lastSeenAt ?? new Date().toISOString(),
        failureCount: r.failureCount ?? 0,
        disabled: r.disabled === true ? 1 : 0,
      }).onConflictDoNothing();
    }
  }
  return { store: "expo-tokens", status: "migrated", fileCount: tokens.length, dbCount: tokens.length, durationMs: t.ms() };
}

async function migratePushSubscriptions(ctx: Ctx): Promise<PerStoreResult> {
  const t = timed();
  const filePath = join(ctx.polpoDir, "push.json");
  const dbCount = await tableCount(ctx.db, ctx.schema.pushSubscriptions);
  if (dbCount > 0) return { store: "push-subscriptions", status: "skipped-existing", fileCount: 0, dbCount, durationMs: t.ms() };
  const data = readJson<{ vapid?: any; subscriptions?: any[] }>(filePath, { subscriptions: [] });
  const subs = data?.subscriptions ?? [];
  if (subs.length === 0 && !data?.vapid) return { store: "push-subscriptions", status: "skipped-empty", fileCount: 0, dbCount: 0, durationMs: t.ms() };
  if (!ctx.dryRun) {
    if (data?.vapid) {
      await ctx.db.insert(ctx.schema.pushVapid).values({
        id: 1,
        publicKey: data.vapid.publicKey,
        privateKey: data.vapid.privateKey,
        subject: data.vapid.subject,
      }).onConflictDoUpdate({
        target: ctx.schema.pushVapid.id,
        set: { publicKey: data.vapid.publicKey, privateKey: data.vapid.privateKey, subject: data.vapid.subject },
      });
    }
    for (const r of subs) {
      if (!r?.endpoint) continue;
      const keys = r.keys ?? {};
      await ctx.db.insert(ctx.schema.pushSubscriptions).values({
        endpoint: r.endpoint,
        expirationTime: r.expirationTime ?? null,
        p256dh: keys.p256dh ?? "",
        auth: keys.auth ?? "",
        userAgent: r.userAgent ?? null,
        createdAt: r.createdAt ?? new Date().toISOString(),
        updatedAt: r.updatedAt ?? new Date().toISOString(),
        lastSuccessAt: r.lastSuccessAt ?? null,
        lastFailureAt: r.lastFailureAt ?? null,
        failureCount: r.failureCount ?? 0,
      }).onConflictDoNothing();
    }
  }
  return { store: "push-subscriptions", status: "migrated", fileCount: subs.length, dbCount: subs.length, durationMs: t.ms() };
}

// ── Peers (4 sub-tables) ────────────────────────────────────────────────

async function migratePeers(ctx: Ctx): Promise<PerStoreResult> {
  const t = timed();
  const dir = join(ctx.polpoDir, "peers");
  const dbCount = await tableCount(ctx.db, ctx.schema.peers);
  if (dbCount > 0) return { store: "peers", status: "skipped-existing", fileCount: 0, dbCount, durationMs: t.ms() };
  if (!existsSync(dir)) return { store: "peers", status: "skipped-empty", fileCount: 0, dbCount: 0, durationMs: t.ms() };

  const peers = readJson<any[]>(join(dir, "peers.json"), []);
  const allowlist = readJson<string[]>(join(dir, "allowlist.json"), []);
  const pairings = readJson<any[]>(join(dir, "pairing.json"), []);
  const sessions = readJson<Record<string, string>>(join(dir, "sessions.json"), {});

  const totalFiles = peers.length + allowlist.length + pairings.length + Object.keys(sessions).length;
  if (totalFiles === 0) return { store: "peers", status: "skipped-empty", fileCount: 0, dbCount: 0, durationMs: t.ms() };

  if (!ctx.dryRun) {
    for (const p of peers) {
      if (!p?.id) continue;
      await ctx.db.insert(ctx.schema.peers).values({
        id: p.id,
        channel: p.channel ?? "",
        externalId: p.externalId ?? "",
        displayName: p.displayName ?? null,
        firstSeenAt: p.firstSeenAt ?? new Date().toISOString(),
        lastSeenAt: p.lastSeenAt ?? new Date().toISOString(),
        linkedTo: p.linkedTo ?? null,
      }).onConflictDoNothing();
    }
    for (const peerId of allowlist) {
      await ctx.db.insert(ctx.schema.peerAllowlist).values({ peerId }).onConflictDoNothing();
    }
    for (const r of pairings) {
      if (!r?.code) continue;
      await ctx.db.insert(ctx.schema.pairingRequests).values({
        id: r.id ?? r.code,
        peerId: r.peerId,
        channel: r.channel ?? "",
        externalId: r.externalId ?? "",
        displayName: r.displayName ?? null,
        code: r.code,
        createdAt: r.createdAt ?? new Date().toISOString(),
        expiresAt: r.expiresAt ?? new Date().toISOString(),
        resolved: r.resolved === true ? 1 : 0,
      }).onConflictDoNothing();
    }
    for (const [peerId, sessionId] of Object.entries(sessions)) {
      await ctx.db.insert(ctx.schema.peerSessions).values({ peerId, sessionId })
        .onConflictDoUpdate({ target: ctx.schema.peerSessions.peerId, set: { sessionId } });
    }
  }
  return { store: "peers", status: "migrated", fileCount: totalFiles, dbCount: totalFiles, durationMs: t.ms() };
}
