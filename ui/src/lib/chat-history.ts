/**
 * Chat history — the pure parts of the history list (no React): sorting, the time buckets of
 * "By chat" (Today, Yesterday, Previous 7 days, Previous 30 days, then months), the per-agent
 * sections of "By agent", pinned chats and the search filter.
 *
 * "Pinned" is the UI name of the thread's `starred` flag (API, SDK, MCP and storage keep
 * `starred`; only the copy changed).
 */

/** The orchestrator's section key (threads with no agent). */
export const ORCHESTRATOR_KEY = "__orchestrator__";

export interface HistorySession {
  id: string;
  title?: string;
  createdAt?: string;
  updatedAt: string;
  messageCount: number;
  agent?: string;
  /** Pinned (the API field is `starred`). */
  starred?: boolean;
  parentSessionId?: string;
  forkMessageId?: string;
}

export interface HistorySection<T> {
  key: string;
  label: string;
  items: T[];
}

function timeOf(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Most recently updated first (stable for equal times). */
export function sortByRecent<T extends Pick<HistorySession, "updatedAt">>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index, t: timeOf(item.updatedAt) }))
    .sort((a, b) => b.t - a.t || a.index - b.index)
    .map((e) => e.item);
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * The time bucket of a date, relative to `now` (local calendar days, like Claude's sidebar):
 * today, yesterday, the previous 7 days, the previous 30 days, then one bucket per month
 * ("October", or "October 2025" in another year). Future dates count as today.
 */
export function dateBucketOf(iso: string, now: Date): { key: string; label: string } {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { key: "older", label: "Older" };
  const today = startOfDay(now);
  const day = startOfDay(date);
  // calendar days between (rounded: DST days are 23 or 25 hours long)
  const days = Math.round((today - day) / DAY);
  if (days <= 0) return { key: "today", label: "Today" };
  if (days === 1) return { key: "yesterday", label: "Yesterday" };
  if (days <= 7) return { key: "week", label: "Previous 7 days" };
  if (days <= 30) return { key: "month", label: "Previous 30 days" };
  const month = date.toLocaleString("en-US", { month: "long" });
  const sameYear = date.getFullYear() === now.getFullYear();
  return {
    key: `m-${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`,
    label: sameYear ? month : `${month} ${date.getFullYear()}`,
  };
}

/** "By chat": the chats in time buckets, most recent first. */
export function groupByDate<T extends Pick<HistorySession, "updatedAt">>(
  items: readonly T[],
  now: Date,
): HistorySection<T>[] {
  const sections: HistorySection<T>[] = [];
  const byKey = new Map<string, HistorySection<T>>();
  for (const item of sortByRecent(items)) {
    const bucket = dateBucketOf(item.updatedAt, now);
    let section = byKey.get(bucket.key);
    if (!section) {
      section = { key: bucket.key, label: bucket.label, items: [] };
      byKey.set(bucket.key, section);
      sections.push(section);
    }
    section.items.push(item);
  }
  return sections;
}

/** The section key of a chat in "By agent". */
export function agentKeyOf(session: Pick<HistorySession, "agent">): string {
  return session.agent || ORCHESTRATOR_KEY;
}

/**
 * "By agent": one section per agent, the orchestrator first, then the agents by their most
 * recent chat; chats most recent first inside each. `labelOf` names a section.
 */
export function groupByAgent<T extends Pick<HistorySession, "updatedAt" | "agent">>(
  items: readonly T[],
  labelOf: (key: string) => string = (key) => key,
): HistorySection<T>[] {
  const byKey = new Map<string, T[]>();
  for (const item of sortByRecent(items)) {
    const key = agentKeyOf(item);
    const list = byKey.get(key) ?? [];
    list.push(item);
    byKey.set(key, list);
  }
  return [...byKey.entries()]
    .sort(([ka, a], [kb, b]) => {
      if (ka === ORCHESTRATOR_KEY) return -1;
      if (kb === ORCHESTRATOR_KEY) return 1;
      return timeOf(b[0].updatedAt) - timeOf(a[0].updatedAt);
    })
    .map(([key, list]) => ({ key, label: labelOf(key), items: list }));
}

/** Pinned chats, most recent first. */
export function pinnedOf<T extends Pick<HistorySession, "updatedAt" | "starred">>(items: readonly T[]): T[] {
  return sortByRecent(items.filter((s) => !!s.starred));
}

/** The chats that are not pinned (pinning moves a chat out of Recents into Pinned). */
export function unpinnedOf<T extends Pick<HistorySession, "starred">>(items: readonly T[]): T[] {
  return items.filter((s) => !s.starred);
}

/** Lowercased, accents stripped, trimmed. */
export function normalizeQuery(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

/**
 * The search: every word of the query must appear in the chat's title or in its agent's name
 * (`agentLabel` gives the display name, e.g. the orchestrator's). An empty query keeps all.
 */
export function filterSessions<T extends Pick<HistorySession, "title" | "agent">>(
  items: readonly T[],
  query: string,
  agentLabel: (key: string) => string = (key) => key,
): T[] {
  const words = normalizeQuery(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...items];
  return items.filter((s) => {
    const key = agentKeyOf(s);
    const hay = normalizeQuery(`${s.title ?? "Untitled"} ${s.agent ?? ""} ${agentLabel(key)}`);
    return words.every((w) => hay.includes(w));
  });
}

/** True when a group title matches the search (same rules as the chats). */
export function matchesQuery(text: string, query: string): boolean {
  const words = normalizeQuery(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = normalizeQuery(text);
  return words.every((w) => hay.includes(w));
}
