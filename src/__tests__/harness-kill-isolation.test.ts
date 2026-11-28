/**
 * Two runs on one remote computer: killing (or timing out) one never disturbs the other.
 *
 * - The bridge of each run starts in its own process group in the VM; a kill stops exactly that
 *   group (the bridge, its runtime, the commands they started) and nothing else — checked with real
 *   processes on this machine standing in for the VM, and through the engine with two concurrent
 *   task runs on one fake computer.
 * - A computer that stops answering for a while (Daytona's "bad gateway: sandbox … not available",
 *   a bridge whose connection could not be re-established) is waited for and checked again,
 *   instead of the run (and its automatic retries) failing within seconds.
 */
import { execFile, execFileSync, spawn as spawnChild, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { RemoteDriver, RemoteProcess } from "../sandbox/remote-adapters.js";
import {
  createHarnessSandboxSession, freeMachinePort, inOwnProcessGroup, killProcessGroupCommand, remoteHarnessMachine,
} from "../harness/sandbox-session.js";
import { isTransientMachineError, spawnHarnessEngine, waitForMachine } from "../adapters/harness-engine.js";
import { killBridgeCommand } from "../harness/control.js";

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const settings = {
  harnesses: { enabled: ["claude-code"], allowHost: true, "claude-code": { auth: "bedrock", credentialRef: { owner: "ops", service: "bedrock" }, bedrock: { region: "us-east-1" } } },
} as any;
const agent = { name: "nina", role: "research", engine: { harness: "claude-code" } } as any;
const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
const done = (text: string) => ({ text, finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 } });

function memoryVault() {
  const m = new Map<string, any>([["ops/bedrock", { type: "api_key", credentials: { apiKey: "bedrock-secret" } }]]);
  return {
    get: async (o: string, s: string) => m.get(`${o}/${s}`),
    set: async (o: string, s: string, e: any) => { m.set(`${o}/${s}`, e); },
    remove: async (o: string, s: string) => m.delete(`${o}/${s}`),
    getAllForAgent: async () => ({}), list: async () => [], hasEntries: async () => false, patch: async () => [], renameAgent: async () => {}, removeAgent: async () => {},
  } as any;
}

// ── real processes: this machine stands in for the VM ─────────────────────────

/**
 * A computer whose commands and long-running processes run here, as Daytona runs them in the VM:
 * spawn starts `bash -c <command>`, and the provider's own kill signals that process only.
 */
function localComputer(): RemoteDriver {
  return {
    remoteId: "sbx_local",
    exec: (command) => new Promise((resolve) => {
      execFile("bash", ["-c", command], { timeout: 20_000 }, (err, stdout, stderr) => {
        resolve({ exitCode: err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0, stdout, stderr });
      });
    }),
    readFile: async () => new Uint8Array(), writeFile: async () => {}, suspend: async () => {}, resume: async () => {}, destroy: async () => {},
    spawn: async (command) => {
      const child = spawnChild("bash", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });
      const exited = new Promise<{ exitCode: number }>((resolve) => child.on("exit", (code, signal) => resolve({ exitCode: code ?? (signal ? 143 : 1) })));
      const p: RemoteProcess = {
        id: String(child.pid),
        stdout: Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr!) as unknown as ReadableStream<Uint8Array>,
        wait: () => exited,
        kill: async () => { try { child.kill("SIGTERM"); } catch { /* gone */ } await exited; },
        detach: () => {},
      };
      return p;
    },
  };
}

const running = (marker: string) => {
  try { return execFileSync("pgrep", ["-f", "--", `^sleep ${marker}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean).length; } catch { return 0; }
};
const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return cond();
};

describe("a kill stops only its own run's processes on the computer", () => {
  it("two bridges on one computer: killing one ends its whole process tree, the other keeps running", async () => {
    const computer = localComputer();
    const tag = `${process.pid}${Date.now() % 100000}`;
    // two runs, each its own machine over the same computer (as two task runners do)
    const a: any = createHarnessSandboxSession(remoteHarnessMachine({ driver: async () => computer, workDir: tmpdir(), label: "box" }), { port: 4001 });
    const b: any = createHarnessSandboxSession(remoteHarnessMachine({ driver: async () => computer, workDir: tmpdir(), label: "box" }), { port: 4002 });
    // a bridge that started a runtime and a command of its own (children in the background)
    const pa = await a.spawn({ command: `sleep 71${tag} & sleep 72${tag} & wait` });
    const pb = await b.spawn({ command: `sleep 81${tag} & sleep 82${tag} & wait` });
    try {
      expect(await until(() => running(`7[12]${tag}`) === 2 && running(`8[12]${tag}`) === 2)).toBe(true);
      await pa.kill();
      // run A's whole tree is gone (not only the top process the provider knows)…
      expect(await until(() => running(`7[12]${tag}`) === 0)).toBe(true);
      // …and run B's bridge and children were never touched
      expect(running(`8[12]${tag}`)).toBe(2);
      let bEnded = false;
      void pb.wait().then(() => { bEnded = true; });
      await new Promise((r) => setTimeout(r, 200));
      expect(bEnded).toBe(false);
    } finally {
      await pb.kill();
    }
    expect(await until(() => running(`8[12]${tag}`) === 0)).toBe(true);
  }, 30_000);

  it("the group kill targets only the recorded group; a missing or bogus group file is a no-op", async () => {
    const dir = tmp("polpo-pg-");
    const file = join(dir, "g");
    // a bystander that must survive every case below
    const bystander = spawnChild("sleep", ["30"], { stdio: "ignore" });
    try {
      const run = () => spawnSync("bash", ["-c", killProcessGroupCommand(file)], { encoding: "utf8" });
      // no file: nothing is signalled
      expect(run().status).toBe(0);
      // garbage is refused before any kill (only digits, and above 1: never "kill -- -1" / "-0")
      for (const bogus of ["0", "abc", "12 34", "$(true)", "-5"]) {
        writeFileSync(file, bogus);
        expect(run().status).toBe(0);
      }
      expect(killProcessGroupCommand(file)).toContain(`case "$g" in ''|*[!0-9]*) exit 0;; esac; [ "$g" -gt 1 ] || exit 0;`);
      expect(bystander.exitCode).toBeNull();
      expect(bystander.signalCode).toBeNull();
    } finally {
      bystander.kill();
    }
    // the wrapper records the group and removes the file when the command ends by itself
    rmSync(file, { force: true });
    const r = spawnSync("bash", ["-c", inOwnProcessGroup("echo hi; exit 3", file)], { encoding: "utf8" });
    expect(r).toMatchObject({ status: 3, stdout: "hi\n" });
    expect(existsSync(file)).toBe(false);
  });

  it("a parked session's bridge is found by its port and its session id, never by its port alone", () => {
    const c = killBridgeCommand(4001, "4DkQAIiao5i5b38E");
    expect(c).toContain("grep -qx 'BRIDGE_WS_PORT=4001'");
    expect(c).toContain("grep -qF -- '4DkQAIiao5i5b38E'");
    // an id that is not a plain token is not put in a shell command
    expect(killBridgeCommand(4001, "x'; rm -rf /")).not.toContain("rm -rf");
  });

  it("free bridge ports are searched from a random start (two runs starting together do not race for the lowest)", async () => {
    const seen: string[] = [];
    const port = await freeMachinePort({ exec: async (c) => { seen.push(c); return { exitCode: 0, stdout: "4050\n", stderr: "" }; } }, 4000, 4099, 4050);
    expect(port).toBe(4050);
    expect(seen[0]).toContain("for p in $(seq 4050 4099) $(seq 4000 4049);");
  });
});

// ── the engine: two task runs on one computer ─────────────────────────────────

interface FakeProc { id: string; command: string; killed: boolean; groupKilled: boolean; ended: () => void; wait: Promise<{ exitCode: number }> }

/** One computer, shared by every run: its processes, and the commands run on it. */
function fakeComputer() {
  const procs: FakeProc[] = [];
  const execs: string[] = [];
  let ports = 4000;
  const end = (p: FakeProc) => p.ended();
  const driver: RemoteDriver = {
    remoteId: "sbx_box",
    exec: async (command) => {
      execs.push(command);
      if (command.startsWith("for p in")) return { exitCode: 0, stdout: String(++ports), stderr: "" };
      // a process-group kill: only the process whose wrapper recorded that group file
      const g = /^g=\$\(cat '([^']+)'/.exec(command);
      if (g) for (const p of procs.filter((x) => x.command.includes(g[1]!))) { p.groupKilled = true; end(p); }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    readFile: async () => new Uint8Array(), writeFile: async () => {}, suspend: async () => {}, resume: async () => {}, destroy: async () => {},
    spawn: async (command) => {
      let ended!: () => void;
      const wait = new Promise<{ exitCode: number }>((r) => { ended = () => r({ exitCode: 143 }); });
      const p: FakeProc = { id: `proc_${procs.length + 1}`, command, killed: false, groupKilled: false, ended, wait };
      procs.push(p);
      return {
        id: p.id, stdout: new ReadableStream({ start(c) { c.close(); } }), stderr: new ReadableStream({ start(c) { c.close(); } }),
        wait: () => wait, kill: async () => { p.killed = true; end(p); }, detach: () => {},
      };
    },
  };
  return { driver, procs, execs };
}

/**
 * A runtime like the AI SDK's: each session starts its bridge through the sandbox (its own
 * process), a turn runs until released or aborted, and stop() ends that bridge.
 */
function fakeRuntime(turns: Map<string, { release: (r: any) => void }>, name: string) {
  return {
    harness: "claude-code",
    createSession: async (o: any) => {
      const sessionId = o.sessionId ?? `hs-${name}`;
      const proc = await o.sandbox.spawn({ command: `node bridge.mjs --bridge-state-dir /home/.agent-runs/${sessionId}/bridge`, abortSignal: o.abortSignal });
      let stopped = false;
      return {
        sessionId, workDir: "/work", isResume: !!o.resumeFrom,
        turn: (_prompt: string, x: any) => new Promise((resolve, reject) => {
          turns.set(sessionId, { release: resolve });
          x.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
        steer: async () => {},
        detach: async () => ({ type: "resume-session", data: {} }),
        stop: async () => { if (!stopped) { stopped = true; await proc.kill(); } return { type: "resume-session", data: {} }; },
        destroy: async () => {},
      };
    },
  };
}

function startRun(id: string, computer: ReturnType<typeof fakeComputer>, turns: Map<string, any>, extra: Record<string, unknown> = {}) {
  const root = tmp(`polpo-kill-${id}-`);
  const polpoDir = join(root, ".polpo");
  mkdirSync(polpoDir, { recursive: true });
  const transcript: any[] = [];
  const handle = spawnHarnessEngine(agent, { id, title: id, description: "research", expectations: [], status: "in_progress" } as any, root,
    { polpoDir, outputDir: join(polpoDir, "output", id), vaultStore: memoryVault() } as any, {
      settings: () => settings,
      openMachine: async () => ({ machine: remoteHarnessMachine({ driver: async () => computer.driver, workDir: root, label: "box" }), computerId: "box", hold: () => () => {} }),
      runtimeFactory: () => fakeRuntime(turns, id) as any,
      recordUsage: async () => {},
      sleep: async () => {},
      ...extra,
    });
  handle.onTranscript = (e) => transcript.push(e);
  return { handle, transcript, polpoDir };
}

describe("two task runs on one computer", () => {
  it("killing one run (kill, timeout or stale kill) leaves the other running to completion", async () => {
    const computer = fakeComputer();
    const turns = new Map<string, { release: (r: any) => void }>();
    const a = startRun("tA", computer, turns);
    const b = startRun("tB", computer, turns);
    expect(await until(() => turns.size === 2 && computer.procs.length === 2)).toBe(true);
    const procA = computer.procs.find((p) => p.command.includes("hs-tA"));
    const procB = computer.procs.find((p) => p.command.includes("hs-tB"));
    // each bridge in its own group, with its own group file
    const groupOf = (p: FakeProc) => /polpo-run '([^']+)'/.exec(p.command)![1]!;
    expect(groupOf(procA!)).not.toBe(groupOf(procB!));

    a.handle.kill();
    expect(await a.handle.done).toMatchObject({ exitCode: 1, stderr: "Killed" });
    // run A's bridge ended through its own group, and nothing addressed run B's
    expect(procA!.groupKilled || procA!.killed).toBe(true);
    expect(procB).toMatchObject({ killed: false, groupKilled: false });
    const groupKills = computer.execs.filter((c) => c.startsWith("g=$(cat "));
    expect(groupKills.length).toBeGreaterThan(0);
    expect(groupKills.every((c) => c.includes(groupOf(procA!)) && !c.includes(groupOf(procB!)))).toBe(true);
    expect(computer.execs.some((c) => /pkill|killall|kill -9 -1|BRIDGE_WS_PORT/.test(c))).toBe(false);

    // run B's turn is still open and finishes normally
    turns.get("hs-tB")!.release(done("dossier ready"));
    expect(await b.handle.done).toMatchObject({ exitCode: 0, stdout: "dossier ready" });
    expect(b.transcript.some((e) => e.type === "error")).toBe(false);
  });
});

// ── a computer that stops answering for a while ─────────────────────────────

describe("a computer that does not answer for a while", () => {
  const unavailable = "bad gateway: sandbox 07d926c6-bd85-4d1e-89e3-1857a606d4f2 not available";

  it("recognises the provider's and the bridge's transient errors, not the model's", () => {
    expect(isTransientMachineError(unavailable)).toBe(true);
    expect(isTransientMachineError("codex bridge closed before the turn finished.")).toBe(true);
    expect(isTransientMachineError("socket hang up")).toBe(true);
    expect(isTransientMachineError("API Error: 403 anthropic.claude-sonnet-5 is not available for this account")).toBe(false);
    expect(isTransientMachineError("model refused")).toBe(false);
  });

  function engineWith(o: { open?: () => Promise<any>; turns: Array<(onEvent: (e: any) => void) => Promise<any>>; exec?: (c: string) => Promise<any>; waitMs?: number }) {
    const root = tmp("polpo-unavail-");
    const polpoDir = join(root, ".polpo");
    mkdirSync(polpoDir, { recursive: true });
    const created: any[] = [];
    const prompts: string[] = [];
    let n = 0;
    const machine = {
      id: "box", description: "", workDir: root,
      exec: o.exec ?? (async (c: string) => ({ exitCode: 0, stdout: c.startsWith("for p in") ? "4003" : "", stderr: "" })),
      readFile: async () => null, writeFile: async () => {}, stat: async () => null, list: async () => null, remove: async () => false,
      spawn: async () => { throw new Error("no"); }, portEndpoint: async () => ({ url: "ws://x" }), close: () => {},
    };
    const runtime = {
      harness: "claude-code",
      createSession: async (x: any) => {
        created.push(x);
        return {
          sessionId: x.sessionId ?? "hs-1", workDir: root, isResume: !!x.resumeFrom,
          turn: async (prompt: string, t: any) => { prompts.push(prompt); return o.turns[n++]!(t.onEvent); },
          steer: async () => {}, detach: async () => ({ type: "resume-session", data: {} }), stop: async () => ({ type: "resume-session", data: {} }), destroy: async () => {},
        };
      },
    };
    const transcript: any[] = [];
    const slept: number[] = [];
    const handle = spawnHarnessEngine(agent, { id: "t1", title: "dossier", description: "d", expectations: [], status: "in_progress" } as any, root,
      { polpoDir, outputDir: join(polpoDir, "output", "t1"), vaultStore: memoryVault() } as any, {
        settings: () => settings,
        openMachine: o.open ?? (async () => ({ machine: machine as any, computerId: "box", hold: () => () => {} })),
        runtimeFactory: () => runtime as any,
        recordUsage: async () => {},
        sleep: async (ms) => { slept.push(ms); },
        unavailableWaitMs: o.waitMs ?? 60_000,
      });
    handle.onTranscript = (e) => transcript.push(e);
    return { handle, transcript, created, prompts, slept, machine };
  }

  it("at the start: the computer is checked again with backoff instead of failing (and its retries) within seconds", async () => {
    let opens = 0;
    let env: ReturnType<typeof engineWith>;
    env = engineWith({
      open: async () => { if (++opens <= 2) throw new Error(unavailable); return { machine: env.machine as any, computerId: "box", hold: () => () => {} }; },
      turns: [async () => done("ok")],
    });
    expect(await env.handle.done).toMatchObject({ exitCode: 0, stdout: "ok" });
    expect(opens).toBe(3);
    expect(env.slept).toEqual([5_000, 10_000]);
    expect(env.transcript.filter((e) => /The computer is not answering \(opening the computer/.test(e.message ?? ""))).toHaveLength(2);
  });

  it("at the start: other errors fail at once, and a computer that never comes back fails after the wait", async () => {
    let opens = 0;
    const other = engineWith({ open: async () => { opens++; throw new Error("Computer \"box\" runs on Daytona v0"); }, turns: [] });
    expect(await other.handle.done).toMatchObject({ exitCode: 1, stderr: expect.stringMatching(/Daytona v0/) });
    expect(opens).toBe(1);
    const gone = engineWith({ open: async () => { throw new Error(unavailable); }, turns: [], waitMs: 0 });
    expect(await gone.handle.done).toMatchObject({ exitCode: 1, stderr: expect.stringMatching(/not available/) });
  });

  it("under a turn: the bridge's connection is lost; the run waits for the computer, re-attaches and continues once", async () => {
    let probes = 0;
    const env = engineWith({
      exec: async (c: string) => {
        if (c === "true" && ++probes <= 2) throw new Error(unavailable);
        return { exitCode: 0, stdout: c.startsWith("for p in") ? "4003" : "", stderr: "" };
      },
      turns: [
        async (onEvent) => { onEvent({ type: "error", message: "codex bridge closed before the turn finished." }); return { text: "", finishReason: "stop", usage: zero }; },
        async () => done("recovered"),
      ],
    });
    expect(await env.handle.done).toMatchObject({ exitCode: 0, stdout: "recovered" });
    expect(env.created).toHaveLength(2);
    expect(env.prompts[1]).toMatch(/computer stopped answering for a while/);
    expect(env.transcript.some((e) => /stopped answering during the turn/.test(e.message ?? ""))).toBe(true);
    expect(env.transcript.some((e) => /answers again; re-attaching/.test(e.message ?? ""))).toBe(true);
  });

  it("under a turn: a computer that does not come back fails the run, saying so", async () => {
    const env = engineWith({
      exec: async (c: string) => {
        if (c === "true") throw new Error(unavailable);
        return { exitCode: 0, stdout: c.startsWith("for p in") ? "4003" : "", stderr: "" };
      },
      turns: [async (onEvent) => { onEvent({ type: "error", message: "codex bridge closed before the turn finished." }); return { text: "", finishReason: "stop", usage: zero }; }],
      waitMs: 0,
    });
    const r = await env.handle.done;
    expect(r).toMatchObject({ exitCode: 1 });
    expect(r.stderr).toMatch(/bridge closed before the turn finished\. \(the computer box did not answer for 1 min after that\)/);
    expect(r.retryable).toBeUndefined();
  });

  it("waitForMachine: true as soon as the computer answers; false when the run is killed meanwhile", async () => {
    let calls = 0;
    const m = { exec: async () => { if (++calls < 3) throw new Error(unavailable); return { exitCode: 0, stdout: "", stderr: "" }; } };
    expect(await waitForMachine(m, { budgetMs: 60_000, sleep: async () => {} })).toBe(true);
    expect(calls).toBe(3);
    const ac = new AbortController();
    const never = { exec: async () => { ac.abort(); throw new Error(unavailable); } };
    expect(await waitForMachine(never, { budgetMs: 60_000, signal: ac.signal, sleep: async () => {} })).toBe(false);
  });
});

