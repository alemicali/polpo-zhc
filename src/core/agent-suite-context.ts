/**
 * Agent suite interception: the hooks a suite case installs on Polpo's real execution path.
 *
 * A case runs as an ordinary agent chat turn (the in-process chat completions pipeline, the same
 * one the agent's chats and the Tests tab's smoke run use) inside an AsyncLocalStorage context.
 * The pipeline's seams read that context:
 *
 *   streamLLM          model mock: the next scripted turn instead of the provider (no network);
 *                      otherwise the real stream, observed (text, tool calls, usage) for the trace,
 *                      and refused once a budget (turns, cost, time) is spent
 *   completeLLM        model mock: summaries and titles answered locally
 *   resolveAgentModel  model mock: a placeholder model when the agent's cannot be resolved offline
 *   tool executor      tool mocks: every tool call (native tools, Polpo's host tools, connector and
 *                      hosted MCP server tools) is matched against the case's mocks BEFORE it runs,
 *                      so a mocked call has no side effect; unmocked calls are blocked or run for real
 *   CLI tool server    the same for Polpo's tools served to the official claude / codex program
 *   resolveAgent       per-run overrides (model, reasoning, instructions, tools) for the variant;
 *                      a role's model + engine block as an ephemeral agent
 *   tools              a role turn (judge, simulated user, generator, reviewer) gets none
 *
 * Approvals are never answered here: a gated send or ask_user still stops the turn for a person
 * (recorded as "approval requested"), a hosted tool that needs approval is still queued.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ScriptedTurn, SuiteRoleName, SuiteVariantOverrides } from "@polpo-ai/core/agent-suites";

/** What the pipeline reports back to the running case. */
export interface SuiteCaseHooks {
  /** The case scripts the model (model mock). */
  readonly mocksModel: boolean;
  /** Per-run overrides applied to the agent (the variant). */
  readonly overrides?: SuiteVariantOverrides;
  /**
   * A suite role's turn (the judge, the simulated user, the generator, the reviewer), not a case:
   * the chat gets no tools (Polpo's or the agent's), only the role's prompt.
   */
  readonly role?: SuiteRoleName;
  /** A role played by a model + engine block: the ephemeral agent the chat resolves by this name. */
  readonly roleAgent?: { name: string } & Record<string, unknown>;
  /** Why the next model call must not happen (a budget is spent), or undefined. */
  budgetExceeded(): string | undefined;
  /** The next scripted turn; undefined when the script is over. */
  nextScriptedTurn(): ScriptedTurn | undefined;
  /** A model turn finished (scripted or real). */
  recordTurn(turn: { text: string; thinking?: string; toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>; mocked: boolean; model?: string; usage?: { inputTokens: number; outputTokens: number; costUsd: number }; durationMs: number; error?: string }): void;
  /** A tool call: answer it from a mock, a stub, a block, or `run` it for real. */
  toolCall(name: string, args: Record<string, unknown>, run: () => Promise<string>, callId?: string): Promise<string>;
}

const storage = new AsyncLocalStorage<SuiteCaseHooks>();

/** Run `fn` as a suite case: the pipeline's seams below see `hooks`. */
export function runAsSuiteCase<T>(hooks: SuiteCaseHooks, fn: () => Promise<T>): Promise<T> {
  return storage.run(hooks, fn);
}

/** The suite case running in this async context, if any. */
export function currentSuiteCase(): SuiteCaseHooks | undefined {
  return storage.getStore();
}

// ── Model ──

interface StreamEvent { type: string; delta?: string; error?: { errorMessage?: string } }
interface StreamLike extends AsyncIterable<StreamEvent> { result(): Promise<any> }

let scriptedCallSeq = 0;

/** An assistant message the completions pipeline accepts (pi-ai's AssistantMessage shape). */
function assistantMessage(model: any, turn: ScriptedTurn | undefined) {
  const content: any[] = [];
  if (turn?.thinking) content.push({ type: "thinking", thinking: turn.thinking });
  if (turn?.text) content.push({ type: "text", text: turn.text });
  for (const c of turn?.toolCalls ?? []) content.push({ type: "toolCall", id: c.id ?? `suite_call_${++scriptedCallSeq}`, name: c.name, arguments: c.args ?? {} });
  const input = turn?.usage?.inputTokens ?? 0, output = turn?.usage?.outputTokens ?? 0, cost = turn?.usage?.costUsd ?? 0;
  return {
    role: "assistant",
    content,
    api: model?.api ?? "suite-mock",
    provider: model?.provider ?? "suite-mock",
    model: model?.id ?? "suite-mock",
    usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } },
    stopReason: turn?.toolCalls?.length ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

/** A stream that plays one message (text deltas, then done). */
function playedStream(message: any): StreamLike {
  const text = message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  const thinking = message.content.filter((c: any) => c.type === "thinking").map((c: any) => c.thinking).join("");
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "start" };
      if (thinking) yield { type: "thinking_delta", delta: thinking };
      if (text) yield { type: "text_delta", delta: text };
      yield { type: "done" };
    },
    result: () => Promise.resolve(message),
  };
}

function toolCallsOf(message: any): Array<{ id: string; name: string; args: Record<string, unknown> }> {
  return (message?.content ?? []).filter((c: any) => c.type === "toolCall").map((c: any) => ({ id: c.id, name: c.name, args: c.arguments ?? {} }));
}

function usageOf(message: any): { inputTokens: number; outputTokens: number; costUsd: number } {
  const u = message?.usage ?? {};
  return {
    inputTokens: (Number(u.input) || 0) + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0),
    outputTokens: Number(u.output) || 0,
    costUsd: Number(u.cost?.total) || 0,
  };
}

/** Observe a real stream: pass events through, record the turn when its result is read. */
function observedStream(real: StreamLike, hooks: SuiteCaseHooks, model: any, t0: number): StreamLike {
  let thinking = "";
  let error: string | undefined;
  let recorded: Promise<any> | undefined;
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of real) {
        if (event.type === "thinking_delta") thinking += event.delta ?? "";
        else if (event.type === "error") error = event.error?.errorMessage ?? "Model returned an error";
        yield event;
      }
      if (error) hooks.recordTurn({ text: "", toolCalls: [], mocked: false, model: model?.id, durationMs: Date.now() - t0, error });
    },
    result: () => {
      recorded ??= real.result().then((message) => {
        const text = (message?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
        hooks.recordTurn({ text, ...(thinking ? { thinking } : {}), toolCalls: toolCallsOf(message), mocked: false, model: model?.id, usage: usageOf(message), durationMs: Date.now() - t0 });
        return message;
      });
      return recorded;
    },
  };
}

/** Wrap the pipeline's streamLLM: scripted turns under a model mock, observed real turns otherwise, nothing once a budget is spent. */
export function suiteStreamLLM<F extends (model: any, ctx: any, opts: any) => any>(real: F): F {
  return ((model: any, ctx: any, opts: any) => {
    const hooks = currentSuiteCase();
    if (!hooks) return real(model, ctx, opts);
    const over = hooks.budgetExceeded();
    // a spent budget ends the turn: an empty answer, no call to the provider
    if (over) return playedStream(assistantMessage(model, undefined));
    const t0 = Date.now();
    if (hooks.mocksModel) {
      const turn = hooks.nextScriptedTurn();
      const message = assistantMessage(model, turn);
      if (turn) hooks.recordTurn({ text: turn.text ?? "", ...(turn.thinking ? { thinking: turn.thinking } : {}), toolCalls: toolCallsOf(message), mocked: true, model: "scripted", usage: usageOf(message), durationMs: 0 });
      return playedStream(message);
    }
    const out = real(model, ctx, opts);
    const wrap = (s: StreamLike) => observedStream(s, hooks, model, t0);
    return (typeof out?.[Symbol.asyncIterator] === "function" ? wrap(out) : Promise.resolve(out).then(wrap)) as ReturnType<F>;
  }) as F;
}

/** Wrap completeLLM (summaries, titles): answered locally under a model mock. */
export function suiteCompleteLLM<F extends ((model: any, ctx: any, opts?: any) => Promise<any>) | undefined>(real: F): F {
  if (!real) return real;
  return (async (model: any, ctx: any, opts?: any) => {
    const hooks = currentSuiteCase();
    if (hooks?.mocksModel) return assistantMessage(model, { text: "Test conversation" });
    return real(model, ctx, opts);
  }) as F;
}

/** A model to hand the pipeline when the agent's cannot be resolved and the model is scripted anyway. */
export const SUITE_PLACEHOLDER_MODEL = {
  id: "suite-mock", name: "Scripted model (suite)", api: "suite-mock", provider: "suite-mock", baseUrl: "http://suite-mock.invalid",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8192,
};

// ── Tools ──

/** Wrap a tool executor: a suite case answers each call (mock, stub, block) or lets it run. */
export function suiteToolExecutor<F extends (name: string, args: Record<string, unknown>, ...rest: any[]) => Promise<string>>(executor: F): F {
  return ((name: string, args: Record<string, unknown>, ...rest: any[]) => {
    const hooks = currentSuiteCase();
    if (!hooks) return executor(name, args, ...rest);
    const callId = (rest[0] as { toolCallId?: string } | undefined)?.toolCallId;
    return hooks.toolCall(name, args ?? {}, () => executor(name, args, ...rest), callId);
  }) as F;
}

/**
 * For servers that outlive the call that opened them (the CLI engine's tool server): the hooks of
 * the case that opened it, captured now, used for every call it serves.
 */
export function captureSuiteToolHook(): ((name: string, args: Record<string, unknown>, run: () => Promise<string>, callId?: string) => Promise<string>) | undefined {
  const hooks = currentSuiteCase();
  return hooks ? (name, args, run, callId) => hooks.toolCall(name, args, run, callId) : undefined;
}

// ── Agent ──

/** The agent with the variant's overrides applied (this run only; nothing is saved). */
export function applySuiteOverrides<A extends Record<string, any>>(agent: A, overrides: SuiteVariantOverrides | undefined): A {
  if (!overrides) return agent;
  const out: Record<string, any> = { ...agent };
  if (overrides.model) out.model = overrides.model;
  if (overrides.reasoning) out.reasoning = overrides.reasoning;
  if (overrides.engine !== undefined) out.engine = overrides.engine;
  if (overrides.allowedTools) out.allowedTools = overrides.allowedTools;
  if (overrides.maxTurns) out.maxTurns = overrides.maxTurns;
  if (overrides.instructions !== undefined) out.systemPrompt = overrides.instructions;
  if (overrides.instructionsAppend) out.systemPrompt = `${out.systemPrompt ?? ""}\n\n${overrides.instructionsAppend}`.trim();
  return out as A;
}
