/**
 * The ONLY module that touches the experimental AI SDK harness API (`@ai-sdk/harness`,
 * `@ai-sdk/harness-claude-code`, `@ai-sdk/harness-codex`, `@ai-sdk/harness-opencode`, `ai` 7),
 * pinned exactly in package.json.
 * It maps Polpo's HarnessRuntimeSpec to a HarnessAgent and the AI SDK stream parts to
 * HarnessEvents. Imported lazily (instances without harnesses never load the SDK).
 *
 * Authentication is always explicit: an authentication environment object (`auth`) makes the
 * adapters skip process.env, ~/.claude (settings, apiKeyHelper), the subscription lookup and
 * ~/.codex/auth.json on this server. The runtime process gets only what `env` says. OpenCode gets
 * an empty one (`auth: {}`: no environment lookup, no ~/.local/share/opencode/auth.json, no
 * subscription) and Polpo's own provider config (`openCodeConfig`) with the key or a placeholder.
 */
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createCodex } from "@ai-sdk/harness-codex";
import { createOpenCode } from "@ai-sdk/harness-opencode";
import { jsonSchema, tool, type ToolSet } from "ai";
import type {
  HarnessEvent, HarnessResumeState, HarnessRuntime, HarnessRuntimeSession, HarnessRuntimeSpec, HarnessSandbox, HarnessTurnResult, HarnessUsage,
} from "./types.js";

/** The first bridge port tried inside a VM (each session takes a free one; the sandbox session declares it). */
export const HARNESS_BRIDGE_PORT = 4000;

const ZERO: HarnessUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };

/**
 * AI SDK usage → ours. The stream's finish part carries the AI SDK usage (inputTokens,
 * outputTokens, totalTokens, inputTokenDetails.{cacheReadTokens, cacheWriteTokens}); the
 * provider-level shape ({ inputTokens: { total, cacheRead, cacheWrite }, outputTokens: { total } })
 * and the older cachedInputTokens are read too.
 */
export function mapUsage(u: any): HarnessUsage {
  if (!u || typeof u !== "object") return { ...ZERO };
  const n = (...xs: unknown[]): number => {
    for (const x of xs) {
      if (x === undefined || x === null) continue;
      const v = Number(x);
      if (Number.isFinite(v)) return v;
    }
    return 0;
  };
  const inObj = u.inputTokens && typeof u.inputTokens === "object" ? u.inputTokens : undefined;
  const outObj = u.outputTokens && typeof u.outputTokens === "object" ? u.outputTokens : undefined;
  const input = inObj ? n(inObj.total) : n(u.inputTokens);
  const output = outObj ? n(outObj.total) : n(u.outputTokens);
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: n(u.inputTokenDetails?.cacheReadTokens, inObj?.cacheRead, u.cachedInputTokens),
    cacheWriteTokens: n(u.inputTokenDetails?.cacheWriteTokens, inObj?.cacheWrite),
    totalTokens: n(u.totalTokens) || input + output,
  };
}

/** The runtime's metadata on a finish part: cumulative cost (Claude Code) and its conversation id. */
export function finishMetadata(part: any): { costUsd?: number; runtimeSessionId?: string } {
  const meta = part?.providerMetadata ?? part?.harnessMetadata ?? {};
  for (const key of ["claude-code", "codex"]) {
    const m = meta?.[key];
    if (m && typeof m === "object") {
      return {
        ...(typeof m.costUsd === "number" ? { costUsd: m.costUsd } : {}),
        ...(typeof m.sessionId === "string" ? { runtimeSessionId: m.sessionId } : typeof m.threadId === "string" ? { runtimeSessionId: m.threadId } : {}),
      };
    }
  }
  return {};
}

/**
 * OpenCode reports the cost of each model step (USD, from its model catalog's prices) on the
 * finish-step part (`opencode.cost`, the AI SDK's provider metadata). Not cumulative: a turn's cost
 * is the sum of its steps.
 */
export function stepCostUsd(part: any): number | undefined {
  const m = part?.providerMetadata?.opencode ?? part?.harnessMetadata?.opencode;
  const v = m && typeof m === "object" ? (m as { cost?: unknown }).cost : undefined;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Polpo's effort → OpenCode's reasoning variant (the variants every reasoning model has). */
export function openCodeReasoningVariant(effort: string | undefined): string | undefined {
  if (!effort) return undefined;
  return effort === "low" || effort === "medium" || effort === "high" ? effort : "high";
}

/**
 * Map one fullStream part. Text and reasoning deltas are collected by the caller (they arrive in
 * many small parts); everything else becomes at most one event.
 */
export function mapStreamPart(part: any, hostTools: ReadonlySet<string>): HarnessEvent | undefined {
  switch (part?.type) {
    case "tool-call":
      return { type: "tool-call", toolCallId: String(part.toolCallId ?? ""), toolName: String(part.toolName ?? ""), input: part.input, host: hostTools.has(part.toolName) };
    case "tool-result":
      return { type: "tool-result", toolCallId: String(part.toolCallId ?? ""), toolName: String(part.toolName ?? ""), output: part.output, isError: false };
    case "tool-error":
      return { type: "tool-result", toolCallId: String(part.toolCallId ?? ""), toolName: String(part.toolName ?? ""), output: errorText(part.error), isError: true };
    case "tool-output-denied":
      return { type: "tool-result", toolCallId: String(part.toolCallId ?? ""), toolName: String(part.toolName ?? ""), output: "denied", isError: true };
    case "tool-approval-request":
      return {
        type: "tool-approval-request", approvalId: String(part.approvalId ?? ""), toolCallId: String(part.toolCall?.toolCallId ?? part.toolCallId ?? ""),
        toolName: String(part.toolCall?.toolName ?? ""), input: part.toolCall?.input,
      };
    case "finish-step":
      return { type: "step-finish", ...(part.usage ? { usage: mapUsage(part.usage) } : {}) };
    case "error":
      return { type: "error", message: errorText(part.error) };
    default:
      return undefined;
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

// shared with the CLI engine (no AI SDK there)
export { HOST_TOOLS_EAGER_LIMIT, claudeCodeToolSearch } from "./tool-search.js";
import { claudeCodeToolSearch } from "./tool-search.js";

export function buildHarness(spec: HarnessRuntimeSpec): any {
  const debug = spec.onDebug ? (e: any) => { try { spec.onDebug!({ ...e, type: String(e?.type ?? "debug") }); } catch { /* never breaks the bridge */ } } : undefined;
  if (spec.harness === "claude-code") {
    // Host tools load with the first request (no ToolSearch round trip). The `alwaysLoad` hint
    // (MCP `_meta["anthropic/alwaysLoad"]`) alone is not honored by the pinned Claude Code (live:
    // register_outcome stayed in the deferred set), so tool search is turned off for a normal
    // tool set; the hint stays for when it is on.
    const toolHints = Object.fromEntries(spec.tools.map((t) => [t.name, { alwaysLoad: true, ...(t.readOnly ? { readOnly: true } : {}) }]));
    return createClaudeCode({
      auth: { ...spec.auth.auth },
      env: { ENABLE_TOOL_SEARCH: claudeCodeToolSearch(spec.tools.length), ...spec.auth.env },
      toolHints,
      // the agent's own MCP servers are Polpo connectors, offered as host tools: no .mcp.json in the repo
      strictMcpConfig: true,
      // non-Claude models behind a gateway: no adaptive thinking and no effort (they reject them)
      ...(spec.effort && !spec.auth.nonClaude ? { effort: spec.effort, thinking: { type: "adaptive" as const } } : { thinking: { type: "disabled" as const } }),
      ...(spec.maxTurns ? { maxTurns: spec.maxTurns } : {}),
      ...(spec.maxBudgetUsd ? { maxBudgetUsd: spec.maxBudgetUsd } : {}),
      startupTimeoutMs: 180_000,
      ...(debug ? { onDebug: debug } : {}),
    });
  }
  if (spec.harness === "opencode") {
    const variant = openCodeReasoningVariant(spec.effort);
    return createOpenCode({
      // an explicit, empty authentication environment: the adapter reads nothing on this server
      // (no process.env, no OpenCode auth.json, no subscription); the key is in openCodeConfig
      auth: {},
      ...(spec.auth.openCode?.provider ? { provider: spec.auth.openCode.provider } : {}),
      ...(spec.auth.openCodeConfig ? { openCodeConfig: structuredClone(spec.auth.openCodeConfig) } : {}),
      ...(variant ? { reasoningVariant: variant } : {}),
      startupTimeoutMs: 180_000,
    });
  }
  return createCodex({
    auth: { ...spec.auth.auth },
    ...(spec.effort ? { reasoningEffort: spec.effort } : {}),
    startupTimeoutMs: 180_000,
  });
}

/** Polpo host tools → AI SDK tools (executed here when the runtime calls them). */
function buildTools(spec: HarnessRuntimeSpec): ToolSet {
  const out: ToolSet = {};
  for (const t of spec.tools) {
    out[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema as any),
      execute: async (input: unknown, opts: { toolCallId: string; abortSignal?: AbortSignal }) =>
        t.execute(input, { toolCallId: opts.toolCallId, abortSignal: opts.abortSignal }),
    } as any);
  }
  return out;
}

class SdkSession implements HarnessRuntimeSession {
  /** Cumulative cost the runtime reported so far (Claude Code reports it per session). */
  private costSoFar?: number;

  constructor(
    private readonly agent: HarnessAgent<any, any>,
    private readonly session: any,
    private readonly hostTools: ReadonlySet<string>,
    initialCost?: number,
    private readonly perStepCost = false,
  ) {
    this.costSoFar = initialCost;
  }

  get sessionId(): string { return this.session.sessionId; }
  get workDir(): string {
    return typeof this.session.getSessionWorkDir === "function" ? this.session.getSessionWorkDir() : String(this.session.sessionWorkDir ?? "");
  }
  get isResume(): boolean { return !!this.session.isResume; }

  async turn(prompt: string, opts: { abortSignal?: AbortSignal; onEvent: (e: HarnessEvent) => void; onApproval?: (e: Extract<HarnessEvent, { type: "tool-approval-request" }>) => Promise<{ approved: boolean; reason?: string }> }): Promise<HarnessTurnResult> {
    let result = await this.agent.stream({ session: this.session, prompt, abortSignal: opts.abortSignal } as any);
    const usage: HarnessUsage = { ...ZERO };
    let text = "";
    let finishReason = "stop";
    let meta: { costUsd?: number; runtimeSessionId?: string } = {};
    let stepCosts: number | undefined;
    for (;;) {
      const approvals: Array<Extract<HarnessEvent, { type: "tool-approval-request" }>> = [];
      let textBuf = "";
      let reasoningBuf = "";
      const flush = () => {
        if (textBuf) { opts.onEvent({ type: "text", text: textBuf }); text += textBuf; textBuf = ""; }
        if (reasoningBuf) { opts.onEvent({ type: "reasoning", text: reasoningBuf }); reasoningBuf = ""; }
      };
      for await (const part of (result as any).fullStream as AsyncIterable<any>) {
        if (part.type === "text-delta") { textBuf += part.text ?? part.delta ?? ""; continue; }
        if (part.type === "reasoning-delta") { reasoningBuf += part.text ?? part.delta ?? ""; continue; }
        if (part.type === "text-end" || part.type === "reasoning-end") { flush(); continue; }
        if (part.type === "finish") {
          flush();
          const u = mapUsage(part.totalUsage);
          usage.inputTokens += u.inputTokens; usage.outputTokens += u.outputTokens;
          usage.cacheReadTokens += u.cacheReadTokens; usage.cacheWriteTokens += u.cacheWriteTokens; usage.totalTokens += u.totalTokens;
          finishReason = String(part.finishReason ?? "stop");
          meta = { ...meta, ...finishMetadata(part) };
          continue;
        }
        if (this.perStepCost && part.type === "finish-step") {
          const c = stepCostUsd(part);
          if (c !== undefined) stepCosts = (stepCosts ?? 0) + c;
        }
        const ev = mapStreamPart(part, this.hostTools);
        if (!ev) continue;
        flush();
        if (ev.type === "tool-approval-request") approvals.push(ev);
        opts.onEvent(ev);
      }
      flush();
      if (!approvals.length || opts.abortSignal?.aborted) break;
      // builtin tools the permission mode does not allow: answered, then the turn goes on
      const responses = [];
      for (const a of approvals) {
        const r = opts.onApproval ? await opts.onApproval(a) : { approved: false, reason: "Not allowed by this agent's permission mode" };
        responses.push({ type: "tool-approval-response" as const, approvalId: a.approvalId, approved: r.approved, ...(r.reason ? { reason: r.reason } : {}) });
      }
      result = await this.agent.continueStream({ session: this.session, toolApprovalContinuations: responses, abortSignal: opts.abortSignal } as any);
    }
    // Claude Code reports a cumulative cost per session: this turn's share is the difference.
    // OpenCode reports each step's cost: the turn's is their sum (the session total is kept too).
    let costUsd: number | undefined;
    if (this.perStepCost) {
      if (stepCosts !== undefined) {
        costUsd = stepCosts;
        this.costSoFar = (this.costSoFar ?? 0) + stepCosts;
      }
    } else if (typeof meta.costUsd === "number") {
      costUsd = this.costSoFar !== undefined && meta.costUsd >= this.costSoFar ? meta.costUsd - this.costSoFar : meta.costUsd;
      this.costSoFar = meta.costUsd;
    }
    return { text, finishReason, usage, ...(costUsd !== undefined ? { costUsd } : {}), ...(meta.runtimeSessionId ? { runtimeSessionId: meta.runtimeSessionId } : {}) };
  }

  /** The cumulative cost the runtime reported (kept with the resume state). */
  get cumulativeCostUsd(): number | undefined { return this.costSoFar; }

  async steer(text: string): Promise<void> {
    await this.agent.experimental_steer({ session: this.session, text });
  }

  async detach(): Promise<HarnessResumeState> {
    return withCost(await this.session.detach(), this.costSoFar);
  }

  async stop(): Promise<HarnessResumeState> {
    return withCost(await this.session.stop(), this.costSoFar);
  }

  async destroy(): Promise<void> {
    await this.session.destroy();
  }
}

/** Polpo keeps the cumulative cost next to the SDK's resume state (`polpoCostUsd`). */
function withCost(state: any, cost: number | undefined): HarnessResumeState {
  return { ...(state ?? {}), ...(cost !== undefined ? { polpoCostUsd: cost } : {}) };
}

function withoutCost(state: HarnessResumeState | undefined): { state?: any; cost?: number } {
  if (!state) return {};
  const { polpoCostUsd, ...rest } = state as Record<string, unknown>;
  return { state: rest, ...(typeof polpoCostUsd === "number" ? { cost: polpoCostUsd } : {}) };
}

/** The default runtime factory: a HarnessAgent for the spec. */
export function createSdkHarnessRuntime(spec: HarnessRuntimeSpec): HarnessRuntime {
  const toolApproval = Object.fromEntries(spec.tools.filter((t) => t.approval).map((t) => [t.name, t.approval!]));
  const agent = new HarnessAgent({
    harness: buildHarness(spec),
    id: spec.id,
    ...(spec.model ? { model: spec.model } : {}),
    instructions: spec.instructions,
    // gateway headers sent from the VM: only when they are not brokered (no relay reachable)
    ...(spec.auth.headers && Object.keys(spec.auth.headers).length ? { headers: { ...spec.auth.headers } } : {}),
    tools: buildTools(spec),
    skills: spec.skills.map((s) => ({ name: s.name, description: s.description, content: s.content, ...(s.files?.length ? { files: s.files } : {}) })),
    permissionMode: spec.permissionMode,
    ...(Object.keys(toolApproval).length ? { toolApproval } : {}),
    // the session works in the sandbox's working directory itself (the task's), not a subdirectory
    sandboxConfig: { workDir: "." },
  } as any);
  const hostTools = new Set(spec.tools.map((t) => t.name));
  return {
    harness: spec.harness,
    async createSession(o: { sessionId?: string; resumeFrom?: HarnessResumeState; sandbox: HarnessSandbox; abortSignal?: AbortSignal }) {
      const { state, cost } = withoutCost(o.resumeFrom);
      const session = await agent.createSession({
        ...(o.sessionId ? { sessionId: o.sessionId } : {}),
        ...(state ? { resumeFrom: state } : {}),
        sandboxSession: o.sandbox as any,
        ...(o.abortSignal ? { abortSignal: o.abortSignal } : {}),
      });
      return new SdkSession(agent, session, hostTools, cost, spec.harness === "opencode");
    },
  };
}
