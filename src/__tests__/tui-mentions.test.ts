import { describe, it, expect } from "vitest";
import { parseMentions, findMentionSpans } from "../tui/mentions.js";

describe("parseMentions", () => {
  it("extracts @agent from simple input", () => {
    const r = parseMentions("fix the bug @alice");
    expect(r.agent).toBe("alice");
    expect(r.text).toBe("fix the bug");
  });

  it("extracts quoted @agent", () => {
    const r = parseMentions('deploy @"my agent" to prod');
    expect(r.agent).toBe("my agent");
    expect(r.text).toBe("deploy  to prod");
  });

  it("extracts #task reference", () => {
    const r = parseMentions("depends on #login-fix");
    expect(r.taskRef).toBe("login-fix");
    expect(r.text).toBe("depends on");
  });

  it("extracts quoted #task", () => {
    const r = parseMentions('see #"fix auth flow"');
    expect(r.taskRef).toBe("fix auth flow");
    expect(r.text).toBe("see");
  });

  it("extracts %plan reference", () => {
    const r = parseMentions("run %refactor-v2");
    expect(r.planRef).toBe("refactor-v2");
    expect(r.text).toBe("run");
  });

  it("extracts quoted %plan", () => {
    const r = parseMentions('execute %"full migration"');
    expect(r.planRef).toBe("full migration");
    expect(r.text).toBe("execute");
  });

  it("extracts all three mention types", () => {
    const r = parseMentions("@bob fix #auth-bug in %sprint-3");
    expect(r.agent).toBe("bob");
    expect(r.taskRef).toBe("auth-bug");
    expect(r.planRef).toBe("sprint-3");
    expect(r.text).toBe("fix  in");
  });

  it("returns original text when no mentions", () => {
    const r = parseMentions("just a normal message");
    expect(r.agent).toBeUndefined();
    expect(r.taskRef).toBeUndefined();
    expect(r.planRef).toBeUndefined();
    expect(r.text).toBe("just a normal message");
  });

  it("handles agent name with hyphens", () => {
    const r = parseMentions("@claude-code do this");
    expect(r.agent).toBe("claude-code");
  });

  it("trims result text", () => {
    const r = parseMentions("@alice");
    expect(r.text).toBe("");
  });
});

describe("findMentionSpans", () => {
  it("finds @agent span", () => {
    const spans = findMentionSpans("hello @alice world");
    expect(spans).toHaveLength(1);
    expect(spans[0]).toEqual({ start: 6, end: 12, type: "agent" });
  });

  it("finds #task span", () => {
    const spans = findMentionSpans("see #bug-123");
    expect(spans).toHaveLength(1);
    expect(spans[0]).toEqual({ start: 4, end: 12, type: "task" });
  });

  it("finds %plan span", () => {
    const spans = findMentionSpans("run %deploy");
    expect(spans).toHaveLength(1);
    expect(spans[0]).toEqual({ start: 4, end: 11, type: "plan" });
  });

  it("finds multiple spans sorted by position", () => {
    const spans = findMentionSpans("@alice fix #bug for %sprint");
    expect(spans).toHaveLength(3);
    expect(spans[0]!.type).toBe("agent");
    expect(spans[1]!.type).toBe("task");
    expect(spans[2]!.type).toBe("plan");
    expect(spans[0]!.start).toBeLessThan(spans[1]!.start);
    expect(spans[1]!.start).toBeLessThan(spans[2]!.start);
  });

  it("finds quoted mention spans", () => {
    const spans = findMentionSpans('assign @"my agent" now');
    expect(spans).toHaveLength(1);
    expect(spans[0]!.type).toBe("agent");
    expect(spans[0]!.start).toBe(7);
    expect(spans[0]!.end).toBe(18);
  });

  it("returns empty array for no mentions", () => {
    expect(findMentionSpans("no mentions here")).toEqual([]);
  });
});
