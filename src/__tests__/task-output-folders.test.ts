import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskRunner, safeFolderName, taskOutputPath, missionOutputPath, taskPosition, bareFileNames } from "@polpo-ai/core";
import { TypedEmitter } from "../core/events.js";
import { buildSystemPrompt } from "../adapters/engine.js";
import { listOutputFiles } from "../core/output-files.js";

describe("output folder names", () => {
  test("a mission run gets one folder, each task a numbered folder named after it", () => {
    const data = JSON.stringify({ tasks: [{ title: "crea una frase" }, { title: "crea il disegno" }] });
    const task = { id: "abcdef123", title: "crea il disegno", group: "diegno-random (4)" };
    expect(taskOutputPath(task, taskPosition(data, task.title))).toBe("output/diegno-random (4)/02 - crea il disegno");
    expect(missionOutputPath("diegno-random (4)")).toBe("output/diegno-random (4)");
    // A task added to the mission later (not in the document) has no number.
    expect(taskOutputPath(task, taskPosition(data, "other"))).toBe("output/diegno-random (4)/crea il disegno");
    expect(taskPosition("not json", "x")).toBeUndefined();
  });

  test("a task outside a mission goes under tasks/, with part of its id (titles may repeat)", () => {
    expect(taskOutputPath({ id: "Xy_12-abcdef", title: "Report" })).toBe("output/tasks/Report - Xy_12-");
  });

  test("file names a description mentions without a folder: deliverables only, once each", () => {
    expect(bareFileNames('Salva in frase.md. Leggi "frase.md" e salva in disegno.svg e città.csv')).toEqual(["frase.md", "disegno.svg", "città.csv"]);
    // A path says where the file goes; source code is not a deliverable; e.g. and domains are not files.
    expect(bareFileNames("edit docs/a.md and src\\b.md, index.ts, e.g. www.example.com")).toEqual([]);
  });

  test("names are valid folders on every platform", () => {
    expect(safeFolderName('a/b\\c:d*e?f"g<h>i|j')).toBe("a-b-c-d-e-f-g-h-i-j");
    expect(safeFolderName("  report.  ")).toBe("report");
    expect(safeFolderName("..")).toBe("untitled");
    expect(safeFolderName("../../etc")).toBe("-..-etc");
    expect(safeFolderName("CON")).toBe("CON_");
    expect(safeFolderName("x".repeat(100))).toHaveLength(60);
    expect(safeFolderName("line\nbreak\ttab")).toBe("line break tab");
  });
});

/** Just enough of the orchestrator for spawnForTask to build the runner config. */
function harness(tasks: any[], missionData: string, files: Record<string, string[]> = {}, existing: string[] = []) {
  const spawned: any[] = [];
  const ctx = {
    emitter: new TypedEmitter(),
    polpoDir: "/work/.polpo",
    agentWorkDir: "/work",
    config: { settings: {} },
    hooks: { runBeforeSync: () => ({ cancelled: false }) },
    agentStore: { getAgent: async () => ({ name: "dev" }) },
    memoryStore: { get: async () => "" },
    sandboxProviders: () => new Set(["local"]),
    listOutputFiles: async (dir: string) => files[dir] ?? [],
    fileExists: async (path: string) => existing.includes(path),
    spawner: { spawn: async (config: any) => { spawned.push(config); throw new Error("stop after the config"); } },
    registry: {
      transition: async () => {},
      updateTask: async () => {},
      getMission: async () => ({ id: "m1", name: "report (2)", data: missionData, prompt: "playbook:report" }),
      getAllTasks: async () => tasks,
    },
  } as never;
  return { runner: new TaskRunner(ctx), spawned };
}

describe("task output folders at run time", () => {
  const data = JSON.stringify({ tasks: [{ title: "Raccogli dati" }, { title: "Scrivi report" }] });
  const first = { id: "t1", title: "Raccogli dati", description: "Salva in dati.md", assignTo: "dev", missionId: "m1", group: "report (2)", dependsOn: [], status: "done", outcomes: [{ id: "o1", type: "file", label: "Extra", path: "/work/extra.md" }] };
  const second = { id: "t2", title: "Scrivi report", description: "Leggi dati.md e scrivi report.md", assignTo: "dev", missionId: "m1", group: "report (2)", dependsOn: ["t1"], status: "pending", phase: "execution" };

  test("the runner gets the task's readable folder, and a dependent task the files of the tasks it depends on", async () => {
    const h = harness([first, second], data, { "/work/output/report (2)/01 - Raccogli dati": ["dati.md", "fonti/roma.txt"] });
    await h.runner.spawnForTask(second as any);
    const config = h.spawned[0];
    expect(config.outputDir).toBe("/work/output/report (2)/02 - Scrivi report");
    expect(config.task.description).toContain("<dependency-outputs>");
    expect(config.task.description).toContain('- "Raccogli dati": output/report (2)/01 - Raccogli dati/ — dati.md, fonti/roma.txt');
    // Registered outside its folder: shown too, so nothing is lost.
    expect(config.task.description).toContain("also registered: /work/extra.md");
    expect(config.task.description).toContain('"read dati.md"');
    expect(config.task.description).toMatch(/Leggi dati\.md e scrivi report\.md$/);
    // Its own folder, with the exact path of the file it must write (dati.md is an input: not listed)
    expect(config.task.description).toContain("Save the files this task produces in its own folder: output/report (2)/02 - Scrivi report/");
    expect(config.task.description).toContain("- output/report (2)/02 - Scrivi report/report.md");
    expect(config.task.description).not.toContain("02 - Scrivi report/dati.md");
  });

  test("a file that already exists in the working directory is a project file, not a new output", async () => {
    const h = harness([], data, {}, ["/work/README.md"]);
    await h.runner.spawnForTask({ ...first, description: "Aggiorna README.md e salva il riepilogo in sintesi.md", status: "pending", phase: "execution" } as any);
    const description = h.spawned[0].task.description;
    expect(description).toContain("- output/report (2)/01 - Raccogli dati/sintesi.md");
    expect(description).not.toContain("01 - Raccogli dati/README.md");
  });

  test("a task without dependencies gets no dependency block; an empty folder says so", async () => {
    const h = harness([first, second], data);
    await h.runner.spawnForTask({ ...first, status: "pending", phase: "execution" } as any);
    expect(h.spawned[0].outputDir).toBe("/work/output/report (2)/01 - Raccogli dati");
    expect(h.spawned[0].task.description).not.toContain("<dependency-outputs>");

    const h2 = harness([first, second], data);
    await h2.runner.spawnForTask(second as any);
    expect(h2.spawned[0].task.description).toContain("01 - Raccogli dati/ (no files)");
  });
});

describe("agent prompt", () => {
  test("names the output folder relative to the working directory and where bare file names go", () => {
    const cwd = join(tmpdir(), "proj");
    const prompt = buildSystemPrompt({ name: "dev" } as any, cwd, undefined, join(cwd, "output", "report (2)", "02 - Scrivi report"));
    expect(prompt).toContain("Your task output directory is: output/report (2)/02 - Scrivi report");
    expect(prompt).toContain("write output/report (2)/02 - Scrivi report/report.md, not report.md");
  });
});

describe("listOutputFiles", () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("lists deliverables with / separators, without offloaded tool outputs; a missing folder is empty", async () => {
    dir = mkdtempSync(join(tmpdir(), "polpo-out-"));
    mkdirSync(join(dir, "img"));
    mkdirSync(join(dir, "tool-output"));
    writeFileSync(join(dir, "b.md"), "b");
    writeFileSync(join(dir, "img", "a.svg"), "<svg/>");
    writeFileSync(join(dir, "tool-output", "bash-1.txt"), "x");
    expect(await listOutputFiles(dir)).toEqual(["b.md", "img/a.svg"]);
    expect(await listOutputFiles(join(dir, "missing"))).toEqual([]);
  });
});
