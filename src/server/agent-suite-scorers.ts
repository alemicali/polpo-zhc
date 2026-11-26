/**
 * The host side of agent suite evals: custom scorers run in the sandboxed code worker hosted MCP
 * servers use (bubblewrap: no network, no instance files, no secrets, a time and memory limit).
 * The LLM judge and "explain this run" are suite roles: chat turns through the chat completions
 * pipeline (AgentSuiteRunner.playRole), never a model called from here.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScorerDeps } from "@polpo-ai/core";
import { sharedCodeRunner } from "../mcp-servers/host.js";
import { DEFAULT_LIMITS } from "../mcp-servers/types.js";

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
