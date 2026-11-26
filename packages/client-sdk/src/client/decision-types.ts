// ── Decisions (decide(): typed judgments with probabilities from a decision model) ────

export type DecisionQuestionType = "predicate" | "choice" | "score" | "rank";

export interface DecisionQuestion {
  /** Unique in the request: letters, digits, _ and -, starting with a letter. */
  name: string;
  type: DecisionQuestionType;
  instructions: string;
  /** choice: the options (2–20). */
  choices?: Array<{ value: string; description?: string }>;
  /** score (rank: the rating scale): ordered levels, lowest first (2–11). */
  levels?: Array<string | { label: string; description?: string }>;
  /** rank: the items to sort (2–20). */
  items?: Array<string | { id?: string; label: string; description?: string }>;
  /** Confidence (0..1) below which the answer is uncertain. */
  threshold?: number;
}

export interface DecisionFallbackModel { model: string; confidenceBelow?: number }

/** settings.decisionModel: "gateway:model" or the object (its gateway's key in the vault, else the gateway's env var). */
export type DecisionModelSetting = string | {
  gateway?: string;
  model: string;
  fallback?: string | DecisionFallbackModel;
  credentialRef?: { owner: string; service: string };
  credentialField?: string;
  zeroDataRetention?: boolean;
};

export interface DecisionSettings {
  /** Without a decision model: "error" (default) or "orchestrator" (Polpo's own model answers, uncalibrated). */
  unconfigured?: "error" | "orchestrator";
  retention?: number;
  retentionDays?: number;
  storeInputs?: "capped" | "hash";
}

export interface DecideRequest {
  state: string | Record<string, unknown> | unknown[];
  questions: DecisionQuestion[];
  model?: DecisionModelSetting;
  thresholds?: number | Record<string, number>;
  fallback?: string | DecisionFallbackModel;
}

export interface DecisionAnswer {
  name: string;
  type: DecisionQuestionType;
  value?: boolean;
  probability?: number;
  choice?: string;
  score?: number;
  level?: string;
  probabilities?: Record<string, number>;
  ranking?: Array<{ id: string; label: string; score: number; confidence?: number }>;
  confidence?: number;
  threshold?: number;
  uncertain: boolean;
}

export interface DecisionUsage { inputTokens?: number; outputTokens?: number }

export interface DecideResult {
  id: string;
  answers: DecisionAnswer[];
  model: string;
  gateway?: string;
  usage: DecisionUsage;
  costUsd: number;
  /** false: no decision model is configured and Polpo's own model answered. */
  calibrated: boolean;
  latencyMs: number;
  uncertain: boolean;
}

export type DecisionCallerKind = "api" | "mcp" | "chat" | "agent" | "mission" | "suite" | "playground";

export interface DecisionLogSummary {
  id: string;
  at: string;
  caller: { kind: DecisionCallerKind; id?: string; label?: string; by?: string };
  status: "ok" | "error";
  error?: string;
  model: string;
  gateway?: string;
  calibrated: boolean;
  latencyMs: number;
  costUsd: number;
  usage: DecisionUsage;
  answers: DecisionAnswer[];
  uncertain: boolean;
  stateHash: string;
  stateChars: number;
  questions: Array<{ name: string; type: DecisionQuestionType }>;
}

export interface DecisionLogEntry extends Omit<DecisionLogSummary, "questions"> {
  questions: DecisionQuestion[];
  /** The state, capped (absent when the log keeps hashes only). */
  state?: string;
  stateTruncated?: boolean;
}

export interface DecisionLogPage { decisions: DecisionLogSummary[]; nextCursor?: string; total: number }

export interface DecisionStatus {
  configured: boolean;
  model?: string;
  gateway?: { id: string; label: string };
  fallback?: DecisionFallbackModel;
  zeroDataRetention?: boolean;
  /** Where the gateway's key comes from (never the key), and whether it resolves. */
  key?: { ok: boolean; source?: "vault" | "env"; detail: string };
  error?: string;
  unconfigured: "error" | "orchestrator";
  retention: number;
  retentionDays: number;
  storeInputs: "capped" | "hash";
  gateways: Array<{ id: string; label: string; envVar: string; docsUrl?: string }>;
}

/** A mission's decision node: deciding, decided (the branch taken), or waiting for a person. */
export interface DecisionNodeState {
  group: string;
  missionId?: string;
  node: string;
  status: "deciding" | "decided" | "awaiting";
  branch?: string | null;
  suggested?: string | null;
  decisionId?: string;
  answer?: DecisionAnswer;
  calibrated?: boolean;
  reason?: string;
  startedAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

/** A decision node in a mission (or playbook) document. */
export interface MissionDecision {
  name: string;
  afterTasks: string[];
  /** A template with {{tasks.<title>}}; default every after task's result. */
  state?: string;
  question: {
    type: DecisionQuestionType;
    instructions: string;
    choices?: Array<{ value: string; description?: string }>;
    levels?: Array<string | { label: string; description?: string }>;
    items?: string | Array<string | { id?: string; label: string; description?: string }>;
  };
  /** Answer → the task titles it starts. */
  branches: Record<string, string[]>;
  threshold?: number;
  onUncertain?: "human" | { branch: string };
  model?: string;
  notifyChannels?: string[];
}
