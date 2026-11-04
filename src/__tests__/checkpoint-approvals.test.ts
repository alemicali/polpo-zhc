import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createSqliteStores, migrateSqlite } from "@polpo-ai/drizzle";
import { Orchestrator } from "../core/orchestrator.js";
import { InMemoryRunStore, createTestAgent } from "./fixtures.js";

const TEST_DIR = join(process.cwd(), ".test-polpo-checkpoint-approvals");

describe("checkpoint approvals", () => {
  let sqlite: InstanceType<typeof Database>;
  let runStore: InMemoryRunStore;
  let orchestrator: Orchestrator;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    sqlite = new Database(join(TEST_DIR, "state.db"));
    const db = drizzle(sqlite);
    migrateSqlite(db);
    runStore = new InMemoryRunStore();
    orchestrator = new Orchestrator({
      workDir: TEST_DIR,
      store: createSqliteStores(db).taskStore,
      runStore,
      assessFn: async () => ({ passed: true, checks: [], metrics: [], timestamp: new Date().toISOString() }),
    });
    await orchestrator.initInteractive("test-project", { name: "test-team", agents: [createTestAgent({ name: "dev" })] });
  });

  afterEach(() => {
    sqlite.close();
    runStore.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  async function pausedMission() {
    const mission = await orchestrator.saveMission({ name: "report", data: JSON.stringify({ tasks: [] }) });
    await orchestrator.updateMission(mission.id, { status: "paused" });
    return mission;
  }

  function reach(missionId: string) {
    orchestrator.emit("checkpoint:reached", {
      missionId, group: "report", checkpointName: "review", message: "Check the draft",
      afterTasks: ["Draft"], blocksTasks: ["Publish"], reachedAt: new Date().toISOString(),
    });
  }

  const pending = () => orchestrator.getPendingApprovals();

  it("opens one approval request when a checkpoint is reached", async () => {
    const mission = await pausedMission();
    reach(mission.id);
    await vi.waitFor(async () => expect(await pending()).toHaveLength(1));
    reach(mission.id);
    await new Promise((r) => setTimeout(r, 50));

    const [request] = await pending();
    expect(request).toMatchObject({
      gateId: "checkpoint:report:review",
      missionId: mission.id,
      payload: { kind: "checkpoint", group: "report", checkpointName: "review", message: "Check the draft" },
    });
    expect(await pending()).toHaveLength(1);
  });

  it("resumes the checkpoint when the request is approved", async () => {
    const mission = await pausedMission();
    const resume = vi.spyOn(orchestrator, "resumeCheckpoint").mockResolvedValue(true);
    reach(mission.id);
    await vi.waitFor(async () => expect(await pending()).toHaveLength(1));

    await orchestrator.approveRequest((await pending())[0].id, "reviewer");

    await vi.waitFor(() => expect(resume).toHaveBeenCalledWith("report", "review"));
  });

  it("aborts the mission when the request is rejected", async () => {
    const mission = await pausedMission();
    const abort = vi.spyOn(orchestrator, "abortGroup");
    reach(mission.id);
    await vi.waitFor(async () => expect(await pending()).toHaveLength(1));

    await orchestrator.rejectRequest((await pending())[0].id, "Not good enough", "reviewer");

    await vi.waitFor(() => expect(abort).toHaveBeenCalledWith("report", mission.id));
  });

  it("closes the request when the checkpoint is resumed elsewhere, without resuming it twice", async () => {
    const mission = await pausedMission();
    reach(mission.id);
    await vi.waitFor(async () => expect(await pending()).toHaveLength(1));
    const resume = vi.spyOn(orchestrator, "resumeCheckpoint");

    orchestrator.emit("checkpoint:resumed", { missionId: mission.id, group: "report", checkpointName: "review" });

    await vi.waitFor(async () => expect(await pending()).toHaveLength(0));
    const [closed] = await orchestrator.getAllApprovals("approved");
    expect(closed).toMatchObject({ gateId: "checkpoint:report:review", resolvedBy: "system" });
    expect(resume).not.toHaveBeenCalled();
  });

  it("closes the request when the mission is aborted", async () => {
    const mission = await pausedMission();
    reach(mission.id);
    await vi.waitFor(async () => expect(await pending()).toHaveLength(1));

    orchestrator.emit("mission:aborted", { missionId: mission.id, name: "report", group: "report", killedTasks: 1 });

    await vi.waitFor(async () => expect(await pending()).toHaveLength(0));
    expect((await orchestrator.getAllApprovals("rejected"))[0]).toMatchObject({ resolvedBy: "system" });
  });
});
