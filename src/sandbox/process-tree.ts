/**
 * Commands that end together with everything they started.
 *
 * A shell run for an agent starts programs of its own (`npm run dev` → node, a `sleep` in a
 * pipeline, a server a script started). Killing the shell alone on a timeout or an abort leaves
 * them running: they leak on the host and keep the output pipes open, so a caller waiting for
 * 'close' waits until they finish by themselves.
 *
 * On Linux and macOS the shell is spawned in its own process group (`detached`), and the whole
 * group is stopped: SIGTERM, then SIGKILL after a short grace if anything is still alive. On
 * Windows, where there are no process groups, `taskkill /T /F` ends the tree (local-shell.ts).
 * Commands still running when Polpo exits are killed then.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { constants as osConstants } from "node:os";
import type { ExecOptions, ExecResult } from "@polpo-ai/core/sandbox";
import { killProcessTree } from "./local-shell.js";

/** Output kept in memory per stream; the bash tool offloads anything big to a file anyway. */
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;

/** How long a stopped tree gets between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 2_500;

const isWindows = () => process.platform === "win32";

/**
 * Process groups of commands still running, or stopped and inside their grace: killed if Polpo
 * exits first. A command that finished normally is forgotten, with what it left in the
 * background on purpose (`nohup server &`).
 */
const liveGroups = new Set<number>();
let exitHookInstalled = false;
/** Children {@link killTree} is stopping (their group stays tracked until the grace ends). */
const stopping = new WeakSet<ChildProcess>();

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const pgid of liveGroups) {
      try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ }
    }
  });
}

/** True while some process of the group `pgid` is alive. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    // EPERM: alive, but not ours to signal
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Spawn `file` so that {@link killTree} can stop it with everything it starts: its own process
 * group on POSIX (`detached`), no console window on Windows.
 */
export function spawnTree(file: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
  const child = spawn(file, args, { ...options, detached: !isWindows(), windowsHide: true });
  const pgid = child.pid;
  if (!isWindows() && pgid) {
    installExitHook();
    liveGroups.add(pgid);
    child.once("close", () => { if (!stopping.has(child)) liveGroups.delete(pgid); });
  }
  return child;
}

/**
 * Stop `child` (spawned with {@link spawnTree}) and every process it started. POSIX: SIGTERM to
 * the group, SIGKILL to it `graceMs` later if any member is still alive. Windows: the whole tree
 * at once. The child is unref'd: a stopped command never keeps Polpo running.
 */
export function killTree(child: ChildProcess, opts: { graceMs?: number } = {}): void {
  const pid = child.pid;
  child.unref();
  if (!pid || stopping.has(child)) return;
  // finished already (POSIX: its group id may belong to someone else by now)
  if (isWindows() ? child.exitCode !== null || child.signalCode !== null : !liveGroups.has(pid)) return;
  stopping.add(child);
  if (isWindows()) {
    if (!killProcessTree(pid)) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
    return;
  }
  try { process.kill(-pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* gone */ } }
  const timer = setTimeout(() => {
    if (groupAlive(pid)) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }
    if (child.exitCode === null && child.signalCode === null) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
    liveGroups.delete(pid);
  }, opts.graceMs ?? KILL_GRACE_MS);
  timer.unref();
}

/** {@link runCommand}'s result: `signal` is set when the command ended by a signal. */
export type RunResult = ExecResult & { signal?: NodeJS.Signals };

/**
 * Run argv, capture output, enforce the timeout and the abort signal. A stop ends the whole tree
 * (process-tree.ts), and the run ends when the shell does, without waiting for a program that
 * escaped it and still holds the output open.
 */
export function runCommand(argv: string[], opts: ExecOptions & { env: Record<string, string>; cwd?: string }): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolveRun) => {
    const child = spawnTree(argv[0]!, argv.slice(1), { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    const stdoutStream = child.stdout!;
    const stderrStream = child.stderr!;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const collect = (which: "out" | "err") => (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      opts.onOutput?.(text);
      if (which === "out") { if (stdout.length < MAX_CAPTURE_BYTES) stdout += text; }
      else if (stderr.length < MAX_CAPTURE_BYTES) stderr += text;
    };
    stdoutStream.on("data", collect("out"));
    stderrStream.on("data", collect("err"));
    // the whole tree: the shell and what it started
    let killed = false;
    const kill = () => {
      if (killed) return;
      killed = true;
      killTree(child);
    };
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs) : undefined;
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", kill);
      resolveRun(result);
    };
    child.on("error", (error) => {
      finish({ exitCode: 127, stdout, stderr: `${stderr}${error.message}`, durationMs: Date.now() - started });
    });
    child.stdin!.on("error", () => { /* the command exited without reading its input */ });
    if (opts.stdin !== undefined) child.stdin!.end(opts.stdin); else child.stdin!.end();
    const done = (code: number | null, signal: NodeJS.Signals | null) => {
      const exitCode = code ?? (signal ? 128 + (osConstants.signals[signal] ?? 9) : 1);
      if (timedOut && !stderr) stderr = `Command timed out after ${opts.timeoutMs}ms`;
      finish({
        exitCode: timedOut && exitCode === 0 ? 124 : exitCode, stdout, stderr,
        ...(timedOut ? { timedOut } : {}), ...(code === null && signal ? { signal } : {}), durationMs: Date.now() - started,
      });
    };
    child.on("close", done);
    // A stopped command ends when the shell exits: a program it left behind may keep the output
    // open (one that left the process group, or the msys bash on Windows), and the run must not
    // wait for it.
    child.on("exit", (code, signal) => {
      if (!killed) return;
      stdoutStream.destroy();
      stderrStream.destroy();
      done(code, signal);
    });
    if (opts.signal?.aborted) kill();
    else opts.signal?.addEventListener("abort", kill, { once: true });
  });
}
