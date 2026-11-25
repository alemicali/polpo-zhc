/**
 * `polpo bench` (and `polpo test --bench`) — run a benchmark from the terminal or CI
 * (docs/agent-suites.md, "Benchmarks").
 *
 *   polpo bench <file|id> [--yes] [--budget usd] [--allow-real-tools] [--weights quality=1,cost=0.5,latency=0]
 *                         [--json [file]] [--remote URL --token TOKEN] [--timeout s]
 *
 * <file> is a benchmark as JSON or YAML (run inline, not saved); <id> a saved benchmark. The cost
 * is estimated first: a benchmark that calls a real model runs only with --yes (it costs money).
 * It prints the leaderboard and the case × variant matrix, and exits 0 when it completed, 1 when it
 * was cancelled (the budget cap) or errored, 2 when it could not run.
 */
import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { benchmarkMatrixText, benchmarkRunText, type BenchmarkEstimate, type BenchmarkLeaderboard, type BenchmarkMatrix, type BenchmarkRun, type BenchmarkVariantStats } from "@polpo-ai/core/agent-suites";
import type { PolpoTestDeps, TestApi } from "./test.js";

export interface PolpoBenchOptions {
  /** A benchmark file (JSON or YAML) or a saved benchmark's id. */
  bench: string;
  yes?: boolean;
  budget?: string | number;
  allowRealTools?: boolean;
  weights?: string;
  json?: boolean | string;
  timeout?: string | number;
  /** Read a file (tests). */
  readFile?: (path: string) => string | undefined;
}

type Report = { run: BenchmarkRun; stats: BenchmarkVariantStats[]; leaderboard: BenchmarkLeaderboard; matrix: BenchmarkMatrix };

const enc = encodeURIComponent;

/** "quality=1,cost=0.5" → { quality: 1, cost: 0.5 } (undefined when empty or invalid). */
export function parseWeights(text: string | undefined): Record<string, number> | undefined {
  if (!text) return undefined;
  const out: Record<string, number> = {};
  for (const part of text.split(",")) {
    const [k, v] = part.split("=").map((x) => x.trim());
    if (!k || !["quality", "cost", "latency"].includes(k)) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return undefined;
    out[k] = n;
  }
  return Object.keys(out).length ? out : undefined;
}

function estimateLine(e: BenchmarkEstimate): string {
  return `Estimate: ${e.runs} run(s), ${e.cases} case run(s), ${e.realModelCases} on a real model · about $${e.costUsd.toFixed(4)} (up to $${e.maxCostUsd.toFixed(4)})${e.offline ? " · offline: free" : ""}${e.unknownPrice ? " · some model has no known price" : ""}`;
}

/** Run a benchmark and report; returns the exit code (0 completed, 1 cancelled or errored, 2 could not run). */
export async function runPolpoBench(opts: PolpoBenchOptions, deps: PolpoTestDeps): Promise<number> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const read = opts.readFile ?? ((p: string) => (existsSync(p) ? readFileSync(p, "utf-8") : undefined));
  const weights = parseWeights(opts.weights);
  if (opts.weights && !weights) { deps.error("--weights must look like quality=1,cost=0.5,latency=0"); return 2; }
  const budget = opts.budget !== undefined ? Number(opts.budget) : undefined;
  if (budget !== undefined && (!Number.isFinite(budget) || budget < 0)) { deps.error("--budget must be a number of USD ≥ 0"); return 2; }

  // a file (inline benchmark) or a saved benchmark's id
  let ref: { benchmarkId?: string; benchmark?: unknown };
  const text = /\.(json|ya?ml)$/i.test(opts.bench) || opts.bench.includes("/") ? read(opts.bench) : undefined;
  if (text !== undefined) {
    try { ref = { benchmark: opts.bench.toLowerCase().endsWith(".json") ? JSON.parse(text) : parseYaml(text) }; } catch (err) { deps.error(`${opts.bench}: ${(err as Error).message}`); return 2; }
  } else if (/\.(json|ya?ml)$/i.test(opts.bench)) {
    deps.error(`${opts.bench}: no such file`);
    return 2;
  } else ref = { benchmarkId: opts.bench };

  const est = await deps.api("POST", "/benchmarks/estimate", ref);
  if (!est.ok) { deps.error(`Could not estimate the benchmark: ${est.error ?? `HTTP ${est.status}`}`); return 2; }
  const estimate = est.data as BenchmarkEstimate;
  if (opts.json !== true) deps.log(estimateLine(estimate));
  if (!estimate.offline && !opts.yes) {
    deps.error("This benchmark calls real models and costs money: run again with --yes to accept the estimate (and --budget to cap it).");
    return 2;
  }
  const started = await deps.api("POST", "/benchmarks/runs", {
    ...ref, confirm: true, source: "cli", ...(budget !== undefined ? { budgetUsd: budget } : {}), ...(opts.allowRealTools ? { allowRealTools: true } : {}),
  });
  if (!started.ok) { deps.error(`Could not start the benchmark: ${started.error ?? `HTTP ${started.status}`}`); return 2; }
  const runId = (started.data as BenchmarkRun).id;
  if (opts.json !== true) deps.log(`… ${(started.data as BenchmarkRun).name} [${runId}]`);

  const until = Date.now() + Math.max(10, Number(opts.timeout ?? 3600)) * 1000;
  const q = weights ? `?${new URLSearchParams(Object.entries(weights).map(([k, v]) => [k, String(v)])).toString()}` : "";
  let report: Report;
  let lastLine = "";
  for (;;) {
    const g = await deps.api("GET", `/benchmark-runs/${enc(runId)}${q}`);
    if (!g.ok) { deps.error(`Could not read the benchmark: ${g.error ?? `HTTP ${g.status}`}`); return 2; }
    report = g.data as Report;
    const r = report.run;
    if (r.status !== "running" && r.status !== "queued") break;
    const line = `  ${r.progress.runsDone}/${r.progress.runsTotal} runs · ${r.progress.casesDone}/${r.progress.casesTotal} cases · $${r.spentUsd.toFixed(4)}`;
    if (line !== lastLine && opts.json !== true) { deps.log(line); lastLine = line; }
    if (Date.now() > until) {
      deps.error(`Timed out waiting for ${runId}: cancelling it`);
      await deps.api("POST", `/benchmark-runs/${enc(runId)}/cancel`);
      return 1;
    }
    await sleep(2000);
  }
  const exitCode = report.run.status === "completed" ? 0 : 1;
  const out = { ...report, exitCode };
  if (opts.json === true) deps.log(JSON.stringify(out, null, 2));
  else {
    deps.log(benchmarkRunText(report.run, report.leaderboard));
    deps.log(benchmarkMatrixText(report.matrix));
    if (typeof opts.json === "string") await deps.write(opts.json, JSON.stringify(out, null, 2));
  }
  return exitCode;
}

export function registerBenchCommand(program: Command, connect: (opts: { remote?: string; token?: string; dir?: string }) => Promise<{ api: TestApi; close?: () => Promise<void>; dashboard?: string }>): void {
  program
    .command("bench <benchmark>")
    .description("Run a benchmark (a file, JSON or YAML, or a saved benchmark's id): suites × variants × repetitions, compared. Prints the leaderboard and the case × variant matrix")
    .option("--yes", "Accept the cost estimate (needed when a real model is called)")
    .option("--budget <usd>", "Stop once it has spent this much")
    .option("--allow-real-tools", "Confirm runs that use real tools (needs an admin token remotely)")
    .option("--weights <list>", "The leaderboard's weights, e.g. quality=1,cost=0.5,latency=0")
    .option("--json [file]", "JSON report (stdout, or a file)")
    .option("--remote <url>", "Run on this instance (env POLPO_URL)")
    .option("--token <token>", "The instance's API key (env POLPO_TOKEN)")
    .option("--timeout <seconds>", "How long to wait", "3600")
    .option("-d, --dir <path>", "Working directory (local runs)", ".")
    .action(async (benchmark: string, opts: Omit<PolpoBenchOptions, "bench"> & { remote?: string; token?: string; dir?: string }) => {
      process.exit(await benchAction({ ...opts, bench: benchmark }, connect));
    });
}

/** Connect (remote or local), run, close; the exit code. */
export async function benchAction(opts: PolpoBenchOptions & { remote?: string; token?: string; dir?: string }, connect: (o: { remote?: string; token?: string; dir?: string }) => Promise<{ api: TestApi; close?: () => Promise<void> }>): Promise<number> {
  let close: (() => Promise<void>) | undefined;
  try {
    const c = await connect({ ...(opts.remote ? { remote: opts.remote } : {}), ...(opts.token ? { token: opts.token } : {}), ...(opts.dir ? { dir: opts.dir } : {}) });
    close = c.close;
    return await runPolpoBench(opts, {
      api: c.api,
      log: (l) => { if (opts.json === true) process.stdout.write(`${l}\n`); else console.log(l); },
      error: (l) => console.error(l),
      write: (file, t) => writeFile(file, t, "utf-8"),
    });
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  } finally {
    await close?.().catch(() => undefined);
  }
}
