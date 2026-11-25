/**
 * `polpo bench` and `polpo test --bench`: a benchmark from a file (JSON, YAML) or a saved id, the
 * cost estimate (real models only with --yes), the budget cap and weights passed through, the
 * leaderboard and matrix printed, exit codes — against a fake API (no instance, no model).
 */
import { describe, expect, it } from "vitest";
import { parseWeights, runPolpoBench } from "../cli/commands/bench.js";
import type { TestApi } from "../cli/commands/test.js";

const report = (status: string) => ({
  run: {
    id: "br-1", name: "Models", status, ...(status === "cancelled" ? { stopReason: "budget" } : {}), startedAt: "2026-11-25T10:00:00Z", spec: { variants: [] },
    estimate: { costUsd: 0.12 }, spentUsd: 0.1, runs: [], progress: { runsDone: 2, runsTotal: 2, casesDone: 4, casesTotal: 4 }, notes: [],
  },
  stats: [],
  leaderboard: { weights: { quality: 1, cost: 0, latency: 0 }, qualityMetric: "score", paretoFront: ["a"], notes: ["\"A\" and \"B\": within the noise"],
    entries: [{ rank: 1, variantId: "a", label: "A", quality: 0.9, qualityStddev: 0.01, passRate: 1, costUsd: 0.05, latencyP50Ms: 1000, latencyP95Ms: 2000, composite: 0.9, pareto: true, flakiness: 0 }] },
  matrix: { variants: [{ id: "a", label: "A" }], rows: [{ key: "shop/q/x", suiteName: "Q", caseName: "X", cells: { a: { status: "passed", attempts: 1, passed: 1, score: 0.9 } }, spread: false }] },
});

function fakeApi(opts: { offline?: boolean; final?: string; polls?: number } = {}) {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  let polls = opts.polls ?? 1;
  const api: TestApi = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === "/benchmarks/estimate") return { ok: true, status: 200, data: { runs: 2, cases: 4, realModelCases: opts.offline ? 0 : 4, costUsd: opts.offline ? 0 : 0.12, maxCostUsd: opts.offline ? 0 : 0.18, offline: !!opts.offline, unknownPrice: false, realTools: false, cells: [], notes: [] } };
    if (path === "/benchmarks/runs") return { ok: true, status: 200, data: { id: "br-1", name: "Models", status: "running" } };
    if (path.startsWith("/benchmark-runs/br-1")) {
      if (polls-- > 0) return { ok: true, status: 200, data: report("running") };
      return { ok: true, status: 200, data: report(opts.final ?? "completed") };
    }
    return { ok: false, status: 404, error: `no route ${path}` };
  };
  return { api, calls };
}

function io() {
  const out: string[] = [], err: string[] = [];
  const files = new Map<string, string>();
  return { out, err, files, deps: { log: (l: string) => out.push(l), error: (l: string) => err.push(l), write: async (f: string, t: string) => { files.set(f, t); }, sleep: async () => undefined } };
}

describe("polpo bench", () => {
  it("a YAML file runs inline: estimate, run (confirmed with --yes, budget and source), the leaderboard and the matrix; exit 0", async () => {
    const { api, calls } = fakeApi();
    const x = io();
    const yaml = "name: Models\nsuites:\n  - { agent: shop, suite: q }\nvariants:\n  - { agent: shop }\n  - { agent: shop, overrides: { model: openai:gpt-x } }\n";
    const code = await runPolpoBench({ bench: "bench.yaml", yes: true, budget: "0.5", weights: "quality=1,cost=0", readFile: () => yaml }, { api, ...x.deps });
    expect(code).toBe(0);
    expect(calls[0]).toMatchObject({ path: "/benchmarks/estimate", body: { benchmark: { name: "Models", variants: [{ agent: "shop" }, { agent: "shop", overrides: { model: "openai:gpt-x" } }] } } });
    expect(calls[1]).toMatchObject({ path: "/benchmarks/runs", body: { confirm: true, source: "cli", budgetUsd: 0.5 } });
    expect(calls.find((c) => c.method === "GET")!.path).toBe("/benchmark-runs/br-1?quality=1&cost=0");
    const text = x.out.join("\n");
    expect(text).toContain("Estimate: 2 run(s)");
    expect(text).toContain("1. A ◆");
    expect(text).toContain("within the noise");
    expect(text).toContain("case × variant");
  });

  it("a real model without --yes does not run (exit 2); offline needs no --yes; a saved id; JSON output", async () => {
    const real = fakeApi();
    const x = io();
    expect(await runPolpoBench({ bench: "models" }, { api: real.api, ...x.deps })).toBe(2);
    expect(x.err.join(" ")).toContain("--yes");
    expect(real.calls.some((c) => c.path === "/benchmarks/runs")).toBe(false);
    expect(real.calls[0].body).toEqual({ benchmarkId: "models" });

    const off = fakeApi({ offline: true });
    const y = io();
    expect(await runPolpoBench({ bench: "models", json: true }, { api: off.api, ...y.deps })).toBe(0);
    expect(JSON.parse(y.out.join("\n"))).toMatchObject({ exitCode: 0, run: { id: "br-1" }, leaderboard: { paretoFront: ["a"] } });
  });

  it("exit 1 when stopped by the budget cap; exit 2 on bad options or a missing file", async () => {
    const { api } = fakeApi({ offline: true, final: "cancelled" });
    expect(await runPolpoBench({ bench: "m" }, { api, ...io().deps })).toBe(1);
    const x = io();
    expect(await runPolpoBench({ bench: "m", weights: "speed=1" }, { api, ...x.deps })).toBe(2);
    expect(await runPolpoBench({ bench: "m", budget: "-1" }, { api, ...io().deps })).toBe(2);
    expect(await runPolpoBench({ bench: "nope.json", readFile: () => undefined }, { api, ...io().deps })).toBe(2);
    expect(await runPolpoBench({ bench: "bad.json", readFile: () => "{" }, { api, ...io().deps })).toBe(2);
    expect(parseWeights("quality=1, latency=0.5")).toEqual({ quality: 1, latency: 0.5 });
  });
});
