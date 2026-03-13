/**
 * @polpo-ai/drizzle — SQLite in-memory tests for all 15 Drizzle stores.
 *
 * Uses better-sqlite3 :memory: — no PG required.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createSqliteStores, type DrizzleStores } from "../index.js";
import type { ApprovalRequest } from "@polpo-ai/core/types";

// Provide a deterministic vault key for tests (32 bytes hex-encoded)
process.env.POLPO_VAULT_KEY = randomBytes(32).toString("hex");

// ── Test helpers ─────────────────────────────────────────────────────

let sqlite: InstanceType<typeof Database>;
let db: ReturnType<typeof drizzle>;
let stores: DrizzleStores;

/** Create all SQLite tables via raw SQL (mirrors what ensurePgSchema does for PG). */
function createTables(raw: InstanceType<typeof Database>) {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      assign_to TEXT NOT NULL,
      "group" TEXT,
      mission_id TEXT,
      depends_on TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      retries INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 2,
      max_duration INTEGER,
      retry_policy TEXT,
      expectations TEXT NOT NULL DEFAULT '[]',
      metrics TEXT NOT NULL DEFAULT '[]',
      result TEXT,
      phase TEXT,
      fix_attempts INTEGER NOT NULL DEFAULT 0,
      resolution_attempts INTEGER NOT NULL DEFAULT 0,
      original_description TEXT,
      session_id TEXT,
      notifications TEXT,
      outcomes TEXT,
      expected_outcomes TEXT,
      deadline TEXT,
      priority TEXT,
      side_effects INTEGER,
      revision_count INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      data TEXT NOT NULL,
      prompt TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      schedule TEXT,
      end_date TEXT,
      quality_threshold TEXT,
      deadline TEXT,
      notifications TEXT,
      execution_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS processes (
      agent_name TEXT NOT NULL,
      pid INTEGER NOT NULL,
      task_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      alive INTEGER NOT NULL DEFAULT 1,
      activity TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      pid INTEGER NOT NULL DEFAULT 0,
      agent_name TEXT NOT NULL,
      adapter_type TEXT NOT NULL,
      session_id TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      activity TEXT NOT NULL DEFAULT '{}',
      result TEXT,
      outcomes TEXT,
      config TEXT,
      config_path TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      agent TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      ts TEXT NOT NULL,
      tool_calls TEXT
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      rule_name TEXT NOT NULL,
      channel TEXT NOT NULL,
      channel_type TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      severity TEXT NOT NULL,
      source_event TEXT NOT NULL,
      attachment_count INTEGER NOT NULL DEFAULT 0,
      attachment_types TEXT
    );
    CREATE TABLE IF NOT EXISTS log_sessions (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS log_entries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES log_sessions(id) ON DELETE CASCADE,
      ts TEXT NOT NULL,
      event TEXT NOT NULL,
      data TEXT
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      gate_id TEXT NOT NULL,
      gate_name TEXT NOT NULL,
      task_id TEXT,
      mission_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      payload TEXT,
      requested_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      note TEXT
    );
    CREATE TABLE IF NOT EXISTS memory (
      key TEXT PRIMARY KEY,
      content TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS peers (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      external_id TEXT NOT NULL,
      display_name TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      linked_to TEXT
    );
    CREATE TABLE IF NOT EXISTS peer_allowlist (
      peer_id TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS pairing_requests (
      id TEXT PRIMARY KEY,
      peer_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      external_id TEXT NOT NULL,
      display_name TEXT,
      code TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS peer_sessions (
      peer_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS teams (
      name TEXT PRIMARY KEY,
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agents (
      name TEXT PRIMARY KEY,
      team_name TEXT NOT NULL,
      config TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vault (
      agent TEXT NOT NULL,
      service TEXT NOT NULL,
      type TEXT NOT NULL,
      label TEXT,
      credentials TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent, service)
    );
    CREATE TABLE IF NOT EXISTS playbooks (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      mission TEXT NOT NULL,
      parameters TEXT,
      version TEXT,
      author TEXT,
      tags TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    PRAGMA foreign_keys = ON;
  `);
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  createTables(sqlite);
  db = drizzle(sqlite);
  stores = createSqliteStores(db);
});

afterEach(() => {
  sqlite.close();
});

// ═══════════════════════════════════════════════════════════════════════
// TaskStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleTaskStore", () => {
  it("addTask + getTask round-trip", async () => {
    const task = await stores.taskStore.addTask({
      title: "Fix bug",
      description: "Fix the login bug",
      assignTo: "claude",
      dependsOn: [],
      maxRetries: 3,
      expectations: [{ type: "llm_review" as const, criteria: "Login works" }],
      metrics: [],
    });

    expect(task.id).toBeDefined();
    expect(task.status).toBe("pending");
    expect(task.retries).toBe(0);
    expect(task.title).toBe("Fix bug");

    const fetched = await stores.taskStore.getTask(task.id);
    expect(fetched).toBeDefined();
    expect(fetched!.title).toBe("Fix bug");
    expect(fetched!.expectations).toEqual([{ type: "llm_review", criteria: "Login works" }]);
  });

  it("getAllTasks returns ordered by createdAt", async () => {
    await stores.taskStore.addTask({
      title: "A", description: "first", assignTo: "claude", dependsOn: [], maxRetries: 2, expectations: [], metrics: [],
    });
    await stores.taskStore.addTask({
      title: "B", description: "second", assignTo: "claude", dependsOn: [], maxRetries: 2, expectations: [], metrics: [],
    });

    const all = await stores.taskStore.getAllTasks();
    expect(all).toHaveLength(2);
    expect(all[0].title).toBe("A");
    expect(all[1].title).toBe("B");
  });

  it("updateTask merges fields", async () => {
    const task = await stores.taskStore.addTask({
      title: "Original", description: "desc", assignTo: "claude", dependsOn: [], maxRetries: 2, expectations: [], metrics: [],
    });

    const updated = await stores.taskStore.updateTask(task.id, { title: "Updated" });
    expect(updated.title).toBe("Updated");
    expect(updated.description).toBe("desc"); // unchanged

    const fetched = await stores.taskStore.getTask(task.id);
    expect(fetched!.title).toBe("Updated");
  });

  it("removeTask deletes by ID", async () => {
    const task = await stores.taskStore.addTask({
      title: "Delete me", description: "d", assignTo: "claude", dependsOn: [], maxRetries: 2, expectations: [], metrics: [],
    });

    const removed = await stores.taskStore.removeTask(task.id);
    expect(removed).toBe(true);

    const fetched = await stores.taskStore.getTask(task.id);
    expect(fetched).toBeUndefined();
  });

  it("removeTasks with filter", async () => {
    await stores.taskStore.addTask({
      title: "Keep", description: "d", assignTo: "claude", dependsOn: [], maxRetries: 2, expectations: [], metrics: [],
    });
    await stores.taskStore.addTask({
      title: "Remove", description: "d", assignTo: "claude", dependsOn: [], maxRetries: 2, expectations: [], metrics: [], group: "old",
    });

    const count = await stores.taskStore.removeTasks((t) => t.group === "old");
    expect(count).toBe(1);

    const all = await stores.taskStore.getAllTasks();
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe("Keep");
  });

  it("transition validates state machine", async () => {
    const task = await stores.taskStore.addTask({
      title: "T", description: "d", assignTo: "claude", dependsOn: [], maxRetries: 2, expectations: [], metrics: [],
    });

    // pending → assigned is valid
    const assigned = await stores.taskStore.transition(task.id, "assigned");
    expect(assigned.status).toBe("assigned");

    // assigned → pending is invalid
    await expect(stores.taskStore.transition(task.id, "pending")).rejects.toThrow();
  });

  it("transition increments retries on failed→pending", async () => {
    const task = await stores.taskStore.addTask({
      title: "T", description: "d", assignTo: "claude", dependsOn: [], maxRetries: 3, expectations: [], metrics: [],
    });

    await stores.taskStore.transition(task.id, "assigned");
    await stores.taskStore.transition(task.id, "in_progress");
    await stores.taskStore.transition(task.id, "failed");

    const retried = await stores.taskStore.transition(task.id, "pending");
    expect(retried.retries).toBe(1);
  });

  it("unsafeSetStatus bypasses state machine", async () => {
    const task = await stores.taskStore.addTask({
      title: "T", description: "d", assignTo: "claude", dependsOn: [], maxRetries: 2, expectations: [], metrics: [],
    });

    // pending → done is not a valid transition, but unsafeSetStatus allows it
    const result = await stores.taskStore.unsafeSetStatus(task.id, "done", "admin override");
    expect(result.status).toBe("done");
  });

  // ── Missions ────────────────────────────────────────────────────────

  it("saveMission + getMission round-trip", async () => {
    const mission = await stores.taskStore.saveMission!({
      name: "mission-1",
      data: '{"tasks":[]}',
      status: "draft",
    });

    expect(mission.id).toBeDefined();
    expect(mission.name).toBe("mission-1");

    const fetched = await stores.taskStore.getMission!(mission.id);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe("mission-1");
  });

  it("getMissionByName finds by name", async () => {
    await stores.taskStore.saveMission!({ name: "deploy-v2", data: "{}", status: "draft" });
    const found = await stores.taskStore.getMissionByName!("deploy-v2");
    expect(found).toBeDefined();
    expect(found!.name).toBe("deploy-v2");
  });

  it("updateMission merges fields", async () => {
    const m = await stores.taskStore.saveMission!({ name: "m-1", data: "{}", status: "draft" });
    const updated = await stores.taskStore.updateMission!(m.id, { status: "active" });
    expect(updated.status).toBe("active");
    expect(updated.name).toBe("m-1");
  });

  it("deleteMission removes", async () => {
    const m = await stores.taskStore.saveMission!({ name: "m-del", data: "{}", status: "draft" });
    const ok = await stores.taskStore.deleteMission!(m.id);
    expect(ok).toBe(true);
    const fetched = await stores.taskStore.getMission!(m.id);
    expect(fetched).toBeUndefined();
  });

  it("nextMissionName increments", async () => {
    expect(await stores.taskStore.nextMissionName!()).toBe("mission-1");
    await stores.taskStore.saveMission!({ name: "mission-1", data: "{}", status: "draft" });
    expect(await stores.taskStore.nextMissionName!()).toBe("mission-2");
    await stores.taskStore.saveMission!({ name: "mission-5", data: "{}", status: "draft" });
    expect(await stores.taskStore.nextMissionName!()).toBe("mission-6");
  });

  // ── State ────────────────────────────────────────────────────────────

  it("setState + getState round-trip", async () => {
    await stores.taskStore.setState({
      org: "test-project",
      teams: [{ name: "alpha", agents: [{ name: "claude" }] }],
      startedAt: "2025-01-01T00:00:00Z",
    });

    const state = await stores.taskStore.getState();
    expect(state.org).toBe("test-project");
    expect(state.teams).toHaveLength(1);
    expect(state.teams[0].name).toBe("alpha");
    expect(state.startedAt).toBe("2025-01-01T00:00:00Z");
  });

  it("setState with processes", async () => {
    await stores.taskStore.setState({
      org: "p",
      processes: [{
        agentName: "claude",
        pid: 1234,
        taskId: "t1",
        startedAt: "2025-01-01T00:00:00Z",
        alive: true,
        activity: { filesCreated: [], filesEdited: [], toolCalls: 5, totalTokens: 100, lastUpdate: "now" },
      }],
    });

    const state = await stores.taskStore.getState();
    expect(state.processes).toHaveLength(1);
    expect(state.processes[0].pid).toBe(1234);
    expect(state.processes[0].alive).toBe(true);
    expect(state.processes[0].activity.toolCalls).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// RunStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleRunStore", () => {
  const now = new Date().toISOString();

  const makeRun = (id: string, taskId: string, status = "running" as const) => ({
    id,
    taskId,
    pid: 0,
    agentName: "claude",
    sessionId: undefined,
    status,
    startedAt: now,
    updatedAt: now,
    activity: { filesCreated: [] as string[], filesEdited: [] as string[], toolCalls: 0, totalTokens: 0, lastUpdate: "" },
    result: undefined,
    outcomes: undefined,
    configPath: "/tmp/config.json",
  });

  it("upsertRun + getRun round-trip", async () => {
    const run = makeRun("r1", "t1");
    await stores.runStore.upsertRun(run as any);

    const fetched = await stores.runStore.getRun("r1");
    expect(fetched).toBeDefined();
    expect(fetched!.taskId).toBe("t1");
    expect(fetched!.status).toBe("running");
  });

  it("upsertRun updates on conflict", async () => {
    await stores.runStore.upsertRun(makeRun("r1", "t1") as any);
    await stores.runStore.upsertRun({ ...makeRun("r1", "t1"), status: "completed" as any } as any);

    const fetched = await stores.runStore.getRun("r1");
    expect(fetched!.status).toBe("completed");
  });

  it("getRunByTaskId returns latest", async () => {
    await stores.runStore.upsertRun({ ...makeRun("r1", "t1"), startedAt: "2025-01-01T00:00:00Z" } as any);
    await stores.runStore.upsertRun({ ...makeRun("r2", "t1"), startedAt: "2025-01-02T00:00:00Z" } as any);

    const latest = await stores.runStore.getRunByTaskId("t1");
    expect(latest).toBeDefined();
    expect(latest!.id).toBe("r2");
  });

  it("getActiveRuns returns only running", async () => {
    await stores.runStore.upsertRun(makeRun("r1", "t1") as any);
    await stores.runStore.upsertRun({ ...makeRun("r2", "t2"), status: "completed" as any } as any);

    const active = await stores.runStore.getActiveRuns();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe("r1");
  });

  it("getTerminalRuns returns completed/failed/killed", async () => {
    await stores.runStore.upsertRun(makeRun("r1", "t1") as any);
    await stores.runStore.upsertRun({ ...makeRun("r2", "t2"), status: "completed" as any } as any);
    await stores.runStore.upsertRun({ ...makeRun("r3", "t3"), status: "failed" as any } as any);

    const terminal = await stores.runStore.getTerminalRuns();
    expect(terminal).toHaveLength(2);
  });

  it("completeRun guards against overwriting terminal status", async () => {
    await stores.runStore.upsertRun({ ...makeRun("r1", "t1"), status: "completed" as any } as any);

    // Try to overwrite with failed — should be silently ignored
    await stores.runStore.completeRun("r1", "failed", { exitCode: 1, stdout: "", stderr: "nope", duration: 100 });
    const fetched = await stores.runStore.getRun("r1");
    expect(fetched!.status).toBe("completed"); // unchanged
  });

  it("updateActivity updates activity and sessionId", async () => {
    await stores.runStore.upsertRun(makeRun("r1", "t1") as any);
    await stores.runStore.updateActivity("r1", {
      filesCreated: ["a.ts"], filesEdited: [], toolCalls: 10, totalTokens: 500, lastUpdate: "now", sessionId: "s1",
    });

    const fetched = await stores.runStore.getRun("r1");
    expect(fetched!.activity.toolCalls).toBe(10);
    expect(fetched!.sessionId).toBe("s1");
  });

  it("deleteRun removes the record", async () => {
    await stores.runStore.upsertRun(makeRun("r1", "t1") as any);
    await stores.runStore.deleteRun("r1");
    expect(await stores.runStore.getRun("r1")).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SessionStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleSessionStore", () => {
  it("create + getSession", async () => {
    const id = await stores.sessionStore.create("My Session");
    const session = await stores.sessionStore.getSession(id);
    expect(session).toBeDefined();
    expect(session!.title).toBe("My Session");
    expect(session!.messageCount).toBe(0);
  });

  it("addMessage + getMessages", async () => {
    const sid = await stores.sessionStore.create();
    await stores.sessionStore.addMessage(sid, "user", "Hello");
    await stores.sessionStore.addMessage(sid, "assistant", "Hi there");

    const msgs = await stores.sessionStore.getMessages(sid);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].content).toBe("Hi there");
  });

  it("getRecentMessages returns last N", async () => {
    const sid = await stores.sessionStore.create();
    await stores.sessionStore.addMessage(sid, "user", "1");
    await new Promise((r) => setTimeout(r, 5));
    await stores.sessionStore.addMessage(sid, "assistant", "2");
    await new Promise((r) => setTimeout(r, 5));
    await stores.sessionStore.addMessage(sid, "user", "3");

    const recent = await stores.sessionStore.getRecentMessages(sid, 2);
    expect(recent).toHaveLength(2);
    expect(recent[0].content).toBe("2");
    expect(recent[1].content).toBe("3");
  });

  it("listSessions includes messageCount", async () => {
    const s1 = await stores.sessionStore.create("S1");
    await stores.sessionStore.addMessage(s1, "user", "msg1");
    await stores.sessionStore.addMessage(s1, "assistant", "msg2");
    await stores.sessionStore.create("S2");

    const list = await stores.sessionStore.listSessions();
    expect(list).toHaveLength(2);
    const withMessages = list.find((s) => s.title === "S1");
    expect(withMessages!.messageCount).toBe(2);
  });

  it("renameSession updates title", async () => {
    const id = await stores.sessionStore.create("Old");
    const ok = await stores.sessionStore.renameSession(id, "New");
    expect(ok).toBe(true);

    const session = await stores.sessionStore.getSession(id);
    expect(session!.title).toBe("New");
  });

  it("deleteSession cascade-deletes messages", async () => {
    const id = await stores.sessionStore.create("Del");
    await stores.sessionStore.addMessage(id, "user", "msg");
    const ok = await stores.sessionStore.deleteSession(id);
    expect(ok).toBe(true);

    expect(await stores.sessionStore.getSession(id)).toBeUndefined();
    expect(await stores.sessionStore.getMessages(id)).toEqual([]);
  });

  it("prune keeps the N most recent sessions", async () => {
    await stores.sessionStore.create("Old");
    await stores.sessionStore.create("New");

    const pruned = await stores.sessionStore.prune(1);
    expect(pruned).toBe(1);

    const list = await stores.sessionStore.listSessions();
    expect(list).toHaveLength(1);
  });

  it("getLatestSession returns most recently updated", async () => {
    await stores.sessionStore.create("First");
    await new Promise((r) => setTimeout(r, 5));
    const id2 = await stores.sessionStore.create("Second");

    const latest = await stores.sessionStore.getLatestSession();
    expect(latest).toBeDefined();
    expect(latest!.id).toBe(id2);
  });

  it("updateMessage changes content", async () => {
    const sid = await stores.sessionStore.create();
    const msg = await stores.sessionStore.addMessage(sid, "assistant", "draft");
    const ok = await stores.sessionStore.updateMessage(sid, msg.id, "final");
    expect(ok).toBe(true);

    const msgs = await stores.sessionStore.getMessages(sid);
    expect(msgs[0].content).toBe("final");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// NotificationStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleNotificationStore", () => {
  const makeNotification = (id: string, overrides: Partial<any> = {}) => ({
    id,
    timestamp: new Date().toISOString(),
    ruleId: "rule-1",
    ruleName: "Test Rule",
    channel: "slack-general",
    channelType: "slack",
    status: "sent",
    title: "Alert",
    body: "Something happened",
    severity: "info",
    sourceEvent: "task:done",
    attachmentCount: 0,
    ...overrides,
  });

  it("append + list", async () => {
    await stores.notificationStore.append(makeNotification("n1") as any);
    await stores.notificationStore.append(makeNotification("n2") as any);

    const all = await stores.notificationStore.list();
    expect(all).toHaveLength(2);
  });

  it("listByChannel filters", async () => {
    await stores.notificationStore.append(makeNotification("n1", { channel: "slack" }) as any);
    await stores.notificationStore.append(makeNotification("n2", { channel: "email" }) as any);

    const slack = await stores.notificationStore.listByChannel("slack");
    expect(slack).toHaveLength(1);
    expect(slack[0].channel).toBe("slack");
  });

  it("listByStatus filters", async () => {
    await stores.notificationStore.append(makeNotification("n1", { status: "sent" }) as any);
    await stores.notificationStore.append(makeNotification("n2", { status: "failed" }) as any);

    const failed = await stores.notificationStore.listByStatus("failed");
    expect(failed).toHaveLength(1);
  });

  it("count with and without status filter", async () => {
    await stores.notificationStore.append(makeNotification("n1", { status: "sent" }) as any);
    await stores.notificationStore.append(makeNotification("n2", { status: "failed" }) as any);

    expect(await stores.notificationStore.count()).toBe(2);
    expect(await stores.notificationStore.count("sent")).toBe(1);
  });

  it("prune keeps most recent", async () => {
    await stores.notificationStore.append(makeNotification("n1", { timestamp: "2025-01-01T00:00:00Z" }) as any);
    await stores.notificationStore.append(makeNotification("n2", { timestamp: "2025-01-02T00:00:00Z" }) as any);
    await stores.notificationStore.append(makeNotification("n3", { timestamp: "2025-01-03T00:00:00Z" }) as any);

    const pruned = await stores.notificationStore.prune(1);
    expect(pruned).toBe(2);
    expect(await stores.notificationStore.count()).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// LogStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleLogStore", () => {
  it("startSession + append + getSessionEntries", async () => {
    const sid = await stores.logStore.startSession();
    expect(sid).toBeDefined();

    await stores.logStore.append({ ts: "2025-01-01T00:00:00Z", event: "task:started", data: { taskId: "t1" } });
    await stores.logStore.append({ ts: "2025-01-01T00:01:00Z", event: "task:done", data: { taskId: "t1" } });

    const entries = await stores.logStore.getSessionEntries(sid);
    expect(entries).toHaveLength(2);
    expect(entries[0].event).toBe("task:started");
    expect(entries[1].event).toBe("task:done");
  });

  it("getSessionId returns current", async () => {
    expect(await stores.logStore.getSessionId()).toBeUndefined();
    const sid = await stores.logStore.startSession();
    expect(await stores.logStore.getSessionId()).toBe(sid);
  });

  it("listSessions returns sessions with entry count", async () => {
    await stores.logStore.startSession();
    await stores.logStore.append({ ts: "2025-01-01T00:00:00Z", event: "e1", data: null });
    await stores.logStore.append({ ts: "2025-01-01T00:01:00Z", event: "e2", data: null });

    const sessions = await stores.logStore.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].entries).toBe(2);
  });

  it("auto-creates session on append if none started", async () => {
    await stores.logStore.append({ ts: "2025-01-01T00:00:00Z", event: "auto", data: null });
    const sid = await stores.logStore.getSessionId();
    expect(sid).toBeDefined();

    const entries = await stores.logStore.getSessionEntries(sid!);
    expect(entries).toHaveLength(1);
  });

  it("prune removes old sessions", async () => {
    await stores.logStore.startSession();
    await stores.logStore.append({ ts: "2025-01-01T00:00:00Z", event: "old", data: null });
    await stores.logStore.startSession();
    await stores.logStore.append({ ts: "2025-01-02T00:00:00Z", event: "new", data: null });

    const pruned = await stores.logStore.prune(1);
    expect(pruned).toBe(1);
    expect(await stores.logStore.listSessions()).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ApprovalStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleApprovalStore", () => {
  const makeApproval = (id: string, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
    id,
    gateId: "gate-1",
    gateName: "Deploy Gate",
    taskId: "t1",
    status: "pending",
    payload: null,
    requestedAt: new Date().toISOString(),
    ...overrides,
  });

  it("upsert + get round-trip", async () => {
    const req = makeApproval("a1");
    await stores.approvalStore.upsert(req);

    const fetched = await stores.approvalStore.get("a1");
    expect(fetched).toBeDefined();
    expect(fetched!.gateName).toBe("Deploy Gate");
    expect(fetched!.status).toBe("pending");
  });

  it("upsert updates on conflict", async () => {
    await stores.approvalStore.upsert(makeApproval("a1"));
    await stores.approvalStore.upsert(makeApproval("a1", {
      status: "approved",
      resolvedBy: "admin",
      resolvedAt: new Date().toISOString(),
    }));

    const fetched = await stores.approvalStore.get("a1");
    expect(fetched!.status).toBe("approved");
    expect(fetched!.resolvedBy).toBe("admin");
  });

  it("list filters by status", async () => {
    await stores.approvalStore.upsert(makeApproval("a1", { status: "pending" }));
    await stores.approvalStore.upsert(makeApproval("a2", { status: "approved" }));

    const pending = await stores.approvalStore.list("pending");
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe("a1");
  });

  it("listByTask filters by taskId", async () => {
    await stores.approvalStore.upsert(makeApproval("a1", { taskId: "t1" }));
    await stores.approvalStore.upsert(makeApproval("a2", { taskId: "t2" }));

    const t1 = await stores.approvalStore.listByTask("t1");
    expect(t1).toHaveLength(1);
    expect(t1[0].id).toBe("a1");
  });

  it("delete removes", async () => {
    await stores.approvalStore.upsert(makeApproval("a1"));
    const ok = await stores.approvalStore.delete("a1");
    expect(ok).toBe(true);
    expect(await stores.approvalStore.get("a1")).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// MemoryStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleMemoryStore", () => {
  it("starts empty", async () => {
    expect(await stores.memoryStore.exists()).toBe(false);
    expect(await stores.memoryStore.get()).toBe("");
  });

  it("save + get round-trip", async () => {
    await stores.memoryStore.save("Hello world");
    expect(await stores.memoryStore.exists()).toBe(true);
    expect(await stores.memoryStore.get()).toBe("Hello world");
  });

  it("save overwrites", async () => {
    await stores.memoryStore.save("first");
    await stores.memoryStore.save("second");
    expect(await stores.memoryStore.get()).toBe("second");
  });

  it("append adds lines", async () => {
    await stores.memoryStore.append("line 1");
    await stores.memoryStore.append("line 2");
    expect(await stores.memoryStore.get()).toBe("line 1\nline 2");
  });

  it("update replaces text", async () => {
    await stores.memoryStore.save("foo bar baz");
    const result = await stores.memoryStore.update("bar", "qux");
    expect(result).toBe(true);
    expect(await stores.memoryStore.get()).toBe("foo qux baz");
  });

  it("update returns error string when text not found", async () => {
    await stores.memoryStore.save("hello");
    const result = await stores.memoryStore.update("missing", "new");
    expect(typeof result).toBe("string");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// CheckpointStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleCheckpointStore", () => {
  it("load returns empty state when nothing saved", async () => {
    const state = await stores.checkpointStore.load();
    expect(state).toEqual({ definitions: {}, active: {}, resumed: [] });
  });

  it("save + load round-trip", async () => {
    const state = {
      definitions: { "mission-1": [{ name: "review", afterTasks: ["Task A"], blocksTasks: ["Task B"] }] },
      active: { "mission-1:review": { checkpoint: { name: "review", afterTasks: ["Task A"], blocksTasks: ["Task B"] }, reachedAt: "2025-01-01T00:00:00Z" } },
      resumed: [],
    };
    await stores.checkpointStore.save(state);

    const loaded = await stores.checkpointStore.load();
    expect(loaded.definitions["mission-1"]).toHaveLength(1);
    expect(loaded.active["mission-1:review"]).toBeDefined();
  });

  it("removeGroup clears group-specific data", async () => {
    const cp1 = { name: "cp1", afterTasks: ["A"], blocksTasks: ["B"] };
    const cp2 = { name: "cp2", afterTasks: ["C"], blocksTasks: ["D"] };
    const state = {
      definitions: { "g1": [cp1], "g2": [cp2] },
      active: {
        "g1:cp1": { checkpoint: cp1, reachedAt: "now" },
        "g2:cp2": { checkpoint: cp2, reachedAt: "now" },
      },
      resumed: ["g1:cp1", "g2:cp2"],
    };
    await stores.checkpointStore.save(state);

    const next = await stores.checkpointStore.removeGroup(state, "g1");
    expect(next.definitions["g1"]).toBeUndefined();
    expect(next.definitions["g2"]).toBeDefined();
    expect(next.active["g1:cp1"]).toBeUndefined();
    expect(next.active["g2:cp2"]).toBeDefined();
    expect(next.resumed).toEqual(["g2:cp2"]);

    // Verify persisted
    const reloaded = await stores.checkpointStore.load();
    expect(reloaded.definitions["g1"]).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// DelayStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleDelayStore", () => {
  it("load returns empty state when nothing saved", async () => {
    const state = await stores.delayStore.load();
    expect(state).toEqual({ definitions: {}, active: {}, expired: [] });
  });

  it("save + load round-trip", async () => {
    const delay = { name: "cooldown", duration: "PT5M", afterTasks: ["Task A"], blocksTasks: ["Task B"] };
    const state = {
      definitions: { "mission-1": [delay] },
      active: { "mission-1:cooldown": { delay, startedAt: "2025-01-01T00:00:00Z", expiresAt: "2025-01-01T00:05:00Z" } },
      expired: [],
    };
    await stores.delayStore.save(state);

    const loaded = await stores.delayStore.load();
    expect(loaded.definitions["mission-1"]).toHaveLength(1);
    expect(loaded.active["mission-1:cooldown"]).toBeDefined();
  });

  it("removeGroup clears group-specific data", async () => {
    const d1 = { name: "d1", duration: "PT5M", afterTasks: ["A"], blocksTasks: ["B"] };
    const d2 = { name: "d2", duration: "PT10M", afterTasks: ["C"], blocksTasks: ["D"] };
    const state = {
      definitions: { "g1": [d1], "g2": [d2] },
      active: {
        "g1:d1": { delay: d1, startedAt: "now", expiresAt: "later" },
        "g2:d2": { delay: d2, startedAt: "now", expiresAt: "later" },
      },
      expired: ["g1:d1", "g2:d2"],
    };
    await stores.delayStore.save(state);

    const next = await stores.delayStore.removeGroup(state, "g1");
    expect(next.definitions["g1"]).toBeUndefined();
    expect(next.active["g1:d1"]).toBeUndefined();
    expect(next.expired).toEqual(["g2:d2"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ConfigStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleConfigStore", () => {
  it("exists returns false initially", async () => {
    expect(await stores.configStore.exists()).toBe(false);
  });

  it("save + get round-trip", async () => {
    const config = {
      settings: { storage: "postgres" as const, model: "claude-sonnet-4-20250514" },
    } as any;

    await stores.configStore.save(config);
    expect(await stores.configStore.exists()).toBe(true);

    const loaded = await stores.configStore.get();
    expect(loaded).toBeDefined();
    expect(loaded!.settings.storage).toBe("postgres");
  });

  it("save overwrites previous config", async () => {
    await stores.configStore.save({ settings: { workDir: "/old" } } as any);
    await stores.configStore.save({ settings: { workDir: "/new" } } as any);

    const loaded = await stores.configStore.get();
    expect(loaded!.settings.workDir).toBe("/new");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PeerStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzlePeerStore", () => {
  it("upsertPeer + getPeer round-trip", async () => {
    const peer = await stores.peerStore.upsertPeer({
      channel: "slack",
      externalId: "U123",
      displayName: "Alice",
      lastSeenAt: new Date().toISOString(),
    });

    expect(peer.id).toBeDefined();
    expect(peer.displayName).toBe("Alice");

    const fetched = await stores.peerStore.getPeer(peer.id);
    expect(fetched).toBeDefined();
    expect(fetched!.externalId).toBe("U123");
  });

  it("upsertPeer updates on conflict", async () => {
    const p1 = await stores.peerStore.upsertPeer({
      channel: "slack", externalId: "U1", displayName: "Old", lastSeenAt: "2025-01-01",
    });
    await stores.peerStore.upsertPeer({
      id: p1.id, channel: "slack", externalId: "U1", displayName: "New", lastSeenAt: "2025-01-02",
    });

    const fetched = await stores.peerStore.getPeer(p1.id);
    expect(fetched!.displayName).toBe("New");
    expect(fetched!.lastSeenAt).toBe("2025-01-02");
  });

  it("listPeers filters by channel", async () => {
    await stores.peerStore.upsertPeer({ channel: "slack", externalId: "U1", lastSeenAt: "now" });
    await stores.peerStore.upsertPeer({ channel: "discord", externalId: "D1", lastSeenAt: "now" });

    const slack = await stores.peerStore.listPeers("slack");
    expect(slack).toHaveLength(1);
    expect(slack[0].channel).toBe("slack");
  });

  // ── Allowlist ──────────────────────────────────────────────────────

  it("allowlist CRUD", async () => {
    const peer = await stores.peerStore.upsertPeer({ channel: "slack", externalId: "U1", lastSeenAt: "now" });

    expect(await stores.peerStore.isAllowed(peer.id)).toBe(false);

    await stores.peerStore.addToAllowlist(peer.id);
    expect(await stores.peerStore.isAllowed(peer.id)).toBe(true);
    expect(await stores.peerStore.getAllowlist()).toEqual([peer.id]);

    await stores.peerStore.removeFromAllowlist(peer.id);
    expect(await stores.peerStore.isAllowed(peer.id)).toBe(false);
  });

  it("isAllowed returns true for open dmPolicy", async () => {
    expect(await stores.peerStore.isAllowed("anyone", { dmPolicy: "open" })).toBe(true);
  });

  // ── Session mapping ───────────────────────────────────────────────

  it("session mapping CRUD", async () => {
    expect(await stores.peerStore.getSessionId("p1")).toBeUndefined();

    await stores.peerStore.setSessionId("p1", "s1");
    expect(await stores.peerStore.getSessionId("p1")).toBe("s1");

    await stores.peerStore.setSessionId("p1", "s2"); // overwrite
    expect(await stores.peerStore.getSessionId("p1")).toBe("s2");

    await stores.peerStore.clearSession("p1");
    expect(await stores.peerStore.getSessionId("p1")).toBeUndefined();
  });

  // ── Identity linking ─────────────────────────────────────────────

  it("linkPeers + resolveCanonicalId", async () => {
    const p1 = await stores.peerStore.upsertPeer({ channel: "slack", externalId: "U1", lastSeenAt: "now" });
    const p2 = await stores.peerStore.upsertPeer({ channel: "discord", externalId: "D1", lastSeenAt: "now" });

    await stores.peerStore.linkPeers(p2.id, p1.id);
    expect(await stores.peerStore.resolveCanonicalId(p2.id)).toBe(p1.id);
    expect(await stores.peerStore.resolveCanonicalId(p1.id)).toBe(p1.id); // no link = self
  });

  // ── Pairing ───────────────────────────────────────────────────────

  it("createPairingRequest + resolvePairing", async () => {
    const req = await stores.peerStore.createPairingRequest("slack", "U1", "Alice");
    expect(req.code).toHaveLength(6);
    expect(req.resolved).toBe(false);

    const resolved = await stores.peerStore.resolvePairing(req.code);
    expect(resolved).toBeDefined();
    expect(resolved!.resolved).toBe(true);

    // Peer should now be in allowlist
    expect(await stores.peerStore.isAllowed(req.peerId)).toBe(true);
  });

  it("resolvePairing returns undefined for invalid code", async () => {
    expect(await stores.peerStore.resolvePairing("INVALID")).toBeUndefined();
  });

  it("getPendingPairing returns non-expired request", async () => {
    const req = await stores.peerStore.createPairingRequest("slack", "U1");
    const pending = await stores.peerStore.getPendingPairing(req.peerId);
    expect(pending).toBeDefined();
    expect(pending!.code).toBe(req.code);
  });

  // ── Presence (in-memory) ──────────────────────────────────────────

  it("presence is in-memory", async () => {
    const peer = await stores.peerStore.upsertPeer({ channel: "slack", externalId: "U1", lastSeenAt: "now" });
    await stores.peerStore.updatePresence(peer.id, "chatting");

    const presence = await stores.peerStore.getPresence();
    expect(presence).toHaveLength(1);
    expect(presence[0].activity).toBe("chatting");
  });

  it("prunePresence removes old entries", async () => {
    const peer = await stores.peerStore.upsertPeer({ channel: "slack", externalId: "U1", lastSeenAt: "now" });
    await stores.peerStore.updatePresence(peer.id, "idle");

    // Prune with 1ms TTL — the entry was just created so wait a tick
    await new Promise((r) => setTimeout(r, 5));
    const pruned = await stores.peerStore.prunePresence(1);
    expect(pruned).toBe(1);
    expect(await stores.peerStore.getPresence()).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TeamStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleTeamStore", () => {
  it("createTeam + getTeam round-trip", async () => {
    const team = await stores.teamStore.createTeam({ name: "alpha", agents: [] });
    expect(team.name).toBe("alpha");
    expect(team.agents).toEqual([]);

    const fetched = await stores.teamStore.getTeam("alpha");
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe("alpha");
  });

  it("getTeams returns all teams", async () => {
    await stores.teamStore.createTeam({ name: "alpha", agents: [] });
    await stores.teamStore.createTeam({ name: "beta", agents: [] });

    const teams = await stores.teamStore.getTeams();
    expect(teams).toHaveLength(2);
    const names = teams.map(t => t.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
  });

  it("createTeam rejects duplicates", async () => {
    await stores.teamStore.createTeam({ name: "alpha", agents: [] });
    await expect(stores.teamStore.createTeam({ name: "alpha", agents: [] })).rejects.toThrow(/already exists/);
  });

  it("updateTeam merges description", async () => {
    await stores.teamStore.createTeam({ name: "alpha", agents: [], description: "old" });
    const updated = await stores.teamStore.updateTeam("alpha", { description: "new" });
    expect(updated.description).toBe("new");
  });

  it("renameTeam updates team and agent foreign keys", async () => {
    await stores.teamStore.createTeam({ name: "old-name", agents: [] });
    await stores.agentStore.createAgent({ name: "claude" } as any, "old-name");

    const renamed = await stores.teamStore.renameTeam("old-name", "new-name");
    expect(renamed.name).toBe("new-name");

    // Old name should not exist
    expect(await stores.teamStore.getTeam("old-name")).toBeUndefined();

    // Agent should be under the new team
    const agentTeam = await stores.agentStore.getAgentTeam("claude");
    expect(agentTeam).toBe("new-name");
  });

  it("deleteTeam cascade-deletes agents", async () => {
    await stores.teamStore.createTeam({ name: "alpha", agents: [] });
    await stores.agentStore.createAgent({ name: "claude" } as any, "alpha");

    const ok = await stores.teamStore.deleteTeam("alpha");
    expect(ok).toBe(true);

    expect(await stores.teamStore.getTeam("alpha")).toBeUndefined();
    expect(await stores.agentStore.getAgent("claude")).toBeUndefined();
  });

  it("deleteTeam returns false for non-existent", async () => {
    expect(await stores.teamStore.deleteTeam("ghost")).toBe(false);
  });

  it("seed skips existing teams", async () => {
    await stores.teamStore.createTeam({ name: "alpha", description: "original", agents: [] });
    await stores.teamStore.seed([
      { name: "alpha", description: "overwrite?", agents: [] },
      { name: "beta", agents: [] },
    ]);

    const alpha = await stores.teamStore.getTeam("alpha");
    expect(alpha!.description).toBe("original"); // not overwritten

    const beta = await stores.teamStore.getTeam("beta");
    expect(beta).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// AgentStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleAgentStore", () => {
  beforeEach(async () => {
    // Need a team to attach agents to
    await stores.teamStore.createTeam({ name: "alpha", agents: [] });
  });

  it("createAgent + getAgent round-trip", async () => {
    const agent = await stores.agentStore.createAgent({ name: "claude", role: "coder" } as any, "alpha");
    expect(agent.name).toBe("claude");
    expect(agent.role).toBe("coder");

    const fetched = await stores.agentStore.getAgent("claude");
    expect(fetched).toBeDefined();
    expect(fetched!.role).toBe("coder");
  });

  it("getAgents with and without team filter", async () => {
    await stores.teamStore.createTeam({ name: "beta", agents: [] });
    await stores.agentStore.createAgent({ name: "claude" } as any, "alpha");
    await stores.agentStore.createAgent({ name: "gpt" } as any, "beta");

    const all = await stores.agentStore.getAgents();
    expect(all).toHaveLength(2);

    const alphaOnly = await stores.agentStore.getAgents("alpha");
    expect(alphaOnly).toHaveLength(1);
    expect(alphaOnly[0].name).toBe("claude");
  });

  it("getAgentTeam returns team name", async () => {
    await stores.agentStore.createAgent({ name: "claude" } as any, "alpha");
    expect(await stores.agentStore.getAgentTeam("claude")).toBe("alpha");
    expect(await stores.agentStore.getAgentTeam("ghost")).toBeUndefined();
  });

  it("createAgent rejects duplicates", async () => {
    await stores.agentStore.createAgent({ name: "claude" } as any, "alpha");
    await expect(stores.agentStore.createAgent({ name: "claude" } as any, "alpha")).rejects.toThrow(/already exists/);
  });

  it("updateAgent merges fields", async () => {
    await stores.agentStore.createAgent({ name: "claude", role: "coder" } as any, "alpha");
    const updated = await stores.agentStore.updateAgent("claude", { role: "reviewer" });
    expect(updated.role).toBe("reviewer");
    expect(updated.name).toBe("claude");
  });

  it("moveAgent changes team", async () => {
    await stores.teamStore.createTeam({ name: "beta", agents: [] });
    await stores.agentStore.createAgent({ name: "claude" } as any, "alpha");

    await stores.agentStore.moveAgent("claude", "beta");
    expect(await stores.agentStore.getAgentTeam("claude")).toBe("beta");
  });

  it("deleteAgent removes the agent", async () => {
    await stores.agentStore.createAgent({ name: "claude" } as any, "alpha");
    expect(await stores.agentStore.deleteAgent("claude")).toBe(true);
    expect(await stores.agentStore.getAgent("claude")).toBeUndefined();
    expect(await stores.agentStore.deleteAgent("ghost")).toBe(false);
  });

  it("seed skips existing agents", async () => {
    await stores.agentStore.createAgent({ name: "claude", role: "coder" } as any, "alpha");
    await stores.agentStore.seed([
      { name: "claude", role: "overwrite?", teamName: "alpha" } as any,
      { name: "gpt", role: "planner", teamName: "alpha" } as any,
    ]);

    const claude = await stores.agentStore.getAgent("claude");
    expect(claude!.role).toBe("coder"); // not overwritten

    const gpt = await stores.agentStore.getAgent("gpt");
    expect(gpt).toBeDefined();
    expect(gpt!.role).toBe("planner");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// VaultStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleVaultStore", () => {
  it("set + get round-trip with encryption", async () => {
    const entry = { type: "api_key" as const, credentials: { key: "sk-secret-123" } };
    await stores.vaultStore.set("claude", "openai", entry);

    const fetched = await stores.vaultStore.get("claude", "openai");
    expect(fetched).toBeDefined();
    expect(fetched!.type).toBe("api_key");
    expect(fetched!.credentials.key).toBe("sk-secret-123");
  });

  it("getAllForAgent returns map by service", async () => {
    await stores.vaultStore.set("claude", "openai", { type: "api_key" as const, credentials: { key: "k1" } });
    await stores.vaultStore.set("claude", "smtp", { type: "smtp" as const, credentials: { host: "mail.test" } });

    const all = await stores.vaultStore.getAllForAgent("claude");
    expect(Object.keys(all).sort()).toEqual(["openai", "smtp"]);
    expect(all.openai.credentials.key).toBe("k1");
  });

  it("set upserts on conflict", async () => {
    await stores.vaultStore.set("claude", "openai", { type: "api_key" as const, credentials: { key: "old" } });
    await stores.vaultStore.set("claude", "openai", { type: "api_key" as const, credentials: { key: "new" } });

    const fetched = await stores.vaultStore.get("claude", "openai");
    expect(fetched!.credentials.key).toBe("new");
  });

  it("patch merges credentials", async () => {
    await stores.vaultStore.set("claude", "smtp", { type: "smtp" as const, credentials: { host: "mail.test", port: "587" } });
    const keys = await stores.vaultStore.patch("claude", "smtp", { credentials: { user: "alice" } });
    expect(keys.sort()).toEqual(["host", "port", "user"]);

    const fetched = await stores.vaultStore.get("claude", "smtp");
    expect(fetched!.credentials.user).toBe("alice");
    expect(fetched!.credentials.host).toBe("mail.test"); // preserved
  });

  it("remove deletes entry", async () => {
    await stores.vaultStore.set("claude", "openai", { type: "api_key" as const, credentials: { key: "k" } });
    const ok = await stores.vaultStore.remove("claude", "openai");
    expect(ok).toBe(true);
    expect(await stores.vaultStore.get("claude", "openai")).toBeUndefined();
  });

  it("list returns metadata without full credentials", async () => {
    await stores.vaultStore.set("claude", "openai", { type: "api_key" as const, label: "Main", credentials: { key: "sk", org: "o" } });
    const list = await stores.vaultStore.list("claude");
    expect(list).toHaveLength(1);
    expect(list[0].service).toBe("openai");
    expect(list[0].type).toBe("api_key");
    expect(list[0].label).toBe("Main");
    expect(list[0].keys.sort()).toEqual(["key", "org"]);
  });

  it("hasEntries returns correct boolean", async () => {
    expect(await stores.vaultStore.hasEntries("claude")).toBe(false);
    await stores.vaultStore.set("claude", "openai", { type: "api_key" as const, credentials: { key: "k" } });
    expect(await stores.vaultStore.hasEntries("claude")).toBe(true);
  });

  it("renameAgent moves entries to new name", async () => {
    await stores.vaultStore.set("old-agent", "openai", { type: "api_key" as const, credentials: { key: "k" } });
    await stores.vaultStore.renameAgent("old-agent", "new-agent");

    expect(await stores.vaultStore.get("old-agent", "openai")).toBeUndefined();
    const fetched = await stores.vaultStore.get("new-agent", "openai");
    expect(fetched).toBeDefined();
    expect(fetched!.credentials.key).toBe("k");
  });

  it("removeAgent deletes all entries for agent", async () => {
    await stores.vaultStore.set("claude", "openai", { type: "api_key" as const, credentials: { key: "k1" } });
    await stores.vaultStore.set("claude", "smtp", { type: "smtp" as const, credentials: { host: "h" } });
    await stores.vaultStore.removeAgent("claude");

    expect(await stores.vaultStore.hasEntries("claude")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PlaybookStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzlePlaybookStore", () => {
  const makePlaybook = (name: string, overrides: Partial<any> = {}) => ({
    name,
    description: `Playbook ${name}`,
    mission: { prompt: "Do the thing", tasks: [] },
    ...overrides,
  });

  it("save + get round-trip", async () => {
    const path = await stores.playbookStore.save(makePlaybook("deploy-v1"));
    expect(path).toContain("deploy-v1");

    const fetched = await stores.playbookStore.get("deploy-v1");
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe("deploy-v1");
    expect(fetched!.description).toBe("Playbook deploy-v1");
    expect(fetched!.mission).toEqual({ prompt: "Do the thing", tasks: [] });
  });

  it("save upserts on conflict", async () => {
    await stores.playbookStore.save(makePlaybook("pb", { description: "old" }));
    await stores.playbookStore.save(makePlaybook("pb", { description: "new" }));

    const fetched = await stores.playbookStore.get("pb");
    expect(fetched!.description).toBe("new");
  });

  it("list returns metadata for all playbooks", async () => {
    await stores.playbookStore.save(makePlaybook("alpha", {
      parameters: [{ name: "env", description: "Target environment", required: true }],
    }));
    await stores.playbookStore.save(makePlaybook("beta"));

    const list = await stores.playbookStore.list();
    expect(list).toHaveLength(2);

    const alpha = list.find(p => p.name === "alpha");
    expect(alpha).toBeDefined();
    expect(alpha!.parameters).toHaveLength(1);
    expect(alpha!.parameters[0].name).toBe("env");
    expect(alpha!.path).toContain("alpha");
  });

  it("get returns null for non-existent", async () => {
    expect(await stores.playbookStore.get("ghost")).toBeNull();
  });

  it("delete removes playbook", async () => {
    await stores.playbookStore.save(makePlaybook("del-me"));
    const ok = await stores.playbookStore.delete("del-me");
    expect(ok).toBe(true);
    expect(await stores.playbookStore.get("del-me")).toBeNull();
  });

  it("delete returns false for non-existent", async () => {
    expect(await stores.playbookStore.delete("ghost")).toBe(false);
  });

  it("preserves optional fields: version, author, tags", async () => {
    await stores.playbookStore.save(makePlaybook("rich", {
      version: "1.2.0",
      author: "alice",
      tags: ["infra", "deploy"],
    }));

    const fetched = await stores.playbookStore.get("rich");
    expect(fetched!.version).toBe("1.2.0");
    expect(fetched!.author).toBe("alice");
    expect(fetched!.tags).toEqual(["infra", "deploy"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Factory function
// ═══════════════════════════════════════════════════════════════════════

describe("createSqliteStores", () => {
  it("returns all 15 stores", () => {
    expect(stores.taskStore).toBeDefined();
    expect(stores.runStore).toBeDefined();
    expect(stores.sessionStore).toBeDefined();
    expect(stores.notificationStore).toBeDefined();
    expect(stores.logStore).toBeDefined();
    expect(stores.approvalStore).toBeDefined();
    expect(stores.memoryStore).toBeDefined();
    expect(stores.peerStore).toBeDefined();
    expect(stores.checkpointStore).toBeDefined();
    expect(stores.delayStore).toBeDefined();
    expect(stores.configStore).toBeDefined();
    expect(stores.teamStore).toBeDefined();
    expect(stores.agentStore).toBeDefined();
    expect(stores.vaultStore).toBeDefined();
    expect(stores.playbookStore).toBeDefined();
  });
});
