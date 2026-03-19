import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runCheck as coreRunCheck,
  runMetric as coreRunMetric,
  assessTask as coreAssessTask,
  type AssessmentDeps,
} from "@polpo-ai/core/assessor";
import { createTestTask } from "./fixtures.js";
import type { TaskExpectation, TaskMetric, CheckResult } from "../core/types.js";

// ── Mock Shell & FileSystem ──────────────────────────────────────────────

function createMockShell(behavior?: {
  resolve?: { stdout: string; stderr: string; exitCode?: number };
  reject?: Error;
}) {
  return {
    execute: vi.fn().mockImplementation(async () => {
      if (behavior?.reject) throw behavior.reject;
      return behavior?.resolve ?? { stdout: "", stderr: "", exitCode: 0 };
    }),
  };
}

function createMockFS(existingPaths: string[] = []) {
  return {
    readFile: vi.fn().mockResolvedValue(""),
    writeFile: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockImplementation(async (path: string) => existingPaths.includes(path)),
    readdir: vi.fn().mockResolvedValue([]),
    mkdir: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 0, isDirectory: false, isFile: true }),
    rename: vi.fn().mockResolvedValue(undefined),
  };
}

const mockedLLMReview = vi.fn<(...args: any[]) => Promise<CheckResult>>();

function makeDeps(overrides?: {
  shell?: ReturnType<typeof createMockShell>;
  fs?: ReturnType<typeof createMockFS>;
}): AssessmentDeps {
  return {
    fs: overrides?.fs ?? createMockFS(),
    shell: overrides?.shell ?? createMockShell(),
    polpoDir: "/tmp/.polpo",
    runLLMReview: mockedLLMReview,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── runCheck ──────────────────────────────────────────

describe("runCheck", () => {
  it("test: returns passed when command succeeds", async () => {
    const shell = createMockShell({ resolve: { stdout: "ok", stderr: "", exitCode: 0 } });
    const deps = makeDeps({ shell });
    const exp: TaskExpectation = { type: "test", command: "npm test" };
    const result = await coreRunCheck(deps, exp, "/tmp");
    expect(result.passed).toBe(true);
    expect(result.type).toBe("test");
  });

  it("test: returns failed when command throws", async () => {
    const shell = createMockShell({ reject: new Error("exit code 1") });
    const deps = makeDeps({ shell });
    const exp: TaskExpectation = { type: "test", command: "npm test" };
    const result = await coreRunCheck(deps, exp, "/tmp");
    expect(result.passed).toBe(false);
    expect(result.details).toContain("exit code 1");
  });

  it("test: defaults to 'npm test' when no command", async () => {
    const shell = createMockShell({ resolve: { stdout: "", stderr: "", exitCode: 0 } });
    const deps = makeDeps({ shell });
    const exp: TaskExpectation = { type: "test" };
    await coreRunCheck(deps, exp, "/tmp");
    expect(shell.execute).toHaveBeenCalledWith("npm test", expect.anything());
  });

  it("file_exists: returns failed when files are missing", async () => {
    const fs = createMockFS([]);
    const deps = makeDeps({ fs });
    const exp: TaskExpectation = { type: "file_exists", paths: ["/nope/does-not-exist.txt"] };
    const result = await coreRunCheck(deps, exp, "/tmp");
    expect(result.passed).toBe(false);
    expect(result.message).toContain("Missing");
  });

  it("file_exists: returns passed when all files exist", async () => {
    const fs = createMockFS(["/tmp"]);
    const deps = makeDeps({ fs });
    const exp: TaskExpectation = { type: "file_exists", paths: ["/tmp"] };
    const result = await coreRunCheck(deps, exp, "/tmp");
    expect(result.passed).toBe(true);
    expect(result.message).toContain("exist");
  });

  it("script: returns passed on success", async () => {
    const shell = createMockShell({ resolve: { stdout: "ok", stderr: "", exitCode: 0 } });
    const deps = makeDeps({ shell });
    const exp: TaskExpectation = { type: "script", command: "echo hello" };
    const result = await coreRunCheck(deps, exp, "/tmp");
    expect(result.passed).toBe(true);
  });

  it("script: returns failed on error", async () => {
    const shell = createMockShell({ reject: new Error("script died") });
    const deps = makeDeps({ shell });
    const exp: TaskExpectation = { type: "script", command: "exit 1" };
    const result = await coreRunCheck(deps, exp, "/tmp");
    expect(result.passed).toBe(false);
  });

  it("script: returns failed when no command provided", async () => {
    const deps = makeDeps();
    const exp: TaskExpectation = { type: "script" };
    const result = await coreRunCheck(deps, exp, "/tmp");
    expect(result.passed).toBe(false);
    expect(result.message).toContain("No script command");
  });

  it("llm_review: delegates to runLLMReview", async () => {
    mockedLLMReview.mockResolvedValueOnce({
      type: "llm_review",
      passed: true,
      message: "good",
    });
    const deps = makeDeps();
    const exp: TaskExpectation = { type: "llm_review", criteria: "be good" };
    const result = await coreRunCheck(deps, exp, "/tmp");
    expect(result.passed).toBe(true);
    expect(mockedLLMReview).toHaveBeenCalledWith(exp, "/tmp", undefined, undefined, undefined);
  });
});

// ── runMetric ─────────────────────────────────────────

describe("runMetric", () => {
  it("returns passed when value >= threshold", async () => {
    const shell = createMockShell({ resolve: { stdout: "95\n", stderr: "", exitCode: 0 } });
    const deps = makeDeps({ shell });
    const metric: TaskMetric = { name: "coverage", command: "echo 95", threshold: 80 };
    const result = await coreRunMetric(deps, metric, "/tmp");
    expect(result.passed).toBe(true);
    expect(result.value).toBe(95);
  });

  it("returns failed when value < threshold", async () => {
    const shell = createMockShell({ resolve: { stdout: "50\n", stderr: "", exitCode: 0 } });
    const deps = makeDeps({ shell });
    const metric: TaskMetric = { name: "coverage", command: "echo 50", threshold: 80 };
    const result = await coreRunMetric(deps, metric, "/tmp");
    expect(result.passed).toBe(false);
    expect(result.value).toBe(50);
  });

  it("returns failed when output is NaN", async () => {
    const shell = createMockShell({ resolve: { stdout: "not-a-number\n", stderr: "", exitCode: 0 } });
    const deps = makeDeps({ shell });
    const metric: TaskMetric = { name: "coverage", command: "echo x", threshold: 80 };
    const result = await coreRunMetric(deps, metric, "/tmp");
    expect(result.passed).toBe(false);
    expect(result.value).toBe(0);
  });

  it("returns failed when command throws", async () => {
    const shell = createMockShell({ reject: new Error("cmd failed") });
    const deps = makeDeps({ shell });
    const metric: TaskMetric = { name: "coverage", command: "fail", threshold: 80 };
    const result = await coreRunMetric(deps, metric, "/tmp");
    expect(result.passed).toBe(false);
    expect(result.value).toBe(0);
  });
});

// ── assessTask ────────────────────────────────────────

describe("assessTask", () => {
  it("passes when all checks and metrics pass", async () => {
    const shell = createMockShell({ resolve: { stdout: "100\n", stderr: "", exitCode: 0 } });
    const deps = makeDeps({ shell });
    const task = createTestTask({
      expectations: [{ type: "test", command: "npm test" }],
      metrics: [{ name: "cov", command: "echo 100", threshold: 80 }],
    });
    const result = await coreAssessTask(deps, task, "/tmp");
    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.metrics).toHaveLength(1);
  });

  it("fails when a check fails", async () => {
    const shell = createMockShell({ reject: new Error("fail") });
    const deps = makeDeps({ shell });
    const task = createTestTask({
      expectations: [{ type: "test", command: "npm test" }],
    });
    const result = await coreAssessTask(deps, task, "/tmp");
    expect(result.passed).toBe(false);
  });

  it("fails when a metric fails", async () => {
    const shell = createMockShell({ resolve: { stdout: "10\n", stderr: "", exitCode: 0 } });
    const deps = makeDeps({ shell });
    const task = createTestTask({
      metrics: [{ name: "cov", command: "echo 10", threshold: 80 }],
    });
    const result = await coreAssessTask(deps, task, "/tmp");
    expect(result.passed).toBe(false);
  });

  it("passes with empty expectations and metrics", async () => {
    const deps = makeDeps();
    const task = createTestTask();
    const result = await coreAssessTask(deps, task, "/tmp");
    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(0);
    expect(result.metrics).toHaveLength(0);
  });

  it("includes timestamp", async () => {
    const deps = makeDeps();
    const task = createTestTask();
    const result = await coreAssessTask(deps, task, "/tmp");
    expect(result.timestamp).toBeDefined();
    expect(new Date(result.timestamp!).getTime()).not.toBeNaN();
  });
});
