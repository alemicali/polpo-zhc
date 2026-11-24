/**
 * Claude Code in print mode with the stream-json protocol on both sides
 * (https://code.claude.com/docs/en/cli-reference):
 *
 *   claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages
 *          [--resume <session>] [--model <m>] --permission-mode <mode> --append-system-prompt <polpo>
 *
 * Input: one JSON line per user message, {"type":"user","message":{"role":"user","content":"…"}}.
 * The program keeps reading until its input closes; every message it takes is echoed back
 * (--replay-user-messages), so a direction sent during a turn is known to be read.
 * Output: {"type":"system","subtype":"init","session_id",…}, {"type":"assistant","message":{content:
 * [text | thinking | tool_use]}}, {"type":"user","message":{content:[tool_result]}}, and one
 * {"type":"result", subtype, is_error, result, usage, total_cost_usd, session_id} per turn.
 */
import type { CliPermissionMode } from "@polpo-ai/core";
import type { CliProcess } from "./process.js";
import { ZERO_USAGE, type CliEvent, type CliSession, type CliTurnEnd, type CliUsage } from "./types.js";

/** Polpo's permission modes as Claude Code's (print mode cannot ask: what needs a prompt is denied). */
export const CLAUDE_PERMISSION_MODES: Record<CliPermissionMode, string> = {
  "allow-all": "bypassPermissions",
  "allow-edits": "acceptEdits",
  "allow-reads": "default",
};

export function claudeArgs(o: { resume?: string; model?: string; permissionMode?: CliPermissionMode; instructions?: string; maxTurns?: number; extra?: string[] }): string[] {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages"];
  if (o.resume) args.push("--resume", o.resume);
  if (o.model) args.push("--model", o.model);
  args.push("--permission-mode", CLAUDE_PERMISSION_MODES[o.permissionMode ?? "allow-all"]);
  if (o.instructions) args.push("--append-system-prompt", o.instructions);
  if (o.maxTurns) args.push("--max-turns", String(o.maxTurns));
  if (o.extra?.length) args.push(...o.extra);
  return args;
}

export function claudeUserLine(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } });
}

type Json = Record<string, unknown>;

function usageOf(u: unknown): CliUsage {
  const r = (u ?? {}) as Json;
  const n = (k: string) => (typeof r[k] === "number" ? (r[k] as number) : 0);
  const inputTokens = n("input_tokens");
  const outputTokens = n("output_tokens");
  const cacheReadTokens = n("cache_read_input_tokens");
  const cacheWriteTokens = n("cache_creation_input_tokens");
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b === "object" && typeof (b as Json).text === "string" ? (b as Json).text as string : "")).filter(Boolean).join("\n");
  return "";
}

/** One stream-json line as events, a replayed user message, or the end of a turn. */
export function parseClaudeLine(line: string):
  | { kind: "events"; events: CliEvent[] }
  | { kind: "replay" }
  | { kind: "result"; end: CliTurnEnd }
  | { kind: "ignore" } {
  const t = line.trim();
  if (!t.startsWith("{")) return t ? { kind: "events", events: [] } : { kind: "ignore" };
  let m: Json;
  try { m = JSON.parse(t) as Json; } catch { return { kind: "ignore" }; }
  switch (m.type) {
    case "system": {
      if (m.subtype === "init" && typeof m.session_id === "string") {
        return { kind: "events", events: [{ type: "session", sessionId: m.session_id, ...(typeof m.model === "string" ? { model: m.model } : {}) }] };
      }
      return { kind: "ignore" };
    }
    case "assistant": {
      const msg = (m.message ?? {}) as Json;
      const events: CliEvent[] = [];
      for (const b of Array.isArray(msg.content) ? (msg.content as Json[]) : []) {
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) events.push({ type: "text", text: b.text });
        else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) events.push({ type: "reasoning", text: b.thinking });
        else if (b.type === "tool_use") events.push({ type: "tool-call", id: String(b.id ?? ""), name: String(b.name ?? "tool"), input: b.input ?? {} });
      }
      if (typeof m.error === "string" && m.error) events.push({ type: "error", message: textOf(msg.content) || m.error });
      return { kind: "events", events };
    }
    case "user": {
      const msg = (m.message ?? {}) as Json;
      const content = msg.content;
      const blocks = Array.isArray(content) ? (content as Json[]) : [];
      const results = blocks.filter((b) => b.type === "tool_result");
      if (!results.length) return m.isSynthetic ? { kind: "ignore" } : { kind: "replay" };
      return {
        kind: "events",
        events: results.map((b) => ({ type: "tool-result" as const, id: String(b.tool_use_id ?? ""), output: textOf(b.content) || b.content || "", isError: b.is_error === true })),
      };
    }
    case "result": {
      const isError = m.is_error === true || (typeof m.subtype === "string" && m.subtype !== "success");
      const text = typeof m.result === "string" ? m.result : "";
      const errors = Array.isArray(m.errors) ? (m.errors as unknown[]).map(String).join("\n") : "";
      return {
        kind: "result",
        end: {
          ok: !isError,
          text,
          ...(isError ? { error: errors || text || String(m.subtype ?? "error") } : {}),
          usage: m.usage ? usageOf(m.usage) : { ...ZERO_USAGE },
          ...(typeof m.total_cost_usd === "number" ? { estimateUsd: m.total_cost_usd } : {}),
          ...(typeof m.session_id === "string" ? { sessionId: m.session_id } : {}),
        },
      };
    }
    default:
      return { kind: "ignore" };
  }
}

/**
 * A Claude Code conversation over a running program. Turns are sequential; a direction during a
 * turn goes in at once (Claude reads it after its current tool calls, or as the next turn): the
 * turn is over at a result once every message sent has been read.
 */
export function claudeSession(proc: CliProcess, o: { closeGraceMs?: number } = {}): CliSession {
  let sessionId: string | undefined;
  let model: string | undefined;
  let unread = 0;
  let current: { onEvent: (e: CliEvent) => void; resolve: (e: CliTurnEnd) => void; reject: (e: Error) => void; usage: CliUsage; estimate: number; lastText: string } | undefined;
  let exited = false;

  const pump = (async () => {
    for await (const line of proc.lines()) {
      const p = parseClaudeLine(line);
      if (p.kind === "ignore") continue;
      if (p.kind === "replay") {
        if (unread > 0) unread--;
        current?.onEvent({ type: "steer-read" });
        continue;
      }
      if (p.kind === "events") {
        for (const e of p.events) {
          if (e.type === "session") { sessionId = e.sessionId; if (e.model) model = e.model; }
          if (e.type === "text") { if (current) current.lastText = e.text; }
          current?.onEvent(e);
        }
        continue;
      }
      // a result: one turn of the program is over
      const end = p.end;
      if (end.sessionId) sessionId = end.sessionId;
      if (!current) continue;
      current.usage = sum(current.usage, end.usage);
      current.estimate += end.estimateUsd ?? 0;
      if (unread > 0 && end.ok) continue; // a message it has not read yet starts the next turn
      const c = current;
      current = undefined;
      unread = 0;
      c.resolve({ ...end, text: end.text || c.lastText, usage: c.usage, ...(c.estimate ? { estimateUsd: c.estimate } : {}), ...(sessionId ? { sessionId } : {}) });
    }
  })().catch(() => undefined).finally(async () => {
    exited = true;
    if (current) {
      const c = current;
      current = undefined;
      const { exitCode } = await proc.wait();
      c.reject(new Error(proc.stderrTail().trim() || `Claude Code exited (code ${exitCode}) before the end of the turn`));
    }
  });

  return {
    get sessionId() { return sessionId; },
    get model() { return model; },
    turn: (prompt, onEvent) => new Promise<CliTurnEnd>((resolve, reject) => {
      if (exited) { reject(new Error(proc.stderrTail().trim() || "Claude Code is not running")); return; }
      if (current) { reject(new Error("A turn is already running")); return; }
      current = { onEvent, resolve, reject, usage: { ...ZERO_USAGE }, estimate: 0, lastText: "" };
      unread = 1;
      proc.send(claudeUserLine(prompt)).catch((err) => {
        const c = current;
        current = undefined;
        c?.reject(err as Error);
      });
    }),
    steer: async (text) => {
      if (!current || exited) return false;
      unread++;
      await proc.send(claudeUserLine(text));
      return true;
    },
    interrupt: async () => { await proc.kill(); },
    close: async () => {
      await proc.endInput().catch(() => undefined);
      const done = await Promise.race([proc.wait().then(() => true), new Promise<false>((r) => setTimeout(() => r(false), o.closeGraceMs ?? 10_000).unref?.())]);
      if (!done) await proc.kill();
      await pump;
    },
  };
}

function sum(a: CliUsage, b: CliUsage): CliUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}
