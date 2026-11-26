/**
 * Codex through its app server (`codex app-server`): JSON-RPC 2.0 over stdio, one JSON object per
 * line, without the "jsonrpc" field (https://github.com/openai/codex/tree/main/codex-rs/app-server).
 *
 *   → initialize { clientInfo }            ← { userAgent, … }        → initialized (notification)
 *   → thread/start { cwd, model?, approvalPolicy: "never", sandbox, developerInstructions }
 *   → thread/resume { threadId }           (a continuation)
 *   → turn/start { threadId, input: [{ type: "text", text }] }  ← { turn: { id } }
 *   → turn/steer { threadId, expectedTurnId, input }            (a direction during the turn)
 *   → turn/interrupt { threadId, turnId }
 *   ← item/started, item/completed { item: agentMessage | reasoning | commandExecution | fileChange | mcpToolCall | webSearch … }
 *   ← thread/tokenUsage/updated { tokenUsage: { total, last } }, error { error, willRetry }
 *   ← turn/completed { turn: { id, status: completed | interrupted | failed, error? } }
 *
 * The program never asks for approval (approvalPolicy "never"); a request it sends anyway is
 * declined.
 */
import type { CliPermissionMode, HarnessEffort } from "@polpo-ai/core";
import type { CliProcess } from "./process.js";
import { ZERO_USAGE, type CliEvent, type CliSession, type CliTurnEnd, type CliUsage } from "./types.js";

export const CODEX_SANDBOX_MODES: Record<CliPermissionMode, string> = {
  "allow-all": "danger-full-access",
  "allow-edits": "workspace-write",
  "allow-reads": "read-only",
};

/** Polpo's effort levels as Codex's model_reasoning_effort ("max" is Codex's "xhigh"). */
export const CODEX_EFFORTS: Record<HarnessEffort, string> = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" };

/**
 * `codex [-c overrides] app-server [extra]`: `config` are root config overrides (Polpo's MCP
 * server, the effort), which the app server takes like every subcommand.
 */
export function codexArgs(extra: string[] = [], o: { config?: string[]; effort?: HarnessEffort } = {}): string[] {
  const config = [...(o.config ?? [])];
  if (o.effort) config.push("-c", `model_reasoning_effort=${JSON.stringify(CODEX_EFFORTS[o.effort])}`);
  return [...config, "app-server", ...extra];
}

type Json = Record<string, unknown>;

class RpcError extends Error {
  constructor(message: string, readonly code?: number) { super(message); this.name = "CodexRpcError"; }
}

/** A JSON-RPC peer over a CLI process's lines. */
export class CodexRpc {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(method: string, params: Json) => void>();
  readonly done: Promise<void>;
  private closed = false;
  /**
   * Answers the server's approval requests (`…/requestApproval`): set by a session that asks a
   * person (coding chats); without it every request is declined (unattended runs).
   */
  approvals?: (method: string, params: Json) => Promise<"accept" | "decline">;

  constructor(private proc: CliProcess) {
    this.done = (async () => {
      for await (const line of proc.lines()) this.onLine(line);
    })().catch(() => undefined).finally(async () => {
      this.closed = true;
      const { exitCode } = await proc.wait();
      const err = new RpcError(proc.stderrTail().trim() || `Codex exited (code ${exitCode})`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      for (const l of this.listeners) l("$exit", { message: err.message });
    });
  }

  private onLine(line: string): void {
    const t = line.trim();
    if (!t.startsWith("{")) return;
    let m: Json;
    try { m = JSON.parse(t) as Json; } catch { return; }
    const id = m.id;
    if (typeof m.method === "string") {
      if (id !== undefined && id !== null) {
        if (/requestApproval$/.test(m.method) && this.approvals) {
          // a person answers (a coding chat): accept or decline when they do
          const method = m.method;
          void this.approvals(method, (m.params ?? {}) as Json)
            .catch(() => "decline" as const)
            .then((decision) => this.proc.send(JSON.stringify({ id, result: { decision } })))
            .catch(() => undefined);
          return;
        }
        // a request from the server (an approval…): declined, Polpo's runs are unattended
        const decline = /requestApproval$/.test(m.method) ? { result: { decision: "decline" } } : { error: { code: -32601, message: "Polpo runs this agent unattended: not available" } };
        void this.proc.send(JSON.stringify({ id, ...decline })).catch(() => undefined);
        return;
      }
      for (const l of this.listeners) l(m.method, (m.params ?? {}) as Json);
      return;
    }
    if (typeof id === "number" && this.pending.has(id)) {
      const p = this.pending.get(id)!;
      this.pending.delete(id);
      if (m.error) {
        const e = m.error as Json;
        p.reject(new RpcError(String(e.message ?? "error"), typeof e.code === "number" ? e.code : undefined));
      } else p.resolve(m.result);
    }
  }

  request<T = Json>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError(this.proc.stderrTail().trim() || "Codex is not running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.proc.send(JSON.stringify({ id, method, params })).catch((err) => { this.pending.delete(id); reject(err as Error); });
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.proc.send(JSON.stringify({ method, ...(params !== undefined ? { params } : {}) }));
  }

  on(l: (method: string, params: Json) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

function usageOf(u: unknown): CliUsage {
  const r = (u ?? {}) as Json;
  const n = (k: string) => (typeof r[k] === "number" ? (r[k] as number) : 0);
  const cacheRead = n("cachedInputTokens");
  // Codex counts cached tokens inside inputTokens
  const input = Math.max(0, n("inputTokens") - cacheRead);
  const output = n("outputTokens");
  const cacheWrite = n("cacheWriteInputTokens");
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, totalTokens: n("totalTokens") || input + output + cacheRead + cacheWrite };
}

function diff(a: CliUsage, b: CliUsage): CliUsage {
  return {
    inputTokens: Math.max(0, a.inputTokens - b.inputTokens), outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
    cacheReadTokens: Math.max(0, a.cacheReadTokens - b.cacheReadTokens), cacheWriteTokens: Math.max(0, a.cacheWriteTokens - b.cacheWriteTokens),
    totalTokens: Math.max(0, a.totalTokens - b.totalTokens),
  };
}

/** A thread item as the tool call it is (commands, file changes, MCP and web tools), or undefined. */
export function codexToolCall(item: Json): { name: string; input: unknown } | undefined {
  switch (item.type) {
    case "commandExecution": return { name: "shell", input: { command: item.command, cwd: item.cwd } };
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? (item.changes as Json[]) : [];
      return { name: "apply_patch", input: { path: changes[0]?.path, changes: changes.map((c) => ({ path: c.path, kind: typeof c.kind === "object" ? (c.kind as Json).type : c.kind, ...(typeof c.diff === "string" ? { diff: c.diff } : {}) })) } };
    }
    case "mcpToolCall": return { name: `${String(item.server ?? "mcp")}.${String(item.tool ?? "tool")}`, input: item.arguments ?? {} };
    case "dynamicToolCall": return { name: String(item.tool ?? "tool"), input: item.arguments ?? {} };
    case "webSearch": return { name: "web_search", input: { query: item.query } };
    case "imageView": return { name: "view_image", input: { path: item.path } };
    default: return undefined;
  }
}

function toolOutput(item: Json): { output: unknown; isError: boolean } {
  const status = String(item.status ?? "");
  const failed = /fail|declin|error/i.test(status) || (typeof item.exitCode === "number" && item.exitCode !== 0) || !!item.error;
  const output = item.aggregatedOutput ?? item.result ?? item.error ?? (Array.isArray(item.changes) ? (item.changes as Json[]).map((c) => c.path).join("\n") : status);
  return { output, isError: failed };
}

/** Item notifications as events. */
export function codexItemEvents(method: string, params: Json): CliEvent[] {
  const item = (params.item ?? {}) as Json;
  const id = String(item.id ?? "");
  if (method === "item/agentMessage/delta") {
    return typeof params.delta === "string" && params.delta ? [{ type: "text-delta", text: params.delta }] : [];
  }
  if (method === "item/started") {
    const call = codexToolCall(item);
    return call ? [{ type: "tool-call", id, name: call.name, input: call.input }] : [];
  }
  if (method === "item/completed") {
    if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) return [{ type: "text", text: item.text }];
    if (item.type === "reasoning") {
      const parts = [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])].map(String).filter(Boolean);
      return parts.length ? [{ type: "reasoning", text: parts.join("\n") }] : [];
    }
    const call = codexToolCall(item);
    if (call) {
      const r = toolOutput(item);
      return [{ type: "tool-result", id, name: call.name, output: r.output, isError: r.isError }];
    }
  }
  return [];
}

export interface CodexSessionOptions {
  cwd: string;
  model?: string;
  permissionMode?: CliPermissionMode;
  instructions?: string;
  /** Continue this thread (a continuation of the task). */
  resumeThreadId?: string;
  clientVersion?: string;
  closeGraceMs?: number;
  /**
   * A person answers the program's approval requests (coding chats): the thread runs with
   * approvalPolicy "on-request" (Codex asks before leaving its sandbox: network, files outside the
   * workspace) and each request is answered by this. Without it: "never", nothing is asked.
   */
  onApproval?: (method: string, params: Record<string, unknown>) => Promise<"accept" | "decline">;
}

/** Start the app server's conversation: initialize, then a new or resumed thread. */
export async function codexSession(proc: CliProcess, o: CodexSessionOptions): Promise<CliSession> {
  const rpc = new CodexRpc(proc);
  if (o.onApproval) rpc.approvals = o.onApproval;
  await rpc.request("initialize", { clientInfo: { name: "polpo", title: "Polpo", version: o.clientVersion ?? "0" } });
  await rpc.notify("initialized");
  let threadId: string;
  let model: string | undefined;
  const threadParams = {
    cwd: o.cwd,
    ...(o.model ? { model: o.model } : {}),
    approvalPolicy: o.onApproval ? "on-request" : "never",
    sandbox: CODEX_SANDBOX_MODES[o.permissionMode ?? "allow-all"],
    ...(o.instructions ? { developerInstructions: o.instructions } : {}),
  };
  let resumed: Json | undefined;
  if (o.resumeThreadId) {
    resumed = await rpc.request<Json>("thread/resume", { threadId: o.resumeThreadId, ...threadParams }).catch(() => undefined);
  }
  const started = resumed ?? await rpc.request<Json>("thread/start", threadParams);
  threadId = String(((started.thread ?? {}) as Json).id ?? o.resumeThreadId ?? "");
  if (!threadId) throw new Error("Codex did not start a thread");
  model = typeof started.model === "string" ? started.model : o.model;

  let total: CliUsage = { ...ZERO_USAGE };
  let turnId: string | undefined;
  let running: { onEvent: (e: CliEvent) => void; resolve: (e: CliTurnEnd) => void; reject: (e: Error) => void; start: CliUsage; lastText: string; errors: string[] } | undefined;

  rpc.on((method, params) => {
    if (method === "$exit") {
      const r = running;
      running = undefined;
      r?.reject(new Error(String(params.message)));
      return;
    }
    if (params.threadId !== undefined && params.threadId !== threadId) return; // a sub-agent's thread
    if (method === "thread/tokenUsage/updated") {
      total = usageOf(((params.tokenUsage ?? {}) as Json).total);
      return;
    }
    if (!running) return;
    if (method === "error") {
      const e = (params.error ?? {}) as Json;
      if (params.willRetry !== true) running.errors.push(String(e.message ?? "error"));
      running.onEvent({ type: "error", message: String(e.message ?? "error") });
      return;
    }
    if (method === "turn/completed") {
      const turn = (params.turn ?? {}) as Json;
      const r = running;
      running = undefined;
      turnId = undefined;
      const status = String(turn.status ?? "completed");
      const err = (turn.error ?? undefined) as Json | undefined;
      const error = err ? [err.message, err.additionalDetails].filter(Boolean).join(": ") : r.errors.join("\n");
      const ok = status === "completed" && !err;
      r.resolve({ ok, text: r.lastText, ...(ok ? {} : { error: error || `Codex turn ${status}` }), usage: diff(total, r.start), sessionId: threadId });
      return;
    }
    for (const e of codexItemEvents(method, params)) {
      if (e.type === "text") running.lastText = e.text;
      running.onEvent(e);
    }
  });

  const input = (text: string) => [{ type: "text", text }];
  return {
    get sessionId() { return threadId; },
    get model() { return model; },
    turn: (prompt, onEvent) => new Promise<CliTurnEnd>((resolve, reject) => {
      if (running) { reject(new Error("A turn is already running")); return; }
      running = { onEvent, resolve, reject, start: { ...total }, lastText: "", errors: [] };
      onEvent({ type: "session", sessionId: threadId, ...(model ? { model } : {}) });
      rpc.request<Json>("turn/start", { threadId, input: input(prompt) }).then(
        (r) => { turnId = String(((r?.turn ?? {}) as Json).id ?? "") || undefined; },
        (err) => { const x = running; running = undefined; x?.reject(err as Error); },
      );
    }),
    steer: async (text) => {
      if (!running || !turnId) return false;
      await rpc.request("turn/steer", { threadId, expectedTurnId: turnId, input: input(text) });
      running?.onEvent({ type: "steer-read" });
      return true;
    },
    interrupt: async () => {
      if (turnId) await rpc.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
    },
    close: async () => {
      await proc.endInput().catch(() => undefined);
      const done = await Promise.race([proc.wait().then(() => true), new Promise<false>((r) => { setTimeout(() => r(false), o.closeGraceMs ?? 5_000).unref?.(); })]);
      if (!done) await proc.kill();
      await rpc.done;
    },
  };
}
