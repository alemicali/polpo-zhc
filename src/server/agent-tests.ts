/**
 * Agent tests (the agent page's Tests tab, POST /agents/:name/tests, MCP polpo_agent_test, Polpo's
 * agent_test): check everything an agent has at its disposal, each check on its own or all at once.
 *
 *   engine      a minimal real request with the agent's engine and auth (Polpo's engine: one tiny
 *               completion; a harness: the harness connection test; the CLI engine: the account's
 *               sign-in status and the owner policy for the person testing)
 *   tools       every allowedTools entry resolves to a real tool (globs too); unknown names flagged
 *   connectors  each connector the agent can use or names: connected, auth valid, tools listed; a
 *               connector named in allowedTools whose access leaves the agent out (one-click grant)
 *   vault       referenced vault entries exist (names only, never values), env_from_vault mappings
 *   skills      each assigned skill loads (with its bundled files), pinned skill versions exist
 *   computer    default computer reachable (a stopped one is started only on request), sandbox
 *               provider, egress proxy (and the tailnet of a remote computer)
 *   channels    routes to the agent exist and their channels run
 *   versioning  production version, draft state (stale draft)
 *   smoke       (explicit) a tiny real chat turn that calls one harmless tool
 *
 * It reuses the existing connection tests; this module only decides pass / warn / fail and the
 * fix (a link to the setting, or a one-click action). Runs are kept per agent.
 */
import { randomUUID } from "node:crypto";
import {
  AGENT_TEST_DEFAULT_CHECKS, AGENT_TEST_TITLES, HOST_COMPUTER_ID,
  agentCliEngine, agentEgressName, agentEngineProblem, agentHarness, cliAccountUseProblem, cliEngineProblem, cliSettingsOf,
  connectorAccessProblem, connectorGrants, connectorOwner, connectorToolSelected, harnessVaultRefs, harnessesSettingsOf, instanceServesCustomers, isAgentTestCheckId,
  isRemoteComputer, resolveCliAccount, worstAgentTestStatus,
  type AgentConfig, type AgentTestCheckId, type AgentTestCheckResult, type AgentTestFixAction, type AgentTestItem,
  type AgentTestRun, type AgentTestRunRequest, type AgentTestStatus, type AgentTestStore, type AgentVersionState,
  type CliAccount, type ComputerConfig, type ConnectorConfig, type HarnessesSettings, type AgentHarnessEngine,
  type PolpoSettings, type VaultRef, type VaultStore,
} from "@polpo-ai/core";

/** The harness connection test's result (src/harness/test-connection.ts). */
export interface EngineTestResult {
  ok: boolean;
  model?: string;
  auth?: string;
  endpoint?: string;
  latencyMs: number;
  errorKind?: string;
  error?: string;
  note?: string;
}

/** A CLI account's installed version and sign-in status (src/cli-engine/accounts.ts). */
export interface CliReport {
  installed: boolean;
  version?: string;
  status?: { signedIn: boolean; who?: string; method?: string; plan?: string; detail?: string };
  error?: string;
}

export interface ConnectorTestResult {
  ok: boolean;
  status: string;
  tools?: Array<{ name: string }>;
  error?: string;
}

export interface LoadedSkillInfo {
  name: string;
  /** Its SKILL.md body (scanned for env_from_vault mappings). */
  content: string;
  files?: number;
}

export interface ComputerLiveInfo {
  status: string;
  lastError?: string;
}

export interface EgressInfo {
  tailnet: string;
  proxyReachable: boolean;
  effective: string;
  machine?: string;
  error?: string;
}

export interface SmokeResult {
  text: string;
  toolCalls: Array<{ name: string; state?: string; result?: unknown }>;
  latencyMs: number;
  sessionId?: string;
}

/** What the checks read and call. Every external effect goes through here (tests mock it). */
export interface AgentTestDeps {
  agents: () => Promise<AgentConfig[]>;
  settings: () => PolpoSettings | undefined;
  store: AgentTestStore;
  versioning?: () => {
    state: (name: string) => Promise<AgentVersionState>;
    resolve: (name: string, ref?: string) => Promise<{ agent: AgentConfig; version?: string } | undefined>;
    draftConfig: (name: string) => Promise<{ config: Partial<AgentConfig> }>;
    getVersion: (name: string, version: string) => Promise<{ skillVersions?: Record<string, number> } | undefined>;
  };
  // engine
  /** One tiny completion with Polpo's engine (throws on failure). */
  nativeModelTest: (model: string | undefined) => Promise<{ model: string; latencyMs: number }>;
  harnessTest: (input: { harness: AgentHarnessEngine["harness"]; settings: HarnessesSettings; agentEngine: AgentHarnessEngine }) => Promise<EngineTestResult>;
  cliAccountReport: (account: CliAccount) => Promise<CliReport>;
  instanceAuth: () => boolean;
  // tools
  knownTools: () => Promise<string[]>;
  // connectors
  connectors: () => ConnectorConfig[];
  testConnector: (id: string) => Promise<ConnectorTestResult>;
  /** Add the agent to the connector's access.agents. */
  grantConnector: (id: string, agent: string) => Promise<void>;
  // vault
  vault: () => VaultStore | undefined;
  // skills
  loadSkills: (agent: string, names: string[]) => LoadedSkillInfo[];
  skillVersionExists: (name: string, version: number) => boolean;
  // computer & sandbox
  computers: () => ComputerConfig[];
  computerLive: (computer: ComputerConfig) => Promise<ComputerLiveInfo>;
  startComputer: (computer: ComputerConfig) => Promise<void>;
  sandboxProviderStatus: (provider: string) => Promise<{ configured: boolean; keyFound: boolean } | undefined>;
  sandboxProviderTest: (provider: string) => Promise<{ ok: boolean; error?: string; durationMs?: number }>;
  computerEgress: (computer: ComputerConfig) => Promise<EgressInfo | undefined>;
  proxyReachable: (url: string) => Promise<boolean>;
  // channels
  channelLive: (name: string) => boolean;
  // smoke
  smoke: (agentRef: string, prompt: string) => Promise<SmokeResult>;
  now?: () => Date;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const enc = encodeURIComponent;
const SMOKE_TOOL = "register_outcome";
export const DEFAULT_SMOKE_PROMPT = `This is an automated test of your setup, not a real request. Call the ${SMOKE_TOOL} tool exactly once `
  + `with type "text", label "agent-test" and text "ok". Then reply with exactly: TEST OK`;

/** A check's items → its status and a one-line summary. */
function result(id: AgentTestCheckId, items: AgentTestItem[], startedAt: number, summary?: string, data?: Record<string, unknown>): AgentTestCheckResult {
  const status = worstAgentTestStatus(items.map((i) => i.status));
  const counts = (["fail", "warn", "pass"] as const).map((s) => [s, items.filter((i) => i.status === s).length] as const).filter(([, n]) => n > 0);
  return {
    id, title: AGENT_TEST_TITLES[id], status,
    summary: summary ?? (items.length ? counts.map(([s, n]) => `${n} ${s === "pass" ? "ok" : s === "warn" ? "warning" : "failed"}`).join(", ") : "Nothing to check"),
    items, durationMs: Date.now() - startedAt, ...(data ? { data } : {}),
  };
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 400);

/** With a deadline: slow checks report a timeout instead of hanging the run. */
async function within<T>(ms: number, p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms); timer.unref?.(); })]);
  } finally { clearTimeout(timer); }
}

/** The connector ids an allowedTools entry names (`mcp__printful__*`, `mcp__printful__get_x`, `mcp__printful*`); "*" for `mcp__*`. */
export function connectorIdsInPattern(pattern: string, connectorIds: string[]): string[] {
  const p = pattern.trim().toLowerCase();
  if (!p.startsWith("mcp_")) return [];
  if (p === "mcp__*" || p === "mcp_*" || p === "mcp*") return ["*"];
  const rest = p.replace(/^mcp__/, "");
  const sep = rest.indexOf("__");
  if (sep >= 0) return [rest.slice(0, sep)];
  if (rest.endsWith("*")) {
    const prefix = rest.slice(0, -1);
    return connectorIds.filter((id) => id.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase().startsWith(prefix));
  }
  return [rest];
}

/** `env_from_vault` mappings written in a text (the agent's instructions, a skill): VAR → "service.key". */
export function envFromVaultMappings(text: string | undefined): Array<{ variable: string; ref: string }> {
  if (!text) return [];
  const out: Array<{ variable: string; ref: string }> = [];
  const block = /env_from_vault["'`]?\s*[:=]?\s*\{([^{}]*)\}/g;
  for (const m of text.matchAll(block)) {
    for (const pair of m[1]!.matchAll(/["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?\s*:\s*["'`]([^"'`]+)["'`]/g)) {
      out.push({ variable: pair[1]!, ref: pair[2]!.trim() });
    }
  }
  return out;
}

function matchPattern(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase();
  const n = name.toLowerCase();
  return p === n || (p.endsWith("*") && n.startsWith(p.slice(0, -1)));
}

/** The bridged name of a connector tool (mcp__<connector>__<tool>, as src/mcp/tools.ts names it). */
function bridgedName(connectorId: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `mcp__${clean(connectorId)}__${clean(tool)}`;
}

export class AgentTester {
  constructor(private readonly deps: AgentTestDeps) {}

  /** The agent as the target runs it: production (live), the draft, or a published version. */
  async resolveTarget(name: string, target: string | undefined): Promise<{ agent: AgentConfig; target: string; version?: string; ref: string; pins?: Record<string, number> }> {
    const live = (await this.deps.agents()).find((a) => a.name === name);
    if (!live) throw Object.assign(new Error(`Agent "${name}" not found`), { name: "AgentTestError", code: "NOT_FOUND" });
    const versioning = live.volatile ? undefined : this.deps.versioning?.();
    const t = !target || target === "latest" ? "production" : target;
    if (t === "production") {
      const state = versioning ? await versioning.state(name).catch(() => undefined) : undefined;
      const pins = state?.production ? (await versioning!.getVersion(name, state.production).catch(() => undefined))?.skillVersions : undefined;
      return { agent: live, target: "production", ...(state?.production ? { version: state.production } : {}), ref: name, ...(pins ? { pins } : {}) };
    }
    if (!versioning) throw Object.assign(new Error(`${name} has no versions: test production`), { name: "AgentTestError", code: "INVALID" });
    if (t === "draft") {
      const { config } = await versioning.draftConfig(name);
      const agent = { ...live, ...config, name } as AgentConfig;
      for (const [k, v] of Object.entries(agent)) if (v === undefined) delete (agent as unknown as Record<string, unknown>)[k];
      return { agent, target: "draft", ref: `${name}@draft` };
    }
    if (!SEMVER.test(t)) throw Object.assign(new Error(`"${t}" is not a target: use production, draft or a version like 1.2.0`), { name: "AgentTestError", code: "INVALID" });
    const resolved = await versioning.resolve(name, t);
    if (!resolved) throw Object.assign(new Error(`${name} has no version ${t}`), { name: "AgentTestError", code: "NOT_FOUND" });
    const pins = (await versioning.getVersion(name, t).catch(() => undefined))?.skillVersions;
    return { agent: resolved.agent, target: t, version: t, ref: `${name}@${t}`, ...(pins ? { pins } : {}) };
  }

  async run(name: string, req: AgentTestRunRequest = {}, opts: { actor?: string; member?: string } = {}): Promise<AgentTestRun> {
    const now = this.deps.now ?? (() => new Date());
    const startedAt = now().toISOString();
    const wanted = (req.checks?.length ? req.checks : AGENT_TEST_DEFAULT_CHECKS).filter(isAgentTestCheckId);
    const checks = [...new Set(wanted)];
    const t = await this.resolveTarget(name, req.target);
    const results = await Promise.all(checks.map(async (id) => {
      const t0 = Date.now();
      try {
        return await this.check(id, t, { ...req, member: opts.member });
      } catch (err) {
        return result(id, [{ label: "The check could not run", status: "fail", detail: errorText(err) }], t0);
      }
    }));
    const run: AgentTestRun = {
      id: randomUUID(), agent: name, target: t.target, ...(t.version ? { version: t.version } : {}),
      startedAt, finishedAt: now().toISOString(), status: worstAgentTestStatus(results.map((r) => r.status)),
      checks: results, ...(opts.actor ? { actor: opts.actor } : {}),
    };
    await this.deps.store.add(run);
    return run;
  }

  private check(id: AgentTestCheckId, t: Awaited<ReturnType<AgentTester["resolveTarget"]>>, req: AgentTestRunRequest & { member?: string }): Promise<AgentTestCheckResult> {
    switch (id) {
      case "engine": return this.engine(t.agent, req.member);
      case "tools": return this.tools(t.agent);
      case "connectors": return this.connectors(t.agent);
      case "vault": return this.vault(t.agent);
      case "skills": return this.skills(t.agent, t.pins);
      case "computer": return this.computer(t.agent, !!req.startComputer);
      case "channels": return this.channels(t.agent);
      case "versioning": return this.versioning(t.agent, t.target);
      case "smoke": return this.smoke(t.agent, t.ref, req.smokePrompt);
    }
  }

  // ── engine & model ──

  async engine(agent: AgentConfig, member?: string): Promise<AgentTestCheckResult> {
    const t0 = Date.now();
    const settings = this.deps.settings();
    const harnessesLink = "/config?section=harnesses";
    const cli = agentCliEngine(agent);
    if (cli) {
      const items: AgentTestItem[] = [];
      const problem = cliEngineProblem(agent, settings);
      const cliSettings = cliSettingsOf(settings);
      const computer = agent.defaultComputer || HOST_COMPUTER_ID;
      const resolved = resolveCliAccount(cli, computer, cliSettings);
      if (problem || "problem" in resolved) {
        items.push({ label: `CLI engine (${cli.cli})`, status: "fail", detail: problem ?? ("problem" in resolved ? resolved.problem : ""), fix: { label: "Open CLI accounts", href: harnessesLink } });
        return result("engine", items, t0, undefined, { engine: "cli", cli: cli.cli });
      }
      const account = resolved.account;
      let report: CliReport;
      try { report = await within(45_000, this.deps.cliAccountReport(account), "The account check"); } catch (err) {
        items.push({ label: `Account ${account.id} on ${account.computer}`, status: "fail", detail: errorText(err), fix: { label: "Open CLI accounts", href: harnessesLink } });
        return result("engine", items, t0, undefined, { engine: "cli", cli: cli.cli, account: account.id });
      }
      if (!report.installed) {
        items.push({ label: `${cli.cli} on ${account.computer}`, status: "fail", detail: report.error ?? `The ${cli.cli} CLI is not installed there`, fix: { label: "Install it", href: harnessesLink } });
      } else if (!report.status?.signedIn) {
        items.push({ label: `Account ${account.id}`, status: "fail", detail: `Not signed in${report.status?.detail ? `: ${report.status.detail}` : ""}. ${account.owner} signs in from Settings → Harnesses → CLI accounts.`, fix: { label: "Sign in", href: harnessesLink } });
      } else {
        items.push({ label: `Account ${account.id}`, status: "pass", detail: `Signed in${report.status.who ? ` as ${report.status.who}` : ""}${report.status.plan ? ` (${report.status.plan})` : ""}${report.version ? ` · ${cli.cli} ${report.version}` : ""}` });
      }
      // the owner policy for the person testing (as if they started the work now)
      const policy = cliAccountUseProblem(account, {
        ...(member ? { initiator: member } : {}), origin: member ? "member" : "unknown",
        instanceAuth: this.deps.instanceAuth(), servesCustomers: instanceServesCustomers(settings),
      }, cliSettings);
      items.push(policy
        ? { label: `Policy for ${member ?? "this request"}`, status: "warn", detail: policy }
        : { label: `Policy for ${member ?? "this request"}`, status: "pass", detail: `Work ${member ? "you start" : "started this way"} may run on account ${account.id}` });
      return result("engine", items, t0, undefined, { engine: "cli", cli: cli.cli, account: account.id, ...(report.version ? { version: report.version } : {}) });
    }

    const harness = agentHarness(agent);
    if (harness) {
      const problem = agentEngineProblem(agent, settings, { daytonaApi: settings?.sandbox?.providers?.daytona?.api === "v2" ? "v2" : "v0" });
      if (problem) return result("engine", [{ label: `Harness ${harness.harness}`, status: "fail", detail: problem, fix: { label: "Open harness settings", href: harnessesLink } }], t0, undefined, { engine: harness.harness });
      const hs = harnessesSettingsOf(settings);
      if (!hs) return result("engine", [{ label: `Harness ${harness.harness}`, status: "fail", detail: "The harness settings cannot be read", fix: { label: "Open harness settings", href: harnessesLink } }], t0);
      let r: EngineTestResult;
      try { r = await within(60_000, this.deps.harnessTest({ harness: harness.harness, settings: hs, agentEngine: harness }), "The model request"); } catch (err) {
        return result("engine", [{ label: `Harness ${harness.harness}`, status: "fail", detail: errorText(err), fix: { label: "Open harness settings", href: harnessesLink } }], t0, undefined, { engine: harness.harness });
      }
      const label = `${harness.harness}${r.model ? ` · ${r.model}` : ""}${r.auth ? ` · ${r.auth}` : ""}`;
      const item: AgentTestItem = r.ok
        ? { label, status: r.note ? "warn" : "pass", detail: `Answered in ${r.latencyMs} ms${r.endpoint ? ` (${r.endpoint})` : ""}${r.note ? `. ${r.note}` : ""}` }
        : { label, status: "fail", detail: `${r.errorKind ? `${r.errorKind}: ` : ""}${r.error ?? "the request failed"}`, fix: { label: "Open harness settings", href: harnessesLink } };
      return result("engine", [item], t0, r.ok ? `${r.model ?? harness.harness} answered in ${r.latencyMs} ms` : undefined, {
        engine: harness.harness, ...(r.model ? { model: r.model } : {}), latencyMs: r.latencyMs, ...(r.auth ? { auth: r.auth } : {}),
      });
    }

    // Polpo's own engine
    try {
      const r = await within(60_000, this.deps.nativeModelTest(agent.model), "The model request");
      return result("engine", [{ label: `Polpo engine · ${r.model}`, status: "pass", detail: `Answered in ${r.latencyMs} ms` }], t0,
        `${r.model} answered in ${r.latencyMs} ms`, { engine: "polpo", model: r.model, latencyMs: r.latencyMs });
    } catch (err) {
      return result("engine", [{ label: `Polpo engine · ${agent.model ?? "default model"}`, status: "fail", detail: errorText(err), fix: { label: "Check the provider", href: "/config?section=providers" } }], t0,
        undefined, { engine: "polpo", ...(agent.model ? { model: agent.model } : {}) });
    }
  }

  // ── tools ──

  async tools(agent: AgentConfig): Promise<AgentTestCheckResult> {
    const t0 = Date.now();
    const toolsLink = `/agents/${enc(agent.name)}?tab=tools`;
    const allowed = agent.allowedTools;
    const known = await this.deps.knownTools();
    const items: AgentTestItem[] = [];
    if (agentHarness(agent) || agentCliEngine(agent)) {
      items.push({ label: "Engine", status: "pass", detail: "This agent runs on an official runtime: its own tools, plus Polpo's tools and connectors through allowedTools" });
    }
    if (!allowed?.length) {
      items.push({ label: "allowedTools", status: "pass", detail: "Not set: the core tools (read, write, edit, bash, …) and every connector granted to the agent" });
      return result("tools", items, t0, "Core tools only (no allowedTools)");
    }
    const resolved = new Set<string>();
    for (const pattern of allowed) {
      if (/^mcp_/i.test(pattern)) {
        items.push({ label: pattern, status: "pass", detail: "Connector tools: checked under Connectors" });
        continue;
      }
      const matches = known.filter((n) => matchPattern(pattern, n));
      for (const m of matches) resolved.add(m);
      if (!matches.length) {
        items.push(pattern.includes("*")
          ? { label: pattern, status: "warn", detail: "Matches no tool: it gives the agent nothing", fix: { label: "Edit tools", href: toolsLink } }
          : { label: pattern, status: "warn", detail: "Unknown tool name: no such tool, it is ignored (a typo?)", fix: { label: "Edit tools", href: toolsLink } });
      } else {
        items.push({ label: pattern, status: "pass", detail: pattern.includes("*") ? `${matches.length} tools: ${matches.slice(0, 8).join(", ")}${matches.length > 8 ? ", …" : ""}` : "Loads" });
      }
    }
    const blocked = known.filter((n) => !resolved.has(n));
    items.push({ label: "Not allowed", status: "pass", detail: `${blocked.length} other built-in tools stay blocked (not in allowedTools)` });
    return result("tools", items, t0, `${resolved.size} built-in tools allowed${items.some((i) => i.status === "warn") ? ", some entries resolve to nothing" : ""}`, { allowed: resolved.size, blocked: blocked.length });
  }

  // ── connectors ──

  async connectors(agent: AgentConfig): Promise<AgentTestCheckResult> {
    const t0 = Date.now();
    const all = this.deps.connectors();
    const byId = new Map(all.map((c) => [c.id, c]));
    const allowed = agent.allowedTools;
    const items: AgentTestItem[] = [];
    // connectors the agent's allowedTools or connectorTools name
    const named = new Map<string, string>();
    for (const pattern of allowed ?? []) {
      for (const id of connectorIdsInPattern(pattern, all.map((c) => c.id))) {
        if (id === "*") continue;
        if (!named.has(id)) named.set(id, pattern);
      }
    }
    for (const id of Object.keys(agent.connectorTools ?? {})) if (!named.has(id)) named.set(id, `connectorTools.${id}`);
    for (const [id, where] of named) {
      const c = byId.get(id);
      if (!c) { items.push({ label: where, status: "warn", detail: `There is no connector "${id}"`, fix: { label: "Open connectors", href: "/connectors" } }); continue; }
      if (!c.enabled) { items.push({ label: `${c.name} (${where})`, status: "warn", detail: `${c.name} is turned off: the agent gets none of its tools`, fix: { label: "Open connectors", href: "/connectors" } }); continue; }
      const owner = connectorOwner(c);
      if (owner !== undefined && owner !== agent.name) {
        items.push({ label: `${c.name} (${where})`, status: "fail", detail: `${where} names ${c.name}, but it belongs to agent ${owner} (a personal connector): ${agent.name} can never use it` });
        continue;
      }
      if (!connectorGrants(c, agent.name)) {
        items.push({
          label: `${c.name} (${where})`, status: "fail",
          detail: `${where} names ${c.name}, but the connector's access does not include ${agent.name}: the agent sees none of its tools`,
          fix: { label: `Grant ${agent.name} access`, action: { type: "grant-connector-access", connector: c.id } },
        });
      }
    }
    const granted = all.filter((c) => connectorGrants(c, agent.name));
    if (!granted.length && !items.length) return result("connectors", [], t0, "No connectors for this agent");
    await Promise.all(granted.map(async (c) => {
      let r: ConnectorTestResult;
      try { r = await within(30_000, this.deps.testConnector(c.id), `${c.name}`); } catch (err) {
        items.push({ label: c.name, status: "fail", detail: errorText(err), fix: { label: "Open connectors", href: "/connectors" } });
        return;
      }
      if (!r.ok) {
        const auth = r.status === "needs_auth" || r.status === "needs_reauth";
        items.push({ label: c.name, status: "fail", detail: `${auth ? "Sign-in needed" : r.status}${r.error ? `: ${r.error}` : ""}`, fix: { label: auth ? "Sign in again" : "Open connectors", href: "/connectors" } });
        return;
      }
      const tools = r.tools ?? [];
      const selected = agent.connectorTools?.[c.id];
      const unknown = Array.isArray(selected) ? selected.filter((n) => !tools.some((t) => t.name === n)) : [];
      const off = tools.filter((t) => c.toolPolicy?.[t.name] === "off");
      const visible = tools.filter((t) => c.toolPolicy?.[t.name] !== "off"
        && connectorToolSelected(agent.connectorTools, c.id, t.name)
        && (!allowed || allowed.some((p) => matchPattern(p, bridgedName(c.id, t.name)))));
      const blockedNote = off.length ? ` · ${off.length} turned off by the connector's policy (blocked)` : "";
      if (!visible.length) {
        items.push({
          label: c.name, status: "warn",
          detail: `Connected, ${tools.length} tools, but none reaches ${agent.name}${allowed ? ` (allowedTools has no mcp__${c.id}__* entry)` : ""}${blockedNote}`,
          fix: { label: "Edit tools", href: `/agents/${enc(agent.name)}?tab=tools` },
        });
      } else {
        items.push({ label: c.name, status: "pass", detail: `Connected · ${visible.length} of ${tools.length} tools for ${agent.name}${blockedNote}` });
      }
      if (unknown.length) items.push({ label: `${c.name}: selected tools`, status: "warn", detail: `Not on the server: ${unknown.join(", ")}`, fix: { label: "Edit tools", href: `/agents/${enc(agent.name)}?tab=tools` } });
    }));
    return result("connectors", items, t0);
  }

  // ── vault ──

  async vault(agent: AgentConfig): Promise<AgentTestCheckResult> {
    const t0 = Date.now();
    const store = this.deps.vault();
    const credsLink = (owner: string) => `/agents/${enc(owner)}?tab=credentials`;
    if (!store) return result("vault", [{ label: "Vault", status: "warn", detail: "The vault is not available on this server" }], t0);
    const items: AgentTestItem[] = [];
    const lists = new Map<string, Awaited<ReturnType<VaultStore["list"]>>>();
    const listOf = async (owner: string) => {
      if (!lists.has(owner)) lists.set(owner, await store.list(owner).catch(() => []));
      return lists.get(owner)!;
    };
    const own = await listOf(agent.name);
    items.push({ label: "Entries", status: "pass", detail: own.length ? own.map((e) => `${e.service}${e.sharedFrom ? ` (shared by ${e.sharedFrom})` : ""}`).join(", ") : "None" });
    // vault references of the engine: the agent's own credential, the harness's credential and gateway headers
    const refs: Array<{ ref: VaultRef; field?: string; where: string }> = [];
    const harness = agentHarness(agent);
    if (harness?.credentialRef) refs.push({ ref: harness.credentialRef, where: "engine.credentialRef" });
    if (harness) refs.push(...harnessVaultRefs(harnessesSettingsOf(this.deps.settings())?.[harness.harness]).map((r) => ({ ...r, where: `harness ${harness.harness}: ${r.where}` })));
    for (const r of refs) {
      const entry = (await listOf(r.ref.owner)).find((e) => e.service === r.ref.service && !e.sharedFrom);
      const label = `${r.where} → ${r.ref.owner} / ${r.ref.service}`;
      if (!entry) items.push({ label, status: "fail", detail: "The entry does not exist", fix: { label: "Open credentials", href: credsLink(r.ref.owner) } });
      else if (r.field && !entry.keys.includes(r.field)) items.push({ label, status: "fail", detail: `The entry has no field "${r.field}"`, fix: { label: "Open credentials", href: credsLink(r.ref.owner) } });
      else items.push({ label, status: "pass", detail: "Exists" });
    }
    // env_from_vault mappings written in its instructions and skills
    const sources: Array<{ where: string; text?: string }> = [{ where: "instructions", text: agent.systemPrompt }];
    if (agent.skills?.length) for (const s of this.deps.loadSkills(agent.name, agent.skills)) sources.push({ where: `skill ${s.name}`, text: s.content });
    for (const { where, text } of sources) {
      for (const m of envFromVaultMappings(text)) {
        const dot = m.ref.indexOf(".");
        const service = dot > 0 ? m.ref.slice(0, dot) : m.ref;
        const key = dot > 0 ? m.ref.slice(dot + 1) : undefined;
        const entry = own.find((e) => e.service === service);
        const label = `env_from_vault ${m.variable} → ${m.ref} (${where})`;
        if (!entry) items.push({ label, status: "fail", detail: `${agent.name} has no vault entry "${service}" (own or shared)`, fix: { label: "Add it", href: credsLink(agent.name) } });
        else if (key && !entry.keys.includes(key)) items.push({ label, status: "fail", detail: `The entry "${service}" has no field "${key}" (it has ${entry.keys.join(", ") || "none"})`, fix: { label: "Open credentials", href: credsLink(agent.name) } });
        else items.push({ label, status: "pass", detail: "Resolves" });
      }
    }
    return result("vault", items, t0);
  }

  // ── skills ──

  async skills(agent: AgentConfig, pins?: Record<string, number>): Promise<AgentTestCheckResult> {
    const t0 = Date.now();
    const names = agent.skills ?? [];
    if (!names.length) return result("skills", [], t0, "No skills assigned");
    const loaded = new Map(this.deps.loadSkills(agent.name, names).map((s) => [s.name, s]));
    const items: AgentTestItem[] = names.map((name) => {
      const s = loaded.get(name);
      if (!s) return { label: name, status: "fail", detail: "Not installed, or its SKILL.md cannot be read", fix: { label: "Open skills", href: "/skills" } };
      const pin = pins?.[name];
      if (pin !== undefined && !this.deps.skillVersionExists(name, pin)) {
        return { label: name, status: "fail", detail: `Pinned at v${pin}, which no longer exists`, fix: { label: "Open the skill", href: `/skills/${enc(name)}` } };
      }
      return { label: name, status: "pass", detail: `Loads${s.files ? ` · ${s.files} bundled files` : ""}${pin !== undefined ? ` · pinned v${pin}` : ""}` };
    });
    return result("skills", items, t0);
  }

  // ── computer & sandbox ──

  async computer(agent: AgentConfig, start: boolean): Promise<AgentTestCheckResult> {
    const t0 = Date.now();
    const settings = this.deps.settings();
    const items: AgentTestItem[] = [];
    const id = agent.defaultComputer || HOST_COMPUTER_ID;
    const data: Record<string, unknown> = { computer: id };
    let remote: ComputerConfig | undefined;
    if (id === HOST_COMPUTER_ID) {
      items.push({ label: "Computer", status: "pass", detail: "Works on this server" });
    } else {
      const c = this.deps.computers().find((x) => x.id === id);
      if (!c) {
        items.push({ label: `Computer ${id}`, status: "fail", detail: "There is no such computer", fix: { label: "Open computers", href: "/computers" } });
      } else if (!isRemoteComputer(c)) {
        items.push({ label: `Computer ${c.id}`, status: "pass", detail: "Runs on this server" });
      } else {
        remote = c;
        let live: ComputerLiveInfo;
        try { live = await within(20_000, this.deps.computerLive(c), "The computer's status"); } catch (err) { live = { status: "unknown", lastError: errorText(err) }; }
        const sleeping = ["stopped", "paused", "hibernated", "archived"].includes(live.status);
        if (sleeping && start) {
          try {
            await within(240_000, this.deps.startComputer(c), "Starting the computer");
            live = await this.deps.computerLive(c).catch(() => ({ status: "unknown" }));
          } catch (err) { live = { status: "error", lastError: errorText(err) }; }
        }
        data.status = live.status;
        const link = { label: "Open the computer", href: `/computers/${enc(c.id)}` };
        if (live.status === "running") items.push({ label: `Computer ${c.id} (${c.kind})`, status: "pass", detail: "Running" });
        else if (["stopped", "paused", "hibernated", "archived", "creating", "starting", "missing"].includes(live.status)) {
          data.canStart = true;
          items.push({ label: `Computer ${c.id} (${c.kind})`, status: "warn", detail: `${live.status}: it starts on first use. Use "Start and test" to check it now (a remote machine may cost).`, fix: link });
        } else {
          items.push({ label: `Computer ${c.id} (${c.kind})`, status: "fail", detail: `${live.status}${live.lastError ? `: ${live.lastError}` : ""}`, fix: link });
        }
      }
    }
    // the sandbox provider: the remote computer's, or the agent's own remote sandbox
    const provider = remote?.kind ?? (agent.sandbox?.provider === "daytona" || agent.sandbox?.provider === "e2b" ? agent.sandbox.provider : undefined);
    if (provider) {
      const sandboxLink = { label: "Sandbox settings", href: "/config?section=sandbox" };
      const st = await this.deps.sandboxProviderStatus(provider).catch(() => undefined);
      if (!st?.configured || !st.keyFound) {
        items.push({ label: `Sandbox provider ${provider}`, status: "fail", detail: st?.configured ? "Its API key's vault entry is missing" : "Not set up: choose the vault entry with its API key", fix: sandboxLink });
      } else if (data.status === "running") {
        items.push({ label: `Sandbox provider ${provider}`, status: "pass", detail: "Answers (the computer runs on it)" });
      } else {
        const r = await within(120_000, this.deps.sandboxProviderTest(provider), "The provider test").catch((err) => ({ ok: false, error: errorText(err) }) as { ok: boolean; error?: string; durationMs?: number });
        items.push(r.ok
          ? { label: `Sandbox provider ${provider}`, status: "pass", detail: `Answers${r.durationMs ? ` (${Math.round(r.durationMs / 100) / 10} s)` : ""}` }
          : { label: `Sandbox provider ${provider}`, status: "fail", detail: r.error ?? "The test failed", fix: sandboxLink });
      }
    }
    // egress: a remote computer's tailnet, else the proxy its browser uses from this server
    if (remote?.egress) {
      const e = await within(30_000, this.deps.computerEgress(remote), "The egress check").catch((err) => ({ tailnet: "unknown", proxyReachable: false, effective: "", error: errorText(err) }) as EgressInfo);
      const label = `Egress ${remote.egress} (tailnet)`;
      if (!e) items.push({ label, status: "skip" });
      else if (e.error) items.push({ label, status: "fail", detail: e.error, fix: { label: "Open the computer", href: `/computers/${enc(remote.id)}` } });
      else if (e.tailnet === "off") items.push({ label, status: "warn", detail: e.effective || "Checked when the computer runs" });
      else if (e.tailnet === "up" && e.proxyReachable) items.push({ label, status: "pass", detail: e.effective });
      else items.push({ label, status: "fail", detail: `tailnet ${e.tailnet}${e.proxyReachable ? "" : ", proxy unreachable"}: ${e.effective}`, fix: { label: "Open the computer", href: `/computers/${enc(remote.id)}` } });
    } else if (!remote) {
      const proxy = agentEgressName(agent, settings);
      if (proxy) {
        const url = settings?.egressProxies?.[proxy];
        if (!url) items.push({ label: `Egress ${proxy}`, status: "fail", detail: `There is no egress proxy "${proxy}": the browser goes out directly`, fix: { label: "Computers & egress", href: "/config?section=computers" } });
        else {
          const ok = await within(10_000, this.deps.proxyReachable(url), "The proxy check").catch(() => false);
          items.push(ok ? { label: `Egress ${proxy}`, status: "pass", detail: "Reachable" } : { label: `Egress ${proxy}`, status: "fail", detail: "Not reachable from this server", fix: { label: "Computers & egress", href: "/config?section=computers" } });
        }
      }
    }
    return result("computer", items, t0, undefined, data);
  }

  // ── channels ──

  async channels(agent: AgentConfig): Promise<AgentTestCheckResult> {
    const t0 = Date.now();
    const channels = (this.deps.settings()?.notifications?.channels ?? {}) as Record<string, { type?: string; gateway?: { agent?: string; enableInbound?: boolean; replyTo?: { channel: string } } }>;
    const items: AgentTestItem[] = [];
    for (const [name, ch] of Object.entries(channels)) {
      if (ch?.gateway?.agent !== agent.name) continue;
      const link = { label: "Open the channel", href: `/config?section=channels&channel=${enc(name)}` };
      const label = `${name} (${ch.type ?? "channel"})`;
      if (!ch.gateway.enableInbound) items.push({ label, status: "warn", detail: `Dedicated to ${agent.name}, but inbound is off: nobody reaches it here`, fix: link });
      else if (!this.deps.channelLive(name)) items.push({ label, status: "fail", detail: "Routed to the agent, but the channel is not running (check its token and the logs)", fix: link });
      else items.push({ label, status: "pass", detail: "Routed to the agent and running" });
      const via = ch.gateway.replyTo?.channel;
      if (via && !channels[via]) items.push({ label: `${name}: replies via ${via}`, status: "fail", detail: `There is no channel "${via}"`, fix: link });
    }
    return result("channels", items, t0, items.length ? undefined : "No channel routes to this agent");
  }

  // ── versioning ──

  async versioning(agent: AgentConfig, target: string): Promise<AgentTestCheckResult> {
    const t0 = Date.now();
    const versioning = agent.volatile ? undefined : this.deps.versioning?.();
    if (!versioning) return result("versioning", [], t0, "Not versioned");
    const s = await versioning.state(agent.name);
    const link = { label: "Open versions", href: `/agents/${enc(agent.name)}?tab=versions` };
    const items: AgentTestItem[] = [];
    items.push(s.production
      ? { label: "Production", status: "pass", detail: `${s.production}${s.latest && s.latest !== s.production ? ` (latest published: ${s.latest}, not deployed)` : ""}` }
      : { label: "Production", status: "warn", detail: "No version deployed yet", fix: link });
    if (s.draft.stale) items.push({ label: "Draft", status: "warn", detail: s.draft.warning ?? "The draft is based on a version production no longer runs: rebase or discard it", fix: link });
    else if (s.draft.hasChanges) items.push({ label: "Draft", status: "pass", detail: `${s.draft.changes.length} unpublished change(s)${s.draft.nextVersion ? ` → ${s.draft.nextVersion}` : ""}` });
    else items.push({ label: "Draft", status: "pass", detail: "No unpublished changes" });
    if (target !== "production") items.push({ label: "Tested", status: "pass", detail: target === "draft" ? "The draft (not what runs)" : `Version ${target}${target === s.production ? " (production)" : " (not production)"}` });
    return result("versioning", items, t0, undefined, { ...(s.production ? { production: s.production } : {}), ...(s.latest ? { latest: s.latest } : {}), draftStale: s.draft.stale, draftChanges: s.draft.changes.length });
  }

  // ── live smoke run ──

  async smoke(agent: AgentConfig, ref: string, prompt?: string): Promise<AgentTestCheckResult> {
    const t0 = Date.now();
    const native = !agentHarness(agent) && !agentCliEngine(agent);
    let r: SmokeResult;
    try { r = await within(180_000, this.deps.smoke(ref, prompt?.trim() || DEFAULT_SMOKE_PROMPT), "The smoke run"); } catch (err) {
      return result("smoke", [{ label: `Chat turn with ${ref}`, status: "fail", detail: errorText(err) }], t0);
    }
    const reply = r.text.trim().slice(0, 500);
    const items: AgentTestItem[] = [];
    items.push(reply ? { label: "Reply", status: "pass", detail: reply } : { label: "Reply", status: "fail", detail: "The agent did not answer" });
    if (native || r.toolCalls.length) {
      const call = r.toolCalls.find((c) => c.name === SMOKE_TOOL) ?? (prompt ? r.toolCalls[0] : undefined);
      const name = call?.name ?? SMOKE_TOOL;
      if (!call) items.push({ label: `Tool ${name}`, status: "warn", detail: `Not called${r.toolCalls.length ? ` (called ${r.toolCalls.map((c) => c.name).join(", ")})` : ""}` });
      else if (call.state === "error") items.push({ label: `Tool ${name}`, status: "fail", detail: `Called, and it failed${call.result ? `: ${String(typeof call.result === "string" ? call.result : JSON.stringify(call.result)).slice(0, 300)}` : ""}` });
      else items.push({ label: `Tool ${name}`, status: "pass", detail: "Called and completed" });
    }
    return result("smoke", items, t0, `${ref} answered in ${r.latencyMs} ms`, {
      ref, latencyMs: r.latencyMs, tools: r.toolCalls.map((c) => c.name), ...(r.sessionId ? { sessionId: r.sessionId } : {}),
    });
  }

  /** The agent's runs, newest first. */
  history(name: string, limit?: number): Promise<AgentTestRun[]> { return this.deps.store.list(name, limit); }
  get(name: string, id: string): Promise<AgentTestRun | undefined> { return this.deps.store.get(name, id); }
  /** The agent was removed: drop its history. */
  forget(name: string): Promise<void> { return this.deps.store.deleteAgent(name); }

  // ── fixes ──

  async fix(name: string, action: AgentTestFixAction): Promise<{ message: string }> {
    if (action.type !== "grant-connector-access") throw Object.assign(new Error("Unknown fix"), { name: "AgentTestError", code: "INVALID" });
    const c = this.deps.connectors().find((x) => x.id === action.connector);
    if (!c) throw Object.assign(new Error(`There is no connector "${action.connector}"`), { name: "AgentTestError", code: "NOT_FOUND" });
    if (connectorGrants({ ...c, enabled: true }, name)) return { message: `${c.name} already grants ${name}` };
    const problem = connectorAccessProblem(c.scope, { agents: [name] });
    if (problem) throw Object.assign(new Error(problem), { name: "AgentTestError", code: "INVALID" });
    await this.deps.grantConnector(c.id, name);
    return { message: `${c.name} now grants ${name}: its tools reach the agent from its next turn` };
  }
}

export type { AgentTestCheckId, AgentTestRun, AgentTestStatus };
