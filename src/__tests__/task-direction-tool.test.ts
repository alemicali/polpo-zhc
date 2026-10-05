import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Orchestrator } from "../core/orchestrator.js";
import {
  ALL_ORCHESTRATOR_TOOLS,
  executeOrchestratorTool,
  needsApproval,
} from "../llm/orchestrator-tools.js";
import { buildChatSystemPrompt } from "../llm/prompts.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("send_task_direction orchestrator tool", () => {
  test("is exposed as an approved write tool with all supported modes", () => {
    const tool = ALL_ORCHESTRATOR_TOOLS.find((candidate) => candidate.name === "send_task_direction");

    expect(tool).toBeDefined();
    expect(needsApproval("send_task_direction")).toBe(true);
    expect(JSON.stringify(tool?.parameters)).toContain("follow_up");
    expect(JSON.stringify(tool?.parameters)).toContain("continue");
  });

  test("forwards a direction to the task runtime", async () => {
    const sendDirection = vi.fn(async () => ({
      action: "steer" as const,
      direction: { id: "direction-1" },
    }));
    const polpo = { sendDirection } as unknown as Orchestrator;

    const result = await executeOrchestratorTool("send_task_direction", {
      taskId: "task-1",
      message: "Keep the existing API and add regression tests",
      mode: "auto",
    }, polpo);

    expect(sendDirection).toHaveBeenCalledWith(
      "task-1",
      "Keep the existing API and add regression tests",
      { mode: "auto", confirmSideEffects: undefined },
    );
    expect(result).toBe("Direction sent to task task-1 using steer mode.");
  });

  test("passes explicit side-effect confirmation for a continuation", async () => {
    const sendDirection = vi.fn(async () => ({
      action: "continue" as const,
      direction: { id: "direction-2" },
    }));
    const polpo = { sendDirection } as unknown as Orchestrator;

    await executeOrchestratorTool("send_task_direction", {
      taskId: "task-2",
      message: "Resume from the checkpoint",
      mode: "continue",
      confirmSideEffects: true,
    }, polpo);

    expect(sendDirection).toHaveBeenCalledWith(
      "task-2",
      "Resume from the checkpoint",
      { mode: "continue", confirmSideEffects: true },
    );
  });

  test("teaches the chat orchestrator to preserve context by default", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "polpo-task-direction-prompt-"));
    tempDirs.push(cwd);
    const polpo = {
      getTeams: async () => [],
      getAgents: async () => [],
      getConfig: () => ({ project: "test", teams: [], settings: {} }),
      getMemory: async () => "",
      getPolpoDir: () => cwd,
      getAllMissions: async () => [],
      getPendingApprovals: async () => [],
      getActiveCheckpoints: () => [],
    } as unknown as Orchestrator;

    const prompt = await buildChatSystemPrompt(polpo, null, cwd);

    expect(prompt).toContain("send_task_direction");
    expect(prompt).toContain('Use mode="auto" by default');
    expect(prompt).toContain("Restart a failed task from scratch");
    expect(prompt).toContain("context-preserving human continuation");
  });
});
