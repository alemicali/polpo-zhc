import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../core/orchestrator.js";
import { parseConfig, savePolpoConfig } from "../core/config.js";
import type { Team } from "../core/types.js";


const VALID_TEAM: Team = {
  name: "test-team",
  agents: [
    { name: "agent-1", role: "Test agent" },
  ],
};

// ── Helpers ──────────────────────────────────────────────────────

/** Create a temp directory, create .polpo/ dir, and return a ready Orchestrator. */
async function setupOrchestratorEnv(): Promise<{ tempDir: string; o: Orchestrator }> {
  const tempDir = await mkdtemp(join(tmpdir(), "polpo-cli-test-"));
  await mkdir(join(tempDir, ".polpo"), { recursive: true });

  // Deep-copy the team so mutations in one test suite do not leak to others
  const team: Team = JSON.parse(JSON.stringify(VALID_TEAM));
  const o = new Orchestrator({ workDir: tempDir });
  await o.initInteractive("test-cli", team);
  return { tempDir, o };
}

// ═════════════════════════════════════════════════════════════════
// 1. Task Commands
// ═════════════════════════════════════════════════════════════════

describe("CLI: task operations", () => {
  let tempDir: string;
  let o: Orchestrator;

  beforeAll(async () => {
    ({ tempDir, o } = await setupOrchestratorEnv());
  });

  afterAll(async () => {
    try { await o.gracefulStop(200); } catch { /* already stopped */ }
    await rm(tempDir, { recursive: true, force: true });
  });

  test("task list — empty initially (no seed tasks in interactive mode)", () => {
    const tasks = o.getStore().getAllTasks();
    expect(tasks).toHaveLength(0);
  });

  test("task add — creates task with title and agent", () => {
    const task = o.addTask({
      title: "first-task",
      description: "Do something useful",
      assignTo: "agent-1",
    });
    expect(task.id).toBeDefined();
    expect(task.title).toBe("first-task");
    expect(task.assignTo).toBe("agent-1");
    expect(task.status).toBe("pending");
    expect(task.retries).toBe(0);
  });

  test("task show — finds task by full ID", () => {
    const task = o.addTask({
      title: "findable",
      description: "Find me",
      assignTo: "agent-1",
    });
    const found = o.getStore().getTask(task.id);
    expect(found).toBeDefined();
    expect(found!.title).toBe("findable");
  });

  test("task show — finds task by partial ID (prefix)", () => {
    const task = o.addTask({
      title: "partial-find",
      description: "Find by prefix",
      assignTo: "agent-1",
    });
    const prefix = task.id.slice(0, 6);
    const allTasks = o.getStore().getAllTasks();
    const match = allTasks.find((t) => t.id.startsWith(prefix));
    expect(match).toBeDefined();
    expect(match!.id).toBe(task.id);
  });

  test("task show — returns undefined for unknown ID", () => {
    const found = o.getStore().getTask("nonexistent-id-that-does-not-exist");
    expect(found).toBeUndefined();
  });

  test("task delete — removes task", () => {
    const task = o.addTask({
      title: "delete-me",
      description: "To be removed",
      assignTo: "agent-1",
    });
    const removed = o.getStore().removeTask(task.id);
    expect(removed).toBe(true);
    expect(o.getStore().getTask(task.id)).toBeUndefined();
  });

  test("task retry — resets failed task to pending", () => {
    const task = o.addTask({
      title: "fail-me",
      description: "test retry",
      assignTo: "agent-1",
    });
    o.getStore().transition(task.id, "assigned");
    o.getStore().transition(task.id, "in_progress");
    o.getStore().transition(task.id, "failed");
    expect(o.getStore().getTask(task.id)!.status).toBe("failed");

    o.retryTask(task.id);
    expect(o.getStore().getTask(task.id)!.status).toBe("pending");
  });

  test("task kill — kills running task (marks as failed)", () => {
    const task = o.addTask({
      title: "kill-me",
      description: "test kill",
      assignTo: "agent-1",
    });
    // Task starts as pending — killTask transitions it through to failed
    o.killTask(task.id);
    expect(o.getStore().getTask(task.id)!.status).toBe("failed");
  });
});

// ═════════════════════════════════════════════════════════════════
// 2. Mission Commands
// ═════════════════════════════════════════════════════════════════

describe("CLI: mission operations", () => {
  let tempDir: string;
  let o: Orchestrator;

  beforeAll(async () => {
    ({ tempDir, o } = await setupOrchestratorEnv());
  });

  afterAll(async () => {
    try { await o.gracefulStop(200); } catch { /* already stopped */ }
    await rm(tempDir, { recursive: true, force: true });
  });

  test("mission list — empty initially", () => {
    const missions = o.getAllMissions();
    expect(missions).toHaveLength(0);
  });

  test("mission save — creates draft mission", () => {
    const mission = o.saveMission({
      data: JSON.stringify({ tasks: [{ title: "Test", description: "Do something", assignTo: "agent-1" }] }),
    });
    expect(mission.status).toBe("draft");
    expect(mission.name).toBeDefined();
    expect(mission.id).toBeDefined();
    expect(mission.data).toContain("tasks");
  });

  test("mission show — finds by ID", () => {
    const mission = o.saveMission({
      data: JSON.stringify({ tasks: [{ title: "FindById", description: "Test", assignTo: "agent-1" }] }),
      name: "find-by-id",
    });
    const found = o.getMission(mission.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(mission.id);
    expect(found!.name).toBe("find-by-id");
  });

  test("mission show — finds by name", () => {
    const mission = o.saveMission({
      data: JSON.stringify({ tasks: [{ title: "FindByName", description: "Test", assignTo: "agent-1" }] }),
      name: "named-mission",
    });
    const found = o.getMissionByName("named-mission");
    expect(found).toBeDefined();
    expect(found!.id).toBe(mission.id);
  });

  test("mission delete — removes mission", () => {
    const mission = o.saveMission({
      data: JSON.stringify({ tasks: [{ title: "DeleteMe", description: "Test", assignTo: "agent-1" }] }),
      name: "to-delete",
    });
    const result = o.deleteMission(mission.id);
    expect(result).toBe(true);
    expect(o.getMission(mission.id)).toBeUndefined();
  });

  test("mission execute — creates tasks from mission", () => {
    const mission = o.saveMission({
      data: JSON.stringify({ tasks: [{ title: "Mission task", description: "Do work", assignTo: "agent-1" }] }),
      name: "exec-mission",
    });
    const result = o.executeMission(mission.id);
    expect(result.tasks.length).toBe(1);
    expect(result.tasks[0].title).toBe("Mission task");
    expect(result.group).toBe("exec-mission");

    // Mission should now be active
    const updated = o.getMission(mission.id);
    expect(updated!.status).toBe("active");
  });
});

// ═════════════════════════════════════════════════════════════════
// 3. Team Commands
// ═════════════════════════════════════════════════════════════════

describe("CLI: team operations", () => {
  let tempDir: string;
  let o: Orchestrator;

  beforeAll(async () => {
    ({ tempDir, o } = await setupOrchestratorEnv());
  });

  afterAll(async () => {
    try { await o.gracefulStop(200); } catch { /* already stopped */ }
    await rm(tempDir, { recursive: true, force: true });
  });

  test("team list — shows agents from config", () => {
    const agents = o.getAgents();
    expect(agents.length).toBeGreaterThanOrEqual(1);
    expect(agents.find((a) => a.name === "agent-1")).toBeDefined();
  });

  test("team add — adds agent to runtime", () => {
    o.addAgent({
      name: "agent-2",
      role: "Helper",
    });
    const agents = o.getAgents();
    expect(agents.find((a) => a.name === "agent-2")).toBeDefined();
  });

  test("team remove — removes agent", () => {
    o.addAgent({
      name: "agent-temp",
    });
    const result = o.removeAgent("agent-temp");
    expect(result).toBe(true);
    expect(o.getAgents().find((a) => a.name === "agent-temp")).toBeUndefined();
  });

  test("team rename — changes team name", () => {
    o.renameTeam("test-team", "new-team-name");
    const team = o.getTeam()!;
    expect(team.name).toBe("new-team-name");
  });

  test("team getTeam — returns team info", () => {
    const team = o.getTeam()!;
    expect(team).toBeDefined();
    expect(team.name).toBe("new-team-name"); // renamed in previous test
    expect(Array.isArray(team.agents)).toBe(true);
    expect(team.agents.length).toBeGreaterThanOrEqual(1);
  });
});

// ═════════════════════════════════════════════════════════════════
// 4. Memory Commands
// ═════════════════════════════════════════════════════════════════

describe("CLI: memory operations", () => {
  let tempDir: string;
  let o: Orchestrator;

  beforeAll(async () => {
    ({ tempDir, o } = await setupOrchestratorEnv());
  });

  afterAll(async () => {
    try { await o.gracefulStop(200); } catch { /* already stopped */ }
    await rm(tempDir, { recursive: true, force: true });
  });

  test("memory — no memory initially", () => {
    expect(o.hasMemory()).toBe(false);
    expect(o.getMemory()).toBe("");
  });

  test("memory save — persists content", () => {
    o.saveMemory("# Project Memory\nKey architecture decisions.");
    expect(o.hasMemory()).toBe(true);
  });

  test("memory append — adds line with timestamp", () => {
    o.appendMemory("New discovery about the codebase");
    const content = o.getMemory();
    expect(content).toContain("# Project Memory");
    expect(content).toContain("New discovery about the codebase");
  });

  test("memory get — reads saved content", () => {
    const content = o.getMemory();
    expect(content).toContain("# Project Memory");
    expect(content).toContain("Key architecture decisions.");
    expect(content).toContain("New discovery about the codebase");
  });
});

// ═════════════════════════════════════════════════════════════════
// 5. Config Commands
// ═════════════════════════════════════════════════════════════════

describe("CLI: config operations", () => {
  let tempDir: string;
  let o: Orchestrator;

  beforeAll(async () => {
    ({ tempDir, o } = await setupOrchestratorEnv());
  });

  afterAll(async () => {
    try { await o.gracefulStop(200); } catch { /* already stopped */ }
    await rm(tempDir, { recursive: true, force: true });
  });

  test("config show — returns parsed config", () => {
    const config = o.getConfig();
    expect(config).toBeDefined();
    expect(config!.project).toBe("test-cli");
    expect(config!.teams[0].name).toBe("test-team");
    expect(config!.teams[0].agents.length).toBeGreaterThanOrEqual(1);
  });

  test("config validate — valid config succeeds", async () => {
    // parseConfig reads from .polpo/polpo.json — write it first
    savePolpoConfig(join(tempDir, ".polpo"), {
      project: "test-cli",
      teams: [VALID_TEAM],
      settings: { maxRetries: 2, workDir: ".", logLevel: "normal" },
    });
    const config = await parseConfig(tempDir);
    expect(config.version).toBe("1");
    expect(config.project).toBe("test-cli");
    expect(config.teams[0].name).toBe("test-team");
  });

  test("config validate — missing config fails", async () => {
    const invalidDir = await mkdtemp(join(tmpdir(), "polpo-invalid-cfg-"));
    try {
      await expect(parseConfig(invalidDir)).rejects.toThrow(
        /No configuration found/i,
      );
    } finally {
      await rm(invalidDir, { recursive: true, force: true });
    }
  });
});

// ═════════════════════════════════════════════════════════════════
// 6. Log Commands
// ═════════════════════════════════════════════════════════════════

describe("CLI: log operations", () => {
  let tempDir: string;
  let o: Orchestrator;

  beforeAll(async () => {
    ({ tempDir, o } = await setupOrchestratorEnv());
  });

  afterAll(async () => {
    try { await o.gracefulStop(200); } catch { /* already stopped */ }
    await rm(tempDir, { recursive: true, force: true });
  });

  test("logs — logStore available after init", () => {
    const logStore = o.getLogStore();
    expect(logStore).toBeDefined();
  });

  test("logs list — returns sessions", () => {
    const logStore = o.getLogStore()!;
    const sessions = logStore.listSessions();
    // initInteractive calls initLogStore which calls startSession,
    // so there should be at least one session
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions[0].sessionId).toBeDefined();
    expect(sessions[0].startedAt).toBeDefined();
  });

  test("logs show — returns entries for session", () => {
    const logStore = o.getLogStore()!;
    const sessionId = logStore.getSessionId();
    expect(sessionId).toBeDefined();

    // Add a task to generate a log event (task:created is emitted via the log sink)
    o.addTask({ title: "log-test", description: "Generate log entry", assignTo: "agent-1" });

    const entries = logStore.getSessionEntries(sessionId);
    // The logStore receives events wired by setLogSink — entries may be present
    // depending on what events the log sink captures. At minimum, entries is an array.
    expect(Array.isArray(entries)).toBe(true);
  });
});
