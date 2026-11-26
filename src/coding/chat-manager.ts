/**
 * Coding chats: Claude Code or Codex sessions in a worktree of the Coding app, run through the CLI
 * engine (src/cli-engine: the official, unmodified program, signed in with the person's own
 * account) and kept as a chat transcript.
 *
 * - The program works in the session's worktree (cwd = the worktree). Each turn starts it, resumes
 *   the session's own CLI conversation (`--resume <session>` / `thread/resume`), streams text,
 *   reasoning and tool calls into the transcript, and ends; a message sent while it works reaches it
 *   at once (a steer); stop ends the turn (the conversation stays). After a restart the next message
 *   resumes the conversation.
 * - The account is the CLI account of the person who opened the session (ToS owner rules unchanged:
 *   packages/core cli-engine.ts cliAccountUseProblem); only they can talk to it.
 * - Approvals (coding-policy.ts): edits and commands inside the worktree run on their own; risky
 *   actions wait for the person inside the chat (Claude Code: --permission-prompt-tool, a Polpo MCP
 *   tool that answers allow / deny; Codex: the app server's approval requests).
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  CLI_NAMES, CLI_INSTANCE_OWNER, HOST_COMPUTER_ID, classifyCliError, cliAccountUseProblem, cliSettingsOf, instanceServesCustomers,
  type AgentCliEngine, type CliAccount, type PolpoSettings,
} from "@polpo-ai/core";
import type { AgentConfig } from "../core/types.js";
import type { HarnessHostTool } from "../harness/types.js";
import { classifyCodingAction, describeCodingAction, type CodingRiskCategory } from "../cli-engine/coding-policy.js";
import type { CliLauncher } from "../cli-engine/process.js";
import { openCliConversation, type CliConversation } from "../cli-engine/run.js";
import { CLI_TOOL_SERVER_NAME } from "../cli-engine/tool-server.js";
import type { CliEvent, CliTurnEnd } from "../cli-engine/types.js";
import { changesFiles, editDiff } from "./chat-diff.js";
import { CodingChatStore } from "./chat-store.js";
import {
  CODING_CHAT_KINDS, ZERO_CODING_USAGE,
  type CodingChatApproval, type CodingChatErrorKind, type CodingChatEvent, type CodingChatKind, type CodingChatMessage,
  type CodingChatSession, type CodingChatSummary, type CodingChatToolCall, type CodingChatUsage,
} from "./chat-types.js";

/** The Polpo MCP tool Claude Code asks for permission (--permission-prompt-tool). */
export const CODING_PERMISSION_TOOL = "permission_prompt";
export const CODING_PERMISSION_TOOL_REF = `mcp__${CLI_TOOL_SERVER_NAME}__${CODING_PERMISSION_TOOL}`;
/** How long a risky action waits for the person before it is denied. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 30 * 60_000;
const MAX_OUTPUT_CHARS = 20_000;
const MAX_TEXT_CHARS = 20_000;

export class CodingChatError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 400, readonly code = "VALIDATION_ERROR") {
    super(message);
    this.name = "CodingChatError";
  }
}

/** The global event (the bus): a session was created, changed status or was deleted. */
export interface CodingChatBusEvent {
  id: string;
  action: "created" | "updated" | "deleted";
  kind: CodingChatKind;
  status: CodingChatSession["status"];
  cwd: string;
  title: string;
  branch?: string;
  workspaceId?: string;
  owner?: string;
}

export interface CodingChatManagerDeps {
  polpoDir: string;
  settings: () => PolpoSettings | undefined;
  /** The instance has member sign-in. */
  instanceAuth: () => boolean;
  /** The worktree as an absolute path, checked (inside the agent workspace or an allowed root, an existing folder); throws why not. */
  checkCwd: (cwd: string) => string;
  /** Tests: fake CLIs. Default: the program on this server. */
  launch?: CliLauncher;
  /** The bus (coding:chat). */
  emit?: (e: CodingChatBusEvent) => void;
  approvalTimeoutMs?: number;
  /** Transcript writes during a turn are batched (ms). */
  persistDelayMs?: number;
  now?: () => Date;
}

export interface CodingChatCreateInput {
  kind: CodingChatKind;
  cwd: string;
  title?: string;
  workspaceId?: string;
  branch?: string;
  /** A CLI account id (default: yours for that CLI on this server). */
  account?: string;
  model?: string;
  /** The first message (the turn starts at once). */
  prompt?: string;
  /** "Open as chat": the terminal session this chat continues (the Coding app's session id and label). */
  fromTerminal?: { id: string; label?: string };
  /** The program's conversation to resume (Claude Code: the terminal's --session-id). */
  resumeSessionId?: string;
}

const RESUME_ID = /^[A-Za-z0-9_-]{1,200}$/;
const LOST_CONVERSATION = /no conversation found|session.*not found|thread.*not found/i;

/** Who acts: the signed-in member (none on a personal installation). */
export interface CodingChatActor {
  member?: string;
}

interface Live {
  conv?: CliConversation;
  stopped: boolean;
  stoppedBy?: string;
  /** The assistant message being written. */
  currentId: string;
  /** Messages sent before the program was ready. */
  queued: string[];
  approvals: Map<string, (approved: boolean) => void>;
  /** The open text segment of the current message (deltas go there until the whole text comes). */
  openText?: number;
  turn: Promise<void>;
}

const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);
const EMAIL = /[^\s@<>()"']+@[^\s@<>()"']+\.[^\s@<>()"']+/;

/** The member's email in an event origin's `by` ("ada@example.com", "ada@example.com via Claude"). */
export function memberOf(by: string | undefined): string | undefined {
  return by ? EMAIL.exec(by)?.[0]?.toLowerCase() : undefined;
}

function addUsage(a: CodingChatUsage, b: CodingChatUsage): CodingChatUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/** The text of an assistant message (its text segments). */
export function messageText(m: CodingChatMessage): string {
  if (m.role === "user") return m.text ?? "";
  return (m.segments ?? []).flatMap((x) => (x.type === "text" ? [x.text] : [])).join("\n").trim();
}

function preview(s: CodingChatSession): string | undefined {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const text = messageText(s.messages[i]!);
    if (text.trim()) return text.replace(/\s+/g, " ").trim().slice(0, 160);
  }
  return undefined;
}

export function summaryOf(s: CodingChatSession): CodingChatSummary {
  const { messages, approvals, ...rest } = s;
  return {
    ...rest,
    messageCount: messages.length,
    pendingApprovals: approvals.filter((a) => a.state === "pending").length,
    ...(preview(s) ? { preview: preview(s) } : {}),
  };
}

/** The instructions the program gets for a coding chat (appended to its own). */
export function codingInstructions(s: Pick<CodingChatSession, "cwd" | "branch" | "owner">): string {
  return [
    "## Polpo Coding",
    `You are working in a git worktree at ${s.cwd}${s.branch ? ` (branch ${s.branch})` : ""}, opened from Polpo's Coding app${s.owner ? ` by ${s.owner}` : ""}, who talks to you in a chat.`,
    "Work inside this directory. Edits and commands inside the worktree run on their own. Installing packages over the network, other network access, git push, and anything that touches files outside the worktree wait for the person's approval in the chat: if they deny it, go on without it or say what they need to do.",
  ].join("\n");
}

export class CodingChatManager {
  readonly store: CodingChatStore;
  private live = new Map<string, Live>();
  private listeners = new Map<string, Set<(e: CodingChatEvent) => void>>();
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private emitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private recovered = false;

  constructor(private readonly deps: CodingChatManagerDeps) {
    this.store = new CodingChatStore(deps.polpoDir);
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  /** After a restart: turns that were running are over (the conversation resumes on the next message). */
  private recover(): void {
    if (this.recovered) return;
    this.recovered = true;
    for (const s of this.store.list()) {
      if (s.status !== "running" && s.status !== "awaiting-approval") continue;
      if (this.live.has(s.id)) continue;
      for (const m of s.messages) {
        if (!m.streaming) continue;
        m.streaming = false;
        for (const seg of m.segments ?? []) if (seg.type === "tool" && seg.tool.state === "running") seg.tool.state = "interrupted";
        m.error = "Interrupted by a server restart";
        m.errorKind = "interrupted";
      }
      for (const a of s.approvals) if (a.state === "pending") { a.state = "expired"; a.resolvedAt = this.now(); }
      s.status = "idle";
      s.errorKind = "interrupted";
      s.lastError = "Interrupted by a server restart: send a message to continue (the conversation resumes).";
      s.updatedAt = this.now();
      this.store.save(s);
    }
  }

  // ── Reads ──────────────────────────────────────────────────────────

  list(filter: { cwd?: string; workspaceId?: string; kind?: CodingChatKind } = {}): CodingChatSummary[] {
    this.recover();
    return this.store.list()
      .filter((s) => (!filter.cwd || s.cwd === filter.cwd) && (!filter.workspaceId || s.workspaceId === filter.workspaceId) && (!filter.kind || s.kind === filter.kind))
      .map(summaryOf);
  }

  get(id: string): CodingChatSession | undefined {
    this.recover();
    return this.store.get(id);
  }

  private mustGet(id: string): CodingChatSession {
    const s = this.get(id);
    if (!s) throw new CodingChatError(`Coding chat ${id} not found`, 404, "NOT_FOUND");
    return s;
  }

  isLive(id: string): boolean {
    return this.live.has(id);
  }

  /** The turn running now, if any (tests and the MCP wait). */
  running(id: string): Promise<void> | undefined {
    return this.live.get(id)?.turn;
  }

  // ── Accounts ───────────────────────────────────────────────────────

  /**
   * The CLI account a member's coding chat uses on this server: the one asked for, else theirs for
   * that CLI, else an instance account the policy allows. A problem says why none (and how to sign in).
   */
  accountFor(kind: CodingChatKind, actor: CodingChatActor, requested?: string): { account: CliAccount } | { problem: string; code: "NO_CLI_ACCOUNT" | "CLI_NOT_ALLOWED" } {
    const settings = this.deps.settings();
    const cli = cliSettingsOf(settings);
    const name = CLI_NAMES[kind];
    const member = actor.member?.toLowerCase();
    const all = (cli?.accounts ?? []).filter((a) => a.cli === kind && a.computer === HOST_COMPUTER_ID);
    const ctx = {
      ...(member ? { initiator: member } : {}),
      origin: member ? "member" as const : "unknown" as const,
      instanceAuth: this.deps.instanceAuth(),
      servesCustomers: instanceServesCustomers(settings as { notifications?: { channels?: Record<string, unknown> } }),
    };
    let account: CliAccount | undefined;
    if (requested) {
      account = all.find((a) => a.id === requested);
      if (!account) return { problem: `${name}: no account "${requested}" on this server (Settings → Harnesses → CLI accounts)`, code: "NO_CLI_ACCOUNT" };
    } else {
      account = (member ? all.find((a) => a.owner === member) : undefined)
        ?? all.find((a) => a.owner === CLI_INSTANCE_OWNER && !cliAccountUseProblem(a, ctx, cli))
        ?? (all.length === 1 && !member ? all[0] : undefined);
    }
    if (!account) {
      return {
        problem: `${name}: you have no account on this server. Add one in Settings → Harnesses → CLI accounts and sign in with your own ${kind === "claude" ? "Claude" : "ChatGPT"} plan (the dashboard opens \`${kind === "claude" ? "claude auth login" : "codex login --device-auth"}\` in a terminal), then send your message again.`,
        code: "NO_CLI_ACCOUNT",
      };
    }
    const refusal = cliAccountUseProblem(account, ctx, cli);
    if (refusal) return { problem: refusal, code: "CLI_NOT_ALLOWED" };
    return { account };
  }

  // ── Writes ─────────────────────────────────────────────────────────

  create(input: CodingChatCreateInput, actor: CodingChatActor): CodingChatSession {
    this.recover();
    if (!(CODING_CHAT_KINDS as string[]).includes(input.kind)) throw new CodingChatError(`kind must be one of ${CODING_CHAT_KINDS.join(", ")}`);
    let cwd: string;
    try { cwd = this.deps.checkCwd(input.cwd); } catch (err) { throw new CodingChatError((err as Error).message); }
    if (input.model !== undefined && !/^[A-Za-z0-9._:/@[\]-]{1,200}$/.test(input.model)) throw new CodingChatError("model must be a model id or alias");
    if (input.resumeSessionId !== undefined && !RESUME_ID.test(input.resumeSessionId)) throw new CodingChatError("resumeSessionId must be the program's session id (letters, digits, - and _)");
    if (input.fromTerminal && (typeof input.fromTerminal.id !== "string" || !input.fromTerminal.id.trim())) throw new CodingChatError("fromTerminal.id is required");
    const now = this.now();
    const member = actor.member?.toLowerCase();
    const s: CodingChatSession = {
      id: newId("cc"),
      kind: input.kind,
      title: (input.title?.trim() || (input.kind === "claude" ? "Claude Code" : "Codex")).slice(0, 120),
      cwd,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.branch ? { branch: input.branch } : {}),
      ...(member ? { owner: member } : {}),
      ...(input.account ? { account: input.account } : {}),
      ...(input.model ? { model: input.model } : {}),
      status: "idle",
      messages: [],
      approvals: [],
      usage: { ...ZERO_CODING_USAGE },
      costUsd: 0,
      turns: 0,
      ...(input.fromTerminal || input.resumeSessionId ? { continuedFrom: this.continuation(input) } : {}),
      // the first turn resumes the terminal's conversation
      ...(input.resumeSessionId ? { runtimeSessionId: input.resumeSessionId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    // say at once when there is no account to run it (the chat shows how to sign in)
    const acc = this.accountFor(s.kind, actor, input.account);
    if ("problem" in acc) {
      s.status = "error";
      s.errorKind = acc.code === "NO_CLI_ACCOUNT" ? "no-account" : "not-allowed";
      s.lastError = acc.problem;
    } else {
      s.account = acc.account.id;
    }
    this.store.save(s);
    this.bus(s, "created");
    if (input.prompt?.trim() && !("problem" in acc)) this.startTurn(s, input.prompt.trim(), actor);
    return s;
  }

  /** What a chat opened from a terminal session says first, and whether it resumes its conversation. */
  private continuation(input: CodingChatCreateInput): NonNullable<CodingChatSession["continuedFrom"]> {
    const name = input.kind === "claude" ? "Claude Code" : "Codex";
    const t = input.fromTerminal;
    const label = t?.label?.trim() ? `“${t.label.trim()}”` : t ? t.id : "a terminal";
    const base = {
      terminalId: t?.id ?? "",
      ...(t?.label?.trim() ? { label: t.label.trim().slice(0, 120) } : {}),
    };
    if (input.resumeSessionId) {
      return {
        ...base, resumeSessionId: input.resumeSessionId, status: "pending",
        note: `Continued from terminal session ${label}: the first message resumes ${name}'s conversation ${input.resumeSessionId}. The terminal session stays open.`,
      };
    }
    return {
      ...base, status: "new",
      note: `Continued from terminal session ${label}: ${name} terminal sessions keep no conversation id Polpo can resume, so this chat starts a new conversation in the same worktree. The terminal session stays open.`,
    };
  }

  /**
   * The terminal's conversation cannot be resumed with this account (the terminal ran with this
   * server's own sign-in, or another account): the chat goes on with a new conversation and says so.
   */
  private terminalConversationLost(s: CodingChatSession, account: CliAccount): void {
    const c = s.continuedFrom;
    if (!c || c.status !== "pending") return;
    const name = s.kind === "claude" ? "Claude Code" : "Codex";
    s.continuedFrom = {
      ...c, status: "new",
      note: `Continued from terminal session ${c.label ? `“${c.label}”` : c.terminalId}: its ${name} conversation ${c.resumeSessionId ?? ""} is not readable with your CLI account "${account.id}" (the terminal ran with this server's own ${name} sign-in, or another account), so this chat started a new conversation in the same worktree. The terminal session stays open, with its conversation.`,
    };
    this.emitSession(s);
  }

  private assertOwner(s: CodingChatSession, actor: CodingChatActor): void {
    const member = actor.member?.toLowerCase();
    if (s.owner && member !== s.owner) {
      throw new CodingChatError(`This session runs on ${s.owner}'s CLI account: only they can use it`, 403, "FORBIDDEN");
    }
  }

  /** A message: a new turn, or a steer when a turn is running. */
  send(id: string, text: string, actor: CodingChatActor): { steered: boolean; session: CodingChatSession } {
    const s = this.mustGet(id);
    this.assertOwner(s, actor);
    const t = text.trim();
    if (!t) throw new CodingChatError("text is required");
    if (t.length > 100_000) throw new CodingChatError("text is too long (100,000 characters at most)");
    const live = this.live.get(id);
    if (live) {
      // into the running turn: the program reads it after its current tool calls
      const user: CodingChatMessage = { id: newId("m"), role: "user", ts: this.now(), text: t, kind: "steer" };
      const prev = s.messages.find((m) => m.id === live.currentId);
      if (prev) prev.streaming = false;
      const next: CodingChatMessage = { id: newId("m"), role: "assistant", ts: this.now(), segments: [], streaming: true };
      s.messages.push(user, next);
      live.currentId = next.id;
      live.openText = undefined;
      if (live.conv) void live.conv.session.steer(t).catch(() => undefined);
      else live.queued.push(t);
      this.touch(s);
      if (prev) this.emitMessage(s, prev, true);
      this.emitMessage(s, user, true);
      this.emitMessage(s, next, true);
      return { steered: true, session: s };
    }
    this.startTurn(s, t, actor);
    return { steered: false, session: s };
  }

  /** Stop the running turn (the conversation stays); pending approvals are denied. */
  async stop(id: string, actor: CodingChatActor): Promise<CodingChatSession> {
    const s = this.mustGet(id);
    this.assertOwner(s, actor);
    const live = this.live.get(id);
    if (!live) return s;
    live.stopped = true;
    live.stoppedBy = actor.member;
    for (const resolve of live.approvals.values()) resolve(false);
    await live.conv?.session.interrupt().catch(() => undefined);
    await live.turn.catch(() => undefined);
    return this.mustGet(id);
  }

  resolveApproval(id: string, approvalId: string, decision: "approve" | "deny", actor: CodingChatActor): CodingChatApproval {
    const s = this.mustGet(id);
    this.assertOwner(s, actor);
    const a = s.approvals.find((x) => x.id === approvalId);
    if (!a) throw new CodingChatError(`Approval ${approvalId} not found`, 404, "NOT_FOUND");
    if (a.state !== "pending") throw new CodingChatError(`Approval ${approvalId} is already ${a.state}`, 409, "ALREADY_RESOLVED");
    const resolve = this.live.get(id)?.approvals.get(approvalId);
    if (!resolve) {
      a.state = "expired";
      a.resolvedAt = this.now();
      this.touch(s);
      throw new CodingChatError("This approval is no longer waiting (the turn ended)", 409, "EXPIRED");
    }
    a.resolvedBy = actor.member ?? "local";
    resolve(decision === "approve");
    return a;
  }

  async delete(id: string, actor: CodingChatActor): Promise<boolean> {
    const s = this.mustGet(id);
    this.assertOwner(s, actor);
    if (this.live.has(id)) await this.stop(id, actor);
    const t = this.persistTimers.get(id);
    if (t) clearTimeout(t);
    this.persistTimers.delete(id);
    const ok = this.store.delete(id);
    this.bus(s, "deleted");
    for (const l of this.listeners.get(id) ?? []) l({ type: "deleted" });
    this.listeners.delete(id);
    return ok;
  }

  subscribe(id: string, fn: (e: CodingChatEvent) => void): () => void {
    let set = this.listeners.get(id);
    if (!set) { set = new Set(); this.listeners.set(id, set); }
    set.add(fn);
    return () => { set!.delete(fn); if (!set!.size) this.listeners.delete(id); };
  }

  /** Stop every running turn (server shutdown). */
  async close(): Promise<void> {
    await Promise.all([...this.live.keys()].map(async (id) => {
      const live = this.live.get(id);
      if (!live) return;
      live.stopped = true;
      for (const r of live.approvals.values()) r(false);
      await live.conv?.session.interrupt().catch(() => undefined);
      await live.turn.catch(() => undefined);
    }));
    for (const [id, t] of this.persistTimers) { clearTimeout(t); const s = this.store.get(id); if (s) this.store.save(s); }
    this.persistTimers.clear();
  }

  // ── Events and persistence ────────────────────────────────────────

  private emit(id: string, e: CodingChatEvent): void {
    for (const l of this.listeners.get(id) ?? []) {
      try { l(e); } catch { /* a listener's problem */ }
    }
  }

  /** A message changed: to the listeners now, or batched while text streams in. */
  private emitMessage(s: CodingChatSession, m: CodingChatMessage, now = false): void {
    const key = `${s.id}:${m.id}`;
    const fire = () => { this.emitTimers.delete(key); this.emit(s.id, { type: "message", message: m }); };
    if (now) {
      const t = this.emitTimers.get(key);
      if (t) clearTimeout(t);
      fire();
      return;
    }
    if (!this.emitTimers.has(key)) this.emitTimers.set(key, setTimeout(fire, 40));
  }

  private emitSession(s: CodingChatSession): void {
    this.emit(s.id, { type: "session", session: summaryOf(s) });
  }

  private bus(s: CodingChatSession, action: CodingChatBusEvent["action"]): void {
    this.deps.emit?.({
      id: s.id, action, kind: s.kind, status: s.status, cwd: s.cwd, title: s.title,
      ...(s.branch ? { branch: s.branch } : {}), ...(s.workspaceId ? { workspaceId: s.workspaceId } : {}), ...(s.owner ? { owner: s.owner } : {}),
    });
  }

  /** Save now (status changes, the end of a turn). */
  private touch(s: CodingChatSession): void {
    s.updatedAt = this.now();
    const t = this.persistTimers.get(s.id);
    if (t) { clearTimeout(t); this.persistTimers.delete(s.id); }
    if (!this.store.get(s.id)) return; // deleted meanwhile
    this.store.save(s);
  }

  /** Save soon (text and tool output streaming in). */
  private persistSoon(s: CodingChatSession): void {
    if (this.persistTimers.has(s.id)) return;
    this.persistTimers.set(s.id, setTimeout(() => {
      this.persistTimers.delete(s.id);
      if (!this.store.get(s.id)) return;
      s.updatedAt = this.now();
      this.store.save(s);
    }, this.deps.persistDelayMs ?? 400));
  }

  private setStatus(s: CodingChatSession, status: CodingChatSession["status"]): void {
    if (s.status === status) return;
    s.status = status;
    this.touch(s);
    this.emitSession(s);
    this.bus(s, "updated");
  }

  // ── Turns ──────────────────────────────────────────────────────────

  private startTurn(s: CodingChatSession, prompt: string, actor: CodingChatActor): void {
    const user: CodingChatMessage = { id: newId("m"), role: "user", ts: this.now(), text: prompt, kind: "prompt" };
    const assistant: CodingChatMessage = { id: newId("m"), role: "assistant", ts: this.now(), segments: [], streaming: true };
    const history = this.historyText(s);
    s.messages.push(user, assistant);
    s.lastError = undefined;
    s.errorKind = undefined;
    const live: Live = { stopped: false, currentId: assistant.id, queued: [], approvals: new Map(), turn: Promise.resolve() };
    this.live.set(s.id, live);
    this.emitMessage(s, user, true);
    this.emitMessage(s, assistant, true);
    s.status = "running";
    this.touch(s);
    this.emitSession(s);
    this.bus(s, "updated");
    live.turn = this.runTurn(s, live, prompt, history, actor).finally(() => {
      this.live.delete(s.id);
    });
  }

  /** The conversation so far as text, for a new CLI conversation (another account, a lost session). */
  private historyText(s: CodingChatSession): string {
    const parts: string[] = [];
    for (const m of s.messages) {
      const text = messageText(m);
      if (text) parts.push(`${m.role === "user" ? "Person" : "You"}: ${text}`);
    }
    const all = parts.join("\n\n");
    return all.length > 8000 ? `…${all.slice(-8000)}` : all;
  }

  private current(s: CodingChatSession, live: Live): CodingChatMessage {
    let m = s.messages.find((x) => x.id === live.currentId);
    if (!m) {
      m = { id: newId("m"), role: "assistant", ts: this.now(), segments: [], streaming: true };
      s.messages.push(m);
      live.currentId = m.id;
    }
    m.segments ??= [];
    return m;
  }

  private findTool(s: CodingChatSession, id: string): CodingChatToolCall | undefined {
    for (let i = s.messages.length - 1; i >= 0; i--) {
      for (const seg of s.messages[i]!.segments ?? []) if (seg.type === "tool" && seg.tool.id === id) return seg.tool;
    }
    return undefined;
  }

  private onEvent(s: CodingChatSession, live: Live, e: CliEvent): void {
    if (e.type === "steer-read" || e.type === "error") return;
    if (e.type === "session") {
      s.runtimeSessionId = e.sessionId;
      if (e.model) s.model = e.model;
      this.persistSoon(s);
      return;
    }
    const m = this.current(s, live);
    const segs = m.segments!;
    switch (e.type) {
      case "text-delta": {
        const open = live.openText !== undefined ? segs[live.openText] : undefined;
        if (open && open.type === "text") open.text = clip(open.text + e.text, MAX_TEXT_CHARS);
        else { segs.push({ type: "text", text: e.text }); live.openText = segs.length - 1; }
        this.emitMessage(s, m);
        break;
      }
      case "text": {
        const open = live.openText !== undefined ? segs[live.openText] : undefined;
        if (open && open.type === "text") open.text = clip(e.text, MAX_TEXT_CHARS);
        else {
          const last = segs[segs.length - 1];
          if (!(last?.type === "text" && last.text === e.text)) segs.push({ type: "text", text: clip(e.text, MAX_TEXT_CHARS) });
        }
        live.openText = undefined;
        this.emitMessage(s, m);
        break;
      }
      case "reasoning": {
        live.openText = undefined;
        const last = segs[segs.length - 1];
        if (last?.type === "reasoning") last.text = clip(`${last.text}\n${e.text}`, MAX_TEXT_CHARS);
        else segs.push({ type: "reasoning", text: clip(e.text, MAX_TEXT_CHARS) });
        this.emitMessage(s, m);
        break;
      }
      case "tool-call": {
        live.openText = undefined;
        const input = (e.input && typeof e.input === "object" ? e.input : {}) as Record<string, unknown>;
        if (this.findTool(s, e.id)) break; // already there (a replayed item)
        const diff = editDiff(e.name, input);
        segs.push({ type: "tool", tool: { id: e.id, name: e.name, input, state: "running", ...(diff ? { diff } : {}) } });
        this.emitMessage(s, m, true);
        break;
      }
      case "tool-result": {
        const tool = this.findTool(s, e.id);
        const output = typeof e.output === "string" ? e.output : JSON.stringify(e.output);
        if (tool) {
          tool.output = clip(output, MAX_OUTPUT_CHARS);
          tool.state = e.isError ? "error" : "completed";
          const owner = s.messages.find((x) => x.segments?.some((seg) => seg.type === "tool" && seg.tool === tool));
          if (owner) this.emitMessage(s, owner, true);
          if (changesFiles(tool.name)) this.emit(s.id, { type: "files-changed", tool: tool.name });
        }
        break;
      }
    }
    this.persistSoon(s);
  }

  /** A risky action waits for the person: true when they approve. */
  private ask(s: CodingChatSession, live: Live, o: { tool: string; toolUseId?: string; input: unknown; reason: string; category: CodingRiskCategory }): Promise<boolean> {
    if (live.stopped) return Promise.resolve(false);
    const approval: CodingChatApproval = {
      id: newId("ap"), tool: o.tool, ...(o.toolUseId ? { toolUseId: o.toolUseId } : {}), input: o.input,
      summary: describeCodingAction(o.tool, o.input), reason: o.reason, category: o.category, state: "pending", requestedAt: this.now(),
    };
    s.approvals.push(approval);
    const m = this.current(s, live);
    live.openText = undefined;
    m.segments!.push({ type: "approval", approvalId: approval.id });
    this.emit(s.id, { type: "approval", approval });
    this.emitMessage(s, m, true);
    this.setStatus(s, "awaiting-approval");
    this.touch(s);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false, "expired"), this.deps.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      const finish = (approved: boolean, state?: "expired") => {
        if (!live.approvals.has(approval.id)) return;
        clearTimeout(timer);
        live.approvals.delete(approval.id);
        approval.state = state ?? (approved ? "approved" : "denied");
        approval.resolvedAt = this.now();
        if (!approval.resolvedBy && live.stopped) approval.resolvedBy = live.stoppedBy ?? "stop";
        this.emit(s.id, { type: "approval", approval });
        if (!live.approvals.size && !live.stopped) this.setStatus(s, "running");
        this.touch(s);
        resolve(approved);
      };
      live.approvals.set(approval.id, (approved) => finish(approved));
    });
  }

  /** Claude Code's permission prompt (an MCP tool of the turn's Polpo server). */
  private permissionTool(s: CodingChatSession, live: Live): HarnessHostTool {
    return {
      name: CODING_PERMISSION_TOOL,
      description: "Polpo's approval prompt for Claude Code's tool permissions (--permission-prompt-tool). Not for direct use.",
      inputSchema: {
        type: "object",
        properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } },
        required: ["tool_name", "input"],
      },
      execute: async (raw) => {
        const r = (raw ?? {}) as { tool_name?: unknown; input?: unknown; tool_use_id?: unknown };
        const tool = typeof r.tool_name === "string" ? r.tool_name : "tool";
        const input = r.input && typeof r.input === "object" ? r.input as Record<string, unknown> : {};
        const risk = classifyCodingAction({ tool, input, cwd: s.cwd });
        if (!risk.risky) return JSON.stringify({ behavior: "allow", updatedInput: input });
        const approved = await this.ask(s, live, {
          tool, input, reason: risk.reason, category: risk.category,
          ...(typeof r.tool_use_id === "string" ? { toolUseId: r.tool_use_id } : {}),
        });
        return JSON.stringify(approved
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: live.stopped ? "The person stopped the turn." : "The person denied this in Polpo's chat: do not retry it; continue without it or explain what they need to do." });
      },
    };
  }

  /** Codex's approval requests: it asks only to leave its sandbox, so every one waits for the person. */
  private codexApproval(s: CodingChatSession, live: Live) {
    return async (method: string, params: Record<string, unknown>): Promise<"accept" | "decline"> => {
      const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
      const known = itemId ? this.findTool(s, itemId) : undefined;
      const isFile = /fileChange/i.test(method) || /applyPatch/i.test(method);
      const command = Array.isArray(params.command) ? (params.command as unknown[]).map(String).join(" ") : typeof params.command === "string" ? params.command : undefined;
      const tool = isFile ? "apply_patch" : "shell";
      const input: Record<string, unknown> = { ...(known?.input ?? {}), ...(command ? { command } : {}), ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}) };
      const risk = classifyCodingAction({ tool, input, cwd: s.cwd });
      const asked = typeof params.reason === "string" && params.reason.trim() ? params.reason.trim() : undefined;
      const approved = await this.ask(s, live, {
        tool, input, ...(itemId ? { toolUseId: itemId } : {}),
        reason: risk.risky ? risk.reason : asked ?? "Codex asks to leave its sandbox (network, or files outside the worktree)",
        category: risk.risky ? risk.category : isFile ? "outside-worktree" : "network",
      });
      return approved ? "accept" : "decline";
    };
  }

  private async runTurn(s: CodingChatSession, live: Live, prompt: string, history: string, actor: CodingChatActor): Promise<void> {
    let account: CliAccount | undefined;
    let end: CliTurnEnd | undefined;
    let failure: { message: string; kind: CodingChatErrorKind } | undefined;
    const open = async (resume: string | undefined) => {
      const engine: AgentCliEngine = s.kind === "claude"
        ? {
          type: "cli", cli: "claude", permissionMode: "allow-reads",
          ...(s.model ? { model: s.model } : {}),
          // risky permissions come to Polpo's chat; text streams as it is written
          args: ["--permission-prompt-tool", CODING_PERMISSION_TOOL_REF, "--include-partial-messages"],
        }
        : { type: "cli", cli: "codex", permissionMode: "allow-edits", ...(s.model ? { model: s.model } : {}) };
      const timeout = (this.deps.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS) + 60_000;
      return openCliConversation({
        agent: { name: "coding", role: "Coding session" } as AgentConfig,
        engine, account: account!, computerId: HOST_COMPUTER_ID, cwd: s.cwd, polpoDir: this.deps.polpoDir,
        instructions: () => codingInstructions(s),
        ...(resume ? { resume } : {}),
        tools: s.kind === "claude" ? [this.permissionTool(s, live)] : [],
        ...(this.deps.launch ? { launch: this.deps.launch } : {}),
        inbox: `/tmp/polpo-cli-inbox-coding-${s.id}.jsonl`,
        log: () => {},
        // the permission prompt may wait for the person: Claude Code's MCP tool timeout covers it
        ...(s.kind === "claude" ? { env: { MCP_TOOL_TIMEOUT: String(timeout) } } : {}),
        ...(s.kind === "codex" ? { codexApproval: this.codexApproval(s, live) } : {}),
      });
    };
    try {
      // the session's account while it is still there, else the person's own
      const known = s.account && (cliSettingsOf(this.deps.settings())?.accounts ?? []).some((a) => a.id === s.account && a.cli === s.kind && a.computer === HOST_COMPUTER_ID);
      const acc = this.accountFor(s.kind, actor, known ? s.account : undefined);
      if ("problem" in acc) {
        failure = { message: acc.problem, kind: acc.code === "NO_CLI_ACCOUNT" ? "no-account" : "not-allowed" };
        return;
      }
      account = acc.account;
      const sameAccount = s.account === account.id;
      s.account = account.id;
      let resume = sameAccount ? s.runtimeSessionId : undefined;
      if (!resume && s.continuedFrom?.status === "pending") this.terminalConversationLost(s, account);
      const onEvent = (e: CliEvent) => this.onEvent(s, live, e);
      for (let attempt = 0; attempt < 2; attempt++) {
        if (live.stopped) return;
        const text = !resume && history ? `Our conversation so far (for context):\n\n${history}\n\n---\n\n${prompt}` : prompt;
        live.conv = await open(resume);
        if (live.stopped) { await live.conv.session.interrupt().catch(() => undefined); return; }
        for (const q of live.queued.splice(0)) void live.conv.session.steer(q).catch(() => undefined);
        try {
          end = await live.conv.session.turn(text, onEvent);
        } catch (err) {
          if (live.stopped) return;
          const raw = [(err as Error).message, live.conv.proc.stderrTail()].filter(Boolean).join("\n");
          // the program lost the conversation (another machine, a cleared account): a new one, with the transcript as context
          if (resume && LOST_CONVERSATION.test(raw)) {
            this.terminalConversationLost(s, account);
            await live.conv.close().catch(() => undefined);
            live.conv = undefined;
            resume = undefined;
            s.runtimeSessionId = undefined;
            continue;
          }
          throw new Error(raw);
        }
        if (!end.ok && resume && LOST_CONVERSATION.test(end.error ?? "")) {
          this.terminalConversationLost(s, account);
          await live.conv.close().catch(() => undefined);
          live.conv = undefined;
          resume = undefined;
          s.runtimeSessionId = undefined;
          end = undefined;
          continue;
        }
        break;
      }
      if (end?.sessionId) s.runtimeSessionId = end.sessionId;
      if (end?.ok && resume && s.continuedFrom?.status === "pending") {
        s.continuedFrom = { ...s.continuedFrom, status: "resumed" };
        this.emitSession(s);
      }
      if (live.conv?.session.model) s.model = live.conv.session.model;
      if (end && !end.ok && !live.stopped) {
        const c = classifyCliError(s.kind, [end.error, live.conv?.proc.stderrTail()].filter(Boolean).join("\n"), account);
        failure = { message: c.message, kind: c.kind === "other" ? "other" : c.kind };
      }
    } catch (err) {
      if (!live.stopped) {
        const raw = err instanceof Error ? err.message : String(err);
        const c = classifyCliError(s.kind, raw, account);
        failure = { message: c.message, kind: c.kind === "other" ? "other" : c.kind };
      }
    } finally {
      await live.conv?.close().catch(() => undefined);
      live.conv = undefined;
      for (const resolve of live.approvals.values()) resolve(false);
      const m = s.messages.find((x) => x.id === live.currentId);
      if (m) {
        m.streaming = false;
        for (const seg of m.segments ?? []) {
          if (seg.type === "tool" && seg.tool.state === "running") seg.tool.state = live.stopped || failure ? "interrupted" : "completed";
        }
        if (end) {
          m.usage = { ...end.usage };
          if (end.estimateUsd) m.costUsd = end.estimateUsd;
          if (s.model) m.model = s.model;
          s.usage = addUsage(s.usage, end.usage);
          s.costUsd += end.estimateUsd ?? 0;
          s.turns += 1;
          // the final answer, when nothing streamed it
          if (end.ok && end.text && !(m.segments ?? []).some((x) => x.type === "text")) m.segments!.push({ type: "text", text: clip(end.text, MAX_TEXT_CHARS) });
        }
        if (live.stopped) { m.error = live.stoppedBy ? `Stopped by ${live.stoppedBy}` : "Stopped"; m.errorKind = "interrupted"; }
        else if (failure) { m.error = failure.message; m.errorKind = failure.kind; }
      }
      // older steered messages of this turn are done too
      for (const x of s.messages) if (x.streaming) x.streaming = false;
      if (failure && !live.stopped) {
        s.lastError = failure.message;
        s.errorKind = failure.kind;
      }
      s.status = failure && !live.stopped ? "error" : "idle";
      if (this.store.get(s.id)) {
        this.touch(s);
        if (m) this.emitMessage(s, m, true);
        this.emitSession(s);
        this.bus(s, "updated");
      }
    }
  }
}

/** A fresh id for things outside the manager (tests). */
export const newCodingChatId = (): string => `cc_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
