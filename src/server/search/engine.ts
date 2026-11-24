/**
 * The global search engine (GET /api/v1/search, polpo_search, Polpo's search tool, ⌘K).
 *
 * Every area of the instance is a source: most give a list of documents (agents, tasks,
 * missions, skills…) that the engine keeps for a few seconds and matches in memory; some run
 * their own query (chat messages through the database's full-text index, the company brain).
 *
 * Ranking: a title equal to the query, then a title starting with it, then every word in the
 * title, then in the subtitle, then in the content; within a tier, how well the words match
 * (exact > prefix > same stem > one typo > inside a word) and how recent the item is.
 *
 * The search answers within a budget: a source that is slow the first time is reported as
 * partial and answered from its cache the next time (stale-while-revalidate); a stale query
 * (the client aborted it) stops as soon as possible.
 */
import { fold, matchScore, maskSecrets, parseQuery, snippet, termScore, words, highlightRanges, type ParsedQuery, type Range, type Snippet } from "./text.js";

export const SEARCH_TYPES = [
  "chat", "room", "agent", "task", "mission", "schedule", "playbook", "approval", "artifact", "file",
  "data", "connector", "skill", "memory", "brain", "computer", "app", "channel", "member", "event",
] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export const SEARCH_TYPE_LABELS: Record<SearchType, string> = {
  chat: "Chats", room: "Groups", agent: "Agents", task: "Tasks", mission: "Missions", schedule: "Schedules",
  playbook: "Playbooks", approval: "Approvals", artifact: "Artifacts", file: "Files", data: "Data",
  connector: "Connectors", skill: "Skills", memory: "Memory", brain: "Company brain", computer: "Computers",
  app: "Apps", channel: "Channels", member: "Members", event: "Events",
};

export function isSearchType(value: string): value is SearchType {
  return (SEARCH_TYPES as readonly string[]).includes(value);
}

/** Something the search can find, as a source gives it. */
export interface SearchDoc {
  type: SearchType;
  id: string;
  title: string;
  subtitle?: string;
  /** Searchable, not shown (aliases, tags, ids, column names…). */
  keywords?: string;
  /** Longer text (content, description): matched, and the snippet comes from it. */
  body?: string;
  /** The dashboard route that opens it. */
  url: string;
  updatedAt?: string;
  meta?: Record<string, unknown>;
}

export interface SearchResult {
  type: SearchType;
  id: string;
  title: string;
  /** Matched ranges in the title. */
  titleHighlights?: Range[];
  subtitle?: string;
  /** The matching passage, with its matched ranges. */
  snippet?: Snippet;
  url: string;
  updatedAt?: string;
  score: number;
  meta?: Record<string, unknown>;
}

export interface SearchGroup {
  type: SearchType;
  label: string;
  /** Matches of this type (the group shows the best of them). */
  total: number;
  items: SearchResult[];
}

export interface SearchResponse {
  query: string;
  /** Milliseconds the search took. */
  took: number;
  /** Types that did not answer in time (their results come from the next search). */
  partial: SearchType[];
  groups: SearchGroup[];
  /** Every result shown, best first (the groups' items, flattened). */
  items: SearchResult[];
  /** Pass as cursor for the next results (null: no more). */
  nextCursor: string | null;
}

export interface SourceQueryContext {
  limit: number;
  signal: AbortSignal;
}

export interface SearchSource {
  type: SearchType;
  /** The documents to match (kept for ttlMs, refreshed in the background once stale). */
  docs?: () => Promise<SearchDoc[]>;
  /** How long the documents stay fresh (default 15 s). */
  ttlMs?: number;
  /** A query of its own (results already scored with scoreDoc). */
  query?: (q: ParsedQuery, ctx: SourceQueryContext) => Promise<SearchResult[]>;
}

export interface SearchOptions {
  q: string;
  types?: SearchType[];
  /** Results per page (default 40, at most 100). */
  limit?: number;
  /** Results per type when several types are searched (default 6). */
  perType?: number;
  cursor?: string | null;
  signal?: AbortSignal;
  /** Milliseconds to wait for sources (default 800). */
  budgetMs?: number;
}

// ── Scoring ───────────────────────────────────────────────────────────

interface Prepared {
  doc: SearchDoc;
  titleFolded: string;
  title: string[];
  sub: string[];
  body: string[];
  updatedMs: number;
}

const prepared = new WeakMap<SearchDoc, Prepared>();

function prepare(doc: SearchDoc): Prepared {
  let p = prepared.get(doc);
  if (!p) {
    p = {
      doc,
      titleFolded: fold(doc.title).replace(/\s+/g, " ").trim(),
      title: words(doc.title),
      sub: words(`${doc.subtitle ?? ""} ${doc.keywords ?? ""}`),
      body: doc.body ? words(doc.body) : [],
      updatedMs: doc.updatedAt ? Date.parse(doc.updatedAt) || 0 : 0,
    };
    prepared.set(doc, p);
  }
  return p;
}

const DAY = 86_400_000;

/** Up to 60 points for something changed today, fading over a few weeks. */
function recency(updatedMs: number, now: number): number {
  if (!updatedMs) return 0;
  const days = Math.max(0, (now - updatedMs) / DAY);
  return 60 * Math.exp(-days / 14);
}

/**
 * The score of a document for a query (0: no match). Tiers: title = query (1000), title starts
 * with it (850), every word in the title (600), in title + subtitle (400), anywhere (200); plus
 * up to 100 for match quality and 60 for recency.
 */
export function scoreDoc(doc: SearchDoc, q: ParsedQuery, now = Date.now()): { score: number; inBody: boolean } {
  const p = prepare(doc);
  if (!q.terms.length) return { score: 0, inBody: false };
  let tier: number;
  let quality: number;
  let inBody = false;
  if (p.titleFolded === q.folded) {
    tier = 1000; quality = 1;
  } else if (q.folded.length >= 2 && p.titleFolded.startsWith(q.folded)) {
    tier = 850; quality = 1;
  } else {
    const inTitle = matchScore(q, p.title);
    if (inTitle) {
      tier = 600; quality = inTitle;
    } else {
      // each word in its best field: the weakest field decides the tier
      let worst = 3;
      let sum = 0;
      for (const t of q.terms) {
        const ts = termScore(t, p.title);
        const ss = termScore(t, p.sub);
        const bs = p.body.length ? termScore(t, p.body) : 0;
        const best = Math.max(ts, ss * 0.95, bs * 0.9);
        if (!best) return { score: 0, inBody: false };
        sum += best;
        const field = ts >= ss && ts >= bs ? 3 : ss >= bs ? 2 : 1;
        if (field < worst) worst = field;
        if (field === 1) inBody = true;
      }
      tier = worst === 3 ? 600 : worst === 2 ? 400 : 200;
      quality = sum / q.terms.length;
    }
  }
  return { score: Math.round(tier + 100 * quality + recency(p.updatedMs, now)), inBody };
}

/** A document as a result: scored, with its title highlights and a snippet when the content matched. */
export function toResult(doc: SearchDoc, q: ParsedQuery, now = Date.now()): SearchResult | null {
  const { score, inBody } = scoreDoc(doc, q, now);
  if (!score) return null;
  const titleHighlights = highlightRanges(doc.title, q);
  const body = doc.body && (inBody || !titleHighlights.length) ? maskSecrets(doc.body) : undefined;
  const snip = body ? snippet(body, q) : undefined;
  return {
    type: doc.type,
    id: doc.id,
    title: doc.title,
    ...(titleHighlights.length ? { titleHighlights } : {}),
    ...(doc.subtitle ? { subtitle: maskSecrets(doc.subtitle) } : {}),
    ...(snip && snip.highlights.length ? { snippet: snip } : {}),
    url: doc.url,
    ...(doc.updatedAt ? { updatedAt: doc.updatedAt } : {}),
    score,
    ...(doc.meta ? { meta: doc.meta } : {}),
  };
}

// ── The engine ────────────────────────────────────────────────────────

interface CacheEntry {
  docs: SearchDoc[];
  at: number;
  loaded: boolean;
  refreshing?: Promise<SearchDoc[]>;
}

const DEFAULT_TTL = 15_000;

class AbortedError extends Error {
  constructor() { super("The search was cancelled"); this.name = "AbortError"; }
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
}

function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  try {
    const o = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))?.o;
    return Number.isInteger(o) && o >= 0 ? o : 0;
  } catch {
    return 0;
  }
}

export class SearchEngine {
  private cache = new Map<SearchType, CacheEntry>();

  constructor(private sources: () => SearchSource[]) {}

  /** Forget the documents of a type (or all): the next search reloads them. */
  invalidate(type?: SearchType): void {
    if (type) this.cache.delete(type);
    else this.cache.clear();
  }

  /** Load every source's documents in the background (the palette opening). */
  warm(): void {
    for (const s of this.sources()) {
      if (s.docs) void this.docsOf(s).catch(() => undefined);
    }
  }

  private docsOf(source: SearchSource): Promise<SearchDoc[]> {
    const entry = this.cache.get(source.type);
    const ttl = source.ttlMs ?? DEFAULT_TTL;
    if (entry?.loaded && Date.now() - entry.at < ttl) return Promise.resolve(entry.docs);
    if (entry?.refreshing) return entry.loaded ? Promise.resolve(entry.docs) : entry.refreshing;
    const refreshing = source.docs!().then((docs) => {
      this.cache.set(source.type, { docs, at: Date.now(), loaded: true });
      return docs;
    }, (err) => {
      // keep what we had; try again next time
      if (entry?.loaded) this.cache.set(source.type, { docs: entry.docs, at: entry.at, loaded: true });
      else this.cache.delete(source.type);
      throw err;
    });
    refreshing.catch(() => undefined);
    this.cache.set(source.type, { docs: entry?.docs ?? [], at: entry?.at ?? 0, loaded: !!entry?.loaded, refreshing });
    // stale: answer from the old documents while they refresh
    return entry?.loaded ? Promise.resolve(entry.docs) : refreshing;
  }

  private async runSource(source: SearchSource, q: ParsedQuery, limit: number, signal: AbortSignal): Promise<SearchResult[]> {
    const now = Date.now();
    const [fromDocs, fromQuery] = await Promise.all([
      source.docs ? this.docsOf(source).then((docs) => {
        if (signal.aborted) throw new AbortedError();
        const out: SearchResult[] = [];
        for (const d of docs) {
          const r = toResult(d, q, now);
          if (r) out.push(r);
        }
        return out;
      }) : Promise.resolve([] as SearchResult[]),
      source.query ? source.query(q, { limit, signal }) : Promise.resolve([] as SearchResult[]),
    ]);
    if (!fromQuery.length) return fromDocs;
    // the same item from both (a chat whose title and messages match): the best score, the snippet if any
    const byId = new Map<string, SearchResult>();
    for (const r of [...fromDocs, ...fromQuery]) {
      const prev = byId.get(r.id);
      if (!prev) { byId.set(r.id, r); continue; }
      const [best, other] = prev.score >= r.score ? [prev, r] : [r, prev];
      byId.set(r.id, {
        ...best,
        ...(best.snippet || !other.snippet ? {} : { snippet: other.snippet }),
        ...(best.titleHighlights || !other.titleHighlights ? {} : { titleHighlights: other.titleHighlights }),
        meta: { ...other.meta, ...best.meta },
      });
    }
    return [...byId.values()];
  }

  async search(opts: SearchOptions): Promise<SearchResponse> {
    const started = Date.now();
    const q = parseQuery(opts.q ?? "");
    const limit = Math.max(1, Math.min(opts.limit ?? 40, 100));
    const offset = decodeCursor(opts.cursor);
    const empty: SearchResponse = { query: opts.q ?? "", took: 0, partial: [], groups: [], items: [], nextCursor: null };
    if (!q.terms.length) {
      this.warm();
      return { ...empty, took: Date.now() - started };
    }
    const outer = opts.signal;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    outer?.addEventListener("abort", onAbort, { once: true });
    if (outer?.aborted) controller.abort();
    const types = opts.types?.length ? new Set(opts.types) : undefined;
    const single = types?.size === 1;
    const perType = single ? offset + limit : Math.max(1, Math.min(opts.perType ?? 6, 50));
    const sources = this.sources().filter((s) => !types || types.has(s.type));
    const budget = Math.max(50, opts.budgetMs ?? 800);
    const partial = new Set<SearchType>();
    const byType = new Map<SearchType, SearchResult[]>();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), budget); });
    try {
      await Promise.all(sources.map(async (source) => {
        try {
          const run = this.runSource(source, q, perType + 20, controller.signal);
          run.catch(() => undefined);
          const out = await Promise.race([run, deadline]);
          if (out === "timeout") { partial.add(source.type); return; }
          if (out.length) byType.set(source.type, [...(byType.get(source.type) ?? []), ...out]);
        } catch (err) {
          if ((err as Error)?.name === "AbortError" || controller.signal.aborted) return;
          partial.add(source.type);
        }
      }));
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    }
    if (outer?.aborted) throw new AbortedError();

    const groups: SearchGroup[] = [];
    for (const [type, results] of byType) {
      results.sort((a, b) => b.score - a.score || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
      groups.push({ type, label: SEARCH_TYPE_LABELS[type], total: results.length, items: results.slice(0, perType) });
    }
    groups.sort((a, b) => (b.items[0]?.score ?? 0) - (a.items[0]?.score ?? 0));
    // one page of the flattened list (a single type pages through all of its results)
    const flat = groups.flatMap((g) => g.items);
    const page = flat.slice(offset, offset + limit);
    const shown = new Set(page);
    const pageGroups = groups
      .map((g) => ({ ...g, items: g.items.filter((r) => shown.has(r)) }))
      .filter((g) => g.items.length);
    const more = single ? (groups[0]?.total ?? 0) > offset + limit : flat.length > offset + limit;
    return {
      query: opts.q,
      took: Date.now() - started,
      partial: [...partial],
      groups: pageGroups,
      items: pageGroups.flatMap((g) => g.items),
      nextCursor: more ? encodeCursor(offset + limit) : null,
    };
  }
}
