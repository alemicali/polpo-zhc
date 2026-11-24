/**
 * Where and with what each task run executed (Task.runs): recorded when the run is spawned,
 * completed with what the engine reports while it runs (harness session, cost, VM id), closed when
 * the run ends. Polpo's engine and the agent harnesses alike; never a secret.
 */
import { describe, expect, test } from "vitest";
import {
  TaskRunner, buildRunContext, describeTaskRun, finishRunContext, mergeRunContext, summarizeTaskRun, upsertTaskRun, MAX_TASK_RUNS,
} from "@polpo-ai/core";
import { TypedEmitter } from "../core/events.js";

const settings = {
  sandbox: { providers: { daytona: { api: "v2" } } },
  computers: [{ id: "coder-box", name: "Coder box", kind: "daytona", egress: "home" }],
  egressProxies: { home: "socks5://100.101.102.103:1080", office: "http://proxy.example.com:3128" },
  tailscale: { authKey: { owner: "ops", service: "tailscale" } },
  harnesses: {
    enabled: ["claude-code"],
    "claude-code": { auth: "bedrock", credentialRef: { owner: "ops", service: "bedrock" }, bedrock: { region: "us-east-1" }, model: "us.anthropic.claude-sonnet-4-5" },
  },
};

const harnessAgent = { name: "coder", defaultComputer: "coder-box", engine: { harness: "claude-code", model: "us.anthropic.claude-haiku-4-5-20251001-v1:0", maxBudgetUsd: 2 } };
const nativeAgent = { name: "writer", model: "anthropic:claude-sonnet-4-5", browserEgress: "office" };

/** Just enough of the orchestrator for spawnForTask, the process sync and the result collection. */
function orchestrator(agent: any) {
  const task: any = { id: "t1", title: "Do it", description: "x", assignTo: agent.name, status: "pending", phase: "execution", dependsOn: [] };
  const runs = new Map<string, any>();
  const ctx = {
    emitter: new TypedEmitter(),
    polpoDir: "/tmp/polpo-test",
    agentWorkDir: "/tmp/polpo-test/work",
    config: { project: "p", settings },
    hooks: { runBeforeSync: () => ({ cancelled: false }) },
    agentStore: { getAgent: async () => agent },
    memoryStore: { get: async () => "" },
    sandboxProviders: () => new Set(["local", "bwrap", "daytona", "e2b"]),
    spawner: { spawn: async () => ({ pid: 4242, configPath: "/tmp/c.json" }), isAlive: () => true, kill: () => {} },
    runStore: {
      upsertRun: async (r: any) => { runs.set(r.id, r); },
      getActiveRuns: async () => [...runs.values()].filter((r) => r.status === "running"),
      getTerminalRuns: async () => [...runs.values()].filter((r) => r.status !== "running"),
      deleteRun: async (id: string) => { runs.delete(id); },
    },
    taskControlStore: { listDirections: async () => [] },
    registry: {
      transition: async (_id: string, to: string) => { task.status = to; },
      updateTask: async (_id: string, patch: any) => { Object.assign(task, patch); return task; },
      getTask: async () => task,
      getAllTasks: async () => [task],
      setState: async () => {},
    },
  } as never;
  return { runner: new TaskRunner(ctx), task, runs };
}

describe("run context recorded per task run", () => {
  test("a Claude Code run on a Daytona v2 computer: engine, model, auth kind, computer, egress via Tailscale, budget; then session, VM id and cost", async () => {
    const o = orchestrator(harnessAgent);
    await o.runner.spawnForTask(o.task);
    expect(o.task.runs).toHaveLength(1);
    const started = o.task.runs[0];
    expect(started).toMatchObject({
      status: "running", engine: "claude-code", model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      auth: { kind: "bedrock", region: "us-east-1" }, permissionMode: "allow-all", budgetUsd: 2,
      computer: { id: "coder-box", name: "Coder box", kind: "daytona", provider: "daytona", daytonaApi: "v2" },
      sandbox: { provider: "daytona", ephemeral: false },
      egress: { mode: "proxy", proxy: "home", tailscale: true },
    });
    // never a secret: the vault reference is not even there
    expect(JSON.stringify(o.task.runs)).not.toMatch(/credentialRef|bedrock"\s*:\s*\{|authKey/);

    // the engine reports its session, VM and cost while it runs
    const run = [...o.runs.values()][0];
    expect(run.id).toBe(started.runId);
    run.activity = { ...run.activity, totalTokens: 144585, runContext: { model: "us.anthropic.claude-haiku-4-5-20251001-v1:0", remoteId: "vm-1", session: { resumed: false, bootstrapMs: 14800, sessionId: "hs-1" }, cost: { harnessUsd: 0.0723, tokens: 144585 } } };
    await o.runner.syncProcessesFromRunStore();
    expect(o.task.runs[0]).toMatchObject({ status: "running", computer: { remoteId: "vm-1" }, session: { resumed: false, bootstrapMs: 14800 }, cost: { harnessUsd: 0.0723 } });

    // the run ends: the entry closes (status, duration, exit code)
    run.status = "completed";
    run.updatedAt = new Date(Date.parse(run.startedAt) + 26_626).toISOString();
    run.result = { exitCode: 0, stdout: "done", stderr: "", duration: 26_626 };
    await o.runner.collectResults(() => {});
    expect(o.task.runs[0]).toMatchObject({ status: "completed", exitCode: 0, durationMs: 26_626, endedAt: run.updatedAt, cost: { harnessUsd: 0.0723, tokens: 144585 } });
    expect(o.runs.size).toBe(0);
  });

  test("a run on Polpo's engine on this server: the agent's model, its own egress proxy, the provider's model cost", async () => {
    const o = orchestrator(nativeAgent);
    await o.runner.spawnForTask(o.task);
    expect(o.task.runs[0]).toMatchObject({
      engine: "polpo", model: "anthropic:claude-sonnet-4-5", computer: { id: "host", kind: "host" },
      egress: { mode: "proxy", proxy: "office" },
    });
    expect(o.task.runs[0].auth).toBeUndefined();
    expect(o.task.runs[0].egress.tailscale).toBeUndefined();
    const run = [...o.runs.values()][0];
    run.activity = { ...run.activity, totalTokens: 900, runContext: { cost: { modelUsd: 0.012, tokens: 900 } } };
    run.status = "failed";
    run.result = { exitCode: 1, stdout: "", stderr: "boom", duration: 1000 };
    await o.runner.collectResults(() => {});
    expect(o.task.runs[0]).toMatchObject({ status: "failed", exitCode: 1, cost: { modelUsd: 0.012, tokens: 900 } });
  });

  test("several runs (continuations, retries) are kept newest last, at most MAX_TASK_RUNS", async () => {
    const o = orchestrator(nativeAgent);
    for (let i = 0; i < 3; i++) {
      await o.runner.spawnForTask(o.task);
      const run = [...o.runs.values()].find((r) => r.status === "running");
      run.status = "completed";
      run.result = { exitCode: 0, stdout: "", stderr: "", duration: 10 };
      await o.runner.collectResults(() => {});
    }
    expect(o.task.runs.map((r: any) => r.status)).toEqual(["completed", "completed", "completed"]);
    let list: any[] = [];
    for (let i = 0; i < MAX_TASK_RUNS + 5; i++) list = upsertTaskRun(list, { ...o.task.runs[0], runId: `r${i}` });
    expect(list).toHaveLength(MAX_TASK_RUNS);
    expect(list.at(-1).runId).toBe(`r${MAX_TASK_RUNS + 4}`);
    // replacing an entry keeps its place
    const replaced = upsertTaskRun(list, { ...list[3], status: "failed" });
    expect(replaced[3]).toMatchObject({ runId: list[3].runId, status: "failed" });
  });
});

describe("run context helpers", () => {
  test("an ephemeral E2B sandbox, a direct egress, a Codex harness with an API key", () => {
    const ctx = buildRunContext({
      runId: "r1", agent: { name: "a", engine: { harness: "codex" } },
      settings: { harnesses: { enabled: ["codex"], codex: { auth: "api-key", credentialRef: { owner: "o", service: "openai" }, model: "gpt-5-codex" } } },
      sandbox: { provider: "e2b" },
    });
    expect(ctx).toMatchObject({ engine: "codex", model: "gpt-5-codex", auth: { kind: "api-key" }, computer: { id: "ephemeral", kind: "ephemeral", provider: "e2b" }, sandbox: { provider: "e2b", ephemeral: true }, egress: { mode: "direct" } });
    expect(ctx.budgetUsd).toBeUndefined();
  });

  test("merge, finish, summary and one-line description", () => {
    const base = buildRunContext({ runId: "r1", startedAt: "2026-11-22T10:00:00.000Z", agent: harnessAgent, settings, sandbox: { provider: "daytona", computer: settings.computers[0] as any }, browserEgress: { name: "home", url: "socks5://100.101.102.103:1080", tailnet: {} } });
    const merged = mergeRunContext(base, { remoteId: "vm-2", session: { resumed: true, bootstrapMs: 1300 } });
    expect(merged.computer.remoteId).toBe("vm-2");
    const done = finishRunContext(merged, { status: "completed", endedAt: "2026-11-22T10:00:30.000Z", exitCode: 0 }, { cost: { harnessUsd: 0.02 } });
    expect(done).toMatchObject({ status: "completed", durationMs: 30_000, cost: { harnessUsd: 0.02 }, session: { resumed: true } });
    expect(summarizeTaskRun(done)).toEqual({ engine: "claude-code", model: "us.anthropic.claude-haiku-4-5-20251001-v1:0", computerId: "coder-box", computerName: "Coder box", computerKind: "daytona", provider: "daytona", status: "completed" });
    expect(describeTaskRun(done)).toBe("r1 [completed] us.anthropic.claude-haiku-4-5-20251001-v1:0 (Claude Code · Harness) via Bedrock (us-east-1) · on computer coder-box (daytona v2) · egress home via Tailscale · resumed session (1.3 s) · $0.0200 of $2 · 30 s");
  });
});
