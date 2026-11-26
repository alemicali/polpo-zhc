/**
 * Codex signed in with ChatGPT (settings.harnesses.codex.auth "chatgpt"). OpenAI supports a
 * ChatGPT login for Codex, also on headless machines (`codex login --device-auth`, or a copy of
 * ~/.codex/auth.json): https://developers.openai.com/codex/auth
 *
 * - The login cache (Codex's auth.json, with the ChatGPT tokens) is kept in a vault entry (the
 *   setting's credentialRef, or an agent's engine.credentialRef), custom field `authJson`.
 * - Each agent has its own CODEX_HOME in its computer's HOME ($HOME/.polpo-harness/codex/<agent>).
 *   Before a session starts, the vault's copy is written there (mode 600) when the computer has none
 *   or an older one. Codex reads it itself: no API key is passed and nothing is brokered.
 * - Codex refreshes its tokens inside auth.json: after each turn, at the end of a run and before
 *   the computer's VM goes away (hibernate, reset, delete), the file is read back and, when it
 *   changed and is not older than the vault's copy, saved to the vault. Failures are warnings only.
 * - Signing in: `codex login --device-auth` with that CODEX_HOME, in a terminal on the agent's
 *   computer (Polpo's terminal); the result is captured into the vault the same way.
 *
 * The content is never logged; its tokens go to the run's secret masker.
 */
import { join } from "node:path";
import {
  CODEX_AUTH_JSON_FIELD, HOST_COMPUTER_ID, agentHarness, harnessesSettingsOf, isRemoteComputer, type ComputerConfig, type VaultRef, type VaultStore,
} from "@polpo-ai/core";

/** Where the per-agent CODEX_HOME lives, under the computer's HOME. */
export const CODEX_CHATGPT_HOME_DIR = ".polpo-harness/codex";
/** The Codex version the AI SDK's Codex harness bundles (used for the sign-in when nothing else is installed). */
export const CODEX_BUNDLED_VERSION = "0.167.0";
/** The Codex CLI the harness bootstrap installs in the computer (AI SDK harness state directory). */
const BOOTSTRAP_CODEX = "$HOME/.ai-sdk-harness/.harness-bootstrap/codex/node_modules/@openai/codex/bin/codex.js";

/** A directory name for an agent (the same agent always gets the same one). */
export function codexHomeSlug(agent: string): string {
  return agent.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "agent";
}

/**
 * The isolated HOME of an agent's harness on this server (settings.harnesses.allowHost): never the
 * server's own HOME. The harness engine runs the runtime there; the sign-in terminal too.
 */
export function hostHarnessHome(polpoDir: string, agent: string): string {
  const slug = agent.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "skill";
  return join(polpoDir, "harness", slug, "home");
}

/** The agent's CODEX_HOME for a HOME directory ("$HOME" keeps it for the shell to expand). */
export function codexChatgptHome(homeDir: string, agent: string): string {
  return `${homeDir.replace(/\/+$/, "")}/${CODEX_CHATGPT_HOME_DIR}/${codexHomeSlug(agent)}`;
}

/**
 * The sign-in command for an agent, run by a shell in its computer: `codex login --device-auth`
 * with the agent's CODEX_HOME (the Codex the harness installed, else one on PATH, else the bundled
 * version through npx). Codex keeps the login in $CODEX_HOME/auth.json (file storage).
 */
export function codexChatgptLoginCommand(agent: string, homeDir = "$HOME"): string {
  const home = codexChatgptHome(homeDir, agent);
  return [
    `export CODEX_HOME="${home}"`,
    `mkdir -p "$CODEX_HOME" && chmod 700 "$CODEX_HOME"`,
    `[ -f "$CODEX_HOME/config.toml" ] || printf 'cli_auth_credentials_store = "file"\\n' > "$CODEX_HOME/config.toml"`,
    `if [ -f "${BOOTSTRAP_CODEX}" ]; then node "${BOOTSTRAP_CODEX}" login --device-auth; `
      + `elif command -v codex >/dev/null 2>&1; then codex login --device-auth; `
      + `else npx -y @openai/codex@${CODEX_BUNDLED_VERSION} login --device-auth; fi`,
    `chmod 600 "$CODEX_HOME/auth.json" 2>/dev/null; true`,
  ].join("; ");
}

export interface CodexAuthFile {
  raw: string;
  parsed: Record<string, unknown>;
  /** last_refresh in ms (0 when absent). */
  freshness: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Codex's auth.json, when it holds a login (ChatGPT tokens, or an API key). */
export function parseCodexAuthJson(text: string | undefined | null): CodexAuthFile | undefined {
  const raw = text?.trim();
  if (!raw || !raw.startsWith("{")) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!isRecord(parsed)) return undefined;
  const tokens = parsed.tokens;
  const hasTokens = isRecord(tokens) && (typeof tokens.access_token === "string" || typeof tokens.refresh_token === "string");
  const hasKey = typeof parsed.OPENAI_API_KEY === "string" && !!parsed.OPENAI_API_KEY;
  if (!hasTokens && !hasKey) return undefined;
  const t = typeof parsed.last_refresh === "string" ? Date.parse(parsed.last_refresh) : NaN;
  return { raw, parsed, freshness: Number.isFinite(t) ? t : 0 };
}

/** The secrets in an auth.json (for the run's masker): its tokens and any API key. */
export function codexAuthSecrets(text: string | undefined | null): string[] {
  const f = parseCodexAuthJson(text);
  if (!f) return [];
  const out: string[] = [];
  const tokens = isRecord(f.parsed.tokens) ? f.parsed.tokens : {};
  for (const k of ["access_token", "refresh_token", "id_token"]) {
    const v = tokens[k];
    if (typeof v === "string" && v.length >= 6) out.push(v);
  }
  if (typeof f.parsed.OPENAI_API_KEY === "string" && f.parsed.OPENAI_API_KEY.length >= 6) out.push(f.parsed.OPENAI_API_KEY);
  return out;
}

/** Same login content (whitespace and key order aside). */
export function sameCodexAuth(a: CodexAuthFile | undefined, b: CodexAuthFile | undefined): boolean {
  if (!a || !b) return !a && !b;
  const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : isRecord(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  return JSON.stringify(canon(a.parsed)) === JSON.stringify(canon(b.parsed));
}

/** The vault's copy (field authJson), when it holds a login. */
export async function readVaultCodexAuth(vault: VaultStore | undefined, ref: VaultRef): Promise<CodexAuthFile | undefined> {
  const entry = await vault?.get(ref.owner, ref.service).catch(() => undefined);
  return parseCodexAuthJson(entry?.credentials?.[CODEX_AUTH_JSON_FIELD]);
}

/** Save a login into the vault entry (created as a custom entry when it does not exist). */
export async function writeVaultCodexAuth(vault: VaultStore, ref: VaultRef, raw: string): Promise<void> {
  const exists = await vault.get(ref.owner, ref.service).catch(() => undefined);
  await vault.patch(ref.owner, ref.service, {
    ...(exists ? {} : { type: "custom" as const, label: "Codex ChatGPT sign-in" }),
    credentials: { [CODEX_AUTH_JSON_FIELD]: raw },
  });
}

/** What the seed and the write-back need from a machine. */
export interface CodexAuthMachine {
  exec(command: string, opts: Record<string, never>): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readFile(path: string): Promise<Uint8Array | null>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The machine's auth.json in that CODEX_HOME (undefined when missing or unreadable). */
export async function readMachineCodexAuth(machine: Pick<CodexAuthMachine, "readFile">, codexHome: string): Promise<string | undefined> {
  const b = await machine.readFile(`${codexHome}/auth.json`).catch(() => null);
  return b ? Buffer.from(b).toString("utf8") : undefined;
}

/**
 * Before a session: the agent's CODEX_HOME exists (700) with file storage for the login, and holds
 * the freshest login: the vault's copy is written (600) when the machine has none or an older one.
 * - "written": the vault's copy is in the machine now;
 * - "kept": the machine's copy is as fresh or fresher (the write-back saves it when it differs);
 * - "none": no login anywhere (nobody signed in yet).
 */
export async function seedCodexAuth(machine: CodexAuthMachine, codexHome: string, vaultRaw: string | undefined): Promise<{ action: "written" | "kept" | "none"; machineRaw?: string }> {
  const dir = q(codexHome);
  await machine.exec(`mkdir -p ${dir} && chmod 700 ${dir} && { [ -f ${dir}/config.toml ] || printf 'cli_auth_credentials_store = "file"\\n' > ${dir}/config.toml; }`, {});
  const machineRaw = await readMachineCodexAuth(machine, codexHome);
  const onMachine = parseCodexAuthJson(machineRaw);
  const inVault = parseCodexAuthJson(vaultRaw);
  if (inVault && (!onMachine || (inVault.freshness > onMachine.freshness && !sameCodexAuth(inVault, onMachine)))) {
    const path = `${codexHome}/auth.json`;
    // created 600 before the content goes in (the directory is 700 anyway)
    await machine.exec(`umask 077 && : > ${q(path)} && chmod 600 ${q(path)}`, {});
    await machine.writeFile(path, new TextEncoder().encode(`${inVault.raw}\n`));
    await machine.exec(`chmod 600 ${q(path)}`, {});
    return { action: "written", machineRaw: inVault.raw };
  }
  if (onMachine) return { action: "kept", machineRaw: onMachine.raw };
  return { action: "none" };
}

export type CodexCaptureStatus = "updated" | "unchanged" | "missing" | "invalid" | "older";

/**
 * Write-back: the machine's auth.json into the vault when it holds a login that differs from the
 * vault's copy and is not older than it (another agent sharing the entry may have refreshed it
 * since). Returns the machine copy's secrets for the masker. Throws only on a vault write error.
 */
export async function captureCodexAuth(o: {
  read: () => Promise<string | undefined>;
  vault: VaultStore | undefined;
  ref: VaultRef;
}): Promise<{ status: CodexCaptureStatus; secrets: string[] }> {
  const raw = await o.read().catch(() => undefined);
  if (raw === undefined || !raw.trim()) return { status: "missing", secrets: [] };
  const onMachine = parseCodexAuthJson(raw);
  if (!onMachine) return { status: "invalid", secrets: [] };
  const secrets = codexAuthSecrets(raw);
  if (!o.vault) throw new Error("no vault on this instance");
  const inVault = await readVaultCodexAuth(o.vault, o.ref);
  if (sameCodexAuth(onMachine, inVault)) return { status: "unchanged", secrets };
  if (inVault && onMachine.freshness < inVault.freshness) return { status: "older", secrets };
  await writeVaultCodexAuth(o.vault, o.ref, onMachine.raw);
  return { status: "updated", secrets };
}

/** Where an agent signs in with ChatGPT: its computer, the vault entry, this server's isolated HOME. */
export type CodexChatgptTarget =
  | { ok: true; agent: string; ref: VaultRef; computer: string; hostHome?: string }
  | { ok: false; status: 404 | 409; error: string };

/**
 * The sign-in target of an agent: Codex must be set to sign in with ChatGPT; the login goes to the
 * agent's own entry (engine.credentialRef on Codex) or the setting's; it runs on the agent's
 * computer (a remote one, or this server with settings.harnesses.allowHost).
 */
export function codexChatgptTarget(o: {
  settings: { harnesses?: unknown; computers?: unknown } | undefined;
  agents: ReadonlyArray<{ name: string; engine?: unknown; defaultComputer?: string }>;
  agent: string | undefined;
  polpoDir: string;
}): CodexChatgptTarget {
  const h = harnessesSettingsOf(o.settings);
  const cx = h?.codex;
  if (cx?.auth !== "chatgpt") {
    return { ok: false, status: 409, error: "Codex is not set to sign in with ChatGPT: set settings.harnesses.codex { auth: \"chatgpt\", credentialRef: { owner, service } } first (Settings → Harnesses → Codex)" };
  }
  if (!o.agent) return { ok: false, status: 409, error: "agent is required: the ChatGPT sign-in is kept per agent, in its computer" };
  const agent = o.agents.find((a) => a.name === o.agent);
  if (!agent) return { ok: false, status: 404, error: `Unknown agent "${o.agent}"` };
  const engine = agentHarness(agent);
  const ref = (engine?.harness === "codex" ? engine.credentialRef : undefined) ?? cx.credentialRef;
  if (!ref) return { ok: false, status: 409, error: "Codex's ChatGPT sign-in has no vault entry (settings.harnesses.codex.credentialRef)" };
  const computer = agent.defaultComputer && agent.defaultComputer !== HOST_COMPUTER_ID ? agent.defaultComputer : HOST_COMPUTER_ID;
  if (computer === HOST_COMPUTER_ID) {
    if (!h?.allowHost) return { ok: false, status: 409, error: `Agent "${agent.name}" works on this server: give it a Daytona v2 computer (or allow harnesses on this server, settings.harnesses.allowHost)` };
    return { ok: true, agent: agent.name, ref, computer, hostHome: hostHarnessHome(o.polpoDir, agent.name) };
  }
  const c = (Array.isArray(o.settings?.computers) ? (o.settings!.computers as ComputerConfig[]) : []).find((x) => x?.id === computer);
  if (!c) return { ok: false, status: 409, error: `Agent "${agent.name}": unknown computer "${computer}"` };
  if (c.kind === "host") {
    if (!h?.allowHost) return { ok: false, status: 409, error: `Agent "${agent.name}": computer "${c.id}" is this server; harnesses run there only with settings.harnesses.allowHost` };
    return { ok: true, agent: agent.name, ref, computer: HOST_COMPUTER_ID, hostHome: hostHarnessHome(o.polpoDir, agent.name) };
  }
  if (!isRemoteComputer(c) || c.kind !== "daytona") return { ok: false, status: 409, error: `Agent "${agent.name}": Codex runs on Daytona v2 computers (computer "${c.id}" is ${c.kind})` };
  return { ok: true, agent: agent.name, ref, computer: c.id };
}
