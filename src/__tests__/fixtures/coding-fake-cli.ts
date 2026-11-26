/**
 * Fake Claude Code and Codex programs for the coding chat tests: in-memory processes speaking
 * stream-json and the Codex app server's JSON-RPC. Never the real binaries, never a model.
 */
import { join } from "node:path";
import type { CliLauncher, CliProcess } from "../../cli-engine/process.js";

export type CodexLog = { threadStart?: Record<string, unknown>; resume?: Record<string, unknown>; decisions: string[] };

/** A launcher of fake programs; every start is recorded. */
export function fakeLauncher(): { launch: CliLauncher; launched: Launched[]; codexLog: CodexLog } {
  const launched: Launched[] = [];
  const codexLog: CodexLog = { decisions: [] };
  const launch: CliLauncher = async (l) => {
    const proc = new FakeProc(l.cli === "claude" ? fakeClaude(l, l.cwd) : fakeCodex(codexLog));
    launched.push({ ...l, proc });
    return proc;
  };
  return { launch, launched, codexLog };
}

/** An in-memory CLI process: stdout lines pushed by the fake program, stdin lines handed to it. */
export class FakeProc implements CliProcess {
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

export async function mcpCall(url: string, headers: Record<string, string>, name: string, args: unknown): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.json() as { result: { content: Array<{ text: string }> } };
  return body.result.content.map((c) => c.text).join("");
}

export interface Launched { cli: string; args: string[]; cwd: string; env: Record<string, string>; proc: FakeProc }

/** A fake `claude -p` (stream-json): scenarios by prompt; permission prompts go to Polpo's MCP tool as the real one does. */
export function fakeClaude(l: Omit<Launched, "proc">, cwd: string): (line: string, p: FakeProc) => Promise<void> {
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
    // a conversation this account's config directory does not have (e.g. made with another sign-in)
    if (sessionId.startsWith("gone-")) {
      result(p, `No conversation found with session ID: ${sessionId}`, { is_error: true, subtype: "error_during_execution" });
      return;
    }
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
export function fakeCodex(log: { threadStart?: Record<string, unknown>; resume?: Record<string, unknown>; decisions: string[] }): (line: string, p: FakeProc) => Promise<void> {
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

