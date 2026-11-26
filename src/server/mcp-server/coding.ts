/**
 * Coding chats through MCP: Claude Code / Codex sessions in a worktree of the Coding app, run with
 * the person's own CLI account (the official program, never a token here) and kept as a chat.
 *
 * - polpo_coding_chats_list (read): sessions, filtered by worktree or kind.
 * - polpo_coding_chat_get (read): a transcript as text (the card's text).
 * - polpo_coding_chat_start (work): a new session in a worktree, optionally with its first message.
 * - polpo_coding_chat_send (work): a message (a new turn, or a steer while one runs); wait: true
 *   waits for the turn (or an approval) and returns the reply.
 * - polpo_coding_chat_control (work): stop the turn, approve or deny a risky action.
 * - polpo_coding_chat_show (read, an MCP App): the transcript as a card (text for other clients),
 *   with approve / deny for actions waiting.
 *
 * Risky actions (network installs, other network access, git push, files outside the worktree,
 * sudo / docker / kill, unknown tools) wait for the session's owner: only they approve.
 */
import { z } from "zod";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildCodingCard, codingCardText, type CodingCard, type CodingSessionShape } from "../mcp-coding-card.js";
import { CODING_CARD_HTML } from "../mcp-widgets.generated.js";
import { cardAppearance } from "./card-appearance.js";
import {
  MAX_WAIT_SECONDS, READ, UPDATE, WRITE, allowed, apiError, apiGet, apiSend, dashboardLink, enc, fail, looseObject, ok, qs, sleep, unwrap,
  type McpDeps, type McpPrincipal, type Register, type ToolScope, type ToolsetName,
} from "./kit.js";

export const CODING_CARD_URI = "ui://polpo/coding-card.html";
let seq = 0;
const key = () => ({ createdAt: Date.now(), seq: ++seq });

type Summary = {
  id: string; kind: string; title: string; cwd: string; branch?: string; status: string; owner?: string; model?: string; turns: number;
  messageCount: number; pendingApprovals: number; preview?: string; lastError?: string; updatedAt: string;
};

const summaryLine = (s: Summary) => `- ${s.id} · ${s.title} (${s.kind === "claude" ? "Claude Code" : "Codex"}) · ${s.status}${s.pendingApprovals ? ` · ${s.pendingApprovals} approval(s) waiting` : ""}`
  + ` · ${s.branch ? `${s.branch} · ` : ""}${s.cwd}${s.owner ? ` · ${s.owner}` : ""}${s.preview ? ` · “${s.preview.slice(0, 80)}”` : ""}${s.lastError ? ` · error: ${s.lastError.slice(0, 160)}` : ""}`;

const summaryItem = z.object({
  id: z.string(), kind: z.string(), title: z.string(), cwd: z.string(), status: z.string(), turns: z.number(), messageCount: z.number(), pendingApprovals: z.number(),
}).passthrough();

export async function loadCodingCard(deps: McpDeps, args: { id: string; limit?: number }): Promise<{ ok: true; card: CodingCard } | { ok: false; error: string }> {
  const r = unwrap(await deps.api("GET", `/api/v1/coding/chats/${enc(args.id)}`));
  if (!r.ok) return { ok: false, error: r.status === 404 ? `There is no coding chat "${args.id}" (polpo_coding_chats_list).` : r.error };
  const card = buildCodingCard({ session: r.data as CodingSessionShape, key: key(), limit: args.limit, link: dashboardLink(deps, `/coding?chat=${enc(args.id)}`) });
  const appearance = await cardAppearance(deps);
  return { ok: true, card: appearance ? { ...card, appearance } : card };
}

/** Wait until the session's turn ends or needs a person (bounded). */
async function waitTurn(deps: McpDeps, id: string, seconds: number, signal?: AbortSignal): Promise<CodingSessionShape | undefined> {
  const until = Date.now() + seconds * 1000;
  let last: CodingSessionShape | undefined;
  for (;;) {
    const r = await apiGet(deps, `/coding/chats/${enc(id)}`);
    if (!r.ok) return last;
    last = r.data as CodingSessionShape;
    if (last.status !== "running" || Date.now() >= until || signal?.aborted) return last;
    await sleep(deps.pollIntervalMs ?? 1000, signal);
  }
}

const waitParams = {
  wait: z.boolean().optional().describe("Wait for the turn to end (or to need an approval) and return the reply; default false"),
  timeout_seconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).optional().describe(`How long to wait at most (default and max ${MAX_WAIT_SECONDS}); then follow with polpo_coding_chat_show`),
};

function replyOf(s: CodingSessionShape): string {
  const card = buildCodingCard({ session: s, key: key(), limit: 4 });
  return codingCardText(card);
}

export function registerCodingTools(tool: Register, deps: McpDeps): void {
  tool("coding", "polpo_coding_chats_list", {
    title: "Coding chats",
    description: "Claude Code and Codex sessions of the Coding app (each in a git worktree, run with its owner's own CLI account): status (idle, running, awaiting-approval, error), "
      + "approvals waiting, the last thing said. Filter by worktree (cwd) or kind.",
    inputSchema: {
      cwd: z.string().optional().describe("Only sessions in this worktree"),
      kind: z.enum(["claude", "codex"]).optional().describe("Only Claude Code (claude) or Codex (codex) sessions"),
    },
    outputSchema: { sessions: z.array(summaryItem) },
    annotations: READ,
  }, async ({ cwd, kind }) => {
    const r = await apiGet(deps, `/coding/chats${qs({ cwd, kind })}`);
    if (!r.ok) return apiError(r, "Listing coding chats");
    const sessions = r.data as Summary[];
    return ok(sessions.length ? sessions.map(summaryLine).join("\n") : "No coding chats.", { sessions });
  });

  tool("coding", "polpo_coding_chat_get", {
    title: "Read a coding chat",
    description: "A coding chat's transcript: the person's messages, the program's replies, each tool call in one line (edits with +/− lines, commands), "
      + "approvals waiting with their ids, status, model and tokens. polpo_coding_chat_show draws the same as a card.",
    inputSchema: {
      id: z.string().min(1).describe("The session id (cc_…)"),
      limit: z.number().int().min(1).max(50).optional().describe("Latest messages (default 12)"),
    },
    outputSchema: { session: looseObject, messages: z.array(looseObject), approvals: z.array(looseObject) },
    annotations: READ,
  }, async ({ id, limit }) => {
    const r = await loadCodingCard(deps, { id, ...(limit ? { limit } : {}) });
    if (!r.ok) return fail(r.error);
    return ok(codingCardText(r.card), { session: r.card.session as unknown as Record<string, unknown>, messages: r.card.messages as unknown as Record<string, unknown>[], approvals: r.card.approvals as unknown as Record<string, unknown>[] });
  });

  tool("coding", "polpo_coding_chat_start", {
    title: "Start a coding chat",
    description: "Open a Claude Code (kind claude) or Codex (kind codex) session in a git worktree (cwd: the worktree's path, inside the agent workspace or an allowed root) "
      + "on the person's own CLI account, optionally with its first message (prompt). The program edits files and runs commands in the worktree on its own; risky actions "
      + "(package installs and other network access, git push, files outside the worktree) wait for the person's approval (polpo_coding_chat_control). Without a signed-in "
      + "account the session says how to sign in (Settings → Harnesses → CLI accounts). Follow with polpo_coding_chat_show.",
    inputSchema: {
      kind: z.enum(["claude", "codex"]).describe("claude: Claude Code; codex: Codex"),
      cwd: z.string().min(1).describe("The worktree (absolute path, e.g. from the Coding app or git worktree list)"),
      prompt: z.string().max(100_000).optional().describe("The first message: the turn starts at once"),
      title: z.string().max(120).optional().describe("A name for the session (default: the program's)"),
      branch: z.string().max(300).optional().describe("The worktree's branch, shown with the session"),
      model: z.string().max(200).optional().describe("A model id or alias of that CLI (default: the CLI's)"),
      from_terminal: z.object({ id: z.string().min(1), label: z.string().optional() }).optional()
        .describe("Open as chat: the Coding app's terminal session this chat continues (its id and label; the terminal stays open)"),
      resume_session_id: z.string().max(200).optional()
        .describe("The program's conversation to resume (Claude Code: the terminal session's id). If the person's CLI account cannot read it, a new conversation starts and the chat says so"),
      ...waitParams,
    },
    outputSchema: { session: looseObject },
    annotations: { ...WRITE, openWorldHint: true },
  }, async (args, extra) => {
    const { wait, timeout_seconds, from_terminal, resume_session_id, ...rest } = args;
    const body = { ...rest, ...(from_terminal ? { fromTerminal: from_terminal } : {}), ...(resume_session_id ? { resumeSessionId: resume_session_id } : {}) };
    const r = await apiSend(deps, "POST", "/coding/chats", body);
    if (!r.ok) return apiError(r, "Starting the coding chat");
    let s = r.data as CodingSessionShape;
    if (s.status === "error" && s.lastError) {
      return ok(`Coding chat ${s.id} created, but it cannot run: ${s.lastError}`, { session: s });
    }
    if (wait && args.prompt) s = (await waitTurn(deps, s.id, timeout_seconds ?? MAX_WAIT_SECONDS, extra?.signal)) ?? s;
    return ok(`Coding chat ${s.id} started (${s.kind === "claude" ? "Claude Code" : "Codex"} in ${s.cwd}).\n${replyOf(s)}`, { session: s });
  });

  tool("coding", "polpo_coding_chat_send", {
    title: "Send to a coding chat",
    description: "Send a message to a coding chat: it starts a turn (the program resumes the session's conversation), or reaches the running turn at once. "
      + "With wait: true it waits for the reply (or for an approval the person must give) and returns it. Only the session's owner can send.",
    inputSchema: {
      id: z.string().min(1).describe("The session id (cc_…, from polpo_coding_chats_list or polpo_coding_chat_start)"),
      text: z.string().min(1).max(100_000).describe("What to ask or tell the program"),
      ...waitParams,
    },
    outputSchema: { steered: z.boolean(), session: looseObject },
    annotations: { ...WRITE, openWorldHint: true },
  }, async ({ id, text, wait, timeout_seconds }, extra) => {
    const r = await apiSend(deps, "POST", `/coding/chats/${enc(id)}/messages`, { text });
    if (!r.ok) return apiError(r, `Sending to coding chat ${id}`);
    const d = r.data as { steered: boolean; session: CodingSessionShape };
    const s = wait ? (await waitTurn(deps, id, timeout_seconds ?? MAX_WAIT_SECONDS, extra?.signal)) ?? d.session : d.session;
    return ok(`${d.steered ? "Sent to the running turn." : "Turn started."}\n${replyOf(s)}`, { steered: d.steered, session: s });
  });

  tool("coding", "polpo_coding_chat_control", {
    title: "Stop a coding chat, or answer an approval",
    description: "stop: end the running turn (the conversation stays). approve / deny: answer a risky action waiting for the person (approval_id from polpo_coding_chat_show) "
      + "— only after the person decided; never approve on your own.",
    inputSchema: {
      id: z.string().min(1).describe("The session id (cc_…)"),
      action: z.enum(["stop", "approve", "deny"]).describe("stop the turn, or approve / deny an approval"),
      approval_id: z.string().optional().describe("approve / deny: the approval (ap_…)"),
    },
    outputSchema: { action: z.string(), result: looseObject },
    annotations: UPDATE,
  }, async ({ id, action, approval_id }) => {
    if (action === "stop") {
      const r = await apiSend(deps, "POST", `/coding/chats/${enc(id)}/stop`);
      if (!r.ok) return apiError(r, `Stopping coding chat ${id}`);
      return ok(`Stopped coding chat ${id}.`, { action, result: r.data as Record<string, unknown> });
    }
    if (!approval_id) return fail("approval_id is required to approve or deny (see polpo_coding_chat_show).");
    const r = await apiSend(deps, "POST", `/coding/chats/${enc(id)}/approvals/${enc(approval_id)}`, { decision: action });
    if (!r.ok) return apiError(r, `${action === "approve" ? "Approving" : "Denying"} ${approval_id}`);
    return ok(`${action === "approve" ? "Approved" : "Denied"}: ${(r.data as { summary?: string }).summary ?? approval_id}.`, { action, result: r.data as Record<string, unknown> });
  });
}

const cardOutput = z.object({
  kind: z.literal("coding-chat").optional(),
  key: z.object({ createdAt: z.number(), seq: z.number() }).passthrough().optional(),
  generatedAt: z.string().optional(),
  session: looseObject.optional().describe("status, model, tokens, worktree, last error"),
  messages: z.array(looseObject).optional().describe("the latest messages: text and one line per tool call (edits with +/− lines)"),
  approvals: z.array(looseObject).optional().describe("risky actions waiting for the person"),
  earlier: z.number().optional(),
}).passthrough();

export function registerCodingCard(server: McpServer, deps: McpDeps, enabled: ReadonlySet<ToolsetName>, principal: McpPrincipal, catalog?: ToolScope[]): void {
  if (!allowed(enabled, principal, "coding", READ, catalog, ["polpo_coding_chat_show"])) return;

  registerAppResource(server, "Coding chat card", CODING_CARD_URI, {
    description: "A Claude Code / Codex session's transcript: messages, tool calls, approvals waiting.",
  }, async () => ({
    contents: [{
      uri: CODING_CARD_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: CODING_CARD_HTML,
      _meta: { ui: { prefersBorder: false, csp: { resourceDomains: ["https://assets.claude.ai"] } } },
    }],
  }));

  registerAppTool(server, "polpo_coding_chat_show", {
    title: "Show a coding chat",
    description: "Show a coding chat (Claude Code / Codex in a worktree) as a card: the latest messages, each tool call in one line (edits with their +/− lines, commands), "
      + "approvals waiting (with their ids), status, model and tokens. The text is the transcript. Use it after polpo_coding_chat_start / _send.",
    inputSchema: {
      id: z.string().min(1).describe("The session id (cc_…)"),
      limit: z.number().int().min(1).max(50).optional().describe("Latest messages shown (default 12)"),
    },
    annotations: { title: "Show a coding chat", ...READ },
    outputSchema: cardOutput,
    _meta: { ui: { resourceUri: CODING_CARD_URI } },
  }, async (args) => {
    const r = await loadCodingCard(deps, args);
    return r.ok ? { content: [{ type: "text" as const, text: codingCardText(r.card) }], structuredContent: r.card as unknown as Record<string, unknown> } : fail(r.error);
  });
}
