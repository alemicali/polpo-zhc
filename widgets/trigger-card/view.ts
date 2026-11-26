/**
 * The trigger card's view: DOM from a card (src/server/mcp-trigger-card.ts) with no host wiring, so
 * it can be tested in a DOM (ui/tests/mcp-trigger-card.test.ts). main.ts connects it to the MCP host.
 *
 *   triggers  each trigger with its endpoint, auth, contract version, counts and last delivery
 *   trigger   one trigger: its definition in words, delivery counts, the recent deliveries
 *             (status, HTTP answer, reasons, contract errors), the last mapped values
 */
import type { TriggerCard, TriggerDetailCard, TriggerListCard } from "../../src/server/mcp-trigger-card.js";

export const STRINGS = {
  en: {
    open: "Open", refresh: "Refresh", ask: "Ask about it", back: "All triggers", title: "Triggers", deliveries: "Deliveries",
    noTriggers: "No triggers yet", noDeliveries: "No deliveries yet", never: "no deliveries yet", disabled: "Disabled",
    total: (n: number) => `${n} deliver${n === 1 ? "y" : "ies"}`, mapped: "Last mapped values", filter: "Filter", dedupe: "Dedupe", mapping: "Mapping",
    auth: "Auth", contract: "Contract", rate: (n: number) => `${n}/min`, test: "test", all: "All", error: "Could not load the card", superseded: "There is a newer card for this below",
    noActions: "No actions run on deliveries yet: the action engine comes later.",
    askAbout: (name: string) => `What did the trigger "${name}" receive lately, and is anything being refused?`,
    askAll: "How are my triggers doing?",
    status: { accepted: "Accepted", rejected: "Rejected", filtered: "Filtered", duplicate: "Duplicate", rate_limited: "Rate limited" } as Record<string, string>,
  },
  it: {
    open: "Apri", refresh: "Aggiorna", ask: "Chiedi", back: "Tutti i trigger", title: "Trigger", deliveries: "Consegne",
    noTriggers: "Ancora nessun trigger", noDeliveries: "Ancora nessuna consegna", never: "ancora nessuna consegna", disabled: "Disattivato",
    total: (n: number) => `${n} consegn${n === 1 ? "a" : "e"}`, mapped: "Ultimi valori mappati", filter: "Filtro", dedupe: "Deduplica", mapping: "Mappatura",
    auth: "Autenticazione", contract: "Contratto", rate: (n: number) => `${n}/min`, test: "test", all: "Tutte", error: "Non riesco a caricare la scheda", superseded: "C'è una scheda più recente più sotto",
    noActions: "Per ora le consegne non avviano azioni: il motore delle azioni arriva dopo.",
    askAbout: (name: string) => `Cosa ha ricevuto di recente il trigger "${name}", e qualcosa viene rifiutato?`,
    askAll: "Come stanno andando i miei trigger?",
    status: { accepted: "Accettata", rejected: "Rifiutata", filtered: "Filtrata", duplicate: "Duplicata", rate_limited: "Limitata" } as Record<string, string>,
  },
};
export type Strings = typeof STRINGS.en;
export const stringsFor = (locale: string | undefined): Strings => ((locale ?? "en").toLowerCase().startsWith("it") ? STRINGS.it : STRINGS.en) as Strings;

export interface ViewEnv {
  card?: TriggerCard;
  pending?: string;
  error?: string;
  locale?: string;
  full: boolean;
  canFullscreen: boolean;
  busy: boolean;
  superseded: boolean;
  /** The statuses the trigger view is filtered by. */
  statuses?: string[];
  onOpen?: () => void;
  onAsk?: () => void;
  onRefresh?: () => void;
  /** Switch the card: a trigger (with a status filter), or the list (no id). */
  onShow?: (args: { id?: string; status?: string[] }) => void;
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

const STATUSES = ["accepted", "rejected", "filtered", "duplicate", "rate_limited"];
const tone = (st: string) => (st === "accepted" ? "success" : st === "rejected" ? "danger" : st === "rate_limited" ? "warning" : st === "duplicate" ? "info" : "neutral");
const when = (iso: string | undefined, locale: string | undefined) => (iso ? new Date(iso).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }) : "");
const chip = (str: Strings, st: string) => h("span", { class: `chip chip-sm chip-${tone(st)}`, "data-status": st }, str.status[st] ?? st);
const countsLine = (str: Strings, c: Record<string, number>) => STATUSES.filter((s) => c[s]).map((s) => `${c[s]} ${(str.status[s] ?? s).toLowerCase()}`).join(" · ");

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

export function listView(c: TriggerListCard, str: Strings): HTMLElement {
  return h("div", { class: env.full ? "full" : "card" },
    header(str.title, str.total(c.triggers.reduce((a, t) => a + t.total, 0))),
    c.triggers.length ? h("div", { class: "triggers" }, ...c.triggers.map((t) => h("div", { class: "row", "data-trigger": t.id },
      h("div", { class: "row-main" },
        h("div", {}, h("button", { class: "link-btn", disabled: env.superseded || env.busy, onclick: () => env.onShow?.({ id: t.id }) }, t.name),
          t.enabled ? null : h("span", { class: "chip chip-sm" }, str.disabled)),
        h("div", { class: "muted small mono" }, t.endpoint),
        h("div", { class: "muted small" }, [t.auth.join(" + "), `v${t.contractVersion} ${t.contentTypes.join("/")}`, countsLine(str, t.counts) || str.never].filter(Boolean).join(" · ")),
        t.warning ? h("div", { class: "small danger-text" }, `⚠ ${t.warning}`) : null),
      h("div", { class: "row-actions" },
        t.lastDeliveryAt ? h("span", { class: "muted small" }, when(t.lastDeliveryAt, env.locale)) : null,
        t.lastStatus ? chip(str, t.lastStatus) : null)))) : h("p", { class: "muted empty" }, str.noTriggers),
    h("p", { class: "muted small" }, str.noActions),
    actions(str));
}

export function detailView(c: TriggerDetailCard, str: Strings): HTMLElement {
  const t = c.trigger;
  const facts: Array<[string, string]> = [
    [str.auth, t.auth.join(" + ")],
    [str.contract, `v${t.contractVersion} · ${t.contentTypes.join(", ")} · ${str.rate(t.rateLimitPerMinute)}`],
    ...(t.filter ? [[str.filter, t.filter] as [string, string]] : []),
    ...(t.dedupe ? [[str.dedupe, t.dedupe] as [string, string]] : []),
    ...(t.mapping ? [[str.mapping, Object.entries(t.mapping).map(([k, v]) => `${k} ← ${v}`).join(", ")] as [string, string]] : []),
  ];
  const selected = env.statuses ?? [];
  const toggle = (s?: string) => env.onShow?.({ id: t.id, status: s ? (selected.includes(s) ? selected.filter((x) => x !== s) : [...selected, s]) : [] });
  return h("div", { class: env.full ? "full" : "card", "data-trigger": t.id },
    header(t.name, t.endpoint, t.enabled ? null : h("span", { class: "chip" }, str.disabled)),
    t.description ? h("p", { class: "prose" }, t.description) : null,
    t.warning ? h("p", { class: "danger" }, `⚠ ${t.warning}`) : null,
    h("dl", { class: "facts" }, ...facts.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
    h("div", { class: "chips", role: "group" },
      h("button", { class: `chip-btn${selected.length ? "" : " on"}`, disabled: env.superseded || env.busy, onclick: () => toggle() }, `${str.all} ${t.total}`),
      ...STATUSES.filter((s) => t.counts[s]).map((s) => h("button", { class: `chip-btn${selected.includes(s) ? " on" : ""}`, "data-filter": s, disabled: env.superseded || env.busy, onclick: () => toggle(s) }, `${str.status[s] ?? s} ${t.counts[s]}`))),
    c.deliveries.length ? h("div", { class: "deliveries" }, ...c.deliveries.map((d) => h("div", { class: "row", "data-delivery": d.id },
      h("div", { class: "row-main" },
        h("div", { class: "small" }, when(d.receivedAt, env.locale), ` · HTTP ${d.httpStatus}`, d.kind ? ` · ${d.kind}` : "", d.count && d.count > 1 ? ` · ×${d.count}` : "", d.test ? h("span", { class: "chip chip-sm chip-info" }, str.test) : null),
        d.reasons.length ? h("div", { class: "muted small fail-line" }, d.reasons.join("; ")) : null,
        ...(d.errors ?? []).slice(0, 3).map((e) => h("div", { class: "small danger-text fail-line" }, e)),
        h("div", { class: "muted small mono" }, d.id)),
      chip(str, d.status)))) : h("p", { class: "muted empty" }, str.noDeliveries),
    c.lastMapped ? h("section", { class: "mapped" }, h("div", { class: "section-title" }, str.mapped), h("pre", { class: "code" }, JSON.stringify(c.lastMapped, null, 2))) : null,
    h("p", { class: "muted small" }, str.noActions),
    actions(str, [h("button", { class: "btn", disabled: env.superseded || env.busy, onclick: () => env.onShow?.({}) }, str.back)]));
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
    env.card?.kind === "triggers" ? listView(env.card, str) : "",
    env.card?.kind === "trigger" ? detailView(env.card, str) : "",
    env.card && env.error ? h("p", { class: "danger small" }, env.error) : "",
  );
}
