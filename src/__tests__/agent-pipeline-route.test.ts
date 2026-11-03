import { describe, expect, it, vi } from "vitest";
import { agentRoutes } from "@polpo-ai/server";

const loops = { triage: { systemPrompt: "Classify the ticket" } };
const pipeline = { steps: [{ loop: "triage" }, { switch: { cases: [{ when: "context.kind == 'bug'", steps: [{ loop: "fix" }] }] } }] };

function setup(existing: Record<string, unknown>) {
  const updateAgent = vi.fn(async (_name: string, updates: Record<string, unknown>) => ({ ...existing, ...updates }));
  const app = agentRoutes((() => ({
    getAgents: async () => [existing],
    updateAgent,
  })) as unknown as Parameters<typeof agentRoutes>[0]);
  const patch = (body: unknown) => app.request("/writer", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { patch, updateAgent };
}

describe("PATCH /agents/:name pipeline", () => {
  it("refuses a pipeline that references loops the agent does not have", async () => {
    const { patch, updateAgent } = setup({ name: "writer", loops });
    const res = await patch({ pipeline });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "VALIDATION_ERROR", error: expect.stringContaining("fix") });
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it("accepts the pipeline when the same update adds the missing loop", async () => {
    const { patch, updateAgent } = setup({ name: "writer", loops });
    const res = await patch({ loops: { ...loops, fix: { systemPrompt: "Fix the bug" } }, pipeline });
    expect(res.status).toBe(200);
    expect(updateAgent).toHaveBeenCalledWith("writer", expect.objectContaining({ pipeline }));
  });

  it("removes the pipeline with null", async () => {
    const { patch, updateAgent } = setup({ name: "writer", loops, pipeline: { steps: [{ loop: "triage" }] } });
    const res = await patch({ pipeline: null });
    expect(res.status).toBe(200);
    expect(updateAgent.mock.calls[0][1]).toHaveProperty("pipeline", undefined);
  });
});
