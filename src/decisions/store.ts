/**
 * The decision log: every decide() call (who called it, the questions, the state capped or only
 * hashed, the answers, the model, the cost) under `.polpo/decisions/`:
 *
 *   index.json        summaries, newest first (pruned by count and age: settings.decisions)
 *   log/<id>.json     one decision with its questions and state
 *
 * Like the agent suites and the triggers: per-instance files whatever the instance's store, bounded,
 * written through a temporary file and a rename.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DecisionAnswer, DecisionQuestion, DecisionQuestionType, DecisionUsage } from "@polpo-ai/core/decisions";

/** Who asked for a decision. */
export interface DecisionCaller {
  kind: "api" | "mcp" | "chat" | "agent" | "mission" | "suite" | "playground";
  /** The agent, mission, suite… */
  id?: string;
  label?: string;
  /** The person, when known. */
  by?: string;
  /** An agent's decide in a task run: the task and the run (from the run record). */
  taskId?: string;
  runId?: string;
}

export interface DecisionLogEntry {
  id: string;
  at: string;
  caller: DecisionCaller;
  status: "ok" | "error";
  error?: string;
  /** "gateway:model", or "Polpo (model)" for the uncalibrated fallback. */
  model: string;
  gateway?: string;
  calibrated: boolean;
  latencyMs: number;
  costUsd: number;
  usage: DecisionUsage;
  questions: DecisionQuestion[];
  answers: DecisionAnswer[];
  uncertain: boolean;
  /** sha256 of the state as text. */
  stateHash: string;
  stateChars: number;
  /** The state, capped (absent with storeInputs "hash"). */
  state?: string;
  stateTruncated?: boolean;
}

export type DecisionLogSummary = Omit<DecisionLogEntry, "questions" | "state" | "stateTruncated"> & {
  questions: Array<{ name: string; type: DecisionQuestionType }>;
};

export interface DecisionLogPage { decisions: DecisionLogSummary[]; nextCursor?: string; total: number }

const ID = /^dec_[a-z0-9]{6,40}$/;
export const isDecisionId = (id: string): boolean => ID.test(id);

function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf-8")) as T; } catch { return undefined; }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

export const summarizeDecision = ({ questions, state: _s, stateTruncated: _t, ...rest }: DecisionLogEntry): DecisionLogSummary => ({
  ...rest, questions: questions.map((q) => ({ name: q.name, type: q.type })),
});

export class FileDecisionLogStore {
  constructor(private readonly polpoDir: () => string) {}

  private root(): string { return join(this.polpoDir(), "decisions"); }
  private indexFile(): string { return join(this.root(), "index.json"); }
  private entryFile(id: string): string { return join(this.root(), "log", `${id}.json`); }

  private index(): DecisionLogSummary[] {
    const d = readJson<{ decisions?: DecisionLogSummary[] }>(this.indexFile());
    return Array.isArray(d?.decisions) ? d.decisions : [];
  }

  /** Record a decision; the oldest beyond `retention`, or older than `retentionDays` (0: no age limit), are removed. */
  add(entry: DecisionLogEntry, retention: { count: number; days: number }): void {
    writeJson(this.entryFile(entry.id), entry);
    const minAt = retention.days > 0 ? new Date(Date.now() - retention.days * 86_400_000).toISOString() : "";
    const all = [summarizeDecision(entry), ...this.index().filter((d) => d.id !== entry.id)];
    const keep: DecisionLogSummary[] = [];
    for (const d of all) {
      if (keep.length < Math.max(1, retention.count) && (!minAt || d.at >= minAt || d.id === entry.id)) keep.push(d);
      else rmSync(this.entryFile(d.id), { force: true });
    }
    writeJson(this.indexFile(), { version: 1, decisions: keep });
  }

  get(id: string): DecisionLogEntry | undefined {
    return isDecisionId(id) && existsSync(this.entryFile(id)) ? readJson<DecisionLogEntry>(this.entryFile(id)) : undefined;
  }

  /** Newest first, filtered; the cursor is an offset. */
  list(o: { limit?: number; cursor?: string; caller?: string; callerId?: string; uncertain?: boolean; status?: "ok" | "error" } = {}): DecisionLogPage {
    const all = this.index().filter((d) => (!o.caller || d.caller.kind === o.caller) && (!o.callerId || d.caller.id === o.callerId)
      && (o.uncertain === undefined || d.uncertain === o.uncertain) && (!o.status || d.status === o.status));
    const offset = o.cursor && /^\d+$/.test(o.cursor) ? Number(o.cursor) : 0;
    const limit = Math.max(1, Math.min(o.limit ?? 50, 200));
    const decisions = all.slice(offset, offset + limit);
    return { decisions, total: all.length, ...(offset + limit < all.length ? { nextCursor: String(offset + limit) } : {}) };
  }
}
