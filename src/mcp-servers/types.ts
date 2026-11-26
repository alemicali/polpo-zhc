/**
 * Custom MCP servers hosted by Polpo: the model.
 *
 * A server is a set of tools Polpo serves over MCP, built from an API (declarative HTTP tools,
 * executed in Polpo) or from code (a `handler(input, ctx)` run in a bubblewrap-isolated worker). It
 * is edited as a draft, published as immutable semver versions, and one version is deployed to
 * `production`. On first publish Polpo creates a connector bound to it, so agents and Polpo use it
 * like any connector; a public server is also reachable at POLPO_PUBLIC_URL/mcp/servers/<id>.
 *
 * Files (one folder per server, `.polpo/mcp-servers/<id>/`):
 *   server.json        meta (visibility, kill switch, publish policy, rate limits, connector id)
 *   draft.json         the working copy (spec + the version it started from)
 *   versions/<v>.json  published versions (immutable)
 *   deploys.json       the production pointer's history (deploy, rollback)
 *   tests.json         saved test cases
 *   logs.jsonl         call log (masked, capped)
 *   pending/<id>.json  calls waiting for a person's approval
 *   builds/<v>/        code tools: the module, package.json, lockfile and node_modules of a version
 *
 * Secrets are never stored here: a server names vault entries (owner / service / key) and the value
 * is read for one call only.
 *
 * The saved tests are also the server's suite (docs/agent-suites.md, "Hosted MCP servers"): its
 * settings (shared HTTP mocks, datasets, the deploy gate) live in server.json's `suite`.
 */
import type { HostedServerSuiteSettings, HostedServerTest } from "@polpo-ai/core/agent-suites";

/** Where a secret lives in the vault: an entry (owner + service) and one credential field. */
export interface McpSecretRef {
  owner: string;
  service: string;
  key: string;
}

/** How calls authenticate to the target service; `secret` is the name of one of the server's secrets. */
export type McpServerAuth =
  | { type: "none" }
  | { type: "bearer"; secret: string }
  | { type: "header"; header: string; secret: string; prefix?: string }
  | { type: "query"; param: string; secret: string }
  | { type: "basic"; usernameSecret: string; passwordSecret: string }
  | { type: "oauth2_client_credentials"; tokenUrl: string; clientIdSecret: string; clientSecretSecret: string; scopes?: string[] };

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A response mapping: what of the JSON the model sees. */
export interface HttpResponseMapping {
  /** JSONPath-ish pick: `result`, `$.data.items`, `items[0]`, `items[*].id`. Default: the whole body. */
  pick?: string;
  /** Keep only these fields of the picked object (or of each item of a picked list). Dotted paths allowed. */
  fields?: string[];
  /** Cut the text the model sees at this many characters (default: the server's maxResultChars). */
  maxChars?: number;
  /**
   * Keep only the items of the picked list that match (all rules): `path` in each item against the
   * tool input `input` (skipped when that input is not given) or a fixed `value`. Applied before `fields`.
   */
  filters?: HttpResponseFilter[];
  /** Page the picked list locally (APIs that return everything): { items, total, offset, limit, next_offset }. */
  page?: HttpResponsePage;
  /**
   * Summaries computed on the whole response (before pick), added to the result: e.g.
   * `{ colors: { path: "result.variants[*].color", op: "unique" } }` instead of dumping every variant.
   */
  aggregates?: Record<string, HttpResponseAggregate>;
}

export interface HttpResponseFilter {
  /** Path in each item (`color`, `options.size`). */
  path: string;
  /** The input property whose value it is compared with (the rule is skipped when it is not given). */
  input?: string;
  /** A fixed value (when no input). */
  value?: string | number | boolean;
  /** equals (default; case-insensitive for text), contains (case-insensitive), in (the input is a list), gte / lte (numbers). */
  match?: "equals" | "contains" | "in" | "gte" | "lte";
}

export interface HttpResponsePage {
  /** Input properties carrying the position and the size (default offset / limit). */
  offsetInput?: string;
  limitInput?: string;
  /** Default 20. */
  defaultLimit?: number;
  /** Default 100. */
  maxLimit?: number;
}

export interface HttpResponseAggregate {
  path: string;
  /** value: the value at the path as is (e.g. a total or the last page next to a picked list). */
  op: "count" | "unique" | "min" | "max" | "sum" | "value";
}

/** Pagination hints (said to the model in the tool description; the executor does not loop). */
export interface HttpPagination {
  style: "offset" | "cursor" | "page";
  /** Input parameter names that carry the position and size. */
  param?: string;
  sizeParam?: string;
  /** Where the next cursor / total is in the response. */
  nextPath?: string;
  totalPath?: string;
}

/** An error rule: the first that matches turns a failed response into this message. */
export interface HttpErrorMapping {
  /** A status (404), a class ("4xx", "5xx") or omitted (any failure). */
  status?: number | "4xx" | "5xx";
  /** Only when the body contains this text. */
  match?: string;
  message: string;
}

/** A declarative HTTP tool: one request built from the input, executed by Polpo. */
export interface HttpToolSpec {
  method: HttpMethod;
  /** Absolute, or relative to the server's baseUrl. `{{input.x}}` placeholders are URL-encoded. */
  url: string;
  /** Header templates (`{{input.x}}`, `{{secrets.NAME}}`). */
  headers?: Record<string, string>;
  /** Query templates; a parameter whose value renders empty (missing input) is left out. */
  query?: Record<string, string>;
  /**
   * The JSON body template: strings with placeholders are rendered; a string that is exactly one
   * placeholder (`"{{input.items}}"`) becomes that value as is (number, list, object). Keys whose
   * value is missing are left out. Omitted: no body.
   */
  body?: unknown;
  bodyType?: "json" | "form";
  response?: HttpResponseMapping;
  pagination?: HttpPagination;
  errors?: HttpErrorMapping[];
  /** Retries on 429 / 5xx (default: the server's limits.retries). Never for non-idempotent methods unless set. */
  retries?: number;
}

/** A code tool: an ES module exporting `handler(input, ctx)` (TypeScript types are stripped at publish). */
export interface CodeToolSpec {
  source: string;
}

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpServerTool {
  /** [a-zA-Z0-9_-]{1,64}: the MCP tool name. */
  name: string;
  title?: string;
  /** What the model reads: when to use it, what it returns. */
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
  /** A person approves every call (agents and Polpo get "queued for approval"). */
  requiresApproval?: boolean;
  /** Destructive / approval tools are not callable on the public endpoint unless this is true. */
  publicCallable?: boolean;
  kind: "http" | "code";
  http?: HttpToolSpec;
  code?: CodeToolSpec;
  /** An MCP Apps widget (`ui://…`) shown with the result: one of the server's resources. */
  uiResource?: string;
  /** The server's scoped defaults this tool gets (spec.scopes), e.g. ["store"] for store-scoped endpoints. */
  scopes?: string[];
}

/**
 * A non-secret setting of a server (a store id, a default currency): declared by the spec, the value
 * set at install and editable later (server settings, not versioned). Templates use `{{settings.key}}`.
 */
export interface McpServerSettingField {
  key: string;
  label: string;
  type: "string" | "number" | "enum" | "boolean";
  help?: string;
  required?: boolean;
  default?: string | number | boolean;
  /** enum: the allowed values. */
  options?: string[];
  /** string: a regular expression the whole value must match. */
  pattern?: string;
  /** number: bounds. */
  min?: number;
  max?: number;
}

export type McpServerSettingValues = Record<string, string | number | boolean>;

/** Defaults a group of tools gets (the tools list the scope in `scopes`). */
export interface McpServerScope {
  description?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

/** A static resource (text or an MCP Apps widget, `ui://<server>/<name>`). */
export interface McpServerResource {
  uri: string;
  name: string;
  description?: string;
  mimeType: string;
  text: string;
}

export interface McpServerLimits {
  /** Per call (ms). Default 30 000. */
  timeoutMs?: number;
  /** Most bytes read from a response (http) or returned by a handler (code). Default 2 MB. */
  maxResponseBytes?: number;
  /** What the model sees of a result (characters). Default 40 000. */
  maxResultChars?: number;
  /** Retries on 429 / 5xx for idempotent requests. Default 2. */
  retries?: number;
  /** Code tools: the worker's memory (MB). Default 256. */
  memoryMb?: number;
  /** Code tools: calls running at once. Default 4. */
  concurrency?: number;
  /** Code tools: the worker stops after this long without calls (ms). Default 5 min. */
  idleMs?: number;
  /** Code tools: most MB of installed npm dependencies. Default 100. */
  depsMaxMb?: number;
}

/** The versioned part of a server: what a draft edits and a version freezes. */
export interface McpServerSpec {
  name: string;
  description?: string;
  /** An emoji, or a simple-icons slug (e.g. "printful"). */
  icon?: string;
  /** Base for relative tool URLs. */
  baseUrl?: string;
  /** Hosts calls may reach (`api.example.com`, `*.example.com`). Secrets only ever go there. */
  allowedDomains: string[];
  /** Named vault references; tools and auth use them by name. */
  secrets: Record<string, McpSecretRef>;
  auth: McpServerAuth;
  /** Headers sent with every http call (templates). */
  headers?: Record<string, string>;
  /** Query parameters sent with every http call (templates; empty values are left out). */
  query?: Record<string, string>;
  /** Scoped defaults: headers / query added to the tools that list the scope (e.g. "store": X-PF-Store-Id). */
  scopes?: Record<string, McpServerScope>;
  /** Non-secret settings (their values live in the server's meta: McpServerMeta.settings). */
  settingsSchema?: McpServerSettingField[];
  limits?: McpServerLimits;
  /** Code tools' npm dependencies (name → version range), installed at publish with --ignore-scripts. */
  dependencies?: Record<string, string>;
  tools: McpServerTool[];
  resources?: McpServerResource[];
}

export type McpServerVisibility = "private" | "public";

/** Per-IP and global request limits of the public endpoint (requests per minute). */
export interface PublicRateLimits {
  perIpPerMinute: number;
  globalPerMinute: number;
}

/** The server's unversioned settings. */
export interface McpServerMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  visibility: McpServerVisibility;
  /** Kill switch: no call runs (private or public) while true. */
  disabled?: boolean;
  /** What publish does when a saved test fails. Default "warn". */
  onTestFailure?: "warn" | "block";
  rateLimits?: PublicRateLimits;
  /** The connector bound to it (created on first publish). */
  connectorId?: string;
  /** Created from a template (e.g. "printful"). */
  template?: string;
  /** The template revision production was published from. */
  templateRevision?: number;
  /** Values of the spec's settingsSchema (non-secret; set at install, editable later). */
  settings?: McpServerSettingValues;
  /** Agents the connector grants when it is created (install flow); afterwards the connector's own access rules. */
  installAccess?: { agents: string[] | "*" };
  /** The saved tests as a suite: shared HTTP mocks, datasets, the deploy gate (required before production). */
  suite?: HostedServerSuiteSettings;
}

export type McpServerBump = "major" | "minor" | "patch";

export interface McpServerFieldChange {
  field: string;
  kind: "added" | "removed" | "changed";
}

export interface McpServerVersion {
  version: string;
  spec: McpServerSpec;
  createdAt: string;
  author: string;
  note?: string;
  bump?: McpServerBump;
  changes: McpServerFieldChange[];
  /** Code tools: the recorded lockfile and installed size. */
  build?: { lockfile?: string; depsBytes?: number; builtAt: string };
  /** The saved tests' outcome at publish. */
  tests?: { passed: number; failed: number; skipped: number };
}

export interface McpServerDraft {
  spec: McpServerSpec;
  /** The version the draft started from (undefined: never published). */
  baseVersion?: string;
  /** The template revision the draft was made from (install / upgrade). */
  templateRevision?: number;
  updatedAt: string;
  updatedBy: string;
}

export type McpServerDeployAction = "deploy" | "rollback" | "initial";

export interface McpServerDeploy {
  id: string;
  from?: string;
  to: string;
  action: McpServerDeployAction;
  actor: string;
  note?: string;
  at: string;
  /**
   * The deploy gate (the server's suite with gate.required): pass, or an admin's override with a
   * reason; `runId` is the suite run (owner mcp-server:<id>).
   */
  gate?: { decision: "pass" | "override"; runId?: string; reason?: string; by?: string; failures?: string[] };
}

/**
 * A saved test case: one tool with sample input (and, as a suite case, more checks, HTTP mocks and
 * a mode: see HostedServerTest).
 */
export type McpServerTestCase = HostedServerTest;

/** Where a call came from (logs, rate limits, approval). */
export type McpCallSource = "private" | "public" | "test" | "approval";

export interface McpCallLog {
  at: string;
  tool: string;
  source: McpCallSource;
  version?: string;
  ok: boolean;
  ms: number;
  status?: number;
  error?: string;
  /** Public calls: the client address. */
  ip?: string;
  /** The approval request it waits for / ran under. */
  approvalId?: string;
}

/** The masked request a call made (test results). */
export interface MaskedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface McpToolCallResult {
  ok: boolean;
  /** What the model sees. */
  text: string;
  structured?: unknown;
  error?: string;
  status?: number;
  ms: number;
  request?: MaskedRequest;
  /** Raw response text (capped), for the Test section. */
  response?: string;
  attempts?: number;
  /** Queued for a person's approval instead of running. */
  pendingApproval?: { id: string; approvalId?: string };
}

/** A call waiting for approval. */
export interface PendingCall {
  id: string;
  serverId: string;
  tool: string;
  input: Record<string, unknown>;
  version?: string;
  requestedAt: string;
  requestedBy?: string;
  status: "pending" | "approved" | "rejected" | "done" | "failed";
  approvalId?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  result?: { ok: boolean; text: string; error?: string };
}

export const MCP_SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const MCP_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
export const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export const DEFAULT_LIMITS: Required<McpServerLimits> = {
  timeoutMs: 30_000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxResultChars: 40_000,
  retries: 2,
  memoryMb: 256,
  concurrency: 4,
  idleMs: 5 * 60_000,
  depsMaxMb: 100,
};

export const DEFAULT_RATE_LIMITS: PublicRateLimits = { perIpPerMinute: 30, globalPerMinute: 300 };

export function limitsOf(spec: Pick<McpServerSpec, "limits">): Required<McpServerLimits> {
  const out = { ...DEFAULT_LIMITS };
  for (const [k, v] of Object.entries(spec.limits ?? {})) if (typeof v === "number" && v > 0) (out as Record<string, number>)[k] = v;
  return out;
}

/** Destructive or approval tools: never run without a person (approval, explicit confirm). */
export function isSensitiveTool(tool: Pick<McpServerTool, "requiresApproval" | "annotations">): boolean {
  return !!tool.requiresApproval || !!tool.annotations?.destructiveHint;
}
