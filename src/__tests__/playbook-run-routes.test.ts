import { describe, expect, it, vi } from "vitest";
import { missionRoutes, playbookRoutes, withFlowControlDependencies } from "@polpo-ai/server";

const playbook = {
  name: "review-flow",
  description: "Draft, review, publish",
  parameters: [],
  mission: {
    name: "review-flow",
    tasks: [
      { title: "Draft", description: "Write the draft" },
      { title: "Publish", description: "Publish it" },
    ],
    checkpoints: [{ name: "review", afterTasks: ["Draft"], blocksTasks: ["Publish"] }],
  },
};

function runRoutes(executeMission: (id: string) => Promise<unknown>) {
  const saveMission = vi.fn(async (opts: { data: string }) => ({ id: "m1", name: "review-flow", ...opts }));
  const deleteMission = vi.fn(async () => true);
  const app = playbookRoutes(() => ({
    playbookStore: { get: async (name: string) => (name === playbook.name ? playbook : null) },
    saveMission,
    executeMission,
    deleteMission,
  }));
  const run = () => app.request(`/${playbook.name}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ params: {} }),
  });
  return { run, saveMission, deleteMission };
}

describe("withFlowControlDependencies", () => {
  it("makes the tasks a gate blocks depend on the gate's afterTasks", () => {
    const out = JSON.parse(withFlowControlDependencies(JSON.stringify(playbook.mission)));
    expect(out.tasks[1].dependsOn).toEqual(["Draft"]);
    expect(out.tasks[0].dependsOn).toBeUndefined();
  });

  it("returns the input unchanged when nothing is missing or it is not JSON", () => {
    const complete = JSON.stringify({ tasks: [{ title: "A" }, { title: "B", dependsOn: ["A"] }], checkpoints: [{ name: "c", afterTasks: ["A"], blocksTasks: ["B"] }] });
    expect(withFlowControlDependencies(complete)).toBe(complete);
    expect(withFlowControlDependencies("not json")).toBe("not json");
  });
});

describe("POST /playbooks/:name/run", () => {
  it("adds the dependencies a checkpoint needs before the mission is saved", async () => {
    const { run, saveMission } = runRoutes(async () => ({ tasks: [{}, {}], group: "review-flow" }));
    const res = await run();
    expect(res.status).toBe(201);
    const saved = JSON.parse(saveMission.mock.calls[0][0].data);
    expect(saved.tasks[1].dependsOn).toEqual(["Draft"]);
  });

  it("answers a readable JSON 400 and removes the mission when it cannot start", async () => {
    const { run, deleteMission } = runRoutes(async () => { throw new Error("Task \"Publish\" is blocked by checkpoint \"review\""); });
    const res = await run();
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; code: string; error: string };
    expect(body).toMatchObject({ ok: false, code: "INVALID_MISSION" });
    expect(body.error).toContain("The playbook cannot run");
    expect(deleteMission).toHaveBeenCalledWith("m1");
  });
});

describe("GET /missions/checkpoints and /missions/delays", () => {
  it("list the active checkpoints and delays instead of looking them up as mission ids", async () => {
    const app = missionRoutes((() => ({
      getMission: async () => undefined,
      getActiveCheckpoints: () => [{ group: "review-flow", checkpointName: "review" }],
      getActiveDelays: () => [],
    })) as unknown as Parameters<typeof missionRoutes>[0]);

    const checkpoints = await app.request("/checkpoints");
    expect(checkpoints.status).toBe(200);
    expect(await checkpoints.json()).toMatchObject({ ok: true, data: [{ checkpointName: "review" }] });

    const delays = await app.request("/delays");
    expect(delays.status).toBe(200);
    expect(await delays.json()).toEqual({ ok: true, data: [] });
  });
});
