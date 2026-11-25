/**
 * Agent tests: checks that verify everything an agent has at its disposal (engine and model, tools,
 * connectors, vault, skills, computer and sandbox, channels, versioning) and, on request, a live
 * smoke run. Each check returns pass / warn / fail with its items, details and a fix when there is
 * one (a link to the setting, or a one-click action). Runs are kept per agent (history).
 *
 * The checks themselves run on the server (src/server/agent-tests.ts); these are the shapes every
 * surface shares (REST, MCP, Polpo's chat, the SDK, the dashboard).
 */

export type AgentTestCheckId =
  | "engine" | "tools" | "connectors" | "vault" | "skills" | "computer" | "channels" | "versioning" | "smoke";

/** Every check, in the order they run and are shown ("smoke" only when asked for). */
export const AGENT_TEST_CHECKS: readonly AgentTestCheckId[] = [
  "engine", "tools", "connectors", "vault", "skills", "computer", "channels", "versioning", "smoke",
];

/** The checks "Run all" runs: everything but the live smoke run (it costs a real turn). */
export const AGENT_TEST_DEFAULT_CHECKS: readonly AgentTestCheckId[] = AGENT_TEST_CHECKS.filter((c) => c !== "smoke");

export const AGENT_TEST_TITLES: Record<AgentTestCheckId, string> = {
  engine: "Engine & model",
  tools: "Tools",
  connectors: "Connectors",
  vault: "Vault",
  skills: "Skills",
  computer: "Computer & sandbox",
  channels: "Channels",
  versioning: "Versioning",
  smoke: "Live smoke run",
};

/** pass ✓, warn ⚠, fail ✗; skip: nothing to check (e.g. no connectors). */
export type AgentTestStatus = "pass" | "warn" | "fail" | "skip";

/** A fix the person can apply in one click (the server does it: POST /agents/{name}/tests/fix). */
export type AgentTestFixAction =
  /** Add the agent to a connector's access list (access.agents). */
  | { type: "grant-connector-access"; connector: string };

export interface AgentTestFix {
  label: string;
  /** Where to fix it in the dashboard (a path such as /connectors?connector=printful). */
  href?: string;
  /** Or a one-click fix. */
  action?: AgentTestFixAction;
}

export interface AgentTestItem {
  /** What was checked ("model anthropic:claude-sonnet-4-5", "mcp__printful__*", "vault github"…). */
  label: string;
  status: AgentTestStatus;
  detail?: string;
  fix?: AgentTestFix;
}

export interface AgentTestCheckResult {
  id: AgentTestCheckId;
  title: string;
  /** The worst status of its items (skip when there was nothing to check). */
  status: AgentTestStatus;
  summary: string;
  items: AgentTestItem[];
  durationMs: number;
  /** Check-specific facts (engine: model, latencyMs, engine; smoke: the tool called, the reply). */
  data?: Record<string, unknown>;
}

/** What a run tested: production (what runs), the draft, or a published version. */
export type AgentTestTarget = "production" | "draft" | string;

export interface AgentTestRun {
  id: string;
  agent: string;
  target: AgentTestTarget;
  /** The version tested (production's or the given one); undefined for the draft or an unversioned agent. */
  version?: string;
  startedAt: string;
  finishedAt: string;
  /** The worst status of its checks. */
  status: AgentTestStatus;
  checks: AgentTestCheckResult[];
  /** Who ran it ("person:<email>", "polpo", "mcp:<client>"). */
  actor?: string;
}

export interface AgentTestRunRequest {
  /** Which checks (default: every check but "smoke"). */
  checks?: AgentTestCheckId[];
  /** production (default), draft, or a published version (1.2.0). */
  target?: AgentTestTarget;
  /** Start a stopped remote computer to test it (it may cost: only on an explicit request). */
  startComputer?: boolean;
  /** The smoke run's message (default: a short instruction to call one harmless tool). */
  smokePrompt?: string;
}

const RANK: Record<AgentTestStatus, number> = { skip: 0, pass: 1, warn: 2, fail: 3 };

/** The worst of some statuses (skip when empty or all skipped). */
export function worstAgentTestStatus(statuses: Iterable<AgentTestStatus>): AgentTestStatus {
  let worst: AgentTestStatus = "skip";
  for (const s of statuses) if (RANK[s] > RANK[worst]) worst = s;
  return worst;
}

export function isAgentTestCheckId(value: unknown): value is AgentTestCheckId {
  return typeof value === "string" && (AGENT_TEST_CHECKS as readonly string[]).includes(value);
}

/** Runs kept per agent. */
export const AGENT_TEST_HISTORY_LIMIT = 50;

/** Where test runs are kept (file, database…). */
export interface AgentTestStore {
  /** Newest first. */
  list(agent: string, limit?: number): Promise<AgentTestRun[]>;
  get(agent: string, id: string): Promise<AgentTestRun | undefined>;
  add(run: AgentTestRun): Promise<void>;
  deleteAgent(agent: string): Promise<void>;
}

export class InMemoryAgentTestStore implements AgentTestStore {
  private runs = new Map<string, AgentTestRun[]>();
  async list(agent: string, limit = AGENT_TEST_HISTORY_LIMIT) { return (this.runs.get(agent) ?? []).slice(0, limit); }
  async get(agent: string, id: string) { return this.runs.get(agent)?.find((r) => r.id === id); }
  async add(run: AgentTestRun) {
    this.runs.set(run.agent, [run, ...(this.runs.get(run.agent) ?? [])].slice(0, AGENT_TEST_HISTORY_LIMIT));
  }
  async deleteAgent(agent: string) { this.runs.delete(agent); }
}
