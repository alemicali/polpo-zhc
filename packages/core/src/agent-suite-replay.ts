/**
 * Agent suites, phase 4 — record / replay (cassettes).
 *
 *   Record   a case runs live (real model, real tools: admins, after a confirmation) and every
 *            model turn and tool call (arguments and results) is saved as its cassette, with the
 *            secrets redacted (vault values, auth headers, tokens, keys)
 *   Replay   the case answers its tool calls from the cassette (matched by tool and arguments:
 *            exact, partial, tool, sequence) and, when the mode scripts the model, plays its model
 *            turns: deterministic and offline. A call no recording answers is blocked or fails
 *            the case.
 *   Edit     per call: change the response, delete it, or turn it into a case mock (a pinned
 *            answer that a re-recording keeps)
 *   From a real chat or task: a chat session's exchange or a task run's activity becomes a case
 *            and its cassette ({@link recordedCase})
 *
 * Pure (no I/O): the server records, stores and replays (src/server/agent-suites.ts).
 */
import { caseFromTrace, suiteSlug, type CassetteMatch, type ScriptedTurn, type SuiteCase, type SuiteTrace } from "./agent-suites.js";

// ── Shapes ───────────────────────────────────────────────────────────

export interface CassetteTurn {
  text: string;
  thinking?: string;
  toolCalls: Array<{ id?: string; name: string; args: Record<string, unknown> }>;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  model?: string;
}

export interface CassetteCall {
  id: string;
  /** The model turn that asked for it (0-based). */
  turn: number;
  tool: string;
  /** The recorded arguments (secrets redacted: a redacted value matches anything when replayed). */
  args: Record<string, unknown>;
  /** The recorded result (redacted). */
  response: string;
  isError: boolean;
  /** Changed by hand in the cassette editor. */
  edited?: boolean;
  /** Turned into a case tool mock: the mock answers it now (the recording is kept, not replayed). */
  mock?: boolean;
}

export interface SuiteCassetteRecord {
  id: string;
  /** The owner: the agent (or `mission:<id>`…). */
  agent: string;
  suiteId?: string;
  caseId?: string;
  name: string;
  /** Where it was recorded: a live suite run, a chat session or a task run. */
  source: { kind: "run" | "session" | "task"; runId?: string; sessionId?: string; taskId?: string; target?: string; version?: string };
  /** The messages the recording started from. */
  input: Array<{ role: string; content: string }>;
  turns: CassetteTurn[];
  calls: CassetteCall[];
  /** The final reply. */
  text: string;
  /** How many values were redacted. */
  redactions: number;
  /** Bumped on every save (an edit from an older revision is refused). */
  revision: number;
  recordedAt: string;
  recordedBy?: string;
  updatedAt: string;
  updatedBy?: string;
}

/** A cassette without its turns and calls (lists). */
export type SuiteCassetteSummary = Omit<SuiteCassetteRecord, "turns" | "calls" | "input"> & { turnCount: number; callCount: number; tools: string[] };

export function summarizeCassette(c: SuiteCassetteRecord): SuiteCassetteSummary {
  const { turns, calls, input: _i, ...rest } = c;
  return { ...rest, turnCount: turns.length, callCount: calls.length, tools: [...new Set(calls.map((x) => x.tool))] };
}

export const CASSETTE_LIMITS = { calls: 500, turns: 200, responseChars: 200_000 } as const;

// ── Redaction ────────────────────────────────────────────────────────

export const REDACTED = "[REDACTED]";

/** Keys whose values are secrets wherever they appear (headers, arguments, results). */
const SECRET_KEY = /^(authorization|proxy-authorization|x-api-key|x-auth-token|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|bearer|token|secret|client[-_]?secret|password|passwd|pwd|cookie|set-cookie|private[-_]?key|session[-_]?token|webhook[-_]?secret|signing[-_]?secret)$/i;

/** Credential shapes found inside text. */
const SECRET_PATTERNS: Array<[RegExp, string | ((m: string, ...g: string[]) => string)]> = [
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, (_m, kind) => `${kind} ${REDACTED}`],
  [/\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b(?:pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  // "token": "…" inside JSON text
  [/("(?:authorization|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|client[_-]?secret|password|private[_-]?key|cookie)"\s*:\s*)"[^"]*"/gi, (_m, k) => `${k}"${REDACTED}"`],
  // Authorization: … / X-Api-Key: … inside text (headers dumped in a result)
  [/\b(authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)(\s*[:=]\s*)(?!\[REDACTED\])[^\r\n,;]+/gi, (_m, k, sep) => `${k}${sep}${REDACTED}`],
];

function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/**
 * Redact secrets, deeply: values under secret-looking keys, the given secret values (the vault's)
 * wherever they appear, and credential shapes in text (bearer tokens, API keys, JWTs). Returns the
 * redacted copy and how many values were replaced.
 */
export function redactCassetteSecrets<T>(value: T, secrets: Iterable<string> = []): { value: T; count: number } {
  const known = [...new Set([...secrets].filter((s) => typeof s === "string" && s.length >= 4))].sort((a, b) => b.length - a.length);
  const knownRe = known.length ? new RegExp(known.map(escapeRegExp).join("|"), "g") : undefined;
  let count = 0;
  const text = (s: string): string => {
    let out = s;
    if (knownRe) out = out.replace(knownRe, () => { count++; return REDACTED; });
    for (const [re, rep] of SECRET_PATTERNS) {
      out = out.replace(re, (...m: string[]) => {
        count++;
        return typeof rep === "string" ? rep : rep(m[0], ...m.slice(1));
      });
    }
    return out;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => {
        if (SECRET_KEY.test(k) && x !== null && x !== undefined && x !== "" && x !== REDACTED) { count++; return [k, REDACTED]; }
        return [k, walk(x)];
      }));
    }
    return v;
  };
  return { value: walk(value) as T, count };
}

// ── Recording ────────────────────────────────────────────────────────

/** The trace parts a cassette is made from. */
export type RecordableTrace = Pick<SuiteTrace, "input" | "turns" | "toolCalls" | "text">;

/** A cassette from a recorded exchange, secrets redacted. */
export function cassetteFromTrace(trace: RecordableTrace, opts: {
  id: string; agent: string; name: string; suiteId?: string; caseId?: string;
  source: SuiteCassetteRecord["source"]; secrets?: Iterable<string>; actor?: string; previous?: SuiteCassetteRecord; now?: string;
}): SuiteCassetteRecord {
  const now = opts.now ?? new Date().toISOString();
  const raw = {
    input: trace.input.map((m) => ({ role: m.role, content: m.content })),
    turns: trace.turns.slice(0, CASSETTE_LIMITS.turns).map((t): CassetteTurn => ({
      text: t.text, ...(t.thinking ? { thinking: t.thinking } : {}),
      toolCalls: t.toolCalls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
      ...(t.usage ? { usage: t.usage } : {}), ...(t.model ? { model: t.model } : {}),
    })),
    calls: trace.toolCalls.slice(0, CASSETTE_LIMITS.calls).map((c, i): CassetteCall => ({
      id: c.id || `call-${i + 1}`, turn: c.turn, tool: c.name, args: c.args,
      response: c.result.length > CASSETTE_LIMITS.responseChars ? `${c.result.slice(0, CASSETTE_LIMITS.responseChars)}…` : c.result,
      isError: c.isError,
    })),
    text: trace.text,
  };
  const { value, count } = redactCassetteSecrets(raw, opts.secrets ?? []);
  // calls turned into case mocks stay so: a re-recording keeps the pin
  const pinned = new Map((opts.previous?.calls ?? []).filter((c) => c.mock).map((c) => [`${c.tool}\u0000${JSON.stringify(c.args)}`, c]));
  const calls = value.calls.map((c) => (pinned.has(`${c.tool}\u0000${JSON.stringify(c.args)}`) ? { ...c, mock: true } : c));
  return {
    id: opts.id, agent: opts.agent, name: opts.name,
    ...(opts.suiteId ? { suiteId: opts.suiteId } : {}), ...(opts.caseId ? { caseId: opts.caseId } : {}),
    source: opts.source,
    input: value.input, turns: value.turns, calls, text: value.text,
    redactions: count,
    revision: (opts.previous?.revision ?? 0) + 1,
    recordedAt: now, ...(opts.actor ? { recordedBy: opts.actor } : {}),
    updatedAt: now, ...(opts.actor ? { updatedBy: opts.actor } : {}),
  };
}

/** The cassette's model turns as a model script (replay). */
export function cassetteScript(c: Pick<SuiteCassetteRecord, "turns">): ScriptedTurn[] {
  return c.turns
    .map((t) => ({
      ...(t.text ? { text: t.text } : {}), ...(t.thinking ? { thinking: t.thinking } : {}),
      ...(t.toolCalls.length ? { toolCalls: t.toolCalls.map((x) => ({ name: x.name, args: x.args, ...(x.id ? { id: x.id } : {}) })) } : {}),
      ...(t.usage ? { usage: t.usage } : {}),
    }))
    .filter((t) => t.text !== undefined || t.toolCalls);
}

// ── Replay ───────────────────────────────────────────────────────────

/** Recorded arguments against a call's: a redacted value matches anything; partial: the recorded keys only. */
export function cassetteArgsMatch(recorded: unknown, actual: unknown, partial = false): boolean {
  if (recorded === REDACTED) return true;
  if (typeof recorded === "string" && recorded.includes(REDACTED) && typeof actual === "string") {
    const re = new RegExp(`^${recorded.split(REDACTED).map(escapeRegExp).join("[\\s\\S]*")}$`);
    return re.test(actual);
  }
  if (Array.isArray(recorded)) {
    if (!Array.isArray(actual)) return false;
    if (partial ? recorded.length > actual.length : recorded.length !== actual.length) return false;
    return recorded.every((x, i) => cassetteArgsMatch(x, actual[i], partial));
  }
  if (recorded && typeof recorded === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    const r = recorded as Record<string, unknown>, a = actual as Record<string, unknown>;
    const rk = Object.keys(r).filter((k) => r[k] !== undefined);
    if (!partial) {
      const ak = Object.keys(a).filter((k) => a[k] !== undefined);
      if (rk.length !== ak.length) return false;
    }
    return rk.every((k) => cassetteArgsMatch(r[k], a[k], partial));
  }
  if (typeof recorded === "number" && typeof actual === "string") return String(recorded) === actual;
  if (typeof recorded === "string" && typeof actual === "number") return recorded === String(actual);
  return recorded === actual;
}

/**
 * The recorded call that answers a tool call when replaying, if any (marked used). `callIndex` is the
 * 0-based number of this call in the case (sequence matching). Calls turned into mocks are skipped.
 */
export function matchCassetteCall(calls: CassetteCall[], name: string, args: Record<string, unknown>, opts: { match?: CassetteMatch; used: Set<string>; callIndex: number }): CassetteCall | undefined {
  const playable = calls.filter((c) => !c.mock);
  const match = opts.match ?? "exact";
  let hit: CassetteCall | undefined;
  if (match === "sequence") {
    const c = playable[opts.callIndex];
    hit = c && c.tool === name && !opts.used.has(c.id) ? c : undefined;
  } else {
    hit = playable.find((c) => !opts.used.has(c.id) && c.tool === name
      && (match === "tool" || cassetteArgsMatch(c.args, args, match === "partial")));
  }
  if (hit) opts.used.add(hit.id);
  return hit;
}

// ── Editing ──────────────────────────────────────────────────────────

export class CassetteEditError extends Error {
  constructor(message: string, readonly code: "INVALID" | "NOT_FOUND" | "CONFLICT" = "INVALID") { super(message); this.name = "AgentSuiteError"; }
}

/** One edit of a recorded call: a new response (and error flag), deletion, or turning it into a case mock. */
export interface CassetteCallEdit {
  callId: string;
  response?: string;
  isError?: boolean;
  delete?: boolean;
  /** Turn it into a case tool mock (the runner adds the mock to the case). */
  markAsMock?: boolean;
}

/** Apply edits (returns the new cassette, and the calls to add to the case as mocks). */
export function editCassette(c: SuiteCassetteRecord, edits: CassetteCallEdit[], opts: { actor?: string; revision?: number; now?: string } = {}): { cassette: SuiteCassetteRecord; mocks: CassetteCall[] } {
  if (opts.revision !== undefined && opts.revision !== c.revision) {
    throw new CassetteEditError(`The cassette changed since you opened it (revision ${c.revision}, yours ${opts.revision}): reload it`, "CONFLICT");
  }
  let calls = [...c.calls];
  const mocks: CassetteCall[] = [];
  for (const e of edits) {
    const i = calls.findIndex((x) => x.id === e.callId);
    if (i < 0) throw new CassetteEditError(`The cassette has no call "${e.callId}"`, "NOT_FOUND");
    if (e.delete) { calls = calls.filter((x) => x.id !== e.callId); continue; }
    let call = { ...calls[i] };
    if (e.response !== undefined) {
      if (typeof e.response !== "string" || e.response.length > CASSETTE_LIMITS.responseChars) throw new CassetteEditError(`calls.${e.callId}.response must be text up to ${CASSETTE_LIMITS.responseChars} characters`);
      call = { ...call, response: e.response, edited: true };
    }
    if (e.isError !== undefined) call = { ...call, isError: e.isError === true, edited: true };
    if (e.markAsMock) { call = { ...call, mock: true }; mocks.push(call); }
    calls[i] = call;
  }
  const now = opts.now ?? new Date().toISOString();
  return { cassette: { ...c, calls, revision: c.revision + 1, updatedAt: now, ...(opts.actor ? { updatedBy: opts.actor } : {}) }, mocks };
}

// ── From a real chat or task ─────────────────────────────────────────

/** A chat message as the session store keeps it. */
export interface ChatMessageLike {
  role: string;
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments?: Record<string, unknown>; result?: unknown; state?: string }>;
}

/**
 * A trace from a chat session: the user message at `messageIndex` (default the last one) is the
 * case's message, the earlier messages its history, and the assistant's answer after it (its tool
 * calls with their results, its text) the recording. Each assistant message becomes a turn with its
 * tool calls, then one with its text.
 */
export function traceFromChat(messages: ChatMessageLike[], opts: { messageIndex?: number } = {}): RecordableTrace {
  const userIdx = opts.messageIndex ?? messages.map((m) => m.role).lastIndexOf("user");
  if (userIdx < 0 || messages[userIdx]?.role !== "user") throw new CassetteEditError("The chat has no user message to start the case from");
  const input = messages.slice(0, userIdx + 1).filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, content: m.content ?? "" }));
  const after: ChatMessageLike[] = [];
  for (const m of messages.slice(userIdx + 1)) {
    if (m.role === "user") break;
    if (m.role === "assistant") after.push(m);
  }
  const turns: SuiteTrace["turns"] = [];
  const toolCalls: SuiteTrace["toolCalls"] = [];
  for (const m of after) {
    const calls = m.toolCalls ?? [];
    if (calls.length) {
      const turn = turns.length;
      turns.push({ index: turn, text: "", toolCalls: calls.map((c) => ({ id: c.id, name: c.name, args: c.arguments ?? {} })), mocked: false, durationMs: 0 });
      for (const c of calls) {
        const result = c.result === undefined ? "" : typeof c.result === "string" ? c.result : JSON.stringify(c.result);
        toolCalls.push({ id: c.id, turn, name: c.name, args: c.arguments ?? {}, result, isError: c.state === "error" || result.startsWith("Error:"), mocked: false, durationMs: 0 });
      }
    }
    if (m.content) turns.push({ index: turns.length, text: m.content, toolCalls: [], mocked: false, durationMs: 0 });
  }
  return { input, turns, toolCalls, text: [...after].reverse().find((m) => m.content)?.content ?? "" };
}

/** A task run's activity entry (the run JSONL: tool_use, tool_result, assistant text…). */
export type ActivityEntryLike = Record<string, unknown>;

/**
 * A trace from a task's run activity: the task description is the case's message (kind task), each
 * group of tool calls a turn, results paired by id (or in order), the last assistant text the reply.
 */
export function traceFromTaskActivity(task: { title: string; description: string }, entries: ActivityEntryLike[]): RecordableTrace & { message: string } {
  const message = `${task.title}\n\n${task.description}`.trim();
  const turns: SuiteTrace["turns"] = [];
  const toolCalls: SuiteTrace["toolCalls"] = [];
  const open: SuiteTrace["toolCalls"] = [];
  let lastKind: "tool" | "text" | undefined;
  let text = "";
  for (const e of entries) {
    const type = String(e.type ?? "");
    if (type === "tool_use") {
      if (lastKind !== "tool") turns.push({ index: turns.length, text: "", toolCalls: [], mocked: false, durationMs: 0 });
      lastKind = "tool";
      const turn = turns[turns.length - 1];
      const id = String(e.id ?? e.toolUseId ?? `call-${toolCalls.length + 1}`);
      const name = String(e.name ?? e.tool ?? "tool");
      const args = e.input && typeof e.input === "object" ? e.input as Record<string, unknown> : {};
      turn.toolCalls.push({ id, name, args });
      const call = { id, turn: turn.index, name, args, result: "", isError: false, mocked: false as const, durationMs: 0 };
      toolCalls.push(call);
      open.push(call);
    } else if (type === "tool_result") {
      const id = e.toolUseId ?? e.tool_use_id ?? e.id;
      const i = id !== undefined ? open.findIndex((c) => c.id === String(id)) : open.findIndex((c) => !e.tool || c.name === e.tool);
      const call = i >= 0 ? open.splice(i, 1)[0] : undefined;
      if (call) {
        const content = e.content ?? e.text ?? "";
        call.result = typeof content === "string" ? content : JSON.stringify(content);
        call.isError = e.isError === true;
      }
    } else if ((type === "assistant" || type === "text" || type === "message") && typeof (e.text ?? e.content) === "string") {
      const t = String(e.text ?? e.content);
      if (!t.trim()) continue;
      turns.push({ index: turns.length, text: t, toolCalls: [], mocked: false, durationMs: 0 });
      lastKind = "text";
      text = t;
    }
  }
  return { input: [{ role: "user", content: message }], turns, toolCalls, text, message };
}

/**
 * A case and its cassette from a recorded exchange: the case replays the cassette (mode all:
 * offline), with the assertions of {@link caseFromTrace} (the same tools with the same arguments, in
 * order). The cassette's secrets are redacted.
 */
export function recordedCase(trace: RecordableTrace, opts: {
  agent: string; name: string; id?: string; cassetteId?: string; suiteId?: string; kind?: "chat" | "task"; message?: string;
  source: SuiteCassetteRecord["source"]; secrets?: Iterable<string>; actor?: string;
}): { case: SuiteCase; cassette: SuiteCassetteRecord } {
  const base = caseFromTrace(trace, { name: opts.name, ...(opts.id ? { id: opts.id } : {}), ...(opts.source.sessionId ? { sessionId: opts.source.sessionId } : {}) });
  const cassetteId = opts.cassetteId ?? `${base.id}-rec`.slice(0, 64);
  const cassette = cassetteFromTrace(trace, {
    id: cassetteId, agent: opts.agent, name: opts.name, ...(opts.suiteId ? { suiteId: opts.suiteId } : {}), caseId: base.id,
    source: opts.source, ...(opts.secrets ? { secrets: opts.secrets } : {}), ...(opts.actor ? { actor: opts.actor } : {}),
  });
  // the assertions read the redacted arguments (a secret never lands in the suite either)
  const assertions = redactCassetteSecrets(base.assertions, opts.secrets ?? []).value;
  const input = opts.kind === "task" ? { kind: "task" as const, message: opts.message ?? base.input.message } : redactCassetteSecrets(base.input, opts.secrets ?? []).value;
  const c: SuiteCase = {
    id: base.id, name: base.name, input, mode: "all",
    mocks: { cassette: { id: cassetteId } },
    assertions,
    source: {
      kind: "recorded", at: new Date().toISOString(),
      ...(opts.source.sessionId ? { sessionId: opts.source.sessionId } : {}), ...(opts.source.taskId ? { taskId: opts.source.taskId } : {}),
    },
  };
  return { case: c, cassette };
}

/** The cassette id a case records into (a dataset row: `<id>--r<n>`, one cassette each). */
export function cassetteIdFor(caseId: string, row?: number): string {
  const base = suiteSlug(`${caseId}-rec`, "cassette").slice(0, 56);
  return row !== undefined ? `${base}--r${row + 1}` : base;
}

/** The cassette a planned case replays: its row's own (`<id>--r<n>`), else the case's. */
export function cassetteIdsToTry(ref: { id: string }, row?: number): string[] {
  return row !== undefined ? [`${ref.id.slice(0, 56)}--r${row + 1}`, ref.id] : [ref.id];
}
