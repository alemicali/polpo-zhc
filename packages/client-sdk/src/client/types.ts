/**
 * OpenPolpo API types — mirrors the server contract.
 * Intentionally decoupled from @polpo-ai/core to avoid pulling
 * server-side dependencies (blessed, sqlite, etc.) into the client bundle.
 */

// === Task ===

export type TaskStatus =
  | "draft"
  | "pending"
  | "awaiting_approval"
  | "assigned"
  | "in_progress"
  | "review"
  | "done"
  | "failed";

export interface EvalDimension {
  name: string;
  description: string;
  weight: number;
  rubric?: Record<number, string>;
}

export interface DimensionScoreEvidence {
  file: string;
  line: number;
  note: string;
}

export interface DimensionScore {
  dimension: string;
  score: number;
  reasoning: string;
  weight: number;
  evidence?: DimensionScoreEvidence[];
}

export interface TaskExpectation {
  type: "test" | "file_exists" | "script" | "llm_review";
  command?: string;
  paths?: string[];
  criteria?: string;
  dimensions?: EvalDimension[];
  threshold?: number;
  confidence?: "firm" | "estimated";
}

export interface TaskMetric {
  name: string;
  command: string;
  threshold: number;
}

export interface RetryPolicy {
  escalateAfter?: number;
  fallbackAgent?: string;
  escalateModel?: string;
}

export type TaskPhase = "execution" | "review" | "fix" | "clarification";

// === Outcomes ===

export type OutcomeType = "file" | "text" | "url" | "json" | "media";

export interface TaskOutcome {
  id: string;
  type: OutcomeType;
  label: string;
  path?: string;
  mimeType?: string;
  size?: number;
  text?: string;
  url?: string;
  data?: unknown;
  producedBy?: string;
  producedAt: string;
  tags?: string[];
}

export interface ExpectedOutcome {
  type: OutcomeType;
  label: string;
  description?: string;
  path?: string;
  mimeType?: string;
  required?: boolean;
  tags?: string[];
}

export interface Task {
  id: string;
  title: string;
  description: string;
  assignTo: string;
  /** A published version of the assignee the task is pinned to (absent: production). */
  agentVersion?: string;
  group?: string;
  /** The mission the task belongs to (missions created before names were unique can share a group). */
  missionId?: string;
  dependsOn: string[];
  status: TaskStatus;
  expectations: TaskExpectation[];
  metrics: TaskMetric[];
  retries: number;
  maxRetries: number;
  maxDuration?: number;
  retryPolicy?: RetryPolicy;
  result?: TaskResult;
  phase?: TaskPhase;
  fixAttempts?: number;
  questionRounds?: number;
  resolutionAttempts?: number;
  originalDescription?: string;
  sessionId?: string;
  /** Absolute deadline (ISO timestamp). */
  deadline?: string;
  /** Priority weight for quality scoring. Default: 1.0 */
  priority?: number;
  expectedOutcomes?: ExpectedOutcome[];
  outcomes?: TaskOutcome[];
  /** Number of approval revision rounds. */
  revisionCount?: number;
  /** Scoped notification rules for this task. */
  notifications?: ScopedNotificationRules;
  /** Whether this task produces irreversible side effects. Blocks automatic retry/fix. */
  sideEffects?: boolean;
  /** Where and with what each run executed (engine, model, computer, egress, session, cost), newest last. */
  runs?: TaskRunContext[];
  /** Why it failed, in a line (GET /tasks/:id and slim lists; failed tasks only). */
  failure?: TaskFailure;
  /** Optional narrowing of the run's tools; absent: everything the agent has. */
  toolScope?: TaskToolScope;
  /** The member (email) who started it, when known: a CLI engine on a personal sign-in runs only its owner's tasks. */
  requestedBy?: string;
  /** GET /tasks/:id: what of the tool scope the agent no longer has (connector removed, access revoked…). */
  toolScopeStale?: string[];
  /**
   * What every run cost in all (first run, retries, continuations, directions): the breakdown on
   * GET /tasks/:id, the compact total in slim lists. Absent on records from events (compute it from `runs`).
   */
  cost?: TaskCost | TaskCostSummary;
  createdAt: string;
  updatedAt: string;
}

/** model_access: the model is not enabled for the account; auth: credentials refused; budget: a spend limit; killed: stopped or timed out. */
export type TaskFailureKind = "model_access" | "auth" | "budget" | "killed" | "assessment" | "error";

/** Why a task failed: the labelled reason of its last run, whether a retry could help, a kind for badges. */
export interface TaskFailure {
  /** The reason in a line (a harness error says what to change). */
  reason: string;
  /** false: not retried automatically (a re-run of the same agent fails the same way). */
  retryable: boolean;
  kind: TaskFailureKind;
}

/**
 * Optional narrowing of the tools a task's runs may use. It only narrows what the agent has
 * (never grants); absent fields inherit from the agent.
 */
export interface TaskToolScope {
  /** Connector ids (each account of an app is its own connector), or "none". */
  connectors?: string[] | "none";
  /** Per connector id: "*" or the server's raw tool names. */
  connectorTools?: Record<string, "*" | string[]>;
  /** Built-in tools or patterns (read, bash, browser_*); not connector tools. */
  allowedTools?: string[];
}

/**
 * An agent's CLI engine (agent.engine { type: "cli" }): the official Claude Code / Codex program,
 * signed in with a person's own plan through a CLI account (a config directory, never a token).
 */
export interface AgentCliEngine {
  type: "cli";
  cli: "claude" | "codex";
  account?: string;
  model?: string;
  permissionMode?: "allow-all" | "allow-edits" | "allow-reads";
  args?: string[];
}

/** A CLI account (settings.harnesses.cli.accounts; GET /harnesses/cli/accounts adds report, agents, manageable). */
export interface CliAccount {
  id: string;
  cli: "claude" | "codex";
  /** "host" or a computer id. */
  computer: string;
  configDir: string;
  /** The member who signed in, or "instance". */
  owner: string;
  label?: string;
  report?: { installed: boolean; version?: string; status?: { signedIn: boolean; who?: string; method?: string; plan?: string; detail?: string }; error?: string };
  agents?: string[];
  manageable?: boolean;
}

/** The engine a run used: Polpo's own, an agent harness, or a CLI on a personal plan (claude-cli, codex-cli). */
export type TaskRunEngine = "polpo" | "claude-code" | "codex" | "opencode" | "claude-cli" | "codex-cli";

/** Where and with what a task run executed (no secrets). */
export interface TaskRunContext {
  runId: string;
  startedAt: string;
  endedAt?: string;
  status: "running" | "completed" | "failed" | "killed";
  /** The run continued the previous one (a "continue" direction). */
  continuation?: boolean;
  /** The agent that ran it. */
  agent?: string;
  /** The agent's published version the run used. */
  agentVersion?: string;
  engine: TaskRunEngine;
  model?: string;
  /** The harness authentication kind (never the credential); provider: OpenCode's model provider (anthropic, openai, amazon-bedrock, vercel, polpo-gateway…). */
  auth?: { kind: "api-key" | "bedrock" | "vertex" | "ai-gateway" | "gateway" | "subscription"; region?: string; provider?: string };
  permissionMode?: string;
  effort?: string;
  computer: {
    /** "host", a computer id, or "ephemeral". */
    id: string;
    name?: string;
    kind: "host" | "daytona" | "e2b" | "ephemeral";
    provider?: "daytona" | "e2b";
    daytonaApi?: "v0" | "v2";
    remoteId?: string;
  };
  sandbox?: { provider: string; ephemeral: boolean; fallbackFrom?: string };
  egress: { mode: "direct" | "proxy"; proxy?: string; tailscale?: boolean };
  session?: { resumed: boolean; bootstrapMs?: number; sessionId?: string };
  cost?: {
    harnessUsd?: number;
    modelUsd?: number;
    tokens?: number;
    /** Where harnessUsd comes from (gateway, the runtime's estimate, tokens only). */
    costSource?: "gateway" | "runtime" | "runtime-estimate" | "tokens-only" | "subscription";
  };
  budgetUsd?: number;
  durationMs?: number;
  exitCode?: number;
}

/** One run in a task's cost breakdown (oldest first). */
export interface TaskCostRun {
  runId: string;
  startedAt: string;
  endedAt?: string;
  status: TaskRunContext["status"];
  continuation?: boolean;
  agent?: string;
  engine: TaskRunEngine;
  model?: string;
  durationMs?: number;
  /** USD; absent when the run recorded none (yet). */
  usd?: number;
  tokens?: number;
  costSource?: NonNullable<TaskRunContext["cost"]>["costSource"];
}

/** What a task cost: every recorded run of it (GET /tasks/:id → cost). A mission's cost adds these up. */
export interface TaskCost extends MissionCostBucket {
  currency: "USD";
  unpricedRuns: number;
  runsActive: number;
  byEngine: Array<MissionCostBucket & { engine: TaskRunEngine }>;
  perRun: TaskCostRun[];
  /** The latest run's cost, USD. */
  lastRunUsd?: number;
  /** Older runs were dropped (20 kept per task) and not recovered: the total may be higher. */
  partial: boolean;
  /** Harness cost of dropped runs, taken from the token-usage records. */
  recoveredUsd?: number;
  recovered?: { usd: number; tokens: number; agent: string; engine: TaskRunEngine };
}

/** The compact task cost in slim lists. */
export interface TaskCostSummary {
  usd: number;
  tokens: number;
  runs: number;
  partial?: boolean;
}

/** The latest run in a slim task row (list badges). */
export interface TaskRunSummary {
  engine: TaskRunEngine;
  model?: string;
  computerId: string;
  computerName?: string;
  computerKind: TaskRunContext["computer"]["kind"];
  provider?: string;
  status: TaskRunContext["status"];
}

/**
 * Slim projection returned by `GET /tasks?slim=true`. Drops the heavy
 * tail (outcomes, stdout/stderr, expectations, metrics, maxRetries) so
 * list rows over Tailscale stay sub-100KB even with hundreds of tasks.
 * The full record is still served by `GET /tasks/:id`.
 */
export interface TaskSlim {
  id: string;
  title: string;
  status: TaskStatus;
  phase?: TaskPhase;
  assignTo: string;
  group?: string;
  missionId?: string;
  dependsOn: string[];
  retries: number;
  createdAt: string;
  updatedAt: string;
  descriptionPreview?: string;
  result?: {
    assessment?: {
      globalScore?: number;
      passed?: boolean;
      checksCount?: number;
    };
  };
  /** Where and with what the latest run executed. */
  lastRun?: TaskRunSummary;
  /** What every run cost in all (not just the latest). */
  cost?: TaskCostSummary;
  /** Why it failed, in a line (failed tasks only). */
  failure?: TaskFailure;
  /** Its runs get only part of the agent's tools. */
  toolScope?: TaskToolScope;
}

export interface TaskResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  /**
   * false: the run failed for a reason a re-run of the same agent cannot fix (the model is not
   * enabled for the account, the credentials are refused): no automatic retry. Omitted: retryable.
   */
  retryable?: boolean;
  assessment?: AssessmentResult;
  /** All previous assessments (oldest first). Current assessment is always in `assessment`. */
  assessmentHistory?: AssessmentResult[];
}

// === Agent ===

// === MCP Server Config ===

/** Stdio-based MCP server — spawns a child process */
export interface McpStdioServerConfig {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** SSE-based MCP server (legacy, prefer HTTP) */
export interface McpSseServerConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
}

/** HTTP-based MCP server (streamable HTTP, recommended for remote) */
export interface McpHttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

/** Union of all supported MCP server configs */
export type McpServerConfig =
  | McpStdioServerConfig
  | McpSseServerConfig
  | McpHttpServerConfig;

// === Agent Identity & Vault ===

/** Agent identity — who this agent is and how it behaves */
/** A structured responsibility area */
export interface AgentResponsibility {
  area: string;
  description: string;
  priority?: "critical" | "high" | "medium" | "low";
}

export interface AgentIdentity {
  displayName?: string;
  title?: string;
  company?: string;
  email?: string;
  bio?: string;
  timezone?: string;
  /** Avatar image path relative to project root, served via /api/v1/files/read?path=<avatar> */
  avatar?: string;
  /** Its colour on screen: an agent colour token, "agent1" … "agent10" (default: picked from its name) */
  color?: string;
  /** Responsibilities — simple strings or structured objects with area/description/priority */
  responsibilities?: (string | AgentResponsibility)[];
  /** Communication tone — HOW the agent communicates */
  tone?: string;
  /** Personality traits — WHO the agent IS as a persona */
  personality?: string;
  /** Social & web accounts — keys are platform names, values are handles/URLs */
  socials?: Record<string, string>;
}

export interface Condition {
  expression: string;
}

export interface LoopOutputConfig {
  schema?: unknown;
}

export interface LoopConfig {
  name?: string;
  systemPrompt?: string;
  tools?: string[];
  model?: string;
  reasoning?: ReasoningLevel | string;
  maxTurns?: number;
  stopWhen?: Condition;
  output?: LoopOutputConfig;
}

export interface SwitchCase {
  when: string;
  steps: PipelineStep[];
}

export type PipelineStep =
  | { loop: string; when?: string }
  | { parallel: PipelineStep[]; join?: "all" | "any" | number; when?: string }
  | { switch: { cases: SwitchCase[]; default?: { steps: PipelineStep[] } }; when?: string }
  | { human: string; output?: LoopOutputConfig; notify?: string[]; when?: string };

export interface Pipeline {
  mode?: "sequential" | "parallel";
  context?: "shared";
  steps: PipelineStep[];
}

export interface AgentConfig {
  name: string;
  /** ISO timestamp of when this agent was created / added to the team. */
  createdAt?: string;
  /** GET/PATCH /agents/{name}: the production version, the latest and the draft's state. */
  versioning?: AgentVersioningSummary;
  role?: string;
  model?: string;
  allowedTools?: string[];
  /** MCP servers to connect to. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Filesystem sandbox — directories the agent is allowed to access.
   *  When omitted, defaults to the project workDir. */
  allowedPaths?: string[];
  /** Agent's identity — persona, responsibilities, communication style */
  identity?: AgentIdentity;
  // NOTE: Vault credentials are stored in encrypted .polpo/vault.enc — not on AgentConfig.
  /** Agent this one reports to — org chart hierarchy for escalation */
  reportsTo?: string;
  systemPrompt?: string;
  skills?: string[];
  /** Suggested starter prompts shown when opening a new chat with this agent. */
  suggestions?: AgentSuggestion[];
  maxTurns?: number;
  /** Max concurrent tasks for this agent. Default: unlimited. */
  maxConcurrency?: number;
  /** Which tools of each granted connector it gets, keyed by connector id: "*" (or no key) = all, a list = only those raw MCP tool names. */
  connectorTools?: Record<string, "*" | string[]>;
  /** Reasoning / deep thinking level for this agent's LLM calls. */
  reasoning?: ReasoningLevel;
  /** Runtime profile used by deterministic loop execution. */
  runtime?: string;
  /** Named deterministic loops available to this agent. */
  loops?: Record<string, LoopConfig>;
  /** Optional deterministic pipeline that composes the agent's loops. */
  pipeline?: Pipeline;
  volatile?: boolean;
  missionGroup?: string;

  // Tool categories are activated via allowedTools (e.g. ["browser_*", "email_*", "image_*", "video_*", "audio_*", "excel_*", "pdf_*", "docx_*", "search_*", "whatsapp_*", "phone_*"])
  // Note: HTTP tools (http_fetch, http_download) and vault tools (vault_get, vault_list) are always available as core tools.
  /** Browser profile name for persistent context (cookies, auth). Used with agent-browser --profile. */
  browserProfile?: string;
  /** Name of an egress proxy (settings.egressProxies) its browser goes out through. */
  browserEgress?: string;
  /** Computers (settings.computers ids) it may use; "host" (this server) always. */
  computers?: string[];
  /** Its default machine for chats and tasks: a computer id or "host" (unset: this server). */
  defaultComputer?: string;
  /** Allowed recipient email domains for email_send. Overrides global setting. */
  emailAllowedDomains?: string[];
}

export type AgentSuggestion = string | AgentSuggestionConfig;

export interface AgentSuggestionConfig {
  /** Short label shown in the UI. */
  title: string;
  /** Optional prompt sent to the agent. Defaults to title. */
  prompt?: string;
  /** Optional secondary text shown below the title. */
  description?: string;
}

export interface AgentActivity {
  lastTool?: string;
  lastFile?: string;
  filesCreated: string[];
  filesEdited: string[];
  toolCalls: number;
  totalTokens: number;
  lastUpdate: string;
  summary?: string;
  sessionId?: string;
}

export interface AgentProcess {
  agentName: string;
  pid: number;
  taskId: string;
  startedAt: string;
  alive: boolean;
  activity: AgentActivity;
}

// === Team ===

export interface Team {
  name: string;
  description?: string;
  agents: AgentConfig[];
}

// === Assessment ===

/** Serializable representation of a single message in the reviewer's conversation */
export interface ReviewerMessage {
  role: "user" | "assistant" | "toolResult";
  /** For user/assistant: text content. For toolResult: the tool output text. */
  content: string;
  /** Tool calls made by the assistant (if role === "assistant") */
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  /** For toolResult messages */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp: number;
}

/** Phase 1 exploration trace from a single reviewer */
export interface ReviewerExploration {
  /** Full analysis text produced by the reviewer during exploration */
  analysis: string;
  /** Files read by the reviewer during exploration */
  filesRead: string[];
  /** Complete conversation (user prompts, assistant responses, tool calls & results) */
  messages: ReviewerMessage[];
}

/** Individual reviewer result from llm_review multi-evaluator consensus */
export interface ReviewerResult {
  index: number;
  scores: { dimension: string; score: number; reasoning: string; evidence?: { file: string; line: number; note: string }[] }[];
  summary: string;
  globalScore: number;
  /** Phase 1 exploration trace (analysis, files read, full conversation) */
  exploration?: ReviewerExploration;
  /** Errors from scoring strategy attempts (Phase 2 fallback chain) */
  scoringAttemptErrors?: string[];
}

export interface CheckResult {
  type: TaskExpectation["type"];
  passed: boolean;
  message: string;
  details?: string;
  scores?: DimensionScore[];
  globalScore?: number;
  /** Individual reviewer results (llm_review only) — shows how each reviewer voted */
  reviewers?: ReviewerResult[];
}

export interface MetricResult {
  name: string;
  value: number;
  threshold: number;
  passed: boolean;
}

export type AssessmentTrigger = "initial" | "reassess" | "fix" | "retry" | "auto-correct" | "judge";

export interface AssessmentResult {
  passed: boolean;
  checks: CheckResult[];
  metrics: MetricResult[];
  llmReview?: string;
  scores?: DimensionScore[];
  globalScore?: number;
  timestamp: string;
  /** What triggered this assessment. */
  trigger?: AssessmentTrigger;
}

// === Mission ===

export type MissionStatus = "draft" | "scheduled" | "recurring" | "active" | "paused" | "completed" | "failed" | "cancelled";

export interface Mission {
  id: string;
  name: string;
  data: string;
  prompt?: string;
  status: MissionStatus;
  /** Absolute deadline (ISO timestamp). */
  deadline?: string;
  /** Cron expression or ISO timestamp for scheduled execution. */
  schedule?: string;
  /** End date for recurring schedules (ISO timestamp). After this date the schedule stops. */
  endDate?: string;
  /** Minimum average score for the mission to pass. */
  qualityThreshold?: number;
  /** Mission-level scoped notification rules. */
  notifications?: ScopedNotificationRules;
  /** How many times this mission has been executed. */
  executionCount?: number;
  /** Spending limit in USD for the whole mission: at it, no new task starts and it pauses. */
  budgetUsd?: number;
  /** Why the orchestrator paused it on its own: "budget". */
  pauseReason?: "budget";
  /** The member (email) who created it or set its schedule: its scheduled runs are their work (tasks' requestedBy). */
  owner?: string;
  /** What it cost so far: full on GET /missions/:id, compact (MissionCostSummary) in lists. */
  cost?: MissionCost | MissionCostSummary;
  createdAt: string;
  updatedAt: string;
}

/** USD, tokens and runs of a slice of a mission's cost. */
export interface MissionCostBucket {
  usd: number;
  /** The harness runtimes' own estimate (Claude Code, Codex, OpenCode). */
  harnessUsd: number;
  /** The model cost the provider reported (Polpo's engine). */
  modelUsd: number;
  tokens: number;
  runs: number;
}

/** What a mission cost: every recorded run of its tasks (retries and continuations included). */
export interface MissionCost extends MissionCostBucket {
  currency: "USD";
  tasks: number;
  unpricedRuns: number;
  runsActive: number;
  byAgent: Array<MissionCostBucket & { agent: string }>;
  byEngine: Array<MissionCostBucket & { engine: TaskRunEngine }>;
  /** Older runs of some task were dropped (20 kept per task): the total may be higher. */
  partial: boolean;
  partialTaskIds?: string[];
  recoveredUsd?: number;
  budgetUsd?: number;
  remainingUsd?: number;
  /** usd / budgetUsd. */
  budgetUsed?: number;
  overBudget?: boolean;
  /** No budget: the per-run harness budgets of the tasks' agents, summed (informational). */
  agentBudgetCapUsd?: number;
}

/** The compact cost in mission lists. */
export interface MissionCostSummary {
  usd: number;
  tokens: number;
  runs: number;
  partial?: boolean;
  budgetUsd?: number;
  overBudget?: boolean;
}

/**
 * Slim projection returned by `GET /missions?slim=true`. Drops the
 * potentially-multi-KB `data` JSON blob and the full `prompt`; surfaces
 * derived `taskCount` so list rows can render the badge without parsing
 * `data` themselves. The full record is still served by `GET /missions/:id`.
 */
export interface MissionSlim {
  id: string;
  name: string;
  status: MissionStatus;
  schedule?: string;
  deadline?: string;
  endDate?: string;
  qualityThreshold?: number;
  budgetUsd?: number;
  pauseReason?: "budget";
  owner?: string;
  cost?: MissionCostSummary;
  createdAt: string;
  updatedAt: string;
  taskCount?: number;
  promptPreview?: string;
}

// === Mission Document Types (parsed from Mission.data JSON) ===

/** Checkpoint defined within a mission — planned stopping point for human review.
 *  Pauses the mission when afterTasks complete; blocked tasks wait until resumed. */
export interface MissionCheckpoint {
  /** Checkpoint name (unique within the mission, used in events and resume calls). */
  name: string;
  /** Task titles that must all complete before this checkpoint triggers. */
  afterTasks: string[];
  /** Task titles that are blocked until the checkpoint is resumed. */
  blocksTasks: string[];
  /** Optional message shown when the checkpoint activates. */
  message?: string;
  /** Notification channels to alert when the checkpoint is reached. */
  notifyChannels?: string[];
}

/** Delay defined within a mission — timed wait between task groups.
 * Unlike checkpoints (which pause until a human resumes), delays automatically
 * resume after a specified duration elapses. */
export interface MissionDelay {
  /** Delay name (unique within the mission). */
  name: string;
  /** Task titles that must all complete before the delay timer starts. */
  afterTasks: string[];
  /** Task titles that are blocked until the delay timer expires. */
  blocksTasks: string[];
  /** ISO 8601 duration (e.g. "PT2H" = 2 hours, "PT30M" = 30 minutes, "P1D" = 1 day). */
  duration: string;
  /** Optional message shown when the delay starts. */
  message?: string;
  /** Notification channels to alert when the delay starts / expires. */
  notifyChannels?: string[];
}

/** Runtime state of an active delay (timer started, waiting to expire). */
export interface ActiveDelay {
  /** Mission group name. */
  group: string;
  /** Delay name. */
  delayName: string;
  /** Full delay definition. */
  delay: MissionDelay;
  /** ISO timestamp when the delay timer started. */
  startedAt: string;
  /** ISO timestamp when the delay will expire. */
  expiresAt: string;
}

/** Quality gate defined within a mission — automatic score-based blocking between task phases. */
export interface MissionQualityGate {
  /** Gate name (unique within the mission). */
  name: string;
  /** Task titles whose assessment scores are evaluated. */
  afterTasks: string[];
  /** Task titles blocked until the gate passes. */
  blocksTasks: string[];
  /** Minimum average score (1-5) of afterTasks required to pass. */
  minScore?: number;
  /** If true, all afterTasks must be "done" (not "failed") to pass. */
  requireAllPassed?: boolean;
  /** Custom condition expression. */
  condition?: string;
  /** Notification channels for pass/fail events. */
  notifyChannels?: string[];
}

export interface MissionReport {
  missionId: string;
  group: string;
  allPassed: boolean;
  totalDuration: number;
  tasks: {
    title: string;
    status: "done" | "failed";
    duration: number;
    score?: number;
    filesCreated: string[];
    filesEdited: string[];
    outcomes?: TaskOutcome[];
  }[];
  filesCreated: string[];
  filesEdited: string[];
  outcomes?: TaskOutcome[];
  avgScore?: number;
}

// === Notifications ===

export type NotificationSeverity = "info" | "warning" | "critical";
export type NotificationChannelType = "slack" | "email" | "telegram" | "whatsapp" | "whatsapp-business" | "webhook" | "push";
export type NotificationStatus = "sent" | "failed";

export type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";

export interface ChannelGatewayConfig {
  dmPolicy?: DmPolicy;
  allowFrom?: string[];
  enableInbound?: boolean;
  /** Minutes of inactivity before a new session starts. 0 = never expire. */
  sessionIdleMinutes?: number;
  /** "per-peer" (default) keeps channel chats separate; "shared" continues the web UI session. */
  sessionMode?: "per-peer" | "shared";
  /** Per-agent overrides, keyed by agent name. */
  agentSessions?: Record<string, { sessionMode?: "per-peer" | "shared"; sessionIdleMinutes?: number }>;
  /** Dedicate the channel to one agent (no /agent switching). */
  agent?: string;
  /** Conversation pipe: deliver chat replies through another channel (e.g. in from a webhook, out on Telegram). */
  replyTo?: { channel: string; chatId?: string; echoInbound?: boolean };
  /** "mentions" (default) or "intent": also answer group messages a classifier judges are for this agent. */
  groupReplies?: "mentions" | "intent";
  /** groupReplies "intent": how sure the classifier must be (0–1). Default 0.7. */
  intentThreshold?: number;
  /** Who may use slash commands: all (default), operators, none. */
  commands?: "all" | "operators" | "none";
}

/** WhatsApp Business settings (defaults in brackets). */
export interface WaBusinessSettings {
  /** customers [default]: answered only by gateway.agent; operators: the team. */
  audience?: "customers" | "operators";
  /** Operators' wa_ids (phone numbers with country code, digits). */
  operators?: string[];
  markRead?: boolean;
  typing?: boolean;
  /** A notification outside the 24-hour window: the template, or fail [default]. */
  outsideWindow?: "template" | "fail";
  notificationTemplate?: { name: string; language: string; bodyParams?: string[] };
  /** [UTILITY] */
  allowedCategories?: Array<"UTILITY" | "MARKETING" | "AUTHENTICATION">;
  /** [true] */
  approveTemplates?: boolean;
  limits?: { businessInitiatedPerDay?: number; perAgentPerDay?: Record<string, number> };
  /** [90] */
  retentionDays?: number;
}

export interface NotificationChannelConfig {
  type: NotificationChannelType;
  webhookUrl?: string;
  to?: string[];
  provider?: string;
  apiKey?: string;
  botToken?: string;
  chatId?: string;
  profileDir?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Webhook: secret for POST /api/v1/channels/<name>/inbound (Authorization: Bearer <secret>). */
  inboundSecret?: string;
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  vapidSubject?: string;
  ttl?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
  host?: string;
  port?: number;
  from?: string;
  /** WhatsApp Business: the phone number's id and the WhatsApp Business Account id (Meta). */
  phoneNumberId?: string;
  wabaId?: string;
  graphApiVersion?: string;
  /** WhatsApp Business: vault references of the secrets (owner "$channels"), set from the dashboard. */
  accessTokenRef?: { owner: string; service: string };
  appSecretRef?: { owner: string; service: string };
  verifyTokenRef?: { owner: string; service: string };
  business?: WaBusinessSettings;
  gateway?: ChannelGatewayConfig;
}

export interface NotificationRule {
  id: string;
  name: string;
  events: string[];
  condition?: unknown;
  channels: string[];
  severity?: NotificationSeverity;
  template?: string;
  cooldownMs?: number;
  includeOutcomes?: boolean;
  outcomeFilter?: OutcomeType[];
  maxAttachmentSize?: number;
}

export interface ScopedNotificationRules {
  rules: NotificationRule[];
  /** If true, rules are added on top of parent scope. If false (default), they replace. */
  inherit?: boolean;
}

export interface NotificationRecord {
  id: string;
  timestamp: string;
  ruleId: string;
  ruleName: string;
  channel: string;
  channelType: string;
  status: NotificationStatus;
  error?: string;
  title: string;
  body: string;
  severity: NotificationSeverity;
  sourceEvent: string;
  attachmentCount: number;
  attachmentTypes?: OutcomeType[];
}

export interface NotificationStats {
  total: number;
  sent: number;
  failed: number;
}

export interface SendNotificationRequest {
  channel: string;
  title: string;
  body: string;
  severity?: NotificationSeverity;
  delayMs?: number;
}

export interface SendNotificationResult {
  id: string;
  scheduledAt: string;
  firesAt: string;
}

// === Approval Gates ===

export type ApprovalGateHandler = "auto" | "human";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "timeout";

export interface ApprovalRequest {
  id: string;
  gateId: string;
  gateName: string;
  taskId?: string;
  missionId?: string;
  status: ApprovalStatus;
  payload: unknown;
  requestedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  note?: string;
}

// === Scheduling ===

export interface ScheduleEntry {
  id: string;
  missionId: string;
  expression: string;
  recurring: boolean;
  /** false: paused (persisted: a restart keeps it). */
  enabled: boolean;
  /** Same as !enabled. */
  paused?: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  deadlineOffsetMs?: number;
  /** The member (email) who owns it (the mission's owner): its runs' tasks are that member's work. */
  owner?: string;
  /** A run missed while the server was down: "once" runs it at startup (at most one interval late), "none" skips it. */
  catchUp?: "none" | "once";
  /** How the last run went: started (running), completed, failed, skipped, missed (server down), expired. */
  lastOutcome?: "started" | "completed" | "failed" | "skipped" | "missed" | "expired";
  lastError?: string;
  /** Runs missed (not run) because the server was down, in total. */
  missedRuns?: number;
  lastMissedAt?: string;
  createdAt: string;
}

// === Quality & SLA ===

export interface QualityMetrics {
  entityId: string;
  entityType: "task" | "agent" | "mission";
  totalAssessments: number;
  passedAssessments: number;
  avgScore?: number;
  minScore?: number;
  maxScore?: number;
  dimensionScores: Record<string, number>;
  totalRetries: number;
  totalFixes: number;
  deadlinesMet: number;
  deadlinesMissed: number;
  updatedAt: string;
}

// === Playbooks ===

export interface PlaybookParameter {
  /** Parameter name — used as {{name}} in the mission playbook. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Value type. Default: "string". */
  type?: "string" | "number" | "boolean";
  /** Whether the parameter must be provided. Default: false. */
  required?: boolean;
  /** Default value when not provided. */
  default?: string | number | boolean;
  /** Allowed values (enum constraint). */
  enum?: (string | number)[];
}

/** Lightweight playbook metadata (no mission body). */
export interface PlaybookInfo {
  name: string;
  description: string;
  parameters: PlaybookParameter[];
  /** Absolute path to the playbook directory. */
  path: string;
}

/** Full playbook definition including the mission body. */
export interface PlaybookDefinition {
  name: string;
  description: string;
  mission: Record<string, unknown>;
  parameters?: PlaybookParameter[];
}

/** Result of running a playbook. */
export interface PlaybookRunResult {
  mission: Mission;
  tasks: number;
  group: string;
  /** Non-blocking validation warnings (e.g. unknown parameters). */
  warnings?: string[];
}

// Backward-compat aliases
/** @deprecated Use PlaybookParameter instead. */
export type TemplateParameter = PlaybookParameter;
/** @deprecated Use PlaybookInfo instead. */
export type TemplateInfo = PlaybookInfo;
/** @deprecated Use PlaybookDefinition instead. */
export type TemplateDefinition = PlaybookDefinition;
/** @deprecated Use PlaybookRunResult instead. */
export type TemplateRunResult = PlaybookRunResult;

// === Config ===

/** Reasoning level for LLM calls. */
export type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Primary model with ordered fallbacks. */
export interface ModelConfig {
  /** Primary model spec (e.g. "anthropic:claude-opus-4-6"). */
  primary?: string;
  /** Ordered fallback models — tried when primary fails. */
  fallbacks?: string[];
}

/** Model allowlist entry with optional alias and parameter overrides. */
export interface ModelAllowlistEntry {
  /** Display alias for this model (e.g. "Sonnet", "GPT"). */
  alias?: string;
  /** Per-model parameter overrides. */
  params?: Record<string, unknown>;
}

/** Custom model definition for non-catalog providers (Ollama, vLLM, LM Studio, etc.) */
export interface CustomModelDef {
  /** Model ID used in API calls. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Whether the model supports extended thinking / reasoning. */
  reasoning?: boolean;
  /** Supported input types. Default: ["text"] */
  input?: ("text" | "image")[];
  /** Cost per million tokens. Default: all zeros (free/local). */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Context window size in tokens. Default: 200000 */
  contextWindow?: number;
  /** Max output tokens. Default: 8192 */
  maxTokens?: number;
  /** Per-model compatibility flags (custom providers). */
  compat?: Record<string, unknown>;
}

export interface BrandingConfig {
  productName?: string;
  tagline?: string;
  logoUrl?: string;
  /** The logo in dark mode (falls back to logoUrl). */
  logoDarkUrl?: string;
  /** How the logo is shown: "box" (default) in a tile, "none" bare. */
  logoFrame?: "box" | "none";
}

/** A mode's design tokens (any subset): colours, fonts, radii (px), shadows, buttonGradient { from, to, angle }. See docs/appearance.md. */
export type AppearanceTokens = Record<string, string | number | { from: string; to: string; angle?: number }>;

/** A web font the dashboard loads: Google Fonts by family (and weights), or an https stylesheet on an allowed font host. */
export interface AppearanceWebFont {
  family: string;
  source: "google" | "url";
  url?: string;
  weights?: string;
}

/** The dashboard's default look for everyone (settings.appearance); a person may customize their own browser. */
export interface AppearanceConfig {
  theme?: "light" | "dark" | "system";
  palette?: "tide" | "lovable" | "chatgpt" | "claude" | "brutal" | "editorial" | "redline" | "cyber" | "mono";
  custom?: { enabled: boolean; derive?: boolean; light?: AppearanceTokens; dark?: AppearanceTokens };
  fonts?: AppearanceWebFont[];
  /**
   * The navigation sidebar everyone gets by default: "drill-in" (the default when unset: top-level
   * entries open their pages as a second level in the sidebar) or "classic" (every page in one list).
   * A person may still choose their own in the dashboard.
   */
  sidebarStyle?: SidebarStyle;
}

/** The dashboard's navigation sidebar style (settings.appearance.sidebarStyle). */
export type SidebarStyle = "classic" | "drill-in";

export interface PolpoSettings {
  maxRetries: number;
  workDir: string;
  logLevel: "quiet" | "normal" | "verbose";
  branding?: BrandingConfig;
  appearance?: AppearanceConfig;
  taskTimeout?: number;
  staleThreshold?: number;
  defaultRetryPolicy?: RetryPolicy;
  enableVolatileTeams?: boolean;
  volatileCleanup?: "on_complete" | "manual";
  maxFixAttempts?: number;
  maxQuestionRounds?: number;
  maxResolutionAttempts?: number;
  autoCorrectExpectations?: boolean;
  /** Skills to load into the orchestrator's system prompt. Resolved against the orchestrator skill pool. */
  orchestratorSkills?: string[];
  /** Model for orchestrator LLM calls. Can be a string or a ModelConfig with fallbacks. */
  orchestratorModel?: string | ModelConfig;
  /** The orchestrator's display name (default "Polpo"). */
  orchestratorName?: string;
  imageModel?: string;
  modelAllowlist?: Record<string, ModelAllowlistEntry>;
  /** Global reasoning / deep thinking level. */
  reasoning?: ReasoningLevel;
  storage?: "file" | "sqlite";
  maxAssessmentRetries?: number;
  maxConcurrency?: number;
  approvalGates?: Array<Record<string, unknown>>;
  notifications?: Record<string, unknown>;
  escalationPolicy?: Record<string, unknown>;
  sla?: Record<string, unknown>;
  enableScheduler?: boolean;
  defaultQualityThreshold?: number;
  emailAllowedDomains?: string[];
  mcpToolAllowlist?: Record<string, string[]>;
}

export type ProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "azure-openai-responses";

export interface ProviderAuthConfig {
  type: "none" | "bearer" | "x-api-key" | "header";
  headerName?: string;
  prefix?: string;
  envVar?: string;
}

export interface ProviderConfig {
  /** Display name (custom providers). */
  label?: string;
  /** Wizard preset the provider was created from. */
  preset?: string;
  /** Built-in provider proxied by this endpoint. */
  proxyFor?: string;
  baseUrl?: string;
  /** API compatibility mode for custom endpoints. */
  api?: ProviderApi;
  /** How the key is sent (key itself lives in the vault). */
  auth?: ProviderAuthConfig;
  /** Static, non-secret headers. */
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  allowPrivateNetwork?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  /** Custom model definitions for this provider. */
  models?: CustomModelDef[];
}

/** Custom provider as returned by /providers/custom (no secrets). */
export interface CustomProviderInfo extends ProviderConfig {
  id: string;
  hasKey: boolean;
  /** Last 4 chars of the stored key (long keys only). */
  keyHint?: string;
  secretHeaderNames: string[];
  envVar?: string;
  envKeyPresent: boolean;
  keySource?: "vault" | "env" | "none";
  configured: boolean;
  warnings?: string[];
}

export interface PolpoConfig {
  version: string;
  project: string;
  teams: Team[];
  tasks: Omit<Task, "status" | "retries" | "result" | "createdAt" | "updatedAt">[];
  settings: PolpoSettings;
  providers?: Record<string, ProviderConfig>;
}

export interface PolpoState {
  project: string;
  teams: Team[];
  tasks: Task[];
  processes: AgentProcess[];
  startedAt?: string;
  completedAt?: string;
}

export interface AddTeamRequest {
  name: string;
  description?: string;
}

// === API ===

export type ErrorCode =
  | "NOT_FOUND"
  | "INVALID_STATE"
  | "VALIDATION_ERROR"
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "CONFLICT"
  /** A deploy the agent's required suites blocked (details: { status, gate, entry }). */
  | "GATE_BLOCKED"
  | "INTERNAL_ERROR";

export interface ApiResponse<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: string;
  code: ErrorCode;
  details?: unknown;
}

export type ApiResult<T> = ApiResponse<T> | ApiError;

// === Request DTOs ===

export interface CreateTaskRequest {
  title: string;
  description: string;
  assignTo: string;
  /** Create task as draft (won't be picked up until queued). Default: false. */
  draft?: boolean;
  expectations?: TaskExpectation[];
  expectedOutcomes?: ExpectedOutcome[];
  dependsOn?: string[];
  group?: string;
  maxDuration?: number;
  retryPolicy?: RetryPolicy;
  notifications?: ScopedNotificationRules;
  sideEffects?: boolean;
  /** Narrow the run's tools (rejected with INVALID_TOOL_SCOPE if it asks for more than the agent has). */
  toolScope?: TaskToolScope;
}

export interface UpdateTaskRequest {
  description?: string;
  assignTo?: string;
  status?: TaskStatus;
  expectations?: TaskExpectation[];
  sideEffects?: boolean;
  /** Narrow the run's tools; null clears it (everything the agent has). */
  toolScope?: TaskToolScope | null;
}

export type TaskDirectionMode = "steer" | "follow_up" | "continue";
export type TaskDirectionStatus = "queued" | "delivered" | "applied" | "failed";

export interface TaskDirection {
  id: string;
  taskId: string;
  runId?: string;
  mode: TaskDirectionMode;
  message: string;
  status: TaskDirectionStatus;
  createdAt: string;
  deliveredAt?: string;
  appliedAt?: string;
  error?: string;
}

export interface SendTaskDirectionRequest {
  message: string;
  mode?: "auto" | TaskDirectionMode;
  confirmSideEffects?: boolean;
}

export interface SendTaskDirectionResult {
  action: TaskDirectionMode;
  direction: TaskDirection;
}

export interface CreateMissionRequest {
  data: string;
  prompt?: string;
  name?: string;
  status?: MissionStatus;
  notifications?: ScopedNotificationRules;
  /** Spending limit in USD for the whole mission. */
  budgetUsd?: number;
}

export interface UpdateMissionRequest {
  data?: string;
  status?: MissionStatus;
  name?: string;
  endDate?: string | null;
  /** Spending limit in USD; null clears it. */
  budgetUsd?: number | null;
}

// === Atomic Mission Data Request DTOs ===

export interface AddMissionTaskRequest {
  title: string;
  description: string;
  assignTo?: string;
  dependsOn?: string[];
  expectations?: TaskExpectation[];
  expectedOutcomes?: ExpectedOutcome[];
  maxDuration?: number;
  retryPolicy?: RetryPolicy;
  notifications?: ScopedNotificationRules;
  sideEffects?: boolean;
  toolScope?: TaskToolScope;
}

export interface UpdateMissionTaskRequest {
  title?: string;
  description?: string;
  assignTo?: string;
  dependsOn?: string[];
  expectations?: TaskExpectation[];
  expectedOutcomes?: ExpectedOutcome[];
  maxDuration?: number;
  retryPolicy?: RetryPolicy;
  notifications?: ScopedNotificationRules;
  sideEffects?: boolean;
  toolScope?: TaskToolScope | null;
}

export interface ReorderMissionTasksRequest {
  titles: string[];
}

export interface AddMissionCheckpointRequest {
  name: string;
  afterTasks: string[];
  blocksTasks: string[];
  message?: string;
  notifyChannels?: string[];
}

export interface UpdateMissionCheckpointRequest {
  name?: string;
  afterTasks?: string[];
  blocksTasks?: string[];
  message?: string;
  notifyChannels?: string[];
}

export interface AddMissionDelayRequest {
  name: string;
  afterTasks: string[];
  blocksTasks: string[];
  duration: string;
  message?: string;
  notifyChannels?: string[];
}

export interface UpdateMissionDelayRequest {
  name?: string;
  afterTasks?: string[];
  blocksTasks?: string[];
  duration?: string;
  message?: string;
  notifyChannels?: string[];
}

export interface AddMissionQualityGateRequest {
  name: string;
  afterTasks: string[];
  blocksTasks: string[];
  minScore?: number;
  requireAllPassed?: boolean;
  condition?: string;
  notifyChannels?: string[];
}

export interface UpdateMissionQualityGateRequest {
  name?: string;
  afterTasks?: string[];
  blocksTasks?: string[];
  minScore?: number;
  requireAllPassed?: boolean;
  condition?: string;
  notifyChannels?: string[];
}

export interface AddMissionTeamMemberRequest {
  name: string;
  role?: string;
  model?: string;
  systemPrompt?: string;
  allowedTools?: string[];
}

export interface UpdateMissionTeamMemberRequest {
  name?: string;
  role?: string;
  model?: string;
  systemPrompt?: string;
  allowedTools?: string[];
}

export interface UpdateMissionNotificationsRequest {
  notifications: ScopedNotificationRules | null;
}

export interface AddAgentRequest {
  name: string;
  role?: string;
  model?: string;
  allowedTools?: string[];
  systemPrompt?: string;
  skills?: string[];
  suggestions?: AgentSuggestion[];
  maxTurns?: number;
  /** Max concurrent tasks for this agent. */
  maxConcurrency?: number;
  /** MCP servers to connect to. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Filesystem sandbox — directories the agent is allowed to access. */
  allowedPaths?: string[];
  /** Agent identity (display name, bio, avatar). */
  identity?: AgentIdentity;
  // NOTE: Vault credentials managed via encrypted store, not in API body.
  /** Org chart: who this agent reports to. */
  reportsTo?: string;
  runtime?: string;
  loops?: Record<string, LoopConfig>;
  pipeline?: Pipeline;
  /** Allowed email recipient domains (overrides global setting). */
  emailAllowedDomains?: string[];
  // Tool categories activated via allowedTools (e.g. ["browser_*", "email_*", "image_*", "video_*", "audio_*", "excel_*", "pdf_*", "docx_*", "search_*"])
}

export interface UpdateAgentRequest {
  role?: string;
  model?: string;
  allowedTools?: string[];
  allowedPaths?: string[];
  systemPrompt?: string;
  skills?: string[];
  suggestions?: AgentSuggestion[];
  maxTurns?: number;
  maxConcurrency?: number;
  identity?: AgentIdentity;
  reportsTo?: string;
  reasoning?: string;
  runtime?: string;
  loops?: Record<string, LoopConfig>;
  pipeline?: Pipeline;
  browserProfile?: string;
  /** Name of an egress proxy (settings.egressProxies) its browser goes out through. */
  browserEgress?: string;
  /** Computers (settings.computers ids) it may use; "host" always. */
  computers?: string[];
  /** Its default machine for chats and tasks (a computer id, or "host"); "" clears it. */
  defaultComputer?: string;
  emailAllowedDomains?: string[];
  /** Move agent to a different team. */
  team?: string;
  /**
   * Versioning: false keeps the change in the draft; true publishes it as a new version. Absent:
   * the instance setting decides (settings.agents.versioning.autoDeployApiUpdates, default: publish and deploy).
   */
  publish?: boolean;
  /** Publish and deploy the new version to production in the same call. */
  deploy?: boolean;
  bump?: AgentVersionBump;
  /** An explicit version number for the published version (above the latest). */
  version?: string;
  /** Release note of the published version. */
  note?: string;
}

// ── Agent versions ──

export type AgentVersionBump = "major" | "minor" | "patch";

export interface AgentFieldChange {
  field: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
  /** Long text fields (system prompt): a unified line diff. */
  textDiff?: string;
}

/** A published, immutable snapshot of an agent's configuration. */
export interface AgentVersion {
  agent: string;
  version: string;
  /** The versioned configuration (GET …/versions/{version}; absent in lists). */
  config?: Partial<AgentConfig>;
  author: string;
  createdAt: string;
  note?: string;
  bump: AgentVersionBump | "custom" | "initial";
  previous?: string;
  changes: AgentFieldChange[];
  changedFields?: string[];
  /** Skill versions pinned at publish time (skill → version number). */
  skillVersions?: Record<string, number>;
  /** Lists: the version's latest deploy gate (✓ passed, ✗ blocked / failed, in verifica, override). */
  gate?: import("./agent-suite-types.js").AgentVersionGateStatus;
}

export interface AgentVersionState {
  agent: string;
  production?: string;
  pointers: Record<string, string>;
  latest?: string;
  versions: number;
  draft: {
    exists: boolean;
    hasChanges: boolean;
    /** The version the draft is based on (production's when it started). */
    baseVersion?: string;
    /** Production moved away from the draft's base: rebase or discard before publishing. */
    stale: boolean;
    warning?: string;
    updatedAt?: string;
    updatedBy?: string;
    changes: AgentFieldChange[];
    suggestedBump?: AgentVersionBump;
    nextVersion?: string;
  };
  /** Deploy gates: the suites that gate deploys, the deploy being verified now. */
  gate?: { requiredSuites: Array<{ id: string; name: string; onPublish: boolean; allowRealTools: boolean }>; pending?: import("./agent-suite-types.js").AgentDeployGate };
}

/** The versioning summary returned with an agent (GET/PATCH /agents/{name}). */
export interface AgentVersioningSummary {
  production?: string;
  latest?: string;
  pointers: Record<string, string>;
  versions: number;
  draft: { exists: boolean; hasChanges: boolean; changedFields: string[]; baseVersion?: string; stale?: boolean; warning?: string; updatedAt?: string; updatedBy?: string; suggestedBump?: AgentVersionBump; nextVersion?: string };
  /** PATCH only: what the update did. */
  mode?: "draft" | "publish" | "deploy";
  draftChanged?: boolean;
  published?: { version: string; bump: string; changedFields: string[] };
  deployed?: AgentDeployEntry;
  /** A deploy through the required suites: deployed, pending ("in verifica") or blocked (published, not deployed). */
  deployStatus?: "deployed" | "pending" | "blocked";
  deployMessage?: string;
  gate?: { id: string; status: string; version: string; progress: { done: number; total: number }; failed: string[]; suites: Array<{ suiteId: string; suiteName: string; status: string; runId?: string; reasons: string[] }> };
  /** Set when the deploy was not made: "Published as 1.3.0 but not deployed: …". */
  warning?: string;
  /** mode publish: the publish checks started. */
  check?: { id: string; status: string; version: string };
}

export interface AgentVersionList {
  state: AgentVersionState;
  /** Newest first, without their config. */
  versions: AgentVersion[];
}

export interface AgentVersionDiff {
  agent: string;
  from?: string;
  to: string;
  changes: AgentFieldChange[];
  /** git-style unified diff of the configuration (YAML, keys sorted, text as blocks). */
  unified: string;
  suggestedBump?: AgentVersionBump;
}

export interface AgentDeployEntry {
  id: string;
  agent: string;
  pointer: string;
  from?: string;
  to: string;
  /** blocked: the required suites stopped the deploy (production did not move). */
  action: "deploy" | "rollback" | "initial" | "blocked";
  actor: string;
  note?: string;
  at: string;
  diff?: AgentVersionDiff;
  /** The deploy gate that verified it (or blocked it, or was overridden). */
  gate?: import("./agent-suite-types.js").AgentDeployGateRef;
}

/**
 * A deploy request's outcome: deployed (the history entry, with its gate), or pending (the required
 * suites are running: production moves when they pass). A blocked deploy throws a PolpoApiError
 * with code GATE_BLOCKED (details: { status, gate, entry }).
 */
export type AgentDeployOutcome =
  | (AgentDeployEntry & { status: "deployed"; gate?: import("./agent-suite-types.js").AgentDeployGate | import("./agent-suite-types.js").AgentDeployGateRef; message?: string })
  | { status: "pending"; gate: import("./agent-suite-types.js").AgentDeployGate; message?: string };

export interface AgentPublishResult {
  version: AgentVersion;
  deploy?: AgentDeployEntry;
  /** deploy: true through the required suites. */
  deployStatus?: "deployed" | "pending" | "blocked";
  message?: string;
  gate?: import("./agent-suite-types.js").AgentDeployGate;
  /** Without deploy: the publish checks started (suites with gate.onPublish). */
  check?: import("./agent-suite-types.js").AgentDeployGate;
}

// ── Agent tests ──

export type AgentTestCheckId = "engine" | "tools" | "connectors" | "vault" | "skills" | "computer" | "channels" | "versioning" | "smoke";
/** pass ✓, warn ⚠, fail ✗; skip: nothing to check. */
export type AgentTestStatus = "pass" | "warn" | "fail" | "skip";
/** A one-click fix (POST /agents/{name}/tests/fix). */
export type AgentTestFixAction = { type: "grant-connector-access"; connector: string };

export interface AgentTestItem {
  label: string;
  status: AgentTestStatus;
  detail?: string;
  /** A link to the setting (href, a dashboard path) or a one-click action. */
  fix?: { label: string; href?: string; action?: AgentTestFixAction };
}

export interface AgentTestCheckResult {
  id: AgentTestCheckId;
  title: string;
  status: AgentTestStatus;
  summary: string;
  items: AgentTestItem[];
  durationMs: number;
  /** engine: model, latencyMs, engine; computer: status, canStart; smoke: ref, tools, latencyMs. */
  data?: Record<string, unknown>;
}

export interface AgentTestRun {
  id: string;
  agent: string;
  /** production, draft or a published version. */
  target: string;
  version?: string;
  startedAt: string;
  finishedAt: string;
  status: AgentTestStatus;
  checks: AgentTestCheckResult[];
  actor?: string;
}

export interface AgentTestRunRequest {
  /** Default: every check but smoke. */
  checks?: AgentTestCheckId[];
  /** production (default), draft, or a version like 1.2.0. */
  target?: string;
  /** Start a stopped remote computer to test it (it may cost). */
  startComputer?: boolean;
  smokePrompt?: string;
}

export interface UpdateSettingsRequest {
  /** Sandbox settings (see GET /sandbox); null removes them. */
  sandbox?: Record<string, unknown> | null;
  /** Context compaction settings; null removes them. */
  compaction?: Record<string, unknown> | null;
  orchestratorModel?: string | ModelConfig;
  /** The orchestrator's display name (default "Polpo"); in an update, null or "" restores the default. */
  orchestratorName?: string | null;
  imageModel?: string | null;
  reasoning?: ReasoningLevel;
  branding?: BrandingConfig;
  /** The dashboard's default look; null removes it. */
  appearance?: AppearanceConfig | null;
}

// === SSE ===

export interface SSEEvent {
  id: string;
  event: string;
  data: unknown;
  timestamp: string;
}

// === Health ===

export interface HealthResponse {
  status: string;
  version: string;
  uptime: number;
}

// === Task Filters ===

export interface TaskFilters {
  /** Single status or comma-separated list (e.g. "pending,in_progress") */
  status?: TaskStatus | string;
  group?: string;
  assignTo?: string;
}

/**
 * Page of tasks returned by {@link PolpoClient.getTasksPage}.
 * - `tasks` is `TaskSlim[]` when `slim: true` was passed, otherwise `Task[]`.
 * - `nextCursor` is the `updated_at` of the last item — pass it back as
 *   `cursor` to fetch the next page. `null` when there are no more pages.
 * - `hasMore` is true when the server has at least one more row beyond
 *   the requested limit.
 */
export interface TasksPageResponse<T = Task | TaskSlim> {
  tasks: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface TasksPageRequest {
  limit?: number;
  cursor?: string | null;
  q?: string;
  status?: TaskStatus | string;
  group?: string;
  assignTo?: string;
  slim?: boolean;
}

// === Execution results ===

export interface ExecuteMissionResult {
  tasks: Task[];
  group: string;
}

export interface ResumeMissionResult {
  retried: number;
  pending: number;
}

// === Log types ===

export interface LogSession {
  sessionId: string;
  startedAt: string;
  entries: number;
}

export interface LogEntry {
  ts: string;
  event: string;
  data: unknown;
}

// === Run Activity types ===

/** A single entry from the per-run JSONL activity log. */
export interface RunActivityEntry {
  /** ISO timestamp (present on all entries except the header) */
  ts?: string;
  /** Event type: "spawning", "spawned", "activity", "sigterm", "done", "error" */
  event?: string;
  /** Transcript type: "stdout", "tool_use", "tool_result", "assistant", "error", "result" */
  type?: string;
  /** Agent output text (for stdout/assistant entries) */
  text?: string;
  /** Payload data (activity snapshot, lifecycle info, etc.) */
  data?: unknown;

  // ── tool_use fields ──
  /** Tool name (present on tool_use and tool_result entries) */
  tool?: string;
  /** Tool call ID (present on tool_use and tool_result entries) */
  toolId?: string;
  /** Tool input arguments (present on tool_use entries) */
  input?: Record<string, unknown>;

  // ── tool_result fields ──
  /** Tool output content (present on tool_result entries) */
  content?: string;
  /** Whether the tool call errored (present on tool_result entries) */
  isError?: boolean;

  /** Lifecycle / harness log line (type "log"; errors of type "error"). */
  message?: string;
  /** An agent harness's Polpo tool (it runs on the Polpo server, not in the runtime). */
  host?: boolean;
  /** Usage entries (type "usage"): the harness that reported them and the turn's tokens and cost. */
  harness?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;

  /** Present on the header line only */
  _run?: boolean;
  runId?: string;
  taskId?: string;
  agentName?: string;
  startedAt?: string;
  pid?: number;
}

// === Skill types ===

/** A discovered skill from the project skill pool. */
export interface SkillInfo {
  name: string;
  description: string;
  allowedTools?: string[];
  /** Where this skill was discovered from. */
  source: "project" | "global" | "polpo" | "claude" | "home";
  /** Absolute path to the skill directory. */
  path: string;
  /** Freeform tags for search and filtering (from skills-index.json). */
  tags?: string[];
  /** Macro-category for grouping (from skills-index.json). */
  category?: string;
}

/** Skill with full content loaded (returned by GET /skills/:name/content). */
export interface LoadedSkill extends SkillInfo {
  /** Full SKILL.md content (markdown body without frontmatter). */
  content: string;
}

/** Skill with agent assignment info (returned by GET /skills). */
export interface SkillWithAssignment extends SkillInfo {
  /** Agent names that have this skill assigned. */
  assignedTo: string[];
}

/** A single entry in the skills index file (.polpo/skills-index.json). */
export interface SkillIndexEntry {
  /** Freeform tags for search and filtering. */
  tags?: string[];
  /** Macro-category for grouping. */
  category?: string;
}

/** The full skills index: maps skill names to their index metadata. */
export type SkillIndex = Record<string, SkillIndexEntry>;

/** Which skill pool: the agents' skills or Polpo's (the orchestrator's) own. */
export type SkillPool = "agent" | "orchestrator";

/** A file of a skill folder (relative POSIX path) with its size in bytes. */
export interface SkillFileEntry {
  path: string;
  size: number;
}

/** The files of an installed skill (GET /skills/:name/files). */
export interface SkillFileList {
  name: string;
  source: SkillInfo["source"];
  files: SkillFileEntry[];
  /** More files exist than listed (the list stops at 2000). */
  truncated: boolean;
  totalBytes: number;
}

/** How a skill version came to be. "external": found on disk (the skill before versioning, or files changed outside Polpo). */
export type SkillVersionSource = "create" | "upload" | "git" | "local" | "edit" | "restore" | "external";

/** One version of a skill: a copy of the whole folder at that time. */
export interface SkillVersion {
  version: number;
  createdAt: string;
  /** "person:<email>", an agent's name, "polpo", "mcp:<client>", "cli" or "unknown". */
  author: string;
  source: SkillVersionSource;
  files: number;
  totalBytes: number;
  /** SKILL.md's frontmatter at that time. */
  name?: string;
  description?: string;
  /** The version a restore brought back. */
  restoredFrom?: number;
  hash: string;
}

/** A skill's history (GET /skills/:name/versions), newest first. */
export interface SkillVersionList {
  name: string;
  pool: SkillPool;
  scope: "project" | "global";
  versions: SkillVersion[];
  /** The current state's version (absent for a deleted skill). */
  current?: number;
  /** The skill was deleted: its history is kept until the grace period ends. */
  deletedAt?: string;
  deletedBy?: string;
  retention: { maxVersions: number; maxBytes: number; deletedDays: number };
}

/** The files of one version (GET /skills/:name/versions/:n/files). */
export interface SkillVersionFiles {
  name: string;
  version: SkillVersion;
  files: SkillFileEntry[];
  totalBytes: number;
  truncated: boolean;
}

/** One file that differs between two versions. */
export interface SkillFileDiff {
  path: string;
  status: "added" | "removed" | "changed";
  sizeA?: number;
  sizeB?: number;
  binary?: boolean;
  /** Unified diff from a to b (text files). */
  diff?: string;
  additions?: number;
  deletions?: number;
  /** No diff: the file is too large, or the diff was cut. */
  truncated?: boolean;
}

/** The diff of two versions (GET /skills/:name/versions/:a/diff/:b). */
export interface SkillVersionDiff {
  skill: string;
  a: SkillVersion;
  b: SkillVersion;
  files: SkillFileDiff[];
  unchanged: number;
  summary: { added: number; removed: number; changed: number };
}

/** A restore (POST /skills/:name/versions/:n/restore): the new version it recorded. */
export interface SkillRestoreResult {
  name: string;
  restoredFrom: number;
  version: SkillVersion;
}

/** A skill found in an uploaded .skill / .zip archive. */
export interface SkillBundleSkill {
  /** Frontmatter name (or the folder name when missing). */
  name: string;
  /** Its folder in the archive ("" when SKILL.md is at the root). */
  folder: string;
  description: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string[];
  metadata?: Record<string, unknown>;
  files: SkillFileEntry[];
  totalBytes: number;
  /** Block the install (a rename fixes name errors). */
  errors: string[];
  /** Deviations from the Agent Skills spec that do not block it. */
  warnings: string[];
  /** Whether the name is taken in each pool and scope. */
  exists: Record<SkillPool, { project: boolean; global: boolean }>;
}

/** The preview of an uploaded archive (POST /skills/upload?dryRun=1). */
export interface SkillBundlePreview {
  /** Install it with installSkillBundle within 30 minutes. */
  uploadId: string;
  archiveName?: string;
  skills: SkillBundleSkill[];
  /** Junk dropped (__MACOSX, .DS_Store…). */
  ignored: string[];
  warnings: string[];
  limits: { maxArchiveBytes: number; maxTotalBytes: number; maxFiles: number; maxFileBytes: number; maxPathLength: number };
}

/** How to install a skill bundle. */
export interface SkillBundleInstallOptions {
  pool?: SkillPool;
  /** The global pool (~/.polpo) instead of this project's. */
  global?: boolean;
  /** When a skill with the same name exists (default "fail"). */
  onConflict?: "fail" | "replace" | "skip";
  /** Only these skills of the archive. */
  skills?: string[];
  /** Archive name → name to install as. */
  renames?: Record<string, string>;
  /** Agents to assign the installed skills to (agent pool). */
  assignTo?: string[];
}

export interface SkillBundleInstallResult {
  installed: Array<{ name: string; from: string; path: string; replaced: boolean; files: number }>;
  skipped: Array<{ name: string; reason: string }>;
  errors: Array<{ name: string; error: string }>;
  assigned: Array<{ skill: string; agent: string }>;
  assignErrors?: string[];
}

// === Chat Session types ===

export interface ChatSession {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** Agent name when this session targets a specific agent (agent-direct mode). Absent for orchestrator sessions. */
  agent?: string;
  /** True when the user starred this session — surfaced in the sidebar "Starred" section. */
  starred?: boolean;
  /** Channel conversation the session belongs to (e.g. a Telegram group). */
  scope?: string;
  /** Set on a branch: the session it was forked from. */
  parentSessionId?: string;
  /** Set on a branch: the parent's message the branch starts after. */
  forkMessageId?: string;
}

/** A prompt waiting in a session's server-side queue. */
export interface ChatQueueItem {
  id: string;
  sessionId: string;
  content: string;
  createdAt: string;
  /** Set on a message that goes out next whatever auto-send says (a steer that missed its turn…). */
  steerId?: string;
}

export interface ChatQueueState {
  items: ChatQueueItem[];
  autoSend: boolean;
  /** Auto-send is held: the last turn errored, was stopped or waits for the user. */
  hold?: string;
}

/** Result of "send now" on a queued prompt. */
export type ChatQueueSendResult =
  | { mode: "steer"; turnId: string; steerId: string }
  | { mode: "turn"; turnId: string }
  | { mode: "scheduled" };

/** Result of steering a running turn. */
export interface SteerResult {
  id: string;
  turnId: string;
  /** pending: joins the turn at its next safe point; scheduled: the turn was over, it becomes the next message. */
  status: "pending" | "scheduled";
}

export interface ForkSessionResult {
  session: ChatSession;
  /** The turn answering the branch's last message, when it could start. */
  turnId: string | null;
  turnError?: string;
}

export interface ChatMessage {
  attachments?: Array<{ id: string; sessionId: string; messageId?: string; filename: string; mimeType: string; size: number; path: string; createdAt: string }>;
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: string;
  /** Tool calls executed during this assistant message (only for role=assistant) */
  toolCalls?: ToolCallEvent[];
  /** Ordered assistant render timeline preserving text/reasoning/tool interleaving. */
  segments?: ChatMessageSegment[];
}

// === Chat Completions types (OpenAI-compatible) ===

/** A text content part. */
export interface TextContentPart {
  type: "text";
  text: string;
}

/** An image content part (data URL or HTTPS URL). */
export interface ImageUrlContentPart {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

export type ContentPart = TextContentPart | ImageUrlContentPart | { type: "file"; file: { filename: string; file_data: string } };

export interface ChatCompletionMessage {
  role: "system" | "user" | "assistant";
  /** Plain string or multimodal content parts (text + images). */
  content: string | ContentPart[];
}

export interface ChatCompletionRequest {
  messages: ChatCompletionMessage[];
  stream?: boolean;
  /** Polpo extension: target a specific project by ID. If omitted, uses the first registered project. */
  project?: string;
  /** Ignored — Polpo uses its configured orchestrator model. */
  model?: string;
  /** Session ID for conversation persistence. If omitted, server auto-selects or creates one. */
  sessionId?: string;
  /** Target a specific agent by name for direct conversation. Uses the agent's own model, system prompt, and coding tools. Omit to talk to the orchestrator (default). */
  agent?: string;
}

export interface ChatCompletionChoice {
  index: number;
  message: { role: "assistant"; content: string };
  finish_reason: "stop" | "length" | "ask_user" | "mission_preview" | "vault_preview" | "open_file" | "navigate_to" | "open_tab" | "set_design" | "widget_render" | "whatsapp_preview" | "email_preview";
  /** Present when finish_reason is "ask_user" — structured questions for the user. */
  ask_user?: AskUserPayload;
  /** Present when finish_reason is "mission_preview" — proposed mission for user review. */
  mission_preview?: MissionPreviewPayload;
  /** Present when finish_reason is "vault_preview" — proposed vault entry for user review. */
  vault_preview?: VaultPreviewPayload;
  /** Present when finish_reason is "open_file" — file path to open in preview dialog. */
  open_file?: OpenFilePayload;
  /** Present when finish_reason is "navigate_to" — navigate the UI to a specific page. */
  navigate_to?: NavigateToPayload;
  /** Present when finish_reason is "open_tab" — open a URL in a new browser tab. */
  open_tab?: OpenTabPayload;
  /** Present when finish_reason is "set_design" — apply local appearance overrides. */
  set_design?: SetDesignPayload;
  /** Present when finish_reason is "widget_render" — render an inline HTML widget. */
  widget_render?: WidgetRenderPayload;
  /** Present when finish_reason is "whatsapp_preview" — proposed WhatsApp message awaiting user confirmation. */
  whatsapp_preview?: WhatsAppPreviewPayload;
  /** Present when finish_reason is "email_preview" — proposed email awaiting user confirmation. */
  email_preview?: EmailPreviewPayload;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatCompletionChunkDelta {
  role?: string;
  content?: string;
}

// === Tool Call streaming ===

export type ToolCallState = "preparing" | "calling" | "completed" | "error" | "interrupted";

export interface ToolCallProgress {
  message: string;
  taskId?: string;
  status?: string;
  elapsedMs?: number;
}

export type ChatMessageSegment =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool"; toolId: string };

export interface ToolCallEvent {
  /** Tool call ID from the LLM */
  id: string;
  /** Tool name (e.g. "create_task", "get_status") */
  name: string;
  /** Raw partial JSON arguments while the model is still generating the tool call. */
  argumentsText?: string;
  /** Tool input arguments (present when state is "calling") */
  arguments?: Record<string, unknown>;
  /** Tool execution result (present when state is "completed" or "error") */
  result?: string;
  /** Best-effort progress while a long-running tool remains in "calling" state. */
  progress?: ToolCallProgress;
  /** Current state of the tool call */
  state: ToolCallState;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: ChatCompletionChunkDelta;
    finish_reason: string | null;
    /** Present when finish_reason is "ask_user" — structured questions for the user. */
    ask_user?: AskUserPayload;
    /** Present when finish_reason is "mission_preview" — proposed mission for user review. */
    mission_preview?: MissionPreviewPayload;
    /** Present when finish_reason is "vault_preview" — proposed vault entry for user review. */
    vault_preview?: VaultPreviewPayload;
    /** Present when finish_reason is "open_file" — file path to open in preview dialog. */
    open_file?: OpenFilePayload;
    /** Present when finish_reason is "navigate_to" — navigate the UI to a specific page. */
    navigate_to?: NavigateToPayload;
    /** Present when finish_reason is "open_tab" — open a URL in a new browser tab. */
    open_tab?: OpenTabPayload;
    /** Present when finish_reason is "set_design" — apply local appearance overrides. */
    set_design?: SetDesignPayload;
    /** Present when finish_reason is "widget_render" — render an inline HTML widget. */
    widget_render?: WidgetRenderPayload;
    /** Present when finish_reason is "whatsapp_preview" — proposed WhatsApp message. */
    whatsapp_preview?: WhatsAppPreviewPayload;
    /** Present when finish_reason is "email_preview" — proposed email. */
    email_preview?: EmailPreviewPayload;
    /** Present when the server is executing a tool call. */
    tool_call?: ToolCallEvent;
    /** Present when the model is emitting thinking/reasoning tokens. */
    thinking?: string;
  }>;
}

// === Ask User (structured clarification questions) ===

export interface AskUserOption {
  label: string;
  description?: string;
}

export interface AskUserQuestion {
  /** Unique question key for matching answers */
  id: string;
  /** The full question text */
  question: string;
  /** Short label for compact display (max 30 chars) */
  header?: string;
  /** Pre-populated selectable options */
  options: AskUserOption[];
  /** Allow selecting multiple options (default: false) */
  multiple?: boolean;
  /** Show custom text input (default: true) */
  custom?: boolean;
}

export interface AskUserPayload {
  questions: AskUserQuestion[];
}

export interface AskUserAnswer {
  questionId: string;
  /** Labels of selected options */
  selected: string[];
  /** Custom text typed by user */
  customText?: string;
}

// === Mission Preview (interactive review before creation) ===

export interface MissionPreviewPayload {
  /** Proposed mission name */
  name: string;
  /** Parsed mission document (tasks, qualityGates, etc.) */
  data: unknown;
  /** Original user prompt that generated this mission */
  prompt?: string;
  /** Proposed spending limit in USD for the whole mission (create it with this budget) */
  budgetUsd?: number;
}

// === Vault Entry Metadata (safe listing — no secret values) ===

export interface VaultEntryMeta {
  /** Service name (vault key, e.g. "gmail", "stripe") */
  service: string;
  /** Credential type */
  type: "smtp" | "imap" | "oauth" | "api_key" | "login" | "custom";
  /** Human-readable label */
  label?: string;
  /** Logical mailbox account this entry belongs to. Same value across the
   *  SMTP and IMAP entries that form one mailbox. When null, falls back
   *  to `service` for grouping purposes. */
  account?: string;
  /** Other agent names allowed to use this credential. Empty/undefined →
   *  owner-private. Owner is implicit (the agent on the PK) and not listed. */
  allowedAgents?: string[];
  /** When the entry is inherited from another agent via `allowedAgents`,
   *  this carries the owner's name. Populated only by listVaultEntries when
   *  the row was shared; the UI uses it to render a read-only "shared from
   *  X" badge. NEVER stored — computed at read-time. */
  sharedFrom?: string;
  /** True when the entry is inherited (sharedFrom !== undefined). The UI
   *  uses this to gate edit/delete actions. */
  readOnly?: boolean;
  /** Credential field names (e.g. ["host", "port", "user", "pass"]) — values are NOT exposed */
  keys: string[];
}

// === Auth Profile Metadata (safe — no tokens exposed) ===

export type AuthProfileStatus = "active" | "cooldown" | "billing_disabled" | "expired";
export type AuthProfileType = "oauth" | "api_key";

/** Metadata for a single auth profile — tokens are NEVER exposed. */
export interface AuthProfileMeta {
  id: string;
  type: AuthProfileType;
  email?: string;
  expires?: number;
  expired: boolean;
  hasRefresh: boolean;
  lastUsed?: string;
  createdAt: string;
  status: AuthProfileStatus;
  cooldownUntil?: number;
  disabledUntil?: number;
  lastErrorReason?: string;
  disabledReason?: string;
  errorCount?: number;
}

/** Per-provider auth health info. */
export interface ProviderAuthInfo {
  hasEnvKey: boolean;
  envVar?: string;
  profiles: AuthProfileMeta[];
  oauthAvailable: boolean;
  oauthProviderName?: string;
  oauthFlow?: string;
  /** Custom provider / gateway (polpo.json `providers`, non built-in id). */
  custom?: boolean;
  /** Custom providers: usable (key in vault / env, or keyless). */
  configured?: boolean;
  label?: string;
  keySource?: "vault" | "env" | "none";
  hasVaultKey?: boolean;
  keyHint?: string;
}

/** Full auth status response — all providers. */
export interface AuthStatusResponse {
  providers: Record<string, ProviderAuthInfo>;
}

// === Member preferences (per signed-in member, follow the person across devices) ===

/** Where the person was in the chat: the open chat, tabs and panels. */
export interface ChatNavigationPreferences {
  /** Thread open in the chat; null = a new, unsaved chat. */
  lastSessionId?: string | null;
  /** Group open in the chat (wins over lastSessionId), or null. */
  lastRoomId?: string | null;
  /** Agent picked for the new chat when lastSessionId is null. */
  lastAgent?: string | null;
  /** Thread ids open as tabs, left to right. */
  openTabs?: string[];
  /** Right-hand chat panel shown on other pages. */
  sidePanelOpen?: boolean;
  /** Thread list (session sidebar) shown next to the chat. */
  threadsOpen?: boolean;
  /** When the preferences were last written (set by the server). */
  updatedAt?: string;
}

export interface MemberPreferences {
  chatNavigation?: ChatNavigationPreferences;
}

export interface MemberPreferencesPatch {
  chatNavigation?: Omit<ChatNavigationPreferences, "updatedAt">;
}

export interface MemberPreferencesResponse {
  /** Signed-in member the preferences belong to; null when shared (no instance auth). */
  member: string | null;
  preferences: MemberPreferences;
}

// === Global search (GET /search) ===

/** What the global search finds. */
export type SearchType =
  | "chat" | "room" | "agent" | "task" | "mission" | "schedule" | "playbook" | "approval" | "artifact" | "file"
  | "data" | "connector" | "skill" | "memory" | "brain" | "computer" | "app" | "channel" | "member" | "event";

/** A matched range [start, end) in a shown string. */
export type SearchRange = [number, number];

export interface SearchResult {
  type: SearchType;
  id: string;
  title: string;
  /** Matched ranges in the title. */
  titleHighlights?: SearchRange[];
  subtitle?: string;
  /** The matching passage (secrets masked) and its matched ranges. */
  snippet?: { text: string; highlights: SearchRange[] };
  /** Dashboard route that opens the item. */
  url: string;
  updatedAt?: string;
  score: number;
  /** Type details: agent, status, messageId, author, role, columns, path… */
  meta?: Record<string, unknown>;
}

export interface SearchGroup {
  type: SearchType;
  label: string;
  /** Matches of this type (the group holds the best of them). */
  total: number;
  items: SearchResult[];
}

export interface SearchResponse {
  query: string;
  /** Milliseconds the search took on the server. */
  took: number;
  /** Types that did not answer in time (search again for them). */
  partial: SearchType[];
  groups: SearchGroup[];
  items: SearchResult[];
  nextCursor: string | null;
}

export interface SearchOptions {
  /** Only these types (default: all). */
  types?: SearchType[];
  /** Results per page (default 40, max 100). */
  limit?: number;
  /** Results per type when several types are searched (default 6). */
  perType?: number;
  cursor?: string | null;
  /** Abort a stale query (the person kept typing). */
  signal?: AbortSignal;
}

// === Ask the search (POST /search/ask) ===

/** A dashboard page the assistant may open. */
export interface SearchAskPage {
  id?: string;
  label: string;
  to: string;
  section?: string;
}

/** A palette command the assistant may run (view-only) or suggest (confirm: it changes data). */
export interface SearchAskCommand {
  id: string;
  label: string;
  hint?: string;
  argument?: boolean;
  confirm?: boolean;
}

/**
 * What to do after an answer. auto: true ones (navigation, view-only commands) the dashboard runs at
 * once; the others are buttons the person clicks (never run by the server).
 */
export type SearchAskIntent =
  | { kind: "navigate"; route: string; label: string; auto: boolean }
  | { kind: "open"; route: string; label: string; key: string; auto: boolean }
  | { kind: "command"; id: string; label: string; argument?: string; auto: boolean }
  | { kind: "handoff"; label: string; message: string; auto: false };

export interface SearchAskResult {
  answer: string;
  items: SearchResult[];
  intents: SearchAskIntent[];
  /** Answered without the model (an obvious "go to X"). */
  fastPath: boolean;
  rounds: number;
  usage?: {
    provider?: string; model?: string;
    inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number; cost: number;
  };
}

export type SearchAskEvent =
  | { type: "status"; text: string }
  | { type: "delta"; text: string }
  | { type: "results"; items: SearchResult[] }
  | { type: "intent"; intent: SearchAskIntent }
  | { type: "done"; result: SearchAskResult }
  | { type: "error"; error: string; code?: string };

export interface SearchAskOptions {
  /** The page the person is on. */
  route?: string;
  /** The dashboard's pages (default: the server's list). */
  pages?: SearchAskPage[];
  /** The palette's commands the assistant may run or suggest. */
  commands?: SearchAskCommand[];
  /** Stream the answer: every event as it comes (text deltas, results, intents). */
  onEvent?: (event: SearchAskEvent) => void;
  signal?: AbortSignal;
}

// === Vault Preview (interactive credential review before saving) ===

export interface VaultPreviewPayload {
  /** Agent name */
  agent: string;
  /** Service name (vault key, e.g. "gmail", "stripe") */
  service: string;
  /** Credential type */
  type: "smtp" | "imap" | "oauth" | "api_key" | "login" | "custom";
  /** Human-readable label */
  label?: string;
  /** Credential key-value pairs — user can edit before confirming */
  credentials: Record<string, string>;
}

// === Client-side tools (executed on the user's device, not the server) ===

export interface OpenFilePayload {
  /** File path relative to project root */
  path: string;
}

export interface NavigateToPayload {
  /** Target page: dashboard, tasks, task, missions, mission, agents, agent, skills, skill, files, app_preview, activity, chat, memory, settings */
  target: string;
  /** Entity ID for detail pages (task, mission) */
  id?: string;
  /** Entity name for detail pages (agent, skill) */
  name?: string;
  /** Directory path for files target */
  path?: string;
  /** File to highlight/select for files target */
  highlight?: string;
  /** Public preview URL for the app_preview target */
  url?: string;
}

/** Payload for open_tab — opens a URL in a new browser tab. */
export interface OpenTabPayload {
  /** The URL to open */
  url: string;
  /** Optional human-readable label */
  label?: string;
}

export interface DesignThemePayload {
  /** Primary color as 6-digit hex. */
  primary?: string;
  /** Secondary/accent color as 6-digit hex. */
  secondary?: string;
  /** Main text color as 6-digit hex. */
  text?: string;
  /** Roundedness in px, 0-24. */
  radius?: number;
  /** Any valid CSS font-family stack. */
  fontFamily?: string;
}

/** Payload for set_design — proposes local appearance overrides in the browser. */
export interface SetDesignPayload extends DesignThemePayload {
  /** Enable/disable appearance overrides. Defaults to true when an override value is present. */
  enabled?: boolean;
  /** Light-mode override values. */
  light?: DesignThemePayload;
  /** Dark-mode override values. */
  dark?: DesignThemePayload;
}

/** Payload for widget_render — display-only inline interactive HTML widget. */
export interface WidgetRenderPayload {
  /** Self-contained HTML to render inside a sandboxed iframe. */
  html: string;
  /** Optional title shown in the card header. Ignored if `chrome` is false. */
  title?: string | null;
  /** Brief alt text / a11y description. */
  description?: string | null;
  /** Show card chrome (border + header). Default true. */
  chrome?: boolean;
  /** Opt-in chunk-by-chunk live preview during stream. Default false. */
  stream?: boolean;
}

// === WhatsApp Preview (interactive approval gate before send) ===

/** Payload for whatsapp_preview — proposed outbound WhatsApp message. The
 *  user must explicitly confirm via the UI before the bridge actually
 *  sends. Confirm path: POST /api/v1/whatsapp/send (text) or
 *  POST /api/v1/whatsapp/send-file (media). */
export interface WhatsAppPreviewPayload {
  /** Discriminator: "text" → whatsapp_send, "file" → whatsapp_send_file. */
  kind: "text" | "file";
  /** Recipient phone, contact name, or JID — passed straight from the
   *  tool args. The REST endpoint will resolve it to a JID using the
   *  WhatsApp store contact map. */
  to: string;
  /** Text body (kind="text" only). */
  message?: string;
  /** Local file path (kind="file" only) — relative to the agent workdir
   *  unless absolute, sandboxed by allowedPaths at send time. */
  path?: string;
  /** Optional caption for image / video / document attachments. */
  caption?: string;
  /** Force the WhatsApp media kind. Default "auto" (sniffed from MIME). */
  mediaKind?: string;
  /** Override MIME type. */
  mimeType?: string;
  /** Override displayed filename for documents. */
  fileName?: string;
  /** Send as view-once (image/video only). */
  viewOnce?: boolean;
}

// === Email Preview (interactive approval gate before send) ===

/** Payload for email_preview — proposed outbound email. The user must
 *  explicitly confirm via the UI before SMTP fires. Confirm path:
 *  POST /api/v1/email/send. The REST handler re-validates
 *  emailAllowedDomains at send time. */
export interface EmailPreviewPayload {
  /** Recipient(s) — string or array of strings. */
  to: string | string[];
  /** Subject line. */
  subject: string;
  /** Body content (plain text or HTML). */
  body: string;
  /** Treat body as HTML (default: auto-detect from `<...>` markers). */
  html?: boolean;
  /** CC recipients. */
  cc?: string | string[];
  /** BCC recipients. */
  bcc?: string | string[];
  /** Sender override (otherwise resolved from vault / env). */
  from?: string;
  /** Reply-To override. */
  reply_to?: string;
  /** File attachments — paths sandboxed by allowedPaths at send time. */
  attachments?: Array<{ path: string; filename?: string }>;
}

// === Connectors (external apps over MCP; GET /connectors) ===

export type ConnectorStatus = "disconnected" | "connecting" | "connected" | "needs_auth" | "needs_reauth" | "error" | "disabled";
export type ConnectorToolPolicy = "allow" | "ask" | "off";

/**
 * A connector as the API shows it (secrets only say whether they are set). Several accounts of
 * the same catalog app have their own ids (gmail, gmail-2…), names and `account`.
 */
export interface Connector {
  /** Slug used in tool names (mcp__<id>__<tool>). */
  id: string;
  /** Display name; another account of an app says which ("Gmail – info@acme.com"). */
  name: string;
  /** The signed-in account (e.g. an email), when the sign-in revealed it. */
  account?: string;
  kind: "mcp";
  description?: string;
  /** "hosted": a custom MCP server Polpo hosts itself (see McpHostedServer). */
  transport: { type: "http" | "sse" | "stdio" | "hosted"; url?: string; command?: string; serverId?: string };
  auth: { type: "none" | "bearer" | "headers" | "oauth"; headerNames?: string[]; oauth?: { app?: string; scopes?: string[] } };
  /** Hosted servers: the version in production ("Hosted by Polpo · v1.2.0"). */
  hostedVersion?: string;
  /** Who may use it: agent names or "*", and Polpo itself. */
  access: { agents: string[] | "*"; polpo: boolean };
  enabled: boolean;
  /** The catalog entry it came from (another account of the same app shares it). */
  catalogId?: string;
  toolPolicy?: Record<string, ConnectorToolPolicy>;
  createdAt: string;
  updatedAt?: string;
  status?: ConnectorStatus;
  lastError?: string;
  toolCount?: number;
  lastConnectedAt?: string;
  secrets?: { bearerToken: boolean; headers: string[]; clientSecret: boolean; values: string[]; oauth: { authorized: boolean; clientRegistered?: boolean; pending?: boolean } };
}

export interface ConnectorTool {
  /** The server's tool name (as agent.connectorTools lists it), not mcp__… */
  name: string;
  title?: string;
  description?: string;
  policy: ConnectorToolPolicy;
}

// ── Computer provider webhooks (GET /computer-webhooks, /computer-webhooks/:provider/events) ──

export type ComputerWebhookProvider = "daytona" | "e2b";
export type ComputerWebhookOutcome = "accepted" | "ignored" | "rejected" | "error";

/** Deliveries a provider's webhooks counted before the event log existed (no detail is kept for them). */
export interface ComputerWebhookCountsBefore {
  received: number;
  ignored: number;
  rejected: number;
  errors: number;
  /** When the event log took over. */
  until: string;
}

/** A computer provider's webhook status (never a secret). */
export interface ComputerWebhookStatus {
  provider: ComputerWebhookProvider;
  label: string;
  /** "manual": the person adds the endpoint at the provider (Daytona); "api": Polpo registers it (E2B). */
  registration: "manual" | "api";
  secretSet: boolean;
  registered?: boolean;
  webhookId?: string;
  /** The URL the provider must call. */
  url?: string;
  /** This instance has computers on this provider. */
  inUse: boolean;
  lastEventAt?: string;
  lastEventType?: string;
  /** Deliveries that passed the signature check (the counts are the event log's: the last 200 deliveries kept). */
  received: number;
  rejected: number;
  ignored: number;
  /** Deliveries Polpo could not apply. */
  errors: number;
  /** Deliveries counted before the event log existed: totals only, with no entry in the log. */
  before?: ComputerWebhookCountsBefore;
  /** The last problem since the provider was configured. */
  lastError?: string;
  lastErrorAt?: string;
  state: "receiving" | "configured" | "not-configured";
  /** Configured, but no delivery ever arrived: what to expect. */
  waitingNote?: string;
}

/** One webhook delivery, as the provider's event log keeps it (without payload). */
export interface ComputerWebhookEventSummary {
  id: string;
  provider: string;
  receivedAt: string;
  outcome: ComputerWebhookOutcome;
  /** Why it was ignored or rejected, or what went wrong. */
  reason?: string;
  /** What Polpo answered the provider. */
  httpStatus: number;
  signature: "valid" | "invalid" | "missing" | "not-checked";
  eventType?: string;
  providerEventId?: string;
  deliveryId?: string;
  sandboxId?: string;
  snapshotName?: string;
  /** This instance's computer the event is about. */
  computerId?: string;
  /** The provider's states the event reports. */
  providerState?: { from?: string; to?: string };
  /** The computer's status in Polpo before and after Polpo applied the event. */
  statusChange?: { from?: string; to?: string; error?: string; appliedAt?: string };
  /** What Polpo did, in a line. */
  action?: string;
  events?: number;
  processingMs: number;
  bytes: number;
}

/** One webhook delivery with its redacted payload and safe headers. */
export interface ComputerWebhookEvent extends ComputerWebhookEventSummary {
  payload?: unknown;
  payloadTruncated?: boolean;
  headers?: Record<string, string>;
}

export interface ComputerWebhookEventPage {
  provider: string;
  events: ComputerWebhookEventSummary[];
  nextCursor?: string;
  total: number;
  counts: Record<ComputerWebhookOutcome, number>;
}

// ── WhatsApp Business (Meta Cloud API) ─────────────────────────────────

export type WaBizOutcome = "accepted" | "ignored" | "rejected" | "error";
export type WaBizSecretKind = "accessToken" | "appSecret" | "verifyToken";

/** A WhatsApp Business channel's status (never a secret's value). */
export interface WaBusinessStatus {
  channel: string;
  phoneNumberId?: string;
  wabaId?: string;
  graphApiVersion: string;
  audience: "customers" | "operators";
  agent?: string;
  inbound: boolean;
  secrets: Record<WaBizSecretKind, boolean>;
  state: "receiving" | "configured" | "not-configured";
  missing: string[];
  callbackUrl?: string;
  funnelCommand: string;
  note: string;
  lastEventAt?: string;
  lastError?: string;
  counts: Record<WaBizOutcome, number>;
  inbox: number;
  pendingApprovals: number;
  sentToday: number;
  limits: { businessInitiatedPerDay: number; perAgentPerDay: Record<string, number> };
  phone?: { displayPhoneNumber?: string; verifiedName?: string; qualityRating?: string; messagingLimitTier?: string; checkedAt: string };
  templates?: { count: number; approved: number; syncedAt: string };
}

export interface WaBusinessEventSummary {
  id: string;
  channel: string;
  receivedAt: string;
  outcome: WaBizOutcome;
  reason?: string;
  httpStatus: number;
  signature: "valid" | "invalid" | "missing" | "not-checked";
  eventType?: string;
  phoneNumberId?: string;
  messages?: number;
  statuses?: number;
  action?: string;
  processingMs: number;
  bytes: number;
}

export interface WaBusinessEvent extends WaBusinessEventSummary {
  /** Types, lengths and masked contacts: never message text. */
  items?: Array<{ kind: "message" | "status"; wamid?: string; type?: string; length?: number; status?: string; contact?: string; error?: string }>;
}

export interface WaBusinessEventPage {
  channel: string;
  events: WaBusinessEventSummary[];
  nextCursor?: string;
  total: number;
  counts: Record<WaBizOutcome, number>;
}

export interface WaBusinessContact {
  channel: string;
  waId: string;
  userId?: string;
  name?: string;
  lastInboundAt?: string;
  optIn: { at: string; source: string } | null;
  optOut: { at: string; keyword: string } | null;
  window?: { open: boolean; closesAt?: string };
  createdAt: string;
  updatedAt: string;
}

export interface WaBusinessMessage {
  id: string;
  channel: string;
  waId: string;
  direction: "in" | "out";
  type: string;
  initiated?: "reply" | "business";
  sentBy?: string;
  template?: { name: string; language: string; category?: string };
  text?: string;
  status: string;
  statuses: Array<{ status: string; at: string; error?: string }>;
  pricing?: { category?: string; type?: string; billable?: boolean; model?: string };
  error?: { code?: number; title?: string; detail?: string };
  pending?: { template: string; language: string; params: string[]; requestedBy: string; requestedAt: string; reason?: string };
  createdAt: string;
  updatedAt: string;
}

export interface WaBusinessConversation {
  contact: WaBusinessContact & { masked?: string };
  window: { open: boolean; closesAt?: string };
  optedOut: boolean;
  messages: WaBusinessMessage[];
}

export interface WaBusinessTemplate {
  id?: string;
  name: string;
  language: string;
  status: string;
  category: string;
  parameterFormat?: "POSITIONAL" | "NAMED";
  components: Array<{ type: string; format?: string; text?: string }>;
}

export type WaBusinessSendResult =
  | { status: "sent"; ids: string[] }
  | { status: "pending_approval"; id: string; note: string };


// ── Hosted MCP servers ─────────────────────────────────────────────────

/** A vault reference: an entry (owner + service) and one credential field. Never a value. */
export interface McpSecretRef { owner: string; service: string; key: string }

export type McpServerAuth =
  | { type: "none" }
  | { type: "bearer"; secret: string }
  | { type: "header"; header: string; secret: string; prefix?: string }
  | { type: "query"; param: string; secret: string }
  | { type: "basic"; usernameSecret: string; passwordSecret: string }
  | { type: "oauth2_client_credentials"; tokenUrl: string; clientIdSecret: string; clientSecretSecret: string; scopes?: string[] };

export interface McpServerTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  requiresApproval?: boolean;
  publicCallable?: boolean;
  kind: "http" | "code";
  http?: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; headers?: Record<string, string>; query?: Record<string, string>; body?: unknown;
    bodyType?: "json" | "form";
    response?: {
      pick?: string; fields?: string[]; maxChars?: number;
      filters?: Array<{ path: string; input?: string; value?: string | number | boolean; match?: "equals" | "contains" | "in" | "gte" | "lte" }>;
      page?: { offsetInput?: string; limitInput?: string; defaultLimit?: number; maxLimit?: number };
      aggregates?: Record<string, { path: string; op: "count" | "unique" | "min" | "max" | "sum" | "value" }>;
    };
    pagination?: { style: "offset" | "cursor" | "page"; param?: string; sizeParam?: string; nextPath?: string; totalPath?: string };
    errors?: Array<{ status?: number | "4xx" | "5xx"; match?: string; message: string }>; retries?: number;
  };
  code?: { source: string };
  uiResource?: string;
  /** The server's scoped defaults this tool gets (spec.scopes). */
  scopes?: string[];
}

/** A non-secret setting a hosted server declares (`{{settings.key}}` in its tools). */
export interface McpServerSettingField {
  key: string; label: string; type: "string" | "number" | "enum" | "boolean";
  help?: string; required?: boolean; default?: string | number | boolean; options?: string[]; pattern?: string; min?: number; max?: number;
}

export interface McpServerSpec {
  name: string;
  description?: string;
  icon?: string;
  baseUrl?: string;
  allowedDomains: string[];
  secrets: Record<string, McpSecretRef>;
  auth: McpServerAuth;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  scopes?: Record<string, { description?: string; headers?: Record<string, string>; query?: Record<string, string> }>;
  settingsSchema?: McpServerSettingField[];
  limits?: Partial<Record<"timeoutMs" | "maxResponseBytes" | "maxResultChars" | "retries" | "memoryMb" | "concurrency" | "idleMs" | "depsMaxMb", number>>;
  dependencies?: Record<string, string>;
  tools: McpServerTool[];
  resources?: Array<{ uri: string; name: string; description?: string; mimeType: string; text: string }>;
}

export interface McpServerSummary {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  visibility: "private" | "public";
  disabled?: boolean;
  onTestFailure?: "warn" | "block";
  rateLimits?: { perIpPerMinute: number; globalPerMinute: number };
  connectorId?: string;
  template?: string;
  /** The template revision production was published from. */
  templateRevision?: number;
  /** Values of the spec's settingsSchema. */
  settings?: Record<string, string | number | boolean>;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  toolCount: number;
  production?: string;
  latest?: string;
  versionCount: number;
  draftChanged: boolean;
  pendingApprovals: number;
  /** Public servers: POLPO_PUBLIC_URL/mcp/servers/<id>. */
  publicUrl?: string;
}

export interface McpServerTestCase { id: string; name?: string; tool: string; input: Record<string, unknown>; expect?: "ok" | "error"; contains?: string }

export interface McpHostedServer extends McpServerSummary {
  draft: { spec: McpServerSpec; baseVersion?: string; updatedAt: string; updatedBy: string; problems: string[]; stale?: boolean } | null;
  productionSpec?: McpServerSpec;
  /** Which declared secrets are set in the vault (never their values). */
  secrets: Record<string, boolean>;
  tests: McpServerTestCase[];
  rateLimits: { perIpPerMinute: number; globalPerMinute: number };
  /** The settings the deployed (else draft) spec declares and what tools see (defaults applied). */
  settingsSchema: McpServerSettingField[];
  effectiveSettings: Record<string, string | number | boolean>;
  /** Made from a ready-made template: its revisions and the vendor's instructions per secret. */
  templateInfo?: {
    id: string; name: string; latestRevision: number; installedRevision?: number; docs: string;
    secrets: Record<string, McpServerTemplateSecret>; maturity: { testedWithLiveApi: boolean; note?: string };
  };
}

/** A credential a template needs, with the vendor's instructions (never a value). */
export interface McpServerTemplateSecret { label: string; howTo: string; url?: string; scopes?: string[]; recommendation?: string }

export type McpServerTemplateStatus = "available" | "draft" | "installed" | "update_available";

/** A ready-made hosted connector and where it stands on this instance. */
export interface McpServerTemplateInfo {
  id: string; name: string; vendor: string; category: string; description: string; icon?: string; docs: string; setup: string;
  revision: number; changelog: Array<{ revision: number; note: string }>; maturity: { testedWithLiveApi: boolean; note?: string };
  secrets: Array<McpServerTemplateSecret & { name: string; vault: McpSecretRef }>;
  settings: McpServerSettingField[];
  toolCount: number; testCount: number;
  tools: Array<{ name: string; title?: string; description: string; readOnly: boolean; requiresApproval: boolean; destructive: boolean }>;
  readOnlyTools: string[]; approvalTools: string[];
  status: McpServerTemplateStatus;
  installs: Array<{ serverId: string; production?: string; revision?: number; status: McpServerTemplateStatus; connectorId?: string }>;
}

export interface McpServerInstallRequest {
  id?: string;
  settings?: Record<string, string | number | boolean | null>;
  /** Secret values, saved straight to the vault (never returned). */
  secrets?: Record<string, string>;
  /** Who the connector grants ("*": all agents). Default none. */
  agents?: string[] | "*";
  publish?: boolean;
  force?: boolean;
}

export interface McpServerInstallResult {
  id: string; template: string; revision: number;
  status: "installed" | "needs_secrets" | "tests_failed" | "draft" | "upgrade_draft" | "up_to_date";
  missingSecrets?: string[];
  tests?: { passed: number; failed: number; skipped: number; results: McpToolTestResult[] };
  version?: string; deployed?: McpServerDeploy; diff?: McpServerDiff; connectorId?: string;
  access?: { agents: string[] | "*"; polpo: boolean };
  settings: Record<string, string | number | boolean>;
}

export interface McpServerVersionInfo {
  version: string; createdAt: string; author: string; note?: string; bump?: "major" | "minor" | "patch";
  changes: Array<{ field: string; kind: "added" | "removed" | "changed" }>; toolCount: number; production: boolean;
  build?: { depsBytes?: number; builtAt: string }; tests?: { passed: number; failed: number; skipped: number };
}

export interface McpServerDeploy {
  id: string; from?: string; to: string; action: "deploy" | "rollback" | "initial"; actor: string; note?: string; at: string;
  /** The deploy gate (the server's saved tests marked required): passed (with the suite run), or an admin's override with a reason. */
  gate?: { decision: "pass" | "override"; runId?: string; reason?: string; by?: string };
}

/** A publish whose deploy the required suite blocked: the version is published, not deployed. */
export interface McpServerDeployBlocked { reason: string; runId?: string; failures: string[] }

export interface McpServerDiff {
  server: string; from?: string; to: string; changes: Array<{ field: string; kind: "added" | "removed" | "changed" }>; unified: string; suggestedBump?: "major" | "minor" | "patch";
}

export interface McpToolTestResult {
  tool: string; ok: boolean; text: string; structured?: unknown; error?: string; status?: number; ms: number; attempts?: number;
  request?: { method: string; url: string; headers: Record<string, string>; body?: string };
  response?: string; skipped?: string; testId?: string; passed?: boolean;
  pendingApproval?: { id: string; approvalId?: string };
}

export interface McpServerCallLog {
  at: string; tool: string; source: "private" | "public" | "test" | "approval"; version?: string; ok: boolean; ms: number; status?: number; error?: string; ip?: string; approvalId?: string;
}

export interface McpPendingCall {
  id: string; serverId: string; tool: string; input: Record<string, unknown>; version?: string; requestedAt: string; requestedBy?: string;
  status: "pending" | "approved" | "rejected" | "done" | "failed"; approvalId?: string; resolvedAt?: string; resolvedBy?: string;
  result?: { ok: boolean; text: string; error?: string };
}

export interface McpServerGenerateRequest { mode: "api" | "description"; url?: string; text?: string; goal?: string; name?: string; vaultOwner?: string; create?: boolean; id?: string }
export interface McpServerGenerateResult {
  id?: string; spec: McpServerSpec; problems: string[]; notes: string[]; source: { kind: "openapi" | "docs" | "description"; endpoints?: number; title?: string };
}

// ── Artifacts ────────────────────────────────────────────────────────

export type ArtifactType = "doc" | "html" | "svg" | "mermaid" | "view";

/** How much the versions of an artifact take, against the limits (settings.artifacts.versions). */
export interface ArtifactVersionUsage {
  count: number;
  bytes: number;
  currentBytes: number;
  maxCount: number;
  maxBytes: number;
}

export interface ArtifactVersionInfo {
  version: number;
  /** Empty when the version is large: read it with getArtifactVersion or artifactContentUrl. */
  content: string;
  blob?: { sha256: string; size: number };
  size?: number;
  author?: string;
  note?: string;
  at: string;
}

export interface ArtifactSummary {
  id: string;
  title: string;
  type: ArtifactType;
  kind?: string;
  description?: string;
  version: number;
  author?: string;
  note?: string;
  createdBy: string;
  sessionId?: string;
  taskId?: string;
  missionId?: string;
  sources?: string[];
  refreshSeconds?: number;
  pinned?: boolean;
  tags?: string[];
  /** Bytes of the current content. */
  size: number;
  blob?: { sha256: string; size: number };
  createdAt: string;
  updatedAt: string;
}

export interface Artifact extends ArtifactSummary {
  /** The content; empty with contentOmitted when it is over the viewer limit (read it as a file or by part). */
  content: string;
  contentOmitted?: boolean;
  /** The beginning of a large content. */
  excerpt?: string;
  versions: ArtifactVersionInfo[];
  usage?: ArtifactVersionUsage;
  /** After a partial change: what it did ("1 update", "set_cells"…). */
  change?: string;
}

/** A change to an artifact's content (one kind per call): Claude-artifact style update / rewrite, plus append, prepend, JSON Patch and per-kind ops. */
export interface ArtifactChange {
  command?: "update" | "rewrite" | "append" | "prepend";
  old_str?: string;
  new_str?: string;
  replace_all?: boolean;
  updates?: Array<{ old_str: string; new_str: string; replace_all?: boolean }>;
  content?: string;
  text?: string;
  append?: string;
  prepend?: string;
  patch?: Array<{ op: "add" | "remove" | "replace" | "move" | "copy" | "test"; path: string; from?: string; value?: unknown }>;
  ops?: Array<{ op: string; [key: string]: unknown }>;
}

export interface ArtifactUpdateInput extends ArtifactChange {
  expectedVersion?: number;
  title?: string;
  description?: string;
  kind?: string;
  pinned?: boolean;
  sources?: string[];
  refreshSeconds?: number | null;
  tags?: string[];
  note?: string;
}

export interface ArtifactCreateInput {
  title: string;
  type: Exclude<ArtifactType, "view">;
  content: string;
  kind?: string;
  description?: string;
  sources?: string[];
  refreshSeconds?: number;
  pinned?: boolean;
  tags?: string[];
}

/** A byte range (offset/limit), the outline, or one part (tab, slide(s), sheet + range, board, page, scene). */
export interface ArtifactReadOptions {
  version?: number;
  offset?: number;
  limit?: number;
  outline?: boolean;
  tab?: string | number;
  slide?: string | number;
  slides?: string;
  sheet?: string | number;
  range?: string;
  board?: string | number;
  page?: string | number;
  scene?: string | number;
}

export interface ArtifactRead {
  id: string;
  version: number;
  text: string;
  size: number;
  start?: number;
  end?: number;
  more?: boolean;
  outline?: string;
}

export interface ArtifactUploadOptions {
  title?: string;
  type?: Exclude<ArtifactType, "view">;
  kind?: string;
  description?: string;
  /** The file's name (helps detect the type). */
  filename?: string;
  note?: string;
}

/** An upload in progress (POST /artifacts/uploads). */
export interface ArtifactUploadPart {
  uploadId: string;
  size: number;
  complete: boolean;
  filename?: string;
}

export interface ArtifactStorageUsage {
  bytes: number;
  maxBytes: number;
  /** Over 80% of maxBytes. */
  warning: boolean;
  limits: { maxBytes: number; inlineBytes: number; maxEditBytes: number; maxTotalBytes: number; versions: { maxCount: number; maxTotalBytes: number } };
  /** Contents over this are not sent whole with the artifact. */
  viewerBytes: number;
}
