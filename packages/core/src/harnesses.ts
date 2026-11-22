/**
 * Agent harnesses (settings.harnesses + agent.engine): an agent may run on an official agent
 * runtime (Claude Code, Codex) instead of Polpo's own engine. The runtime runs inside the agent's
 * computer (a remote VM), Polpo's tools are offered to it as host tools, and its usage is metered
 * as Polpo's own.
 *
 * Rules shared by the config file, the API, the MCP tools and the dashboard live here; the
 * runtime is src/harness/ and src/adapters/harness-engine.ts.
 *
 * - The instance enables harnesses explicitly (settings.harnesses.enabled) and gives each one an
 *   explicit credential: a vault reference (owner + service), never a secret in the config.
 * - Claude Code: an Anthropic API key, Amazon Bedrock or Google Vertex AI. A Claude subscription
 *   (Pro/Max login, OAuth token) is refused: Anthropic's terms do not allow it in a product that
 *   serves other people. Codex: an OpenAI API key only (ChatGPT login is not supported yet).
 * - An agent on a harness needs a sandboxed computer: a remote computer (Daytona v2), or this
 *   server only when the instance allows it (settings.harnesses.allowHost), and then with an
 *   isolated HOME under the run's working directory (never the server's ~/.claude or ~/.codex).
 */
import { normalizeVaultRef, type VaultRef } from "./vault-ref.js";
import { HOST_COMPUTER_ID, isRemoteComputer, type ComputerConfig } from "./computers.js";

export type HarnessId = "claude-code" | "codex";
export const HARNESS_IDS: readonly HarnessId[] = ["claude-code", "codex"];
export const HARNESS_NAMES: Record<HarnessId, string> = { "claude-code": "Claude Code", codex: "Codex" };

export type ClaudeCodeAuth = "api-key" | "bedrock" | "vertex";
export const CLAUDE_CODE_AUTHS: readonly ClaudeCodeAuth[] = ["api-key", "bedrock", "vertex"];
export type CodexAuth = "api-key";
export const CODEX_AUTHS: readonly CodexAuth[] = ["api-key"];

/** Auth values people try that are refused, with the reason. */
const CLAUDE_SUBSCRIPTION_AUTHS = new Set(["subscription", "pro", "max", "oauth", "claude-ai", "claude.ai", "login", "native"]);
export const CLAUDE_SUBSCRIPTION_REFUSAL =
  "A Claude subscription (Pro/Max login or OAuth token) cannot run Claude Code for Polpo agents: Anthropic's terms do not allow a consumer subscription in a product that runs agents for other people. Use an Anthropic API key, Amazon Bedrock or Google Vertex AI";
export const CODEX_CHATGPT_REFUSAL =
  "Codex with a ChatGPT login is not supported yet: use an OpenAI API key";

export interface ClaudeCodeHarnessSettings {
  auth: ClaudeCodeAuth;
  /** Vault entry with the credential: api-key → apiKey; bedrock → apiKey (a Bedrock API key / bearer token); vertex → a service account JSON. */
  credentialRef: VaultRef;
  bedrock?: { region: string };
  vertex?: { region: string; projectId: string };
  /** Default model id (an agent may choose its own). */
  model?: string;
}

export interface CodexHarnessSettings {
  auth: CodexAuth;
  credentialRef: VaultRef;
  model?: string;
}

export interface HarnessesSettings {
  enabled: HarnessId[];
  /** Agents on this server (computer "host") may use a harness; it runs with an isolated HOME. Default false. */
  allowHost?: boolean;
  "claude-code"?: ClaudeCodeHarnessSettings;
  codex?: CodexHarnessSettings;
}

export type HarnessPermissionMode = "allow-all" | "allow-edits" | "allow-reads";
export const HARNESS_PERMISSION_MODES: readonly HarnessPermissionMode[] = ["allow-all", "allow-edits", "allow-reads"];
export type HarnessEffort = "low" | "medium" | "high" | "xhigh" | "max";
export const HARNESS_EFFORTS: readonly HarnessEffort[] = ["low", "medium", "high", "xhigh", "max"];

export interface AgentHarnessEngine {
  harness: HarnessId;
  /** Model id for the runtime (default: the harness setting's model, then the runtime's own). */
  model?: string;
  /** Default "allow-all" (the runtime works unattended in its sandbox). */
  permissionMode?: HarnessPermissionMode;
  effort?: HarnessEffort;
  /** Stop a run when its estimated spend passes this (USD). */
  maxBudgetUsd?: number;
}

/** agent.engine: "polpo" (default) or a harness. */
export type AgentEngine = "polpo" | AgentHarnessEngine;

export class HarnessConfigError extends Error {
  constructor(message: string) { super(message); this.name = "HarnessConfigError"; }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const MODEL = /^[A-Za-z0-9._:/@\[\]-]{1,200}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$|^global$|^[a-z]+-[a-z]+\d$/;

function parseRef(raw: unknown, where: string): VaultRef {
  if (typeof raw === "string") {
    throw new HarnessConfigError(`${where} must be a vault reference { owner, service }, never the key itself: store the key in an agent's vault and point to that entry`);
  }
  const ref = normalizeVaultRef(raw);
  if (!ref) throw new HarnessConfigError(`${where} must be a vault reference { owner: <agent>, service: <entry> }`);
  return ref;
}

function parseModel(raw: unknown, where: string): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const m = str(raw);
  if (!m || !MODEL.test(m)) throw new HarnessConfigError(`${where} must be a model id`);
  return m;
}

/** Secret-looking fields that never belong in the settings. */
const SECRET_KEYS = /^(api[-_]?key|apikey|key|token|secret|password|accessKey|secretAccessKey|bearer|oauthToken)$/i;

function refuseSecrets(r: Record<string, unknown>, where: string): void {
  for (const k of Object.keys(r)) {
    if (SECRET_KEYS.test(k)) throw new HarnessConfigError(`${where}.${k}: secrets never go in the settings; store it in the vault and set credentialRef { owner, service }`);
  }
}

function parseClaudeCode(raw: unknown, where: string): ClaudeCodeHarnessSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HarnessConfigError(`${where} must be an object { auth, credentialRef, bedrock?, model? }`);
  const r = raw as Record<string, unknown>;
  refuseSecrets(r, where);
  const auth = str(r.auth)?.toLowerCase();
  if (auth && CLAUDE_SUBSCRIPTION_AUTHS.has(auth)) throw new HarnessConfigError(`${where}.auth "${auth}": ${CLAUDE_SUBSCRIPTION_REFUSAL}`);
  if (!auth || !(CLAUDE_CODE_AUTHS as string[]).includes(auth)) throw new HarnessConfigError(`${where}.auth must be one of ${CLAUDE_CODE_AUTHS.join(", ")}`);
  const out: ClaudeCodeHarnessSettings = { auth: auth as ClaudeCodeAuth, credentialRef: parseRef(r.credentialRef, `${where}.credentialRef`) };
  if (auth === "bedrock") {
    const region = str((r.bedrock as Record<string, unknown> | undefined)?.region);
    if (!region || !REGION.test(region)) throw new HarnessConfigError(`${where}.bedrock.region must be an AWS region, e.g. "us-east-1"`);
    out.bedrock = { region };
  } else if (r.bedrock !== undefined && r.bedrock !== null) {
    throw new HarnessConfigError(`${where}.bedrock is only for auth "bedrock"`);
  }
  if (auth === "vertex") {
    const v = (r.vertex ?? {}) as Record<string, unknown>;
    const region = str(v.region);
    const projectId = str(v.projectId);
    if (!region || !REGION.test(region)) throw new HarnessConfigError(`${where}.vertex.region must be a Google Cloud region, e.g. "us-east5" or "global"`);
    if (!projectId || !/^[a-z][a-z0-9-]{4,29}$/.test(projectId)) throw new HarnessConfigError(`${where}.vertex.projectId must be a Google Cloud project id`);
    out.vertex = { region, projectId };
  } else if (r.vertex !== undefined && r.vertex !== null) {
    throw new HarnessConfigError(`${where}.vertex is only for auth "vertex"`);
  }
  const model = parseModel(r.model, `${where}.model`);
  if (model) out.model = model;
  return out;
}

function parseCodex(raw: unknown, where: string): CodexHarnessSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HarnessConfigError(`${where} must be an object { auth: "api-key", credentialRef, model? }`);
  const r = raw as Record<string, unknown>;
  refuseSecrets(r, where);
  const auth = str(r.auth)?.toLowerCase();
  if (auth === "chatgpt" || auth === "subscription" || auth === "login" || auth === "oauth") throw new HarnessConfigError(`${where}.auth "${auth}": ${CODEX_CHATGPT_REFUSAL}`);
  if (auth !== "api-key") throw new HarnessConfigError(`${where}.auth must be "api-key"`);
  const out: CodexHarnessSettings = { auth: "api-key", credentialRef: parseRef(r.credentialRef, `${where}.credentialRef`) };
  const model = parseModel(r.model, `${where}.model`);
  if (model) out.model = model;
  return out;
}

/** settings.harnesses from raw input (config file or API), or an error naming the field. */
export function parseHarnessesSettings(raw: unknown): HarnessesSettings {
  const where = "settings.harnesses";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HarnessConfigError(`${where} must be an object { enabled: ["claude-code" | "codex"], "claude-code"?: {...}, codex?: {...} }`);
  const r = raw as Record<string, unknown>;
  const enabledRaw = r.enabled ?? [];
  if (!Array.isArray(enabledRaw) || enabledRaw.some((h) => typeof h !== "string" || !(HARNESS_IDS as string[]).includes(h))) {
    throw new HarnessConfigError(`${where}.enabled must be a list of ${HARNESS_IDS.map((h) => `"${h}"`).join(", ")}`);
  }
  const out: HarnessesSettings = { enabled: [...new Set(enabledRaw as HarnessId[])] };
  if (r.allowHost !== undefined && r.allowHost !== null) {
    if (typeof r.allowHost !== "boolean") throw new HarnessConfigError(`${where}.allowHost must be true or false`);
    if (r.allowHost) out.allowHost = true;
  }
  if (r["claude-code"] !== undefined && r["claude-code"] !== null) out["claude-code"] = parseClaudeCode(r["claude-code"], `${where}["claude-code"]`);
  if (r.codex !== undefined && r.codex !== null) out.codex = parseCodex(r.codex, `${where}.codex`);
  for (const h of out.enabled) {
    if (!out[h]) throw new HarnessConfigError(`${where}: ${HARNESS_NAMES[h]} is enabled but has no settings (${where}${h === "codex" ? ".codex" : `["${h}"]`}: { auth, credentialRef })`);
  }
  return out;
}

/** The parsed settings, or undefined when absent or malformed (runtime paths never throw on them). */
export function harnessesSettingsOf(settings: { harnesses?: unknown } | undefined): HarnessesSettings | undefined {
  if (!settings?.harnesses) return undefined;
  try { return parseHarnessesSettings(settings.harnesses); } catch { return undefined; }
}

/** agent.engine from raw input: undefined for "polpo" (the default), or an error naming the field. */
export function parseAgentEngine(raw: unknown, where = "engine"): AgentHarnessEngine | undefined {
  if (raw === undefined || raw === null || raw === "" || raw === "polpo") return undefined;
  if (typeof raw === "string") {
    if ((HARNESS_IDS as string[]).includes(raw)) return { harness: raw as HarnessId };
    throw new HarnessConfigError(`${where} must be "polpo" or { harness: ${HARNESS_IDS.map((h) => `"${h}"`).join(" | ")}, model?, permissionMode?, effort?, maxBudgetUsd? }`);
  }
  if (typeof raw !== "object" || Array.isArray(raw)) throw new HarnessConfigError(`${where} must be "polpo" or an object { harness, ... }`);
  const r = raw as Record<string, unknown>;
  refuseSecrets(r, where);
  const harness = str(r.harness);
  if (!harness || !(HARNESS_IDS as string[]).includes(harness)) throw new HarnessConfigError(`${where}.harness must be one of ${HARNESS_IDS.join(", ")}`);
  const out: AgentHarnessEngine = { harness: harness as HarnessId };
  const model = parseModel(r.model, `${where}.model`);
  if (model) out.model = model;
  if (r.permissionMode !== undefined && r.permissionMode !== null) {
    if (typeof r.permissionMode !== "string" || !(HARNESS_PERMISSION_MODES as string[]).includes(r.permissionMode)) {
      throw new HarnessConfigError(`${where}.permissionMode must be one of ${HARNESS_PERMISSION_MODES.join(", ")}`);
    }
    out.permissionMode = r.permissionMode as HarnessPermissionMode;
  }
  if (r.effort !== undefined && r.effort !== null) {
    if (typeof r.effort !== "string" || !(HARNESS_EFFORTS as string[]).includes(r.effort)) throw new HarnessConfigError(`${where}.effort must be one of ${HARNESS_EFFORTS.join(", ")}`);
    out.effort = r.effort as HarnessEffort;
  }
  if (r.maxBudgetUsd !== undefined && r.maxBudgetUsd !== null) {
    if (typeof r.maxBudgetUsd !== "number" || !(r.maxBudgetUsd > 0) || r.maxBudgetUsd > 10_000) throw new HarnessConfigError(`${where}.maxBudgetUsd must be a positive number of US dollars`);
    out.maxBudgetUsd = r.maxBudgetUsd;
  }
  return out;
}

/** The agent's harness engine, or undefined when it runs on Polpo's engine (never throws). */
export function agentHarness(agent: { engine?: unknown } | undefined): AgentHarnessEngine | undefined {
  try { return parseAgentEngine(agent?.engine); } catch { return undefined; }
}

/**
 * Why an agent cannot run on its harness with these settings (null: it can, or it is on Polpo's
 * engine). Checked when an agent or the settings are saved, and again before every run.
 * `daytonaApi` says which Daytona API the instance uses ("v2" computers can run harnesses).
 */
export function agentEngineProblem(
  agent: { name?: string; engine?: unknown; defaultComputer?: string },
  settings: { harnesses?: unknown; computers?: unknown } | undefined,
  opts: { daytonaApi?: "v0" | "v2" } = {},
): string | null {
  let engine: AgentHarnessEngine | undefined;
  try { engine = parseAgentEngine(agent.engine); } catch (err) { return (err as Error).message; }
  if (!engine) return null;
  const who = agent.name ? `Agent "${agent.name}"` : "This agent";
  const name = HARNESS_NAMES[engine.harness];
  let h: HarnessesSettings | undefined;
  try { h = settings?.harnesses ? parseHarnessesSettings(settings.harnesses) : undefined; } catch (err) { return (err as Error).message; }
  if (!h?.enabled.includes(engine.harness)) {
    return `${who}: ${name} is not enabled on this instance (Settings → Harnesses: enable it and choose its credential)`;
  }
  const computerId = agent.defaultComputer && agent.defaultComputer !== HOST_COMPUTER_ID ? agent.defaultComputer : undefined;
  if (!computerId) {
    if (h.allowHost) return null;
    return `${who}: ${name} runs inside the agent's computer, and this agent works on this server. Give it a remote computer (defaultComputer), or allow harnesses on this server (settings.harnesses.allowHost: they run with an isolated HOME, never the server's)`;
  }
  const computers = Array.isArray(settings?.computers) ? (settings!.computers as ComputerConfig[]) : [];
  const c = computers.find((x) => x?.id === computerId);
  if (!c) return `${who}: unknown computer "${computerId}"`;
  if (c.kind === "host") {
    return h.allowHost ? null : `${who}: computer "${c.id}" is this server; harnesses run there only with settings.harnesses.allowHost (isolated HOME)`;
  }
  if (!isRemoteComputer(c)) return `${who}: computer "${c.id}" cannot run ${name}`;
  if (c.kind === "e2b") return `${who}: ${name} does not run on E2B computers yet (computer "${c.id}"): use a Daytona v2 computer`;
  if (opts.daytonaApi && opts.daytonaApi !== "v2") return `${who}: ${name} needs Daytona v2 (settings.sandbox.providers.daytona.api "v2"); computer "${c.id}" runs on Daytona v0`;
  return null;
}

/** Agents whose harness these settings no longer allow (to refuse a settings change that breaks them). */
export function harnessUsers(harness: HarnessId, agents: ReadonlyArray<{ name: string; engine?: unknown }>): string[] {
  return agents.filter((a) => agentHarness(a)?.harness === harness).map((a) => a.name);
}
