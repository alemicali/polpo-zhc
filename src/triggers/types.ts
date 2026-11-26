/**
 * Triggers: public endpoints (POST /hooks/{id}) that receive events from outside — a form
 * submission (Tally, Typeform), a webhook from any service — check who sent them (a secret, an HMAC
 * signature, an IP allowlist), parse and validate them against a contract, filter and de-duplicate
 * them, and record each one as a delivery with the values an action would receive (mapping).
 *
 * What a trigger DOES on an accepted delivery is its actions (actions.ts): run a playbook, start a
 * mission, create a task, run an agent turn, send a notification, in order, after the 202, each
 * run's status (and what it created) recorded on the delivery.
 */

export type TriggerContentType = "json" | "form" | "multipart" | "text";
export const TRIGGER_CONTENT_TYPES: readonly TriggerContentType[] = ["json", "form", "multipart", "text"];

export type TriggerDeliveryStatus = "accepted" | "rejected" | "filtered" | "duplicate" | "rate_limited";
export const TRIGGER_DELIVERY_STATUSES: readonly TriggerDeliveryStatus[] = ["accepted", "rejected", "filtered", "duplicate", "rate_limited"];

export type TriggerHmacAlgorithm = "sha256" | "sha1";
export type TriggerHmacEncoding = "hex" | "base64";

export const TRIGGER_LIMITS = {
  /** Default body cap. */
  defaultMaxBodyBytes: 256 * 1024,
  /** The most a trigger may accept (multipart with files included). */
  maxBodyBytes: 10 * 1024 * 1024,
  /** Default per-file cap for multipart. */
  defaultMaxFileBytes: 5 * 1024 * 1024,
  /** The body kept on a delivery (larger ones are kept truncated). */
  storedBodyBytes: 64 * 1024,
  /** Deliveries kept per trigger by default, and the most one may keep. */
  defaultRetention: 500,
  maxRetention: 5000,
  /** Default and most requests per minute. */
  defaultRateLimitPerMinute: 60,
  maxRateLimitPerMinute: 6000,
  /** HMAC timestamp tolerance (seconds). */
  defaultToleranceSeconds: 300,
  /** Overlap a rotated secret keeps working (seconds): default one day, at most a week. */
  defaultOverlapSeconds: 24 * 3600,
  maxOverlapSeconds: 7 * 24 * 3600,
  /** Dedupe window (seconds): at most a week. */
  maxDedupeTtlSeconds: 7 * 24 * 3600,
  /** Dedupe keys remembered per trigger. */
  maxDedupeKeys: 20_000,
  /** Contract revisions kept per trigger. */
  contractRevisionsKept: 50,
  /** Mapping fields per trigger. */
  maxMappingFields: 50,
  /** Filter conditions per trigger. */
  maxFilterConditions: 20,
  /** IP allowlist entries. */
  maxIpAllowlist: 50,
  /** Actions per trigger. */
  maxActions: 10,
  /** Deliveries whose actions run at once, per trigger: default and most. */
  defaultActionConcurrency: 2,
  maxActionConcurrency: 10,
  /** Actions started per minute and per day, per trigger: defaults and most. */
  defaultActionsPerMinute: 30,
  maxActionsPerMinute: 600,
  defaultActionsPerDay: 1000,
  maxActionsPerDay: 100_000,
  /** Loop guard: how many triggers deep a chain of actions may go (A's action fires B, B's fires C). */
  maxChainDepth: 3,
  /** Retries of an action: the most, and the defaults (an agent turn is not repeated by default). */
  maxRetries: 5,
  defaultRetries: 2,
  defaultAgentRetries: 0,
  /** How long an action may wait for its mission or task to finish (seconds). */
  maxWaitSeconds: 3600,
  /** An agent action's tool-loop steps: default and most. */
  defaultAgentMaxSteps: 10,
  maxAgentMaxSteps: 50,
  /** The payload an agent action receives as data (bytes of JSON; larger is cut). */
  agentDataBytes: 20 * 1024,
  /** Earlier runs of a delivery's actions kept when it is re-run. */
  previousActionRunsKept: 5,
  /** A template in an action (title, body, instructions, a parameter). */
  maxActionTemplateChars: 8000,
} as const;

/** An HMAC signature check: the sender signs the raw body (optionally with a timestamp) with a shared secret. */
export interface TriggerHmacConfig {
  /**
   * "standard-webhooks" (https://www.standardwebhooks.com, Svix-style): the headers webhook-id /
   * webhook-timestamp / webhook-signature, the signed content "{id}.{timestamp}.{body}", signatures
   * "v1,<base64>" separated by spaces, and a "whsec_<base64>" secret used as its decoded bytes. The
   * other fields are then ignored (except toleranceSeconds, default 300). Absent: the generic HMAC below.
   */
  scheme?: "standard-webhooks";
  /** The header carrying the signature, e.g. x-hub-signature-256, typeform-signature, x-signature. */
  header: string;
  algorithm: TriggerHmacAlgorithm;
  encoding: TriggerHmacEncoding;
  /** Stripped before comparing, e.g. "sha256=". */
  prefix?: string;
  /** The header carrying the signing time (unix seconds or ms, or ISO); replays outside the tolerance are refused. */
  timestampHeader?: string;
  /** Seconds a timestamp may be off (default 300). */
  toleranceSeconds?: number;
  /**
   * What is signed: `{body}` (default) or a template with `{timestamp}`, e.g. `{timestamp}.{body}`
   * (Stripe-style) or `v0:{timestamp}:{body}` (Slack-style). `{body}` is the raw body, byte for byte.
   */
  signedPayload?: string;
}

/** How a delivery is authenticated. Every configured method must pass. */
export interface TriggerAuth {
  /** Require Polpo's generated secret: `Authorization: Bearer <secret>` or `X-Polpo-Secret: <secret>`. */
  secret: boolean;
  /** Also accept `?token=<secret>` (for senders that cannot set headers). Off by default: URLs end up in logs. */
  allowQueryToken?: boolean;
  /** An HMAC signature; its secret is in the vault (never returned). */
  hmac?: TriggerHmacConfig;
  /** Only these addresses (CIDR or single IPs, v4 or v6); empty or absent: any. */
  ipAllowlist?: string[];
}

/** One generated secret, as stored: its hash only. */
export interface TriggerSecretRecord {
  id: string;
  /** sha256 of the secret (hex). */
  hash: string;
  /** The first characters, to recognise it ("pts_Ab12…"). */
  hint: string;
  createdAt: string;
  /** A rotated-out secret keeps working until then. */
  expiresAt?: string;
}

/** What a delivery must look like. */
export interface TriggerContract {
  contentTypes: TriggerContentType[];
  maxBodyBytes: number;
  /** Multipart: per file. */
  maxFileBytes?: number;
  /** A JSON Schema the parsed body must satisfy (validated with the repo's validator). */
  schema?: Record<string, unknown>;
}

/** A contract as it was at a version. */
export interface TriggerContractRevision {
  version: number;
  contract: TriggerContract;
  createdAt: string;
  by?: string;
  note?: string;
}

export type TriggerFilterOp = "equals" | "not_equals" | "contains" | "in" | "gte" | "lte" | "exists" | "not_exists";
export const TRIGGER_FILTER_OPS: readonly TriggerFilterOp[] = ["equals", "not_equals", "contains", "in", "gte", "lte", "exists", "not_exists"];

/** A condition on the delivery: a path into body / headers / query (`body.answers[0].value`). */
export interface TriggerFilterCondition {
  path: string;
  op: TriggerFilterOp;
  value?: unknown;
}

export interface TriggerFilter {
  /** all (default): every condition must hold; any: one is enough. */
  mode?: "all" | "any";
  conditions: TriggerFilterCondition[];
}

export interface TriggerDedupe {
  /** A template over body / headers / query, e.g. `{{body.submission_id}}` or `{{headers.x-request-id}}`. */
  key: string;
  /** How long a key is remembered (seconds). */
  ttlSeconds: number;
}

/** A trigger as stored. */
export interface Trigger {
  /** A slug with a random suffix (tally-signup-3f9a1c2e): the endpoint is not guessable. */
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  /** Who owns it (an email, an agent, "polpo"). */
  owner?: string;
  createdAt: string;
  updatedAt: string;
  auth: TriggerAuth;
  /** Generated secrets (hashes): the current one and, during an overlap, the previous. */
  secrets: TriggerSecretRecord[];
  contract: TriggerContract;
  contractVersion: number;
  filter?: TriggerFilter;
  dedupe?: TriggerDedupe;
  rateLimitPerMinute: number;
  /** Named fields → templates over body / headers / query: what an action would receive. */
  mapping?: Record<string, string>;
  /** Deliveries kept (newest). */
  retention: number;
  /** What runs on an accepted delivery, in order. Absent or empty: nothing runs (the delivery is only recorded). */
  actions?: TriggerAction[];
  /** Safeguards on the actions (defaults in TRIGGER_LIMITS). */
  actionLimits?: TriggerActionLimits;
}

// ── Actions ──────────────────────────────────────────────────────────

export type TriggerActionKind = "playbook" | "mission" | "task" | "agent" | "notify";
export const TRIGGER_ACTION_KINDS: readonly TriggerActionKind[] = ["playbook", "mission", "task", "agent", "notify"];

/** A run of one action on one delivery. */
export type TriggerActionStatus = "queued" | "running" | "done" | "failed" | "skipped";
export const TRIGGER_ACTION_STATUSES: readonly TriggerActionStatus[] = ["queued", "running", "done", "failed", "skipped"];
/** A delivery's actions as a whole: partial = some done, some failed. */
export type TriggerActionsStatus = TriggerActionStatus | "partial";

interface TriggerActionBase {
  /** Stable within the trigger (generated when absent): runs and {{steps.<id>.…}} refer to it. */
  id: string;
  kind: TriggerActionKind;
  /** Off: skipped (recorded as skipped). Default on. */
  enabled: boolean;
  /** A label for lists. */
  name?: string;
  /** Retries after a failure, with backoff (default 2; 0 for agent turns). Never repeats what was already created. */
  retries?: number;
  /** When this action fails, still run the later ones (default false: they are skipped). */
  continueOnError?: boolean;
}

/**
 * Run a playbook by name (the same function as POST /playbooks/{name}/run). `params`: templates
 * over body / headers / query / mapped (`{{mapped.email}}`); a template that is one placeholder of
 * an object or list passes it as JSON.
 */
export interface TriggerPlaybookAction extends TriggerActionBase {
  kind: "playbook";
  playbook: string;
  params?: Record<string, string>;
  /** Wait until the playbook's mission ends (seconds, at most 3600): later actions can read {{steps.<id>.result}}. */
  waitSeconds?: number;
}

/**
 * Start an existing mission (by id or name), the same way as POST /missions/{id}/execute. With
 * `variables` (or when it cannot start again: completed, running) a copy runs, with its `{{name}}`
 * placeholders replaced by the variables.
 */
export interface TriggerMissionAction extends TriggerActionBase {
  kind: "mission";
  mission: string;
  variables?: Record<string, string>;
  waitSeconds?: number;
}

/** Create a task (the orchestrator's normal task creation). Title and description are templates. */
export interface TriggerTaskAction extends TriggerActionBase {
  kind: "task";
  title: string;
  description: string;
  assignTo: string;
  waitSeconds?: number;
}

/** Where an agent action's reply is sent (a Telegram chat through the instance's bots). */
export interface TriggerDeliverTo {
  /** Channel key of the bot that delivers (settings.notifications.channels). */
  channel: string;
  chatId: string;
  threadId?: number;
  /** The chat's name, for lists. */
  name?: string;
}

/**
 * One turn of an agent (or Polpo, when `agent` is absent) through the chat pipeline, in its own
 * session. `instructions` may only use {{trigger.*}} and {{delivery.*}}: the payload reaches the
 * agent as clearly delimited DATA after the instructions, never inside them.
 */
export interface TriggerAgentAction extends TriggerActionBase {
  kind: "agent";
  agent?: string;
  instructions: string;
  /** What data the turn receives: the mapped values, the body, or both (default: mapped when the trigger has a mapping, else body). */
  data?: "mapped" | "body" | "both";
  /** Only these tools in this turn (names; "prefix*" a family; [] none). Absent: the agent's own. */
  allowedTools?: string[];
  /** Tool-loop steps for the turn (default 10, at most 50). */
  maxSteps?: number;
  /** Send the reply there too (e.g. a Telegram chat). */
  deliverTo?: TriggerDeliverTo;
}

/** Send a message through a notification channel (the notification router). */
export interface TriggerNotifyAction extends TriggerActionBase {
  kind: "notify";
  channel: string;
  /** Template; default the trigger's name. */
  title?: string;
  body: string;
  severity?: "info" | "warning" | "critical";
}

export type TriggerAction = TriggerPlaybookAction | TriggerMissionAction | TriggerTaskAction | TriggerAgentAction | TriggerNotifyAction;

/** Safeguards on a trigger's actions. */
export interface TriggerActionLimits {
  /** Deliveries whose actions run at once (default 2). */
  concurrency?: number;
  /** Actions started per minute (default 30) and per day (default 1000); beyond, they are skipped. */
  perMinute?: number;
  perDay?: number;
  /** What the trigger's agent actions may spend per day (USD, from the recorded token usage); beyond, they are skipped. */
  agentDailyCostUsd?: number;
}

/** What an action created, to open from the delivery. */
export interface TriggerActionRefs {
  playbook?: string;
  missionId?: string;
  missionName?: string;
  /** mission: the mission the copy was made from. */
  copyOf?: string;
  taskId?: string;
  sessionId?: string;
  agent?: string;
  notificationId?: string;
  channel?: string;
}

/** One action's run on a delivery. */
export interface TriggerActionRun {
  actionId: string;
  kind: TriggerActionKind;
  name?: string;
  status: TriggerActionStatus;
  attempts: number;
  queuedAt: string;
  startedAt?: string;
  endedAt?: string;
  error?: string;
  /** Why it was skipped. */
  reason?: string;
  refs?: TriggerActionRefs;
  /** An agent turn's cost (USD), from the recorded token usage. */
  costUsd?: number;
  /** What later actions read as {{steps.<actionId>.<key>}} (reply, result, status, ids). Kept on the delivery only, not in lists. */
  outputs?: Record<string, unknown>;
}

/** A trigger's HMAC secret as the API shows it: set or not, never the value. */
export interface TriggerHmacSecretStatus {
  secretSet: boolean;
  /** A previous secret still accepted until then (rotation overlap). */
  previousUntil?: string;
}

/** A trigger as the API returns it: no hashes, the endpoint URL, the delivery counts. */
export interface TriggerView extends Omit<Trigger, "secrets"> {
  secrets: Array<Omit<TriggerSecretRecord, "hash">>;
  hmacSecret?: TriggerHmacSecretStatus;
  /** POLPO_PUBLIC_URL + /hooks/{id}, when the public URL is known; else the path. */
  endpoint: string;
  /** The path to publish (Tailscale Funnel: /<instance>/hooks/). */
  path: string;
  stats: TriggerStats;
}

export interface TriggerStats {
  /** Deliveries kept, per status. */
  counts: Record<TriggerDeliveryStatus, number>;
  total: number;
  lastDeliveryAt?: string;
  lastStatus?: TriggerDeliveryStatus;
}

export interface TriggerFileMeta {
  field: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
}

/** One received (or test) request, as recorded. */
export interface TriggerDelivery {
  id: string;
  triggerId: string;
  receivedAt: string;
  status: TriggerDeliveryStatus;
  /** What the sender was answered. */
  httpStatus: number;
  /** Why it was rejected / filtered / a duplicate (one line each). */
  reasons: string[];
  /** Contract errors (JSON Schema), one per line. */
  errors?: string[];
  /** Sent from the dashboard, the API or a tool, not by the sender. */
  test?: boolean;
  /** The source IP (as seen through the proxy). */
  ip?: string;
  /** How it authenticated. */
  auth?: { secret?: "header" | "bearer" | "query"; secretId?: string; hmac?: "current" | "previous"; /** How the signature matched when not by the spec (e.g. "signed with the secret as text"). */ hmacNote?: string };
  contentType?: string;
  kind?: TriggerContentType;
  bytes: number;
  /** Headers with secrets removed. */
  headers: Record<string, string>;
  /** The query string (a `token` removed). */
  query: Record<string, string | string[]>;
  /** The parsed body (keys that look secret redacted), capped. */
  body?: unknown;
  bodyTruncated?: boolean;
  files?: TriggerFileMeta[];
  /** The mapping's values. */
  mapped?: Record<string, unknown>;
  mappingErrors?: string[];
  /** The contract version it was checked against. */
  contractVersion: number;
  /** A hash of the dedupe key (never the key itself). */
  dedupeHash?: string;
  /** A duplicate: the original delivery. */
  duplicateOf?: string;
  /** rate_limited: refusals counted in this record (one record per minute). */
  count?: number;
  /** The actions' runs on this delivery (accepted ones; tests only when asked). */
  actions?: TriggerActionRun[];
  /** The actions as a whole. */
  actionsStatus?: TriggerActionsStatus;
  /** The member the actions ran for (the trigger's owner). */
  actionsRequestedBy?: string;
  /** Earlier runs (re-runs), newest first. */
  previousActions?: Array<{ endedAt?: string; status?: TriggerActionsStatus; runs: TriggerActionRun[] }>;
  /** It arrived while another trigger's actions ran (the loop guard's chain). */
  origin?: import("@polpo-ai/core").WorkOrigin;
}

/** A delivery in the list (no body, headers, files or mapped values). */
export type TriggerDeliverySummary = Omit<TriggerDelivery, "body" | "headers" | "query" | "files" | "mapped" | "previousActions" | "actions"> & {
  /** The runs without their outputs. */
  actions?: Array<Omit<TriggerActionRun, "outputs">>;
};

export interface TriggerDeliveryPage {
  deliveries: TriggerDeliverySummary[];
  nextCursor?: string;
  total: number;
  counts: Record<TriggerDeliveryStatus, number>;
}

/** The result of running a sample (or a stored delivery) through a contract, filter, dedupe and mapping without recording it. */
export interface TriggerDryRun {
  status: TriggerDeliveryStatus;
  reasons: string[];
  errors: string[];
  /** The filter held (or there is none). */
  filterMatched: boolean;
  /** The dedupe key's value (what would be remembered). */
  dedupeKey?: string;
  /** It would be a duplicate of this delivery now. */
  duplicateOf?: string;
  mapped?: Record<string, unknown>;
  mappingErrors?: string[];
  contractVersion: number;
}

export const emptyStatusCounts = (): Record<TriggerDeliveryStatus, number> => ({ accepted: 0, rejected: 0, filtered: 0, duplicate: 0, rate_limited: 0 });
