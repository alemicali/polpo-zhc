import { describe, it, expect } from "vitest";
import { validateAgents } from "../core/config.js";

describe("Agent validation — deterministic loops", () => {
  it("accepts loops with a sequential pipeline", () => {
    const agents = [{
      name: "support-router",
      runtime: "polpo-runner",
      loops: {
        triage: {
          systemPrompt: "Classify the ticket.",
          tools: ["read", "search_*"],
          stopWhen: { expression: "context.ticket.category != null" },
          output: { schema: { type: "object" } },
        },
        resolve: {
          model: "openai/gpt-4o",
          maxTurns: 12,
        },
      },
      pipeline: {
        mode: "sequential",
        context: "shared",
        steps: [
          { loop: "triage" },
          {
            switch: {
              cases: [
                { when: "context.ticket.category == 'billing'", steps: [{ human: "billing_approval", notify: ["ops"] }] },
              ],
              default: { steps: [{ loop: "resolve" }] },
            },
          },
        ],
      },
    }];

    expect(() => validateAgents(agents)).not.toThrow();
  });

  it("rejects pipeline steps that reference unknown loops", () => {
    const agents = [{
      name: "support-router",
      loops: { triage: {} },
      pipeline: { steps: [{ loop: "resolve" }] },
    }];

    expect(() => validateAgents(agents)).toThrow('references unknown loop "resolve"');
  });

  it("rejects empty parallel branches", () => {
    const agents = [{
      name: "support-router",
      pipeline: { steps: [{ parallel: [] }] },
    }];

    expect(() => validateAgents(agents)).toThrow("parallel must contain at least one step");
  });

  it("rejects malformed loop tools", () => {
    const agents = [{
      name: "support-router",
      loops: { triage: { tools: ["read", ""] } },
    }];

    expect(() => validateAgents(agents)).toThrow('loop "triage" tools must be an array of non-empty strings');
  });
});
