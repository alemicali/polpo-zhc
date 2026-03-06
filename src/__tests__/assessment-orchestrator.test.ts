import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { AssessmentOrchestrator } from "../core/assessment-orchestrator.js";
import type { OrchestratorContext, AssessFn } from "../core/orchestrator-context.js";
import { HookRegistry } from "../core/hooks.js";
import type { Task, TaskResult, AssessmentResult, PolpoConfig } from "../core/types.js";
import { TypedEmitter } from "../core/events.js";
import { InMemoryTaskStore, InMemoryRunStore, createTestActivity } from "./fixtures.js";
import type { RunRecord } from "../core/run-store.js";

// Mock external LLM modules — these must be mocked before importing the class
vi.mock("../llm/query.js", () => ({
  queryOrchestratorText: vi.fn().mockResolvedValue({ text: "{}", usage: undefined, costUsd: undefined }),
}));

vi.mock("../llm/answer-generator.js", () => ({
  generateAnswer: vi.fn().mockResolvedValue("Here is the answer."),
}));

vi.mock("../core/question-detector.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/question-detector.js")>();
  return {
    ...actual,
    // Keep the real looksLikeQuestion (it's sync, no LLM), but mock classifyAsQuestion
    looksLikeQuestion: actual.looksLikeQuestion,
    classifyAsQuestion: vi.fn().mockResolvedValue({ isQuestion: false, question: "" }),
  };
});

// Import mocked modules so we can configure them per test
import { queryOrchestratorText } from "../llm/query.js";
import { generateAnswer } from "../llm/answer-generator.js";
import { classifyAsQuestion } from "../core/question-detector.js";

// ── Helpers ──────────────────────────────────────────

function createPassingAssessment(): AssessmentResult {
  return {
    passed: true,
    checks: [],
    metrics: [],
    timestamp: new Date().toISOString(),
  };
}

function createFailingAssessment(overrides: Partial<AssessmentResult> = {}): AssessmentResult {
  return {
    passed: false,
    checks: [
      { type: "file_exists", passed: false, message: "Missing file src/foo.ts" },
    ],
    metrics: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function createOkResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return { exitCode: 0, stdout: "done", stderr: "", duration: 100, ...overrides };
}

function createFailResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return { exitCode: 1, stdout: "", stderr: "error", duration: 100, ...overrides };
}

function createTestRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  const now = new Date().toISOString();
  return {
    id: "run-1",
    taskId: "task-1",
    pid: 0,
    agentName: "test-agent",
    status: "running",
    startedAt: now,
    updatedAt: now,
    activity: createTestActivity(),
    configPath: "/tmp/run.json",
    ...overrides,
  };
}

/** Minimal in-memory MemoryStore */
function createMemoryStore() {
  let content = "";
  return {
    exists: () => content.length > 0,
    get: () => content,
    save: (c: string) => { content = c; },
    append: (line: string) => { content += `\n${line}`; },
    update: (oldText: string, newText: string): true | string => {
      if (!content.includes(oldText)) return "oldText not found";
      content = content.replace(oldText, newText);
      return true;
    },
  };
}

/** Minimal in-memory LogStore */
function createLogStore() {
  return {
    startSession: () => "session-1",
    getSessionId: () => "session-1",
    append: () => {},
    getSessionEntries: () => [],
    listSessions: () => [],
    prune: () => 0,
    close: () => {},
  };
}

/** Minimal in-memory SessionStore */
function createSessionStore() {
  return {
    create: () => "s1",
    addMessage: () => ({ id: "m1", role: "user" as const, content: "", ts: new Date().toISOString() }),
    updateMessage: () => false,
    getMessages: () => [],
    getRecentMessages: () => [],
    listSessions: () => [],
    getSession: () => undefined,
    getLatestSession: () => undefined,
    renameSession: () => false,
    deleteSession: () => false,
    prune: () => 0,
    close: () => {},
  };
}

function createMinimalConfig(): PolpoConfig {
  return {
    version: "1",
    project: "test",
    teams: [{ name: "test-team", agents: [{ name: "test-agent" }] }],
    tasks: [],
    settings: {
      maxRetries: 2,
      workDir: "/tmp/test",
      logLevel: "quiet",
      maxFixAttempts: 2,
      maxQuestionRounds: 2,
    },
  };
}

interface TestHarness {
  store: InMemoryTaskStore;
  runStore: InMemoryRunStore;
  emitter: TypedEmitter;
  assessFn: Mock<AssessFn>;
  ctx: OrchestratorContext;
  ao: AssessmentOrchestrator;
}

function createHarness(configOverrides: Partial<PolpoConfig["settings"]> = {}): TestHarness {
  const store = new InMemoryTaskStore();
  const runStore = new InMemoryRunStore();
  const emitter = new TypedEmitter();
  const assessFn = vi.fn<AssessFn>();

  const config = createMinimalConfig();
  Object.assign(config.settings, configOverrides);

  const ctx: OrchestratorContext = {
    emitter,
    registry: store,
    runStore,
    memoryStore: createMemoryStore(),
    logStore: createLogStore(),
    sessionStore: createSessionStore(),
    hooks: new HookRegistry(),
    config,
    workDir: "/tmp/test",
    agentWorkDir: "/tmp/test",
    polpoDir: "/tmp/test/.polpo",
    assessFn,
  };

  const ao = new AssessmentOrchestrator(ctx);
  return { store, runStore, emitter, assessFn, ctx, ao };
}

/** Add a task to the store and transition it to review (ready for assessment). */
function addReviewTask(h: TestHarness, taskOverrides: Partial<Task> = {}): Task {
  const task = h.store.addTask({
    title: "Test task",
    description: "A test task",
    assignTo: "test-agent",
    dependsOn: [],
    expectations: [],
    metrics: [],
    maxRetries: 2,
    ...taskOverrides,
  });
  h.store.transition(task.id, "assigned");
  h.store.transition(task.id, "in_progress");
  return task;
}

// ── Tests ────────────────────────────────────────────

describe("AssessmentOrchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (classifyAsQuestion as Mock).mockResolvedValue({ isQuestion: false, question: "" });
    (queryOrchestratorText as Mock).mockResolvedValue({ text: "{}", usage: undefined, costUsd: undefined });
    (generateAnswer as Mock).mockResolvedValue("Here is the answer.");
  });

  // ── handleResult basics ──────────────────────────

  describe("handleResult", () => {
    it("skips if task not found", () => {
      const h = createHarness();
      // Should not throw for nonexistent task
      h.ao.handleResult("nonexistent", createOkResult());
    });

    it("skips already-terminal done tasks", () => {
      const h = createHarness();
      const task = addReviewTask(h);
      // Transition through valid path: in_progress -> review -> done
      h.store.transition(task.id, "review");
      h.store.transition(task.id, "done");

      const events: unknown[] = [];
      h.emitter.on("agent:finished", (e) => events.push(e));

      h.ao.handleResult(task.id, createOkResult());
      // Should NOT emit agent:finished for terminal tasks
      expect(events).toHaveLength(0);
    });

    it("skips already-terminal failed tasks", () => {
      const h = createHarness();
      const task = addReviewTask(h);
      h.store.transition(task.id, "failed");

      const events: unknown[] = [];
      h.emitter.on("agent:finished", (e) => events.push(e));

      h.ao.handleResult(task.id, createOkResult());
      expect(events).toHaveLength(0);
    });

    it("emits agent:finished event", () => {
      const h = createHarness();
      const task = addReviewTask(h);

      const events: any[] = [];
      h.emitter.on("agent:finished", (e) => events.push(e));

      h.ao.handleResult(task.id, createOkResult());

      expect(events).toHaveLength(1);
      expect(events[0].taskId).toBe(task.id);
      expect(events[0].exitCode).toBe(0);
    });

    it("transitions in_progress task to review before assessment", () => {
      const h = createHarness();
      h.assessFn.mockResolvedValue(createPassingAssessment());
      const task = addReviewTask(h);

      h.ao.handleResult(task.id, createOkResult());

      // The task should have been moved to review as an intermediate step
      // (then proceedToAssessment runs async)
      const current = h.store.getTask(task.id)!;
      // It transitions to review first, so status is at least review or later
      expect(["review", "done"]).toContain(current.status);
    });
  });

  // ── proceedToAssessment: no expectations ─────────

  describe("proceedToAssessment — no expectations/metrics", () => {
    it("marks task done when exitCode=0 and no expectations", async () => {
      const h = createHarness();
      const task = addReviewTask(h);

      const transitions: any[] = [];
      h.emitter.on("task:transition", (e) => transitions.push(e));

      h.ao.handleResult(task.id, createOkResult());
      // No expectations → synchronous path
      await vi.waitFor(() => {
        expect(h.store.getTask(task.id)!.status).toBe("done");
      });

      expect(transitions.some(t => t.to === "done")).toBe(true);
    });

    it("retries when exitCode!=0 and no expectations", async () => {
      const h = createHarness();
      const task = addReviewTask(h);

      const retryEvents: any[] = [];
      h.emitter.on("task:retry", (e) => retryEvents.push(e));

      h.ao.handleResult(task.id, createFailResult());

      await vi.waitFor(() => {
        // Task should be back to pending (retry) since retries < maxRetries
        expect(h.store.getTask(task.id)!.status).toBe("pending");
      });

      expect(retryEvents).toHaveLength(1);
      expect(retryEvents[0].attempt).toBe(1);
    });

    it("fails permanently when exitCode!=0 and retries exhausted", async () => {
      const h = createHarness();
      const task = addReviewTask(h, { maxRetries: 0 });

      const maxRetryEvents: any[] = [];
      h.emitter.on("task:maxRetries", (e) => maxRetryEvents.push(e));

      h.ao.handleResult(task.id, createFailResult());

      await vi.waitFor(() => {
        expect(h.store.getTask(task.id)!.status).toBe("failed");
      });

      expect(maxRetryEvents).toHaveLength(1);
    });
  });

  // ── proceedToAssessment: with expectations (passing) ─

  describe("proceedToAssessment — passing assessment", () => {
    it("marks task done when assessment passes", async () => {
      const h = createHarness();
      h.assessFn.mockResolvedValue(createPassingAssessment());

      const task = addReviewTask(h, {
        expectations: [{ type: "file_exists", paths: ["src/foo.ts"] }],
      });

      const completeEvents: any[] = [];
      h.emitter.on("assessment:complete", (e) => completeEvents.push(e));

      h.ao.handleResult(task.id, createOkResult());

      await vi.waitFor(() => {
        expect(h.store.getTask(task.id)!.status).toBe("done");
      });

      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0].passed).toBe(true);
      expect(h.assessFn).toHaveBeenCalledTimes(1);
    });

    it("emits assessment:started before running assessment", async () => {
      const h = createHarness();
      h.assessFn.mockResolvedValue(createPassingAssessment());

      const task = addReviewTask(h, {
        expectations: [{ type: "test", command: "npm test" }],
      });

      const events: string[] = [];
      h.emitter.on("assessment:started", () => events.push("started"));
      h.emitter.on("assessment:complete", () => events.push("complete"));

      h.ao.handleResult(task.id, createOkResult());

      await vi.waitFor(() => {
        expect(events).toContain("complete");
      });

      expect(events[0]).toBe("started");
    });
  });

  // ── proceedToAssessment: with expectations (failing) ─

  describe("proceedToAssessment — failing assessment", () => {
    it("enters fix phase when exitCode=0 but assessment fails", async () => {
      const h = createHarness();
      h.assessFn.mockResolvedValue(createFailingAssessment({
        checks: [{ type: "test", passed: false, message: "Tests failed" }],
      }));

      const task = addReviewTask(h, {
        expectations: [{ type: "test", command: "npm test", confidence: "firm" }],
      });

      const fixEvents: any[] = [];
      h.emitter.on("task:fix", (e) => fixEvents.push(e));

      h.ao.handleResult(task.id, createOkResult());

      await vi.waitFor(() => {
        expect(h.store.getTask(task.id)!.status).toBe("pending");
      });

      const updated = h.store.getTask(task.id)!;
      expect(updated.phase).toBe("fix");
      expect(updated.fixAttempts).toBe(1);
      expect(fixEvents).toHaveLength(1);
    });

    it("retries when exitCode!=0 and assessment fails", async () => {
      const h = createHarness();
      h.assessFn.mockResolvedValue(createFailingAssessment());

      const task = addReviewTask(h, {
        expectations: [{ type: "file_exists", paths: ["src/foo.ts"] }],
      });

      const retryEvents: any[] = [];
      h.emitter.on("task:retry", (e) => retryEvents.push(e));

      h.ao.handleResult(task.id, createFailResult());

      await vi.waitFor(() => {
        expect(h.store.getTask(task.id)!.status).toBe("pending");
      });

      expect(retryEvents).toHaveLength(1);
    });

    it("fails permanently when exitCode!=0, assessment fails, and retries exhausted", async () => {
      const h = createHarness();
      h.assessFn.mockResolvedValue(createFailingAssessment());

      const task = addReviewTask(h, {
        expectations: [{ type: "file_exists", paths: ["src/foo.ts"] }],
        maxRetries: 0,
      });

      h.ao.handleResult(task.id, createFailResult());

      await vi.waitFor(() => {
        expect(h.store.getTask(task.id)!.status).toBe("failed");
      });
    });

    it("emits assessment:complete with failure reasons", async () => {
      const h = createHarness();
      h.assessFn.mockResolvedValue(createFailingAssessment({
        checks: [{ type: "test", passed: false, message: "2 tests failed" }],
      }));

      const task = addReviewTask(h, {
        expectations: [{ type: "test", command: "npm test", confidence: "firm" }],
      });

      const completeEvents: any[] = [];
      h.emitter.on("assessment:complete", (e) => completeEvents.push(e));

      h.ao.handleResult(task.id, createOkResult());

      await vi.waitFor(() => {
        expect(completeEvents).toHaveLength(1);
      });

      expect(completeEvents[0].passed).toBe(false);
      expect(completeEvents[0].message).toContain("2 tests failed");
    });
  });

  // ── Assessment error handling ────────────────────

  describe("assessment error handling", () => {
    it("retries on assessment function error", async () => {
      const h = createHarness();
      h.assessFn.mockRejectedValue(new Error("LLM call failed"));

      const task = addReviewTask(h, {
        expectations: [{ type: "test", command: "npm test" }],
      });

      const logEvents: any[] = [];
      h.emitter.on("log", (e) => logEvents.push(e));

      h.ao.handleResult(task.id, createOkResult());

      await vi.waitFor(() => {
        // Should fall through to retryOrFail
        expect(h.store.getTask(task.id)!.status).toBe("pending");
      });

      expect(logEvents.some(e => e.level === "error" && e.message.includes("Assessment error"))).toBe(true);
    });
  });

  // ── Fix / Retry logic ────────────────────────────

  describe("fixOrRetry", () => {
    it("increments fixAttempts and sets fix phase", async () => {
      const h = createHarness();
      h.assessFn.mockResolvedValue(createFailingAssessment({
        checks: [{ type: "script", passed: false, message: "lint failed" }],
      }));

      const task = addReviewTask(h, {
        expectations: [{ type: "script", command: "npm run lint", confidence: "firm" }],
      });

      h.ao.handleResult(task.id, createOkResult());

      await vi.waitFor(() => {
        const t = h.store.getTask(task.id)!;
        expect(t.fixAttempts).toBe(1);
        expect(t.phase).toBe("fix");
      });
    });

    it("falls back to full retry after max fix attempts", async () => {
      const h = createHarness({ maxFixAttempts: 1 });
      h.assessFn.mockResolvedValue(createFailingAssessment({
        checks: [{ type: "script", passed: false, message: "lint failed" }],
      }));

      // Task already used 1 fix attempt
      const task = addReviewTask(h, {
        expectations: [{ type: "script", command: "npm run lint", confidence: "firm" }],
        fixAttempts: 1,
      });

      const retryEvents: any[] = [];
      h.emitter.on("task:retry", (e) => retryEvents.push(e));

      h.ao.handleResult(task.id, createOkResult());

      await vi.waitFor(() => {
        // Should have done a full retry (failed -> pending burns a retry)
        expect(h.store.getTask(task.id)!.phase).toBe("execution");
      });

      expect(retryEvents).toHaveLength(1);
    });

    it("preserves originalDescription on first fix attempt", async () => {
      const h = createHarness();
      h.assessFn.mockResolvedValue(createFailingAssessment({
        checks: [{ type: "test", passed: false, message: "tests failed" }],
      }));

      const task = addReviewTask(h, {
        description: "Original task description",
        expectations: [{ type: "test", command: "npm test", confidence: "firm" }],
      });

      h.ao.handleResult(task.id, createOkResult());

      await vi.waitFor(() => {
        const t = h.store.getTask(task.id)!;
        expect(t.originalDescription).toBe("Original task description");
      });
    });
  });

  // ── retryOrFail ──────────────────────────────────

  describe("retryOrFail", () => {
    it("retries when retries < maxRetries", async () => {
      const h = createHarness();
      const task = addReviewTask(h, { maxRetries: 3 });

      const retryEvents: any[] = [];
      h.emitter.on("task:retry", (e) => retryEvents.push(e));

      // Simulate: task is in_progress, result comes back with exitCode != 0, no expectations
      h.ao.handleResult(task.id, createFailResult());

      await vi.waitFor(() => {
        expect(h.store.getTask(task.id)!.status).toBe("pending");
      });

      expect(retryEvents).toHaveLength(1);
      expect(retryEvents[0].attempt).toBe(1);
      expect(retryEvents[0].maxRetries).toBe(3);
      expect(h.store.getTask(task.id)!.retries).toBe(1);
    });

    it("emits task:maxRetries and fails when retries exhausted", async () => {
      const h = createHarness();
      const task = addReviewTask(h, { maxRetries: 0 });

      const maxRetryEvents: any[] = [];
      h.emitter.on("task:maxRetries", (e) => maxRetryEvents.push(e));

      h.ao.handleResult(task.id, createFailResult());

      await vi.waitFor(() => {
        expect(h.store.getTask(task.id)!.status).toBe("failed");
      });

      expect(maxRetryEvents).toHaveLength(1);
      expect(maxRetryEvents[0].taskId).toBe(task.id);
    });

    it("preserves originalDescription on first retry", async () => {
      const h = createHarness();
      const task = addReviewTask(h, {
        description: "Do something important",
        maxRetries: 2,
      });

      h.ao.handleResult(task.id, createFailResult());

      await vi.waitFor(() => {
        expect(h.store.getTask(task.id)!.status).toBe("pending");
      });

      expect(h.store.getTask(task.id)!.originalDescription).toBe("Do something important");
    });

    it("escalates to fallback agent after escalateAfter retries", async () => {
      const h = createHarness();
      h.ctx.config.teams[0].agents.push({ name: "senior-agent" });

      // Task already has 1 retry, maxRetries is 3, escalateAfter is 2
      const task = addReviewTask(h, {
        maxRetries: 3,
        retryPolicy: { escalateAfter: 2, fallbackAgent: "senior-agent" },
      });
      // Manually set retries to 1 so next will be attempt 2 which = escalateAfter
      h.store.updateTask(task.id, { retries: 1 });
      // Re-transition from failed -> pending doesn't apply here since we manually set;
      // we need the task in review state. Let's just call retryOrFail directly.
      // Actually, let's re-set to review for handleResult
      // The task is currently in_progress from addReviewTask. Let's proceed via handleResult:
      h.ao.handleResult(task.id, createFailResult());

      await vi.waitFor(() => {
        expect(h.store.getTask(task.id)!.status).toBe("pending");
      });

      // After escalateAfter=2, the fallback agent should be assigned
      expect(h.store.getTask(task.id)!.assignTo).toBe("senior-agent");
    });

    it("skips retry for tasks from cancelled missions", async () => {
      const h = createHarness();
      // Add getMissionByName to the store to simulate cancelled mission
      (h.store as any).getMissionByName = (name: string) => {
        if (name === "cancelled-mission") {
          return { id: "p1", name: "cancelled-mission", status: "cancelled", data: "", createdAt: "", updatedAt: "" };
        }
        return undefined;
      };

      const task = addReviewTask(h, {
        group: "cancelled-mission",
        maxRetries: 3,
      });

      h.ao.handleResult(task.id, createFailResult());

      await vi.waitFor(() => {
        expect(h.store.getTask(task.id)!.status).toBe("failed");
      });
    });
  });

  // ── Question detection ───────────────────────────

  describe("question detection", () => {
    it("detects and resolves a question, re-running the task", async () => {
      const h = createHarness();
      (classifyAsQuestion as Mock).mockResolvedValue({
        isQuestion: true,
        question: "Which database should I use?",
      });
      (generateAnswer as Mock).mockResolvedValue("Use PostgreSQL.");

      // Need activity with no file changes and few tool calls for heuristic to trigger
      const task = addReviewTask(h);
      h.runStore.upsertRun(createTestRunRecord({
        taskId: task.id,
        activity: createTestActivity({ toolCalls: 1 }),
      }));

      const questionEvents: any[] = [];
      const answeredEvents: any[] = [];
      h.emitter.on("task:question", (e) => questionEvents.push(e));
      h.emitter.on("task:answered", (e) => answeredEvents.push(e));

      // Output looks like a question (short, ends with ?)
      h.ao.handleResult(task.id, createOkResult({ stdout: "Which database should I use?" }));

      await vi.waitFor(() => {
        expect(answeredEvents).toHaveLength(1);
      });

      expect(questionEvents).toHaveLength(1);
      expect(questionEvents[0].question).toBe("Which database should I use?");
      expect(answeredEvents[0].answer).toBe("Use PostgreSQL.");

      // Task should be back to pending with Q&A appended
      const updated = h.store.getTask(task.id)!;
      expect(updated.status).toBe("pending");
      expect(updated.description).toContain("[Polpo Clarification]");
      expect(updated.description).toContain("Which database should I use?");
      expect(updated.description).toContain("Use PostgreSQL.");
      expect(updated.questionRounds).toBe(1);
    });

    it("proceeds to assessment when classifier says not a question", async () => {
      const h = createHarness();
      (classifyAsQuestion as Mock).mockResolvedValue({ isQuestion: false, question: "" });

      const task = addReviewTask(h);
      h.runStore.upsertRun(createTestRunRecord({
        taskId: task.id,
        activity: createTestActivity({ toolCalls: 1 }),
      }));

      h.ao.handleResult(task.id, createOkResult({ stdout: "Is this a question?" }));

      // No expectations → should proceed to done
      await vi.waitFor(() => {
        expect(h.store.getTask(task.id)!.status).toBe("done");
      });
    });

    it("respects maxQuestionRounds limit", async () => {
      const h = createHarness({ maxQuestionRounds: 1 });

      const task = addReviewTask(h, { questionRounds: 1 });
      h.runStore.upsertRun(createTestRunRecord({
        taskId: task.id,
        activity: createTestActivity({ toolCalls: 0 }),
      }));

      // Even though output looks like a question, questionRounds >= maxQuestionRounds
      h.ao.handleResult(task.id, createOkResult({ stdout: "Should I continue?" }));

      // Should skip question detection and proceed directly to assessment (done since no expectations)
      await vi.waitFor(() => {
        expect(h.store.getTask(task.id)!.status).toBe("done");
      });
    });

    it("proceeds to assessment when classification fails", async () => {
      const h = createHarness();
      (classifyAsQuestion as Mock).mockRejectedValue(new Error("LLM unavailable"));

      const task = addReviewTask(h);
      h.runStore.upsertRun(createTestRunRecord({
        taskId: task.id,
        activity: createTestActivity({ toolCalls: 0 }),
      }));

      h.ao.handleResult(task.id, createOkResult({ stdout: "What should I do?" }));

      // Classification error → falls back to proceedToAssessment → done (no expectations)
      await vi.waitFor(() => {
        expect(h.store.getTask(task.id)!.status).toBe("done");
      });
    });

    it("proceeds to assessment when answer generation fails", async () => {
      const h = createHarness();
      (classifyAsQuestion as Mock).mockResolvedValue({
        isQuestion: true,
        question: "Which DB?",
      });
      (generateAnswer as Mock).mockRejectedValue(new Error("LLM down"));

      const task = addReviewTask(h);
      h.runStore.upsertRun(createTestRunRecord({
        taskId: task.id,
        activity: createTestActivity({ toolCalls: 0 }),
      }));

      h.ao.handleResult(task.id, createOkResult({ stdout: "Which DB?" }));

      // Answer generation failed → falls back to proceedToAssessment → done
      await vi.waitFor(() => {
        expect(h.store.getTask(task.id)!.status).toBe("done");
      });
    });
  });

  // ── LLM Judge (judgeExpectations) ────────────────

  describe("judgeExpectations", () => {
    it("corrects estimated expectations when LLM judge says expectation_wrong", async () => {
      const h = createHarness();

      // First assessment fails (file_exists check), then after correction, second passes
      const failedAssessment = createFailingAssessment({
        globalScore: 4.0,
        checks: [{ type: "file_exists", passed: false, message: "Missing src/foo.ts" }],
      });
      const passingAssessment = createPassingAssessment();
      h.assessFn
        .mockResolvedValueOnce(failedAssessment)
        .mockResolvedValueOnce(passingAssessment);

      // Mock LLM judge to correct the expectation
      (queryOrchestratorText as Mock).mockResolvedValue({ text: JSON.stringify({
        corrections: [{
          type: "file_exists",
          verdict: "expectation_wrong",
          reason: "File was created at a different path",
          fix: { paths: ["src/bar.ts"] },
        }],
      }), usage: undefined, costUsd: undefined });

      const task = addReviewTask(h, {
        expectations: [{ type: "file_exists", paths: ["src/foo.ts"], confidence: "estimated" }],
      });

      // Provide a run record so activity is available
      h.runStore.upsertRun(createTestRunRecord({
        taskId: task.id,
        activity: createTestActivity({ filesCreated: ["src/bar.ts"], toolCalls: 10 }),
      }));

      const correctedEvents: any[] = [];
      h.emitter.on("assessment:corrected", (e) => correctedEvents.push(e));

      h.ao.handleResult(task.id, createOkResult());

      await vi.waitFor(() => {
        expect(h.store.getTask(task.id)!.status).toBe("done");
      });

      // Should have emitted correction event
      expect(correctedEvents.length).toBeGreaterThanOrEqual(1);
      expect(queryOrchestratorText).toHaveBeenCalled();
    });

    it("does not judge firm expectations", async () => {
      const h = createHarness();

      h.assessFn.mockResolvedValue(createFailingAssessment({
        checks: [{ type: "test", passed: false, message: "Tests failed" }],
      }));

      const task = addReviewTask(h, {
        expectations: [{ type: "test", command: "npm test", confidence: "firm" }],
      });

      const fixEvents: any[] = [];
      h.emitter.on("task:fix", (e) => fixEvents.push(e));

      h.ao.handleResult(task.id, createOkResult());

      await vi.waitFor(() => {
        // Firm expectations go straight to fixOrRetry, not judge
        expect(fixEvents).toHaveLength(1);
      });

      // queryOrchestratorText should NOT be called for judging (firm expectations skip the judge)
      expect(queryOrchestratorText).not.toHaveBeenCalled();
    });

    it("skips judge when globalScore is very low (<2.5)", async () => {
      const h = createHarness();

      h.assessFn.mockResolvedValue(createFailingAssessment({
        globalScore: 1.5,
        checks: [{ type: "file_exists", passed: false, message: "Missing file" }],
      }));

      const task = addReviewTask(h, {
        expectations: [{ type: "file_exists", paths: ["src/foo.ts"], confidence: "estimated" }],
      });

      h.runStore.upsertRun(createTestRunRecord({ taskId: task.id }));

      const fixEvents: any[] = [];
      h.emitter.on("task:fix", (e) => fixEvents.push(e));

      h.ao.handleResult(task.id, createOkResult());

      await vi.waitFor(() => {
        expect(fixEvents).toHaveLength(1);
      });

      // Judge should not be called when score is very low
      expect(queryOrchestratorText).not.toHaveBeenCalled();
    });
  });

  // ── Auto-correct expectations ────────────────────

  describe("auto-correct expectations", () => {
    it("skips auto-correct when disabled in settings", async () => {
      const h = createHarness({ autoCorrectExpectations: false });

      h.assessFn.mockResolvedValue(createFailingAssessment({
        checks: [{ type: "file_exists", passed: false, message: "Missing" }],
      }));

      const task = addReviewTask(h, {
        expectations: [{ type: "file_exists", paths: ["src/foo.ts"], confidence: "estimated" }],
      });

      const fixEvents: any[] = [];
      h.emitter.on("task:fix", (e) => fixEvents.push(e));

      h.ao.handleResult(task.id, createOkResult());

      await vi.waitFor(() => {
        // Should go straight to fix (no auto-correct attempted)
        expect(fixEvents).toHaveLength(1);
      });
    });
  });

  // ── Confidence helper ────────────────────────────

  describe("confidence defaults", () => {
    it("file_exists defaults to estimated confidence", async () => {
      const h = createHarness();

      // Assessment fails with file_exists check
      h.assessFn.mockResolvedValue(createFailingAssessment({
        globalScore: 4.0,
        checks: [{ type: "file_exists", passed: false, message: "Missing" }],
      }));

      const task = addReviewTask(h, {
        expectations: [{ type: "file_exists", paths: ["src/foo.ts"] }], // no explicit confidence
      });

      h.runStore.upsertRun(createTestRunRecord({ taskId: task.id }));

      // The code should attempt auto-correct/judge because file_exists defaults to "estimated"
      // Mock the judge to return work_wrong so it falls through
      (queryOrchestratorText as Mock).mockResolvedValue({ text: JSON.stringify({
        corrections: [{ type: "file_exists", verdict: "work_wrong", reason: "Agent didn't create the file" }],
      }), usage: undefined, costUsd: undefined });

      const fixEvents: any[] = [];
      h.emitter.on("task:fix", (e) => fixEvents.push(e));

      h.ao.handleResult(task.id, createOkResult());

      // Even though the judge found work_wrong, the important thing is it was called
      // (meaning estimated confidence was detected)
      await vi.waitFor(() => {
        expect(fixEvents).toHaveLength(1);
      });

      // queryOrchestratorText should have been called (judge was invoked)
      expect(queryOrchestratorText).toHaveBeenCalled();
    });

    it("test type defaults to firm confidence", async () => {
      const h = createHarness();

      h.assessFn.mockResolvedValue(createFailingAssessment({
        globalScore: 4.0,
        checks: [{ type: "test", passed: false, message: "Tests failed" }],
      }));

      const task = addReviewTask(h, {
        expectations: [{ type: "test", command: "npm test" }], // no explicit confidence
      });

      const fixEvents: any[] = [];
      h.emitter.on("task:fix", (e) => fixEvents.push(e));

      h.ao.handleResult(task.id, createOkResult());

      await vi.waitFor(() => {
        expect(fixEvents).toHaveLength(1);
      });

      // Judge should NOT be called because test defaults to firm
      expect(queryOrchestratorText).not.toHaveBeenCalled();
    });
  });

  // ── Result storage ───────────────────────────────

  describe("result storage", () => {
    it("stores TaskResult on the task after assessment", async () => {
      const h = createHarness();
      const assessment = createPassingAssessment();
      h.assessFn.mockResolvedValue(assessment);

      const task = addReviewTask(h, {
        expectations: [{ type: "file_exists", paths: ["src/foo.ts"] }],
      });

      h.ao.handleResult(task.id, createOkResult());

      await vi.waitFor(() => {
        expect(h.store.getTask(task.id)!.status).toBe("done");
      });

      const updated = h.store.getTask(task.id)!;
      expect(updated.result).toBeDefined();
      expect(updated.result!.assessment).toBeDefined();
      expect(updated.result!.assessment!.passed).toBe(true);
    });

    it("stores TaskResult even without expectations", async () => {
      const h = createHarness();
      const task = addReviewTask(h);

      h.ao.handleResult(task.id, createOkResult());

      await vi.waitFor(() => {
        expect(h.store.getTask(task.id)!.status).toBe("done");
      });

      expect(h.store.getTask(task.id)!.result).toBeDefined();
      expect(h.store.getTask(task.id)!.result!.exitCode).toBe(0);
    });
  });

  // ── Metric failures ──────────────────────────────

  describe("metric failures", () => {
    it("fails assessment when metrics fail", async () => {
      const h = createHarness();
      h.assessFn.mockResolvedValue({
        passed: false,
        checks: [],
        metrics: [{ name: "coverage", value: 50, threshold: 80, passed: false }],
        timestamp: new Date().toISOString(),
      } satisfies AssessmentResult);

      const task = addReviewTask(h, {
        metrics: [{ name: "coverage", command: "npx coverage", threshold: 80 }],
      });

      const completeEvents: any[] = [];
      h.emitter.on("assessment:complete", (e) => completeEvents.push(e));

      h.ao.handleResult(task.id, createOkResult());

      await vi.waitFor(() => {
        expect(completeEvents).toHaveLength(1);
      });

      expect(completeEvents[0].passed).toBe(false);
      expect(completeEvents[0].message).toContain("coverage");
    });
  });
});
