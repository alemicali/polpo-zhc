import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FileTeamStore } from "../stores/file-team-store.js";
import { FileAgentStore } from "../stores/file-agent-store.js";
import type { Team, AgentConfig } from "../core/types.js";

const TEST_DIR = join(process.cwd(), ".test-team-agent-store");

// ═══════════════════════════════════════════════════════
//  FileTeamStore
// ═══════════════════════════════════════════════════════

describe("FileTeamStore", () => {
  let store: FileTeamStore;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    store = new FileTeamStore(TEST_DIR);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  // ── getTeams ────────────────────────────────────────

  it("getTeams() returns empty array when no file exists", async () => {
    expect(await store.getTeams()).toEqual([]);
  });

  it("getTeams() returns all created teams", async () => {
    await store.createTeam({ name: "alpha", agents: [] });
    await store.createTeam({ name: "beta", agents: [], description: "B team" });
    const teams = await store.getTeams();
    expect(teams).toHaveLength(2);
    expect(teams[0].name).toBe("alpha");
    expect(teams[1].name).toBe("beta");
    expect(teams[1].description).toBe("B team");
  });

  // ── getTeam ─────────────────────────────────────────

  it("getTeam() returns undefined for non-existent team", async () => {
    expect(await store.getTeam("nope")).toBeUndefined();
  });

  it("getTeam() returns the team by name", async () => {
    await store.createTeam({ name: "ops", agents: [], description: "Operations" });
    const team = await store.getTeam("ops");
    expect(team).toBeDefined();
    expect(team!.name).toBe("ops");
    expect(team!.description).toBe("Operations");
  });

  // ── createTeam ──────────────────────────────────────

  it("createTeam() persists to disk", async () => {
    await store.createTeam({ name: "dev", agents: [] });
    const raw = JSON.parse(readFileSync(join(TEST_DIR, "teams.json"), "utf-8"));
    expect(raw).toHaveLength(1);
    expect(raw[0].name).toBe("dev");
  });

  it("createTeam() creates directory if needed", async () => {
    expect(existsSync(TEST_DIR)).toBe(false);
    await store.createTeam({ name: "first", agents: [] });
    expect(existsSync(TEST_DIR)).toBe(true);
  });

  it("createTeam() throws on duplicate name", async () => {
    await store.createTeam({ name: "dup", agents: [] });
    await expect(store.createTeam({ name: "dup", agents: [] })).rejects.toThrow(
      'Team "dup" already exists',
    );
  });

  it("createTeam() returns the created team", async () => {
    const result = await store.createTeam({ name: "ret", agents: [], description: "x" });
    expect(result.name).toBe("ret");
    expect(result.description).toBe("x");
  });

  // ── updateTeam ──────────────────────────────────────

  it("updateTeam() changes description", async () => {
    await store.createTeam({ name: "u", agents: [] });
    const updated = await store.updateTeam("u", { description: "Updated" });
    expect(updated.description).toBe("Updated");

    // Verify persistence
    const fromDisk = await store.getTeam("u");
    expect(fromDisk!.description).toBe("Updated");
  });

  it("updateTeam() throws for non-existent team", async () => {
    await expect(store.updateTeam("ghost", { description: "x" })).rejects.toThrow(
      'Team "ghost" not found',
    );
  });

  // ── renameTeam ──────────────────────────────────────

  it("renameTeam() changes the team name", async () => {
    await store.createTeam({ name: "old", agents: [] });
    const renamed = await store.renameTeam("old", "new");
    expect(renamed.name).toBe("new");
    expect(await store.getTeam("old")).toBeUndefined();
    expect(await store.getTeam("new")).toBeDefined();
  });

  it("renameTeam() throws if old name not found", async () => {
    await expect(store.renameTeam("ghost", "new")).rejects.toThrow('Team "ghost" not found');
  });

  it("renameTeam() throws if new name already taken", async () => {
    await store.createTeam({ name: "a", agents: [] });
    await store.createTeam({ name: "b", agents: [] });
    await expect(store.renameTeam("a", "b")).rejects.toThrow('Team "b" already exists');
  });

  // ── deleteTeam ──────────────────────────────────────

  it("deleteTeam() removes the team and returns true", async () => {
    await store.createTeam({ name: "del", agents: [] });
    expect(await store.deleteTeam("del")).toBe(true);
    expect(await store.getTeam("del")).toBeUndefined();
    expect(await store.getTeams()).toHaveLength(0);
  });

  it("deleteTeam() returns false for non-existent team", async () => {
    expect(await store.deleteTeam("nope")).toBe(false);
  });

  // ── seed ────────────────────────────────────────────

  it("seed() adds missing teams without overwriting existing", async () => {
    await store.createTeam({ name: "existing", agents: [], description: "original" });

    await store.seed([
      { name: "existing", agents: [], description: "should not overwrite" },
      { name: "new-team", agents: [], description: "fresh" },
    ]);

    const teams = await store.getTeams();
    expect(teams).toHaveLength(2);
    expect(teams.find(t => t.name === "existing")!.description).toBe("original");
    expect(teams.find(t => t.name === "new-team")).toBeDefined();
  });

  it("seed() strips agents from seeded teams", async () => {
    await store.seed([
      { name: "t", agents: [{ name: "a", role: "dev" }] },
    ]);
    const team = await store.getTeam("t");
    expect(team!.agents).toEqual([]);
  });

  it("seed() is a no-op when all teams exist", async () => {
    await store.createTeam({ name: "x", agents: [] });
    await store.seed([{ name: "x", agents: [] }]);
    expect(await store.getTeams()).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════
//  FileAgentStore
// ═══════════════════════════════════════════════════════

describe("FileAgentStore", () => {
  let store: FileAgentStore;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    store = new FileAgentStore(TEST_DIR);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  // ── getAgents ───────────────────────────────────────

  it("getAgents() returns empty array when no file", async () => {
    expect(await store.getAgents()).toEqual([]);
  });

  it("getAgents() returns all agents without team filter", async () => {
    await store.createAgent({ name: "a1" }, "team-a");
    await store.createAgent({ name: "a2" }, "team-b");
    const all = await store.getAgents();
    expect(all).toHaveLength(2);
  });

  it("getAgents() filters by teamName", async () => {
    await store.createAgent({ name: "a1" }, "team-a");
    await store.createAgent({ name: "a2" }, "team-b");
    await store.createAgent({ name: "a3" }, "team-a");
    const teamA = await store.getAgents("team-a");
    expect(teamA).toHaveLength(2);
    expect(teamA.map(a => a.name).sort()).toEqual(["a1", "a3"]);
  });

  // ── getAgent ────────────────────────────────────────

  it("getAgent() returns undefined for non-existent agent", async () => {
    expect(await store.getAgent("ghost")).toBeUndefined();
  });

  it("getAgent() returns the agent config", async () => {
    await store.createAgent({ name: "dev", role: "developer", model: "gpt-4" }, "ops");
    const agent = await store.getAgent("dev");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("dev");
    expect(agent!.role).toBe("developer");
    expect(agent!.model).toBe("gpt-4");
  });

  // ── getAgentTeam ────────────────────────────────────

  it("getAgentTeam() returns the team name", async () => {
    await store.createAgent({ name: "x" }, "my-team");
    expect(await store.getAgentTeam("x")).toBe("my-team");
  });

  it("getAgentTeam() returns undefined for non-existent agent", async () => {
    expect(await store.getAgentTeam("ghost")).toBeUndefined();
  });

  // ── createAgent ─────────────────────────────────────

  it("createAgent() persists to disk", async () => {
    await store.createAgent({ name: "persisted" }, "t");
    const raw = JSON.parse(readFileSync(join(TEST_DIR, "agents.json"), "utf-8"));
    expect(raw).toHaveLength(1);
    expect(raw[0].agent.name).toBe("persisted");
    expect(raw[0].teamName).toBe("t");
  });

  it("createAgent() adds createdAt if missing", async () => {
    const agent = await store.createAgent({ name: "ts" }, "t");
    expect(agent.createdAt).toBeDefined();
    expect(new Date(agent.createdAt!).getTime()).not.toBeNaN();
  });

  it("createAgent() preserves existing createdAt", async () => {
    const ts = "2024-01-01T00:00:00.000Z";
    const agent = await store.createAgent({ name: "ts", createdAt: ts }, "t");
    expect(agent.createdAt).toBe(ts);
  });

  it("createAgent() throws on duplicate name", async () => {
    await store.createAgent({ name: "dup" }, "t");
    await expect(store.createAgent({ name: "dup" }, "t2")).rejects.toThrow(
      'Agent "dup" already exists',
    );
  });

  it("createAgent() creates directory if needed", async () => {
    expect(existsSync(TEST_DIR)).toBe(false);
    await store.createAgent({ name: "first" }, "t");
    expect(existsSync(TEST_DIR)).toBe(true);
  });

  // ── updateAgent ─────────────────────────────────────

  it("updateAgent() merges fields", async () => {
    await store.createAgent({ name: "u", role: "dev" }, "t");
    const updated = await store.updateAgent("u", { role: "senior dev", model: "claude" });
    expect(updated.role).toBe("senior dev");
    expect(updated.model).toBe("claude");

    // Verify persistence
    const fromDisk = await store.getAgent("u");
    expect(fromDisk!.role).toBe("senior dev");
    expect(fromDisk!.model).toBe("claude");
  });

  it("updateAgent() throws for non-existent agent", async () => {
    await expect(store.updateAgent("ghost", { role: "x" })).rejects.toThrow(
      'Agent "ghost" not found',
    );
  });

  // ── moveAgent ───────────────────────────────────────

  it("moveAgent() changes the agent's team", async () => {
    await store.createAgent({ name: "m" }, "old-team");
    await store.moveAgent("m", "new-team");
    expect(await store.getAgentTeam("m")).toBe("new-team");
  });

  it("moveAgent() throws for non-existent agent", async () => {
    await expect(store.moveAgent("ghost", "t")).rejects.toThrow(
      'Agent "ghost" not found',
    );
  });

  // ── deleteAgent ─────────────────────────────────────

  it("deleteAgent() removes the agent and returns true", async () => {
    await store.createAgent({ name: "del" }, "t");
    expect(await store.deleteAgent("del")).toBe(true);
    expect(await store.getAgent("del")).toBeUndefined();
    expect(await store.getAgents()).toHaveLength(0);
  });

  it("deleteAgent() returns false for non-existent agent", async () => {
    expect(await store.deleteAgent("nope")).toBe(false);
  });

  // ── cleanupVolatileAgents ───────────────────────────

  it("cleanupVolatileAgents() removes matching volatile agents", async () => {
    await store.createAgent({ name: "normal" }, "t");
    await store.createAgent({ name: "vol1", volatile: true, missionGroup: "g1" }, "t");
    await store.createAgent({ name: "vol2", volatile: true, missionGroup: "g1" }, "t");
    await store.createAgent({ name: "vol3", volatile: true, missionGroup: "g2" }, "t");

    const removed = await store.cleanupVolatileAgents("g1");
    expect(removed).toBe(2);
    expect(await store.getAgents()).toHaveLength(2);
    expect(await store.getAgent("normal")).toBeDefined();
    expect(await store.getAgent("vol3")).toBeDefined();
  });

  it("cleanupVolatileAgents() returns 0 when nothing matches", async () => {
    await store.createAgent({ name: "normal" }, "t");
    expect(await store.cleanupVolatileAgents("no-match")).toBe(0);
  });

  // ── seed ────────────────────────────────────────────

  it("seed() adds missing agents without overwriting", async () => {
    await store.createAgent({ name: "existing", role: "original" }, "t");

    await store.seed([
      { name: "existing", role: "should not overwrite", teamName: "t" },
      { name: "new-agent", role: "fresh", teamName: "t2" },
    ]);

    const all = await store.getAgents();
    expect(all).toHaveLength(2);
    expect(all.find(a => a.name === "existing")!.role).toBe("original");
    expect(all.find(a => a.name === "new-agent")!.role).toBe("fresh");
  });

  it("seed() preserves team assignment for new agents", async () => {
    await store.seed([{ name: "s", teamName: "seeded-team" }]);
    expect(await store.getAgentTeam("s")).toBe("seeded-team");
  });

  it("seed() is a no-op when all agents exist", async () => {
    await store.createAgent({ name: "x" }, "t");
    await store.seed([{ name: "x", teamName: "t" }]);
    expect(await store.getAgents()).toHaveLength(1);
  });

  // ── cross-store consistency ─────────────────────────

  it("multiple operations produce consistent state", async () => {
    // Create 3 agents
    await store.createAgent({ name: "a", role: "dev" }, "team1");
    await store.createAgent({ name: "b", role: "qa" }, "team1");
    await store.createAgent({ name: "c", role: "ops" }, "team2");

    // Update one
    await store.updateAgent("b", { role: "senior qa" });

    // Move one
    await store.moveAgent("a", "team2");

    // Delete one
    await store.deleteAgent("c");

    // Verify final state
    const all = await store.getAgents();
    expect(all).toHaveLength(2);

    const team1 = await store.getAgents("team1");
    expect(team1).toHaveLength(1);
    expect(team1[0].name).toBe("b");
    expect(team1[0].role).toBe("senior qa");

    const team2 = await store.getAgents("team2");
    expect(team2).toHaveLength(1);
    expect(team2[0].name).toBe("a");
  });
});
