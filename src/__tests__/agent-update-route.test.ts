import { describe, expect, it, vi } from "vitest";
import { agentRoutes } from "@polpo-ai/server";

function setup(existing: Record<string, unknown>) {
  const updateAgent = vi.fn(async () => undefined);
  const app = agentRoutes((() => ({ getAgents: async () => [existing], updateAgent })) as unknown as Parameters<typeof agentRoutes>[0]);
  const patch = (body: unknown) => app.request(`/${existing.name}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { patch, updateAgent };
}

describe("PATCH /agents/:name empty values", () => {
  it("removes text fields sent empty (model \"\" = the project default)", async () => {
    const { patch, updateAgent } = setup({ name: "writer", model: "ollama:qwen3", role: "Writer", systemPrompt: "Be brief." });
    const res = await patch({ model: "", role: "  ", systemPrompt: "", reasoning: "" });
    expect(res.status).toBe(200);
    const updates = updateAgent.mock.calls[0][1] as Record<string, unknown>;
    for (const key of ["model", "role", "systemPrompt", "reasoning"]) {
      expect(updates).toHaveProperty(key, undefined);
    }
  });

  it("keeps the other identity fields and removes the ones sent empty", async () => {
    const { patch, updateAgent } = setup({ name: "writer", identity: { displayName: "Wendy", title: "Writer" } });
    await patch({ identity: { title: "" } });
    expect((updateAgent.mock.calls[0][1] as { identity: Record<string, unknown> }).identity).toEqual({ displayName: "Wendy", title: undefined });
  });

  it("stores non-empty values as given", async () => {
    const { patch, updateAgent } = setup({ name: "writer" });
    await patch({ model: "ollama:qwen3", maxTurns: 30 });
    expect(updateAgent.mock.calls[0][1]).toEqual({ model: "ollama:qwen3", maxTurns: 30 });
  });
});
