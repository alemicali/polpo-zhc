/**
 * A WhatsApp Business conversation, oldest first: media (images inline as thumbnails, voice notes
 * and audio with a player and the transcript, video, documents as downloads, stickers), interactive
 * messages (buttons, list rows, CTA link, flow, products, catalog, order details and status, call
 * and address requests), templates (name and the filled text), replies (button, list, flow
 * completion, address, call permission) as structured chips, orders and payments, reactions,
 * quoted messages, forwarded / edited / deleted flags, status ticks and failures.
 */
import { useState } from "react";
import {
  AlertCircle, Check, CheckCheck, Clock, CornerUpLeft, Download, FileText, Forward, ListChecks, MapPin, Megaphone, Package,
  Pencil, Phone, ShoppingCart, SmilePlus, Trash2, User, Wallet, Workflow, XCircle,
} from "lucide-react";
import { useWaMedia, type WaBusinessMessage, type WaBizMedia } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatBytes, QUICK_REACTIONS } from "./wabiz-lib";

type Content = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Content => (v && typeof v === "object" && !Array.isArray(v) ? (v as Content) : {});


/** A file kept with a message, fetched with the dashboard's credentials. */
export function WaMediaView({ channel, message }: { channel: string; message: WaBusinessMessage & { media: WaBizMedia } }) {
  const m = message.media;
  const kept = !!m.stored;
  const auto = m.kind === "image" || m.kind === "sticker" || m.kind === "audio";
  const [wanted, setWanted] = useState(auto);
  const [expanded, setExpanded] = useState(false);
  const media = useWaMedia(channel, kept && !message.revoked ? message.id : undefined, wanted);
  const label = m.voice ? "Voice note" : m.kind === "sticker" ? `${m.animated ? "Animated sticker" : "Sticker"}` : m.kind[0]!.toUpperCase() + m.kind.slice(1);
  const meta = [m.filename, m.mimeType, formatBytes(m.size)].filter(Boolean).join(" · ");

  if (m.skipped || (!kept && !m.link)) {
    return (
      <div className="flex items-center gap-1.5 text-caption text-muted-foreground" data-testid="wabiz-media-skipped">
        <FileText className="h-3.5 w-3.5" /> {label}{meta ? ` (${meta})` : ""}: {m.skipped ?? (m.mediaId ? `not kept here (Meta media id ${m.mediaId})` : "not kept")}
      </div>
    );
  }
  if (!kept && m.link) {
    return (
      <a href={m.link} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-caption text-primary underline-offset-2 hover:underline" data-testid="wabiz-media-link">
        <FileText className="h-3.5 w-3.5" /> {label} by link{m.filename ? `: ${m.filename}` : ""}
      </a>
    );
  }
  const loading = wanted && media.isLoading;
  if (media.error) return <p className="text-caption text-destructive">{label}: {media.error.message}</p>;
  switch (m.kind) {
    case "image":
    case "sticker":
      return media.url ? (
        <button type="button" onClick={() => setExpanded((e) => !e)} aria-label={expanded ? "Shrink the image" : "Enlarge the image"} className="block">
          <img src={media.url} alt={m.caption ?? label} data-testid={`wabiz-media-${m.kind}`}
            className={cn("rounded-md border border-border/40 object-contain", m.kind === "sticker" ? "h-24 w-24" : expanded ? "max-h-96 max-w-full" : "max-h-40 max-w-56")} />
        </button>
      ) : <div className="h-24 w-32 animate-pulse rounded-md bg-muted/60" data-testid={`wabiz-media-${m.kind}`} aria-label={`Loading the ${label.toLowerCase()}`} />;
    case "audio":
      return (
        <div className="space-y-1" data-testid="wabiz-media-audio">
          <span className="text-micro text-muted-foreground">{label}{meta ? ` · ${meta}` : ""}</span>
          {media.url ? <audio controls src={media.url} className="w-full max-w-72" /> : <div className="h-8 w-56 animate-pulse rounded-md bg-muted/60" />}
        </div>
      );
    case "video":
      return media.url
        ? <video controls src={media.url} className="max-h-64 max-w-full rounded-md border border-border/40" data-testid="wabiz-media-video" />
        : (
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={loading} onClick={() => setWanted(true)} data-testid="wabiz-media-video">
            {loading ? "Loading…" : `Play video${meta ? ` (${meta})` : ""}`}
          </Button>
        );
    default:
      return media.url
        ? (
          <a href={media.url} download={media.filename ?? m.filename ?? "document"} className="flex items-center gap-1.5 text-caption text-primary underline-offset-2 hover:underline" data-testid="wabiz-media-document">
            <Download className="h-3.5 w-3.5" /> Save {media.filename ?? m.filename ?? "the document"}
          </a>
        )
        : (
          <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" disabled={loading} onClick={() => setWanted(true)} data-testid="wabiz-media-document">
            <FileText className="h-3.5 w-3.5" /> {loading ? "Loading…" : `${m.filename ?? "Document"}${meta && !m.filename ? ` (${meta})` : m.size ? ` (${formatBytes(m.size)})` : ""}`}
          </Button>
        );
  }
}

function Chip({ icon: Icon, children, testId, tone = "default" }: { icon?: React.ComponentType<{ className?: string }>; children: React.ReactNode; testId?: string; tone?: "default" | "info" | "success" | "warning" | "destructive" }) {
  const tones = {
    default: "border-border/60 bg-muted/30",
    info: "border-info/30 bg-info/10 text-info",
    success: "border-success/30 bg-success/10 text-success",
    warning: "border-warning/30 bg-warning/10 text-warning",
    destructive: "border-destructive/30 bg-destructive/10 text-destructive",
  };
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1 rounded-pill border px-2 py-0.5 text-caption", tones[tone])} data-testid={testId}>
      {Icon && <Icon className="h-3 w-3 shrink-0" />}<span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

function KeyValues({ value }: { value: unknown }) {
  const o = obj(value);
  const entries = Object.entries(o).filter(([k]) => k !== "flow_token");
  if (!entries.length) return null;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-caption">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k.replace(/_/g, " ")}</dt>
          <dd className="min-w-0 break-words">{typeof v === "object" ? JSON.stringify(v) : str(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function Lines({ text }: { text?: string }) {
  if (!text) return null;
  return <p className="whitespace-pre-wrap break-words text-small">{text}</p>;
}

/** The body, header and footer of an interactive message sent by the business. */
function InteractiveFrame({ c, children }: { c: Content; children?: React.ReactNode }) {
  const header = obj(c.header);
  const headerText = typeof c.header === "string" ? c.header : header.type === "text" ? str(header.text) : "";
  const headerMedia = header.type && header.type !== "text" ? `${str(header.type)} header${header.filename ? `: ${str(header.filename)}` : ""}` : "";
  return (
    <div className="space-y-1.5">
      {headerText && <p className="text-small font-semibold">{headerText}</p>}
      {headerMedia && <Chip icon={FileText}>{headerMedia}</Chip>}
      <Lines text={str(c.body)} />
      {c.footer ? <p className="text-micro text-muted-foreground">{str(c.footer)}</p> : null}
      {children}
    </div>
  );
}

/** A message sent by the business: the WaBizOutbound kept as its content. */
function OutboundContent({ m, c }: { m: WaBusinessMessage; c: Content }) {
  switch (m.type) {
    case "buttons":
      return (
        <InteractiveFrame c={c}>
          <div className="flex flex-wrap gap-1" data-testid="wabiz-out-buttons">
            {arr(c.buttons).map((b) => { const x = obj(b); return <Chip key={str(x.id)} icon={CornerUpLeft}>{str(x.title)}</Chip>; })}
          </div>
        </InteractiveFrame>
      );
    case "list":
      return (
        <InteractiveFrame c={c}>
          <div className="space-y-1" data-testid="wabiz-out-list">
            <Chip icon={ListChecks}>{str(c.button)}</Chip>
            {arr(c.sections).map((s, i) => {
              const sec = obj(s);
              return (
                <div key={i} className="space-y-0.5 border-l-2 border-border/60 pl-2">
                  {sec.title ? <p className="text-micro font-medium uppercase tracking-label text-muted-foreground">{str(sec.title)}</p> : null}
                  {arr(sec.rows).map((r) => { const row = obj(r); return <p key={str(row.id)} className="text-caption">{str(row.title)}{row.description ? <span className="text-muted-foreground"> — {str(row.description)}</span> : null}</p>; })}
                </div>
              );
            })}
          </div>
        </InteractiveFrame>
      );
    case "cta_url":
      return (
        <InteractiveFrame c={c}>
          <a href={str(c.url)} target="_blank" rel="noreferrer" className="inline-flex" data-testid="wabiz-out-cta"><Chip icon={Forward} tone="info">{str(c.displayText)} → {str(c.url)}</Chip></a>
        </InteractiveFrame>
      );
    case "location_request":
      return <InteractiveFrame c={c}><Chip icon={MapPin} testId="wabiz-out-location-request">Send location</Chip></InteractiveFrame>;
    case "flow":
      return <InteractiveFrame c={c}><Chip icon={Workflow} testId="wabiz-out-flow">{str(c.cta)} · flow {str(c.flowName ?? c.flowId)}{c.mode === "draft" ? " (draft)" : ""}</Chip></InteractiveFrame>;
    case "product":
      return <InteractiveFrame c={c}><Chip icon={Package} testId="wabiz-out-product">Product {str(c.productRetailerId)}</Chip></InteractiveFrame>;
    case "product_list":
      return (
        <InteractiveFrame c={{ ...c, header: str(c.header) }}>
          <div className="space-y-1" data-testid="wabiz-out-products">
            {arr(c.sections).map((s, i) => { const sec = obj(s); return <p key={i} className="text-caption"><span className="font-medium">{str(sec.title)}:</span> {arr(sec.productRetailerIds).map(str).join(", ")}</p>; })}
          </div>
        </InteractiveFrame>
      );
    case "catalog":
      return <InteractiveFrame c={c}><Chip icon={ShoppingCart} testId="wabiz-out-catalog">View catalog</Chip></InteractiveFrame>;
    case "voice_call":
      return <InteractiveFrame c={c}><Chip icon={Phone} testId="wabiz-out-call">{str(c.displayText) || "Call now"}</Chip></InteractiveFrame>;
    case "call_permission_request":
      return <InteractiveFrame c={c}><Chip icon={Phone} testId="wabiz-out-call-permission">Asked permission to call</Chip></InteractiveFrame>;
    case "address":
      return <InteractiveFrame c={c}><Chip icon={MapPin} testId="wabiz-out-address">Asked for a delivery address</Chip></InteractiveFrame>;
    case "order_details": {
      const items = arr(c.items).map(obj);
      const subtotal = items.reduce((n, it) => n + Number(it.saleAmount ?? it.amount ?? 0) * Number(it.quantity ?? 1), 0);
      const total = subtotal + Number(c.tax ?? 0) + Number(c.shipping ?? 0) - Number(c.discount ?? 0);
      return (
        <InteractiveFrame c={c}>
          <div className="space-y-0.5" data-testid="wabiz-out-order">
            <p className="text-micro text-muted-foreground">Order {str(c.referenceId)}{c.goods ? ` · ${str(c.goods)}` : ""}</p>
            {items.map((it, i) => <p key={i} className="text-caption">{str(it.quantity)}× {str(it.name)} <span className="text-muted-foreground">{str(it.saleAmount ?? it.amount)}</span></p>)}
            {c.tax !== undefined && <p className="text-caption text-muted-foreground">Tax {str(c.tax)}</p>}
            {c.shipping !== undefined && <p className="text-caption text-muted-foreground">Shipping {str(c.shipping)}</p>}
            {c.discount !== undefined && <p className="text-caption text-muted-foreground">Discount −{str(c.discount)}</p>}
            <p className="text-caption font-medium">Total {Math.round(total * 100) / 100}</p>
            {c.paymentSettings ? <Chip icon={Wallet} tone="info">Pay in WhatsApp</Chip> : null}
          </div>
        </InteractiveFrame>
      );
    }
    case "order_status":
      return <InteractiveFrame c={c}><Chip icon={Package} tone="info" testId="wabiz-out-order-status">Order {str(c.referenceId)}: {str(c.status)}{c.description ? ` — ${str(c.description)}` : ""}</Chip></InteractiveFrame>;
    case "location":
      return <LocationView c={c} />;
    case "contacts":
      return <ContactsView list={arr(c.contacts)} />;
    case "reaction":
      return <Chip icon={SmilePlus}>{str(c.emoji) ? `Reacted ${str(c.emoji)}` : "Reaction removed"}</Chip>;
    default:
      return <Lines text={m.text} />;
  }
}

function LocationView({ c }: { c: Content }) {
  const lat = Number(c.latitude);
  const lng = Number(c.longitude);
  return (
    <a href={str(c.url) || `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`} target="_blank" rel="noreferrer"
      className="flex items-start gap-1.5 text-caption hover:underline" data-testid="wabiz-location">
      <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
      <span>{[str(c.name), str(c.address)].filter(Boolean).join(", ") || "Location"} <span className="text-muted-foreground">({lat}, {lng})</span></span>
    </a>
  );
}

function ContactsView({ list }: { list: unknown[] }) {
  return (
    <div className="space-y-1" data-testid="wabiz-contacts-card">
      {list.map((x, i) => {
        const c = obj(x);
        const name = str(obj(c.name).formatted_name) || str(c.name);
        const phones = arr(c.phones).map((p) => str(obj(p).phone)).filter(Boolean);
        const emails = arr(c.emails).map((e) => str(obj(e).email)).filter(Boolean);
        return (
          <div key={i} className="flex items-start gap-1.5 text-caption">
            <User className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span><span className="font-medium">{name}</span> {[...phones, ...emails].join(", ")}</span>
          </div>
        );
      })}
    </div>
  );
}

/** A message from the contact: text, a reply to an interactive message, an order, a payment, a location… */
function InboundContent({ m, c }: { m: WaBusinessMessage; c: Content }) {
  const reply = str(c.reply);
  if (reply === "button" || reply === "template_button") {
    return (
      <div className="space-y-1">
        <Chip icon={CornerUpLeft} tone="info" testId="wabiz-reply-button">{reply === "button" ? "Button" : "Template button"}: {str(c.title ?? c.text)}</Chip>
        <p className="text-micro text-muted-foreground font-mono">{reply === "button" ? `id ${str(c.id)}` : c.payload ? `payload ${str(c.payload)}` : ""}</p>
      </div>
    );
  }
  if (reply === "list") {
    return (
      <div className="space-y-1">
        <Chip icon={ListChecks} tone="info" testId="wabiz-reply-list">Chose: {str(c.title)}</Chip>
        {c.description ? <p className="text-caption text-muted-foreground">{str(c.description)}</p> : null}
        <p className="text-micro text-muted-foreground font-mono">id {str(c.id)}</p>
      </div>
    );
  }
  if (reply === "flow") {
    return (
      <div className="space-y-1" data-testid="wabiz-reply-flow">
        <Chip icon={Workflow} tone="success">Flow completed{c.name && c.name !== "flow" ? `: ${str(c.name)}` : ""}</Chip>
        <KeyValues value={c.response} />
      </div>
    );
  }
  if (reply === "address") {
    return (
      <div className="space-y-1" data-testid="wabiz-reply-address">
        <Chip icon={MapPin} tone="success">Address sent</Chip>
        <KeyValues value={obj(c.address).values ?? c.address} />
      </div>
    );
  }
  if (reply === "call_permission") {
    return (
      <Chip icon={Phone} tone={c.response === "accept" ? "success" : "warning"} testId="wabiz-reply-call">
        Call permission {c.response === "accept" ? "granted" : "declined"}{c.permanent ? " (permanent)" : c.expiresAt ? ` until ${new Date(str(c.expiresAt)).toLocaleString()}` : ""}
      </Chip>
    );
  }
  if (c.order) {
    const o = obj(c.order);
    return (
      <div className="space-y-1" data-testid="wabiz-order">
        <Chip icon={ShoppingCart} tone="success">Order from the catalog</Chip>
        {o.text ? <Lines text={str(o.text)} /> : null}
        {arr(o.items).map(obj).map((it, i) => <p key={i} className="text-caption">{str(it.quantity)}× <span className="font-mono">{str(it.productRetailerId)}</span> <span className="text-muted-foreground">{str(it.itemPrice)} {str(it.currency)}</span></p>)}
        <p className="text-caption font-medium">Total {str(o.total)} {str(o.currency)}</p>
      </div>
    );
  }
  if (c.payment) {
    const p = obj(c.payment);
    const ok = ["captured", "success", "paid"].includes(str(p.status).toLowerCase());
    return <Chip icon={Wallet} tone={ok ? "success" : str(p.status).toLowerCase().includes("fail") ? "destructive" : "info"} testId="wabiz-payment">Payment {str(p.status)} · order {str(p.referenceId)}{p.amount !== undefined ? ` · ${str(p.amount)} ${str(p.currency)}` : ""}</Chip>;
  }
  if (c.product) {
    const p = obj(c.product);
    return <Chip icon={Package} testId="wabiz-product-enquiry">Asked about {str(p.title) || str(p.retailer_id)}</Chip>;
  }
  if (m.type === "location") return <LocationView c={c} />;
  if (m.type === "contacts") return <ContactsView list={arr(c.contacts)} />;
  if (c.system) return <p className="text-caption italic text-muted-foreground">{str(obj(c.system).body) || str(obj(c.system).type)}</p>;
  if (c.error) return <p className="text-caption italic text-muted-foreground">A message WhatsApp does not pass to businesses{obj(c.error).title ? `: ${str(obj(c.error).title)}` : ""}</p>;
  if (m.type === "request_welcome") return <Chip icon={Megaphone}>Opened the chat for the first time</Chip>;
  return <Lines text={m.text} />;
}

/** A template: its name and category, the text as filled, the other components' values. */
function TemplateContent({ m }: { m: WaBusinessMessage }) {
  const comps = obj(obj(m.content).components);
  const header = obj(comps.header);
  const buttons = arr(comps.buttons).map(obj);
  const cards = arr(comps.carousel);
  return (
    <div className="space-y-1.5" data-testid="wabiz-template">
      <div className="flex flex-wrap items-center gap-1">
        <Chip icon={Megaphone} tone="info">Template {m.template?.name ?? m.pending?.template}</Chip>
        {m.template?.language && <span className="text-micro text-muted-foreground">{m.template.language}</span>}
        {m.template?.category && <Badge variant="outline" className="font-normal text-micro">{m.template.category.toLowerCase()}</Badge>}
      </div>
      {!!header.type && header.type !== "text" && <Chip icon={header.type === "location" ? MapPin : FileText}>{str(header.type)} header{header.link ? `: ${str(header.link)}` : header.mediaId ? `: ${str(header.mediaId)}` : header.name ? `: ${str(header.name)}` : ""}</Chip>}
      <Lines text={m.text} />
      {buttons.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {buttons.map((b) => <Chip key={str(b.index)}>button {Number(b.index) + 1}: {str(b.text ?? b.payload ?? b.couponCode ?? b.flowToken)}</Chip>)}
        </div>
      )}
      {cards.length > 0 && <p className="text-micro text-muted-foreground">Carousel of {cards.length} card{cards.length === 1 ? "" : "s"}</p>}
      {comps.otp ? <p className="text-micro text-muted-foreground">One-time code sent</p> : null}
      {comps.offerExpiresAt ? <p className="text-micro text-muted-foreground">Offer ends {new Date(str(comps.offerExpiresAt)).toLocaleString()}</p> : null}
    </div>
  );
}

const STATUS_ORDER = ["accepted", "sent", "delivered", "read"];

export function StatusTicks({ m }: { m: WaBusinessMessage }) {
  if (m.direction !== "out") return null;
  const s = m.status;
  if (s === "failed") {
    const why = m.error ? [m.error.title, m.error.detail, m.error.code ? `(${m.error.code})` : ""].filter(Boolean).join(" ") : m.statuses.find((x) => x.error)?.error;
    return <span className="inline-flex items-center gap-1 text-destructive" data-testid="wabiz-status-failed" title={why}><AlertCircle className="h-3 w-3" /> Failed{why ? `: ${why}` : ""}</span>;
  }
  if (s === "pending_approval") return <span className="inline-flex items-center gap-1 text-warning" data-testid="wabiz-status-pending"><Clock className="h-3 w-3" /> Waiting for approval</span>;
  if (s === "rejected") return <span className="inline-flex items-center gap-1 text-destructive" data-testid="wabiz-status-rejected"><XCircle className="h-3 w-3" /> Rejected</span>;
  if (s === "deleted") return <span className="inline-flex items-center gap-1 text-muted-foreground"><Trash2 className="h-3 w-3" /> Deleted</span>;
  const label = STATUS_ORDER.includes(s) ? s : "sent";
  const Icon = label === "delivered" || label === "read" ? CheckCheck : label === "accepted" ? Clock : Check;
  return (
    <span className={cn("inline-flex items-center gap-0.5", label === "read" ? "text-info" : "text-muted-foreground")} data-testid={`wabiz-status-${label}`} aria-label={label} title={label}>
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

function snippet(m: WaBusinessMessage | undefined): string {
  if (!m) return "a message";
  if (m.revoked) return "a deleted message";
  if (m.media) return `${m.media.voice ? "voice note" : m.media.kind}${m.media.caption ? `: ${m.media.caption}` : ""}`;
  return (m.text ?? m.type).split("\n")[0]!.slice(0, 120);
}

export function WaMessageBubble({ channel, m, all, onReply, onReact, onMarkRead }: {
  channel: string;
  m: WaBusinessMessage;
  all: WaBusinessMessage[];
  onReply?: (m: WaBusinessMessage) => void;
  onReact?: (m: WaBusinessMessage, emoji: string) => void;
  onMarkRead?: (m: WaBusinessMessage) => void;
}) {
  const [picking, setPicking] = useState(false);
  const out = m.direction === "out";
  const c = obj(m.content);
  const quoted = m.context?.id && !["button", "list", "flow", "address", "template_button"].includes(str(c.reply)) ? all.find((x) => x.id === m.context!.id) : undefined;
  const repliedTo = str(c.to) ? all.find((x) => x.id === str(c.to)) : undefined;
  const real = !m.id.startsWith("pending_") && !m.id.startsWith("pay:");
  return (
    <div className={cn("flex", out ? "justify-end" : "justify-start")} data-testid="wabiz-message" data-direction={m.direction} data-type={m.type}>
      <div className={cn("group max-w-[85%] space-y-1 rounded-lg border px-3 py-2",
        out ? "border-primary/20 bg-primary/5" : "border-border/60 bg-muted/30",
        m.status === "failed" && "border-destructive/40")}>
        {(m.context?.forwarded || m.edited || m.revoked || m.referral || m.context?.referredProduct || (out && m.sentBy)) && (
          <div className="flex flex-wrap items-center gap-1.5 text-micro text-muted-foreground">
            {out && m.sentBy && <span>{m.sentBy}</span>}
            {m.context?.forwarded && <span className="inline-flex items-center gap-0.5" data-testid="wabiz-forwarded"><Forward className="h-3 w-3" />{m.context.frequentlyForwarded ? "Forwarded many times" : "Forwarded"}</span>}
            {m.edited && <span className="inline-flex items-center gap-0.5" data-testid="wabiz-edited"><Pencil className="h-3 w-3" />Edited</span>}
            {m.revoked && <span className="inline-flex items-center gap-0.5" data-testid="wabiz-revoked"><Trash2 className="h-3 w-3" />Deleted by the contact</span>}
            {m.referral && <span className="inline-flex items-center gap-0.5"><Megaphone className="h-3 w-3" />From an ad{obj(m.referral).headline ? `: ${str(obj(m.referral).headline)}` : ""}</span>}
            {m.context?.referredProduct?.productRetailerId && <span className="inline-flex items-center gap-0.5"><Package className="h-3 w-3" />About {m.context.referredProduct.productRetailerId}</span>}
          </div>
        )}
        {m.context?.id && (quoted || !str(c.reply)) && (
          <div className="border-l-2 border-primary/40 pl-2 text-caption text-muted-foreground" data-testid="wabiz-quoted">{snippet(quoted)}</div>
        )}
        {repliedTo && <div className="border-l-2 border-info/40 pl-2 text-micro text-muted-foreground">to: {snippet(repliedTo)}</div>}

        {m.revoked ? (
          <p className="text-caption italic text-muted-foreground">This message was deleted.</p>
        ) : m.type === "template" ? (
          <TemplateContent m={m} />
        ) : m.media ? (
          <div className="space-y-1">
            <WaMediaView channel={channel} message={m as WaBusinessMessage & { media: WaBizMedia }} />
            {m.media.caption && <Lines text={m.media.caption} />}
            {m.media.voice && m.text && m.text !== m.media.caption && (
              <p className="text-caption text-muted-foreground" data-testid="wabiz-transcript"><span className="font-medium">Transcript:</span> {m.text}</p>
            )}
          </div>
        ) : out ? (
          <OutboundContent m={m} c={c} />
        ) : (
          <InboundContent m={m} c={c} />
        )}

        {m.reactions?.length ? (
          <div className="flex flex-wrap gap-1" data-testid="wabiz-reactions">
            {m.reactions.map((r) => (
              <span key={`${r.by}${r.emoji}`} className="rounded-pill border border-border/60 bg-background px-1.5 text-caption" title={r.by === "contact" ? "The contact" : "The business"}>
                {r.emoji}<span className="ml-0.5 text-micro text-muted-foreground">{r.by === "contact" ? "contact" : "you"}</span>
              </span>
            ))}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-1.5 text-micro text-muted-foreground">
          {m.pricing?.category && <span>{m.pricing.category.toLowerCase()}{m.pricing.billable === false ? " (free)" : ""}</span>}
          <span>{new Date(m.createdAt).toLocaleString()}</span>
          <StatusTicks m={m} />
        </div>
        {real && !m.revoked && (onReply || onReact || onMarkRead) && (
          <div className="flex flex-wrap items-center gap-0.5">
            {onReply && <Button size="sm" variant="ghost" className="h-6 px-1.5 text-micro" onClick={() => onReply(m)}><CornerUpLeft className="h-3 w-3" /> Reply</Button>}
            {onReact && <Button size="sm" variant="ghost" className="h-6 px-1.5 text-micro" aria-expanded={picking} onClick={() => setPicking((p) => !p)}><SmilePlus className="h-3 w-3" /> React</Button>}
            {onMarkRead && !out && <Button size="sm" variant="ghost" className="h-6 px-1.5 text-micro" onClick={() => onMarkRead(m)}><CheckCheck className="h-3 w-3" /> Mark read</Button>}
            {picking && onReact && (
              <span className="flex flex-wrap items-center gap-0.5" data-testid="wabiz-react-picker">
                {QUICK_REACTIONS.map((e) => <button key={e} type="button" className="rounded-md px-1 text-small hover:bg-muted" aria-label={`React ${e}`} onClick={() => { setPicking(false); onReact(m, e); }}>{e}</button>)}
                {m.reactions?.some((r) => r.by === "business") && <button type="button" className="rounded-md px-1 text-micro text-muted-foreground hover:bg-muted" onClick={() => { setPicking(false); onReact(m, ""); }}>Remove</button>}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The conversation, oldest first (the API returns newest first). */
export function WaTranscript({ channel, messages, onReply, onReact, onMarkRead }: {
  channel: string;
  messages: WaBusinessMessage[];
  onReply?: (m: WaBusinessMessage) => void;
  onReact?: (m: WaBusinessMessage, emoji: string) => void;
  onMarkRead?: (m: WaBusinessMessage) => void;
}) {
  const ordered = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!ordered.length) return <p className="text-caption text-muted-foreground">No messages kept for this contact.</p>;
  return (
    <div className="space-y-2" data-testid="wabiz-transcript-list">
      {ordered.map((m) => <WaMessageBubble key={m.id} channel={channel} m={m} all={ordered} {...(onReply ? { onReply } : {})} {...(onReact ? { onReact } : {})} {...(onMarkRead ? { onMarkRead } : {})} />)}
    </div>
  );
}
