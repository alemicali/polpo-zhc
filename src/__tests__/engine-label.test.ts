/**
 * The engine named after every model in text outputs (MCP, Polpo's tools, the CLI):
 * "claude-sonnet-4-6 (Claude Code · CLI)", "kimi-k3.1 (OpenCode · Harness)", "gpt-6 (Polpo)".
 */
import { describe, expect, it } from "vitest";
import {
  agentEffectiveModel, agentEngineIdOf, engineKindOf, engineMarkLabel, engineTypeText, modelWithEngineText,
} from "@polpo-ai/core/engine-label";
import { describeTaskCost, computeTaskCost } from "@polpo-ai/core/task-cost";
import { describeTaskRun, type TaskRunContext } from "@polpo-ai/core/run-context";

describe("engine labels", () => {
  it("names every engine by product and type", () => {
    expect(["polpo", "claude-code", "codex", "opencode", "claude-cli", "codex-cli"].map(engineMarkLabel))
      .toEqual(["Polpo", "Claude Code Harness", "Codex Harness", "OpenCode Harness", "Claude Code CLI", "Codex CLI"]);
    expect(["polpo", "opencode", "codex-cli"].map(engineKindOf)).toEqual(["polpo", "harness", "cli"]);
    expect(engineTypeText("claude-cli")).toBe("Claude Code · CLI");
    expect(engineTypeText(undefined)).toBe("Polpo");
    expect(engineTypeText("something-else")).toBe("Polpo");
  });

  it("puts the engine after the model", () => {
    expect(modelWithEngineText("claude-sonnet-4-6", "claude-cli")).toBe("claude-sonnet-4-6 (Claude Code · CLI)");
    expect(modelWithEngineText("kimi-k3.1", "opencode")).toBe("kimi-k3.1 (OpenCode · Harness)");
    expect(modelWithEngineText("gpt-6", "polpo")).toBe("gpt-6 (Polpo)");
    expect(modelWithEngineText(undefined, "codex")).toBe("default model (Codex · Harness)");
  });

  it("resolves an agent's engine and the model it actually runs", () => {
    expect(agentEngineIdOf(undefined)).toBe("polpo");
    expect(agentEngineIdOf("polpo")).toBe("polpo");
    expect(agentEngineIdOf("codex")).toBe("codex");
    expect(agentEngineIdOf({ harness: "opencode" })).toBe("opencode");
    expect(agentEngineIdOf({ type: "cli", cli: "codex" })).toBe("codex-cli");
    expect(agentEngineIdOf({ type: "cli", cli: "claude" })).toBe("claude-cli");
    expect(agentEffectiveModel({ model: "openai:gpt-6" })).toBe("openai:gpt-6");
    expect(agentEffectiveModel({ model: "openai:gpt-6", engine: { harness: "opencode", model: "kimi-k3.1" } })).toBe("kimi-k3.1");
    // a harness without its own model runs the harness setting's, not the agent's Polpo model
    expect(agentEffectiveModel({ model: "openai:gpt-6", engine: { harness: "codex" } })).toBeUndefined();
  });

  it("run lines and per-run cost lines name the model's engine", () => {
    const run: TaskRunContext = {
      runId: "r1", startedAt: "2026-11-24T10:00:00.000Z", status: "completed", engine: "codex-cli", model: "gpt-6-codex", auth: { kind: "subscription" },
      computer: { id: "host", kind: "host" }, egress: { mode: "direct" }, cost: { modelUsd: 0.5 },
    };
    expect(describeTaskRun(run)).toMatch(/^r1 \[completed\] gpt-6-codex \(Codex · CLI\)/);
    expect(describeTaskRun({ ...run, model: undefined, engine: "polpo", auth: undefined })).toMatch(/^r1 \[completed\] Polpo · on this server/);
    const two = computeTaskCost({ runs: [run, { ...run, runId: "r2", engine: "opencode", model: "kimi-k3.1" }] })!;
    expect(describeTaskCost(two, { perRun: true })).toMatch(/1\. r1 \[completed\] gpt-6-codex \(Codex · CLI\)[\s\S]*2\. r2 \[completed\] kimi-k3\.1 \(OpenCode · Harness\)/);
  });
});
