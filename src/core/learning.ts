/**
 * Learning from conversations (opt-in per agent, `learning` in its config): every N new messages in
 * the agent's chats, or after a quiet period, the agent reviews them in a session of its own and
 * updates its memory and its own skills. Every change is recorded (before / after) and can be reverted.
 *
 * State and history live in .polpo/learning/<agent>/ (state.json, changes/<id>.json).
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { agentMemoryScope, type AgentConfig, type MemoryStore, type SessionStore } from "@polpo-ai/core";

export type LearningChangeKind = "memory" | "skill-created" | "skill-updated";

export interface LearningChange {
  id: string;
  agent: string;
  at: string;
  kind: LearningChangeKind;
  /** "memory", or the skill name. */
  target: string;
  before: string;
  after: string;
  /** "review": made while reviewing conversations; "chat": the agent did it while talking. */
  source: "review" | "chat";
  revertedAt?: string;
}

interface LearningState {
  /** Last message reviewed, per session. */
  cursors: Record<string, string>;
  /** New messages since the last review. */
  pending: number;
  /** The agent's own session where reviews happen. */
  runSessionId?: string;
  lastReviewAt?: string;
}

/** Sessions that are not conversations to learn from (the reviews themselves, recurring checks, reflections). */
export function isLearningExcluded(scope: string | undefined): boolean {
  return !!scope && (scope.startsWith("learning:") || scope.startsWith("check:") || scope.startsWith("reflection:"));
}

export const DEFAULT_LEARNING_EVERY = 30;
export const DEFAULT_LEARNING_IDLE_MINUTES = 30;
/** Fewest messages worth a review when the conversation goes quiet. */
const MIN_IDLE_REVIEW = 4;
/** What one review reads at most (the most recent part wins). */
const MAX_TRANSCRIPT_CHARS = 40_000;
const MAX_MESSAGE_CHARS = 1_500;

function atomicWrite(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${nanoid(6)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
}

export class FileLearningStore {
  constructor(private readonly polpoDir: string) {}

  private dir(agent: string): string {
    const dir = join(this.polpoDir, "learning", encodeURIComponent(agent));
    mkdirSync(join(dir, "changes"), { recursive: true });
    return dir;
  }

  getState(agent: string): LearningState {
    try {
      return { cursors: {}, pending: 0, ...JSON.parse(readFileSync(join(this.dir(agent), "state.json"), "utf-8")) };
    } catch {
      return { cursors: {}, pending: 0 };
    }
  }

  saveState(agent: string, state: LearningState): void {
    atomicWrite(join(this.dir(agent), "state.json"), state);
  }

  addChange(change: Omit<LearningChange, "id" | "at">): LearningChange {
    const full: LearningChange = { ...change, id: `lrn_${nanoid(10)}`, at: new Date().toISOString() };
    atomicWrite(join(this.dir(change.agent), "changes", `${full.id}.json`), full);
    return full;
  }

  getChange(agent: string, id: string): LearningChange | undefined {
    try {
      return JSON.parse(readFileSync(join(this.dir(agent), "changes", `${encodeURIComponent(id)}.json`), "utf-8")) as LearningChange;
    } catch {
      return undefined;
    }
  }

  updateChange(change: LearningChange): void {
    atomicWrite(join(this.dir(change.agent), "changes", `${change.id}.json`), change);
  }

  /** Newest first. */
  listChanges(agent: string, limit = 50): LearningChange[] {
    const dir = join(this.dir(agent), "changes");
    const changes: LearningChange[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try { changes.push(JSON.parse(readFileSync(join(dir, name), "utf-8")) as LearningChange); } catch { /* foreign file */ }
    }
    return changes.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }
}

/** Reads and writes an agent's own skills (SKILL.md in the skill pool). */
export interface LearningSkillPort {
  read(name: string): string | undefined;
  /** Write the whole SKILL.md (frontmatter included). */
  write(name: string, content: string): void;
  remove(name: string): void;
  /** Give the skill to the agent, or take it back. */
  assign(agent: string, name: string, assigned: boolean): Promise<void>;
}

/** One review: a turn of the agent's review session with this prompt. */
export type LearningRunner = (input: { agent: AgentConfig; sessionId: string; prompt: string; signal: AbortSignal }) => Promise<{ text: string } | "deferred">;

export interface LearningDeps {
  getAgents(): Promise<AgentConfig[]>;
  sessions: SessionStore;
  memory?: MemoryStore;
  store: FileLearningStore;
  skills: LearningSkillPort;
  /** Creates the agent's review session. */
  createReviewSession(agent: string): Promise<string>;
  emit(event: "agent:learned", payload: {
    agentName: string; messages: number; summary: string; timestamp: string;
    changes: { id: string; kind: LearningChangeKind; target: string }[];
  }): void;
  log(level: "info" | "warn", message: string): void;
}

const REVIEW_TIMEOUT_MS = 15 * 60_000;

export class LearningManager {
  private runner?: LearningRunner;
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly reviewing = new Map<string, AbortController>();

  constructor(private readonly deps: LearningDeps) {}

  setRunner(runner: LearningRunner): void { this.runner = runner; }

  /** True while the agent reviews its conversations (skill changes are then recorded as "review"). */
  isReviewing(agent: string): boolean { return this.reviewing.has(agent); }

  dispose(): void {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    for (const controller of this.reviewing.values()) controller.abort();
    this.reviewing.clear();
  }

  /** A chat message was stored: count it for its agent and review when enough have arrived. */
  async onMessageAdded(sessionId: string): Promise<void> {
    const session = await this.deps.sessions.getSession(sessionId).catch(() => undefined);
    if (!session?.agent || isLearningExcluded(session.scope)) return;
    const agent = (await this.deps.getAgents()).find((a) => a.name === session.agent);
    if (!agent?.learning?.enabled) return;
    const state = this.deps.store.getState(agent.name);
    state.pending += 1;
    this.deps.store.saveState(agent.name, state);
    const every = Math.max(1, agent.learning.everyMessages ?? DEFAULT_LEARNING_EVERY);
    if (state.pending >= every) {
      void this.review(agent.name, "messages");
      return;
    }
    this.armIdle(agent);
  }

  private armIdle(agent: AgentConfig): void {
    const minutes = agent.learning?.idleMinutes ?? DEFAULT_LEARNING_IDLE_MINUTES;
    clearTimeout(this.idleTimers.get(agent.name));
    if (minutes <= 0) return;
    const timer = setTimeout(() => {
      this.idleTimers.delete(agent.name);
      if (this.deps.store.getState(agent.name).pending >= MIN_IDLE_REVIEW) void this.review(agent.name, "idle");
    }, minutes * 60_000);
    timer.unref?.();
    this.idleTimers.set(agent.name, timer);
  }

  /** The messages since the last review, as one transcript (newest kept when too long). */
  private async collect(agent: string, cursors: Record<string, string>): Promise<{ text: string; count: number; cursors: Record<string, string> }> {
    const sessions = (await this.deps.sessions.listSessions())
      .filter((s) => s.agent === agent && !isLearningExcluded(s.scope))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const parts: string[] = [];
    const next = { ...cursors };
    let count = 0;
    for (const session of sessions) {
      const all = await this.deps.sessions.getMessages(session.id);
      const cursor = cursors[session.id];
      const from = cursor ? all.findIndex((m) => m.id === cursor) + 1 : 0;
      const fresh = all.slice(from).filter((m) => (m.role === "user" || m.role === "assistant") && m.content?.trim());
      if (all.length) next[session.id] = all[all.length - 1]!.id;
      if (!fresh.length) continue;
      count += fresh.length;
      const where = session.scope ? `group chat ${session.title ?? session.scope}` : `chat "${session.title ?? session.id}"`;
      parts.push(`## ${where}\n${fresh.map((m) => {
        const text = m.content.length > MAX_MESSAGE_CHARS ? `${m.content.slice(0, MAX_MESSAGE_CHARS)}…` : m.content;
        return `${m.role === "user" ? "Them" : "You"}: ${text}`;
      }).join("\n")}`);
    }
    let text = parts.join("\n\n");
    if (text.length > MAX_TRANSCRIPT_CHARS) text = `…\n${text.slice(text.length - MAX_TRANSCRIPT_CHARS)}`;
    return { text, count, cursors: next };
  }

  /** Review the conversations since the last time and learn from them. Returns what changed. */
  async review(agentName: string, reason: "messages" | "idle" | "manual" = "manual"): Promise<LearningChange[]> {
    if (!this.runner || this.reviewing.has(agentName)) return [];
    const agent = (await this.deps.getAgents()).find((a) => a.name === agentName);
    if (!agent) return [];
    clearTimeout(this.idleTimers.get(agentName));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REVIEW_TIMEOUT_MS);
    this.reviewing.set(agentName, controller);
    const startedAt = new Date().toISOString();
    try {
      const state = this.deps.store.getState(agentName);
      const { text, count, cursors } = await this.collect(agentName, state.cursors);
      if (count === 0) {
        this.deps.store.saveState(agentName, { ...state, cursors, pending: 0 });
        return [];
      }
      let runSessionId = state.runSessionId;
      if (!runSessionId || !(await this.deps.sessions.getSession(runSessionId))) {
        runSessionId = await this.deps.createReviewSession(agentName);
      }
      const scope = agentMemoryScope(agentName);
      const memoryBefore = await this.deps.memory?.get(scope) ?? "";
      const result = await this.runner({ agent, sessionId: runSessionId, prompt: reviewPrompt(agent, text, count), signal: controller.signal });
      if (result === "deferred") return [];

      const changes: LearningChange[] = [];
      const memoryAfter = await this.deps.memory?.get(scope) ?? "";
      if (memoryAfter !== memoryBefore) {
        changes.push(this.deps.store.addChange({ agent: agentName, kind: "memory", target: "memory", before: memoryBefore, after: memoryAfter, source: "review" }));
      }
      // skill changes were recorded by the skill tools during the review
      changes.push(...this.deps.store.listChanges(agentName, 100).filter((c) => c.source === "review" && c.at >= startedAt && c.kind !== "memory"));
      this.deps.store.saveState(agentName, { ...state, cursors, pending: 0, runSessionId, lastReviewAt: new Date().toISOString() });
      const summary = result.text.trim().slice(0, 500);
      this.deps.emit("agent:learned", {
        agentName, messages: count, summary, timestamp: new Date().toISOString(),
        changes: changes.map((c) => ({ id: c.id, kind: c.kind, target: c.target })),
      });
      this.deps.log("info", `[learning] ${agentName} reviewed ${count} messages (${reason}): ${changes.length} change(s)`);
      return changes;
    } catch (err) {
      this.deps.log("warn", `[learning] ${agentName}: review failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    } finally {
      clearTimeout(timeout);
      this.reviewing.delete(agentName);
    }
  }

  /** Record a change the agent made to one of its own skills (tools call this). */
  recordSkillChange(agent: string, kind: "skill-created" | "skill-updated", name: string, before: string, after: string): LearningChange {
    return this.deps.store.addChange({ agent, kind, target: name, before, after, source: this.isReviewing(agent) ? "review" : "chat" });
  }

  listChanges(agent: string, limit?: number): LearningChange[] {
    return this.deps.store.listChanges(agent, limit);
  }

  /**
   * Put back what was there before a change. Refused when the memory or the skill changed again since
   * (reverting would lose the later change).
   */
  async revert(agent: string, changeId: string): Promise<LearningChange> {
    const change = this.deps.store.getChange(agent, changeId);
    if (!change) throw new Error(`No learning change ${changeId} for ${agent}`);
    if (change.revertedAt) throw new Error("This change was already reverted");
    if (change.kind === "memory") {
      if (!this.deps.memory) throw new Error("No memory store");
      const scope = agentMemoryScope(agent);
      if (await this.deps.memory.get(scope) !== change.after) throw new Error("The memory changed again since: edit it instead");
      await this.deps.memory.save(change.before, scope);
    } else {
      const current = this.deps.skills.read(change.target);
      if (current !== change.after) throw new Error(`The skill "${change.target}" changed again since: edit it instead`);
      if (change.kind === "skill-created") {
        await this.deps.skills.assign(agent, change.target, false);
        this.deps.skills.remove(change.target);
      } else {
        this.deps.skills.write(change.target, change.before);
      }
    }
    const reverted = { ...change, revertedAt: new Date().toISOString() };
    this.deps.store.updateChange(reverted);
    return reverted;
  }
}

/** What the agent is asked at a review. */
export function reviewPrompt(agent: AgentConfig, transcript: string, count: number): string {
  const skills = agent.learning?.skills !== false;
  return [
    `[Learning: review of your recent conversations — ${count} new message(s)]`,
    "Learn from the conversations below, then stop. Change nothing if nothing is worth keeping.",
    "1. Memory: read it (memory_get), then keep it current with memory_update / memory_save: durable facts,",
    "   preferences, decisions, recurring context, corrections people made to how you work. Remove what is",
    "   outdated or duplicated; keep it concise.",
    skills
      ? "2. Skills: when you did (or were asked for) the same procedure more than once, or were corrected on how to do\n"
        + "   something, write it down as a skill: list_my_skills first, then create_my_skill or update_my_skill\n"
        + "   (only your own skills). One skill per procedure; do not duplicate."
      : "2. Skills: not for this review (memory only).",
    "Never store credentials, keys, tokens, vault values, or personal data about other people (phone numbers,",
    "emails, addresses) beyond what your work needs.",
    "End with one short line saying what you changed, or \"nothing\".",
    "",
    "--- conversations since your last review (\"Them\" = the people or agents, \"You\" = you) ---",
    transcript,
  ].join("\n");
}
