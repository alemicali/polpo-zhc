/**
 * Coding chats (src/coding/chat-manager.ts): Claude Code / Codex sessions in a worktree, through the
 * CLI engine, as a chat. Fake programs only (in-memory processes speaking stream-json and the Codex
 * app server's JSON-RPC): never the real binaries, never a model.
 *
 * Lifecycle (text deltas, tool calls with diffs and output, results), the approval policy and its
 * round trip (Claude Code's --permission-prompt-tool over Polpo's MCP tool, Codex's approval
 * requests), stop, resume across a restart, cwd = the worktree, the account / ToS guard, the
 * changes panel trigger.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CliAccount, PolpoSettings } from "@polpo-ai/core";
import type { CliLauncher, CliProcess } from "../cli-engine/process.js";
import { CodingChatError, CodingChatManager, memberOf } from "../coding/chat-manager.js";
import type { CodingChatEvent } from "../coding/chat-types.js";
import { classifyCodingAction, classifyCommand } from "../cli-engine/coding-policy.js";
import { editDiff } from "../coding/chat-diff.js";

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const managers: CodingChatManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** An in-memory CLI process: stdout lines pushed by the fake program, stdin lines handed to it. */
class FakeProc implements CliProcess {
  private queue: string[] = [];
  private waiters: Array<(r: IteratorResult<string>) => void> = [];
  private ended = false;
  private exit!: (r: { exitCode: number }) => void;
  private exited = new Promise<{ exitCode: number }>((r) => { this.exit = r; });
  killed = false;
  stderr = "";
  constructor(private onInput: (line: string, p: FakeProc) => void | Promise<void>) {}
  out(o: unknown): void {
    if (this.ended) return;
    const line = typeof o === "string" ? o : JSON.stringify(o);
    const w = this.waiters.shift();
    if (w) w({ value: line, done: false }); else this.queue.push(line);
  }
  end(code = 0): void {
    if (this.ended) return;
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
    this.exit({ exitCode: code });
  }
  lines(): AsyncIterable<string> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (this.queue.length) return Promise.resolve({ value: this.queue.shift()!, done: false });
          if (this.ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise<IteratorResult<string>>((r) => this.waiters.push(r));
        },
      }),
    };
  }
  stderrTail(): string { return this.stderr; }
  async send(line: string): Promise<void> {
    if (this.ended) throw new Error("The CLI's input is closed");
    setImmediate(() => { void this.onInput(line, this); });
  }
  async endInput(): Promise<void> { this.end(0); }
  async kill(): Promise<void> { this.killed = true; this.end(137); }
  wait(): Promise<{ exitCode: number }> { return this.exited; }
}

async function mcpCall(url: string, headers: Record<string, string>, name: string, args: unknown): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.json() as { result: { content: Array<{ text: string }> } };
  return body.result.content.map((c) => c.text).join("");
}

interface Launched { cli: string; args: string[]; cwd: string; env: Record<string, string>; proc: FakeProc }

/** A fake `claude -p` (stream-json): scenarios by prompt; permission prompts go to Polpo's MCP tool as the real one does. */
function fakeClaude(l: Omit<Launched, "proc">, cwd: string): (line: string, p: FakeProc) => Promise<void> {
  const cfg = l.args.indexOf("--mcp-config") >= 0 ? JSON.parse(l.args[l.args.indexOf("--mcp-config") + 1]!).mcpServers.polpo : undefined;
  const ri = l.args.indexOf("--resume");
  const sessionId = ri >= 0 ? l.args[ri + 1]! : "sess-1";
  let init = false;
  const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 };
  const result = (p: FakeProc, text: string, extra: Record<string, unknown> = {}) =>
    p.out({ type: "result", subtype: "success", is_error: false, result: text, session_id: sessionId, total_cost_usd: 0.01, usage, ...extra });
  const permission = async (tool: string, input: Record<string, unknown>, id: string) =>
    JSON.parse(await mcpCall(cfg.url, cfg.headers, "permission_prompt", { tool_name: tool, input, tool_use_id: id })) as { behavior: string; message?: string };
  return async (line, p) => {
    const msg = JSON.parse(line) as { message: { content: string } };
    const text = msg.message.content;
    p.out({ type: "user", message: { role: "user", content: text } }); // --replay-user-messages
    if (!init) { init = true; p.out({ type: "system", subtype: "init", session_id: sessionId, model: "claude-opus-4-5" }); }
    if (text.includes("hello")) {
      p.out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } } });
      p.out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } } });
      await new Promise((r) => setTimeout(r, 60));
      p.out({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } });
      result(p, "Hello");
    } else if (text.includes("edit")) {
      const input = { file_path: join(cwd, "src", "a.ts"), old_string: "const a = 1;\nconst b = 2;", new_string: "const a = 1;\nconst b = 3;" };
      p.out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu-edit", name: "Edit", input }] } });
      const ok = await permission("Edit", input, "tu-edit");
      p.out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-edit", content: ok.behavior === "allow" ? "The file was updated" : "denied", is_error: ok.behavior !== "allow" }] } });
      p.out({ type: "assistant", message: { content: [{ type: "text", text: "Edited." }] } });
      result(p, "Edited.");
    } else if (text.includes("push") || text.includes("test")) {
      const command = text.includes("push") ? "git push --force origin main" : "pnpm test";
      p.out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu-bash", name: "Bash", input: { command } }] } });
      const ok = await permission("Bash", { command }, "tu-bash");
      p.out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-bash", content: ok.behavior === "allow" ? "ran" : ok.message ?? "denied", is_error: ok.behavior !== "allow" }] } });
      p.out({ type: "assistant", message: { content: [{ type: "text", text: ok.behavior === "allow" ? "Done." : "Not pushed." }] } });
      result(p, "ok");
    } else if (text.includes("fail")) {
      result(p, "Invalid API key · Please run /login", { is_error: true, subtype: "error_during_execution" });
    }
    // "hang": nothing more, until it is stopped
  };
}

/** A fake `codex app-server` (JSON-RPC lines): asks to install over the network on "install". */
function fakeCodex(log: { threadStart?: Record<string, unknown>; resume?: Record<string, unknown>; decisions: string[] }): (line: string, p: FakeProc) => Promise<void> {
  const answers = new Map<number, (d: string) => void>();
  return async (line, p) => {
    const m = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, any>; result?: Record<string, any> };
    if (m.method === undefined && m.id !== undefined) { answers.get(m.id)?.(String(m.result?.decision)); return; }
    switch (m.method) {
      case "initialize": p.out({ id: m.id, result: { userAgent: "codex/0.90" } }); return;
      case "thread/start": log.threadStart = m.params; p.out({ id: m.id, result: { thread: { id: "th-1" }, model: "gpt-5.5" } }); return;
      case "thread/resume": log.resume = m.params; p.out({ id: m.id, result: { thread: { id: m.params!.threadId }, model: "gpt-5.5" } }); return;
      case "turn/interrupt": p.out({ id: m.id, result: {} }); p.out({ method: "turn/completed", params: { turn: { id: "turn-1", status: "interrupted" } } }); return;
      case "turn/start": {
        p.out({ id: m.id, result: { turn: { id: "turn-1" } } });
        const text = String(m.params!.input[0].text);
        if (text.includes("install")) {
          p.out({ method: "item/started", params: { item: { type: "commandExecution", id: "c1", command: "npm install left-pad" } } });
          const decision = await new Promise<string>((r) => { answers.set(500, r); p.out({ id: 500, method: "item/commandExecution/requestApproval", params: { itemId: "c1", reason: "needs network" } }); });
          log.decisions.push(decision);
          p.out({ method: "item/completed", params: { item: { type: "commandExecution", id: "c1", command: "npm install left-pad", status: decision === "accept" ? "completed" : "declined", aggregatedOutput: decision === "accept" ? "added 1 package" : "", exitCode: decision === "accept" ? 0 : null } } });
        }
        if (text.includes("hang")) return;
        p.out({ method: "item/agentMessage/delta", params: { itemId: "a1", delta: "All " } });
        p.out({ method: "item/completed", params: { item: { type: "agentMessage", id: "a1", text: "All set." } } });
        p.out({ method: "thread/tokenUsage/updated", params: { tokenUsage: { total: { inputTokens: 300, cachedInputTokens: 100, outputTokens: 40, totalTokens: 340 } } } });
        p.out({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
      }
    }
  };
}

const ada: CliAccount = { id: "ada-max", cli: "claude", computer: "host", configDir: "~/.polpo-cli/claude/ada-max", owner: "ada@example.com" };
const adaCodex: CliAccount = { id: "ada-gpt", cli: "codex", computer: "host", configDir: "~/.polpo-cli/codex/ada-gpt", owner: "ada@example.com" };

function setup(o: { accounts?: CliAccount[]; instanceAuth?: boolean; settings?: Partial<PolpoSettings>; polpoDir?: string; approvalTimeoutMs?: number } = {}) {
  const polpoDir = o.polpoDir ?? tmp("polpo-coding-chats-");
  const worktree = join(polpoDir, "wt", "lisbon-x1");
  mkdirSync(join(worktree, "src"), { recursive: true });
  const launched: Launched[] = [];
  const codexLog = { decisions: [] as string[] } as { threadStart?: Record<string, unknown>; resume?: Record<string, unknown>; decisions: string[] };
  const launch: CliLauncher = async (l) => {
    const proc = new FakeProc(l.cli === "claude" ? fakeClaude(l, l.cwd) : fakeCodex(codexLog));
    launched.push({ ...l, proc });
    return proc;
  };
  const busEvents: Array<{ action: string; status: string }> = [];
  const m = new CodingChatManager({
    polpoDir,
    settings: () => ({ harnesses: { enabled: [], cli: { accounts: o.accounts ?? [ada, adaCodex] } }, ...(o.settings ?? {}) }) as PolpoSettings,
    instanceAuth: () => o.instanceAuth ?? true,
    checkCwd: (cwd) => {
      const p = resolve(cwd);
      if (!p.startsWith(polpoDir)) throw new Error("The worktree must be inside the agent workspace");
      return p;
    },
    launch,
    emit: (e) => busEvents.push({ action: e.action, status: e.status }),
    persistDelayMs: 5,
    ...(o.approvalTimeoutMs ? { approvalTimeoutMs: o.approvalTimeoutMs } : {}),
  });
  managers.push(m);
  return { m, polpoDir, worktree, launched, codexLog, busEvents };
}

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const ADA = { member: "ada@example.com" };

describe("lifecycle (Claude Code, stream-json)", () => {
  it("runs a turn in the worktree with the person's account: text streams in, the result closes it", async () => {
    const { m, worktree, launched, busEvents } = setup();
    const s = m.create({ kind: "claude", cwd: worktree, branch: "lisbon-x1" }, ADA);
    expect(s).toMatchObject({ status: "idle", account: "ada-max", owner: "ada@example.com", cwd: worktree });
    const events: CodingChatEvent[] = [];
    m.subscribe(s.id, (e) => events.push(e));
    m.send(s.id, "hello there", ADA);
    await until(() => events.some((e) => e.type === "message" && e.message.role === "assistant" && e.message.streaming === true && e.message.segments?.[0]?.type === "text" && (e.message.segments[0] as { text: string }).text === "Hello"));
    await m.running(s.id);

    const l = launched[0]!;
    expect(l.cwd).toBe(worktree);
    expect(l.cli).toBe("claude");
    expect(l.args).toEqual(expect.arrayContaining(["-p", "--permission-mode", "default", "--permission-prompt-tool", "mcp__polpo__permission_prompt", "--include-partial-messages", "--strict-mcp-config"]));
    expect(l.args.join(" ")).toContain("Polpo Coding");
    expect(l.env.CLAUDE_CONFIG_DIR).toMatch(/\.polpo-cli\/claude\/ada-max$/);
    expect(l.env.MCP_TOOL_TIMEOUT).toBeTruthy();
    expect(Object.keys(l.env).some((k) => /^ANTHROPIC_|^CLAUDE_CODE_OAUTH/.test(k))).toBe(false);
    expect(l.args).not.toContain("--resume");

    const done = m.get(s.id)!;
    expect(done.status).toBe("idle");
    expect(done.runtimeSessionId).toBe("sess-1");
    expect(done.model).toBe("claude-opus-4-5");
    expect(done.turns).toBe(1);
    expect(done.usage.totalTokens).toBe(170);
    expect(done.messages.map((x) => x.role)).toEqual(["user", "assistant"]);
    const a = done.messages[1]!;
    expect(a).toMatchObject({ streaming: false, segments: [{ type: "text", text: "Hello" }], costUsd: 0.01, model: "claude-opus-4-5" });
    expect(busEvents.map((e) => e.status)).toEqual(expect.arrayContaining(["idle", "running"]));
  });

  it("tool calls become cards: an edit with its diff and output, inside the worktree without asking; the changes panel is told", async () => {
    const { m, worktree } = setup();
    const s = m.create({ kind: "claude", cwd: worktree }, ADA);
    const events: CodingChatEvent[] = [];
    m.subscribe(s.id, (e) => events.push(e));
    m.send(s.id, "please edit the file", ADA);
    await m.running(s.id);
    const done = m.get(s.id)!;
    expect(done.approvals).toEqual([]);
    const tool = done.messages[1]!.segments!.find((x) => x.type === "tool") as { tool: { name: string; state: string; output: string; diff: string } };
    expect(tool.tool).toMatchObject({ name: "Edit", state: "completed", output: "The file was updated" });
    expect(tool.tool.diff).toContain("-const b = 2;");
    expect(tool.tool.diff).toContain("+const b = 3;");
    expect(events).toContainEqual({ type: "files-changed", tool: "Edit" });
  });

  it("a safe command runs on its own (no approval)", async () => {
    const { m, worktree } = setup();
    const s = m.create({ kind: "claude", cwd: worktree }, ADA);
    m.send(s.id, "run the test suite", ADA);
    await m.running(s.id);
    expect(m.get(s.id)!.approvals).toEqual([]);
    expect(m.get(s.id)!.messages[1]!.segments!.some((x) => x.type === "tool" && x.tool.output === "ran")).toBe(true);
  });

  it("a failed sign-in is said in the chat, labelled", async () => {
    const { m, worktree } = setup();
    const s = m.create({ kind: "claude", cwd: worktree }, ADA);
    m.send(s.id, "fail please", ADA);
    await m.running(s.id);
    const done = m.get(s.id)!;
    expect(done).toMatchObject({ status: "error", errorKind: "not-signed-in" });
    expect(done.lastError).toMatch(/not signed in/);
    expect(done.messages[1]).toMatchObject({ errorKind: "not-signed-in" });
  });
});

describe("approvals", () => {
  it("a risky action waits in the chat; approve runs it", async () => {
    const { m, worktree } = setup();
    const s = m.create({ kind: "claude", cwd: worktree }, ADA);
    const events: CodingChatEvent[] = [];
    m.subscribe(s.id, (e) => events.push(e));
    m.send(s.id, "push it", ADA);
    await until(() => m.get(s.id)!.status === "awaiting-approval");
    const ap = m.get(s.id)!.approvals[0]!;
    expect(ap).toMatchObject({ state: "pending", tool: "Bash", category: "git-push", reason: "Force-pushes to a remote", summary: "$ git push --force origin main" });
    expect(m.get(s.id)!.messages[1]!.segments!.some((x) => x.type === "approval" && x.approvalId === ap.id)).toBe(true);
    expect(events.some((e) => e.type === "approval" && e.approval.state === "pending")).toBe(true);
    expect(() => m.resolveApproval(s.id, ap.id, "approve", { member: "bob@example.com" })).toThrow(/only they can use it/);
    m.resolveApproval(s.id, ap.id, "approve", ADA);
    await m.running(s.id);
    const done = m.get(s.id)!;
    expect(done.approvals[0]).toMatchObject({ state: "approved", resolvedBy: "ada@example.com" });
    expect(done.status).toBe("idle");
    expect(done.messages[1]!.segments!.some((x) => x.type === "tool" && x.tool.output === "ran" && x.tool.state === "completed")).toBe(true);
    expect(() => m.resolveApproval(s.id, ap.id, "deny", ADA)).toThrow(/already approved/);
  });

  it("deny tells the program it was refused", async () => {
    const { m, worktree } = setup();
    const s = m.create({ kind: "claude", cwd: worktree }, ADA);
    m.send(s.id, "push it", ADA);
    await until(() => m.get(s.id)!.approvals.length === 1);
    m.resolveApproval(s.id, m.get(s.id)!.approvals[0]!.id, "deny", ADA);
    await m.running(s.id);
    const done = m.get(s.id)!;
    expect(done.approvals[0]!.state).toBe("denied");
    const tool = done.messages[1]!.segments!.find((x) => x.type === "tool") as { tool: { state: string; output: string } };
    expect(tool.tool.state).toBe("error");
    expect(tool.tool.output).toMatch(/denied this in Polpo's chat/);
  });

  it("an approval nobody answers expires as a denial", async () => {
    const { m, worktree } = setup({ approvalTimeoutMs: 50 });
    const s = m.create({ kind: "claude", cwd: worktree }, ADA);
    m.send(s.id, "push it", ADA);
    await m.running(s.id);
    await until(() => m.get(s.id)!.status === "idle");
    expect(m.get(s.id)!.approvals[0]!.state).toBe("expired");
  });

  it("Codex asks before leaving its sandbox: the request waits in the chat, accept goes back to the app server", async () => {
    const { m, worktree, launched, codexLog } = setup();
    const s = m.create({ kind: "codex", cwd: worktree }, ADA);
    expect(s.account).toBe("ada-gpt");
    m.send(s.id, "install left-pad", ADA);
    await until(() => m.get(s.id)!.approvals.length === 1);
    expect(m.get(s.id)!.approvals[0]).toMatchObject({ tool: "shell", category: "network-install", summary: "$ npm install left-pad" });
    m.resolveApproval(s.id, m.get(s.id)!.approvals[0]!.id, "approve", ADA);
    await m.running(s.id);
    expect(codexLog.decisions).toEqual(["accept"]);
    expect(codexLog.threadStart).toMatchObject({ cwd: worktree, approvalPolicy: "on-request", sandbox: "workspace-write" });
    expect(launched[0]!.env.CODEX_HOME).toMatch(/\.polpo-cli\/codex\/ada-gpt$/);
    const done = m.get(s.id)!;
    expect(done.runtimeSessionId).toBe("th-1");
    const segs = done.messages[1]!.segments!;
    expect(segs.find((x) => x.type === "tool")).toMatchObject({ tool: { name: "shell", state: "completed", output: "added 1 package" } });
    expect(segs.filter((x) => x.type === "text")).toEqual([{ type: "text", text: "All set." }]);
    expect(done.usage).toMatchObject({ inputTokens: 200, cacheReadTokens: 100, outputTokens: 40 });
  });
});

describe("stop, steer, resume", () => {
  it("stop ends the turn (pending approvals denied); the conversation stays", async () => {
    const { m, worktree, launched } = setup();
    const s = m.create({ kind: "claude", cwd: worktree }, ADA);
    m.send(s.id, "hang on", ADA);
    await until(() => launched.length === 1 && !!m.get(s.id)!.runtimeSessionId);
    await expect(m.stop(s.id, { member: "bob@example.com" })).rejects.toThrow(/only they can use it/);
    await m.stop(s.id, ADA);
    expect(launched[0]!.proc.killed).toBe(true);
    const done = m.get(s.id)!;
    expect(done.status).toBe("idle");
    expect(done.messages[1]).toMatchObject({ streaming: false, errorKind: "interrupted", error: "Stopped by ada@example.com" });
    expect(m.isLive(s.id)).toBe(false);
  });

  it("a message during a turn steers it", async () => {
    const { m, worktree } = setup();
    const s = m.create({ kind: "codex", cwd: worktree }, ADA);
    m.send(s.id, "hang a bit", ADA);
    await until(() => m.isLive(s.id) && !!m.get(s.id)!.runtimeSessionId);
    expect(m.send(s.id, "also check the docs", ADA).steered).toBe(true);
    expect(m.get(s.id)!.messages.map((x) => [x.role, x.kind ?? ""])).toEqual([["user", "prompt"], ["assistant", ""], ["user", "steer"], ["assistant", ""]]);
    await m.stop(s.id, ADA);
  });

  it("resumes the program's conversation after a restart; a turn cut by a restart is marked", async () => {
    const first = setup();
    const s = first.m.create({ kind: "claude", cwd: first.worktree }, ADA);
    first.m.send(s.id, "hello", ADA);
    await first.m.running(s.id);
    // a turn that was running when the server went down
    const stored = first.m.store.get(s.id)!;
    stored.status = "running";
    stored.messages.push({ id: "m_cut", role: "assistant", ts: new Date().toISOString(), streaming: true, segments: [{ type: "tool", tool: { id: "t", name: "Bash", state: "running" } }] });
    first.m.store.save(stored);

    const again = setup({ polpoDir: first.polpoDir });
    const recovered = again.m.get(s.id)!;
    expect(recovered).toMatchObject({ status: "idle", errorKind: "interrupted" });
    expect(recovered.messages.at(-1)).toMatchObject({ streaming: false, errorKind: "interrupted", segments: [{ type: "tool", tool: { state: "interrupted" } }] });
    again.m.send(s.id, "hello again", ADA);
    await again.m.running(s.id);
    expect(again.launched[0]!.args).toEqual(expect.arrayContaining(["--resume", "sess-1"]));
    expect(again.m.get(s.id)!.turns).toBe(2);
  });
});

describe("account and ToS guard", () => {
  it("someone without an account gets a session that says how to sign in", () => {
    const { m, worktree } = setup();
    const s = m.create({ kind: "claude", cwd: worktree }, { member: "bob@example.com" });
    expect(s).toMatchObject({ status: "error", errorKind: "no-account", owner: "bob@example.com" });
    expect(s.lastError).toMatch(/Settings → Harnesses → CLI accounts.*claude auth login/);
    expect(m.accountFor("claude", { member: "bob@example.com" })).toMatchObject({ code: "NO_CLI_ACCOUNT" });
  });

  it("only the owner talks to a session (it runs on their account)", () => {
    const { m, worktree } = setup();
    const s = m.create({ kind: "claude", cwd: worktree }, ADA);
    expect(() => m.send(s.id, "hi", { member: "bob@example.com" })).toThrow(CodingChatError);
    expect(() => m.send(s.id, "hi", {})).toThrow(/only they can use it/);
  });

  it("an instance that serves customers cannot use a personal sign-in", async () => {
    const { m, worktree } = setup({ settings: { notifications: { channels: { wa: { type: "whatsapp-business" } } } } as Partial<PolpoSettings> });
    const s = m.create({ kind: "claude", cwd: worktree }, ADA);
    expect(s).toMatchObject({ status: "error", errorKind: "not-allowed" });
    expect(s.lastError).toMatch(/serves customers/);
  });

  it("a personal installation (no member sign-in) uses the instance's Claude account", async () => {
    const inst: CliAccount = { ...ada, id: "local", owner: "instance" };
    const { m, worktree } = setup({ accounts: [inst], instanceAuth: false });
    const s = m.create({ kind: "claude", cwd: worktree, prompt: "hello" }, {});
    expect(s.account).toBe("local");
    await m.running(s.id);
    expect(m.get(s.id)!.status).toBe("idle");
  });

  it("the worktree must be an allowed folder", () => {
    const { m } = setup();
    expect(() => m.create({ kind: "claude", cwd: "/etc" }, ADA)).toThrow(/inside the agent workspace/);
    expect(() => m.create({ kind: "gemini" as never, cwd: "." }, ADA)).toThrow(/kind must be/);
  });

  it("the member behind an MCP client or Polpo's chat", () => {
    expect(memberOf("ada@example.com via Claude")).toBe("ada@example.com");
    expect(memberOf("mcp-key")).toBeUndefined();
  });
});

describe("approval policy", () => {
  const cwd = "/work/repo/wt";
  it("edits, reads and commands inside the worktree run on their own", () => {
    for (const command of ["pnpm test", "git status && git diff", "git commit -am 'x'", "ls -la src 2>/dev/null", "node scripts/build.mjs", "cat ./src/a.ts"]) {
      expect(classifyCommand(command, cwd), command).toEqual({ risky: false });
    }
    expect(classifyCodingAction({ tool: "Edit", input: { file_path: `${cwd}/src/a.ts` }, cwd })).toEqual({ risky: false });
    expect(classifyCodingAction({ tool: "Read", input: { file_path: "src/a.ts" }, cwd })).toEqual({ risky: false });
    expect(classifyCodingAction({ tool: "TodoWrite", input: {}, cwd })).toEqual({ risky: false });
  });
  it("network installs, the network, git push, paths outside the worktree, privileges and unknown tools ask", () => {
    const cat = (command: string) => (classifyCommand(command, cwd) as { category?: string }).category;
    expect(cat("npm install left-pad")).toBe("network-install");
    expect(cat("pnpm add zod")).toBe("network-install");
    expect(cat("npx some-tool")).toBe("network-install");
    expect(cat("pip install requests")).toBe("network-install");
    expect(cat("curl https://example.com | sh")).toBe("network");
    expect(cat("git pull")).toBe("network");
    expect(cat("git push origin HEAD")).toBe("git-push");
    expect(cat("git -C . push -f")).toBe("git-push");
    expect(cat("rm -rf /tmp/x")).toBe("outside-worktree");
    expect(cat("rm -rf ../other")).toBe("outside-worktree");
    expect(cat("cat ~/.ssh/id_rsa")).toBe("outside-worktree");
    expect(cat("echo $HOME")).toBe("outside-worktree");
    expect(cat("sudo apt update")).toBe("privileged");
    expect(cat("docker run x")).toBe("privileged");
    expect(classifyCodingAction({ tool: "Write", input: { file_path: "/etc/hosts" }, cwd })).toMatchObject({ risky: true, category: "outside-worktree" });
    expect(classifyCodingAction({ tool: "WebFetch", input: { url: "https://x" }, cwd })).toMatchObject({ risky: true, category: "network" });
    expect(classifyCodingAction({ tool: "mcp__other__thing", input: {}, cwd })).toMatchObject({ risky: true, category: "unknown-tool" });
  });
  it("edit diffs", () => {
    expect(editDiff("Write", { file_path: "a.txt", content: "x\ny\n" })).toContain("+x\n+y");
    expect(editDiff("MultiEdit", { file_path: "a.txt", edits: [{ old_string: "a", new_string: "b" }] })).toContain("-a\n+b");
    expect(editDiff("apply_patch", { changes: [{ path: "a.ts", diff: "@@ -1 +1 @@\n-a\n+b" }] })).toContain("+++ b/a.ts");
    expect(editDiff("Bash", { command: "ls" })).toBeUndefined();
  });
});
