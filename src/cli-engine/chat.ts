/**
 * Agent chats on the CLI engine: each chat turn runs the official program (Claude Code / Codex)
 * signed in with the agent's account, resuming the chat's own CLI conversation (one per chat
 * session, kept in the harness session record "cli:chat:<agent>:<session>"). Like a task run:
 *
 * - the account must be allowed: a personal sign-in answers only its owner's chats (the signed-in
 *   member chatting); never a channel's contacts;
 * - Polpo's tools (the agent's, as the harness builds them) are the turn's MCP server; in a chat a
 *   message to a person (email_send, whatsapp_send…) becomes a preview the person sends;
 * - the stream (text, reasoning, tool calls) goes into the chat as it happens; steers reach the
 *   program while it works; stop ends the turn (the conversation stays for the next one);
 * - tokens go to the usage store (cost 0, the plan pays), the session record keeps turns and tokens.
 */
import {
  CLI_NAMES, HOST_COMPUTER_ID, agentCliEngine, classifyCliError, cliAccountUseProblem, cliSettingsOf, instanceServesCustomers,
  isRemoteComputer, resolveCliAccount, type PolpoSettings, type VaultStore,
} from "@polpo-ai/core";
import type { EffectiveSandbox, ResolvedSandboxVolume } from "@polpo-ai/core/sandbox";
import type { AgentConfig } from "../core/types.js";
import type { SpawnContext } from "../core/adapter.js";
import { buildHarnessInstructions } from "../adapters/harness-engine.js";
import { cliHarnessId, cliRunHostTools, cliSessionKey, defaultOpenCliRemote, type OpenedCliMachine } from "../adapters/cli-engine.js";
import { SIDE_EFFECT_GATED_TOOLS } from "../harness/tool-policy.js";
import { harnessRelayPublicUrl } from "../harness/relay.js";
import { HarnessSessionStore, type HarnessSessionStatus } from "../harness/session-store.js";
import type { HarnessHostTool } from "../harness/types.js";
import type { CliLauncher } from "./process.js";
import { openCliConversation } from "./run.js";
import { polpoToolName } from "./tool-server.js";
import type { CliEvent } from "./types.js";

/** One chat turn's input and callbacks (the completions route's CliChatRunner contract). */
export interface CliChatTurnInput {
  sessionId: string | null;
  prompt: string;
  history?: string;
  isFirstTurn?: boolean;
  member?: string;
  origin?: unknown;
  signal: AbortSignal;
  onEvent: (e: { type: "text"; text: string } | { type: "reasoning"; text: string } | { type: "tool-call"; id: string; name: string; input: unknown } | { type: "tool-result"; id: string; name?: string; output: string; isError: boolean }) => void | Promise<void>;
  takeSteers: () => Promise<string[]>;
  preview: (toolName: string, input: Record<string, unknown>) => Promise<string>;
}

export interface CliChatRunnerDeps {
  polpoDir: string;
  /** The agent's working directory (as its chats on Polpo's engine). */
  workDir: () => string;
  settings: () => PolpoSettings | undefined;
  vaultStore?: () => VaultStore | undefined;
  /** The chat's sandbox (its computer), as Polpo's engine resolves it. */
  chatSandbox?: (agent: AgentConfig) => Promise<{ sandbox: EffectiveSandbox; volumes: ResolvedSandboxVolume[] }>;
  chatOutputDir?: (agent: string) => string;
  instanceAuth: () => boolean;
  /** Tests: fake CLIs, injected tools, a fake remote computer. */
  launch?: CliLauncher;
  hostTools?: (agent: AgentConfig) => Promise<{ tools: HarnessHostTool[]; connectorNote?: string; cleanup?: () => Promise<void> }>;
  openRemote?: (o: { agent: AgentConfig; cwd: string; ctx: SpawnContext }) => Promise<OpenedCliMachine>;
  publicUrl?: () => string | undefined;
  /** How often steers are looked for while the program works (ms). */
  steerPollMs?: number;
}

const CHAT_NOTE = [
  "## Chat",
  "You are in a conversation with a person in Polpo's chat: answer them, ask when something is unclear, and keep your messages readable.",
  "A message to a person outside this chat (an email, a WhatsApp message) is shown to them as a preview first: they send it from the chat.",
].join("\n");

/** A runner for the agent's chats, or undefined when the agent is not on the CLI engine. */
export function cliChatRunner(agent: AgentConfig, deps: CliChatRunnerDeps) {
  const engine = agentCliEngine(agent);
  if (!engine) return undefined;
  const store = () => new HarnessSessionStore(deps.polpoDir, deps.vaultStore?.());
  return {
    cli: engine.cli,
    async turn(i: CliChatTurnInput): Promise<{ text: string; model?: string; usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number } }> {
      const settings = deps.settings();
      const name = CLI_NAMES[engine.cli];
      // ── where: the chat's computer (as Polpo's engine), else this server ──
      const chat = deps.chatSandbox ? await deps.chatSandbox(agent).catch(() => undefined) : undefined;
      const computer = chat?.sandbox.computer && isRemoteComputer(chat.sandbox.computer) ? chat.sandbox.computer : undefined;
      const computerId = computer?.id ?? (agent.defaultComputer || HOST_COMPUTER_ID);
      const resolved = resolveCliAccount(engine, computerId, cliSettingsOf(settings));
      if ("problem" in resolved) throw new Error(resolved.problem);
      const account = resolved.account;
      // ── policy: a personal sign-in answers only its owner; never a channel's contacts ──
      const refusal = cliAccountUseProblem(account, {
        ...(i.member ? { initiator: i.member } : {}),
        origin: i.origin ? "channel-customer" : i.member ? "member" : "unknown",
        instanceAuth: deps.instanceAuth(),
        servesCustomers: instanceServesCustomers(settings as { notifications?: { channels?: Record<string, unknown> } }),
      }, cliSettingsOf(settings));
      if (refusal) throw new Error(refusal);

      const cwd = deps.workDir();
      const key = cliSessionKey({ scope: "chat", agent: agent.name, chatSessionId: i.sessionId ?? "default" });
      const s = store();
      const prior = s.get(key);
      const resume = prior?.runtimeSessionId && prior.cli === engine.cli && prior.account === account.id ? prior.runtimeSessionId : undefined;
      const now = () => new Date().toISOString();
      const status = (patch: Partial<HarnessSessionStatus>) => s.update(key, (cur) => ({
        key, agent: agent.name, harness: cliHarnessId(engine.cli), engine: "cli", cli: engine.cli, account: account.id, computerId, scope: "chat",
        ...(i.sessionId ? { chatSessionId: i.sessionId } : {}),
        state: "starting", resumable: false, turns: 0, costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, createdAt: now(), updatedAt: now(),
        ...(cur ?? {}), ...patch,
      } as HarnessSessionStatus)).catch(() => undefined);

      const ctx: SpawnContext = {
        polpoDir: deps.polpoDir,
        ...(deps.vaultStore?.() ? { vaultStore: deps.vaultStore!() } : {}),
        ...(deps.chatOutputDir ? { outputDir: deps.chatOutputDir(agent.name) } : {}),
        ...(chat && computer ? { sandbox: chat.sandbox, volumes: chat.volumes } : {}),
      } as SpawnContext;
      let opened: OpenedCliMachine | undefined;
      let cleanup: (() => Promise<void>) | undefined;
      let conv: Awaited<ReturnType<typeof openCliConversation>> | undefined;
      let poll: ReturnType<typeof setInterval> | undefined;
      const unwatch = () => i.signal.removeEventListener("abort", onAbort);
      const onAbort = () => { void conv?.session.interrupt(); };
      i.signal.addEventListener("abort", onAbort, { once: true });
      try {
        if (computerId !== HOST_COMPUTER_ID && !deps.launch) {
          opened = await (deps.openRemote ?? ((x) => defaultOpenCliRemote({ ...x, scope: "chat", ...(i.sessionId ? { sessionKey: i.sessionId } : {}) })))({ agent, cwd, ctx });
        }
        const host = deps.hostTools
          ? await deps.hostTools(agent)
          : await cliRunHostTools({ agent, cwd, ctx, workspace: opened?.workspace, interactive: true, log: () => {} });
        cleanup = host.cleanup;
        await status({ state: "starting", pid: process.pid, ...(opened?.remoteId?.() ? { remoteId: opened.remoteId!() } : {}), lastError: undefined });
        conv = await openCliConversation({
          agent, engine, account, computerId, cwd, polpoDir: deps.polpoDir, ...(opened ? { machine: opened.machine } : {}),
          instructions: (toolNames) => `${buildHarnessInstructions({
            agent, cwd, outputDir: ctx.outputDir, connectorNote: toolNames.length ? host.connectorNote : undefined, hostTools: toolNames,
            harness: engine.cli === "claude" ? "claude-code" : "codex",
          })}\n\n${CHAT_NOTE}`,
          ...(resume ? { resume } : {}),
          tools: host.tools,
          // a message to a person: a preview in the chat (the person sends it), never sent from here
          approve: async (call) => {
            if (!SIDE_EFFECT_GATED_TOOLS.has(call.toolName)) return { approved: false, reason: "this chat cannot ask a person for it" };
            const reply = await i.preview(call.toolName, (call.input ?? {}) as Record<string, unknown>);
            return { approved: false, message: reply };
          },
          publicUrl: (deps.publicUrl ?? harnessRelayPublicUrl)(),
          ...(deps.launch ? { launch: deps.launch } : {}),
          inbox: `/tmp/polpo-cli-inbox-chat-${(i.sessionId ?? "default").replace(/[^A-Za-z0-9_-]/g, "")}.jsonl`,
          log: () => {},
          maxTurns: agent.maxTurns,
        });
        await status({ state: "running", ...(resume ? { lastResumeAt: now() } : { bootstrappedAt: now() }) });
        if (i.signal.aborted) throw new Error("Stopped");
        // steers while it works: to the program at once
        poll = setInterval(() => {
          void i.takeSteers().then((texts) => { for (const t of texts) void conv?.session.steer(t); }).catch(() => undefined);
        }, deps.steerPollMs ?? 400);
        poll.unref?.();
        const release = opened?.hold?.();
        const prompt = !resume && i.history ? `Our conversation so far (for context):\n\n${i.history}\n\n---\n\n${i.prompt}` : i.prompt;
        const onEvent = (e: CliEvent) => {
          if (e.type === "text") void i.onEvent({ type: "text", text: e.text });
          else if (e.type === "reasoning") void i.onEvent({ type: "reasoning", text: e.text });
          else if (e.type === "tool-call") void i.onEvent({ type: "tool-call", id: e.id, name: polpoToolName(e.name) ?? e.name, input: e.input ?? {} });
          else if (e.type === "tool-result") void i.onEvent({ type: "tool-result", id: e.id, ...(e.name ? { name: polpoToolName(e.name) ?? e.name } : {}), output: typeof e.output === "string" ? e.output : JSON.stringify(e.output), isError: e.isError });
          else if (e.type === "session") void status({ runtimeSessionId: e.sessionId, sessionId: e.sessionId });
        };
        let end;
        try {
          end = await conv.session.turn(prompt, onEvent);
        } finally {
          release?.();
        }
        const cur = s.get(key);
        await status({
          state: "stopped", pid: undefined, turns: (cur?.turns ?? 0) + 1, resumable: !!conv.session.sessionId,
          ...(conv.session.sessionId ? { runtimeSessionId: conv.session.sessionId, sessionId: conv.session.sessionId } : {}),
          tokens: {
            input: (cur?.tokens.input ?? 0) + end.usage.inputTokens, output: (cur?.tokens.output ?? 0) + end.usage.outputTokens,
            cacheRead: (cur?.tokens.cacheRead ?? 0) + end.usage.cacheReadTokens, cacheWrite: (cur?.tokens.cacheWrite ?? 0) + end.usage.cacheWriteTokens,
          },
        });
        if (!end.ok && !i.signal.aborted) {
          const c = classifyCliError(engine.cli, [end.error, conv.proc.stderrTail()].filter(Boolean).join("\n"), account);
          throw new Error(c.message);
        }
        return { text: end.text, ...(conv.session.model ? { model: conv.session.model } : {}), usage: end.usage };
      } catch (err) {
        const raw = [err instanceof Error ? err.message : String(err), conv?.proc.stderrTail() ?? ""].filter(Boolean).join("\n");
        const message = i.signal.aborted ? "Stopped" : classifyCliError(engine.cli, raw, account).message;
        await status({ state: i.signal.aborted ? "stopped" : "error", pid: undefined, ...(i.signal.aborted ? {} : { lastError: message }) });
        throw new Error(`${name}: ${message}`);
      } finally {
        if (poll) clearInterval(poll);
        unwatch();
        await conv?.close().catch(() => undefined);
        opened?.machine.close();
        await cleanup?.().catch(() => undefined);
        await opened?.dispose?.().catch(() => undefined);
      }
    },
  };
}
