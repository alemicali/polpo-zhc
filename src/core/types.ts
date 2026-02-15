import type { McpServerConfig } from "../mcp/types.js";
export type { McpServerConfig } from "../mcp/types.js";

// === Task ===

export type TaskStatus =
  | "pending"
  | "awaiting_approval"
  | "assigned"
  | "in_progress"
  | "review"
  | "done"
  | "failed";

export interface EvalDimension {
  name: string;              // e.g. "correctness", "completeness"
  description: string;       // what this dimension measures
  weight: number;            // 0-1, weights should sum to ~1
  rubric?: Record<number, string>; // 1-5 score descriptions per level
}

export interface DimensionScore {
  dimension: string;         // dimension name
  score: number;             // 1-5
  reasoning: string;         // chain-of-thought for this score
  weight: number;            // weight used for global score
  evidence?: { file: string; line: number; note: string }[];
}

export interface TaskExpectation {
  type: "test" | "file_exists" | "script" | "llm_review";
  command?: string;
  paths?: string[];
  criteria?: string;
  /** For llm_review: evaluation dimensions with weights and rubrics */
  dimensions?: EvalDimension[];
  /** For llm_review: minimum weighted score (1-5) to pass. Default 3.0 */
  threshold?: number;
  /** Whether this expectation is a firm requirement or an estimate that can be auto-corrected.
   *  Default: "estimated" for file_exists, "firm" for test/script/llm_review. */
  confidence?: "firm" | "estimated";
}

export interface TaskMetric {
  name: string;
  command: string;
  threshold: number;
}

export interface RetryPolicy {
  /** After this many failures, escalate to fallbackAgent */
  escalateAfter?: number;
  /** Agent to use for escalation retries */
  fallbackAgent?: string;
  /** Model override for escalation (e.g. switch from haiku to sonnet) */
  escalateModel?: string;
}

export type TaskPhase = "execution" | "review" | "fix" | "clarification";

export interface Task {
  id: string;
  title: string;
  description: string;
  assignTo: string;
  group?: string;
  dependsOn: string[];
  status: TaskStatus;
  expectations: TaskExpectation[];
  metrics: TaskMetric[];
  retries: number;
  maxRetries: number;
  maxDuration?: number;       // ms, 0 = no timeout
  retryPolicy?: RetryPolicy;
  result?: TaskResult;
  phase?: TaskPhase;             // current phase (execution/review/fix/clarification)
  fixAttempts?: number;          // fix attempts in current review cycle
  questionRounds?: number;       // Q&A rounds with orchestrator (max default: 2)
  resolutionAttempts?: number;   // deadlock resolution attempts (max default: 2)
  originalDescription?: string;  // preserved before first retry/fix
  sessionId?: string;            // SDK session ID from the last agent run (for transcript access)
  createdAt: string;
  updatedAt: string;
}

export interface TaskResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  assessment?: AssessmentResult;
  /** All previous assessments (oldest first). Current assessment is always in `assessment`. */
  assessmentHistory?: AssessmentResult[];
}

// === Agent ===

/**
 * Adapter type for external agent runtimes.
 * When not specified (undefined), Polpo's built-in engine (Pi Agent) is used.
 * "claude-sdk" delegates to Anthropic's Claude Code SDK.
 */
export type AdapterType = "claude-sdk" | string;

export interface AgentConfig {
  name: string;
  /** External adapter to use. When omitted, Polpo's built-in engine (Pi Agent) is used.
   *  Use "claude-sdk" to delegate to Claude Code. */
  adapter?: AdapterType;
  role?: string;
  /** Model to use. Format: "provider:model" (e.g. "anthropic:claude-sonnet-4-5-20250929") or bare model ID (auto-inferred). */
  model?: string;
  /** Allowed tools for the agent (e.g. ["read", "write", "edit", "bash", "glob", "grep"]) */
  allowedTools?: string[];
  /** Filesystem sandbox — directories the agent is allowed to access.
   *  Paths can be absolute or relative to workDir. When set, all file tool operations
   *  and bash cwd are validated against these paths. When omitted, defaults to [workDir]. */
  allowedPaths?: string[];
  /** MCP servers to connect to. Works with both the built-in engine and claude-sdk adapter.
   *  Keys are server names, values are server configs (stdio or HTTP). */
  mcpServers?: Record<string, McpServerConfig>;
  /** System prompt appended to the agent's base prompt */
  systemPrompt?: string;
  /** Installed skill names (e.g. "find-skills", "frontend-design") */
  skills?: string[];
  /** Max conversation turns before stopping. Default 150 */
  maxTurns?: number;
  /** Max concurrent tasks for this agent. Default: unlimited (undefined). */
  maxConcurrency?: number;
  /** Volatile agent — created for a specific plan, auto-removed when plan completes */
  volatile?: boolean;
  /** Plan group this volatile agent belongs to */
  planGroup?: string;
}

export interface AgentActivity {
  lastTool?: string;        // last tool the agent used (e.g. "Write", "Edit", "Bash")
  lastFile?: string;        // last file touched
  filesCreated: string[];   // files created during this task
  filesEdited: string[];    // files edited during this task
  toolCalls: number;        // total tool calls made
  totalTokens: number;      // cumulative token usage across all turns
  lastUpdate: string;       // ISO timestamp of last activity
  summary?: string;         // agent's last text output / message
  sessionId?: string;       // SDK session ID for transcript access
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

export interface CheckResult {
  type: TaskExpectation["type"];
  passed: boolean;
  message: string;
  details?: string;
  /** Per-dimension scores from llm_review */
  scores?: DimensionScore[];
  /** Weighted average score (1-5) from llm_review */
  globalScore?: number;
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
  llmReview?: string;            // LLM reviewer's detailed feedback
  scores?: DimensionScore[];     // aggregated dimension scores
  globalScore?: number;          // aggregated weighted score (1-5)
  timestamp: string;
  /** What triggered this assessment. Defaults to "initial" for backwards compatibility. */
  trigger?: AssessmentTrigger;
}

/**
 * Replace the current assessment on a TaskResult, archiving the old one in assessmentHistory.
 * Also tags the new assessment with the given trigger.
 */
export function setAssessment(result: TaskResult, assessment: AssessmentResult, trigger: AssessmentTrigger): void {
  if (result.assessment) {
    if (!result.assessmentHistory) result.assessmentHistory = [];
    result.assessmentHistory.push(result.assessment);
  }
  assessment.trigger = trigger;
  result.assessment = assessment;
}

// === Review Context (passed to LLM reviewers for richer assessment) ===

export interface ReviewContext {
  taskTitle: string;
  taskDescription: string;
  agentOutput?: string;       // stdout truncated to last 2000 chars
  filesCreated?: string[];
  filesEdited?: string[];
}

// === Plan ===

export type PlanStatus = "draft" | "active" | "completed" | "failed" | "cancelled";

export interface Plan {
  id: string;
  name: string;         // "plan-1", "plan-2", or custom name
  data: string;         // JSON plan content (tasks, team, etc.)
  prompt?: string;      // original user prompt that generated this plan
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
}

/** Completion report for a plan — aggregated results across all tasks. */
export interface PlanReport {
  planId: string;
  group: string;
  allPassed: boolean;
  totalDuration: number;           // ms, sum of all task durations
  tasks: {
    title: string;
    status: "done" | "failed";
    duration: number;              // ms
    score?: number;                // global assessment score (1-5)
    filesCreated: string[];
    filesEdited: string[];
  }[];
  filesCreated: string[];          // aggregated across all tasks
  filesEdited: string[];           // aggregated across all tasks
  avgScore?: number;               // average assessment score
}

// === Runner Config ===

export interface RunnerConfig {
  runId: string;
  taskId: string;
  agent: AgentConfig;
  task: Task;
  polpoDir: string;
  cwd: string;
  storage?: "file" | "sqlite";
  /** UDS path for push-notifying the orchestrator on completion. */
  notifySocket?: string;
}

// === Polpo Config (.polpo/polpo.json — persistent project configuration) ===

export interface PolpoConfig {
  project: string;
  team: Team;
  settings: OrchestraSettings;
  providers?: Record<string, ProviderConfig>;
}

// === Provider Config ===

export interface ProviderConfig {
  /** API key (direct value or "${ENV_VAR}" reference). */
  apiKey?: string;
  /** Override base URL for the provider (e.g. custom proxy). */
  baseUrl?: string;
}

// === Config (.polpo/polpo.json) ===

export interface OrchestraConfig {
  version: string;
  project: string;
  team: Team;
  tasks: Omit<Task, "status" | "retries" | "result" | "createdAt" | "updatedAt">[];
  settings: OrchestraSettings;
  /** Per-provider API key and base URL overrides. */
  providers?: Record<string, ProviderConfig>;
}

export interface OrchestraSettings {
  maxRetries: number;
  workDir: string;
  logLevel: "quiet" | "normal" | "verbose";
  taskTimeout?: number;            // default timeout per task (ms). Default: 30min
  staleThreshold?: number;         // ms idle before agent considered stale. Default: 5min
  defaultRetryPolicy?: RetryPolicy;
  /** Whether plans can define volatile agents in their team: section. Default: true */
  enableVolatileTeams?: boolean;
  /** When to clean up volatile agents: "on_complete" (default) removes them when the plan
   *  finishes, "manual" keeps them until the user explicitly removes them or the plan is deleted */
  volatileCleanup?: "on_complete" | "manual";
  /** Max fix attempts per review cycle before falling back to full retry. Default: 2 */
  maxFixAttempts?: number;
  /** Max auto-answer rounds per task when agent asks questions. Default: 2 */
  maxQuestionRounds?: number;
  /** Max deadlock resolution attempts per task. Default: 2 */
  maxResolutionAttempts?: number;
  /** Auto-correct correctable expectations (e.g. file_exists paths) on assessment failure. Default: true */
  autoCorrectExpectations?: boolean;
  /** Model for orchestrator LLM calls (question detection, deadlock, plans). */
  orchestratorModel?: string;
  /** Storage backend for tasks, plans, and runs. Default: "file" (filesystem JSON). */
  storage?: "file" | "sqlite";
  /** Max assessment retries when all reviewers fail before falling back to fix/retry. Default: 1 */
  maxAssessmentRetries?: number;
  /** Max concurrent agent processes. Default: unlimited (undefined). */
  maxConcurrency?: number;
  /** Approval gates — checkpoints that block task/plan execution until approved. */
  approvalGates?: ApprovalGate[];
  /** Notification system — routes events to external channels (Slack, email, Telegram). */
  notifications?: NotificationsConfig;
  /** Default escalation policy — defines escalation chain when tasks fail repeatedly. */
  escalationPolicy?: EscalationPolicy;
}

// === Orchestra State (persisted in .polpo/state.json) ===

export interface OrchestraState {
  project: string;
  team: Team;
  tasks: Task[];
  processes: AgentProcess[];
  startedAt?: string;
  completedAt?: string;
}

// === Project Config (legacy JSON format) ===

/** Legacy project config stored in config.json */
export interface ProjectConfig {
  project: string;
  judge?: string;
  agent?: string;
  model?: string;
}

// === Approval Gates ===

export type ApprovalGateHandler = "auto" | "human";

export interface ApprovalGateCondition {
  /** JS-like expression evaluated against the hook payload.
   *  For "auto" gates — if condition passes, task proceeds. If it fails, task is blocked.
   *  For "human" gates — condition determines WHEN to trigger the gate. */
  expression: string;
}

export interface ApprovalGate {
  /** Unique gate ID. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** "auto" = system evaluates condition. "human" = blocks for human approval. */
  handler: ApprovalGateHandler;
  /** Which lifecycle hook triggers this gate. */
  hook: string;
  /** Optional condition — when to activate the gate. */
  condition?: ApprovalGateCondition;
  /** Notification channels to alert on gate activation (for "human" gates). */
  notifyChannels?: string[];
  /** Timeout in ms (for "human" gates). 0 = no timeout. */
  timeoutMs?: number;
  /** Action when timeout expires. Default: "reject". */
  timeoutAction?: "approve" | "reject";
  /** Priority within the same hook point. Lower = first. Default: 100. */
  priority?: number;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "timeout";

export interface ApprovalRequest {
  /** Unique request ID. */
  id: string;
  /** Gate that triggered this request. */
  gateId: string;
  /** Gate name (denormalized for display). */
  gateName: string;
  /** Related task ID, if applicable. */
  taskId?: string;
  /** Related plan ID, if applicable. */
  planId?: string;
  /** Current status. */
  status: ApprovalStatus;
  /** Hook payload snapshot at time of request. */
  payload: unknown;
  /** When the request was created. */
  requestedAt: string;
  /** When the request was resolved (approved/rejected/timeout). */
  resolvedAt?: string;
  /** Who resolved it (user ID, "system", "timeout"). */
  resolvedBy?: string;
  /** Optional resolution note. */
  note?: string;
}

// === Notification System ===

export type NotificationChannelType = "slack" | "email" | "telegram" | "webhook";

export interface NotificationChannelConfig {
  type: NotificationChannelType;
  /** Slack: webhook URL. */
  webhookUrl?: string;
  /** Email: recipient addresses. */
  to?: string[];
  /** Email: provider ("smtp" | "resend" | "sendgrid"). */
  provider?: string;
  /** API key (direct value or "${ENV_VAR}" reference). */
  apiKey?: string;
  /** Telegram: bot token. */
  botToken?: string;
  /** Telegram: chat ID. */
  chatId?: string;
  /** Webhook: target URL. */
  url?: string;
  /** Webhook: custom headers. */
  headers?: Record<string, string>;
  /** SMTP host. */
  host?: string;
  /** SMTP port. */
  port?: number;
  /** SMTP from address. */
  from?: string;
}

export type NotificationSeverity = "info" | "warning" | "critical";

export interface NotificationRule {
  /** Unique rule ID. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Event patterns to match (glob-style: "task:*", "plan:completed"). */
  events: string[];
  /** Optional JS-like condition on the event payload. */
  condition?: string;
  /** Channels to notify (references to channel IDs in config). */
  channels: string[];
  /** Severity level. Default: "info". */
  severity?: NotificationSeverity;
  /** Mustache-style template for the notification body. */
  template?: string;
  /** Minimum interval between notifications for the same rule (ms). */
  cooldownMs?: number;
}

export interface NotificationsConfig {
  channels: Record<string, NotificationChannelConfig>;
  rules: NotificationRule[];
}

// === Escalation ===

export type EscalationHandlerType = "agent" | "orchestrator" | "human";

export interface EscalationLevel {
  /** Level number (0 = first). */
  level: number;
  /** Who handles at this level. */
  handler: EscalationHandlerType;
  /** Target agent name (for "agent"), notification channel (for "human"). */
  target?: string;
  /** Timeout before escalating to next level (ms). */
  timeoutMs?: number;
  /** Notification channels to alert at this level. */
  notifyChannels?: string[];
}

export interface EscalationPolicy {
  /** Policy name. */
  name: string;
  /** Ordered escalation levels. */
  levels: EscalationLevel[];
}

// === Extended Settings ===

export interface OrchestraSettingsExtended {
  /** Approval gates configuration. */
  approvalGates?: ApprovalGate[];
  /** Notification system configuration. */
  notifications?: NotificationsConfig;
  /** Default escalation policy for tasks. */
  escalationPolicy?: EscalationPolicy;
}
