/**
 * The agent suite card: an MCP App (interactive UI in Claude, ChatGPT…; text elsewhere) shown by
 * polpo_agent_suite_show — an agent's suites, a run's report (cases, assertions, scores, deltas
 * versus the baseline, the AI review) or a suite's trend chart. Its UI calls the same tool to
 * refresh and to switch view.
 */
import { z } from "zod";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { buildBenchmarkCard, buildCompareCard, buildSuiteListCard, buildSuiteRunCard, buildSuiteTrendCard, suiteCardText, type SuiteCard } from "../mcp-suite-card.js";
import { SUITE_CARD_HTML } from "../mcp-widgets.generated.js";
import { cardAppearance } from "./card-appearance.js";
import { READ, dashboardLink, enc, fail, looseObject, unwrap, type AppRegister, type McpDeps } from "./kit.js";

/** The suite card's UI: one HTML document, served as a ui:// resource. */
export const SUITE_CARD_URI = "ui://polpo/suite-card.html";
let seq = 0;
const key = () => ({ createdAt: Date.now(), seq: ++seq });

type Loaded = { ok: true; card: SuiteCard } | { ok: false; error: string };

async function get(deps: McpDeps, path: string): Promise<{ ok: true; data: unknown } | { ok: false; error: string; status: number }> {
  const r = unwrap(await deps.api("GET", `/api/v1${path}`));
  return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error, status: r.status };
}

/** The card for these arguments: a run (run), a suite's trend (view trend), or the agent's suites. */
export async function loadSuiteCard(deps: McpDeps, args: { agent: string; suite?: string; run?: string; view?: "suites" | "run" | "trend" }): Promise<Loaded> {
  const agent = args.agent;
  const link = dashboardLink(deps, `/agents/${enc(agent)}?tab=suites`);
  let card: SuiteCard;
  if (args.run || args.view === "run") {
    let runId = args.run;
    if (!runId) {
      if (!args.suite) return { ok: false, error: "Give run (a run id) or suite (its latest run)." };
      const list = await get(deps, `/agents/${enc(agent)}/suite-runs?suite=${enc(args.suite)}&limit=1`);
      if (!list.ok) return { ok: false, error: list.error };
      runId = (list.data as Array<{ id: string }>)[0]?.id;
      if (!runId) return { ok: false, error: `${args.suite} has no runs yet: run it with polpo_agent_suite_run.` };
    }
    const r = await get(deps, `/agents/${enc(agent)}/suite-runs/${enc(runId)}`);
    if (!r.ok) return { ok: false, error: r.status === 404 ? `There is no run "${runId}" for ${agent}.` : r.error };
    card = buildSuiteRunCard({ run: r.data as Parameters<typeof buildSuiteRunCard>[0]["run"], key: key(), ...(link ? { link } : {}) });
  } else if (args.view === "trend") {
    if (!args.suite) return { ok: false, error: "The trend needs suite (its id: polpo_agent_suite_list)." };
    const [t, s] = await Promise.all([get(deps, `/agents/${enc(agent)}/suites/${enc(args.suite)}/trend`), get(deps, `/agents/${enc(agent)}/suites/${enc(args.suite)}`)]);
    if (!t.ok) return { ok: false, error: t.status === 404 ? `There is no suite "${args.suite}" for ${agent}.` : t.error };
    card = buildSuiteTrendCard({ agent, trend: t.data as Parameters<typeof buildSuiteTrendCard>[0]["trend"], key: key(), ...(s.ok ? { suiteName: (s.data as { name: string }).name } : {}), ...(link ? { link } : {}) });
  } else {
    const [s, runs, gates] = await Promise.all([
      get(deps, `/agents/${enc(agent)}/suites`), get(deps, `/agents/${enc(agent)}/suite-runs?limit=100`), get(deps, `/agents/${enc(agent)}/deploy-gates?limit=5`),
    ]);
    if (!s.ok) return { ok: false, error: s.status === 404 ? `There is no agent "${agent}".` : s.error };
    card = buildSuiteListCard({
      agent, key: key(), ...(link ? { link } : {}),
      suites: s.data as Parameters<typeof buildSuiteListCard>[0]["suites"],
      runs: runs.ok ? runs.data as Parameters<typeof buildSuiteListCard>[0]["runs"] : [],
      ...(gates.ok ? { gates: gates.data as NonNullable<Parameters<typeof buildSuiteListCard>[0]["gates"]> } : {}),
    });
  }
  const appearance = await cardAppearance(deps);
  return { ok: true, card: appearance ? { ...card, appearance } : card };
}

/** A benchmark run's card (leaderboard and matrix), or one of its cases side by side (view compare, case). */
export async function loadBenchmarkCard(deps: McpDeps, args: { run: string; view?: "benchmark" | "compare"; case?: string; variants?: string[] }): Promise<Loaded> {
  const link = dashboardLink(deps, `/benchmarks?run=${enc(args.run)}`);
  let card: SuiteCard;
  if (args.view === "compare" || args.case) {
    if (!args.case) return { ok: false, error: "The side by side view needs case (a key from the matrix)." };
    const q = new URLSearchParams({ case: args.case, ...(args.variants?.length ? { variants: args.variants.join(",") } : {}) });
    const r = await get(deps, `/benchmark-runs/${enc(args.run)}/compare?${q.toString()}`);
    if (!r.ok) return { ok: false, error: r.status === 404 ? `There is no case "${args.case}" in the benchmark run "${args.run}".` : r.error };
    card = buildCompareCard({ runId: args.run, comparison: r.data as Parameters<typeof buildCompareCard>[0]["comparison"], key: key(), ...(link ? { link } : {}) });
  } else {
    const r = await get(deps, `/benchmark-runs/${enc(args.run)}`);
    if (!r.ok) return { ok: false, error: r.status === 404 ? `There is no benchmark run "${args.run}".` : r.error };
    const rep = r.data as Parameters<typeof buildBenchmarkCard>[0];
    card = buildBenchmarkCard({ run: rep.run, leaderboard: rep.leaderboard, matrix: rep.matrix, key: key(), ...(link ? { link } : {}) });
  }
  const appearance = await cardAppearance(deps);
  return { ok: true, card: appearance ? { ...card, appearance } : card };
}

const output = z.object({
  kind: z.enum(["suites", "run", "trend", "benchmark", "compare"]).optional(),
  key: z.object({ createdAt: z.number(), seq: z.number() }).passthrough().optional(),
  generatedAt: z.string().optional(),
  agent: z.string().optional(),
  suites: z.array(looseObject).optional().describe("suites view: each suite with its last run (score, regressions), baseline and deploy gate (required)"),
  gates: z.array(looseObject).optional().describe("suites view: the latest deploy gates (version, status — verifying, passed, blocked, override —, what failed)"),
  run: looseObject.optional().describe("run view: status, pass rate, overall score, cost"),
  scorers: z.array(looseObject).optional().describe("run view: mean / median / p10 per scorer with the delta versus the baseline; trend view: the scorer ids"),
  cases: z.array(looseObject).optional().describe("run view: each case with its status, score, failed checks and change versus the baseline"),
  baseline: looseObject.optional(),
  review: looseObject.optional().describe("The AI review of the run (Markdown)"),
  points: z.array(looseObject).optional().describe("trend view: the runs over time"),
  byVersion: z.array(looseObject).optional(),
  leaderboard: z.array(looseObject).optional().describe("benchmark view: the variants ranked (quality ± stddev, cost, latency, composite, Pareto front)"),
  rows: z.array(looseObject).optional().describe("benchmark view: the case × variant matrix"),
  columns: z.array(looseObject).optional().describe("compare view: one column per variant (tool calls and the answer diffed)"),
}).passthrough();

export function registerSuiteCards(app: AppRegister, deps: McpDeps): void {
  const card = app.gate("team", READ, ["polpo_agent_suite_show", "polpo_benchmark_show"]);

  registerAppResource(card, "Agent suite card", SUITE_CARD_URI, {
    description: "An agent's test and eval suites, a run's report (cases, assertions, scores, deltas versus the baseline, the AI review) or a suite's trend chart.",
  }, async () => ({
    contents: [{
      uri: SUITE_CARD_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: SUITE_CARD_HTML,
      _meta: { ui: { prefersBorder: false, csp: { resourceDomains: ["https://assets.claude.ai"] } } },
    }],
  }));

  registerAppTool(card, "polpo_agent_suite_show", {
    title: "Show agent suites",
    description: "Show an agent's suites as a card: the suites with their last run (pass rate, score, regressions), which ones gate its deploys (required) and the latest deploy gates (in verifica, passed, blocked, override); with run (or view run and suite: its latest run), the run's report — "
      + "each case's status, failed assertions and scorers, scores per scorer (mean, median, p10), deltas and regressions versus the baseline, flaky cases, the AI review; "
      + "with view trend and suite, the suite's runs over time as a chart (score, pass rate, cost) and by version. Use it when the person asks how an agent's tests or evals are going.",
    inputSchema: {
      agent: z.string().min(1).describe("The agent's name (polpo_agents_list)"),
      suite: z.string().optional().describe("A suite id (polpo_agent_suite_list): its trend, or its latest run"),
      run: z.string().optional().describe("A run id (sr-…): its report"),
      view: z.enum(["suites", "run", "trend"]).optional().describe("suites (default), run or trend"),
    },
    annotations: { title: "Show agent suites", ...READ },
    outputSchema: output,
    _meta: { ui: { resourceUri: SUITE_CARD_URI } },
  }, async (args) => {
    const r = await loadSuiteCard(deps, args);
    return r.ok ? { content: [{ type: "text" as const, text: suiteCardText(r.card) }], structuredContent: r.card as unknown as Record<string, unknown> } : fail(r.error);
  });

  registerAppTool(card, "polpo_benchmark_show", {
    title: "Show a benchmark",
    description: "Show a benchmark run as a card: its progress and spend, the leaderboard (variants ranked by quality, cost and latency, the Pareto front, notes when differences are within noise) and the case × variant matrix; "
      + "with case (a matrix key) — or view compare — that case side by side for 2–4 variants: their tool calls and answers with the differences highlighted. Use it when the person asks which variant (model, version, instructions) is better.",
    inputSchema: {
      run: z.string().min(1).describe("A benchmark run id (br-…: polpo_benchmark_get)"),
      view: z.enum(["benchmark", "compare"]).optional().describe("benchmark (default) or compare"),
      case: z.string().optional().describe("compare: a case's matrix key (agent/suite/case)"),
      variants: z.array(z.string()).max(4).optional().describe("compare: 2–4 variant ids (default the first four)"),
    },
    annotations: { title: "Show a benchmark", ...READ },
    outputSchema: output,
    _meta: { ui: { resourceUri: SUITE_CARD_URI } },
  }, async (args) => {
    const r = await loadBenchmarkCard(deps, args);
    return r.ok ? { content: [{ type: "text" as const, text: suiteCardText(r.card) }], structuredContent: r.card as unknown as Record<string, unknown> } : fail(r.error);
  });
}
