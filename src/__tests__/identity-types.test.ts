import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "../core/config.js";

const TMP = "/tmp/polpo-identity-test";
const POLPO_DIR = join(TMP, ".polpo");

function writeConfig(config: object): string {
  mkdirSync(POLPO_DIR, { recursive: true });
  writeFileSync(join(POLPO_DIR, "polpo.json"), JSON.stringify(config, null, 2));
  return TMP;
}

function baseConfig(agentOverrides: object = {}) {
  return {
    project: "identity-test",
    teams: [{
      name: "test-team",
      agents: [{ name: "agent-1", ...agentOverrides }],
    }],
    settings: { maxRetries: 3, workDir: ".", logLevel: "normal" },
  };
}

describe("Config parsing — identity, responsibilities, vault", () => {
  beforeEach(() => mkdirSync(TMP, { recursive: true }));
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it("parses responsibilities as string[]", async () => {
    const workDir = writeConfig(baseConfig({
      identity: { responsibilities: ["Code review", "Bug fixes"] },
    }));
    const config = await parseConfig(workDir);
    const agent = config.teams[0].agents[0];
    expect(agent.identity?.responsibilities).toEqual(["Code review", "Bug fixes"]);
  });

  it("parses responsibilities as AgentResponsibility[]", async () => {
    const workDir = writeConfig(baseConfig({
      identity: {
        responsibilities: [
          { area: "Frontend", description: "Build UI", priority: "high" },
        ],
      },
    }));
    const config = await parseConfig(workDir);
    const resp = config.teams[0].agents[0].identity?.responsibilities;
    expect(resp).toHaveLength(1);
    expect(resp![0]).toEqual({ area: "Frontend", description: "Build UI", priority: "high" });
  });

  it("parses mixed responsibilities (string + structured)", async () => {
    const workDir = writeConfig(baseConfig({
      identity: {
        responsibilities: [
          "General tasks",
          { area: "Testing", description: "Write tests", priority: "medium" },
        ],
      },
    }));
    const config = await parseConfig(workDir);
    const resp = config.teams[0].agents[0].identity?.responsibilities;
    expect(resp).toHaveLength(2);
    expect(resp![0]).toBe("General tasks");
    expect(typeof resp![1]).toBe("object");
  });

  it("parses personality", async () => {
    const workDir = writeConfig(baseConfig({
      identity: { personality: "Detail-oriented and empathetic" },
    }));
    const config = await parseConfig(workDir);
    expect(config.teams[0].agents[0].identity?.personality).toBe("Detail-oriented and empathetic");
  });

  it("parses tone + personality together", async () => {
    const workDir = writeConfig(baseConfig({
      identity: {
        tone: "Professional but warm",
        personality: "Creative problem-solver",
      },
    }));
    const config = await parseConfig(workDir);
    const agent = config.teams[0].agents[0];
    expect(agent.identity?.tone).toBe("Professional but warm");
    expect(agent.identity?.personality).toBe("Creative problem-solver");
  });

  it("parses full identity (all fields)", async () => {
    const workDir = writeConfig(baseConfig({
      identity: {
        displayName: "Alice Chen",
        title: "CTO",
        company: "Acme Corp",
        email: "alice@acme.com",
        bio: "Tech leader with 15 years experience",
        timezone: "US/Pacific",
        responsibilities: ["Architecture", "Hiring"],
        tone: "Direct and concise",
        personality: "Strategic thinker",
      },
    }));
    const config = await parseConfig(workDir);
    const id = config.teams[0].agents[0].identity!;
    expect(id.displayName).toBe("Alice Chen");
    expect(id.title).toBe("CTO");
    expect(id.company).toBe("Acme Corp");
    expect(id.email).toBe("alice@acme.com");
    expect(id.bio).toBe("Tech leader with 15 years experience");
    expect(id.timezone).toBe("US/Pacific");
    expect(id.responsibilities).toHaveLength(2);
    expect(id.tone).toBe("Direct and concise");
    expect(id.personality).toBe("Strategic thinker");
  });

  it("silently strips vault from config (vault now lives in encrypted store)", async () => {
    const workDir = writeConfig(baseConfig({
      vault: {
        email: {
          type: "smtp",
          credentials: { host: "smtp.example.com", port: "587", user: "u", pass: "p" },
        },
      },
    }));
    const config = await parseConfig(workDir);
    const agent = config.teams[0].agents[0];
    // vault field is silently stripped — no longer on AgentConfig
    expect((agent as any).vault).toBeUndefined();
  });

  it("parses reportsTo", async () => {
    const workDir = writeConfig({
      project: "identity-test",
      teams: [{
        name: "test-team",
        agents: [
          { name: "manager" },
          { name: "worker", reportsTo: "manager" },
        ],
      }],
      settings: { maxRetries: 3, workDir: ".", logLevel: "normal" },
    });
    const config = await parseConfig(workDir);
    expect(config.teams[0].agents[1].reportsTo).toBe("manager");
  });

  it("rejects reportsTo self-reference", async () => {
    const workDir = writeConfig(baseConfig({ reportsTo: "agent-1" }));
    await expect(parseConfig(workDir)).rejects.toThrow("cannot report to itself");
  });

  it("rejects reportsTo referencing nonexistent agent", async () => {
    const workDir = writeConfig(baseConfig({ reportsTo: "nonexistent" }));
    await expect(parseConfig(workDir)).rejects.toThrow("does not match any agent");
  });
});
