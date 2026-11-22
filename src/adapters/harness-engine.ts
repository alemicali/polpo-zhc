/**
 * Harness engine: an agent whose `engine` is an official agent harness (Claude Code, Codex) runs
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
 */
import { join } from "node:path";
import {
  agentEngineProblem, agentHarness, buildAgentSystemPrompt, DEPENDENCY_RESULTS_TOOL, HARNESS_NAMES, harnessesSettingsOf, isRemoteComputer,
  type AgentHarnessEngine, type PolpoSettings,
} from "@polpo-ai/core";
import { daytonaApiVersion } from "@polpo-ai/core/sandbox";
import type { AgentConfig, Task, TaskResult } from "../core/types.js";
import type { AgentHandle, SpawnContext } from "../core/adapter.js";
import { loadPolpoConfig } from "../core/config.js";
import { createWorkspace, isRemoteWorkspace, WorkspaceShell } from "../sandbox/manager.js";
import { RemoteWorkspace } from "../sandbox/remote.js";
import { WorkspaceFileSystem } from "../sandbox/workspace-fs.js";
import { loadAgentSkills } from "../llm/skills.js";
import { buildAgentToolset, buildPrompt, collectOutcome, createActivity } from "./engine.js";
import { brokeredHarnessAuth, resolveHarnessAuth, scrubSecrets, type HarnessBrokering, type ResolvedHarnessAuth } from "../harness/credentials.js";
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
  const home = join(polpoDir, "harness", slug(o.agent.name), "home");
  return { machine: hostHarnessMachine({ workDir: o.cwd, home, label: "host" }), computerId: "host", home };
}

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
  }
  if (o.connectorNote) parts.push("", o.connectorNote);
  if (o.agentsMd && o.harness === "claude-code") parts.push("", "## Repository instructions (AGENTS.md)", o.agentsMd.slice(0, 40_000));
  return parts.join("\n");
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
  const scrub = (t: string) => scrubSecrets(t, secrets);

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

  handle.done = (async (): Promise<TaskResult> => {
    let workspace: import("@polpo-ai/core/sandbox").Workspace | undefined;
    let opened: OpenedMachine | undefined;
    let unregister: (() => void) | undefined;
    let lease: HarnessRelayLease | undefined;
    let toolsetCleanup: Array<() => Promise<unknown>> = [];
    let lastText = "";
    try {
      const settings = deps.settings ? deps.settings() : loadPolpoConfig(polpoDir)?.settings;
      const engine = agentHarness(agentConfig);
      if (!engine) throw new Error(`Agent "${agentConfig.name}" has no harness engine`);
      const daytonaApi = daytonaApiVersion((settings?.sandbox as any)?.providers?.daytona) as "v0" | "v2";
      const problem = agentEngineProblem(agentConfig, settings as any, { daytonaApi });
      if (problem) throw new Error(problem);
      const name = HARNESS_NAMES[engine.harness];

      // ── where it runs, and the agent's Polpo tools (run here) ──
      const outputDir = ctx.outputDir;
      const remoteRun = ctx.sandbox?.provider === "daytona" || ctx.sandbox?.provider === "e2b";
      workspace = ctx.sandbox && !deps.openMachine
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
      const shell = workspace ? new WorkspaceShell(workspace) : undefined;
      const remoteFs = isRemoteWorkspace(workspace) ? new WorkspaceFileSystem(workspace!) : undefined;
      opened = await (deps.openMachine ?? defaultOpenMachine)({ agent: agentConfig, cwd, ctx, settings, workspace });
      const machine = opened.machine;

      const toolset = await buildAgentToolset({
        agentConfig, cwd, ctx, effectiveAllowedPaths: remoteRun ? undefined : [cwd, ...(outputDir ? [outputDir] : [])], outputDir, remoteFs, shell,
        sandboxProvider: workspace?.provider ?? "local",
        browserProfileDir: join(polpoDir, "browser-profiles", agentConfig.browserProfile || agentConfig.name),
        hasExtendedTools: (agentConfig.allowedTools ?? []).some((t) => /^(browser|email|image|video|audio|excel|pdf|docx|search|whatsapp|phone)_/i.test(t)),
        log: (line) => transcript({ type: "log", message: line }),
        task,
      });
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
      const auth: ResolvedHarnessAuth = brokeredHarnessAuth(resolved, brokering, lease?.baseUrl);
      const broker: HarnessCredentialBroker | undefined = brokering === "none" ? undefined : {
        ...(lease ? { lease } : {}),
        ...(resolved.route?.scheme ? { scheme: resolved.route.scheme } : {}),
        // native: Polpo's gateway headers are rules too (the relay lease holds its own)
        ...(brokering === "native" && resolved.route && Object.keys(resolved.route.headers).length
          ? { rules: [{ match: { host: new URL(resolved.route.upstream).hostname }, transform: { headers: { ...resolved.route.headers } } }] }
          : {}),
      };
      if (resolved.route) transcript({ type: "log", message: `${name}: model credential ${brokering === "none" ? "in the computer (not brokered)" : brokering === "relay" ? "brokered by Polpo's model relay (placeholders only in the computer)" : "brokered by the computer's provider (placeholders only in the computer)"}` });
      // where and with what this run executes (the task's run context; no secrets)
      activity.runContext = {
        ...(auth.model ? { model: auth.model } : {}),
        ...(opened.remoteId?.() ? { remoteId: opened.remoteId!() } : {}),
      };

      // ── the machine: pnpm for the bootstrap, credential files ──
      const pnpm = await machine.exec(ENSURE_PNPM, {});
      if (pnpm.exitCode !== 0) throw new Error(`${name} needs pnpm ${HARNESS_PNPM_VERSION} in the computer (corepack could not activate it): ${scrub(pnpm.stderr || pnpm.stdout).slice(0, 300)}`);
      if (auth.files.length) {
        const homeDir = opened.home ?? (await machine.exec("printf %s \"$HOME\"", {})).stdout.trim();
        for (const f of auth.files) {
          const path = `${homeDir}/.config/polpo-harness/${f.name}`;
          await machine.writeFile(path, new TextEncoder().encode(f.content));
          await machine.exec(`chmod 600 '${path}'`, {});
          auth.env[f.envVar] = path;
        }
      }

      // ── skills and instructions ──
      const skills: HarnessSkill[] = loadAgentSkills(cwd, polpoDir, agentConfig.name, agentConfig.skills)
        .map((s) => ({ name: slug(s.name), description: (s.description || s.name).slice(0, 1000), content: s.content }));
      const agentsMd = await machine.readFile(join(cwd, "AGENTS.md")).then((b) => (b ? Buffer.from(b).toString("utf8") : undefined), () => undefined);
      const instructions = buildHarnessInstructions({
        agent: agentConfig, cwd, outputDir, agentsMd, connectorNote: toolset.connectorNote, hostTools: hostTools.map((t) => t.name), harness: engine.harness,
      });

      const runtime = await (deps.runtimeFactory ?? defaultRuntimeFactory)({
        harness: engine.harness,
        id: agentConfig.name,
        model: auth.model,
        instructions,
        tools: hostTools,
        skills,
        permissionMode: engine.permissionMode ?? "allow-all",
        ...(engine.effort ? { effort: engine.effort } : {}),
        ...(engine.maxBudgetUsd ? { maxBudgetUsd: engine.maxBudgetUsd } : {}),
        maxTurns: agentConfig.maxTurns ?? 150,
        auth,
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
      const port = resumeFrom && prior?.bridgePort
        ? prior.bridgePort
        : opened.computerId === "host" ? await freeHostPort() : await freeMachinePort(machine);
      const sandbox: HarnessSandbox = createHarnessSandboxSession(machine, { port, ...(broker ? { broker } : {}) });
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
      session = await open(resumeFrom, wantResume ? prior!.sessionId : undefined);
      activity.sessionId = session.sessionId;
      resumeFrom = undefined;
      let parked: HarnessResumeState | undefined;

      // ── hibernation: park before the VM goes, re-attach on the next turn ──
      unregister = liveHarnessSessions.register({
        key, agent: agentConfig.name, computerId: opened.computerId,
        suspend: async (mode: HarnessSuspendMode, reason: string) => {
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
        }
      };

      const onEvent = (e: HarnessEvent) => {
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
      const turnCost = (r: HarnessTurnResult): { usd?: number; source: "gateway" | "runtime" | "runtime-estimate" | "tokens-only" } => {
        const gateway = lease ? lease.costUsd - leaseCostSeen : 0;
        if (lease) leaseCostSeen = lease.costUsd;
        if (gateway > 0) return { usd: gateway, source: "gateway" };
        if (auth.nonClaude || (resolved.route && resolved.route.mode !== "direct" && engine.harness === "codex")) return { source: "tokens-only" };
        if (r.costUsd === undefined) return { source: "tokens-only" };
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
          timestamp: now(), source: "agent_harness", provider: engine.harness, model: auth.model, sessionId: task.id,
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
      while (prompt !== undefined && !abort.signal.aborted) {
        const vmAtStart = opened.remoteId?.();
        try {
          lastResult = await runTurn(prompt);
          await account(lastResult);
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
      const failed = lastResult && /error|length|budget/i.test(lastResult.finishReason) && lastResult.finishReason !== "stop";
      if (failed) {
        const message = `${name} ended the turn with "${lastResult!.finishReason}"`;
        transcript({ type: "error", message });
        return { exitCode: 1, stdout: scrub(lastText), stderr: message, duration: Date.now() - start };
      }
      return { exitCode: 0, stdout: scrub(lastText || lastResult?.text || ""), stderr: "", duration: Date.now() - start };
    } catch (err) {
      alive = false;
      const msg = scrub(err instanceof Error ? err.message : String(err));
      transcript({ type: "error", message: msg });
      await store.update(key, (cur) => (cur ? { ...cur, state: "error", lastError: msg, pid: undefined } : null)).catch(() => undefined);
      return { exitCode: 1, stdout: scrub(lastText), stderr: msg, duration: Date.now() - start };
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
      // the run is over: its relay token stops working
      await lease?.revoke().catch(() => undefined);
      opened?.machine.close();
      for (const c of toolsetCleanup) await c().catch(() => undefined);
      await workspace?.dispose().catch(() => undefined);
    }
  })();

  return handle;
}
