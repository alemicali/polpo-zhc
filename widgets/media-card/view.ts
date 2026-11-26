/**
 * The media card's view: DOM from a card (src/server/mcp-media-card.ts) with no host wiring, so it
 * can be tested in a DOM (ui/tests/mcp-media-card.test.ts). main.ts connects it to the host.
 *
 *   image   one request: its images (previews), the prompt, model, size, seed, cost, who asked
 *   media   the latest requests, each with a preview, each opening its card
 */
import type { MediaCard, MediaCardItem, MediaDetailCard, MediaListCard } from "../../src/server/mcp-media-card.js";

export const STRINGS = {
  en: {
    open: "Open", refresh: "Refresh", ask: "Ask about it", back: "Latest images", title: "Images", noImages: "No images yet",
    failed: "Failed", fallback: "Fallback model", prompt: "Prompt", noPreview: "No preview", error: "Could not load the card",
    superseded: "There is a newer card for this below", total: (n: number) => `${n} request${n === 1 ? "" : "s"}`,
    image: (i: number) => `Image ${i + 1}`,
    askAbout: (id: string) => `Tell me about the images ${id}: what was asked, and should we make variants?`,
    askAll: "Which images were generated lately, and what did they cost?",
  },
  it: {
    open: "Apri", refresh: "Aggiorna", ask: "Chiedi", back: "Ultime immagini", title: "Immagini", noImages: "Ancora nessuna immagine",
    failed: "Fallita", fallback: "Modello di riserva", prompt: "Prompt", noPreview: "Nessuna anteprima", error: "Non riesco a caricare la scheda",
    superseded: "C'è una scheda più recente più sotto", total: (n: number) => `${n} richiest${n === 1 ? "a" : "e"}`,
    image: (i: number) => `Immagine ${i + 1}`,
    askAbout: (id: string) => `Parlami delle immagini ${id}: cosa è stato chiesto, e facciamo delle varianti?`,
    askAll: "Quali immagini sono state generate di recente, e quanto sono costate?",
  },
};
export type Strings = typeof STRINGS.en;
export const stringsFor = (locale: string | undefined): Strings => ((locale ?? "en").toLowerCase().startsWith("it") ? STRINGS.it : STRINGS.en) as Strings;

export interface ViewEnv {
  card?: MediaCard;
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
  /** Switch the card: a request, or the latest ones (no id). */
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

const when = (iso: string | undefined, locale: string | undefined) => (iso ? new Date(iso).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }) : "");
/** Only data: image previews are shown (the card loads nothing). */
const safeSrc = (src: string | undefined) => (src && /^data:image\/(png|jpeg|webp|gif);base64,/.test(src) ? src : undefined);

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

function chips(str: Strings, e: MediaCardItem): HTMLElement {
  return h("div", { class: "chips" },
    e.status === "error" ? h("span", { class: "chip chip-sm chip-danger" }, str.failed) : null,
    e.usedFallback ? h("span", { class: "chip chip-sm chip-info" }, str.fallback) : null);
}

function figure(str: Strings, e: MediaCardItem, i: MediaCardItem["images"][number]): HTMLElement {
  const src = safeSrc(i.src);
  return h("figure", { class: "shot", "data-image": String(i.index) },
    src ? h("img", { src, alt: `${str.image(i.index)}: ${e.prompt.slice(0, 120)}`, loading: "lazy" }) : h("div", { class: "shot-empty muted small" }, str.noPreview),
    h("figcaption", { class: "muted small" }, [i.width && i.height ? `${i.width}×${i.height}` : "", `${Math.round(i.bytes / 1024)} KB`].filter(Boolean).join(" · ")));
}

export function detailView(c: MediaDetailCard, str: Strings): HTMLElement {
  const e = c.entry;
  return h("div", { class: env.full ? "full" : "card", "data-entry": e.id },
    header(str.title, `${e.model} · $${e.costUsd.toFixed(4)} · ${e.latencyMs} ms · ${e.caller}`),
    chips(str, e),
    e.error ? h("p", { class: "danger small fail-line" }, e.error) : null,
    e.images.length ? h("div", { class: `shots shots-${Math.min(e.images.length, 2)}` }, ...e.images.map((i) => figure(str, e, i))) : null,
    h("section", {}, h("div", { class: "section-title" }, str.prompt), h("p", { class: "prompt" }, e.prompt)),
    h("p", { class: "muted small mono" }, [e.id, e.size, e.seed !== undefined ? `seed ${e.seed}` : "", when(e.at, env.locale)].filter(Boolean).join(" · ")),
    actions(str, [h("button", { class: "btn", disabled: env.superseded || env.busy, onclick: () => env.onShow?.({}) }, str.back)]));
}

export function listView(c: MediaListCard, str: Strings): HTMLElement {
  return h("div", { class: env.full ? "full" : "card" },
    header(str.title, str.total(c.total)),
    c.entries.length ? h("div", { class: "entries" }, ...c.entries.map((e) => {
      const src = safeSrc(e.images[0]?.src);
      return h("div", { class: "row", "data-entry": e.id },
        src ? h("img", { class: "thumb", src, alt: "", loading: "lazy" }) : h("div", { class: "thumb thumb-empty" }),
        h("div", { class: "row-main" },
          h("div", {}, h("button", { class: "link-btn", disabled: env.superseded || env.busy, onclick: () => env.onShow?.({ id: e.id }) },
            e.status === "error" ? str.failed : e.prompt.slice(0, 90))),
          h("div", { class: "muted small" }, `${when(e.at, env.locale)} · ${e.caller} · ${e.model} · ${e.images.length}`)),
        chips(str, e));
    })) : h("p", { class: "muted empty" }, str.noImages),
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
    env.card?.kind === "media" ? listView(env.card, str) : "",
    env.card?.kind === "image" ? detailView(env.card, str) : "",
    env.card && env.error ? h("p", { class: "danger small" }, env.error) : "",
  );
}
