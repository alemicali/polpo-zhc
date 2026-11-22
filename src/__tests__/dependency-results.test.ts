/**
 * A task receives the results of the tasks it depends on: in its prompt at every run (budgeted per
 * dependency and in total), and through task_result / dependency_results (its dependencies and its
 * mission's tasks only). Polpo's engine and the agent harnesses alike.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TaskRunner, fairCap, findTaskInScope, normalizeDependencyResultsSettings, renderDependencyResults, renderTaskResult, resolveDependencies, taskReadScope,
} from "@polpo-ai/core";
import type { Task, TaskOutcome } from "../core/types.js";
import { TypedEmitter } from "../core/events.js";
import { createTestTask } from "./fixtures.js";
import { createTaskResultTools, wantsTaskResultTools } from "../tools/task-result-tools.js";
import { FileTaskStore } from "../stores/file-task-store.js";
import { buildPrompt } from "../adapters/engine.js";

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const textOutcome = (label: string, text: string): TaskOutcome => ({ id: `o-${label}`, type: "text", label, text, producedAt: "2026-11-22T15:47:32Z" });

/** The live spike20 shape: 20 writers, each with one sentence as result and as a text outcome. */
function writers(n = 20, opts: { missionId?: string; group?: string; long?: number } = {}): Task[] {
  return Array.from({ length: n }, (_, i) => {
    const title = `frase-${String(i + 1).padStart(2, "0")}`;
    const sentence = opts.long ? `${title}: ${"onde e gabbiani ".repeat(Math.ceil(opts.long / 16))}`.slice(0, opts.long) : `L'alba ${i + 1} dipinge il porto di rosa.`;
    return createTestTask({
      id: `w${i + 1}`, title, assignTo: `spike-${String(i + 1).padStart(2, "0")}`, status: "done",
      missionId: opts.missionId ?? "m1", group: opts.group ?? "spike20",
      result: { exitCode: 0, stdout: sentence, stderr: "", duration: 30_000 },
      outcomes: [textOutcome(title, sentence)],
    });
  });
}

function finale(deps: Task[], extra: Partial<Task> = {}): Task {
  return createTestTask({ id: "final", title: "frase-finale", assignTo: "spike-final", missionId: "m1", group: "spike20", dependsOn: deps.map((d) => d.id), ...extra });
}

describe("rendering the dependencies' results", () => {
  it("20 short results: every sentence, its agent and status, the text outcome not repeated", () => {
    const deps = writers();
    const section = renderDependencyResults(deps);
    for (const d of deps) {
      expect(section).toContain(d.result!.stdout);
      expect(section).toContain(`"${d.title}" — agent ${d.assignTo} — done — task id ${d.id}`);
    }
    expect(section).toContain(`- text "frase-01": (same as the result above)`);
    // only the intro mentions the marker: nothing was cut
    expect(section.split("…[truncated]")).toHaveLength(2);
    expect(section.startsWith("<dependency-results>")).toBe(true);
  });

  it("long results are cut fairly within the per-task and total budget, with a pointer to task_result", () => {
    const deps = writers(20, { long: 5_000 });
    const section = renderDependencyResults(deps, { perTaskChars: 2_000, totalChars: 20_000 });
    expect(section.length).toBeLessThanOrEqual(20_000);
    expect(section).toContain("…[truncated]");
    expect(section).toContain('task_result({task: "<task id or title>"})');
    // every dependency still has its heading and the beginning of its result
    for (const d of deps) {
      expect(section).toContain(`task id ${d.id}`);
      expect(section).toContain(`${d.title}: onde e gabbiani`);
    }
    // one long dependency alone: capped per task, not by the total
    const one = renderDependencyResults(deps.slice(0, 1), { perTaskChars: 2_000, totalChars: 20_000 });
    expect(one.length).toBeLessThan(2_800);
  });

  it("short results leave their room to a long one", () => {
    const deps = [...writers(5), ...writers(1, { long: 9_000 }).map((t) => ({ ...t, id: "long", title: "long one" }))];
    const section = renderDependencyResults(deps, { perTaskChars: 8_000, totalChars: 9_000 });
    expect(section.length).toBeLessThanOrEqual(9_000);
    const longBlock = section.slice(section.indexOf('"long one"'));
    expect(longBlock.length).toBeGreaterThan(5_000);
    expect(fairCap([10, 20, 1000], 600)).toBe(570);
  });

  it("hundreds of dependencies: those that fit get their results, the rest are listed by title", () => {
    const deps = writers(300, { long: 400 });
    const section = renderDependencyResults(deps, { totalChars: 20_000 });
    expect(section.length).toBeLessThanOrEqual(24_000);
    expect(section).toMatch(/### \d+ more \(no room for their results here: read them with task_result\)/);
    expect(section).toContain("task id w300");
  });

  it("failed dependencies show their error; files are references (path, computer, outcome id); missing ones are named", () => {
    const failed = createTestTask({ id: "f1", title: "fetch data", status: "failed", result: { exitCode: 1, stdout: "", stderr: "HTTP 503 from the API", duration: 5 } });
    const report = createTestTask({
      id: "r1", title: "report", status: "done", result: { exitCode: 0, stdout: "Report ready.", stderr: "", duration: 5 },
      outcomes: [{ id: "o9", type: "file", label: "Report", path: "/home/daytona/out/report.pdf", mimeType: "application/pdf", size: 20480, producedAt: "x" }],
      runs: [{ runId: "x", status: "completed", startedAt: "x", engine: "claude-code", computer: { id: "box-1", kind: "daytona" } } as any],
    });
    const section = renderDependencyResults([failed, report], { missing: ["gone"] });
    expect(section).toContain("Error:\nHTTP 503 from the API");
    expect(section).toContain('- file "Report" (application/pdf, 20 KB): path /home/daytona/out/report.pdf (on computer "box-1") · outcome id o9 · task id r1');
    expect(section).toContain('### Not found\n- "gone"');
  });

  it("settings: only positive numbers are kept", () => {
    expect(normalizeDependencyResultsSettings({ perTaskChars: 500.7, totalChars: -1, other: 1 })).toEqual({ perTaskChars: 500 });
    expect(normalizeDependencyResultsSettings("x")).toBeUndefined();
  });
});

describe("resolving dependencies and the read scope", () => {
  const deps = writers(3);
  const other = createTestTask({ id: "x1", title: "frase-01", missionId: "m2", group: "other", status: "done" });
  const solo = createTestTask({ id: "s1", title: "standalone", status: "done" });
  const sibling = createTestTask({ id: "sib", title: "sibling", missionId: "m1", group: "spike20", status: "pending" });
  const all = [...deps, other, solo, sibling];

  it("by id, and by title within the mission (never another mission's task with the same title)", () => {
    const me = finale(deps, { dependsOn: ["w1", "frase-02", "frase-03", "nope"] });
    const r = resolveDependencies(me, [...all, me]);
    expect(r.tasks.map((t) => t.id)).toEqual(["w1", "w2", "w3"]);
    expect(r.missing).toEqual(["nope"]);
  });

  it("a mission task reads its dependencies and its mission's tasks, not other missions or standalone tasks", () => {
    const me = finale(deps.slice(0, 1));
    const scope = taskReadScope(me, [...all, me]).map((t) => t.id).sort();
    expect(scope).toEqual(["final", "sib", "w1", "w2", "w3"]);
  });

  it("a standalone task reads only its dependencies", () => {
    const me = createTestTask({ id: "me", title: "me", dependsOn: ["s1"] });
    expect(taskReadScope(me, [...all, me]).map((t) => t.id).sort()).toEqual(["me", "s1"]);
  });

  it("finds by id or title, and reports an ambiguous title", () => {
    const twins = [createTestTask({ id: "a", title: "Same" }), createTestTask({ id: "b", title: "same" })];
    expect(findTaskInScope("a", twins).task?.id).toBe("a");
    expect(findTaskInScope("Same", twins).task?.id).toBe("a");
    expect(findTaskInScope("SAME", twins).ambiguous?.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("task_result / dependency_results tools", () => {
  const deps = writers(3, { long: 3_000 });
  const outsider = createTestTask({ id: "x1", title: "secret", missionId: "m2", group: "other", status: "done", result: { exitCode: 0, stdout: "classified", stderr: "", duration: 1 } });
  const me = finale(deps);
  const all = [...deps, outsider, me];
  const tools = createTaskResultTools(me, async () => all);
  const run = (name: string, args: any) => tools.find((t) => t.name === name)!.execute("c1", args);
  const out = (r: any) => r.content[0].text as string;

  it("only for tasks with dependencies or a mission", () => {
    expect(wantsTaskResultTools(me)).toBe(true);
    expect(wantsTaskResultTools(createTestTask({}))).toBe(false);
    expect(tools.map((t) => t.name)).toEqual(["task_result", "dependency_results"]);
  });

  it("reads a dependency in full, by title or id, with paging for long results", async () => {
    const full = out(await run("task_result", { task: "frase-02" }));
    expect(full).toContain(deps[1].result!.stdout);
    expect(full).toContain('- text "frase-02"');
    const paged = renderTaskResult({ ...deps[0], result: { ...deps[0].result!, stdout: "y".repeat(3000) } }, { maxChars: 1000 });
    expect(paged).toContain("…[more: call again with offset 1000]");
    expect(out(await run("task_result", { task: "w3" }))).toContain("task id w3");
  });

  it("refuses a task outside its dependencies and mission", async () => {
    await expect(run("task_result", { task: "x1" })).rejects.toThrow(/not one this task depends on, nor of its mission/);
    await expect(run("task_result", { task: "nothing" })).rejects.toThrow(/No task "nothing"/);
  });

  it("dependency_results lists every dependency with a larger budget than the prompt", async () => {
    const text = out(await run("dependency_results", {}));
    for (const d of deps) expect(text).toContain(d.result!.stdout.slice(0, 2_900));
  });
});

// ── in the run: the orchestrator puts the section in the task's prompt ─────────────

/** Just enough of the orchestrator for spawnForTask: what the spawned runner receives. */
function orchestrator(agent: any, tasks: Task[], settings: Record<string, unknown> = {}) {
  const spawned: any[] = [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const ctx = {
    emitter: new TypedEmitter(),
    polpoDir: "/tmp/polpo-test",
    agentWorkDir: "/tmp/polpo-test/work",
    config: { project: "p", settings },
    hooks: { runBeforeSync: () => ({ cancelled: false }) },
    agentStore: { getAgent: async () => agent },
    memoryStore: { get: async () => "" },
    sandboxProviders: () => new Set(["local"]),
    spawner: { spawn: async (c: any) => { spawned.push(c); return { pid: 4242, configPath: "/tmp/c.json" }; }, isAlive: () => true, kill: () => {} },
    runStore: { upsertRun: async () => {}, getActiveRuns: async () => [], getTerminalRuns: async () => [], deleteRun: async () => {} },
    taskControlStore: { listDirections: async () => [] },
    registry: {
      transition: async (id: string, to: string) => { byId.get(id)!.status = to as never; },
      updateTask: async (id: string, patch: any) => Object.assign(byId.get(id)!, patch),
      getTask: async (id: string) => byId.get(id),
      getAllTasks: async () => tasks,
      getMission: async () => ({ id: "m1", name: "spike20", prompt: "Twenty writers, one final sentence." }),
      setState: async () => {},
    },
  } as never;
  return { runner: new TaskRunner(ctx), spawned };
}

describe("the dependent task's prompt, every engine", () => {
  it("Polpo's engine: the 20 sentences are in the prompt (first run and retry alike)", async () => {
    const deps = writers();
    const me = finale(deps);
    const o = orchestrator({ name: "spike-final", model: "anthropic:claude-sonnet-4-5" }, [...deps, me]);
    await o.runner.spawnForTask(me);
    const prompt = buildPrompt(o.spawned[0].task, true);
    for (const d of deps) expect(prompt).toContain(d.result!.stdout);
    expect(prompt).toContain("<mission-context>");
    expect(prompt.indexOf("<dependency-results>")).toBeLessThan(prompt.indexOf(me.description));
    // a retry: a new run, same section (never stacked on the stored description)
    me.status = "pending";
    await o.runner.spawnForTask(me);
    expect(o.spawned[1].task.description.match(/<dependency-results>/g)).toHaveLength(1);
    expect(me.description).not.toContain("<dependency-results>");
  });

  it("the budget comes from settings.dependencyResults", async () => {
    const deps = writers(20, { long: 4_000 });
    const me = finale(deps);
    const o = orchestrator({ name: "spike-final" }, [...deps, me], { dependencyResults: { perTaskChars: 500, totalChars: 6_000 } });
    await o.runner.spawnForTask(me);
    const desc: string = o.spawned[0].task.description;
    const section = desc.slice(desc.indexOf("<dependency-results>"), desc.indexOf("</dependency-results>"));
    expect(section.length).toBeLessThanOrEqual(6_000);
    expect(section).toContain("…[truncated]");
  });

  it("no dependencies: no section", async () => {
    const me = createTestTask({ id: "solo", title: "solo" });
    const o = orchestrator({ name: "a" }, [me]);
    await o.runner.spawnForTask(me);
    expect(o.spawned[0].task.description).not.toContain("<dependency-results>");
  });
});

describe("Claude Code harness: the prompt and task_result as a host tool", () => {
  it("sends the dependencies' results and offers task_result (reading the task store), not dependency_results", async () => {
    const { spawnHarnessEngine } = await import("../adapters/harness-engine.js");
    const root = tmp("polpo-dep-harness-");
    const polpoDir = join(root, ".polpo");
    mkdirSync(polpoDir, { recursive: true });

    // the tasks as the server stored them (file storage: the runner reads them from .polpo)
    const store = new FileTaskStore(polpoDir);
    const dep = await store.addTask({ title: "frase-01", description: "w", assignTo: "spike-01", dependsOn: [], expectations: [], metrics: [], maxRetries: 1, missionId: "m1", group: "spike20" } as any);
    await store.updateTask(dep.id, { result: { exitCode: 0, stdout: "Le onde sussurrano storie.", stderr: "", duration: 1 }, outcomes: [textOutcome("frase-01", "Le onde sussurrano storie.")] });
    await store.unsafeSetStatus(dep.id, "done", "test");
    const meStored = await store.addTask({ title: "frase-finale", description: "Weave them.", assignTo: "spike-final", dependsOn: [dep.id], expectations: [], metrics: [], maxRetries: 1, missionId: "m1", group: "spike20" } as any);
    const section = renderDependencyResults([(await store.getTask(dep.id))!]);
    const task = { ...meStored, description: `${section}\n\n${meStored.description}`, status: "in_progress" } as Task;

    let spec: any;
    const prompts: string[] = [];
    let toolOutput = "";
    const machine = {
      id: "box", description: "", workDir: root,
      exec: async (c: string) => ({ exitCode: 0, stdout: c.startsWith("for p in") ? "4007" : "", stderr: "" }),
      readFile: async () => null, writeFile: async () => {}, stat: async () => null, list: async () => null, remove: async () => false,
      spawn: async () => { throw new Error("no"); }, portEndpoint: async () => ({ url: "ws://x" }), close: vi.fn(),
    };
    const runtime = {
      harness: "claude-code",
      createSession: async (o: any) => ({
        sessionId: o.sessionId ?? "hs-1", workDir: root, isResume: false,
        turn: async (prompt: string) => {
          prompts.push(prompt);
          toolOutput = await spec.tools.find((t: any) => t.name === "task_result").execute({ task: "frase-01" }, { toolCallId: "c1" });
          return { text: "Done", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, costUsd: 0.001, runtimeSessionId: "cc-1" };
        },
        steer: async () => {}, detach: async () => ({ type: "resume-session", data: {} }), stop: async () => ({ type: "resume-session", data: {} }), destroy: async () => {},
      }),
    };
    const vault = { get: async () => ({ type: "api_key", credentials: { apiKey: "k" } }), set: async () => {}, remove: async () => true, getAllForAgent: async () => ({}), list: async () => [], hasEntries: async () => false, patch: async () => [], renameAgent: async () => {}, removeAgent: async () => {} };
    const handle = spawnHarnessEngine({ name: "spike-final", engine: { harness: "claude-code" } } as any, task, root, { polpoDir, outputDir: join(polpoDir, "output", task.id), vaultStore: vault } as any, {
      settings: () => ({ harnesses: { enabled: ["claude-code"], allowHost: true, "claude-code": { auth: "bedrock", credentialRef: { owner: "ops", service: "bedrock" }, bedrock: { region: "us-east-1" } } } }) as any,
      openMachine: async () => ({ machine: machine as any, computerId: "box", hold: () => () => {} }),
      runtimeFactory: (s) => { spec = s; return runtime as any; },
      recordUsage: async () => {},
    });
    const r = await handle.done;
    expect(r.exitCode).toBe(0);
    expect(prompts[0]).toContain("<dependency-results>");
    expect(prompts[0]).toContain("Le onde sussurrano storie.");
    const names = spec.tools.map((t: any) => t.name);
    expect(names).toContain("task_result");
    expect(names).not.toContain("dependency_results");
    expect(spec.instructions).toContain("task_result");
    expect(toolOutput).toContain('"frase-01" — agent spike-01 — done');
    expect(toolOutput).toContain("Le onde sussurrano storie.");
  });
});
