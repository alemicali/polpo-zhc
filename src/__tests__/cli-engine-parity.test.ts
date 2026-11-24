/**
 * CLI engine parity with the harness engine, with the fake `claude` / `codex` programs
 * (fixtures/fake-*.mjs; no network beyond this machine's loopback, no real account):
 *
 * - Polpo's tools reach the program as the run's MCP server (Claude --mcp-config, Codex
 *   `-c mcp_servers.polpo.*` with the token from the environment) and the calls round-trip to
 *   Polpo's tool executor (outcomes collected, transcript marks them as Polpo tools);
 * - the run is a harness session record (status, tokens), stop from the sessions view kills it;
 * - a remote computer's run streams the protocol to the program's stdin (fake remote driver);
 * - approvals: a tool that needs a person is refused in a task and asked in a chat.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { CliAccount } from "@polpo-ai/core";
import { spawnCliEngine, cliSessionKey, type CliEngineDeps, type OpenedCliMachine } from "../adapters/cli-engine.js";
import { hostCliProcess } from "../cli-engine/process.js";
import { claudeArgs } from "../cli-engine/claude.js";
import { codexArgs } from "../cli-engine/codex.js";
import { openCliToolServer, polpoToolName } from "../cli-engine/tool-server.js";
import { HarnessSessionStore } from "../harness/session-store.js";
import { controlHarnessSession, harnessSessionViews } from "../harness/control.js";
import { liveHarnessSessions } from "../harness/live-sessions.js";
import { forwardToRelay } from "../harness/relay.js";
import type { HarnessHostTool, } from "../harness/types.js";
import type { HarnessMachine } from "../harness/sandbox-session.js";
import type { RemoteProcess } from "../sandbox/remote-adapters.js";

const fixtures = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures");
const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); liveHarnessSessions.clear(); });

function fakeBin(): string {
  const bin = tmp("polpo-fake-bin-");
  for (const [name, file] of [["claude", "fake-claude.mjs"], ["codex", "fake-codex.mjs"]]) {
    writeFileSync(join(bin, name!), `#!/bin/sh\nexec "${process.execPath}" "${join(fixtures, file!)}" "$@"\n`);
    chmodSync(join(bin, name!), 0o755);
  }
  return bin;
}

const ada: CliAccount = { id: "ada-max", cli: "claude", computer: "host", configDir: "~/.polpo-cli/claude/ada-max", owner: "ada@example.com" };
const adaCodex: CliAccount = { id: "ada-gpt", cli: "codex", computer: "host", configDir: "~/.polpo-cli/codex/ada-gpt", owner: "ada@example.com" };

/** A Polpo tool that records its calls (what toHarnessHostTools gives both engines). */
function echoTool(calls: unknown[], extra: Partial<HarnessHostTool> = {}): HarnessHostTool {
  return {
    name: "echo_tool", description: "Echo", inputSchema: { type: "object", properties: { x: { type: "number" } } },
    execute: async (input) => { calls.push(input); return `echo ${(input as { x: number }).x}`; },
    ...extra,
  };
}

function setup(o: { engine?: Record<string, unknown>; tools?: HarnessHostTool[]; accounts?: CliAccount[]; deps?: Partial<CliEngineDeps>; outputDir?: string } = {}) {
  const bin = fakeBin();
  const polpoDir = tmp("polpo-cli-dir-");
  const cwd = tmp("polpo-cli-cwd-");
  const log = join(polpoDir, "fake.log");
  const transcript: any[] = [];
  const settings = { harnesses: { enabled: [], cli: { accounts: o.accounts ?? [ada, adaCodex] } } } as any;
  const deps: CliEngineDeps = {
    settings: () => settings,
    recordUsage: async () => {},
    instanceAuth: () => true,
    launch: async ({ cli, args, cwd: dir, env }) => hostCliProcess(join(bin, cli), args, { cwd: dir, env: { ...env, PATH: `${bin}:${process.env.PATH}`, FAKE_CLI_LOG: log } }),
    ...(o.tools ? { hostTools: async () => ({ tools: o.tools! }) } : {}),
    ...o.deps,
  };
  const agent: any = { name: "dev", engine: o.engine ?? { type: "cli", cli: "claude" } };
  const task = (description: string, id = "t1"): any => ({
    id, title: "Do it", description, assignTo: "dev", dependsOn: [], status: "in_progress", retries: 0, maxRetries: 2, expectations: [], metrics: [],
    createdAt: "", updatedAt: "", requestedBy: "ada@example.com",
  });
  const run = (t: any, extra: any = {}) => {
    const h = spawnCliEngine(agent, t, cwd, { polpoDir, ...(o.outputDir ? { outputDir: o.outputDir } : {}), ...extra }, deps);
    h.onTranscript = (e) => transcript.push(e);
    return h;
  };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { run, task, transcript, calls, polpoDir, cwd, bin, log };
}

describe("Polpo's tools as the run's MCP server", () => {
  it("Claude Code: --mcp-config with a loopback URL and a per-run token; a call round-trips to Polpo's tool", async () => {
    const seen: unknown[] = [];
    const s = setup({ tools: [echoTool(seen)] });
    const h = s.run(s.task('POLPO_TOOL echo_tool {"x":7}'));
    const r = await h.done;
    expect(r).toMatchObject({ exitCode: 0, stdout: "Tool said: echo 7" });
    expect(seen).toEqual([{ x: 7 }]);
    const log = s.calls();
    expect(log.find((c) => c.mcp)?.mcp).toMatchObject({ url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/), hasAuth: true });
    // every tool in the first request, as the harness sets it for a normal tool set
    expect(log.find((c) => "toolSearch" in c)?.toolSearch).toBe("false");
    expect(log.find((c) => c.toolCall)?.result.tools).toEqual(["echo_tool"]);
    const argv = log.find((c) => c.argv?.[0] === "-p").argv as string[];
    expect(argv).toEqual(expect.arrayContaining(["--strict-mcp-config", "--allowedTools=mcp__polpo"]));
    // the transcript names the Polpo tool, marked as one
    expect(s.transcript.find((e) => e.type === "tool_use" && e.host)).toMatchObject({ tool: "echo_tool", input: { x: 7 } });
    // the instructions name Polpo's tools
    expect(argv[argv.indexOf("--append-system-prompt") + 1]).toMatch(/Polpo's tools.*echo_tool/);
  });

  it("Codex: -c mcp_servers.polpo.* before app-server, the token only in the environment", async () => {
    const seen: unknown[] = [];
    const s = setup({ engine: { type: "cli", cli: "codex", effort: "max" }, tools: [echoTool(seen)] });
    const r = await s.run(s.task('POLPO_TOOL echo_tool {"x":3}')).done;
    expect(r).toMatchObject({ exitCode: 0, stdout: "Tool said: echo 3" });
    expect(seen).toEqual([{ x: 3 }]);
    const cfg = s.calls().find((c) => c.config)!;
    expect(cfg.config["mcp_servers.polpo.url"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(cfg.config["mcp_servers.polpo.bearer_token_env_var"]).toBe("POLPO_MCP_TOKEN");
    expect(cfg.config.model_reasoning_effort).toBe("xhigh");
    expect(cfg.token).toBe(true);
    // the token is not on the command line
    expect(JSON.stringify(s.calls().find((c) => c.argv)?.argv)).not.toMatch(/Bearer|POLPO_MCP_TOKEN=/);
    expect(s.transcript.find((e) => e.type === "tool_use" && e.host)).toMatchObject({ tool: "echo_tool" });
  });

  it("the default toolset: register_outcome through MCP becomes the run's outcome", async () => {
    const out = tmp("polpo-cli-out-");
    const s = setup({ outputDir: out });
    const h = s.run(s.task('POLPO_TOOL register_outcome {"type":"text","label":"Summary","text":"All good"}'));
    const r = await h.done;
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/Tool said:/);
    expect(h.outcomes?.[0]).toMatchObject({ type: "text", label: "Summary" });
  });

  it("refuses a wrong token, and tools that need a person when nobody can answer", async () => {
    const seen: unknown[] = [];
    const server = await openCliToolServer({ tools: [echoTool(seen, { approval: "user-approval" })], loopback: true });
    try {
      const post = (auth: string, body: unknown) => fetch(server.localUrl!, {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: auth }, body: JSON.stringify(body),
      });
      expect((await post("Bearer nope", { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
      const call = await (await post(`Bearer ${server.token}`, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo_tool", arguments: { x: 1 } } })).json() as any;
      expect(call.result.isError).toBe(true);
      expect(call.result.content[0].text).toMatch(/did not approve/);
      expect(seen).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("a chat's approval: asked, then the tool runs", async () => {
    const seen: unknown[] = [];
    const asked: string[] = [];
    const server = await openCliToolServer({
      tools: [echoTool(seen, { approval: "user-approval" })], loopback: true,
      approve: async (c) => { asked.push(c.toolName); return { approved: true }; },
    });
    try {
      const res = await fetch(server.localUrl!, {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo_tool", arguments: { x: 2 } } }),
      });
      expect(((await res.json()) as any).result.content[0].text).toBe("echo 2");
      expect(asked).toEqual(["echo_tool"]);
    } finally {
      await server.close();
    }
  });

  it("a remote computer reaches the tools through the relay route (token in the path)", async () => {
    const polpoDir = tmp("polpo-relay-");
    const seen: unknown[] = [];
    const server = await openCliToolServer({ tools: [echoTool(seen)], relay: { polpoDir, publicUrl: "https://polpo.example.com" } });
    try {
      expect(server.publicUrl).toBe(`https://polpo.example.com/api/v1/harness-relay/${server.token}/mcp`);
      const path = `/${server.token}/mcp`;
      const res = await forwardToRelay({
        polpoDir, path,
        request: new Request(`https://polpo.example.com/api/v1/harness-relay${path}`, {
          method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo_tool", arguments: { x: 9 } } }),
        }),
      });
      expect(((await res.json()) as any).result.content[0].text).toBe("echo 9");
      expect(seen).toEqual([{ x: 9 }]);
    } finally {
      await server.close();
    }
    // revoked at the end of the run
    const gone = await forwardToRelay({ polpoDir, path: `/${server.token}/mcp`, request: new Request("https://x/", { method: "POST", body: "{}" }) });
    expect(gone.status).toBe(401);
  });

  it("names: mcp__polpo__x (Claude), polpo.x (Codex)", () => {
    expect(polpoToolName("mcp__polpo__register_outcome")).toBe("register_outcome");
    expect(polpoToolName("polpo.email_send")).toBe("email_send");
    expect(polpoToolName("Write")).toBeUndefined();
    expect(claudeArgs({ effort: "high", maxBudgetUsd: 5 })).toEqual(expect.arrayContaining(["--effort", "high", "--max-budget-usd", "5"]));
    expect(codexArgs([], { config: ["-c", "a=1"] })).toEqual(["-c", "a=1", "app-server"]);
  });
});

describe("harness sessions view", () => {
  it("a CLI run is a harness session record (engine cli), and stop kills a live one", async () => {
    const s = setup({ tools: [] });
    const done = await s.run(s.task("Write out.txt")).done;
    expect(done.exitCode).toBe(0);
    const views = harnessSessionViews(s.polpoDir);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      key: cliSessionKey({ scope: "task", taskId: "t1" }), engine: "cli", cli: "claude", account: "ada-max", harness: "claude-code",
      state: "stopped", turns: 1, runtimeSessionId: "11111111-2222-3333-4444-555555555555", tokens: { input: 100, output: 20 },
    });

    const h = s.run(s.task("SLOW", "t2"));
    await new Promise((r) => setTimeout(r, 700));
    const key = cliSessionKey({ scope: "task", taskId: "t2" });
    expect(harnessSessionViews(s.polpoDir, { key })[0]).toMatchObject({ state: "running", live: true });
    const stopped = await controlHarnessSession({ polpoDir: s.polpoDir, key, action: "stop" });
    expect(stopped.ok).toBe(true);
    expect((await h.done).stderr).toBe("Killed");
    expect(new HarnessSessionStore(s.polpoDir).get(key)?.state).toBe("stopped");
  });

  it("the computer's machine going away (hibernation, rotation) fails the run as retryable", async () => {
    const s = setup({ tools: [] });
    const h = s.run(s.task("SLOW", "t3"));
    await new Promise((r) => setTimeout(r, 700));
    expect(await liveHarnessSessions.beforeVmGoes("host", "memory", "hibernation")).toBe(1);
    const r = await h.done;
    expect(r.exitCode).toBe(1);
    expect(r.retryable).not.toBe(false);
    expect(r.stderr).toMatch(/machine went away during the run \(hibernation\)/);
  });
});

/** A fake remote computer: processes run here, with their input open (as Daytona v2 / E2B with stdin). */
function fakeRemote(bin: string, log: string, seen: { commands: string[]; env: Record<string, string>[] }): OpenedCliMachine {
  const machine = {
    id: "fake-vm", description: "fake", workDir: "/",
    exec: async (command: string) => {
      seen.commands.push(`exec:${command}`);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    readFile: async () => null,
    writeFile: async () => {},
    stat: async () => null,
    list: async () => null,
    remove: async () => false,
    spawn: async (command: string, o: { cwd?: string; env?: Record<string, string>; stdin?: boolean }): Promise<RemoteProcess> => {
      seen.commands.push(command);
      seen.env.push(o.env ?? {});
      const child = spawn("bash", ["-c", command], { cwd: o.cwd, env: { ...process.env, ...o.env, PATH: `${bin}:${process.env.PATH}`, HOME: tmp("polpo-vm-home-"), FAKE_CLI_LOG: log } });
      const toWeb = (s: NodeJS.ReadableStream) => new ReadableStream<Uint8Array>({ start(c) { s.on("data", (d) => c.enqueue(new Uint8Array(d))); s.on("end", () => c.close()); } });
      const exited = new Promise<{ exitCode: number }>((r) => child.on("close", (code) => r({ exitCode: code ?? 137 })));
      return {
        id: String(child.pid), stdout: toWeb(child.stdout!), stderr: toWeb(child.stderr!), wait: () => exited,
        kill: async () => { child.kill("SIGKILL"); await exited; }, detach: () => {},
        ...(o.stdin ? {
          writeStdin: async (d: string) => { await new Promise<void>((ok, fail) => child.stdin!.write(d, (e) => (e ? fail(e) : ok()))); },
          closeStdin: async () => { child.stdin!.end(); },
        } : {}),
      };
    },
    portEndpoint: async () => { throw new Error("no ports"); },
    close: () => {},
  } as unknown as HarnessMachine;
  return { machine, remoteId: () => "vm-1" };
}

describe("remote computer (fake driver)", () => {
  it("runs the CLI with its stdin streamed through the provider's process API (no inbox file), steering included", async () => {
    const remoteAda: CliAccount = { ...ada, id: "ada-vm", computer: "box" };
    const seen = { commands: [] as string[], env: [] as Record<string, string>[] };
    const tools: unknown[] = [];
    let s!: ReturnType<typeof setup>;
    s = setup({
      accounts: [remoteAda],
      tools: [echoTool(tools)],
      deps: {
        launch: undefined,
        openRemote: async () => fakeRemote(s.bin, s.log, seen),
        publicUrl: () => "https://polpo.example.com",
      },
    });
    const sandbox = { provider: "daytona", computer: { id: "box", kind: "daytona" } } as any;
    const h = s.run(s.task("STEER me"), { sandbox });
    const applied: string[][] = [];
    h.onDirectionApplied = (ids) => { applied.push(ids); };
    await new Promise((r) => setTimeout(r, 800));
    h.steer!("use pnpm", "d1");
    const r = await h.done;
    expect(r).toMatchObject({ exitCode: 0, stdout: "Steered: use pnpm" });
    expect(applied).toContainEqual(["d1"]);
    const cmd = seen.commands.find((c) => c.includes("claude"))!;
    expect(cmd).toMatch(/^export CLAUDE_CONFIG_DIR=/);
    expect(cmd).not.toMatch(/tail -n \+1 -f/);
    expect(seen.commands.some((c) => c.includes("polpo-cli-inbox"))).toBe(false);
    // Polpo's tools through the public relay URL; the token never on the command line for Codex (env)
    const mcp = s.calls().find((c) => c.mcp)?.mcp;
    expect(mcp?.url).toMatch(/^https:\/\/polpo\.example\.com\/api\/v1\/harness-relay\/[A-Za-z0-9_-]{43}\/mcp$/);
    expect(h.activity.runContext?.remoteId).toBe("vm-1");
  });
});
