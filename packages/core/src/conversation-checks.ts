/**
 * Conversation checks: work an agent (or Polpo) runs later, once or on a schedule ("check every 2
 * minutes whether the site answers and tell us if it goes down", "remind the team group every Monday
 * at 9").
 *
 * Each run is a turn of the check's own chat session (it remembers its earlier runs, and the "nothing
 * to report" answers stay there), or a fixed message sent as it is; the answer is delivered to the
 * check's target (any Telegram group, topic or person the bots can reach; by default the chat it was
 * asked in) and added to the chat session it was asked in, unless the agent answers
 * {@link CHECK_NOTHING_TO_REPORT}.
 */

/** The answer of a run with nothing worth telling: nothing is delivered. */
export const CHECK_NOTHING_TO_REPORT = "NO_UPDATE";

/** Shortest interval between two runs. */
export const MIN_CHECK_INTERVAL_MINUTES = 1;

/** Where the answers of a check go: a channel's conversation (bot key, chat, topic). */
export interface ConversationCheckTarget {
  /** Channel key of the bot that delivers (settings.notifications.channels). */
  channel: string;
  chatId: string;
  /** Forum topic inside a group. */
  threadId?: number;
  /** Conversation id of a group ("telegram:group:<chatId>[:topic:<n>]"): answers join its transcript. */
  conversation?: string;
  /** Name of the chat (group title or person), for listing. */
  name?: string;
}

/** "proposed": planned by an agent on its own initiative, waiting for a yes before it runs. */
export type ConversationCheckState = "active" | "proposed" | "ended" | "cancelled";

export interface ConversationCheck {
  id: string;
  /** The chat session the check was asked in: its reports are added there. */
  sessionId: string;
  /** The check's own session, where runs happen (created at the first run). */
  runSessionId?: string;
  /** The agent that runs it; absent for Polpo. */
  agent?: string;
  /** What to do at every run, in the words of the request. */
  prompt: string;
  /** Sent as it is at every run, without running the agent (reminders). */
  message?: string;
  /** Minutes between runs; 0 when the check follows `cron` or runs once. */
  everyMinutes: number;
  /** Cron expression (5 fields) for the runs, read in `timezone`. */
  cron?: string;
  /** IANA timezone of `cron` (e.g. "Europe/Rome"). */
  timezone?: string;
  /** Where answers are delivered; absent = only the chat session (web chats). */
  target?: ConversationCheckTarget;
  state: ConversationCheckState;
  /** Who asked for it (person or peer id), for listing. */
  createdBy?: string;
  /** An agent's own intention (nobody asked): why it plans it, in its words. */
  why?: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string;
  /** Stop after this many runs. */
  maxRuns?: number;
  /** Stop after this time (ISO). */
  endsAt?: string;
  runs: number;
  lastRunAt?: string;
  /** Last answer delivered (not the "nothing to report" ones). */
  lastReport?: string;
  lastError?: string;
}

export interface NewConversationCheck {
  sessionId: string;
  agent?: string;
  prompt: string;
  message?: string;
  /** Minutes between runs; 0 with `cron`, or for a check that runs once (at `firstRunAt`). */
  everyMinutes: number;
  cron?: string;
  timezone?: string;
  target?: ConversationCheckTarget;
  createdBy?: string;
  why?: string;
  /** Start as "proposed" (waits for a yes). */
  proposed?: boolean;
  maxRuns?: number;
  endsAt?: string;
  /** First run; default: one interval from now. */
  firstRunAt?: string;
}

export interface ConversationCheckStore {
  createCheck(input: NewConversationCheck): Promise<ConversationCheck>;
  getCheck(id: string): Promise<ConversationCheck | undefined>;
  /** Checks of a session, or all; newest first. */
  listChecks(filter?: { sessionId?: string; agent?: string; states?: readonly ConversationCheckState[] }): Promise<ConversationCheck[]>;
  /** Active checks due at `now`. */
  dueChecks(now: string): Promise<ConversationCheck[]>;
  updateCheck(id: string, patch: Partial<Omit<ConversationCheck, "id" | "createdAt">>): Promise<ConversationCheck | undefined>;
}

/**
 * The next state of a check after a run at `at`: next run one interval later (or `next`, the next
 * cron time), or ended when it ran its last time (maxRuns, a check that runs once, a cron with no
 * next time) or its end time has passed.
 */
export function afterCheckRun(check: ConversationCheck, at: Date, next?: Date | null): Pick<ConversationCheck, "runs" | "lastRunAt" | "nextRunAt" | "state"> {
  const runs = check.runs + 1;
  const nextAt = check.cron ? next ?? null : check.everyMinutes > 0 ? new Date(at.getTime() + check.everyMinutes * 60_000) : null;
  const nextRunAt = (nextAt ?? at).toISOString();
  const ended = !nextAt
    || (check.maxRuns !== undefined && runs >= check.maxRuns)
    || (check.endsAt !== undefined && nextRunAt > check.endsAt);
  return { runs, lastRunAt: at.toISOString(), nextRunAt, state: ended ? "ended" : check.state };
}

/**
 * Today's date for a prompt ("Today is Tuesday 2026-10-13 (Europe/Rome)."), so "tomorrow at 9" can be
 * scheduled. Day precision keeps the prompt stable within a day; list_chats tells the exact time.
 */
export function todayLine(timezone?: string, now = new Date()): string {
  let zone = timezone;
  try { zone ||= Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* the server's */ }
  try {
    const date = now.toLocaleDateString("sv-SE", { timeZone: zone });
    const weekday = now.toLocaleDateString("en-US", { timeZone: zone, weekday: "long" });
    return `Today is ${weekday} ${date}${zone ? ` (${zone})` : ""}.`;
  } catch {
    return `Today is ${now.toISOString().slice(0, 10)} (UTC).`;
  }
}
