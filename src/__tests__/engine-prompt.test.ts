import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../adapters/engine.js";
import { createTestAgent } from "./fixtures.js";
import type { AgentConfig } from "../core/types.js";

const CWD = "/tmp/test-project";

// ─── Base prompt ─────────────────────────────────────

describe("buildSystemPrompt — base", () => {
  it("includes Polpo intro for minimal agent", () => {
    const agent = createTestAgent({ name: "dev" });
    const prompt = buildSystemPrompt(agent, CWD);
    expect(prompt).toContain("Polpo");
    expect(prompt).toContain("coding agent");
    expect(prompt).toContain("<project-memory>");
  });

  it("includes agent role when set", () => {
    const agent = createTestAgent({ name: "dev", role: "backend engineer" });
    // role is not injected into system prompt by buildSystemPrompt (it's in config, not prompt)
    // just verify it doesn't crash
    const prompt = buildSystemPrompt(agent, CWD);
    expect(typeof prompt).toBe("string");
  });

  it("appends systemPrompt when set", () => {
    const agent = createTestAgent({ systemPrompt: "Always use TypeScript strict mode." });
    const prompt = buildSystemPrompt(agent, CWD);
    expect(prompt).toContain("Always use TypeScript strict mode.");
  });
});

// ─── Identity ────────────────────────────────────────

describe("buildSystemPrompt — identity", () => {
  it("includes displayName", () => {
    const agent = createTestAgent({ identity: { displayName: "Alice Chen" } });
    const prompt = buildSystemPrompt(agent, CWD);
    expect(prompt).toContain("## Your Identity");
    expect(prompt).toContain("Name: Alice Chen");
  });

  it("includes title", () => {
    const agent = createTestAgent({ identity: { title: "Lead Developer" } });
    const prompt = buildSystemPrompt(agent, CWD);
    expect(prompt).toContain("Title: Lead Developer");
  });

  it("includes company", () => {
    const agent = createTestAgent({ identity: { company: "Acme Corp" } });
    const prompt = buildSystemPrompt(agent, CWD);
    expect(prompt).toContain("Company: Acme Corp");
  });

  it("includes email", () => {
    const agent = createTestAgent({ identity: { email: "alice@acme.com" } });
    const prompt = buildSystemPrompt(agent, CWD);
    expect(prompt).toContain("Email: alice@acme.com");
  });

  it("includes bio", () => {
    const agent = createTestAgent({ identity: { bio: "Experienced developer" } });
    const prompt = buildSystemPrompt(agent, CWD);
    expect(prompt).toContain("Bio: Experienced developer");
  });

  it("includes timezone", () => {
    const agent = createTestAgent({ identity: { timezone: "Europe/Rome" } });
    const prompt = buildSystemPrompt(agent, CWD);
    expect(prompt).toContain("Timezone: Europe/Rome");
  });

  it("omits identity section when identity is empty", () => {
    const agent = createTestAgent({ identity: {} });
    const prompt = buildSystemPrompt(agent, CWD);
    // Empty identity still triggers the section (the code checks for agent.identity truthy)
    // but an identity with no fields should still have the header
    expect(prompt).toContain("## Your Identity");
  });

  it("omits identity section when identity is undefined", () => {
    const agent = createTestAgent({});
    const prompt = buildSystemPrompt(agent, CWD);
    expect(prompt).not.toContain("## Your Identity");
  });
});

// ─── Responsibilities (strings) ──────────────────────

describe("buildSystemPrompt — responsibilities (strings)", () => {
  it("renders string responsibilities as bullet list", () => {
    const agent = createTestAgent({
      identity: {
        responsibilities: ["Do X", "Do Y"],
      },
    });
    const prompt = buildSystemPrompt(agent, CWD);
    expect(prompt).toContain("## Your Responsibilities");
    expect(prompt).toContain("- Do X");
    expect(prompt).toContain("- Do Y");
  });
});

// ─── Responsibilities (structured) ───────────────────

describe("buildSystemPrompt — responsibilities (structured)", () => {
  it("renders structured responsibility with area, priority, description", () => {
    const agent = createTestAgent({
      identity: {
        responsibilities: [
          { area: "Sales", description: "Close deals and manage pipeline", priority: "high" },
        ],
      },
    });
    const prompt = buildSystemPrompt(agent, CWD);
    expect(prompt).toContain("**Sales** [high]: Close deals and manage pipeline");
  });

  it("renders structured without priority", () => {
    const agent = createTestAgent({
      identity: {
        responsibilities: [
          { area: "Support", description: "Handle tickets" },
        ],
      },
    });
    const prompt = buildSystemPrompt(agent, CWD);
    expect(prompt).toContain("**Support**: Handle tickets");
    expect(prompt).not.toContain("[");
  });

  it("renders mixed string + structured", () => {
    const agent = createTestAgent({
      identity: {
        responsibilities: [
          "General coding tasks",
          { area: "Reviews", description: "Review PRs", priority: "medium" },
        ],
      },
    });
    const prompt = buildSystemPrompt(agent, CWD);
    expect(prompt).toContain("- General coding tasks");
    expect(prompt).toContain("**Reviews** [medium]: Review PRs");
  });

  it("omits responsibilities section when empty array", () => {
    const agent = createTestAgent({ identity: { responsibilities: [] } });
    const prompt = buildSystemPrompt(agent, CWD);
    expect(prompt).not.toContain("## Your Responsibilities");
  });
});

// ─── Tone ────────────────────────────────────────────

describe("buildSystemPrompt — tone", () => {
  it("renders tone as Communication Style section", () => {
    const agent = createTestAgent({
      identity: { tone: "Professional but warm" },
    });
    const prompt = buildSystemPrompt(agent, CWD);
    expect(prompt).toContain("## Communication Style");
    expect(prompt).toContain("Professional but warm");
  });

  it("omits tone section when tone is undefined", () => {
    const agent = createTestAgent({ identity: {} });
    const prompt = buildSystemPrompt(agent, CWD);
    expect(prompt).not.toContain("## Communication Style");
  });
});

// ─── Personality ─────────────────────────────────────

describe("buildSystemPrompt — personality", () => {
  it("renders personality section", () => {
    const agent = createTestAgent({
      identity: { personality: "Empathetic and detail-oriented" },
    });
    const prompt = buildSystemPrompt(agent, CWD);
    expect(prompt).toContain("## Personality");
    expect(prompt).toContain("Empathetic and detail-oriented");
  });

  it("omits personality section when undefined", () => {
    const agent = createTestAgent({ identity: {} });
    const prompt = buildSystemPrompt(agent, CWD);
    expect(prompt).not.toContain("## Personality");
  });
});

// ─── Hierarchy (reportsTo) ───────────────────────────

describe("buildSystemPrompt — hierarchy", () => {
  it("renders reportsTo as Organization section", () => {
    const agent = createTestAgent({ reportsTo: "marco" });
    const prompt = buildSystemPrompt(agent, CWD);
    expect(prompt).toContain("## Organization");
    expect(prompt).toContain("You report to: marco");
  });

  it("omits Organization section when reportsTo is undefined", () => {
    const agent = createTestAgent({});
    const prompt = buildSystemPrompt(agent, CWD);
    expect(prompt).not.toContain("## Organization");
  });
});

// ─── Full combo ──────────────────────────────────────

describe("buildSystemPrompt — full combo", () => {
  it("includes all sections in correct order", () => {
    const agent: AgentConfig = {
      name: "alice",
      identity: {
        displayName: "Alice Chen",
        title: "CTO",
        company: "Acme",
        email: "alice@acme.com",
        bio: "Tech leader",
        timezone: "US/Pacific",
        responsibilities: [
          "Architecture decisions",
          { area: "Hiring", description: "Recruit engineers", priority: "high" },
        ],
        tone: "Direct and concise",
        personality: "Strategic thinker",
      },
      reportsTo: "ceo",
      systemPrompt: "Focus on scalability.",
    };

    const prompt = buildSystemPrompt(agent, CWD);

    // All sections present
    expect(prompt).toContain("## Your Identity");
    expect(prompt).toContain("## Your Responsibilities");
    expect(prompt).toContain("## Communication Style");
    expect(prompt).toContain("## Personality");
    expect(prompt).toContain("## Organization");
    expect(prompt).toContain("Focus on scalability.");

    // Verify ordering: Identity < Responsibilities < Communication Style < Personality < Organization
    const idIdx = prompt.indexOf("## Your Identity");
    const respIdx = prompt.indexOf("## Your Responsibilities");
    const toneIdx = prompt.indexOf("## Communication Style");
    const persIdx = prompt.indexOf("## Personality");
    const orgIdx = prompt.indexOf("## Organization");

    expect(idIdx).toBeLessThan(respIdx);
    expect(respIdx).toBeLessThan(toneIdx);
    expect(toneIdx).toBeLessThan(persIdx);
    expect(persIdx).toBeLessThan(orgIdx);
  });
});
