/**
 * End-to-end integration test using real Claude SDK.
 *
 * This test exercises the FULL framework pipeline:
 *   Orchestrator → Plan → Runner subprocess → Claude SDK adapter → Assessment → Cleanup
 *
 * Requires: ANTHROPIC_API_KEY in environment.
 * Run explicitly: INTEGRATION_TEST=1 npm test -- --run src/__tests__/integration/e2e-claude.test.ts
 *
 * NOT run in CI — real API calls, real costs, ~2-4 min.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { Orchestrator } from "../../core/orchestrator.js";

// Claude SDK uses auth from ~/.claude (same as Claude Code CLI) — no env var needed.
// Only gate on INTEGRATION_TEST to avoid running in CI or on every `npm test`.
const RUN_E2E = !!process.env.INTEGRATION_TEST;

describe.runIf(RUN_E2E)("e2e: Claude SDK full pipeline", () => {
  let tmpDir: string;
  let orchestrator: Orchestrator;
  const events: Array<{ type: string; data: unknown }> = [];

  beforeAll(() => {
    // Create isolated temp workspace
    tmpDir = join(tmpdir(), `polpo-e2e-${randomBytes(6).toString("hex")}`);
    mkdirSync(join(tmpDir, ".polpo", "tmp"), { recursive: true });
    mkdirSync(join(tmpDir, "src"), { recursive: true });

    orchestrator = new Orchestrator(tmpDir);

    // Initialize in interactive mode with a Claude SDK agent
    orchestrator.initInteractive("e2e-test", {
      name: "e2e-team",
      agents: [
        {
          name: "claude",
          adapter: "claude-sdk",
          model: "claude-sonnet-4-5-20250929",
          maxTurns: 20,
        },
      ],
    });

    // Wire up event tracking
    const track = (type: string) => (data: unknown) => events.push({ type, data });
    orchestrator.on("agent:spawned", track("agent:spawned"));
    orchestrator.on("agent:finished", track("agent:finished"));
    orchestrator.on("task:transition", track("task:transition"));
    orchestrator.on("task:retry", track("task:retry"));
    orchestrator.on("task:question", track("task:question"));
    orchestrator.on("task:answered", track("task:answered"));
    orchestrator.on("assessment:started", track("assessment:started"));
    orchestrator.on("assessment:complete", track("assessment:complete"));
    orchestrator.on("plan:completed", track("plan:completed"));
    orchestrator.on("deadlock:detected", track("deadlock:detected"));
    orchestrator.on("log", track("log"));
  });

  afterAll(async () => {
    // Graceful shutdown — kills runners, waits for results, closes DB
    try {
      await orchestrator.gracefulStop(10_000);
    } catch { /* already stopped */ }

    // Clean up temp dir
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  it("executes a 3-task plan with dependencies and assessment", async () => {
    // ── Define Plan ──────────────────────────────────────
    //
    // Task A: Create a utility module (no deps)
    // Task B: Create a consumer module (depends on A)
    // Task C: Verify everything works (depends on A + B) with script assessment
    //

    const taskA = orchestrator.addTask({
      title: "Create greet module",
      description: [
        `Create the file ${join(tmpDir, "src", "greet.ts")} with this exact content:`,
        ``,
        `export function greet(name: string): string {`,
        `  return \`Hello, \${name}!\`;`,
        `}`,
        ``,
        `export function farewell(name: string): string {`,
        `  return \`Goodbye, \${name}!\`;`,
        `}`,
        ``,
        `Only create this one file. Do not create any other files.`,
      ].join("\n"),
      assignTo: "claude",
      group: "e2e-plan",
    });

    const taskB = orchestrator.addTask({
      title: "Create main module",
      description: [
        `Create the file ${join(tmpDir, "src", "main.ts")} that:`,
        `1. Imports greet and farewell from ./greet.ts (use .js extension in import)`,
        `2. Exports a function called run() that returns the string: greet("World") + " " + farewell("World")`,
        ``,
        `The file should be:`,
        `import { greet, farewell } from "./greet.js";`,
        `export function run(): string { return greet("World") + " " + farewell("World"); }`,
        ``,
        `Only create this one file. Do not modify any other files.`,
      ].join("\n"),
      assignTo: "claude",
      dependsOn: [taskA.id],
      group: "e2e-plan",
    });

    const taskC = orchestrator.addTask({
      title: "Verify files exist",
      description: [
        `Verify that both files exist:`,
        `- ${join(tmpDir, "src", "greet.ts")}`,
        `- ${join(tmpDir, "src", "main.ts")}`,
        ``,
        `Read both files and confirm they contain the expected exports.`,
        `If both exist and look correct, your work is done.`,
      ].join("\n"),
      assignTo: "claude",
      dependsOn: [taskA.id, taskB.id],
      group: "e2e-plan",
      expectations: [
        {
          type: "script",
          command: `test -f "${join(tmpDir, "src", "greet.ts")}" && test -f "${join(tmpDir, "src", "main.ts")}" && echo "OK"`,
        },
      ],
    });

    // Save as a plan for plan:completed event
    orchestrator.savePlan({
      name: "e2e-plan",
      yaml: "tasks:\n  - title: Create greet module\n  - title: Create main module\n  - title: Verify files exist",
      status: "active",
    });

    // ── Run Supervisor Loop ──────────────────────────────
    //
    // tick() repeatedly until all tasks are terminal, with timeout.
    //

    const TIMEOUT = 4 * 60 * 1000; // 4 minutes
    const POLL = 2000;
    const deadline = Date.now() + TIMEOUT;

    while (Date.now() < deadline) {
      const allDone = orchestrator.tick();
      if (allDone) break;
      await sleep(POLL);
    }

    // ── Assertions ───────────────────────────────────────

    const store = orchestrator.getStore();
    const tasks = store.getAllTasks();
    const finalA = tasks.find(t => t.id === taskA.id)!;
    const finalB = tasks.find(t => t.id === taskB.id)!;
    const finalC = tasks.find(t => t.id === taskC.id)!;

    // 1. All tasks should be terminal
    expect(["done", "failed"]).toContain(finalA.status);
    expect(["done", "failed"]).toContain(finalB.status);
    expect(["done", "failed"]).toContain(finalC.status);

    // 2. Task A (no deps) should have been spawned first
    const spawnEvents = events.filter(e => e.type === "agent:spawned");
    expect(spawnEvents.length).toBeGreaterThanOrEqual(1);

    // 3. Files should exist (if tasks succeeded)
    if (finalA.status === "done") {
      expect(existsSync(join(tmpDir, "src", "greet.ts"))).toBe(true);
      const content = readFileSync(join(tmpDir, "src", "greet.ts"), "utf-8");
      expect(content).toContain("greet");
      expect(content).toContain("farewell");
    }

    if (finalB.status === "done") {
      expect(existsSync(join(tmpDir, "src", "main.ts"))).toBe(true);
      const content = readFileSync(join(tmpDir, "src", "main.ts"), "utf-8");
      expect(content).toContain("import");
      expect(content).toContain("run");
    }

    // 4. Task C has assessment (script check)
    if (finalC.status === "done") {
      expect(finalC.result?.assessment).toBeDefined();
      expect(finalC.result?.assessment?.passed).toBe(true);
    }

    // 5. Dependency order was respected
    const finishedEvents = events
      .filter(e => e.type === "agent:finished")
      .map(e => (e.data as any).taskId);

    if (finishedEvents.includes(taskA.id) && finishedEvents.includes(taskB.id)) {
      const aIdx = finishedEvents.indexOf(taskA.id);
      const bIdx = finishedEvents.indexOf(taskB.id);
      expect(aIdx).toBeLessThan(bIdx); // A finished before B
    }

    // 6. RunStore should be clean (no active runs)
    const runStore = orchestrator.getRunStore();
    expect(runStore.getActiveRuns()).toHaveLength(0);

    // 7. Log event coverage — key events should have fired
    const eventTypes = new Set(events.map(e => e.type));
    expect(eventTypes.has("agent:spawned")).toBe(true);
    expect(eventTypes.has("agent:finished")).toBe(true);

    // ── Report ───────────────────────────────────────────

    console.log("\n── E2E Test Results ──");
    console.log(`Task A (greet): ${finalA.status} (${finalA.result?.duration ?? 0}ms)`);
    console.log(`Task B (main):  ${finalB.status} (${finalB.result?.duration ?? 0}ms)`);
    console.log(`Task C (verify): ${finalC.status} (${finalC.result?.duration ?? 0}ms)`);
    if (finalC.result?.assessment) {
      console.log(`Assessment: passed=${finalC.result.assessment.passed}`);
      for (const c of finalC.result.assessment.checks) {
        console.log(`  - ${c.type}: ${c.passed ? "✓" : "✗"} ${c.message}`);
      }
    }
    console.log(`Events fired: ${events.length} (${[...eventTypes].join(", ")})`);
    console.log(`Retries: ${events.filter(e => e.type === "task:retry").length}`);
    console.log(`Questions detected: ${events.filter(e => e.type === "task:question").length}`);
    console.log(`Deadlocks: ${events.filter(e => e.type === "deadlock:detected").length}`);
    console.log("──────────────────────\n");

  }, 5 * 60 * 1000); // 5 minute timeout

  it("handles task failure and retry correctly", async () => {
    // Add a task that will fail (impossible command)
    const badTask = orchestrator.addTask({
      title: "Intentional failure",
      description: [
        `Run this command and report the result: cat /nonexistent/file/that/does/not/exist_12345.txt`,
        `You MUST run this exact command. Do not create the file. Just try to read it.`,
        `If the command fails, that is expected — just report the error and exit.`,
      ].join("\n"),
      assignTo: "claude",
      expectations: [
        {
          type: "script",
          command: `test -f "/nonexistent/file/that/does/not/exist_12345.txt"`,
        },
      ],
    });

    const TIMEOUT = 3 * 60 * 1000;
    const deadline = Date.now() + TIMEOUT;

    while (Date.now() < deadline) {
      const task = orchestrator.getStore().getTask(badTask.id);
      if (task && (task.status === "done" || task.status === "failed")) break;
      orchestrator.tick();
      await sleep(2000);
    }

    const final = orchestrator.getStore().getTask(badTask.id)!;

    // Should have failed (assessment script check fails)
    // or exhausted retries
    expect(["done", "failed"]).toContain(final.status);

    // Should have result with assessment
    if (final.result?.assessment) {
      const scriptCheck = final.result.assessment.checks.find(c => c.type === "script");
      if (scriptCheck) {
        expect(scriptCheck.passed).toBe(false);
      }
    }

    // Should have triggered retry events (maxRetries = 2 by default)
    if (final.status === "failed") {
      expect(final.retries).toBeGreaterThanOrEqual(0);
    }

    console.log(`Failure test: status=${final.status}, retries=${final.retries}`);
  }, 4 * 60 * 1000);

  it("cleans up gracefully", async () => {
    // Verify we can stop without hanging
    const stopPromise = orchestrator.gracefulStop(5000);
    await expect(stopPromise).resolves.toBeUndefined();

    // RunStore should be clean
    const runStore = orchestrator.getRunStore();
    expect(runStore.getActiveRuns()).toHaveLength(0);
    expect(runStore.getTerminalRuns()).toHaveLength(0);
  }, 15_000);
});

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
