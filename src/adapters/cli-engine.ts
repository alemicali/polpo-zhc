/**
 * CLI engine: an agent whose engine is { type: "cli" } runs its tasks through the official,
 * unmodified Claude Code or Codex program on its computer, signed in with a person's own account
 * (settings.harnesses.cli.accounts: a config directory, never a token). Same AgentHandle contract
 * as Polpo's engine and the harness engine, and the same features as the harness engine:
 *
 * - before anything runs, the account must be allowed for this work (cliAccountUseProblem: a
 *   personal sign-in runs only what its owner started; never channel customers or ownerless work);
 * - the agent's Polpo tools (the harness engine's host tools: connectors, outcomes, artifacts,
 *   memory, data, messages, the task's tool scope) are served to the program as the run's MCP
 *   server (src/cli-engine/tool-server.ts), on this server's loopback or through the relay route
 *   for a remote computer, with a per-run token;
 * - the program runs in the task's working directory: on this server as a child process
 *   (stdin/stdout), on a remote computer (Daytona v2, E2B) through the provider's process API
 *   with its stdin streamed;
 * - its stream becomes the run transcript and activity; tokens go to the usage store with cost 0
 *   and costSource "subscription" (the plan pays; the CLI's own estimate is shown, not billed);
 * - its session is a harness session record (status, turns, tokens): the harness sessions view,
 *   stop and reset work on it (polpo_harness_sessions_list / polpo_harness_session_control);
 * - kill and the task timeout stop the program with everything it started (process groups);
 * - "not signed in" and "usage limit reached" fail the run without retries, saying what to do;
 * - a continuation of the task resumes the CLI's conversation (Claude --resume, Codex thread/resume).
 */
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  CLI_NAMES, DEPENDENCY_RESULTS_TOOL, HOST_COMPUTER_ID, agentCliEngine, classifyCliError, cliAccountUseProblem, cliSettingsOf, instanceServesCustomers,
  isRemoteComputer, resolveCliAccount, type AgentCliEngine, type CliAccount, type CliUseContext, type PolpoSettings,
} from "@polpo-ai/core";
import type { AgentConfig, Task, TaskResult } from "../core/types.js";
import type { AgentHandle, SpawnContext } from "../core/adapter.js";
import { loadPolpoConfig } from "../core/config.js";
import { buildAgentToolset, buildPrompt, collectOutcome, createActivity } from "./engine.js";
import { buildHarnessInstructions, fileOfToolCall } from "./harness-engine.js";
import type { CliLauncher } from "../cli-engine/process.js";
import { openCliConversation, type CliConversation } from "../cli-engine/run.js";
import { polpoToolName } from "../cli-engine/tool-server.js";
import { addUsage, ZERO_USAGE, type CliEvent, type CliTurnEnd, type CliUsage } from "../cli-engine/types.js";
import { toHarnessHostTools } from "../harness/host-tools.js";
import { liveHarnessSessions } from "../harness/live-sessions.js";
import { harnessRelayPublicUrl } from "../harness/relay.js";
import { HarnessSessionStore, type HarnessSessionStatus } from "../harness/session-store.js";
import type { HarnessHostTool } from "../harness/types.js";
import type { TokenUsageRecord } from "@polpo-ai/core/token-usage";
import type { HarnessMachine } from "../harness/sandbox-session.js";

export interface CliEngineDeps {
  settings?: () => PolpoSettings | undefined;
  /** Starts the program (tests inject fake CLIs; default: this server or the remote computer). */
  launch?: CliLauncher;
  recordUsage?: (r: TokenUsageRecord) => Promise<void>;
  /** The instance has member sign-in (default: POLPO_AUTH_ENABLED). */
  instanceAuth?: () => boolean;
  /** A remote computer's machine (tests inject one). */
  openRemote?: (o: { agent: AgentConfig; cwd: string; ctx: SpawnContext }) => Promise<OpenedCliMachine>;
  /** The agent's Polpo tools (default: buildAgentToolset, as the harness engine). */
  hostTools?: (o: { agent: AgentConfig; task: Task; cwd: string; ctx: SpawnContext; onOutcome: (toolName: string, details: Record<string, unknown>) => void }) => Promise<{ tools: HarnessHostTool[]; connectorNote?: string; remoteRoots?: string[]; cleanup?: () => Promise<void> }>;
  /** Polpo's public URL, for remote computers to reach the run's tools (default: POLPO_PUBLIC_URL). */
  publicUrl?: () => string | undefined;
  store?: HarnessSessionStore;
}

export interface OpenedCliMachine {
  machine: HarnessMachine;
  /** The computer is in use (a turn) until the returned function runs. */
  hold?: () => () => void;
  remoteId?: () => string | undefined;
  /** Files and commands of the remote workspace, for Polpo's tools. */
  workspace?: import("@polpo-ai/core/sandbox").Workspace;
  dispose?: () => Promise<void>;
}

/** The CLI session key of a task (harness-sessions.json; "cli:" so it never meets a harness session). */
export function cliSessionKey(o: { scope: "task"; taskId: string } | { scope: "chat"; agent: string; chatSessionId: string }): string {
  return o.scope === "task" ? `cli:task:${o.taskId}` : `cli:chat:${o.agent}:${o.chatSessionId}`;
}

function instanceAuthEnabled(): boolean {
  const v = process.env.POLPO_AUTH_ENABLED;
  return v === "1" || v?.toLowerCase() === "true";
}

/** Where the work comes from, for the policy guard. */
export function cliUseContext(task: Pick<Task, "requestedBy">, settings: PolpoSettings | undefined, instanceAuth: boolean): CliUseContext {
  return {
    ...(task.requestedBy ? { initiator: task.requestedBy } : {}),
    origin: task.requestedBy ? "member" : "unknown",
    instanceAuth,
    servesCustomers: instanceServesCustomers(settings as { notifications?: { channels?: Record<string, unknown> } }),
  };
}

function stringify(v: unknown, max = 2000): string {
  if (typeof v === "string") return v.slice(0, max);
  try { return JSON.stringify(v).slice(0, max); } catch { return String(v).slice(0, max); }
}

/** The harness id a CLI's session is listed under (the same program). */
export function cliHarnessId(cli: AgentCliEngine["cli"]): HarnessSessionStatus["harness"] {
  return cli === "claude" ? "claude-code" : "codex";
}

/** The agent's remote computer as a machine for the CLI (Daytona v2 and E2B: processes with input). */
export async function defaultOpenCliRemote(o: { agent: AgentConfig; cwd: string; ctx: SpawnContext; scope?: "task" | "chat"; sessionKey?: string }): Promise<OpenedCliMachine> {
  const computer = o.ctx.sandbox?.computer;
  if (!computer || !isRemoteComputer(computer)) throw new Error("No remote computer for this run");
  const { createWorkspace } = await import("../sandbox/manager.js");
  const { RemoteWorkspace } = await import("../sandbox/remote.js");
  const { remoteHarnessMachine } = await import("../harness/sandbox-session.js");
  const polpoDir = o.ctx.polpoDir!;
  const ws = createWorkspace(o.ctx.sandbox!, {
    root: o.cwd, writable: o.ctx.outputDir ? [o.ctx.outputDir] : [], readable: [join(polpoDir, "skills")], volumes: o.ctx.volumes ?? [], hide: [polpoDir],
    onRemoteEvent: (e) => o.ctx.onSandboxEvent?.(e),
    pool: { polpoDir, owner: o.agent.name, scope: o.scope ?? "task", ...(o.ctx.runId ? { runId: o.ctx.runId } : {}), ...(o.sessionKey ? { sessionKey: o.sessionKey } : {}) },
    onNetworkDenied: o.ctx.onNetworkDenied,
  });
  if (!(ws instanceof RemoteWorkspace)) throw new Error(`Computer "${computer.id}" is not reachable from this server`);
  const driver = await ws.driver();
  if (!driver.spawn) {
    await ws.dispose().catch(() => undefined);
    throw new Error(`Computer "${computer.id}" (${computer.kind}) has no process API here: the CLI engine needs a Daytona v2 or E2B computer`);
  }
  await driver.exec(`mkdir -p '${o.cwd.replace(/'/g, `'\\''`)}'`, {});
  return {
    machine: remoteHarnessMachine({ driver: () => ws.driver(), workDir: o.cwd, label: computer.id }),
    hold: () => driver.hold?.() ?? (() => {}),
    remoteId: () => ws.remoteId,
    workspace: ws,
    dispose: () => ws.dispose(),
  };
}

/** The agent's Polpo tools for a run, exactly as the harness engine builds them. */
export async function cliRunHostTools(o: {
  agent: AgentConfig; task?: Task; cwd: string; ctx: SpawnContext; workspace?: import("@polpo-ai/core/sandbox").Workspace; interactive: boolean;
  log: (line: string) => void; onOutcome?: (toolName: string, details: Record<string, unknown>) => void;
  /** A chat: its session, recorded on what send_notification sends. */
  notifyOrigin?: { sessionId?: string };
}): Promise<{ tools: HarnessHostTool[]; connectorNote?: string; remoteRoots?: string[]; cleanup: () => Promise<void> }> {
  const { WorkspaceShell, isRemoteWorkspace } = await import("../sandbox/manager.js");
  const { WorkspaceFileSystem } = await import("../sandbox/workspace-fs.js");
  const remote = isRemoteWorkspace(o.workspace);
  const polpoDir = o.ctx.polpoDir!;
  const outputDir = o.ctx.outputDir;
  const toolset = await buildAgentToolset({
    agentConfig: o.agent, cwd: o.cwd, ctx: o.ctx, effectiveAllowedPaths: remote ? undefined : [o.cwd, ...(outputDir ? [outputDir] : [])], outputDir,
    ...(remote ? { remoteFs: new WorkspaceFileSystem(o.workspace!), shell: new WorkspaceShell(o.workspace!) } : {}),
    sandboxProvider: o.workspace?.provider ?? "local",
    browserProfileDir: join(polpoDir, "browser-profiles", o.agent.browserProfile || o.agent.name),
    hasExtendedTools: (o.agent.allowedTools ?? []).some((t) => /^(browser|email|image|video|audio|excel|pdf|docx|search|whatsapp|phone)_/i.test(t)),
    log: o.log,
    ...(o.task ? { task: o.task } : {}),
    ...(o.notifyOrigin ? { notifyOrigin: o.notifyOrigin } : {}),
    harnessHost: true,
  });
  // as the harness: of the task result tools only task_result (dependencies' results are in the prompt)
  const tools = toHarnessHostTools(toolset.tools.filter((t) => t.name !== DEPENDENCY_RESULTS_TOOL), {
    interactive: o.interactive,
    onResult: (r) => { if (!r.isError && r.details) o.onOutcome?.(r.toolName, r.details); },
  });
  return {
    tools,
    ...(toolset.connectorNote ? { connectorNote: toolset.connectorNote } : {}),
    ...(toolset.remoteRoots ? { remoteRoots: toolset.remoteRoots } : {}),
    cleanup: async () => {
      await toolset.connectorManager?.closeAll().catch(() => undefined);
      await toolset.browserNetwork?.close().catch(() => undefined);
    },
  };
}

/** Spawn a task run on the agent's CLI (same contract as spawnEngine). */
export function spawnCliEngine(agentConfig: AgentConfig, task: Task, cwd: string, ctx: SpawnContext, deps: CliEngineDeps = {}): AgentHandle {
  const activity = createActivity();
  const start = Date.now();
  const polpoDir = ctx.polpoDir;
  if (!polpoDir) throw new Error("spawnCliEngine: ctx.polpoDir is required");
  const store = deps.store ?? new HarnessSessionStore(polpoDir, ctx.vaultStore);
  const key = cliSessionKey({ scope: "task", taskId: task.id });
  let alive = true;
  let killed = false;
  let conv: CliConversation | undefined;
  let turnRunning = false;
  const followUps: Array<{ message: string; directionId?: string }> = [];
  let wake: ((why: "killed") => void) | undefined;
  /** Set when the computer's VM went away under the run (hibernation, rotation, reset). */
  let vmGone: string | undefined;

  const handle: AgentHandle = {
    agentName: agentConfig.name,
    taskId: task.id,
    startedAt: new Date().toISOString(),
    pid: 0,
    activity,
    done: null as unknown as Promise<TaskResult>,
    isAlive: () => alive,
    kill: () => {
      killed = true;
      alive = false;
      void conv?.proc.kill();
      wake?.("killed");
    },
    steer: (message, directionId) => {
      if (conv && turnRunning) {
        void conv.session.steer(message).then(
          (sent) => { if (sent) { if (directionId) void handle.onDirectionApplied?.([directionId]); } else followUps.push({ message, directionId }); },
          () => followUps.push({ message, directionId }),
        );
      } else followUps.push({ message, directionId });
    },
    followUp: (message, directionId) => { followUps.push({ message, directionId }); },
  };

  const transcript = (entry: Record<string, unknown>) => {
    activity.lastUpdate = new Date().toISOString();
    try { handle.onTranscript?.(entry); } catch { /* the log never breaks the run */ }
  };

  handle.done = (async (): Promise<TaskResult> => {
    let engine: AgentCliEngine | undefined;
    let account: CliAccount | undefined;
    let lastText = "";
    const errors: string[] = [];
    let opened: OpenedCliMachine | undefined;
    let unregister: (() => void) | undefined;
    let cleanupTools: (() => Promise<void>) | undefined;
    let failure: string | undefined;
    const now = () => new Date().toISOString();
    const status = (patch: Partial<HarnessSessionStatus>) => store.update(key, (cur) => ({
      key, agent: agentConfig.name, harness: cliHarnessId(engine!.cli), engine: "cli", cli: engine!.cli, account: account!.id,
      computerId: account!.computer, scope: "task", taskId: task.id,
      state: "starting", resumable: false, turns: 0, costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, createdAt: now(), updatedAt: now(),
      ...(cur ?? {}),
      ...patch,
    } as HarnessSessionStatus)).catch(() => undefined);
    try {
      const settings = deps.settings ? deps.settings() : loadPolpoConfig(polpoDir)?.settings;
      engine = agentCliEngine(agentConfig);
      if (!engine) throw new Error(`Agent "${agentConfig.name}" has no CLI engine`);
      const name = CLI_NAMES[engine.cli];
      const computerId = ctx.sandbox?.computer?.id ?? (agentConfig.defaultComputer || HOST_COMPUTER_ID);
      const resolved = resolveCliAccount(engine, computerId, cliSettingsOf(settings));
      if ("problem" in resolved) return fail(resolved.problem, false);
      account = resolved.account;
      // ── policy: a personal sign-in runs only its owner's work ──
      const refusal = cliAccountUseProblem(account, cliUseContext(task, settings, (deps.instanceAuth ?? instanceAuthEnabled)()), cliSettingsOf(settings));
      if (refusal) return fail(refusal, false);

      activity.runContext = { ...(engine.model ? { model: engine.model } : {}), cost: { tokens: 0, costSource: "subscription" } };
      transcript({ type: "log", message: `${name}: account "${account.id}"${account.label ? ` (${account.label})` : ""} on ${account.computer}` });

      // ── the conversation to continue, if any ──
      const prior = store.get(key);
      const resume = ctx.continuation && prior?.runtimeSessionId && prior.cli === engine.cli && prior.account === account.id ? prior.runtimeSessionId : undefined;
      if (!ctx.continuation && prior) await store.update(key, () => null).catch(() => undefined);

      // ── where it runs ──
      const remote = computerId !== HOST_COMPUTER_ID && !deps.launch;
      if (remote) {
        opened = await (deps.openRemote ?? ((x) => defaultOpenCliRemote(x)))({ agent: agentConfig, cwd, ctx });
        const vm = opened.remoteId?.();
        if (vm) activity.runContext = { ...activity.runContext, remoteId: vm };
      }

      // ── Polpo's tools (run here, with the agent's permissions) ──
      const onOutcome = (toolName: string, details: Record<string, unknown>) => {
        const outcome = collectOutcome(toolName, details);
        if (outcome) (handle.outcomes ??= []).push(outcome);
      };
      const host = await (deps.hostTools
        ? deps.hostTools({ agent: agentConfig, task, cwd, ctx, onOutcome })
        : cliRunHostTools({ agent: agentConfig, task, cwd, ctx, workspace: opened?.workspace, interactive: false, log: (line) => transcript({ type: "log", message: line }), onOutcome }));
      cleanupTools = host.cleanup;

      const agentsMd = opened
        ? await opened.machine.readFile(join(cwd, "AGENTS.md")).then((b) => (b ? Buffer.from(b).toString("utf8") : undefined), () => undefined)
        : await readFile(join(cwd, "AGENTS.md"), "utf8").catch(() => undefined);
      await status({ state: "starting", pid: process.pid, computerId, ...(opened?.remoteId?.() ? { remoteId: opened.remoteId!() } : {}), lastError: undefined });
      if (killed) return killedResult();
      const t0 = Date.now();
      conv = await openCliConversation({
        agent: agentConfig, engine, account, computerId, cwd, polpoDir, ...(opened ? { machine: opened.machine } : {}),
        instructions: (toolNames) => {
          const text = buildHarnessInstructions({
            agent: agentConfig, cwd, outputDir: ctx.outputDir, agentsMd, connectorNote: toolNames.length ? host.connectorNote : undefined, hostTools: toolNames,
            harness: engine!.cli === "claude" ? "claude-code" : "codex", ...(host.remoteRoots ? { remoteRoots: host.remoteRoots } : {}),
          });
          // without Polpo's tools there is no register_outcome to name
          return toolNames.includes("register_outcome") ? text : text.replace(", and register each one with the register_outcome tool.", ".");
        },
        ...(resume ? { resume } : {}),
        tools: host.tools,
        onToolCall: (e) => { if (e.phase === "start") transcript({ type: "log", message: `Polpo tool ${e.toolName} called by ${name}` }); },
        publicUrl: (deps.publicUrl ?? harnessRelayPublicUrl)(),
        ...(deps.launch ? { launch: deps.launch } : {}),
        inbox: `/tmp/polpo-cli-inbox-${task.id}.jsonl`,
        log: (line) => transcript({ type: "log", message: line }),
        maxTurns: agentConfig.maxTurns,
      });
      const bootstrapMs = Date.now() - t0;
      if (conv.toolNames.length) transcript({ type: "log", message: `${name}: Polpo's tools available (${conv.toolNames.length}) through the run's MCP server` });
      transcript({ type: "log", message: `${name} ${resume ? "resumed its conversation" : "started"} on ${computerId}` });
      activity.runContext = { ...activity.runContext, session: { resumed: !!resume, bootstrapMs } };
      await status({ state: "idle", ...(resume ? { lastResumeAt: now() } : { bootstrappedAt: now(), bootstrapMs }) });

      // ── stop / reset from the harness sessions view: the program stops ──
      unregister = liveHarnessSessions.register({
        key, agent: agentConfig.name, computerId,
        suspend: async (_mode, reason) => {
          if (reason === "stop" || reason === "reset") {
            // a person stopped it from the sessions view: the run ends as killed
            transcript({ type: "log", message: `${name} stopped (${reason})` });
            handle.kill();
            return;
          }
          // the computer's VM goes away (hibernation, rotation, reset): the program cannot follow
          // it; the run fails retryable (its retry or continuation starts the program again there)
          vmGone = reason;
          transcript({ type: "log", message: `${name}: the computer's machine is going away (${reason}); the run stops and can be retried` });
          await conv?.proc.kill().catch(() => undefined);
        },
      });

      const onEvent = (e: CliEvent) => {
        switch (e.type) {
          case "session":
            activity.sessionId = e.sessionId;
            handle.sessionId = e.sessionId;
            activity.runContext = { ...activity.runContext, ...(e.model ? { model: e.model } : {}), session: { ...activity.runContext?.session, resumed: !!resume, sessionId: e.sessionId } };
            void status({ runtimeSessionId: e.sessionId, sessionId: e.sessionId });
            break;
          case "text":
            lastText = e.text;
            activity.summary = e.text.slice(0, 200);
            transcript({ type: "assistant", text: e.text });
            break;
          case "reasoning":
            transcript({ type: "reasoning", text: e.text.slice(0, 4000) });
            break;
          case "tool-call": {
            activity.toolCalls++;
            const polpo = polpoToolName(e.name);
            const tool = polpo ?? e.name;
            activity.lastTool = tool;
            const file = fileOfToolCall(tool, e.input);
            if (file) {
              activity.lastFile = file.path;
              const list = file.created ? activity.filesCreated : activity.filesEdited;
              if (!list.includes(file.path)) list.push(file.path);
            }
            transcript({ type: "tool_use", tool, toolId: e.id, input: e.input ?? {}, ...(polpo ? { host: true } : {}) });
            break;
          }
          case "tool-result":
            transcript({ type: "tool_result", toolId: e.id, ...(e.name ? { tool: polpoToolName(e.name) ?? e.name } : {}), content: stringify(e.output), isError: e.isError });
            break;
          case "error":
            errors.push(e.message);
            transcript({ type: "error", message: e.message });
            break;
          default:
            break;
        }
      };

      let usage: CliUsage = { ...ZERO_USAGE };
      let estimate = 0;
      const acc = account;
      const record = async (end: CliTurnEnd) => {
        usage = addUsage(usage, end.usage);
        estimate += end.estimateUsd ?? 0;
        activity.totalTokens = usage.totalTokens;
        activity.runContext = { ...activity.runContext, cost: { tokens: usage.totalTokens, costSource: "subscription" } };
        transcript({ type: "usage", harness: `${engine!.cli}-cli`, ...end.usage, costSource: "subscription", ...(end.estimateUsd !== undefined ? { estimateUsd: end.estimateUsd } : {}) });
        const cur = store.get(key);
        await status({
          state: "idle", turns: (cur?.turns ?? 0) + 1, resumable: !!conv?.session.sessionId,
          ...(conv?.session.sessionId ? { runtimeSessionId: conv.session.sessionId, sessionId: conv.session.sessionId } : {}),
          tokens: {
            input: (cur?.tokens.input ?? 0) + end.usage.inputTokens, output: (cur?.tokens.output ?? 0) + end.usage.outputTokens,
            cacheRead: (cur?.tokens.cacheRead ?? 0) + end.usage.cacheReadTokens, cacheWrite: (cur?.tokens.cacheWrite ?? 0) + end.usage.cacheWriteTokens,
          },
        });
        await (deps.recordUsage ?? (async (r) => {
          const { databaseStoresFor } = await import("../core/storage.js");
          const { FileTokenUsageStore } = await import("../stores/file-token-usage-store.js");
          await (databaseStoresFor(polpoDir)?.tokenUsageStore ?? new FileTokenUsageStore(polpoDir)).record(r);
        }))({
          timestamp: now(), source: "agent_harness", provider: `${engine!.cli}-cli`, model: conv?.session.model ?? engine!.model ?? engine!.cli,
          sessionId: task.id, inputTokens: end.usage.inputTokens, outputTokens: end.usage.outputTokens, cacheReadTokens: end.usage.cacheReadTokens,
          cacheWriteTokens: end.usage.cacheWriteTokens, totalTokens: end.usage.totalTokens, cost: 0,
        }).catch(() => undefined);
        void acc;
      };

      // ── the turns: the task, then queued follow-ups ──
      const first = ctx.continuation
        ? (resume ? ctx.continuation.message : `${buildPrompt(task, true)}\n\n[Human direction]\n${ctx.continuation.message}`)
        : buildPrompt(task, true);
      if (ctx.continuation) await handle.onDirectionApplied?.(ctx.continuation.directionIds);
      let prompt: string | undefined = first;
      let last: CliTurnEnd | undefined;
      while (prompt !== undefined && !killed) {
        turnRunning = true;
        const release = opened?.hold?.();
        await status({ state: "running" });
        const killedWait = new Promise<"killed">((r) => { wake = r; });
        const turn = conv.session.turn(prompt, onEvent);
        turn.catch(() => undefined); // a kill ends the race first
        const r = await Promise.race([turn, killedWait]).finally(() => { turnRunning = false; wake = undefined; release?.(); });
        if (r === "killed") break;
        last = r;
        await record(r);
        if (!r.ok) {
          const c = classifyCliError(engine.cli, [r.error, ...errors, conv.proc.stderrTail()].filter(Boolean).join("\n"), account);
          return fail(c.message, c.retryable);
        }
        const next = followUps.shift();
        if (next?.directionId) await handle.onDirectionApplied?.([next.directionId]);
        prompt = next?.message;
      }
      if (killed) return killedResult();
      alive = false;
      return { exitCode: 0, stdout: lastText || last?.text || "", stderr: "", duration: Date.now() - start };
    } catch (err) {
      if (killed) return killedResult();
      if (vmGone) return fail(`The computer's machine went away during the run (${vmGone}): run the task again (a continuation resumes the CLI's conversation)`, true);
      const raw = [err instanceof Error ? err.message : String(err), ...errors, conv?.proc.stderrTail() ?? ""].filter(Boolean).join("\n");
      const c = engine ? classifyCliError(engine.cli, raw, account) : { message: raw, retryable: true };
      return fail(c.message, c.retryable);
    } finally {
      alive = false;
      unregister?.();
      await conv?.close().catch(() => undefined);
      if (engine && account && store.get(key)) {
        const lastError = failure;
        await store.update(key, (cur) => (cur ? { ...cur, state: lastError ? "error" : "stopped", ...(lastError ? { lastError } : {}), pid: undefined } : null)).catch(() => undefined);
      }
      opened?.machine.close();
      await cleanupTools?.().catch(() => undefined);
      await opened?.dispose?.().catch(() => undefined);
    }

    function fail(message: string, retryable: boolean): TaskResult {
      alive = false;
      transcript({ type: "error", message });
      failure = message;
      return { exitCode: 1, stdout: lastText, stderr: message, duration: Date.now() - start, ...(retryable ? {} : { retryable: false }) };
    }
    function killedResult(): TaskResult {
      alive = false;
      return { exitCode: 1, stdout: lastText, stderr: "Killed", duration: Date.now() - start };
    }
  })();

  return handle;
}
