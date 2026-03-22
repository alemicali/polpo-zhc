import { describe, it, expect } from "vitest";
import { validateAgents } from "../core/config.js";

/**
 * These tests validate agent identity/responsibility types via validateAgents().
 * Since agents are no longer read from polpo.json (they come from FileAgentStore),
 * we test the validation function directly instead of through parseConfig.
 */
describe("Agent validation — identity, responsibilities, vault", () => {
  it("validates responsibilities as string[]", () => {
    const agents = [{
      name: "agent-1",
      identity: { responsibilities: ["Code review", "Bug fixes"] },
    }];
    expect(() => validateAgents(agents)).not.toThrow();
  });

  it("validates responsibilities as AgentResponsibility[]", () => {
    const agents = [{
      name: "agent-1",
      identity: {
        responsibilities: [
          { area: "Backend", description: "API development", priority: "critical" },
          { area: "Testing", description: "Unit tests", priority: "medium" },
        ],
      },
    }];
    expect(() => validateAgents(agents)).not.toThrow();
  });

  it("validates mixed responsibilities (string + structured)", () => {
    const agents = [{
      name: "agent-1",
      identity: {
        responsibilities: [
          "Code review",
          { area: "Backend", description: "API development", priority: "high" },
        ],
      },
    }];
    expect(() => validateAgents(agents)).not.toThrow();
  });

  it("validates personality", () => {
    const agents = [{
      name: "agent-1",
      identity: { personality: "Patient, methodical, detail-oriented" },
    }];
    expect(() => validateAgents(agents)).not.toThrow();
  });

  it("validates tone + personality together", () => {
    const agents = [{
      name: "agent-1",
      identity: {
        tone: "Professional but friendly",
        personality: "Curious, analytical",
      },
    }];
    expect(() => validateAgents(agents)).not.toThrow();
  });

  it("validates full identity (all fields)", () => {
    const agents = [{
      name: "agent-1",
      identity: {
        displayName: "Dr. Alice",
        title: "Lead Engineer",
        company: "Acme Corp",
        email: "alice@acme.com",
        bio: "Senior engineer with 10 years experience",
        timezone: "America/New_York",
        tone: "Direct, technical",
        personality: "Analytical, precise",
        responsibilities: [
          { area: "Architecture", description: "System design", priority: "critical" },
          "Code review",
        ],
      },
    }];
    expect(() => validateAgents(agents)).not.toThrow();
  });

  it("silently strips vault from agent (vault now lives in encrypted store)", () => {
    const agents = [{
      name: "agent-1",
      vault: { smtp: { credentials: { host: "smtp.example.com" } } },
    }] as any[];
    validateAgents(agents);
    expect(agents[0].vault).toBeUndefined();
  });

  it("validates reportsTo", () => {
    const agents = [
      { name: "junior", reportsTo: "senior" },
      { name: "senior" },
    ];
    expect(() => validateAgents(agents)).not.toThrow();
  });

  it("rejects reportsTo self-reference", () => {
    const agents = [{ name: "agent-1", reportsTo: "agent-1" }];
    expect(() => validateAgents(agents)).toThrow("cannot report to itself");
  });

  it("rejects reportsTo referencing nonexistent agent", () => {
    const agents = [{ name: "agent-1", reportsTo: "ghost" }];
    expect(() => validateAgents(agents)).toThrow('does not match any agent');
  });
});
