import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process exec before importing assessor
vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

vi.mock("node:util", () => ({
  promisify: (fn: unknown) => fn, // exec mock IS already the async version
}));

vi.mock("../assessment/llm-review.js", () => ({
  runLLMReview: vi.fn(),
}));

import { exec } from "node:child_process";
import { runCheck, runMetric, assessTask } from "../assessment/assessor.js";
import { runLLMReview } from "../assessment/llm-review.js";
import { createTestTask } from "./fixtures.js";
import type { TaskExpectation, TaskMetric } from "../core/types.js";

const mockedExec = vi.mocked(exec);
const mockedLLMReview = vi.mocked(runLLMReview);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── runCheck ──────────────────────────────────────────

describe("runCheck", () => {
  it("test: returns passed when command succeeds", async () => {
    mockedExec.mockResolvedValueOnce({ stdout: "ok", stderr: "" } as any);
    const exp: TaskExpectation = { type: "test", command: "npm test" };
    const result = await runCheck(exp, "/tmp");
    expect(result.passed).toBe(true);
    expect(result.type).toBe("test");
  });

  it("test: returns failed when command throws", async () => {
    mockedExec.mockRejectedValueOnce(new Error("exit code 1"));
    const exp: TaskExpectation = { type: "test", command: "npm test" };
    const result = await runCheck(exp, "/tmp");
    expect(result.passed).toBe(false);
    expect(result.details).toContain("exit code 1");
  });

  it("test: defaults to 'npm test' when no command", async () => {
    mockedExec.mockResolvedValueOnce({ stdout: "", stderr: "" } as any);
    const exp: TaskExpectation = { type: "test" };
    await runCheck(exp, "/tmp");
    expect(mockedExec).toHaveBeenCalledWith("npm test", expect.anything());
  });

  it("file_exists: returns failed when files are missing", async () => {
    const exp: TaskExpectation = { type: "file_exists", paths: ["/nope/does-not-exist.txt"] };
    const result = await runCheck(exp, "/tmp");
    expect(result.passed).toBe(false);
    expect(result.message).toContain("Missing");
  });

  it("file_exists: returns passed when all files exist", async () => {
    const exp: TaskExpectation = { type: "file_exists", paths: ["/tmp"] };
    const result = await runCheck(exp, "/tmp");
    expect(result.passed).toBe(true);
    expect(result.message).toContain("exist");
  });

  it("script: returns passed on success", async () => {
    mockedExec.mockResolvedValueOnce({ stdout: "ok", stderr: "" } as any);
    const exp: TaskExpectation = { type: "script", command: "echo hello" };
    const result = await runCheck(exp, "/tmp");
    expect(result.passed).toBe(true);
  });

  it("script: returns failed on error", async () => {
    mockedExec.mockRejectedValueOnce(new Error("script died"));
    const exp: TaskExpectation = { type: "script", command: "exit 1" };
    const result = await runCheck(exp, "/tmp");
    expect(result.passed).toBe(false);
  });

  it("script: returns failed when no command provided", async () => {
    const exp: TaskExpectation = { type: "script" };
    const result = await runCheck(exp, "/tmp");
    expect(result.passed).toBe(false);
    expect(result.message).toContain("No script command");
  });

  it("llm_review: delegates to runLLMReview", async () => {
    mockedLLMReview.mockResolvedValueOnce({
      type: "llm_review",
      passed: true,
      message: "good",
    });
    const exp: TaskExpectation = { type: "llm_review", criteria: "be good" };
    const result = await runCheck(exp, "/tmp");
    expect(result.passed).toBe(true);
    expect(mockedLLMReview).toHaveBeenCalledWith(exp, "/tmp", undefined, undefined);
  });
});

// ── runMetric ─────────────────────────────────────────

describe("runMetric", () => {
  it("returns passed when value >= threshold", async () => {
    mockedExec.mockResolvedValueOnce({ stdout: "95\n", stderr: "" } as any);
    const metric: TaskMetric = { name: "coverage", command: "echo 95", threshold: 80 };
    const result = await runMetric(metric, "/tmp");
    expect(result.passed).toBe(true);
    expect(result.value).toBe(95);
  });

  it("returns failed when value < threshold", async () => {
    mockedExec.mockResolvedValueOnce({ stdout: "50\n", stderr: "" } as any);
    const metric: TaskMetric = { name: "coverage", command: "echo 50", threshold: 80 };
    const result = await runMetric(metric, "/tmp");
    expect(result.passed).toBe(false);
    expect(result.value).toBe(50);
  });

  it("returns failed when output is NaN", async () => {
    mockedExec.mockResolvedValueOnce({ stdout: "not-a-number\n", stderr: "" } as any);
    const metric: TaskMetric = { name: "coverage", command: "echo x", threshold: 80 };
    const result = await runMetric(metric, "/tmp");
    expect(result.passed).toBe(false);
    expect(result.value).toBe(0);
  });

  it("returns failed when command throws", async () => {
    mockedExec.mockRejectedValueOnce(new Error("cmd failed"));
    const metric: TaskMetric = { name: "coverage", command: "fail", threshold: 80 };
    const result = await runMetric(metric, "/tmp");
    expect(result.passed).toBe(false);
    expect(result.value).toBe(0);
  });
});

// ── assessTask ────────────────────────────────────────

describe("assessTask", () => {
  it("passes when all checks and metrics pass", async () => {
    mockedExec.mockResolvedValue({ stdout: "100\n", stderr: "" } as any);
    const task = createTestTask({
      expectations: [{ type: "test", command: "npm test" }],
      metrics: [{ name: "cov", command: "echo 100", threshold: 80 }],
    });
    const result = await assessTask(task, "/tmp");
    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.metrics).toHaveLength(1);
  });

  it("fails when a check fails", async () => {
    mockedExec.mockRejectedValue(new Error("fail"));
    const task = createTestTask({
      expectations: [{ type: "test", command: "npm test" }],
    });
    const result = await assessTask(task, "/tmp");
    expect(result.passed).toBe(false);
  });

  it("fails when a metric fails", async () => {
    mockedExec.mockResolvedValue({ stdout: "10\n", stderr: "" } as any);
    const task = createTestTask({
      metrics: [{ name: "cov", command: "echo 10", threshold: 80 }],
    });
    const result = await assessTask(task, "/tmp");
    expect(result.passed).toBe(false);
  });

  it("passes with empty expectations and metrics", async () => {
    const task = createTestTask();
    const result = await assessTask(task, "/tmp");
    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(0);
    expect(result.metrics).toHaveLength(0);
  });

  it("includes timestamp", async () => {
    const task = createTestTask();
    const result = await assessTask(task, "/tmp");
    expect(result.timestamp).toBeDefined();
    expect(new Date(result.timestamp!).getTime()).not.toBeNaN();
  });
});
