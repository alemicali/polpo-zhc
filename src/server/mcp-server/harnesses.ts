/**
 * Agent harnesses through MCP (no polpo_ask): the instance's harness settings (Configuration →
 * Harnesses), and the harness sessions agents run (status, stop, reset). An agent's engine is set
 * with polpo_agent_create / polpo_agent_update (engine).
 *
 * - polpo_harnesses_get (read): enabled harnesses, auth, credential reference and whether its vault
 *   entry exists (never the value), model, region, agents on each.
 * - polpo_harnesses_update (settings toolset, polpo:admin): enable/disable, auth type (API key,
 *   Bedrock, Vertex, Vercel AI Gateway, a custom gateway), credential reference, region, gateway,
 *   model; OpenCode with a provider API key, a Bedrock API key, a gateway and any model. The secret
 *   itself never passes here: when the entry is missing the tool returns setup_url + setup_id for
 *   polpo_setup_wait. A Claude subscription and OpenCode logins are refused.
 * - polpo_harnesses_get { test }: also tests a harness's connection: one tiny model request from
 *   the Polpo server with its auth and model (or an agent's own credential) → ok / latency /
 *   labelled error. (A parameter, not a tool: the default tool set stays within its bound.)
 * - polpo_harness_sessions_list (read): per agent and computer — bootstrapped, live, last
 *   detach/resume, turns, cost so far.
 * - polpo_harness_session_control (polpo:work): stop (the conversation stays resumable) or reset
 *   (forgets it; confirm: true).
 * - The CLI engine's accounts (personal Claude Code / Codex sign-ins: config directories on a
 *   computer, never tokens) are part of polpo_harnesses_get (cli: accounts with version and
 *   sign-in status) and polpo_harnesses_update (cli: add, remove, sign out, install, instance Codex).
 *   Signing in is the person's own flow in a terminal: the tool gives the dashboard link and command.
 */
import { z } from "zod";
import {
  DESTRUCTIVE, READ, UPDATE, apiError, apiGet, apiSend, confirmParam, enc, fail, ok,
  type McpDeps, type Register,
} from "./kit.js";
import { setupHandoff } from "./setup.js";
import { CLAUDE_SUBSCRIPTION_REFUSAL, OPENCODE_PROVIDER_IDS, OPENCODE_SUBSCRIPTION_REFUSAL } from "@polpo-ai/core/harnesses";
import { engineTypeText } from "@polpo-ai/core/engine-label";

type HarnessItem = {
  id: string; name: string; enabled: boolean; auth?: string; credentialRef?: { owner: string; service: string }; credentialFound?: boolean;
  model?: string; provider?: string; bedrock?: { region: string }; vertex?: { region: string; projectId: string }; agents: string[];
  gateway?: { preset?: string; format?: string; baseUrl?: string; authScheme?: string; headers?: Array<{ name: string; credentialRef?: { owner: string; service: string }; credentialFound?: boolean; value?: string }>; models?: { main: string }; nonClaude?: boolean };
  brokering?: "relay" | "in-vm" | "not-brokered";
};
type Overview = { allowHost: boolean; harnesses: HarnessItem[]; computers: string[]; relay?: { available: boolean; url?: string; path: string; warning?: string } };
type CliAccountView = {
  id: string; cli: string; computer: string; configDir: string; owner: string; label?: string; agents: string[];
  report?: { installed: boolean; version?: string; status?: { signedIn: boolean; who?: string; method?: string; plan?: string; detail?: string }; error?: string };
};
type CliOverview = { accounts: CliAccountView[]; allowInstanceCodex: boolean };
/** One CLI account, in words: where, whose, installed, signed in. */
export const cliAccountLine = (a: CliAccountView) => `- CLI account ${a.id}${a.label ? ` (${a.label})` : ""}: ${a.cli === "claude" ? "Claude Code" : "Codex"} on ${a.computer}, owner ${a.owner}, dir ${a.configDir}`
  + (a.report ? (a.report.installed
    ? `, v${a.report.version ?? "?"}, ${a.report.status?.signedIn ? `signed in${a.report.status.who ? ` as ${a.report.status.who}` : ""}${a.report.status.plan ? ` (${a.report.status.plan})` : ""}` : "NOT signed in"}`
    : `, NOT installed${a.report.error ? ` (${a.report.error})` : ""}`) : "")
  + (a.agents.length ? ` · agents: ${a.agents.join(", ")}` : "");
type TestResult = { ok: boolean; harness: string; auth?: string; model?: string; endpoint?: string; latencyMs: number; status?: number; errorKind?: string; error?: string; note?: string };
type Session = {
  key: string; agent: string; harness: string; computerId: string; scope: string; taskId?: string; state: string; live: boolean;
  sessionId?: string; bootstrappedAt?: string; bootstrapMs?: number; lastDetachAt?: string; lastResumeAt?: string; resumable: boolean;
  turns: number; costUsd: number; lastError?: string; updatedAt: string;
  /** "cli": the CLI engine (the official program on a person's account): cli and account say which. */
  engine?: "harness" | "cli"; cli?: string; account?: string; chatSessionId?: string;
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

const vaultRef = z.object({ owner: z.string().min(1).describe("The agent whose vault holds the entry"), service: z.string().min(1).describe("The entry's service name") });
/** A gateway in the tool's snake_case; mapped to settings' camelCase by gatewaySettings. */
const gatewayInput = z.object({
  preset: z.enum(["vercel", "cloudflare", "openrouter", "litellm", "portkey", "kong", "custom"]).optional().describe("A label for the dashboard (the URL, scheme and headers are what count)"),
  format: z.enum(["anthropic", "openai-responses", "openai-chat"]).optional().describe("Custom gateways: anthropic (Claude Code), openai-responses (Codex); OpenCode takes any of the three, openai-chat (Chat Completions) for most gateways and open models"),
  base_url: z.string().optional().describe("https base URL: Claude Code adds /v1/messages (e.g. https://openrouter.ai/api, https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic); "
    + "Codex adds /responses, so it ends in /v1 (Cloudflare: …/openai); OpenCode adds /v1/messages (anthropic) or /chat/completions, /responses (e.g. https://openrouter.ai/api/v1). AI Gateway: optional (default https://ai-gateway.vercel.sh)"),
  credential_ref: vaultRef.optional().describe("The vault entry with the gateway key (never the key)"),
  auth_scheme: z.enum(["x-api-key", "bearer", "none"]).optional().describe("How the key is sent (custom gateways; default bearer). none: auth goes in a header"),
  headers: z.array(z.object({
    name: z.string().describe("Header name, e.g. cf-aig-authorization, x-portkey-api-key, x-portkey-provider"),
    credential_ref: vaultRef.optional().describe("A secret value: its vault entry"),
    field: z.string().optional().describe("The entry's field (default apiKey / key / token)"),
    prefix: z.string().optional().describe("Before the secret, e.g. \"Bearer \""),
    value: z.string().optional().describe("A literal value that is not a secret (e.g. x-portkey-provider: anthropic)"),
  })).optional().describe("Extra headers for every model request: injected by Polpo's relay outside the computer"),
  models: z.object({ main: z.string(), haiku: z.string().optional(), sonnet: z.string().optional(), opus: z.string().optional() }).optional()
    .describe("Gateway model ids: main, and what Claude Code's haiku / sonnet / opus aliases map to"),
  non_claude: z.boolean().optional().describe("Claude Code on non-Claude models (Anthropic format): no experimental betas, no adaptive thinking or effort; models.main required"),
}).nullable().optional();

function gatewaySettings(g: z.infer<typeof gatewayInput>, cur: Record<string, any> | undefined): Record<string, any> | undefined {
  if (g === null) return undefined;
  if (!g) return cur;
  const out: Record<string, any> = { ...(cur ?? {}) };
  if (g.preset) out.preset = g.preset;
  if (g.format) out.format = g.format;
  if (g.base_url !== undefined) { if (g.base_url) out.baseUrl = g.base_url; else delete out.baseUrl; }
  if (g.credential_ref) out.credentialRef = g.credential_ref;
  if (g.auth_scheme) { out.authScheme = g.auth_scheme; if (g.auth_scheme === "none") delete out.credentialRef; }
  if (g.headers) out.headers = g.headers.map((h) => ({ name: h.name, ...(h.credential_ref ? { credentialRef: h.credential_ref } : {}), ...(h.field ? { field: h.field } : {}), ...(h.prefix ? { prefix: h.prefix } : {}), ...(h.value !== undefined ? { value: h.value } : {}) }));
  if (g.models) out.models = Object.fromEntries(Object.entries(g.models).filter(([, v]) => !!v));
  if (g.non_claude !== undefined) { if (g.non_claude) out.nonClaude = true; else delete out.nonClaude; }
  return out;
}

/** A test result in words. */
export const testLine = (t: TestResult) => t.ok
  ? `${t.harness}: OK in ${t.latencyMs} ms${t.model ? ` (model ${t.model}` : " ("}${t.endpoint ? `${t.model ? ", " : ""}${t.endpoint}` : ""})${t.note ? ` — ${t.note}` : ""}`
  : `${t.harness}: FAILED (${t.errorKind ?? "error"}) after ${t.latencyMs} ms — ${t.error ?? "unknown error"}`;
const harnessItem = z.object({ id: z.string(), name: z.string(), enabled: z.boolean(), agents: z.array(z.string()) }).passthrough();
const sessionItem = z.object({ key: z.string(), agent: z.string(), harness: z.string(), computerId: z.string(), state: z.string(), live: z.boolean(), costUsd: z.number() }).passthrough();

/** One harness, in words: the credential is always said to be found or missing in the vault. */
export const harnessLine = (h: HarnessItem) => `- ${h.name} (${h.id}): ${h.enabled ? "enabled" : "disabled"}`
  + (h.auth ? `, auth ${h.auth}${h.provider ? ` (${h.provider})` : ""}${h.bedrock ? ` (${h.bedrock.region})` : ""}${h.vertex ? ` (${h.vertex.projectId}, ${h.vertex.region})` : ""}` : ", not configured")
  + (h.gateway ? `, gateway ${h.gateway.preset ? `${h.gateway.preset} ` : ""}${h.gateway.baseUrl ?? "(Vercel AI Gateway)"}${h.gateway.authScheme ? ` [${h.gateway.authScheme}]` : ""}`
    + `${h.gateway.headers?.length ? `, headers ${h.gateway.headers.map((x) => `${x.name}${x.credentialRef ? `=${x.credentialRef.owner}/${x.credentialRef.service}${x.credentialFound === false ? " (MISSING)" : ""}` : ""}`).join(", ")}` : ""}`
    + `${h.gateway.nonClaude ? ", non-Claude models" : ""}` : "")
  + (h.credentialRef ? `, credential ${h.credentialRef.owner} / ${h.credentialRef.service} ${h.credentialFound ? "(found in the vault)" : "(MISSING in the vault)"}` : "")
  + (h.model ? `, model ${h.model}` : h.gateway?.models?.main ? `, model ${h.gateway.models.main}` : "")
  + (h.brokering ? `, key ${h.brokering === "relay" ? "brokered by Polpo's relay (not in the VM)" : h.brokering === "in-vm" ? "in the VM (no POLPO_PUBLIC_URL)" : "in the VM (Claude Code on Bedrock/Vertex signs requests)"}` : "")
  + (h.agents.length ? ` · agents: ${h.agents.join(", ")}` : "");

const sessionLine = (s: Session) => `- ${s.key} · ${s.agent} on ${s.computerId} (${s.engine === "cli" ? `${engineTypeText(s.cli === "codex" ? "codex-cli" : "claude-cli")}, account ${s.account ?? "?"}` : engineTypeText(s.harness)}): ${s.state}${s.live ? " (live)" : ""}`
  + `${s.bootstrappedAt ? `, bootstrapped ${s.bootstrappedAt}${s.bootstrapMs ? ` in ${Math.round(s.bootstrapMs / 1000)} s` : ""}` : ""}`
  + `${s.lastDetachAt ? `, detached ${s.lastDetachAt}` : ""}${s.lastResumeAt ? `, resumed ${s.lastResumeAt}` : ""}`
  + `, ${s.turns} turn(s), ${s.engine === "cli" ? `${(s.tokens ? s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite : 0)} tokens on the plan` : `$${s.costUsd.toFixed(4)}`}${s.resumable ? ", resumable" : ""}${s.lastError ? `, error: ${s.lastError}` : ""}`;

export function registerHarnessTools(tool: Register, deps: McpDeps): void {
  tool("settings", "polpo_harnesses_get", {
    title: "Agent harnesses",
    description: "The official agent harnesses agents may run on (Claude Code, Codex, OpenCode): which are enabled, their auth type (api-key, bedrock, vertex, ai-gateway, gateway; OpenCode's provider), "
      + "credential vault reference and whether that entry exists (never its value), region, default model, the agents using each, and the computers "
      + "that can run them, and whether their key stays on the server (model relay). With test: also checks that harness's connection — one tiny "
      + "streaming model request FROM THE POLPO SERVER (never the computer) with its auth and model (Anthropic Messages with a tool for Claude Code, "
      + "OpenAI Responses for Codex, Converse for Bedrock, rawPredict for Vertex; OpenCode: its provider's format); with agent, that agent's own key and model. The test says ok and "
      + "latency, or a labelled error (auth, model, network, timeout, protocol, config) with what to change: run it after polpo_harnesses_update. "
      + "Set an agent on one with polpo_agent_update engine; change these settings with polpo_harnesses_update.",
    inputSchema: {
      test: z.enum(["claude-code", "codex", "opencode"]).optional().describe("Also test this harness's connection (one tiny model request from the Polpo server)"),
      agent: z.string().optional().describe("With test: use this agent's engine (its own key and model)"),
    },
    outputSchema: { allowHost: z.boolean(), harnesses: z.array(harnessItem), computers: z.array(z.string()), test: z.record(z.string(), z.unknown()).optional(), cli: z.record(z.string(), z.unknown()).optional() },
    annotations: { ...READ, openWorldHint: true },
  }, async ({ test, agent }) => {
    const r = await apiGet(deps, "/harnesses");
    if (!r.ok) return apiError(r, "Reading the harnesses");
    const o = r.data as Overview;
    const cr = await apiGet(deps, "/harnesses/cli/accounts");
    const cli = cr.ok ? (cr.data as CliOverview) : undefined;
    let t: TestResult | undefined;
    if (test) {
      const tr = await apiSend(deps, "POST", "/harnesses/test", { harness: test, ...(agent ? { agent } : {}) });
      if (!tr.ok) return apiError(tr, `Testing ${test}`);
      t = tr.data as TestResult;
    }
    return ok([...o.harnesses.map(harnessLine), `Agents on this server may use a harness: ${o.allowHost ? "yes (isolated HOME)" : "no"}`,
      `Computers that can run one: ${o.computers.join(", ") || "none (create a Daytona v2 computer)"}`,
      ...(o.relay ? [o.relay.available ? `Model relay: ${o.relay.url}` : `Model relay: off — ${o.relay.warning}`] : []),
      ...(t ? [`Connection test: ${testLine(t)}`] : []),
      ...(cli ? ["CLI engine accounts (personal sign-ins; agent.engine { type: \"cli\" }):", ...(cli.accounts.length ? cli.accounts.map(cliAccountLine) : ["- none"]),
        `Instance Codex accounts: ${cli.allowInstanceCodex ? "allowed" : "not allowed"}`] : [])].join("\n"),
    { ...(o as unknown as Record<string, unknown>), ...(t ? { test: t } : {}), ...(cli ? { cli: cli as unknown as Record<string, unknown> } : {}) });
  });

  tool("settings", "polpo_harnesses_update", {
    title: "Change agent harness settings",
    description: "Enable or disable Claude Code, Codex and OpenCode for agents and set how they authenticate: auth type, the vault entry with the credential "
      + "(owner + service: a reference, never the key), Bedrock region, Vertex project and region, a model gateway (ai-gateway: the Vercel AI Gateway; "
      + "gateway: Cloudflare AI Gateway, OpenRouter, LiteLLM, Portkey, Kong… with format, base_url, auth_scheme, headers from the vault, models), default model. "
      + "Only the fields given change. Gateway keys and secret headers are injected by Polpo's model relay, never put in the computer. "
      + "A Claude subscription (Pro/Max login) is refused by Anthropic's terms: use an Anthropic API key, Bedrock, Vertex or a gateway. Codex takes an OpenAI API key or a gateway. "
      + "OpenCode runs any model: a provider API key (provider: " + OPENCODE_PROVIDER_IDS.join(", ") + "), a Bedrock API key (open-weight models on Bedrock: Kimi, GLM, Qwen, DeepSeek…), "
      + "the Vercel AI Gateway or a custom gateway (anthropic, openai-responses or openai-chat); its model is required. OpenCode logins and subscriptions (ChatGPT, Copilot, OpenCode Zen…) are refused. "
      + "Check the result with polpo_harnesses_get { test }. "
      + "When the credential's vault entry does not exist yet, the result gives setup_url: show it to the person (they paste the key there), "
      + "then call polpo_setup_wait with setup_id. Disabling a harness that agents use is refused (move them to engine \"polpo\" first).",
    inputSchema: {
      enabled: z.array(z.enum(["claude-code", "codex", "opencode"])).optional().describe("The harnesses agents may use (replaces the list; [] disables all)"),
      allow_host: z.boolean().optional().describe("Agents on this server (no remote computer) may use a harness, with an isolated HOME (default false)"),
      claude_code: z.object({
        // "subscription" is accepted here only to answer with the reason it is refused (Anthropic's terms)
        auth: z.enum(["api-key", "bedrock", "vertex", "ai-gateway", "gateway", "subscription"]).optional()
          .describe("api-key: Anthropic API key; bedrock: Amazon Bedrock; vertex: Google Vertex AI; ai-gateway: Vercel AI Gateway; gateway: a custom gateway (format anthropic). \"subscription\" (a Claude Pro/Max login) is always refused"),
        gateway: gatewayInput.describe("For auth ai-gateway / gateway (null removes it)"),
        credential_ref: vaultRef.optional().describe("The vault entry with the credential: api-key/bedrock → apiKey (Bedrock: a Bedrock API key, or accessKeyId + secretAccessKey); vertex → serviceAccountJson"),
        bedrock_region: z.string().optional().describe("AWS region for Bedrock, e.g. us-east-1"),
        vertex: z.object({ region: z.string(), project_id: z.string() }).optional().describe("Google Cloud region and project for Vertex AI"),
        model: z.string().nullable().optional().describe("Default model id (Bedrock: an inference profile such as us.anthropic.claude-sonnet-4-5-20250929-v1:0); null clears it"),
      }).nullable().optional().describe("Claude Code's settings (null removes them)"),
      codex: z.object({
        auth: z.enum(["api-key", "ai-gateway", "gateway"]).optional().describe("api-key: OpenAI API key; ai-gateway: Vercel AI Gateway; gateway: a custom gateway with the OpenAI Responses API (format openai-responses)"),
        credential_ref: vaultRef.optional().describe("The vault entry with the OpenAI API key (field apiKey or OPENAI_API_KEY)"),
        gateway: gatewayInput.describe("For auth ai-gateway / gateway (null removes it)"),
        model: z.string().nullable().optional().describe("Default model id; null clears it"),
      }).nullable().optional().describe("Codex's settings (null removes them)"),
      opencode: z.object({
        // "subscription" is accepted here only to answer with the reason it is refused
        auth: z.enum(["api-key", "bedrock", "ai-gateway", "gateway", "subscription"]).optional()
          .describe("api-key: a model provider's API key (with provider); bedrock: an Amazon Bedrock API key; ai-gateway: Vercel AI Gateway; gateway: a custom gateway. \"subscription\" (a login) is always refused"),
        provider: z.enum(OPENCODE_PROVIDER_IDS as [string, ...string[]]).optional().describe("For auth api-key: the model provider (OpenCode's id)"),
        credential_ref: vaultRef.optional().describe("The vault entry with the key: api-key → the provider's API key (apiKey); bedrock → a Bedrock API key (apiKey or AWS_BEARER_TOKEN_BEDROCK; AWS access keys are not used)"),
        bedrock_region: z.string().optional().describe("AWS region for Bedrock, e.g. us-east-1"),
        gateway: gatewayInput.describe("For auth ai-gateway / gateway (null removes it)"),
        model: z.string().nullable().optional().describe("Default model, the provider's id (e.g. claude-sonnet-4-5, gpt-5, global.moonshotai.kimi-k3.1 on Bedrock, moonshotai/kimi-k2 on the AI Gateway or OpenRouter); null clears it"),
      }).nullable().optional().describe("OpenCode's settings (null removes them)"),
      cli: z.object({
        add_account: z.object({
          cli: z.enum(["claude", "codex"]),
          id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional(),
          computer: z.string().optional().describe("\"host\" (default) or a computer id"),
          label: z.string().max(80).optional(),
        }).optional().describe("Add a CLI account (a config directory on the computer; its owner is you). Then the person signs in: the result says how"),
        remove_account: z.string().optional().describe("Remove this account (refused while agents use it)"),
        sign_out: z.string().optional().describe("Sign this account out with the CLI's own command"),
        install: z.object({ cli: z.enum(["claude", "codex"]), computer: z.string().optional() }).optional().describe("Install the CLI with its official installer (npm) on this server or a computer"),
        allow_instance_codex: z.boolean().optional().describe("Codex accounts owned by \"instance\" may run any work of the instance (shared ChatGPT plan: check OpenAI's terms)"),
      }).optional().describe("The CLI engine (official Claude Code / Codex signed in with a person's own plan). Polpo never sees a token: signing in is Anthropic's / OpenAI's own flow in a terminal"),
    },
    outputSchema: { harnesses: z.array(harnessItem), changed: z.array(z.string()) },
    annotations: UPDATE,
  }, async ({ enabled, allow_host, claude_code, codex, opencode, cli }) => {
    if (enabled === undefined && allow_host === undefined && claude_code === undefined && codex === undefined && opencode === undefined && cli === undefined) {
      return fail("Nothing to change: give enabled, allow_host, claude_code, codex, opencode or cli.");
    }
    if (cli && enabled === undefined && allow_host === undefined && claude_code === undefined && codex === undefined && opencode === undefined) {
      const lines: string[] = [];
      if (cli.install) {
        const r = await apiSend(deps, "POST", "/harnesses/cli/install", cli.install);
        const d = r.ok ? (r.data as { ok: boolean; version?: string; output?: string }) : undefined;
        lines.push(d?.ok ? `Installed ${cli.install.cli}${d.version ? ` ${d.version}` : ""}.` : `Install failed: ${d?.output ?? (r as { error?: string }).error ?? "error"}`);
      }
      if (cli.add_account) {
        const r = await apiSend(deps, "POST", "/harnesses/cli/accounts", cli.add_account);
        if (!r.ok) return apiError(r, "Adding the CLI account");
        const a = r.data as { id: string; cli: string; computer: string; configDir: string };
        const login = await apiGet(deps, `/harnesses/cli/accounts/${enc(a.id)}/login`);
        const how = login.ok ? (login.data as { command: string; mode: string }) : undefined;
        lines.push(`Added CLI account ${a.id} (${a.configDir} on ${a.computer}). Sign in: the person opens Settings → Harnesses → CLI accounts → Sign in in the dashboard`
          + `${how ? ` (or runs \`${how.command}\` on ${a.computer})` : ""} and completes ${a.cli === "claude" ? "Anthropic's" : "OpenAI's"} own sign-in. Polpo never sees the token.`);
      }
      if (cli.sign_out) {
        const r = await apiSend(deps, "POST", `/harnesses/cli/accounts/${enc(cli.sign_out)}/logout`, {});
        if (!r.ok) return apiError(r, "Signing the CLI account out");
        lines.push(`Signed out ${cli.sign_out}.`);
      }
      if (cli.remove_account) {
        const r = await apiSend(deps, "DELETE", `/harnesses/cli/accounts/${enc(cli.remove_account)}`);
        if (!r.ok) return apiError(r, "Removing the CLI account");
        lines.push(`Removed CLI account ${cli.remove_account} (its sign-in stays in its directory until signed out).`);
      }
      if (cli.allow_instance_codex !== undefined) {
        const r = await apiSend(deps, "PATCH", "/harnesses/cli/settings", { allowInstanceCodex: cli.allow_instance_codex });
        if (!r.ok) return apiError(r, "Changing the CLI settings");
        lines.push(`Instance Codex accounts: ${cli.allow_instance_codex ? "allowed (a shared ChatGPT plan: check OpenAI's terms)" : "not allowed"}.`);
      }
      const after = await apiGet(deps, "/harnesses");
      const o = (after.ok ? after.data : { harnesses: [] }) as Overview;
      return ok(lines.join("\n") || "Nothing changed.", { harnesses: o.harnesses, changed: ["cli"] });
    }
    if (claude_code?.auth === "subscription") return fail(`${CLAUDE_SUBSCRIPTION_REFUSAL}. Nothing was changed.`);
    if (opencode?.auth === "subscription") return fail(`${OPENCODE_SUBSCRIPTION_REFUSAL}. Nothing was changed.`);
    const cfg = await apiGet(deps, "/config");
    if (!cfg.ok) return apiError(cfg, "Reading the configuration");
    const cur = ((cfg.data as { settings?: { harnesses?: Record<string, any> } })?.settings?.harnesses ?? { enabled: [] }) as Record<string, any>;
    const next: Record<string, any> = JSON.parse(JSON.stringify(cur));
    next.enabled ??= [];
    if (enabled !== undefined) next.enabled = enabled;
    if (allow_host !== undefined) { if (allow_host) next.allowHost = true; else delete next.allowHost; }
    if (claude_code === null) delete next["claude-code"];
    else if (claude_code) {
      const c: Record<string, any> = { ...(next["claude-code"] ?? {}) };
      if (claude_code.auth) c.auth = claude_code.auth;
      if (claude_code.credential_ref) c.credentialRef = claude_code.credential_ref;
      if (claude_code.bedrock_region) c.bedrock = { region: claude_code.bedrock_region };
      if (claude_code.vertex) c.vertex = { region: claude_code.vertex.region, projectId: claude_code.vertex.project_id };
      if (claude_code.model === null) delete c.model; else if (claude_code.model) c.model = claude_code.model;
      const g = gatewaySettings(claude_code.gateway, c.gateway);
      if (g) c.gateway = g; else delete c.gateway;
      if (c.auth !== "bedrock") delete c.bedrock;
      if (c.auth !== "vertex") delete c.vertex;
      if (c.auth === "ai-gateway" || c.auth === "gateway") {
        if (c.gateway && !c.gateway.credentialRef && c.credentialRef && c.gateway.authScheme !== "none") c.gateway.credentialRef = c.credentialRef;
        delete c.credentialRef;
        if (c.auth === "ai-gateway" && c.gateway) for (const k of Object.keys(c.gateway)) if (!["baseUrl", "credentialRef", "preset"].includes(k)) delete c.gateway[k];
      } else {
        delete c.gateway;
      }
      next["claude-code"] = c;
    }
    if (codex === null) delete next.codex;
    else if (codex) {
      const c: Record<string, any> = { auth: "api-key", ...(next.codex ?? {}) };
      if (codex.auth) c.auth = codex.auth;
      if (codex.credential_ref) c.credentialRef = codex.credential_ref;
      if (codex.model === null) delete c.model; else if (codex.model) c.model = codex.model;
      const g = gatewaySettings(codex.gateway, c.gateway);
      if (g) c.gateway = g; else delete c.gateway;
      if (c.auth === "ai-gateway" || c.auth === "gateway") {
        if (c.gateway && !c.gateway.credentialRef && c.credentialRef && c.gateway.authScheme !== "none") c.gateway.credentialRef = c.credentialRef;
        delete c.credentialRef;
        if (c.auth === "ai-gateway" && c.gateway) for (const k of Object.keys(c.gateway)) if (!["baseUrl", "credentialRef", "preset"].includes(k)) delete c.gateway[k];
      } else {
        delete c.gateway;
      }
      next.codex = c;
    }
    if (opencode === null) delete next.opencode;
    else if (opencode) {
      const c: Record<string, any> = { ...(next.opencode ?? {}) };
      if (opencode.auth) c.auth = opencode.auth;
      if (opencode.provider) c.provider = opencode.provider;
      if (opencode.credential_ref) c.credentialRef = opencode.credential_ref;
      if (opencode.bedrock_region) c.bedrock = { region: opencode.bedrock_region };
      if (opencode.model === null) delete c.model; else if (opencode.model) c.model = opencode.model;
      const g = gatewaySettings(opencode.gateway, c.gateway);
      if (g) c.gateway = g; else delete c.gateway;
      if (c.auth !== "bedrock") delete c.bedrock;
      if (c.auth !== "api-key") delete c.provider;
      if (c.auth === "ai-gateway" || c.auth === "gateway") {
        if (c.gateway && !c.gateway.credentialRef && c.credentialRef && c.gateway.authScheme !== "none") c.gateway.credentialRef = c.credentialRef;
        delete c.credentialRef;
        if (c.auth === "ai-gateway" && c.gateway) for (const k of Object.keys(c.gateway)) if (!["baseUrl", "credentialRef", "preset"].includes(k)) delete c.gateway[k];
        if (c.gateway) delete c.gateway.nonClaude;
      } else {
        delete c.gateway;
      }
      next.opencode = c;
    }
    const r = await apiSend(deps, "PATCH", "/config/settings", { harnesses: next });
    if (!r.ok) return apiError(r, "Changing the harness settings");
    const changed = [...new Set([...Object.keys(cur), ...Object.keys(next)])].filter((k) => JSON.stringify(cur[k]) !== JSON.stringify(next[k]));
    const after = await apiGet(deps, "/harnesses");
    const o = (after.ok ? after.data : { harnesses: [] }) as Overview;
    // a credential entry that is not there yet: the person enters the secret in the dashboard
    const missing = o.harnesses.find((h) => h.credentialRef && h.credentialFound === false && next.enabled.includes(h.id));
    const handoff = missing?.credentialRef
      ? setupHandoff(deps, { kind: "vault", item: missing.credentialRef.owner, field: missing.credentialRef.service }, `${missing.name} ${missing.auth === "vertex" ? "service account key (serviceAccountJson)" : missing.auth === "bedrock" ? "Bedrock API key" : missing.auth === "ai-gateway" || missing.auth === "gateway" ? "gateway key" : "API key"}`)
      : undefined;
    return ok([`Harness settings changed: ${changed.join(", ") || "nothing (same values)"}.`, ...o.harnesses.map(harnessLine), ...(handoff ? ["", handoff.next_step] : [])].join("\n"),
      { harnesses: o.harnesses, changed, ...(handoff ?? {}) });
  });

  tool("settings", "polpo_harness_sessions_list", {
    title: "Harness sessions",
    description: "The harness sessions agents run (one per task run or chat on Claude Code / Codex / OpenCode): agent, computer, state (running, idle, detached "
      + "while its computer hibernates, stopped, error), whether it is live now, when its runtime was bootstrapped in the computer (and how long it took), "
      + "last detach and resume, turns and cost so far. Filter by agent or computer.",
    inputSchema: {
      agent: z.string().optional().describe("Only this agent's sessions"),
      computer: z.string().optional().describe("Only sessions on this computer (\"host\": this server)"),
    },
    outputSchema: { sessions: z.array(sessionItem) },
    annotations: READ,
  }, async ({ agent, computer }) => {
    const q = new URLSearchParams();
    if (agent) q.set("agent", agent);
    if (computer) q.set("computer", computer);
    const r = await apiGet(deps, `/harnesses/sessions${q.size ? `?${q}` : ""}`);
    if (!r.ok) return apiError(r, "Listing harness sessions");
    const sessions = ((r.data as { sessions?: Session[] })?.sessions ?? []);
    return ok(sessions.length ? sessions.map(sessionLine).join("\n") : "No harness sessions.", { sessions });
  });

  tool("settings", "polpo_harness_session_control", {
    title: "Stop or reset a harness session",
    description: "stop: end a harness session's runtime (its bridge process in the computer exits; the conversation stays and resumes on the next turn). "
      + "reset: stop it and forget it — the next run starts a new conversation (needs confirm: true). A session a task run holds right now is refused: "
      + "kill the task instead. Keys come from polpo_harness_sessions_list.",
    inputSchema: {
      key: z.string().min(1).describe("The session's key (polpo_harness_sessions_list), e.g. task:abc123"),
      action: z.enum(["stop", "reset"]).describe("stop: end the runtime, keep the conversation; reset: forget it (needs confirm)"),
      confirm: confirmParam("forget the session's conversation"),
    },
    outputSchema: { key: z.string(), action: z.string(), message: z.string() },
    annotations: { ...DESTRUCTIVE, idempotentHint: true },
    scope: "polpo:work",
  }, async ({ key, action, confirm }) => {
    if (action === "reset" && confirm !== true) return fail(`Resetting ${key} forgets its conversation: ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "POST", `/harnesses/sessions/${enc(key)}/${action}`, action === "reset" ? { confirm: true } : undefined);
    if (!r.ok) return apiError(r, `${action} of harness session ${key}`);
    const message = (r.data as { message?: string })?.message ?? `${action} done`;
    return ok(message, { key, action, message });
  });
}
