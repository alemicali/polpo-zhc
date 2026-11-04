import { describe, expect, test } from "vitest";
import type { AgentConfig } from "@polpo-ai/react";
import { CORE_TOOLS, agentUpdateFrom, allowedToolsOf, formFromAgent } from "@/lib/agent-edit";

const PREFIXES = ["browser_", "email_", "search_"];

const agent: AgentConfig = {
  name: "writer",
  role: "Writes drafts",
  model: "ollama:qwen3:4b-instruct",
  reasoning: "low",
  maxTurns: 40,
  systemPrompt: "Be brief.",
  skills: ["report-style"],
  identity: { displayName: "Wendy", title: "Writer", responsibilities: ["Drafts", "Edits"] },
};

describe("agent edit form", () => {
  test("an agent without allowedTools has every built-in tool and no category", () => {
    const form = formFromAgent(agent, "default", PREFIXES);
    expect(form.coreTools).toEqual([...CORE_TOOLS]);
    expect(form.categories).toEqual([]);
    expect(form.otherTools).toBe("");
    expect(form.responsibilities).toBe("Drafts\nEdits");
  });

  test("allowedTools are split into built-in tools, categories and other entries", () => {
    const form = formFromAgent({ ...agent, allowedTools: ["read", "bash", "browser_*", "pdf_*", "email_send"] }, null, PREFIXES);
    expect(form.coreTools).toEqual(["read", "bash"]);
    expect(form.categories).toEqual(["browser_"]);
    expect(form.otherTools).toBe("pdf_*, email_send");
    expect(allowedToolsOf(form).sort()).toEqual(["bash", "browser_*", "email_send", "pdf_*", "read"]);
  });

  test("no change gives an empty request", () => {
    const form = formFromAgent(agent, "default", PREFIXES);
    expect(agentUpdateFrom(form, { ...form })).toEqual({ update: {}, errors: [] });
  });

  test("only changed fields are sent; an emptied text field is sent as empty to remove it", () => {
    const initial = formFromAgent(agent, "default", PREFIXES);
    const { update, errors } = agentUpdateFrom(initial, {
      ...initial,
      model: "",
      role: "Reviews drafts",
      maxTurns: "60",
      title: "",
      responsibilities: "Drafts\nReviews",
    });
    expect(errors).toEqual([]);
    expect(update).toEqual({
      model: "",
      role: "Reviews drafts",
      maxTurns: 60,
      identity: { title: "", responsibilities: ["Drafts", "Reviews"] },
    });
  });

  test("enabling a category keeps the built-in tools listed, so the agent can still write files", () => {
    const initial = formFromAgent(agent, "default", PREFIXES);
    const { update } = agentUpdateFrom(initial, { ...initial, categories: ["browser_"] });
    expect(update.allowedTools).toEqual([...CORE_TOOLS, "browser_*"]);
  });

  test("numbers must be whole and positive, and cannot be removed once set", () => {
    const initial = formFromAgent(agent, "default", PREFIXES);
    expect(agentUpdateFrom(initial, { ...initial, maxTurns: "0" }).errors).toHaveLength(1);
    expect(agentUpdateFrom(initial, { ...initial, maxTurns: "2.5" }).errors).toHaveLength(1);
    expect(agentUpdateFrom(initial, { ...initial, maxTurns: "" }).errors).toHaveLength(1);
    expect(agentUpdateFrom(initial, { ...initial, maxConcurrency: "3" }).update).toEqual({ maxConcurrency: 3 });
  });

  test("structured responsibilities are left alone", () => {
    const form = formFromAgent({ ...agent, identity: { responsibilities: [{ area: "Docs", description: "Keep them current" }] } }, null, PREFIXES);
    expect(form.responsibilities).toBeNull();
    expect(agentUpdateFrom(form, { ...form }).update).toEqual({});
  });
});
