/**
 * Benchmarks and the Playground over MCP (agent suites phase 5; docs/agent-suites.md): save a
 * benchmark (suites × variants × repetitions), estimate and run it (a real model needs confirm:
 * true; real tools need polpo:admin), cancel it, read its leaderboard (weights, Pareto front, noise
 * notes), its case × variant matrix and one case side by side; compare variants on one message
 * headless (the Playground) and save an exchange as a test case; promote a variant into the
 * agent's draft (admin). The card (polpo_benchmark_show) lives in suite-cards.ts.
 */
import { z } from "zod";
import { benchmarkRunText, type BenchmarkCaseComparison, type BenchmarkEstimate, type BenchmarkLeaderboard, type BenchmarkMatrix, type BenchmarkRun, type BenchmarkVariantStats, type PlaygroundExchange, type PlaygroundPane } from "@polpo-ai/core/agent-suites";
import {
  DESTRUCTIVE, MAX_WAIT_SECONDS, READ, UPDATE, WRITE, apiError, apiGet, apiSend, dashboardLink, enc, fail, hasScope, looseObject, ok, qs, short, sleep,
  type McpDeps, type Register,
} from "./kit.js";

type Report = { run: BenchmarkRun; stats: BenchmarkVariantStats[]; leaderboard: BenchmarkLeaderboard; matrix: BenchmarkMatrix };

const overrides = z.object({
  model: z.string().optional(), reasoning: z.string().optional(), instructions: z.string().optional().describe("Replaces the agent's instructions"),
  instructionsAppend: z.string().optional().describe("Appended to the agent's instructions"), allowedTools: z.array(z.string()).optional(), maxTurns: z.number().int().positive().optional(),
}).optional();

const variant = z.object({
  agent: z.string().min(1).describe("Any agent (polpo_agents_list): the suites' cases run against it"),
  version: z.string().optional().describe("production (default), draft or a published version"),
  label: z.string().optional(), id: z.string().optional(), overrides,
});

const pane = z.object({
  label: z.string().optional(),
  variant: z.object({ agent: z.string().min(1), version: z.string().optional(), overrides }),
  mockTools: z.boolean().optional().describe("Answer tool calls with mocks (default true)"),
  mockModel: z.boolean().optional().describe("Script the model from mocks.model (offline, free)"),
  realTools: z.boolean().optional().describe("Calls no mock answers run for real (needs polpo:admin); off: blocked"),
  mocks: z.object({
    suite: z.object({ agent: z.string().optional(), suite: z.string(), caseId: z.string().optional() }).optional().describe("Use a suite's mocks (shared, and a case's)"),
    tools: z.array(looseObject).optional().describe("Inline tool mocks: [{ tool, when?, response | error }]"),
    model: looseObject.optional().describe("Scripted model turns: { turns: [{ text?, toolCalls? }] }"),
  }).optional(),
});

const usd = (n: number) => `$${n.toFixed(4)}`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

export function estimateText(e: BenchmarkEstimate): string {
  return [
    `Estimate: ${e.runs} run(s), ${e.cases} case run(s), ${e.realModelCases} on a real model · about ${usd(e.costUsd)} (up to ${usd(e.maxCostUsd)})${e.offline ? " · offline: free" : ""}${e.realTools ? " · uses REAL tools" : ""}`,
    ...e.cells.map((c) => `   ${c.owner}/${c.suite} × ${c.variantId}: ${c.cases} case(s)/rep, ${c.realModelCases} real-model, ${c.judgeCalls} judge call(s) · ${usd(c.costUsd)} (${c.basis}${c.model ? `, ${c.model}` : ""})`),
    ...e.notes.map((n) => `note: ${n}`),
  ].join("\n");
}

export function matrixText(m: BenchmarkMatrix, limit = 40): string {
  const mark: Record<string, string> = { passed: "✓", failed: "✗", mixed: "≈", errored: "‼", skipped: "–", missing: " " };
  const lines = [`case × variant (${m.variants.map((v) => v.label).join(" | ")}):`];
  for (const r of m.rows.slice(0, limit)) {
    lines.push(`${r.spread ? "≠" : " "} ${r.suiteName} · ${r.caseName}${r.row ? ` #${r.row}` : ""} [${r.key}]: ${m.variants.map((v) => {
      const c = r.cells[v.id];
      return `${mark[c?.status ?? "missing"]}${c && c.attempts > 1 ? ` ${c.passed}/${c.attempts}` : ""}${c?.score !== undefined ? ` ${c.score.toFixed(2)}` : ""}`;
    }).join(" | ")}`);
  }
  if (m.rows.length > limit) lines.push(`… ${m.rows.length - limit} more case(s)`);
  return lines.join("\n");
}

export function compareText(c: BenchmarkCaseComparison): string {
  const lines = [`${c.caseName} [${c.key}] side by side (diffs against ${c.reference}):`];
  for (const col of c.columns) {
    lines.push(`── ${col.label} [${col.variantId}] · ${col.status}${col.score !== undefined ? ` · score ${col.score.toFixed(2)}` : ""} · ${usd(col.costUsd)} · ${secs(col.durationMs)} · ${col.tokens.input + col.tokens.output} tokens · run ${col.runId}${col.repetition > 1 ? ` rep ${col.repetition}` : ""}`);
    for (const t of col.toolCalls) {
      lines.push(`   ${t.diff === "added" ? "+" : t.diff === "changed" ? "~" : "="} ${t.name} ${short(JSON.stringify(t.args), 200)}${t.argChanges?.length ? ` (changed: ${t.argChanges.join(", ")})` : ""}${t.mocked ? ` [${t.mocked}]` : ""} → ${t.isError ? "ERROR " : ""}${short(t.result, 160)}`);
    }
    for (const m of col.missingCalls) lines.push(`   - ${m} (the reference called it)`);
    if (col.textDiff) lines.push(`   answer: ${short(col.textDiff.map((s) => (s.op === "same" ? s.text : s.op === "add" ? `{+${s.text}+}` : `[-${s.text}-]`)).join(""), 1500)}`);
    else lines.push(`   answer: ${short(col.finalText, 1500) || "—"}`);
  }
  return lines.join("\n");
}

function exchangesText(panes: PlaygroundPane[], exchanges: Record<string, PlaygroundExchange>): string {
  return panes.map((p) => {
    const x = exchanges[p.id];
    const head = `── ${p.label ?? p.id} · ${p.variant.agent}@${p.variant.version}${p.variant.overrides ? ` ${short(JSON.stringify(p.variant.overrides), 120)}` : ""} · ${p.mockModel ? "scripted model" : "real model"}, tools ${p.mockTools ? "mocked" : "not mocked"}${p.realTools ? " (unmocked run for real)" : " (unmocked blocked)"}`;
    if (!x) return head;
    return [
      `${head} · ${x.status} · ${usd(x.costUsd)} · ${secs(x.durationMs)} · ${x.tokens.input + x.tokens.output} tokens`,
      ...x.trace.toolCalls.map((t) => `   ${t.name} ${short(JSON.stringify(t.args), 160)} [${t.mocked || "real"}] → ${t.isError ? "ERROR " : ""}${short(t.result, 160)}`),
      x.error ? `   error: ${x.error}` : `   reply: ${short(x.trace.text, 1500) || "—"}`,
    ].join("\n");
  }).join("\n");
}

export function registerBenchmarkTools(tool: Register, deps: McpDeps): void {
  const isAdmin = () => !deps.principal || hasScope(deps.principal, "polpo:admin");
  const link = (runId?: string) => dashboardLink(deps, runId ? `/benchmarks?run=${enc(runId)}` : "/benchmarks");

  tool("team", "polpo_benchmark_save", {
    title: "Save a benchmark",
    description: "Create or replace a benchmark: one or more suites (or the cases of one dataset) × variants × repetitions. benchmark: { name, suites: [{ agent (the suite's agent), suite, caseIds?, dataset? }], "
      + "variants: [{ agent (any agent), version?: production | draft | 1.2.0, label?, overrides?: { model, reasoning, instructions | instructionsAppend, allowedTools, maxTurns } }] (1–8), repetitions? (1–10), "
      + "mode?: all (offline, free) | tools | model | none, concurrency? (1–4 cases at once per run), budgetUsd? (stop once spent), weights?: { quality, cost, latency } (the leaderboard) }. "
      + "With an id it replaces that benchmark. Run it with polpo_benchmark_run.",
    inputSchema: {
      benchmark: looseObject.describe("The benchmark (see the description)"),
      revision: z.number().int().optional().describe("The revision you edited (refused if it changed meanwhile)"),
    },
    outputSchema: { benchmark: looseObject },
    annotations: WRITE,
    scope: "polpo:work",
  }, async ({ benchmark, revision }) => {
    const id = typeof benchmark.id === "string" ? benchmark.id : undefined;
    const body = { ...benchmark, ...(revision !== undefined ? { revision } : {}) };
    const r = id ? await apiSend(deps, "PUT", `/benchmarks/${enc(id)}`, body) : await apiSend(deps, "POST", "/benchmarks", body);
    if (!r.ok) return apiError(r, "Saving the benchmark");
    const b = r.data as { id: string; name: string; revision: number; suites: unknown[]; variants: Array<{ id: string }>; repetitions: number };
    return ok(`Saved ${b.name} [${b.id}] rev ${b.revision}: ${b.suites.length} suite(s) × ${b.variants.length} variant(s) (${b.variants.map((v) => v.id).join(", ")}) × ${b.repetitions} repetition(s). Run it with polpo_benchmark_run. ${link()}`,
      { benchmark: b as unknown as Record<string, unknown> });
  });

  tool("team", "polpo_benchmark_delete", {
    title: "Delete a benchmark",
    description: "Delete a saved benchmark (its past runs stay).",
    inputSchema: { benchmark: z.string().min(1).describe("The benchmark's id (polpo_benchmark_get)") },
    outputSchema: { deleted: z.string() },
    annotations: DESTRUCTIVE,
    scope: "polpo:work",
  }, async ({ benchmark }) => {
    const r = await apiSend(deps, "DELETE", `/benchmarks/${enc(benchmark)}`);
    if (!r.ok) return apiError(r, `Deleting ${benchmark}`);
    return ok(`Deleted the benchmark ${benchmark}.`, { deleted: benchmark });
  });

  tool("team", "polpo_benchmark_run", {
    title: "Run a benchmark",
    description: "Run a benchmark (a saved one, or `inline`) or only estimate it. Every suite × variant × repetition is a suite run (two at a time on the instance; the others wait). "
      + "Real models cost money: without confirm: true a benchmark that calls one returns its cost ESTIMATE and does not start — show it to the person and run again with confirm: true when they agree. "
      + "A budget cap (budget_usd, or the benchmark's budgetUsd) stops it once spent. Real tools need polpo:admin. Waits up to wait_seconds (default 50) and returns the leaderboard; "
      + "a benchmark still going is returned running (polpo_benchmark_get with run). cancel: a benchmark run id to stop instead.",
    inputSchema: {
      benchmark: z.string().optional().describe("A saved benchmark's id"),
      inline: looseObject.optional().describe("Or a benchmark not saved: { name, suites, variants, repetitions?, mode? } (as in polpo_benchmark_save)"),
      confirm: z.boolean().optional().describe("The person saw the estimate and accepted the cost"),
      estimate_only: z.boolean().optional().describe("Only estimate the cost (nothing runs)"),
      budget_usd: z.number().min(0).optional().describe("Stop once it has spent this much (USD)"),
      wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().describe("How long to wait for it (default 50 s)"),
      cancel: z.string().optional().describe("Stop this benchmark run (br-…) instead"),
    },
    outputSchema: { run: looseObject.optional(), estimate: looseObject.optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    scope: "polpo:work",
  }, async ({ benchmark, inline, confirm, estimate_only, budget_usd, wait_seconds, cancel }, extra) => {
    if (cancel) {
      const c = await apiSend(deps, "POST", `/benchmark-runs/${enc(cancel)}/cancel`);
      if (!c.ok) return apiError(c, "Cancelling the benchmark");
      return ok(benchmarkRunText(c.data as BenchmarkRun), { run: c.data as Record<string, unknown> });
    }
    if (!benchmark && !inline) return fail("Give benchmark (a saved one's id) or inline (a benchmark object).");
    const ref = benchmark ? { benchmarkId: benchmark } : { benchmark: inline };
    const est = await apiSend(deps, "POST", "/benchmarks/estimate", ref);
    if (!est.ok) return apiError(est, "Estimating the benchmark");
    const estimate = est.data as BenchmarkEstimate;
    if (estimate_only) return ok(estimateText(estimate), { estimate: estimate as unknown as Record<string, unknown> });
    if (!estimate.offline && !confirm) {
      return ok(`${estimateText(estimate)}\nNot started: this benchmark calls real models. Show the person the estimate; when they agree, run it again with confirm: true${budget_usd === undefined ? " (and a budget_usd cap if they want one)" : ""}.`,
        { estimate: estimate as unknown as Record<string, unknown> });
    }
    const r = await apiSend(deps, "POST", "/benchmarks/runs", { ...ref, confirm: true, source: "mcp", ...(budget_usd !== undefined ? { budgetUsd: budget_usd } : {}), ...(isAdmin() ? { allowRealTools: true } : {}) });
    if (!r.ok) {
      if (r.status === 403) return fail(`${r.error}${isAdmin() ? "" : " This connection does not have the admin scope (polpo:admin)."}`);
      return apiError(r, "Starting the benchmark");
    }
    let run = r.data as BenchmarkRun;
    const until = Date.now() + (wait_seconds ?? 50) * 1000;
    while ((run.status === "running" || run.status === "queued") && Date.now() < until && !extra?.signal?.aborted) {
      await sleep(1000, extra?.signal);
      const g = await apiGet(deps, `/benchmark-runs/${enc(run.id)}`);
      if (g.ok) run = (g.data as Report).run;
    }
    const still = run.status === "running" || run.status === "queued";
    const rep = still ? undefined : await apiGet(deps, `/benchmark-runs/${enc(run.id)}`);
    const report = rep?.ok ? rep.data as Report : undefined;
    return ok(`${benchmarkRunText(run, report?.leaderboard)}${report ? `\n${matrixText(report.matrix, 20)}` : ""}${still ? `\nStill running: polpo_benchmark_get with run "${run.id}".` : ""}\n${link(run.id)}`,
      { run: run as unknown as Record<string, unknown>, estimate: estimate as unknown as Record<string, unknown> });
  });

  tool("team", "polpo_benchmark_get", {
    title: "Read benchmarks",
    description: "Without run: the saved benchmarks and the recent benchmark runs (status, progress, spent). With run: its report — per variant the pass rate and score (mean ± stddev over repetitions), cost, "
      + "latency p50 / p95, tokens and flakiness; the leaderboard with the Pareto front and notes on differences within noise; the case × variant matrix. polpo_benchmark_show draws it as a card.",
    inputSchema: {
      run: z.string().optional().describe("A benchmark run id (br-…)"),
      benchmark: z.string().optional().describe("Only this benchmark's runs"),
    },
    outputSchema: { benchmarks: z.array(looseObject).optional(), runs: z.array(looseObject).optional(), report: looseObject.optional() },
    annotations: READ,
  }, async ({ run, benchmark }) => {
    if (run) {
      const r = await apiGet(deps, `/benchmark-runs/${enc(run)}`);
      if (!r.ok) return apiError(r, "Reading the benchmark run");
      const rep = r.data as Report;
      const variants = rep.stats.map((s) => `   ${s.label} [${s.variantId}] ${s.agent}@${s.version}: pass ${pct(s.passRate.mean)} ± ${pct(s.passRate.stddev)}${s.score ? ` · score ${s.score.mean.toFixed(2)} ± ${s.score.stddev.toFixed(2)}` : ""}`
        + `${s.scorers.length ? ` · ${s.scorers.map((x) => `${x.id} ${x.mean.toFixed(2)}`).join(", ")}` : ""} · ${usd(s.costUsd.mean)}/rep · p50 ${secs(s.latency.p50Ms)} · p95 ${secs(s.latency.p95Ms)} · ${s.tokens.perCase} tokens/case${s.flakiness ? ` · flaky ${pct(s.flakiness)}` : ""}`);
      return ok([benchmarkRunText(rep.run, rep.leaderboard), "Variants:", ...variants, matrixText(rep.matrix), link(run)].join("\n"), { report: rep as unknown as Record<string, unknown> });
    }
    const [defs, runs] = await Promise.all([apiGet(deps, "/benchmarks"), apiGet(deps, `/benchmark-runs${qs({ benchmark, limit: "20" })}`)]);
    if (!defs.ok) return apiError(defs, "Reading the benchmarks");
    const list = defs.data as Array<{ id: string; name: string; suites: unknown[]; variants: unknown[]; repetitions: number }>;
    const rs = runs.ok ? runs.data as BenchmarkRun[] : [];
    const lines = [
      list.length ? "Benchmarks:" : "No saved benchmarks yet (polpo_benchmark_save).",
      ...list.map((b) => `   ${b.name} [${b.id}] · ${b.suites.length} suite(s) × ${b.variants.length} variant(s) × ${b.repetitions}`),
      rs.length ? "Runs:" : "No benchmark runs yet.",
      ...rs.map((r) => `   ${r.name} [${r.id}] · ${r.status}${r.stopReason ? ` (${r.stopReason})` : ""} · ${r.progress.runsDone}/${r.progress.runsTotal} · ${usd(r.spentUsd)} · ${r.startedAt.slice(0, 16).replace("T", " ")}${r.leaderboard?.entries[0] ? ` · best: ${r.leaderboard.entries[0].label}` : ""}`),
    ];
    return ok(lines.join("\n"), { benchmarks: list as unknown as Array<Record<string, unknown>>, runs: rs as unknown as Array<Record<string, unknown>> });
  });

  tool("team", "polpo_benchmark_leaderboard", {
    title: "A benchmark's leaderboard",
    description: "Rank a benchmark run's variants with weights: quality (score, else pass rate) versus cost versus latency (each ≥ 0; default the benchmark's, 0.7 / 0.2 / 0.1). Marks the Pareto front (◆) and says when variants differ by less than the noise.",
    inputSchema: {
      run: z.string().min(1).describe("A benchmark run id (br-…)"),
      quality: z.number().min(0).optional().describe("Weight of quality (score, else pass rate)"),
      cost: z.number().min(0).optional().describe("Weight of cost (cheaper ranks higher)"),
      latency: z.number().min(0).optional().describe("Weight of latency p50 (faster ranks higher)"),
    },
    outputSchema: { leaderboard: looseObject },
    annotations: READ,
  }, async ({ run, quality, cost, latency }) => {
    const r = await apiGet(deps, `/benchmark-runs/${enc(run)}/leaderboard${qs({ quality, cost, latency })}`);
    if (!r.ok) return apiError(r, "Reading the leaderboard");
    const lb = r.data as BenchmarkLeaderboard;
    const g = await apiGet(deps, `/benchmark-runs/${enc(run)}`);
    const text = g.ok ? benchmarkRunText((g.data as Report).run, lb) : JSON.stringify(lb.entries);
    return ok(text, { leaderboard: lb as unknown as Record<string, unknown> });
  });

  tool("team", "polpo_benchmark_compare", {
    title: "Compare a case across variants",
    description: "One case of a benchmark run side by side for 2–4 variants: each one's status, score, cost, latency and tokens, its tool calls aligned with the first variant's (= same, ~ other arguments, + extra, - missing) and its final answer diffed word by word ({+added+} [-removed-]). "
      + "case: the matrix key (agent/suite/case, from polpo_benchmark_get) or the case id.",
    inputSchema: {
      run: z.string().min(1).describe("A benchmark run id (br-…)"),
      case: z.string().min(1).describe("The case: its matrix key or id"),
      variants: z.array(z.string()).max(4).optional().describe("2–4 variant ids (default: the first four)"),
      repetition: z.number().int().min(1).optional().describe("Which repetition (default the first with a result)"),
    },
    outputSchema: { comparison: looseObject },
    annotations: READ,
  }, async ({ run, case: caseKey, variants, repetition }) => {
    const r = await apiGet(deps, `/benchmark-runs/${enc(run)}/compare${qs({ case: caseKey, variants: variants?.join(","), repetition })}`);
    if (!r.ok) return apiError(r, "Comparing the case");
    const cmp = r.data as BenchmarkCaseComparison;
    // the full results stay out of the structured content (large): the text has what matters
    const slim = { ...cmp, columns: cmp.columns.map(({ result: _r, ...c }) => c) };
    return ok(compareText(cmp), { comparison: slim as unknown as Record<string, unknown> });
  });

  tool("team", "polpo_playground_send", {
    title: "Compare variants on a message (Playground)",
    description: "Send one message to 1–4 variants at once and compare their replies headless — each pane: { variant: { agent, version?, overrides? }, mockTools? (default true), mockModel?, realTools? (polpo:admin), "
      + "mocks?: { suite: { agent?, suite, caseId? } (a suite's mocks), tools: [{ tool, response | error }], model: { turns } } }. Each answer is a test chat (deleted afterwards): its reply, tool calls (mocked, blocked or real), cost, latency and tokens. "
      + "save_case: { pane (its index from 0, or id), agent, suite, name?, mock_model? } also saves that pane's exchange as a test case of the suite (observed tool calls as mocks and checks).",
    inputSchema: {
      panes: z.array(pane).min(1).max(4).describe("1–4 panes, each a variant with its mocks"),
      message: z.string().min(1).max(50_000).describe("The message every pane gets"),
      save_case: z.object({ pane: z.union([z.number().int().min(0), z.string()]), agent: z.string(), suite: z.string(), name: z.string().optional(), mock_model: z.boolean().optional() }).optional()
        .describe("Save that pane's exchange as a test case of the suite (mock_model: also script the model turns)"),
    },
    outputSchema: { panes: z.array(looseObject), exchanges: looseObject, case: looseObject.optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    scope: "polpo:work",
  }, async ({ panes, message, save_case }) => {
    if (panes.some((p) => p.realTools) && !isAdmin()) return fail("A pane with realTools runs real tools (side effects possible): it needs the admin scope (polpo:admin). Turn realTools off to keep tools mocked or blocked.");
    const created = await apiSend(deps, "POST", "/playground/sessions", { panes });
    if (!created.ok) return apiError(created, "Opening the Playground");
    const session = created.data as { id: string; panes: PlaygroundPane[] };
    try {
      const sent = await apiSend(deps, "POST", `/playground/sessions/${enc(session.id)}/send`, { message, ...(isAdmin() ? { allowRealTools: true } : {}) });
      if (!sent.ok) return apiError(sent, "Sending the message");
      const { exchanges } = sent.data as { exchanges: Record<string, PlaygroundExchange> };
      let saved: Record<string, unknown> | undefined;
      let savedLine = "";
      if (save_case) {
        const paneId = typeof save_case.pane === "number" ? session.panes[save_case.pane]?.id : save_case.pane;
        if (!paneId) return fail(`There is no pane ${save_case.pane}`);
        const c = await apiSend(deps, "POST", `/playground/sessions/${enc(session.id)}/case`, {
          paneId, save: { agent: save_case.agent, suite: save_case.suite }, ...(save_case.name ? { name: save_case.name } : {}), ...(save_case.mock_model ? { mockModel: true } : {}),
        });
        if (!c.ok) return apiError(c, "Saving the test case");
        saved = (c.data as { case: Record<string, unknown> }).case;
        savedLine = `\nSaved as the case "${saved.name}" [${saved.id}] of ${save_case.agent}/${save_case.suite}: run it with polpo_agent_suite_run.`;
      }
      return ok(`${exchangesText(session.panes, exchanges)}${savedLine}`, {
        panes: session.panes as unknown as Array<Record<string, unknown>>, exchanges: exchanges as unknown as Record<string, unknown>, ...(saved ? { case: saved } : {}),
      });
    } finally {
      await apiSend(deps, "DELETE", `/playground/sessions/${enc(session.id)}`).catch(() => undefined);
    }
  });

  tool("team", "polpo_playground_promote", {
    title: "Promote a variant to the draft",
    description: "Write a variant's overrides (model, reasoning, instructions replace or append, allowedTools, maxTurns), applied to the agent at the variant's version, into the agent's DRAFT. Never deploys: "
      + "publish and deploy the draft as usual (polpo_agent_publish, polpo_agent_deploy — through its required suites).",
    inputSchema: {
      agent: z.string().min(1).describe("The agent whose draft gets the overrides"), version: z.string().optional().describe("The variant's version (default production)"),
      overrides: z.object({
        model: z.string().optional(), reasoning: z.string().optional(), instructions: z.string().optional(), instructionsAppend: z.string().optional(),
        allowedTools: z.array(z.string()).optional(), maxTurns: z.number().int().positive().optional(),
      }).describe("The variant's overrides: model, reasoning, instructions (replace) or instructionsAppend, allowedTools, maxTurns"),
      note: z.string().max(500).optional().describe("A note for the draft's history"),
    },
    outputSchema: { agent: z.string(), fields: looseObject, draftChanged: z.boolean() },
    annotations: UPDATE,
  }, async ({ agent, version, overrides: o, note }) => {
    const r = await apiSend(deps, "POST", "/playground/promote", { agent, ...(version ? { version } : {}), overrides: o, ...(note ? { note } : {}) });
    if (!r.ok) return apiError(r, "Promoting the variant");
    const d = r.data as { agent: string; fields: Record<string, unknown>; draftChanged: boolean };
    return ok(`${d.draftChanged ? "Updated" : "Nothing changed in"} ${agent}'s draft: ${Object.keys(d.fields).join(", ")}. Not deployed: publish and deploy the draft when ready (polpo_agent_publish, polpo_agent_deploy).`,
      d as unknown as Record<string, unknown>);
  });
}
