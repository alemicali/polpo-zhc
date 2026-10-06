/**
 * Custom LLM providers / AI gateways — wizard + provider cards (Config → Providers).
 *
 * Secrets are write-only: the API key and secret header values are sent once and stored
 * encrypted in the vault on the server; the UI only ever sees "key stored (…abcd)".
 */

import { useCallback, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Globe,
  KeyRound,
  Loader2,
  Lock,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldAlert,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import type { CustomModelDef, CustomProviderInfo, ProviderApi, ProviderAuthConfig } from "@polpo-ai/react";
import {
  COMPAT_FLAGS,
  COMPAT_FLAG_HELP,
  PROVIDER_API_LABELS,
  PROVIDER_APIS,
  PROVIDER_ID_RE,
  PROVIDER_PRESETS,
  PROXYABLE_PROVIDERS,
  defaultAuthFor,
  fillPresetUrl,
  getPreset,
  isLikelyLocalHost,
  normalizeBaseUrl,
  type ProviderPreset,
} from "@polpo-ai/core/provider-presets";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { ProviderIcon } from "@/components/shared/provider-icon";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────

import type { ApiFetch } from "@/hooks/use-custom-providers";

interface TestResult {
  ok: boolean;
  latencyMs?: number;
  model?: string;
  sample?: string;
  error?: string;
  stage?: string;
  hints: string[];
  suggestedCompat?: Record<string, unknown>;
  suggestions?: Array<{ flag: string; value: unknown; reason: string }>;
}

interface DiscoveredModel extends CustomModelDef {
  configured?: boolean;
}

interface DiscoveryResult {
  source: string;
  models: DiscoveredModel[];
  warnings: string[];
}

interface HeaderRow {
  name: string;
  value: string;
  /** Secret header already stored server-side (value hidden). */
  stored?: boolean;
  removed?: boolean;
}

interface Draft {
  id: string;
  label: string;
  preset?: string;
  proxyFor?: string;
  api: ProviderApi;
  baseUrl: string;
  fields: Record<string, string>;
  authType: ProviderAuthConfig["type"];
  headerName: string;
  prefix: string;
  envVar: string;
  apiKey: string;
  keyAction: "keep" | "replace" | "remove";
  headers: HeaderRow[];
  secretHeaders: HeaderRow[];
  allowPrivateNetwork: boolean;
  timeoutMs: string;
  maxRetries: string;
  compat: Record<string, unknown>;
  models: CustomModelDef[];
}

// ── Helpers ────────────────────────────────────────────────────────

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 41);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function presetTemplate(preset: ProviderPreset | undefined, fields: Record<string, string>): string {
  if (!preset) return "";
  return fillPresetUrl(preset.baseUrl, fields);
}

function draftFromPreset(preset: ProviderPreset, takenIds: Set<string>): Draft {
  let id = preset.suggestedId;
  for (let i = 2; takenIds.has(id); i++) id = `${preset.suggestedId}-${i}`;
  const isProxy = preset.id === "proxy";
  return {
    id,
    label: isProxy ? "Anthropic proxy" : preset.label,
    preset: preset.id,
    proxyFor: isProxy ? "anthropic" : undefined,
    api: preset.api,
    baseUrl: preset.fields ? "" : preset.baseUrl,
    fields: {},
    authType: preset.auth.type,
    headerName: preset.auth.headerName ?? "",
    prefix: preset.auth.prefix ?? "",
    envVar: preset.auth.envVar ?? "",
    apiKey: "",
    keyAction: "replace",
    headers: [],
    secretHeaders: [],
    allowPrivateNetwork: !!preset.local,
    timeoutMs: "",
    maxRetries: "",
    compat: { ...(preset.compat ?? {}) },
    models: [],
  };
}

function draftFromProvider(p: CustomProviderInfo): Draft {
  const api = (p.api ?? "openai-completions") as ProviderApi;
  const auth = p.auth ?? defaultAuthFor(api);
  return {
    id: p.id,
    label: p.label ?? p.id,
    preset: p.preset,
    proxyFor: p.proxyFor,
    api,
    baseUrl: p.baseUrl ?? "",
    fields: {},
    authType: auth.type,
    headerName: auth.headerName ?? "",
    prefix: auth.prefix ?? "",
    envVar: auth.envVar ?? "",
    apiKey: "",
    keyAction: p.hasKey ? "keep" : "replace",
    headers: Object.entries(p.headers ?? {}).map(([name, value]) => ({ name, value })),
    secretHeaders: (p.secretHeaderNames ?? []).map((name) => ({ name, value: "", stored: true })),
    allowPrivateNetwork: !!p.allowPrivateNetwork,
    timeoutMs: p.timeoutMs ? String(p.timeoutMs) : "",
    maxRetries: p.maxRetries !== undefined ? String(p.maxRetries) : "",
    compat: { ...(p.compat ?? {}) },
    models: (p.models ?? []).map((m) => ({ ...m })),
  };
}

/** Effective base URL: preset template (Cloudflare / Azure fields) or the typed one. */
function effectiveBaseUrl(d: Draft): string {
  const preset = getPreset(d.preset);
  if (preset?.fields && !d.baseUrl) return presetTemplate(preset, d.fields);
  return d.baseUrl;
}

function toProviderPayload(d: Draft) {
  const auth: ProviderAuthConfig = { type: d.authType };
  if (d.authType === "header") {
    auth.headerName = d.headerName.trim();
    if (d.prefix) auth.prefix = d.prefix;
  }
  if (d.authType !== "none" && d.envVar.trim()) auth.envVar = d.envVar.trim();
  const headers = Object.fromEntries(d.headers.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value]));
  return {
    label: d.label.trim() || undefined,
    preset: d.preset,
    proxyFor: d.proxyFor,
    api: d.api,
    baseUrl: effectiveBaseUrl(d),
    auth,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    compat: Object.keys(d.compat).length > 0 ? d.compat : undefined,
    allowPrivateNetwork: d.allowPrivateNetwork || undefined,
    timeoutMs: d.timeoutMs ? Number(d.timeoutMs) : undefined,
    maxRetries: d.maxRetries !== "" ? Number(d.maxRetries) : undefined,
    models: d.models,
  };
}

function toSecretsPayload(d: Draft) {
  const secrets: { apiKey?: string; secretHeaders?: Record<string, string | null> } = {};
  if (d.authType !== "none") {
    if (d.keyAction === "replace" && d.apiKey.trim()) secrets.apiKey = d.apiKey.trim();
    if (d.keyAction === "remove") secrets.apiKey = "";
  }
  const sh: Record<string, string | null> = {};
  for (const h of d.secretHeaders) {
    const name = h.name.trim();
    if (!name) continue;
    if (h.removed) sh[name] = null;
    else if (h.value) sh[name] = h.value;
  }
  if (Object.keys(sh).length > 0) secrets.secretHeaders = sh;
  return secrets;
}

const SECTION = "text-[10px] uppercase tracking-wider text-muted-foreground font-semibold";
const LABEL = "text-xs font-medium text-foreground";
const HELP = "text-[11px] text-muted-foreground";

function Field({ label, help, children }: { label: string; help?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className={LABEL}>{label}</span>
      {children}
      {help && <span className={cn(HELP, "block")}>{help}</span>}
    </label>
  );
}

function Toggle({ checked, onChange, label, help }: { checked: boolean; onChange: (v: boolean) => void; label: string; help?: string }) {
  return (
    <label className="flex items-start gap-2 cursor-pointer">
      <input type="checkbox" className="mt-0.5 h-3.5 w-3.5 accent-primary" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className={LABEL}>{label}</span>
        {help && <span className={cn(HELP, "block")}>{help}</span>}
      </span>
    </label>
  );
}

function Callout({ tone, children }: { tone: "warn" | "info" | "error" | "ok"; children: React.ReactNode }) {
  const styles = {
    warn: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    info: "border-border bg-muted/30 text-muted-foreground",
    error: "border-destructive/30 bg-destructive/10 text-destructive",
    ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  } as const;
  return <div className={cn("rounded-md border px-3 py-2 text-[11px] leading-relaxed", styles[tone])}>{children}</div>;
}

// ── Wizard ─────────────────────────────────────────────────────────

const PRESET_GROUPS: Array<{ kind: ProviderPreset["kind"][]; title: string }> = [
  { kind: ["gateway"], title: "Hosted gateways" },
  { kind: ["local"], title: "Local servers" },
  { kind: ["generic", "proxy"], title: "Any endpoint" },
];

export function CustomProviderWizard({
  apiFetch,
  existing,
  takenIds,
  onSaved,
  onCancel,
}: {
  apiFetch: ApiFetch;
  /** Edit mode when set. */
  existing?: CustomProviderInfo;
  takenIds: Set<string>;
  onSaved: (p: CustomProviderInfo) => void;
  onCancel: () => void;
}) {
  const editing = !!existing;
  const [step, setStep] = useState<1 | 2 | 3>(editing ? 2 : 1);
  const [draft, setDraft] = useState<Draft | null>(existing ? draftFromProvider(existing) : null);
  const [idTouched, setIdTouched] = useState(editing);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showCompat, setShowCompat] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  const [modelFilter, setModelFilter] = useState("");
  const [manualModel, setManualModel] = useState("");
  const [expandedModel, setExpandedModel] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const update = useCallback((patch: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setTestResult(null);
  }, []);

  const preset = getPreset(draft?.preset);
  const baseUrl = draft ? effectiveBaseUrl(draft) : "";
  const urlCheck = useMemo(() => (draft ? normalizeBaseUrl(baseUrl, draft.api) : { hints: [] as string[] }), [baseUrl, draft]);
  const host = urlCheck.url ? hostOf(urlCheck.url) : "";
  const looksLocal = !!host && isLikelyLocalHost(host.replace(/:\d+$/, ""));
  const idError = draft && !editing
    ? (!PROVIDER_ID_RE.test(draft.id) ? "2-41 chars: lowercase letters, digits, dashes" : takenIds.has(draft.id) ? "Already in use" : undefined)
    : undefined;
  const reusesBuiltinKey = !!draft?.proxyFor && draft.envVar === PROXYABLE_PROVIDERS[draft.proxyFor]?.envVar;
  const missingFields = preset?.fields?.filter((f) => !draft?.fields[f.key]?.trim() && !draft?.baseUrl) ?? [];
  const connectionValid = !!draft && !idError && !urlCheck.error && missingFields.length === 0
    && (draft.authType !== "header" || !!draft.headerName.trim());

  const choosePreset = (p: ProviderPreset) => {
    setDraft(draftFromPreset(p, takenIds));
    setIdTouched(false);
    setShowAdvanced(false);
    setStep(2);
  };

  const requestBody = useCallback((d: Draft, extra?: Record<string, unknown>) => JSON.stringify({
    id: editing ? d.id : undefined,
    provider: { ...toProviderPayload(d), baseUrl: normalizeBaseUrl(effectiveBaseUrl(d), d.api).url ?? effectiveBaseUrl(d) },
    secrets: toSecretsPayload(d),
    ...extra,
  }), [editing]);

  const runTest = async () => {
    if (!draft) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await apiFetch("/providers/custom/test", { method: "POST", body: requestBody(draft) });
      if (r.ok) setTestResult(r.data as TestResult);
      else setTestResult({ ok: false, error: r.error ?? "Test failed", hints: [] });
    } finally {
      setTesting(false);
    }
  };

  const runDiscover = async () => {
    if (!draft) return;
    setDiscovering(true);
    try {
      const r = await apiFetch("/providers/custom/discover", { method: "POST", body: requestBody(draft) });
      if (r.ok) {
        const result = r.data as DiscoveryResult;
        setDiscovery(result);
        if (result.models.length === 0) toast.info("No models discovered — add model ids manually");
      } else {
        setDiscovery({ source: "error", models: [], warnings: [r.error ?? "Discovery failed"] });
      }
    } finally {
      setDiscovering(false);
    }
  };

  const toggleModel = (m: DiscoveredModel) => {
    if (!draft) return;
    const exists = draft.models.some((x) => x.id === m.id);
    if (exists) {
      update({ models: draft.models.filter((x) => x.id !== m.id) });
    } else {
      const { configured: _configured, ...def } = m;
      update({ models: [...draft.models, { ...def, name: def.name || def.id }] });
    }
  };

  const addManualModel = () => {
    const id = manualModel.trim();
    if (!draft || !id || /\s/.test(id) || draft.models.some((m) => m.id === id)) return;
    update({ models: [...draft.models, { id, name: id }] });
    setManualModel("");
  };

  const patchModel = (id: string, patch: Partial<CustomModelDef>) => {
    if (!draft) return;
    update({ models: draft.models.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      const body = requestBody(draft);
      const parsed = JSON.parse(body) as { provider: unknown; secrets: unknown };
      const r = editing
        ? await apiFetch(`/providers/custom/${encodeURIComponent(draft.id)}`, { method: "PUT", body: JSON.stringify({ provider: parsed.provider, secrets: parsed.secrets }) })
        : await apiFetch("/providers/custom", { method: "POST", body: JSON.stringify({ id: draft.id, provider: parsed.provider, secrets: parsed.secrets }) });
      if (!r.ok) {
        setSaveError(r.error ?? "Save failed");
        return;
      }
      const saved = r.data as CustomProviderInfo;
      for (const w of saved.warnings ?? []) toast.warning(w);
      toast.success(editing ? `Updated ${saved.label ?? saved.id}` : `Added ${saved.label ?? saved.id}`);
      onSaved(saved);
    } finally {
      setSaving(false);
    }
  };

  // ── Step 1: presets ──
  if (step === 1 || !draft) {
    return (
      <div className="space-y-4">
        <p className={HELP}>
          Connect an AI gateway, a self-hosted server or any OpenAI / Anthropic-compatible endpoint. Its models become available
          everywhere as <code className="font-mono">id:model</code>.
        </p>
        {PRESET_GROUPS.map((group) => (
          <div key={group.title} className="space-y-2">
            <div className={SECTION}>{group.title}</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {PROVIDER_PRESETS.filter((p) => group.kind.includes(p.kind)).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => choosePreset(p)}
                  className="flex items-start gap-3 rounded-lg border border-border p-3 text-left hover:border-primary/40 hover:bg-accent/40 transition-colors"
                >
                  <div className="h-8 w-8 rounded-md border bg-card flex items-center justify-center shrink-0">
                    {p.kind === "local" ? <Server className="h-4 w-4 text-muted-foreground" />
                      : p.kind === "proxy" ? <Plug className="h-4 w-4 text-muted-foreground" />
                      : p.kind === "generic" ? <Globe className="h-4 w-4 text-muted-foreground" />
                      : <Cloud className="h-4 w-4 text-muted-foreground" />}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{p.label}</div>
                    <div className="text-[11px] text-muted-foreground leading-snug">{p.description}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    );
  }

  const compatFlags = COMPAT_FLAGS[draft.api] ?? {};
  const selectedIds = new Set(draft.models.map((m) => m.id));
  const filteredDiscovered = (discovery?.models ?? []).filter((m) => !modelFilter || m.id.toLowerCase().includes(modelFilter.toLowerCase()) || (m.name ?? "").toLowerCase().includes(modelFilter.toLowerCase()));

  return (
    <div className="space-y-4">
      {/* Stepper */}
      <div className="flex items-center gap-2 text-[11px]">
        {!editing && (
          <button type="button" className="text-muted-foreground hover:text-foreground flex items-center gap-1" onClick={() => setStep(1)}>
            <ArrowLeft className="h-3 w-3" /> Presets
          </button>
        )}
        <span className={cn("px-2 py-0.5 rounded-full", step === 2 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>1 · Connection</span>
        <ChevronRight className="h-3 w-3 text-muted-foreground" />
        <span className={cn("px-2 py-0.5 rounded-full", step === 3 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>2 · Test & models</span>
        {preset && <Badge variant="outline" className="ml-auto text-[10px]">{preset.label}</Badge>}
      </div>

      {step === 2 && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Name">
              <Input
                value={draft.label}
                onChange={(e) => update({ label: e.target.value, ...(idTouched || editing ? {} : { id: slugify(e.target.value) || draft.id }) })}
                placeholder="My gateway"
              />
            </Field>
            <Field label="ID" help={editing ? "Used in model specs — cannot be changed" : <>Models are referenced as <code className="font-mono">{draft.id || "id"}:model</code></>}>
              <Input
                value={draft.id}
                disabled={editing}
                onChange={(e) => { setIdTouched(true); update({ id: e.target.value.toLowerCase() }); }}
                className={cn("font-mono", idError && "border-destructive")}
              />
              {idError && <span className="text-[11px] text-destructive">{idError}</span>}
            </Field>
          </div>

          {draft.preset === "proxy" && (
            <Field label="Proxied provider" help="Catalog models (context window, pricing, reasoning) are reused for this endpoint.">
              <Select
                value={draft.proxyFor ?? "anthropic"}
                onValueChange={(v) => {
                  const p = PROXYABLE_PROVIDERS[v];
                  update({ proxyFor: v, api: p.api, authType: p.auth.type, envVar: "", label: draft.label === `${draft.proxyFor === "openai" ? "OpenAI" : "Anthropic"} proxy` ? `${v === "openai" ? "OpenAI" : "Anthropic"} proxy` : draft.label });
                }}
              >
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.keys(PROXYABLE_PROVIDERS).map((k) => (
                    <SelectItem key={k} value={k} className="text-xs">{k === "openai" ? "OpenAI" : "Anthropic"}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}

          {preset?.fields && !editing && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {preset.fields.map((f) => (
                <Field key={f.key} label={f.label} help={f.help}>
                  <Input
                    value={draft.fields[f.key] ?? ""}
                    placeholder={f.placeholder}
                    onChange={(e) => update({ fields: { ...draft.fields, [f.key]: e.target.value }, baseUrl: "" })}
                    className="font-mono text-xs"
                  />
                </Field>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
            <div className="sm:col-span-2">
            <Field label="API type">
              <Select value={draft.api} onValueChange={(v) => update({ api: v as ProviderApi, compat: {} })}>
                <SelectTrigger className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROVIDER_APIS.map((a) => <SelectItem key={a} value={a} className="text-xs">{PROVIDER_API_LABELS[a]}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            </div>
            <div className="sm:col-span-3">
              <Field label="Base URL">
                <Input
                  value={baseUrl}
                  onChange={(e) => update({ baseUrl: e.target.value })}
                  placeholder={draft.api === "anthropic-messages" ? "https://llm-proxy.example.com" : "https://llm.example.com/v1"}
                  className={cn("font-mono text-xs", urlCheck.error && baseUrl && "border-destructive")}
                />
              </Field>
            </div>
          </div>
          {baseUrl && urlCheck.error && <Callout tone="error">{urlCheck.error}</Callout>}
          {urlCheck.url && urlCheck.url !== baseUrl.trim() && (
            <Callout tone="info">Will be saved as <code className="font-mono">{urlCheck.url}</code></Callout>
          )}
          {urlCheck.hints.length > 0 && (
            <Callout tone="info">{urlCheck.hints.map((h) => <div key={h}>• {h}</div>)}</Callout>
          )}
          {missingFields.length > 0 && <Callout tone="info">Fill in {missingFields.map((f) => f.label).join(" and ")} to build the endpoint URL.</Callout>}

          {/* Auth */}
          <div className="rounded-lg border border-border/60 p-3 space-y-3">
            <div className="flex items-center gap-2"><KeyRound className="h-3.5 w-3.5 text-muted-foreground" /><span className={SECTION}>Authentication</span></div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="Method">
                <Select value={draft.authType} onValueChange={(v) => update({ authType: v as ProviderAuthConfig["type"] })}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none" className="text-xs">No key (local server)</SelectItem>
                    <SelectItem value="bearer" className="text-xs">Authorization: Bearer</SelectItem>
                    <SelectItem value="x-api-key" className="text-xs">x-api-key header</SelectItem>
                    <SelectItem value="header" className="text-xs">Custom header</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {draft.authType === "header" && (
                <>
                  <Field label="Header name">
                    <Input value={draft.headerName} onChange={(e) => update({ headerName: e.target.value })} placeholder="api-key" className="font-mono text-xs" />
                  </Field>
                  <Field label="Value prefix" help='Optional, e.g. "Bearer "'>
                    <Input value={draft.prefix} onChange={(e) => update({ prefix: e.target.value })} className="font-mono text-xs" />
                  </Field>
                </>
              )}
            </div>
            {draft.authType !== "none" && (
              <>
                {editing && existing?.hasKey && draft.keyAction !== "replace" ? (
                  <div className="flex items-center gap-2 text-xs">
                    <Lock className="h-3.5 w-3.5 text-emerald-500" />
                    {draft.keyAction === "keep"
                      ? <span>Key stored in the vault{existing.keyHint ? <> (…{existing.keyHint})</> : null}</span>
                      : <span className="text-destructive">Key will be removed on save</span>}
                    <Button type="button" variant="outline" size="sm" className="h-6 text-[11px] ml-auto" onClick={() => update({ keyAction: "replace" })}>Replace</Button>
                    {draft.keyAction === "keep"
                      ? <Button type="button" variant="ghost" size="sm" className="h-6 text-[11px] text-destructive" onClick={() => update({ keyAction: "remove" })}>Remove</Button>
                      : <Button type="button" variant="ghost" size="sm" className="h-6 text-[11px]" onClick={() => update({ keyAction: "keep" })}>Undo</Button>}
                  </div>
                ) : (
                  <Field
                    label={preset?.keyOptional ? "API key (optional)" : "API key"}
                    help={<span className="flex items-center gap-1"><Lock className="h-3 w-3" /> Stored encrypted in the vault — never written to polpo.json or shown again.</span>}
                  >
                    <Input
                      type="password"
                      autoComplete="off"
                      value={draft.apiKey}
                      onChange={(e) => update({ apiKey: e.target.value })}
                      placeholder={editing && existing?.hasKey ? "New key" : draft.envVar ? `Leave empty to use $${draft.envVar}` : "sk-…"}
                      className="font-mono text-xs"
                    />
                  </Field>
                )}
                <Field label="Environment variable fallback" help="Used when no key is stored in the vault.">
                  <Input value={draft.envVar} onChange={(e) => update({ envVar: e.target.value.toUpperCase() })} placeholder={`${(draft.id || "my-gateway").toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`} className="font-mono text-xs" />
                </Field>
                {draft.proxyFor && (
                  <Toggle
                    checked={reusesBuiltinKey}
                    onChange={(v) => update({ envVar: v ? PROXYABLE_PROVIDERS[draft.proxyFor!].envVar : "" })}
                    label={`Reuse ${PROXYABLE_PROVIDERS[draft.proxyFor].envVar} from the server environment`}
                  />
                )}
                {(reusesBuiltinKey || (draft.proxyFor && draft.apiKey)) && host && (
                  <Callout tone="warn">
                    <ShieldAlert className="inline h-3 w-3 mr-1" />
                    Your {draft.proxyFor === "openai" ? "OpenAI" : "Anthropic"} key will be sent to <strong>{host}</strong>. Only continue if you trust this endpoint.
                  </Callout>
                )}
              </>
            )}
          </div>

          {/* Private network */}
          {(looksLocal || draft.allowPrivateNetwork) && (
            <div className="rounded-lg border border-amber-500/30 p-3 space-y-2">
              <Toggle
                checked={draft.allowPrivateNetwork}
                onChange={(v) => update({ allowPrivateNetwork: v })}
                label="Allow private network"
                help="Lets Polpo call localhost, LAN (10/8, 172.16/12, 192.168/16), Tailscale (100.64/10) and IPv6 ULA addresses for this provider. Cloud metadata addresses are always blocked."
              />
              {looksLocal && !draft.allowPrivateNetwork && (
                <Callout tone="warn"><AlertTriangle className="inline h-3 w-3 mr-1" />{host} looks like a private address — requests will be blocked unless you allow private network access.</Callout>
              )}
            </div>
          )}

          {/* Advanced */}
          <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} Advanced: headers, timeouts, network
          </button>
          {showAdvanced && (
            <div className="space-y-4 rounded-lg border border-border/60 p-3">
              {!looksLocal && !draft.allowPrivateNetwork && (
                <Toggle
                  checked={draft.allowPrivateNetwork}
                  onChange={(v) => update({ allowPrivateNetwork: v })}
                  label="Allow private network"
                  help="Needed when the hostname resolves to an internal address (VPN, Tailscale, LAN)."
                />
              )}
              <HeaderEditor
                title="Static headers"
                help="Sent with every request and saved in polpo.json — do not put secrets here."
                rows={draft.headers}
                onChange={(headers) => update({ headers })}
              />
              <HeaderEditor
                title="Secret headers"
                help="Values are stored encrypted in the vault (write-only)."
                secret
                rows={draft.secretHeaders}
                onChange={(secretHeaders) => update({ secretHeaders })}
              />
              <div className="grid grid-cols-2 gap-3">
                <Field label="Timeout (ms)">
                  <Input type="number" min={1000} value={draft.timeoutMs} onChange={(e) => update({ timeoutMs: e.target.value })} placeholder="600000" className="text-xs" />
                </Field>
                <Field label="Max retries">
                  <Input type="number" min={0} max={10} value={draft.maxRetries} onChange={(e) => update({ maxRetries: e.target.value })} placeholder="2" className="text-xs" />
                </Field>
              </div>
            </div>
          )}

          <div className="flex justify-between gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
            <Button size="sm" disabled={!connectionValid} onClick={() => { setStep(3); if (!discovery && draft.models.length === 0) void runDiscover(); }}>
              Next: test & models <ChevronRight className="h-3.5 w-3.5 ml-1" />
            </Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          {/* Test */}
          <div className="rounded-lg border border-border/60 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <Zap className="h-3.5 w-3.5 text-muted-foreground" />
              <span className={SECTION}>Connection</span>
              <code className="text-[10px] font-mono text-muted-foreground truncate">{urlCheck.url ?? baseUrl}</code>
              <Button size="sm" variant="outline" className="ml-auto h-7 text-xs" disabled={testing} onClick={runTest}>
                {testing ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Plug className="h-3 w-3 mr-1" />} Test connection
              </Button>
            </div>
            {testResult && (testResult.ok ? (
              <Callout tone="ok">
                <Check className="inline h-3 w-3 mr-1" />
                Connected{testResult.model ? <> with <code className="font-mono">{testResult.model}</code></> : null} in {testResult.latencyMs} ms
                {testResult.sample ? <> — replied “{testResult.sample}”</> : null}
              </Callout>
            ) : (
              <Callout tone="error">
                <div className="font-medium">{testResult.error}</div>
                {testResult.hints.map((h) => <div key={h}>• {h}</div>)}
              </Callout>
            ))}
            {testResult?.suggestedCompat && (
              <Callout tone="warn">
                <div className="mb-1">The endpoint rejected some OpenAI-only fields. These compatibility settings fix it:</div>
                {testResult.suggestions?.map((s) => <div key={s.flag}>• <code className="font-mono">{s.flag} = {String(s.value)}</code> — {s.reason}</div>)}
                <Button size="sm" variant="outline" className="h-6 text-[11px] mt-2" onClick={() => { update({ compat: { ...draft.compat, ...testResult.suggestedCompat } }); setShowCompat(true); toast.success("Compatibility settings applied"); }}>
                  Apply
                </Button>
              </Callout>
            )}
          </div>

          {/* Models */}
          <div className="rounded-lg border border-border/60 p-3 space-y-3">
            <div className="flex items-center gap-2">
              <span className={SECTION}>Models</span>
              <Badge variant="secondary" className="text-[10px]">{draft.models.length} selected</Badge>
              <Button size="sm" variant="outline" className="ml-auto h-7 text-xs" disabled={discovering} onClick={runDiscover}>
                {discovering ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <RefreshCw className="h-3 w-3 mr-1" />} Discover
              </Button>
            </div>
            {discovery?.warnings.map((w) => <Callout key={w} tone="info">{w}</Callout>)}
            {discovery && discovery.models.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                    <Input value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} placeholder={`Filter ${discovery.models.length} models…`} className="h-7 pl-7 text-xs" />
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-[11px]"
                    onClick={() => {
                      const toAdd = filteredDiscovered.filter((m) => !selectedIds.has(m.id)).slice(0, 200).map(({ configured: _c, ...m }) => ({ ...m, name: m.name || m.id }));
                      update({ models: [...draft.models, ...toAdd] });
                    }}
                  >
                    Select shown
                  </Button>
                </div>
                <div className="max-h-48 overflow-y-auto space-y-0.5 pr-1">
                  {filteredDiscovered.slice(0, 300).map((m) => (
                    <label key={m.id} className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent/40 cursor-pointer">
                      <input type="checkbox" className="h-3.5 w-3.5 accent-primary" checked={selectedIds.has(m.id)} onChange={() => toggleModel(m)} />
                      <code className="font-mono truncate">{m.id}</code>
                      {m.contextWindow ? <span className="text-[10px] text-muted-foreground">{Math.round(m.contextWindow / 1000)}k ctx</span> : null}
                      {m.input?.includes("image") && <Badge variant="outline" className="text-[9px] h-4">vision</Badge>}
                      {m.reasoning && <Badge variant="outline" className="text-[9px] h-4">reasoning</Badge>}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="flex gap-2">
              <Input
                value={manualModel}
                onChange={(e) => setManualModel(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addManualModel(); } }}
                placeholder={draft.api === "azure-openai-responses" ? "Deployment name" : "Model id, e.g. llama-3.1-70b"}
                className="h-7 text-xs font-mono"
              />
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={addManualModel} disabled={!manualModel.trim()}>
                <Plus className="h-3 w-3 mr-1" /> Add
              </Button>
            </div>

            {draft.models.length > 0 && (
              <div className="space-y-1">
                {draft.models.map((m) => (
                  <div key={m.id} className="rounded-md border border-border/40 bg-muted/10">
                    <div className="flex items-center gap-2 px-2 py-1.5">
                      <button type="button" onClick={() => setExpandedModel(expandedModel === m.id ? null : m.id)} className="text-muted-foreground">
                        {expandedModel === m.id ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      </button>
                      <code className="text-xs font-mono truncate flex-1">{m.id}</code>
                      <span className="text-[10px] text-muted-foreground">{m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k ctx` : "default ctx"}</span>
                      <button type="button" className="text-muted-foreground hover:text-destructive" onClick={() => update({ models: draft.models.filter((x) => x.id !== m.id) })}>
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                    {expandedModel === m.id && (
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 px-2 pb-2">
                        <Field label="Display name">
                          <Input value={m.name} onChange={(e) => patchModel(m.id, { name: e.target.value })} className="h-7 text-xs" />
                        </Field>
                        <Field label="Context window">
                          <Input type="number" value={m.contextWindow ?? ""} onChange={(e) => patchModel(m.id, { contextWindow: e.target.value ? Number(e.target.value) : undefined })} placeholder="128000" className="h-7 text-xs" />
                        </Field>
                        <Field label="Max output">
                          <Input type="number" value={m.maxTokens ?? ""} onChange={(e) => patchModel(m.id, { maxTokens: e.target.value ? Number(e.target.value) : undefined })} placeholder="8192" className="h-7 text-xs" />
                        </Field>
                        <div className="space-y-1">
                          <Toggle checked={!!m.input?.includes("image")} onChange={(v) => patchModel(m.id, { input: v ? ["text", "image"] : ["text"] })} label="Vision" />
                          <Toggle checked={!!m.reasoning} onChange={(v) => patchModel(m.id, { reasoning: v })} label="Reasoning" />
                        </div>
                        <Field label="$ / M input">
                          <Input type="number" step="0.01" value={m.cost?.input ?? ""} onChange={(e) => patchModel(m.id, { cost: { input: Number(e.target.value || 0), output: m.cost?.output ?? 0, cacheRead: m.cost?.cacheRead ?? 0, cacheWrite: m.cost?.cacheWrite ?? 0 } })} className="h-7 text-xs" />
                        </Field>
                        <Field label="$ / M output">
                          <Input type="number" step="0.01" value={m.cost?.output ?? ""} onChange={(e) => patchModel(m.id, { cost: { input: m.cost?.input ?? 0, output: Number(e.target.value || 0), cacheRead: m.cost?.cacheRead ?? 0, cacheWrite: m.cost?.cacheWrite ?? 0 } })} className="h-7 text-xs" />
                        </Field>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Compatibility */}
          <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowCompat((v) => !v)}>
            {showCompat ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} Compatibility settings
            {Object.keys(draft.compat).length > 0 && <Badge variant="secondary" className="text-[9px] h-4 ml-1">{Object.keys(draft.compat).length}</Badge>}
          </button>
          {showCompat && (
            <div className="rounded-lg border border-border/60 p-3 space-y-2">
              <p className={HELP}>Leave on “auto” unless the endpoint rejects requests. Applies to every model of this provider.</p>
              {Object.entries(compatFlags).map(([flag, spec]) => {
                const value = draft.compat[flag];
                const options = spec === "boolean" ? ["true", "false"] : [...spec];
                return (
                  <div key={flag} className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <code className="text-[11px] font-mono">{flag}</code>
                      <div className="text-[10px] text-muted-foreground truncate">{COMPAT_FLAG_HELP[flag]}</div>
                    </div>
                    <Select
                      value={value === undefined ? "auto" : String(value)}
                      onValueChange={(v) => {
                        const next = { ...draft.compat };
                        if (v === "auto") delete next[flag];
                        else next[flag] = spec === "boolean" ? v === "true" : v;
                        update({ compat: next });
                      }}
                    >
                      <SelectTrigger className="h-7 w-44 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto" className="text-xs">auto</SelectItem>
                        {options.map((o) => <SelectItem key={o} value={o} className="text-xs">{o}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </div>
          )}

          {saveError && <Callout tone="error">{saveError}</Callout>}
          {draft.models.length === 0 && <Callout tone="info">Add at least one model so agents can use this provider (you can also add models later).</Callout>}

          <div className="flex justify-between gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={() => setStep(2)}><ArrowLeft className="h-3.5 w-3.5 mr-1" /> Back</Button>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
              <Button size="sm" disabled={saving || !connectionValid} onClick={save}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Check className="h-3.5 w-3.5 mr-1" />}
                {editing ? "Save changes" : "Add provider"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function HeaderEditor({ title, help, rows, onChange, secret }: {
  title: string;
  help: string;
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
  secret?: boolean;
}) {
  const set = (i: number, patch: Partial<HeaderRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className={LABEL}>{title}</span>
        <Button type="button" variant="ghost" size="sm" className="h-6 text-[11px] ml-auto" onClick={() => onChange([...rows, { name: "", value: "" }])}>
          <Plus className="h-3 w-3 mr-1" /> Add
        </Button>
      </div>
      <p className={HELP}>{help}</p>
      {rows.map((r, i) => (
        <div key={i} className={cn("flex gap-2 items-center", r.removed && "opacity-50")}>
          <Input value={r.name} disabled={r.stored} onChange={(e) => set(i, { name: e.target.value })} placeholder="Header-Name" className="h-7 text-xs font-mono" />
          <Input
            type={secret ? "password" : "text"}
            autoComplete="off"
            value={r.value}
            disabled={r.removed}
            onChange={(e) => set(i, { value: e.target.value })}
            placeholder={r.stored ? "stored — type to replace" : "value"}
            className="h-7 text-xs font-mono"
          />
          <button
            type="button"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => (r.stored ? set(i, { removed: !r.removed }) : onChange(rows.filter((_, j) => j !== i)))}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

// ── Cards section ──────────────────────────────────────────────────

export function CustomProvidersSection({
  apiFetch,
  providers,
  loaded = true,
  agentUsage,
  onChanged,
  onAdd,
}: {
  apiFetch: ApiFetch;
  providers: CustomProviderInfo[];
  /** False while the first list request is in flight (avoids flashing the empty state). */
  loaded?: boolean;
  agentUsage: Map<string, string[]>;
  onChanged: () => Promise<void>;
  onAdd: () => void;
}) {
  const [editing, setEditing] = useState<CustomProviderInfo | null>(null);
  const [removing, setRemoving] = useState<CustomProviderInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  const takenIds = useMemo(() => new Set(providers.map((p) => p.id)), [providers]);

  const test = async (p: CustomProviderInfo) => {
    setBusy(`test:${p.id}`);
    try {
      const r = await apiFetch("/providers/custom/test", { method: "POST", body: JSON.stringify({ id: p.id }) });
      setTests((t) => ({ ...t, [p.id]: r.ok ? (r.data as TestResult) : { ok: false, error: r.error, hints: [] } }));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!removing) return;
    const p = removing;
    setRemoving(null);
    setBusy(`rm:${p.id}`);
    try {
      const r = await apiFetch(`/providers/custom/${encodeURIComponent(p.id)}`, { method: "DELETE" });
      if (!r.ok) toast.error(r.error ?? "Remove failed");
      else {
        for (const w of (r.data as { warnings?: string[] }).warnings ?? []) toast.warning(w);
        toast.success(`Removed ${p.label ?? p.id}`);
      }
      await onChanged();
    } finally {
      setBusy(null);
    }
  };

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <Plug className="h-3.5 w-3.5" /> Custom endpoints & gateways
        </h3>
        <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={onAdd}>
          <Plus className="h-3 w-3" /> Add endpoint
        </Button>
      </div>
      {!loaded ? (
        <div className="flex items-center justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
      ) : providers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/60 px-4 py-5 text-xs text-muted-foreground">
          Connect OpenRouter, Vercel AI Gateway, Cloudflare, Azure, LiteLLM, Ollama, vLLM, LM Studio or any OpenAI / Anthropic-compatible endpoint.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {providers.map((p) => {
            const result = tests[p.id];
            const usage = agentUsage.get(p.id) ?? [];
            return (
              <div key={p.id} className="rounded-lg border border-border/40 bg-card/60 p-4 space-y-3">
                <div className="flex items-center gap-2.5">
                  <div className={cn("relative flex h-9 w-9 items-center justify-center rounded-lg shrink-0 border bg-card", p.configured ? "border-emerald-500/30" : "border-border")}>
                    <ProviderIcon name={p.preset && p.preset !== "openai-compatible" && p.preset !== "anthropic-compatible" ? p.preset : p.proxyFor ?? p.id} size={20} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold truncate">{p.label ?? p.id}</span>
                      <code className="text-[10px] font-mono text-muted-foreground">{p.id}</code>
                      <Badge variant="secondary" className="text-[9px] h-4">Custom</Badge>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap text-[11px]">
                      <span className="flex items-center gap-1.5">
                        <span className={cn("h-1.5 w-1.5 rounded-full", p.configured ? "bg-emerald-500" : "bg-zinc-500")} />
                        <span className={p.configured ? "text-foreground" : "text-muted-foreground"}>
                          {p.keySource === "none" ? "No key needed"
                            : p.keySource === "vault" ? `Key in vault${p.keyHint ? ` (…${p.keyHint})` : ""}`
                            : p.keySource === "env" ? `Env var (${p.envVar})`
                            : "Key missing"}
                        </span>
                      </span>
                      {p.api && <Badge variant="outline" className="text-[9px] font-mono h-4">{PROVIDER_API_LABELS[p.api as ProviderApi] ?? p.api}</Badge>}
                      {p.allowPrivateNetwork && <Badge variant="outline" className="text-[9px] h-4">private network</Badge>}
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={busy === `test:${p.id}`} onClick={() => test(p)}>
                      {busy === `test:${p.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : "Test"}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setEditing(p)} title="Edit">
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0 hover:text-destructive" disabled={busy === `rm:${p.id}`} onClick={() => setRemoving(p)} title="Remove">
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
                {p.baseUrl && (
                  <div className="flex items-center gap-1.5 bg-muted/20 rounded-md px-2.5 py-1.5">
                    <Globe className="h-3 w-3 text-muted-foreground shrink-0" />
                    <code className="text-[11px] font-mono text-muted-foreground truncate">{p.baseUrl}</code>
                  </div>
                )}
                {result && (result.ok
                  ? <Callout tone="ok"><Check className="inline h-3 w-3 mr-1" />OK in {result.latencyMs} ms{result.model ? ` (${result.model})` : ""}{result.suggestedCompat ? " — needs compatibility settings, open Edit → Test" : ""}</Callout>
                  : <Callout tone="error"><div>{result.error}</div>{result.hints.map((h) => <div key={h}>• {h}</div>)}</Callout>)}
                {(p.models?.length ?? 0) > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {p.models!.slice(0, 12).map((m) => <Badge key={m.id} variant="outline" className="text-[10px] font-mono">{m.id}</Badge>)}
                    {p.models!.length > 12 && <Badge variant="outline" className="text-[10px]">+{p.models!.length - 12}</Badge>}
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">No models yet — Edit → Discover to add some.</p>
                )}
                {usage.length > 0 && (
                  <div className="pt-2 border-t border-border/20 text-[10px] text-muted-foreground">Used by {usage.length} agent{usage.length > 1 ? "s" : ""}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={!!editing} onOpenChange={(o) => { if (!o) setEditing(null); }}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base">Edit {editing?.label ?? editing?.id}</DialogTitle>
            <DialogDescription className="text-xs">Changes apply immediately to new requests.</DialogDescription>
          </DialogHeader>
          {editing && (
            <CustomProviderWizard
              key={editing.id}
              apiFetch={apiFetch}
              existing={editing}
              takenIds={takenIds}
              onCancel={() => setEditing(null)}
              onSaved={async () => { setEditing(null); await onChanged(); }}
            />
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => { if (!o) setRemoving(null); }}
        title={`Remove ${removing?.label ?? removing?.id ?? ""}?`}
        description="The provider definition and its stored key / secret headers are deleted. Agents using its models will stop working until you pick another model."
        confirmLabel="Remove"
        destructive
        onConfirm={remove}
      />
    </section>
  );
}
