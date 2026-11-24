/**
 * The CLI engine (agent.engine { type: "cli" }): an agent runs its tasks through the official,
 * unmodified Claude Code or Codex command-line program on a computer, signed in with a person's
 * own account through Anthropic's or OpenAI's own sign-in flow.
 *
 * - An account is a CLI config directory on one computer (Claude: CLAUDE_CONFIG_DIR, Codex:
 *   CODEX_HOME). Polpo stores only { id, cli, computer, configDir, owner, label }: never a token.
 *   Signing in happens in a terminal on that computer (`claude auth login`, `codex login
 *   --device-auth`); Polpo streams the terminal and never reads the credential files.
 * - Policy (Anthropic's Claude Code legal and compliance page; OpenAI's Codex terms): a
 *   subscription login is personal. An account belongs to the member who signed in (`owner`) and
 *   runs only work that member started: their tasks, the tasks of missions they start, the runs
 *   of schedules they own (a schedule's owner is the member who created it), their chats. It
 *   never serves other members, channel customers, ownerless work (an API key, a channel) or
 *   instances that serve customers. Codex accounts may be shared by the instance
 *   (owner "instance") only when settings.harnesses.cli.allowInstanceCodex is set (with a warning).
 *   A Claude account owned by "instance" is accepted only on a personal installation (no member
 *   sign-in): the operator is then the only person using it.
 *
 * Shared by the config file, the API, the MCP tools and the dashboard; the runtime is
 * src/cli-engine/ and src/adapters/cli-engine.ts.
 */
import type { HarnessEffort } from "./harnesses.js";

/** harnesses.ts HARNESS_EFFORTS, repeated: harnesses.ts imports this module (no runtime cycle). */
const HARNESS_EFFORTS: readonly HarnessEffort[] = ["low", "medium", "high", "xhigh", "max"];

// computers.ts constants, repeated here: importing computers.js would add an import cycle
// (sandbox → computers → tailnet) that breaks `export *` under some loaders
const HOST_COMPUTER_ID = "host";
const COMPUTER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export type CliId = "claude" | "codex";
export const CLI_IDS: readonly CliId[] = ["claude", "codex"];
export const CLI_NAMES: Record<CliId, string> = { claude: "Claude Code (CLI)", codex: "Codex (CLI)" };
/** The program each CLI runs (unmodified, from the computer's PATH). */
export const CLI_BINARIES: Record<CliId, string> = { claude: "claude", codex: "codex" };
/** The environment variable that points the CLI at an account's config directory. */
export const CLI_CONFIG_ENV: Record<CliId, string> = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };
/** Official installers (an explicit action in the dashboard). */
export const CLI_INSTALL_COMMANDS: Record<CliId, string> = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
};
/** The sign-in, status and sign-out commands (run with the account's config directory). */
export const CLI_LOGIN_COMMANDS: Record<CliId, string> = { claude: "claude auth login", codex: "codex login --device-auth" };
export const CLI_STATUS_COMMANDS: Record<CliId, string> = { claude: "claude auth status", codex: "codex login status" };
export const CLI_LOGOUT_COMMANDS: Record<CliId, string> = { claude: "claude auth logout", codex: "codex logout" };

/** Account owner: a member's email, or "instance" (see the policy above). */
export const CLI_INSTANCE_OWNER = "instance";

export interface CliAccount {
  id: string;
  cli: CliId;
  /** "host" (this server) or a computer id (settings.computers). */
  computer: string;
  /** The CLI's config directory on that computer ("~/" is that computer's home). */
  configDir: string;
  /** The member (email) who signed in, or "instance". */
  owner: string;
  label?: string;
}

export interface CliSettings {
  accounts: CliAccount[];
  /** Codex accounts owned by "instance" may run any work of the instance (default false). */
  allowInstanceCodex?: boolean;
}

export type CliPermissionMode = "allow-all" | "allow-edits" | "allow-reads";
export const CLI_PERMISSION_MODES: readonly CliPermissionMode[] = ["allow-all", "allow-edits", "allow-reads"];

export interface AgentCliEngine {
  type: "cli";
  cli: CliId;
  /** The account (settings.harnesses.cli.accounts[].id); default: the only account of that CLI on the agent's computer. */
  account?: string;
  model?: string;
  /** Default "allow-all": the CLI works unattended in the task's workspace. */
  permissionMode?: CliPermissionMode;
  /** Extra command-line flags passed to the CLI (validated: no flag that changes the account or the output protocol). */
  args?: string[];
  /** Reasoning effort (Claude Code --effort, Codex model_reasoning_effort), as for the harness engine. */
  effort?: HarnessEffort;
  /** Claude Code --max-budget-usd: the run stops at this estimate (a subscription bills nothing; it bounds the work). */
  maxBudgetUsd?: number;
}

export class CliConfigError extends Error {
  constructor(message: string) { super(message); this.name = "CliConfigError"; }
}

export const CLI_ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MODEL = /^[A-Za-z0-9._:/@\[\]-]{1,200}$/;
/** A config directory: absolute or under "~/", no shell metacharacters, no "..". */
const CONFIG_DIR = /^(~\/|\/)[A-Za-z0-9._\/-]{1,300}$/;

/** The default config directory of an account: ~/.polpo-cli/<cli>/<id>. */
export function defaultCliConfigDir(cli: CliId, id: string): string {
  return `~/.polpo-cli/${cli}/${id}`;
}

/** Flags an agent's args may not set: Polpo owns the account, the protocol, the session and the instructions. */
const RESERVED_ARGS = /^(-p|--print|--output-format|--input-format|--verbose|--resume|-r|--continue|-c|--session-id|--append-system-prompt.*|--system-prompt.*|--settings|--setting-sources|--mcp-config|--strict-mcp-config|--permission-prompt-tool|--config|-c|--profile|--cd|-C|--dangerously-.*|--api-key|--oauth.*|--login|--logout)(=.*)?$/;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function parseCliAccount(raw: unknown, where: string): CliAccount {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CliConfigError(`${where} must be { id, cli, computer?, configDir?, owner, label? }`);
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (!["id", "cli", "computer", "configDir", "owner", "label"].includes(k)) {
      throw new CliConfigError(`${where}.${k}: an account holds no secret and no other setting (id, cli, computer, configDir, owner, label); the sign-in happens in the CLI`);
    }
  }
  const id = str(r.id);
  if (!id || !CLI_ACCOUNT_ID_PATTERN.test(id)) throw new CliConfigError(`${where}.id must be lowercase letters, digits and dashes (up to 40)`);
  const cli = str(r.cli);
  if (!cli || !(CLI_IDS as string[]).includes(cli)) throw new CliConfigError(`${where}.cli must be one of ${CLI_IDS.join(", ")}`);
  const computer = str(r.computer) ?? HOST_COMPUTER_ID;
  if (computer !== HOST_COMPUTER_ID && !COMPUTER_ID_PATTERN.test(computer)) throw new CliConfigError(`${where}.computer must be "host" or a computer id`);
  const configDir = str(r.configDir) ?? defaultCliConfigDir(cli as CliId, id);
  if (!CONFIG_DIR.test(configDir) || configDir.split("/").includes("..")) throw new CliConfigError(`${where}.configDir must be an absolute path or start with ~/ (letters, digits, . _ - /)`);
  const owner = str(r.owner)?.toLowerCase();
  if (!owner || (owner !== CLI_INSTANCE_OWNER && !EMAIL.test(owner))) throw new CliConfigError(`${where}.owner must be the email of the member who signs in, or "instance"`);
  const out: CliAccount = { id, cli: cli as CliId, computer, configDir, owner };
  const label = str(r.label);
  if (label) out.label = label.slice(0, 80);
  return out;
}

/** settings.harnesses.cli from raw input, or an error naming the field. */
export function parseCliSettings(raw: unknown, where = "settings.harnesses.cli"): CliSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CliConfigError(`${where} must be { accounts: [...], allowInstanceCodex? }`);
  const r = raw as Record<string, unknown>;
  const list = r.accounts ?? [];
  if (!Array.isArray(list)) throw new CliConfigError(`${where}.accounts must be a list`);
  if (list.length > 50) throw new CliConfigError(`${where}.accounts: at most 50 accounts`);
  const accounts = list.map((a, i) => parseCliAccount(a, `${where}.accounts[${i}]`));
  const ids = new Set<string>();
  const dirs = new Set<string>();
  for (const a of accounts) {
    if (ids.has(a.id)) throw new CliConfigError(`${where}.accounts: the id "${a.id}" appears twice`);
    ids.add(a.id);
    const d = `${a.computer}:${a.configDir}`;
    if (dirs.has(d)) throw new CliConfigError(`${where}.accounts: two accounts use ${a.configDir} on ${a.computer}`);
    dirs.add(d);
  }
  const out: CliSettings = { accounts };
  if (r.allowInstanceCodex !== undefined && r.allowInstanceCodex !== null) {
    if (typeof r.allowInstanceCodex !== "boolean") throw new CliConfigError(`${where}.allowInstanceCodex must be true or false`);
    if (r.allowInstanceCodex) out.allowInstanceCodex = true;
  }
  return out;
}

/** The parsed CLI settings, or undefined (runtime paths never throw on them). */
export function cliSettingsOf(settings: { harnesses?: unknown } | undefined): CliSettings | undefined {
  const raw = (settings?.harnesses as { cli?: unknown } | undefined)?.cli;
  if (!raw) return undefined;
  try { return parseCliSettings(raw); } catch { return undefined; }
}

/** True when raw is a CLI engine ({ type: "cli" }). */
export function isCliEngineInput(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && !Array.isArray(raw) && (raw as Record<string, unknown>).type === "cli";
}

/** agent.engine { type: "cli", ... } from raw input, or an error naming the field. */
export function parseAgentCliEngine(raw: unknown, where = "engine"): AgentCliEngine {
  if (!isCliEngineInput(raw)) throw new CliConfigError(`${where} must be { type: "cli", cli: "claude" | "codex", account?, model?, permissionMode?, effort?, maxBudgetUsd?, args? }`);
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (!["type", "cli", "account", "model", "permissionMode", "effort", "maxBudgetUsd", "args"].includes(k)) throw new CliConfigError(`${where}.${k} is not a CLI engine setting (cli, account, model, permissionMode, effort, maxBudgetUsd, args)`);
  }
  const cli = str(r.cli);
  if (!cli || !(CLI_IDS as string[]).includes(cli)) throw new CliConfigError(`${where}.cli must be one of ${CLI_IDS.join(", ")}`);
  const out: AgentCliEngine = { type: "cli", cli: cli as CliId };
  const account = str(r.account);
  if (account) {
    if (!CLI_ACCOUNT_ID_PATTERN.test(account)) throw new CliConfigError(`${where}.account must be an account id (settings.harnesses.cli.accounts)`);
    out.account = account;
  }
  const model = r.model === undefined || r.model === null || r.model === "" ? undefined : str(r.model);
  if (r.model !== undefined && r.model !== null && r.model !== "" && (!model || !MODEL.test(model))) throw new CliConfigError(`${where}.model must be a model id or alias`);
  if (model) out.model = model;
  if (r.permissionMode !== undefined && r.permissionMode !== null) {
    if (typeof r.permissionMode !== "string" || !(CLI_PERMISSION_MODES as string[]).includes(r.permissionMode)) throw new CliConfigError(`${where}.permissionMode must be one of ${CLI_PERMISSION_MODES.join(", ")}`);
    out.permissionMode = r.permissionMode as CliPermissionMode;
  }
  if (r.effort !== undefined && r.effort !== null && r.effort !== "") {
    if (typeof r.effort !== "string" || !(HARNESS_EFFORTS as string[]).includes(r.effort)) throw new CliConfigError(`${where}.effort must be one of ${HARNESS_EFFORTS.join(", ")}`);
    out.effort = r.effort as HarnessEffort;
  }
  if (r.maxBudgetUsd !== undefined && r.maxBudgetUsd !== null) {
    if (typeof r.maxBudgetUsd !== "number" || !(r.maxBudgetUsd > 0) || r.maxBudgetUsd > 10_000) throw new CliConfigError(`${where}.maxBudgetUsd must be a positive number of US dollars`);
    if (cli !== "claude") throw new CliConfigError(`${where}.maxBudgetUsd is a Claude Code setting (Codex has no budget limit)`);
    out.maxBudgetUsd = r.maxBudgetUsd;
  }
  if (r.args !== undefined && r.args !== null) {
    if (!Array.isArray(r.args) || r.args.length > 20 || r.args.some((a) => typeof a !== "string" || !a || a.length > 300 || /[\0\r\n]/.test(a))) {
      throw new CliConfigError(`${where}.args must be a list of up to 20 command-line arguments`);
    }
    const bad = (r.args as string[]).find((a) => RESERVED_ARGS.test(a));
    if (bad) throw new CliConfigError(`${where}.args: "${bad}" is set by Polpo (account, protocol, session, instructions)`);
    if (r.args.length) out.args = [...(r.args as string[])];
  }
  return out;
}

/** The agent's CLI engine, or undefined (never throws). */
export function agentCliEngine(agent: { engine?: unknown } | undefined): AgentCliEngine | undefined {
  if (!isCliEngineInput(agent?.engine)) return undefined;
  try { return parseAgentCliEngine(agent!.engine); } catch { return undefined; }
}

/** The account an agent's CLI engine uses on its computer (explicit, or the only one), or a reason. */
export function resolveCliAccount(
  engine: AgentCliEngine,
  computer: string,
  settings: CliSettings | undefined,
): { account: CliAccount } | { problem: string } {
  const all = (settings?.accounts ?? []).filter((a) => a.cli === engine.cli);
  const name = CLI_NAMES[engine.cli];
  if (engine.account) {
    const a = all.find((x) => x.id === engine.account);
    if (!a) return { problem: `${name}: unknown account "${engine.account}" (Settings → Harnesses → CLI accounts)` };
    if (a.computer !== computer) return { problem: `${name}: account "${a.id}" is on computer "${a.computer}", and this agent works on "${computer}"` };
    return { account: a };
  }
  const here = all.filter((a) => a.computer === computer);
  if (here.length === 1) return { account: here[0]! };
  if (!here.length) return { problem: `${name}: no account on computer "${computer}" (Settings → Harnesses → CLI accounts: add one and sign in)` };
  return { problem: `${name}: several accounts on computer "${computer}": choose one in the agent's engine (engine.account)` };
}

/** Why an agent cannot use its CLI engine with these settings (null: it can). Checked on save and before every run. */
export function cliEngineProblem(
  agent: { name?: string; engine?: unknown; defaultComputer?: string },
  settings: { harnesses?: unknown } | undefined,
): string | null {
  let engine: AgentCliEngine;
  try { engine = parseAgentCliEngine(agent.engine); } catch (err) { return (err as Error).message; }
  let cli: CliSettings | undefined;
  try {
    const raw = (settings?.harnesses as { cli?: unknown } | undefined)?.cli;
    cli = raw ? parseCliSettings(raw) : undefined;
  } catch (err) { return (err as Error).message; }
  const computer = agent.defaultComputer || HOST_COMPUTER_ID;
  const r = resolveCliAccount(engine, computer, cli);
  if ("problem" in r) return `${agent.name ? `Agent "${agent.name}"` : "This agent"}: ${r.problem}`;
  return null;
}

// ── Policy guard ─────────────────────────────────────────────────────────

/** Where the work comes from. */
export type CliWorkOrigin =
  /** A member (dashboard, API with their session, Polpo chat). */
  | "member"
  /** A schedule without an owner (a schedule's run carries its owner as the initiator). */
  | "schedule"
  /** A customer on a channel (WhatsApp/Telegram customer mode). */
  | "channel-customer"
  /** No known person (an API key, another agent, a mission without an author). */
  | "unknown";

export interface CliUseContext {
  /** The member (email) who started the work, when known. */
  initiator?: string;
  origin: CliWorkOrigin;
  /** The instance has member sign-in (several people may use it). */
  instanceAuth: boolean;
  /** The instance serves customers (a channel or WhatsApp Business audience "customers"). */
  servesCustomers: boolean;
}

export const CLI_SUBSCRIPTION_POLICY_NOTE =
  "Anthropic allows a platform to run the unmodified Claude Code program for a person who signs in with their own account, but not to use one person's subscription for other people or route their requests (https://code.claude.com/docs/en/legal-and-compliance). Use an Anthropic API key, Amazon Bedrock or Google Vertex AI (Settings → Harnesses → Claude Code) for shared work";
const CODEX_POLICY_NOTE =
  "A ChatGPT sign-in is personal. Use an OpenAI API key (Settings → Harnesses → Codex) for shared work, or allow instance Codex accounts explicitly (settings.harnesses.cli.allowInstanceCodex)";

/**
 * Whether an account may run this work (null) or why not. The rule: a personal sign-in runs only
 * work its owner started; never for channel customers or on an instance that serves customers.
 */
export function cliAccountUseProblem(account: CliAccount, ctx: CliUseContext, settings?: CliSettings): string | null {
  const name = CLI_NAMES[account.cli];
  const note = account.cli === "claude" ? CLI_SUBSCRIPTION_POLICY_NOTE : CODEX_POLICY_NOTE;
  const instanceCodex = account.cli === "codex" && account.owner === CLI_INSTANCE_OWNER && !!settings?.allowInstanceCodex;
  if (ctx.origin === "channel-customer") return `${name} account "${account.id}" cannot answer channel customers: it is a personal sign-in. ${note}`;
  if (ctx.servesCustomers && !instanceCodex) return `${name} account "${account.id}" cannot run on an instance that serves customers: it is a personal sign-in. ${note}`;
  if (instanceCodex) return null;
  if (account.owner === CLI_INSTANCE_OWNER) {
    if (account.cli === "claude" && !ctx.instanceAuth) return null;
    return account.cli === "claude"
      ? `${name} account "${account.id}" belongs to no member, and this instance has several members: set its owner to the member who signed in. ${note}`
      : `${name} account "${account.id}" is owned by "instance", which needs settings.harnesses.cli.allowInstanceCodex. ${note}`;
  }
  if (ctx.origin === "schedule") return `${name} account "${account.id}" belongs to ${account.owner} and cannot run scheduled work. ${note}`;
  if (!ctx.initiator) return `${name} account "${account.id}" belongs to ${account.owner}, and this work was not started by a member (no author). ${note}`;
  if (ctx.initiator.toLowerCase() !== account.owner) return `${name} account "${account.id}" belongs to ${account.owner}; this work was started by ${ctx.initiator}. ${note}`;
  return null;
}

// ── Status, versions, errors ─────────────────────────────────────────────

export interface CliAccountStatus {
  signedIn: boolean;
  /** Who: the email or the login kind the CLI reports. */
  who?: string;
  /** How: claude.ai / oauth_token / api_key / chatgpt / api-key… */
  method?: string;
  /** Claude: the subscription (pro, max, team…). */
  plan?: string;
  detail?: string;
}

/** `claude auth status` (JSON; exit 0 signed in, 1 not) or `codex login status` (text). */
export function parseCliStatus(cli: CliId, o: { exitCode: number; stdout: string; stderr: string }): CliAccountStatus {
  const out = `${o.stdout}\n${o.stderr}`.trim();
  if (cli === "claude") {
    const json = parseJsonObject(o.stdout);
    if (json) {
      const method = typeof json.authMethod === "string" ? json.authMethod : undefined;
      const signedIn = json.loggedIn === true || (method !== undefined && method !== "none" && o.exitCode === 0);
      const email = typeof json.email === "string" ? json.email : typeof (json.account as Record<string, unknown> | undefined)?.email === "string" ? String((json.account as Record<string, unknown>).email) : undefined;
      const plan = typeof json.subscriptionType === "string" ? json.subscriptionType : undefined;
      return { signedIn, ...(email ? { who: email } : {}), ...(method ? { method } : {}), ...(plan ? { plan } : {}) };
    }
    if (o.exitCode === 0 && !/not (logged|signed) in/i.test(out)) return { signedIn: true, detail: firstLine(out) };
    return { signedIn: false, ...(out ? { detail: firstLine(out) } : {}) };
  }
  if (/not logged in/i.test(out) || o.exitCode !== 0) return { signedIn: false, ...(out ? { detail: firstLine(out) } : {}) };
  const m = /logged in using (?:an? )?(chatgpt|api key)/i.exec(out);
  const method = m ? (m[1]!.toLowerCase() === "chatgpt" ? "chatgpt" : "api-key") : undefined;
  return { signedIn: true, ...(method ? { method } : {}), detail: firstLine(out) };
}

/** The version a CLI reports (`claude --version` → "2.1.300 (Claude Code)", `codex --version` → "codex-cli 0.80.0"). */
export function parseCliVersion(out: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(out)?.[1];
}

export type CliFailureKind = "not-signed-in" | "usage-limit" | "not-installed" | "other";

/** A CLI failure, labelled: "not signed in" and "usage limit" are not retried. */
export function classifyCliError(cli: CliId, raw: string, account?: Pick<CliAccount, "id">): { kind: CliFailureKind; retryable: boolean; message: string } {
  const name = CLI_NAMES[cli];
  const acc = account ? ` account "${account.id}"` : "";
  if (/command not found|ENOENT|not found: (claude|codex)|No such file or directory.*(claude|codex)/i.test(raw)) {
    return { kind: "not-installed", retryable: false, message: `${name} is not installed on this computer: install it (Settings → Harnesses → CLI accounts → Install) and run the task again` };
  }
  if (/not logged in|please run \/login|run `?claude auth login|invalid api key|oauth token (has )?expired|authentication_error|unauthorized|401\b|codex login|sign in again|logged out/i.test(raw)) {
    return { kind: "not-signed-in", retryable: false, message: `${name}${acc} is not signed in (or its sign-in expired): sign in again from Settings → Harnesses → CLI accounts, then run the task again` };
  }
  if (/usage limit|rate[_ ]limit.*(reached|exceeded)|hit your (usage )?limit|limit reached|quota exceeded|usage_limit_reached|out of (extra )?usage/i.test(raw)) {
    const reset = /resets? (?:at |in )?([^.\n]{1,60})/i.exec(raw)?.[1];
    return { kind: "usage-limit", retryable: false, message: `${name}${acc} reached its plan's usage limit${reset ? ` (resets ${reset.trim()})` : ""}: run the task again later, or use an API key` };
  }
  return { kind: "other", retryable: true, message: raw.slice(0, 2000) };
}

function parseJsonObject(s: string): Record<string, unknown> | undefined {
  const t = s.trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const v = JSON.parse(t.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function firstLine(s: string): string {
  return s.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 200) ?? "";
}

/** The instance serves customers: a WhatsApp Business channel whose audience is "customers" (the default). */
export function instanceServesCustomers(settings: { notifications?: { channels?: Record<string, unknown> } } | undefined): boolean {
  const channels = settings?.notifications?.channels ?? {};
  return Object.values(channels).some((c) => {
    const ch = c as { type?: unknown; business?: { audience?: unknown } } | undefined;
    return ch?.type === "whatsapp-business" && ch.business?.audience !== "operators";
  });
}
