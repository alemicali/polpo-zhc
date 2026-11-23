/**
 * A command stopped by a timeout or an abort ends with everything it started, and the call
 * returns promptly even when a descendant would keep the output open.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./process-tree.js";
import { NodeShell } from "../adapters/node-shell.js";
import { hostHarnessMachine } from "../harness/sandbox-session.js";
import { createSystemTools } from "../tools/system-tools.js";

const posix = process.platform !== "win32";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "polpo-tree-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** The pids the command wrote, one per line. */
function pidsIn(file: string): number[] {
  return readFileSync(file, "utf8").split(/\s+/).filter(Boolean).map(Number);
}

/** Waits until none of `pids` is alive (a stopped tree gets a grace before SIGKILL). */
async function expectAllGone(pids: number[], withinMs = 6_000): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (pids.some(alive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  for (const pid of pids) {
    if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
  expect(pids.filter(alive)).toEqual([]);
}

/**
 * Background sleeps (one ignoring SIGTERM, so only the SIGKILL after the grace ends it, and it
 * holds the output open meanwhile), their pids in `file`, then a wait.
 */
const tree = (file: string) =>
  `sleep 300 & echo $! >> ${file}; (trap '' TERM; exec sleep 300) & echo $! >> ${file}; echo started; wait`;

describe.skipIf(!posix)("process trees", () => {
  it("runCommand: a timeout stops the shell and every descendant, and returns promptly", async () => {
    const file = join(dir, "pids");
    const started = Date.now();
    const r = await runCommand(["bash", "-c", tree(file)], { env: { PATH: process.env.PATH ?? "" }, timeoutMs: 1_000 });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toContain("started");
    expect(r.stderr).toMatch(/timed out/);
    const pids = pidsIn(file);
    expect(pids).toHaveLength(2);
    await expectAllGone(pids);
  }, 15_000);

  it("runCommand: an abort stops the tree", async () => {
    const file = join(dir, "pids");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 700);
    const started = Date.now();
    const r = await runCommand(["sh", "-c", `(sleep 300) & echo $! >> ${file}; sleep 300 & echo $! >> ${file}; wait`], {
      env: { PATH: process.env.PATH ?? "" }, signal: ac.signal,
    });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(r.exitCode).not.toBe(0);
    expect(r.timedOut).toBeUndefined();
    await expectAllGone(pidsIn(file));
  }, 15_000);

  it("runCommand: an already aborted signal stops the command at once", async () => {
    const ac = new AbortController();
    ac.abort();
    const started = Date.now();
    const r = await runCommand(["sh", "-c", "sleep 300"], { env: { PATH: process.env.PATH ?? "" }, signal: ac.signal });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(r.exitCode).not.toBe(0);
  }, 10_000);

  it("runCommand: a command that finishes keeps its output and exit code", async () => {
    const r = await runCommand(["sh", "-c", "echo out; echo err >&2; exit 3"], { env: { PATH: process.env.PATH ?? "" }, timeoutMs: 10_000 });
    expect(r).toMatchObject({ exitCode: 3, stdout: "out\n", stderr: "err\n" });
    expect(r.timedOut).toBeUndefined();
  });

  it("NodeShell: timeout and abort end the whole tree", async () => {
    const shell = new NodeShell();
    const file = join(dir, "pids");
    let started = Date.now();
    const r = await shell.execute(tree(file), { cwd: dir, timeout: 1_000 });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(r.timedOut).toBe(true);
    expect(r.stderr).toMatch(/timed out/i);
    await expectAllGone(pidsIn(file));

    const file2 = join(dir, "pids2");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 700);
    started = Date.now();
    const a = await shell.execute(tree(file2), { cwd: dir, signal: ac.signal });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(a.exitCode).not.toBe(0);
    expect(a.stderr).toMatch(/aborted/);
    await expectAllGone(pidsIn(file2));
  }, 20_000);

  it("the bash tool: a timeout keeps its message and '(no output)', and leaves nothing behind", async () => {
    const bash = createSystemTools(dir, ["bash"], undefined, join(dir, ".out")).find((t) => t.name === "bash")!;
    const file = join(dir, "pids");
    const started = Date.now();
    const r: any = await bash.execute("t", { command: `sleep 300 >/dev/null & echo $! >> ${file}; sleep 300 >/dev/null & echo $! >> ${file}; wait`, timeout: 1_000 });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(r.isError).toBe(true);
    const text = r.content[0].text as string;
    expect(text).toMatch(/^Error: the command timed out after 1 s and was stopped/);
    expect(text).toMatch(/\(no output\)|timed out after 1000/);
    await expectAllGone(pidsIn(file));

    // aborted through the tool's signal (the agent was stopped)
    const file2 = join(dir, "pids2");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 700);
    const a: any = await bash.execute("t", { command: `sleep 300 & echo $! >> ${file2}; wait` }, ac.signal);
    expect(a.content[0].text).not.toMatch(/^Exit code: 0/);
    await expectAllGone(pidsIn(file2));
  }, 20_000);

  it("host harness machine: exec timeout and abort end the whole tree", async () => {
    const m = hostHarnessMachine({ workDir: dir, home: join(dir, "home") });
    const file = join(dir, "pids");
    let started = Date.now();
    const r = await m.exec(tree(file), { timeoutMs: 1_000 });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toContain("started");
    await expectAllGone(pidsIn(file));

    const file2 = join(dir, "pids2");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 700);
    started = Date.now();
    const a = await m.exec(tree(file2), { signal: ac.signal });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(a.exitCode).not.toBe(0);
    await expectAllGone(pidsIn(file2));
  }, 20_000);
});
