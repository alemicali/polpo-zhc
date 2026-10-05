import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Orchestrator } from "../core/orchestrator.js";
import type { AgentConfig, Team } from "../core/types.js";
import { ALL_ORCHESTRATOR_TOOLS } from "../llm/orchestrator-tools.js";
import { buildChatSystemPrompt } from "../llm/prompts.js";
import { createAllTools } from "../tools/system-tools.js";
import { ALL_PHONE_TOOL_NAMES } from "../tools/phone-tools.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("agent phone tool assignment", () => {
  it("expands phone_* into every VAPI agent tool", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "polpo-phone-tools-"));
    tempDirs.push(cwd);

    const tools = await createAllTools({ cwd, allowedTools: ["phone_*"] });
    const names = new Set(tools.map((tool) => tool.name));

    expect(ALL_PHONE_TOOL_NAMES.every((name) => names.has(name))).toBe(true);
  });

  it.each(["add_agent", "update_agent"])("documents phone_* in %s", (toolName) => {
    const tool = ALL_ORCHESTRATOR_TOOLS.find((candidate) => candidate.name === toolName);

    expect(tool).toBeDefined();
    expect(`${tool?.description}\n${JSON.stringify(tool?.parameters)}`).toContain("phone_*");
  });

  it("tells the orchestrator that a phone-enabled agent can use VAPI tools", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "polpo-phone-prompt-"));
    tempDirs.push(cwd);

    const agent: AgentConfig = {
      name: "caller",
      role: "Outbound caller",
      allowedTools: ["phone_*"],
    };
    const teams: Team[] = [{ name: "Sales", agents: [agent] }];
    const orchestrator = {
      getTeams: async () => teams,
      getAgents: async () => [agent],
      getConfig: () => ({ project: "phone-test", teams, settings: {} }),
      getMemory: async () => "",
      getPolpoDir: () => cwd,
      getAllMissions: async () => [],
      getPendingApprovals: async () => [],
      getActiveCheckpoints: () => [],
    } as unknown as Orchestrator;

    const prompt = await buildChatSystemPrompt(orchestrator, null, cwd);
    const callerBlock = prompt.slice(prompt.indexOf("- caller:"), prompt.indexOf("Tasks: none yet"));

    expect(callerBlock).toContain("phone_call");
    expect(callerBlock).toContain("phone_list_calls");
  });
});
