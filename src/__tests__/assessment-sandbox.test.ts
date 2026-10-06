import { afterAll, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffectiveSandbox, Workspace } from "@polpo-ai/core/sandbox";
import { sandboxedAssessFn } from "../assessment/sandboxed.js";
import { bwrapAvailable } from "../sandbox/workspaces.js";
import { createTestTask } from "./fixtures.js";

const dir = mkdtempSync(join(tmpdir(), "polpo-assess-"));
const cwd = join(dir, "work");
const polpoDir = join(cwd, ".polpo");
const outputDir = join(polpoDir, "output", "t1");
for (const d of [cwd, polpoDir, outputDir]) mkdirSync(d, { recursive: true });
writeFileSync(join(polpoDir, "secret.txt"), "top secret");
writeFileSync(join(cwd, "hello.txt"), "hello");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sandbox = (provider: EffectiveSandbox["provider"]): EffectiveSandbox =>
  ({ provider, network: { mode: "deny" }, resources: {}, providerOptions: {}, denied: [] });
const runWith = (sb: EffectiveSandbox | undefined) => async () =>
  ({ id: "r1", taskId: "t1", config: { sandbox: sb, cwd, polpoDir, outputDir, agent: { name: "dev" } } } as any);
const task = (expectations: any[]) => createTestTask({ id: "t1", expectations, metrics: [{ name: "m", command: "echo 5", threshold: 1 }] });

describe("assessment commands and the task's sandbox", () => {
  test("no sandbox or local: run on this machine as before", async () => {
    for (const sb of [undefined, sandbox("local")]) {
      const assess = sandboxedAssessFn({ getRunByTaskId: runWith(sb) });
      const result = await assess(task([{ type: "test", command: `cat ${polpoDir}/secret.txt` }]), cwd);
      expect(result.checks[0]!.passed).toBe(true);
    }
  });

  test("a task without a run record is assessed on this machine", async () => {
    const assess = sandboxedAssessFn({ getRunByTaskId: async () => undefined });
    expect((await assess(task([{ type: "test", command: "true" }]), cwd)).checks[0]!.passed).toBe(true);
  });

  test.skipIf(!bwrapAvailable())("bwrap: same view as the task had (.polpo hidden, output writable)", async () => {
    const assess = sandboxedAssessFn({ getRunByTaskId: runWith(sandbox("bwrap")) });
    const result = await assess(task([
      { type: "test", command: "cat hello.txt" },
      { type: "test", command: `cat ${polpoDir}/secret.txt` },
      { type: "script", command: `echo done > ${outputDir}/ok.txt` },
      { type: "script", command: `set -e\ntest -f hello.txt\n! test -e ${polpoDir}/secret.txt` },
    ]), cwd);
    expect(result.checks.map((c) => c.passed)).toEqual([true, false, true, true]);
    expect(result.metrics[0]!.passed).toBe(true);
  });

  test("remote provider: the adapter's workspace is used and disposed", async () => {
    const calls: string[] = [];
    const workspace = {
      exec: async (command: string) => { calls.push(command); return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 }; },
      dispose: async () => { calls.push("dispose"); },
    } as unknown as Workspace;
    const assess = sandboxedAssessFn({ getRunByTaskId: runWith(sandbox("e2b")), workspaceForAssessment: async (id) => (id === "t1" ? workspace : undefined) });
    const result = await assess(task([{ type: "test", command: "npm test" }]), cwd);
    expect(result.checks[0]!.passed).toBe(true);
    expect(calls).toEqual(["npm test", "echo 5", "dispose"]);
  });

  test.skipIf(!bwrapAvailable())("remote provider without a hook falls back to bwrap on the host", async () => {
    const assess = sandboxedAssessFn({ getRunByTaskId: runWith(sandbox("daytona")) });
    const result = await assess(task([{ type: "test", command: `cat ${polpoDir}/secret.txt` }]), cwd);
    expect(result.checks[0]!.passed).toBe(false);
  });
});
