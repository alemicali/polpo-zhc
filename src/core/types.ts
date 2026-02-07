// === Task ===

export type TaskStatus =
  | "pending"
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
  createdAt: string;
  updatedAt: string;
}

export interface TaskResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  assessment?: AssessmentResult;
}

// === Agent ===

export type AdapterType = "claude-sdk" | "generic" | string;

export interface AgentConfig {
  name: string;
  adapter: AdapterType;
  role?: string;
  /** For generic adapter: the shell command to run. {prompt} and {taskFile} are replaced. */
  command?: string;
  /** For claude-sdk adapter: model to use */
  model?: string;
  /** For claude-sdk adapter: allowed tools */
  allowedTools?: string[];
  /** For claude-sdk adapter: MCP servers config */
  mcpServers?: Record<string, unknown>;
  /** System prompt appended to the agent's base prompt */
  systemPrompt?: string;
  /** Installed skill names (e.g. "find-skills", "frontend-design") */
  skills?: string[];
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

export interface AssessmentResult {
  passed: boolean;
  checks: CheckResult[];
  metrics: MetricResult[];
  llmReview?: string;            // LLM reviewer's detailed feedback
  scores?: DimensionScore[];     // aggregated dimension scores
  globalScore?: number;          // aggregated weighted score (1-5)
  timestamp: string;
}

// === Plan ===

export type PlanStatus = "draft" | "active" | "completed" | "failed" | "cancelled";

export interface Plan {
  id: string;
  name: string;         // "plan-1", "plan-2", or custom name
  yaml: string;         // full YAML content
  prompt?: string;      // original user prompt that generated this plan
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
}

// === Runner Config ===

export interface RunnerConfig {
  runId: string;
  taskId: string;
  agent: AgentConfig;
  task: Task;
  dbPath: string;
  cwd: string;
}

// === Config (orchestra.yml) ===

export interface OrchestraConfig {
  version: string;
  project: string;
  team: Team;
  tasks: Omit<Task, "status" | "retries" | "result" | "createdAt" | "updatedAt">[];
  settings: OrchestraSettings;
}

export interface OrchestraSettings {
  maxRetries: number;
  workDir: string;
  logLevel: "quiet" | "normal" | "verbose";
  taskTimeout?: number;            // default timeout per task (ms). Default: 30min
  staleThreshold?: number;         // ms idle before agent considered stale. Default: 5min
  defaultRetryPolicy?: RetryPolicy;
}

// === Orchestra State (persisted in .orchestra/state.json) ===

export interface OrchestraState {
  project: string;
  team: Team;
  tasks: Task[];
  processes: AgentProcess[];
  startedAt?: string;
  completedAt?: string;
}
