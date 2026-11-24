/**
 * The search palette's own knowledge (⌘K): the query prefixes, the pages and commands it finds
 * without asking the server, the local matching for them, and the recent searches and opened
 * items (this browser, per instance; a blocked storage just means no memory).
 *
 * Server results (chats with their messages, tasks, agents, files…) come from GET /api/v1/search
 * through useSearch (@polpo-ai/react).
 */
import type { LucideIcon } from "lucide-react";
import type { SearchRange, SearchResult, SearchType } from "@polpo-ai/react";
import { DRILL_IN_NAV, type NavEntry } from "@/lib/nav-tree";
import { chatInstanceKey } from "@/lib/chat-navigation";

// ── Query prefixes ──────────────────────────────────────────────────────

export type PaletteScope = "all" | "commands" | "pages" | "types";

export interface ParsedPaletteQuery {
  /** The words to find (prefix removed, trimmed). */
  text: string;
  scope: PaletteScope;
  /** Server types to search (scope "types"); undefined: all of them. */
  types?: SearchType[];
  /** The prefix the query started with, as typed (">", "@", "chat:"…). */
  prefix?: string;
}

export interface PalettePrefix {
  prefix: string;
  label: string;
  scope: Exclude<PaletteScope, "all">;
  types?: SearchType[];
}

/** Prefixes the palette understands (shown in its footer and in the empty state). */
export const PALETTE_PREFIXES: PalettePrefix[] = [
  { prefix: ">", label: "Commands", scope: "commands" },
  { prefix: "/", label: "Pages", scope: "pages" },
  { prefix: "@", label: "Agents", scope: "types", types: ["agent"] },
  { prefix: "#", label: "Tasks", scope: "types", types: ["task"] },
  { prefix: "chat:", label: "Chats", scope: "types", types: ["chat", "room"] },
  { prefix: "task:", label: "Tasks", scope: "types", types: ["task"] },
  { prefix: "mission:", label: "Missions", scope: "types", types: ["mission"] },
  { prefix: "agent:", label: "Agents", scope: "types", types: ["agent"] },
  { prefix: "file:", label: "Files", scope: "types", types: ["file"] },
  { prefix: "artifact:", label: "Artifacts", scope: "types", types: ["artifact"] },
  { prefix: "data:", label: "Data", scope: "types", types: ["data"] },
  { prefix: "skill:", label: "Skills", scope: "types", types: ["skill"] },
  { prefix: "memory:", label: "Memory", scope: "types", types: ["memory", "brain"] },
  { prefix: "event:", label: "Events", scope: "types", types: ["event"] },
];

export function parsePaletteQuery(raw: string): ParsedPaletteQuery {
  const trimmed = raw.replace(/^\s+/, "");
  const lower = trimmed.toLowerCase();
  // longest prefix first ("chat:" before "c…"); symbols need nothing after them
  for (const p of [...PALETTE_PREFIXES].sort((a, b) => b.prefix.length - a.prefix.length)) {
    if (lower.startsWith(p.prefix)) {
      return { text: trimmed.slice(p.prefix.length).trim(), scope: p.scope, ...(p.types ? { types: p.types } : {}), prefix: p.prefix };
    }
  }
  return { text: trimmed.trim(), scope: "all" };
}

// ── Local matching (pages, commands) ────────────────────────────────────

const MARKS = /\p{M}+/gu;
export const foldText = (s: string) => s.normalize("NFD").replace(MARKS, "").toLowerCase();

/**
 * How well the query matches a label (and extra keywords): every word must start a word of the
 * label or keywords. 0 = no match; a label starting with the query ranks first.
 */
export function localMatch(query: string, label: string, keywords = ""): { score: number; highlights: SearchRange[] } {
  const q = foldText(query).trim();
  if (!q) return { score: 1, highlights: [] };
  const l = foldText(label);
  const terms = q.split(/\s+/);
  const labelWords = [...l.matchAll(/[\p{L}\p{N}]+/gu)];
  const keyWords = foldText(keywords).match(/[\p{L}\p{N}]+/gu) ?? [];
  const highlights: SearchRange[] = [];
  let score = l.startsWith(q) ? 3 : 1;
  for (const t of terms) {
    const w = labelWords.find((m) => m[0].startsWith(t));
    if (w) {
      highlights.push([w.index ?? 0, (w.index ?? 0) + t.length]);
      continue;
    }
    if (keyWords.some((k) => k.startsWith(t))) { score = Math.min(score, 0.5); continue; }
    if (t.length >= 3 && l.includes(t)) {
      const at = l.indexOf(t);
      highlights.push([at, at + t.length]);
      score = Math.min(score, 0.8);
      continue;
    }
    return { score: 0, highlights: [] };
  }
  return { score, highlights };
}

// ── Pages ───────────────────────────────────────────────────────────────

export interface PageEntry {
  id: string;
  label: string;
  /** Where it sits ("Work", "Settings · Integrations"). */
  section: string;
  to: string;
  icon?: LucideIcon;
  keywords?: string;
}

/** Pages not in the drill-in tree (reached from elsewhere). */
const EXTRA_PAGES: PageEntry[] = [
  { id: "changelog", label: "What's new", section: "Help", to: "/changelog", keywords: "novità changelog release notes" },
];

/** Every page of the dashboard, from the navigation tree (Settings sections included). */
export function pageEntries(nodes: NavEntry[] = DRILL_IN_NAV): PageEntry[] {
  const out: PageEntry[] = [];
  const walk = (entries: NavEntry[], path: string[]) => {
    let section = "";
    for (const e of entries) {
      if (e.kind === "section") { section = e.label; continue; }
      const where = [...path, section].filter(Boolean).join(" · ") || "Pages";
      if (e.kind === "link") out.push({ id: e.id, label: e.label, section: where, to: e.to, icon: e.icon, keywords: `${e.id} ${path.join(" ")}` });
      if (e.kind === "group") {
        if (e.to) out.push({ id: e.id, label: e.label, section: where, to: e.to, icon: e.icon, keywords: e.id });
        walk(e.children, [...path, e.label]);
      }
    }
  };
  walk(nodes, []);
  const seen = new Set<string>();
  return [...out, ...EXTRA_PAGES].filter((p) => (seen.has(p.to) ? false : (seen.add(p.to), true)));
}

// ── Recents (this browser) ──────────────────────────────────────────────

export interface RecentItem {
  key: string;
  kind: SearchType | "page" | "action";
  title: string;
  subtitle?: string;
  url?: string;
  /** For agents: the avatar and colour; for tasks / missions: the status. */
  meta?: Record<string, unknown>;
  at: number;
}

interface RecentState {
  searches: string[];
  items: RecentItem[];
}

const MAX_SEARCHES = 6;
const MAX_ITEMS = 8;
const storageKey = () => `polpo:search:v1:${chatInstanceKey()}`;
/** Used when the browser's storage is blocked (private window, policies): this tab only. */
let memory: RecentState = { searches: [], items: [] };

function readRecents(): RecentState {
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return memory;
    const parsed = JSON.parse(raw) as Partial<RecentState>;
    return {
      searches: Array.isArray(parsed.searches) ? parsed.searches.filter((s): s is string => typeof s === "string").slice(0, MAX_SEARCHES) : [],
      items: Array.isArray(parsed.items) ? parsed.items.filter((i): i is RecentItem => !!i && typeof i.key === "string" && typeof i.title === "string").slice(0, MAX_ITEMS) : [],
    };
  } catch {
    return memory;
  }
}

function writeRecents(state: RecentState): void {
  memory = state;
  try { localStorage.setItem(storageKey(), JSON.stringify(state)); } catch { /* blocked: kept in memory */ }
}

export function getRecents(): RecentState {
  return readRecents();
}

export function rememberSearch(query: string): void {
  const q = query.trim();
  if (q.length < 2) return;
  const state = readRecents();
  writeRecents({ ...state, searches: [q, ...state.searches.filter((s) => s.toLowerCase() !== q.toLowerCase())].slice(0, MAX_SEARCHES) });
}

export function rememberItem(item: Omit<RecentItem, "at">): void {
  const state = readRecents();
  writeRecents({ ...state, items: [{ ...item, at: Date.now() }, ...state.items.filter((i) => i.key !== item.key)].slice(0, MAX_ITEMS) });
}

export function clearRecents(): void {
  writeRecents({ searches: [], items: [] });
}

/** A server result as a recent item (what is needed to show and open it again). */
export function recentFromResult(r: SearchResult): Omit<RecentItem, "at"> {
  const meta: Record<string, unknown> = {};
  for (const k of ["agent", "status", "avatar", "kind", "artifactType"]) if (r.meta?.[k] != null) meta[k] = r.meta[k];
  return { key: `${r.type}:${r.id}`, kind: r.type, title: r.title, ...(r.subtitle ? { subtitle: r.subtitle } : {}), url: r.url, ...(Object.keys(meta).length ? { meta } : {}) };
}

// ── Time ────────────────────────────────────────────────────────────────

/** "now", "5m", "3h", "2d", "Mar 4" — compact, for result rows. */
export function shortAge(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Ranges where the query's words start words of a text (local, for the preview's messages). */
export function queryTermRanges(text: string, query: string): Array<[number, number]> {
  const terms = foldText(query).match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!terms.length) return [];
  const folded = foldText(text);
  // folding may change lengths (ligatures): only highlight when it did not
  if (folded.length !== text.length) return [];
  const out: Array<[number, number]> = [];
  for (const m of folded.matchAll(/[\p{L}\p{N}]+/gu)) {
    const t = terms.find((term) => m[0].startsWith(term.length > 4 ? term.slice(0, -1) : term));
    if (t) out.push([m.index ?? 0, (m.index ?? 0) + Math.min(m[0].length, t.length)]);
    if (out.length > 40) break;
  }
  return out;
}

