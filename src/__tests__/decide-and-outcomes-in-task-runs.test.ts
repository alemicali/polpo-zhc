/**
 * Two task-run gaps of an agent on a remote computer (live: "nina", Codex harness, Daytona):
 *
 * - decide in a task run: the runner process has no decision service ("decisions are not available
 *   on this server"); the tool asks the orchestrator over the notification socket, which decides
 *   with its own service as the run's agent (from the run record), thresholds and uncertain answers
 *   as usual, the decision logged with the task and run as origin. Chats keep the in-process service.
 * - register_outcome of a file in the computer's VM: the task's output directory (under the
 *   protected .polpo) is always allowed, the file is read through the run's workspace and copied to
 *   the output directory on this server, clear errors (not found, too large), repeats are no-ops.
 *
 * Fakes only: no real gateway, no real VM.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FileSystem } from "@polpo-ai/core/filesystem";
import type { AgentConfig, Task } from "@polpo-ai/core";
import { DecisionService, registerDecisionService } from "../decisions/service.js";
import { handleDecideWire, socketDecide } from "../core/decision-bridge.js";
import { startNotificationServer } from "../core/notification.js";
import { buildAgentToolset, collectOutcome } from "../adapters/engine.js";
import { toHarnessHostTools } from "../harness/host-tools.js";
import { createOutcomeTools } from "../tools/outcome-tools.js";
import { protectPolpoDir, setProtectedPaths } from "../tools/path-sandbox.js";

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); setProtectedPaths([]); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const text = (r: any) => (r.content ?? []).map((c: any) => c.text).join("");

const NINA: AgentConfig = { name: "nina", allowedTools: ["read", "decide"] };
const TASK = { id: "task-1", title: "Rank", description: "Rank the leads", assignTo: "nina", status: "in_progress" } as unknown as Task;

/** A decision service whose gateway answers P(yes) = probability. */
function decisionService(polpoDir: string, probability: number) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    model: "typesafe-ai/jev", answers: [{ type: "predicate", name: "lead", probability }], usage: { input_tokens: 10, output_tokens: 1 },
  }), { status: 200 }));
  return new DecisionService({
    polpoDir: () => polpoDir, settings: () => ({ decisionModel: "vercel-ai-gateway:typesafe-ai/jev" }) as never, vault: () => undefined,
    env: () => ({ AI_GATEWAY_API_KEY: "vck_test_key_value" }), fetch: fetchMock as unknown as typeof fetch,
  });
}

const QUESTION = { name: "lead", type: "predicate", instructions: "Is this a good lead?", threshold: 0.8 };

describe("decide in a task run (over the notification socket)", () => {
  async function orchestrator(service: DecisionService | undefined, agent: AgentConfig = NINA) {
    const dir = tmp("polpo-dec-");
    const runs: Record<string, unknown> = {
      "run-1": { agentName: "nina", taskId: "task-1", status: "running" },
      "run-old": { agentName: "nina", taskId: "task-1", status: "completed" },
    };
    const server = startNotificationServer(dir, () => {}, undefined, undefined, undefined, undefined, undefined, undefined,
      (msg) => handleDecideWire(msg, { service, run: async (id) => runs[id] as never, task: async () => TASK, agentFor: async () => agent }));
    await new Promise((r) => server.once("listening", r));
    return { socket: join(dir, "orchestrator.sock"), close: () => new Promise((r) => server.close(r)) };
  }

  async function runnerTools(ctx: Record<string, unknown>, opts: { task?: boolean } = { task: true }) {
    // the runner's own .polpo: no decision service registered in this "process"
    const polpoDir = tmp("polpo-dec-runner-");
    writeFileSync(join(polpoDir, "polpo.json"), JSON.stringify({ project: "t", team: { name: "t", agents: [{ name: "nina" }] }, settings: {} }));
    const ts = await buildAgentToolset({
      agentConfig: NINA, cwd: polpoDir, sandboxProvider: "local", browserProfileDir: join(polpoDir, "bp"), hasExtendedTools: false,
      ...(opts.task ? { task: TASK } : { notifyOrigin: { sessionId: "chat-1" } }), ctx: { polpoDir, ...ctx } as never,
    });
    await ts.connectorManager?.closeAll();
    return { tools: ts.tools, polpoDir };
  }

  it("Polpo's engine: decided by the server's service as the run's agent, uncertain under the threshold, logged with task and run", async () => {
    const serverDir = tmp("polpo-dec-server-");
    const service = decisionService(serverDir, 0.6);
    const orch = await orchestrator(service);
    try {
      const { tools } = await runnerTools({ decide: socketDecide(orch.socket, "run-1"), runId: "run-1" });
      const r = await tools.find((t) => t.name === "decide")!.execute("c1", { state: "ACME, 40 employees", questions: [QUESTION] });
      expect(text(r)).not.toContain("not available");
      expect(text(r)).toContain("lead");
      expect(r.details).toMatchObject({ uncertain: true, calibrated: true });
      const entry = service.store.get((r.details as { decisionId: string }).decisionId)!;
      expect(entry).toMatchObject({ status: "ok", uncertain: true, caller: { kind: "agent", id: "nina", taskId: "task-1", runId: "run-1" } });
      expect(entry.answers[0]).toMatchObject({ name: "lead", value: true, uncertain: true });
    } finally {
      await orch.close();
    }
  });

  it("the server decides who asks (the run record) and refuses runs that are not running or agents without decide", async () => {
    const serverDir = tmp("polpo-dec-server-");
    const service = decisionService(serverDir, 0.95);
    const orch = await orchestrator(service);
    try {
      const ok = await socketDecide(orch.socket, "run-1").decide({ state: "x", questions: [QUESTION] });
      expect(ok).toMatchObject({ ok: true, result: { uncertain: false } });
      expect(await socketDecide(orch.socket, "run-old").decide({ state: "x", questions: [QUESTION] })).toEqual({ ok: false, error: "this run is not running" });
      expect(await socketDecide(orch.socket, "run-nope").decide({ state: "x", questions: [QUESTION] })).toEqual({ ok: false, error: "this run is not running" });
      // validation errors come back as the tool's error
      const bad = await socketDecide(orch.socket, "run-1").decide({ state: "x", questions: [] });
      expect(bad.ok).toBe(false);
    } finally {
      await orch.close();
    }
    const noDecide = await orchestrator(service, { name: "nina", allowedTools: ["read"] });
    try {
      expect(await socketDecide(noDecide.socket, "run-1").decide({ state: "x", questions: [QUESTION] })).toEqual({ ok: false, error: "decide is not among this agent's tools" });
    } finally {
      await noDecide.close();
    }
    const noService = await orchestrator(undefined);
    try {
      expect(await socketDecide(noService.socket, "run-1").decide({ state: "x", questions: [QUESTION] })).toEqual({ ok: false, error: "decisions are not available on this server" });
    } finally {
      await noService.close();
    }
  });

  it("a harness gets decide as a host tool that goes over the socket", async () => {
    const service = decisionService(tmp("polpo-dec-server-"), 0.9);
    const orch = await orchestrator(service);
    try {
      const { tools } = await runnerTools({ decide: socketDecide(orch.socket, "run-1"), runId: "run-1" });
      const host = toHarnessHostTools(tools).find((t) => t.name === "decide")!;
      const out = await host.execute({ state: "ACME", questions: [QUESTION] }, { toolCallId: "h1" } as never);
      expect(out).toMatch(/decision dec_/);
      expect(service.store.list().decisions[0]).toMatchObject({ caller: { kind: "agent", id: "nina", runId: "run-1" } });
    } finally {
      await orch.close();
    }
  });

  it("a chat (server process): the instance's service directly", async () => {
    const { tools, polpoDir } = await runnerTools({}, { task: false });
    const service = decisionService(polpoDir, 0.9);
    registerDecisionService(polpoDir, service);
    const r = await tools.find((t) => t.name === "decide")!.execute("c1", { state: "ACME", questions: [QUESTION] });
    expect(r.details).toMatchObject({ uncertain: false });
    expect(service.store.list().decisions[0]).toMatchObject({ caller: { kind: "agent", id: "nina" } });
  });
});

/** A remote computer's files (the run's workspace), keyed by absolute path. */
function fakeVm(files: Record<string, string | Buffer>): FileSystem {
  const get = (p: string) => files[p];
  return {
    exists: async (p) => get(p) !== undefined,
    stat: async (p) => {
      const f = get(p);
      if (f === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      return { size: Buffer.byteLength(f), isFile: true, isDirectory: false, modifiedAt: new Date() };
    },
    readFile: async (p) => String(get(p)),
    readFileBuffer: async (p) => Buffer.from(get(p)!),
    writeFile: async () => { throw new Error("read-only fake"); },
    readdir: async () => [],
    mkdir: async () => {},
    remove: async () => {},
    rename: async () => {},
  } as FileSystem;
}

describe("register_outcome of a file in a remote computer", () => {
  function setup(files: (p: { project: string; outputDir: string }) => Record<string, string | Buffer>, maxBytes?: number) {
    const project = tmp("polpo-outcome-remote-");
    const polpoDir = join(project, ".polpo");
    const outputDir = join(polpoDir, "output", "task-1");
    mkdirSync(polpoDir, { recursive: true });
    // the runner protects .polpo (as in a real run): the output directory stays reachable
    protectPolpoDir(polpoDir);
    const vm = fakeVm(files({ project, outputDir }));
    const tool = createOutcomeTools(project, undefined, undefined, outputDir, vm, { remote: true, ...(maxBytes ? { maxBytes } : {}) })[0]!;
    return { project, outputDir, tool };
  }

  it("a file in the VM's output directory (relative .polpo/output path): copied to the same path here and registered", async () => {
    const { outputDir, tool } = setup(({ outputDir }) => ({ [join(outputDir, "proposta.md")]: "# Ranking" }));
    const r = await tool.execute("c1", { type: "file", label: "Proposta", path: ".polpo/output/task-1/proposta.md" });
    expect(text(r)).toContain('Outcome registered: "Proposta" (file)');
    const local = join(outputDir, "proposta.md");
    expect(r.details).toMatchObject({ path: local, outcomeType: "file", outcomeSize: 9 });
    expect(readFileSync(local, "utf8")).toBe("# Ranking");
    expect(collectOutcome("register_outcome", r.details as Record<string, unknown>)).toMatchObject({ path: local, type: "file" });
  });

  it("a file elsewhere in the VM's working directory: copied into the output directory", async () => {
    const { project, outputDir, tool } = setup(({ project }) => ({
      [join(project, "research/ranking/a/proposta.md")]: "A",
      [join(project, "research/ranking/b/proposta.md")]: "B",
    }));
    const a = await tool.execute("c1", { type: "file", label: "A", path: "research/ranking/a/proposta.md" });
    const b = await tool.execute("c2", { type: "file", label: "B", path: join(project, "research/ranking/b/proposta.md") });
    expect(a.details).toMatchObject({ path: join(outputDir, "proposta.md"), copiedFrom: join(project, "research/ranking/a/proposta.md") });
    // another file with the same name does not overwrite the first copy
    expect(b.details).toMatchObject({ path: join(outputDir, "proposta-2.md") });
    expect(readFileSync(join(outputDir, "proposta.md"), "utf8")).toBe("A");
    expect(readFileSync(join(outputDir, "proposta-2.md"), "utf8")).toBe("B");
  });

  it("a missing file: a clear error naming the path in the computer", async () => {
    const { project, outputDir, tool } = setup(() => ({}));
    const r = await tool.execute("c1", { type: "file", label: "Ghost", path: "research/ghost.md" });
    expect(text(r)).toBe(`Error: file not found at ${join(project, "research/ghost.md")} in your computer (working directory ${project}). Check the path (ls), write the file there, then register it again.`);
    expect(r.details).toMatchObject({ error: "file_not_found" });
    expect(existsSync(outputDir)).toBe(false);
  });

  it("too large: refused with the size and the limit, nothing copied", async () => {
    const { outputDir, tool } = setup(({ outputDir }) => ({ [join(outputDir, "big.bin")]: Buffer.alloc(2048) }), 1024);
    const r = await tool.execute("c1", { type: "file", label: "Big", path: join(outputDir, "big.bin") });
    expect(text(r)).toMatch(/is too large to register \(2\.0 KB; the limit is 1\.0 KB\)/);
    expect(r.details).toMatchObject({ error: "too_large", size: 2048, limit: 1024 });
    expect(existsSync(join(outputDir, "big.bin"))).toBe(false);
  });

  it("outside the working and output directories: a clear refusal, not a thrown sandbox error", async () => {
    const { tool } = setup(() => ({ "/etc/hosts": "x" }));
    const r = await tool.execute("c1", { type: "file", label: "Hosts", path: "/etc/hosts" });
    expect(text(r)).toMatch(/^Error: cannot register \/etc\/hosts: it is outside the folders deliverables can come from/);
    expect(r.details).toMatchObject({ error: "path_not_allowed" });
  });

  it("registering the same thing again is a no-op (no duplicate outcome)", async () => {
    const { outputDir, tool } = setup(({ outputDir }) => ({ [join(outputDir, "r.md")]: "R" }));
    const first = await tool.execute("c1", { type: "file", label: "R", path: join(outputDir, "r.md") });
    const again = await tool.execute("c2", { type: "file", label: "R again", path: ".polpo/output/task-1/r.md" });
    expect(collectOutcome("register_outcome", first.details as Record<string, unknown>)).toBeDefined();
    expect(text(again)).toMatch(/^Already registered: "R" \(file\)/);
    expect(collectOutcome("register_outcome", again.details as Record<string, unknown>)).toBeUndefined();
    const t1 = await tool.execute("c3", { type: "text", label: "Summary", text: "same" });
    const t2 = await tool.execute("c4", { type: "text", label: "Summary", text: "same" });
    expect(collectOutcome("register_outcome", t1.details as Record<string, unknown>)).toBeDefined();
    expect(collectOutcome("register_outcome", t2.details as Record<string, unknown>)).toBeUndefined();
    expect(dirname(String((first.details as { path: string }).path))).toBe(outputDir);
  });
});
