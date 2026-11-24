/**
 * Text matching for the global search (GET /api/v1/search): folding (lowercase, no diacritics),
 * light Italian + English plural folding, word-prefix and one-typo matching, snippets with the
 * matched ranges, and masking of secrets in what is shown.
 *
 * Everything works on "folded" text: each character lowercased and stripped of its diacritics,
 * with a map back to the original positions so highlights land on the text as written.
 */

const MARKS = /\p{M}+/gu;
const WORD = /[\p{L}\p{N}]+/gu;

/** One character (or a few, for ligatures) as the search compares it. */
function foldChar(ch: string): string {
  return ch.normalize("NFD").replace(MARKS, "").toLowerCase();
}

/** Lowercase, without diacritics ("Perché Città" → "perche citta"). */
export function fold(text: string): string {
  return text.normalize("NFD").replace(MARKS, "").toLowerCase();
}

/** The folded text and, for each of its characters, the index of the original character. */
export function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  let i = 0;
  for (const ch of text) {
    const f = foldChar(ch);
    for (let k = 0; k < f.length; k++) map.push(i);
    folded += f;
    i += ch.length;
  }
  map.push(i);
  return { folded, map };
}

/** Words of a text, folded. */
export function words(text: string): string[] {
  return fold(text).match(WORD) ?? [];
}

/**
 * Light stemming for Italian and English: plurals and the final vowel fold to one stem
 * ("agenti", "agente", "agents" → "agent"; "missioni" → "mission"; "stories" → "stori").
 * Short words are left alone (a stem of 3 letters would match too much).
 */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4) {
    if (w.endsWith("ies")) w = `${w.slice(0, -3)}i`;
    else if (/(?:ss|sh|ch|x|z)es$/.test(w)) w = w.slice(0, -2);
    else if (w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  }
  if (w.length > 4 && /[aeiou]$/.test(w)) w = w.slice(0, -1);
  return w;
}

/** Edit distance between a and b, stopping early once it exceeds `max` (returns max + 1). */
export function editDistance(a: string, b: string, max = 1): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let prevPrev: number[] | null = null;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      // a swap of two neighbours is one edit (Damerau)
      if (prevPrev && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prevPrev[j - 2]! + 1);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prevPrev = prev;
    prev = cur;
  }
  return prev[b.length]!;
}

export interface QueryTerm {
  /** The word as typed, folded. */
  text: string;
  /** Its stem (stem()). */
  stem: string;
  /** Long enough to forgive one typo. */
  fuzzy: boolean;
}

export interface ParsedQuery {
  /** The query folded and trimmed (for exact / prefix comparisons with titles). */
  folded: string;
  terms: QueryTerm[];
}

/** Words shorter than this forgive no typo. */
const FUZZY_MIN = 5;

export function parseQuery(q: string): ParsedQuery {
  const folded = fold(q).replace(/\s+/g, " ").trim();
  const seen = new Set<string>();
  const terms: QueryTerm[] = [];
  for (const w of folded.match(WORD) ?? []) {
    if (seen.has(w)) continue;
    seen.add(w);
    terms.push({ text: w, stem: stem(w), fuzzy: w.length >= FUZZY_MIN });
  }
  return { folded, terms: terms.slice(0, 8) };
}

/** How well one query term matches one word of a text (0: not at all). */
export function termWordScore(term: QueryTerm, word: string): number {
  if (word === term.text) return 1;
  if (word.startsWith(term.text)) return 0.85;
  const ws = stem(word);
  if (ws === term.stem) return 0.8;
  if (term.stem.length >= 3 && ws.startsWith(term.stem)) return 0.7;
  if (term.fuzzy && word.length >= FUZZY_MIN - 1) {
    // one typo: against the whole word, or against its beginning (the word is still being typed)
    if (editDistance(term.text, word) <= 1) return 0.55;
    if (word.length > term.text.length && editDistance(term.text, word.slice(0, term.text.length)) <= 1) return 0.5;
  }
  if (term.text.length >= 3 && word.includes(term.text)) return 0.4;
  return 0;
}

/** Best score of a term over the words of a text. */
export function termScore(term: QueryTerm, textWords: readonly string[]): number {
  let best = 0;
  for (const w of textWords) {
    const s = termWordScore(term, w);
    if (s > best) {
      best = s;
      if (best === 1) break;
    }
  }
  return best;
}

/**
 * How well every term matches the text: the mean of the terms' best scores, or 0 when a term
 * matches nothing (all words must be there).
 */
export function matchScore(query: ParsedQuery, textWords: readonly string[]): number {
  if (!query.terms.length || !textWords.length) return 0;
  let sum = 0;
  for (const t of query.terms) {
    const s = termScore(t, textWords);
    if (!s) return 0;
    sum += s;
  }
  return sum / query.terms.length;
}

/** A matched range [start, end) in a shown string. */
export type Range = [number, number];

/** The ranges of a text (as written) where the query's terms match. */
export function highlightRanges(text: string, query: ParsedQuery, maxRanges = 24): Range[] {
  if (!query.terms.length || !text) return [];
  const { folded, map } = foldWithMap(text);
  const ranges: Range[] = [];
  for (const m of folded.matchAll(WORD)) {
    const word = m[0];
    const start = m.index ?? 0;
    for (const t of query.terms) {
      const s = termWordScore(t, word);
      if (!s) continue;
      // the typed part of a prefix or inner match, the whole word for a stem or a typo
      const at = word.startsWith(t.text) ? 0 : word.indexOf(t.text);
      const [from, len] = at >= 0 ? [at, t.text.length] : [0, word.length];
      const a = start + from;
      ranges.push([map[a]!, map[Math.min(a + len, map.length - 1)]!]);
      break;
    }
    if (ranges.length >= maxRanges) break;
  }
  return ranges;
}

export interface Snippet {
  text: string;
  highlights: Range[];
}

/**
 * A window of the text around the first match (whole words, with … where cut), its matched
 * ranges relative to the window. Whitespace runs are collapsed first.
 */
export function snippet(text: string, query: ParsedQuery, width = 180): Snippet {
  const clean = text.replace(/\s+/g, " ").trim();
  const all = highlightRanges(clean, query, 200);
  if (clean.length <= width) return { text: clean, highlights: all.slice(0, 24) };
  const first = all[0]?.[0] ?? 0;
  let start = Math.max(0, first - Math.floor(width / 3));
  if (start > 0) {
    const space = clean.indexOf(" ", start);
    if (space !== -1 && space < first) start = space + 1;
  }
  let end = Math.min(clean.length, start + width);
  if (end < clean.length) {
    const space = clean.lastIndexOf(" ", end);
    if (space > first) end = space;
  }
  const prefix = start > 0 ? "… " : "";
  const suffix = end < clean.length ? " …" : "";
  const shift = prefix.length - start;
  return {
    text: `${prefix}${clean.slice(start, end)}${suffix}`,
    highlights: all.filter(([a, b]) => a >= start && b <= end).slice(0, 24).map(([a, b]) => [a + shift, b + shift] as Range),
  };
}

// ── Secrets ───────────────────────────────────────────────────────────

const MASK = "••••••";

/** Things that look like credentials: API keys of known shapes, bearer tokens, JWTs, private keys, key=value secrets. */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)-(?:[a-z]+-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{12,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bpolpo_[A-Za-z0-9_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b[0-9]{8,10}:[A-Za-z0-9_-]{35}\b/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b[a-f0-9]{48,}\b/gi,
];
/** key = value / key: value with a secret-sounding key: the value is masked, the key kept. */
const SECRET_ASSIGNMENT = /\b((?:api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|private[_-]?key)\b["']?\s*[:=]\s*["']?)([^\s"',;]{4,})/gi;

/** The text with anything that looks like a secret replaced by •••••• (never shown in results). */
export function maskSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, scheme?: string) => (typeof scheme === "string" && /^(bearer|basic)$/i.test(scheme) ? `${scheme} ${MASK}` : MASK));
  }
  return out.replace(SECRET_ASSIGNMENT, (_m, key: string) => `${key}${MASK}`);
}
