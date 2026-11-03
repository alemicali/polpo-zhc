import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../core/orchestrator.js";
import { createTestAgent } from "./fixtures.js";

describe("Checkpoint approvals after a restart", () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("opens the approval of a checkpoint paused before the restart, without failing during init", async () => {
    dir = mkdtempSync(join(tmpdir(), "polpo-cp-restart-"));
    mkdirSync(join(dir, ".polpo"), { recursive: true });
    const checkpoint = { name: "review", afterTasks: ["Write"], blocksTasks: ["Publish"], message: "Check the draft" };
    writeFileSync(join(dir, ".polpo", "checkpoints.json"), JSON.stringify({
      definitions: { report: [checkpoint] },
      active: { "report:review": { checkpoint, reachedAt: new Date().toISOString() } },
      resumed: [],
    }));

    const o = new Orchestrator({ workDir: dir });
    const warnings: string[] = [];
    o.on("log", (e: { level: string; message: string }) => { if (e.level === "warn") warnings.push(e.message); });
    await o.initInteractive("test", { name: "team", agents: [createTestAgent({ name: "dev" })] });

    let pending: Awaited<ReturnType<Orchestrator["getPendingApprovals"]>> = [];
    for (let i = 0; i < 50 && pending.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      pending = await o.getPendingApprovals();
    }
    expect(warnings.filter((w) => w.includes("[checkpoint]"))).toEqual([]);
    expect(pending.map((r) => r.gateId)).toEqual(["checkpoint:report:review"]);
  });

  it("names the tasks of the run that failed: a checkpoint is reached also after a failure", async () => {
    dir = mkdtempSync(join(tmpdir(), "polpo-cp-failed-"));
    mkdirSync(join(dir, ".polpo"), { recursive: true });
    const o = new Orchestrator({ workDir: dir });
    await o.initInteractive("test", { name: "team", agents: [createTestAgent({ name: "dev" })] });
    const review = await o.addTask({ title: "Review", description: "check the draft", assignTo: "dev", group: "report (3)" });
    for (const s of ["assigned", "in_progress", "failed"] as const) await o.getStore().transition(review.id, s);
    await o.addTask({ title: "Write", description: "write the draft", assignTo: "dev", group: "report (3)" });

    o.emit("checkpoint:reached", { group: "report (3)", checkpointName: "approve", afterTasks: ["Review"], blocksTasks: ["Publish"], reachedAt: new Date().toISOString() });
    let pending: Awaited<ReturnType<Orchestrator["getPendingApprovals"]>> = [];
    for (let i = 0; i < 50 && pending.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      pending = await o.getPendingApprovals();
    }
    expect(pending.map((r) => r.gateName)).toEqual(['Checkpoint "approve" · report (3) · failed in this run: Review']);
    expect(pending[0].payload).toMatchObject({ kind: "checkpoint", failedTasks: ["Review"] });
  });
});
