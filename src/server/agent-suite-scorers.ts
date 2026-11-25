/**
 * The host side of agent suite evals: the LLM judge (temperature 0, the suite's judge model or the
 * orchestrator's effective one), "explain this run" (the orchestrator's effective model) and custom
 * scorers run in the sandboxed code worker hosted MCP servers use (bubblewrap: no network, no
 * instance files, no secrets, a time and memory limit).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScorerDeps } from "@polpo-ai/core";
import type { ModelConfig } from "../core/types.js";
import { completeSimpleWithAuth, estimateCost, resolveModel, resolveModelSpec } from "../llm/pi-client.js";
import { requireOrchestratorModel } from "../llm/orchestrator-model.js";
import { queryOrchestratorText } from "../llm/query.js";
import { sharedCodeRunner } from "../mcp-servers/host.js";
import { DEFAULT_LIMITS } from "../mcp-servers/types.js";

const JUDGE_SYSTEM = "You are a strict, impartial evaluator. You answer with JSON only.";

/** The LLM judge: one completion at temperature 0. */
export function suiteJudge(configured: () => string | ModelConfig | undefined): NonNullable<ScorerDeps["judge"]> {
  return async ({ model, prompt }) => {
    const spec = resolveModelSpec(model ?? requireOrchestratorModel(configured()));
    if (!spec) throw new Error("No model for the LLM judge: set the suite's judge model or Polpo's model (Settings → Orchestrator)");
    const m = resolveModel(spec);
    const res = await completeSimpleWithAuth(m, {
      systemPrompt: JUDGE_SYSTEM,
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    }, { temperature: 0, maxTokens: Math.min(m.maxTokens || 4096, 4096) } as never);
    if (res.stopReason === "error" || res.stopReason === "aborted") throw new Error(res.errorMessage ?? "the judge's model failed");
    const text = res.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n").trim();
    let costUsd: number | undefined;
    try { costUsd = res.usage ? estimateCost(m, res.usage).totalCost : undefined; } catch { /* no pricing */ }
    return { text, model: spec, ...(costUsd !== undefined ? { costUsd } : {}) };
  };
}

/** "Explain this run" with the orchestrator's effective model. */
export function suiteReviewer(configured: () => string | ModelConfig | undefined): (prompt: string) => Promise<{ text: string; model?: string; costUsd?: number }> {
  return async (prompt) => {
    const model = requireOrchestratorModel(configured());
    const res = await queryOrchestratorText(prompt, model);
    return { text: res.text, model: res.usedSpec ?? resolveModelSpec(model), ...(res.costUsd !== undefined ? { costUsd: res.costUsd } : {}) };
  };
}

/**
 * The module a custom scorer runs as: its code is the body of an async function that gets
 * { reply, toolCalls, turns, costUsd, durationMs, message, row, expected } (an expression without
 * `return` is returned as is).
 */
export function customScorerModule(code: string): string {
  const body = /\breturn\b/.test(code) ? code : `return (${code.trim().replace(/;+\s*$/, "")});`;
  return [
    "export async function handler(input) {",
    "  const { reply, toolCalls, turns, costUsd, durationMs, message, row, expected } = input;",
    "  const score = async () => {",
    body,
    "  };",
    "  return await score();",
    "}",
    "",
  ].join("\n");
}

/** Custom scorers in the hosted MCP servers' sandboxed code worker (bubblewrap on Linux). */
export function sandboxedCustomScorer(): NonNullable<ScorerDeps["custom"]> {
  return async ({ code, input, timeoutMs }) => {
    const runner = sharedCodeRunner();
    if (!runner) throw new Error("Custom scorers need the sandboxed code worker (bubblewrap on Linux), which this server does not have");
    const hash = createHash("sha256").update(code).digest("hex").slice(0, 24);
    const buildDir = join(tmpdir(), "polpo-suite-scorers", hash);
    if (!existsSync(join(buildDir, "tools", "score.mjs"))) {
      mkdirSync(join(buildDir, "tools"), { recursive: true });
      writeFileSync(join(buildDir, "tools", "score.mjs"), customScorerModule(code));
      writeFileSync(join(buildDir, ".built.json"), JSON.stringify({ hash }));
    }
    const res = await runner.run({
      serverId: "suite-scorer", buildDir, workerKey: `suite-scorer@${hash}`,
      tool: { name: "score", description: "A suite's custom scorer", inputSchema: { type: "object" }, kind: "code" },
      input, secrets: {}, allowedDomains: [],
      limits: { ...DEFAULT_LIMITS, timeoutMs: timeoutMs ?? 5_000, memoryMb: 128, concurrency: 2, maxResponseBytes: 64 * 1024, retries: 0 },
    });
    if (!res.ok) throw new Error(res.error ?? res.text ?? "the custom scorer failed");
    return res.structured !== undefined ? res.structured : res.text;
  };
}
