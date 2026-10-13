/**
 * Conversation checks and messages to any chat, as tools: "check every 2 minutes whether the site
 * answers and tell us if it goes down", "remind the team group every Monday at 9", "tell Marco the
 * release is out". The same tools serve agents (agent chat) and Polpo (orchestrator tools); they send
 * to any Telegram group, topic or person the bots have met, wherever they were asked from.
 */
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { CHECK_NOTHING_TO_REPORT, MIN_CHECK_INTERVAL_MINUTES, type ConversationCheck, type ConversationCheckTarget } from "@polpo-ai/core";
import { describeChats, type ChatBot, type ReachableChat } from "../core/chat-directory.js";
import { parseCheckTime, type ConversationCheckManager } from "../core/conversation-check-manager.js";

const toParam = Type.Optional(Type.String({ description: "The chat to send to: a group, topic or person by name or by its id from list_chats (e.g. \"Team Marketing\", \"telegram:group:-100123\"). Default: the chat this request came from." }));
const topicParam = Type.Optional(Type.Number({ description: "Forum topic id inside the `to` group" }));

export const ScheduleCheckSchema = Type.Object({
  instructions: Type.Optional(Type.String({ description: "What to do at every run, self-contained: what to check, how (tools, URLs, commands), and what is worth reporting. Later runs see only this and their own earlier runs. Not needed with `message`." })),
  message: Type.Optional(Type.String({ description: "A fixed message sent as it is at every run, without running you (reminders: \"Stand-up in 10 minutes!\")" })),
  to: toParam,
  topic: topicParam,
  every_minutes: Type.Optional(Type.Number({ minimum: MIN_CHECK_INTERVAL_MINUTES, description: `Run every N minutes (at least ${MIN_CHECK_INTERVAL_MINUTES})` })),
  cron: Type.Optional(Type.String({ description: "Run on a cron schedule, 5 fields in `timezone`: \"0 9 * * 1-5\" = weekdays at 9:00, \"30 18 * * 5\" = Fridays at 18:30" })),
  at: Type.Optional(Type.String({ description: "Run once at this time (or the first run, with every_minutes): local time \"2026-10-14T09:00\" read in `timezone`, or ISO with offset" })),
  in_minutes: Type.Optional(Type.Number({ minimum: 0, description: "Run once in N minutes (or the first run, with every_minutes)" })),
  timezone: Type.Optional(Type.String({ description: "IANA timezone for cron and at (e.g. \"Europe/Rome\"). Default: yours, else the server's" })),
  max_runs: Type.Optional(Type.Number({ minimum: 1, description: "Stop after this many runs" })),
  until: Type.Optional(Type.String({ description: "Stop after this time" })),
  run_now: Type.Optional(Type.Boolean({ description: "Run the first time now (default: after one interval, or at the first cron time)" })),
  why: Type.Optional(Type.String({ description: "When you plan it on your own initiative (nobody asked): why, in your words. It becomes one of your intentions" })),
  propose: Type.Optional(Type.Boolean({ description: "Propose it instead: it waits for a yes (confirm_check) before it runs" })),
});
export const ListChecksSchema = Type.Object({
  all: Type.Optional(Type.Boolean({ description: "Every check you scheduled, from any chat (Polpo: every check of the instance). Default: this chat's" })),
});
export const CancelCheckSchema = Type.Object({
  id: Type.String({ description: "Check id (chk_…), from schedule_check or list_checks" }),
});
export const ConfirmCheckSchema = Type.Object({
  id: Type.String({ description: "Id of a proposed check (chk_…)" }),
});
export const ListChatsSchema = Type.Object({});
export const SendMessageSchema = Type.Object({
  to: Type.String({ description: "The chat: a group, topic or person by name or by its id from list_chats" }),
  text: Type.String({ description: "The message (Markdown)" }),
  topic: topicParam,
});

export const SCHEDULE_CHECK_DESCRIPTION = "Do something later, once or on a schedule, and post the result in any chat: "
  + "\"check every 2 minutes whether the site answers and tell us if it goes down\", \"remind the Marketing group every Monday at 9\", \"tomorrow at 8 send Marco the report\". "
  + "When: every_minutes, cron (in timezone), at or in_minutes (once). Where: `to` = any group, topic or person from list_chats (default: the chat this request came from). "
  + "What: `message` is sent as it is (reminders); `instructions` run you in a session of its own that remembers the earlier runs, and you answer with the message to post, "
  + `or exactly ${CHECK_NOTHING_TO_REPORT} when there is nothing worth telling (then nothing is posted). Reports are also added to this conversation. `
  + "Use this instead of promising to notify later: without a check nothing happens after this turn.";
export const LIST_CHECKS_DESCRIPTION = "List scheduled checks and reminders (this chat's, or all with all=true): id, schedule, target, instructions, runs, next run, last report or error.";
export const CANCEL_CHECK_DESCRIPTION = "Stop a scheduled check or reminder, or drop a proposed one (by id).";
export const CONFIRM_CHECK_DESCRIPTION = "Say yes to a proposed check (an agent's intention waiting for approval): it runs from then on. Use it when the person it concerns agrees.";
export const LIST_CHATS_DESCRIPTION = "The chats you can send to: every Telegram group, topic and person the instance's bots have met, with the id to use in `to` (send_message, schedule_check). Also tells the current time.";
export const SEND_MESSAGE_DESCRIPTION = "Send a message now to any chat: a Telegram group, topic or person (by name or id from list_chats), wherever you were asked from. "
  + "If your bot is not in that chat, another bot of the instance sends it. For later or recurring messages use schedule_check.";

/** Sending to any chat (the orchestrator's Telegram bots). */
export interface ChatAccess {
  resolveChatTarget(to: string, opts?: { agent?: string; topic?: number }): Promise<ConversationCheckTarget>;
  sendToChat(target: ConversationCheckTarget, text: string, agent?: string): Promise<string>;
  listChats(): Promise<ReachableChat[]>;
  chatBots(): ChatBot[];
}

export interface CheckToolContext {
  manager?: ConversationCheckManager;
  /** The chat session of this turn. */
  sessionId?: string;
  /** The agent asking; absent for Polpo. */
  agent?: string;
  /** Where this turn came from (Telegram chat or topic); absent for web chats. */
  origin?: ConversationCheckTarget;
  /** Any chat, by name or id (send_message, schedule_check `to`). */
  chats?: ChatAccess;
  /** Default timezone of cron and at (the agent's identity). */
  timezone?: string;
  /** The agent's autonomy (drive): with "propose" its own intentions wait for a yes. */
  autonomy?: "propose" | "balanced" | "act";
  /** True while this turn is the agent's reflection (its own initiative, nobody asked). */
  reflecting?: () => boolean;
  /** Record what the agent did at a reflection, for its journal. */
  noteAction?: (action: string) => void;
}

function where(target: ConversationCheckTarget | undefined, origin?: ConversationCheckTarget): string {
  if (!target) return "this chat session";
  const here = origin && origin.chatId === target.chatId && origin.threadId === target.threadId;
  const kind = target.conversation ? (target.threadId !== undefined ? "Telegram group topic" : "Telegram group") : "Telegram chat";
  if (here) return `this ${kind}`;
  return target.name ? `the ${kind} "${target.name}"` : `the ${kind} ${target.chatId}`;
}

function schedule(check: Pick<ConversationCheck, "everyMinutes" | "cron" | "timezone">): string {
  if (check.cron) return `cron "${check.cron}"${check.timezone ? ` (${check.timezone})` : ""}`;
  return check.everyMinutes > 0 ? `every ${check.everyMinutes} min` : "once";
}

function describe(check: ConversationCheck): string {
  const limits = [check.maxRuns ? `up to ${check.maxRuns} runs` : "", check.endsAt ? `until ${check.endsAt}` : ""].filter(Boolean).join(", ");
  const what = check.message ?? check.prompt;
  const lines = [
    `${check.id} [${check.state}] ${schedule(check)}${limits ? ` (${limits})` : ""}, ${check.runs} runs, reports to ${where(check.target)}${check.agent ? `, by ${check.agent}` : ""}`,
    `  ${check.message ? "message" : "instructions"}: ${what.length > 200 ? `${what.slice(0, 200)}…` : what}`,
  ];
  if (check.state === "active") lines.push(`  next run: ${check.nextRunAt}`);
  if (check.lastReport) lines.push(`  last report: ${check.lastReport.slice(0, 200)}`);
  if (check.lastError) lines.push(`  last error: ${check.lastError}`);
  return lines.join("\n");
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (v === undefined || v === null || v === "" ? undefined : Number(v));

/** The local time in a timezone, for tool answers ("2026-10-14 09:00 Europe/Rome"). */
function localTime(iso: string, timezone?: string): string {
  try {
    const text = new Date(iso).toLocaleString("sv-SE", { timeZone: timezone, hour12: false }).slice(0, 16);
    return timezone ? `${text} ${timezone}` : `${iso.slice(0, 16)}Z`;
  } catch {
    return iso;
  }
}

function serverTimezone(): string | undefined {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; }
}

/** The target of `to` (any chat), or the chat this request came from. */
async function targetOf(args: Record<string, unknown>, ctx: CheckToolContext): Promise<ConversationCheckTarget | undefined> {
  const to = str(args.to);
  const topic = num(args.topic);
  if (!to || ["here", "this chat", "this group"].includes(to.toLowerCase())) {
    if (topic !== undefined && ctx.origin?.conversation) {
      const group = ctx.origin.conversation.replace(/:topic:\d+$/, "");
      return { ...ctx.origin, threadId: topic, conversation: `${group}:topic:${topic}` };
    }
    return ctx.origin;
  }
  if (!ctx.chats) throw new Error("Sending to other chats is not available here (no Telegram bot)");
  return ctx.chats.resolveChatTarget(to, { ...(ctx.agent ? { agent: ctx.agent } : {}), ...(topic !== undefined ? { topic } : {}) });
}

export async function execScheduleCheck(args: Record<string, unknown>, ctx: CheckToolContext): Promise<string> {
  if (!ctx.manager) return "Error: scheduled checks are not available on this instance";
  if (!ctx.sessionId) return "Error: scheduled checks need a persisted chat session";
  const timezone = str(args.timezone) ?? ctx.timezone ?? serverTimezone();
  const everyMinutes = num(args.every_minutes) ?? 0;
  const cron = str(args.cron);
  const until = str(args.until) ? parseCheckTime(str(args.until)!, timezone) : undefined;
  if (str(args.until) && !until) return "Error: until must be a date (\"2026-10-14T18:00\" or ISO)";
  let firstRunAt: string | undefined;
  if (args.run_now) firstRunAt = new Date().toISOString();
  else if (str(args.at)) {
    const at = parseCheckTime(str(args.at)!, timezone);
    if (!at) return "Error: at must be a date (\"2026-10-14T09:00\" or ISO)";
    if (at.getTime() < Date.now() - 60_000) return `Error: ${localTime(at.toISOString(), timezone)} is in the past (now: ${localTime(new Date().toISOString(), timezone)})`;
    firstRunAt = at.toISOString();
  } else if (num(args.in_minutes) !== undefined) {
    firstRunAt = new Date(Date.now() + num(args.in_minutes)! * 60_000).toISOString();
  }
  try {
    const target = await targetOf(args, ctx);
    const check = await ctx.manager.create({
      sessionId: ctx.sessionId,
      ...(ctx.agent ? { agent: ctx.agent } : {}),
      prompt: str(args.instructions) ?? "",
      ...(str(args.message) ? { message: str(args.message) } : {}),
      everyMinutes: cron ? 0 : everyMinutes,
      ...(cron ? { cron, ...(timezone ? { timezone } : {}) } : {}),
      ...(target ? { target } : {}),
      ...(args.max_runs !== undefined ? { maxRuns: Number(args.max_runs) } : {}),
      ...(until ? { endsAt: until.toISOString() } : {}),
      ...(firstRunAt ? { firstRunAt } : {}),
      ...(str(args.why) ? { why: str(args.why) } : {}),
      ...(args.propose || (str(args.why) && ctx.autonomy === "propose") ? { proposed: true } : {}),
    });
    const silent = check.message ? "" : "; runs with nothing to report stay silent";
    if (check.state === "proposed") {
      ctx.noteAction?.(`proposed ${check.id} → ${check.target?.name ?? "this chat"}${check.why ? ` (${check.why.slice(0, 120)})` : ""}`);
      return `Proposed ${check.id}: ${schedule(check)}, at ${localTime(check.nextRunAt, timezone)}, to ${where(check.target, ctx.origin)}. `
        + "It waits for a yes: ask the person it concerns, then confirm_check; it also shows in the agent's page to approve.";
    }
    ctx.noteAction?.(`planned ${check.id} → ${check.target?.name ?? "this chat"}${check.why ? ` (${check.why.slice(0, 120)})` : ""}`);
    return `Check ${check.id} scheduled ${schedule(check)}, ${check.everyMinutes > 0 || check.cron ? "first run" : "runs"} at ${localTime(check.nextRunAt, timezone)}. `
      + `Reports go to ${where(check.target, ctx.origin)}${silent}. Cancel it with cancel_check.`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function execListChecks(ctx: CheckToolContext, args: Record<string, unknown> = {}): Promise<string> {
  if (!ctx.manager) return "Error: scheduled checks are not available on this instance";
  if (args.all) {
    const checks = (await ctx.manager.list({ ...(ctx.agent ? { agent: ctx.agent } : {}), states: ["active"] }));
    return checks.length ? checks.slice(0, 30).map(describe).join("\n\n") : "No active scheduled checks.";
  }
  if (!ctx.sessionId) return "No checks: this chat has no persisted session.";
  const checks = await ctx.manager.list({ sessionId: ctx.sessionId });
  return checks.length ? checks.slice(0, 20).map(describe).join("\n\n") : "No scheduled checks in this chat (list_checks all=true lists the others).";
}

export async function execCancelCheck(args: Record<string, unknown>, ctx: CheckToolContext): Promise<string> {
  if (!ctx.manager) return "Error: scheduled checks are not available on this instance";
  const id = String(args.id ?? "");
  const [check] = (await ctx.manager.list()).filter((c) => c.id === id);
  // an agent stops its own checks or this chat's; Polpo any
  if (!check || (ctx.agent && check.sessionId !== ctx.sessionId && check.agent !== ctx.agent)) return `Error: no check ${id}`;
  const cancelled = await ctx.manager.cancel(id);
  return cancelled?.state === "cancelled" ? `Check ${id} cancelled.` : `Check ${id} is already ${cancelled?.state ?? "gone"}.`;
}

export async function execConfirmCheck(args: Record<string, unknown>, ctx: CheckToolContext): Promise<string> {
  if (!ctx.manager) return "Error: scheduled checks are not available on this instance";
  const id = String(args.id ?? "");
  const [check] = (await ctx.manager.list()).filter((c) => c.id === id);
  if (!check || (ctx.agent && check.agent !== ctx.agent && check.sessionId !== ctx.sessionId)) return `Error: no check ${id}`;
  if (check.state !== "proposed") return `Check ${id} is ${check.state}, not waiting for a yes.`;
  const confirmed = await ctx.manager.confirm(id);
  return `Check ${id} confirmed: it runs ${confirmed ? `at ${localTime(confirmed.nextRunAt, ctx.timezone)}` : "as planned"}.`;
}

export async function execListChats(ctx: CheckToolContext): Promise<string> {
  if (!ctx.chats) return "Error: no Telegram bot on this instance";
  return describeChats(await ctx.chats.listChats(), ctx.chats.chatBots());
}

export async function execSendMessage(args: Record<string, unknown>, ctx: CheckToolContext): Promise<string> {
  if (!ctx.chats) return "Error: no Telegram bot on this instance";
  const text = str(args.text);
  if (!text) return "Error: text is empty";
  try {
    const target = await ctx.chats.resolveChatTarget(String(args.to ?? ""), { ...(ctx.agent ? { agent: ctx.agent } : {}), ...(num(args.topic) !== undefined ? { topic: num(args.topic)! } : {}) });
    // at a reflection, an agent that proposes does not write on its own: the message waits for a yes
    if (ctx.autonomy === "propose" && ctx.reflecting?.() && ctx.manager && ctx.sessionId) {
      const check = await ctx.manager.create({
        sessionId: ctx.sessionId, ...(ctx.agent ? { agent: ctx.agent } : {}), prompt: "", message: text, everyMinutes: 0,
        firstRunAt: new Date().toISOString(), target, proposed: true, why: str(args.why) ?? "written at a reflection",
      });
      ctx.noteAction?.(`proposed ${check.id}: a message to ${target.name ?? target.chatId}`);
      return `Proposed ${check.id}: the message to ${where(target)} waits for a yes (confirm_check, or the agent's page).`;
    }
    const bot = await ctx.chats.sendToChat(target, text, ctx.agent);
    ctx.noteAction?.(`wrote to ${target.name ?? target.chatId}: ${text.slice(0, 120)}`);
    return `Sent to ${where(target)} (bot ${bot}).`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

type Result = { content: { type: "text"; text: string }[]; details: Record<string, unknown> };
const text = (t: string): Result => ({ content: [{ type: "text", text: t }], details: {} });

/** The tools for an agent chat (checks, list_chats, send_message); `context` is read when a tool runs (the session is known late). */
export function createConversationCheckTools(context: () => CheckToolContext): AgentTool<any>[] {
  return [
    {
      name: "schedule_check",
      label: "Schedule check",
      description: SCHEDULE_CHECK_DESCRIPTION,
      parameters: ScheduleCheckSchema,
      execute: async (_id, params) => text(await execScheduleCheck(params as Record<string, unknown>, context())),
    },
    {
      name: "list_checks",
      label: "List checks",
      description: LIST_CHECKS_DESCRIPTION,
      parameters: ListChecksSchema,
      execute: async (_id, params) => text(await execListChecks(context(), params as Record<string, unknown>)),
    },
    {
      name: "cancel_check",
      label: "Cancel check",
      description: CANCEL_CHECK_DESCRIPTION,
      parameters: CancelCheckSchema,
      execute: async (_id, params) => text(await execCancelCheck(params as Record<string, unknown>, context())),
    },
    {
      name: "confirm_check",
      label: "Confirm check",
      description: CONFIRM_CHECK_DESCRIPTION,
      parameters: ConfirmCheckSchema,
      execute: async (_id, params) => text(await execConfirmCheck(params as Record<string, unknown>, context())),
    },
    {
      name: "list_chats",
      label: "List chats",
      description: LIST_CHATS_DESCRIPTION,
      parameters: ListChatsSchema,
      execute: async () => text(await execListChats(context())),
    },
    {
      name: "send_message",
      label: "Send message",
      description: SEND_MESSAGE_DESCRIPTION,
      parameters: SendMessageSchema,
      execute: async (_id, params) => text(await execSendMessage(params as Record<string, unknown>, context())),
    },
  ];
}
