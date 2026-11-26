/**
 * Coding chats: Claude Code / Codex sessions in a Coding worktree, run through the CLI engine with
 * the person's own CLI account and shown as a chat (src/coding/chat-manager.ts). Mounted under
 * /api/v1/coding/chats.
 *
 *   GET    /coding/chats                          sessions (?cwd, ?workspaceId, ?kind), without transcripts
 *   POST   /coding/chats                          { kind, cwd, title?, workspaceId?, branch?, account?, model?, prompt? } a new session
 *   GET    /coding/chats/account?kind=claude      the CLI account a session of yours would use, or how to sign in
 *   GET    /coding/chats/{id}                     one session with its transcript and approvals
 *   POST   /coding/chats/{id}/messages            { text } a new turn, or a steer when one is running
 *   POST   /coding/chats/{id}/stop                stop the running turn (the conversation stays)
 *   POST   /coding/chats/{id}/approvals/{approvalId}   { decision: approve | deny } answer a risky action
 *   DELETE /coding/chats/{id}                     stop and delete
 *   GET    /coding/chats/{id}/events              Server-Sent Events: session, message, approval, files-changed, deleted
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import { CodingChatError, memberOf, summaryOf, type CodingChatManager } from "../../coding/chat-manager.js";
import { currentEventOrigin } from "../../core/events.js";
import type { CodingChatEvent } from "../../coding/chat-types.js";

export interface CodingChatRouteDeps {
  manager: () => CodingChatManager | undefined;
  /** The member signed in to the dashboard (instance sign-in), if any. */
  member: (c: { get(key: never): unknown }) => string | undefined;
}

const kindEnum = z.enum(["claude", "codex"]);
const usageSchema = z.object({ inputTokens: z.number(), outputTokens: z.number(), cacheReadTokens: z.number(), cacheWriteTokens: z.number(), totalTokens: z.number() });
const toolSchema = z.object({
  id: z.string(), name: z.string().openapi({ description: "The program's own tool (Edit, Bash, Read… / shell, apply_patch…)" }),
  input: z.record(z.string(), z.unknown()).optional(), output: z.string().optional(),
  diff: z.string().optional().openapi({ description: "Edits: a unified diff of the change" }),
  state: z.enum(["running", "completed", "error", "interrupted"]),
});
const segmentSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("reasoning"), text: z.string() }),
  z.object({ type: z.literal("tool"), tool: toolSchema }),
  z.object({ type: z.literal("approval"), approvalId: z.string() }),
]);
const errorKind = z.enum(["no-account", "not-allowed", "not-signed-in", "usage-limit", "not-installed", "interrupted", "other"]);
const messageSchema = z.object({
  id: z.string(), role: z.enum(["user", "assistant"]), ts: z.string(), text: z.string().optional(), kind: z.enum(["prompt", "steer"]).optional(),
  segments: z.array(segmentSchema).optional(), streaming: z.boolean().optional(), model: z.string().optional(), usage: usageSchema.optional(),
  costUsd: z.number().optional(), error: z.string().optional(), errorKind: errorKind.optional(),
}).openapi("CodingChatMessage");
const approvalSchema = z.object({
  id: z.string(), tool: z.string(), toolUseId: z.string().optional(), input: z.unknown().optional(), summary: z.string(), reason: z.string(),
  category: z.enum(["network-install", "network", "git-push", "outside-worktree", "privileged", "unknown-tool"]),
  state: z.enum(["pending", "approved", "denied", "expired"]), requestedAt: z.string(), resolvedAt: z.string().optional(), resolvedBy: z.string().optional(),
}).openapi("CodingChatApproval");
const baseShape = {
  id: z.string(), kind: kindEnum, title: z.string(), cwd: z.string().openapi({ description: "The worktree: the program's working directory" }),
  workspaceId: z.string().optional(), branch: z.string().optional(), owner: z.string().optional().openapi({ description: "The member whose CLI account runs it" }),
  account: z.string().optional(), runtimeSessionId: z.string().optional().openapi({ description: "The program's conversation (Claude session, Codex thread), resumed every turn" }),
  model: z.string().optional(), status: z.enum(["idle", "running", "awaiting-approval", "error"]), lastError: z.string().optional(), errorKind: errorKind.optional(),
  continuedFrom: z.object({
    terminalId: z.string(), label: z.string().optional(), resumeSessionId: z.string().optional(),
    status: z.enum(["pending", "resumed", "new"]), note: z.string(),
  }).optional().openapi({ description: "Opened from a terminal session (Open as chat): what it continues, and whether the conversation was resumed" }),
  usage: usageSchema, costUsd: z.number().openapi({ description: "The CLI's own estimate (the plan pays)" }), turns: z.number(), createdAt: z.string(), updatedAt: z.string(),
};
const summarySchema = z.object({ ...baseShape, messageCount: z.number(), pendingApprovals: z.number(), preview: z.string().optional() }).openapi("CodingChatSummary");
const sessionSchema = z.object({ ...baseShape, messages: z.array(messageSchema), approvals: z.array(approvalSchema) }).openapi("CodingChatSession");
const createSchema = z.object({
  kind: kindEnum.openapi({ description: "claude: Claude Code; codex: Codex" }),
  cwd: z.string().min(1).openapi({ description: "The worktree (inside the agent workspace or an allowed root)" }),
  title: z.string().max(120).optional(), workspaceId: z.string().max(200).optional(), branch: z.string().max(300).optional(),
  account: z.string().max(40).optional().openapi({ description: "A CLI account id (default: yours for that CLI on this server)" }),
  model: z.string().max(200).optional(), prompt: z.string().max(100_000).optional().openapi({ description: "The first message: the turn starts at once" }),
  fromTerminal: z.object({ id: z.string().min(1).max(200), label: z.string().max(200).optional() }).optional()
    .openapi({ description: "Open as chat: the Coding app's terminal session this chat continues (it stays open)" }),
  resumeSessionId: z.string().max(200).optional()
    .openapi({ description: "The program's conversation to resume (Claude Code: the terminal's --session-id). When your CLI account cannot read it, a new conversation starts and continuedFrom says so" }),
}).openapi("CodingChatCreate");
const accountSchema = z.object({
  kind: kindEnum,
  account: z.object({ id: z.string(), label: z.string().optional(), owner: z.string() }).optional(),
  problem: z.string().optional(), code: z.string().optional(),
  signInUrl: z.string().openapi({ description: "Where to add an account and sign in (the dashboard)" }),
}).openapi("CodingChatAccount");

const errorSchema = z.object({ ok: z.literal(false), error: z.string(), code: z.string().optional() });
const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const okOf = <T extends z.ZodTypeAny>(schema: T) => z.object({ ok: z.literal(true), data: schema });
const body = <T extends z.ZodTypeAny>(schema: T) => ({ body: { content: { "application/json": { schema } }, required: true } });
const idParam = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });
const TAG = ["Coding"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each route's own response union
async function guard(c: any, fn: () => Promise<Response> | Response): Promise<any> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CodingChatError) return c.json({ ok: false, error: err.message, code: err.code }, err.status);
    throw err;
  }
}

export function codingChatRoutes(deps: CodingChatRouteDeps): OpenAPIHono {
  const app = new OpenAPIHono();
  const need = () => {
    const m = deps.manager();
    if (!m) throw new CodingChatError("Polpo is not initialized", 409, "UNAVAILABLE");
    return m;
  };
  // the dashboard's member, else the person an MCP client or Polpo's chat acts for
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any Hono context
  const actor = (c: any) => {
    const member = (deps.member(c) ?? memberOf(currentEventOrigin()?.by))?.toLowerCase();
    return member ? { member } : {};
  };

  app.openapi(createRoute({
    method: "get", path: "/", tags: TAG, summary: "Coding chat sessions",
    description: "Claude Code and Codex sessions of the Coding app (run through the CLI engine with the person's own CLI account), newest first, without their transcripts.",
    request: { query: z.object({ cwd: z.string().optional(), workspaceId: z.string().optional(), kind: kindEnum.optional() }) },
    responses: { 200: json(okOf(z.array(summarySchema)), "Sessions") },
  }), (c) => guard(c, () => {
    const q = c.req.valid("query");
    return c.json({ ok: true as const, data: need().list({ ...(q.cwd ? { cwd: q.cwd } : {}), ...(q.workspaceId ? { workspaceId: q.workspaceId } : {}), ...(q.kind ? { kind: q.kind } : {}) }) }, 200);
  }));

  app.openapi(createRoute({
    method: "post", path: "/", tags: TAG, summary: "Start a coding chat",
    description: "A new Claude Code or Codex session in a worktree (the program's working directory), on your own CLI account. With prompt the first turn starts at once. "
      + "With fromTerminal (and resumeSessionId) it continues a terminal session of the Coding app (Open as chat). Without an account to run it the session is created with status error and errorKind no-account (lastError says how to sign in).",
    request: body(createSchema),
    responses: { 201: json(okOf(sessionSchema), "Created"), 400: json(errorSchema, "Invalid request (kind, cwd outside the allowed roots…)") },
  }), (c) => guard(c, () => c.json({ ok: true as const, data: need().create(c.req.valid("json"), actor(c)) }, 201)));

  app.openapi(createRoute({
    method: "get", path: "/account", tags: TAG, summary: "Your CLI account for coding chats",
    description: "The CLI account a coding chat of yours would use on this server (Claude Code or Codex), or why none can (and where to sign in).",
    request: { query: z.object({ kind: kindEnum }) },
    responses: { 200: json(okOf(accountSchema), "The account, or the problem") },
  }), (c) => guard(c, () => {
    const { kind } = c.req.valid("query");
    const r = need().accountFor(kind, actor(c));
    const data = "problem" in r
      ? { kind, problem: r.problem, code: r.code, signInUrl: "/config?section=harnesses" }
      : { kind, account: { id: r.account.id, owner: r.account.owner, ...(r.account.label ? { label: r.account.label } : {}) }, signInUrl: "/config?section=harnesses" };
    return c.json({ ok: true as const, data }, 200);
  }));

  app.openapi(createRoute({
    method: "get", path: "/{id}", tags: TAG, summary: "One coding chat",
    description: "A session with its transcript (messages with text, reasoning, tool calls with diffs and output, approvals in place) and its approvals.",
    request: { params: idParam },
    responses: { 200: json(okOf(sessionSchema), "The session"), 404: json(errorSchema, "No such session") },
  }), (c) => guard(c, () => {
    const s = need().get(c.req.valid("param").id);
    if (!s) throw new CodingChatError(`Coding chat ${c.req.valid("param").id} not found`, 404, "NOT_FOUND");
    return c.json({ ok: true as const, data: s }, 200);
  }));

  app.openapi(createRoute({
    method: "post", path: "/{id}/messages", tags: TAG, summary: "Send a message to a coding chat",
    description: "Starts a turn (the program resumes the session's conversation), or reaches the running turn at once (steered: true). Only the session's owner can send.",
    request: { params: idParam, ...body(z.object({ text: z.string().min(1).max(100_000) })) },
    responses: {
      202: json(okOf(z.object({ steered: z.boolean(), session: sessionSchema })), "Accepted"),
      403: json(errorSchema, "Not your session"), 404: json(errorSchema, "No such session"),
    },
  }), (c) => guard(c, () => {
    const r = need().send(c.req.valid("param").id, c.req.valid("json").text, actor(c));
    return c.json({ ok: true as const, data: r }, 202);
  }));

  app.openapi(createRoute({
    method: "post", path: "/{id}/stop", tags: TAG, summary: "Stop a coding chat's turn",
    description: "Ends the running turn (approvals waiting are denied); the conversation stays and the next message resumes it.",
    request: { params: idParam },
    responses: { 200: json(okOf(sessionSchema), "Stopped"), 403: json(errorSchema, "Not your session"), 404: json(errorSchema, "No such session") },
  }), (c) => guard(c, async () => c.json({ ok: true as const, data: await need().stop(c.req.valid("param").id, actor(c)) }, 200)));

  app.openapi(createRoute({
    method: "post", path: "/{id}/approvals/{approvalId}", tags: TAG, summary: "Approve or deny a risky action",
    description: "A risky action (network installs, other network access, git push, files outside the worktree, sudo / docker / kill, an unknown tool) waits for the session's owner: approve runs it, deny tells the program it was refused.",
    request: {
      params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }), approvalId: z.string().openapi({ param: { name: "approvalId", in: "path" } }) }),
      ...body(z.object({ decision: z.enum(["approve", "deny"]) })),
    },
    responses: {
      200: json(okOf(approvalSchema), "Answered"), 403: json(errorSchema, "Not your session"), 404: json(errorSchema, "No such session or approval"),
      409: json(errorSchema, "Already answered, or no longer waiting"),
    },
  }), (c) => guard(c, () => {
    const p = c.req.valid("param");
    return c.json({ ok: true as const, data: need().resolveApproval(p.id, p.approvalId, c.req.valid("json").decision, actor(c)) }, 200);
  }));

  app.openapi(createRoute({
    method: "delete", path: "/{id}", tags: TAG, summary: "Delete a coding chat",
    description: "Stops its turn and deletes the transcript (the worktree and the program's own session files stay).",
    request: { params: idParam },
    responses: { 200: json(okOf(z.object({ deleted: z.boolean() })), "Deleted"), 403: json(errorSchema, "Not your session"), 404: json(errorSchema, "No such session") },
  }), (c) => guard(c, async () => c.json({ ok: true as const, data: { deleted: await need().delete(c.req.valid("param").id, actor(c)) } }, 200)));

  app.openapi(createRoute({
    method: "get", path: "/{id}/events", tags: TAG, summary: "A coding chat's live events",
    description: "Server-Sent Events: session (status, usage), message (a message as it is written: the whole message each time), approval, files-changed (the worktree changed: refresh its changes), deleted. "
      + "The first event is the session.",
    request: { params: idParam },
    responses: {
      200: { description: "The event stream", content: { "text/event-stream": { schema: z.string().openapi({ description: "event: <type>, data: the event as JSON" }) } } },
      404: json(errorSchema, "No such session"),
    },
  }), ((c: any) => guard(c, () => {
    const m = need();
    const id = c.req.valid("param").id as string;
    const s = m.get(id);
    if (!s) throw new CodingChatError(`Coding chat ${id} not found`, 404, "NOT_FOUND");
    return streamSSE(c, async (stream) => {
      let written: Promise<void> = Promise.resolve();
      const send = (e: CodingChatEvent) => { written = written.then(() => stream.writeSSE({ event: e.type, data: JSON.stringify(e) })).catch(() => undefined); };
      let close: () => void = () => {};
      const closed = new Promise<void>((resolve) => { close = resolve; });
      const unsubscribe = m.subscribe(id, (e) => { send(e); if (e.type === "deleted") close(); });
      stream.onAbort(() => close());
      c.req.raw.signal?.addEventListener?.("abort", () => close());
      send({ type: "session", session: summaryOf(m.get(id) ?? s) });
      // a comment now and then keeps proxies from closing an idle stream
      const ping = setInterval(() => { written = written.then(() => stream.write(": ping\n\n")).then(() => undefined).catch(() => close()); }, 25_000);
      try {
        await closed;
      } finally {
        clearInterval(ping);
        unsubscribe();
        await written;
      }
    });
  })) as any);

  return app;
}
