/**
 * settings.orchestratorName: the orchestrator's display name ("Polpo" by default), read from
 * polpo.json, used for its prompt identity, agent-talk labels and MCP replies.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeOrchestratorName, orchestratorName } from "../core/orchestrator-name.js";
import { parseConfig } from "../core/config.js";
import { orchestratorIdentity } from "../llm/prompts.js";
import { AgentTalk } from "../server/agent-talk.js";
import { turnText } from "../server/mcp-server/conversation.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function configWith(settings: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "polpo-orch-name-"));
  dirs.push(dir);
  await mkdir(join(dir, ".polpo"), { recursive: true });
  await writeFile(join(dir, ".polpo", "polpo.json"), JSON.stringify({ project: "p", settings }));
  return parseConfig(dir);
}

describe("orchestratorName", () => {
  it("defaults to Polpo and validates 1–40 trimmed characters on one line", () => {
    expect(orchestratorName(undefined)).toBe("Polpo");
    expect(orchestratorName({})).toBe("Polpo");
    expect(orchestratorName({ orchestratorName: "  Ada " })).toBe("Ada");
    expect(normalizeOrchestratorName("x".repeat(40))).toHaveLength(40);
    expect(normalizeOrchestratorName("x".repeat(41))).toBeUndefined();
    expect(normalizeOrchestratorName("")).toBeUndefined();
    expect(normalizeOrchestratorName("a\nb")).toBeUndefined();
    expect(normalizeOrchestratorName(42)).toBeUndefined();
  });

  it("is read from polpo.json; an invalid one is left out with a warning, and the branding never sets it", async () => {
    expect((await configWith({ orchestratorName: " Ada " })).settings.orchestratorName).toBe("Ada");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const invalid = await configWith({ orchestratorName: "x".repeat(41), branding: { productName: "Lumea" } });
    expect(invalid.settings.orchestratorName).toBeUndefined();
    expect(orchestratorName(invalid.settings)).toBe("Polpo");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("orchestratorName"));
  });

  it("is the identity of the system prompt, Polpo staying the platform's name", () => {
    expect(orchestratorIdentity("Polpo")).toEqual(["You are Polpo — an AI orchestrator that manages teams of autonomous AI agents."]);
    const custom = orchestratorIdentity("Ada").join("\n");
    expect(custom).toMatch(/^You are Ada — an AI orchestrator/);
    expect(custom).toContain("You run on Polpo, the agent orchestration");
  });

  it("labels the orchestrator in agent talk and MCP replies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polpo-orch-talk-"));
    dirs.push(dir);
    const talk = new AgentTalk(dir, {
      turn: async () => ({ text: "", sessionId: "s" }),
      history: async () => [],
      agents: async () => [{ name: "giulia" }],
      orchestratorName: () => "Ada",
    });
    expect((talk as unknown as { label(a?: string): string }).label(undefined)).toBe("Ada");
    expect((talk as unknown as { label(a?: string): string }).label("giulia")).toBe("giulia");
    const out = { status: "needs_input" as const, reply: "", session_id: "s1", pending: { kind: "questions" as const, questions: [{ id: "q1", question: "Which?", options: [] }] } };
    expect(turnText(out as never, undefined, "Ada")).toContain("Ada asks:");
    expect(turnText(out as never)).toContain("Polpo asks:");
  });
});
