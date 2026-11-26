/**
 * The operator's composer in a contact's conversation. Inside the 24-hour window: text, media (a
 * file uploaded as base64, or a public link), reply buttons, a list, a CTA link button, a location
 * request, a location. Always: a template, with every component's values (header text / media /
 * location, positional or named body variables, button values, carousel cards, the one-time code)
 * checked against the synced definition — it shows which values are still needed and the filled
 * text before sending. Meta's limits are checked here too (the server checks them again).
 */
import { useMemo, useRef, useState } from "react";
import { Loader2, Paperclip, Plus, Send, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import type { WaBizFileInput, WaBizMediaKind, WaBizOutbound, WaBizTemplateInput, WaBusinessMessage, WaBusinessSendResult, WaBusinessTemplate } from "@polpo-ai/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  WA_LIMIT, cleanTemplateInput, fileToBase64, formatBytes, mediaKindFor, mediaProblem, outboundProblem, templateInputProblems, templateNeeds,
  templatePreviewText, type TemplateNeeds,
} from "./wabiz-lib";

export type ComposerMode = "text" | "media" | "buttons" | "list" | "cta" | "location_request" | "location" | "template";

const MODES: Array<{ mode: ComposerMode; label: string; window: boolean }> = [
  { mode: "text", label: "Text", window: true },
  { mode: "media", label: "Media", window: true },
  { mode: "buttons", label: "Buttons", window: true },
  { mode: "list", label: "List", window: true },
  { mode: "cta", label: "Link button", window: true },
  { mode: "location_request", label: "Ask location", window: true },
  { mode: "location", label: "Location", window: true },
  { mode: "template", label: "Template", window: false },
];

function Counter({ value, max }: { value: string; max: number }) {
  return <span className={cn("text-micro", value.length > max ? "text-destructive" : "text-muted-foreground")}>{value.length}/{max}</span>;
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="flex items-center justify-between gap-2 text-xs font-medium">{label}{hint}</label>
      {children}
    </div>
  );
}

export interface WaComposerProps {
  windowOpen: boolean;
  optedOut?: boolean;
  blocked?: boolean;
  templates: WaBusinessTemplate[];
  replyTo?: WaBusinessMessage;
  onClearReply?: () => void;
  send: (message: WaBizOutbound, file?: WaBizFileInput) => Promise<unknown>;
  sendTemplate: (input: { template: string; language?: string; components?: WaBizTemplateInput; queue?: boolean; reason?: string }) => Promise<WaBusinessSendResult>;
}

export function WaComposer({ windowOpen, optedOut, blocked, templates, replyTo, onClearReply, send, sendTemplate }: WaComposerProps) {
  const [mode, setMode] = useState<ComposerMode>(windowOpen ? "text" : "template");
  const active = !windowOpen && mode !== "template" ? "template" : mode;
  if (blocked) return <p className="text-caption text-warning" data-testid="wabiz-composer-blocked">This contact is blocked: unblock it to write.</p>;
  return (
    <div className="space-y-2" data-testid="wabiz-composer">
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Message type">
        {MODES.map((m) => {
          const disabled = m.window && !windowOpen;
          return (
            <Button key={m.mode} type="button" role="tab" aria-selected={active === m.mode} size="sm" variant={active === m.mode ? "default" : "outline"} className="h-7 text-xs"
              disabled={disabled} title={disabled ? "Only inside the 24-hour window: send a template" : undefined} onClick={() => setMode(m.mode)}>
              {m.label}
            </Button>
          );
        })}
      </div>
      {!windowOpen && <p className="text-caption text-muted-foreground">The 24-hour window is closed: only approved templates can be sent until the contact writes again.</p>}
      {replyTo && active !== "template" && (
        <div className="flex items-center gap-2 border-l-2 border-primary/40 pl-2 text-caption text-muted-foreground" data-testid="wabiz-replying-to">
          <span className="min-w-0 flex-1 truncate">Replying to: {(replyTo.text ?? replyTo.media?.kind ?? replyTo.type).split("\n")[0]}</span>
          <Button size="icon" variant="ghost" className="h-6 w-6" aria-label="Do not quote" onClick={onClearReply}><X className="h-3 w-3" /></Button>
        </div>
      )}
      {active === "template"
        ? <TemplateComposer templates={templates} optedOut={!!optedOut} sendTemplate={sendTemplate} />
        : <FreeFormComposer mode={active} replyTo={replyTo?.id} send={async (m, f) => { await send(m, f); onClearReply?.(); }} />}
    </div>
  );
}

function useSending() {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, done: string, after?: () => void) => {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      after?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

function SendBar({ problem, busy, onSend, label = "Send" }: { problem?: string; busy: boolean; onSend: () => void; label?: string }) {
  return (
    <div className="flex items-center gap-2">
      {problem && <p className="min-w-0 flex-1 text-caption text-warning" data-testid="wabiz-composer-problem">{problem}</p>}
      <Button size="sm" className="ml-auto h-8 gap-1.5 text-xs" disabled={busy || !!problem} onClick={onSend} data-testid="wabiz-composer-send">
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} {label}
      </Button>
    </div>
  );
}

function FreeFormComposer({ mode, replyTo, send }: { mode: Exclude<ComposerMode, "template">; replyTo?: string; send: (m: WaBizOutbound, f?: WaBizFileInput) => Promise<void> }) {
  const { busy, run } = useSending();
  const [text, setText] = useState("");
  const [header, setHeader] = useState("");
  const [footer, setFooter] = useState("");
  const [buttons, setButtons] = useState<Array<{ id: string; title: string }>>([{ id: "yes", title: "" }]);
  const [listButton, setListButton] = useState("");
  const [sections, setSections] = useState<Array<{ title: string; rows: Array<{ id: string; title: string; description: string }> }>>([{ title: "", rows: [{ id: "row_1", title: "", description: "" }] }]);
  const [cta, setCta] = useState({ displayText: "", url: "" });
  const [loc, setLoc] = useState({ latitude: "", longitude: "", name: "", address: "" });
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<WaBizMediaKind>("image");
  const [link, setLink] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const q = replyTo ? { replyTo } : {};

  const message: WaBizOutbound | undefined = useMemo(() => {
    const h = header.trim() ? { header: { type: "text" as const, text: header.trim() } } : {};
    const f = footer.trim() ? { footer: footer.trim() } : {};
    switch (mode) {
      case "text": return { type: "text", text, ...q };
      case "media": return {
        type: "media", kind, ...(file ? {} : link.trim() ? { link: link.trim() } : {}), ...(text.trim() && kind !== "audio" && kind !== "sticker" ? { caption: text.trim() } : {}),
        ...(kind === "document" && file ? { filename: file.name } : {}), ...q,
      } as WaBizOutbound;
      case "buttons": return { type: "buttons", body: text, ...h, ...f, buttons: buttons.map((b) => ({ id: b.id.trim(), title: b.title.trim() })), ...q };
      case "list": return {
        type: "list", body: text, ...(header.trim() ? { header: header.trim() } : {}), ...f, button: listButton.trim(),
        sections: sections.map((s) => ({ ...(s.title.trim() ? { title: s.title.trim() } : {}), rows: s.rows.map((r) => ({ id: r.id.trim(), title: r.title.trim(), ...(r.description.trim() ? { description: r.description.trim() } : {}) })) })), ...q,
      };
      case "cta": return { type: "cta_url", body: text, ...h, ...f, displayText: cta.displayText.trim(), url: cta.url.trim(), ...q };
      case "location_request": return { type: "location_request", body: text, ...q };
      case "location": return {
        type: "location", latitude: loc.latitude === "" ? Number.NaN : Number(loc.latitude), longitude: loc.longitude === "" ? Number.NaN : Number(loc.longitude),
        ...(loc.name.trim() ? { name: loc.name.trim() } : {}), ...(loc.address.trim() ? { address: loc.address.trim() } : {}), ...q,
      };
      default: return undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, text, header, footer, buttons, listButton, sections, cta, loc, file, kind, link, replyTo]);

  const fileProblem = mode === "media" && file ? mediaProblem(kind, file.type, file.size) : undefined;
  // a chosen file is uploaded by the server first: check the rest as if it had its media id
  const checked = message && mode === "media" && file ? ({ ...message, mediaId: "upload" } as WaBizOutbound) : message;
  const problem = fileProblem ?? (checked ? outboundProblem(checked) : undefined);

  const reset = () => {
    setText(""); setHeader(""); setFooter(""); setFile(null); setLink("");
    setButtons([{ id: "yes", title: "" }]); setListButton(""); setSections([{ title: "", rows: [{ id: "row_1", title: "", description: "" }] }]);
    setCta({ displayText: "", url: "" }); setLoc({ latitude: "", longitude: "", name: "", address: "" });
  };
  const submit = () => run(async () => {
    if (!message) return;
    const f = mode === "media" && file ? { data: await fileToBase64(file), mimeType: file.type || "application/octet-stream", filename: file.name } : undefined;
    await send(message, f);
  }, "Sent", reset);

  const bodyMax = mode === "text" ? WA_LIMIT.text : mode === "list" ? WA_LIMIT.bodyList : WA_LIMIT.bodyInteractive;
  const withHeader = mode === "buttons" || mode === "list" || mode === "cta";
  return (
    <div className="space-y-2" data-testid={`wabiz-composer-${mode}`}>
      {withHeader && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Header (optional)" hint={<Counter value={header} max={WA_LIMIT.header} />}><Input className="h-8 text-xs" value={header} onChange={(e) => setHeader(e.target.value)} /></Field>
          <Field label="Footer (optional)" hint={<Counter value={footer} max={WA_LIMIT.footer} />}><Input className="h-8 text-xs" value={footer} onChange={(e) => setFooter(e.target.value)} /></Field>
        </div>
      )}
      {mode === "media" && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileInput} type="file" className="hidden" data-testid="wabiz-composer-file"
              onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f) setKind(mediaKindFor(f.type)); }} />
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => fileInput.current?.click()}><Paperclip className="h-3.5 w-3.5" /> Choose a file</Button>
            {file && <span className="text-caption">{file.name} · {formatBytes(file.size)}<Button size="icon" variant="ghost" className="ml-1 h-6 w-6" aria-label="Remove the file" onClick={() => setFile(null)}><X className="h-3 w-3" /></Button></span>}
            <Select value={kind} onValueChange={(v) => setKind(v as WaBizMediaKind)}>
              <SelectTrigger className="h-8 w-32 text-xs" aria-label="Send as"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(["image", "video", "audio", "document", "sticker"] as const).map((k) => <SelectItem key={k} value={k} className="text-xs">{k}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {!file && <Input className="h-8 text-xs" placeholder="…or a public https link" value={link} onChange={(e) => setLink(e.target.value)} />}
        </div>
      )}
      {mode !== "location" && !(mode === "media" && (kind === "audio" || kind === "sticker")) && (
        <Field label={mode === "text" ? "Message" : mode === "media" ? "Caption (optional)" : "Body"} hint={<Counter value={text} max={mode === "media" ? WA_LIMIT.caption : bodyMax} />}>
          <Textarea rows={mode === "text" ? 3 : 2} className="text-small" value={text} onChange={(e) => setText(e.target.value)} data-testid="wabiz-composer-body" />
        </Field>
      )}
      {mode === "buttons" && (
        <div className="space-y-1.5">
          {buttons.map((b, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Input className="h-8 flex-1 text-xs" placeholder={`Button ${i + 1} title (≤ ${WA_LIMIT.buttonTitle})`} value={b.title} data-testid={`wabiz-button-title-${i}`}
                onChange={(e) => setButtons((bs) => bs.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
              <Input className="h-8 w-28 text-xs font-mono" placeholder="id" value={b.id} onChange={(e) => setButtons((bs) => bs.map((x, j) => (j === i ? { ...x, id: e.target.value } : x)))} />
              <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Remove button ${i + 1}`} disabled={buttons.length === 1} onClick={() => setButtons((bs) => bs.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
            </div>
          ))}
          <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" disabled={buttons.length >= WA_LIMIT.buttons} onClick={() => setButtons((bs) => [...bs, { id: `b${bs.length + 1}`, title: "" }])}>
            <Plus className="h-3.5 w-3.5" /> Add a button ({buttons.length}/{WA_LIMIT.buttons})
          </Button>
        </div>
      )}
      {mode === "list" && (
        <div className="space-y-2">
          <Field label="List button label" hint={<Counter value={listButton} max={WA_LIMIT.listButton} />}><Input className="h-8 text-xs" value={listButton} onChange={(e) => setListButton(e.target.value)} data-testid="wabiz-list-button" /></Field>
          {sections.map((s, si) => (
            <div key={si} className="space-y-1.5 border-l-2 border-border/60 pl-2">
              <div className="flex items-center gap-1.5">
                <Input className="h-8 flex-1 text-xs" placeholder={`Section ${si + 1} title${sections.length > 1 ? "" : " (optional)"}`} value={s.title}
                  onChange={(e) => setSections((ss) => ss.map((x, j) => (j === si ? { ...x, title: e.target.value } : x)))} />
                <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Remove section ${si + 1}`} disabled={sections.length === 1} onClick={() => setSections((ss) => ss.filter((_, j) => j !== si))}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
              {s.rows.map((r, ri) => (
                <div key={ri} className="flex items-center gap-1.5">
                  <Input className="h-8 flex-1 text-xs" placeholder={`Row title (≤ ${WA_LIMIT.rowTitle})`} value={r.title} data-testid={`wabiz-row-title-${si}-${ri}`}
                    onChange={(e) => setSections((ss) => ss.map((x, j) => (j === si ? { ...x, rows: x.rows.map((y, k) => (k === ri ? { ...y, title: e.target.value } : y)) } : x)))} />
                  <Input className="h-8 flex-1 text-xs" placeholder="Description (optional)" value={r.description}
                    onChange={(e) => setSections((ss) => ss.map((x, j) => (j === si ? { ...x, rows: x.rows.map((y, k) => (k === ri ? { ...y, description: e.target.value } : y)) } : x)))} />
                  <Input className="h-8 w-20 text-xs font-mono" placeholder="id" value={r.id}
                    onChange={(e) => setSections((ss) => ss.map((x, j) => (j === si ? { ...x, rows: x.rows.map((y, k) => (k === ri ? { ...y, id: e.target.value } : y)) } : x)))} />
                  <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Remove the row" disabled={s.rows.length === 1}
                    onClick={() => setSections((ss) => ss.map((x, j) => (j === si ? { ...x, rows: x.rows.filter((_, k) => k !== ri) } : x)))}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              ))}
              <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => setSections((ss) => ss.map((x, j) => (j === si ? { ...x, rows: [...x.rows, { id: `row_${ss.flatMap((y) => y.rows).length + 1}`, title: "", description: "" }] } : x)))}>
                <Plus className="h-3.5 w-3.5" /> Add a row
              </Button>
            </div>
          ))}
          <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" disabled={sections.length >= WA_LIMIT.sections} onClick={() => setSections((ss) => [...ss, { title: "", rows: [{ id: `row_${ss.flatMap((y) => y.rows).length + 1}`, title: "", description: "" }] }])}>
            <Plus className="h-3.5 w-3.5" /> Add a section
          </Button>
        </div>
      )}
      {mode === "cta" && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Button label" hint={<Counter value={cta.displayText} max={WA_LIMIT.ctaText} />}><Input className="h-8 text-xs" value={cta.displayText} onChange={(e) => setCta((c) => ({ ...c, displayText: e.target.value }))} data-testid="wabiz-cta-label" /></Field>
          <Field label="URL (https)"><Input className="h-8 text-xs font-mono" value={cta.url} placeholder="https://" onChange={(e) => setCta((c) => ({ ...c, url: e.target.value }))} data-testid="wabiz-cta-url" /></Field>
        </div>
      )}
      {mode === "location" && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Latitude"><Input className="h-8 text-xs" inputMode="decimal" value={loc.latitude} onChange={(e) => setLoc((l) => ({ ...l, latitude: e.target.value }))} data-testid="wabiz-lat" /></Field>
          <Field label="Longitude"><Input className="h-8 text-xs" inputMode="decimal" value={loc.longitude} onChange={(e) => setLoc((l) => ({ ...l, longitude: e.target.value }))} data-testid="wabiz-lng" /></Field>
          <Field label="Name (optional)"><Input className="h-8 text-xs" value={loc.name} onChange={(e) => setLoc((l) => ({ ...l, name: e.target.value }))} /></Field>
          <Field label="Address (optional)"><Input className="h-8 text-xs" value={loc.address} onChange={(e) => setLoc((l) => ({ ...l, address: e.target.value }))} /></Field>
        </div>
      )}
      <SendBar problem={problem} busy={busy} onSend={() => void submit()} />
    </div>
  );
}

/** The values a template needs, from its synced definition. */
export function TemplateValuesForm({ needs, input, onChange }: { needs: TemplateNeeds; input: WaBizTemplateInput; onChange: (next: WaBizTemplateInput) => void }) {
  const setBody = (name: string, i: number, v: string) => {
    if (needs.named) onChange({ ...input, body: { ...(input.body && !Array.isArray(input.body) ? input.body : {}), [name]: v } });
    else { const b = [...(Array.isArray(input.body) ? input.body : needs.body.map(() => ""))]; b[i] = v; onChange({ ...input, body: b }); }
  };
  const bodyValue = (name: string, i: number) => (Array.isArray(input.body) ? input.body[i] : input.body?.[name]) ?? "";
  const setButton = (index: number, patch: Record<string, string>) => {
    const others = (input.buttons ?? []).filter((b) => b.index !== index);
    const cur = (input.buttons ?? []).find((b) => b.index === index) ?? { index };
    onChange({ ...input, buttons: [...others, { ...cur, ...patch }].sort((a, b) => a.index - b.index) });
  };
  const button = (index: number) => (input.buttons ?? []).find((b) => b.index === index);
  const header = input.header;
  const media = needs.header && ["IMAGE", "VIDEO", "DOCUMENT"].includes(needs.header.format) ? needs.header.format.toLowerCase() as "image" | "video" | "document" : undefined;
  const otpButton = needs.buttons.some((b) => b.needs === "otp");
  return (
    <div className="space-y-2" data-testid="wabiz-template-values">
      {needs.header?.format === "TEXT" && needs.header.variable && (
        <Field label="Header variable"><Input className="h-8 text-xs" value={header?.type === "text" ? header.text : ""} data-testid="wabiz-tpl-header-text" onChange={(e) => onChange({ ...input, header: { type: "text", text: e.target.value } })} /></Field>
      )}
      {media && (
        <div className="grid grid-cols-2 gap-2">
          <Field label={`Header ${media}: public https link`}>
            <Input className="h-8 text-xs font-mono" data-testid="wabiz-tpl-header-link" value={header && header.type === media ? header.link ?? "" : ""}
              onChange={(e) => onChange({ ...input, header: { type: media, ...(e.target.value ? { link: e.target.value } : {}) } })} />
          </Field>
          <Field label="…or a Meta media id">
            <Input className="h-8 text-xs font-mono" value={header && header.type === media ? header.mediaId ?? "" : ""}
              onChange={(e) => onChange({ ...input, header: { type: media, ...(e.target.value ? { mediaId: e.target.value } : {}) } })} />
          </Field>
        </div>
      )}
      {needs.header?.format === "LOCATION" && (
        <div className="grid grid-cols-2 gap-2">
          {(["latitude", "longitude"] as const).map((k) => (
            <Field key={k} label={`Header ${k}`}>
              <Input className="h-8 text-xs" inputMode="decimal" value={header?.type === "location" && Number.isFinite(header[k]) ? String(header[k]) : ""}
                onChange={(e) => { const prev = header?.type === "location" ? header : { type: "location" as const, latitude: Number.NaN, longitude: Number.NaN }; onChange({ ...input, header: { ...prev, [k]: e.target.value === "" ? Number.NaN : Number(e.target.value) } }); }} />
            </Field>
          ))}
          {(["name", "address"] as const).map((k) => (
            <Field key={k} label={`Header ${k} (optional)`}>
              <Input className="h-8 text-xs" value={header?.type === "location" ? header[k] ?? "" : ""}
                onChange={(e) => { const prev = header?.type === "location" ? header : { type: "location" as const, latitude: Number.NaN, longitude: Number.NaN }; onChange({ ...input, header: { ...prev, [k]: e.target.value } }); }} />
            </Field>
          ))}
        </div>
      )}
      {needs.authentication && (
        <Field label="One-time code"><Input className="h-8 text-xs font-mono" maxLength={15} value={input.otp ?? ""} data-testid="wabiz-tpl-otp" onChange={(e) => onChange({ ...input, otp: e.target.value })} /></Field>
      )}
      {needs.body.length > 0 && !(needs.authentication && input.otp && input.body === undefined) && (
        <div className="grid grid-cols-2 gap-2">
          {needs.body.map((n, i) => (
            <Field key={n} label={`Body {{${n}}}`}>
              <Input className="h-8 text-xs" value={bodyValue(n, i)} data-testid={`wabiz-tpl-body-${n}`} onChange={(e) => setBody(n, i, e.target.value)} />
            </Field>
          ))}
        </div>
      )}
      {needs.limitedTimeOffer && (
        <Field label="Offer ends (optional)"><Input type="datetime-local" className="h-8 text-xs" value={input.offerExpiresAt ? input.offerExpiresAt.slice(0, 16) : ""}
          onChange={(e) => onChange({ ...input, ...(e.target.value ? { offerExpiresAt: new Date(e.target.value).toISOString() } : { offerExpiresAt: undefined }) })} /></Field>
      )}
      {needs.buttons.filter((b) => b.needs || b.optional === "payload" || b.optional === "flow").map((b) => (
        <Field key={b.index} label={`Button ${b.index + 1}${b.text ? ` "${b.text}"` : ""} · ${b.type.toLowerCase().replace(/_/g, " ")}${b.needs ? "" : " (optional)"}`}>
          {b.needs === "coupon_code"
            ? <Input className="h-8 text-xs font-mono" maxLength={15} placeholder="Coupon code" value={button(b.index)?.couponCode ?? ""} onChange={(e) => setButton(b.index, { couponCode: e.target.value })} />
            : b.needs === "text"
              ? <Input className="h-8 text-xs font-mono" placeholder={`The URL's variable (${b.url ?? ""})`} data-testid={`wabiz-tpl-button-${b.index}`} value={button(b.index)?.text ?? ""} onChange={(e) => setButton(b.index, { text: e.target.value })} />
              : b.needs === "otp"
                ? <p className="text-caption text-muted-foreground">{otpButton ? "Uses the one-time code above" : ""}</p>
                : b.optional === "flow"
                  ? <Input className="h-8 text-xs font-mono" placeholder="Flow token" value={button(b.index)?.flowToken ?? ""} onChange={(e) => setButton(b.index, { flowToken: e.target.value })} />
                  : <Input className="h-8 text-xs font-mono" placeholder="Payload sent back when tapped" value={button(b.index)?.payload ?? ""} onChange={(e) => setButton(b.index, { payload: e.target.value })} />}
        </Field>
      ))}
      {needs.cards?.map((card, ci) => {
        const c = input.carousel?.[ci] ?? {};
        const setCard = (patch: Record<string, unknown>) => {
          const cards = needs.cards!.map((_, j) => input.carousel?.[j] ?? {});
          cards[ci] = { ...c, ...patch };
          onChange({ ...input, carousel: cards });
        };
        const cardBody = (n: string, i: number) => (Array.isArray(c.body) ? c.body[i] : c.body?.[n]) ?? "";
        return (
          <div key={ci} className="space-y-1.5 border-l-2 border-border/60 pl-2" data-testid={`wabiz-tpl-card-${ci}`}>
            <p className="text-micro font-medium uppercase tracking-label text-muted-foreground">Card {ci + 1}</p>
            {card.header && (
              <Input className="h-8 text-xs font-mono" placeholder={`${card.header.toLowerCase()} https link`} value={c.header?.link ?? ""}
                onChange={(e) => setCard({ header: { type: card.header!.toLowerCase() === "video" ? "video" : "image", link: e.target.value } })} />
            )}
            {card.body.map((n, i) => (
              <Input key={n} className="h-8 text-xs" placeholder={`Body {{${n}}}`} value={cardBody(n, i)}
                onChange={(e) => {
                  if (needs.named) setCard({ body: { ...(c.body && !Array.isArray(c.body) ? c.body : {}), [n]: e.target.value } });
                  else { const b = [...(Array.isArray(c.body) ? c.body : card.body.map(() => ""))]; b[i] = e.target.value; setCard({ body: b }); }
                }} />
            ))}
            {card.buttons.filter((b) => b.needs === "text" || b.optional === "payload").map((b) => (
              <Input key={b.index} className="h-8 text-xs font-mono" placeholder={`Button ${b.index + 1} ${b.needs === "text" ? "URL variable" : "payload (optional)"}`}
                value={(b.needs === "text" ? c.buttons?.find((x) => x.index === b.index)?.text : c.buttons?.find((x) => x.index === b.index)?.payload) ?? ""}
                onChange={(e) => setCard({ buttons: [...(c.buttons ?? []).filter((x) => x.index !== b.index), { index: b.index, [b.needs === "text" ? "text" : "payload"]: e.target.value }] })} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function TemplateComposer({ templates, optedOut, sendTemplate }: { templates: WaBusinessTemplate[]; optedOut: boolean; sendTemplate: WaComposerProps["sendTemplate"] }) {
  const { busy, run } = useSending();
  const approved = templates.filter((t) => t.status.toUpperCase() === "APPROVED");
  const [key, setKey] = useState("");
  const [input, setInput] = useState<WaBizTemplateInput>({});
  const t = approved.find((x) => `${x.name}|${x.language}` === key);
  const needs = t ? templateNeeds(t) : undefined;
  const missing = needs ? templateInputProblems(needs, input) : [];
  if (optedOut) return <p className="text-caption text-warning">The contact opted out: no template can be sent until they opt in again.</p>;
  if (!approved.length) return <p className="text-caption text-muted-foreground">No approved templates: create one in Templates and wait for Meta's review, then sync.</p>;
  return (
    <div className="space-y-2" data-testid="wabiz-composer-template">
      <Select value={key} onValueChange={(v) => { setKey(v); setInput({}); }}>
        <SelectTrigger className="h-8 w-full text-xs" aria-label="Template" data-testid="wabiz-tpl-select"><SelectValue placeholder="Choose an approved template" /></SelectTrigger>
        <SelectContent>
          {approved.map((x) => <SelectItem key={`${x.name}|${x.language}`} value={`${x.name}|${x.language}`} className="text-xs">{x.name} · {x.language} · {x.category.toLowerCase()}</SelectItem>)}
        </SelectContent>
      </Select>
      {t && needs && (
        <>
          <p className="text-caption text-muted-foreground" data-testid="wabiz-tpl-needs">
            {needs.body.length || needs.header?.variable || needs.cards || needs.buttons.some((b) => b.needs) || (needs.header && needs.header.format !== "TEXT")
              ? `Needs: ${[
                needs.header && (needs.header.variable || needs.header.format !== "TEXT") ? `header ${needs.header.format.toLowerCase()}` : "",
                needs.body.length ? `${needs.named ? "named" : "positional"} body variables ${needs.body.map((n) => `{{${n}}}`).join(", ")}` : "",
                ...needs.buttons.filter((b) => b.needs).map((b) => `button ${b.index + 1} ${b.needs === "coupon_code" ? "coupon code" : b.needs === "otp" ? "code" : "URL variable"}`),
                needs.cards ? `${needs.cards.length} carousel cards` : "",
              ].filter(Boolean).join("; ")}`
              : "This template takes no values."}
          </p>
          <TemplateValuesForm needs={needs} input={input} onChange={setInput} />
          <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2" data-testid="wabiz-tpl-preview">
            <p className="mb-1 text-micro font-medium uppercase tracking-label text-muted-foreground">Preview</p>
            <p className="whitespace-pre-wrap text-small">{templatePreviewText(needs, input)}</p>
            {needs.buttons.length > 0 && <p className="mt-1 text-caption text-muted-foreground">{needs.buttons.map((b) => b.text ?? b.type.toLowerCase()).join(" · ")}</p>}
          </div>
          <SendBar problem={missing.length ? `Still needed: ${missing.join(", ")}` : undefined} busy={busy} label="Send template"
            onSend={() => void run(async () => {
              const r = await sendTemplate({ template: t.name, language: t.language, components: cleanTemplateInput(input) });
              if (r.status === "pending_approval") toast.info?.("Queued for approval");
            }, "Template sent", () => setInput({}))} />
        </>
      )}
    </div>
  );
}
