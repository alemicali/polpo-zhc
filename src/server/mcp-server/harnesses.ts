/**
 * Agent harnesses through MCP (no polpo_ask): the instance's harness settings (Configuration →
 * Harnesses), and the harness sessions agents run (status, stop, reset). An agent's engine is set
 * with polpo_agent_create / polpo_agent_update (engine).
 *
 * - polpo_harnesses_get (read): enabled harnesses, auth, credential reference and whether its vault
 *   entry exists (never the value), model, region, agents on each.
 * - polpo_harnesses_update (settings toolset, polpo:admin): enable/disable, auth type, credential
 *   reference, region, model. The secret itself never passes here: when the entry is missing the
 *   tool returns setup_url + setup_id for polpo_setup_wait. A Claude subscription is refused.
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
};
type Overview = { allowHost: boolean; harnesses: HarnessItem[]; computers: string[] };
type Session = {
  key: string; agent: string; harness: string; computerId: string; scope: string; taskId?: string; state: string; live: boolean;
  sessionId?: string; bootstrappedAt?: string; bootstrapMs?: number; lastDetachAt?: string; lastResumeAt?: string; resumable: boolean;
  turns: number; costUsd: number; lastError?: string; updatedAt: string;
};

const vaultRef = z.object({ owner: z.string().min(1).describe("The agent whose vault holds the entry"), service: z.string().min(1).describe("The entry's service name") });
const harnessItem = z.object({ id: z.string(), name: z.string(), enabled: z.boolean(), agents: z.array(z.string()) }).passthrough();
const sessionItem = z.object({ key: z.string(), agent: z.string(), harness: z.string(), computerId: z.string(), state: z.string(), live: z.boolean(), costUsd: z.number() }).passthrough();

/** One harness, in words: the credential is always said to be found or missing in the vault. */
export const harnessLine = (h: HarnessItem) => `- ${h.name} (${h.id}): ${h.enabled ? "enabled" : "disabled"}`
  + (h.auth ? `, auth ${h.auth}${h.bedrock ? ` (${h.bedrock.region})` : ""}${h.vertex ? ` (${h.vertex.projectId}, ${h.vertex.region})` : ""}` : ", not configured")
  + (h.credentialRef ? `, credential ${h.credentialRef.owner} / ${h.credentialRef.service} ${h.credentialFound ? "(found in the vault)" : "(MISSING in the vault)"}` : "")
  + (h.model ? `, model ${h.model}` : "")
  + (h.agents.length ? ` · agents: ${h.agents.join(", ")}` : "");

const sessionLine = (s: Session) => `- ${s.key} · ${s.agent} on ${s.computerId} (${s.harness}): ${s.state}${s.live ? " (live)" : ""}`
  + `${s.bootstrappedAt ? `, bootstrapped ${s.bootstrappedAt}${s.bootstrapMs ? ` in ${Math.round(s.bootstrapMs / 1000)} s` : ""}` : ""}`
  + `${s.lastDetachAt ? `, detached ${s.lastDetachAt}` : ""}${s.lastResumeAt ? `, resumed ${s.lastResumeAt}` : ""}`
  + `, ${s.turns} turn(s), $${s.costUsd.toFixed(4)}${s.resumable ? ", resumable" : ""}${s.lastError ? `, error: ${s.lastError}` : ""}`;

export function registerHarnessTools(tool: Register, deps: McpDeps): void {
  tool("settings", "polpo_harnesses_get", {
    title: "Agent harnesses",
    description: "The official agent harnesses agents may run on (Claude Code, Codex): which are enabled, their auth type (api-key, bedrock, vertex), "
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
      `Computers that can run one: ${o.computers.join(", ") || "none (create a Daytona v2 computer)"}`].join("\n"), o as unknown as Record<string, unknown>);
  });

  tool("settings", "polpo_harnesses_update", {
    title: "Change agent harness settings",
    description: "Enable or disable Claude Code and Codex for agents and set how they authenticate: auth type, the vault entry with the credential "
      + "(owner + service: a reference, never the key), Bedrock region, Vertex project and region, default model. Only the fields given change. "
      + "A Claude subscription (Pro/Max login) is refused by Anthropic's terms: use an Anthropic API key, Bedrock or Vertex. Codex takes an OpenAI API key. "
      + "When the credential's vault entry does not exist yet, the result gives setup_url: show it to the person (they paste the key there), "
      + "then call polpo_setup_wait with setup_id. Disabling a harness that agents use is refused (move them to engine \"polpo\" first).",
    inputSchema: {
      enabled: z.array(z.enum(["claude-code", "codex"])).optional().describe("The harnesses agents may use (replaces the list; [] disables all)"),
      allow_host: z.boolean().optional().describe("Agents on this server (no remote computer) may use a harness, with an isolated HOME (default false)"),
      claude_code: z.object({
        // "subscription" is accepted here only to answer with the reason it is refused (Anthropic's terms)
        auth: z.enum(["api-key", "bedrock", "vertex", "subscription"]).optional()
          .describe("api-key: Anthropic API key; bedrock: Amazon Bedrock; vertex: Google Vertex AI. \"subscription\" (a Claude Pro/Max login) is always refused"),
        credential_ref: vaultRef.optional().describe("The vault entry with the credential: api-key/bedrock → apiKey (Bedrock: a Bedrock API key, or accessKeyId + secretAccessKey); vertex → serviceAccountJson"),
        bedrock_region: z.string().optional().describe("AWS region for Bedrock, e.g. us-east-1"),
        vertex: z.object({ region: z.string(), project_id: z.string() }).optional().describe("Google Cloud region and project for Vertex AI"),
        model: z.string().nullable().optional().describe("Default model id (Bedrock: an inference profile such as us.anthropic.claude-sonnet-4-5-20250929-v1:0); null clears it"),
      }).nullable().optional().describe("Claude Code's settings (null removes them)"),
      codex: z.object({
        credential_ref: vaultRef.optional().describe("The vault entry with the OpenAI API key (field apiKey or OPENAI_API_KEY)"),
        model: z.string().nullable().optional().describe("Default model id; null clears it"),
      }).nullable().optional().describe("Codex's settings (auth: an OpenAI API key; null removes them)"),
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
      if (c.auth !== "bedrock") delete c.bedrock;
      if (c.auth !== "vertex") delete c.vertex;
      next["claude-code"] = c;
    }
    if (codex === null) delete next.codex;
    else if (codex) {
      const c: Record<string, any> = { auth: "api-key", ...(next.codex ?? {}) };
      if (codex.credential_ref) c.credentialRef = codex.credential_ref;
      if (codex.model === null) delete c.model; else if (codex.model) c.model = codex.model;
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
      ? setupHandoff(deps, { kind: "vault", item: missing.credentialRef.owner, field: missing.credentialRef.service }, `${missing.name} ${missing.auth === "vertex" ? "service account key (serviceAccountJson)" : missing.auth === "bedrock" ? "Bedrock API key" : "API key"}`)
      : undefined;
    return ok([`Harness settings changed: ${changed.join(", ") || "nothing (same values)"}.`, ...o.harnesses.map(harnessLine), ...(handoff ? ["", handoff.next_step] : [])].join("\n"),
      { harnesses: o.harnesses, changed, ...(handoff ?? {}) });
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
