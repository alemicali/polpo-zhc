/**
 * Who work is for (Task.requestedBy), so a CLI engine on a personal sign-in runs only its owner's
 * work: tasks created by a member (API, Polpo's chat), the tasks of a mission a member starts, the
 * runs of a schedule (its owner: the member who created the mission or set the schedule).
 * Channel and agent work stays ownerless (refused by personal accounts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createSqliteStores, migrateSqlite } from "@polpo-ai/drizzle";
import { cliAccountUseProblem, type CliAccount } from "@polpo-ai/core";
import { Orchestrator, originMember } from "../core/orchestrator.js";
import { withEventOrigin } from "../core/events.js";
import { cliUseContext } from "../adapters/cli-engine.js";
import { InMemoryRunStore, createTestAgent } from "./fixtures.js";

const TEST_DIR = join(process.cwd(), ".test-polpo-cli-ownership");
const ada: CliAccount = { id: "ada-max", cli: "claude", computer: "host", configDir: "~/.polpo-cli/claude/ada-max", owner: "ada@example.com" };

describe("requestedBy propagation", () => {
  let sqlite: InstanceType<typeof Database>;
  let runStore: InMemoryRunStore;
  let o: Orchestrator;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    sqlite = new Database(join(TEST_DIR, "state.db"));
    const db = drizzle(sqlite);
    migrateSqlite(db);
    runStore = new InMemoryRunStore();
    o = new Orchestrator({
      workDir: TEST_DIR, store: createSqliteStores(db).taskStore, runStore,
      assessFn: async () => ({ passed: true, checks: [], metrics: [], timestamp: new Date().toISOString() }),
    });
    await o.initInteractive("test-project", { name: "team", agents: [createTestAgent({ name: "dev" })] });
  });

  afterEach(() => {
    sqlite.close();
    runStore.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  const plan = JSON.stringify({ tasks: [{ title: "A", description: "a", assignTo: "dev" }] });

  it("the member of the call: API and Polpo's chat yes; agents, channels and schedules no", async () => {
    expect(withEventOrigin({ source: "api", by: "Ada@Example.com" }, () => originMember())).toBe("ada@example.com");
    // Polpo's chat tools keep the chatting member
    expect(withEventOrigin({ source: "api", by: "ada@example.com" }, () => withEventOrigin({ source: "polpo" }, () => originMember()))).toBe("ada@example.com");
    expect(withEventOrigin({ source: "agent", by: "dev" }, () => originMember())).toBeUndefined();
    expect(withEventOrigin({ source: "channel", by: "telegram:42" }, () => originMember())).toBeUndefined();
    expect(withEventOrigin({ source: "schedule" }, () => originMember())).toBeUndefined();
    expect(originMember()).toBeUndefined();
  });

  it("tasks created in a member's call (dashboard, API, Polpo's chat) are theirs", async () => {
    const t = await withEventOrigin({ source: "api", by: "ada@example.com" }, () => withEventOrigin({ source: "polpo" }, () => o.addTask({ title: "T", description: "d", assignTo: "dev" })));
    expect(t.requestedBy).toBe("ada@example.com");
    const fromChannel = await withEventOrigin({ source: "channel", by: "telegram:42" }, () => o.addTask({ title: "C", description: "d", assignTo: "dev" }));
    expect(fromChannel.requestedBy).toBeUndefined();
    // an explicit member wins
    const explicit = await withEventOrigin({ source: "api", by: "ada@example.com" }, () => o.addTask({ title: "E", description: "d", assignTo: "dev", requestedBy: "bob@example.com" }));
    expect(explicit.requestedBy).toBe("bob@example.com");
  });

  it("a mission's tasks are for the member who started the run; the creator owns the mission", async () => {
    const m = await withEventOrigin({ source: "api", by: "ada@example.com" }, () => o.saveMission({ name: "m1", data: plan }));
    expect(m.owner).toBe("ada@example.com");
    expect((await o.getMission(m.id))?.owner).toBe("ada@example.com");
    const run = await withEventOrigin({ source: "api", by: "bob@example.com" }, () => o.executeMission(m.id));
    expect(run.tasks.map((t) => t.requestedBy)).toEqual(["bob@example.com"]);
    // started by nobody known (an API key, a hook): ownerless
    const m2 = await o.saveMission({ name: "m2", data: plan });
    expect(m2.owner).toBeUndefined();
    expect((await o.executeMission(m2.id)).tasks[0]!.requestedBy).toBeUndefined();
  });

  it("a schedule belongs to the member who sets it; its runs' tasks are theirs, and a personal account takes them", async () => {
    const m = await o.saveMission({ name: "nightly", data: plan });
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const updated = await withEventOrigin({ source: "api", by: "ada@example.com" }, () => o.updateMission(m.id, { schedule: future, status: "scheduled" }));
    expect(updated.owner).toBe("ada@example.com");
    const entry = o.getScheduler()?.registerMission(updated, "none");
    expect(entry?.owner).toBe("ada@example.com");
    // the scheduler's run (source "schedule", no person in the call)
    const run = await (o as unknown as { runScheduledMission(id: string): Promise<{ tasks: Array<{ requestedBy?: string }> }> }).runScheduledMission(m.id);
    expect(run.tasks[0]!.requestedBy).toBe("ada@example.com");
    expect(cliAccountUseProblem(ada, cliUseContext(run.tasks[0]!, undefined, true))).toBeNull();
    // another member's account still refuses it
    expect(cliAccountUseProblem({ ...ada, owner: "bob@example.com" }, cliUseContext(run.tasks[0]!, undefined, true))).toMatch(/started by ada@example.com/);
  });

  it("ownerless work (a channel, an ownerless schedule) is refused by a personal account", async () => {
    const t = await withEventOrigin({ source: "channel", by: "whatsapp:39333" }, () => o.addTask({ title: "W", description: "d", assignTo: "dev" }));
    expect(cliAccountUseProblem(ada, cliUseContext(t, undefined, true))).toMatch(/not started by a member/);
  });
});
