/**
 * Polpo's own tools refuse what the REST API and MCP refuse (live e2e, 2026-11-21): a schedule
 * whose cron cannot fire ("99 99 * * *"), and a task whose dependsOn names no task.
 */
import { describe, expect, it, vi } from "vitest";
import { executeOrchestratorTool } from "../llm/orchestrator-tools.js";

function fakePolpo() {
  const mission: any = { id: "m1", name: "Digest", status: "draft", data: "{}" };
  const tasks = new Map<string, any>([["t1", { id: "t1", title: "First", status: "done" }]]);
  const entry = { id: "sched-m1", missionId: "m1", expression: "0 9 * * *", recurring: true, enabled: true };
  const scheduler = { registerMission: vi.fn(() => entry), getScheduleByMissionId: vi.fn(() => entry), rescheduleMission: vi.fn(), setEnabled: vi.fn() };
  const polpo = {
    getScheduler: () => scheduler,
    getMission: async (id: string) => (id === "m1" ? mission : undefined),
    updateMission: vi.fn(async (_id: string, u: any) => Object.assign(mission, u)),
    getAgents: async () => [{ name: "coach" }],
    getStore: () => ({ getTask: async (id: string) => tasks.get(id) }),
    addTask: vi.fn(async (t: any) => ({ ...t, id: "t2", status: "pending" })),
  } as any;
  return { polpo, mission, scheduler };
}

describe("Polpo's tools validate like the API", () => {
  it("create_schedule / update_schedule refuse an invalid cron before the mission changes", async () => {
    const { polpo, mission, scheduler } = fakePolpo();
    expect(await executeOrchestratorTool("create_schedule", { missionId: "m1", expression: "99 99 * * *", recurring: true }, polpo))
      .toMatch(/^Error: Invalid cron expression "99 99 \* \* \*": minute "99": 99 is not between 0 and 59/);
    expect(polpo.updateMission).not.toHaveBeenCalled();
    expect(mission.status).toBe("draft");
    expect(await executeOrchestratorTool("update_schedule", { missionId: "m1", expression: "0 25 * * *" }, polpo)).toMatch(/^Error: Invalid cron expression .*hour "25"/);
    expect(scheduler.rescheduleMission).not.toHaveBeenCalled();
    expect(await executeOrchestratorTool("create_schedule", { missionId: "m1", expression: "0 3 1 1 *", recurring: true }, polpo)).toMatch(/Schedule created/);
  });

  it("create_task refuses a dependsOn that names no task", async () => {
    const { polpo } = fakePolpo();
    expect(await executeOrchestratorTool("create_task", { title: "Bad", description: "x", assignTo: "coach", dependsOn: ["no-such-task-e2e"] }, polpo))
      .toMatch(/^Error: dependsOn: there is no task "no-such-task-e2e"/);
    expect(polpo.addTask).not.toHaveBeenCalled();
    expect(await executeOrchestratorTool("create_task", { title: "Good", description: "x", assignTo: "coach", dependsOn: ["t1"] }, polpo)).toMatch(/Task created/);
  });
});
