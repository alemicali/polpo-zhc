/**
 * Agent versions — immutable, semver-numbered snapshots of everything that configures an agent,
 * a draft (working copy) people edit, and deploy pointers (`production`) that say which version
 * runs.
 *
 *   edit ──▶ draft ──publish──▶ version 1.3.0 (immutable) ──deploy──▶ production pointer
 *                                                         ◀─rollback─┘ (a deploy too)
 *
 * The agent store keeps holding the agent as it runs in production: deploying a version writes its
 * snapshot there (`materialize`), so every place that loads an agent for execution keeps reading
 * the deployed configuration. A run can be pinned to another published version (`agent@1.2.0`):
 * {@link AgentVersioning.resolve} returns that version's snapshot over the agent's runtime fields.
 *
 * What a snapshot holds is decided field by field in {@link AGENT_FIELD_CLASSIFICATION}: every
 * AgentConfig key is either versioned or explicitly excluded (a test keeps it complete). Runtime
 * data — memory, chats, task history, outcomes, learned items — is not configuration and lives
 * outside the agent config, so it is never versioned nor restored by a rollback.
 */
import type { AgentConfig, AgentUpdate } from "./types.js";
import type { AgentDeployGateRef } from "./agent-suite-gates.js";

// ── Field classification ────────────────────────────────────────────────

/** How each AgentConfig field is treated by versioning. */
export type AgentFieldClass = "versioned" | "excluded";

/**
 * Every AgentConfig field, classified. `Record<keyof Required<AgentConfig>, …>` makes the compiler
 * reject a new AgentConfig field until it is classified here (and the completeness test checks it
 * at runtime too).
 */
export const AGENT_FIELD_CLASSIFICATION: Record<keyof Required<AgentConfig>, AgentFieldClass> = {
  // identity of the record, not configuration
  name: "excluded",
  createdAt: "excluded",
  // role, persona, prompt
  role: "versioned",
  identity: "versioned",
  systemPrompt: "versioned",
  suggestions: "versioned",
  reportsTo: "versioned",
  talksTo: "versioned",
  // model, engine, reasoning
  model: "versioned",
  engine: "versioned",
  reasoning: "versioned",
  runtime: "versioned",
  loops: "versioned",
  pipeline: "versioned",
  // tools, skills, connectors and their policy
  allowedTools: "versioned",
  allowedPaths: "versioned",
  skills: "versioned",
  connectorTools: "versioned",
  progressiveTools: "versioned",
  emailAllowedDomains: "versioned",
  // limits and budgets
  maxTurns: "versioned",
  maxConcurrency: "versioned",
  compaction: "versioned",
  // behaviour settings
  voiceReplies: "versioned",
  learning: "versioned",
  drive: "versioned",
  // where it runs
  sandbox: "versioned",
  computers: "versioned",
  defaultComputer: "versioned",
  browserProfile: "versioned",
  browserEgress: "versioned",
  // Ink registry metadata (author and tags travel with the config)
  author: "versioned",
  tags: "versioned",
  // the Ink registry's package version: independent of the agent's published versions
  version: "excluded",
  // mission-scoped agents: removed when their mission completes, never versioned
  volatile: "excluded",
  missionGroup: "excluded",
};

/** Why a field is not versioned (docs and the API's field list). */
export const AGENT_EXCLUDED_FIELD_REASONS: Partial<Record<keyof AgentConfig, string>> = {
  name: "The agent's key: versions belong to it.",
  createdAt: "When the agent was created: a fact about the record, not configuration.",
  version: "The Ink registry package version (when installed from Ink), independent of published versions.",
  volatile: "Mission-scoped agents are removed when their mission completes and are never versioned.",
  missionGroup: "The mission a volatile agent belongs to.",
};

/** Runtime data that is never part of a version (it is not configuration and lives in other stores). */
export const AGENT_RUNTIME_DATA_NOT_VERSIONED = [
  "memory (shared and the agent's own)",
  "chats and their messages",
  "tasks, runs and their history",
  "outcomes and artifacts it produced",
  "learned items (learning reviews, its own learned skills' content)",
  "team membership (a relationship kept by the team store)",
  "connector grants and vault entries (kept on the connector and in the vault: only names are on the agent)",
] as const;

export const AGENT_VERSIONED_FIELDS = (Object.keys(AGENT_FIELD_CLASSIFICATION) as Array<keyof AgentConfig>)
  .filter((k) => AGENT_FIELD_CLASSIFICATION[k] === "versioned");

/** The versioned part of an agent's config (keys sorted, no undefined values). */
export type AgentSnapshot = Partial<Omit<AgentConfig, "name" | "createdAt" | "version" | "volatile" | "missionGroup">>;

// ── Data model ──────────────────────────────────────────────────────────

export type AgentVersionBump = "major" | "minor" | "patch";

/** One field that differs between two snapshots. */
export interface AgentFieldChange {
  field: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
  /** For long text fields (system prompt …): a unified line diff. */
  textDiff?: string;
}

export interface AgentVersion {
  agent: string;
  /** Semver: "1.3.0". */
  version: string;
  config: AgentSnapshot;
  /** Who published it: "person:<email>", an agent's name, "polpo", "mcp:<client>", "system:…". */
  author: string;
  createdAt: string;
  note?: string;
  /** How the number was chosen: a bump, an explicit version ("custom"), or the first one. */
  bump: AgentVersionBump | "custom" | "initial";
  /** The latest published version before this one. */
  previous?: string;
  /** Per-field changes against `previous`. */
  changes: AgentFieldChange[];
  /** The skills' versions current when it was published (skill name → skill version number). */
  skillVersions?: Record<string, number>;
}

export interface AgentDraft {
  agent: string;
  config: AgentSnapshot;
  /** The published version the draft started from. */
  baseVersion?: string;
  updatedAt: string;
  updatedBy: string;
}

/** A named pointer to a version. Only "production" is used today (the default everything runs). */
export interface AgentPointer {
  agent: string;
  pointer: string;
  version: string;
  updatedAt: string;
  updatedBy: string;
}

/** blocked: a deploy the required suites stopped (the pointer did not move). */
export type AgentDeployAction = "deploy" | "rollback" | "initial" | "blocked";

/** One move of a pointer: the deploy history (audit log). */
export interface AgentDeployEntry {
  id: string;
  agent: string;
  pointer: string;
  /** The version the pointer was on before (none for the first deploy). */
  from?: string;
  to: string;
  action: AgentDeployAction;
  actor: string;
  note?: string;
  at: string;
  /** The deploy gate that verified (or blocked, or was overridden for) it: attached when the history is read. */
  gate?: AgentDeployGateRef;
}

export const PRODUCTION_POINTER = "production";

/**
 * Persistence for versions, drafts, pointers and the deploy log. Every backend (file, SQLite,
 * PostgreSQL) implements it.
 */
export interface AgentVersionStore {
  /** Oldest first. */
  listVersions(agent: string): Promise<AgentVersion[]>;
  getVersion(agent: string, version: string): Promise<AgentVersion | undefined>;
  /** Throws if the version already exists (versions are immutable). */
  addVersion(version: AgentVersion): Promise<void>;

  getDraft(agent: string): Promise<AgentDraft | undefined>;
  saveDraft(draft: AgentDraft): Promise<void>;
  deleteDraft(agent: string): Promise<void>;

  getPointers(agent: string): Promise<AgentPointer[]>;
  setPointer(pointer: AgentPointer): Promise<void>;

  addDeploy(entry: AgentDeployEntry): Promise<void>;
  /** Newest first. */
  listDeploys(agent: string, limit?: number): Promise<AgentDeployEntry[]>;

  /** Remove everything about an agent (it was deleted). */
  deleteAgent(agent: string): Promise<void>;
}

// ── Semver ──────────────────────────────────────────────────────────────

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function isSemver(v: string): boolean { return SEMVER.test(v); }

export function parseSemver(v: string): [number, number, number] | undefined {
  const m = SEMVER.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a) ?? [0, 0, 0];
  const pb = parseSemver(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

export function bumpSemver(v: string, bump: AgentVersionBump): string {
  const [ma, mi, pa] = parseSemver(v) ?? [0, 0, 0];
  if (bump === "major") return `${ma + 1}.0.0`;
  if (bump === "minor") return `${ma}.${mi + 1}.0`;
  return `${ma}.${mi}.${pa + 1}`;
}

// ── Agent refs: "name", "name@1.2.0", "name@production" ─────────────────

export interface AgentRef { name: string; ref?: string }

/** Split "writer@1.2.0" into { name: "writer", ref: "1.2.0" }; a plain name has no ref. */
export function parseAgentRef(value: string): AgentRef {
  const at = value.lastIndexOf("@");
  if (at <= 0) return { name: value };
  const ref = value.slice(at + 1).trim();
  return ref ? { name: value.slice(0, at), ref } : { name: value.slice(0, at) };
}

/** A ref that means "whatever production runs" (also the default when none is given). */
export function isProductionRef(ref: string | undefined): boolean {
  return !ref || ref === PRODUCTION_POINTER || ref === "latest";
}

/** A ref the API accepts: production / latest or a semver. */
export function isValidAgentRef(ref: string): boolean {
  return isProductionRef(ref) || isSemver(ref);
}

// ── Snapshots, diff, bump suggestion ────────────────────────────────────

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** The versioned fields of an agent, keys sorted, undefined dropped (a deep copy). */
export function agentSnapshot(agent: Partial<AgentConfig>): AgentSnapshot {
  const out: Record<string, unknown> = {};
  for (const field of [...AGENT_VERSIONED_FIELDS].sort()) {
    const v = (agent as Record<string, unknown>)[field];
    if (v !== undefined) out[field] = sortKeys(JSON.parse(JSON.stringify(v)));
  }
  return out as AgentSnapshot;
}

/** Stable, pretty serialization (what the unified diff compares). */
export function serializeSnapshot(snapshot: AgentSnapshot): string {
  return `${JSON.stringify(sortKeys(snapshot), null, 2)}\n`;
}

/** A YAML rendering for reading and diffing: keys sorted, multi-line text as block scalars (line diffs). */
export function snapshotToYaml(snapshot: AgentSnapshot): string {
  const lines: string[] = [];
  const scalar = (v: unknown): string => {
    if (v === null) return "null";
    if (typeof v === "string") return /^[\w./@:+-][\w ./@:+,()-]*$/.test(v) && !/^(true|false|null|\d[\d.]*)$/.test(v) && !v.endsWith(" ") ? v : JSON.stringify(v);
    return String(v);
  };
  const emit = (value: unknown, indent: string, key?: string, listItem = false): void => {
    const head = listItem ? `${indent}- ` : key !== undefined ? `${indent}${key}: ` : indent;
    const child = listItem ? `${indent}  ` : `${indent}  `;
    if (typeof value === "string" && value.includes("\n")) {
      lines.push(`${head}|`);
      for (const l of value.replace(/\n$/, "").split("\n")) lines.push(l ? `${child}${l}` : "");
      return;
    }
    if (Array.isArray(value)) {
      if (!value.length) { lines.push(`${head}[]`); return; }
      lines.push(head.trimEnd());
      for (const item of value) emit(item, child, undefined, true);
      return;
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b));
      if (!entries.length) { lines.push(`${head}{}`); return; }
      if (listItem) {
        // first key on the dash line
        const [[k0, v0], ...rest] = entries as [[string, unknown], ...Array<[string, unknown]>];
        const saved = lines.length;
        emit(v0, child, k0);
        const first = lines.splice(saved);
        lines.push(`${indent}- ${first[0]!.trimStart()}`, ...first.slice(1));
        for (const [k, v] of rest) emit(v, child, k);
        return;
      }
      if (key !== undefined) lines.push(head.trimEnd());
      for (const [k, v] of entries) emit(v, key !== undefined ? child : indent, k);
      return;
    }
    lines.push(`${head}${scalar(value)}`);
  };
  emit(sortKeys(snapshot), "");
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export function snapshotsEqual(a: AgentSnapshot, b: AgentSnapshot): boolean {
  return serializeSnapshot(a) === serializeSnapshot(b);
}

/** Text fields diffed line by line in field changes. */
const TEXT_FIELDS = new Set(["systemPrompt"]);

/** Fields whose edit is a patch (text, persona, presentation). */
const PATCH_FIELDS = new Set(["role", "identity", "systemPrompt", "suggestions", "reportsTo", "author", "tags"]);

/** List fields where adding is a minor change and removing a major one. */
const CAPABILITY_LISTS = new Set(["allowedTools", "skills"]);

/** Per-field changes from `before` to `after`. */
export function diffSnapshots(before: AgentSnapshot, after: AgentSnapshot): AgentFieldChange[] {
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changes: AgentFieldChange[] = [];
  for (const field of fields) {
    const b = (before as Record<string, unknown>)[field];
    const a = (after as Record<string, unknown>)[field];
    if (JSON.stringify(sortKeys(b)) === JSON.stringify(sortKeys(a))) continue;
    const kind: AgentFieldChange["kind"] = b === undefined ? "added" : a === undefined ? "removed" : "changed";
    const change: AgentFieldChange = { field, kind, ...(b !== undefined ? { before: b } : {}), ...(a !== undefined ? { after: a } : {}) };
    if (TEXT_FIELDS.has(field) && (typeof a === "string" || typeof b === "string")) {
      change.textDiff = unifiedLineDiff(typeof b === "string" ? b : "", typeof a === "string" ? a : "", `a/${field}`, `b/${field}`);
    }
    changes.push(change);
  }
  return changes;
}

function listOf(v: unknown): string[] { return Array.isArray(v) ? v.map(String) : []; }

/**
 * The bump a change deserves: major for an engine or model change or a removed tool, skill or
 * connector; minor for added tools, skills, connectors or any setting; patch for text, prompt and
 * identity edits. None (undefined) when nothing changed.
 */
export function suggestBump(before: AgentSnapshot, after: AgentSnapshot): AgentVersionBump | undefined {
  const changes = diffSnapshots(before, after);
  if (!changes.length) return undefined;
  let bump: AgentVersionBump = "patch";
  const raise = (b: AgentVersionBump) => {
    if (b === "major" || (b === "minor" && bump === "patch")) bump = b;
  };
  for (const c of changes) {
    if (c.field === "engine" || c.field === "model") { raise("major"); continue; }
    if (CAPABILITY_LISTS.has(c.field)) {
      const b = new Set(listOf(c.before));
      const a = new Set(listOf(c.after));
      // no list at all = the defaults: going to a list or back is a capability change either way
      if (c.before === undefined || c.after === undefined) { raise(c.after === undefined ? "major" : "minor"); continue; }
      if ([...b].some((x) => !a.has(x))) raise("major");
      else if ([...a].some((x) => !b.has(x))) raise("minor");
      continue;
    }
    if (c.field === "connectorTools") {
      const b = (c.before ?? {}) as Record<string, unknown>;
      const a = (c.after ?? {}) as Record<string, unknown>;
      if (Object.keys(b).some((k) => !(k in a))) { raise("major"); continue; }
      const narrowed = Object.keys(b).some((k) => {
        if (b[k] === "*") return a[k] !== "*";
        if (a[k] === "*") return false;
        const after = new Set(listOf(a[k]));
        return listOf(b[k]).some((x) => !after.has(x));
      });
      raise(narrowed ? "major" : "minor");
      continue;
    }
    if (PATCH_FIELDS.has(c.field)) continue;
    raise("minor");
  }
  return bump;
}

// ── Line diff (LCS) ─────────────────────────────────────────────────────

type DiffOp = { op: " " | "-" | "+"; line: string };

function lineOps(a: string[], b: string[]): DiffOp[] {
  // trim the common head and tail, LCS on the rest (bounded so huge texts stay cheap)
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops: DiffOp[] = a.slice(0, start).map((line) => ({ op: " ", line }));
  if (midA.length * midB.length > 4_000_000) {
    ops.push(...midA.map((line) => ({ op: "-" as const, line })), ...midB.map((line) => ({ op: "+" as const, line })));
  } else {
    const n = midA.length;
    const m = midB.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i]![j] = midA[i] === midB[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { ops.push({ op: " ", line: midA[i]! }); i++; j++; }
      else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { ops.push({ op: "-", line: midA[i]! }); i++; }
      else { ops.push({ op: "+", line: midB[j]! }); j++; }
    }
    while (i < n) ops.push({ op: "-", line: midA[i++]! });
    while (j < m) ops.push({ op: "+", line: midB[j++]! });
  }
  ops.push(...a.slice(endA).map((line) => ({ op: " " as const, line })));
  return ops;
}

/** A git-style unified diff of two texts ("" when they are equal). */
export function unifiedLineDiff(before: string, after: string, labelA = "a", labelB = "b", context = 3): string {
  if (before === after) return "";
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  const ops = lineOps(a, b);
  const out: string[] = [`--- ${labelA}`, `+++ ${labelB}`];
  // group changes into hunks with `context` lines around them
  let i = 0;
  let lineA = 1;
  let lineB = 1;
  const posA: number[] = [];
  const posB: number[] = [];
  for (const o of ops) { posA.push(lineA); posB.push(lineB); if (o.op !== "+") lineA++; if (o.op !== "-") lineB++; }
  while (i < ops.length) {
    if (ops[i]!.op === " ") { i++; continue; }
    let start = Math.max(0, i - context);
    let end = i;
    // extend while changes are within 2*context of each other
    while (end < ops.length) {
      if (ops[end]!.op !== " ") { end++; continue; }
      let next = end;
      while (next < ops.length && ops[next]!.op === " ") next++;
      if (next < ops.length && next - end <= context * 2) { end = next; continue; }
      break;
    }
    const stop = Math.min(ops.length, end + context);
    const hunk = ops.slice(start, stop);
    const countA = hunk.filter((o) => o.op !== "+").length;
    const countB = hunk.filter((o) => o.op !== "-").length;
    const fromA = countA ? posA[start]! : posA[start]! - 1;
    const fromB = countB ? posB[start]! : posB[start]! - 1;
    out.push(`@@ -${fromA},${countA} +${fromB},${countB} @@`);
    for (const o of hunk) out.push(`${o.op}${o.line}`);
    i = stop;
    start = stop;
  }
  return `${out.join("\n")}\n`;
}

/** The diff between two snapshots: per-field changes and a unified diff of the serialized config. */
export interface AgentVersionDiff {
  agent: string;
  from?: string;
  to: string;
  changes: AgentFieldChange[];
  unified: string;
  /** The bump the change deserves (none when equal). */
  suggestedBump?: AgentVersionBump;
}

export function diffAgentSnapshots(agent: string, from: { label?: string; config: AgentSnapshot }, to: { label: string; config: AgentSnapshot }): AgentVersionDiff {
  return {
    agent,
    ...(from.label ? { from: from.label } : {}),
    to: to.label,
    changes: diffSnapshots(from.config, to.config),
    unified: unifiedLineDiff(snapshotToYaml(from.config), snapshotToYaml(to.config),
      `a/${agent}@${from.label ?? "empty"}.yaml`, `b/${agent}@${to.label}.yaml`),
    ...(suggestBump(from.config, to.config) ? { suggestedBump: suggestBump(from.config, to.config) } : {}),
  };
}

// ── The service ─────────────────────────────────────────────────────────

export class AgentVersionError extends Error {
  constructor(message: string, readonly code: "NOT_FOUND" | "NO_CHANGES" | "CONFLICT" | "INVALID") {
    super(message);
    this.name = "AgentVersionError";
  }
}

/** What versioning needs from the agent store (where production lives). */
export interface AgentVersioningAgents {
  getAgent(name: string): Promise<AgentConfig | undefined>;
  getAgents(): Promise<AgentConfig[]>;
  /** Write the live (production) agent. Undefined values clear a field. */
  writeLive(name: string, updates: AgentUpdate): Promise<AgentConfig>;
}

export interface AgentVersioningOptions {
  /** The skills' current version numbers at publish time (skill pinning). */
  skillVersions?: (skills: string[]) => Record<string, number>;
  /** Called after a deploy moved production (events, caches). */
  onDeploy?: (entry: AgentDeployEntry) => void | Promise<void>;
  now?: () => Date;
  newId?: () => string;
}

export interface AgentVersionState {
  agent: string;
  /** The version production runs. */
  production?: string;
  pointers: Record<string, string>;
  /** The newest published version. */
  latest?: string;
  versions: number;
  draft: {
    exists: boolean;
    hasChanges: boolean;
    /** The version the draft is based on (production's when it started). */
    baseVersion?: string;
    /** Production moved away from the draft's base (rollback or deploy): rebase or discard before publishing. */
    stale: boolean;
    /** "draft is based on 1.4.0, production is now 1.2.0: …" when stale. */
    warning?: string;
    updatedAt?: string;
    updatedBy?: string;
    changes: AgentFieldChange[];
    suggestedBump?: AgentVersionBump;
    nextVersion?: string;
  };
}

export interface ResolvedAgent {
  agent: AgentConfig;
  /** The published version it is (undefined: not versioned, e.g. a volatile agent). */
  version?: string;
  /** "production" or the pinned ref. */
  ref: string;
}

export interface PublishOptions {
  actor: string;
  bump?: AgentVersionBump;
  /** An explicit semver (overrides bump); must be above the latest. */
  version?: string;
  note?: string;
}

export interface DeployOptions {
  actor: string;
  note?: string;
  pointer?: string;
  /** The history entry's id (a deploy gate's id, to link the two). */
  id?: string;
}

/**
 * Versioning for a team's agents: drafts, publish, deploy, rollback, diff and resolution.
 * Single-process: calls for one agent are serialized so two publishes never pick the same number.
 */
export class AgentVersioning {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    readonly store: AgentVersionStore,
    private readonly agents: AgentVersioningAgents,
    private readonly opts: AgentVersioningOptions = {},
  ) {}

  private now(): string { return (this.opts.now?.() ?? new Date()).toISOString(); }
  private id(): string { return this.opts.newId?.() ?? `dep_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; }

  private serial<T>(agent: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(agent) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.locks.set(agent, next);
    return next.finally(() => { if (this.locks.get(agent) === next) this.locks.delete(agent); });
  }

  private async live(name: string): Promise<AgentConfig> {
    const agent = await this.agents.getAgent(name);
    if (!agent) throw new AgentVersionError(`Agent "${name}" not found`, "NOT_FOUND");
    return agent;
  }

  private static versionable(agent: AgentConfig): boolean { return !agent.volatile; }

  async listVersions(name: string): Promise<AgentVersion[]> {
    await this.ensureInitial(name);
    return this.store.listVersions(name);
  }

  async getVersion(name: string, version: string): Promise<AgentVersion | undefined> {
    await this.ensureInitial(name);
    return this.store.getVersion(name, version);
  }

  async latest(name: string): Promise<AgentVersion | undefined> {
    const all = await this.store.listVersions(name);
    return all.sort((a, b) => compareSemver(a.version, b.version)).at(-1);
  }

  async pointer(name: string, pointer = PRODUCTION_POINTER): Promise<string | undefined> {
    return (await this.store.getPointers(name)).find((p) => p.pointer === pointer)?.version;
  }

  /**
   * The first version of an agent that has none: its current config published as 1.0.0 and
   * deployed to production. Idempotent (the migration of existing agents, and new agents).
   */
  async ensureInitial(name: string, actor = "system:migration"): Promise<AgentVersion | undefined> {
    const existing = await this.store.listVersions(name);
    if (existing.length) return undefined;
    return this.serial(name, async () => {
      if ((await this.store.listVersions(name)).length) return undefined;
      const agent = await this.live(name);
      if (!AgentVersioning.versionable(agent)) return undefined;
      const at = this.now();
      const config = agentSnapshot(agent);
      const version: AgentVersion = {
        agent: name, version: "1.0.0", config, author: actor, createdAt: at, bump: "initial",
        note: "Initial version", changes: diffSnapshots({}, config),
        ...this.skillPins(config),
      };
      await this.store.addVersion(version);
      await this.store.setPointer({ agent: name, pointer: PRODUCTION_POINTER, version: "1.0.0", updatedAt: at, updatedBy: actor });
      const entry: AgentDeployEntry = { id: this.id(), agent: name, pointer: PRODUCTION_POINTER, to: "1.0.0", action: "initial", actor, note: "Initial version", at };
      await this.store.addDeploy(entry);
      return version;
    });
  }

  private skillPins(config: AgentSnapshot): { skillVersions?: Record<string, number> } {
    if (!config.skills?.length || !this.opts.skillVersions) return {};
    try {
      const pins = this.opts.skillVersions(config.skills);
      return Object.keys(pins).length ? { skillVersions: pins } : {};
    } catch { return {}; }
  }

  /**
   * Bring every (non-volatile) agent under versioning: 1.0.0 for those without versions, and a new
   * version for an agent whose live config was changed outside versioning (a CLI or a file edit).
   */
  async migrateAll(): Promise<{ initialized: string[]; reconciled: string[] }> {
    const initialized: string[] = [];
    const reconciled: string[] = [];
    for (const agent of await this.agents.getAgents()) {
      if (!AgentVersioning.versionable(agent)) continue;
      try {
        if (await this.ensureInitial(agent.name)) { initialized.push(agent.name); continue; }
        if (await this.recordLive(agent.name, { actor: "system:external", note: "Changed outside versioning" })) reconciled.push(agent.name);
      } catch { /* one agent never blocks the others */ }
    }
    return { initialized, reconciled };
  }

  /** The production version's snapshot (what the draft starts from). */
  private async productionSnapshot(name: string): Promise<{ version?: string; config: AgentSnapshot }> {
    const prod = await this.pointer(name);
    if (prod) {
      const v = await this.store.getVersion(name, prod);
      if (v) return { version: prod, config: v.config };
    }
    return { config: agentSnapshot(await this.live(name)) };
  }

  /**
   * The version a draft is based on: the one production ran when the draft started (a new draft
   * always starts from what is live, so a rolled-back change never comes back silently).
   */
  private async draftBase(name: string, draft: AgentDraft | undefined): Promise<{ version?: string; config: AgentSnapshot }> {
    if (draft?.baseVersion) {
      const v = await this.store.getVersion(name, draft.baseVersion);
      if (v) return { version: v.version, config: v.config };
    }
    return this.productionSnapshot(name);
  }

  /** The draft's config: the saved working copy, or production's when there is none. */
  async draftConfig(name: string): Promise<{ config: AgentSnapshot; draft?: AgentDraft }> {
    await this.ensureInitial(name);
    const draft = await this.store.getDraft(name);
    if (draft) return { config: draft.config, draft };
    return { config: (await this.productionSnapshot(name)).config };
  }

  /** A draft based on a version production no longer runs (a rollback or deploy moved it). */
  private static staleMessage(name: string, base?: string, production?: string): string {
    return `${name}'s draft is based on ${base ?? "an earlier version"}, production is now ${production ?? "another version"}: rebase it onto production or discard it first`;
  }

  async state(name: string): Promise<AgentVersionState> {
    await this.ensureInitial(name);
    const [versions, pointers, draft] = await Promise.all([
      this.store.listVersions(name), this.store.getPointers(name), this.store.getDraft(name),
    ]);
    const latest = versions.sort((a, b) => compareSemver(a.version, b.version)).at(-1);
    const prodVersion = pointers.find((p) => p.pointer === PRODUCTION_POINTER)?.version;
    // changes against the version the draft is based on; the next number is above every version
    const base = draft ? await this.draftBase(name, draft) : undefined;
    const changes = draft && base ? diffSnapshots(base.config, draft.config) : [];
    const bump = draft && base ? suggestBump(base.config, draft.config) : undefined;
    const stale = !!draft && !!prodVersion && !!base?.version && base.version !== prodVersion;
    return {
      agent: name,
      ...(prodVersion ? { production: prodVersion } : {}),
      pointers: Object.fromEntries(pointers.map((p) => [p.pointer, p.version])),
      ...(latest ? { latest: latest.version } : {}),
      versions: versions.length,
      draft: {
        exists: !!draft,
        hasChanges: changes.length > 0,
        ...(base?.version ? { baseVersion: base.version } : {}),
        stale,
        ...(stale ? { warning: AgentVersioning.staleMessage(name, base?.version, prodVersion).replace(" first", "") } : {}),
        ...(draft ? { updatedAt: draft.updatedAt, updatedBy: draft.updatedBy } : {}),
        changes,
        ...(bump ? { suggestedBump: bump, nextVersion: bumpSemver(latest?.version ?? "0.0.0", bump) } : {}),
      },
    };
  }

  /**
   * Apply changes to the draft (created from production when there is none). Undefined values
   * clear a field. It never touches what runs.
   */
  async updateDraft(name: string, updates: AgentUpdate, actor: string): Promise<AgentDraft> {
    await this.ensureInitial(name);
    return this.serial(name, async () => {
      const current = await this.store.getDraft(name);
      const base = current ? { version: current.baseVersion, config: current.config } : await this.productionSnapshot(name);
      const { team: _team, ...fields } = updates as AgentUpdate & { team?: string };
      const merged: Record<string, unknown> = { ...base.config };
      for (const [k, v] of Object.entries(fields)) {
        if (AGENT_FIELD_CLASSIFICATION[k as keyof AgentConfig] !== "versioned") continue;
        if (v === undefined || v === null) delete merged[k];
        else merged[k] = v;
      }
      const draft: AgentDraft = {
        agent: name, config: agentSnapshot(merged as Partial<AgentConfig>), updatedAt: this.now(), updatedBy: actor,
        ...(base.version ? { baseVersion: base.version } : {}),
      };
      await this.store.saveDraft(draft);
      return draft;
    });
  }

  /**
   * Move a stale draft onto what production runs now: its own changes (against the version it was
   * based on) applied over production's config. Nothing left to change: the draft goes.
   */
  async rebaseDraft(name: string, actor: string): Promise<{ draft?: AgentDraft; from?: string; to?: string; dropped: boolean }> {
    await this.ensureInitial(name);
    return this.serial(name, async () => {
      const draft = await this.store.getDraft(name);
      if (!draft) throw new AgentVersionError(`${name} has no draft to rebase`, "NOT_FOUND");
      const base = await this.draftBase(name, draft);
      const prod = await this.productionSnapshot(name);
      const merged: Record<string, unknown> = { ...prod.config };
      for (const c of diffSnapshots(base.config, draft.config)) {
        if (c.after === undefined) delete merged[c.field];
        else merged[c.field] = c.after;
      }
      const config = agentSnapshot(merged as Partial<AgentConfig>);
      if (snapshotsEqual(config, prod.config)) {
        await this.store.deleteDraft(name);
        return { ...(base.version ? { from: base.version } : {}), ...(prod.version ? { to: prod.version } : {}), dropped: true };
      }
      const next: AgentDraft = { ...draft, config, updatedAt: this.now(), updatedBy: actor, ...(prod.version ? { baseVersion: prod.version } : {}) };
      await this.store.saveDraft(next);
      return { draft: next, ...(base.version ? { from: base.version } : {}), ...(prod.version ? { to: prod.version } : {}), dropped: false };
    });
  }

  async discardDraft(name: string): Promise<boolean> {
    const had = !!(await this.store.getDraft(name));
    await this.store.deleteDraft(name);
    return had;
  }

  /** The version number a publish would get. */
  async nextVersion(name: string, opts: { bump?: AgentVersionBump; version?: string; config?: AgentSnapshot; parent?: AgentSnapshot } = {}): Promise<{ version: string; bump: AgentVersion["bump"] }> {
    const latest = await this.latest(name);
    if (opts.version) {
      if (!isSemver(opts.version)) throw new AgentVersionError(`"${opts.version}" is not a version (major.minor.patch, e.g. 1.4.0)`, "INVALID");
      if (latest && compareSemver(opts.version, latest.version) <= 0) {
        throw new AgentVersionError(`Version ${opts.version} must be above the latest, ${latest.version}`, "CONFLICT");
      }
      return { version: opts.version, bump: "custom" };
    }
    // the bump the change deserves (against its parent); the number is above the highest version
    const parent = opts.parent ?? latest?.config;
    const bump = opts.bump ?? (opts.config && parent ? suggestBump(parent, opts.config) : undefined) ?? "patch";
    return { version: bumpSemver(latest?.version ?? "0.0.0", bump), bump };
  }

  /** Publish the draft as a new immutable version (it does not deploy it). */
  async publish(name: string, opts: PublishOptions): Promise<AgentVersion> {
    await this.ensureInitial(name);
    return this.serial(name, async () => {
      const draft = await this.store.getDraft(name);
      const base = await this.draftBase(name, draft);
      if (!draft || snapshotsEqual(base.config, draft.config)) {
        throw new AgentVersionError(`${name} has no draft changes to publish`, "NO_CHANGES");
      }
      const production = await this.pointer(name);
      if (base.version && production && base.version !== production) {
        throw new AgentVersionError(AgentVersioning.staleMessage(name, base.version, production), "CONFLICT");
      }
      const version = await this.createVersion(name, draft.config, base, opts);
      await this.store.deleteDraft(name);
      return version;
    });
  }

  /** A new version whose parent is `parent` (the version it was edited from); numbered above every version. */
  private async createVersion(name: string, config: AgentSnapshot, parent: { version?: string; config: AgentSnapshot } | undefined, opts: PublishOptions): Promise<AgentVersion> {
    const next = await this.nextVersion(name, { bump: opts.bump, version: opts.version, config, ...(parent ? { parent: parent.config } : {}) });
    if (await this.store.getVersion(name, next.version)) throw new AgentVersionError(`Version ${next.version} of ${name} already exists`, "CONFLICT");
    const version: AgentVersion = {
      agent: name, version: next.version, config, author: opts.actor, createdAt: this.now(), bump: next.bump,
      ...(opts.note?.trim() ? { note: opts.note.trim() } : {}),
      ...(parent?.version ? { previous: parent.version } : {}),
      changes: diffSnapshots(parent?.config ?? {}, config),
      ...this.skillPins(config),
    };
    await this.store.addVersion(version);
    return version;
  }

  /** Move a pointer (production) to a published version and write it live. */
  async deploy(name: string, version: string, opts: DeployOptions & { action?: AgentDeployAction }): Promise<AgentDeployEntry> {
    await this.ensureInitial(name);
    return this.serial(name, () => this.deployUnlocked(name, version, opts));
  }

  private async deployUnlocked(name: string, version: string, opts: DeployOptions & { action?: AgentDeployAction }): Promise<AgentDeployEntry> {
    const pointer = opts.pointer ?? PRODUCTION_POINTER;
    const target = await this.store.getVersion(name, version);
    if (!target) throw new AgentVersionError(`${name} has no version ${version}`, "NOT_FOUND");
    const from = await this.pointer(name, pointer);
    if (pointer === PRODUCTION_POINTER) await this.materialize(name, target.config);
    const at = this.now();
    await this.store.setPointer({ agent: name, pointer, version, updatedAt: at, updatedBy: opts.actor });
    const entry: AgentDeployEntry = {
      id: opts.id ?? this.id(), agent: name, pointer, ...(from ? { from } : {}), to: version, action: opts.action ?? "deploy",
      actor: opts.actor, at, ...(opts.note?.trim() ? { note: opts.note.trim() } : {}),
    };
    await this.store.addDeploy(entry);
    await this.opts.onDeploy?.(entry);
    return entry;
  }

  /** Write a snapshot as the live agent: every versioned field set or cleared. */
  private async materialize(name: string, config: AgentSnapshot): Promise<void> {
    const updates: Record<string, unknown> = {};
    for (const field of AGENT_VERSIONED_FIELDS) updates[field] = (config as Record<string, unknown>)[field];
    await this.agents.writeLive(name, updates as AgentUpdate);
  }

  /**
   * Record a deploy the required suites blocked: a history entry (action "blocked") from what
   * production runs to the version that did not pass. The pointer does not move.
   */
  async recordBlocked(name: string, version: string, opts: DeployOptions): Promise<AgentDeployEntry> {
    await this.ensureInitial(name);
    return this.serial(name, async () => {
      const pointer = opts.pointer ?? PRODUCTION_POINTER;
      if (!(await this.store.getVersion(name, version))) throw new AgentVersionError(`${name} has no version ${version}`, "NOT_FOUND");
      const from = await this.pointer(name, pointer);
      const entry: AgentDeployEntry = {
        id: opts.id ?? this.id(), agent: name, pointer, ...(from ? { from } : {}), to: version, action: "blocked",
        actor: opts.actor, at: this.now(), ...(opts.note?.trim() ? { note: opts.note.trim() } : {}),
      };
      await this.store.addDeploy(entry);
      return entry;
    });
  }

  /**
   * Roll production back: to `to`, or to the version production ran before the deploy that brought
   * the current one, else the published version below it.
   */
  async rollback(name: string, opts: DeployOptions & { to?: string }): Promise<AgentDeployEntry> {
    await this.ensureInitial(name);
    return this.serial(name, async () => {
      const current = await this.pointer(name);
      let to = opts.to;
      if (!to) {
        const deploys = await this.store.listDeploys(name);
        // the deploy that brought the current version (not a rollback to it): one step back in the
        // history each time, so repeated rollbacks walk back instead of toggling
        to = deploys.find((d) => d.pointer === PRODUCTION_POINTER && d.to === current && d.action !== "rollback" && d.action !== "blocked" && d.from && d.from !== current)?.from;
      }
      if (!to) {
        const below = (await this.store.listVersions(name))
          .filter((v) => current && compareSemver(v.version, current) < 0)
          .sort((a, b) => compareSemver(a.version, b.version)).at(-1);
        to = below?.version;
      }
      if (!to) throw new AgentVersionError(`${name} has no earlier version to roll back to`, "NOT_FOUND");
      if (to === current) throw new AgentVersionError(`${name} already runs ${to} in production`, "NO_CHANGES");
      return this.deployUnlocked(name, to, { ...opts, action: "rollback" });
    });
  }

  /**
   * Record the live config as a new version deployed to production when it differs from what
   * production should run (a change written live, outside the draft). Pending draft edits are kept
   * and the same changes are applied to the draft, so publishing it later does not revert them.
   */
  async recordLive(name: string, opts: { actor: string; note?: string; updates?: AgentUpdate }): Promise<AgentVersion | undefined> {
    if (!(await this.store.listVersions(name)).length) return this.ensureInitial(name, opts.actor);
    return this.serial(name, async () => {
      const agent = await this.agents.getAgent(name);
      if (!agent || !AgentVersioning.versionable(agent)) return undefined;
      const live = agentSnapshot(agent);
      const prod = await this.productionSnapshot(name);
      if (snapshotsEqual(prod.config, live)) return undefined;
      const version = await this.createVersion(name, live, prod, { actor: opts.actor, note: opts.note ?? "Applied directly" });
      const at = this.now();
      await this.store.setPointer({ agent: name, pointer: PRODUCTION_POINTER, version: version.version, updatedAt: at, updatedBy: opts.actor });
      const entry: AgentDeployEntry = {
        id: this.id(), agent: name, pointer: PRODUCTION_POINTER, ...(prod.version ? { from: prod.version } : {}),
        to: version.version, action: "deploy", actor: opts.actor, at, note: opts.note ?? "Applied directly",
      };
      await this.store.addDeploy(entry);
      const draft = await this.store.getDraft(name);
      if (draft) {
        const changed = diffSnapshots(prod.config, live);
        const merged: Record<string, unknown> = { ...draft.config };
        for (const c of changed) {
          if (c.after === undefined) delete merged[c.field];
          else merged[c.field] = c.after;
        }
        const config = agentSnapshot(merged as Partial<AgentConfig>);
        if (snapshotsEqual(config, live)) await this.store.deleteDraft(name);
        // a draft on production follows it to the new version; a stale one stays stale (rebase shows it)
        else await this.store.saveDraft({ ...draft, config, ...(!draft.baseVersion || draft.baseVersion === prod.version ? { baseVersion: version.version } : {}) });
      }
      await this.opts.onDeploy?.(entry);
      return version;
    });
  }

  /** "draft", "production" / "latest" or a semver → a labelled snapshot. */
  async snapshotOf(name: string, ref: string): Promise<{ label: string; config: AgentSnapshot }> {
    await this.ensureInitial(name);
    if (ref === "draft") return { label: "draft", config: (await this.draftConfig(name)).config };
    if (isProductionRef(ref)) {
      const p = await this.productionSnapshot(name);
      return { label: p.version ?? "production", config: p.config };
    }
    const v = await this.store.getVersion(name, ref);
    if (!v) throw new AgentVersionError(`${name} has no version ${ref}`, "NOT_FOUND");
    return { label: v.version, config: v.config };
  }

  /** Diff any two refs ("draft", "production", a version). `from` omitted: the version before `to`. */
  async diff(name: string, to: string, from?: string): Promise<AgentVersionDiff> {
    const target = await this.snapshotOf(name, to);
    let source: { label?: string; config: AgentSnapshot } | undefined;
    if (from) source = await this.snapshotOf(name, from);
    else if (to === "draft") {
      const base = await this.draftBase(name, await this.store.getDraft(name));
      source = { ...(base.version ? { label: base.version } : {}), config: base.config };
    }
    else {
      const v = await this.store.getVersion(name, target.label);
      source = v?.previous ? await this.snapshotOf(name, v.previous) : { config: {} };
    }
    return diffAgentSnapshots(name, source, target);
  }

  /** The deploy history, newest first, each with the diff from the version it replaced. */
  async deploys(name: string, opts: { limit?: number; withDiff?: boolean } = {}): Promise<Array<AgentDeployEntry & { diff?: AgentVersionDiff }>> {
    await this.ensureInitial(name);
    const entries = await this.store.listDeploys(name, opts.limit);
    if (!opts.withDiff) return entries;
    return Promise.all(entries.map(async (e) => ({ ...e, diff: await this.deployDiff(name, e).catch(() => undefined) })));
  }

  async deployDiff(name: string, entry: AgentDeployEntry): Promise<AgentVersionDiff> {
    const to = await this.snapshotOf(name, entry.to);
    const from = entry.from ? await this.snapshotOf(name, entry.from) : { config: {} as AgentSnapshot };
    return diffAgentSnapshots(name, from, to);
  }

  /**
   * The agent a run uses: production (the live config) by default, or a pinned published version
   * over the agent's runtime fields. Undefined when the agent does not exist.
   */
  async resolve(name: string, ref?: string): Promise<ResolvedAgent | undefined> {
    const live = await this.agents.getAgent(name);
    if (!live) return undefined;
    if (!AgentVersioning.versionable(live)) return { agent: live, ref: PRODUCTION_POINTER };
    if (isProductionRef(ref)) {
      await this.ensureInitial(name).catch(() => undefined);
      const version = await this.pointer(name);
      return { agent: live, ...(version ? { version } : {}), ref: PRODUCTION_POINTER };
    }
    if (!isSemver(ref!)) throw new AgentVersionError(`"${ref}" is not a version of ${name} (use a version like 1.2.0, or production)`, "INVALID");
    const v = await this.store.getVersion(name, ref!);
    if (!v) throw new AgentVersionError(`${name} has no version ${ref}`, "NOT_FOUND");
    const runtime: Record<string, unknown> = {};
    for (const [k, cls] of Object.entries(AGENT_FIELD_CLASSIFICATION)) {
      if (cls === "excluded" && (live as unknown as Record<string, unknown>)[k] !== undefined) runtime[k] = (live as unknown as Record<string, unknown>)[k];
    }
    return { agent: { ...(runtime as unknown as AgentConfig), ...(v.config as AgentConfig), name }, version: v.version, ref: v.version };
  }

  /**
   * Change an agent through versioning: the fields go to its draft; then, as `mode` asks, the draft
   * is published ("publish") and also deployed to production ("deploy"). "draft" stops at the draft.
   */
  async update(name: string, fields: AgentUpdate, opts: PublishOptions & { mode: "draft" | "publish" | "deploy" }): Promise<{
    draftChanged: boolean; published?: AgentVersion; deployed?: AgentDeployEntry;
  }> {
    if (opts.mode !== "draft") {
      const st = await this.state(name);
      if (st.draft.stale) throw new AgentVersionError(AgentVersioning.staleMessage(name, st.draft.baseVersion, st.production), "CONFLICT");
    }
    let draftChanged = false;
    if (Object.keys(fields).length) {
      const before = (await this.draftConfig(name)).config;
      const draft = await this.updateDraft(name, fields, opts.actor);
      draftChanged = !snapshotsEqual(before, draft.config);
    }
    let published: AgentVersion | undefined;
    let deployed: AgentDeployEntry | undefined;
    if (opts.mode !== "draft") {
      const state = await this.state(name);
      if (state.draft.hasChanges) published = await this.publish(name, opts);
      else if (state.draft.exists) await this.discardDraft(name); // nothing left to publish
      // only what this call published is deployed (a version published earlier is deployed explicitly)
      if (opts.mode === "deploy" && published) deployed = await this.deploy(name, published.version, { actor: opts.actor, note: opts.note });
    }
    return { draftChanged, ...(published ? { published } : {}), ...(deployed ? { deployed } : {}) };
  }

  /** Forget an agent's versions (it was deleted). */
  async forget(name: string): Promise<void> { await this.store.deleteAgent(name); }
}

/** A store kept in memory (tests, and instances without persistence). */
export class InMemoryAgentVersionStore implements AgentVersionStore {
  private versions = new Map<string, AgentVersion[]>();
  private drafts = new Map<string, AgentDraft>();
  private pointers = new Map<string, AgentPointer[]>();
  private deployLog = new Map<string, AgentDeployEntry[]>();

  async listVersions(agent: string) { return [...(this.versions.get(agent) ?? [])]; }
  async getVersion(agent: string, version: string) { return this.versions.get(agent)?.find((v) => v.version === version); }
  async addVersion(version: AgentVersion) {
    const list = this.versions.get(version.agent) ?? [];
    if (list.some((v) => v.version === version.version)) throw new AgentVersionError(`Version ${version.version} of ${version.agent} already exists`, "CONFLICT");
    list.push(version);
    this.versions.set(version.agent, list);
  }
  async getDraft(agent: string) { return this.drafts.get(agent); }
  async saveDraft(draft: AgentDraft) { this.drafts.set(draft.agent, draft); }
  async deleteDraft(agent: string) { this.drafts.delete(agent); }
  async getPointers(agent: string) { return [...(this.pointers.get(agent) ?? [])]; }
  async setPointer(p: AgentPointer) {
    const list = (this.pointers.get(p.agent) ?? []).filter((x) => x.pointer !== p.pointer);
    list.push(p);
    this.pointers.set(p.agent, list);
  }
  async addDeploy(entry: AgentDeployEntry) {
    const list = this.deployLog.get(entry.agent) ?? [];
    list.push(entry);
    this.deployLog.set(entry.agent, list);
  }
  async listDeploys(agent: string, limit?: number) {
    const list = [...(this.deployLog.get(agent) ?? [])].reverse();
    return limit ? list.slice(0, limit) : list;
  }
  async deleteAgent(agent: string) {
    this.versions.delete(agent); this.drafts.delete(agent); this.pointers.delete(agent); this.deployLog.delete(agent);
  }
}
