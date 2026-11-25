/**
 * Agent suites over MCP (docs/agent-suites.md): list, read, save (JSON or YAML, CSV / JSON dataset
 * imports), delete, run against a version (offline contract runs with the work scope; runs that
 * touch real tools need polpo:admin), and read runs: a report per case with the failed assertions,
 * their diffs, the trace (model turns, tool calls, mocks hit, approvals) and the cost, so a person
 * can analyse results by chatting with an assistant over MCP.
 */
import { z } from "zod";
import {
  DESTRUCTIVE, MAX_WAIT_SECONDS, READ, WRITE, apiError, apiGet, apiSend, dashboardLink, enc, fail, hasScope, looseObject, ok, qs, short, sleep,
  type McpDeps, type Register,
} from "./kit.js";

type Assertion = { description: string; passed: boolean; message: string; diff?: string };
type Score = { id: string; description: string; score: number; threshold: number; passed: boolean; reason?: string; error?: string; judge?: { model?: string; summary?: string; criteria: Array<{ name: string; score: number; reasoning: string }> } };
type Delta = { id: string; label?: string; baseline?: number; current?: number; delta?: number; change: string };
type Comparison = {
  runId: string; source: string; baselineTarget?: string; baselineVersion?: string; tolerance: number; passRateDelta: number; costDelta: number; durationDelta: number; scoreDelta?: number;
  regressions: number; improvements: number; scorers: Delta[];
  cases: Array<{ key: string; caseName: string; change: string; reasons: string[]; score?: { baseline?: number; current?: number; delta?: number } }>;
};
type Aggregates = {
  score?: number; passRate: number; judgeCostUsd: number; latencyP50Ms?: number; latencyP90Ms?: number; repetitions: number; flaky: string[];
  scorers: Array<{ id: string; label: string; mean: number; median: number; p10: number; passRate: number; count: number }>;
  cases: Array<{ key: string; caseName: string; attempts: number; passRate: number; score?: number; scoreStddev?: number; flaky: boolean }>;
};
type ToolCall = { name: string; args: Record<string, unknown>; result: string; isError: boolean; mocked: string | false; mockId?: string; approval?: string };
type Result = {
  key: string; caseName: string; status: string; mode: string; engine: string; error?: string; durationMs: number; costUsd: number;
  assertions?: Assertion[]; failed?: string[]; scores?: Score[]; score?: number; attempt?: number;
  trace?: { turns: Array<{ text: string; mocked: boolean; toolCalls: Array<{ name: string }> }>; toolCalls: ToolCall[]; text: string; finishReason?: string; approvals: Array<{ tool: string; kind: string }>; notes: string[];
    transcript?: Array<{ role: string; content: string; simulated?: boolean }>; finalText?: string; simulator?: { model?: string; calls: number; stoppedBy: string };
    http?: Array<{ method: string; url: string; status: number; mocked: string | false; mockId?: string }>; tasks?: Array<{ title: string; agent: string; status: string; error?: string; toolCalls: number; text: string }>;
    cassette?: { id: string; replayedCalls: number; replayedTurns: number; unmatched: string[] }; recorded?: { cassetteId: string; calls: number; turns: number; redactions: number } };
};
type Run = {
  id: string; agent: string; suiteId: string; suiteName: string; target: string; version?: string; status: string; startedAt: string; finishedAt?: string;
  variant: { id: string; label?: string }; benchmarkRunId?: string; planned: string[]; results: Result[]; notes: string[]; error?: string;
  stats: { total: number; passed: number; failed: number; errored: number; skipped: number; passRate: number; costUsd: number; durationMs: number };
  aggregates?: Aggregates; baseline?: Comparison; isBaseline?: boolean; repetitions?: number;
  review?: { text: string; model?: string; at: string };
};
type Trend = {
  suiteId: string;
  points: Array<{ runId: string; startedAt: string; target: string; version?: string; status: string; passRate: number; score?: number; costUsd: number; durationMs: number; regressions?: number; isBaseline?: boolean }>;
  byVersion: Array<{ version: string; runs: number; passRate: number; score?: number; costUsd: number; durationMs: number }>;
};
type Suite = { id: string; name: string; description?: string; defaultMode: string; revision: number; cases: Array<{ id: string; name: string; mode?: string; dataset?: string; assertions: unknown[] }>; datasets: Array<{ id: string; name: string; rows: unknown[] }>; updatedAt: string;
  gate?: { required?: boolean; minPassRate?: number; maxRegression?: number; scoreThresholds?: Record<string, number>; onPublish?: boolean; allowRealTools?: boolean } };

/** A suite's deploy gate in words ("required: pass rate ≥ 100%, max regression 0.05, on publish"). */
function gateLine(g: Suite["gate"]): string {
  if (!g?.required) return "";
  const parts = [`pass rate ≥ ${Math.round((g.minPassRate ?? 1) * 100)}%`];
  if (g.maxRegression !== undefined) parts.push(`max regression ${g.maxRegression}`);
  for (const [k, v] of Object.entries(g.scoreThresholds ?? {})) parts.push(`${k} ≥ ${v}`);
  if (g.onPublish) parts.push("also on publish");
  if (g.allowRealTools) parts.push("may run real tools");
  return ` · REQUIRED to deploy (${parts.join(", ")})`;
}

const MARK: Record<string, string> = { passed: "✓", failed: "✗", errored: "‼", skipped: "–", running: "…", queued: "…", cancelled: "⊘" };
const usd = (n: number) => `$${n.toFixed(4)}`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

const signed = (n: number, digits = 2) => `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n).toFixed(digits)}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

function runHeader(r: Run): string {
  const target = r.target === "production" ? `production${r.version ? ` (v${r.version})` : ""}` : r.target === "draft" ? "draft" : `v${r.target}`;
  return `${MARK[r.status] ?? r.status} ${r.agent} · ${r.suiteName} @ ${target}${r.variant.label ? ` · ${r.variant.label}` : ""} · ${r.status} · `
    + `${r.stats.passed}/${r.stats.total - r.stats.skipped} passed${r.aggregates?.score !== undefined ? ` · score ${r.aggregates.score.toFixed(2)}` : ""} · ${usd(r.stats.costUsd)} · ${secs(r.stats.durationMs)}`
    + `${r.baseline ? ` · vs baseline: ${r.baseline.regressions} regression(s), ${r.baseline.improvements} improvement(s)` : ""}${r.isBaseline ? " · ★ baseline" : ""} [${r.id}]`;
}

/** The scores per scorer, flaky cases and the baseline comparison of a run. */
function evalLines(r: Run): string[] {
  const lines: string[] = [];
  const a = r.aggregates;
  if (a?.scorers.length) {
    lines.push(`scores${a.score !== undefined ? ` (overall ${a.score.toFixed(2)})` : ""}: ${a.scorers.map((x) => `${x.id} mean ${x.mean.toFixed(2)} · median ${x.median.toFixed(2)} · p10 ${x.p10.toFixed(2)} · pass ${pct(x.passRate)}`).join(" | ")}`);
  }
  if (a && a.repetitions > 1) {
    lines.push(`repetitions: ${a.repetitions} per case${a.flaky.length ? ` · flaky: ${a.flaky.join(", ")}` : " · none flaky"}`);
    for (const c of a.cases.filter((x) => x.flaky).slice(0, 10)) lines.push(`   ≈ ${c.key} — ${c.caseName}: pass ${pct(c.passRate)} of ${c.attempts}${c.score !== undefined ? `, score ${c.score.toFixed(2)} ± ${(c.scoreStddev ?? 0).toFixed(2)}` : ""}`);
  }
  const b = r.baseline;
  if (b) {
    lines.push(`baseline ${b.runId} (${b.source}${b.baselineVersion ? `, v${b.baselineVersion}` : b.baselineTarget ? `, ${b.baselineTarget}` : ""}): pass rate ${signed(b.passRateDelta * 100, 0)} pts`
      + `${b.scoreDelta !== undefined ? ` · score ${signed(b.scoreDelta)}` : ""} · cost ${b.costDelta >= 0 ? "+" : "−"}${usd(Math.abs(b.costDelta))} · tolerance ${b.tolerance}`);
    for (const c of b.cases.filter((x) => x.change === "regressed" || x.change === "improved").slice(0, 20)) lines.push(`   ${c.change === "regressed" ? "▼" : "▲"} ${c.key} — ${c.caseName}: ${c.reasons.join("; ")}`);
    for (const x of b.scorers.filter((y) => y.change === "regressed" || y.change === "improved")) lines.push(`   ${x.change === "regressed" ? "▼" : "▲"} scorer ${x.id}: ${x.baseline?.toFixed(2)} → ${x.current?.toFixed(2)}`);
  }
  return lines;
}

/** The report of a run: one line per case, the failed assertions with their messages and diffs. */
function runReport(r: Run, opts: { diffs?: boolean } = {}): string {
  const lines = [runHeader(r)];
  if (r.error) lines.push(`Error: ${r.error}`);
  for (const n of r.notes) lines.push(`note: ${n}`);
  lines.push(...evalLines(r));
  for (const c of r.results) {
    const tools = c.trace ? ` · tools: ${c.trace.toolCalls.map((t) => `${t.name}${t.mocked ? `(${t.mocked})` : ""}`).join(", ") || "none"}` : "";
    lines.push(`${MARK[c.status] ?? c.status} ${c.key} — ${c.caseName} [${c.mode}, ${c.engine}] ${secs(c.durationMs)} ${usd(c.costUsd)}${c.score !== undefined ? ` score ${c.score.toFixed(2)}` : ""}${tools}`);
    if (c.error) lines.push(`   error: ${short(c.error, 400)}`);
    for (const a of c.assertions?.filter((x) => !x.passed) ?? []) {
      lines.push(`   ✗ ${a.description}: ${short(a.message, 400)}`);
      if (opts.diffs && a.diff) lines.push(...a.diff.split("\n").slice(0, 30).map((l) => `      ${l}`));
    }
    // full runs list the failed scorers here (summaries already have them in `failed`)
    if (c.assertions) for (const x of c.scores?.filter((y) => !y.passed) ?? []) lines.push(`   ✗ ${x.id}: ${x.score.toFixed(2)} < ${x.threshold}${x.error ? ` (error: ${short(x.error, 200)})` : ""}${x.reason ? ` — ${short(x.reason, 300)}` : ""}`);
    for (const f of c.failed ?? []) lines.push(`   ✗ ${f}`);
  }
  if (r.review) lines.push(`AI review (${r.review.model ?? "model"}, ${r.review.at.slice(0, 16).replace("T", " ")}):`, short(r.review.text, 3000));
  const pending = r.planned.filter((k) => !r.results.some((x) => x.key === k));
  if (pending.length) lines.push(`… ${pending.length} case(s) not finished yet: ${pending.slice(0, 10).join(", ")}`);
  return lines.join("\n");
}

/** One case's trace, readable. */
function caseTrace(c: Result): string {
  const lines = [`${MARK[c.status] ?? c.status} ${c.key} — ${c.caseName} [${c.mode}, ${c.engine}]`];
  const t = c.trace;
  if (!t) return lines.join("\n");
  t.turns.forEach((turn, i) => {
    lines.push(`turn ${i + 1}${turn.mocked ? " (scripted)" : ""}: ${short(turn.text, 300) || "—"}${turn.toolCalls.length ? ` → ${turn.toolCalls.map((x) => x.name).join(", ")}` : ""}`);
  });
  for (const tc of t.toolCalls) {
    lines.push(`tool ${tc.name}${tc.mocked ? ` [${tc.mocked}${tc.mockId ? ` ${tc.mockId}` : ""}]` : " [real]"}${tc.approval ? ` [approval ${tc.approval}]` : ""} ${short(JSON.stringify(tc.args), 300)}`);
    lines.push(`   → ${tc.isError ? "ERROR " : ""}${short(tc.result, 400)}`);
  }
  for (const h of t.http ?? []) lines.push(`http ${h.method} ${h.url} → ${h.status || "—"} [${h.mocked ? `${h.mocked}${h.mockId ? ` ${h.mockId}` : ""}` : "real"}]`);
  for (const task of t.tasks ?? []) lines.push(`task ${task.title} (${task.agent}): ${task.status}${task.error ? ` — ${short(task.error, 200)}` : ""} · ${task.toolCalls} call(s)${task.text ? ` · ${short(task.text, 200)}` : ""}`);
  if (t.cassette) lines.push(`cassette ${t.cassette.id}: ${t.cassette.replayedCalls} call(s) and ${t.cassette.replayedTurns} turn(s) replayed${t.cassette.unmatched.length ? `, unmatched: ${t.cassette.unmatched.join(", ")}` : ""}`);
  if (t.recorded) lines.push(`recorded into the cassette ${t.recorded.cassetteId}: ${t.recorded.calls} call(s), ${t.recorded.turns} turn(s), ${t.recorded.redactions} value(s) redacted`);
  if (t.transcript?.length) {
    lines.push(`conversation (${t.transcript.length} messages${t.simulator ? `, the user ${t.simulator.calls ? `simulated by ${t.simulator.model ?? "Polpo's model"}` : "scripted"}, stopped by ${t.simulator.stoppedBy}` : ""}):`);
    for (const m of t.transcript.slice(0, 40)) lines.push(`   ${m.role === "user" ? "USER" : "AGENT"}${m.simulated ? " (simulated)" : ""}: ${short(m.content, 400)}`);
    lines.push(`final reply: ${short(t.finalText ?? "", 1200) || "—"}`);
  } else lines.push(`reply: ${short(t.text, 1200) || "—"}`);
  if (t.finishReason) lines.push(`finish: ${t.finishReason}`);
  for (const n of t.notes) lines.push(`note: ${n}`);
  for (const a of c.assertions ?? []) {
    lines.push(`${a.passed ? "✓" : "✗"} ${a.description}: ${short(a.message, 300)}`);
    if (!a.passed && a.diff) lines.push(...a.diff.split("\n").slice(0, 40).map((l) => `   ${l}`));
  }
  for (const x of c.scores ?? []) {
    lines.push(`${x.passed ? "✓" : "✗"} score ${x.id} ${x.score.toFixed(2)} (threshold ${x.threshold}) — ${x.description}${x.error ? `: error ${short(x.error, 300)}` : x.reason ? `: ${short(x.reason, 400)}` : ""}`);
    for (const k of x.judge?.criteria ?? []) lines.push(`   ${k.name} ${k.score}/5: ${short(k.reasoning, 400)}`);
  }
  return lines.join("\n");
}

export function registerAgentSuiteTools(tool: Register, deps: McpDeps): void {
  const isAdmin = () => !deps.principal || hasScope(deps.principal, "polpo:admin");
  const notFound = (r: { error?: string }, fallback: string) => fail(r.error ?? fallback);
  const suitesLink = (agent: string) => dashboardLink(deps, `/agents/${enc(agent)}?tab=suites`);

  tool("team", "polpo_agent_suite_list", {
    title: "List an agent's suites",
    description: "An agent's test and eval suites: cases, datasets, default mock mode (all = offline contract: scripted model and mocked tools; tools = mocked tools, real model; "
      + "model = scripted model, real tools; none = live), and the latest run of each.",
    inputSchema: { agent: z.string().min(1).describe("The agent's name (polpo_agents_list)") },
    outputSchema: { suites: z.array(looseObject) },
    annotations: READ,
  }, async ({ agent }) => {
    const r = await apiGet(deps, `/agents/${enc(agent)}/suites`);
    if (!r.ok) return r.status === 404 ? notFound(r, `There is no agent "${agent}".`) : apiError(r, `Reading ${agent}'s suites`);
    const suites = r.data as Suite[];
    const runs = await apiGet(deps, `/agents/${enc(agent)}/suite-runs${qs({ limit: "50" })}`);
    const latest = new Map<string, Run>();
    // a suite's own last run (benchmark runs compare variants)
    for (const run of (runs.ok ? runs.data as Run[] : [])) if (!run.benchmarkRunId && !latest.has(run.suiteId)) latest.set(run.suiteId, run);
    if (!suites.length) return ok(`${agent} has no suites yet. Create one with polpo_agent_suite_save (${suitesLink(agent)}).`, { suites: [] });
    return ok(suites.map((s) => {
      const last = latest.get(s.id);
      return `${s.name} [${s.id}] · ${s.cases.length} case(s), ${s.datasets.length} dataset(s), mode ${s.defaultMode} · rev ${s.revision}${gateLine(s.gate)}`
        + (last ? ` · last run ${MARK[last.status] ?? ""} ${last.status} ${last.stats.passed}/${last.stats.total - last.stats.skipped} (${last.startedAt.slice(0, 16).replace("T", " ")}, ${last.id})` : " · never run");
    }).join("\n"), { suites: suites.map((s) => ({ ...s, lastRun: latest.get(s.id) ?? null })) as unknown as Array<Record<string, unknown>> });
  });

  tool("team", "polpo_agent_suite_get", {
    title: "Read a suite",
    description: "One suite with its cases (input, mode, mocks, assertions), datasets and shared mocks, as JSON; format: yaml returns the YAML view (edit it and save it back with polpo_agent_suite_save yaml).",
    inputSchema: {
      agent: z.string().min(1).describe("The agent's name (polpo_agents_list)"),
      suite: z.string().min(1).describe("The suite's id (polpo_agent_suite_list)"),
      format: z.enum(["json", "yaml"]).optional().describe("json (default) or yaml (the YAML view)"),
    },
    outputSchema: { suite: looseObject.optional(), yaml: z.string().optional(), revision: z.number().optional() },
    annotations: READ,
  }, async ({ agent, suite, format }) => {
    const r = await apiGet(deps, `/agents/${enc(agent)}/suites/${enc(suite)}${format === "yaml" ? "?format=yaml" : ""}`);
    if (!r.ok) return r.status === 404 ? notFound(r, `There is no suite "${suite}" for ${agent}.`) : apiError(r, `Reading ${suite}`);
    if (format === "yaml") {
      const y = r.data as { yaml: string; revision: number };
      return ok(`# revision ${y.revision}\n${y.yaml}`, y);
    }
    const s = r.data as Suite;
    return ok(JSON.stringify(s, null, 2), { suite: s as unknown as Record<string, unknown>, revision: s.revision });
  });

  tool("team", "polpo_agent_suite_save", {
    title: "Save a suite",
    description: "Create or replace an agent's suite. suite: { name, description?, defaultMode?: all | tools | model | none (default all), mocks?: shared mocks, budgets?: { maxTurns, maxCostUsd, maxDurationMs }, "
      + "datasets?: [{ name, rows: [{...}] }], cases: [{ name, input: { kind: chat | task, message, history?, context?: { system, memory, files, attachments } }, mode?, dataset?: dataset id (one run per row, {{row.col}} templated), "
      + "mocks?: { tools?: [{ tool: name or glob like mcp__printful__*, when?: { args, match: partial | exact | regex | schema, call }, response | error, delayMs?, times? }], "
      + "model?: { turns: [{ text?, toolCalls?: [{ name, args }] }] }, unmockedTools?: block | real }, "
      + "assertions: [{ type: tool_called | tool_not_called | tool_order | tool_args | no_tool_errors | outcome_registered | artifact_created | approval_requested | text_contains | text_not_contains | text_regex | max_turns | max_cost | max_duration, ... }], "
      + "scorers?: [{ type: exact | numeric | contains_all | contains_any | regex | similarity | json_schema | tool_trajectory | cost | latency | llm_judge | custom, id?, threshold? (0..1), weight?, "
      + "from?: reply | reply_json | tool_args | tool_result | outcome, tool?, path?, expected / values / pattern / schema / maxUsd / maxMs / rubric + criteria [{ name, description, weight }] / code }] (evals: a score 0..1 each; "
      + "expected may be {{row.expected}} from a dataset) }], scorers?: defaults for every case, evals?: { judgeModel, repetitions, regressionTolerance, baseline: previous | production | none }, "
      + "gate?: { required: true (a deploy gate: the suite must pass before any version of the agent reaches production), minPassRate? (0..1, default 1), maxRegression? (largest pass-rate or score drop versus the baseline), "
      + "scoreThresholds?: { scorerId | score: minimum mean }, onPublish? (also run when a version is published, non-blocking), allowRealTools? (the gate may run its real-tools cases: admin only) } }. "
      + "Or yaml: the same as YAML (polpo_agent_suite_get format yaml). revision: the one you edited (refused if changed meanwhile). "
      + "import_dataset: { format: csv | json, text, name?, id?, mode?: replace | append } imports rows into the suite `suite` instead.",
    inputSchema: {
      agent: z.string().min(1).describe("The agent's name (polpo_agents_list)"),
      suite: z.union([z.string().min(1), looseObject]).optional().describe("The suite object to save, or (with import_dataset) the id of the suite to import into"),
      yaml: z.string().optional().describe("The suite as YAML (instead of suite)"),
      revision: z.number().int().optional().describe("The revision you edited (the save is refused if the suite changed meanwhile)"),
      import_dataset: z.object({
        format: z.enum(["csv", "json"]), text: z.string().min(1), name: z.string().optional(), id: z.string().optional(), mode: z.enum(["replace", "append"]).optional(),
      }).optional().describe("Import rows (CSV with a header line, or JSON: a list of objects) into the suite `suite` (its id): a new dataset, or replace / append the rows of dataset `id`"),
    },
    outputSchema: { suite: looseObject },
    annotations: WRITE,
    scope: "polpo:work",
  }, async ({ agent, suite, yaml, revision, import_dataset }) => {
    if (import_dataset) {
      if (typeof suite !== "string") return fail("With import_dataset, suite is the id of the suite to import into.");
      const r = await apiSend(deps, "POST", `/agents/${enc(agent)}/suites/${enc(suite)}/datasets/import`, import_dataset);
      if (!r.ok) return r.status === 404 ? notFound(r, `There is no suite "${suite}" for ${agent}.`) : apiError(r, "Importing the dataset");
      const s = r.data as Suite;
      return ok(`Imported into ${s.name}: ${s.datasets.map((d) => `${d.name} [${d.id}] ${d.rows.length} rows`).join(", ")}. Use it in a case with dataset: "<id>" and {{row.column}}.`, { suite: s as unknown as Record<string, unknown> });
    }
    let body: Record<string, unknown>;
    if (yaml) body = { yaml, ...(revision !== undefined ? { revision } : {}) };
    else if (suite && typeof suite === "object") body = { ...suite, ...(revision !== undefined ? { revision } : {}) };
    else return fail("Give suite (an object) or yaml.");
    const id = typeof (body as { id?: unknown }).id === "string" ? (body as { id: string }).id : undefined;
    // with an id: replace (or create) that suite; without: create one (its id made from the name)
    const r = id
      ? await apiSend(deps, "PUT", `/agents/${enc(agent)}/suites/${enc(id)}`, body)
      : await apiSend(deps, "POST", `/agents/${enc(agent)}/suites`, body);
    if (!r.ok) {
      if (r.status === 409 && !id && !yaml) return fail(`${r.error}. To replace it, send the suite with its id.`);
      return r.status === 404 ? notFound(r, `There is no agent "${agent}".`) : apiError(r, "Saving the suite");
    }
    const s = r.data as Suite;
    return ok(`Saved ${s.name} [${s.id}] rev ${s.revision}: ${s.cases.length} case(s), ${s.datasets.length} dataset(s), default mode ${s.defaultMode}. Run it with polpo_agent_suite_run. ${suitesLink(agent)}`,
      { suite: s as unknown as Record<string, unknown> });
  });

  tool("team", "polpo_agent_suite_delete", {
    title: "Delete a suite",
    description: "Delete one of an agent's suites (its past runs stay in the history).",
    inputSchema: { agent: z.string().min(1).describe("The agent's name"), suite: z.string().min(1).describe("The suite's id (polpo_agent_suite_list)") },
    outputSchema: { deleted: z.string() },
    annotations: DESTRUCTIVE,
    scope: "polpo:work",
  }, async ({ agent, suite }) => {
    const r = await apiSend(deps, "DELETE", `/agents/${enc(agent)}/suites/${enc(suite)}`);
    if (!r.ok) return r.status === 404 ? notFound(r, `There is no suite "${suite}" for ${agent}.`) : apiError(r, `Deleting ${suite}`);
    return ok(`Deleted the suite ${suite} of ${agent}.`, { deleted: suite });
  });

  tool("team", "polpo_agent_suite_run", {
    title: "Run a suite",
    description: "Run an agent's suite (or some cases) against a version: target production (default), draft or 1.2.0. Each case is a real chat turn through the agent's own path with its mocks. "
      + "mode overrides every case's mode: all (offline: scripted model, mocked tools — no cost, no side effects), tools (mocked tools, the real model: costs tokens), "
      + "model / none (real tools: side effects possible, needs the admin scope; approvals are never given). overrides change the agent for this run only (model, reasoning, instructions, instructionsAppend, allowedTools, maxTurns): "
      + "compare variants by running the same suite with different overrides and labels. repetitions runs each case N times (flaky cases flagged). The report has each case's assertions and scores, "
      + "the mean / median / p10 per scorer and the comparison with the baseline (regressions, improvements). Waits up to wait_seconds (default 50) and returns the report; "
      + "a run still going is returned running: read it later with polpo_agent_suite_run_get. cancel: a run id to stop instead (cases not started are skipped).",
    inputSchema: {
      agent: z.string().min(1).describe("The agent's name (polpo_agents_list)"),
      suite: z.string().min(1).describe("The suite's id (polpo_agent_suite_list)"),
      target: z.string().optional().describe("production (default), draft, or a published version like 1.2.0"),
      cases: z.array(z.string()).optional().describe("Only these case ids"),
      mode: z.enum(["none", "tools", "model", "all"]).optional().describe("Run every case in this mode (default: each case's own)"),
      overrides: z.object({
        model: z.string().optional(), reasoning: z.string().optional(), instructions: z.string().optional(), instructionsAppend: z.string().optional(),
        allowedTools: z.array(z.string()).optional(), maxTurns: z.number().int().positive().optional(),
      }).optional().describe("Per-run changes to the agent (this run only; nothing is saved)"),
      label: z.string().optional().describe("A label for this run's variant (comparisons)"),
      concurrency: z.number().int().min(1).max(4).optional().describe("Cases at once (default the suite's, 1)"),
      repetitions: z.number().int().min(1).max(10).optional().describe("Run every case this many times: mean, stddev and a flakiness flag per case (default the suite's, 1)"),
      baseline: z.string().optional().describe("Compare with this run id instead of the suite's baseline"),
      tolerance: z.number().min(0).max(1).optional().describe("A change within this is not a regression (default the suite's, 0.05)"),
      wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().describe("How long to wait for the run (default 50 s)"),
      cancel: z.string().optional().describe("Stop this running run (its id) instead of starting one"),
    },
    outputSchema: { run: looseObject },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    scope: "polpo:work",
  }, async ({ agent, suite, target, cases, mode, overrides, label, concurrency, repetitions, baseline, tolerance, wait_seconds, cancel }, extra) => {
    if (cancel) {
      const c = await apiSend(deps, "POST", `/agents/${enc(agent)}/suite-runs/${enc(cancel)}/cancel`);
      if (!c.ok) return c.status === 404 ? notFound(c, `There is no run "${cancel}".`) : apiError(c, "Cancelling the run");
      return ok(runReport(c.data as Run), { run: c.data as Record<string, unknown> });
    }
    const admin = isAdmin();
    const r = await apiSend(deps, "POST", `/agents/${enc(agent)}/suites/${enc(suite)}/runs`, {
      ...(target ? { target } : {}), ...(cases?.length ? { caseIds: cases } : {}), ...(mode ? { mode } : {}), ...(overrides ? { overrides } : {}),
      ...(label ? { variant: { label } } : {}), ...(concurrency ? { concurrency } : {}),
      ...(repetitions ? { repetitions } : {}), ...(baseline ? { baselineRunId: baseline } : {}), ...(tolerance !== undefined ? { regressionTolerance: tolerance } : {}),
      ...(admin ? { allowRealTools: true } : {}),
    });
    if (!r.ok) {
      if (r.status === 403) return fail(`${r.error}${admin ? "" : " This connection does not have the admin scope (polpo:admin)."}`);
      return r.status === 404 ? notFound(r, `There is no agent "${agent}", suite "${suite}" or version "${target}".`) : apiError(r, `Running ${suite}`);
    }
    let run = r.data as Run;
    const until = Date.now() + (wait_seconds ?? 50) * 1000;
    while ((run.status === "running" || run.status === "queued") && Date.now() < until && !extra?.signal?.aborted) {
      await sleep(1000, extra?.signal);
      const g = await apiGet(deps, `/agents/${enc(agent)}/suite-runs/${enc(run.id)}`);
      if (g.ok) run = g.data as Run;
    }
    const still = run.status === "running" || run.status === "queued";
    return ok(`${runReport(run, { diffs: true })}${still ? `\nStill running: polpo_agent_suite_run_get with run "${run.id}".` : ""}\n${suitesLink(agent)}`,
      { run: run as unknown as Record<string, unknown> });
  });

  tool("team", "polpo_agent_suite_run_get", {
    title: "Read suite runs",
    description: "Without run: an agent's suite runs, newest first (suite: one suite; benchmark: one benchmark), with pass rate, cost and duration. "
      + "With run: its report — each case's status, the failed assertions with their messages and diffs; case: one case's full trace (model turns, tool calls with arguments, "
      + "results and the mock that answered, approvals, reply, notes).",
    inputSchema: {
      agent: z.string().min(1).describe("The agent's name (polpo_agents_list)"),
      run: z.string().optional().describe("A run id (sr-…)"),
      suite: z.string().optional().describe("Only this suite's runs"),
      benchmark: z.string().optional().describe("Only this benchmark's runs"),
      case: z.string().optional().describe("A case key (case id, or case#row for a dataset row): its full trace"),
      limit: z.number().int().min(1).max(100).optional().describe("How many runs (default 20)"),
    },
    outputSchema: { run: looseObject.optional(), runs: z.array(looseObject).optional(), result: looseObject.optional() },
    annotations: READ,
  }, async ({ agent, run, suite, benchmark, case: caseKey, limit }) => {
    if (!run) {
      const r = await apiGet(deps, `/agents/${enc(agent)}/suite-runs${qs({ suite, benchmark, limit: String(limit ?? 20) })}`);
      if (!r.ok) return r.status === 404 ? notFound(r, `There is no agent "${agent}".`) : apiError(r, `Reading ${agent}'s runs`);
      const runs = r.data as Run[];
      return ok(runs.length ? runs.map(runHeader).join("\n") : `${agent} has no suite runs${suite ? ` for ${suite}` : ""} yet.`, { runs: runs as unknown as Array<Record<string, unknown>> });
    }
    const r = await apiGet(deps, `/agents/${enc(agent)}/suite-runs/${enc(run)}`);
    if (!r.ok) return r.status === 404 ? notFound(r, `There is no run "${run}" for ${agent}.`) : apiError(r, "Reading the run");
    const full = r.data as Run;
    if (caseKey) {
      const c = full.results.find((x) => x.key === caseKey || x.key.split("#")[0] === caseKey);
      if (!c) return fail(`The run has no case "${caseKey}": ${full.results.map((x) => x.key).join(", ")}`);
      return ok(caseTrace(c), { result: c as unknown as Record<string, unknown> });
    }
    return ok(runReport(full, { diffs: true }), { run: full as unknown as Record<string, unknown> });
  });

  tool("team", "polpo_agent_suite_trend", {
    title: "A suite's trend",
    description: "A suite's finished runs over time (oldest first): pass rate, overall score, cost, duration and regressions versus the baseline per run, and the same averaged by version "
      + "(production's version, a published one, draft). Use it to see whether a change to the agent made it better or worse. polpo_agent_suite_show view trend draws it as a chart.",
    inputSchema: {
      agent: z.string().min(1).describe("The agent's name (polpo_agents_list)"),
      suite: z.string().min(1).describe("The suite's id (polpo_agent_suite_list)"),
      limit: z.number().int().min(1).max(100).optional().describe("How many recent runs (default 50)"),
    },
    outputSchema: { trend: looseObject },
    annotations: READ,
  }, async ({ agent, suite, limit }) => {
    const r = await apiGet(deps, `/agents/${enc(agent)}/suites/${enc(suite)}/trend${qs({ limit: limit ? String(limit) : undefined })}`);
    if (!r.ok) return r.status === 404 ? notFound(r, `There is no suite "${suite}" for ${agent}.`) : apiError(r, `Reading ${suite}'s trend`);
    const t = r.data as Trend;
    if (!t.points.length) return ok(`${suite} has no finished runs yet: run it with polpo_agent_suite_run.`, { trend: t as unknown as Record<string, unknown> });
    const lines = [
      `${suite}: ${t.points.length} run(s)`,
      ...t.points.map((p) => `${p.startedAt.slice(0, 16).replace("T", " ")} ${MARK[p.status] ?? ""} ${p.version ? `v${p.version}` : p.target} · pass ${pct(p.passRate)}`
        + `${p.score !== undefined ? ` · score ${p.score.toFixed(2)}` : ""} · ${usd(p.costUsd)} · ${secs(p.durationMs)}${p.regressions ? ` · ${p.regressions} regression(s)` : ""}${p.isBaseline ? " · ★ baseline" : ""} [${p.runId}]`),
      "by version:",
      ...t.byVersion.map((v) => `   ${v.version}: ${v.runs} run(s) · pass ${pct(v.passRate)}${v.score !== undefined ? ` · score ${v.score.toFixed(2)}` : ""} · ${usd(v.costUsd)} · ${secs(v.durationMs)}`),
    ];
    return ok(lines.join("\n"), { trend: t as unknown as Record<string, unknown> });
  });

  tool("team", "polpo_agent_suite_baseline", {
    title: "A suite's baseline",
    description: "The run a suite's new runs are compared with (deltas per case and per scorer; regressions and improvements beyond the tolerance). "
      + "run: mark that finished run as the baseline (e.g. the last good run on production); clear: true removes the mark (new runs are then compared with the previous run, or as evals.baseline says); "
      + "neither: show the current baseline. compare: a run id to compare with the baseline now (or with run).",
    inputSchema: {
      agent: z.string().min(1).describe("The agent's name (polpo_agents_list)"),
      suite: z.string().min(1).describe("The suite's id (polpo_agent_suite_list)"),
      run: z.string().optional().describe("Mark this run (sr-…) as the baseline; with compare: the run to compare with"),
      clear: z.boolean().optional().describe("Remove the baseline mark"),
      compare: z.string().optional().describe("A run id to compare with the baseline (or with run)"),
    },
    outputSchema: { baseline: looseObject.nullable().optional(), comparison: looseObject.nullable().optional() },
    annotations: WRITE,
    scope: "polpo:work",
  }, async ({ agent, suite, run, clear, compare }) => {
    if (compare) {
      const r = await apiGet(deps, `/agents/${enc(agent)}/suite-runs/${enc(compare)}/compare${qs({ baseline: run })}`);
      if (!r.ok) return r.status === 404 ? notFound(r, `There is no run "${compare}" for ${agent}.`) : apiError(r, "Comparing the runs");
      const cmp = r.data as Comparison | null;
      if (!cmp) return ok(`There is nothing to compare ${compare} with: mark a baseline (run) first.`, { comparison: null });
      const fake = { baseline: cmp } as unknown as Run;
      return ok([`${compare} vs ${cmp.runId}: ${cmp.regressions} regression(s), ${cmp.improvements} improvement(s)`, ...evalLines(fake)].join("\n"), { comparison: cmp as unknown as Record<string, unknown> });
    }
    if (clear) {
      const r = await apiSend(deps, "DELETE", `/agents/${enc(agent)}/suites/${enc(suite)}/baseline`);
      if (!r.ok) return r.status === 404 ? notFound(r, `There is no suite "${suite}" for ${agent}.`) : apiError(r, "Clearing the baseline");
      return ok(`${suite} has no marked baseline now: new runs are compared as its evals.baseline says (the previous run by default).`, { baseline: null });
    }
    if (run) {
      const r = await apiSend(deps, "PUT", `/agents/${enc(agent)}/suites/${enc(suite)}/baseline`, { runId: run });
      if (!r.ok) return r.status === 404 ? notFound(r, `There is no suite "${suite}" or run "${run}" for ${agent}.`) : apiError(r, "Marking the baseline");
      return ok(`Marked ${run} as ${suite}'s baseline: ${runHeader(r.data as Run)}. New runs are compared with it.`, { baseline: r.data as Record<string, unknown> });
    }
    const r = await apiGet(deps, `/agents/${enc(agent)}/suites/${enc(suite)}/baseline`);
    if (!r.ok) return r.status === 404 ? notFound(r, `There is no suite "${suite}" for ${agent}.`) : apiError(r, "Reading the baseline");
    return r.data
      ? ok(`Baseline of ${suite}: ${runHeader(r.data as Run)}`, { baseline: r.data as Record<string, unknown> })
      : ok(`${suite} has no marked baseline: new runs are compared with the previous run (or as its evals.baseline says). Mark one with run.`, { baseline: null });
  });

  tool("team", "polpo_agent_suite_review", {
    title: "Explain a suite run",
    description: "An AI review of a finished run by Polpo's model: a summary, what failed or regressed and why, and suggested fixes (instruction edits, tool changes, or the test itself). "
      + "Stored on the run (the dashboard shows it); costs tokens. With refresh: false (default), an existing review is returned as is.",
    inputSchema: {
      agent: z.string().min(1).describe("The agent's name (polpo_agents_list)"),
      run: z.string().min(1).describe("The run id (sr-…)"),
      language: z.string().max(40).optional().describe("The review's language (default English)"),
      refresh: z.boolean().optional().describe("Write a new review even when the run has one"),
    },
    outputSchema: { review: looseObject, run: looseObject.optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    scope: "polpo:work",
  }, async ({ agent, run, language, refresh }) => {
    if (!refresh) {
      const g = await apiGet(deps, `/agents/${enc(agent)}/suite-runs/${enc(run)}`);
      if (!g.ok) return g.status === 404 ? notFound(g, `There is no run "${run}" for ${agent}.`) : apiError(g, "Reading the run");
      const existing = (g.data as Run).review;
      if (existing) return ok(existing.text, { review: existing as unknown as Record<string, unknown> });
    }
    const r = await apiSend(deps, "POST", `/agents/${enc(agent)}/suite-runs/${enc(run)}/review`, language ? { language } : {});
    if (!r.ok) return r.status === 404 ? notFound(r, `There is no run "${run}" for ${agent}.`) : apiError(r, "Reviewing the run");
    const done = r.data as Run;
    return ok(`${done.review?.text ?? ""}\n\n${runHeader(done)}`, { review: (done.review ?? {}) as unknown as Record<string, unknown>, run: { id: done.id, status: done.status } });
  });

  registerPhase4SuiteTools(tool, deps, { isAdmin, suitesLink });
}

// ── phase 4: record / replay (cassettes), case generation, suites of other targets ──

type Cassette = {
  id: string; name: string; suiteId?: string; caseId?: string; revision: number; redactions: number; recordedAt: string; updatedAt: string;
  source: { kind: string; runId?: string; sessionId?: string; taskId?: string; target?: string };
  calls?: Array<{ id: string; turn: number; tool: string; args: Record<string, unknown>; response: string; isError: boolean; edited?: boolean; mock?: boolean }>;
  turns?: Array<{ text: string; toolCalls: Array<{ name: string }> }>;
  callCount?: number; turnCount?: number; tools?: string[];
};

function cassetteText(c: Cassette): string {
  const lines = [`${c.name} [${c.id}] rev ${c.revision} · recorded ${c.recordedAt.slice(0, 16).replace("T", " ")} from ${c.source.kind}${c.source.sessionId ? ` ${c.source.sessionId}` : c.source.taskId ? ` ${c.source.taskId}` : c.source.runId ? ` ${c.source.runId}` : ""}`
    + ` · ${c.calls?.length ?? c.callCount ?? 0} call(s), ${c.turns?.length ?? c.turnCount ?? 0} turn(s) · ${c.redactions} value(s) redacted${c.caseId ? ` · case ${c.suiteId}/${c.caseId}` : ""}`];
  for (const call of c.calls ?? []) {
    lines.push(`- ${call.id} · ${call.tool}${call.mock ? " [now a case mock]" : ""}${call.edited ? " [edited]" : ""} ${short(JSON.stringify(call.args), 200)}`);
    lines.push(`   → ${call.isError ? "ERROR " : ""}${short(call.response, 300)}`);
  }
  return lines.join("\n");
}

type Proposal = { index: number; case?: { id: string; name: string; input: { message: string }; mode?: string; assertions: unknown[]; scorers?: unknown[]; dataset?: string }; dataset?: { id: string; rows: unknown[] }; category?: string; rationale?: string; error?: string };

export function registerPhase4SuiteTools(tool: Register, deps: McpDeps, h: { isAdmin: () => boolean; suitesLink: (agent: string) => string | undefined }): void {
  const notFound = (r: { error?: string }, fallback: string) => fail(r.error ?? fallback);

  tool("team", "polpo_agent_suite_record", {
    title: "Record a case (cassette)",
    description: "Record a case's cassette: case runs it LIVE once (the agent's real model and real tools — side effects possible, admin only) and saves every model turn and tool call "
      + "(arguments and results, secrets redacted: vault values, auth headers, tokens); from then on the case replays it offline and deterministically. Run it again to re-record (calls turned into mocks stay pinned). "
      + "Or turn a REAL exchange into a case and its cassette (no live run, work scope is enough): from_session (a chat with the agent: its last user message, or message_index) or from_task (a task run's activity); the case is added to the suite.",
    inputSchema: {
      agent: z.string().min(1).describe("The agent's name (polpo_agents_list)"),
      suite: z.string().min(1).describe("The suite's id (polpo_agent_suite_list)"),
      case: z.string().optional().describe("The case to record live (its id)"),
      target: z.string().optional().describe("production (default), draft, or a version"),
      from_session: z.string().optional().describe("A chat session id (polpo_chat_sessions_list) with this agent: becomes a case + cassette"),
      from_task: z.string().optional().describe("A task id whose run becomes a case + cassette"),
      message_index: z.number().int().min(0).optional().describe("from_session: the user message to start from (default the last)"),
      name: z.string().optional().describe("The new case's name (from_session / from_task)"),
      wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().describe("How long to wait for a live recording (default 50 s)"),
    },
    outputSchema: { run: looseObject.optional(), case: looseObject.optional(), cassette: looseObject.optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    scope: "polpo:work",
  }, async ({ agent, suite, case: caseId, target, from_session, from_task, message_index, name, wait_seconds }, extra) => {
    if (from_session || from_task) {
      const r = await apiSend(deps, "POST", `/agents/${enc(agent)}/suites/${enc(suite)}/cases/from-recording`, {
        ...(from_session ? { sessionId: from_session } : {}), ...(from_task ? { taskId: from_task } : {}), ...(message_index !== undefined ? { messageIndex: message_index } : {}), ...(name ? { name } : {}),
      });
      if (!r.ok) return r.status === 404 ? notFound(r, `There is no suite "${suite}", chat or task.`) : apiError(r, "Recording the case");
      const out = r.data as { case: { id: string; name: string }; cassette: Cassette };
      return ok(`Added the case ${out.case.name} [${out.case.id}] to ${suite}: it replays the recorded exchange offline (mode all) and checks the same tool calls in order.\n${cassetteText(out.cassette)}\n${h.suitesLink(agent) ?? ""}`,
        { case: out.case as unknown as Record<string, unknown>, cassette: out.cassette as unknown as Record<string, unknown> });
    }
    if (!caseId) return fail("Give case (record it live), or from_session / from_task (a real exchange).");
    if (!h.isAdmin()) return fail("Recording runs the case live with real tools: it needs the admin scope (polpo:admin). Use from_session or from_task to record a real exchange instead.");
    const r = await apiSend(deps, "POST", `/agents/${enc(agent)}/suites/${enc(suite)}/cases/${enc(caseId)}/record`, { ...(target ? { target } : {}), allowRealTools: true });
    if (!r.ok) return r.status === 404 ? notFound(r, `There is no suite "${suite}" or case "${caseId}" for ${agent}.`) : apiError(r, "Recording the case");
    let run = r.data as Run;
    const until = Date.now() + (wait_seconds ?? 50) * 1000;
    while ((run.status === "running" || run.status === "queued") && Date.now() < until && !extra?.signal?.aborted) {
      await sleep(1000, extra?.signal);
      const g = await apiGet(deps, `/agents/${enc(agent)}/suite-runs/${enc(run.id)}`);
      if (g.ok) run = g.data as Run;
    }
    const recorded = (run.results as Array<Result & { trace?: { recorded?: { cassetteId: string; calls: number; turns: number; redactions: number } } }>).map((x) => x.trace?.recorded).filter(Boolean);
    const still = run.status === "running" || run.status === "queued";
    return ok(`${runReport(run)}\n${recorded.map((x) => `cassette ${x!.cassetteId}: ${x!.calls} call(s), ${x!.turns} turn(s), ${x!.redactions} value(s) redacted`).join("\n")}${still ? `\nStill recording: polpo_agent_suite_run_get with run "${run.id}".` : ""}`,
      { run: run as unknown as Record<string, unknown> });
  });

  tool("team", "polpo_agent_suite_replay", {
    title: "Replay cases (cassettes)",
    description: "Run a suite's cases offline against their cassettes (mode all: the recorded model turns and tool results, no cost, no side effects): by default every case that has a cassette. "
      + "A tool call no recording answers is blocked (or fails the case with cassette.onUnmatched: fail). Waits up to wait_seconds and returns the report.",
    inputSchema: {
      agent: z.string().min(1).describe("The agent's name"),
      suite: z.string().min(1).describe("The suite's id"),
      cases: z.array(z.string()).optional().describe("Only these case ids (default: the cases with a cassette)"),
      target: z.string().optional().describe("production (default), draft, or a version"),
      wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().describe("How long to wait (default 50 s)"),
    },
    outputSchema: { run: looseObject },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    scope: "polpo:work",
  }, async ({ agent, suite, cases, target, wait_seconds }, extra) => {
    let ids = cases;
    if (!ids?.length) {
      const s = await apiGet(deps, `/agents/${enc(agent)}/suites/${enc(suite)}`);
      if (!s.ok) return s.status === 404 ? notFound(s, `There is no suite "${suite}" for ${agent}.`) : apiError(s, `Reading ${suite}`);
      ids = (s.data as { cases: Array<{ id: string; mocks?: { cassette?: unknown } }> }).cases.filter((c) => c.mocks?.cassette).map((c) => c.id);
      if (!ids.length) return fail(`No case of ${suite} has a cassette yet: record one with polpo_agent_suite_record.`);
    }
    const r = await apiSend(deps, "POST", `/agents/${enc(agent)}/suites/${enc(suite)}/runs`, { caseIds: ids, mode: "all", ...(target ? { target } : {}) });
    if (!r.ok) return r.status === 404 ? notFound(r, `There is no suite "${suite}" for ${agent}.`) : apiError(r, `Replaying ${suite}`);
    let run = r.data as Run;
    const until = Date.now() + (wait_seconds ?? 50) * 1000;
    while ((run.status === "running" || run.status === "queued") && Date.now() < until && !extra?.signal?.aborted) {
      await sleep(1000, extra?.signal);
      const g = await apiGet(deps, `/agents/${enc(agent)}/suite-runs/${enc(run.id)}`);
      if (g.ok) run = g.data as Run;
    }
    return ok(runReport(run, { diffs: true }), { run: run as unknown as Record<string, unknown> });
  });

  tool("team", "polpo_agent_suite_cassette", {
    title: "Read cassettes",
    description: "An agent's cassettes (recorded exchanges its cases replay): without cassette, the list; with cassette (its id) or suite + case, every recorded call with its arguments and result (secrets redacted).",
    inputSchema: {
      agent: z.string().min(1).describe("The agent's name"),
      cassette: z.string().optional().describe("A cassette id"),
      suite: z.string().optional().describe("With case: the cassette that case replays"),
      case: z.string().optional().describe("A case id (with suite)"),
    },
    outputSchema: { cassettes: z.array(looseObject).optional(), cassette: looseObject.nullable().optional() },
    annotations: READ,
  }, async ({ agent, cassette, suite, case: caseId }) => {
    if (suite && caseId) {
      const r = await apiGet(deps, `/agents/${enc(agent)}/suites/${enc(suite)}/cases/${enc(caseId)}/cassette`);
      if (!r.ok) return r.status === 404 ? notFound(r, `There is no suite "${suite}" or case "${caseId}".`) : apiError(r, "Reading the cassette");
      return r.data ? ok(cassetteText(r.data as Cassette), { cassette: r.data as Record<string, unknown> }) : ok(`${caseId} has no cassette yet: record it with polpo_agent_suite_record.`, { cassette: null });
    }
    if (cassette) {
      const r = await apiGet(deps, `/agents/${enc(agent)}/cassettes/${enc(cassette)}`);
      if (!r.ok) return r.status === 404 ? notFound(r, `There is no cassette "${cassette}" for ${agent}.`) : apiError(r, "Reading the cassette");
      return ok(cassetteText(r.data as Cassette), { cassette: r.data as Record<string, unknown> });
    }
    const r = await apiGet(deps, `/agents/${enc(agent)}/cassettes`);
    if (!r.ok) return r.status === 404 ? notFound(r, `There is no agent "${agent}".`) : apiError(r, "Reading the cassettes");
    const list = r.data as Cassette[];
    return ok(list.length ? list.map((c) => `${c.name} [${c.id}] · ${c.callCount} call(s) (${(c.tools ?? []).join(", ") || "no tools"}) · ${c.redactions} redacted · ${c.updatedAt.slice(0, 16).replace("T", " ")}${c.caseId ? ` · ${c.suiteId}/${c.caseId}` : ""}`).join("\n") : `${agent} has no cassettes yet.`,
      { cassettes: list as unknown as Array<Record<string, unknown>> });
  });

  tool("team", "polpo_agent_suite_cassette_edit", {
    title: "Edit a cassette",
    description: "Edit a cassette's recorded calls: response (a new result; is_error), delete, or mark_as_mock (the call becomes a tool mock of its case, kept on re-recording). delete_cassette: true deletes the whole cassette. "
      + "revision: the one you read (refused if it changed meanwhile).",
    inputSchema: {
      agent: z.string().min(1).describe("The agent's name"),
      cassette: z.string().min(1).describe("The cassette id (polpo_agent_suite_cassette)"),
      edits: z.array(z.object({
        call: z.string().min(1).describe("The call's id"),
        response: z.string().optional(), is_error: z.boolean().optional(), delete: z.boolean().optional(), mark_as_mock: z.boolean().optional(),
      })).optional().describe("Per call: response (a new result, with is_error), delete, or mark_as_mock"),
      delete_cassette: z.boolean().optional().describe("Delete the whole cassette"),
      revision: z.number().int().optional().describe("The cassette revision you read (refused if it changed meanwhile)"),
    },
    outputSchema: { cassette: looseObject.nullable() },
    annotations: WRITE,
    scope: "polpo:work",
  }, async ({ agent, cassette, edits, delete_cassette, revision }) => {
    if (delete_cassette) {
      const r = await apiSend(deps, "DELETE", `/agents/${enc(agent)}/cassettes/${enc(cassette)}`);
      if (!r.ok) return r.status === 404 ? notFound(r, `There is no cassette "${cassette}".`) : apiError(r, "Deleting the cassette");
      return ok(`Deleted the cassette ${cassette}: the cases that replayed it block their tool calls until recorded again.`, { cassette: null });
    }
    if (!edits?.length) return fail("Give edits (call + response / delete / mark_as_mock) or delete_cassette.");
    const r = await apiSend(deps, "PATCH", `/agents/${enc(agent)}/cassettes/${enc(cassette)}`, {
      edits: edits.map((e) => ({ callId: e.call, ...(e.response !== undefined ? { response: e.response } : {}), ...(e.is_error !== undefined ? { isError: e.is_error } : {}), ...(e.delete ? { delete: true } : {}), ...(e.mark_as_mock ? { markAsMock: true } : {}) })),
      ...(revision !== undefined ? { revision } : {}),
    });
    if (!r.ok) return r.status === 404 ? notFound(r, `There is no cassette "${cassette}" (or no such call).`) : apiError(r, "Editing the cassette");
    return ok(`Saved.\n${cassetteText(r.data as Cassette)}`, { cassette: r.data as Record<string, unknown> });
  });

  tool("team", "polpo_agent_suite_generate", {
    title: "Generate cases (AI)",
    description: "Polpo's model proposes test cases for an agent from its instructions, tools, skills and connectors (and brief, sample chats): input, mocks, assertions, scorers, dataset rows — happy paths, "
      + "edge cases and adversarial / prompt-injection ones. Proposals are NOT saved: show them to the person, then send the ones they accept with accept (the case objects, and their datasets). "
      + "rows_for_case: propose dataset rows for one case instead. Costs tokens.",
    inputSchema: {
      agent: z.string().min(1).describe("The agent's name"),
      suite: z.string().optional().describe("The suite the cases are for (required with accept / rows_for_case)"),
      count: z.number().int().min(1).max(20).optional().describe("How many cases (default 6)"),
      brief: z.string().max(4000).optional().describe("What to focus on"),
      sessions: z.array(z.string()).max(5).optional().describe("Chat session ids with the agent to draw from"),
      include: z.array(z.enum(["happy", "edge", "adversarial"])).optional().describe("Kinds of cases (default all): happy paths, edge cases, adversarial / prompt injection"),
      style: z.enum(["contract", "tools"]).optional().describe("contract (default, offline) or tools (real model, mocked tools)"),
      accept: z.object({ cases: z.array(looseObject).min(1), datasets: z.array(looseObject).optional() }).optional().describe("Add these accepted cases (and datasets) to suite"),
      rows_for_case: z.string().optional().describe("A case id: propose rows for its dataset"),
      rows: z.number().int().min(1).max(50).optional().describe("How many rows (rows_for_case)"),
    },
    outputSchema: { proposals: z.array(looseObject).optional(), suite: looseObject.optional(), rows: z.array(looseObject).optional(), columns: z.array(z.string()).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    scope: "polpo:work",
  }, async ({ agent, suite, count, brief, sessions, include, style, accept, rows_for_case, rows }) => {
    if (accept) {
      if (!suite) return fail("accept needs suite (the suite to add the cases to).");
      const r = await apiSend(deps, "POST", `/agents/${enc(agent)}/suites/${enc(suite)}/cases`, accept);
      if (!r.ok) return r.status === 404 ? notFound(r, `There is no suite "${suite}" for ${agent}.`) : apiError(r, "Adding the cases");
      const s = r.data as Suite;
      return ok(`Added ${accept.cases.length} case(s) to ${s.name} [${s.id}] rev ${s.revision}: ${s.cases.length} case(s) now. Run it with polpo_agent_suite_run.`, { suite: s as unknown as Record<string, unknown> });
    }
    if (rows_for_case) {
      if (!suite) return fail("rows_for_case needs suite.");
      const r = await apiSend(deps, "POST", `/agents/${enc(agent)}/suites/${enc(suite)}/datasets/generate`, { caseId: rows_for_case, ...(rows ? { count: rows } : {}), ...(brief ? { brief } : {}) });
      if (!r.ok) return r.status === 404 ? notFound(r, `There is no suite "${suite}" or case "${rows_for_case}".`) : apiError(r, "Generating rows");
      const d = r.data as { datasetId?: string; columns: string[]; rows: Array<Record<string, unknown>> };
      return ok(`Proposed ${d.rows.length} row(s)${d.datasetId ? ` for the dataset ${d.datasetId}` : ""} (not saved: import the ones you keep with polpo_agent_suite_save import_dataset):\n${d.rows.map((x) => JSON.stringify(x)).join("\n")}`,
        { rows: d.rows, columns: d.columns });
    }
    const r = await apiSend(deps, "POST", `/agents/${enc(agent)}/suites/generate-cases`, {
      ...(suite ? { suiteId: suite } : {}), ...(count ? { count } : {}), ...(brief ? { brief } : {}), ...(sessions?.length ? { sessionIds: sessions } : {}), ...(include ? { include } : {}), ...(style ? { style } : {}),
    });
    if (!r.ok) return r.status === 404 ? notFound(r, `There is no agent "${agent}".`) : apiError(r, "Generating cases");
    const out = r.data as { proposals: Proposal[]; model?: string };
    const lines = out.proposals.map((p) => p.case
      ? `${p.index}. [${p.category ?? "case"}] ${p.case.name} [${p.case.id}] — "${short(p.case.input.message, 160)}" · ${p.case.assertions.length} assertion(s)${p.case.scorers?.length ? `, ${p.case.scorers.length} scorer(s)` : ""}${p.dataset ? `, ${p.dataset.rows.length} row(s)` : ""}${p.rationale ? `\n   why: ${short(p.rationale, 300)}` : ""}`
      : `${p.index}. ✗ invalid: ${p.error}`);
    return ok(`${out.proposals.length} proposal(s)${out.model ? ` by ${out.model}` : ""} — NOT saved. Ask the person which to keep, then call again with accept: { cases: [...], datasets: [...] }${suite ? "" : " and suite"}.\n${lines.join("\n")}`,
      { proposals: out.proposals as unknown as Array<Record<string, unknown>> });
  });

  // ── suites of a hosted MCP server (its saved tests) or a mission ──

  const base = (kind: "mcp-server" | "mission", id: string) => `${kind === "mcp-server" ? "/mcp-servers" : "/missions"}/${enc(id)}`;
  const targetSchema = {
    kind: z.enum(["mcp-server", "mission"]).describe("mcp-server: a hosted MCP server (its saved tests are its suite); mission: a mission (run in test mode with every agent mocked)"),
    id: z.string().min(1).describe("The hosted server's id or the mission's id"),
  };

  tool("team", "polpo_target_suites", {
    title: "Suites of a hosted server or a mission",
    description: "The suites of a hosted MCP server (one: its saved tests — each calls a tool with arguments, its upstream API answered by HTTP mocks) or of a mission (cases that run its tasks in dependency order, "
      + "each agent with its own mocks, checking task outcomes, order and who did what), with their latest runs. With run: that run's report (or case: one case's trace).",
    inputSchema: { ...targetSchema, run: z.string().optional().describe("A run id: its report"), case: z.string().optional().describe("With run: a case's trace") },
    outputSchema: { suites: z.array(looseObject).optional(), run: looseObject.optional(), result: looseObject.optional() },
    annotations: READ,
  }, async ({ kind, id, run, case: caseKey }) => {
    if (run) {
      const r = await apiGet(deps, `${base(kind, id)}/suite-runs/${enc(run)}`);
      if (!r.ok) return r.status === 404 ? notFound(r, `There is no run "${run}".`) : apiError(r, "Reading the run");
      const full = r.data as Run;
      if (caseKey) {
        const c = full.results.find((x) => x.key === caseKey || x.key.split("#")[0] === caseKey);
        if (!c) return fail(`The run has no case "${caseKey}"`);
        return ok(caseTrace(c), { result: c as unknown as Record<string, unknown> });
      }
      return ok(runReport(full, { diffs: true }), { run: full as unknown as Record<string, unknown> });
    }
    const r = await apiGet(deps, `${base(kind, id)}/suites`);
    if (!r.ok) return r.status === 404 ? notFound(r, `There is no ${kind === "mcp-server" ? "hosted server" : "mission"} "${id}".`) : apiError(r, "Reading the suites");
    const suites = r.data as Suite[];
    const runs = await apiGet(deps, `${base(kind, id)}/suite-runs${qs({ limit: "30" })}`);
    const latest = new Map<string, Run>();
    for (const x of (runs.ok ? runs.data as Run[] : [])) if (!latest.has(x.suiteId)) latest.set(x.suiteId, x);
    return ok(suites.length ? suites.map((s) => {
      const last = latest.get(s.id);
      return `${s.name} [${s.id}] · ${s.cases.length} case(s)${gateLine(s.gate)}${last ? ` · last ${MARK[last.status] ?? ""} ${last.status} ${last.stats.passed}/${last.stats.total - last.stats.skipped} (${last.id})` : " · never run"}`;
    }).join("\n") : `No suites yet: create one with polpo_target_suite_save.`, { suites: suites.map((s) => ({ ...s, lastRun: latest.get(s.id) ?? null })) as unknown as Array<Record<string, unknown>> });
  });

  tool("team", "polpo_target_suite_save", {
    title: "Save a hosted server's or a mission's suite",
    description: "Save a suite of a hosted MCP server or a mission (same shape as polpo_agent_suite_save). Hosted server: one suite, id saved-tests (its saved tests: cases { name, input: { kind: tool, tool, args }, "
      + "mocks?: { http: [{ method?, url (glob or substring), status?, body? }] }, assertions: [tool_failed, http_called, text_contains, …] }, mocks.http shared, gate: { required } to gate its deploys). "
      + "Mission: cases { name, input: { kind: mission, message? }, mocks: { agents: { <agent>: { model?, tools? } } }, assertions: [task_status, task_order, task_agent, tool_called with agent, artifact_created, …], budgets }.",
    inputSchema: { ...targetSchema, suite: looseObject.describe("The suite"), revision: z.number().int().optional().describe("The revision you edited (refused if it changed meanwhile)") },
    outputSchema: { suite: looseObject },
    annotations: WRITE,
    scope: "polpo:work",
  }, async ({ kind, id, suite, revision }) => {
    const sid = typeof suite.id === "string" ? suite.id : kind === "mcp-server" ? "saved-tests" : undefined;
    const body = { ...suite, ...(revision !== undefined ? { revision } : {}) };
    const r = sid ? await apiSend(deps, "PUT", `${base(kind, id)}/suites/${enc(sid)}`, body) : await apiSend(deps, "POST", `${base(kind, id)}/suites`, body);
    if (!r.ok) return r.status === 404 ? notFound(r, `There is no ${kind === "mcp-server" ? "hosted server" : "mission"} "${id}".`) : apiError(r, "Saving the suite");
    const s = r.data as Suite;
    return ok(`Saved ${s.name} [${s.id}] rev ${s.revision}: ${s.cases.length} case(s)${gateLine(s.gate)}. Run it with polpo_target_suite_run.`, { suite: s as unknown as Record<string, unknown> });
  });

  tool("team", "polpo_target_suite_run", {
    title: "Run a hosted server's or a mission's suite",
    description: "Run a suite of a hosted MCP server (target: draft by default, production or a version; HTTP mocked in mode all) or of a mission (its agents' production versions, each with its mocks). "
      + "Real HTTP or real tools need the admin scope. Waits up to wait_seconds and returns the report.",
    inputSchema: {
      ...targetSchema,
      suite: z.string().optional().describe("The suite id (a hosted server: saved-tests, the default)"),
      target: z.string().optional().describe("Hosted server: draft (default), production or a version"),
      cases: z.array(z.string()).optional().describe("Only these case ids"),
      mode: z.enum(["none", "tools", "model", "all"]).optional().describe("Run every case in this mode (default each case's own; all: HTTP and tools mocked)"),
      wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().describe("How long to wait for the run (default 50 s)"),
    },
    outputSchema: { run: looseObject },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    scope: "polpo:work",
  }, async ({ kind, id, suite, target, cases, mode, wait_seconds }, extra) => {
    const sid = suite ?? (kind === "mcp-server" ? "saved-tests" : undefined);
    if (!sid) return fail("Give suite (polpo_target_suites).");
    const r = await apiSend(deps, "POST", `${base(kind, id)}/suites/${enc(sid)}/runs`, {
      ...(target ? { target } : {}), ...(cases?.length ? { caseIds: cases } : {}), ...(mode ? { mode } : {}), ...(h.isAdmin() ? { allowRealTools: true } : {}),
    });
    if (!r.ok) {
      if (r.status === 403) return fail(`${r.error}${h.isAdmin() ? "" : " This connection does not have the admin scope (polpo:admin)."}`);
      return r.status === 404 ? notFound(r, `There is no ${kind} "${id}" or suite "${sid}".`) : apiError(r, `Running ${sid}`);
    }
    let run = r.data as Run;
    const until = Date.now() + (wait_seconds ?? 50) * 1000;
    while ((run.status === "running" || run.status === "queued") && Date.now() < until && !extra?.signal?.aborted) {
      await sleep(1000, extra?.signal);
      const g = await apiGet(deps, `${base(kind, id)}/suite-runs/${enc(run.id)}`);
      if (g.ok) run = g.data as Run;
    }
    return ok(runReport(run, { diffs: true }), { run: run as unknown as Record<string, unknown> });
  });
}
