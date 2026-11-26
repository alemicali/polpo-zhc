/**
 * Managing a WhatsApp Business number from the channel's sheet: templates (create / edit / delete
 * with a JSON components editor, status, quality, category, rejection reason), the business
 * profile (about, description, address, email, websites, vertical, photo), the phone number
 * (quality, tier, name review; register, PIN, verification code, subscribe the app; the webhook
 * override for a Meta app shared by several instances), analytics (plain tables), Meta's account
 * updates and the blocked contacts.
 */
import { useMemo, useRef, useState } from "react";
import { Ban, ImageUp, Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  useWaAccountEvents, useWaAnalytics, useWaBlocked, useWaBusinessProfile, useWaBusinessStatus, useWaPhone, useWaTemplates,
  type WaBusinessAnalyticsKind, type WaBusinessAnalyticsQuery, type WaBusinessPhoneAction, type WaBusinessStatus, type WaBusinessTemplate,
  type WaBusinessTemplateDefinition,
} from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { cn } from "@/lib/utils";
import { WA_PROFILE_VERTICALS, fileToBase64, formatBytes, templateNeeds } from "./wabiz-lib";

const TONE = {
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-warning/30 bg-warning/10 text-warning",
  destructive: "border-destructive/30 bg-destructive/10 text-destructive",
  info: "border-info/30 bg-info/10 text-info",
  muted: "text-muted-foreground",
} as const;

export function templateStatusTone(status: string): keyof typeof TONE {
  const s = status.toUpperCase();
  if (s === "APPROVED") return "success";
  if (s === "PENDING" || s === "IN_APPEAL" || s === "PENDING_DELETION") return "warning";
  if (s === "REJECTED" || s === "DISABLED" || s === "PAUSED") return "destructive";
  return "muted";
}

export function qualityTone(q: string | undefined): keyof typeof TONE {
  const s = String(q ?? "").toUpperCase();
  if (s === "GREEN" || s === "HIGH") return "success";
  if (s === "YELLOW" || s === "MEDIUM") return "warning";
  if (s === "RED" || s === "LOW") return "destructive";
  return "muted";
}

function useRun() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(done);
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

function Labeled({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="flex items-center justify-between gap-2 text-xs font-medium">{label}{hint}</label>
      {children}
    </div>
  );
}

const counter = (v: string, max: number) => <span className={cn("text-micro", v.length > max ? "text-destructive" : "text-muted-foreground")}>{v.length}/{max}</span>;

// ── Templates ────────────────────────────────────────────────────────

const STARTER_COMPONENTS = JSON.stringify([
  { type: "HEADER", format: "TEXT", text: "Order update" },
  { type: "BODY", text: "Hi {{1}}, your order {{2}} has shipped.", example: { body_text: [["Mario", "A-1234"]] } },
  { type: "FOOTER", text: "Reply STOP to opt out" },
  { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Thanks" }] },
], null, 2);

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

function TemplateEditor({ open, template, onOpenChange, create, edit }: {
  open: boolean;
  template?: WaBusinessTemplate;
  onOpenChange: (o: boolean) => void;
  create: (d: WaBusinessTemplateDefinition) => Promise<unknown>;
  edit: (id: string, patch: { components?: Array<Record<string, unknown>>; category?: WaBusinessTemplateDefinition["category"] }) => Promise<void>;
}) {
  const editing = !!template;
  const [name, setName] = useState(template?.name ?? "");
  const [language, setLanguage] = useState(template?.language ?? "it");
  const [category, setCategory] = useState<WaBusinessTemplateDefinition["category"]>((template?.category as WaBusinessTemplateDefinition["category"]) ?? "UTILITY");
  const [format, setFormat] = useState<"POSITIONAL" | "NAMED">(template?.parameterFormat ?? "POSITIONAL");
  const [allowChange, setAllowChange] = useState(true);
  const [json, setJson] = useState(template ? JSON.stringify(template.components, null, 2) : STARTER_COMPONENTS);
  const { busy, run } = useRun();
  const nameProblem = !editing && !/^[a-z0-9_]{1,512}$/.test(name) ? "Name: lowercase letters, digits and underscores" : undefined;
  const problem = nameProblem ?? (!editing && !/^[a-z]{2,3}(_[A-Z]{2})?$/.test(language) ? "Language: a code like it or en_US" : componentsProblem(json));
  const needs = useMemo(() => {
    try { return templateNeeds({ components: JSON.parse(json), parameterFormat: format, category }); } catch { return undefined; }
  }, [json, format, category]);
  const save = () => void run("save", async () => {
    const components = JSON.parse(json) as Array<Record<string, unknown>>;
    if (editing) await edit(template!.id!, { components, ...(category !== template!.category ? { category } : {}) });
    else await create({ name, language, category, components, parameterFormat: format, allowCategoryChange: allowChange });
  }, editing ? "Template sent back to review" : "Template submitted to Meta's review").then((ok) => { if (ok) onOpenChange(false); });
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl" data-testid="wabiz-template-editor">
        <SheetHeader>
          <SheetTitle>{editing ? `Edit ${template!.name} (${template!.language})` : "New template"}</SheetTitle>
          <SheetDescription>Meta reviews every new or edited template; its status comes back by webhook and on sync. Components follow Meta's format (HEADER, BODY, FOOTER, BUTTONS, CAROUSEL, LIMITED_TIME_OFFER) with examples for the variables.</SheetDescription>
        </SheetHeader>
        <div className="space-y-3 px-4 pb-4">
          <div className="grid grid-cols-2 gap-2">
            <Labeled label="Name"><Input className="h-8 font-mono text-xs" value={name} disabled={editing} onChange={(e) => setName(e.target.value)} data-testid="wabiz-tpl-name" /></Labeled>
            <Labeled label="Language"><Input className="h-8 font-mono text-xs" value={language} disabled={editing} onChange={(e) => setLanguage(e.target.value)} /></Labeled>
            <Labeled label="Category">
              <Select value={category} onValueChange={(v) => setCategory(v as WaBusinessTemplateDefinition["category"])}>
                <SelectTrigger className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{(["UTILITY", "MARKETING", "AUTHENTICATION"] as const).map((c) => <SelectItem key={c} value={c} className="text-xs">{c.toLowerCase()}</SelectItem>)}</SelectContent>
              </Select>
            </Labeled>
            <Labeled label="Variables">
              <Select value={format} disabled={editing} onValueChange={(v) => setFormat(v as "POSITIONAL" | "NAMED")}>
                <SelectTrigger className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="POSITIONAL" className="text-xs">Positional ({"{{1}}"}, {"{{2}}"})</SelectItem>
                  <SelectItem value="NAMED" className="text-xs">Named ({"{{first_name}}"})</SelectItem>
                </SelectContent>
              </Select>
            </Labeled>
          </div>
          {!editing && (
            <label className="flex items-center gap-2 text-caption">
              <input type="checkbox" checked={allowChange} onChange={(e) => setAllowChange(e.target.checked)} /> Let Meta change the category when it does not match the content
            </label>
          )}
          <Labeled label="Components (JSON)">
            <Textarea rows={16} spellCheck={false} className="font-mono text-caption" value={json} onChange={(e) => setJson(e.target.value)} data-testid="wabiz-tpl-json" />
          </Labeled>
          {needs && !problem && (
            <p className="text-caption text-muted-foreground" data-testid="wabiz-tpl-editor-needs">
              Variables: {needs.body.length ? needs.body.map((n) => `{{${n}}}`).join(", ") : "none"}
              {needs.header ? ` · header ${needs.header.format.toLowerCase()}` : ""}
              {needs.buttons.length ? ` · ${needs.buttons.length} button${needs.buttons.length === 1 ? "" : "s"}` : ""}
              {needs.cards ? ` · ${needs.cards.length} cards` : ""}
            </p>
          )}
          <div className="flex items-center gap-2">
            {problem && <p className="min-w-0 flex-1 text-caption text-warning" data-testid="wabiz-tpl-editor-problem">{problem}</p>}
            <Button size="sm" className="ml-auto h-8 text-xs" disabled={!!problem || busy === "save"} onClick={save} data-testid="wabiz-tpl-save">
              {busy === "save" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : editing ? "Save and resubmit" : "Submit for review"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function WaTemplatesManager({ channel }: { channel: string }) {
  const { templates, syncedAt, isLoading, error, sync, create, edit, remove } = useWaTemplates(channel);
  const { busy, run } = useRun();
  const [editor, setEditor] = useState<{ template?: WaBusinessTemplate } | null>(null);
  const [deleting, setDeleting] = useState<{ t: WaBusinessTemplate; all: boolean } | null>(null);
  return (
    <div className="space-y-2" data-testid="wabiz-templates">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-caption text-muted-foreground">{templates.length} templates{syncedAt ? ` · synced ${new Date(syncedAt).toLocaleString()}` : ""}</span>
        <Button size="sm" variant="outline" className="ml-auto h-7 gap-1 text-xs" disabled={busy === "sync"} onClick={() => void run("sync", sync, "Templates synced")}>
          {busy === "sync" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Sync
        </Button>
        <Button size="sm" className="h-7 gap-1 text-xs" onClick={() => setEditor({})}><Plus className="h-3.5 w-3.5" /> New template</Button>
      </div>
      {isLoading && !templates.length && <p className="text-caption text-muted-foreground">Loading…</p>}
      {error && <p className="text-caption text-destructive">{error.message}</p>}
      {templates.map((t) => {
        const needs = templateNeeds(t);
        const body = t.components.find((c) => c.type.toUpperCase() === "BODY")?.text;
        return (
          <div key={`${t.name}|${t.language}`} className="space-y-1 rounded-md border border-border/40 px-2.5 py-1.5" data-testid={`wabiz-template-${t.name}`}>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-caption font-medium">{t.name}</span>
              <span className="text-micro text-muted-foreground">{t.language}</span>
              <Badge variant="outline" className="font-normal">{t.category.toLowerCase()}</Badge>
              <Badge variant="outline" className={cn("font-normal", TONE[templateStatusTone(t.status)])}>{t.status.toLowerCase()}</Badge>
              {t.quality && <Badge variant="outline" className={cn("font-normal", TONE[qualityTone(t.quality)])}>quality {t.quality.toLowerCase()}</Badge>}
              <span className="ml-auto flex gap-0.5">
                <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Edit ${t.name}`} disabled={!t.id} onClick={() => setEditor({ template: t })}><Pencil className="h-3.5 w-3.5" /></Button>
                <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" aria-label={`Delete ${t.name}`} onClick={() => setDeleting({ t, all: !t.id })}><Trash2 className="h-3.5 w-3.5" /></Button>
              </span>
            </div>
            {body && <p className="line-clamp-2 text-caption text-muted-foreground">{body}</p>}
            <p className="text-micro text-muted-foreground">
              {needs.body.length ? `${needs.named ? "named" : "positional"}: ${needs.body.map((n) => `{{${n}}}`).join(" ")}` : "no body variables"}
              {needs.header ? ` · header ${needs.header.format.toLowerCase()}` : ""}
              {needs.buttons.length ? ` · buttons ${needs.buttons.map((b) => b.type.toLowerCase()).join(", ")}` : ""}
              {needs.cards ? ` · carousel ${needs.cards.length}` : ""}
            </p>
            {t.rejectedReason && <p className="text-caption text-destructive">Rejected: {t.rejectedReason}</p>}
          </div>
        );
      })}
      {editor && <TemplateEditor open onOpenChange={(o) => { if (!o) setEditor(null); }} {...(editor.template ? { template: editor.template } : {})} create={create} edit={edit} />}
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => { if (!o) setDeleting(null); }}
        title={deleting ? `Delete ${deleting.t.name}${deleting.all ? "" : ` (${deleting.t.language})`}?` : ""}
        description={deleting?.all ? "Every language of this template is deleted at Meta. Its name cannot be reused for 30 days." : "Only this language is deleted at Meta. The name cannot be reused for 30 days."}
        confirmLabel="Delete" destructive loading={busy === "delete"}
        onConfirm={() => { const d = deleting!; void run("delete", () => remove(d.t.name, d.all ? undefined : d.t.id), "Template deleted").then(() => setDeleting(null)); }} />
    </div>
  );
}

// ── Profile ──────────────────────────────────────────────────────────

export function WaProfileEditor({ channel, canUploadPhoto }: { channel: string; canUploadPhoto: boolean }) {
  const { profile, isLoading, error, update } = useWaBusinessProfile(channel);
  const [draft, setDraft] = useState<{ about: string; description: string; address: string; email: string; website1: string; website2: string; vertical: string } | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { busy, run } = useRun();
  if (isLoading && !profile) return <p className="text-caption text-muted-foreground">Loading the profile…</p>;
  if (error && !profile) return <p className="text-caption text-destructive">{error.message}</p>;
  const d = draft ?? {
    about: profile?.about ?? "", description: profile?.description ?? "", address: profile?.address ?? "", email: profile?.email ?? "",
    website1: profile?.websites?.[0] ?? "", website2: profile?.websites?.[1] ?? "", vertical: profile?.vertical ?? "UNDEFINED",
  };
  const set = (patch: Partial<typeof d>) => setDraft({ ...d, ...patch });
  const photoProblem = photo && !["image/jpeg", "image/png"].includes(photo.type) ? "The photo must be JPEG or PNG" : photo && photo.size > 5 * 1024 * 1024 ? "The photo can be at most 5 MB" : undefined;
  const problem = d.about.length > 139 ? "About: at most 139 characters" : d.description.length > 512 ? "Description: at most 512 characters"
    : d.address.length > 256 ? "Address: at most 256 characters" : d.email.length > 128 ? "Email: at most 128 characters"
      : d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email) ? "Email: not an address" : [d.website1, d.website2].some((w) => w && !/^https?:\/\//.test(w)) ? "Websites start with http:// or https://" : photoProblem;
  const save = () => void run("save", async () => {
    const websites = [d.website1, d.website2].map((w) => w.trim()).filter(Boolean);
    await update({
      about: d.about, description: d.description, address: d.address, email: d.email, websites, vertical: d.vertical,
      ...(photo ? { photo: { data: await fileToBase64(photo), mimeType: photo.type, filename: photo.name } } : {}),
    });
    setDraft(null);
    setPhoto(null);
  }, "Profile saved");
  return (
    <div className="space-y-2" data-testid="wabiz-profile">
      <div className="flex items-center gap-3">
        {profile?.profilePictureUrl
          ? <img src={profile.profilePictureUrl} alt="Profile" className="h-14 w-14 rounded-avatar border object-cover" />
          : <div className="h-14 w-14 rounded-avatar border bg-muted/40" />}
        <div className="space-y-1">
          <input ref={fileRef} type="file" accept="image/jpeg,image/png" className="hidden" data-testid="wabiz-profile-photo" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={!canUploadPhoto} onClick={() => fileRef.current?.click()}><ImageUp className="h-3.5 w-3.5" /> {photo ? `${photo.name} (${formatBytes(photo.size)})` : "Change photo"}</Button>
          {!canUploadPhoto && <p className="text-micro text-muted-foreground">Set the Meta app's id (settings) to upload a photo.</p>}
        </div>
      </div>
      <Labeled label="About" hint={counter(d.about, 139)}><Input className="h-8 text-xs" value={d.about} onChange={(e) => set({ about: e.target.value })} data-testid="wabiz-profile-about" /></Labeled>
      <Labeled label="Description" hint={counter(d.description, 512)}><Textarea rows={3} className="text-small" value={d.description} onChange={(e) => set({ description: e.target.value })} /></Labeled>
      <div className="grid grid-cols-2 gap-2">
        <Labeled label="Address" hint={counter(d.address, 256)}><Input className="h-8 text-xs" value={d.address} onChange={(e) => set({ address: e.target.value })} /></Labeled>
        <Labeled label="Email"><Input className="h-8 text-xs" value={d.email} onChange={(e) => set({ email: e.target.value })} data-testid="wabiz-profile-email" /></Labeled>
        <Labeled label="Website"><Input className="h-8 text-xs" placeholder="https://" value={d.website1} onChange={(e) => set({ website1: e.target.value })} /></Labeled>
        <Labeled label="Second website"><Input className="h-8 text-xs" placeholder="https://" value={d.website2} onChange={(e) => set({ website2: e.target.value })} /></Labeled>
        <Labeled label="Industry">
          <Select value={d.vertical} onValueChange={(v) => set({ vertical: v })}>
            <SelectTrigger className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{WA_PROFILE_VERTICALS.map((v) => <SelectItem key={v} value={v} className="text-xs">{v.toLowerCase().replace(/_/g, " ")}</SelectItem>)}</SelectContent>
          </Select>
        </Labeled>
      </div>
      <div className="flex items-center gap-2">
        {problem && <p className="min-w-0 flex-1 text-caption text-warning" data-testid="wabiz-profile-problem">{problem}</p>}
        <Button size="sm" className="ml-auto h-8 text-xs" disabled={!!problem || busy === "save" || (!draft && !photo)} onClick={save} data-testid="wabiz-profile-save">
          {busy === "save" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save profile"}
        </Button>
      </div>
    </div>
  );
}

// ── Phone number ─────────────────────────────────────────────────────

const PHONE_FIELDS: Array<[keyof NonNullable<WaBusinessStatus["phone"]>, string]> = [
  ["displayPhoneNumber", "Number"], ["verifiedName", "Display name"], ["nameStatus", "Name review"], ["newNameStatus", "New name review"],
  ["qualityRating", "Quality rating"], ["messagingLimitTier", "Messaging limit"], ["codeVerificationStatus", "Verification"], ["throughput", "Throughput"],
  ["platformType", "Platform"], ["accountMode", "Mode"], ["officialBusinessAccount", "Official business account"],
];

export function WaPhonePanel({ channel, status }: { channel: string; status: WaBusinessStatus }) {
  const [checkWebhook, setCheckWebhook] = useState(false);
  const { webhook, isLoading, error, setOverride, action } = useWaPhone(channel, { loadWebhook: checkWebhook });
  const { busy, run } = useRun();
  const [pin, setPin] = useState("");
  const [code, setCode] = useState("");
  const [method, setMethod] = useState<"SMS" | "VOICE">("SMS");
  const [codeLanguage, setCodeLanguage] = useState("it");
  const [deregister, setDeregister] = useState(false);
  const phone = status.phone;
  const pinOk = /^\d{6}$/.test(pin);
  const doAction = (a: WaBusinessPhoneAction, done: string) => run(a.action, () => action(a), done);
  return (
    <div className="space-y-3" data-testid="wabiz-phone">
      {phone ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-caption">
          {PHONE_FIELDS.filter(([k]) => phone[k]).map(([k, label]) => (
            <div key={k} className="flex min-w-0 items-center gap-1.5">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className={cn("min-w-0 truncate", k === "qualityRating" && TONE[qualityTone(phone[k])])} data-testid={`wabiz-phone-${k}`}>{String(phone[k])}</dd>
            </div>
          ))}
          <div className="col-span-2 text-micro text-muted-foreground">Checked {new Date(phone.checkedAt).toLocaleString()} (Test above reads it again)</div>
        </dl>
      ) : <p className="text-caption text-muted-foreground">Run Test above to read the number's quality, tier and name review from Meta.</p>}

      <div className="space-y-2">
        <p className="text-xs font-medium">Registration and two-step verification</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Input className="h-8 w-32 font-mono text-xs" inputMode="numeric" maxLength={6} placeholder="6-digit PIN" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} data-testid="wabiz-phone-pin" />
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!pinOk || !!busy} onClick={() => void doAction({ action: "register", pin }, "Number registered")}>Register</Button>
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!pinOk || !!busy} onClick={() => void doAction({ action: "set_pin", pin }, "Two-step PIN set")}>Set PIN</Button>
          <Button size="sm" variant="ghost" className="h-8 text-xs text-destructive hover:text-destructive" disabled={!!busy} onClick={() => setDeregister(true)}>Deregister</Button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Select value={method} onValueChange={(v) => setMethod(v as "SMS" | "VOICE")}>
            <SelectTrigger className="h-8 w-24 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="SMS" className="text-xs">SMS</SelectItem><SelectItem value="VOICE" className="text-xs">Voice</SelectItem></SelectContent>
          </Select>
          <Input className="h-8 w-20 font-mono text-xs" value={codeLanguage} onChange={(e) => setCodeLanguage(e.target.value)} aria-label="Language of the code message" />
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!!busy} onClick={() => void doAction({ action: "request_code", method, language: codeLanguage }, "Code requested")}>Request code</Button>
          <Input className="h-8 w-28 font-mono text-xs" inputMode="numeric" placeholder="Code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!/^\d{4,8}$/.test(code) || !!busy} onClick={() => void doAction({ action: "verify_code", code }, "Number verified")}>Verify</Button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!!busy} onClick={() => void doAction({ action: "subscribe_app" }, "App subscribed to the account's webhooks")}>Subscribe the app</Button>
          <span className="text-micro text-muted-foreground">Without it no message reaches the webhook.</span>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium">Webhook for this number (one Meta app shared by several instances)</p>
        <p className="text-micro text-muted-foreground">Point this number's deliveries at this instance with its own callback, instead of the app's. Routes to other instances are in the channel's settings.</p>
        {!checkWebhook ? (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setCheckWebhook(true)} data-testid="wabiz-webhook-check">Check at Meta</Button>
        ) : isLoading && !webhook ? <p className="text-caption text-muted-foreground">Reading Meta's configuration…</p>
          : error && !webhook ? <p className="text-caption text-destructive">{error.message}</p>
            : webhook && (
              <div className="space-y-1 text-caption" data-testid="wabiz-webhook">
                <p><span className="text-muted-foreground">Here:</span> <span className="font-mono">{webhook.callbackUrl ?? "POLPO_PUBLIC_URL not set"}</span></p>
                <p><span className="text-muted-foreground">App callback:</span> <span className="font-mono">{webhook.current.application ?? "—"}</span></p>
                <p><span className="text-muted-foreground">Account override:</span> <span className="font-mono">{webhook.current.whatsappBusinessAccount ?? "—"}</span></p>
                <p><span className="text-muted-foreground">This number's override:</span> <span className="font-mono">{webhook.current.phoneNumber ?? "none"}</span>
                  {webhook.callbackUrl && webhook.current.phoneNumber === webhook.callbackUrl && <Badge variant="outline" className={cn("ml-1.5 font-normal", TONE.success)}>points here</Badge>}</p>
                <div className="flex gap-1.5 pt-1">
                  <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!webhook.callbackUrl || busy === "override"} onClick={() => void run("override", () => setOverride(true), "This number now delivers here")}>Point it here</Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={!webhook.current.phoneNumber || busy === "override"} onClick={() => void run("override", () => setOverride(false), "Override removed")}>Remove the override</Button>
                </div>
              </div>
            )}
      </div>
      <ConfirmDialog open={deregister} onOpenChange={setDeregister} title="Deregister the number?"
        description="The number stops working with the Cloud API until it is registered again (with the PIN). Messages are not received meanwhile."
        confirmLabel="Deregister" destructive loading={busy === "deregister"}
        onConfirm={() => void doAction({ action: "deregister" }, "Number deregistered").then(() => setDeregister(false))} />
    </div>
  );
}

// ── Analytics ────────────────────────────────────────────────────────

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

const cell = (k: string, v: unknown) => {
  if ((k === "start" || k === "end") && typeof v === "number") return new Date(v * 1000).toLocaleDateString();
  if (k === "clicked" && Array.isArray(v)) return String(v.reduce((n, c) => n + Number((c as { count?: unknown }).count ?? 0), 0));
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(4);
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v ?? "");
};

const GRANULARITY: Record<WaBusinessAnalyticsKind, string[]> = { messages: ["DAY", "HALF_HOUR", "MONTH"], pricing: ["DAILY", "HALF_HOUR", "MONTHLY"], templates: ["DAILY"] };
const DIMENSIONS = ["PRICING_CATEGORY", "PRICING_TYPE", "COUNTRY", "PHONE", "TIER"];

export function WaAnalyticsPanel({ channel }: { channel: string }) {
  const { templates } = useWaTemplates(channel);
  const [kind, setKind] = useState<WaBusinessAnalyticsKind>("messages");
  const [days, setDays] = useState("30");
  const [granularity, setGranularity] = useState("DAY");
  const [dimensions, setDimensions] = useState<string[]>(["PRICING_CATEGORY"]);
  const [templateIds, setTemplateIds] = useState<string[]>([]);
  const [query, setQuery] = useState<WaBusinessAnalyticsQuery>();
  const { data, isLoading, error } = useWaAnalytics(channel, query);
  const rows = useMemo(() => analyticsRows(data), [data]);
  const columns = useMemo(() => [...new Set(rows.flatMap((r) => Object.keys(r)))], [rows]);
  const withIds = templates.filter((t) => t.id);
  const load = () => {
    const end = Math.floor(Date.now() / 1000);
    const start = end - Number(days) * 86_400;
    setQuery({ kind, start, end, granularity, ...(kind === "pricing" && dimensions.length ? { dimensions } : {}), ...(kind === "templates" ? { templateIds } : {}) });
  };
  return (
    <div className="space-y-2" data-testid="wabiz-analytics">
      <div className="flex flex-wrap items-center gap-1.5">
        <Select value={kind} onValueChange={(v) => { const k = v as WaBusinessAnalyticsKind; setKind(k); setGranularity(GRANULARITY[k][0]!); }}>
          <SelectTrigger className="h-8 w-32 text-xs" aria-label="What"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="messages" className="text-xs">Messages</SelectItem>
            <SelectItem value="pricing" className="text-xs">Pricing</SelectItem>
            <SelectItem value="templates" className="text-xs">Templates</SelectItem>
          </SelectContent>
        </Select>
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger className="h-8 w-32 text-xs" aria-label="Period"><SelectValue /></SelectTrigger>
          <SelectContent>{["1", "7", "30", "90"].map((d) => <SelectItem key={d} value={d} className="text-xs">Last {d} day{d === "1" ? "" : "s"}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={granularity} onValueChange={setGranularity}>
          <SelectTrigger className="h-8 w-32 text-xs" aria-label="Granularity"><SelectValue /></SelectTrigger>
          <SelectContent>{GRANULARITY[kind].map((g) => <SelectItem key={g} value={g} className="text-xs">{g.toLowerCase().replace("_", " ")}</SelectItem>)}</SelectContent>
        </Select>
        <Button size="sm" className="h-8 text-xs" disabled={kind === "templates" && !templateIds.length} onClick={load} data-testid="wabiz-analytics-load">
          {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Show"}
        </Button>
      </div>
      {kind === "pricing" && (
        <div className="flex flex-wrap gap-1">
          {DIMENSIONS.map((d) => {
            const on = dimensions.includes(d);
            return <Button key={d} size="sm" variant={on ? "default" : "outline"} className="h-6 text-micro" aria-pressed={on} onClick={() => setDimensions(on ? dimensions.filter((x) => x !== d) : [...dimensions, d])}>{d.toLowerCase().replace("_", " ")}</Button>;
          })}
        </div>
      )}
      {kind === "templates" && (
        <div className="flex flex-wrap gap-1">
          {withIds.length === 0 && <span className="text-caption text-muted-foreground">Sync the templates first.</span>}
          {withIds.map((t) => {
            const on = templateIds.includes(t.id!);
            return <Button key={t.id} size="sm" variant={on ? "default" : "outline"} className="h-6 text-micro" aria-pressed={on} disabled={!on && templateIds.length >= 10}
              onClick={() => setTemplateIds(on ? templateIds.filter((x) => x !== t.id) : [...templateIds, t.id!])}>{t.name} · {t.language}</Button>;
          })}
        </div>
      )}
      {error && <p className="text-caption text-destructive">{error.message}</p>}
      {query && !isLoading && !error && rows.length === 0 && <p className="text-caption text-muted-foreground">No data for this period.</p>}
      {rows.length > 0 && (
        <div className="max-h-80 overflow-auto rounded-md border border-border/40">
          <Table data-testid="wabiz-analytics-table">
            <TableHeader><TableRow>{columns.map((c) => <TableHead key={c} className="text-micro">{c.replace(/_/g, " ")}</TableHead>)}</TableRow></TableHeader>
            <TableBody>
              {rows.map((r, i) => <TableRow key={i}>{columns.map((c) => <TableCell key={c} className="text-caption">{cell(c, r[c])}</TableCell>)}</TableRow>)}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-micro text-muted-foreground">Conversation analytics were retired by Meta: messages, pricing and template metrics are what remains.</p>
    </div>
  );
}

// ── Account updates, blocked ─────────────────────────────────────────

export function WaAccountEventsList({ channel }: { channel: string }) {
  const { events, isLoading, error, refetch } = useWaAccountEvents(channel, 100);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-1.5" data-testid="wabiz-account-events">
      <div className="flex items-center gap-2">
        <span className="text-caption text-muted-foreground">Quality and tier changes, display name reviews, template status / quality / category, capabilities, alerts.</span>
        <Button size="icon" variant="ghost" className="ml-auto h-7 w-7" aria-label="Reload" onClick={() => void refetch()}>{isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}</Button>
      </div>
      {error && <p className="text-caption text-destructive">{error.message}</p>}
      {!isLoading && !events.length && <p className="text-caption text-muted-foreground">No account updates yet.</p>}
      {events.map((e) => (
        <button key={e.id} type="button" className="w-full rounded-md border border-border/40 px-2.5 py-1.5 text-left hover:bg-muted/30" onClick={() => setOpen(open === e.id ? null : e.id)} data-testid="wabiz-account-event">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="font-mono font-normal">{e.field}</Badge>
            <span className="min-w-0 flex-1 text-caption">{e.summary}</span>
            <span className="text-micro text-muted-foreground">{new Date(e.at).toLocaleString()}</span>
          </div>
          {open === e.id && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-micro text-muted-foreground">{JSON.stringify(e.value, null, 2)}</pre>}
        </button>
      ))}
    </div>
  );
}

export function WaBlockedList({ channel }: { channel: string }) {
  const { blocked, isLoading, error, block, unblock } = useWaBlocked(channel);
  const [numbers, setNumbers] = useState("");
  const { busy, run } = useRun();
  const list = numbers.split(/[\s,]+/).map((x) => x.replace(/[^\d]/g, "")).filter(Boolean);
  const check = async (r: { failed: Array<{ user: string; error: string }> }) => { if (r.failed.length) throw new Error(r.failed.map((f) => `${f.user}: ${f.error}`).join("; ")); };
  return (
    <div className="space-y-2" data-testid="wabiz-blocked">
      <p className="text-caption text-muted-foreground">Blocked contacts cannot write to the number and get nothing from it. Meta blocks only people who wrote in the last 24 hours.</p>
      <div className="flex items-center gap-1.5">
        <Input className="h-8 font-mono text-xs" placeholder="393331234567, 393339876543" value={numbers} onChange={(e) => setNumbers(e.target.value)} data-testid="wabiz-block-input" />
        <Button size="sm" variant="outline" className="h-8 gap-1 text-xs" disabled={!list.length || busy === "block"} onClick={() => void run("block", async () => check(await block(list)), "Blocked").then((ok) => { if (ok) setNumbers(""); })}>
          <Ban className="h-3.5 w-3.5" /> Block
        </Button>
      </div>
      {error && <p className="text-caption text-destructive">{error.message}</p>}
      {isLoading && !blocked.length && <p className="text-caption text-muted-foreground">Loading…</p>}
      {!isLoading && !error && !blocked.length && <p className="text-caption text-muted-foreground">Nobody is blocked.</p>}
      {blocked.map((u) => (
        <div key={u} className="flex items-center gap-2 rounded-md border border-border/40 px-2.5 py-1 text-caption" data-testid={`wabiz-blocked-${u}`}>
          <span className="font-mono">{u}</span>
          <Button size="sm" variant="ghost" className="ml-auto h-7 text-xs" disabled={busy === u} onClick={() => void run(u, async () => check(await unblock([u])), `${u} unblocked`)}>Unblock</Button>
        </div>
      ))}
    </div>
  );
}

/** Every management panel of a number, as tabs (in the channel's sheet). */
export function WaBusinessManage({ channel }: { channel: string }) {
  const { status } = useWaBusinessStatus(channel);
  return (
    <Tabs defaultValue="templates" className="w-full" data-testid="wabiz-manage">
      <TabsList className="flex h-auto w-full flex-wrap justify-start">
        <TabsTrigger value="templates" className="text-xs">Templates</TabsTrigger>
        <TabsTrigger value="profile" className="text-xs">Profile</TabsTrigger>
        <TabsTrigger value="phone" className="text-xs">Phone number</TabsTrigger>
        <TabsTrigger value="analytics" className="text-xs">Analytics</TabsTrigger>
        <TabsTrigger value="account" className="text-xs">Account updates</TabsTrigger>
        <TabsTrigger value="blocked" className="text-xs">Blocked</TabsTrigger>
      </TabsList>
      <TabsContent value="templates"><WaTemplatesManager channel={channel} /></TabsContent>
      <TabsContent value="profile"><WaProfileEditor channel={channel} canUploadPhoto={!!status?.capabilities?.profilePhoto} /></TabsContent>
      <TabsContent value="phone">{status ? <WaPhonePanel channel={channel} status={status} /> : <p className="text-caption text-muted-foreground">Loading…</p>}</TabsContent>
      <TabsContent value="analytics"><WaAnalyticsPanel channel={channel} /></TabsContent>
      <TabsContent value="account"><WaAccountEventsList channel={channel} /></TabsContent>
      <TabsContent value="blocked"><WaBlockedList channel={channel} /></TabsContent>
    </Tabs>
  );
}
