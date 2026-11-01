import { describe, expect, test } from "vitest";
import { runCheck, type AssessmentDeps } from "@polpo-ai/core";

/** A shell and file system that record what the checks ask for. */
function fakeDeps(existing: string[] = []) {
  const calls: Array<{ cmd: string; env?: Record<string, string> }> = [];
  const deps = {
    polpoDir: "/p/.polpo",
    shell: { execute: async (cmd: string, opts?: { env?: Record<string, string> }) => { calls.push({ cmd, env: opts?.env }); return { stdout: "", stderr: "", exitCode: 0 }; } },
    fs: { exists: async (path: string) => existing.includes(path.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "")) },
  } as unknown as AssessmentDeps;
  return { deps, calls };
}

const context = { taskTitle: "t", taskDescription: "d", outputDir: "/p/output/run (2)/01 - t" };

describe("checks and the task's output folder", () => {
  test("test and script checks get it as POLPO_OUTPUT_DIR", async () => {
    const { deps, calls } = fakeDeps();
    await runCheck(deps, { type: "test", command: "node check.js" }, "/p", undefined, context as never);
    await runCheck(deps, { type: "script", command: "node other.js" }, "/p", undefined, context as never);
    expect(calls.map((c) => c.env)).toEqual([{ POLPO_OUTPUT_DIR: context.outputDir }, { POLPO_OUTPUT_DIR: context.outputDir }]);
  });

  test("file_exists paths may start with $POLPO_OUTPUT_DIR", async () => {
    const { deps } = fakeDeps(["/p/output/run (2)/01 - t/note.md"]);
    const found = await runCheck(deps, { type: "file_exists", paths: ["$POLPO_OUTPUT_DIR/note.md"] }, "/p", undefined, context as never);
    expect(found.passed).toBe(true);
    const missing = await runCheck(deps, { type: "file_exists", paths: ["$POLPO_OUTPUT_DIR/other.md"] }, "/p", undefined, context as never);
    expect(missing.passed).toBe(false);
  });

  test("without a context nothing changes", async () => {
    const { deps, calls } = fakeDeps();
    await runCheck(deps, { type: "test", command: "npm test" }, "/p");
    expect(calls[0].env).toBeUndefined();
  });
});
