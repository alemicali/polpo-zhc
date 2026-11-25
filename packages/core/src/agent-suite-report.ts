/**
 * Agent suites, phase 4 — reports for CI (`polpo test`, the GitHub Action): JUnit XML, a Markdown
 * summary (a job summary or a PR comment), plain text, and the exit code. Pure.
 */
import type { SuiteRun, SuiteRunSummary } from "./agent-suites.js";

/** A run as the CLI reads it (full or summarized). */
export type ReportRun = Pick<SuiteRun, "id" | "agent" | "suiteId" | "suiteName" | "target" | "version" | "status" | "startedAt" | "finishedAt" | "stats" | "notes" | "error" | "targetKind"> & {
  results: Array<Pick<SuiteRunSummary["results"][number], "key" | "caseName" | "status" | "durationMs" | "costUsd" | "error" | "score"> & {
    failed?: string[];
    assertions?: Array<{ description: string; passed: boolean; message: string }>;
    scores?: Array<{ id: string; description?: string; score: number; threshold: number; passed: boolean; reason?: string; error?: string }>;
  }>;
  aggregates?: { score?: number };
  baseline?: { regressions: number; improvements: number; runId: string; cases?: Array<{ key: string; caseName: string; change: string; reasons: string[] }> };
};

export interface SuiteReportOptions {
  /** A regression versus the baseline fails the build too. */
  failOnRegression?: boolean;
}

/** Why a case failed, in words (failed assertions and scorers, or its error). */
export function caseFailures(r: ReportRun["results"][number]): string[] {
  if (r.failed?.length) return [...(r.error ? [r.error] : []), ...r.failed];
  return [
    ...(r.error ? [r.error] : []),
    ...(r.assertions ?? []).filter((a) => !a.passed).map((a) => `${a.description}: ${a.message}`),
    ...(r.scores ?? []).filter((x) => !x.passed).map((x) => `${x.description ?? x.id}: ${x.score.toFixed(2)} < ${x.threshold}${x.error ? ` (${x.error})` : x.reason ? ` — ${x.reason}` : ""}`),
  ];
}

/** The verdict of a set of runs: pass, or what failed (runs not passed; regressions with failOnRegression). */
export function suiteReportVerdict(runs: ReportRun[], opts: SuiteReportOptions = {}): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!runs.length) reasons.push("no suite ran");
  for (const r of runs) {
    const label = `${r.agent} · ${r.suiteName}`;
    if (r.status === "running" || r.status === "queued") reasons.push(`${label}: still ${r.status}`);
    else if (r.status !== "passed") reasons.push(`${label}: ${r.status}${r.error ? ` (${r.error})` : ` — ${r.stats.failed} failed, ${r.stats.errored} errored`}`);
    if (opts.failOnRegression && (r.baseline?.regressions ?? 0) > 0) reasons.push(`${label}: ${r.baseline!.regressions} regression(s) versus ${r.baseline!.runId}`);
  }
  return { passed: reasons.length === 0, reasons };
}

/** The exit code: 0 passed, 1 failed (a run failed, errored or was cancelled; a regression with failOnRegression). */
export function suiteReportExitCode(runs: ReportRun[], opts: SuiteReportOptions = {}): 0 | 1 {
  return suiteReportVerdict(runs, opts).passed ? 0 : 1;
}

const xml = (s: unknown) => String(s ?? "")
  // characters XML 1.0 does not allow
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const targetLabel = (r: Pick<ReportRun, "target" | "version">) => r.target === "production" ? `production${r.version ? ` v${r.version}` : ""}` : r.target === "draft" ? "draft" : `v${r.target}`;

/** JUnit XML: one testsuite per run, one testcase per case (failure, error or skipped). */
export function suiteRunsJunit(runs: ReportRun[], opts: { name?: string } = {}): string {
  const total = runs.reduce((a, r) => ({
    tests: a.tests + r.results.length, failures: a.failures + r.stats.failed, errors: a.errors + r.stats.errored + (r.error ? 1 : 0), skipped: a.skipped + r.stats.skipped, time: a.time + r.stats.durationMs,
  }), { tests: 0, failures: 0, errors: 0, skipped: 0, time: 0 });
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${xml(opts.name ?? "Polpo suites")}" tests="${total.tests}" failures="${total.failures}" errors="${total.errors}" skipped="${total.skipped}" time="${(total.time / 1000).toFixed(3)}">`,
  ];
  for (const r of runs) {
    const name = `${r.agent}/${r.suiteName} @ ${targetLabel(r)}`;
    lines.push(`  <testsuite name="${xml(name)}" id="${xml(r.id)}" tests="${r.results.length}" failures="${r.stats.failed}" errors="${r.stats.errored + (r.error ? 1 : 0)}" skipped="${r.stats.skipped}" time="${(r.stats.durationMs / 1000).toFixed(3)}" timestamp="${xml(r.startedAt)}">`);
    lines.push(`    <properties><property name="run" value="${xml(r.id)}"/><property name="status" value="${xml(r.status)}"/><property name="target" value="${xml(targetLabel(r))}"/>${r.aggregates?.score !== undefined ? `<property name="score" value="${r.aggregates.score.toFixed(4)}"/>` : ""}<property name="costUsd" value="${r.stats.costUsd}"/></properties>`);
    if (r.error) lines.push(`    <testcase classname="${xml(`${r.agent}.${r.suiteId}`)}" name="(run)" time="0"><error message="${xml(r.error)}">${xml(r.error)}</error></testcase>`);
    for (const c of r.results) {
      const open = `    <testcase classname="${xml(`${r.agent}.${r.suiteId}`)}" name="${xml(`${c.caseName} [${c.key}]`)}" time="${(c.durationMs / 1000).toFixed(3)}"`;
      const why = caseFailures(c);
      if (c.status === "passed") lines.push(`${open}/>`);
      else if (c.status === "skipped") lines.push(`${open}><skipped${c.error ? ` message="${xml(c.error)}"` : ""}/></testcase>`);
      else if (c.status === "errored") lines.push(`${open}><error message="${xml(why[0] ?? "errored")}">${xml(why.join("\n"))}</error></testcase>`);
      else lines.push(`${open}><failure message="${xml(why[0] ?? "failed")}" type="assertion">${xml(why.join("\n"))}</failure></testcase>`);
    }
    lines.push("  </testsuite>");
  }
  lines.push("</testsuites>");
  return `${lines.join("\n")}\n`;
}

const MARK: Record<string, string> = { passed: "✓", failed: "✗", errored: "‼", skipped: "–", running: "…", queued: "…", cancelled: "⊘" };
const usd = (n: number) => `$${n.toFixed(4)}`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Plain text (the terminal): a line per run, the failed cases with why. */
export function suiteRunsText(runs: ReportRun[], opts: SuiteReportOptions = {}): string {
  const lines: string[] = [];
  for (const r of runs) {
    lines.push(`${MARK[r.status] ?? r.status} ${r.agent} · ${r.suiteName} @ ${targetLabel(r)} · ${r.stats.passed}/${r.stats.total - r.stats.skipped} passed`
      + `${r.aggregates?.score !== undefined ? ` · score ${r.aggregates.score.toFixed(2)}` : ""} · ${usd(r.stats.costUsd)} · ${secs(r.stats.durationMs)}`
      + `${r.baseline ? ` · ${r.baseline.regressions} regression(s)` : ""} [${r.id}]`);
    if (r.error) lines.push(`   error: ${r.error}`);
    for (const c of r.results.filter((x) => x.status === "failed" || x.status === "errored")) {
      lines.push(`   ${MARK[c.status]} ${c.caseName} [${c.key}]`);
      for (const f of caseFailures(c).slice(0, 5)) lines.push(`      ${f.slice(0, 300)}`);
    }
    for (const c of r.baseline?.cases?.filter((x) => x.change === "regressed") ?? []) lines.push(`   ▼ ${c.caseName} [${c.key}]: ${c.reasons.join("; ")}`);
  }
  const v = suiteReportVerdict(runs, opts);
  lines.push("", v.passed ? `PASSED: ${runs.length} suite run(s)` : `FAILED: ${v.reasons.join("; ")}`);
  return lines.join("\n");
}

/** Markdown (a GitHub job summary or PR comment): a table of runs, then the failed cases. */
export function suiteRunsMarkdown(runs: ReportRun[], opts: SuiteReportOptions & { title?: string; links?: (run: ReportRun) => string | undefined } = {}): string {
  const v = suiteReportVerdict(runs, opts);
  const lines = [
    `## ${v.passed ? "✅" : "❌"} ${opts.title ?? "Polpo suites"}`,
    "",
    "| | Suite | Target | Passed | Score | Regressions | Cost | Time |",
    "|---|---|---|---|---|---|---|---|",
    ...runs.map((r) => {
      const link = opts.links?.(r);
      const name = `${r.agent} · ${r.suiteName}`.replace(/\|/g, "\\|");
      return `| ${MARK[r.status] ?? r.status} | ${link ? `[${name}](${link})` : name} | ${targetLabel(r)} | ${r.stats.passed}/${r.stats.total - r.stats.skipped} | ${r.aggregates?.score !== undefined ? r.aggregates.score.toFixed(2) : "—"} | ${r.baseline ? r.baseline.regressions : "—"} | ${usd(r.stats.costUsd)} | ${secs(r.stats.durationMs)} |`;
    }),
  ];
  const failed = runs.flatMap((r) => r.results.filter((c) => c.status === "failed" || c.status === "errored").map((c) => ({ r, c })));
  if (failed.length) {
    lines.push("", "<details><summary>Failed cases</summary>", "");
    for (const { r, c } of failed.slice(0, 50)) {
      lines.push(`- **${r.suiteName} › ${c.caseName}** \`${c.key}\``);
      for (const f of caseFailures(c).slice(0, 4)) lines.push(`  - ${f.slice(0, 300).replace(/\n/g, " ")}`);
    }
    lines.push("", "</details>");
  }
  if (!v.passed) lines.push("", ...v.reasons.map((x) => `- ${x}`));
  return `${lines.join("\n")}\n`;
}
