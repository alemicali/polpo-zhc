import { describe, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { TaskRunner, parseMissionDocument, missionTaskScript, scriptTaskDescription } from "@polpo-ai/core";
import { TypedEmitter } from "../core/events.js";
import { MissionExecutor } from "../core/mission-executor.js";
import { TaskManager } from "../core/task-manager.js";
import { AgentManager } from "../core/agent-manager.js";
import { HookRegistry } from "../core/hooks.js";
import type { OrchestratorContext } from "../core/orchestrator-context.js";
import type { Mission, PolpoConfig, Task } from "../core/types.js";
import { InMemoryTaskStore, InMemoryRunStore, createMockStores } from "./fixtures.js";
import { spawnScript, SCRIPT_LOG } from "../adapters/script.js";
import { localShell } from "../sandbox/local-shell.js";

const localSandbox = { provider: "local", network: { mode: "open" }, resources: {}, providerOptions: {}, denied: [] } as never;

describe("script task in a mission document", () => {
  test("a script task needs a command, not a description", () => {
    const doc = parseMissionDocument({ tasks: [{ title: "Converti", script: { command: "python convert.py" } }] });
    expect(doc.tasks[0].script?.command).toBe("python convert.py");
    expect(() => parseMissionDocument({ tasks: [{ title: "Converti", script: { command: "  " } }] }))
      .toThrow("tasks.0.script.command: script task requires a command");
    // any other task still needs its description
    expect(() => parseMissionDocument({ tasks: [{ title: "Scrivi" }] }))
      .toThrow("tasks.0.description: task requires a description");
  });

  test("its command is read from the mission by title; its description says what it runs", () => {
    const data = JSON.stringify({ tasks: [{ title: "A", description: "x" }, { title: "B", script: { command: "make\nmake test" } }] });
    expect(missionTaskScript(data, "B")).toEqual({ command: "make\nmake test" });
    expect(missionTaskScript(data, "A")).toBeUndefined();
    expect(missionTaskScript("not json", "B")).toBeUndefined();
    expect(scriptTaskDescription("make\nmake test")).toBe("Run: make …");
  });
});

describe("a mission with a script task", () => {
  function executor() {
    const store = new InMemoryTaskStore();
    const missions = new Map<string, Mission>();
    const registry = Object.assign(store, {
      saveMission: async (opts: { name: string; data: string }) => {
        const mission = { id: "m1", name: opts.name, data: opts.data, status: "draft", createdAt: "", updatedAt: "" } as Mission;
        missions.set(mission.id, mission);
        return mission;
      },
      getMission: async (id: string) => missions.get(id),
      getMissionByName: async (name: string) => [...missions.values()].find((m) => m.name === name),
      getAllMissions: async () => [...missions.values()],
      updateMission: async (id: string, updates: Partial<Mission>) => Object.assign(missions.get(id)!, updates),
      nextMissionName: async () => "mission-1",
    });
    const config: PolpoConfig = { version: "1", project: "test", teams: [{ name: "team", agents: [{ name: "dev" }] }], tasks: [], settings: { maxRetries: 2, workDir: "/tmp/test", logLevel: "quiet" } };
    const { teamStore, agentStore } = createMockStores(config.teams);
    const tmp = mkdtempSync(join(tmpdir(), "polpo-script-mission-"));
    const ctx = {
      emitter: new TypedEmitter(), registry, runStore: new InMemoryRunStore(), hooks: new HookRegistry(), config, teamStore, agentStore,
      memoryStore: { exists: async () => false, get: async () => "", save: async () => {}, append: async () => {}, update: async () => true },
      workDir: tmp, agentWorkDir: tmp, polpoDir: tmp, assessFn: vi.fn(),
    } as unknown as OrchestratorContext;
    const taskMgr = new TaskManager(ctx);
    const agentMgr = new AgentManager(ctx);
    return { exec: new MissionExecutor(ctx, taskMgr, agentMgr), store, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
  }

  test("runs without an agent: the task is assigned to @script", async () => {
    const h = executor();
    try {
      await h.exec.ready;
      const mission = await h.exec.saveMission({
        name: "dati",
        data: JSON.stringify({ tasks: [
          { title: "Scarica", script: { command: "curl -o data.csv https://example.com/data.csv" } },
          { title: "Analizza", description: "Leggi data.csv", assignTo: "dev", dependsOn: ["Scarica"] },
        ] }),
      });
      await h.exec.executeMission(mission.id);
      const tasks = await h.store.getAllTasks();
      const script = tasks.find((t) => t.title === "Scarica")!;
      expect(script.assignTo).toBe("@script");
      expect(script.description).toBe("Run: curl -o data.csv https://example.com/data.csv");
      expect(tasks.find((t) => t.title === "Analizza")!.dependsOn).toEqual([script.id]);
    } finally {
      h.cleanup();
    }
  });
});

describe("spawning a script task", () => {
  const data = JSON.stringify({ tasks: [{ title: "Raccogli dati", description: "x" }, { title: "Converti", script: { command: "python convert.py" } }] });
  const first = { id: "t1", title: "Raccogli dati", description: "x", assignTo: "dev", missionId: "m1", group: "report (2)", dependsOn: [], status: "done" };
  const script = { id: "t2", title: "Converti", description: "Run: python convert.py", assignTo: "@script", missionId: "m1", group: "report (2)", dependsOn: ["t1"], status: "pending", phase: "execution", maxDuration: 60_000 };

  function harness(missionData: string) {
    const spawned: any[] = [];
    const transitions: string[] = [];
    const getAgent = vi.fn(async () => ({ name: "dev" }));
    const ctx = {
      emitter: new TypedEmitter(),
      polpoDir: "/work/.polpo",
      agentWorkDir: "/work",
      config: { settings: {} },
      hooks: { runBeforeSync: () => ({ cancelled: false }) },
      agentStore: { getAgent },
      memoryStore: { get: async () => "shared memory" },
      sandboxProviders: () => new Set(["local"]),
      listOutputFiles: async () => [],
      spawner: { spawn: async (config: any) => { spawned.push(config); throw new Error("stop after the config"); } },
      registry: {
        transition: async (_id: string, status: string) => { transitions.push(status); },
        updateTask: async () => {},
        getMission: async () => ({ id: "m1", name: "report (2)", data: missionData }),
        getAllTasks: async () => [first, script],
      },
    } as never;
    return { runner: new TaskRunner(ctx), spawned, transitions, getAgent };
  }

  test("the runner gets the command, the folders as environment variables and a deadline; no agent, no context", async () => {
    const h = harness(data);
    const before = Date.now();
    await h.runner.spawnForTask(script as any);
    const config = h.spawned[0];
    expect(h.getAgent).not.toHaveBeenCalled();
    expect(config.agent.name).toBe("@script");
    expect(config.task.description).toBe("Run: python convert.py");
    expect(config.script.command).toBe("python convert.py");
    expect(config.script.env).toEqual({
      POLPO_OUTPUT_DIR: "/work/output/report (2)/02 - Converti",
      POLPO_TASK: "Converti",
      POLPO_MISSION: "report (2)",
      POLPO_DEP_1: "/work/output/report (2)/01 - Raccogli dati",
    });
    expect(config.script.deadline).toBeGreaterThanOrEqual(before + 60_000);
  });

  test("a script task whose command is gone fails with the reason", async () => {
    const h = harness(JSON.stringify({ tasks: [{ title: "Converti", description: "x" }] }));
    await h.runner.spawnForTask(script as any);
    expect(h.spawned).toHaveLength(0);
    expect(h.transitions.at(-1)).toBe("failed");
  });
});

/** Whether a process whose command line contains `text` is still running. */
function leftover(text: string): boolean {
  const out = process.platform === "win32"
    ? spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }"], { encoding: "utf8" }).stdout
    : spawnSync("ps", ["-eo", "args"], { encoding: "utf8" }).stdout;
  return (out ?? "").split(/\r?\n/).some((line) => line.includes(text) && !line.includes("CommandLine"));
}

// The commands below are bash: skip them where the local shell is cmd.exe (Windows without Git).
describe.skipIf(localShell().name === "cmd.exe")("running a script", () => {
  const task = { id: "t1", title: "Converti" } as Task;

  async function run(command: string, opts: { deadline?: number; kill?: boolean } = {}) {
    const root = mkdtempSync(join(tmpdir(), "polpo-script-"));
    const outputDir = join(root, "output", "02 - Converti");
    const transcript: any[] = [];
    const handle = spawnScript(
      { command, env: { POLPO_OUTPUT_DIR: outputDir, POLPO_TASK: "Converti" }, ...(opts.deadline ? { deadline: opts.deadline } : {}) },
      task, root, { polpoDir: join(root, ".polpo"), outputDir, sandbox: localSandbox },
    );
    handle.onTranscript = (entry) => transcript.push(entry);
    if (opts.kill) setTimeout(() => handle.kill(), 300);
    const result = await handle.done;
    const log = existsSync(join(outputDir, SCRIPT_LOG)) ? readFileSync(join(outputDir, SCRIPT_LOG), "utf8") : "";
    const out = existsSync(join(outputDir, "out.txt")) ? readFileSync(join(outputDir, "out.txt"), "utf8") : undefined;
    rmSync(root, { recursive: true, force: true });
    return { handle, result, transcript, log, out };
  }

  test("it writes in its output folder; its output is in script.log, the result and the transcript", async () => {
    const r = await run('echo "ciao da $POLPO_TASK"; echo dati > "$POLPO_OUTPUT_DIR/out.txt"');
    expect(r.result.exitCode).toBe(0);
    expect(r.result.stdout.trim()).toBe("ciao da Converti");
    expect(r.out?.trim()).toBe("dati");
    expect(r.log).toContain("ciao da Converti");
    expect(r.log).toContain("[exit code 0]");
    expect(r.transcript[0]).toMatchObject({ type: "tool_use", tool: "script" });
    expect(r.transcript[1]).toMatchObject({ type: "tool_result", tool: "script", isError: false });
    expect(r.transcript[1].content).toContain("ciao da Converti");
    expect(r.handle.isAlive()).toBe(false);
  });

  test("a non-zero exit code fails the run", async () => {
    const r = await run("echo rotto >&2; exit 3");
    expect(r.result.exitCode).toBe(3);
    expect(r.result.stderr.trim()).toBe("rotto");
    expect(r.log).toContain("[exit code 3]");
    expect(r.transcript.at(-1)).toMatchObject({ type: "error" });
  });

  test("it stops at the task's deadline, with what it started", async () => {
    // not the last command, so bash runs it as a child (msys process group on Windows)
    const r = await run("sleep 23; echo late", { deadline: Date.now() + 1000 });
    expect(r.result.exitCode).not.toBe(0);
    expect(r.result.stderr).toContain("Timed out after 1s");
    expect(r.result.duration).toBeLessThan(10_000);
    expect(leftover("sleep 23")).toBe(false);
  }, 20_000);

  test("killing the run stops the command", async () => {
    const r = await run("sleep 20", { kill: true });
    expect(r.result.exitCode).toBe(1);
    expect(r.log).toContain("[stopped]");
    expect(r.result.duration).toBeLessThan(10_000);
  }, 20_000);

  test("a remote sandbox is refused with the reason", async () => {
    const root = mkdtempSync(join(tmpdir(), "polpo-script-"));
    try {
      const handle = spawnScript({ command: "echo hi", env: {} }, task, root, { polpoDir: join(root, ".polpo"), outputDir: join(root, "out"), sandbox: { provider: "e2b" } as never });
      const result = await handle.done;
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('the "e2b" sandbox is not supported');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
