/**
 * Polpo's own interface to agent harnesses. The AI SDK harness API (`@ai-sdk/harness*`, `ai` 7)
 * is experimental: only src/harness/sdk.ts imports it; everything else (the engine, the sandbox
 * bridge, tests) uses these types, so an SDK change stays in one file.
 */
import type { HarnessEffort, HarnessId, HarnessPermissionMode } from "@polpo-ai/core/harnesses";

/** Opaque, JSON-serializable resume state (contains a bridge private key: store it as a secret). */
export type HarnessResumeState = Record<string, unknown>;

export interface HarnessUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

/** One event of a harness turn, as Polpo maps it. */
export type HarnessEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown; host: boolean }
  | { type: "tool-result"; toolCallId: string; toolName: string; output: unknown; isError: boolean }
  | { type: "tool-approval-request"; approvalId: string; toolCallId: string; toolName: string; input: unknown }
  | { type: "step-finish"; usage?: HarnessUsage }
  | { type: "error"; message: string };

export interface HarnessTurnResult {
  text: string;
  finishReason: string;
  /** This turn's usage. */
  usage: HarnessUsage;
  /** The runtime's own spend estimate for this turn (USD), when it reports one (OpenCode: the sum of its per-step costs). */
  costUsd?: number;
  /** The runtime's conversation id (Claude Code session id, Codex thread id). */
  runtimeSessionId?: string;
}

/** A Polpo tool offered to the runtime and executed on this server. */
export interface HarnessHostTool {
  name: string;
  description: string;
  /** JSON Schema of the input (an object schema). */
  inputSchema: Record<string, unknown>;
  /** No side effects (the runtime may run it in parallel and in plan mode). */
  readOnly?: boolean;
  /** "user-approval": the turn pauses for a person; "denied": refused without running. */
  approval?: "user-approval" | "denied";
  execute(input: unknown, opts: { toolCallId: string; abortSignal?: AbortSignal }): Promise<unknown>;
}

export interface HarnessSkill { name: string; description: string; content: string }

/** Explicit authentication: what the runtime gets, never looked up from this server's env or files. */
export interface HarnessAuth {
  /** Authentication environment handed to the adapter (API keys), {} for none (Bedrock/Vertex use `env`). */
  auth: Record<string, string>;
  /** Extra environment for the runtime process (Bedrock/Vertex variables, IS_SANDBOX, model ids). */
  env: Record<string, string>;
  /** Secret values, scrubbed from transcripts and errors. */
  secrets: string[];
}

/** A matcher of the AI SDK's request transformations (`HarnessV1RequestTransformation`), copied here. */
export type RequestMatcher = { exact: string } | { startsWith: string } | { regex: string };
export interface RequestKeyValueMatcher { readonly key?: RequestMatcher; readonly value?: RequestMatcher }

/**
 * An outbound request transformation (structurally the AI SDK's `HarnessV1RequestTransformation`):
 * requests that match get `transform.headers` set outside the sandbox. In Polpo's rules a header
 * value "" removes the header (used to present a brokered key the way a gateway wants it).
 */
export interface RequestTransformation {
  readonly match: {
    readonly host: string;
    readonly path?: RequestMatcher;
    readonly method?: ReadonlyArray<string>;
    readonly queryString?: ReadonlyArray<RequestKeyValueMatcher>;
    readonly headers?: ReadonlyArray<RequestKeyValueMatcher>;
  };
  readonly transform: { readonly headers: Readonly<Record<string, string>> };
}

export interface HarnessRuntimeSpec {
  harness: HarnessId;
  /** Stable id for logs (the Polpo agent name). */
  id: string;
  model?: string;
  instructions: string;
  tools: HarnessHostTool[];
  skills: HarnessSkill[];
  permissionMode: HarnessPermissionMode;
  effort?: HarnessEffort;
  maxBudgetUsd?: number;
  maxTurns?: number;
  auth: HarnessAuth & {
    /** Extra model-request headers sent from the VM (only when they are not brokered). */
    headers?: Record<string, string>;
    /** Non-Claude models behind the Anthropic format: no adaptive thinking, no effort. */
    nonClaude?: boolean;
    /** OpenCode: its config for this run (provider section with the key or a placeholder, model). */
    openCodeConfig?: Record<string, unknown>;
    /** OpenCode: the model's provider id (amazon-bedrock, openai, polpo-gateway…). */
    openCode?: { provider: string };
  };
  /** Bridge diagnostics (reconnects, failures) for the run log. */
  onDebug?: (event: { type: string; [k: string]: unknown }) => void;
}

/**
 * A session's sandbox as the harness needs it (structurally an AI SDK
 * `HarnessV1NetworkSandboxSession`; see sandbox-session.ts).
 */
export type HarnessSandbox = Record<string, unknown> & { id: string; defaultWorkingDirectory: string; ports: readonly number[] };

export interface HarnessRuntimeSession {
  readonly sessionId: string;
  readonly workDir: string;
  readonly isResume: boolean;
  /** One prompt turn, events streamed to onEvent. Rejects on a runtime or connection failure. */
  turn(prompt: string, opts: {
    abortSignal?: AbortSignal;
    onEvent: (e: HarnessEvent) => void;
    /** A runtime tool its permission mode does not allow: approve or deny (default: deny). */
    onApproval?: (request: Extract<HarnessEvent, { type: "tool-approval-request" }>) => Promise<{ approved: boolean; reason?: string }>;
  }): Promise<HarnessTurnResult>;
  /** The cumulative cost the runtime reported for this session (USD), when it reports one. */
  readonly cumulativeCostUsd?: number;
  /** A message to the running turn (the runtime takes it at its next safe point). */
  steer(text: string): Promise<void>;
  /** Park it: the runtime keeps running in the sandbox; resume with the returned state. */
  detach(): Promise<HarnessResumeState>;
  /** Stop the runtime, keeping enough to resume the conversation later. */
  stop(): Promise<HarnessResumeState>;
  /** Stop and forget. */
  destroy(): Promise<void>;
}

export interface HarnessRuntime {
  readonly harness: HarnessId;
  createSession(opts: { sessionId?: string; resumeFrom?: HarnessResumeState; sandbox: HarnessSandbox; abortSignal?: AbortSignal }): Promise<HarnessRuntimeSession>;
}

export type HarnessRuntimeFactory = (spec: HarnessRuntimeSpec) => HarnessRuntime | Promise<HarnessRuntime>;
