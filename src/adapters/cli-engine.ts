/**
 * CLI engine: an agent whose engine is { type: "cli" } runs its tasks through the official,
 * unmodified Claude Code or Codex program on its computer, signed in with a person's own account
 * (settings.harnesses.cli.accounts: a config directory, never a token). Same AgentHandle contract
 * as Polpo's engine and the harness engine:
 *
 * - before anything runs, the account must be allowed for this work (cliAccountUseProblem: a
 *   personal sign-in runs only what its owner started; never channel customers or schedules);
 * - the program runs in the task's working directory: on this server as a child process
 *   (stdin/stdout), on a remote computer (Daytona v2) through its process API and an inbox file;
 * - its stream becomes the run transcript and activity; tokens go to the usage store with cost 0
 *   and costSource "subscription" (the plan pays; the CLI's own estimate is shown, not billed);
 * - kill and the task timeout stop the program with everything it started (process groups);
 * - "not signed in" and "usage limit reached" fail the run without retries, saying what to do;
 * - a continuation of the task resumes the CLI's conversation (Claude --resume, Codex thread/resume).
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_BINARIES, CLI_NAMES, HOST_COMPUTER_ID, agentCliEngine, classifyCliError, cliAccountUseProblem, cliSettingsOf, instanceServesCustomers,
  isRemoteComputer, resolveCliAccount, type AgentCliEngine, type CliAccount, type CliUseContext, type PolpoSettings,
} from "@polpo-ai/core";
import type { AgentConfig, Task, TaskResult } from "../core/types.js";
import type { AgentHandle, SpawnContext } from "../core/adapter.js";
import { loadPolpoConfig } from "../core/config.js";
import { buildPrompt, createActivity } from "./engine.js";
import { buildHarnessInstructions, fileOfToolCall } from "./harness-engine.js";
import { claudeArgs, claudeSession } from "../cli-engine/claude.js";
import { codexArgs, codexSession } from "../cli-engine/codex.js";
import { cliHostEnv, hostCliProcess, remoteCliProcess, type CliLauncher, type CliProcess } from "../cli-engine/process.js";
import { remoteAccountPrefix } from "../cli-engine/accounts.js";
import { addUsage, ZERO_USAGE, type CliEvent, type CliSession, type CliTurnEnd, type CliUsage } from "../cli-engine/types.js";
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
  openRemote?: (o: { agent: AgentConfig; cwd: string; ctx: SpawnContext }) => Promise<HarnessMachine>;
}

/** The CLI's conversation per task, for continuations (no secrets: ids only). */
interface CliSessionRecord { sessionId: string; cli: string; account: string; updatedAt: string }

async function loadSessions(polpoDir: string): Promise<Record<string, CliSessionRecord>> {
  try { return JSON.parse(await readFile(join(polpoDir, "cli-sessions.json"), "utf8")) as Record<string, CliSessionRecord>; } catch { return {}; }
}
async function saveSession(polpoDir: string, key: string, rec: CliSessionRecord | null): Promise<void> {
  const all = await loadSessions(polpoDir);
  if (rec) all[key] = rec; else delete all[key];
  await mkdir(polpoDir, { recursive: true });
  await writeFile(join(polpoDir, "cli-sessions.json"), JSON.stringify(all, null, 2));
}

function instanceAuthEnabled(): boolean {
  const v = process.env.POLPO_AUTH_ENABLED;
  return v === "1" || v?.toLowerCase() === "true";
}

/** Where the work comes from, for the policy guard. */
export function cliUseContext(task: Task, settings: PolpoSettings | undefined, instanceAuth: boolean): CliUseContext {
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

async function defaultOpenRemote(o: { agent: AgentConfig; cwd: string; ctx: SpawnContext }): Promise<HarnessMachine> {
  const computer = o.ctx.sandbox?.computer;
  if (!computer || !isRemoteComputer(computer)) throw new Error("No remote computer for this run");
  if (computer.kind !== "daytona") throw new Error(`The CLI engine does not run on ${computer.kind} computers yet (computer "${computer.id}"): use a Daytona v2 computer or this server`);
  const { createWorkspace } = await import("../sandbox/manager.js");
  const { RemoteWorkspace } = await import("../sandbox/remote.js");
  const { remoteHarnessMachine } = await import("../harness/sandbox-session.js");
  const ws = createWorkspace(o.ctx.sandbox!, {
    root: o.cwd, writable: o.ctx.outputDir ? [o.ctx.outputDir] : [], readable: [], volumes: o.ctx.volumes ?? [], hide: o.ctx.polpoDir ? [o.ctx.polpoDir] : [],
    pool: { polpoDir: o.ctx.polpoDir!, owner: o.agent.name, scope: "task", runId: o.ctx.runId },
  });
  if (!(ws instanceof RemoteWorkspace)) throw new Error(`Computer "${computer.id}" is not reachable from this server`);
  const driver = await ws.driver();
  if (!driver.spawn) throw new Error(`Computer "${computer.id}" runs on Daytona v0: the CLI engine needs Daytona v2 (long-running processes)`);
  await driver.exec(`mkdir -p '${o.cwd.replace(/'/g, `'\\''`)}'`, {});
  return remoteHarnessMachine({ driver: () => ws.driver(), workDir: o.cwd, label: computer.id });
}

/** Spawn a task run on the agent's CLI (same contract as spawnEngine). */
export function spawnCliEngine(agentConfig: AgentConfig, task: Task, cwd: string, ctx: SpawnContext, deps: CliEngineDeps = {}): AgentHandle {
  const activity = createActivity();
  const start = Date.now();
  const polpoDir = ctx.polpoDir;
  if (!polpoDir) throw new Error("spawnCliEngine: ctx.polpoDir is required");
  let alive = true;
  let killed = false;
  let session: CliSession | undefined;
  let proc: CliProcess | undefined;
  let turnRunning = false;
  const followUps: Array<{ message: string; directionId?: string }> = [];
  let wake: (() => void) | undefined;

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
      void proc?.kill();
      wake?.();
    },
    steer: (message, directionId) => {
      if (session && turnRunning) {
        void session.steer(message).then(
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
    let machine: HarnessMachine | undefined;
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
      const key = `task:${task.id}`;
      const prior = (await loadSessions(polpoDir))[key];
      const resume = ctx.continuation && prior && prior.cli === engine.cli && prior.account === account.id ? prior.sessionId : undefined;
      if (!ctx.continuation && prior) await saveSession(polpoDir, key, null).catch(() => undefined);

      // ── the program ──
      const remote = computerId !== HOST_COMPUTER_ID && !deps.launch;
      if (remote) machine = await (deps.openRemote ?? defaultOpenRemote)({ agent: agentConfig, cwd, ctx });
      const agentsMd = await readFile(join(cwd, "AGENTS.md"), "utf8").catch(() => undefined);
      const instructions = buildHarnessInstructions({
        agent: agentConfig, cwd, outputDir: ctx.outputDir, agentsMd: remote ? undefined : agentsMd, hostTools: [],
        harness: engine.cli === "claude" ? "claude-code" : "codex",
        // Polpo's tools are not offered to the CLI (yet): its instructions do not name them
      }).replace(", and register each one with the register_outcome tool.", ".");
      const args = engine.cli === "claude"
        ? claudeArgs({ resume, model: engine.model, permissionMode: engine.permissionMode, instructions, maxTurns: agentConfig.maxTurns, extra: engine.args })
        : codexArgs(engine.args);
      const launch: CliLauncher = deps.launch ?? (async (o) => {
        if (machine) {
          const cmd = `${remoteAccountPrefix(account!)}exec ${CLI_BINARIES[o.cli]} ${o.args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ")}`;
          return remoteCliProcess(machine, cmd, { cwd: o.cwd, env: {}, inbox: `/tmp/polpo-cli-inbox-${task.id}.jsonl` });
        }
        return hostCliProcess(CLI_BINARIES[o.cli], o.args, { cwd: o.cwd, env: o.env });
      });
      if (killed) return killedResult();
      proc = await launch({ cli: engine.cli, args, cwd, env: cliHostEnv(engine.cli, account) });
      session = engine.cli === "claude"
        ? claudeSession(proc)
        : await codexSession(proc, { cwd, model: engine.model, permissionMode: engine.permissionMode, instructions, ...(resume ? { resumeThreadId: resume } : {}) });
      transcript({ type: "log", message: `${name} ${resume ? "resumed its conversation" : "started"} on ${computerId}` });

      const onEvent = (e: CliEvent) => {
        switch (e.type) {
          case "session":
            activity.sessionId = e.sessionId;
            handle.sessionId = e.sessionId;
            activity.runContext = { ...activity.runContext, ...(e.model ? { model: e.model } : {}), session: { resumed: !!resume, sessionId: e.sessionId } };
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
            activity.lastTool = e.name;
            const file = fileOfToolCall(e.name, e.input);
            if (file) {
              activity.lastFile = file.path;
              const list = file.created ? activity.filesCreated : activity.filesEdited;
              if (!list.includes(file.path)) list.push(file.path);
            }
            transcript({ type: "tool_use", tool: e.name, toolId: e.id, input: e.input ?? {} });
            break;
          }
          case "tool-result":
            transcript({ type: "tool_result", toolId: e.id, ...(e.name ? { tool: e.name } : {}), content: stringify(e.output), isError: e.isError });
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
      const account_ = account;
      const record = async (end: CliTurnEnd) => {
        usage = addUsage(usage, end.usage);
        estimate += end.estimateUsd ?? 0;
        activity.totalTokens = usage.totalTokens;
        activity.runContext = { ...activity.runContext, cost: { tokens: usage.totalTokens, costSource: "subscription" } };
        transcript({ type: "usage", harness: `${engine!.cli}-cli`, ...end.usage, costSource: "subscription", ...(end.estimateUsd !== undefined ? { estimateUsd: end.estimateUsd } : {}) });
        await (deps.recordUsage ?? (async (r) => {
          const { databaseStoresFor } = await import("../core/storage.js");
          const { FileTokenUsageStore } = await import("../stores/file-token-usage-store.js");
          await (databaseStoresFor(polpoDir)?.tokenUsageStore ?? new FileTokenUsageStore(polpoDir)).record(r);
        }))({
          timestamp: new Date().toISOString(), source: "agent_harness", provider: `${engine!.cli}-cli`, model: session?.model ?? engine!.model ?? engine!.cli,
          sessionId: task.id, inputTokens: end.usage.inputTokens, outputTokens: end.usage.outputTokens, cacheReadTokens: end.usage.cacheReadTokens,
          cacheWriteTokens: end.usage.cacheWriteTokens, totalTokens: end.usage.totalTokens, cost: 0,
        }).catch(() => undefined);
        if (session?.sessionId) {
          await saveSession(polpoDir, key, { sessionId: session.sessionId, cli: engine!.cli, account: account_.id, updatedAt: new Date().toISOString() }).catch(() => undefined);
        }
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
        const killedWait = new Promise<"killed">((r) => { wake = () => r("killed"); });
        const turn = session.turn(prompt, onEvent);
        turn.catch(() => undefined); // a kill ends the race first
        const r = await Promise.race([turn, killedWait]).finally(() => { turnRunning = false; wake = undefined; });
        if (r === "killed") break;
        last = r;
        await record(r);
        if (!r.ok) {
          const c = classifyCliError(engine.cli, [r.error, ...errors, proc.stderrTail()].filter(Boolean).join("\n"), account);
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
      const raw = [err instanceof Error ? err.message : String(err), ...errors, proc?.stderrTail() ?? ""].filter(Boolean).join("\n");
      const c = engine ? classifyCliError(engine.cli, raw, account) : { message: raw, retryable: true };
      return fail(c.message, c.retryable);
    } finally {
      alive = false;
      if (session) await session.close().catch(() => undefined);
      else if (proc) await proc.kill().catch(() => undefined);
      machine?.close();
    }

    function fail(message: string, retryable: boolean): TaskResult {
      alive = false;
      transcript({ type: "error", message });
      return { exitCode: 1, stdout: lastText, stderr: message, duration: Date.now() - start, ...(retryable ? {} : { retryable: false }) };
    }
    function killedResult(): TaskResult {
      alive = false;
      return { exitCode: 1, stdout: lastText, stderr: "Killed", duration: Date.now() - start };
    }
  })();

  return handle;
}
