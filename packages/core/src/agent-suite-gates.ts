/**
 * Deploy gates (agent suites phase 3): the suites an agent marks `gate.required` run against a
 * version before it reaches production. The version is deployed only when every required suite
 * passes its gate — pass rate, regression versus the baseline, scorer thresholds —; otherwise the
 * deploy is blocked and recorded in the deploy history. An admin may deploy anyway with a reason
 * (an override, recorded too). Rollbacks are never gated.
 *
 * This module holds the data model and the pure decisions; the host (src/server/agent-deploy-gates.ts)
 * starts the runs, waits for them and moves the production pointer.
 */
import type { AgentSuite, SuiteGate, SuiteRun } from "./agent-suites.js";
import type { AgentDeployEntry } from "./agent-versions.js";

export const DEPLOY_GATE_LIMITS = {
  /** Gates kept per agent (newest). */
  kept: 200,
  /** Failed cases listed per suite. */
  failedCases: 20,
} as const;

/** Why a gate ran: a deploy (dashboard, REST, MCP, Polpo), an API update that auto-deploys, or a publish check. */
export type DeployGateTrigger = "deploy" | "api-update" | "publish";

/**
 * running: "in verifica" (the suites are running; production has not moved);
 * passed: every required suite passed (a deploy gate deployed the version; a publish check only annotates it);
 * blocked: a deploy gate failed (production unchanged, recorded in the deploy history);
 * failed: a publish check failed (non-blocking);
 * override: an admin deployed anyway, with a reason;
 * cancelled: stopped before it finished (nothing deployed);
 * errored: the gate itself could not run.
 */
export type DeployGateStatus = "running" | "passed" | "blocked" | "failed" | "override" | "cancelled" | "errored";

export type DeployGateSuiteStatus = "queued" | "running" | "passed" | "failed" | "errored" | "cancelled" | "not_run";

export interface DeployGateFailedCase {
  key: string;
  caseName: string;
  /** The failed assertions and scorers. */
  failed: string[];
  error?: string;
}

/** One required suite inside a gate. */
export interface DeployGateSuite {
  suiteId: string;
  suiteName: string;
  suiteRevision: number;
  /** The run (trigger deploy / publish) against the version. */
  runId?: string;
  status: DeployGateSuiteStatus;
  /** Why it did not pass its gate (thresholds missed, not run). */
  reasons: string[];
  failedCases: DeployGateFailedCase[];
  passRate?: number;
  score?: number;
  /** The run its regressions were measured against. */
  baselineRunId?: string;
  /** The thresholds applied (defaults filled in). */
  thresholds: { minPassRate: number; maxRegression?: number; scoreThresholds?: Record<string, number> };
  progress: { done: number; total: number };
}

/** A gate: the required suites run against one version (before a deploy, or as a publish check). */
export interface AgentDeployGate {
  id: string;
  agent: string;
  /** The version being verified. */
  version: string;
  /** What production ran when the gate started. */
  from?: string;
  trigger: DeployGateTrigger;
  status: DeployGateStatus;
  requestedBy: string;
  requestedAt: string;
  finishedAt?: string;
  /** The deploy's note. */
  note?: string;
  suites: DeployGateSuite[];
  /** Cases done over cases planned, across the suites. */
  progress: { done: number; total: number };
  /** The deploy history entry that moved production (passed, override). */
  deployId?: string;
  /** The deploy history entry that recorded the block. */
  blockedEntryId?: string;
  /** An admin deployed anyway. */
  override?: { by: string; at: string; reason: string; failed: string[] };
  cancelledBy?: string;
  error?: string;
  notes: string[];
}

/** What a deploy history entry carries about its gate (GET /agents/{name}/deploys). */
export interface AgentDeployGateRef {
  id: string;
  status: DeployGateStatus;
  trigger: DeployGateTrigger;
  /** "Suite: reason" for each failure. */
  failed: string[];
  suites: Array<{ suiteId: string; suiteName: string; status: DeployGateSuiteStatus; runId?: string; passRate?: number; score?: number }>;
  override?: { by: string; at: string; reason: string; failed: string[] };
}

/** A version's latest gate, for badges (✓ passed, ✗ blocked / failed, in verifica, override). */
export interface AgentVersionGateStatus {
  gateId: string;
  status: DeployGateStatus;
  trigger: DeployGateTrigger;
  at: string;
  failed: string[];
  progress?: { done: number; total: number };
}

/** The outcome of a deploy request through the gate. */
export type AgentDeployRequestStatus = "deployed" | "pending" | "blocked";

/**
 * What a deploy request did: deployed (no required suites, they passed, or an override), pending
 * (the suites are running: production moves when they pass) or blocked (production unchanged).
 */
export interface AgentDeployOutcome {
  status: AgentDeployRequestStatus;
  /** The history entry: the deploy (deployed) or the block (blocked). */
  entry?: AgentDeployEntry;
  gate?: AgentDeployGate;
  /** In words, for replies. */
  message: string;
}

/** A deploy request (dashboard, REST, MCP, Polpo's chat, an API update that auto-deploys). */
export interface AgentDeployRequest {
  actor: string;
  note?: string;
  trigger?: Exclude<DeployGateTrigger, "publish">;
  /** Deploy even if the suites fail (or without running them): admins only, with a reason. */
  override?: { reason: string };
  /** The caller is an admin (scope polpo:admin, an instance member). */
  admin?: boolean;
  /** Wait up to this long for the gate (default: return it pending). */
  waitMs?: number;
}

/** The host's deploy gate, as the orchestrator calls it (src/server/agent-deploy-gates.ts). */
export interface AgentDeployGateHook {
  /** Does the agent have required suites (a deploy of it goes through the gate)? */
  applies(agent: string): Promise<boolean>;
  /** Deploy a version through the gate. */
  request(agent: string, version: string, req: AgentDeployRequest): Promise<AgentDeployOutcome>;
  /** A version was published (not deployed): run the publish checks (gate.onPublish), non-blocking. */
  published(agent: string, version: string, actor: string): Promise<AgentDeployGate | undefined>;
  /** Production is being rolled back: stop the verifications in flight (a rollback is never gated). */
  rollingBack(agent: string, actor: string): Promise<void>;
}

/** The thresholds a suite's gate applies, defaults filled in. */
export function suiteGateThresholds(gate: SuiteGate | undefined): DeployGateSuite["thresholds"] {
  return {
    minPassRate: gate?.minPassRate ?? 1,
    ...(gate?.maxRegression !== undefined ? { maxRegression: gate.maxRegression } : {}),
    ...(gate?.scoreThresholds && Object.keys(gate.scoreThresholds).length ? { scoreThresholds: gate.scoreThresholds } : {}),
  };
}

/** The suites that gate a deploy (gate.required), by name. */
export function requiredGateSuites(suites: AgentSuite[]): AgentSuite[] {
  return suites.filter((s) => s.gate?.required === true && s.target.kind === "agent" && s.cases.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The suites a publish runs (required and gate.onPublish). */
export function publishCheckSuites(suites: AgentSuite[]): AgentSuite[] {
  return requiredGateSuites(suites).filter((s) => s.gate?.onPublish === true);
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const pts = (x: number) => `${Math.round(x * 1000) / 10} pts`;
const EPS = 1e-9;

type GateRun = Pick<SuiteRun, "status" | "stats" | "aggregates" | "baseline" | "error">;

/**
 * Does a finished run pass its suite's gate? Pass rate ≥ minPassRate (default 1), no drop of the
 * pass rate or the overall score versus the baseline beyond maxRegression, every scoreThresholds
 * entry met (by scorer id; "score" is the run's overall score). Returns the reasons it does not.
 */
export function evaluateSuiteGate(gate: SuiteGate | undefined, run: GateRun): { passed: boolean; reasons: string[] } {
  const t = suiteGateThresholds(gate);
  const reasons: string[] = [];
  if (run.status === "cancelled") return { passed: false, reasons: ["the run was cancelled"] };
  if (run.status === "queued" || run.status === "running") return { passed: false, reasons: ["the run has not finished"] };
  if (run.error) reasons.push(`the run failed: ${run.error}`);
  const counted = run.stats.total - run.stats.skipped;
  if (counted <= 0) reasons.push("no case ran");
  else if (run.stats.passRate + EPS < t.minPassRate) reasons.push(`pass rate ${pct(run.stats.passRate)} < ${pct(t.minPassRate)} (${run.stats.passed}/${counted} passed)`);
  if (t.maxRegression !== undefined) {
    const b = run.baseline;
    if (b) {
      if (-b.passRateDelta > t.maxRegression + EPS) reasons.push(`pass rate dropped ${pts(-b.passRateDelta)} versus the baseline (max ${pts(t.maxRegression)})`);
      if (b.scoreDelta !== undefined && -b.scoreDelta > t.maxRegression + EPS) reasons.push(`score dropped ${(-b.scoreDelta).toFixed(2)} versus the baseline (max ${t.maxRegression.toFixed(2)})`);
    }
  }
  for (const [id, min] of Object.entries(t.scoreThresholds ?? {})) {
    const mean = id === "score" ? run.aggregates?.score : run.aggregates?.scorers.find((s) => s.id === id)?.mean;
    if (mean === undefined) reasons.push(`no scores for "${id}" (threshold ${min})`);
    else if (mean + EPS < min) reasons.push(`${id === "score" ? "overall score" : id} ${mean.toFixed(2)} < ${min}`);
  }
  return { passed: reasons.length === 0, reasons };
}

/** The failed (or errored) cases of a run, with what failed: for the gate's report. */
export function gateFailedCases(run: Pick<SuiteRun, "results">, max: number = DEPLOY_GATE_LIMITS.failedCases): DeployGateFailedCase[] {
  return run.results
    .filter((r) => r.status === "failed" || r.status === "errored")
    .slice(0, max)
    .map((r) => ({
      key: r.key, caseName: r.caseName,
      failed: [
        ...r.assertions.filter((a) => !a.passed).map((a) => a.message ? `${a.description}: ${a.message}` : a.description),
        ...(r.scores ?? []).filter((x) => !x.passed).map((x) => `${x.description}: ${x.score.toFixed(2)} < ${x.threshold}`),
      ].slice(0, 10),
      ...(r.error ? { error: r.error } : {}),
    }));
}

/** "Suite: reason" for every suite that did not pass. */
export function deployGateFailures(gate: Pick<AgentDeployGate, "suites">): string[] {
  return gate.suites
    .filter((s) => s.status !== "passed")
    .map((s) => `${s.suiteName}: ${s.reasons.length ? s.reasons.join("; ") : s.status === "running" || s.status === "queued" ? "not finished" : s.status}`);
}

/** One line about a gate: for notes, MCP and chat replies. */
export function deployGateSummary(gate: AgentDeployGate): string {
  const n = gate.suites.length;
  const suites = `${n} required suite${n === 1 ? "" : "s"}`;
  switch (gate.status) {
    case "running": return `${gate.agent}@${gate.version}: verifying (${suites}, ${gate.progress.done}/${gate.progress.total} cases)`;
    case "passed": return `${gate.agent}@${gate.version}: ${suites} passed${gate.trigger === "publish" ? "" : gate.deployId ? ", deployed to production" : ""}`;
    case "blocked": return `Blocked by suites: ${deployGateFailures(gate).join(" · ")}`;
    case "failed": return `Publish check failed: ${deployGateFailures(gate).join(" · ")}`;
    case "override": return `Deployed with an override by ${gate.override?.by ?? "an admin"}: "${gate.override?.reason ?? ""}"${gate.override?.failed.length ? ` (failed: ${gate.override.failed.join(" · ")})` : ""}`;
    case "cancelled": return `${gate.agent}@${gate.version}: verification cancelled${gate.cancelledBy ? ` by ${gate.cancelledBy}` : ""}`;
    case "errored": return `${gate.agent}@${gate.version}: the gate failed${gate.error ? `: ${gate.error}` : ""}`;
  }
}

/** A gate as a deploy history entry carries it. */
export function deployGateRef(gate: AgentDeployGate): AgentDeployGateRef {
  return {
    id: gate.id, status: gate.status, trigger: gate.trigger, failed: deployGateFailures(gate),
    suites: gate.suites.map((s) => ({
      suiteId: s.suiteId, suiteName: s.suiteName, status: s.status,
      ...(s.runId ? { runId: s.runId } : {}), ...(s.passRate !== undefined ? { passRate: s.passRate } : {}), ...(s.score !== undefined ? { score: s.score } : {}),
    })),
    ...(gate.override ? { override: gate.override } : {}),
  };
}

/** Each version's latest gate (newest-first input): the badge per version. */
export function versionGateStatuses(gates: AgentDeployGate[]): Record<string, AgentVersionGateStatus> {
  const out: Record<string, AgentVersionGateStatus> = {};
  for (const g of [...gates].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))) {
    // a cancelled verification does not hide an earlier result
    if (out[g.version] || (g.status === "cancelled" && gates.some((x) => x.version === g.version && x.id !== g.id && x.status !== "cancelled"))) continue;
    out[g.version] = {
      gateId: g.id, status: g.status, trigger: g.trigger, at: g.finishedAt ?? g.requestedAt, failed: deployGateFailures(g),
      ...(g.status === "running" ? { progress: g.progress } : {}),
    };
  }
  return out;
}
