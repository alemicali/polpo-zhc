import { describe, it, expect } from "vitest";
import { looksLikeQuestion } from "../question-detector.js";
import type { TaskResult, AgentActivity } from "../core/types.js";

function makeResult(stdout: string): TaskResult {
  return { exitCode: 0, stdout, stderr: "", duration: 100 };
}

function makeActivity(overrides: Partial<AgentActivity> = {}): AgentActivity {
  return {
    filesCreated: [],
    filesEdited: [],
    toolCalls: 0,
    lastUpdate: new Date().toISOString(),
    ...overrides,
  };
}

describe("looksLikeQuestion", () => {
  it("returns true for short output ending with ?", () => {
    expect(looksLikeQuestion(makeResult("Should I use TypeScript?"))).toBe(true);
  });

  it("returns false for empty output", () => {
    expect(looksLikeQuestion(makeResult(""))).toBe(false);
  });

  it("returns false for long output (> 2000 chars)", () => {
    const long = "x".repeat(2001) + "?";
    expect(looksLikeQuestion(makeResult(long))).toBe(false);
  });

  it("returns false when no ? in last 3 lines", () => {
    expect(looksLikeQuestion(makeResult("I completed the task.\nAll done.\nDone."))).toBe(false);
  });

  it("returns false when 5+ tool calls in activity", () => {
    const activity = makeActivity({ toolCalls: 5 });
    expect(looksLikeQuestion(makeResult("Should I do X?"), activity)).toBe(false);
  });

  it("returns false when files created", () => {
    const activity = makeActivity({ filesCreated: ["src/foo.ts"] });
    expect(looksLikeQuestion(makeResult("Is this right?"), activity)).toBe(false);
  });

  it("returns false when files edited", () => {
    const activity = makeActivity({ filesEdited: ["src/bar.ts"] });
    expect(looksLikeQuestion(makeResult("Looks good?"), activity)).toBe(false);
  });

  it("returns true with low tool calls and no file changes", () => {
    const activity = makeActivity({ toolCalls: 2 });
    expect(looksLikeQuestion(makeResult("Which approach do you prefer?"), activity)).toBe(true);
  });

  it("returns true without activity data", () => {
    expect(looksLikeQuestion(makeResult("How should I proceed?"))).toBe(true);
  });

  it("detects ? in last 3 lines even with blank lines", () => {
    const text = "Some context\n\nWhat should I do?\n";
    expect(looksLikeQuestion(makeResult(text))).toBe(true);
  });
});
