/**
 * Harness engine: an agent whose `engine` is an official agent harness (Claude Code, Codex, OpenCode) runs
 * its tasks through the AI SDK HarnessAgent, inside its computer, with the same AgentHandle
 * contract as Polpo's own engine (engine.ts):
 *
 * - the runtime runs in the agent's computer (a Daytona v2 VM; this server only with
 *   settings.harnesses.allowHost, then with an isolated HOME), through src/harness/sandbox-session.ts;
 * - credentials are explicit (settings.harnesses → vault), never this server's env or ~/.claude;
 * - the agent's Polpo tools are host tools (run here, with the agent's permissions);
 * - its stream becomes the run transcript and activity; usage and the runtime's cost go to the
 *   token usage store; registered outcomes and written files are the run's deliverables;
 * - kill aborts the turn; a hibernation of the computer detaches the session (resume state in the
 *   vault) and the next turn re-attaches to the new VM.
 *
 * A run's session is kept per task (key "task:<id>"): a continuation of the task resumes the same
 * runtime conversation; at the end of a run the runtime is stopped (its bridge exits; the
 * conversation stays in the VM for a continuation).
 *
 * Codex signed in with ChatGPT (harness/codex-chatgpt.ts): the login cache from the vault is
 * written into the agent's CODEX_HOME in the computer before the session, and read back into the
 * vault after each turn, at the end of the run and before the computer's VM goes away.
 */
import { join } from "node:path";
import {
  agentEngineProblem, agentHarness, buildAgentSystemPrompt, DEPENDENCY_RESULTS_TOOL, HARNESS_NAMES, harnessesSettingsOf, isRemoteComputer,
  type AgentHarnessEngine, type PolpoSettings, type VaultRef,
} from "@polpo-ai/core";
import { daytonaApiVersion } from "@polpo-ai/core/sandbox";
import type { AgentConfig, Task, TaskResult } from "../core/types.js";
import type { AgentHandle, SpawnContext } from "../core/adapter.js";
import { loadPolpoConfig } from "../core/config.js";
import { createWorkspace, isRemoteWorkspace, WorkspaceShell } from "../sandbox/manager.js";
import { RemoteWorkspace } from "../sandbox/remote.js";
import { WorkspaceFileSystem } from "../sandbox/workspace-fs.js";
import { loadAgentSkills, type LoadedSkill } from "../llm/skills.js";
import { readSkillTextFiles } from "../llm/skill-bundle.js";
import { buildAgentToolset, buildPrompt, collectOutcome, createActivity } from "./engine.js";
import { brokeredHarnessAuth, HarnessCredentialError, resolveHarnessAuth, scrubSecrets, type HarnessBrokering, type ResolvedHarnessAuth } from "../harness/credentials.js";
import { captureCodexAuth, codexAuthSecrets, codexChatgptHome, hostHarnessHome, readMachineCodexAuth, seedCodexAuth } from "../harness/codex-chatgpt.js";
import { classifyHarnessError, harnessTurnFailure, type HarnessFailure, type HarnessTurnOutcome } from "../harness/errors.js";
import { harnessRelayPublicUrl, openRelayLease, type HarnessRelayLease, type RelayLeaseOptions } from "../harness/relay.js";
import { toHarnessHostTools } from "../harness/host-tools.js";
import { liveHarnessSessions, type HarnessSuspendMode } from "../harness/live-sessions.js";
import {
  createHarnessSandboxSession, freeHostPort, freeMachinePort, hostHarnessMachine, remoteHarnessMachine, type HarnessCredentialBroker, type HarnessMachine,
} from "../harness/sandbox-session.js";
import { HarnessSessionStore, harnessSessionKey, type HarnessSessionStatus } from "../harness/session-store.js";
import type {
  HarnessEvent, HarnessResumeState, HarnessRuntime, HarnessRuntimeFactory, HarnessRuntimeSession, HarnessSandbox, HarnessSkill, HarnessTurnResult,
} from "../harness/types.js";
import type { TokenUsageRecord } from "@polpo-ai/core/token-usage";

/** pnpm the harness bootstrap needs (lockfile v9 with allowBuilds): baked in polpo-runner-vm-3, else activated here. */
export const HARNESS_PNPM_VERSION = "10.30.1";
const ENSURE_PNPM = `command -v pnpm >/dev/null 2>&1 || { COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack prepare pnpm@${HARNESS_PNPM_VERSION} --activate >/dev/null 2>&1 && corepack enable pnpm >/dev/null 2>&1; }; command -v pnpm >/dev/null 2>&1`;
/** Signed preview links for remote bridges last as long as a VM can (re-attaching mints a new one). */
const PORT_TTL_SECONDS = 24 * 3600;

export interface HarnessEngineDeps {
  /** The runtime (tests inject a fake; default: the AI SDK HarnessAgent, loaded lazily). */
  runtimeFactory?: HarnessRuntimeFactory;
  /** Settings (default: .polpo/polpo.json). */
  settings?: () => PolpoSettings | undefined;
  /** The machine the runtime runs on (tests inject one; default from the run's sandbox). */
  openMachine?: (o: { agent: AgentConfig; cwd: string; ctx: SpawnContext; settings: PolpoSettings | undefined; workspace?: import("@polpo-ai/core/sandbox").Workspace }) => Promise<OpenedMachine>;
  /** Token usage sink (default: the project's token usage store). */
  recordUsage?: (r: TokenUsageRecord) => Promise<void>;
  store?: HarnessSessionStore;
  /** Polpo's public URL, for the model relay (default: POLPO_PUBLIC_URL). */
  publicUrl?: () => string | undefined;
  /** Opens the run's model relay lease (tests inject one). */
  openRelayLease?: (o: RelayLeaseOptions) => Promise<HarnessRelayLease>;
  /**
   * How long a computer that stopped answering (the provider's "sandbox not available", a bridge
   * whose connection could not be re-established) is waited for before the run fails (default 5 min).
   */
  unavailableWaitMs?: number;
  /** Waits (tests make it instant); resolves early when the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * The computer stopped answering for a while — the provider's proxy cannot reach the VM ("bad
 * gateway: sandbox … not available"), the bridge's connection dropped and could not be
 * re-established, a gateway error — as opposed to an error of the runtime or the model. Worth
 * checking again before the run fails (and before an automatic retry fails the same way in seconds).
 */
export const TRANSIENT_MACHINE_ERROR = /bad gateway|\bsandbox \S+ (?:is )?not available|bridge closed before the turn finished|reconnect (?:deadline expired|failed)|service unavailable|gateway time-?out|\bHTTP 50[234]\b|\bstatus (?:code )?50[234]\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up/i;

export function isTransientMachineError(message: string): boolean {
  return TRANSIENT_MACHINE_ERROR.test(message);
}

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) { resolve(); return; }
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); }
  signal?.addEventListener("abort", done, { once: true });
});

/**
 * Whether the computer answers again within `budgetMs`: a trivial command, tried with backoff
 * (5 s, 10 s, 20 s, then every 30 s). Each try is bounded (a hung provider call counts as no
 * answer). false when the budget runs out or the run is killed.
 */
export async function waitForMachine(
  machine: Pick<HarnessMachine, "exec">,
  o: { budgetMs: number; signal?: AbortSignal; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; now?: () => number; onWait?: (ms: number, why: string) => void },
): Promise<boolean> {
  const sleep = o.sleep ?? defaultSleep;
  const now = o.now ?? Date.now;
  const until = now() + o.budgetMs;
  let delay = 5_000;
  while (!o.signal?.aborted) {
    let why = "no answer";
    try {
      const r = await Promise.race([
        machine.exec("true", { timeoutMs: 20_000, ...(o.signal ? { signal: o.signal } : {}) }),
        sleep(25_000, o.signal).then(() => ({ exitCode: -1, stdout: "", stderr: "no answer within 25 s" })),
      ]);
      if (r.exitCode === 0) return true;
      why = r.stderr || `exit code ${r.exitCode}`;
    } catch (err) {
      why = (err as Error)?.message ?? String(err);
    }
    const left = until - now();
    if (left <= 0 || o.signal?.aborted) return false;
    const ms = Math.min(delay, left);
    o.onWait?.(ms, why);
    await sleep(ms, o.signal);
    delay = Math.min(delay * 2, 30_000);
  }
  return false;
}

export interface OpenedMachine {
  machine: HarnessMachine;
  /** "host" or the computer id. */
  computerId: string;
  /** The computer is in use (a turn) until the returned function runs. */
  hold?: () => () => void;
  /** The current VM id (status). */
  remoteId?: () => string | undefined;
  /** This server's isolated HOME (host machines). */
  home?: string;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "skill";

/**
 * A loaded skill for an agent harness: its bundled text files travel with it (the harness writes
 * them next to SKILL.md, so `references/…` and `scripts/…` resolve); binary files cannot, and the
 * instructions say so.
 */
export function harnessSkill(s: LoadedSkill): HarnessSkill {
  const bundled = s.dir ? readSkillTextFiles(s.dir) : { files: [], skipped: [] };
  const note = bundled.skipped.length
    ? `\n\n> Bundled files not available in this runtime (binary or too large): ${bundled.skipped.slice(0, 20).join(", ")}${bundled.skipped.length > 20 ? "…" : ""}.`
    : "";
  return {
    name: slug(s.name),
    description: (s.description || s.name).slice(0, 1000),
    content: s.content + note,
    ...(bundled.files.length ? { files: bundled.files } : {}),
  };
}

/**
 * The runtime's file edits as activity (Claude Code Write/Edit/MultiEdit, Codex apply_patch/write_file).
 * The AI SDK harness reports the runtime's tools in lower case ("write", "edit"), so names match
 * whatever their case.
 */
export function fileOfToolCall(toolName: string, input: unknown): { path: string; created: boolean } | undefined {
  const i = (input ?? {}) as Record<string, unknown>;
  const path = typeof i.file_path === "string" ? i.file_path : typeof i.path === "string" ? i.path : undefined;
  if (!path) return undefined;
  if (/^(write|write_file|create_file)$/i.test(toolName)) return { path, created: true };
  if (/^(edit|multiedit|multi_edit|notebookedit|notebook_edit|edit_file|apply_patch)$/i.test(toolName)) return { path, created: false };
  return undefined;
}

function stringify(v: unknown, max = 2000): string {
  if (typeof v === "string") return v.slice(0, max);
  try { return JSON.stringify(v).slice(0, max); } catch { return String(v).slice(0, max); }
}

/** The default machine: the agent's remote computer (Daytona v2), or this server with an isolated HOME. */
async function defaultOpenMachine(o: { agent: AgentConfig; cwd: string; ctx: SpawnContext; settings: PolpoSettings | undefined; workspace?: import("@polpo-ai/core/sandbox").Workspace }): Promise<OpenedMachine> {
  const computer = o.ctx.sandbox?.computer;
  if (computer && isRemoteComputer(computer)) {
    if (computer.kind !== "daytona") throw new Error(`${computer.kind} computers cannot run agent harnesses yet (computer "${computer.id}"): use a Daytona v2 computer`);
    const ws = o.workspace;
    if (!(ws instanceof RemoteWorkspace)) throw new Error(`Computer "${computer.id}" is not reachable from this server (no Daytona API key here?)`);
    const driver = await ws.driver();
    if (!driver.spawn || !driver.portEndpoint) {
      throw new Error(`Computer "${computer.id}" runs on Daytona v0: agent harnesses need Daytona v2 (settings.sandbox.providers.daytona.api "v2"), whose VMs run long-lived processes and expose ports`);
    }
    // the session works in the run's working directory, in the VM
    await driver.exec(`mkdir -p '${o.cwd.replace(/'/g, `'\\''`)}'`, {});
    return {
      machine: remoteHarnessMachine({
        driver: () => ws.driver(), workDir: o.cwd, label: computer.id, portTtlSeconds: PORT_TTL_SECONDS,
        // a provider that rewrites outbound requests itself brokers the credential natively
        nativeTransformations: !!driver.requestTransformations,
      }),
      computerId: computer.id,
      hold: () => driver.hold?.() ?? (() => {}),
      remoteId: () => ws.remoteId,
    };
  }
  if (!harnessesSettingsOf(o.settings)?.allowHost) {
    throw new Error(`Agent "${o.agent.name}" works on this server: agent harnesses run there only with settings.harnesses.allowHost (with an isolated HOME). Give it a Daytona v2 computer instead.`);
  }
  const polpoDir = o.ctx.polpoDir;
  // never the server's HOME: the runtime's config, credentials cache and bootstrap live here
  const home = hostHarnessHome(polpoDir, o.agent.name);
  return { machine: hostHarnessMachine({ workDir: o.cwd, home, label: "host" }), computerId: "host", home };
}

/**
 * Provider credentials OpenCode's bridge (or OpenCode itself) would pick up from the computer's
 * environment, blanked for its processes: only Polpo's config chooses the provider and the key.
 */
export const OPENCODE_BLANK_ENV: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries([
  "AI_GATEWAY_API_KEY", "AI_GATEWAY_BASE_URL", "VERCEL_OIDC_TOKEN", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_NAME", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY", "GITHUB_TOKEN", "GITHUB_COPILOT_TOKEN", "GITLAB_TOKEN", "POE_API_KEY",
  "OPENCODE_API_KEY", "AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE",
].map((k) => [k, ""])));

async function defaultRuntimeFactory(spec: Parameters<HarnessRuntimeFactory>[0]): Promise<HarnessRuntime> {
  const { createSdkHarnessRuntime } = await import("../harness/sdk.js");
  return createSdkHarnessRuntime(spec);
}

async function defaultRecordUsage(polpoDir: string, r: TokenUsageRecord): Promise<void> {
  const { databaseStoresFor } = await import("../core/storage.js");
  const { FileTokenUsageStore } = await import("../stores/file-token-usage-store.js");
  await (databaseStoresFor(polpoDir)?.tokenUsageStore ?? new FileTokenUsageStore(polpoDir)).record(r);
}

/**
 * The harness instructions: the agent's own prompt (identity, responsibilities, systemPrompt),
 * where it works, where deliverables go, the repository's AGENTS.md (Claude Code does not read it
 * by itself), and Polpo's tools.
 */
export function buildHarnessInstructions(o: {
  agent: AgentConfig; cwd: string; outputDir?: string; agentsMd?: string; connectorNote?: string; hostTools: string[]; harness: AgentHarnessEngine["harness"];
  /** A remote computer: the folders of it Polpo's tools take paths in (see remoteAllowedRoots). */
  remoteRoots?: string[];
}): string {
  const parts = [buildAgentSystemPrompt(o.agent, { skills: [] })];
  parts.push("", "## Working Directory", `Your working directory is ${o.cwd}. Work there; use relative paths.`);
  if (o.outputDir) {
    parts.push("", "## Output Directory",
      `Write deliverable files (reports, images, exports) to ${o.outputDir}, and register each one with the register_outcome tool.`);
  }
  if (o.hostTools.length) {
    parts.push("", "## Polpo tools",
      `Besides your own tools you have Polpo's tools (they run on the Polpo server with your permissions): ${o.hostTools.join(", ")}.`);
    if (o.remoteRoots?.length) parts.push(remoteToolPathsNote(o.remoteRoots));
    if (o.hostTools.includes("run_with_vault")) parts.push(RUN_WITH_VAULT_NOTE);
    if (o.hostTools.some((t) => t.startsWith("browser_"))) {
      parts.push("For anything in a browser use Polpo's browser: the browser_* tools above, or from scripts the same browser over $CDP_URL "
        + "(`agent-browser --session <your session> get cdp-url` when it is not set). Never launch a Chromium, Chrome or Playwright/Puppeteer browser of your own "
        + "(no `npx playwright install`, no browser launch() in scripts): sites flag those as bots, and they have none of your sign-ins.");
    }
  }
  if (o.connectorNote) parts.push("", o.connectorNote);
  if (o.agentsMd && o.harness === "claude-code") parts.push("", "## Repository instructions (AGENTS.md)", o.agentsMd.slice(0, 40_000));
  return parts.join("\n");
}

/** How an agent on a harness uses a vault secret in a command (its own shell cannot read the vault). */
export const RUN_WITH_VAULT_NOTE = "When a command needs a secret from your vault (API key, token, password), use run_with_vault with env_from_vault, "
  + "e.g. { \"command\": \"curl -s -H \\\"Authorization: Bearer $OPENAI_API_KEY\\\" https://api.openai.com/v1/models\", \"env_from_vault\": { \"OPENAI_API_KEY\": \"openai.api_key\" } }: "
  + "the value is set for that command only and shows as *** in its output (vault_list and vault_get show your services and key names, never the values). "
  + "Never copy secrets into files, the chat or outcomes.";

/**
 * For an agent on a remote computer: Polpo's tools take paths of the computer (their files are
 * read and written there), not of the Polpo server.
 */
export function remoteToolPathsNote(roots: readonly string[]): string {
  return "File paths you give Polpo's tools (browser_screenshot, image_analyze, image_edit, register_outcome, pdf_*, excel_*…) are paths of your computer, "
    + `the same files you see: anything under ${roots.join(", ")} (mounted volumes included). `
    + "Screenshots are saved there, images are read from there, and register_outcome copies the file into the task output on the Polpo server by itself: "
    + "do not copy files around for Polpo's tools. Paths outside these folders are rejected.";
}

/** Spawn a task run on the agent's harness (same contract as spawnEngine). */
export function spawnHarnessEngine(agentConfig: AgentConfig, task: Task, cwd: string, ctx: SpawnContext, deps: HarnessEngineDeps = {}): AgentHandle {
  const activity = createActivity();
  const start = Date.now();
  let alive = true;
  const abort = new AbortController();
  const followUps: Array<{ message: string; directionId?: string }> = [];
  const polpoDir = ctx.polpoDir;
  if (!polpoDir) throw new Error("spawnHarnessEngine: ctx.polpoDir is required");
  const store = deps.store ?? new HarnessSessionStore(polpoDir, ctx.vaultStore);
  const key = harnessSessionKey({ scope: "task", taskId: task.id });

  let session: HarnessRuntimeSession | undefined;
  let turnRunning = false;
  /** Set when the computer's VM went away under a running turn (forced rotation): re-attach and go on. */
  let interrupted: string | undefined;
  let secrets: string[] = [];
  // and the secrets the run learns while it runs (a password vault_create_login generated)
  let learned = ctx.runSecrets;
  const scrub = (t: string) => {
    const out = scrubSecrets(t, secrets);
    return learned ? learned.mask(out) : out;
  };

  const handle: AgentHandle = {
    agentName: agentConfig.name,
    taskId: task.id,
    startedAt: new Date().toISOString(),
    pid: 0,
    activity,
    done: null as unknown as Promise<TaskResult>,
    isAlive: () => alive,
    kill: () => {
      abort.abort(new Error("killed"));
      alive = false;
    },
    steer: (message, directionId) => {
      if (session && turnRunning) {
        void session.steer(message).then(
          () => directionId && handle.onDirectionApplied?.([directionId]),
          () => followUps.push({ message, directionId }),
        );
      } else {
        followUps.push({ message, directionId });
      }
    },
    followUp: (message, directionId) => { followUps.push({ message, directionId }); },
  };

  const transcript = (entry: Record<string, unknown>) => {
    activity.lastUpdate = new Date().toISOString();
    try { handle.onTranscript?.(entry); } catch { /* the log never breaks the run */ }
  };
  const sleep = deps.sleep ?? defaultSleep;
  const unavailableWaitMs = deps.unavailableWaitMs ?? 5 * 60_000;
  /**
   * `fn` again while it fails because the computer is not answering (with backoff, within
   * unavailableWaitMs): an automatic retry right after such a failure otherwise fails the same way
   * in seconds. Other errors, and the last one once the budget is spent, are thrown.
   */
  const whileUnavailable = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
    const until = Date.now() + unavailableWaitMs;
    let delay = 5_000;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        const left = until - Date.now();
        if (abort.signal.aborted || !isTransientMachineError(message) || left <= 0) throw err;
        const ms = Math.min(delay, left);
        transcript({ type: "log", message: `The computer is not answering (${what}: ${scrubSecrets(message, secrets).slice(0, 200)}): checking again in ${Math.round(ms / 1000)} s` });
        await sleep(ms, abort.signal);
        if (abort.signal.aborted) throw err;
        delay = Math.min(delay * 2, 30_000);
      }
    }
  };

  handle.done = (async (): Promise<TaskResult> => {
    let workspace: import("@polpo-ai/core/sandbox").Workspace | undefined;
    let opened: OpenedMachine | undefined;
    let unregister: (() => void) | undefined;
    let lease: HarnessRelayLease | undefined;
    let toolsetCleanup: Array<() => Promise<unknown>> = [];
    let lastText = "";
    let harnessName = "The harness";
    let auth: ResolvedHarnessAuth | undefined;
    /** Codex signed in with ChatGPT: the agent's CODEX_HOME in the computer and the vault entry of its login. */
    let codexChatgpt: { home: string; ref: VaultRef } | undefined;
    /**
     * Codex refreshes its ChatGPT tokens in auth.json: the machine's copy goes back to the vault when
     * it changed (never logged; a failure is a warning, never the run's).
     */
    const writeBackCodexAuth = async (when: string): Promise<void> => {
      const cx = codexChatgpt;
      const m = opened?.machine;
      if (!cx || !m) return;
      try {
        const r = await captureCodexAuth({ read: () => readMachineCodexAuth(m, cx.home), vault: ctx.vaultStore, ref: cx.ref });
        if (r.secrets.length) secrets = [...new Set([...secrets, ...r.secrets])];
        if (r.status === "updated") transcript({ type: "log", message: `Codex: the refreshed ChatGPT sign-in was saved to the vault (${when})` });
      } catch (err) {
        const warning = `Codex: the ChatGPT sign-in could not be saved back to the vault entry ${cx.ref.owner} / ${cx.ref.service} (${when}): ${scrub((err as Error)?.message ?? String(err))}`;
        console.warn(`[polpo/harness] ${warning}`);
        transcript({ type: "log", message: warning });
      }
    };
    /** What the current turn produced (errors, output after them, usage): see harness/errors.ts. */
    let turnOutcome: HarnessTurnOutcome = { errors: [], outputAfterError: false, output: false, totalTokens: 0 };
    const label = (raw: string): HarnessFailure =>
      classifyHarnessError(raw, {
        harnessName, ...(auth ? { provider: auth.provider } : {}), ...(auth?.providerLabel ? { providerLabel: auth.providerLabel } : {}), ...(auth?.model ? { model: auth.model } : {}),
      });
    try {
      const settings = deps.settings ? deps.settings() : loadPolpoConfig(polpoDir)?.settings;
      const engine = agentHarness(agentConfig);
      if (!engine) throw new Error(`Agent "${agentConfig.name}" has no harness engine`);
      const daytonaApi = daytonaApiVersion((settings?.sandbox as any)?.providers?.daytona) as "v0" | "v2";
      const problem = agentEngineProblem(agentConfig, settings as any, { daytonaApi });
      if (problem) throw new Error(problem);
      const name = HARNESS_NAMES[engine.harness];
      harnessName = name;

      // ── where it runs, and the agent's Polpo tools (run here) ──
      const outputDir = ctx.outputDir;
      const remoteRun = ctx.sandbox?.provider === "daytona" || ctx.sandbox?.provider === "e2b";
      const makeWorkspace = () => ctx.sandbox && !deps.openMachine
        ? createWorkspace(ctx.sandbox, {
            root: cwd,
            writable: [...(outputDir ? [outputDir] : [])],
            readable: [join(polpoDir, "skills")],
            volumes: ctx.volumes ?? [],
            hide: [polpoDir],
            onRemoteEvent: (e) => ctx.onSandboxEvent?.(e),
            pool: { polpoDir, owner: agentConfig.name, scope: "task", runId: ctx.runId },
            onNetworkDenied: ctx.onNetworkDenied,
          })
        : undefined;
      workspace = makeWorkspace();
      let opening = 0;
      opened = await whileUnavailable("opening the computer", async () => {
        // a workspace whose first acquire failed stays failed: a fresh one for the next try (a
        // computer's workspace never stops or deletes the computer when released)
        if (opening++ > 0 && workspace) {
          await workspace.dispose().catch(() => undefined);
          workspace = makeWorkspace();
        }
        return (deps.openMachine ?? defaultOpenMachine)({ agent: agentConfig, cwd, ctx, settings, workspace });
      });
      const shell = workspace ? new WorkspaceShell(workspace) : undefined;
      const remoteFs = isRemoteWorkspace(workspace) ? new WorkspaceFileSystem(workspace!) : undefined;
      const machine = opened.machine;

      const toolset = await buildAgentToolset({
        agentConfig, cwd, ctx, effectiveAllowedPaths: remoteRun ? undefined : [cwd, ...(outputDir ? [outputDir] : [])], outputDir, remoteFs, shell,
        sandboxProvider: workspace?.provider ?? "local",
        browserProfileDir: join(polpoDir, "browser-profiles", agentConfig.browserProfile || agentConfig.name),
        hasExtendedTools: (agentConfig.allowedTools ?? []).some((t) => /^(browser|email|image|video|audio|excel|pdf|docx|search|whatsapp|phone)_/i.test(t)),
        log: (line) => transcript({ type: "log", message: line }),
        task,
        harnessHost: true,
      });
      learned = toolset.secrets;
      toolsetCleanup = [
        async () => toolset.connectorManager?.closeAll(),
        async () => toolset.browserNetwork?.close(),
      ];
      // Host tools stay within HOST_TOOLS_EAGER_LIMIT where possible (all in the first request): of the
      // task result tools only task_result, since the dependencies' results are already in the prompt
      const hostTools = toHarnessHostTools(toolset.tools.filter((t) => t.name !== DEPENDENCY_RESULTS_TOOL), {
        interactive: false,
        onResult: (r) => {
          if (r.isError || !r.details) return;
          const outcome = collectOutcome(r.toolName, r.details);
          if (outcome) (handle.outcomes ??= []).push(outcome);
        },
      });

      // ── credentials: explicit, from the settings' vault reference ──
      const resolved: ResolvedHarnessAuth = await resolveHarnessAuth(engine, harnessesSettingsOf(settings), ctx.vaultStore);
      secrets = resolved.secrets;

      // ── credential brokering: the VM gets placeholders, the key is injected outside it ──
      // native: the computer's provider rewrites outbound requests; relay: Polpo's model relay
      // (POLPO_PUBLIC_URL); none: the key goes into the VM (no relay reachable, Bedrock, Vertex)
      let brokering: HarnessBrokering = "none";
      if (resolved.route && opened.computerId !== "host") {
        const publicUrl = (deps.publicUrl ?? harnessRelayPublicUrl)();
        if (machine.nativeRequestTransformations) {
          brokering = "native";
        } else if (publicUrl) {
          lease = await (deps.openRelayLease ?? openRelayLease)({
            polpoDir, publicUrl, upstream: resolved.route.upstream, headers: resolved.route.headers, scheme: resolved.route.scheme,
            log: (line) => transcript({ type: "log", message: line }),
          });
          secrets = [...secrets, lease.token];
          brokering = "relay";
        } else {
          const warning = `${name}: POLPO_PUBLIC_URL is not set, so Polpo's model relay is not reachable from the computer: the model key goes into the VM (credential brokering off). Set POLPO_PUBLIC_URL and expose its /api/v1/harness-relay/ path.`;
          console.warn(`[polpo/harness] ${warning}`);
          transcript({ type: "log", message: warning });
        }
      }
      auth = brokeredHarnessAuth(resolved, brokering, lease?.baseUrl);
      const creds = auth;
      const broker: HarnessCredentialBroker | undefined = brokering === "none" ? undefined : {
        ...(lease ? { lease } : {}),
        ...(resolved.route?.scheme ? { scheme: resolved.route.scheme } : {}),
        // native: Polpo's gateway headers are rules too (the relay lease holds its own)
        ...(brokering === "native" && resolved.route && Object.keys(resolved.route.headers).length
          ? { rules: [{ match: { host: new URL(resolved.route.upstream).hostname }, transform: { headers: { ...resolved.route.headers } } }] }
          : {}),
        // OpenCode: Polpo wrote its provider config, so the placeholder's rule is Polpo's own
        ...(auth.credentialRules?.length ? { credentialRules: auth.credentialRules } : {}),
      };
      if (resolved.chatgpt) transcript({ type: "log", message: `${name}: signed in with ChatGPT (the login cache from the vault entry ${resolved.chatgpt.ref.owner} / ${resolved.chatgpt.ref.service}, in the agent's CODEX_HOME in the computer)` });
      if (resolved.route) transcript({ type: "log", message: `${name}: model credential ${brokering === "none" ? "in the computer (not brokered)" : brokering === "relay" ? "brokered by Polpo's model relay (placeholders only in the computer)" : "brokered by the computer's provider (placeholders only in the computer)"}` });
      // where and with what this run executes (the task's run context; no secrets)
      activity.runContext = {
        ...(creds.model ? { model: creds.model } : {}),
        ...(opened.remoteId?.() ? { remoteId: opened.remoteId!() } : {}),
      };

      // ── the machine: pnpm for the bootstrap, credential files ──
      const pnpm = await whileUnavailable("preparing the computer", () => machine.exec(ENSURE_PNPM, {}));
      if (pnpm.exitCode !== 0) throw new Error(`${name} needs pnpm ${HARNESS_PNPM_VERSION} in the computer (corepack could not activate it): ${scrub(pnpm.stderr || pnpm.stdout).slice(0, 300)}`);
      if (creds.files.length) {
        const homeDir = opened.home ?? (await machine.exec("printf %s \"$HOME\"", {})).stdout.trim();
        for (const f of creds.files) {
          const path = `${homeDir}/.config/polpo-harness/${f.name}`;
          await machine.writeFile(path, new TextEncoder().encode(f.content));
          await machine.exec(`chmod 600 '${path}'`, {});
          creds.env[f.envVar] = path;
        }
      }
      // Codex signed in with ChatGPT: the freshest login in the agent's CODEX_HOME (vault → computer)
      if (resolved.chatgpt) {
        const homeDir = opened.home ?? (await machine.exec("printf %s \"$HOME\"", {})).stdout.trim();
        if (!homeDir) throw new Error(`${name}: the computer's HOME directory could not be read`);
        const home = codexChatgptHome(homeDir, agentConfig.name);
        const seeded = await seedCodexAuth(machine, home, resolved.chatgpt.authJson);
        if (seeded.action === "none") {
          throw new HarnessCredentialError(`${name} signs in with ChatGPT on this instance, and nobody has signed in for agent "${agentConfig.name}" yet: `
            + `Settings → Harnesses → Codex → Sign in with ChatGPT (or polpo_harnesses_update codex.chatgpt_login), then run the task again`);
        }
        codexChatgpt = { home, ref: resolved.chatgpt.ref };
        if (seeded.machineRaw) secrets = [...new Set([...secrets, ...codexAuthSecrets(seeded.machineRaw)])];
        // the computer's copy is fresher (a sign-in there, a refresh the vault missed): save it
        if (seeded.action === "kept") await writeBackCodexAuth("run start");
      }

      // ── skills and instructions ──
      const skills: HarnessSkill[] = loadAgentSkills(cwd, polpoDir, agentConfig.name, agentConfig.skills)
        .map((s) => harnessSkill(s));
      const agentsMd = await machine.readFile(join(cwd, "AGENTS.md")).then((b) => (b ? Buffer.from(b).toString("utf8") : undefined), () => undefined);
      const instructions = buildHarnessInstructions({
        agent: agentConfig, cwd, outputDir, agentsMd, connectorNote: toolset.connectorNote, hostTools: hostTools.map((t) => t.name), harness: engine.harness, ...(toolset.remoteRoots ? { remoteRoots: toolset.remoteRoots } : {}),
      });

      const runtime = await (deps.runtimeFactory ?? defaultRuntimeFactory)({
        harness: engine.harness,
        id: agentConfig.name,
        model: creds.model,
        instructions,
        tools: hostTools,
        skills,
        permissionMode: engine.permissionMode ?? "allow-all",
        ...(engine.effort ? { effort: engine.effort } : {}),
        ...(engine.maxBudgetUsd ? { maxBudgetUsd: engine.maxBudgetUsd } : {}),
        maxTurns: agentConfig.maxTurns ?? 150,
        auth: creds,
        onDebug: (e) => { if (/fail|error|reconnect/i.test(e.type)) transcript({ type: "log", message: `[${name}] ${e.type}` }); },
      });

      // ── the session: resumed for a continuation of the task, else fresh ──
      const prior = store.get(key);
      const wantResume = !!ctx.continuation && !!prior?.sessionId && prior.resumable;
      let resumeFrom: HarnessResumeState | undefined = wantResume ? await store.loadResumeState(key) : undefined;
      if (!wantResume && prior) {
        // a new run of the task (not a continuation): a new conversation
        await store.forgetResumeState(key);
        await store.update(key, () => null).catch(() => undefined);
      }
      // the old bridge's port only while that bridge still runs (a detached session re-attaches to
      // it); a stopped one's port may belong to another run's bridge on this computer by now
      const port = resumeFrom && prior?.bridgePort && prior.state === "detached"
        ? prior.bridgePort
        : opened.computerId === "host" ? await freeHostPort() : await freeMachinePort(machine);
      const sandbox: HarnessSandbox = createHarnessSandboxSession(machine, {
        port, ...(broker ? { broker } : {}),
        // OpenCode's bridge builds a provider from these variables when the computer has them: blank
        // them, so its config is Polpo's (the chosen provider and credential) and nothing else
        ...(engine.harness === "opencode" ? { spawnEnv: OPENCODE_BLANK_ENV } : {}),
        // Codex signed in with ChatGPT: its own CODEX_HOME (auth.json there), per agent
        ...(codexChatgpt ? { spawnEnv: { CODEX_HOME: codexChatgpt.home } } : {}),
      });
      const now = () => new Date().toISOString();
      const status = (patch: Partial<HarnessSessionStatus>) => store.update(key, (cur) => ({
        key, agent: agentConfig.name, harness: engine.harness, computerId: opened!.computerId, scope: "task", taskId: task.id,
        state: "starting", resumable: false, turns: 0, costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, createdAt: now(), updatedAt: now(),
        ...(cur ?? {}),
        ...patch,
      } as HarnessSessionStatus)).catch(() => undefined);
      await status({ state: "starting", pid: process.pid, bridgePort: port, remoteId: opened.remoteId?.(), lastError: undefined });

      const open = async (from?: HarnessResumeState, sessionId?: string): Promise<HarnessRuntimeSession> => {
        const t0 = Date.now();
        lease?.resume();
        const s = await runtime.createSession({ ...(sessionId ? { sessionId } : {}), ...(from ? { resumeFrom: from } : {}), sandbox, abortSignal: abort.signal });
        const ms = Date.now() - t0;
        const vm = opened!.remoteId?.();
        activity.runContext = {
          ...activity.runContext,
          ...(vm ? { remoteId: vm } : {}),
          session: { resumed: !!from, bootstrapMs: ms, sessionId: s.sessionId },
        };
        transcript({ type: "log", message: `${name} session ${from ? "resumed" : "started"} in ${Math.round(ms / 100) / 10} s on ${opened!.computerId}` });
        await status({
          state: "idle", sessionId: s.sessionId, pid: process.pid, remoteId: opened!.remoteId?.(),
          ...(from ? { lastResumeAt: now() } : { bootstrappedAt: now(), bootstrapMs: ms }),
        });
        return s;
      };
      session = await whileUnavailable("starting the session", () => open(resumeFrom, wantResume ? prior!.sessionId : undefined));
      activity.sessionId = session.sessionId;
      resumeFrom = undefined;
      let parked: HarnessResumeState | undefined;

      // ── hibernation: park before the VM goes, re-attach on the next turn ──
      unregister = liveHarnessSessions.register({
        key, agent: agentConfig.name, computerId: opened.computerId,
        suspend: async (mode: HarnessSuspendMode, reason: string) => {
          // the VM goes away: the refreshed ChatGPT sign-in goes to the vault first
          await writeBackCodexAuth(`computer ${reason}`);
          if (!session) return;
          if (turnRunning) {
            // a forced rotation under a running turn: the turn breaks; it re-attaches and goes on
            interrupted = reason;
            return;
          }
          const s = session;
          session = undefined;
          // the VM goes away: its relay token stops working until the session re-attaches
          lease?.suspend();
          try {
            parked = mode === "memory" ? await s.detach() : await s.stop();
            await store.saveResumeState(key, parked);
            await status({ state: mode === "memory" ? "detached" : "stopped", resumable: true, lastDetachAt: now(), pid: undefined });
            transcript({ type: "log", message: `${name} session ${mode === "memory" ? "detached" : "stopped"} (computer ${reason})` });
          } catch (err) {
            await status({ state: "error", lastError: scrub((err as Error).message) });
          }
        },
      });

      const ensureSession = async (): Promise<HarnessRuntimeSession> => {
        if (session) return session;
        const from = parked ?? (await store.loadResumeState(key));
        const id = store.get(key)?.sessionId;
        session = await open(from, id);
        parked = undefined;
        return session;
      };

      const runTurn = async (prompt: string): Promise<HarnessTurnResult> => {
        const s = await ensureSession();
        const release = opened!.hold?.();
        turnRunning = true;
        turnOutcome = { errors: [], outputAfterError: false, output: false, totalTokens: 0 };
        await status({ state: "running", pid: process.pid });
        try {
          return await s.turn(prompt, {
            abortSignal: abort.signal,
            onEvent: (e: HarnessEvent) => onEvent(e),
            onApproval: async (req) => {
              transcript({ type: "log", message: `${name} asked to run ${req.toolName}: denied (permission mode ${engine.permissionMode ?? "allow-all"}; a task cannot ask a person)` });
              return { approved: false, reason: "This agent runs unattended: its permission mode does not allow this action. Do it another way, or stop and say what you need." };
            },
          });
        } finally {
          turnRunning = false;
          release?.();
          await writeBackCodexAuth("after a turn");
        }
      };

      const onEvent = (e: HarnessEvent) => {
        if (e.type === "text" || e.type === "tool-call") {
          turnOutcome.output = true;
          if (turnOutcome.errors.length) turnOutcome.outputAfterError = true;
        } else if (e.type === "error") {
          turnOutcome.errors.push(scrub(e.message));
          turnOutcome.outputAfterError = false;
        }
        switch (e.type) {
          case "text":
            lastText = e.text;
            activity.summary = e.text.slice(0, 200);
            transcript({ type: "assistant", text: scrub(e.text) });
            break;
          case "reasoning":
            transcript({ type: "reasoning", text: scrub(e.text).slice(0, 4000) });
            break;
          case "tool-call": {
            activity.toolCalls++;
            activity.lastTool = e.toolName;
            const file = fileOfToolCall(e.toolName, e.input);
            if (file) {
              activity.lastFile = file.path;
              const list = file.created ? activity.filesCreated : activity.filesEdited;
              if (!list.includes(file.path)) list.push(file.path);
            }
            transcript({ type: "tool_use", tool: e.toolName, toolId: e.toolCallId, input: JSON.parse(scrub(JSON.stringify(e.input ?? {}))), ...(e.host ? { host: true } : {}) });
            break;
          }
          case "tool-result":
            transcript({ type: "tool_result", toolId: e.toolCallId, tool: e.toolName, content: scrub(stringify(e.output)), isError: e.isError });
            break;
          case "error":
            transcript({ type: "error", message: scrub(e.message) });
            break;
          default:
            break;
        }
      };

      // cost: what a gateway reports (relay, response headers) beats the runtime's estimate, which
      // uses Anthropic's list prices: right for Anthropic, approximate through a gateway, wrong for
      // non-Claude models (then only tokens are recorded)
      let leaseCostSeen = 0;
      const turnCost = (r: HarnessTurnResult): { usd?: number; source: "gateway" | "runtime" | "runtime-estimate" | "tokens-only" | "subscription" } => {
        const gateway = lease ? lease.costUsd - leaseCostSeen : 0;
        if (lease) leaseCostSeen = lease.costUsd;
        if (gateway > 0) return { usd: gateway, source: "gateway" };
        // a ChatGPT plan pays: tokens only, no USD billed by Polpo
        if (resolved.chatgpt) return { source: "subscription" };
        if (creds.nonClaude || (resolved.route && resolved.route.mode !== "direct" && engine.harness === "codex")) return { source: "tokens-only" };
        if (r.costUsd === undefined) return { source: "tokens-only" };
        // OpenCode prices steps from its model catalog: a model it has no price for costs "0"
        if (engine.harness === "opencode" && r.costUsd === 0 && r.usage.totalTokens > 0) return { source: "tokens-only" };
        return { usd: r.costUsd, source: resolved.route && resolved.route.mode !== "direct" ? "runtime-estimate" : "runtime" };
      };
      const account = async (r0: HarnessTurnResult) => {
        const c = turnCost(r0);
        const r: HarnessTurnResult = { ...r0 };
        if (c.usd === undefined) delete r.costUsd; else r.costUsd = c.usd;
        activity.totalTokens += r.usage.totalTokens;
        const prevCost = activity.runContext?.cost;
        activity.runContext = {
          ...activity.runContext,
          cost: {
            ...prevCost,
            tokens: activity.totalTokens,
            costSource: c.source,
            ...(r.costUsd !== undefined ? { harnessUsd: (prevCost?.harnessUsd ?? 0) + r.costUsd } : {}),
          },
        };
        const cur = store.get(key);
        await status({
          state: "idle", turns: (cur?.turns ?? 0) + 1, costUsd: (cur?.costUsd ?? 0) + (r.costUsd ?? 0), resumable: true,
          ...(r.runtimeSessionId ? { runtimeSessionId: r.runtimeSessionId } : {}),
          tokens: {
            input: (cur?.tokens.input ?? 0) + r.usage.inputTokens, output: (cur?.tokens.output ?? 0) + r.usage.outputTokens,
            cacheRead: (cur?.tokens.cacheRead ?? 0) + r.usage.cacheReadTokens, cacheWrite: (cur?.tokens.cacheWrite ?? 0) + r.usage.cacheWriteTokens,
          },
        });
        await (deps.recordUsage ?? ((x) => defaultRecordUsage(polpoDir, x)))({
          timestamp: now(), source: "agent_harness", provider: engine.harness, model: creds.model, sessionId: task.id,
          inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, cacheReadTokens: r.usage.cacheReadTokens,
          cacheWriteTokens: r.usage.cacheWriteTokens, totalTokens: r.usage.totalTokens, cost: r.costUsd ?? 0,
        }).catch(() => undefined);
        transcript({ type: "usage", harness: engine.harness, ...r.usage, ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}), costSource: c.source });
      };

      // ── the turns: the task, then queued follow-ups ──
      const first = ctx.continuation
        ? (wantResume ? ctx.continuation.message : `${buildPrompt(task, true)}\n\n[Human direction]\n${ctx.continuation.message}`)
        : buildPrompt(task, true);
      if (ctx.continuation) await handle.onDirectionApplied?.(ctx.continuation.directionIds);
      let prompt: string | undefined = first;
      let lastResult: HarnessTurnResult | undefined;
      let retriedAfterRotation = false;
      let failure: HarnessFailure | undefined;
      let retriedAfterUnavailable = false;
      let unreachableFor: number | undefined;
      /**
       * The computer stopped answering under the turn (its bridge's connection could not be
       * re-established, the provider's proxy cannot reach the VM): wait for it within
       * unavailableWaitMs, then re-attach and continue, once. false: not that kind of failure, or the
       * computer did not come back (the run fails, saying so).
       */
      const recoverFromUnavailable = async (why: string): Promise<boolean> => {
        if (retriedAfterUnavailable || abort.signal.aborted || !isTransientMachineError(why)) return false;
        retriedAfterUnavailable = true;
        transcript({ type: "log", message: `${name}: the computer ${opened!.computerId} stopped answering during the turn (${scrub(why).slice(0, 200)}); waiting for it (up to ${Math.round(unavailableWaitMs / 60_000)} min) before giving up` });
        const t0 = Date.now();
        const back = await waitForMachine(machine, {
          budgetMs: unavailableWaitMs, signal: abort.signal, sleep,
          onWait: (ms, w) => transcript({ type: "log", message: `${name}: the computer is not answering yet (${scrub(w).slice(0, 160)}); checking again in ${Math.round(ms / 1000)} s` }),
        });
        if (abort.signal.aborted) return false;
        if (!back) { unreachableFor = Date.now() - t0; return false; }
        transcript({ type: "log", message: `${name}: the computer answers again; re-attaching the session` });
        const s = session;
        session = undefined;
        parked = await s?.detach().catch(() => undefined);
        prompt = "Your previous turn was interrupted because the computer stopped answering for a while. Check the state of your work (commands you started may have been cut) and continue the task.";
        return true;
      };
      const unreachableNote = (why: string) => unreachableFor === undefined
        ? why
        : `${why} (the computer ${opened!.computerId} did not answer for ${Math.max(1, Math.round(unreachableFor / 60_000))} min after that)`;
      while (prompt !== undefined && !abort.signal.aborted) {
        const vmAtStart = opened.remoteId?.();
        try {
          lastResult = await runTurn(prompt);
          await account(lastResult);
          // an API error, a refused model, no model call: the run fails with the reason (not "done")
          const why = harnessTurnFailure({ ...turnOutcome, finishReason: lastResult.finishReason, totalTokens: lastResult.usage.totalTokens, text: lastResult.text }, name);
          if (why && !abort.signal.aborted) {
            if (await recoverFromUnavailable(why)) continue;
            if (abort.signal.aborted) break;
            failure = label(scrub(unreachableNote(why)));
            break;
          }
        } catch (err) {
          if (abort.signal.aborted) break;
          // the VM was replaced under the turn (a forced rotation, here or by the server process):
          // re-attach once (the bridge lives on in the memory snapshot) and continue
          let replaced = interrupted;
          if (!replaced && !retriedAfterRotation && vmAtStart && opened.remoteId) {
            // a command goes to the computer's current VM (reconnecting after a replacement)
            await machine.exec("true", {}).catch(() => undefined);
            const now = opened.remoteId();
            if (now && now !== vmAtStart) replaced = `VM ${vmAtStart} replaced by ${now}`;
          }
          if (replaced && !retriedAfterRotation) {
            retriedAfterRotation = true;
            transcript({ type: "log", message: `${name}: the computer was rotated during the turn (${replaced}); re-attaching` });
            interrupted = undefined;
            const s = session;
            session = undefined;
            parked = await s?.detach().catch(() => undefined);
            prompt = "Your previous turn was interrupted because the machine was moved to a new VM. Check the state of your work and continue the task.";
            continue;
          }
          const message = (err as Error)?.message ?? String(err);
          if (await recoverFromUnavailable(message)) continue;
          if (abort.signal.aborted) break;
          if (unreachableFor !== undefined && err instanceof Error) err.message = unreachableNote(err.message);
          throw err;
        }
        const next = followUps.shift();
        if (next?.directionId) await handle.onDirectionApplied?.([next.directionId]);
        prompt = next?.message;
      }

      alive = false;
      if (abort.signal.aborted) {
        return { exitCode: 1, stdout: scrub(lastText), stderr: "Killed", duration: Date.now() - start };
      }
      if (failure) {
        transcript({ type: "error", message: failure.message });
        const lastError = failure.message;
        await store.update(key, (cur) => (cur ? { ...cur, lastError } : null)).catch(() => undefined);
        return { exitCode: 1, stdout: scrub(lastText), stderr: failure.message, duration: Date.now() - start, ...(failure.retryable ? {} : { retryable: false }) };
      }
      return { exitCode: 0, stdout: scrub(lastText || lastResult?.text || ""), stderr: "", duration: Date.now() - start };
    } catch (err) {
      alive = false;
      const raw = scrub(err instanceof Error ? err.message : String(err));
      // the stream's own error events say why the runtime broke (a crash after an API error)
      const text = [...turnOutcome.errors.filter((e) => !raw.includes(e)), raw].join("\n");
      const labelled = (err as Error)?.name !== "HarnessCredentialError" ? label(text) : undefined;
      const msg = labelled && !labelled.retryable ? labelled.message : text;
      transcript({ type: "error", message: msg });
      await store.update(key, (cur) => (cur ? { ...cur, state: "error", lastError: msg, pid: undefined } : null)).catch(() => undefined);
      return { exitCode: 1, stdout: scrub(lastText), stderr: msg, duration: Date.now() - start, ...(labelled && !labelled.retryable ? { retryable: false } : {}) };
    } finally {
      unregister?.();
      // end of the run: the runtime stops (its bridge exits); the conversation stays resumable
      if (session) {
        const s = session;
        session = undefined;
        try {
          const state = await s.stop();
          await store.saveResumeState(key, state);
          await store.update(key, (cur) => (cur ? { ...cur, state: "stopped", resumable: true, pid: undefined } : null));
        } catch {
          await store.update(key, (cur) => (cur ? { ...cur, state: "stopped", pid: undefined } : null)).catch(() => undefined);
        }
      }
      // the run is over: Codex's refreshed ChatGPT sign-in goes back to the vault
      await writeBackCodexAuth("end of the run");
      // the run is over: its relay token stops working
      await lease?.revoke().catch(() => undefined);
      opened?.machine.close();
      for (const c of toolsetCleanup) await c().catch(() => undefined);
      await workspace?.dispose().catch(() => undefined);
    }
  })();

  return handle;
}
