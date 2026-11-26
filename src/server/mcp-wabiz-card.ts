/**
 * The WhatsApp Business card (an MCP App shown by polpo_wabiz_show): the channel's status (state,
 * quality, tier, today's templates against the cap, the last account update), the recent
 * conversations (window, opt-out, blocked, the last message with a thumbnail of its photo), one
 * conversation's transcript with media, interactive and template messages drawn as they look in
 * WhatsApp, reactions and status ticks, and the templates waiting for approval (approve / reject
 * from the card). Built from the REST shapes; the widget (widgets/wabiz-card) draws it, the text is
 * for clients without MCP Apps.
 */
export interface WabizCardKey { createdAt: number; seq: number }
type Appearance = { light?: Record<string, string>; dark?: Record<string, string> };

export interface WabizCardMedia { kind: string; voice?: boolean; filename?: string; caption?: string; thumb?: string; skipped?: string; size?: number }

export interface WabizCardMessage {
  id: string;
  dir: "in" | "out";
  at: string;
  type: string;
  status: string;
  text?: string;
  by?: string;
  template?: string;
  media?: WabizCardMedia;
  /** Interactive messages: the buttons / rows / link / flow / products they offered or the reply chosen. */
  buttons?: string[];
  rows?: string[];
  link?: { text: string; url: string };
  flow?: string;
  products?: string[];
  location?: { latitude: number; longitude: number; name?: string };
  order?: { lines: string[]; total?: string };
  reply?: string;
  reactions?: string[];
  quoted?: string;
  forwarded?: boolean;
  edited?: boolean;
  revoked?: boolean;
  error?: string;
}

export interface WabizCardConversation {
  waId: string;
  name?: string;
  masked: string;
  windowOpen: boolean;
  closesAt?: string;
  optedOut: boolean;
  blocked: boolean;
  lastAt?: string;
  last?: string;
  lastDir?: "in" | "out";
  thumb?: string;
}

export interface WabizCardPending {
  id: string; template: string; language: string; to: string; requestedBy: string; requestedAt: string; reason?: string; params: string[]; preview?: string;
}

export interface WabizCard {
  kind: "wabiz";
  key: WabizCardKey;
  generatedAt: string;
  channel: string;
  channels: string[];
  status: {
    state: string; audience: string; agent?: string; phone?: string; quality?: string; tier?: string; sentToday: number; cap: number;
    pendingApprovals: number; lastError?: string; lastAccountEvent?: string; missing: string[];
  };
  conversations: WabizCardConversation[];
  transcript?: { waId: string; name?: string; masked: string; windowOpen: boolean; closesAt?: string; optedOut: boolean; messages: WabizCardMessage[] };
  pending: WabizCardPending[];
  link?: string;
  appearance?: Appearance;
}

/** The REST shapes the card reads. */
export interface WabizMessageShape {
  id: string; direction: "in" | "out"; type: string; status: string; text?: string; sentBy?: string; createdAt: string;
  template?: { name: string; language: string };
  media?: { kind: string; voice?: boolean; filename?: string; caption?: string; stored?: string; skipped?: string; size?: number };
  content?: Record<string, any>;
  context?: { id?: string; forwarded?: boolean };
  reactions?: Array<{ emoji: string; by: string }>;
  edited?: unknown; revoked?: unknown;
  error?: { code?: number; title?: string };
  pending?: { template: string; language: string; params: string[]; requestedBy: string; requestedAt: string; reason?: string };
  waId: string;
}

const firstLine = (s: string | undefined, n = 90) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** A message as the card draws it: the visible text, and the interactive parts as their own fields. */
export function cardMessage(m: WabizMessageShape, thumb?: string): WabizCardMessage {
  const c = m.content ?? {};
  const out: WabizCardMessage = {
    id: m.id, dir: m.direction, at: m.createdAt, type: m.type, status: m.status,
    ...(m.sentBy ? { by: m.sentBy } : {}), ...(m.template ? { template: `${m.template.name} (${m.template.language})` } : {}),
    ...(m.context?.id ? { quoted: m.context.id } : {}), ...(m.context?.forwarded ? { forwarded: true } : {}),
    ...(m.edited ? { edited: true } : {}), ...(m.revoked ? { revoked: true } : {}),
    ...(m.reactions?.length ? { reactions: m.reactions.map((r) => r.emoji) } : {}),
    ...(m.error?.title ? { error: `${m.error.code ?? ""} ${m.error.title}`.trim() } : {}),
  };
  let text = m.text;
  if (m.media) {
    out.media = {
      kind: m.media.kind, ...(m.media.voice ? { voice: true } : {}), ...(m.media.filename ? { filename: m.media.filename } : {}),
      ...(m.media.caption ? { caption: m.media.caption } : {}), ...(m.media.skipped ? { skipped: m.media.skipped } : {}),
      ...(m.media.size ? { size: m.media.size } : {}), ...(thumb ? { thumb } : {}),
    };
    text = m.media.caption ?? (m.direction === "in" ? m.text : undefined);
  }
  if (m.direction === "out" && typeof c.type === "string") {
    // what was sent: the body, and the interactive parts drawn apart
    if (typeof c.body === "string") text = c.body;
    if (c.type === "buttons") out.buttons = (c.buttons ?? []).map((b: { title: string }) => b.title);
    if (c.type === "list") out.rows = (c.sections ?? []).flatMap((s: { rows: Array<{ title: string }> }) => s.rows.map((r) => r.title));
    if (c.type === "cta_url") out.link = { text: String(c.displayText ?? ""), url: String(c.url ?? "") };
    if (c.type === "flow") out.flow = String(c.cta ?? "");
    if (c.type === "voice_call") out.buttons = [String(c.displayText ?? "Call")];
    if (c.type === "location_request") out.buttons = ["Send location"];
    if (c.type === "product") out.products = [String(c.productRetailerId ?? "")];
    if (c.type === "product_list") out.products = (c.sections ?? []).flatMap((s: { productRetailerIds: string[] }) => s.productRetailerIds);
    if (c.type === "location") { out.location = { latitude: Number(c.latitude), longitude: Number(c.longitude), ...(c.name ? { name: String(c.name) } : {}) }; text = undefined; }
    if (c.type === "order_details") out.order = { lines: (c.items ?? []).map((i: { quantity: number; name: string; amount: number }) => `${i.quantity}× ${i.name} ${i.amount}`) };
  }
  if (m.direction === "in") {
    if (c.reply === "button" || c.reply === "list" || c.reply === "template_button") { out.reply = String(c.title ?? c.text ?? ""); text = undefined; }
    if (c.reply === "flow") { out.reply = "Flow completed"; text = typeof c.response === "object" ? JSON.stringify(c.response) : String(c.response ?? ""); }
    if (c.order) {
      out.order = { lines: (c.order.items ?? []).map((i: { quantity: number; productRetailerId: string; itemPrice: number; currency: string }) => `${i.quantity}× ${i.productRetailerId} ${i.itemPrice} ${i.currency}`), total: `${c.order.total} ${c.order.currency ?? ""}`.trim() };
      text = c.order.text;
    }
    if (typeof c.latitude === "number") { out.location = { latitude: c.latitude, longitude: Number(c.longitude), ...(c.name ? { name: String(c.name) } : {}) }; text = undefined; }
  }
  if (m.revoked) text = undefined;
  if (text) out.text = text.length > 1500 ? `${text.slice(0, 1499)}…` : text;
  return out;
}

export function buildWabizCard(o: {
  channel: string; channels: string[]; status: Record<string, any>;
  contacts: Array<Record<string, any>>; lastMessages: Record<string, WabizMessageShape | undefined>; thumbs: Record<string, string>;
  conversation?: { contact: Record<string, any>; window: { open: boolean; closesAt?: string }; optedOut: boolean; messages: WabizMessageShape[] };
  pending: WabizMessageShape[]; key: WabizCardKey; link?: string;
}): WabizCard {
  const s = o.status;
  const masked = (c: Record<string, any>) => String(c.masked ?? c.waId);
  return {
    kind: "wabiz", key: o.key, generatedAt: new Date().toISOString(), channel: o.channel, channels: o.channels,
    status: {
      state: String(s.state ?? "not-configured"), audience: String(s.audience ?? "customers"), ...(s.agent ? { agent: String(s.agent) } : {}),
      ...(s.phone?.displayPhoneNumber ? { phone: String(s.phone.displayPhoneNumber) } : {}), ...(s.phone?.qualityRating ? { quality: String(s.phone.qualityRating) } : {}),
      ...(s.phone?.messagingLimitTier ? { tier: String(s.phone.messagingLimitTier) } : {}),
      sentToday: Number(s.sentToday ?? 0), cap: Number(s.limits?.businessInitiatedPerDay ?? 0), pendingApprovals: Number(s.pendingApprovals ?? 0),
      ...(s.lastError ? { lastError: String(s.lastError) } : {}), ...(s.lastAccountEvent ? { lastAccountEvent: `${s.lastAccountEvent.field}: ${s.lastAccountEvent.summary}` } : {}),
      missing: Array.isArray(s.missing) ? s.missing.map(String) : [],
    },
    conversations: o.contacts.map((c) => {
      const last = o.lastMessages[String(c.waId)];
      const lm = last ? cardMessage(last) : undefined;
      return {
        waId: String(c.waId), ...(c.name ? { name: String(c.name) } : {}), masked: masked(c), windowOpen: !!c.window?.open,
        ...(c.window?.closesAt ? { closesAt: String(c.window.closesAt) } : {}), optedOut: !!c.optOut, blocked: !!c.blocked,
        ...(last ? { lastAt: last.createdAt, lastDir: last.direction } : {}),
        ...(lm ? { last: firstLine(lm.text ?? lm.reply ?? (lm.media ? `[${lm.media.voice ? "voice" : lm.media.kind}]` : lm.template ?? `(${lm.type})`)) } : {}),
        ...(last && o.thumbs[last.id] ? { thumb: o.thumbs[last.id] } : {}),
      };
    }),
    ...(o.conversation ? {
      transcript: {
        waId: String(o.conversation.contact.waId), ...(o.conversation.contact.name ? { name: String(o.conversation.contact.name) } : {}),
        masked: masked(o.conversation.contact), windowOpen: o.conversation.window.open, ...(o.conversation.window.closesAt ? { closesAt: o.conversation.window.closesAt } : {}),
        optedOut: o.conversation.optedOut,
        // oldest first, as a chat reads
        messages: [...o.conversation.messages].reverse().map((m) => cardMessage(m, o.thumbs[m.id])),
      },
    } : {}),
    pending: o.pending.map((m) => ({
      id: m.id, template: m.pending?.template ?? m.template?.name ?? "", language: m.pending?.language ?? m.template?.language ?? "", to: m.waId,
      requestedBy: m.pending?.requestedBy ?? m.sentBy ?? "", requestedAt: m.pending?.requestedAt ?? m.createdAt, ...(m.pending?.reason ? { reason: m.pending.reason } : {}),
      params: m.pending?.params ?? [], ...(m.text ? { preview: m.text } : {}),
    })),
    ...(o.link ? { link: o.link } : {}),
  };
}

const TICKS: Record<string, string> = { accepted: "✓", sent: "✓", delivered: "✓✓", read: "✓✓ read", failed: "failed", pending_approval: "waiting for approval", rejected: "rejected" };

/** The card as text (clients without MCP Apps). */
export function wabizCardText(card: WabizCard): string {
  const s = card.status;
  const lines = [
    `${card.channel}: ${s.state}${s.phone ? ` · ${s.phone}` : ""}${s.quality ? ` · quality ${s.quality}` : ""}${s.tier ? ` · ${s.tier}` : ""} · templates today ${s.sentToday}/${s.cap} · waiting for approval ${s.pendingApprovals}`,
    ...(s.missing.length ? [`missing: ${s.missing.join(", ")}`] : []),
    ...(s.lastAccountEvent ? [`last account update: ${s.lastAccountEvent}`] : []),
  ];
  if (card.pending.length) {
    lines.push("", "Waiting for approval:");
    for (const p of card.pending) lines.push(`- ${p.id}: ${p.template} (${p.language}) to ${p.to} by ${p.requestedBy}${p.reason ? ` — ${p.reason}` : ""}${p.preview ? `: ${firstLine(p.preview, 120)}` : ""}`);
  }
  if (card.transcript) {
    const t = card.transcript;
    lines.push("", `Conversation with ${t.name ?? t.masked} (window ${t.windowOpen ? `open until ${t.closesAt}` : "closed"}${t.optedOut ? ", opted out" : ""}):`);
    for (const m of t.messages) {
      const parts = [
        m.media ? `[${m.media.voice ? "voice" : m.media.kind}${m.media.filename ? ` ${m.media.filename}` : ""}]` : "",
        m.template ? `[template ${m.template}]` : "", m.reply ? `[${m.reply}]` : "", m.revoked ? "(deleted)" : m.text ?? "",
        m.buttons ? `[${m.buttons.join(" | ")}]` : "", m.rows ? `[list: ${m.rows.join(" | ")}]` : "", m.link ? `[${m.link.text} → ${m.link.url}]` : "",
        m.flow ? `[flow: ${m.flow}]` : "", m.products ? `[products: ${m.products.join(", ")}]` : "",
        m.location ? `[location ${m.location.latitude},${m.location.longitude}${m.location.name ? ` ${m.location.name}` : ""}]` : "",
        m.order ? `[order: ${m.order.lines.join(", ")}${m.order.total ? `; ${m.order.total}` : ""}]` : "",
        m.reactions ? `{${m.reactions.join(" ")}}` : "", m.edited ? "(edited)" : "",
      ].filter(Boolean).join(" ");
      lines.push(`${m.dir === "in" ? "←" : "→"} ${m.at.slice(0, 16).replace("T", " ")} ${firstLine(parts, 300)}${m.dir === "out" ? ` ${TICKS[m.status] ?? m.status}` : ""}`);
    }
  } else {
    lines.push("", card.conversations.length ? "Recent conversations:" : "No conversations yet.");
    for (const c of card.conversations) lines.push(`- ${c.name ?? c.masked} (${c.waId}) window ${c.windowOpen ? "open" : "closed"}${c.optedOut ? ", opted out" : ""}${c.blocked ? ", blocked" : ""}${c.last ? `: ${c.last}` : ""}`);
  }
  return lines.join("\n");
}
