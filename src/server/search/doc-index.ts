/**
 * An inverted index over one source's documents, so a query costs a pass over the vocabulary
 * (each distinct word once) instead of over every word of every document: lumea-sized lists
 * (20 000 files, a thousand tasks, long memories) answer in a few milliseconds.
 *
 * Built when a source's documents load (and again when they refresh); the scores are the ones
 * scoreDoc() gives (src/server/search/engine.ts), computed from the postings.
 */
import { fold, stem, termWordScore, words, type ParsedQuery } from "./text.js";

export interface IndexedDoc<D> {
  doc: D;
  score: number;
  /** A word matched only in the content (the result shows a snippet of it). */
  inBody: boolean;
}

interface Entry {
  stem: string;
  title: number[];
  sub: number[];
  body: number[];
}

const DAY = 86_400_000;

export class DocIndex<D extends { title: string; subtitle?: string; keywords?: string; body?: string; updatedAt?: string }> {
  private readonly titles: string[];
  private readonly updated: number[];
  private readonly vocab = new Map<string, Entry>();

  constructor(readonly docs: readonly D[]) {
    this.titles = docs.map((d) => fold(d.title).replace(/\s+/g, " ").trim());
    this.updated = docs.map((d) => (d.updatedAt ? Date.parse(d.updatedAt) || 0 : 0));
    docs.forEach((d, i) => {
      this.add(words(d.title), i, "title");
      this.add(words(`${d.subtitle ?? ""} ${d.keywords ?? ""}`), i, "sub");
      if (d.body) this.add(words(d.body), i, "body");
    });
  }

  private add(list: string[], i: number, field: "title" | "sub" | "body"): void {
    for (const w of new Set(list)) {
      let e = this.vocab.get(w);
      if (!e) this.vocab.set(w, (e = { stem: stem(w), title: [], sub: [], body: [] }));
      e[field].push(i);
    }
  }

  /** The documents matching the query, scored (unsorted). */
  search(q: ParsedQuery, now = Date.now()): Array<IndexedDoc<D>> {
    const n = this.docs.length;
    if (!q.terms.length || !n) return [];
    // per term and field, each document's best word score
    const best = q.terms.map(() => ({ title: new Float32Array(n), sub: new Float32Array(n), body: new Float32Array(n) }));
    for (const [word, e] of this.vocab) {
      q.terms.forEach((t, j) => {
        const s = termWordScore(t, word, e.stem);
        if (!s) return;
        const b = best[j]!;
        for (const d of e.title) if (s > b.title[d]!) b.title[d] = s;
        for (const d of e.sub) if (s > b.sub[d]!) b.sub[d] = s;
        for (const d of e.body) if (s > b.body[d]!) b.body[d] = s;
      });
    }
    const out: Array<IndexedDoc<D>> = [];
    for (let d = 0; d < n; d++) {
      let tier = 0;
      let quality = 0;
      let inBody = false;
      const title = this.titles[d]!;
      if (title === q.folded) { tier = 1000; quality = 1; }
      else if (q.folded.length >= 2 && title.startsWith(q.folded)) { tier = 850; quality = 1; }
      else {
        let worst = 3;
        let sum = 0;
        let titleSum = 0;
        let allInTitle = true;
        for (const b of best) {
          const ts = b.title[d]!, ss = b.sub[d]!, bs = b.body[d]!;
          const top = Math.max(ts, ss * 0.95, bs * 0.9);
          if (!top) { worst = 0; break; }
          sum += top;
          titleSum += ts;
          if (!ts) allInTitle = false;
          const field = ts >= ss && ts >= bs ? 3 : ss >= bs ? 2 : 1;
          if (field < worst) worst = field;
          if (field === 1) inBody = true;
        }
        if (!worst) continue;
        if (allInTitle) { tier = 600; quality = titleSum / best.length; inBody = false; }
        else { tier = worst === 3 ? 600 : worst === 2 ? 400 : 200; quality = sum / best.length; }
      }
      const u = this.updated[d]!;
      const recency = u ? 60 * Math.exp(-Math.max(0, (now - u) / DAY) / 14) : 0;
      out.push({ doc: this.docs[d]!, score: Math.round(tier + 100 * quality + recency), inBody });
    }
    return out;
  }
}
