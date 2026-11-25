/**
 * `polpo test` — run suites from the terminal or CI (docs/agent-suites.md, "polpo test and CI").
 *
 *   polpo test [agent] [--suite id] [--version production|draft|1.2.0] [--mode all|tools|model|none]
 *              [--mcp-server id | --mission id] [--json [file]] [--junit file] [--summary file]
 *              [--fail-on-regression] [--allow-real-tools] [--remote URL --token TOKEN] [--timeout s]
 *
 * Locally it runs against the project in the working directory (the server in process, nothing
 * listens); with --remote it runs on an instance through its REST API (a token: an API key). It
 * prints a report, writes JUnit XML and a Markdown summary for CI, and exits 1 when a run fails
 * (or regressed, with --fail-on-regression), 2 when it could not run.
 */
import { Command } from "commander";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { suiteReportExitCode, suiteRunsJunit, suiteRunsMarkdown, suiteRunsText, type ReportRun } from "@polpo-ai/core/agent-suites";

export interface PolpoTestOptions {
  agent?: string;
  suite?: string;
  version?: string;
  mode?: string;
  mcpServer?: string;
  mission?: string;
  json?: boolean | string;
  junit?: string;
  summary?: string;
  failOnRegression?: boolean;
  allowRealTools?: boolean;
  remote?: string;
  token?: string;
  timeout?: string | number;
  dir?: string;
}

/** One REST call: `{ ok, data }` or `{ ok: false, error, status }`. */
export type TestApi = (method: string, path: string, body?: unknown) => Promise<{ ok: boolean; status: number; data?: any; error?: string }>;

export interface PolpoTestDeps {
  api: TestApi;
  log: (line: string) => void;
  error: (line: string) => void;
  write: (file: string, text: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** The dashboard's base URL (links in the summary). */
  dashboard?: string;
}

const MODES = ["none", "tools", "model", "all"];
const enc = encodeURIComponent;

/** Run the suites and report; returns the exit code (0 passed, 1 failed, 2 could not run). */
export async function runPolpoTest(opts: PolpoTestOptions, deps: PolpoTestDeps): Promise<number> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (opts.mode && !MODES.includes(opts.mode)) { deps.error(`--mode must be one of ${MODES.join(", ")}`); return 2; }
  if ([opts.agent, opts.mcpServer, opts.mission].filter(Boolean).length > 1) { deps.error("Give one target: an agent, --mcp-server or --mission"); return 2; }
  const timeoutMs = Math.max(10, Number(opts.timeout ?? 1800)) * 1000;

  // what to test: owners (base paths) and their suites
  const bases: Array<{ base: string; label: string }> = [];
  if (opts.mcpServer) bases.push({ base: `/mcp-servers/${enc(opts.mcpServer)}`, label: opts.mcpServer });
  else if (opts.mission) bases.push({ base: `/missions/${enc(opts.mission)}`, label: opts.mission });
  else if (opts.agent) bases.push({ base: `/agents/${enc(opts.agent)}`, label: opts.agent });
  else {
    const agents = await deps.api("GET", "/agents");
    if (!agents.ok) { deps.error(`Could not list the agents: ${agents.error ?? `HTTP ${agents.status}`}`); return 2; }
    for (const a of agents.data as Array<{ name: string }>) bases.push({ base: `/agents/${enc(a.name)}`, label: a.name });
  }

  const started: Array<{ base: string; runId: string; label: string }> = [];
  for (const { base, label } of bases) {
    const list = await deps.api("GET", `${base}/suites`);
    if (!list.ok) { deps.error(`${label}: ${list.error ?? `HTTP ${list.status}`}`); return 2; }
    const suites = (list.data as Array<{ id: string; name: string; cases: unknown[] }>).filter((s) => !opts.suite || s.id === opts.suite);
    if (opts.suite && !suites.length) { deps.error(`${label} has no suite "${opts.suite}"`); return 2; }
    for (const s of suites) {
      if (!s.cases.length) { deps.log(`– ${label} · ${s.name}: no cases, skipped`); continue; }
      const r = await deps.api("POST", `${base}/suites/${enc(s.id)}/runs`, {
        ...(opts.version ? { target: opts.version } : {}), ...(opts.mode ? { mode: opts.mode } : {}), trigger: "ci",
        ...(opts.allowRealTools ? { allowRealTools: true } : {}),
      });
      if (!r.ok) { deps.error(`${label} · ${s.name}: ${r.error ?? `HTTP ${r.status}`}`); return 2; }
      deps.log(`… ${label} · ${s.name} [${r.data.id}]`);
      started.push({ base, runId: r.data.id, label });
    }
  }
  if (!started.length) { deps.error("No suite to run"); return 2; }

  // wait for every run
  const until = Date.now() + timeoutMs;
  const runs: ReportRun[] = [];
  for (const s of started) {
    let run: ReportRun | undefined;
    for (;;) {
      const g = await deps.api("GET", `${s.base}/suite-runs/${enc(s.runId)}`);
      if (!g.ok) { deps.error(`${s.label}: ${g.error ?? `HTTP ${g.status}`}`); return 2; }
      run = g.data as ReportRun;
      if (run.status !== "running" && run.status !== "queued") break;
      if (Date.now() > until) { deps.error(`Timed out waiting for ${s.runId}`); break; }
      await sleep(2000);
    }
    runs.push(run);
  }

  const report = { runs, exitCode: suiteReportExitCode(runs, { failOnRegression: opts.failOnRegression === true }) };
  if (opts.json === true) deps.log(JSON.stringify(report, null, 2));
  else {
    deps.log(suiteRunsText(runs, { failOnRegression: opts.failOnRegression === true }));
    if (typeof opts.json === "string") await deps.write(opts.json, JSON.stringify(report, null, 2));
  }
  if (opts.junit) await deps.write(opts.junit, suiteRunsJunit(runs));
  if (opts.summary) {
    const links = deps.dashboard ? (r: ReportRun) => {
      const kind = r.targetKind ?? "agent";
      if (kind !== "agent") return undefined;
      return `${deps.dashboard}/agents/${enc(r.agent)}?tab=suites&run=${enc(r.id)}`;
    } : undefined;
    await deps.write(opts.summary, suiteRunsMarkdown(runs, { failOnRegression: opts.failOnRegression === true, ...(links ? { links } : {}) }));
  }
  return report.exitCode;
}

/** The REST API of a remote instance (a token: an API key). */
export function remoteApi(url: string, token: string | undefined, fetchImpl: typeof fetch = fetch): TestApi {
  const root = url.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  return async (method, path, body) => {
    try {
      const res = await fetchImpl(`${root}/api/v1${path}`, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const json = await res.json().catch(() => ({})) as { ok?: boolean; data?: unknown; error?: string };
      return { ok: res.ok && json.ok !== false, status: res.status, data: json.data, ...(json.error ? { error: json.error } : {}) };
    } catch (err) {
      return { ok: false, status: 0, error: `${root}: ${(err as Error).message}` };
    }
  };
}

/** The project in `dir`, in process: its server app without listening. */
async function localApi(dir: string): Promise<{ api: TestApi; close: () => Promise<void> }> {
  const { Orchestrator } = await import("../../core/orchestrator.js");
  const { SSEBridge } = await import("../../server/sse-bridge.js");
  const { createApp } = await import("../../server/app.js");
  const { trustedApiCallHeaders } = await import("@polpo-ai/server");
  const o = new Orchestrator(resolve(dir));
  await o.init();
  const bridge = new SSEBridge(o);
  bridge.start();
  const app = createApp(o, bridge, { workDir: resolve(dir) });
  const api: TestApi = async (method, path, body) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { "content-type": "application/json", ...trustedApiCallHeaders() },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json().catch(() => ({})) as { ok?: boolean; data?: unknown; error?: string };
    return { ok: res.ok && json.ok !== false, status: res.status, data: json.data, ...(json.error ? { error: json.error } : {}) };
  };
  return { api, close: async () => { bridge.dispose(); } };
}

export function registerTestCommand(program: Command): void {
  program
    .command("test [agent]")
    .description("Run suites (tests and evals) and report: locally on this project, or on a remote instance (--remote). Exit code 1 when a run fails")
    .option("--suite <id>", "Only this suite")
    .option("--version <version>", "production (default), draft, or a published version like 1.2.0 (hosted servers: draft by default)")
    .option("--mode <mode>", "Run every case in this mode: all (offline), tools, model, none")
    .option("--mcp-server <id>", "A hosted MCP server's saved tests instead of an agent")
    .option("--mission <id>", "A mission's suites instead of an agent")
    .option("--json [file]", "JSON report (stdout, or a file)")
    .option("--junit <file>", "Write JUnit XML (CI test reports)")
    .option("--summary <file>", "Write a Markdown summary (e.g. $GITHUB_STEP_SUMMARY)")
    .option("--fail-on-regression", "Also fail when a run regressed versus its baseline")
    .option("--allow-real-tools", "Confirm runs that use real tools (side effects possible; needs an admin token remotely)")
    .option("--remote <url>", "Run on this instance (env POLPO_URL)")
    .option("--token <token>", "The instance's API key (env POLPO_TOKEN)")
    .option("--timeout <seconds>", "How long to wait for the runs", "1800")
    .option("-d, --dir <path>", "Working directory (local runs)", ".")
    .action(async (agent: string | undefined, opts: PolpoTestOptions) => {
      const remote = opts.remote ?? process.env.POLPO_URL;
      const token = opts.token ?? process.env.POLPO_TOKEN;
      let close: (() => Promise<void>) | undefined;
      let code = 2;
      try {
        let api: TestApi;
        if (remote) api = remoteApi(remote, token);
        else {
          const local = await localApi(opts.dir ?? ".");
          api = local.api;
          close = local.close;
        }
        code = await runPolpoTest({ ...opts, ...(agent ? { agent } : {}) }, {
          api,
          log: (l) => { if (opts.json === true) process.stdout.write(`${l}\n`); else console.log(l); },
          error: (l) => console.error(l),
          write: (file, text) => writeFile(file, text, "utf-8"),
          ...(remote ? { dashboard: remote.replace(/\/+$/, "") } : {}),
        });
      } catch (err) {
        console.error((err as Error).message);
        code = 2;
      } finally {
        await close?.().catch(() => undefined);
      }
      process.exit(code);
    });
}
