/**
 * The decision card's view: DOM from a card (src/server/mcp-decision-card.ts) with no host wiring,
 * so it can be tested in a DOM (ui/tests/mcp-decision-card.test.ts). main.ts connects it to the host.
 *
 *   decision    one decision: each answer with its headline and probability bars, confidence,
 *               uncertain; the model, cost, caller, whether it is calibrated
 *   decisions   the latest decisions, each opening its card
 */
import type { DecisionCard, DecisionCardAnswer, DecisionCardItem, DecisionDetailCard, DecisionListCard } from "../../src/server/mcp-decision-card.js";

export const STRINGS = {
  en: {
    open: "Open", refresh: "Refresh", ask: "Ask about it", back: "Latest decisions", title: "Decisions", noDecisions: "No decisions yet",
    uncertain: "Uncertain", uncalibrated: "Uncalibrated", failed: "Failed", confidence: (c: string) => `confidence ${c}`, threshold: (t: string) => `threshold ${t}`,
    total: (n: number) => `${n} decision${n === 1 ? "" : "s"}`, state: "State", error: "Could not load the card", superseded: "There is a newer card for this below",
    uncalibratedNote: "No decision model is configured: Polpo's own model answered, its probabilities are estimates.",
    askAbout: (id: string) => `Explain the decision ${id}: what does each answer mean, and how sure is it?`,
    askAll: "What have I decided lately, and is anything uncertain?",
  },
  it: {
    open: "Apri", refresh: "Aggiorna", ask: "Chiedi", back: "Ultime decisioni", title: "Decisioni", noDecisions: "Ancora nessuna decisione",
    uncertain: "Incerta", uncalibrated: "Non calibrata", failed: "Fallita", confidence: (c: string) => `confidenza ${c}`, threshold: (t: string) => `soglia ${t}`,
    total: (n: number) => `${n} decision${n === 1 ? "e" : "i"}`, state: "Stato", error: "Non riesco a caricare la scheda", superseded: "C'è una scheda più recente più sotto",
    uncalibratedNote: "Nessun modello di decisione configurato: ha risposto il modello di Polpo, le probabilità sono stime.",
    askAbout: (id: string) => `Spiegami la decisione ${id}: cosa significa ogni risposta e quanto è sicura?`,
    askAll: "Cosa ho deciso di recente, e c'è qualcosa di incerto?",
  },
};
export type Strings = typeof STRINGS.en;
export const stringsFor = (locale: string | undefined): Strings => ((locale ?? "en").toLowerCase().startsWith("it") ? STRINGS.it : STRINGS.en) as Strings;

export interface ViewEnv {
  card?: DecisionCard;
  pending?: string;
  error?: string;
  locale?: string;
  full: boolean;
  canFullscreen: boolean;
  busy: boolean;
  superseded: boolean;
  onOpen?: () => void;
  onAsk?: () => void;
  onRefresh?: () => void;
  /** Switch the card: a decision, or the latest ones (no id). */
  onShow?: (args: { id?: string }) => void;
}

let env: ViewEnv = { full: false, canFullscreen: false, busy: false, superseded: false };

type Child = Node | string | false | null | undefined;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false || v === null) continue;
    if (k === "class") el.className = String(v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== false && c !== null && c !== undefined) el.append(c);
  return el;
}

const pct = (v: number) => `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
const when = (iso: string | undefined, locale: string | undefined) => (iso ? new Date(iso).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }) : "");

function header(title: string, subtitle: string, right?: Child): HTMLElement {
  return h("div", { class: "head" }, h("div", { class: "who" }, h("div", { class: "name" }, title), h("div", { class: "role" }, subtitle)), right);
}

function actions(str: Strings, extra: Child[] = []): HTMLElement {
  return h("div", { class: "actions" },
    env.canFullscreen && !env.full ? h("button", { class: "btn btn-primary", disabled: env.superseded, onclick: () => env.onOpen?.() }, str.open) : null,
    ...extra,
    h("button", { class: "btn", disabled: env.superseded, onclick: () => env.onAsk?.() }, str.ask),
    h("button", { class: "btn", disabled: env.superseded || env.busy, onclick: () => env.onRefresh?.() }, str.refresh));
}

function chips(str: Strings, d: DecisionCardItem): HTMLElement {
  return h("div", { class: "chips" },
    d.status === "error" ? h("span", { class: "chip chip-sm chip-danger" }, str.failed) : null,
    d.uncertain ? h("span", { class: "chip chip-sm chip-warning" }, str.uncertain) : null,
    d.calibrated ? null : h("span", { class: "chip chip-sm chip-info" }, str.uncalibrated));
}

/** One answer: its name and headline, then a bar per outcome (the chosen one marked). */
export function answerView(str: Strings, a: DecisionCardAnswer): HTMLElement {
  const meta = [a.confidence !== undefined ? str.confidence(a.confidence.toFixed(2)) : "", a.threshold !== undefined ? str.threshold(a.threshold.toFixed(2)) : ""].filter(Boolean).join(" · ");
  return h("section", { class: "answer", "data-answer": a.name },
    h("div", { class: "answer-head" },
      h("span", { class: "answer-name" }, a.name),
      h("span", { class: "answer-headline" }, a.headline),
      a.uncertain ? h("span", { class: "chip chip-sm chip-warning" }, str.uncertain) : null),
    meta ? h("div", { class: "muted small" }, meta) : null,
    ...a.bars.map((b) => h("div", { class: `pbar${b.chosen ? " chosen" : ""}`, "data-bar": b.label },
      h("div", { class: "pbar-label" }, h("span", {}, b.label), h("span", { class: "muted" }, a.relative ? "" : pct(b.value))),
      h("div", { class: "bar", role: "meter", "aria-valuemin": "0", "aria-valuemax": "1", "aria-valuenow": String(Math.round(b.value * 1000) / 1000), "aria-label": b.label },
        h("div", { class: "bar-fill", style: `width:${pct(b.value)}` })))));
}

export function detailView(c: DecisionDetailCard, str: Strings): HTMLElement {
  const d = c.decision;
  return h("div", { class: env.full ? "full" : "card", "data-decision": d.id },
    header(d.answers.map((a) => a.headline).join(" · ") || str.title, `${d.model} · $${d.costUsd.toFixed(5)} · ${d.latencyMs} ms · ${d.caller}`),
    chips(str, d),
    d.error ? h("p", { class: "danger small fail-line" }, d.error) : null,
    ...d.answers.map((a) => answerView(str, a)),
    d.calibrated ? null : h("p", { class: "muted small" }, str.uncalibratedNote),
    d.state && env.full ? h("section", {}, h("div", { class: "section-title" }, str.state), h("pre", { class: "code" }, d.state)) : null,
    h("p", { class: "muted small mono" }, `${d.id} · ${when(d.at, env.locale)}`),
    actions(str, [h("button", { class: "btn", disabled: env.superseded || env.busy, onclick: () => env.onShow?.({}) }, str.back)]));
}

export function listView(c: DecisionListCard, str: Strings): HTMLElement {
  return h("div", { class: env.full ? "full" : "card" },
    header(str.title, str.total(c.total)),
    c.decisions.length ? h("div", { class: "decisions" }, ...c.decisions.map((d) => h("div", { class: "row", "data-decision": d.id },
      h("div", { class: "row-main" },
        h("div", {}, h("button", { class: "link-btn", disabled: env.superseded || env.busy, onclick: () => env.onShow?.({ id: d.id }) },
          d.status === "error" ? str.failed : d.answers.map((a) => `${a.name}: ${a.headline}`).join(" · "))),
        h("div", { class: "muted small" }, `${when(d.at, env.locale)} · ${d.caller} · ${d.model}`)),
      chips(str, d)))) : h("p", { class: "muted empty" }, str.noDecisions),
    actions(str));
}

function skeleton(): HTMLElement {
  return h("div", { class: "card", "aria-busy": "true" },
    h("div", { class: "head" }, h("div", { class: "who" }, h("div", { class: "sk sk-line w40" }), h("div", { class: "sk sk-line w60" }))),
    h("div", { class: "sk sk-line w80" }), h("div", { class: "sk sk-line w55" }));
}

/** Draw the card into root. */
export function renderView(root: HTMLElement, next: ViewEnv): void {
  env = next;
  const str = stringsFor(env.locale);
  root.className = env.superseded ? "is-superseded" : "";
  root.replaceChildren(
    env.superseded ? h("div", { class: "banner" }, str.superseded) : "",
    env.error && !env.card ? h("div", { class: "card" }, h("p", { class: "danger" }, `${str.error}: ${env.error}`)) : "",
    !env.card && !env.error ? skeleton() : "",
    env.card?.kind === "decisions" ? listView(env.card, str) : "",
    env.card?.kind === "decision" ? detailView(env.card, str) : "",
    env.card && env.error ? h("p", { class: "danger small" }, env.error) : "",
  );
}
