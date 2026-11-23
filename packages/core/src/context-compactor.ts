/**
 * Context compactor: keeps a conversation within the model's window, the same way for chat
 * sessions and task runs.
 *
 * Practice it follows (OpenCode, OpenClaw, Claude Code, Anthropic context editing, JetBrains
 * "The Complexity Trap"):
 * - Stable projection: once compacted, the same checkpoint and the same cleared results are
 *   reused on every call until the window fills again, so the prompt prefix (and its cache)
 *   does not move at each call.
 * - Two stages: first clear old tool results (cheap, safe), then summarize with a model; the
 *   summary is incremental (previous summary + new messages), with a deterministic fallback.
 * - Anchors: the leading messages (system prompt, the task request) are never summarized.
 * - Measure with the provider's real input tokens of the last call when known, plus an
 *   estimate of what was added since.
 * - Never split a tool call from its result; keep a verbatim tail of recent messages.
 * - Split turn (Pi coding agent, badlogic/pi-mono): when the cut falls inside a turn (the
 *   user's message is folded, the assistant's latest steps are kept), that turn's folded start is
 *   summarized on its own ("turn in progress") and placed right before the kept part, instead of
 *   being mixed into the history summary.
 * - File lists (Pi): the files read and modified in the folded messages are listed after the
 *   summary (`<read-files>`, `<modified-files>`) and carried across compactions.
 */
import {
  type ContextBudget,
  type ContextMessageLike,
  estimateMessageTokens,
  selectCompactionCut,
  summarizeContextMessages,
} from "./context-compaction.js";

/** Compaction settings (`settings.compaction`, overridable per agent). */
export interface CompactionSettings {
  /** Compact automatically when the window fills (default true). */
  auto?: boolean;
  /** Clear old tool results before summarizing (default true). */
  prune?: boolean;
  /** Trigger at this fraction of the window (default 0.8, capped by window - output reserve). */
  thresholdPct?: number;
  /** Tokens kept free for the model's answer (default: max(16k, maxTokens) capped at 25% of the window). */
  reserveTokens?: number;
  /** Recent tokens kept verbatim after a summary (default: 20% of the window, at most 100k). */
  keepRecentTokens?: number;
  /** Model that writes summaries ("provider:model"); default: the conversation's own model. */
  model?: string;
  /** Give up on the model summary after this long and use the deterministic one (default 90s). */
  summaryTimeoutMs?: number;
  /** Save durable facts to memory when compacting (default true). */
  memoryFlush?: boolean;
}

export type CompactionReason = "budget" | "overflow" | "manual";
export type CompactionMode = "prune" | "summary" | "fallback" | "truncate";

/** What a compaction did (sent to the UI, the event bus and the run transcript). */
export interface CompactionInfo {
  reason: CompactionReason;
  mode: CompactionMode;
  beforeTokens: number;
  afterTokens: number;
  hardLimit: number;
  /** Messages folded into the checkpoint by this compaction. */
  removedMessages: number;
  /** Tool results cleared by this compaction. */
  prunedToolResults: number;
  /** Compactions so far in this conversation or run (this one included). */
  compactionCount: number;
  durationMs: number;
  /** Model that wrote the summary, when one did. */
  model?: string;
  focus?: string;
  /** Why the model summary was not used, when the fallback ran. */
  fallbackReason?: string;
}

export interface SummaryRequest {
  messages: ContextMessageLike[];
  /**
   * "history" (default): the conversation so far. "turn": the folded start of the turn still in
   * progress (its latest steps are kept verbatim after the checkpoint).
   */
  kind?: "history" | "turn";
  previousSummary?: string;
  focus?: string;
  signal?: AbortSignal;
}

export interface SummaryResult {
  summary: string;
  /** Facts worth keeping in long-term memory (the "Durable facts" section). */
  durableFacts?: string[];
  model?: string;
}

/** Writes a summary with a model. Throws or returns empty to fall back to the deterministic one. */
export type ContextSummarizer = (request: SummaryRequest) => Promise<SummaryResult>;

export interface ContextCompactorOptions {
  budget: ContextBudget;
  settings?: CompactionSettings;
  /** Token estimate of everything sent besides the messages (system prompt, tool schemas). */
  baseTokens: () => number;
  /** Leading messages never summarized (default: leading system messages + the first user message). */
  pinned?: (messages: ContextMessageLike[]) => number;
  summarize?: ContextSummarizer;
  /** Called with durable facts from a model summary, when memoryFlush is on. */
  onDurableFacts?: (facts: string[]) => Promise<void> | void;
  /** Tool results never cleared (by tool name; `*` suffix matches a prefix). */
  protectedTools?: string[];
}

/** Restorable state, for callers that keep a conversation's checkpoint across requests. */
export interface CompactorState {
  covered: number;
  /**
   * History summary. A summary restored without `readFiles`/`modifiedFiles` (a saved checkpoint
   * text, see checkpointSummaryText) has its file lists read back from the text.
   */
  summary?: string;
  /** Summary of the folded start of the turn in progress (split turn). */
  turnSummary?: string;
  /** Files read / modified in the folded messages, oldest first. */
  readFiles?: string[];
  modifiedFiles?: string[];
  pruned: string[];
  count: number;
}

const DEFAULT_PROTECTED_TOOLS = ["register_outcome", "memory_*", "vault_*", "skill*", "set_session_title"];
const CLEARED_RESULT = "[Old tool result cleared to save context. Re-run the tool if you need this output again.]";
/** Tool output kept untouched at the end of the conversation (OpenCode PRUNE_PROTECT). */
const PRUNE_PROTECT_TOKENS = 40_000;
/** Clearing must free at least this much to be worth breaking the cache (OpenCode PRUNE_MINIMUM). */
const PRUNE_MINIMUM_TOKENS = 20_000;
const DEFAULT_SUMMARY_TIMEOUT_MS = 90_000;
/** Tool output shown to the summarizer per result (OpenCode TOOL_OUTPUT_MAX_CHARS). */
const SUMMARY_TOOL_OUTPUT_CHARS = 2_000;
const SUMMARY_TEXT_CHARS = 8_000;
/** Room assumed for the summary when choosing where to cut (a model summary is capped at 8k tokens). */
const SUMMARY_ALLOWANCE_TOKENS = 8_000;

export const CHECKPOINT_START = "[Context checkpoint: earlier conversation compacted]";
export const CHECKPOINT_END = "[End context checkpoint]";
export const TURN_IN_PROGRESS_HEADING = "## Turn in progress (its start was compacted; the latest steps follow)";
/** Files listed per kind in a checkpoint; older ones are counted, not listed. */
export const MAX_LISTED_FILES = 100;

/** Tools whose path argument is a file read (or a directory looked at). */
const READ_TOOLS = new Set(["read", "read_file", "view", "ls", "list_directory", "glob", "grep", "search_files"]);
/** Tools whose path argument is a file written. */
const WRITE_TOOLS = new Set(["write", "write_file", "edit", "edit_file", "multi_edit", "multiedit", "multi-edit"]);
const PATCH_TOOLS = new Set(["apply_patch", "apply-patch"]);

function pathArgument(args: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file_path", "filePath"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Files named by a Codex-style or unified patch (`*** Update File: x`, `+++ b/x`). */
function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$|^\+\+\+ (?:b\/)?(.+)$/gm)) {
    const path = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (path && path !== "/dev/null") out.push(path);
  }
  return out;
}

/**
 * Files the agent read and modified in these messages, from its coding tool calls (calls whose
 * result is an error are left out). Shell commands are not parsed: what they touch is a guess.
 */
export function extractFileOperations(messages: ContextMessageLike[]): { read: string[]; modified: string[] } {
  const failed = new Set<string>();
  for (const message of messages) {
    if (message.role === "toolResult" && message.isError && typeof message.toolCallId === "string") failed.add(message.toolCallId);
  }
  const read: string[] = [];
  const modified: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content as any[]) {
      if (part?.type !== "toolCall" || typeof part.name !== "string") continue;
      if (typeof part.id === "string" && failed.has(part.id)) continue;
      const args = part.arguments && typeof part.arguments === "object" ? part.arguments as Record<string, unknown> : {};
      if (PATCH_TOOLS.has(part.name)) {
        const patch = [args.patch, args.input, args.diff].find((value) => typeof value === "string") as string | undefined;
        const paths = patch ? patchPaths(patch) : [];
        const direct = pathArgument(args);
        modified.push(...(paths.length ? paths : direct ? [direct] : []));
        continue;
      }
      const path = pathArgument(args);
      if (!path) continue;
      if (WRITE_TOOLS.has(part.name)) modified.push(path);
      else if (READ_TOOLS.has(part.name)) read.push(path);
    }
  }
  return { read, modified };
}

/** Append to an ordered set, moving an entry already present to the end (most recent last). */
function touch(list: string[], paths: string[]): string[] {
  const set = new Set(list);
  for (const path of paths) { set.delete(path); set.add(path); }
  return [...set];
}

function fileListBlock(tag: string, files: string[]): string {
  if (files.length === 0) return "";
  const listed = files.slice(-MAX_LISTED_FILES);
  const more = files.length - listed.length;
  return `<${tag}>\n${more > 0 ? `(+${more} more)\n` : ""}${listed.join("\n")}\n</${tag}>`;
}

/** Read the file lists back from a checkpoint text and return the text without them. */
export function parseFileLists(text: string): { text: string; read: string[]; modified: string[] } {
  const lists = { read: [] as string[], modified: [] as string[] };
  let rest = text;
  for (const [tag, key] of [["read-files", "read"], ["modified-files", "modified"]] as const) {
    const match = new RegExp(`\\n*<${tag}>\\n([\\s\\S]*?)\\n?</${tag}>\\n*`).exec(rest);
    if (!match) continue;
    lists[key] = match[1]!.split("\n").map((line) => line.trim()).filter((line) => line && !/^\(\+\d+ more\)$/.test(line));
    rest = `${rest.slice(0, match.index)}\n\n${rest.slice(match.index + match[0].length)}`;
  }
  return { text: rest.trim(), ...lists };
}

/**
 * The checkpoint's text: history summary, file lists, then the turn in progress (right before
 * the kept messages). This is also what a chat session saves as its checkpoint summary.
 */
export function checkpointSummaryText(state: Pick<CompactorState, "summary" | "turnSummary" | "readFiles" | "modifiedFiles">): string {
  const modified = state.modifiedFiles ?? [];
  const modifiedSet = new Set(modified);
  const read = (state.readFiles ?? []).filter((path) => !modifiedSet.has(path));
  return [
    state.summary?.trim(),
    fileListBlock("read-files", read),
    fileListBlock("modified-files", modified),
    state.turnSummary?.trim() ? `${TURN_IN_PROGRESS_HEADING}\n${state.turnSummary.trim()}` : "",
  ].filter(Boolean).join("\n\n");
}

export function checkpointMessage(summary: string, count?: number): ContextMessageLike {
  const label = count && count > 1 ? `${CHECKPOINT_START.slice(0, -1)} (${count} times)]` : CHECKPOINT_START;
  return { role: "user", content: `${label}\n\n${summary.trim()}\n\n${CHECKPOINT_END}`, timestamp: 0 };
}

/** Default anchors: the leading system messages and the first user message (the request). */
export function defaultPinned(messages: ContextMessageLike[]): number {
  let index = 0;
  while (index < messages.length && messages[index]?.role === "system") index += 1;
  if (messages[index]?.role === "user") index += 1;
  return index;
}

function toolCallIdOf(message: ContextMessageLike): string | undefined {
  return typeof message.toolCallId === "string" ? message.toolCallId : undefined;
}

function isProtectedTool(name: unknown, patterns: string[]): boolean {
  if (typeof name !== "string") return false;
  return patterns.some((pattern) => pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern);
}

function clearedResult(message: ContextMessageLike): ContextMessageLike {
  // An output already saved to a file keeps its path: the agent can read it again instead of re-running
  const saved = /Full output saved to (\S+?)\.?(?:\s|$)/.exec(textOf(message.content, 1_000_000));
  const text = saved ? `${CLEARED_RESULT.slice(0, -1)} The full output is still in ${saved[1]}.]` : CLEARED_RESULT;
  return { ...message, content: [{ type: "text", text }] };
}

function textOf(content: unknown, limit: number): string {
  let text: string;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content.map((part: any) => {
      if (part?.type === "text") return part.text ?? "";
      if (part?.type === "toolCall") return `${part.name}(${JSON.stringify(part.arguments ?? {})})`;
      if (part?.type === "thinking") return "";
      if (part?.type === "image") return "[image]";
      return "";
    }).filter(Boolean).join("\n");
  } else text = JSON.stringify(content ?? "");
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated: ${text.length - limit} more characters]`;
}

/**
 * The conversation as plain lines for the summarizer: tool results capped, thinking dropped.
 * Prompt structure adapted from OpenClaw's compaction (MIT, openclaw/openclaw
 * packages/agent-core/src/harness/compaction/compaction.ts).
 */
export function serializeForSummary(messages: ContextMessageLike[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "toolResult") {
      const tool = typeof message.toolName === "string" ? message.toolName : "tool";
      lines.push(`[Tool result: ${tool}${message.isError ? " (error)" : ""}]: ${textOf(message.content, SUMMARY_TOOL_OUTPUT_CHARS)}`);
    } else if (message.role === "assistant") {
      const text = textOf(message.content, SUMMARY_TEXT_CHARS);
      if (text) lines.push(`[Assistant]: ${text}`);
    } else if (message.role === "user") {
      lines.push(`[User]: ${textOf(message.content, SUMMARY_TEXT_CHARS)}`);
    }
  }
  return lines.join("\n\n");
}

const TURN_SUMMARY_FORMAT = `## Request
[What the user asked in this turn, with its exact constraints]

## Already Done
- [Steps taken so far in this turn: tool calls and what they showed or changed, checks and their results]

## Current State
- [Where the work stands: what was learned, what is half done, open errors, exact paths and identifiers needed to continue]`;

const SUMMARY_FORMAT = `## Goal
[What the user is trying to accomplish; several items if the work covers several tasks.]

## Constraints & Preferences
- [Constraints, preferences or requirements stated by the user, or "(none)"]

## Progress
### Done
- [x] [Completed work, including checks that ran and their results, even when they failed]
### In Progress
- [ ] [Current work]
### Blocked
- [Open problems, or "(none)"]

## Key Decisions
- **[Decision]**: [short rationale]

## Next Steps
1. [What should happen next, in order]

## Critical Context
- [Exact file paths, identifiers, URLs, commands, error messages, values needed to continue, or "(none)"]

## Durable Facts
- [Facts worth remembering beyond this conversation: stable preferences, decisions, names, accounts, conventions. "(none)" if nothing]`;

export function buildSummaryPrompt(request: Omit<SummaryRequest, "signal">): { systemPrompt: string; prompt: string } {
  const systemPrompt = "You are a context summarization assistant. You read a conversation between a user and an AI assistant (with its tool calls) and write a structured summary that another assistant will use to continue the work. Do NOT continue the conversation. Do NOT answer questions in it. Output ONLY the summary, in the same language as the conversation.";
  const conversation = `<conversation>\n${serializeForSummary(request.messages)}\n</conversation>`;
  const focus = request.focus ? `\n\nPay particular attention to: ${request.focus}` : "";
  if (request.kind === "turn") {
    const previous = request.previousSummary
      ? `\n\n<previous-turn-summary>\n${request.previousSummary}\n</previous-turn-summary>\n\nThe conversation above continues the turn summarized before: update that summary with the new steps; anything you do not carry over is lost.`
      : "";
    return {
      systemPrompt,
      prompt: `${conversation}${previous}\n\nThe messages above are the START of a turn that is still in progress: the user's request and the first steps taken for it. The latest steps of the same turn are kept verbatim after your summary, and the assistant will continue from them. Summarize what was asked, what has already been done and the current state, so that the kept steps make sense. Be concise. Keep exact file paths, identifiers, commands and error messages.${focus}\n\nUse exactly this format:\n\n${TURN_SUMMARY_FORMAT}`,
    };
  }
  if (request.previousSummary) {
    return {
      systemPrompt,
      prompt: `${conversation}\n\n<previous-summary>\n${request.previousSummary}\n</previous-summary>\n\nThe conversation above contains NEW messages that follow the previous summary. Update the summary: keep everything still relevant from the previous one, add new progress, decisions and context, move finished items to Done, update Next Steps. Anything you do not carry over is lost. Where the previous summary and the new messages disagree, the new messages win. Keep exact file paths, identifiers, commands and error messages.${focus}\n\nUse exactly this format:\n\n${SUMMARY_FORMAT}`,
    };
  }
  return {
    systemPrompt,
    prompt: `${conversation}\n\nSummarize the conversation above as a context checkpoint. Keep each section concise. Keep exact file paths, identifiers, commands and error messages.${focus}\n\nUse exactly this format:\n\n${SUMMARY_FORMAT}`,
  };
}

/** Split a model summary into the summary proper and its durable facts. */
export function parseSummary(text: string): { summary: string; durableFacts: string[] } {
  const trimmed = text.trim();
  const match = /^##\s*Durable Facts\s*$/im.exec(trimmed);
  if (!match) return { summary: trimmed, durableFacts: [] };
  const summary = trimmed.slice(0, match.index).trim();
  const facts = trimmed.slice(match.index + match[0].length)
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter((line) => line && !/^\(none\)$/i.test(line) && !line.startsWith("##"));
  return { summary, durableFacts: facts };
}

function withTimeout<T>(promise: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { controller.abort(); reject(new Error(`summary timed out after ${ms}ms`)); }, ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

export class ContextCompactor {
  private covered = 0;
  private summary?: string;
  private turnSummary?: string;
  private readFiles: string[] = [];
  private modifiedFiles: string[] = [];
  private pruned = new Set<string>();
  private count = 0;
  /** Real input tokens of the last call and how many projected messages it covered. */
  private lastUsage?: { inputTokens: number; projectedCount: number; epoch: number };
  /** Bumped at each compaction: usage measured on an older projection no longer applies. */
  private epoch = 0;
  private readonly protectedTools: string[];

  constructor(private readonly opts: ContextCompactorOptions) {
    this.protectedTools = opts.protectedTools ?? DEFAULT_PROTECTED_TOOLS;
  }

  private get settings(): CompactionSettings { return this.opts.settings ?? {}; }

  getState(): CompactorState {
    return {
      covered: this.covered, summary: this.summary,
      ...(this.turnSummary ? { turnSummary: this.turnSummary } : {}),
      readFiles: [...this.readFiles], modifiedFiles: [...this.modifiedFiles],
      pruned: [...this.pruned], count: this.count,
    };
  }

  restoreState(state: CompactorState): void {
    this.covered = state.covered;
    if (state.readFiles || state.modifiedFiles || !state.summary) {
      this.summary = state.summary;
      this.readFiles = [...(state.readFiles ?? [])];
      this.modifiedFiles = [...(state.modifiedFiles ?? [])];
    } else {
      // a saved checkpoint text: its file lists go back to the lists
      const parsed = parseFileLists(state.summary);
      this.summary = parsed.text || undefined;
      this.readFiles = parsed.read;
      this.modifiedFiles = parsed.modified;
    }
    this.turnSummary = state.turnSummary;
    this.pruned = new Set(state.pruned);
    this.count = state.count;
    this.epoch += 1;
  }

  get compactions(): number { return this.count; }

  /** Record the provider's input tokens (incl. cache read/write) for the messages just sent. */
  noteUsage(inputTokens: number, projectedCount: number): void {
    if (inputTokens > 0) this.lastUsage = { inputTokens, projectedCount, epoch: this.epoch };
  }

  private pinnedCount(full: ContextMessageLike[]): number {
    const pinned = (this.opts.pinned ?? defaultPinned)(full);
    // never pin past the end, and keep at least one message to compact
    return Math.max(0, Math.min(pinned, full.length - 1));
  }

  /** What is sent to the model now: anchors, checkpoint, then the tail with cleared results. */
  project(full: ContextMessageLike[]): ContextMessageLike[] {
    const pinned = this.pinnedCount(full);
    const start = Math.min(full.length, pinned + this.covered);
    const tail = full.slice(start).map((message) => {
      const id = message.role === "toolResult" ? toolCallIdOf(message) : undefined;
      return id && this.pruned.has(id) ? clearedResult(message) : message;
    });
    const hasCheckpoint = Boolean(this.summary || this.turnSummary);
    return [
      ...full.slice(0, pinned),
      ...(hasCheckpoint ? [checkpointMessage(checkpointSummaryText(this.getState()), this.count)] : []),
      ...tail,
    ];
  }

  /** Tokens of a projection: real usage of the last call plus an estimate of what came after. */
  measure(projected: ContextMessageLike[]): number {
    const usage = this.lastUsage;
    if (usage && usage.epoch === this.epoch && usage.projectedCount <= projected.length) {
      let added = 0;
      for (const message of projected.slice(usage.projectedCount)) added += estimateMessageTokens(message);
      return usage.inputTokens + added;
    }
    let tokens = this.opts.baseTokens();
    for (const message of projected) tokens += estimateMessageTokens(message);
    return tokens;
  }

  private estimate(projected: ContextMessageLike[]): number {
    let tokens = this.opts.baseTokens();
    for (const message of projected) tokens += estimateMessageTokens(message);
    return tokens;
  }

  /** The token count above which a compaction runs. */
  get threshold(): number {
    const pct = this.settings.thresholdPct;
    const byPct = pct && pct > 0 && pct < 1 ? Math.floor(this.opts.budget.hardLimit * pct) : this.opts.budget.softLimit;
    return Math.min(byPct, this.opts.budget.softLimit);
  }

  /**
   * The messages to send. Compacts when the window is full (or when forced: overflow error,
   * manual request) and returns what it did.
   */
  async prepare(
    full: ContextMessageLike[],
    options: { force?: "overflow" | "manual"; focus?: string; signal?: AbortSignal } = {},
  ): Promise<{ messages: ContextMessageLike[]; info: CompactionInfo | null }> {
    const projected = this.project(full);
    const beforeTokens = this.measure(projected);
    const auto = this.settings.auto !== false;
    if (!options.force && (!auto || beforeTokens <= this.threshold)) return { messages: projected, info: null };

    const started = Date.now();
    const reason: CompactionReason = options.force ?? "budget";
    const pinned = this.pinnedCount(full);
    const harsh = options.force === "overflow";
    let prunedNow = 0;

    // ── Stage 1: clear old tool results (not for a manual request: the user asked for a summary)
    if (this.settings.prune !== false && options.force !== "manual") {
      prunedNow = this.pruneOldToolResults(full, pinned, harsh);
      if (prunedNow > 0) {
        const afterPrune = this.project(full);
        const afterTokens = this.estimate(afterPrune);
        if (afterTokens <= this.threshold && !harsh) {
          this.count += 1;
          this.epoch += 1;
          return { messages: afterPrune, info: {
            reason, mode: "prune", beforeTokens, afterTokens, hardLimit: this.opts.budget.hardLimit,
            removedMessages: 0, prunedToolResults: prunedNow, compactionCount: this.count, durationMs: Date.now() - started,
          } };
        }
      }
    }

    // ── Stage 2: fold the older part of the tail into the (incremental) summary
    const tailStart = pinned + this.covered;
    const tail = full.slice(tailStart);
    const baseKeep = harsh || options.force === "manual"
      ? Math.floor((this.settings.keepRecentTokens ?? this.opts.budget.keepRecentTokens) / 2)
      : (this.settings.keepRecentTokens ?? this.opts.budget.keepRecentTokens);
    // Pick the deepest cut needed so that summary + kept tail fits under the threshold: a tail
    // that still overflows would make every later request compact again.
    const anchors = this.estimate(full.slice(0, pinned));
    const fits = (cut: number) => {
      let tokens = anchors + SUMMARY_ALLOWANCE_TOKENS;
      for (const message of tail.slice(cut)) tokens += estimateMessageTokens(message);
      return tokens <= Math.floor(this.threshold * 0.9);
    };
    let cut = 0;
    if (tail.length >= 2) {
      for (const keep of [baseKeep, Math.floor(baseKeep / 2), Math.floor(baseKeep / 4), 0]) {
        cut = selectCompactionCut(tail, keep);
        if (fits(cut)) break;
      }
    }
    const folded = tail.slice(0, cut);

    // Split turn: the cut falls inside a turn whose user message is folded. The folded start of
    // that turn is summarized on its own and shown right before the kept steps. The cut never
    // lands on a tool result (selectCompactionCut), so a call and its result stay together.
    let historyPart = folded;
    let turnPart: ContextMessageLike[] = [];
    let continuingTurn = false;
    if (folded.length > 0 && cut < tail.length && tail[cut]?.role !== "user") {
      let turnStart = -1;
      for (let index = cut - 1; index >= 0; index -= 1) {
        if (tail[index]?.role === "user") { turnStart = index; break; }
      }
      // only the user's message folded (the assistant has not acted yet): nothing to split
      if (turnStart >= 0 && turnStart < cut - 1) {
        historyPart = folded.slice(0, turnStart);
        turnPart = folded.slice(turnStart);
      } else if (turnStart < 0 && this.turnSummary) {
        // still the turn summarized last time: its summary grows, the history stays
        historyPart = [];
        turnPart = folded;
        continuingTurn = true;
      }
    }

    let mode: CompactionMode = "summary";
    let model: string | undefined;
    let fallbackReason: string | undefined;
    if (folded.length > 0 || options.force === "manual") {
      const manualOnly = folded.length === 0;
      // a turn summarized earlier that has ended now belongs to the history
      const finishedTurn = !manualOnly && !continuingTurn && Boolean(this.turnSummary);
      const previousHistory = finishedTurn
        ? [this.summary?.trim(), `${TURN_IN_PROGRESS_HEADING}\n${this.turnSummary!.trim()}`].filter(Boolean).join("\n\n")
        : this.summary;
      const controller = new AbortController();
      options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
      const failures: string[] = [];
      const facts: string[] = [];
      const run = async (kind: "history" | "turn", messages: ContextMessageLike[], previousSummary: string | undefined): Promise<string | undefined> => {
        if (!this.opts.summarize) { failures.push("no summarizer"); return undefined; }
        try {
          const result = await withTimeout(
            this.opts.summarize({ messages, previousSummary, focus: options.focus, signal: controller.signal, ...(kind === "turn" ? { kind } : {}) }),
            this.settings.summaryTimeoutMs ?? DEFAULT_SUMMARY_TIMEOUT_MS,
            controller,
          );
          if (!result.summary.trim()) { failures.push("empty summary"); return undefined; }
          model ??= result.model;
          if (result.durableFacts?.length) facts.push(...result.durableFacts);
          return result.summary.trim();
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
          return undefined;
        }
      };

      const historySource = manualOnly ? tail : historyPart;
      const [historySummary, turnSummary] = await Promise.all([
        historySource.length > 0 ? run("history", historySource, previousHistory) : Promise.resolve(undefined),
        turnPart.length > 0 ? run("turn", turnPart, continuingTurn ? this.turnSummary : undefined) : Promise.resolve(undefined),
      ]);
      if (this.settings.memoryFlush !== false && facts.length && this.opts.onDurableFacts) {
        await Promise.resolve(this.opts.onDurableFacts(facts)).catch(() => undefined);
      }
      if (failures.length > 0) { mode = "fallback"; fallbackReason = failures[0]; }

      if (historySource.length > 0) {
        if (historySummary) this.summary = historySummary;
        else {
          const extract = summarizeContextMessages(historySource);
          this.summary = previousHistory ? `${previousHistory}\n\n## Later messages (extract)\n${extract}` : extract;
        }
      } else if (finishedTurn) {
        this.summary = previousHistory;
      }
      if (turnPart.length > 0) {
        if (turnSummary) this.turnSummary = turnSummary;
        else {
          const extract = summarizeContextMessages(turnPart);
          this.turnSummary = continuingTurn && this.turnSummary ? `${this.turnSummary}\n\n### Later steps (extract)\n${extract}` : extract;
        }
      } else if (!manualOnly) {
        this.turnSummary = undefined;
      }
      if (folded.length > 0) {
        const files = extractFileOperations(folded);
        this.readFiles = touch(this.readFiles, files.read);
        this.modifiedFiles = touch(this.modifiedFiles, files.modified);
        this.covered += folded.length;
      }
    }

    let messages = this.project(full);
    let afterTokens = this.estimate(messages);

    // ── Last resort: a single huge recent message still overflows → cap oversized messages
    if (afterTokens > this.threshold) {
      const cap = Math.max(2_000, Math.floor(this.threshold / 4)) * 3;
      messages = messages.map((message, index) => {
        if (index < pinned) return message;
        const size = JSON.stringify(message.content ?? "").length;
        return size > cap ? { ...message, content: [{ type: "text", text: `${textOf(message.content, cap)}\n[Message shortened to fit the context window]` }] } : message;
      });
      afterTokens = this.estimate(messages);
      mode = "truncate";
    }

    this.count += 1;
    this.epoch += 1;
    return { messages, info: {
      reason, mode, beforeTokens, afterTokens, hardLimit: this.opts.budget.hardLimit,
      removedMessages: folded.length, prunedToolResults: prunedNow, compactionCount: this.count,
      durationMs: Date.now() - started,
      ...(model ? { model } : {}), ...(options.focus ? { focus: options.focus } : {}),
      ...(fallbackReason && mode !== "summary" ? { fallbackReason } : {}),
    } };
  }

  /**
   * Clear tool results older than the protected recent window. Only commits when it frees
   * enough to be worth a new prompt prefix (or always, when recovering from an overflow).
   */
  private pruneOldToolResults(full: ContextMessageLike[], pinned: number, harsh: boolean): number {
    const tail = full.slice(pinned + this.covered);
    const protect = harsh ? PRUNE_PROTECT_TOKENS / 2 : PRUNE_PROTECT_TOKENS;
    const minimum = Math.min(PRUNE_MINIMUM_TOKENS, Math.floor(this.opts.budget.hardLimit * 0.1));
    let recentOutput = 0;
    let recentResults = 0;
    const candidates: Array<{ id: string; tokens: number }> = [];
    for (let index = tail.length - 1; index >= 0; index -= 1) {
      const message = tail[index]!;
      if (message.role !== "toolResult") continue;
      const id = toolCallIdOf(message);
      if (!id || this.pruned.has(id)) continue;
      const tokens = estimateMessageTokens(message);
      // the most recent tool output (by tokens, and at least the last 3 results) stays untouched
      if (recentResults < (harsh ? 1 : 3) || recentOutput < protect) { recentOutput += tokens; recentResults += 1; continue; }
      if (message.isError || isProtectedTool(message.toolName, this.protectedTools)) continue;
      candidates.push({ id, tokens });
    }
    const freed = candidates.reduce((sum, candidate) => sum + candidate.tokens, 0);
    if (candidates.length === 0 || (!harsh && freed < minimum)) return 0;
    for (const candidate of candidates) this.pruned.add(candidate.id);
    return candidates.length;
  }
}

/** Provider error that means "the prompt does not fit": compact harder and retry once. */
export function isContextOverflowError(message: string): boolean {
  // Ollama / llama.cpp: "request (16384 tokens) exceeds the available context size (16384 tokens)"
  return /context.{0,20}(overflow|length|window|limit|size)|prompt is too long|too many tokens|maximum context|input is too long|exceeds the (?:maximum|model|available)/i.test(message);
}
