/**
 * Recurring checks and reminders (what schedule_check makes in a chat), and the Telegram chats the
 * instance's bots can write to: the same managers Polpo's and agents' tools use.
 *
 *   GET    /checks?session=&agent=&state=    checks, newest first
 *   POST   /checks                           a new check { sessionId?, agent?, prompt?, message?, everyMinutes?, cron?, timezone?, at?, to?, maxRuns?, endsAt?, title? }
 *                                            (no sessionId: a new chat session is made for its reports)
 *   PATCH  /checks/:id                       change it { prompt?, message?, everyMinutes?, cron?, timezone?, maxRuns?, endsAt?, confirm? }
 *   DELETE /checks/:id                       cancel it (it stays listed as cancelled)
 *
 *   GET    /telegram/chats                   the groups, topics and people the bots can write to, and the bots
 *   POST   /telegram/send                    { to, text?, files?, agent?, topic? }: send now
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import type { ConversationCheckTarget, SessionStore } from "@polpo-ai/core";
import type { ConversationCheckManager } from "../../core/conversation-check-manager.js";
import { parseCheckTime } from "../../core/conversation-check-manager.js";
import type { ChatBot, ReachableChat } from "../../core/chat-directory.js";

export interface CheckRoutesDeps {
  checks?: ConversationCheckManager;
  sessions?: SessionStore;
  agentNames: () => Promise<string[]>;
  /** Where `to` goes (a chat name or id from /telegram/chats); absent without Telegram bots. */
  resolveChatTarget?: (to: string, opts?: { agent?: string; topic?: number }) => Promise<ConversationCheckTarget>;
}

const STATES = ["active", "proposed", "ended", "cancelled"] as const;

const CreateSchema = z.object({
  sessionId: z.string().min(1).optional(),
  title: z.string().max(120).optional(),
  agent: z.string().min(1).optional(),
  prompt: z.string().max(20_000).optional(),
  message: z.string().max(20_000).optional(),
  everyMinutes: z.number().min(0).optional(),
  cron: z.string().max(200).optional(),
  timezone: z.string().max(100).optional(),
  at: z.string().optional(),
  to: z.string().max(300).optional(),
  topic: z.number().int().optional(),
  maxRuns: z.number().int().min(1).optional(),
  endsAt: z.string().optional(),
  createdBy: z.string().max(200).optional(),
}).strict();

const PatchSchema = z.object({
  prompt: z.string().min(1).max(20_000).optional(),
  message: z.string().max(20_000).nullable().optional(),
  everyMinutes: z.number().min(0).optional(),
  cron: z.string().max(200).nullable().optional(),
  timezone: z.string().max(100).nullable().optional(),
  maxRuns: z.number().int().min(1).nullable().optional(),
  endsAt: z.string().nullable().optional(),
  confirm: z.literal(true).optional(),
}).strict();

export function checkRoutes(getDeps: () => CheckRoutesDeps): OpenAPIHono {
  const app = new OpenAPIHono();
  const fail = (c: any, status: number, error: string) => c.json({ ok: false, error }, status);
  const manager = (c: any): ConversationCheckManager | Response => getDeps().checks ?? fail(c, 503, "Scheduled checks are not available on this instance");

  app.get("/", async (c) => {
    const m = manager(c);
    if (m instanceof Response) return m;
    const state = c.req.query("state");
    const checks = await m.list({
      ...(c.req.query("session") ? { sessionId: c.req.query("session") } : {}),
      ...(c.req.query("agent") ? { agent: c.req.query("agent") } : {}),
      ...(state && (STATES as readonly string[]).includes(state) ? { states: [state as (typeof STATES)[number]] } : {}),
    });
    return c.json({ ok: true, data: checks });
  });

  app.post("/", async (c) => {
    const m = manager(c);
    if (m instanceof Response) return m;
    const parsed = CreateSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return fail(c, 400, parsed.error.issues[0]?.message ?? "Invalid check");
    const b = parsed.data;
    const deps = getDeps();
    if (b.agent && !(await deps.agentNames()).includes(b.agent)) return fail(c, 400, `Unknown agent "${b.agent}"`);
    if (!b.prompt?.trim() && !b.message?.trim()) return fail(c, 400, "Say what to do at every run (prompt), or the message to send");
    let sessionId = b.sessionId;
    if (sessionId) {
      if (deps.sessions && !(await deps.sessions.getSession(sessionId))) return fail(c, 404, `Chat session "${sessionId}" not found`);
    } else {
      if (!deps.sessions) return fail(c, 400, "Give the chat session the reports go to (sessionId)");
      sessionId = await deps.sessions.create(b.title ?? `Check: ${(b.prompt ?? b.message ?? "").trim().slice(0, 60)}`, b.agent);
    }
    let firstRunAt: string | undefined;
    if (b.at) {
      const at = parseCheckTime(b.at, b.timezone);
      if (!at) return fail(c, 400, "at must be a date (\"2026-10-14T09:00\" or ISO)");
      firstRunAt = at.toISOString();
    }
    let target: ConversationCheckTarget | undefined;
    if (b.to) {
      if (!deps.resolveChatTarget) return fail(c, 400, "Sending to a chat needs a Telegram bot on this instance");
      try {
        target = await deps.resolveChatTarget(b.to, { ...(b.agent ? { agent: b.agent } : {}), ...(b.topic !== undefined ? { topic: b.topic } : {}) });
      } catch (err) {
        return fail(c, 400, err instanceof Error ? err.message : String(err));
      }
    }
    try {
      const check = await m.create({
        sessionId, ...(b.agent ? { agent: b.agent } : {}), prompt: b.prompt ?? "", ...(b.message ? { message: b.message } : {}),
        everyMinutes: b.cron ? 0 : b.everyMinutes ?? 0, ...(b.cron ? { cron: b.cron, ...(b.timezone ? { timezone: b.timezone } : {}) } : {}),
        ...(target ? { target } : {}), ...(b.maxRuns !== undefined ? { maxRuns: b.maxRuns } : {}), ...(b.endsAt ? { endsAt: b.endsAt } : {}),
        ...(firstRunAt ? { firstRunAt } : {}), ...(b.createdBy ? { createdBy: b.createdBy } : {}),
      });
      return c.json({ ok: true, data: check }, 201);
    } catch (err) {
      return fail(c, 400, err instanceof Error ? err.message : String(err));
    }
  });

  app.patch("/:id", async (c) => {
    const m = manager(c);
    if (m instanceof Response) return m;
    const parsed = PatchSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return fail(c, 400, parsed.error.issues[0]?.message ?? "Invalid change");
    const { confirm, ...patch } = parsed.data;
    const id = c.req.param("id");
    try {
      let check = await m.update(id, patch);
      if (!check) return fail(c, 404, "Check not found");
      if (confirm) check = await m.confirm(id) ?? check;
      return c.json({ ok: true, data: check });
    } catch (err) {
      return fail(c, 400, err instanceof Error ? err.message : String(err));
    }
  });

  app.delete("/:id", async (c) => {
    const m = manager(c);
    if (m instanceof Response) return m;
    const check = await m.cancel(c.req.param("id"));
    return check ? c.json({ ok: true, data: check }) : fail(c, 404, "Check not found");
  });

  return app;
}

export interface TelegramRoutesDeps {
  listChats?: () => Promise<ReachableChat[]>;
  chatBots?: () => ChatBot[];
  resolveChatTarget?: (to: string, opts?: { agent?: string; topic?: number }) => Promise<ConversationCheckTarget>;
  sendToChat?: (target: ConversationCheckTarget, text: string, agent?: string, files?: string[]) => Promise<string>;
}

const SendSchema = z.object({
  to: z.string().min(1).max(300),
  text: z.string().max(20_000).optional(),
  files: z.array(z.string().min(1)).max(10).optional(),
  agent: z.string().min(1).optional(),
  topic: z.number().int().optional(),
}).strict();

export function telegramRoutes(getDeps: () => TelegramRoutesDeps): OpenAPIHono {
  const app = new OpenAPIHono();
  const fail = (c: any, status: number, error: string) => c.json({ ok: false, error }, status);

  app.get("/chats", async (c) => {
    const d = getDeps();
    const bots = (d.chatBots?.() ?? []).map((b) => ({ key: b.key, ...(b.agent ? { agent: b.agent } : {}) }));
    return c.json({ ok: true, data: { bots, chats: bots.length && d.listChats ? await d.listChats() : [] } });
  });

  app.post("/send", async (c) => {
    const d = getDeps();
    if (!d.resolveChatTarget || !d.sendToChat || !(d.chatBots?.() ?? []).length) return fail(c, 503, "There is no Telegram bot on this instance");
    const parsed = SendSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return fail(c, 400, parsed.error.issues[0]?.message ?? "Invalid message");
    const b = parsed.data;
    if (!b.text?.trim() && !b.files?.length) return fail(c, 400, "Nothing to send (text or files)");
    try {
      const target = await d.resolveChatTarget(b.to, { ...(b.agent ? { agent: b.agent } : {}), ...(b.topic !== undefined ? { topic: b.topic } : {}) });
      const bot = await d.sendToChat(target, b.text ?? "", b.agent, b.files ?? []);
      return c.json({ ok: true, data: { sent: true, bot, to: { chatId: target.chatId, ...(target.name ? { name: target.name } : {}), ...(target.threadId !== undefined ? { threadId: target.threadId } : {}) } } });
    } catch (err) {
      return fail(c, 400, err instanceof Error ? err.message : String(err));
    }
  });

  return app;
}
