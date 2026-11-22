/**
 * Agent harness runtime, with the AI SDK HarnessAgent and the machines faked (no network, no
 * provider calls): the sandbox session over a computer's driver, the SDK wrapper (explicit auth,
 * host tools, stream mapping), credentials and env isolation (never this server's ~/.claude or
 * env), and the engine (transcript, usage and cost, outcomes, kill, hibernation detach/resume).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteDriver, RemoteProcess } from "../sandbox/remote-adapters.js";

// ── the AI SDK, mocked: what Polpo hands it, and a scripted stream ─────────────

const sdk = vi.hoisted(() => ({
  claudeCode: [] as any[],
  codex: [] as any[],
  agents: [] as any[],
  sessions: [] as any[],
  parts: [] as any[],
  continued: [] as any[],
}));

vi.mock("@ai-sdk/harness-claude-code", () => ({ createClaudeCode: (s: any) => { sdk.claudeCode.push(s); return { harnessId: "claude-code", settings: s }; } }));
vi.mock("@ai-sdk/harness-codex", () => ({ createCodex: (s: any) => { sdk.codex.push(s); return { harnessId: "codex", settings: s }; } }));
vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    constructor(readonly settings: any) { sdk.agents.push(settings); }
    async createSession(o: any) {
      const s = { sessionId: o.sessionId ?? "hs-1", isResume: !!o.resumeFrom, o, getSessionWorkDir: () => o.sandboxSession.defaultWorkingDirectory,
        detach: async () => ({ type: "resume-session", data: { bridge: { privateKey: "k" } } }), stop: async () => ({ type: "resume-session", data: {} }), destroy: async () => {} };
      sdk.sessions.push(s);
      return s;
    }
    async stream() { const parts = sdk.parts.shift() ?? []; return { fullStream: (async function* () { yield* parts; })() }; }
    async continueStream(o: any) { sdk.continued.push(o); const parts = sdk.parts.shift() ?? []; return { fullStream: (async function* () { yield* parts; })() }; }
    async experimental_steer() {}
  },
}));

const { createHarnessSandboxSession, remoteHarnessMachine, hostHarnessMachine, isolatedHostEnv } = await import("../harness/sandbox-session.js");
const { createSdkHarnessRuntime, mapStreamPart, mapUsage, finishMetadata } = await import("../harness/sdk.js");
const { resolveHarnessAuth, scrubSecrets } = await import("../harness/credentials.js");
const { toHarnessHostTools } = await import("../harness/host-tools.js");
const { liveHarnessSessions } = await import("../harness/live-sessions.js");
const { HarnessSessionStore, HARNESS_VAULT_OWNER } = await import("../harness/session-store.js");
const { controlHarnessSession, harnessSessionViews, killBridgeCommand } = await import("../harness/control.js");
const { spawnHarnessEngine } = await import("../adapters/harness-engine.js");

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
beforeEach(() => { for (const k of Object.keys(sdk) as Array<keyof typeof sdk>) (sdk[k] as unknown[]).length = 0; liveHarnessSessions.clear(); });
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A vault in memory (the store's $harness entries included). */
function memoryVault(seed: Record<string, Record<string, string>> = {}) {
  const m = new Map<string, any>(Object.entries(seed).map(([k, credentials]) => [k, { type: "api_key", credentials }]));
  return {
    m,
    get: async (o: string, s: string) => m.get(`${o}/${s}`),
    set: async (o: string, s: string, e: any) => { m.set(`${o}/${s}`, e); },
    remove: async (o: string, s: string) => m.delete(`${o}/${s}`),
    getAllForAgent: async () => ({}), list: async () => [], hasEntries: async () => false, patch: async () => [], renameAgent: async () => {}, removeAgent: async () => {},
  } as any;
}

// ── sandbox session over a computer's driver ────────────────────────────────

function fakeDriver() {
  const files = new Map<string, Uint8Array>([["/work/notes.txt", new TextEncoder().encode("a\nb\nc")]]);
  const execs: string[] = [];
  const dirsMade = new Set<string>(["/work"]);
  let writeFails = true;
  const d: RemoteDriver & { execs: string[]; files: typeof files } = {
    remoteId: "sbx_1", execs, files,
    exec: async (command) => {
      execs.push(command);
      const stat = /^stat -c '%F\|%s' -- '([^']+)'/.exec(command);
      if (stat) {
        const p = stat[1]!;
        if (files.has(p)) return { exitCode: 0, stdout: `regular file|${files.get(p)!.length}`, stderr: "" };
        if (dirsMade.has(p)) return { exitCode: 0, stdout: "directory|4096", stderr: "" };
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (command.startsWith("find ")) return { exitCode: 0, stdout: "f|notes.txt\nd|src\n", stderr: "" };
      if (command.startsWith("mkdir -p ")) { writeFails = false; return { exitCode: 0, stdout: "", stderr: "" }; }
      return { exitCode: 0, stdout: "x".repeat(50), stderr: "" };
    },
    readFile: async (p) => files.get(p)!,
    writeFile: async (p, data) => { if (writeFails && p.includes("/deep/")) throw new Error("404 parent missing"); files.set(p, data); },
    suspend: async () => {}, resume: async () => {}, destroy: async () => {},
    spawn: async (command, o) => {
      execs.push(`spawn ${command} ${JSON.stringify(o)}`);
      const p: RemoteProcess = {
        id: "proc_9",
        stdout: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("ready")); c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        wait: async () => ({ exitCode: 0 }), kill: async () => { execs.push("kill proc_9"); }, detach: () => { execs.push("detach proc_9"); },
      };
      return p;
    },
    portEndpoint: async (port, o) => ({ url: `wss://${port}-sbx_1.proxy`, headers: { "X-Daytona-Skip-Preview-Warning": "true" }, ...(o?.ttlSeconds ? {} : {}) }),
  };
  return d;
}

describe("harness sandbox session over a computer", () => {
  it("files, run, spawn and the port endpoint map to the computer's driver", async () => {
    const d = fakeDriver();
    const s: any = createHarnessSandboxSession(remoteHarnessMachine({ driver: async () => d, workDir: "/work", label: "nina", portTtlSeconds: 86_400 }), { port: 4003 });
    expect(s).toMatchObject({ id: "nina", defaultWorkingDirectory: "/work", ports: [4003] });
    expect(await s.readTextFile({ path: "notes.txt" })).toBe("a\nb\nc");
    expect(await s.readTextFile({ path: "notes.txt", startLine: 2, endLine: 2 })).toBe("b");
    expect(await s.readTextFile({ path: "missing.txt" })).toBeNull();
    // a missing parent directory is created, then the write is tried again
    await s.writeTextFile({ path: "/work/deep/x.txt", content: "hi" });
    expect(d.execs).toContain("mkdir -p '/work/deep'");
    expect(new TextDecoder().decode(d.files.get("/work/deep/x.txt"))).toBe("hi");
    expect(await s.stat({ path: "notes.txt" })).toEqual({ type: "file", size: 5 });
    expect(await s.listDirectory({ path: "." })).toEqual([{ name: "notes.txt", type: "file" }, { name: "src", type: "directory" }]);
    expect(await s.run({ command: "echo", maxOutputLength: 10 })).toMatchObject({ exitCode: 0, stdout: "x".repeat(10), stdoutLength: 50 });
    const p = await s.spawn({ command: "node bridge.mjs", env: { BRIDGE_WS_PORT: "4003" } });
    expect(p.processId).toBe("proc_9");
    expect(await p.wait()).toEqual({ exitCode: 0 });
    expect(d.execs.some((e) => e.startsWith('spawn node bridge.mjs {"cwd":"/work","env":{"BRIDGE_WS_PORT":"4003"}}'))).toBe(true);
    await expect(s.spawn({ command: "x", stdin: true })).rejects.toThrow(/stdin/);
    expect(await s.getPortEndpoint({ port: 4003, protocol: "ws" })).toEqual({ url: "wss://4003-sbx_1.proxy", headers: { "X-Daytona-Skip-Preview-Warning": "true" } });
    // the machine outlives the session: stop and destroy do nothing; restricted() hides the infra
    await s.stop(); await s.destroy();
    expect(Object.keys(s.restricted())).not.toContain("getPortEndpoint");
  });

  it("a computer without a process API is refused with a clear message", async () => {
    const d = fakeDriver();
    delete (d as any).spawn;
    const s: any = createHarnessSandboxSession(remoteHarnessMachine({ driver: async () => d, workDir: "/work", label: "old" }), { port: 4000 });
    await expect(s.spawn({ command: "x" })).rejects.toThrow(/Daytona v2/);
  });
});

// ── env isolation: never this server's HOME, ~/.claude or credentials ──────────

describe("isolation from this server", () => {
  it("host processes get an isolated HOME and none of the server's credentials", async () => {
    const env = isolatedHostEnv("/iso/home", {
      HOME: "/home/server", PATH: "/usr/bin:/bin", ANTHROPIC_API_KEY: "sk-ant-server", AWS_SECRET_ACCESS_KEY: "aws", AWS_BEARER_TOKEN_BEDROCK: "b",
      CLAUDE_CODE_OAUTH_TOKEN: "oat", OPENAI_API_KEY: "sk-openai", CODEX_HOME: "/home/server/.codex",
    });
    expect(env.HOME).toBe("/iso/home");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/iso/home/.claude");
    expect(env.CODEX_HOME).toBe("/iso/home/.codex");
    expect(Object.keys(env).filter((k) => /ANTHROPIC|AWS|OPENAI|CLAUDE_CODE|TOKEN/.test(k))).toEqual([]);
    expect(Object.values(env).some((v) => v.includes("/home/server"))).toBe(false);

    const home = tmp("polpo-harness-home-");
    const work = tmp("polpo-harness-work-");
    process.env.ANTHROPIC_API_KEY = "sk-ant-leak";
    try {
      const m = hostHarnessMachine({ workDir: work, home });
      const r = await m.exec('printf "%s|%s|%s" "$HOME" "${ANTHROPIC_API_KEY:-none}" "$CLAUDE_CONFIG_DIR"', {});
      expect(r.stdout).toBe(`${home}|none|${home}/.claude`);
      expect((await m.portEndpoint(4100, "ws")).url).toBe("ws://127.0.0.1:4100");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("credentials come from the settings' vault entry only (not this server's env); Bedrock as env, API keys as an explicit auth environment", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-server-env";
    process.env.AWS_BEARER_TOKEN_BEDROCK = "server-bearer";
    try {
      const vault = memoryVault({ "ops/bedrock": { apiKey: "bedrock-key-123" }, "ops/anthropic": { apiKey: "sk-ant-api03-vault" }, "ops/openai": { OPENAI_API_KEY: "sk-openai-vault" }, "ops/oauth": { token: "sk-ant-oat01-subscription" } });
      const settings = (cc: Record<string, unknown>) => ({ enabled: ["claude-code", "codex"] as any, "claude-code": cc as any, codex: { auth: "api-key" as const, credentialRef: { owner: "ops", service: "openai" } } });
      const b = await resolveHarnessAuth({ harness: "claude-code", model: "us.anthropic.claude-haiku-4-5-20251001-v1:0" }, settings({ auth: "bedrock", credentialRef: { owner: "ops", service: "bedrock" }, bedrock: { region: "us-east-1" } }), vault);
      expect(b.auth).toEqual({});
      expect(b.env).toMatchObject({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1", AWS_BEARER_TOKEN_BEDROCK: "bedrock-key-123", IS_SANDBOX: "1", ANTHROPIC_MODEL: "us.anthropic.claude-haiku-4-5-20251001-v1:0", ANTHROPIC_SMALL_FAST_MODEL: "us.anthropic.claude-haiku-4-5-20251001-v1:0" });
      expect(JSON.stringify(b)).not.toMatch(/server-bearer|sk-ant-server-env/);
      const k = await resolveHarnessAuth({ harness: "claude-code" }, settings({ auth: "api-key", credentialRef: { owner: "ops", service: "anthropic" } }), vault);
      expect(k.auth).toEqual({ ANTHROPIC_API_KEY: "sk-ant-api03-vault" });
      const c = await resolveHarnessAuth({ harness: "codex" }, settings({ auth: "api-key", credentialRef: { owner: "ops", service: "anthropic" } }), vault);
      expect(c.auth).toEqual({ OPENAI_API_KEY: "sk-openai-vault" });
      // a subscription token in the entry is refused too
      await expect(resolveHarnessAuth({ harness: "claude-code" }, settings({ auth: "api-key", credentialRef: { owner: "ops", service: "oauth" } }), vault)).rejects.toThrow(/subscription/);
      await expect(resolveHarnessAuth({ harness: "claude-code" }, settings({ auth: "api-key", credentialRef: { owner: "ops", service: "gone" } }), vault)).rejects.toThrow(/missing/);
      expect(scrubSecrets("key bedrock-key-123 here", b.secrets)).toBe("key <redacted> here");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    }
  });
});

// ── the SDK wrapper ────────────────────────────────────────────────────────

describe("SDK wrapper", () => {
  const spec = (o: Record<string, unknown> = {}) => ({
    harness: "claude-code" as const, id: "ada", instructions: "Be brief.", skills: [{ name: "review", description: "Review code", content: "# Review" }],
    permissionMode: "allow-all" as const, maxBudgetUsd: 1.5, maxTurns: 12,
    auth: { auth: {}, env: { CLAUDE_CODE_USE_BEDROCK: "1" }, secrets: [] },
    tools: [{ name: "register_outcome", description: "Register", inputSchema: { type: "object", properties: {} }, execute: async (input: unknown) => ({ got: input }) }],
    ...o,
  });

  it("Claude Code: explicit auth environment, host tools always loaded, no project MCP config, budget and turns", async () => {
    createSdkHarnessRuntime(spec() as any);
    const cc = sdk.claudeCode[0];
    // an object auth: the adapter never reads process.env, ~/.claude or a subscription on this server
    expect(cc.auth).toEqual({});
    expect(typeof cc.auth).toBe("object");
    // tool search off: host tools (register_outcome) are in the first request, no ToolSearch lookup
    expect(cc.env).toEqual({ CLAUDE_CODE_USE_BEDROCK: "1", ENABLE_TOOL_SEARCH: "false" });
    expect(cc.toolHints).toEqual({ register_outcome: { alwaysLoad: true } });
    expect(cc).toMatchObject({ strictMcpConfig: true, maxBudgetUsd: 1.5, maxTurns: 12, thinking: { type: "disabled" } });
    const agent = sdk.agents[0];
    expect(agent).toMatchObject({ id: "ada", instructions: "Be brief.", permissionMode: "allow-all", sandboxConfig: { workDir: "." } });
    expect(agent.skills).toEqual([{ name: "review", description: "Review code", content: "# Review" }]);
    expect(await agent.tools.register_outcome.execute({ a: 1 }, { toolCallId: "c1" })).toEqual({ got: { a: 1 } });
  });

  it("Claude Code tool search: off for a normal tool set, auto for a very large one; an explicit env wins", () => {
    const many = Array.from({ length: 41 }, (_, i) => ({ name: `t${i}`, description: "x", inputSchema: { type: "object", properties: {} }, execute: async () => "ok" }));
    createSdkHarnessRuntime(spec({ tools: many }) as any);
    expect(sdk.claudeCode[0].env.ENABLE_TOOL_SEARCH).toBe("auto");
    createSdkHarnessRuntime(spec({ auth: { auth: {}, env: { ENABLE_TOOL_SEARCH: "true" }, secrets: [] } }) as any);
    expect(sdk.claudeCode[1].env.ENABLE_TOOL_SEARCH).toBe("true");
  });

  it("Codex: the API key as an explicit auth environment", () => {
    createSdkHarnessRuntime(spec({ harness: "codex", auth: { auth: { OPENAI_API_KEY: "sk" }, env: {}, secrets: [] }, effort: "low" }) as any);
    expect(sdk.codex[0]).toMatchObject({ auth: { OPENAI_API_KEY: "sk" }, reasoningEffort: "low" });
  });

  it("maps stream parts, usage and the runtime's cumulative cost per turn; denies approvals by default", async () => {
    const runtime = createSdkHarnessRuntime(spec() as any);
    const session = await runtime.createSession({ sandbox: { id: "x", defaultWorkingDirectory: "/w", ports: [4000] } as any });
    const finish = (cost: number, input: number) => ({ type: "finish", finishReason: "stop", totalUsage: { inputTokens: input, inputTokenDetails: { cacheReadTokens: 8, cacheWriteTokens: 1 }, outputTokens: 2, totalTokens: input + 2 }, providerMetadata: { "claude-code": { costUsd: cost, sessionId: "cc-1" } } });
    sdk.parts.push([
      { type: "text-delta", text: "Hel" }, { type: "text-delta", text: "lo" }, { type: "text-end" },
      { type: "tool-call", toolCallId: "t1", toolName: "Write", input: { file_path: "/w/a.txt" } },
      { type: "tool-result", toolCallId: "t1", toolName: "Write", output: "ok" },
      { type: "tool-call", toolCallId: "t2", toolName: "register_outcome", input: {} },
      { type: "tool-approval-request", approvalId: "ap1", toolCall: { toolCallId: "t3", toolName: "Bash", input: { command: "rm -rf /" } } },
    ]);
    sdk.parts.push([finish(0.02, 10)]);
    const events: any[] = [];
    const r = await session.turn("go", { onEvent: (e) => events.push(e) });
    expect(events.map((e) => e.type)).toEqual(["text", "tool-call", "tool-result", "tool-call", "tool-approval-request"]);
    expect(events[0]).toEqual({ type: "text", text: "Hello" });
    expect(events[1]).toMatchObject({ toolName: "Write", host: false });
    expect(events[3]).toMatchObject({ toolName: "register_outcome", host: true });
    expect(sdk.continued[0].toolApprovalContinuations).toEqual([{ type: "tool-approval-response", approvalId: "ap1", approved: false, reason: expect.any(String) }]);
    expect(r).toMatchObject({ text: "Hello", costUsd: 0.02, runtimeSessionId: "cc-1", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 8, cacheWriteTokens: 1, totalTokens: 12 } });
    // Claude Code reports a cumulative cost: the second turn costs the difference
    sdk.parts.push([finish(0.03, 5)]);
    expect((await session.turn("again", { onEvent: () => {} })).costUsd).toBeCloseTo(0.01);
    // the cumulative cost travels with the resume state
    expect(await session.detach()).toMatchObject({ polpoCostUsd: 0.03 });
    expect(mapUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 });
    expect(finishMetadata({ providerMetadata: { codex: { threadId: "th" } } })).toEqual({ runtimeSessionId: "th" });
    expect(mapStreamPart({ type: "tool-error", toolCallId: "x", toolName: "y", error: new Error("boom") }, new Set())).toEqual({ type: "tool-result", toolCallId: "x", toolName: "y", output: "boom", isError: true });
  });

  it("host tools: Polpo's tools without the runtime's own; side-effect tools ask a person in chats", () => {
    const t = (name: string) => ({ name, label: name, description: name, parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: `${name} ran` }], details: {} }) }) as any;
    const tools = toHarnessHostTools([t("bash"), t("read"), t("vault_get"), t("email_send"), t("register_outcome"), t("list_email_accounts")], { interactive: true });
    expect(tools.map((x) => x.name)).toEqual(["email_send", "register_outcome", "list_email_accounts"]);
    expect(tools.find((x) => x.name === "email_send")!.approval).toBe("user-approval");
    expect(tools.find((x) => x.name === "list_email_accounts")!.readOnly).toBe(true);
    expect(toHarnessHostTools([t("email_send")])[0]!.approval).toBeUndefined();
  });
});

// ── the engine ─────────────────────────────────────────────────────────────

describe("harness engine (tasks)", () => {
  const settings = {
    harnesses: { enabled: ["claude-code"], allowHost: true, "claude-code": { auth: "bedrock", credentialRef: { owner: "ops", service: "bedrock" }, bedrock: { region: "us-east-1" } } },
  } as any;
  const task = { id: "t1", title: "Write notes", description: "Create notes.txt", expectations: [], status: "in_progress" } as any;
  const agent = { name: "ada", role: "dev", engine: { harness: "claude-code", maxBudgetUsd: 2 } } as any;

  function setup(turns: Array<(session: any, onEvent: (e: any) => void, spec: any) => Promise<any>>, machineOpts: { remoteId?: () => string } = {}, runAgent: any = agent) {
    const root = tmp("polpo-harness-engine-");
    const polpoDir = join(root, ".polpo");
    mkdirSync(polpoDir, { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "Use tabs.");
    const vault = memoryVault({ "ops/bedrock": { apiKey: "bedrock-secret-xyz" } });
    const machineExec: string[] = [];
    const created: any[] = [];
    const usage: any[] = [];
    let spec: any;
    let n = 0;
    const machine = {
      id: "nina", description: "", workDir: root,
      exec: async (c: string) => { machineExec.push(c); return { exitCode: 0, stdout: c.startsWith("for p in") ? "4007" : "", stderr: "" }; },
      readFile: async (p: string) => (p.endsWith("AGENTS.md") ? new TextEncoder().encode("Use tabs.") : null),
      writeFile: async () => {}, stat: async () => null, list: async () => null, remove: async () => false,
      spawn: async () => { throw new Error("no"); }, portEndpoint: async () => ({ url: "ws://x" }), close: vi.fn(),
    };
    const runtime = {
      harness: "claude-code",
      createSession: async (o: any) => {
        created.push(o);
        const s: any = {
          sessionId: o.sessionId ?? "hs-1", workDir: root, isResume: !!o.resumeFrom,
          turn: async (prompt: string, x: any) => { s.prompts = [...(s.prompts ?? []), prompt]; return turns[n++]!(s, x.onEvent, spec); },
          steer: async () => {}, detach: vi.fn(async () => ({ type: "resume-session", data: { bridge: { privateKey: "secret-key" } } })),
          stop: vi.fn(async () => ({ type: "resume-session", data: {} })), destroy: async () => {},
        };
        return s;
      },
    };
    const transcript: any[] = [];
    const handle = spawnHarnessEngine(runAgent, task, root, { polpoDir, outputDir: join(polpoDir, "output", "t1"), vaultStore: vault } as any, {
      settings: () => settings,
      openMachine: async () => ({ machine: machine as any, computerId: "nina", hold: () => () => {}, ...machineOpts }),
      runtimeFactory: (s) => { spec = s; return runtime as any; },
      recordUsage: async (r) => { usage.push(r); },
    });
    handle.onTranscript = (e) => transcript.push(e);
    return { handle, transcript, usage, created, machineExec, vault, polpoDir, getSpec: () => spec };
  }

  const done = (text: string, cost = 0.05) => ({ text, finishReason: "stop", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 5, totalTokens: 120 }, costUsd: cost, runtimeSessionId: "cc-1" });

  it("runs the task: transcript, activity, Polpo tools as host tools, outcomes, usage and cost", async () => {
    const env = setup([async (_s, onEvent, spec) => {
      onEvent({ type: "text", text: "Writing notes. key=bedrock-secret-xyz" });
      onEvent({ type: "tool-call", toolCallId: "c1", toolName: "Write", input: { file_path: "notes.txt" }, host: false });
      onEvent({ type: "tool-result", toolCallId: "c1", toolName: "Write", output: "ok", isError: false });
      onEvent({ type: "text", text: "All done" });
      // the runtime calls a Polpo tool: it runs here
      const outcome = spec.tools.find((t: any) => t.name === "register_outcome");
      await outcome.execute({ type: "text", label: "Summary", text: "done" }, { toolCallId: "c2" });
      return done("All done");
    }]);
    const r = await env.handle.done;
    expect(r).toMatchObject({ exitCode: 0, stdout: "All done" });
    const spec = env.getSpec();
    expect(spec.auth.env).toMatchObject({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1" });
    expect(spec.maxBudgetUsd).toBe(2);
    expect(spec.permissionMode).toBe("allow-all");
    expect(spec.tools.map((t: any) => t.name)).not.toContain("bash");
    expect(spec.instructions).toMatch(/Use tabs\./);
    // pnpm for the bootstrap, then a free port for the bridge
    expect(env.machineExec[0]).toMatch(/corepack prepare pnpm@10\.30\.1/);
    expect(env.created[0].sandbox.ports).toEqual([4007]);
    expect(env.handle.activity).toMatchObject({ toolCalls: 1, filesCreated: ["notes.txt"], totalTokens: 120 });
    expect(env.handle.outcomes).toEqual([expect.objectContaining({ type: "text", label: "Summary" })]);
    expect(env.usage).toEqual([expect.objectContaining({ source: "agent_harness", cost: 0.05, totalTokens: 120, sessionId: "t1" })]);
    // secrets never reach the transcript
    expect(JSON.stringify(env.transcript)).not.toContain("bedrock-secret-xyz");
    expect(env.transcript.find((e) => e.type === "assistant").text).toContain("<redacted>");
    // the runtime stopped at the end, its state kept for a continuation (in the vault, $harness)
    const status = new HarnessSessionStore(env.polpoDir).get("task:t1")!;
    expect(status).toMatchObject({ state: "stopped", resumable: true, turns: 1, costUsd: 0.05, runtimeSessionId: "cc-1", computerId: "nina" });
    expect(env.vault.m.has(`${HARNESS_VAULT_OWNER}/task:t1`)).toBe(true);
    expect(JSON.stringify(status)).not.toContain("privateKey");
  });

  it("reports where and with what it ran (session, VM, cost) and the runtime's lower-case tool names as file activity; Polpo tools marked host", async () => {
    const env = setup([async (_s, onEvent) => {
      // the AI SDK harness reports Claude Code's tools in lower case (as on lumea)
      onEvent({ type: "tool-call", toolCallId: "c1", toolName: "write", input: { file_path: "hello.txt", content: "ciao" }, host: false });
      onEvent({ type: "tool-result", toolCallId: "c1", toolName: "write", output: { type: "create" }, isError: false });
      onEvent({ type: "tool-call", toolCallId: "c2", toolName: "edit", input: { file_path: "notes.txt" }, host: false });
      onEvent({ type: "tool-call", toolCallId: "c3", toolName: "register_outcome", input: { type: "text", label: "hello" }, host: true });
      return done("ok", 0.03);
    }, async () => done("again", 0.02)], { remoteId: () => "vm-7" });
    env.handle.followUp("one more");
    await env.handle.done;
    expect(env.handle.activity).toMatchObject({ filesCreated: ["hello.txt"], filesEdited: ["notes.txt"], toolCalls: 3 });
    expect(env.transcript.filter((e) => e.type === "tool_use").map((e) => [e.tool, !!e.host])).toEqual([["write", false], ["edit", false], ["register_outcome", true]]);
    expect(env.transcript.find((e) => e.type === "usage")).toMatchObject({ harness: "claude-code", inputTokens: 100, costUsd: 0.03 });
    expect(env.handle.activity.runContext).toMatchObject({
      remoteId: "vm-7",
      session: { resumed: false, bootstrapMs: expect.any(Number), sessionId: "hs-1" },
      cost: { tokens: 240, harnessUsd: 0.05 },
    });
    expect(JSON.stringify(env.handle.activity.runContext)).not.toContain("bedrock-secret-xyz");
  });

  it("register_outcome is a host tool even when the agent's allowedTools omit it", async () => {
    const env = setup([async () => done("ok")], {}, { ...agent, allowedTools: ["read", "write", "bash"] });
    await env.handle.done;
    const names = env.getSpec().tools.map((t: any) => t.name);
    expect(names).toContain("register_outcome");
    expect(env.getSpec().instructions).toMatch(/Polpo's tools[^\n]*register_outcome/);
  });

  it("hibernation between turns: detaches (resume state in the vault), then the next turn resumes on the new VM", async () => {
    let env: ReturnType<typeof setup>;
    env = setup([
      async () => { env.handle.followUp!("now add a second line"); return done("first"); },
      async (s) => { expect(s.isResume).toBe(true); return done("second", 0.01); },
    ]);
    // the computer hibernates while the engine accounts for turn 1 (no turn running)
    const record = env.usage.push.bind(env.usage);
    env.usage.push = (r: any) => { void liveHarnessSessions.beforeVmGoes("nina", "memory", "idle"); return record(r); };
    const r = await env.handle.done;
    expect(r).toMatchObject({ exitCode: 0, stdout: "second" });
    expect(env.created).toHaveLength(2);
    expect(env.created[1]).toMatchObject({ sessionId: "hs-1", resumeFrom: { type: "resume-session", data: { bridge: { privateKey: "secret-key" } } } });
    const status = new HarnessSessionStore(env.polpoDir).get("task:t1")!;
    expect(status.lastDetachAt).toBeTruthy();
    expect(status.lastResumeAt).toBeTruthy();
    expect(status.turns).toBe(2);
    expect(env.transcript.some((e) => /detached \(computer idle\)/.test(e.message ?? ""))).toBe(true);
  });

  it("a forced rotation under a running turn: re-attaches and continues once", async () => {
    let env: ReturnType<typeof setup>;
    env = setup([
      async () => { await liveHarnessSessions.beforeVmGoes("nina", "memory", "rotate"); throw new Error("bridge connection lost"); },
      async (s) => { expect(s.isResume).toBe(true); expect(s.prompts[0]).toMatch(/interrupted because the machine was moved/); return done("recovered"); },
    ]);
    const r = await env.handle.done;
    expect(r).toMatchObject({ exitCode: 0, stdout: "recovered" });
    expect(env.created).toHaveLength(2);
  });

  it("a rotation by another process (the VM changed under the turn): re-attaches and continues once", async () => {
    let vm = "sbx_1";
    let env: ReturnType<typeof setup>;
    env = setup([
      async () => { vm = "sbx_2"; throw new Error("bridge connection lost"); },
      async (s) => { expect(s.isResume).toBe(true); return done("recovered"); },
    ], { remoteId: () => vm });
    expect(await env.handle.done).toMatchObject({ exitCode: 0, stdout: "recovered" });
    expect(env.transcript.some((e) => /VM sbx_1 replaced by sbx_2/.test(e.message ?? ""))).toBe(true);
    // without a replacement the error is the run's
    const env2 = setup([async () => { throw new Error("model refused"); }], { remoteId: () => "sbx_1" });
    expect(await env2.handle.done).toMatchObject({ exitCode: 1, stderr: "model refused" });
  });

  it("kill aborts the run; a refused engine fails with the reason, before any machine work", async () => {
    let env: ReturnType<typeof setup>;
    env = setup([async () => { env.handle.kill(); throw new Error("aborted"); }]);
    expect(await env.handle.done).toMatchObject({ exitCode: 1, stderr: "Killed" });
    const bad = spawnHarnessEngine({ ...agent, engine: { harness: "codex" } }, task, tmp("polpo-x-"), { polpoDir: tmp("polpo-y-") } as any, { settings: () => settings });
    expect(await bad.done).toMatchObject({ exitCode: 1, stderr: expect.stringMatching(/Codex is not enabled/) });
  });

  it("status, stop and reset of a parked session (its bridge in the VM ended by its port)", async () => {
    const env = setup([async () => done("ok")]);
    await env.handle.done;
    expect(harnessSessionViews(env.polpoDir, { agent: "ada" })).toEqual([expect.objectContaining({ key: "task:t1", live: false, liveHere: false })]);
    const ran: string[] = [];
    const stop = await controlHarnessSession({ polpoDir: env.polpoDir, vault: env.vault, key: "task:t1", action: "stop", onComputer: async (id, c) => { ran.push(`${id}: ${c}`); return true; } });
    expect(stop).toMatchObject({ ok: true });
    expect(ran[0]).toBe(`nina: ${killBridgeCommand(4007)}`);
    const reset = await controlHarnessSession({ polpoDir: env.polpoDir, vault: env.vault, key: "task:t1", action: "reset" });
    expect(reset).toMatchObject({ ok: true });
    expect(env.vault.m.has(`${HARNESS_VAULT_OWNER}/task:t1`)).toBe(false);
    expect(harnessSessionViews(env.polpoDir)).toEqual([]);
    expect(await controlHarnessSession({ polpoDir: env.polpoDir, key: "task:nope", action: "stop" })).toMatchObject({ ok: false, status: 404 });
  });
});
