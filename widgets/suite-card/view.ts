/**
 * The agent suite card's view: DOM from a card (src/server/mcp-suite-card.ts) with no host wiring,
 * so it can be tested in a DOM (ui/tests/mcp-widgets.test.ts). main.ts connects it to the MCP host.
 *
 *   suites   each suite with its last run (pass rate, score, regressions), baseline and whether it
 *            gates deploys (required); the latest deploy gates (verifying, passed, blocked, override)
 *   run      the report: pass rate, score, cost; scores per scorer with the delta versus the
 *            baseline; each case with its failed checks, its change (▼ regressed, ▲ improved), flaky
 *            cases; the AI review
 *   trend    the suite's runs over time as a chart (pass rate and score), and by version
 *   benchmark  a benchmark run: progress and spend, the leaderboard (Pareto front ◆, noise notes) and
 *            the case × variant matrix; a row opens the case side by side
 *   compare  one case for 2–4 variants in columns: tool calls (= same, ~ other arguments, + extra,
 *            − missing) and the answers with the words added and removed highlighted
 */
import type { BenchmarkCard, CompareCard, SuiteCard, SuiteListCard, SuiteRunCard, SuiteTrendCard } from "../../src/server/mcp-suite-card.js";

export const STRINGS = {
  en: {
    open: "Open", refresh: "Refresh", ask: "Explain this run", askSuites: "Ask about it", trend: "Trend", report: "Latest run", suitesTitle: "Suites",
    explain: (suite: string, run: string) => `Explain the run ${run} of the suite "${suite}": what failed or regressed and why, and what I should change (use polpo_agent_suite_review).`,
    askAbout: (agent: string) => `How are ${agent}'s test and eval suites doing?`,
    noSuites: "No suites yet", neverRun: "never run", cases: (n: number) => `${n} case${n === 1 ? "" : "s"}`, scorers: (n: number) => `${n} scorer${n === 1 ? "" : "s"}`,
    passRate: "Pass rate", score: "Score", cost: "Cost", duration: "Duration", baseline: "Baseline", isBaseline: "Baseline", vsBaseline: "vs baseline",
    regressions: (n: number) => `${n} regression${n === 1 ? "" : "s"}`, improvements: (n: number) => `${n} improvement${n === 1 ? "" : "s"}`,
    scorersTitle: "Scores", casesTitle: "Cases", reviewTitle: "AI review", notes: "Notes", byVersion: "By version", runs: (n: number) => `${n} run${n === 1 ? "" : "s"}`,
    mean: "mean", median: "median", p10: "p10", flaky: "flaky", attempts: (n: number) => `${n} attempts`, noRuns: "No finished runs yet",
    change: { regressed: "Regressed", improved: "Improved", new: "New", removed: "Removed", unchanged: "" } as Record<string, string>,
    status: { passed: "Passed", failed: "Failed", errored: "Errored", skipped: "Skipped", running: "Running", queued: "Queued", cancelled: "Cancelled" } as Record<string, string>,
    legendPass: "Pass rate", legendScore: "Score", error: "Could not load the card", superseded: "There is a newer card for this below",
    required: "Required to deploy", gatesTitle: "Deploy gates", onPublish: "also on publish",
    conversation: "Conversation", simulated: "simulated", replayed: (n: number) => `↺ replayed ${n} call${n === 1 ? "" : "s"}`, unmatched: (n: number) => `${n} unmatched`,
    recorded: "● recorded", cassettes: (n: number) => `${n} replaying a cassette`, multiTurn: (n: number) => `${n} multi-turn`, stoppedBy: "stopped by",
    roles: "Roles", role: { judge: "judge", simulator: "simulated user", generator: "generator", reviewer: "reviewer" } as Record<string, string>,
    gateStatus: { running: "Verifying", passed: "Passed", blocked: "Blocked", failed: "Failed", override: "Override", cancelled: "Cancelled", errored: "Errored" } as Record<string, string>,
    leaderboard: "Leaderboard", matrix: "Case × variant", pareto: "Pareto front", quality: "Quality", latency: "Latency p50", spent: "Spent", progress: "Runs",
    sideBySide: "Side by side", back: "Leaderboard", askBench: "Which variant is best?", missing: "missing", answer: "Answer", toolCalls: "Tool calls", noTools: "no tool calls",
    askBenchmark: (name: string, run: string) => `Which variant of the benchmark "${name}" (${run}) is best, and is the difference real or noise? (use polpo_benchmark_get)`,
    askCompare: (c: string, run: string) => `Why do the variants differ on the case ${c} of the benchmark run ${run}? (use polpo_benchmark_compare)`,
    benchStatus: { queued: "Queued", running: "Running", completed: "Completed", cancelled: "Cancelled", errored: "Errored" } as Record<string, string>,
    cell: { passed: "✓", failed: "✗", mixed: "≈", errored: "‼", skipped: "–", missing: "" } as Record<string, string>,
    moreRows: (n: number) => `${n} more case${n === 1 ? "" : "s"}`,
  },
  it: {
    open: "Apri", refresh: "Aggiorna", ask: "Spiega questo run", askSuites: "Chiedi", trend: "Andamento", report: "Ultimo run", suitesTitle: "Suite",
    explain: (suite: string, run: string) => `Spiegami il run ${run} della suite "${suite}": cosa è fallito o peggiorato e perché, e cosa dovrei cambiare (usa polpo_agent_suite_review).`,
    askAbout: (agent: string) => `Come stanno andando le suite di test ed eval di ${agent}?`,
    noSuites: "Ancora nessuna suite", neverRun: "mai eseguita", cases: (n: number) => `${n} cas${n === 1 ? "o" : "i"}`, scorers: (n: number) => `${n} scorer`,
    passRate: "Superati", score: "Punteggio", cost: "Costo", duration: "Durata", baseline: "Baseline", isBaseline: "Baseline", vsBaseline: "rispetto alla baseline",
    regressions: (n: number) => `${n} regression${n === 1 ? "e" : "i"}`, improvements: (n: number) => `${n} miglioram${n === 1 ? "ento" : "enti"}`,
    scorersTitle: "Punteggi", casesTitle: "Casi", reviewTitle: "Analisi AI", notes: "Note", byVersion: "Per versione", runs: (n: number) => `${n} run`,
    mean: "media", median: "mediana", p10: "p10", flaky: "instabile", attempts: (n: number) => `${n} tentativi`, noRuns: "Ancora nessun run concluso",
    change: { regressed: "Peggiorato", improved: "Migliorato", new: "Nuovo", removed: "Rimosso", unchanged: "" } as Record<string, string>,
    status: { passed: "Superato", failed: "Fallito", errored: "Errore", skipped: "Saltato", running: "In corso", queued: "In coda", cancelled: "Annullato" } as Record<string, string>,
    legendPass: "Superati", legendScore: "Punteggio", error: "Non riesco a caricare la scheda", superseded: "C'è una scheda più recente più sotto",
    required: "Obbligatoria per il deploy", gatesTitle: "Verifiche di deploy", onPublish: "anche alla pubblicazione",
    conversation: "Conversazione", simulated: "simulato", replayed: (n: number) => `↺ ${n} chiamat${n === 1 ? "a riprodotta" : "e riprodotte"}`, unmatched: (n: number) => `${n} senza registrazione`,
    recorded: "● registrato", cassettes: (n: number) => `${n} con cassetta`, multiTurn: (n: number) => `${n} multi-turno`, stoppedBy: "fermato da",
    roles: "Ruoli", role: { judge: "giudice", simulator: "utente simulato", generator: "generatore", reviewer: "revisore" } as Record<string, string>,
    gateStatus: { running: "In verifica", passed: "Superata", blocked: "Bloccato", failed: "Fallita", override: "Forzato", cancelled: "Annullata", errored: "Errore" } as Record<string, string>,
    leaderboard: "Classifica", matrix: "Caso × variante", pareto: "Fronte di Pareto", quality: "Qualità", latency: "Latenza p50", spent: "Speso", progress: "Run",
    sideBySide: "Affiancati", back: "Classifica", askBench: "Qual è la variante migliore?", missing: "mancante", answer: "Risposta", toolCalls: "Chiamate ai tool", noTools: "nessuna chiamata",
    askBenchmark: (name: string, run: string) => `Qual è la variante migliore del benchmark "${name}" (${run}), e la differenza è reale o rumore? (usa polpo_benchmark_get)`,
    askCompare: (c: string, run: string) => `Perché le varianti si comportano diversamente sul caso ${c} del benchmark ${run}? (usa polpo_benchmark_compare)`,
    benchStatus: { queued: "In coda", running: "In corso", completed: "Concluso", cancelled: "Annullato", errored: "Errore" } as Record<string, string>,
    cell: { passed: "✓", failed: "✗", mixed: "≈", errored: "‼", skipped: "–", missing: "" } as Record<string, string>,
    moreRows: (n: number) => `altri ${n} casi`,
  },
};
export type Strings = typeof STRINGS.en;
export const stringsFor = (locale: string | undefined): Strings => ((locale ?? "en").toLowerCase().startsWith("it") ? STRINGS.it : STRINGS.en) as Strings;

export interface ViewEnv {
  card?: SuiteCard;
  pending?: string;
  error?: string;
  locale?: string;
  full: boolean;
  canFullscreen: boolean;
  busy: boolean;
  superseded: boolean;
  onOpen?: () => void;
  onAsk?: () => void;
  onRefresh?: () => void;
  /** Switch the card: a run's report, a suite's trend. */
  onShow?: (args: { suite?: string; run?: string; view: "suites" | "run" | "trend" }) => void;
  /** Benchmark cards: the leaderboard, or one case side by side. */
  onBench?: (args: { run: string; view: "benchmark" | "compare"; case?: string }) => void;
}

let env: ViewEnv = { full: false, canFullscreen: false, busy: false, superseded: false };

// ── DOM helpers (text only through textContent) ──

type Child = Node | string | false | null | undefined;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false || v === null) continue;
    if (k === "class") el.className = String(v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== false && c !== null && c !== undefined) el.append(c);
  return el;
}
const SVG = "http://www.w3.org/2000/svg";
function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number | undefined> = {}, ...children: Array<SVGElement | string>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, String(v));
  for (const c of children) el.append(c);
  return el;
}

const usd = (v: number) => (v === 0 ? "$0" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
const dur = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const pct = (n: number) => `${Math.round(n * 100)}%`;
const signed = (n: number, d = 2) => `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n).toFixed(d)}`;
const tone = (st: string) => (st === "passed" ? "success" : st === "failed" ? "danger" : st === "errored" ? "warning" : st === "running" || st === "queued" ? "info" : "neutral");
const chip = (str: Strings, st: string, small = true) => h("span", { class: `chip${small ? " chip-sm" : ""} chip-${tone(st)}`, "data-status": st }, str.status[st] ?? st);
const changeChip = (str: Strings, c: string | undefined) => (c === "regressed" ? h("span", { class: "chip chip-sm chip-danger", "data-change": c }, `▼ ${str.change[c]}`)
  : c === "improved" ? h("span", { class: "chip chip-sm chip-success", "data-change": c }, `▲ ${str.change[c]}`)
    : c === "new" ? h("span", { class: "chip chip-sm chip-info", "data-change": c }, str.change[c]) : null);
const deltaText = (d: number | undefined, cls = "") => (d === undefined ? null : h("span", { class: `delta ${d < 0 ? "delta-down" : d > 0 ? "delta-up" : ""} ${cls}`.trim() }, signed(d)));
const target = (t: string, v?: string) => (v ? `v${v}` : t);

function header(title: string, subtitle: string, right?: Child): HTMLElement {
  return h("div", { class: "head" }, h("div", { class: "who" }, h("div", { class: "name" }, title), h("div", { class: "role" }, subtitle)), right);
}

function actions(str: Strings, extra: Child[] = [], ask = str.askSuites): HTMLElement {
  return h("div", { class: "actions" },
    env.canFullscreen && !env.full ? h("button", { class: "btn btn-primary", disabled: env.superseded, onclick: () => env.onOpen?.() }, str.open) : null,
    ...extra,
    h("button", { class: "btn", disabled: env.superseded, onclick: () => env.onAsk?.() }, ask),
    h("button", { class: "btn", disabled: env.superseded || env.busy, onclick: () => env.onRefresh?.() }, str.refresh));
}

// ── Suites ──

export function suitesView(c: SuiteListCard, str: Strings): HTMLElement {
  return h("div", { class: env.full ? "full" : "card" },
    header(`${c.agent} · ${str.suitesTitle}`, str.cases(c.suites.reduce((a, x) => a + x.cases, 0))),
    c.suites.length ? h("div", { class: "suites" }, ...c.suites.map((x) => h("div", { class: "row", "data-suite": x.id },
      h("div", { class: "row-main" },
        h("div", {}, x.name, x.baselineRunId ? h("span", { class: "chip chip-sm chip-info" }, `★ ${str.isBaseline}`) : null,
          x.gate?.required ? h("span", { class: "chip chip-sm chip-warning", "data-gate": "required", title: `≥ ${pct(x.gate.minPassRate)}${x.gate.onPublish ? ` · ${str.onPublish}` : ""}` }, str.required) : null),
        h("div", { class: "muted small" }, [str.cases(x.cases), x.scorers ? str.scorers(x.scorers) : "", x.cassettes ? str.cassettes(x.cassettes) : "", x.simulated ? str.multiTurn(x.simulated) : "", x.lastRun
          ? `${x.lastRun.passed}/${x.lastRun.total}${x.lastRun.score !== undefined ? ` · ${str.score.toLowerCase()} ${x.lastRun.score.toFixed(2)}` : ""} · ${target(x.lastRun.target, x.lastRun.version)}`
          : str.neverRun].filter(Boolean).join(" · ")),
        // who plays the judge, the simulated user, the generator and the reviewer (when any is not Polpo)
        x.roles ? h("div", { class: "muted small", "data-roles": "" }, `${str.roles}: ${Object.entries(x.roles).map(([r, by]) => `${str.role[r] ?? r} ${by}`).join(" · ")}`) : null,
        x.lastRun?.regressions ? h("div", { class: "small danger-text" }, `▼ ${str.regressions(x.lastRun.regressions)}`) : null),
      h("div", { class: "row-actions" },
        x.lastRun ? h("button", { class: "btn btn-sm", disabled: env.superseded || env.busy, onclick: () => env.onShow?.({ run: x.lastRun!.id, suite: x.id, view: "run" }) }, str.report) : null,
        x.lastRun ? h("button", { class: "btn btn-sm", disabled: env.superseded || env.busy, onclick: () => env.onShow?.({ suite: x.id, view: "trend" }) }, str.trend) : null,
        x.lastRun ? chip(str, x.lastRun.status) : null)))) : h("p", { class: "muted empty" }, str.noSuites),
    c.gates?.length ? gatesList(c, str) : null,
    actions(str));
}

const GATE_TONE: Record<string, string> = { running: "info", passed: "success", blocked: "danger", failed: "danger", override: "warning", errored: "warning", cancelled: "neutral" };

/** The latest deploy gates: version, status (verifying with progress), what failed, the override. */
function gatesList(c: SuiteListCard, str: Strings): HTMLElement {
  return h("div", { class: "gates" },
    h("div", { class: "section-title" }, str.gatesTitle),
    ...(c.gates ?? []).map((g) => h("div", { class: "row", "data-gate-id": g.id, "data-gate-status": g.status },
      h("div", { class: "row-main" },
        h("div", {}, `v${g.version}`),
        g.status === "running" ? h("div", { class: "muted small" }, `${g.progress.done}/${g.progress.total}`) : null,
        g.override ? h("div", { class: "muted small fail-line" }, `${g.override.by}: “${g.override.reason}”`) : null,
        ...(g.status === "blocked" || g.status === "failed" ? g.failed.slice(0, 3).map((f) => h("div", { class: "small danger-text fail-line" }, f)) : [])),
      h("span", { class: `chip chip-sm chip-${GATE_TONE[g.status] ?? "neutral"}` }, str.gateStatus[g.status] ?? g.status))));
}

// ── Run ──

function kpi(label: string, value: string, extra?: Child): HTMLElement {
  return h("div", { class: "kpi" }, h("div", { class: "kpi-n" }, value, extra), h("div", { class: "muted small" }, label));
}

export function runView(c: SuiteRunCard, str: Strings): HTMLElement {
  const r = c.run;
  const b = c.baseline;
  const cases = env.full ? c.cases : [...c.cases.filter((x) => x.status !== "passed" || x.change === "regressed"), ...c.cases.filter((x) => x.status === "passed" && x.change !== "regressed")].slice(0, 6);
  return h("div", { class: env.full ? "full" : "card", "data-run": r.id },
    header(`${r.suiteName} · ${target(r.target, r.version)}`, [r.id, r.label, r.repetitions ? str.attempts(r.repetitions) : ""].filter(Boolean).join(" · "),
      h("span", { class: "chips" }, r.isBaseline ? h("span", { class: "chip chip-info" }, `★ ${str.isBaseline}`) : null, chip(str, r.status, false))),
    r.error ? h("p", { class: "danger" }, r.error) : null,
    h("div", { class: "kpis" },
      kpi(str.passRate, `${r.passed}/${r.total}`, b ? deltaText(b.passRateDelta) : null),
      r.score !== undefined ? kpi(str.score, r.score.toFixed(2), b?.scoreDelta !== undefined ? deltaText(b.scoreDelta) : null) : null,
      kpi(str.cost, usd(r.costUsd)),
      kpi(str.duration, dur(r.durationMs))),
    b ? h("div", { class: `baseline-box${b.regressions ? " has-regressions" : ""}`, "data-testid": "suite-baseline" },
      h("span", { class: "muted small" }, `${str.vsBaseline} ${b.runId} (${target(b.target ?? "", b.version)})`),
      b.regressions ? h("span", { class: "chip chip-sm chip-danger" }, `▼ ${str.regressions(b.regressions)}`) : null,
      b.improvements ? h("span", { class: "chip chip-sm chip-success" }, `▲ ${str.improvements(b.improvements)}`) : null) : null,
    c.scorers.length ? h("section", {}, h("h3", {}, str.scorersTitle), h("div", { class: "scorers" }, ...c.scorers.map((x) => h("div", { class: "row scorer", "data-scorer": x.id },
      h("div", { class: "row-main" }, h("div", {}, x.id), h("div", { class: "muted small" }, x.label)),
      h("div", { class: "nums" }, h("span", {}, `${str.mean} ${x.mean.toFixed(2)}`), h("span", { class: "muted" }, `${str.median} ${x.median.toFixed(2)} · ${str.p10} ${x.p10.toFixed(2)} · ${pct(x.passRate)}`), deltaText(x.delta)),
      changeChip(str, x.change))))) : null,
    h("section", {}, h("h3", {}, str.casesTitle), h("div", { class: "cases" }, ...cases.map((x) => h("div", { class: "row case", "data-case": x.key, "data-status": x.status },
      h("div", { class: "row-main" },
        h("div", {}, x.name, x.flaky ? h("span", { class: "chip chip-sm chip-warning" }, str.flaky) : null),
        h("div", { class: "muted small" }, [x.key, x.score !== undefined ? `${str.score.toLowerCase()} ${x.score.toFixed(2)}` : "", x.attempts ? `${pct(x.passRate ?? 0)} · ${str.attempts(x.attempts)}` : "", usd(x.costUsd), dur(x.durationMs)].filter(Boolean).join(" · ")),
        ...x.failed.slice(0, env.full ? 8 : 2).map((f) => h("div", { class: "small danger-text fail-line" }, f)),
        x.reasons?.length && x.change !== "unchanged" ? h("div", { class: "small muted" }, x.reasons.join("; ")) : null,
        env.full && x.scores.length ? h("div", { class: "chips" }, ...x.scores.map((sc) => h("span", { class: `chip chip-sm chip-${sc.passed ? "success" : "danger"}` }, `${sc.id} ${sc.score.toFixed(2)}`))) : null,
        x.cassette || x.recorded ? h("div", { class: "chips", "data-testid": "suite-cassette" },
          x.cassette ? h("span", { class: "chip chip-sm chip-info", title: x.cassette.id }, str.replayed(x.cassette.replayedCalls)) : null,
          x.cassette?.unmatched ? h("span", { class: "chip chip-sm chip-warning" }, str.unmatched(x.cassette.unmatched)) : null,
          x.recorded ? h("span", { class: "chip chip-sm chip-neutral", title: x.recorded.cassetteId }, `${str.recorded} · ${x.recorded.calls}`) : null) : null,
        x.tasks?.length ? h("div", { class: "small muted", "data-testid": "suite-tasks" }, x.tasks.map((t) => `${t.title} (${t.agent}) ${t.status === "done" ? "✓" : t.status === "failed" ? "✗" : "–"}`).join(" → ")) : null,
        x.transcript?.length ? h("div", { class: "transcript", "data-testid": "suite-transcript" },
          h("div", { class: "small muted" }, `${str.conversation}${x.simulator ? ` · ${str.stoppedBy} ${x.simulator.stoppedBy}` : ""}`),
          ...x.transcript.slice(0, env.full ? 12 : 2).map((m) => h("div", { class: `small msg msg-${m.role}` }, h("b", {}, m.role === "user" ? `${m.simulated ? `${str.simulated} ` : ""}user: ` : "agent: "), m.content))) : null),
      h("span", { class: "chips" }, changeChip(str, x.change), chip(str, x.status)))))),
    c.review ? h("section", { "data-testid": "suite-review" }, h("h3", {}, str.reviewTitle), h("p", { class: "prose" }, env.full ? c.review.text : `${c.review.text.slice(0, 600)}${c.review.text.length > 600 ? "…" : ""}`)) : null,
    env.full && c.notes.length ? h("section", {}, h("h3", {}, str.notes), ...c.notes.map((n) => h("p", { class: "muted small" }, n))) : null,
    actions(str, [h("button", { class: "btn", disabled: env.superseded || env.busy, onclick: () => env.onShow?.({ suite: r.suiteId, view: "trend" }) }, str.trend)], str.ask));
}

// ── Trend ──

/** The trend chart: pass rate and score (0..1) per run, oldest to newest; the baseline run marked. */
export function trendChart(points: SuiteTrendCard["points"], str: Strings): SVGSVGElement {
  const W = 320, H = 120, P = 8;
  const x = (i: number) => (points.length < 2 ? W / 2 : P + (i * (W - 2 * P)) / (points.length - 1));
  const y = (v: number) => H - P - v * (H - 2 * P);
  const line = (vals: Array<number | undefined>, cls: string) => {
    const d = vals.map((v, i) => (v === undefined ? "" : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean);
    return d.length ? s("polyline", { class: `line ${cls}`, points: d.join(" "), fill: "none" }) : undefined;
  };
  const svg = s("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${str.legendPass} / ${str.legendScore}`, preserveAspectRatio: "none" });
  for (const g of [0, 0.5, 1]) svg.append(s("line", { class: "grid", x1: 0, x2: W, y1: y(g), y2: y(g) }));
  const pass = line(points.map((p) => p.passRate), "line-pass");
  const score = line(points.map((p) => p.score), "line-score");
  if (pass) svg.append(pass);
  if (score) svg.append(score);
  points.forEach((p, i) => {
    svg.append(s("circle", { class: `dot dot-pass${p.status === "passed" ? "" : " dot-bad"}`, cx: x(i), cy: y(p.passRate), r: p.isBaseline ? 4 : 2.5 },
      s("title", {}, `${p.startedAt.slice(0, 16).replace("T", " ")} · ${p.version ? `v${p.version}` : p.target} · ${pct(p.passRate)}${p.score !== undefined ? ` · ${p.score.toFixed(2)}` : ""}`)));
    if (p.score !== undefined) svg.append(s("circle", { class: "dot dot-score", cx: x(i), cy: y(p.score), r: 2.5 }));
    if (p.isBaseline) svg.append(s("line", { class: "baseline-mark", x1: x(i), x2: x(i), y1: P, y2: H - P }));
  });
  return svg;
}

export function trendView(c: SuiteTrendCard, str: Strings): HTMLElement {
  const last = c.points[c.points.length - 1];
  return h("div", { class: env.full ? "full" : "card", "data-trend": c.suiteId },
    header(`${c.suiteName ?? c.suiteId} · ${str.trend}`, `${c.agent} · ${str.runs(c.points.length)}`),
    c.points.length ? h("div", { class: "trend" },
      trendChart(c.points, str),
      h("div", { class: "legend small" },
        h("span", { class: "key key-pass" }, str.legendPass), c.points.some((p) => p.score !== undefined) ? h("span", { class: "key key-score" }, str.legendScore) : null,
        last ? h("span", { class: "muted" }, `${pct(last.passRate)}${last.score !== undefined ? ` · ${last.score.toFixed(2)}` : ""} · ${usd(last.costUsd)}`) : null)) : h("p", { class: "muted empty" }, str.noRuns),
    c.byVersion.length ? h("section", {}, h("h3", {}, str.byVersion), ...c.byVersion.map((v) => h("div", { class: "row", "data-version": v.version },
      h("div", { class: "row-main" }, h("div", {}, v.version === "draft" || v.version === "production" ? v.version : `v${v.version}`), h("div", { class: "muted small" }, `${str.runs(v.runs)} · ${usd(v.costUsd)} · ${dur(v.durationMs)}`)),
      h("span", { class: "nums" }, `${pct(v.passRate)}${v.score !== undefined ? ` · ${v.score.toFixed(2)}` : ""}`)))) : null,
    actions(str, last ? [h("button", { class: "btn", disabled: env.superseded || env.busy, onclick: () => env.onShow?.({ run: last.runId, suite: c.suiteId, view: "run" }) }, str.report)] : []));
}

// ── Benchmark ──

const CELL_TONE: Record<string, string> = { passed: "success", failed: "danger", mixed: "warning", errored: "warning", skipped: "neutral", missing: "neutral" };

export function benchmarkView(c: BenchmarkCard, str: Strings): HTMLElement {
  const r = c.run;
  const running = r.status === "running" || r.status === "queued";
  return h("div", { class: env.full ? "full" : "card", "data-benchmark": r.id },
    header(r.name, [r.id, str.attempts(r.repetitions)].join(" · "), h("span", { class: `chip chip-${running ? "info" : r.status === "completed" ? "success" : "warning"}`, "data-status": r.status }, `${str.benchStatus[r.status] ?? r.status}${r.stopReason ? ` · ${r.stopReason}` : ""}`)),
    h("div", { class: "kpis" },
      kpi(str.progress, `${r.progress.runsDone}/${r.progress.runsTotal}`),
      kpi(str.spent, usd(r.spentUsd), r.budgetUsd !== undefined ? h("span", { class: "delta" }, `/ ${usd(r.budgetUsd)}`) : null),
      kpi(str.cost, usd(r.estimateUsd))),
    c.leaderboard.length ? h("section", { "data-testid": "bench-leaderboard" }, h("h3", {}, str.leaderboard),
      ...c.leaderboard.map((e) => h("div", { class: `row lb-row${e.pareto ? " is-pareto" : ""}`, "data-variant": e.variantId, "data-pareto": e.pareto ? "true" : "false" },
        h("span", { class: "rank" }, String(e.rank)),
        h("div", { class: "row-main" },
          h("div", {}, e.label, e.pareto ? h("span", { class: "chip chip-sm chip-info", title: str.pareto }, "◆") : null, e.flakiness ? h("span", { class: "chip chip-sm chip-warning" }, `${str.flaky} ${pct(e.flakiness)}`) : null),
          h("div", { class: "muted small" }, `${c.qualityMetric === "score" ? str.score : str.passRate} ${e.quality.toFixed(2)} ± ${e.qualityStddev.toFixed(2)} · ${usd(e.costUsd)} · ${dur(e.latencyP50Ms)} / p95 ${dur(e.latencyP95Ms)}`)),
        h("div", { class: "bar", "aria-hidden": "true" }, h("span", { class: "bar-fill", style: `width:${Math.round(Math.max(0, Math.min(1, e.composite)) * 100)}%` }))))) : null,
    c.notes.length ? h("div", { class: "notes small muted", "data-testid": "bench-notes" }, ...c.notes.map((n) => h("p", {}, `≈ ${n}`))) : null,
    c.rows.length ? h("section", { "data-testid": "bench-matrix" }, h("h3", {}, str.matrix),
      h("div", { class: "matrix-wrap" }, h("table", { class: "matrix" },
        h("thead", {}, h("tr", {}, h("th", {}, ""), ...c.variants.map((v) => h("th", { title: v.id }, v.label)))),
        h("tbody", {}, ...c.rows.map((row) => h("tr", { class: row.spread ? "spread" : "", "data-case": row.key },
          h("th", { scope: "row" }, h("button", { class: "link-btn", disabled: env.superseded || env.busy, onclick: () => env.onBench?.({ run: r.id, view: "compare", case: row.key }) }, row.name), h("div", { class: "muted small" }, row.suite)),
          ...c.variants.map((v) => {
            const cell = row.cells[v.id];
            const st = cell?.status ?? "missing";
            return h("td", { "data-cell": st }, h("span", { class: `chip chip-sm chip-${CELL_TONE[st] ?? "neutral"}` }, `${str.cell[st] ?? ""}${cell && cell.attempts > 1 ? ` ${cell.passed}/${cell.attempts}` : ""}${cell?.score !== undefined ? ` ${cell.score.toFixed(2)}` : ""}`));
          })))))),
      c.moreRows ? h("p", { class: "muted small" }, str.moreRows(c.moreRows)) : null) : null,
    actions(str, [], str.askBench));
}

function diffText(col: CompareCard["columns"][number]): HTMLElement {
  if (!col.textDiff) return h("p", { class: "prose answer" }, col.text || "—");
  return h("p", { class: "prose answer" }, ...col.textDiff.map((seg) => (seg.op === "same" ? seg.text : h(seg.op === "add" ? "ins" : "del", { class: `diff-${seg.op}` }, seg.text))));
}

export function compareView(c: CompareCard, str: Strings): HTMLElement {
  return h("div", { class: env.full ? "full" : "card", "data-compare": c.caseKey },
    header(`${c.caseName} · ${str.sideBySide}`, `${c.caseKey} · ${c.runId}`),
    h("div", { class: "compare-grid", style: `--cols:${Math.max(1, c.columns.length)}` }, ...c.columns.map((col) => h("div", { class: "compare-col", "data-variant": col.variantId },
      h("div", { class: "compare-head" }, h("div", { class: "name" }, col.label), chip(str, col.status)),
      h("div", { class: "muted small" }, [col.score !== undefined ? `${str.score.toLowerCase()} ${col.score.toFixed(2)}` : "", usd(col.costUsd), dur(col.durationMs), `${col.tokens} tok`].filter(Boolean).join(" · ")),
      h("div", { class: "section-title small" }, str.toolCalls),
      col.toolCalls.length || col.missingCalls.length ? h("ul", { class: "calls" },
        ...col.toolCalls.map((t) => h("li", { class: `call diff-${t.diff}`, "data-diff": t.diff, title: t.argChanges?.join(", ") ?? "" },
          h("b", {}, `${t.diff === "added" ? "+ " : t.diff === "changed" ? "~ " : ""}${t.name}`), " ", h("span", { class: "muted" }, t.args))),
        ...col.missingCalls.map((m) => h("li", { class: "call diff-missing", "data-diff": "missing" }, h("b", {}, `− ${m}`), " ", h("span", { class: "muted" }, str.missing)))) : h("p", { class: "muted small" }, str.noTools),
      h("div", { class: "section-title small" }, str.answer),
      diffText(col)))),
    actions(str, [h("button", { class: "btn", disabled: env.superseded || env.busy, onclick: () => env.onBench?.({ run: c.runId, view: "benchmark" }) }, str.back)], str.ask));
}

// ── Render ──

function skeleton(): HTMLElement {
  return h("div", { class: "card", "aria-busy": "true" },
    h("div", { class: "head" }, h("div", { class: "who" }, env.pending ? h("div", { class: "name" }, env.pending) : h("div", { class: "sk sk-line w40" }), h("div", { class: "sk sk-line w25" }))),
    h("div", { class: "facts" }, ...[70, 55, 80].map((w) => h("div", { class: `sk sk-line w${w}` }))));
}

export function renderView(root: HTMLElement, next: ViewEnv): void {
  env = next;
  const str = stringsFor(env.locale ?? navigator.language);
  const c = env.card;
  root.replaceChildren(
    env.superseded ? h("div", { class: "banner" }, str.superseded) : "",
    env.error && !c ? h("div", { class: "card" }, h("p", { class: "danger" }, `${str.error}: ${env.error}`))
      : c ? (c.kind === "run" ? runView(c, str) : c.kind === "trend" ? trendView(c, str) : c.kind === "benchmark" ? benchmarkView(c, str) : c.kind === "compare" ? compareView(c, str) : suitesView(c, str)) : skeleton(),
  );
  root.classList.toggle("is-superseded", env.superseded);
  root.classList.toggle("is-full", env.full);
}
