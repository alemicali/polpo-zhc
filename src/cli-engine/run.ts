/**
 * One conversation with a CLI program for a run (a task run, or a chat turn): Polpo's tools as the
 * run's MCP server, the program started on its computer with the account's config directory, and
 * the protocol session (Claude stream-json, Codex app-server) new or resumed. Shared by the task
 * adapter (src/adapters/cli-engine.ts) and agent chats (src/cli-engine/chat.ts).
 */
import { CLI_BINARIES, type AgentCliEngine, type CliAccount } from "@polpo-ai/core";
import type { AgentConfig } from "../core/types.js";
import type { HarnessMachine } from "../harness/sandbox-session.js";
import type { HarnessHostTool } from "../harness/types.js";
import { claudeCodeToolSearch } from "../harness/tool-search.js";
import { remoteAccountPrefix } from "./accounts.js";
import { claudeArgs, claudeSession } from "./claude.js";
import { codexArgs, codexSession } from "./codex.js";
import { cliHostEnv, hostCliProcess, remoteCliProcess, type CliLauncher, type CliProcess } from "./process.js";
import { CLI_TOOL_TOKEN_ENV, openCliToolServer, type CliToolApproval, type CliToolCallEvent, type CliToolServer } from "./tool-server.js";
import type { CliSession } from "./types.js";

export interface CliConversationOptions {
  agent: AgentConfig;
  engine: AgentCliEngine;
  account: CliAccount;
  /** "host" or the computer id. */
  computerId: string;
  cwd: string;
  polpoDir: string;
  /** The remote computer's machine (undefined: this server). */
  machine?: HarnessMachine;
  /** The instructions, given the Polpo tools the program can call. */
  instructions: (toolNames: string[]) => string;
  /** The CLI's conversation to continue (Claude session id, Codex thread id). */
  resume?: string;
  /** Polpo's tools (host tools), served to the program over MCP. */
  tools?: readonly HarnessHostTool[];
  approve?: CliToolApproval;
  onToolCall?: (e: CliToolCallEvent) => void;
  /** POLPO_PUBLIC_URL: how a remote computer reaches the run's tool server. */
  publicUrl?: string;
  /** Starts the program (tests inject fake CLIs). */
  launch?: CliLauncher;
  /** The remote inbox file, for providers without process input. */
  inbox: string;
  log: (line: string) => void;
  maxTurns?: number;
  /** More environment for the program (documented CLI settings only, e.g. MCP_TOOL_TIMEOUT). */
  env?: Record<string, string>;
  /** Codex asks a person before leaving its sandbox (coding chats): see CodexSessionOptions.onApproval. */
  codexApproval?: (method: string, params: Record<string, unknown>) => Promise<"accept" | "decline">;
}

export interface CliConversation {
  session: CliSession;
  proc: CliProcess;
  /** Polpo's tool server for this conversation (absent: no tools, or unreachable). */
  toolServer?: CliToolServer;
  /** The Polpo tools the program can call. */
  toolNames: string[];
  /** End the conversation: the program exits, the tool server's token is revoked. */
  close(): Promise<void>;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function openCliConversation(o: CliConversationOptions): Promise<CliConversation> {
  const { engine, account } = o;
  const remote = !!o.machine;
  // ── Polpo's tools: this server's loopback, or the relay route for a remote computer ──
  let toolServer: CliToolServer | undefined;
  let toolsUrl: string | undefined;
  if (o.tools?.length) {
    if (!remote) {
      toolServer = await openCliToolServer({ tools: o.tools, loopback: true, ...(o.approve ? { approve: o.approve } : {}), ...(o.onToolCall ? { onCall: o.onToolCall } : {}) });
      toolsUrl = toolServer.localUrl;
    } else if (o.publicUrl) {
      toolServer = await openCliToolServer({
        tools: o.tools, relay: { polpoDir: o.polpoDir, publicUrl: o.publicUrl }, ...(o.approve ? { approve: o.approve } : {}), ...(o.onToolCall ? { onCall: o.onToolCall } : {}),
      });
      toolsUrl = toolServer.publicUrl;
    } else {
      o.log(`Polpo's tools are not available to the CLI on computer "${o.computerId}": POLPO_PUBLIC_URL is not set, so the computer cannot reach this instance (set it and expose <public URL>/api/v1/harness-relay/)`);
    }
  }
  const toolNames = toolServer ? toolServer.toolNames : [];
  const instructions = o.instructions(toolNames);
  try {
    const args = engine.cli === "claude"
      ? claudeArgs({
        resume: o.resume, model: engine.model, permissionMode: engine.permissionMode, instructions, maxTurns: o.maxTurns, extra: engine.args,
        ...(toolServer && toolsUrl ? { mcpConfig: toolServer.claudeMcpConfig(toolsUrl) } : {}),
        ...(engine.effort ? { effort: engine.effort } : {}),
        ...(engine.maxBudgetUsd ? { maxBudgetUsd: engine.maxBudgetUsd } : {}),
      })
      : codexArgs(engine.args, { ...(toolServer && toolsUrl ? { config: toolServer.codexConfigArgs(toolsUrl) } : {}), ...(engine.effort ? { effort: engine.effort } : {}) });
    // what the program needs besides the account: the tools' token (Codex reads it from the
    // environment), Claude Code's tool search as the harness sets it
    const extraEnv: Record<string, string> = {
      ...(toolServer && engine.cli === "codex" ? { [CLI_TOOL_TOKEN_ENV]: toolServer.token } : {}),
      ...(engine.cli === "claude" ? { ENABLE_TOOL_SEARCH: claudeCodeToolSearch(toolNames.length) } : {}),
      ...(o.env ?? {}),
    };
    const launch: CliLauncher = o.launch ?? (async (l) => {
      if (o.machine) {
        const cmd = `${remoteAccountPrefix(account)}exec ${CLI_BINARIES[l.cli]} ${l.args.map(q).join(" ")}`;
        return remoteCliProcess(o.machine, cmd, { cwd: l.cwd, env: extraEnv, inbox: o.inbox });
      }
      return hostCliProcess(CLI_BINARIES[l.cli], l.args, { cwd: l.cwd, env: l.env });
    });
    const proc = await launch({ cli: engine.cli, args, cwd: o.cwd, env: { ...cliHostEnv(engine.cli, account), ...extraEnv } });
    let session: CliSession;
    try {
      session = engine.cli === "claude"
        ? claudeSession(proc)
        : await codexSession(proc, { cwd: o.cwd, model: engine.model, permissionMode: engine.permissionMode, instructions, ...(o.resume ? { resumeThreadId: o.resume } : {}), ...(o.codexApproval ? { onApproval: o.codexApproval } : {}) });
    } catch (err) {
      await proc.kill().catch(() => undefined);
      throw err;
    }
    let closed = false;
    return {
      session, proc, toolNames, ...(toolServer ? { toolServer } : {}),
      close: async () => {
        if (closed) return;
        closed = true;
        await session.close().catch(() => proc.kill().catch(() => undefined));
        await toolServer?.close().catch(() => undefined);
      },
    };
  } catch (err) {
    await toolServer?.close().catch(() => undefined);
    throw err;
  }
}
