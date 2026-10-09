import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { NodeShell } from "../adapters/node-shell.js";
import { runCheck } from "../assessment/assessor.js";

describe("NodeShell", () => {
  const shell = new NodeShell();

  it("returns exit code 0 and stdout for a successful command", async () => {
    const r = await shell.execute("echo hi", { cwd: tmpdir() });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hi");
  });

  it("returns the real non-zero exit code", async () => {
    const r = await shell.execute("exit 7", { cwd: tmpdir() });
    expect(r.exitCode).toBe(7);
  });

  it("reports a non-zero exit code and the reason when the command times out", async () => {
    // `exec` so the timeout kill hits sleep itself (a grandchild would keep the pipes open).
    const r = await shell.execute("exec sleep 5", { cwd: tmpdir(), timeout: 100 });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/timed out/i);
  });

  it("reports a non-zero exit code when the command is killed by a signal", async () => {
    // The shell kills itself: no normal exit, execa reports signal + undefined exitCode.
    const r = await shell.execute("kill -KILL $$", { cwd: tmpdir() });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).not.toBe("");
  });

  it("does not let a killed command pass test/script expectations", async () => {
    const test = await runCheck({ type: "test", command: "kill -KILL $$" }, tmpdir());
    expect(test.passed).toBe(false);
    const script = await runCheck({ type: "script", command: "kill -KILL $$" }, tmpdir());
    expect(script.passed).toBe(false);
  });
});
