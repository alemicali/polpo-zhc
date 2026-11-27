/**
 * The computer card's view: DOM from a card (src/server/mcp-computer-card.ts) with no host wiring,
 * so it can be tested in a DOM. main.ts connects it to the MCP host.
 *
 * Live view status, who holds the desktop (the agent, or a person since when), the agents'
 * requests for a person (open first), Take control / Give back (with a note for the agent), the
 * link to the live view in the dashboard (where the person types: never in the chat).
 */
import type { ComputerCard } from "../../src/server/mcp-computer-card.js";

export const STRINGS = {
  en: {
    open: "Open", refresh: "Refresh", ask: "Ask about it", openLive: "Open the live view", take: "Take control", give: "Give back",
    agentHolds: "The agent has control", personHolds: (p: string, since: string) => `${p} has control since ${since}: the agent's browser waits`,
    live: { running: "Live view on", stopped: "Live view off", "machine-off": "Machine off", unsupported: "No live view" } as Record<string, string>,
    waiting: "Waiting for a person", recent: "Recent requests", none: "No agent is waiting for a person.", until: (t: string) => `waits until ${t}`,
    status: { pending: "Waiting", in_control: "In control", released: "Given back", timeout: "Timed out", cancelled: "Cancelled" } as Record<string, string>,
    notePlaceholder: "Note for the agent (optional, never a password)", lastNote: "Last note", page: "Page", todo: "To do",
    error: "Could not load the card", superseded: "There is a newer card for this below",
    typeHere: "Type passwords and codes in the live view, never in the chat.",
    askAbout: (name: string) => `What is the computer "${name}" doing, and is an agent waiting for me?`,
  },
  it: {
    open: "Apri", refresh: "Aggiorna", ask: "Chiedi", openLive: "Apri la vista dal vivo", take: "Prendi il controllo", give: "Restituisci",
    agentHolds: "Il controllo è dell'agente", personHolds: (p: string, since: string) => `${p} ha il controllo dalle ${since}: il browser dell'agente aspetta`,
    live: { running: "Vista dal vivo attiva", stopped: "Vista dal vivo spenta", "machine-off": "Macchina spenta", unsupported: "Nessuna vista dal vivo" } as Record<string, string>,
    waiting: "In attesa di una persona", recent: "Richieste recenti", none: "Nessun agente aspetta una persona.", until: (t: string) => `aspetta fino alle ${t}`,
    status: { pending: "In attesa", in_control: "Controllo preso", released: "Restituito", timeout: "Scaduta", cancelled: "Annullata" } as Record<string, string>,
    notePlaceholder: "Nota per l'agente (facoltativa, mai una password)", lastNote: "Ultima nota", page: "Pagina", todo: "Da fare",
    error: "Non riesco a caricare la scheda", superseded: "C'è una scheda più recente più sotto",
    typeHere: "Password e codici si scrivono nella vista dal vivo, mai in chat.",
    askAbout: (name: string) => `Cosa sta facendo il computer "${name}", e c'è un agente che mi aspetta?`,
  },
};
export type Strings = typeof STRINGS.en;
export const stringsFor = (locale: string | undefined): Strings => ((locale ?? "en").toLowerCase().startsWith("it") ? STRINGS.it : STRINGS.en) as Strings;

export interface ViewEnv {
  card?: ComputerCard;
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
  onTake?: () => void;
  onGive?: (note: string) => void;
  onLink?: (url: string) => void;
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

const when = (iso: string | undefined, locale: string | undefined) => (iso ? new Date(iso).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }) : "");
const tone = (st: string) => (st === "pending" ? "warning" : st === "in_control" ? "info" : st === "released" ? "success" : st === "timeout" ? "danger" : "neutral");
const OPEN = new Set(["pending", "in_control"]);

export function computerView(c: ComputerCard, str: Strings): HTMLElement {
  const person = c.control.holder === "person";
  const open = c.requests.filter((r) => OPEN.has(r.status));
  const recent = c.requests.filter((r) => !OPEN.has(r.status));
  const note = h("input", { class: "note-input", type: "text", maxlength: "2000", placeholder: str.notePlaceholder, "aria-label": str.notePlaceholder });
  const disabled = env.superseded || env.busy;
  const request = (r: ComputerCard["requests"][number]) => h("div", { class: "row", "data-request": r.id },
    h("div", { class: "row-main" },
      h("div", { class: "small req-reason" }, h("strong", {}, r.agent), `: ${r.reason}`),
      r.url ? h("div", { class: "muted small" }, `${str.page}: ${r.url}`) : null,
      r.whatToDo ? h("div", { class: "muted small" }, `${str.todo}: ${r.whatToDo}`) : null,
      OPEN.has(r.status) ? h("div", { class: "muted small" }, str.until(when(r.expiresAt, env.locale))) : null,
      r.note ? h("div", { class: "muted small" }, `${str.lastNote}: ${r.note}`) : null),
    h("span", { class: `chip chip-sm chip-${tone(r.status)}`, "data-status": r.status }, str.status[r.status] ?? r.status));
  return h("div", { class: env.full ? "full" : "card", "data-computer": c.computer.id },
    h("div", { class: "head" },
      h("div", { class: "who" }, h("div", { class: "name" }, c.computer.name), h("div", { class: "role" }, `${c.computer.kind} · ${c.computer.status}`)),
      h("span", { class: `chip ${c.desktop.state === "running" ? "chip-success" : ""}`, "data-live": c.desktop.state }, str.live[c.desktop.state] ?? c.desktop.state)),
    h("p", { class: person ? "prose" : "muted small", "data-holder": c.control.holder },
      person ? str.personHolds(c.control.person ?? "?", when(c.control.since, env.locale)) : str.agentHolds),
    !person && c.control.lastNote ? h("p", { class: "muted small" }, `${str.lastNote}: ${c.control.lastNote}`) : null,
    c.desktop.error ? h("p", { class: "small danger-text" }, c.desktop.error) : null,
    open.length ? h("section", {}, h("div", { class: "section-title" }, str.waiting), h("div", { class: "requests" }, ...open.map(request)))
      : h("p", { class: "muted small empty" }, str.none),
    recent.length && env.full ? h("section", {}, h("div", { class: "section-title" }, str.recent), h("div", { class: "requests" }, ...recent.map(request))) : null,
    person ? note : null,
    h("p", { class: "muted small" }, str.typeHere),
    h("div", { class: "actions" },
      c.link ? h("button", { class: "btn btn-primary", disabled: env.superseded, onclick: () => env.onLink?.(c.link!) }, str.openLive) : null,
      person
        ? h("button", { class: "btn", "data-action": "give", disabled, onclick: () => env.onGive?.(note.value.trim()) }, str.give)
        : h("button", { class: "btn", "data-action": "take", disabled, onclick: () => env.onTake?.() }, str.take),
      env.canFullscreen && !env.full ? h("button", { class: "btn", disabled: env.superseded, onclick: () => env.onOpen?.() }, str.open) : null,
      h("button", { class: "btn", disabled: env.superseded, onclick: () => env.onAsk?.() }, str.ask),
      h("button", { class: "btn", disabled, onclick: () => env.onRefresh?.() }, str.refresh)));
}

export function renderView(root: HTMLElement, next: ViewEnv): void {
  env = next;
  const str = stringsFor(next.locale);
  const body = next.error && !next.card
    ? h("div", { class: "card" }, h("p", { class: "danger" }, `${str.error}: ${next.error}`))
    : next.card
      ? computerView(next.card, str)
      : h("div", { class: "card" }, h("div", { class: "sk sk-line" }), h("div", { class: "sk sk-line" }));
  root.replaceChildren(
    ...(next.superseded ? [h("div", { class: "banner" }, str.superseded)] : []),
    ...(next.error && next.card ? [h("p", { class: "danger small" }, next.error)] : []),
    body,
  );
}
