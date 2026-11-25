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
type ToolCall = { name: string; args: Record<string, unknown>; result: string; isError: boolean; mocked: string | false; mockId?: string; approval?: string };
type Result = {
  key: string; caseName: string; status: string; mode: string; engine: string; error?: string; durationMs: number; costUsd: number;
  assertions?: Assertion[]; failed?: string[];
  trace?: { turns: Array<{ text: string; mocked: boolean; toolCalls: Array<{ name: string }> }>; toolCalls: ToolCall[]; text: string; finishReason?: string; approvals: Array<{ tool: string; kind: string }>; notes: string[] };
};
type Run = {
  id: string; agent: string; suiteId: string; suiteName: string; target: string; version?: string; status: string; startedAt: string; finishedAt?: string;
  variant: { id: string; label?: string }; benchmarkRunId?: string; planned: string[]; results: Result[]; notes: string[]; error?: string;
  stats: { total: number; passed: number; failed: number; errored: number; skipped: number; passRate: number; costUsd: number; durationMs: number };
};
type Suite = { id: string; name: string; description?: string; defaultMode: string; revision: number; cases: Array<{ id: string; name: string; mode?: string; dataset?: string; assertions: unknown[] }>; datasets: Array<{ id: string; name: string; rows: unknown[] }>; updatedAt: string };

const MARK: Record<string, string> = { passed: "✓", failed: "✗", errored: "‼", skipped: "–", running: "…", queued: "…", cancelled: "⊘" };
const usd = (n: number) => `$${n.toFixed(4)}`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function runHeader(r: Run): string {
  const target = r.target === "production" ? `production${r.version ? ` (v${r.version})` : ""}` : r.target === "draft" ? "draft" : `v${r.target}`;
  return `${MARK[r.status] ?? r.status} ${r.agent} · ${r.suiteName} @ ${target}${r.variant.label ? ` · ${r.variant.label}` : ""} · ${r.status} · `
    + `${r.stats.passed}/${r.stats.total - r.stats.skipped} passed · ${usd(r.stats.costUsd)} · ${secs(r.stats.durationMs)} [${r.id}]`;
}

/** The report of a run: one line per case, the failed assertions with their messages and diffs. */
function runReport(r: Run, opts: { diffs?: boolean } = {}): string {
  const lines = [runHeader(r)];
  if (r.error) lines.push(`Error: ${r.error}`);
  for (const n of r.notes) lines.push(`note: ${n}`);
  for (const c of r.results) {
    const tools = c.trace ? ` · tools: ${c.trace.toolCalls.map((t) => `${t.name}${t.mocked ? `(${t.mocked})` : ""}`).join(", ") || "none"}` : "";
    lines.push(`${MARK[c.status] ?? c.status} ${c.key} — ${c.caseName} [${c.mode}, ${c.engine}] ${secs(c.durationMs)} ${usd(c.costUsd)}${tools}`);
    if (c.error) lines.push(`   error: ${short(c.error, 400)}`);
    for (const a of c.assertions?.filter((x) => !x.passed) ?? []) {
      lines.push(`   ✗ ${a.description}: ${short(a.message, 400)}`);
      if (opts.diffs && a.diff) lines.push(...a.diff.split("\n").slice(0, 30).map((l) => `      ${l}`));
    }
    for (const f of c.failed ?? []) lines.push(`   ✗ ${f}`);
  }
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
  lines.push(`reply: ${short(t.text, 1200) || "—"}`);
  if (t.finishReason) lines.push(`finish: ${t.finishReason}`);
  for (const n of t.notes) lines.push(`note: ${n}`);
  for (const a of c.assertions ?? []) {
    lines.push(`${a.passed ? "✓" : "✗"} ${a.description}: ${short(a.message, 300)}`);
    if (!a.passed && a.diff) lines.push(...a.diff.split("\n").slice(0, 40).map((l) => `   ${l}`));
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
    for (const run of (runs.ok ? runs.data as Run[] : [])) if (!latest.has(run.suiteId)) latest.set(run.suiteId, run);
    if (!suites.length) return ok(`${agent} has no suites yet. Create one with polpo_agent_suite_save (${suitesLink(agent)}).`, { suites: [] });
    return ok(suites.map((s) => {
      const last = latest.get(s.id);
      return `${s.name} [${s.id}] · ${s.cases.length} case(s), ${s.datasets.length} dataset(s), mode ${s.defaultMode} · rev ${s.revision}`
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
      + "assertions: [{ type: tool_called | tool_not_called | tool_order | tool_args | no_tool_errors | outcome_registered | artifact_created | approval_requested | text_contains | text_not_contains | text_regex | max_turns | max_cost | max_duration, ... }] }] }. "
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
      + "compare variants by running the same suite with different overrides and labels. Waits up to wait_seconds (default 50) and returns the report; "
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
      wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().describe("How long to wait for the run (default 50 s)"),
      cancel: z.string().optional().describe("Stop this running run (its id) instead of starting one"),
    },
    outputSchema: { run: looseObject },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    scope: "polpo:work",
  }, async ({ agent, suite, target, cases, mode, overrides, label, concurrency, wait_seconds, cancel }, extra) => {
    if (cancel) {
      const c = await apiSend(deps, "POST", `/agents/${enc(agent)}/suite-runs/${enc(cancel)}/cancel`);
      if (!c.ok) return c.status === 404 ? notFound(c, `There is no run "${cancel}".`) : apiError(c, "Cancelling the run");
      return ok(runReport(c.data as Run), { run: c.data as Record<string, unknown> });
    }
    const admin = isAdmin();
    const r = await apiSend(deps, "POST", `/agents/${enc(agent)}/suites/${enc(suite)}/runs`, {
      ...(target ? { target } : {}), ...(cases?.length ? { caseIds: cases } : {}), ...(mode ? { mode } : {}), ...(overrides ? { overrides } : {}),
      ...(label ? { variant: { label } } : {}), ...(concurrency ? { concurrency } : {}),
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
}
