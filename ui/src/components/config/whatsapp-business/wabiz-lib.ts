/**
 * WhatsApp Business helpers for the dashboard: Meta's limits (checked before sending, the server
 * checks them again), a template's needs from its synced definition (which variables, header,
 * buttons, carousel cards, OTP), the filled preview, and files as base64.
 */
import type { WaBizMediaKind, WaBizOutbound, WaBizTemplateInput, WaBusinessTemplate, WaBusinessTemplateComponent } from "@polpo-ai/react";

/** Meta's limits on interactive messages (Cloud API reference). */
export const WA_LIMIT = {
  text: 4096, bodyInteractive: 1024, bodyList: 4096, header: 60, footer: 60, buttonTitle: 20, buttonId: 256, buttons: 3,
  listButton: 20, sections: 10, rows: 10, sectionTitle: 24, rowTitle: 24, rowDescription: 72, rowId: 200, ctaText: 20, caption: 1024,
} as const;

const MB = 1024 * 1024;
/** Meta's supported types and size limits per media kind. */
export const WA_MEDIA_LIMITS: Record<WaBizMediaKind, { maxBytes: number; mimeTypes: readonly string[] }> = {
  image: { maxBytes: 5 * MB, mimeTypes: ["image/jpeg", "image/png", "image/webp"] },
  audio: { maxBytes: 16 * MB, mimeTypes: ["audio/aac", "audio/amr", "audio/mpeg", "audio/mp4", "audio/ogg"] },
  video: { maxBytes: 16 * MB, mimeTypes: ["video/mp4", "video/3gpp"] },
  document: { maxBytes: 100 * MB, mimeTypes: [] },
  sticker: { maxBytes: 500 * 1024, mimeTypes: ["image/webp"] },
};
/** Files go through the API as base64: at most 20 MB (larger documents by link). */
export const WA_UPLOAD_MAX = 20 * MB;

export const WA_PROFILE_VERTICALS = [
  "UNDEFINED", "OTHER", "AUTO", "BEAUTY", "APPAREL", "EDU", "ENTERTAIN", "EVENT_PLAN", "FINANCE", "GROCERY", "GOVT", "HOTEL", "HEALTH",
  "NONPROFIT", "PROF_SERVICES", "RETAIL", "TRAVEL", "RESTAURANT", "NOT_A_BIZ",
] as const;

export function formatBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "";
  if (n >= MB) return `${Number((n / MB).toFixed(n >= 10 * MB ? 0 : 1))} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

const mimeOf = (m: string) => String(m ?? "").split(";")[0]!.trim().toLowerCase();

/** The kind a file goes out as (images, audio, video; anything else a document). */
export function mediaKindFor(mimeType: string): WaBizMediaKind {
  const m = mimeOf(mimeType);
  if (WA_MEDIA_LIMITS.image.mimeTypes.includes(m)) return "image";
  if (WA_MEDIA_LIMITS.audio.mimeTypes.includes(m)) return "audio";
  if (WA_MEDIA_LIMITS.video.mimeTypes.includes(m)) return "video";
  return "document";
}

/** Why a file cannot go out as this kind, or undefined. */
export function mediaProblem(kind: WaBizMediaKind, mimeType: string, bytes: number): string | undefined {
  const l = WA_MEDIA_LIMITS[kind];
  const m = mimeOf(mimeType);
  if (l.mimeTypes.length && !l.mimeTypes.includes(m)) return `A WhatsApp ${kind} must be ${l.mimeTypes.join(", ")} (this file is ${m || "of an unknown type"})`;
  if (bytes > l.maxBytes) return `A WhatsApp ${kind} can be at most ${formatBytes(l.maxBytes)} (this one is ${formatBytes(bytes)})`;
  if (bytes > WA_UPLOAD_MAX) return `Files over ${formatBytes(WA_UPLOAD_MAX)} go by link`;
  return undefined;
}

/** A file's bytes as base64 (no data: prefix). */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file"));
    reader.onload = () => {
      const s = String(reader.result ?? "");
      resolve(s.slice(s.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

const isHttps = (u: string) => { try { return new URL(u).protocol === "https:"; } catch { return false; } };
const tooLong = (v: string | undefined, max: number, what: string) => (v && v.length > max ? `${what}: at most ${max} characters (${v.length})` : undefined);

/** Why a free-form message breaks Meta's limits (the first problem), or undefined. */
export function outboundProblem(m: WaBizOutbound): string | undefined {
  switch (m.type) {
    case "text":
      if (!m.text.trim()) return "Write the message";
      return tooLong(m.text, WA_LIMIT.text, "Text");
    case "media":
      if (!m.link && !m.mediaId) return "Choose a file (or give a public https link)";
      if (m.link && !isHttps(m.link)) return "The link must be a public https URL";
      if ((m.kind === "audio" || m.kind === "sticker") && m.caption) return `A ${m.kind} has no caption`;
      return tooLong(m.caption, WA_LIMIT.caption, "Caption");
    case "buttons": {
      if (!m.body.trim()) return "The body is required";
      if (!m.buttons.length || m.buttons.length > WA_LIMIT.buttons) return "One to three buttons";
      const ids = new Set<string>();
      for (const [i, b] of m.buttons.entries()) {
        if (!b.title.trim()) return `Button ${i + 1}: the title is required`;
        if (!b.id.trim()) return `Button ${i + 1}: the id is required`;
        if (ids.has(b.id)) return `Button ids must be unique ("${b.id}")`;
        ids.add(b.id);
        const p = tooLong(b.title, WA_LIMIT.buttonTitle, `Button ${i + 1} title`) ?? tooLong(b.id, WA_LIMIT.buttonId, `Button ${i + 1} id`);
        if (p) return p;
      }
      if (m.header?.type === "text") { const p = tooLong(m.header.text, WA_LIMIT.header, "Header"); if (p) return p; }
      return tooLong(m.body, WA_LIMIT.bodyInteractive, "Body") ?? tooLong(m.footer, WA_LIMIT.footer, "Footer");
    }
    case "list": {
      if (!m.body.trim()) return "The body is required";
      if (!m.button.trim()) return "The list button's label is required";
      if (!m.sections.length || m.sections.length > WA_LIMIT.sections) return "One to ten sections";
      const rows = m.sections.flatMap((s) => s.rows);
      if (!rows.length) return "At least one row";
      if (rows.length > WA_LIMIT.rows) return `At most ${WA_LIMIT.rows} rows in all`;
      if (m.sections.length > 1 && m.sections.some((s) => !s.title?.trim())) return "With several sections each needs a title";
      const ids = new Set<string>();
      for (const r of rows) {
        if (!r.title.trim() || !r.id.trim()) return "Every row needs an id and a title";
        if (ids.has(r.id)) return `Row ids must be unique ("${r.id}")`;
        ids.add(r.id);
        const p = tooLong(r.title, WA_LIMIT.rowTitle, `Row "${r.title}"`) ?? tooLong(r.description, WA_LIMIT.rowDescription, `Row "${r.title}" description`) ?? tooLong(r.id, WA_LIMIT.rowId, "Row id");
        if (p) return p;
      }
      for (const s of m.sections) { const p = tooLong(s.title, WA_LIMIT.sectionTitle, "Section title"); if (p) return p; }
      return tooLong(m.button, WA_LIMIT.listButton, "List button") ?? tooLong(m.body, WA_LIMIT.bodyList, "Body") ?? tooLong(m.header, WA_LIMIT.header, "Header") ?? tooLong(m.footer, WA_LIMIT.footer, "Footer");
    }
    case "cta_url":
      if (!m.body.trim()) return "The body is required";
      if (!m.displayText.trim()) return "The button's label is required";
      if (!isHttps(m.url)) return "The URL must be https";
      return tooLong(m.displayText, WA_LIMIT.ctaText, "Button label") ?? tooLong(m.body, WA_LIMIT.bodyInteractive, "Body") ?? tooLong(m.footer, WA_LIMIT.footer, "Footer");
    case "location_request":
      if (!m.body.trim()) return "The body is required";
      return tooLong(m.body, WA_LIMIT.bodyInteractive, "Body");
    case "location":
      if (!Number.isFinite(m.latitude) || Math.abs(m.latitude) > 90) return "Latitude: −90 to 90";
      if (!Number.isFinite(m.longitude) || Math.abs(m.longitude) > 180) return "Longitude: −180 to 180";
      return undefined;
    default:
      return undefined;
  }
}

// ── Templates ────────────────────────────────────────────────────────

const VAR = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** A text's variables, in order of first appearance: ["1", "2"] or ["name", "order"]. */
export function templateVars(text: string | undefined): string[] {
  const seen: string[] = [];
  for (const m of (text ?? "").matchAll(VAR)) if (!seen.includes(m[1]!)) seen.push(m[1]!);
  return seen;
}

const comp = (components: WaBusinessTemplateComponent[] | undefined, type: string) => (components ?? []).find((c) => c.type.toUpperCase() === type);

export interface TemplateButtonNeed {
  index: number;
  type: string;
  text?: string;
  url?: string;
  /** A value the send needs: the URL's suffix, a coupon code, the one-time code. */
  needs?: "text" | "coupon_code" | "otp";
  /** A value the send may give: a quick reply payload, a flow token, a catalog action. */
  optional?: "payload" | "flow" | "action";
}

export interface TemplateNeeds {
  header?: { format: string; variable: boolean; text?: string };
  body: string[];
  bodyText: string;
  footer?: string;
  named: boolean;
  buttons: TemplateButtonNeed[];
  cards?: Array<{ header?: string; body: string[]; bodyText: string; buttons: TemplateButtonNeed[] }>;
  authentication: boolean;
  limitedTimeOffer: boolean;
}

function buttonNeeds(buttons: WaBusinessTemplateComponent["buttons"]): TemplateButtonNeed[] {
  return (buttons ?? []).map((b, index) => {
    const type = String(b.type ?? "").toUpperCase();
    const base = { index, type, ...(b.text ? { text: b.text } : {}), ...(b.url ? { url: b.url } : {}) };
    if (type === "URL" && b.url && /\{\{/.test(b.url)) return { ...base, needs: "text" as const };
    if (type === "COPY_CODE") return { ...base, needs: "coupon_code" as const };
    if (type === "OTP") return { ...base, needs: "otp" as const };
    if (type === "QUICK_REPLY") return { ...base, optional: "payload" as const };
    if (type === "FLOW") return { ...base, optional: "flow" as const };
    if (type === "CATALOG" || type === "MPM") return { ...base, optional: "action" as const };
    return base;
  });
}

/** What a template needs to be sent, from its synced definition. */
export function templateNeeds(t: Pick<WaBusinessTemplate, "components" | "parameterFormat" | "category">): TemplateNeeds {
  const h = comp(t.components, "HEADER");
  const bodyText = comp(t.components, "BODY")?.text ?? "";
  const body = templateVars(bodyText);
  const carousel = comp(t.components, "CAROUSEL");
  const footer = comp(t.components, "FOOTER")?.text;
  return {
    ...(h ? { header: { format: (h.format ?? "TEXT").toUpperCase(), variable: templateVars(h.text).length > 0, ...(h.text ? { text: h.text } : {}) } } : {}),
    body, bodyText, ...(footer ? { footer } : {}),
    named: t.parameterFormat === "NAMED" || body.some((n) => !/^\d+$/.test(n)),
    buttons: buttonNeeds(comp(t.components, "BUTTONS")?.buttons),
    ...(carousel?.cards?.length ? {
      cards: carousel.cards.map((card) => {
        const ch = comp(card.components, "HEADER");
        const cbody = comp(card.components, "BODY")?.text ?? "";
        return { ...(ch ? { header: (ch.format ?? "IMAGE").toUpperCase() } : {}), body: templateVars(cbody), bodyText: cbody, buttons: buttonNeeds(comp(card.components, "BUTTONS")?.buttons) };
      }),
    } : {}),
    authentication: String(t.category).toUpperCase() === "AUTHENTICATION",
    limitedTimeOffer: !!comp(t.components, "LIMITED_TIME_OFFER"),
  };
}

/** Every variable and component value the template still needs (empty when it can be sent). */
export function templateInputProblems(needs: TemplateNeeds, input: WaBizTemplateInput): string[] {
  const out: string[] = [];
  const bad = (v: string | undefined) => !v || !v.trim() || /[\n\t]|\s{5,}/.test(v);
  const bodyValues = (names: string[], given: WaBizTemplateInput["body"], where: string) => {
    names.forEach((n, i) => {
      const v = Array.isArray(given) ? given[i] : given?.[n];
      if (bad(v)) out.push(`${where} {{${n}}}`);
    });
  };
  if (needs.header) {
    const h = input.header;
    if (needs.header.format === "TEXT" && needs.header.variable && (h?.type !== "text" || bad(h.text))) out.push("Header text");
    if (needs.header.format === "LOCATION" && (h?.type !== "location" || !Number.isFinite(h.latitude) || !Number.isFinite(h.longitude))) out.push("Header location");
    if (["IMAGE", "VIDEO", "DOCUMENT"].includes(needs.header.format)) {
      const kind = needs.header.format.toLowerCase();
      if (!h || h.type !== kind || (!("link" in h && h.link) && !("mediaId" in h && h.mediaId))) out.push(`Header ${kind} (link or media id)`);
      else if ("link" in h && h.link && !isHttps(h.link)) out.push(`Header ${kind}: the link must be https`);
    }
  }
  const body = needs.authentication && input.otp && input.body === undefined ? needs.body.map(() => input.otp!) : input.body;
  bodyValues(needs.body, body, "Body");
  for (const b of needs.buttons) {
    const g = input.buttons?.find((x) => x.index === b.index);
    if (b.needs === "text" && bad(g?.text)) out.push(`Button ${b.index + 1}${b.text ? ` "${b.text}"` : ""}: the URL's variable`);
    if (b.needs === "coupon_code" && (bad(g?.couponCode) || (g?.couponCode?.length ?? 0) > 15)) out.push(`Button ${b.index + 1}: the coupon code (≤ 15 characters)`);
    if (b.needs === "otp" && bad(g?.text ?? input.otp)) out.push("The one-time code");
  }
  if (needs.authentication && !needs.buttons.some((b) => b.needs === "otp") && needs.body.length && bad(input.otp) && !input.body) out.push("The one-time code");
  needs.cards?.forEach((card, i) => {
    const c = input.carousel?.[i];
    if (card.header && (!c?.header || (!c.header.link && !c.header.mediaId))) out.push(`Card ${i + 1} ${card.header.toLowerCase()} (link or media id)`);
    bodyValues(card.body, c?.body, `Card ${i + 1} body`);
    for (const b of card.buttons) if (b.needs === "text" && bad(c?.buttons?.find((x) => x.index === b.index)?.text)) out.push(`Card ${i + 1} button ${b.index + 1}: the URL's variable`);
  });
  return out;
}

/** A text with its variables filled (unfilled ones stay as {{n}}). */
export function fillVars(text: string, names: string[], given: WaBizTemplateInput["body"]): string {
  const values: Record<string, string> = {};
  names.forEach((n, i) => {
    const v = Array.isArray(given) ? given[i] : given?.[n];
    if (v) values[n] = v;
  });
  return text.replace(VAR, (m, n: string) => values[n] ?? m);
}

/** The template's text as the contact sees it: header, body and footer with the values filled. */
export function templatePreviewText(needs: TemplateNeeds, input: WaBizTemplateInput): string {
  const body = needs.authentication && input.otp && input.body === undefined ? needs.body.map(() => input.otp!) : input.body;
  const header = needs.header?.format === "TEXT" && needs.header.text
    ? fillVars(needs.header.text, templateVars(needs.header.text), input.header?.type === "text" ? [input.header.text] : undefined)
    : undefined;
  return [header, fillVars(needs.bodyText, needs.body, body), needs.footer].filter(Boolean).join("\n\n");
}

/** The values to send, without empty fields (named or positional body). */
export function cleanTemplateInput(input: WaBizTemplateInput): WaBizTemplateInput {
  const out: WaBizTemplateInput = {};
  if (input.header) out.header = input.header;
  if (input.body !== undefined && (Array.isArray(input.body) ? input.body.length : Object.keys(input.body).length)) out.body = input.body;
  const buttons = (input.buttons ?? []).filter((b) => b.text || b.payload || b.couponCode || b.flowToken);
  if (buttons.length) out.buttons = buttons;
  if (input.carousel?.length) out.carousel = input.carousel;
  if (input.otp) out.otp = input.otp;
  if (input.offerExpiresAt) out.offerExpiresAt = input.offerExpiresAt;
  return out;
}

// ── Shared by the account panels (manage.tsx) ─────────────────────

export type WaTone = "success" | "warning" | "destructive" | "info" | "muted";

export function templateStatusTone(status: string): WaTone {
  const s = status.toUpperCase();
  if (s === "APPROVED") return "success";
  if (s === "PENDING" || s === "IN_APPEAL" || s === "PENDING_DELETION") return "warning";
  if (s === "REJECTED" || s === "DISABLED" || s === "PAUSED") return "destructive";
  return "muted";
}

export function qualityTone(q: string | undefined): WaTone {
  const s = String(q ?? "").toUpperCase();
  if (s === "GREEN" || s === "HIGH") return "success";
  if (s === "YELLOW" || s === "MEDIUM") return "warning";
  if (s === "RED" || s === "LOW") return "destructive";
  return "muted";
}

/** Why the components JSON cannot be sent to Meta, or undefined. */
export function componentsProblem(json: string): string | undefined {
  let v: unknown;
  try { v = JSON.parse(json); } catch (e) { return `Not valid JSON: ${(e as Error).message}`; }
  if (!Array.isArray(v) || !v.length) return "A list of components: [{ \"type\": \"BODY\", \"text\": \"…\" }, …]";
  const types = ["HEADER", "BODY", "FOOTER", "BUTTONS", "CAROUSEL", "LIMITED_TIME_OFFER"];
  for (const [i, c] of v.entries()) {
    if (!c || typeof c !== "object" || Array.isArray(c)) return `Component ${i + 1} is not an object`;
    const t = String((c as { type?: unknown }).type ?? "").toUpperCase();
    if (!types.includes(t)) return `Component ${i + 1}: type must be ${types.join(", ")}`;
  }
  if (!v.some((c) => String((c as { type?: unknown }).type).toUpperCase() === "BODY")) return "Every template has a BODY";
  return undefined;
}

/** Meta's data points, wherever they are in the answer (analytics, pricing_analytics, template_analytics). */
export function analyticsRows(data: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === "data_points" && Array.isArray(x)) out.push(...x.filter((p) => p && typeof p === "object") as Array<Record<string, unknown>>);
      else walk(x);
    }
  };
  walk(data);
  return out;
}

/** Reactions offered on a message. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
