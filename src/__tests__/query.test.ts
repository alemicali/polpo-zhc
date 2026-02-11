import { describe, it, expect } from "vitest";
import { extractYaml, extractTeamYaml } from "../llm/query.js";

describe("extractYaml", () => {
  it("returns raw YAML starting with tasks:", () => {
    const input = "tasks:\n  - title: foo";
    expect(extractYaml(input)).toBe("tasks:\n  - title: foo");
  });

  it("extracts from ```yaml fence", () => {
    const input = "Here's the plan:\n```yaml\ntasks:\n  - title: foo\n```\nDone.";
    expect(extractYaml(input)).toBe("tasks:\n  - title: foo");
  });

  it("extracts from ```yml fence", () => {
    const input = "```yml\ntasks:\n  - title: bar\n```";
    expect(extractYaml(input)).toBe("tasks:\n  - title: bar");
  });

  it("extracts from plain ``` fence", () => {
    const input = "```\ntasks:\n  - title: baz\n```";
    expect(extractYaml(input)).toBe("tasks:\n  - title: baz");
  });

  it("strips preamble text before tasks:", () => {
    const input = "Here is your plan:\n\ntasks:\n  - title: foo";
    expect(extractYaml(input)).toBe("tasks:\n  - title: foo");
  });

  it("prefers team: over tasks: when team comes first", () => {
    const input = "team:\n  - name: alice\ntasks:\n  - title: foo";
    expect(extractYaml(input)).toContain("team:");
    expect(extractYaml(input)).toContain("tasks:");
  });

  it("handles whitespace around content", () => {
    const input = "  \n\n  tasks:\n  - title: foo  \n\n  ";
    expect(extractYaml(input)).toContain("tasks:");
  });
});

describe("extractTeamYaml", () => {
  it("returns raw YAML starting with team:", () => {
    const input = "team:\n  - name: bob";
    expect(extractTeamYaml(input)).toBe("team:\n  - name: bob");
  });

  it("extracts from fenced block", () => {
    const input = "```yaml\nteam:\n  - name: alice\n```";
    expect(extractTeamYaml(input)).toBe("team:\n  - name: alice");
  });

  it("strips preamble before team:", () => {
    const input = "Here's the team config:\nteam:\n  - name: charlie";
    expect(extractTeamYaml(input)).toBe("team:\n  - name: charlie");
  });
});
