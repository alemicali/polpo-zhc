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
}

// === Agent ===

export type AdapterType = "native" | "claude-sdk" | "generic" | string;

export interface AgentConfig {
  name: string;
  /** Adapter to use. Defaults to "native" (Polpo's built-in engine). Use "claude-sdk" or "generic" for external tools. */
  adapter: AdapterType;
  role?: string;
  /** For generic adapter: the shell command to run. {prompt} and {taskFile} are replaced. */
  command?: string;
  /** Model to use. Format: "provider:model" (e.g. "anthropic:claude-sonnet-4-5-20250929") or bare model ID (auto-inferred). */
  model?: string;
  /** Allowed tools for the agent (e.g. ["read", "write", "edit", "bash", "glob", "grep"]) */
  allowedTools?: string[];
  /** For claude-sdk adapter: MCP servers config */
  mcpServers?: Record<string, unknown>;
  /** System prompt appended to the agent's base prompt */
  systemPrompt?: string;
  /** Installed skill names (e.g. "find-skills", "frontend-design") */
  skills?: string[];
  /** Max conversation turns before stopping. Default 150 */
  maxTurns?: number;
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
  dbPath: string;
  cwd: string;
}

// === Project Config (persisted preferences) ===

export interface ProjectConfig {
  project: string;      // project name (default: directory name)
  judge: string;        // adapter for assessment LLM (e.g. "claude-sdk")
  judgeModel: string;   // model for orchestrator LLM calls (judge, deadlock, question detection)
  agent: string;        // default adapter for agents (e.g. "claude-sdk", "generic")
  model: string;        // default model (e.g. "claude-sonnet-4-5-20250929")
  taskPrep?: boolean;   // LLM-powered task preparation (default: true)
}

// === Config (polpo.yml) ===

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
