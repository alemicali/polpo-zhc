/**
 * Agent harnesses through MCP (no polpo_ask): the instance's harness settings (Configuration →
 * Harnesses), and the harness sessions agents run (status, stop, reset). An agent's engine is set
 * with polpo_agent_create / polpo_agent_update (engine).
 *
 * - polpo_harnesses_get (read): enabled harnesses, auth, credential reference and whether its vault
 *   entry exists (never the value), model, region, agents on each.
 * - polpo_harnesses_update (settings toolset, polpo:admin): enable/disable, auth type (API key,
 *   Bedrock, Vertex, Vercel AI Gateway, a custom gateway), credential reference, region, gateway,
 *   model. The secret itself never passes here: when the entry is missing the tool returns
 *   setup_url + setup_id for polpo_setup_wait. A Claude subscription is refused.
 * - polpo_harnesses_test (read): one tiny model request from the Polpo server with a harness's
 *   auth and model (saved settings, or an agent's own credential) → ok / latency / labelled error.
 * - polpo_harness_sessions_list (read): per agent and computer — bootstrapped, live, last
 *   detach/resume, turns, cost so far.
 * - polpo_harness_session_control (polpo:work): stop (the conversation stays resumable) or reset
 *   (forgets it; confirm: true).
 */
import { z } from "zod";
import {
  DESTRUCTIVE, READ, UPDATE, apiError, apiGet, apiSend, confirmParam, enc, fail, ok,
  type McpDeps, type Register,
} from "./kit.js";
import { setupHandoff } from "./setup.js";
import { CLAUDE_SUBSCRIPTION_REFUSAL } from "@polpo-ai/core/harnesses";

type HarnessItem = {
  id: string; name: string; enabled: boolean; auth?: string; credentialRef?: { owner: string; service: string }; credentialFound?: boolean;
  model?: string; bedrock?: { region: string }; vertex?: { region: string; projectId: string }; agents: string[];
  gateway?: { preset?: string; format?: string; baseUrl?: string; authScheme?: string; headers?: Array<{ name: string; credentialRef?: { owner: string; service: string }; credentialFound?: boolean; value?: string }>; models?: { main: string }; nonClaude?: boolean };
  brokering?: "relay" | "in-vm" | "not-brokered";
};
type Overview = { allowHost: boolean; harnesses: HarnessItem[]; computers: string[]; relay?: { available: boolean; url?: string; path: string; warning?: string } };
type TestResult = { ok: boolean; harness: string; auth?: string; model?: string; endpoint?: string; latencyMs: number; status?: number; errorKind?: string; error?: string; note?: string };
type Session = {
  key: string; agent: string; harness: string; computerId: string; scope: string; taskId?: string; state: string; live: boolean;
  sessionId?: string; bootstrappedAt?: string; bootstrapMs?: number; lastDetachAt?: string; lastResumeAt?: string; resumable: boolean;
  turns: number; costUsd: number; lastError?: string; updatedAt: string;
};

const vaultRef = z.object({ owner: z.string().min(1).describe("The agent whose vault holds the entry"), service: z.string().min(1).describe("The entry's service name") });
/** A gateway in the tool's snake_case; mapped to settings' camelCase by gatewaySettings. */
const gatewayInput = z.object({
  preset: z.enum(["vercel", "cloudflare", "openrouter", "litellm", "portkey", "kong", "custom"]).optional().describe("A label for the dashboard (the URL, scheme and headers are what count)"),
  format: z.enum(["anthropic", "openai-responses"]).optional().describe("Custom gateways: anthropic (Claude Code) or openai-responses (Codex)"),
  base_url: z.string().optional().describe("https base URL: Claude Code adds /v1/messages (e.g. https://openrouter.ai/api, https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic); "
    + "Codex adds /responses, so it ends in /v1 (Cloudflare: …/openai). AI Gateway: optional (default https://ai-gateway.vercel.sh)"),
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
  + (h.auth ? `, auth ${h.auth}${h.bedrock ? ` (${h.bedrock.region})` : ""}${h.vertex ? ` (${h.vertex.projectId}, ${h.vertex.region})` : ""}` : ", not configured")
  + (h.gateway ? `, gateway ${h.gateway.preset ? `${h.gateway.preset} ` : ""}${h.gateway.baseUrl ?? "(Vercel AI Gateway)"}${h.gateway.authScheme ? ` [${h.gateway.authScheme}]` : ""}`
    + `${h.gateway.headers?.length ? `, headers ${h.gateway.headers.map((x) => `${x.name}${x.credentialRef ? `=${x.credentialRef.owner}/${x.credentialRef.service}${x.credentialFound === false ? " (MISSING)" : ""}` : ""}`).join(", ")}` : ""}`
    + `${h.gateway.nonClaude ? ", non-Claude models" : ""}` : "")
  + (h.credentialRef ? `, credential ${h.credentialRef.owner} / ${h.credentialRef.service} ${h.credentialFound ? "(found in the vault)" : "(MISSING in the vault)"}` : "")
  + (h.model ? `, model ${h.model}` : h.gateway?.models?.main ? `, model ${h.gateway.models.main}` : "")
  + (h.brokering ? `, key ${h.brokering === "relay" ? "brokered by Polpo's relay (not in the VM)" : h.brokering === "in-vm" ? "in the VM (no POLPO_PUBLIC_URL)" : "in the VM (Bedrock/Vertex sign requests)"}` : "")
  + (h.agents.length ? ` · agents: ${h.agents.join(", ")}` : "");

const sessionLine = (s: Session) => `- ${s.key} · ${s.agent} on ${s.computerId} (${s.harness}): ${s.state}${s.live ? " (live)" : ""}`
  + `${s.bootstrappedAt ? `, bootstrapped ${s.bootstrappedAt}${s.bootstrapMs ? ` in ${Math.round(s.bootstrapMs / 1000)} s` : ""}` : ""}`
  + `${s.lastDetachAt ? `, detached ${s.lastDetachAt}` : ""}${s.lastResumeAt ? `, resumed ${s.lastResumeAt}` : ""}`
  + `, ${s.turns} turn(s), $${s.costUsd.toFixed(4)}${s.resumable ? ", resumable" : ""}${s.lastError ? `, error: ${s.lastError}` : ""}`;

export function registerHarnessTools(tool: Register, deps: McpDeps): void {
  tool("settings", "polpo_harnesses_get", {
    title: "Agent harnesses",
    description: "The official agent harnesses agents may run on (Claude Code, Codex): which are enabled, their auth type (api-key, bedrock, vertex, ai-gateway, gateway), "
      + "credential vault reference and whether that entry exists (never its value), region, default model, the agents using each, and the computers "
      + "that can run them. Set an agent on one with polpo_agent_update engine; change these settings with polpo_harnesses_update.",
    inputSchema: {},
    outputSchema: { allowHost: z.boolean(), harnesses: z.array(harnessItem), computers: z.array(z.string()) },
    annotations: READ,
  }, async () => {
    const r = await apiGet(deps, "/harnesses");
    if (!r.ok) return apiError(r, "Reading the harnesses");
    const o = r.data as Overview;
    return ok([...o.harnesses.map(harnessLine), `Agents on this server may use a harness: ${o.allowHost ? "yes (isolated HOME)" : "no"}`,
      `Computers that can run one: ${o.computers.join(", ") || "none (create a Daytona v2 computer)"}`,
      ...(o.relay ? [o.relay.available ? `Model relay: ${o.relay.url}` : `Model relay: off — ${o.relay.warning}`] : [])].join("\n"), o as unknown as Record<string, unknown>);
  });

  tool("settings", "polpo_harnesses_update", {
    title: "Change agent harness settings",
    description: "Enable or disable Claude Code and Codex for agents and set how they authenticate: auth type, the vault entry with the credential "
      + "(owner + service: a reference, never the key), Bedrock region, Vertex project and region, a model gateway (ai-gateway: the Vercel AI Gateway; "
      + "gateway: Cloudflare AI Gateway, OpenRouter, LiteLLM, Portkey, Kong… with format, base_url, auth_scheme, headers from the vault, models), default model. "
      + "Only the fields given change. Gateway keys and secret headers are injected by Polpo's model relay, never put in the computer. "
      + "A Claude subscription (Pro/Max login) is refused by Anthropic's terms: use an Anthropic API key, Bedrock, Vertex or a gateway. Codex takes an OpenAI API key or a gateway. "
      + "Check the result with polpo_harnesses_test. "
      + "When the credential's vault entry does not exist yet, the result gives setup_url: show it to the person (they paste the key there), "
      + "then call polpo_setup_wait with setup_id. Disabling a harness that agents use is refused (move them to engine \"polpo\" first).",
    inputSchema: {
      enabled: z.array(z.enum(["claude-code", "codex"])).optional().describe("The harnesses agents may use (replaces the list; [] disables all)"),
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
    },
    outputSchema: { harnesses: z.array(harnessItem), changed: z.array(z.string()) },
    annotations: UPDATE,
  }, async ({ enabled, allow_host, claude_code, codex }) => {
    if (enabled === undefined && allow_host === undefined && claude_code === undefined && codex === undefined) {
      return fail("Nothing to change: give enabled, allow_host, claude_code or codex.");
    }
    if (claude_code?.auth === "subscription") return fail(`${CLAUDE_SUBSCRIPTION_REFUSAL}. Nothing was changed.`);
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

  tool("settings", "polpo_harnesses_test", {
    title: "Test a harness's connection",
    description: "Check that a harness can reach its model: one tiny streaming model request FROM THE POLPO SERVER (never the computer) with the "
      + "configured authentication and model (Anthropic Messages with a tool for Claude Code, OpenAI Responses for Codex, a Converse call for Bedrock, "
      + "rawPredict for Vertex). With agent: that agent's own credential and model. Returns ok, latency, and a labelled error "
      + "(auth, model, network, timeout, protocol, config) saying what to change. Run it after polpo_harnesses_update.",
    inputSchema: {
      harness: z.enum(["claude-code", "codex"]).describe("The harness to test"),
      agent: z.string().optional().describe("Test with this agent's engine (its own credential and model)"),
    },
    outputSchema: { ok: z.boolean(), harness: z.string(), latencyMs: z.number(), errorKind: z.string().optional(), error: z.string().optional() },
    annotations: { ...READ, openWorldHint: true },
  }, async ({ harness, agent }) => {
    const r = await apiSend(deps, "POST", "/harnesses/test", { harness, ...(agent ? { agent } : {}) });
    if (!r.ok) return apiError(r, `Testing ${harness}`);
    const t = r.data as TestResult;
    return ok(testLine(t), t as unknown as Record<string, unknown>);
  });

  tool("settings", "polpo_harness_sessions_list", {
    title: "Harness sessions",
    description: "The harness sessions agents run (one per task run or chat on Claude Code / Codex): agent, computer, state (running, idle, detached "
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
