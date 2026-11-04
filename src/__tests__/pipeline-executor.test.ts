import { describe, it, expect, vi } from "vitest";
import { evaluateCondition, ExpressionError } from "../core/pipeline/expression.js";
import { validateSchema } from "../core/pipeline/schema.js";
import {
  executePipeline,
  mergeContext,
  type LoopRunRequest,
  type LoopRunResult,
  type PipelineDeps,
  type PipelineEvent,
} from "../core/pipeline/executor.js";
import type { LoopConfig, Pipeline } from "../core/types.js";

describe("pipeline expressions", () => {
  const ctx = { ticket: { category: "billing", priority: 2, tags: ["a", "b"] }, flag: true };

  it("reads paths and compares values", () => {
    expect(evaluateCondition("context.ticket.category == 'billing'", ctx)).toBe(true);
    expect(evaluateCondition('context.ticket.category != "billing"', ctx)).toBe(false);
    expect(evaluateCondition("context.ticket.priority >= 2 && context.flag", ctx)).toBe(true);
    expect(evaluateCondition("context.ticket.tags[1] == 'b'", ctx)).toBe(true);
    expect(evaluateCondition("!(context.ticket.priority < 2) || false", ctx)).toBe(true);
  });

  it("treats missing values as null", () => {
    expect(evaluateCondition("context.missing.deep == null", ctx)).toBe(true);
    expect(evaluateCondition("context.ticket.category != null", ctx)).toBe(true);
    expect(evaluateCondition("context.missing != null", ctx)).toBe(false);
  });

  it("does not coerce types and only orders same-typed values", () => {
    expect(evaluateCondition("context.ticket.priority == '2'", ctx)).toBe(false);
    expect(evaluateCondition("context.ticket.category > 1", ctx)).toBe(false);
  });

  it("rejects anything but the context variable and never reads prototypes", () => {
    expect(() => evaluateCondition("process.exit(1)", ctx)).toThrow(ExpressionError);
    expect(() => evaluateCondition("context.ticket ==", ctx)).toThrow(ExpressionError);
    expect(evaluateCondition("context.constructor != null", ctx)).toBe(false);
    expect(evaluateCondition("context.ticket.category.length == 7", ctx)).toBe(false);
  });
});

describe("loop output schema", () => {
  const schema = {
    type: "object",
    properties: { category: { type: "string", enum: ["billing", "tech"] }, score: { type: "integer", minimum: 0 } },
    required: ["category"],
  };

  it("accepts valid output and reports precise errors", () => {
    expect(validateSchema({ category: "tech", score: 3 }, schema)).toEqual([]);
    expect(validateSchema({ score: -1 }, schema)).toEqual(["$.category: is required", "$.score: below minimum 0"]);
    expect(validateSchema({ category: "other" }, schema)[0]).toContain("must be one of");
    expect(validateSchema("text", schema)).toEqual(["$: expected object, got string"]);
  });
});

describe("mergeContext", () => {
  it("deep-merges objects and ignores prototype keys", () => {
    const target: Record<string, unknown> = { a: { x: 1 }, list: [1] };
    mergeContext(target, JSON.parse('{"a":{"y":2},"list":[2],"__proto__":{"polluted":true}}'));
    expect(target).toEqual({ a: { x: 1, y: 2 }, list: [2] });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

// ── Executor ──

type LoopImpl = (req: LoopRunRequest) => LoopRunResult | Promise<LoopRunResult>;

function makeDeps(impls: Record<string, LoopImpl>, human?: PipelineDeps["requestHuman"]) {
  const events: PipelineEvent[] = [];
  const calls: string[] = [];
  const deps: PipelineDeps = {
    runLoop: async (req) => {
      calls.push(`${req.loopName}#${req.attempt}`);
      return impls[req.loopName](req);
    },
    requestHuman: human ?? (async () => ({ approved: true })),
    onEvent: (e) => events.push(e),
  };
  return { deps, events, calls };
}

const supportLoops: Record<string, LoopConfig> = {
  triage: {
    stopWhen: { expression: "context.ticket.category != null" },
    output: { schema: { type: "object", required: ["category"] } },
  },
  resolve: {},
  refund: {},
};

const supportPipeline: Pipeline = {
  steps: [
    { loop: "triage" },
    {
      switch: {
        cases: [{ when: "context.ticket.category == 'billing'", steps: [{ human: "billing_approval" }, { loop: "refund" }] }],
        default: { steps: [{ loop: "resolve" }] },
      },
    },
  ],
};

describe("executePipeline", () => {
  it("runs loops in order and routes through a switch", async () => {
    const { deps, calls } = makeDeps({
      triage: () => ({ ok: true, contextPatch: { ticket: { category: "tech" } }, output: { category: "tech" } }),
      resolve: () => ({ ok: true }),
      refund: () => ({ ok: true }),
    });
    const result = await executePipeline(supportPipeline, supportLoops, deps);
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["triage#1", "resolve#1"]);
    expect(result.context).toMatchObject({ ticket: { category: "tech" }, outputs: { triage: { category: "tech" } } });
  });

  it("retries a loop with feedback until its output and stop condition are satisfied", async () => {
    const { deps, calls } = makeDeps({
      triage: (req) => req.attempt === 1
        ? { ok: true, output: { wrong: true } }
        : { ok: true, contextPatch: { ticket: { category: "billing" } }, output: { category: "billing" } },
      refund: () => ({ ok: true }),
      resolve: () => ({ ok: true }),
    });
    const requestHuman = vi.fn(async () => ({ approved: true, note: "ok" }));
    deps.requestHuman = requestHuman;
    const feedbacks: (string | undefined)[] = [];
    const runLoop = deps.runLoop;
    deps.runLoop = (req) => { feedbacks.push(req.feedback); return runLoop(req); };

    const result = await executePipeline(supportPipeline, supportLoops, deps);
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["triage#1", "triage#2", "refund#1"]);
    expect(feedbacks[1]).toContain("$.category: is required");
    expect(requestHuman).toHaveBeenCalledOnce();
    expect(result.context.human).toEqual({ billing_approval: { approved: true, note: "ok" } });
  });

  it("fails after the maximum number of attempts", async () => {
    const { deps, calls } = makeDeps({ triage: () => ({ ok: true, output: { category: "x" } }), resolve: () => ({ ok: true }), refund: () => ({ ok: true }) });
    deps.maxLoopAttempts = 2;
    const result = await executePipeline(supportPipeline, supportLoops, deps);
    expect(result.ok).toBe(false);
    expect(calls).toEqual(["triage#1", "triage#2"]);
    expect(result.error).toContain("stop condition");
  });

  it("stops when a human rejects", async () => {
    const { deps, calls } = makeDeps(
      {
        triage: () => ({ ok: true, contextPatch: { ticket: { category: "billing" } }, output: { category: "billing" } }),
        refund: () => ({ ok: true }),
        resolve: () => ({ ok: true }),
      },
      async () => ({ approved: false, note: "too expensive" }),
    );
    const result = await executePipeline(supportPipeline, supportLoops, deps);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("too expensive");
    expect(calls).toEqual(["triage#1"]);
  });

  it("fails immediately when a loop session fails", async () => {
    const { deps } = makeDeps({ triage: () => ({ ok: false, error: "max turns" }), resolve: () => ({ ok: true }), refund: () => ({ ok: true }) });
    const result = await executePipeline(supportPipeline, supportLoops, deps);
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain("max turns");
  });

  it("skips steps whose when guard is false", async () => {
    const { deps, calls, events } = makeDeps({ a: () => ({ ok: true }), b: () => ({ ok: true }) });
    const result = await executePipeline(
      { steps: [{ loop: "a", when: "context.run == true" }, { loop: "b" }] },
      { a: {}, b: {} },
      deps,
      { context: { run: false } },
    );
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["b#1"]);
    expect(events.some((e) => e.type === "step:skip" && e.name === "a")).toBe(true);
  });

  it("parallel join=any resolves on the first success and cancels the rest", async () => {
    let slowSignal: AbortSignal | undefined;
    const { deps } = makeDeps({
      fast: () => ({ ok: true, contextPatch: { winner: "fast" } }),
      slow: (req) => new Promise((resolve) => {
        slowSignal = req.signal;
        req.signal.addEventListener("abort", () => resolve({ ok: false, error: "killed" }));
      }),
    });
    const result = await executePipeline(
      { steps: [{ parallel: [{ loop: "slow" }, { loop: "fast" }], join: "any" }] },
      { fast: {}, slow: {} },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.context.winner).toBe("fast");
    expect(slowSignal?.aborted).toBe(true);
  });

  it("reports step paths that match the pipeline object, and cancelled branches", async () => {
    const { deps, events } = makeDeps({
      fast: () => ({ ok: true }),
      slow: (req) => new Promise((resolve) => req.signal.addEventListener("abort", () => resolve({ ok: false, error: "killed" }))),
      a: () => ({ ok: true }),
    });
    await executePipeline(
      { steps: [
        { parallel: [{ loop: "slow" }, { loop: "fast" }], join: "any" },
        { switch: { cases: [{ when: "false", steps: [{ loop: "a" }] }], default: { steps: [{ loop: "a" }] } } },
      ] },
      { fast: {}, slow: {}, a: {} },
      deps,
    );
    const seen = events.filter((e) => e.type !== "loop:attempt").map((e) => `${e.type} ${e.path}`);
    expect(seen).toContain("step:end steps.0.parallel.1");
    expect(seen).toContain("step:cancel steps.0.parallel.0");
    expect(seen).toContain("step:end steps.1.switch.default.steps.0");
    expect(seen).not.toContain("step:start steps.1.switch.cases.0.steps.0");
  });

  it("parallel join=all fails when one branch fails", async () => {
    const { deps } = makeDeps({ a: () => ({ ok: true }), b: () => ({ ok: false, error: "boom" }) });
    const result = await executePipeline({ steps: [{ parallel: [{ loop: "a" }, { loop: "b" }] }] }, { a: {}, b: {} }, deps);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom");
  });

  it("parallel numeric join needs that many successes", async () => {
    const { deps } = makeDeps({ a: () => ({ ok: true }), b: () => ({ ok: false, error: "no" }), c: () => ({ ok: true }) });
    const result = await executePipeline(
      { steps: [{ parallel: [{ loop: "a" }, { loop: "b" }, { loop: "c" }], join: 2 }] },
      { a: {}, b: {}, c: {} },
      deps,
    );
    expect(result.ok).toBe(true);
  });

  it("reports cancellation", async () => {
    const controller = new AbortController();
    const { deps } = makeDeps({
      a: () => { controller.abort(); return { ok: true }; },
      b: () => ({ ok: true }),
    });
    const result = await executePipeline({ steps: [{ loop: "a" }, { loop: "b" }] }, { a: {}, b: {} }, deps, { signal: controller.signal });
    expect(result).toMatchObject({ ok: false, error: "Pipeline cancelled" });
  });

  it("reports a malformed guard as a step failure", async () => {
    const { deps } = makeDeps({ a: () => ({ ok: true }) });
    const result = await executePipeline({ steps: [{ loop: "a", when: "context.x ==" }] }, { a: {} }, deps);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unexpected end of expression");
  });
});
