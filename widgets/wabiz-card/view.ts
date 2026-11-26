/**
 * The WhatsApp Business card's view: DOM from a card (src/server/mcp-wabiz-card.ts) with no host
 * wiring, so it can be tested in a DOM (ui/tests/mcp-wabiz-card.test.ts). main.ts connects it.
 *
 *   overview     status (state, number, quality, tier, templates today), the templates waiting for
 *                approval (approve / reject), the recent conversations with photo thumbnails
 *   transcript   one conversation as it looks in WhatsApp: bubbles with photos, voice notes,
 *                documents, buttons, lists, links, flows, products, locations, orders, reactions, ticks
 */
import type { WabizCard, WabizCardConversation, WabizCardMessage, WabizCardPending } from "../../src/server/mcp-wabiz-card.js";

export const STRINGS = {
  en: {
    open: "Open", refresh: "Refresh", ask: "Ask about it", back: "Conversations", title: "WhatsApp Business", conversations: "Recent conversations",
    noConversations: "No conversations yet", pending: "Waiting for approval", approve: "Approve", reject: "Reject", windowOpen: "Window open",
    windowClosed: "Window closed", optedOut: "Opted out", blocked: "Blocked", templatesToday: (n: number, cap: number) => `templates today ${n}/${cap}`,
    quality: (q: string) => `quality ${q}`, missing: (m: string) => `Missing: ${m}`, error: "Could not load the card", superseded: "There is a newer card for this below",
    deleted: "Deleted", edited: "edited", forwarded: "Forwarded", voice: "Voice message", photo: "Photo", video: "Video", audio: "Audio", document: "Document", sticker: "Sticker",
    notKept: "not kept", location: "Location", flow: "Flow", products: "Products", order: "Order", total: "Total", read: "read", failed: "failed",
    waiting: "waiting for approval", rejected: "rejected", by: (who: string) => `by ${who}`, until: (t: string) => `until ${t}`,
    state: { receiving: "Receiving", configured: "Configured", "not-configured": "Not configured" } as Record<string, string>,
    askAbout: (who: string) => `Summarize my WhatsApp Business conversation with ${who}: what do they want, and what should I answer?`,
    askAll: "How is my WhatsApp Business number doing, and what is waiting for me?",
  },
  it: {
    open: "Apri", refresh: "Aggiorna", ask: "Chiedi", back: "Conversazioni", title: "WhatsApp Business", conversations: "Conversazioni recenti",
    noConversations: "Ancora nessuna conversazione", pending: "In attesa di approvazione", approve: "Approva", reject: "Rifiuta", windowOpen: "Finestra aperta",
    windowClosed: "Finestra chiusa", optedOut: "Disiscritto", blocked: "Bloccato", templatesToday: (n: number, cap: number) => `template oggi ${n}/${cap}`,
    quality: (q: string) => `qualità ${q}`, missing: (m: string) => `Manca: ${m}`, error: "Non riesco a caricare la scheda", superseded: "C'è una scheda più recente più sotto",
    deleted: "Eliminato", edited: "modificato", forwarded: "Inoltrato", voice: "Messaggio vocale", photo: "Foto", video: "Video", audio: "Audio", document: "Documento", sticker: "Sticker",
    notKept: "non conservato", location: "Posizione", flow: "Flow", products: "Prodotti", order: "Ordine", total: "Totale", read: "letto", failed: "non consegnato",
    waiting: "in attesa di approvazione", rejected: "rifiutato", by: (who: string) => `da ${who}`, until: (t: string) => `fino alle ${t}`,
    state: { receiving: "Riceve", configured: "Configurato", "not-configured": "Non configurato" } as Record<string, string>,
    askAbout: (who: string) => `Riassumi la conversazione WhatsApp Business con ${who}: cosa vuole e cosa dovrei rispondere?`,
    askAll: "Come va il mio numero WhatsApp Business e cosa mi aspetta?",
  },
};
export type Strings = typeof STRINGS.en;
export const stringsFor = (locale: string | undefined): Strings => ((locale ?? "en").toLowerCase().startsWith("it") ? STRINGS.it : STRINGS.en) as Strings;

export interface ViewEnv {
  card?: WabizCard;
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
  /** Switch the card: a conversation, or the overview (no to). */
  onShow?: (args: { to?: string }) => void;
  /** Approve or reject a queued template (the click is the person's decision). */
  onDecide?: (id: string, approve: boolean) => void;
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
const time = (iso: string | undefined, locale: string | undefined) => (iso ? new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) : "");

function header(title: string, subtitle: string): HTMLElement {
  return h("div", { class: "head" }, h("div", { class: "who" }, h("div", { class: "name" }, title), h("div", { class: "role" }, subtitle)));
}

function actions(str: Strings, extra: Child[] = []): HTMLElement {
  return h("div", { class: "actions" },
    env.canFullscreen && !env.full ? h("button", { class: "btn btn-primary", disabled: env.superseded, onclick: () => env.onOpen?.() }, str.open) : null,
    ...extra,
    h("button", { class: "btn", disabled: env.superseded, onclick: () => env.onAsk?.() }, str.ask),
    h("button", { class: "btn", disabled: env.superseded || env.busy, onclick: () => env.onRefresh?.() }, str.refresh));
}

function statusChips(str: Strings, c: WabizCard): HTMLElement {
  const s = c.status;
  const tone = s.state === "receiving" ? "chip-success" : s.state === "configured" ? "chip-info" : "chip-warning";
  return h("div", { class: "chips" },
    h("span", { class: `chip chip-sm ${tone}`, "data-state": s.state }, str.state[s.state] ?? s.state),
    s.quality ? h("span", { class: `chip chip-sm ${s.quality === "GREEN" ? "chip-success" : s.quality === "RED" ? "chip-danger" : "chip-warning"}` }, str.quality(s.quality)) : null,
    s.tier ? h("span", { class: "chip chip-sm" }, s.tier) : null,
    h("span", { class: "chip chip-sm" }, str.templatesToday(s.sentToday, s.cap)));
}

function pendingRow(str: Strings, p: WabizCardPending): HTMLElement {
  return h("div", { class: "row", "data-pending": p.id },
    h("div", { class: "row-main" },
      h("div", {}, h("span", { class: "mono" }, p.template), ` (${p.language}) → ${p.to}`),
      p.preview ? h("div", { class: "small preview" }, p.preview) : null,
      h("div", { class: "muted small" }, [str.by(p.requestedBy), when(p.requestedAt, env.locale), p.reason ?? ""].filter(Boolean).join(" · "))),
    h("div", { class: "row-actions" },
      h("button", { class: "btn btn-sm btn-primary", disabled: env.superseded || env.busy, onclick: () => env.onDecide?.(p.id, true) }, str.approve),
      h("button", { class: "btn btn-sm", disabled: env.superseded || env.busy, onclick: () => env.onDecide?.(p.id, false) }, str.reject)));
}

function conversationRow(str: Strings, c: WabizCardConversation): HTMLElement {
  return h("div", { class: "row conv", "data-contact": c.waId },
    c.thumb ? h("img", { class: "thumb", src: c.thumb, alt: "" }) : h("div", { class: "thumb thumb-empty", "aria-hidden": "true" }, (c.name ?? c.masked).slice(0, 1).toUpperCase()),
    h("div", { class: "row-main" },
      h("button", { class: "link-btn", disabled: env.superseded || env.busy, onclick: () => env.onShow?.({ to: c.waId }) }, c.name ?? c.masked),
      c.last ? h("div", { class: "muted small last" }, `${c.lastDir === "out" ? "→ " : ""}${c.last}`) : null),
    h("div", { class: "chips" },
      h("span", { class: `chip chip-sm ${c.windowOpen ? "chip-success" : ""}` }, c.windowOpen ? str.windowOpen : str.windowClosed),
      c.optedOut ? h("span", { class: "chip chip-sm chip-warning" }, str.optedOut) : null,
      c.blocked ? h("span", { class: "chip chip-sm chip-danger" }, str.blocked) : null,
      c.lastAt ? h("span", { class: "muted small" }, time(c.lastAt, env.locale)) : null));
}

const MEDIA_LABEL = (str: Strings, kind: string, voice?: boolean) => (voice ? str.voice : ({ image: str.photo, video: str.video, audio: str.audio, document: str.document, sticker: str.sticker } as Record<string, string>)[kind] ?? kind);

function tick(str: Strings, status: string): string {
  if (status === "read") return `✓✓ ${str.read}`;
  if (status === "delivered") return "✓✓";
  if (status === "sent" || status === "accepted") return "✓";
  if (status === "failed") return str.failed;
  if (status === "pending_approval") return str.waiting;
  if (status === "rejected") return str.rejected;
  return "";
}

/** One message as a WhatsApp bubble. */
export function bubble(str: Strings, m: WabizCardMessage): HTMLElement {
  return h("div", { class: `bubble ${m.dir === "in" ? "in" : "out"}`, "data-message": m.id, "data-type": m.type },
    m.forwarded ? h("div", { class: "muted small" }, str.forwarded) : null,
    m.template ? h("div", { class: "muted small mono" }, m.template) : null,
    m.media ? (m.media.thumb
      ? h("img", { class: "photo", src: m.media.thumb, alt: m.media.caption ?? MEDIA_LABEL(str, m.media.kind) })
      : h("div", { class: "media", "data-media": m.media.voice ? "voice" : m.media.kind },
        `${MEDIA_LABEL(str, m.media.kind, m.media.voice)}${m.media.filename ? ` · ${m.media.filename}` : ""}${m.media.skipped ? ` (${str.notKept})` : ""}`)) : null,
    m.reply ? h("div", { class: "reply" }, m.reply) : null,
    m.revoked ? h("div", { class: "muted small" }, str.deleted) : m.text ? h("div", { class: "text" }, m.text) : null,
    m.location ? h("div", { class: "media", "data-media": "location" }, `${str.location}: ${m.location.name ? `${m.location.name} · ` : ""}${m.location.latitude}, ${m.location.longitude}`) : null,
    m.link ? h("div", { class: "wa-btn", "data-kind": "link" }, `↗ ${m.link.text}`) : null,
    m.flow ? h("div", { class: "wa-btn", "data-kind": "flow" }, m.flow) : null,
    ...(m.buttons ?? []).map((b) => h("div", { class: "wa-btn", "data-kind": "button" }, b)),
    m.rows?.length ? h("ul", { class: "rows" }, ...m.rows.map((r) => h("li", {}, r))) : null,
    m.products?.length ? h("div", { class: "media", "data-media": "products" }, `${str.products}: ${m.products.join(", ")}`) : null,
    m.order ? h("div", { class: "media", "data-media": "order" }, `${str.order}: ${m.order.lines.join(", ")}${m.order.total ? ` · ${str.total} ${m.order.total}` : ""}`) : null,
    h("div", { class: "meta" },
      m.reactions?.length ? h("span", { class: "reactions" }, m.reactions.join(" ")) : null,
      m.edited ? h("span", {}, str.edited) : null,
      h("span", {}, time(m.at, env.locale)),
      m.dir === "out" ? h("span", { class: `tick${m.status === "read" ? " tick-read" : m.status === "failed" ? " danger-text" : ""}` }, tick(str, m.status)) : null),
    m.error ? h("div", { class: "danger-text small" }, m.error) : null);
}

export function transcriptView(c: WabizCard, str: Strings): HTMLElement {
  const t = c.transcript!;
  return h("div", { class: env.full ? "full" : "card", "data-transcript": t.waId },
    header(t.name ?? t.masked, `${c.channel} · ${t.masked}`),
    h("div", { class: "chips" },
      h("span", { class: `chip chip-sm ${t.windowOpen ? "chip-success" : ""}` }, t.windowOpen ? `${str.windowOpen}${t.closesAt ? ` ${str.until(time(t.closesAt, env.locale))}` : ""}` : str.windowClosed),
      t.optedOut ? h("span", { class: "chip chip-sm chip-warning" }, str.optedOut) : null),
    h("div", { class: "chat" }, ...t.messages.map((m) => bubble(str, m))),
    actions(str, [h("button", { class: "btn", disabled: env.superseded || env.busy, onclick: () => env.onShow?.({}) }, str.back)]));
}

export function overviewView(c: WabizCard, str: Strings): HTMLElement {
  const s = c.status;
  return h("div", { class: env.full ? "full" : "card" },
    header(`${str.title} · ${c.channel}`, [s.phone, s.agent ? `→ ${s.agent}` : s.audience].filter(Boolean).join(" · ")),
    statusChips(str, c),
    s.missing.length ? h("p", { class: "small warning-text" }, str.missing(s.missing.join(", "))) : null,
    s.lastError ? h("p", { class: "danger small fail-line" }, s.lastError) : null,
    s.lastAccountEvent ? h("p", { class: "muted small" }, s.lastAccountEvent) : null,
    c.pending.length ? h("section", { class: "pending" }, h("div", { class: "section-title" }, `${str.pending} (${c.pending.length})`), ...c.pending.map((p) => pendingRow(str, p))) : null,
    h("section", {}, h("div", { class: "section-title" }, str.conversations),
      c.conversations.length ? h("div", { class: "convs" }, ...c.conversations.map((x) => conversationRow(str, x))) : h("p", { class: "muted empty" }, str.noConversations)),
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
    env.card && env.card.transcript ? transcriptView(env.card, str) : "",
    env.card && !env.card.transcript ? overviewView(env.card, str) : "",
    env.card && env.error ? h("p", { class: "danger small" }, env.error) : "",
  );
}
