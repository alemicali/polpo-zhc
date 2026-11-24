import { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Loader2,
  RefreshCw,
  Bot,
  Settings2,
  Check,
  ChevronRight,
  Globe,
  Key,
  Bookmark,
  Bell,
  Shield,
  Hash,
  Eye,
  Zap,
  Monitor,
  Mail,
  ToggleRight,
  Timer,
  Paperclip,
  Gauge,
  Sparkles,
  Activity,
  Brain,
  Server,
  Lock,
  Unlock,
  Users,
  Clock,
  AlertTriangle,
  LogIn,
  Keyboard,
  Pencil,
  X,
  Plus,
  Trash2,
  Cloud as CloudIcon,
  Upload,
  Download,
  EyeOff,
  Image as ImageIcon,
  type LucideIcon,
} from "lucide-react";
import { notifyBrandingChanged, useConfig } from "@/hooks/use-polpo";
import { ProviderIcon } from "@/components/shared/provider-icon";
import { useAgents, useAuthStatus, useOrchestratorSkills } from "@polpo-ai/react";
import type { CustomModelDef, ProviderConfig, AuthProfileMeta, ProviderAuthInfo, SkillInfo, PolpoSettings, AuthStatusResponse, ReasoningLevel, NotificationChannelConfig, BrandingConfig } from "@polpo-ai/react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { ORCHESTRATOR_NAME_MAX_LENGTH, setOrchestratorName } from "@/lib/orchestrator-name";
import { JsonBlock } from "@/components/json-block";
import { config as appConfig, apiFetch, apiUrl } from "@/lib/config";
import { focusSetupField, notifySetupSaved, readSetupParams } from "@/lib/setup-link";
import { AuthStep, OAuthFlow, ApiKeyStep } from "@/components/shared/provider-auth";
import type { Provider as AuthProvider, OAuthProvider } from "@/components/shared/provider-auth";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { ModelPicker } from "@/components/shared/model-picker";
import { RuleFormDialog, type NotificationRuleDraft } from "@/components/config/rule-form-dialog";
import { summarizeRule } from "@/lib/rule-summary";
import { HOOK_EVENT_CATALOG, HOOK_EVENT_GLOBS } from "@polpo-ai/core/hook-events";
import { GateFormDialog, type ApprovalGateDraft, type LifecycleHook as GateLifecycleHook } from "@/components/config/gate-form-dialog";
import { followInstanceDefault, kit, setInstanceAppearance, useResolvedAppearance, type InstanceAppearance } from "@/lib/appearance";
import { AppearanceEditor } from "@/components/config/appearance-editor";
import { SidebarStyleSettings } from "@/components/config/sidebar-style-settings";
import type { SidebarStyle } from "@/hooks/use-sidebar-style";
import { ConfigSectionBar } from "@/components/config/config-sections";
import { findConfigSection, type ConfigSectionId } from "@/lib/config-sections";
import { toast } from "sonner";
import { BrandMark } from "@/components/shared/brand-mark";
import { DEFAULT_PRODUCT_NAME, DEFAULT_PRODUCT_TAGLINE, productName, useInstanceBranding } from "@/lib/branding";
import { CustomProviderWizard, CustomProvidersSection } from "@/components/config/custom-providers";
import { useCustomProviders } from "@/hooks/use-custom-providers";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SandboxSettingsSection } from "@/components/sandbox/sandbox-settings";
import { McpAccessSection } from "@/components/config/mcp-access-section";
import { HarnessesSection } from "@/components/config/harnesses-section";
import { ComputerWebhooksSection } from "@/components/config/computer-webhooks-section";
import { SectionHeader } from "@/components/shared/section-header";
import { ChannelsSection } from "@/components/channels/channels-section";

// ── API helper (same pattern as setup.tsx) ──

const api = async (path: string, init?: RequestInit) => {
  try {
    const headers: Record<string, string> = { ...init?.headers as Record<string, string> };
    if (appConfig.apiKey) headers.Authorization = `Bearer ${appConfig.apiKey}`;
    // Only set Content-Type for requests with a body
    if (init?.body) headers["Content-Type"] = "application/json";
    const res = await fetch(`${appConfig.baseUrl}/api/v1${path}`, {
      ...init,
      headers,
      credentials: "include",
    });
    const data = await res.json();
    return data;
  } catch {
    return { ok: false, error: "Could not connect to server" };
  }
};

// ── Helpers ──

/** Extract provider name from a "provider:model" spec */
function parseModelSpec(spec: string): { provider: string; model: string } {
  const idx = spec.indexOf(":");
  if (idx === -1) return { provider: "unknown", model: spec };
  return { provider: spec.slice(0, idx), model: spec.slice(idx + 1) };
}

/** Human-friendly provider label */
function providerLabel(name: string): string {
  const labels: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    google: "Google",
    groq: "Groq",
    cerebras: "Cerebras",
    xai: "xAI",
    openrouter: "OpenRouter",
    mistral: "Mistral",
    "vercel-ai-gateway": "Vercel AI Gateway",
    "azure-openai-responses": "Azure OpenAI",
    "github-copilot": "GitHub Copilot",
    "amazon-bedrock": "Amazon Bedrock",
    "google-vertex": "Google Vertex AI",
    "openai-codex": "OpenAI Codex",
    huggingface: "Hugging Face",
    minimax: "MiniMax",
    ollama: "Ollama",
  };
  return labels[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
}

/** Human-friendly API mode label */
function apiModeLabel(api: string): string {
  const labels: Record<string, string> = {
    "openai-completions": "OpenAI Completions",
    "openai-responses": "OpenAI Responses",
    "anthropic-messages": "Anthropic Messages",
  };
  return labels[api] ?? api;
}

/** Format context window nicely */
function formatCtx(tokens?: number): string {
  if (!tokens) return "";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  return `${(tokens / 1_000).toFixed(0)}k`;
}

/** Format cost per million tokens */
function formatCost(cost?: { input: number; output: number }): string {
  if (!cost) return "";
  if (cost.input === 0 && cost.output === 0) return "Free / Local";
  return `$${cost.input}/M in, $${cost.output}/M out`;
}

function objectOrEmpty<T = unknown>(value: unknown): Record<string, T> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, T>
    : {};
}

function arrayOrEmpty<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

// ── Section definitions ──

type SectionId = ConfigSectionId;

// ── Reusable display components ──

/** Key-value row — label left, value right, dotted filler in between */
function Row({ label, value, mono, wrap }: { label: React.ReactNode; value: React.ReactNode; mono?: boolean; wrap?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 py-1.5 min-w-0">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span className="flex-1 border-b border-dotted border-border/30 min-w-4 self-end mb-[3px]" />
      <span className={cn(
        "text-xs text-foreground shrink-0 text-right max-w-[60%]",
        wrap ? "break-words [overflow-wrap:anywhere]" : "truncate",
        mono && "font-mono text-caption",
      )}>{value}</span>
    </div>
  );
}

/** Inline pill for enabled/disabled capabilities */
function CapPill({ label, on }: { label: string; on: boolean }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-caption font-medium border",
      on
        ? "bg-success/10 text-success border-success/20"
        : "bg-muted/30 text-muted-foreground/60 border-border/30 line-through decoration-muted-foreground/30",
    )}>
      {label}
    </span>
  );
}

/** Empty state placeholder */
function Empty({ text }: { text: string }) {
  return <p className="text-xs text-muted-foreground/60 italic py-4 text-center">{text}</p>;
}

/** Status dot */
function StatusDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs">
      <span className={cn("h-1.5 w-1.5 rounded-pill shrink-0", ok ? "bg-success" : "bg-muted-foreground")} />
      <span className={ok ? "text-foreground" : "text-muted-foreground"}>{label}</span>
    </span>
  );
}

/** Provider card for the unified Models & Providers section */
function ProviderCard({ name, prov, agentModels, authInfo, onConnect, onDisconnect, disconnecting }: {
  name: string;
  prov: ProviderConfig;
  agentModels: string[];
  authInfo?: ProviderAuthInfo;
  onConnect?: (name: string) => void;
  onDisconnect?: (name: string) => void;
  disconnecting?: boolean;
}) {
  const hasEnvKey = authInfo?.hasEnvKey ?? false;
  const profiles = arrayOrEmpty<AuthProfileMeta>(authInfo?.profiles);
  const hasOAuth = profiles.length > 0;
  const activeOAuth = profiles.filter((p: AuthProfileMeta) => p.status === "active").length;
  const isLocal = !!prov.baseUrl && (prov.baseUrl.includes("localhost") || prov.baseUrl.includes("127.0.0.1"));
  const isAuthenticated = hasEnvKey || hasOAuth || isLocal;

  // Build status label
  const statusLabel = isLocal ? "Local"
    : hasEnvKey ? `Env var (${authInfo?.envVar ?? ""})`
    : hasOAuth ? `OAuth (${activeOAuth} active)`
    : "Not configured";

  return (
    <div className="rounded-lg border border-border/40 bg-card/60 p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2.5">
        <div className={cn(
          "relative flex h-9 w-9 items-center justify-center rounded-lg shrink-0 border bg-card",
          isAuthenticated ? "border-success/30" : "border-border",
        )}>
          <ProviderIcon name={name} size={20} />
          {/* Auth-state pip overlapping the brand icon */}
          <span
            className={cn(
              "absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-pill flex items-center justify-center ring-2 ring-background",
              isLocal || isAuthenticated ? "bg-success text-success-foreground" : "bg-muted-foreground text-background",
            )}
          >
            {isLocal ? <Server className="h-2 w-2" /> :
             isAuthenticated ? <Lock className="h-2 w-2" /> :
                      <Unlock className="h-2 w-2" />}
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{providerLabel(name)}</span>
            <code className="text-micro font-mono text-muted-foreground">{name}</code>
          </div>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <StatusDot ok={isAuthenticated} label={statusLabel} />
            {prov.api && (
              <Badge variant="outline" className="text-micro font-mono h-4">{apiModeLabel(prov.api)}</Badge>
            )}
            {authInfo?.oauthAvailable && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Badge variant="outline" className="text-micro h-4 gap-0.5">
                      <Key className="h-2.5 w-2.5" /> OAuth
                    </Badge>
                  </span>
                </TooltipTrigger>
                <TooltipContent className="text-xs">{authInfo.oauthProviderName} — {authInfo.oauthFlow}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
        {/* Inline action button */}
        {isAuthenticated ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onDisconnect?.(name)}
            disabled={disconnecting}
            className="text-caption text-muted-foreground hover:text-destructive hover:bg-destructive/10 h-7 px-2 shrink-0"
          >
            {disconnecting ? <Loader2 className="h-3 w-3 animate-spin" /> : "Disconnect"}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onConnect?.(name)}
            className="text-caption h-7 px-2.5 shrink-0"
          >
            Connect
          </Button>
        )}
      </div>

      {/* OAuth profiles */}
      {hasOAuth && (
        <div className="space-y-1.5">
          {profiles.map((profile: AuthProfileMeta) => {
            const dotColor: Record<string, string> = {
              active: "bg-success", cooldown: "bg-warning",
              billing_disabled: "bg-destructive", expired: "bg-muted-foreground",
            };
            return (
              <div key={profile.id} className="flex items-center gap-2 text-caption min-w-0">
                <span className={cn("h-1.5 w-1.5 rounded-pill shrink-0", dotColor[profile.status] ?? "bg-muted-foreground")} />
                <span className="truncate text-muted-foreground">{profile.email ?? profile.id}</span>
                <Badge variant={profile.type === "oauth" ? "secondary" : "outline"} className="text-micro h-4 shrink-0">{profile.type}</Badge>
                {profile.status !== "active" && (
                  <span className="text-micro text-muted-foreground/60 shrink-0">{profile.status.replace("_", " ")}</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Base URL */}
      {prov.baseUrl && (
        <div className="flex items-center gap-1.5 bg-muted/20 rounded-md px-2.5 py-1.5">
          <Globe className="h-3 w-3 text-muted-foreground shrink-0" />
          <code className="text-caption font-mono text-muted-foreground truncate">{prov.baseUrl}</code>
        </div>
      )}

      {/* Custom Models */}
      {prov.models && prov.models.length > 0 && (
        <div className="space-y-2">
          <span className="text-label text-muted-foreground">
            Custom Models
          </span>
          {prov.models.map((m: CustomModelDef) => (
            <div key={m.id} className="rounded-md bg-muted/15 border border-border/20 px-3 py-2">
              <div className="flex items-center gap-2 flex-wrap">
                <code className="text-caption font-mono font-medium">{m.name}</code>
                {m.reasoning && (
                  <Tooltip>
                    <TooltipTrigger>
                      <Badge variant="secondary" className="text-micro h-4 gap-0.5"><Brain className="h-2.5 w-2.5" /> Reasoning</Badge>
                    </TooltipTrigger>
                    <TooltipContent className="text-xs">Supports extended thinking</TooltipContent>
                  </Tooltip>
                )}
                {m.contextWindow && (
                  <Badge variant="outline" className="text-micro h-4">{formatCtx(m.contextWindow)} ctx</Badge>
                )}
                {m.maxTokens && (
                  <Badge variant="outline" className="text-micro h-4">{formatCtx(m.maxTokens)} out</Badge>
                )}
                {m.input && m.input.includes("image") && (
                  <Badge variant="outline" className="text-micro h-4">Vision</Badge>
                )}
              </div>
              <div className="flex items-center gap-3 mt-1">
                <code className="text-micro font-mono text-muted-foreground">{m.id}</code>
                {m.cost && (
                  <span className="text-micro text-muted-foreground">{formatCost(m.cost)}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Agent usage */}
      {agentModels.length > 0 && (
        <div className="pt-2 border-t border-border/20">
          <span className="text-micro text-muted-foreground">
            Used by {agentModels.length} agent{agentModels.length > 1 ? "s" : ""}
          </span>
        </div>
      )}

      {/* Hint to login */}
      {!isAuthenticated && authInfo?.oauthAvailable && (
        <p className="text-micro text-muted-foreground/60 italic">
          Run <code className="font-mono text-primary">polpo auth login {name}</code>
        </p>
      )}
    </div>
  );
}

// ── Reasoning level options ──
const REASONING_LEVELS: { value: ReasoningLevel; label: string; description: string }[] = [
  { value: "off", label: "Off", description: "Standard mode — no extended thinking" },
  { value: "minimal", label: "Minimal", description: "Light reasoning pass" },
  { value: "low", label: "Low", description: "Basic extended thinking" },
  { value: "medium", label: "Medium", description: "Balanced reasoning depth" },
  { value: "high", label: "High", description: "Deep analysis — slower, better results" },
  { value: "xhigh", label: "Extra High", description: "Very deep reasoning for supported models" },
  { value: "max", label: "Maximum", description: "Highest native reasoning level for supported models" },
];

// ── Agent Tab ──

/** Clickable setting row — label left, current value right, entire row is the click target */
function SettingRow({ icon: Icon, label, description, value, placeholder, onClick, onClear, saving, disabled }: {
  icon: LucideIcon;
  label: string;
  description?: string;
  value?: React.ReactNode;
  placeholder?: string;
  onClick?: () => void;
  onClear?: () => void;
  saving?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="group rounded-lg border border-border/40 bg-card/60 hover:border-border/60 transition-colors">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || saving}
        className="w-full flex items-center gap-3 px-4 py-3 text-left cursor-pointer disabled:cursor-default disabled:opacity-60"
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/40 shrink-0">
          {saving
            ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            : <Icon className="h-4 w-4 text-muted-foreground" />}
        </div>
        <div className="flex-1 min-w-0">
          <span className="text-xs font-medium text-foreground">{label}</span>
          {description && (
            <p className="text-micro text-muted-foreground mt-0.5 leading-tight">{description}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {value ? (
            <span className="text-xs font-mono text-foreground">{value}</span>
          ) : (
            <span className="text-xs text-muted-foreground/50 italic">{placeholder ?? "Not set"}</span>
          )}
          <Pencil className="h-3 w-3 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors" />
        </div>
      </button>
      {onClear && value && (
        <div className="flex justify-end px-4 pb-2 -mt-1">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onClear(); }}
            disabled={saving}
            className="flex items-center gap-1 text-micro text-muted-foreground/60 hover:text-destructive transition-colors cursor-pointer"
          >
            <X className="h-2.5 w-2.5" /> Clear
          </button>
        </div>
      )}
    </div>
  );
}

function LogoPicker({ label, hint, value, busy, onChange, onUpload, onRemove, uploadedUrl }: {
  label: string;
  hint: string;
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onUpload: (file: File) => Promise<void>;
  onRemove?: () => void;
  uploadedUrl: string;
}) {
  return (
    <label className="grid gap-1.5 sm:col-span-2">
      <span className="text-xs font-medium">{label}</span>
      <div className="flex min-w-0 gap-2">
        <Input value={value} onChange={(event) => onChange(event.target.value)} placeholder="https://example.com/logo.png" className="min-w-0" />
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = "image/png,image/jpeg,image/webp,image/gif";
            input.onchange = () => {
              const file = input.files?.[0];
              if (!file) return;
              void onUpload(file).then(() => onChange(uploadedUrl)).catch((error) => toast.error(error instanceof Error ? error.message : "Logo upload failed"));
            };
            input.click();
          }}
        >
          <Upload className="h-3.5 w-3.5" /> Upload
        </Button>
        {onRemove && (
          <Button variant="ghost" disabled={busy} onClick={onRemove} title={`Remove the ${label.toLowerCase()}`}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <span className="text-micro text-muted-foreground">{hint}</span>
    </label>
  );
}

function AppearanceTab({ branding, onUpdateBranding, onUploadLogo, onRemoveLogo, onSaveInstanceAppearance, onSaveSidebarStyle }: {
  branding?: BrandingConfig;
  onUpdateBranding: (branding: BrandingConfig) => Promise<void>;
  onUploadLogo: (file: File, variant: "light" | "dark") => Promise<void>;
  onRemoveLogo: (variant: "light" | "dark") => Promise<void>;
  onSaveInstanceAppearance: (appearance: InstanceAppearance | null) => Promise<void>;
  onSaveSidebarStyle: (style: SidebarStyle) => Promise<void>;
}) {
  const [productName, setProductName] = useState(branding?.productName ?? "");
  // the logo previews sit on the look's own page background in each mode (custom, else the palette's)
  const look = useResolvedAppearance();
  const previewSurface = (variant: "light" | "dark"): React.CSSProperties => {
    const tokens = look.custom.enabled ? look.custom[variant] : {};
    const background = typeof tokens.background === "string" ? tokens.background
      : (kit.THEME_COLORS[look.palette] ?? kit.THEME_COLORS[kit.DEFAULT_PALETTE])[variant === "dark" ? 1 : 0];
    const color = typeof tokens.foreground === "string" ? tokens.foreground : kit.contrastOn(background) ?? undefined;
    return { background, color };
  };
  const [tagline, setTagline] = useState(branding?.tagline ?? "");
  const [logoUrl, setLogoUrl] = useState(branding?.logoUrl ?? "");
  const [logoDarkUrl, setLogoDarkUrl] = useState(branding?.logoDarkUrl ?? "");
  const [logoBoxed, setLogoBoxed] = useState(branding?.logoFrame !== "none");
  const [brandingBusy, setBrandingBusy] = useState(false);
  const draft = { productName, tagline, logoUrl, logoDarkUrl, logoFrame: logoBoxed ? "box" as const : "none" as const };
  /** Busy while it runs; errors go on to the caller. */
  const busyRun = (work: Promise<void>) => {
    setBrandingBusy(true);
    return work.finally(() => setBrandingBusy(false));
  };
  /** Busy while it runs; an error becomes a toast. */
  const busyWhile = (work: Promise<void>, failure: string) => busyRun(work)
    .catch((error) => { toast.error(error instanceof Error ? error.message : failure); });

  return (
    <div className="space-y-6">
      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="flex items-center gap-1.5 text-label text-muted-foreground">
            <ImageIcon className="h-3.5 w-3.5" /> Instance branding
          </h3>
          <span className="text-micro text-muted-foreground">Shared with every user</span>
        </div>
        <div className="grid gap-3 border-y border-border/60 py-4 lg:grid-cols-[minmax(0,1fr)_17rem]">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5">
              <span className="text-xs font-medium">Product name</span>
              <Input value={productName} maxLength={80} onChange={(event) => setProductName(event.target.value)} placeholder={DEFAULT_PRODUCT_NAME} />
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium">Tagline</span>
              <Input value={tagline} maxLength={120} onChange={(event) => setTagline(event.target.value)} placeholder={DEFAULT_PRODUCT_TAGLINE} />
            </label>
            <LogoPicker
              label="Logo"
              hint="Use an HTTPS URL or upload PNG, JPEG, WebP, or GIF up to 4 MB."
              value={logoUrl}
              busy={brandingBusy}
              onChange={setLogoUrl}
              uploadedUrl="/api/v1/config/branding/logo"
              onUpload={(file) => busyRun(onUploadLogo(file, "light"))}
              onRemove={branding?.logoUrl ? () => void busyWhile(onRemoveLogo("light").then(() => setLogoUrl("")), "Failed to remove logo") : undefined}
            />
            <LogoPicker
              label="Logo for dark mode"
              hint="Optional: shown in dark mode instead of the logo (which is used when this is empty)."
              value={logoDarkUrl}
              busy={brandingBusy}
              onChange={setLogoDarkUrl}
              uploadedUrl="/api/v1/config/branding/logo-dark"
              onUpload={(file) => busyRun(onUploadLogo(file, "dark"))}
              onRemove={branding?.logoDarkUrl ? () => void busyWhile(onRemoveLogo("dark").then(() => setLogoDarkUrl("")), "Failed to remove logo") : undefined}
            />
            <div className="flex items-center gap-3 sm:col-span-2">
              <Switch
                checked={logoBoxed}
                onCheckedChange={setLogoBoxed}
                aria-label="Show logo in a box"
                disabled={brandingBusy}
              />
              <div className="min-w-0">
                <div className="text-xs font-medium">Show logo in a box</div>
                <div className="text-caption text-muted-foreground">Off: the logo is shown bare, at the same height, without the tile behind it.</div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
              <Button
                disabled={brandingBusy}
                onClick={() => void busyWhile(onUpdateBranding({
                  productName: productName.trim() || undefined,
                  tagline: tagline.trim() || undefined,
                  logoUrl: logoUrl.trim() || undefined,
                  logoDarkUrl: logoDarkUrl.trim() || undefined,
                  logoFrame: logoBoxed ? "box" : "none",
                }), "Failed to update branding")}
              >
                {brandingBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Save branding
              </Button>
            </div>
          </div>
          <div className="grid gap-2">
            {(["light", "dark"] as const).map((variant) => (
              <div key={variant} className="flex min-h-24 items-center justify-center border border-border/50 p-4" style={previewSurface(variant)}>
                <div className="flex min-w-0 items-center gap-3">
                  <BrandMark branding={draft} variant={variant} className="h-10 w-10 rounded-lg text-xl" />
                  <div className="min-w-0">
                    <div className="max-w-36 truncate text-sm font-bold">{productName.trim() || DEFAULT_PRODUCT_NAME}</div>
                    <div className="max-w-36 truncate text-micro uppercase opacity-60">{tagline.trim() || DEFAULT_PRODUCT_TAGLINE} · {variant}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <SidebarStyleSettings onSaveInstanceDefault={onSaveSidebarStyle} />

      <AppearanceEditor onSaveInstanceDefault={onSaveInstanceAppearance} />
    </div>
  );
}

interface InstanceMember {
  email: string;
}

function MembersTab() {
  const product = productName(useInstanceBranding());
  const [members, setMembers] = useState<InstanceMember[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [email, setEmail] = useState("");
  const [sendInvite, setSendInvite] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadMembers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api("/auth/instance/members");
      if (!res.ok) throw new Error(res.error ?? "Could not load members");
      setEnabled(!!res.data?.enabled);
      setMembers(arrayOrEmpty<InstanceMember>(res.data?.members));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  const addMember = async () => {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return;
    setSaving(true);
    try {
      const res = await api("/auth/instance/members", {
        method: "POST",
        body: JSON.stringify({ email: normalized, sendInvite }),
      });
      if (!res.ok) throw new Error(res.error ?? "Could not add member");
      setMembers(arrayOrEmpty<InstanceMember>(res.data?.members));
      setEmail("");
      if (sendInvite && res.data?.inviteError) {
        toast.warning(`Member added, invite not sent: ${res.data.inviteError}`);
      } else if (sendInvite && res.data?.invited) {
        toast.success("Member added and invite sent");
      } else {
        toast.success("Member added");
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const removeMember = async (memberEmail: string) => {
    setBusyEmail(memberEmail);
    try {
      const res = await api(`/auth/instance/members/${encodeURIComponent(memberEmail)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(res.error ?? "Could not remove member");
      setMembers(arrayOrEmpty<InstanceMember>(res.data?.members));
      toast.success("Member removed");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusyEmail(null);
    }
  };

  return (
    <div className="space-y-4 max-w-2xl">
      <section>
        <SectionHeader icon={Users} title="Tenant Members" className="mb-1.5" />
        <p className="text-xs text-muted-foreground">
          These emails can request a magic link and access this {product} instance.
        </p>
      </section>

      {!enabled && (
        <Card className="bg-muted/20 border-border/40 py-0 gap-0">
          <CardContent className="py-3 px-4 flex items-start gap-2">
            <Unlock className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium">Instance auth is disabled</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Set <code className="font-mono">POLPO_AUTH_ENABLED=true</code> to enforce the member allowlist.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="py-0 gap-0">
        <CardContent className="py-3 px-4 space-y-3">
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Mail className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void addMember();
                }}
                type="email"
                inputMode="email"
                placeholder="person@example.com"
                className="pl-8"
              />
            </div>
            <Button size="sm" className="h-9 gap-1.5" onClick={addMember} disabled={saving || !email.trim()}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Add
            </Button>
          </div>
          <label className={cn(
            "flex w-fit items-center gap-2 rounded-md border border-border/40 bg-muted/20 px-2.5 py-1.5 text-xs text-muted-foreground",
            !enabled && "opacity-60",
          )}>
            <input
              type="checkbox"
              checked={sendInvite}
              onChange={(e) => setSendInvite(e.target.checked)}
              disabled={!enabled}
              className="h-3.5 w-3.5 accent-primary"
            />
            Send invite email now
          </label>

          {loading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading members...
            </div>
          ) : members.length > 0 ? (
            <div className="divide-y divide-border/40 rounded-lg border border-border/40 overflow-hidden">
              {members.map((member) => (
                <div key={member.email} className="flex items-center gap-3 px-3 py-2.5 bg-background/40">
                  <div className="h-7 w-7 rounded-pill bg-primary/10 text-primary flex items-center justify-center shrink-0">
                    <Mail className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{member.email}</p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    onClick={() => removeMember(member.email)}
                    disabled={members.length <= 1 || busyEmail === member.email}
                    title={members.length <= 1 ? "At least one member must remain" : "Remove member"}
                  >
                    {busyEmail === member.email ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <Empty text="No members configured" />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AgentTab({ settings, primaryModel, fallbackModels, authStatus, onUpdateSettings }: {
  settings: PolpoSettings;
  primaryModel: string | undefined;
  fallbackModels: string[];
  authStatus: AuthStatusResponse | null | undefined;
  onUpdateSettings: (patch: { orchestratorModel?: string; orchestratorName?: string | null; imageModel?: string | null; reasoning?: ReasoningLevel }) => Promise<void>;
}) {
  const { skills, isLoading: skillsLoading } = useOrchestratorSkills();
  const [reasoningSaving, setReasoningSaving] = useState(false);

  // The orchestrator's display name (default "Polpo"), saved on blur / Enter; empty restores the default
  const savedName = (settings as { orchestratorName?: string }).orchestratorName ?? "";
  const [nameDraft, setNameDraft] = useState(savedName);
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  useEffect(() => { setNameDraft(savedName); }, [savedName]);
  const saveName = async () => {
    const next = nameDraft.trim();
    if (next === savedName) { setNameDraft(next); setNameError(null); return; }
    if (next.length > ORCHESTRATOR_NAME_MAX_LENGTH) {
      setNameError(`At most ${ORCHESTRATOR_NAME_MAX_LENGTH} characters`);
      return;
    }
    setNameSaving(true);
    setNameError(null);
    try {
      await onUpdateSettings({ orchestratorName: next || null });
      setOrchestratorName(next);
    } catch (err) {
      setNameError(err instanceof Error ? err.message : "Could not save the name");
    } finally {
      setNameSaving(false);
    }
  };

  // Model picker dialogs
  const [orchestratorPickerOpen, setOrchestratorPickerOpen] = useState(false);
  const [imagePickerOpen, setImagePickerOpen] = useState(false);
  const [modelSaving, setModelSaving] = useState<"orchestrator" | "image" | null>(null);

  // Active providers (have credentials) — derived from auth status
  const authProviders = objectOrEmpty<ProviderAuthInfo>(authStatus?.providers);
  const isActiveProvider = (info: ProviderAuthInfo) => (info.custom ? !!info.configured : info.hasEnvKey)
    || arrayOrEmpty<AuthProfileMeta>(info.profiles).some((p) => p.status === "active");
  const configuredProviders = Object.entries(authProviders)
    .filter(([, info]) => isActiveProvider(info))
    .map(([name]) => name);
  const providerSources = Object.fromEntries(
    Object.entries(authProviders)
      .filter(([, info]) => isActiveProvider(info))
      .map(([name, info]) => [name, info.custom ? "custom" : info.hasEnvKey ? "env" : "oauth"]),
  );

  const handleReasoningChange = async (value: string) => {
    setReasoningSaving(true);
    try {
      await onUpdateSettings({ reasoning: value as ReasoningLevel });
    } finally {
      setReasoningSaving(false);
    }
  };

  const handleOrchestratorModelSelect = async (spec: string) => {
    setModelSaving("orchestrator");
    try {
      await onUpdateSettings({ orchestratorModel: spec });
      setOrchestratorPickerOpen(false);
    } finally {
      setModelSaving(null);
    }
  };

  const handleImageModelSelect = async (spec: string) => {
    setModelSaving("image");
    try {
      await onUpdateSettings({ imageModel: spec });
      setImagePickerOpen(false);
    } finally {
      setModelSaving(null);
    }
  };

  const handleImageModelClear = async () => {
    setModelSaving("image");
    try {
      await onUpdateSettings({ imageModel: null });
    } finally {
      setModelSaving(null);
    }
  };

  // Format model display value
  const orchestratorDisplay = primaryModel ? (
    <span className="flex items-center gap-1.5">
      <span>{parseModelSpec(primaryModel).model}</span>
      <Badge variant="outline" className="text-micro h-4 font-normal">{providerLabel(parseModelSpec(primaryModel).provider)}</Badge>
    </span>
  ) : undefined;

  const imageDisplay = settings.imageModel ? (
    <span className="flex items-center gap-1.5">
      <span>{parseModelSpec(settings.imageModel).model}</span>
      <Badge variant="outline" className="text-micro h-4 font-normal">{providerLabel(parseModelSpec(settings.imageModel).provider)}</Badge>
    </span>
  ) : undefined;

  return (
    <div className="space-y-6">
      {/* ── Models & Reasoning ── */}
      <section>
        <SectionHeader icon={Settings2} title="Orchestrator Settings" className="mb-3" />
        <div className="space-y-2 max-w-xl">
          {/* Name: how the orchestrator is called in chats, groups, channels and its own prompt */}
          <div className="rounded-lg border border-border/40 bg-card/60 px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/40 shrink-0">
                {nameSaving
                  ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  : <Pencil className="h-4 w-4 text-muted-foreground" />}
              </div>
              <div className="flex-1 min-w-0">
                <label htmlFor="orchestrator-name" className="text-xs font-medium text-foreground">Name</label>
                <p className="text-micro text-muted-foreground mt-0.5 leading-tight">
                  What people call the orchestrator in chats, groups and channels
                </p>
              </div>
              <Input
                id="orchestrator-name"
                aria-label="Orchestrator name"
                className="h-8 w-40 text-xs"
                placeholder="Polpo"
                maxLength={ORCHESTRATOR_NAME_MAX_LENGTH}
                value={nameDraft}
                disabled={nameSaving}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={() => { void saveName(); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); void saveName(); }
                  if (e.key === "Escape") { setNameDraft(savedName); setNameError(null); }
                }}
              />
            </div>
            {nameError && <p className="text-micro text-destructive mt-1.5 ml-11">{nameError}</p>}
          </div>

          {/* Orchestrator Model */}
          <SettingRow
            icon={Brain}
            label="Orchestrator Model"
            description="Planning, assessment, and agent coordination"
            value={orchestratorDisplay}
            placeholder="Auto-detect"
            onClick={() => setOrchestratorPickerOpen(true)}
            saving={modelSaving === "orchestrator"}
          />

          {/* Fallbacks */}
          {fallbackModels.length > 0 && (
            <div className="ml-11 flex flex-wrap gap-1 py-1">
              <span className="text-micro text-muted-foreground mr-1">Fallbacks:</span>
              {fallbackModels.map((fb) => (
                <Badge key={fb} variant="outline" className="text-micro font-mono">{fb}</Badge>
              ))}
            </div>
          )}

          {/* Image Model */}
          <SettingRow
            icon={Monitor}
            label="Image Model"
            description="Vision tasks — falls back to orchestrator model"
            value={imageDisplay}
            placeholder="Not set"
            onClick={() => setImagePickerOpen(true)}
            onClear={settings.imageModel ? handleImageModelClear : undefined}
            saving={modelSaving === "image"}
          />

          {/* Reasoning */}
          <div className="rounded-lg border border-border/40 bg-card/60 px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/40 shrink-0">
                {reasoningSaving
                  ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  : <Sparkles className="h-4 w-4 text-muted-foreground" />}
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-xs font-medium text-foreground">Reasoning Level</span>
                <p className="text-micro text-muted-foreground mt-0.5 leading-tight">
                  {REASONING_LEVELS.find((l) => l.value === (settings.reasoning ?? "off"))?.description}
                </p>
              </div>
              <Select
                value={settings.reasoning ?? "off"}
                onValueChange={handleReasoningChange}
                disabled={reasoningSaving}
              >
                <SelectTrigger className="h-8 text-xs w-36 shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REASONING_LEVELS.map((level) => (
                    <SelectItem key={level.value} value={level.value} className="text-xs">
                      <span className={cn(
                        "font-medium",
                        level.value !== "off" ? "text-success" : "text-muted-foreground",
                      )}>
                        {level.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </section>

      {/* ── Orchestrator Skills ── */}
      <section>
        <SectionHeader icon={Bookmark} title="Skills" className="mb-3" />
        {skillsLoading ? (
          <div className="flex items-center gap-2 py-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Loading skills...</span>
          </div>
        ) : skills.length > 0 ? (
          <div className="space-y-2 max-w-xl">
            {skills.map((skill: SkillInfo) => (
              <div key={skill.name} className="flex items-start gap-3 rounded-lg border border-border/40 bg-card/60 px-4 py-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/40 shrink-0">
                  <Bookmark className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium">{skill.name}</span>
                    <Badge variant="outline" className="text-micro h-4">{skill.source}</Badge>
                  </div>
                  {skill.description && (
                    <p className="text-micro text-muted-foreground mt-0.5 line-clamp-2 leading-tight">{skill.description}</p>
                  )}
                </div>
              </div>
            ))}
            {settings.orchestratorSkills && settings.orchestratorSkills.length > 0 && (
              <p className="text-micro text-muted-foreground mt-1 ml-11">
                Filter: <code className="font-mono text-primary">{settings.orchestratorSkills.join(", ")}</code>
              </p>
            )}
          </div>
        ) : (
          <Empty text="No orchestrator skills installed" />
        )}
        <p className="text-micro text-muted-foreground mt-2">
          Skill pool: <code className="font-mono text-primary">.polpo/.agent/skills/</code>
        </p>
      </section>

      {/* ── Orchestrator Model Picker Dialog ── */}
      <Dialog open={orchestratorPickerOpen} onOpenChange={setOrchestratorPickerOpen}>
        <DialogContent className="sm:max-w-lg p-0 gap-0 overflow-hidden">
          <DialogHeader className="px-6 pt-6 pb-0">
            <DialogTitle className="text-base">Orchestrator Model</DialogTitle>
            <DialogDescription className="text-xs">
              Choose the model that powers planning, assessment, and agent coordination.
            </DialogDescription>
          </DialogHeader>
          <div className="px-6 py-5">
            <ModelPicker
              configuredProviders={configuredProviders}
              providerSources={providerSources}
              value={primaryModel ?? null}
              onSelect={handleOrchestratorModelSelect}
              apiFetch={api}
              heading={null}
              maxHeight="320px"
            />
            {modelSaving === "orchestrator" && (
              <div className="flex items-center gap-2 mt-3 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving...
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Image Model Picker Dialog ── */}
      <Dialog open={imagePickerOpen} onOpenChange={setImagePickerOpen}>
        <DialogContent className="sm:max-w-lg p-0 gap-0 overflow-hidden">
          <DialogHeader className="px-6 pt-6 pb-0">
            <DialogTitle className="text-base">Image Model</DialogTitle>
            <DialogDescription className="text-xs">
              Choose the model for vision tasks. Falls back to the orchestrator model if not set.
            </DialogDescription>
          </DialogHeader>
          <div className="px-6 py-5">
            <ModelPicker
              configuredProviders={configuredProviders}
              providerSources={providerSources}
              value={settings.imageModel ?? null}
              onSelect={handleImageModelSelect}
              apiFetch={api}
              heading={null}
              maxHeight="320px"
            />
            {modelSaving === "image" && (
              <div className="flex items-center gap-2 mt-3 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving...
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Providers Tab ──

function ProvidersTab({ settings, providers, allProviderNames, providerAgentUsage, authStatus, onRefresh }: {
  settings: PolpoSettings;
  providers: Record<string, ProviderConfig> | undefined;
  allProviderNames: Set<string>;
  providerAgentUsage: Map<string, string[]>;
  authStatus: AuthStatusResponse | null | undefined;
  onRefresh: () => Promise<void>;
}) {
  // ── "Add provider" dialog (full AuthStep — lists all providers) ──
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addTab, setAddTab] = useState<"builtin" | "custom">("builtin");

  // ── Custom endpoints / gateways ──
  const { providers: customProviders, loaded: customLoaded, reload: reloadCustom } = useCustomProviders(api);
  const customIds = new Set<string>([
    ...customProviders.map((p) => p.id),
    ...Object.entries(authStatus?.providers ?? {}).filter(([, info]) => info.custom).map(([name]) => name),
  ]);
  const refreshCustom = useCallback(async () => {
    await reloadCustom();
    await onRefresh();
  }, [reloadCustom, onRefresh]);
  const [authProviders, setAuthProviders] = useState<AuthProvider[]>([]);
  const [authProvidersLoaded, setAuthProvidersLoaded] = useState(false);

  // ── "Connect specific provider" dialog (direct flow) ──
  // a link from an assistant (?section=providers&provider=openai&focus=apiKey) opens that provider's key form
  const [connectTarget, setConnectTarget] = useState<string | null>(() => {
    const p = readSetupParams();
    return p.section === "providers" && p.provider && p.focus === "apiKey" ? p.provider : null;
  });
  const [connectMode, setConnectMode] = useState<"choose" | "oauth" | "apikey">(() => (connectTarget ? "apikey" : "choose"));
  const [oauthProviders, setOauthProviders] = useState<OAuthProvider[]>([]);

  // ── Disconnect ──
  const [disconnectTarget, setDisconnectTarget] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);

  // Load full provider list for AuthStep (add dialog)
  const ensureAuthProviders = useCallback(async () => {
    if (authProvidersLoaded) return;
    const r = await api("/providers");
    if (r.ok) {
      setAuthProviders(r.data);
      setAuthProvidersLoaded(true);
    }
  }, [authProvidersLoaded]);

  const refreshProviderList = useCallback(async () => {
    await onRefresh();
    const r = await api("/providers");
    if (r.ok) {
      setAuthProviders(r.data);
      setAuthProvidersLoaded(true);
    }
  }, [onRefresh]);

  // ── Connect: card button → open direct dialog for that provider ──
  const handleConnect = useCallback(async (name: string) => {
    const info = authStatus?.providers[name];
    setConnectTarget(name);

    if (info?.oauthAvailable) {
      // Load OAuth providers list if needed, then show choice
      const r = await api("/providers/oauth");
      if (r.ok) setOauthProviders(r.data);
      setConnectMode("choose");
    } else {
      // No OAuth → go direct to API key
      // Ensure provider list loaded for ApiKeyStep
      await ensureAuthProviders();
      setConnectMode("apikey");
    }
  }, [authStatus, ensureAuthProviders]);

  // Close the connect dialog and reset state
  const closeConnectDialog = useCallback(() => {
    setConnectTarget(null);
    setConnectMode("choose");
  }, []);

  // ── Disconnect: card button → confirm dialog ──
  const handleDisconnectRequest = useCallback((name: string) => {
    setDisconnectTarget(name);
  }, []);

  const handleDisconnectConfirm = useCallback(async () => {
    if (!disconnectTarget) return;
    const name = disconnectTarget;
    setDisconnecting(name);
    setDisconnectTarget(null);
    try {
      await api(`/providers/${name}/disconnect`, { method: "DELETE" });
      await refreshProviderList();
    } finally {
      setDisconnecting(null);
    }
  }, [disconnectTarget, refreshProviderList]);

  // ── Shared handlers for auth flows ──
  const handleSaveKey = useCallback(async (provider: string, key: string): Promise<boolean> => {
    const result = await api(`/providers/${provider}/api-key`, {
      method: "POST",
      body: JSON.stringify({ apiKey: key }),
    });
    if (result.ok) {
      await refreshProviderList();
      notifySetupSaved();
      return true;
    }
    return false;
  }, [refreshProviderList]);

  const handleOAuthComplete = useCallback(async (_provider: string) => {
    await refreshProviderList();
    closeConnectDialog();
  }, [refreshProviderList, closeConnectDialog]);

  // Disconnect from inside the AuthStep (add dialog) — AuthStep has its own ConfirmDialog
  const handleAuthDisconnect = useCallback(async (provider: string) => {
    setDisconnecting(provider);
    try {
      await api(`/providers/${provider}/disconnect`, { method: "DELETE" });
      await refreshProviderList();
    } finally {
      setDisconnecting(null);
    }
  }, [refreshProviderList]);

  return (
    <div className="space-y-6">
      {/* ── Provider Cards ── */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <SectionHeader icon={Key} title="Providers" className="mb-0" />
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={async () => { await ensureAuthProviders(); setAddTab("builtin"); setAddDialogOpen(true); }}
          >
            <Key className="h-3 w-3" />
            Add provider
          </Button>
        </div>
        {[...allProviderNames].some((name) => !customIds.has(name)) ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {[...allProviderNames].filter((name) => !customIds.has(name)).sort().map((name) => {
              const prov = providers?.[name] ?? {} as ProviderConfig;
              const agentUsage = providerAgentUsage.get(name) ?? [];
              const authInfo = authStatus?.providers[name];
              return (
                <ProviderCard
                  key={name}
                  name={name}
                  prov={prov}
                  agentModels={agentUsage}
                  authInfo={authInfo}
                  onConnect={handleConnect}
                  onDisconnect={handleDisconnectRequest}
                  disconnecting={disconnecting === name}
                />
              );
            })}
          </div>
        ) : (
          <Empty text="No providers configured — using environment variables for auto-detection" />
        )}
      </section>

      {/* ── Custom endpoints & gateways ── */}
      <CustomProvidersSection
        apiFetch={api}
        providers={customProviders}
        loaded={customLoaded}
        agentUsage={providerAgentUsage}
        onChanged={refreshCustom}
        onAdd={async () => { await ensureAuthProviders(); setAddTab("custom"); setAddDialogOpen(true); }}
      />

      {/* ── Model Allowlist ── */}
      {settings.modelAllowlist && Object.keys(settings.modelAllowlist).length > 0 && (
        <section>
          <SectionHeader icon={Shield} title="Model Allowlist" className="mb-2" />
          <div className="space-y-1.5 max-w-lg">
            {Object.entries(settings.modelAllowlist).map(([model, opts]) => (
              <div key={model} className="flex items-center gap-2 rounded-md bg-muted/20 px-2.5 py-1.5 min-w-0">
                <code className="text-caption font-mono truncate flex-1">{model}</code>
                {opts.alias && <Badge variant="outline" className="text-micro shrink-0">{opts.alias}</Badge>}
                {opts.params && Object.entries(opts.params).map(([k, v]) => (
                  <Badge key={k} variant="secondary" className="text-micro shrink-0">{k}: {String(v)}</Badge>
                ))}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Connect Specific Provider Dialog ── */}
      <Dialog open={!!connectTarget} onOpenChange={(open) => { if (!open) closeConnectDialog(); }}>
        <DialogContent className="sm:max-w-lg p-0 gap-0 overflow-hidden">
          <DialogHeader className="px-6 pt-6 pb-0">
            <DialogTitle className="text-base">Connect {connectTarget}</DialogTitle>
            <DialogDescription className="text-xs">
              {connectMode === "choose"
                ? "Choose how to authenticate with this provider."
                : connectMode === "oauth"
                  ? "Complete the login flow in your browser."
                  : "Enter your API key to connect."}
            </DialogDescription>
          </DialogHeader>
          <div className="px-6 py-5">
            {/* Choose: OAuth or API key */}
            {connectMode === "choose" && (
              <div className="space-y-3">
                <button
                  onClick={() => setConnectMode("oauth")}
                  className="w-full flex items-start gap-4 p-4 rounded-lg border border-border hover:border-primary/30 hover:bg-accent/50 text-left transition-all"
                >
                  <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                    <LogIn className="h-5 w-5 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium text-sm">Login with subscription</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Use your existing account — no API key needed.
                    </p>
                  </div>
                </button>
                <button
                  onClick={async () => {
                    await ensureAuthProviders();
                    setConnectMode("apikey");
                  }}
                  className="w-full flex items-start gap-4 p-4 rounded-lg border border-border hover:border-primary/30 hover:bg-accent/50 text-left transition-all"
                >
                  <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center shrink-0 mt-0.5">
                    <Keyboard className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium text-sm">Enter an API key</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Paste an API key for this provider.
                    </p>
                  </div>
                </button>
              </div>
            )}

            {/* OAuth flow — starts immediately for the target provider */}
            {connectMode === "oauth" && connectTarget && (
              <OAuthFlow
                oauthProviders={oauthProviders}
                initialProvider={connectTarget}
                onBack={() => setConnectMode("choose")}
                onComplete={handleOAuthComplete}
                apiFetch={api}
              />
            )}

            {/* API key — pre-selected provider */}
            {connectMode === "apikey" && connectTarget && (
              <ApiKeyStep
                providers={authProviders}
                initialProvider={connectTarget}
                onSave={async (provider, key) => {
                  const ok = await handleSaveKey(provider, key);
                  if (ok) closeConnectDialog();
                  return ok;
                }}
                onBack={() => {
                  const info = authStatus?.providers[connectTarget];
                  if (info?.oauthAvailable) setConnectMode("choose");
                  else closeConnectDialog();
                }}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Add Provider Dialog (full AuthStep) ── */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent className={cn("p-0 gap-0 max-h-[90vh] overflow-y-auto", addTab === "custom" ? "sm:max-w-2xl" : "sm:max-w-lg")}>
          <DialogHeader className="px-6 pt-6 pb-0">
            <DialogTitle className="text-base">Add provider</DialogTitle>
            <DialogDescription className="text-xs">
              Connect a built-in provider (OAuth or API key), or a custom endpoint / AI gateway.
            </DialogDescription>
          </DialogHeader>
          <div className="px-6 py-5">
            <Tabs value={addTab} onValueChange={(v) => setAddTab(v as "builtin" | "custom")}>
              <TabsList className="mb-3">
                <TabsTrigger value="builtin" className="text-small">Built-in</TabsTrigger>
                <TabsTrigger value="custom" className="text-small">Custom endpoint / gateway</TabsTrigger>
              </TabsList>
              <TabsContent value="builtin">
                {authProviders.length > 0 ? (
                  <AuthStep
                    providers={authProviders}
                    onKeySave={handleSaveKey}
                    onOAuthComplete={async () => { await refreshProviderList(); }}
                    onDisconnect={handleAuthDisconnect}
                    apiFetch={api}
                  />
                ) : (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                )}
              </TabsContent>
              {/* forceMount: switching tabs must not discard a half-filled wizard */}
              <TabsContent value="custom" forceMount className="data-[state=inactive]:hidden">
                {addDialogOpen && (
                  <CustomProviderWizard
                    apiFetch={api}
                    takenIds={customIds}
                    onCancel={() => setAddDialogOpen(false)}
                    onSaved={async () => { setAddDialogOpen(false); await refreshCustom(); }}
                  />
                )}
              </TabsContent>
            </Tabs>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Disconnect Confirmation ── */}
      <ConfirmDialog
        open={!!disconnectTarget}
        onOpenChange={(open) => { if (!open) setDisconnectTarget(null); }}
        title={`Disconnect ${disconnectTarget ?? ""}?`}
        description="This will remove the API key and any OAuth sessions for this provider."
        confirmLabel="Disconnect"
        destructive
        onConfirm={handleDisconnectConfirm}
      />
    </div>
  );
}

// ── Main ──

export function ConfigPage() {
  const { config, isLoading, error, refetch, setOptimistic } = useConfig();
  const { agents } = useAgents();
  const { authStatus, refetch: refetchAuth } = useAuthStatus();
  const [activeSection, setActiveSection] = useState<SectionId>(() => findConfigSection(readSetupParams().section) ?? "general");
  // ?section= follows the section shown (the sidebar's Settings links point at it, and highlight it)
  const [searchParams, setSearchParams] = useSearchParams();
  const sectionParam = searchParams.get("section");
  const [seenSectionParam, setSeenSectionParam] = useState(sectionParam);
  if (seenSectionParam !== sectionParam) {
    setSeenSectionParam(sectionParam);
    const linked = findConfigSection(sectionParam);
    if (linked && linked !== activeSection) setActiveSection(linked);
  }
  const selectSection = (id: SectionId) => {
    setActiveSection(id);
    if (findConfigSection(sectionParam) !== id) setSearchParams({ section: id }, { replace: true });
  };
  // a link from an assistant (setup_url): scroll to the field to fill and focus it
  useEffect(() => focusSetupField(readSetupParams()), [activeSection]);

  // ── Rule dialog state ──
  const [ruleDialogOpen, setRuleDialogOpen] = useState(false);
  const [ruleDialogInitial, setRuleDialogInitial] = useState<NotificationRuleDraft | undefined>(undefined);
  const [deleteRuleId, setDeleteRuleId] = useState<string | null>(null);
  const [ruleBusy, setRuleBusy] = useState(false);

  // ── Gate dialog state ──
  const [gateDialogOpen, setGateDialogOpen] = useState(false);
  const [gateDialogInitial, setGateDialogInitial] = useState<ApprovalGateDraft | undefined>(undefined);
  const [deleteGateId, setDeleteGateId] = useState<string | null>(null);
  const [gateBusy, setGateBusy] = useState(false);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !config) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <Settings2 className="h-10 w-10 opacity-40" />
        <p className="text-sm">{error ?? "Could not load configuration"}</p>
        <Button variant="outline" size="sm" onClick={refetch}>
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Retry
        </Button>
      </div>
    );
  }

  const { settings, providers } = config;
  const notifications = settings.notifications as Record<string, unknown> | undefined;
  const rules = (notifications?.rules ?? []) as Array<{
    id: string; name?: string; events: string[]; channels: string[];
    severity?: string; template?: string; condition?: Record<string, unknown>;
    cooldownMs?: number; includeOutcomes?: boolean;
    outcomeFilter?: string[] | { types?: string[]; tags?: string[] };
    maxAttachmentSize?: number; actions?: Array<{ type: string; [key: string]: unknown }>;
  }>;

  // ── Models & Providers helpers ──

  // Collect all model specs from orchestrator + agents
  const orchestratorModel = settings.orchestratorModel;
  const primaryModel = typeof orchestratorModel === "string" ? orchestratorModel
    : typeof orchestratorModel === "object" ? orchestratorModel?.primary
    : undefined;
  const fallbackModels = typeof orchestratorModel === "object" ? orchestratorModel?.fallbacks ?? [] : [];

  // Map provider name → which agents use it
  const providerAgentUsage = new Map<string, string[]>();
  for (const agent of agents) {
    if (agent.model) {
      const { provider } = parseModelSpec(agent.model);
      const list = providerAgentUsage.get(provider) ?? [];
      list.push(agent.name);
      providerAgentUsage.set(provider, list);
    }
  }
  // Add orchestrator model to usage
  if (primaryModel) {
    const { provider } = parseModelSpec(primaryModel);
    const list = providerAgentUsage.get(provider) ?? [];
    if (!list.includes("orchestrator")) list.push("orchestrator");
    providerAgentUsage.set(provider, list);
  }

  // All provider names (configured + referenced + auth)
  const allProviderNames = new Set<string>();
  if (providers) for (const name of Object.keys(providers)) allProviderNames.add(name);
  for (const name of providerAgentUsage.keys()) allProviderNames.add(name);
  if (authStatus) for (const name of Object.keys(authStatus.providers)) allProviderNames.add(name);

  // ── Policies typed casts ──

  const escalation = settings.escalationPolicy as { name?: string; levels?: Array<{ level: number; handler: string; target?: string; timeoutMs?: number; notifyChannels?: string[] }> } | undefined;
  const sla = settings.sla as { warningThreshold?: number; checkIntervalMs?: number; warningChannels?: string[]; violationChannels?: string[]; violationAction?: string } | undefined;
  const gates = settings.approvalGates as Array<{
    id: string; name: string; handler: string; hook: string; condition?: { expression?: string };
    notifyChannels?: string[]; timeoutMs?: number; timeoutAction?: string; priority?: number; maxRevisions?: number;
    includeOutcomes?: boolean;
  }> | undefined;

  const hasPolicies = !!(escalation || sla || (gates && gates.length > 0));

  // Build visible sections — hide policies when empty (but always allow adding new gates from Policies tab when present, so we always show it)
  void hasPolicies;

  // ── Channel name list (used by rule/gate forms) ──
  const channelNames = Object.keys(
    (settings.notifications?.channels ?? {}) as Record<string, NotificationChannelConfig>,
  );

  // ── Rule persistence helpers ──
  const saveRule = async (rule: NotificationRuleDraft) => {
    setRuleBusy(true);
    try {
      const res = await api(`/config/rules/${encodeURIComponent(rule.id)}`, {
        method: "PUT",
        body: JSON.stringify(rule),
      });
      if (!res.ok) throw new Error(res.error ?? "Failed to save rule");
      if (res.data) setOptimistic(res.data);
      else await refetch();
      toast.success(`Rule "${rule.id}" saved`);
    } finally {
      setRuleBusy(false);
    }
  };

  const removeRule = async (id: string) => {
    setRuleBusy(true);
    try {
      const res = await api(`/config/rules/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(res.error ?? "Failed to delete rule");
      if (res.data) setOptimistic(res.data);
      else await refetch();
      toast.success(`Rule "${id}" deleted`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRuleBusy(false);
      setDeleteRuleId(null);
    }
  };

  // ── Gate persistence helpers ──
  const saveGate = async (gate: ApprovalGateDraft) => {
    setGateBusy(true);
    try {
      const res = await api(`/config/gates/${encodeURIComponent(gate.id)}`, {
        method: "PUT",
        body: JSON.stringify(gate),
      });
      if (!res.ok) throw new Error(res.error ?? "Failed to save gate");
      if (res.data) setOptimistic(res.data);
      else await refetch();
      toast.success(`Gate "${gate.id}" saved`);
    } finally {
      setGateBusy(false);
    }
  };

  const removeGate = async (id: string) => {
    setGateBusy(true);
    try {
      const res = await api(`/config/gates/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(res.error ?? "Failed to delete gate");
      if (res.data) setOptimistic(res.data);
      else await refetch();
      toast.success(`Gate "${id}" deleted`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setGateBusy(false);
      setDeleteGateId(null);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* ── Section bar (the drill-in sidebar lists the sections: the page shows the title) ── */}
      <ConfigSectionBar
        active={activeSection}
        onSelect={selectSection}
        actions={(
          <Button variant="outline" size="sm" className="h-8 shrink-0" onClick={refetch} aria-label="Reload configuration">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        )}
      />

      {/* ── Tab content ── */}
      <div className="flex-1 overflow-auto pb-bottom-nav lg:pb-2 space-y-3">

        {/* ═══ GENERAL (merged with Settings) ═══ */}
        {activeSection === "general" && (
          <div className="space-y-6">
            {/* ── Project ── */}
            <section>
              <SectionHeader icon={Hash} title="Project" className="mb-1.5" />
              <div className="max-w-md">
                <Row label="Name" value={config.project} mono />
              </div>
            </section>

            {/* ── Runtime ── */}
            <section>
              <SectionHeader icon={Settings2} title="Runtime" className="mb-1.5" />
              <div className="max-w-md">
                <Row label="Storage" value={settings.storage ?? "file"} mono />
                <Row label="Log Level" value={settings.logLevel} mono />
                <Row label="Work Directory" value={settings.workDir} mono />
              </div>
              <p className="text-micro text-muted-foreground mt-2">
                Source: <code className="font-mono text-primary">.polpo/polpo.json</code>
              </p>
            </section>

            {/* ── Execution ── */}
            <section>
              <SectionHeader icon={Activity} title="Execution" className="mb-1.5" />
              <div className="max-w-md">
                <Row label="Max Retries" value={settings.maxRetries} />
                <Row label="Max Concurrency" value={settings.maxConcurrency ?? "unlimited"} />
                <Row label="Task Timeout" value={settings.taskTimeout ? `${Math.round(settings.taskTimeout / 1000)}s` : "30min (default)"} />
                <Row label="Stale Threshold" value={settings.staleThreshold ? `${Math.round(settings.staleThreshold / 1000)}s` : "5min (default)"} />
                <Row label="Max Fix Attempts" value={settings.maxFixAttempts ?? "2 (default)"} />
                <Row label="Max Question Rounds" value={settings.maxQuestionRounds ?? "2 (default)"} />
                <Row label="Max Resolution Attempts" value={settings.maxResolutionAttempts ?? "2 (default)"} />
              </div>
            </section>

            {/* ── Quality ── */}
            <section>
              <SectionHeader icon={Gauge} title="Quality" className="mb-1.5" />
              <div className="max-w-md">
                <Row label="Quality Threshold" value={settings.defaultQualityThreshold != null ? `${settings.defaultQualityThreshold}/5` : "none"} />
                <Row label="Auto-correct" value={settings.autoCorrectExpectations !== false ? "Yes" : "No"} />
                <Row label="Max Assessment Retries" value={settings.maxAssessmentRetries ?? "1 (default)"} />
              </div>
            </section>

            {/* ── Features ── */}
            <section>
              <SectionHeader icon={ToggleRight} title="Features" className="mb-1.5" />
              <div className="max-w-md">
                <div className="flex items-center justify-between py-1.5">
                  <span className="text-xs text-muted-foreground">Scheduler</span>
                  <CapPill label={settings.enableScheduler ? "Enabled" : "Disabled"} on={settings.enableScheduler ?? false} />
                </div>
                <div className="flex items-center justify-between py-1.5">
                  <span className="text-xs text-muted-foreground">Volatile Teams</span>
                  <CapPill label={settings.enableVolatileTeams !== false ? "Enabled" : "Disabled"} on={settings.enableVolatileTeams !== false} />
                </div>
                {settings.volatileCleanup && <Row label="Volatile Cleanup" value={settings.volatileCleanup} mono />}
              </div>
            </section>

            {/* ── Retry Policy ── */}
            {settings.defaultRetryPolicy && (
              <section>
                <SectionHeader icon={RefreshCw} title="Default Retry Policy" className="mb-1.5" />
                <div className="max-w-md">
                  {settings.defaultRetryPolicy.escalateAfter != null && <Row label="Escalate After" value={`${settings.defaultRetryPolicy.escalateAfter} failures`} />}
                  {settings.defaultRetryPolicy.fallbackAgent && <Row label="Fallback Agent" value={settings.defaultRetryPolicy.fallbackAgent} mono />}
                  {settings.defaultRetryPolicy.escalateModel && <Row label="Escalate Model" value={settings.defaultRetryPolicy.escalateModel} mono />}
                </div>
              </section>
            )}

            {/* ── Email Domains ── */}
            {settings.emailAllowedDomains && settings.emailAllowedDomains.length > 0 && (
              <section>
                <SectionHeader icon={Mail} title="Email Allowed Domains" className="mb-1.5" />
                <div className="flex flex-wrap gap-1.5">
                  {settings.emailAllowedDomains.map((d) => (
                    <Badge key={d} variant="secondary" className="text-micro font-mono">{d}</Badge>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {/* ═══ SANDBOX ═══ */}
        {activeSection === "sandbox" && <SandboxSettingsSection onSaved={() => void refetch()} />}

        {/* ═══ HARNESSES ═══ */}
        {activeSection === "harnesses" && <HarnessesSection />}
        {activeSection === "computers" && <ComputerWebhooksSection />}

        {/* ═══ MCP ACCESS ═══ */}
        {activeSection === "mcp" && <McpAccessSection />}

        {/* ═══ APPEARANCE ═══ */}
        {activeSection === "appearance" && (
          <AppearanceTab
            branding={settings.branding}
            onUpdateBranding={async (branding) => {
              const result = await api("/config/settings", {
                method: "PATCH",
                body: JSON.stringify({ branding }),
              });
              if (!result.ok) throw new Error(result.error ?? "Failed to update branding");
              if (result.data) setOptimistic(result.data); else await refetch();
              notifyBrandingChanged();
              toast.success("Branding updated");
            }}
            onUploadLogo={async (file, variant) => {
              const response = await apiFetch(`${appConfig.baseUrl}/api/v1/config/instance-logo${variant === "dark" ? "?variant=dark" : ""}`, {
                method: "POST",
                headers: {
                  "Content-Type": file.type,
                  ...(appConfig.apiKey ? { Authorization: `Bearer ${appConfig.apiKey}` } : {}),
                },
                credentials: "include",
                body: file,
              });
              const result = await response.json().catch(() => null);
              if (!response.ok || !result?.ok) throw new Error(result?.error ?? `Logo upload failed (${response.status})`);
              if (result.data) setOptimistic(result.data); else await refetch();
              notifyBrandingChanged();
              toast.success("Logo uploaded");
            }}
            onRemoveLogo={async (variant) => {
              const result = await api(`/config/instance-logo${variant === "dark" ? "?variant=dark" : ""}`, { method: "DELETE" });
              if (!result.ok) throw new Error(result.error ?? "Failed to remove logo");
              if (result.data) setOptimistic(result.data); else await refetch();
              notifyBrandingChanged();
              toast.success("Logo removed");
            }}
            onSaveInstanceAppearance={async (appearance) => {
              // the sidebar style is set on its own (above the look): saving or clearing the look keeps it
              const sidebarStyle = (settings.appearance as InstanceAppearance | undefined)?.sidebarStyle;
              const next = sidebarStyle ? { ...(appearance ?? {}), sidebarStyle } : appearance;
              const result = await api("/config/settings", {
                method: "PATCH",
                body: JSON.stringify({ appearance: next }),
              });
              if (!result.ok) throw new Error(result.error ?? "Failed to save the instance appearance");
              if (result.data) setOptimistic(result.data); else await refetch();
              setInstanceAppearance((result.data?.settings?.appearance as InstanceAppearance | undefined) ?? {});
              // this browser follows the new default (nothing of its own left over)
              followInstanceDefault();
              toast.success(appearance ? "Saved as the instance default: everyone sees it now" : "Instance default cleared");
            }}
            onSaveSidebarStyle={async (sidebarStyle) => {
              const current = { ...((settings.appearance as InstanceAppearance | undefined) ?? {}) };
              // drill-in is the built-in default: no need to store it (classic is stored)
              if (sidebarStyle === "drill-in") delete current.sidebarStyle;
              else current.sidebarStyle = sidebarStyle;
              const result = await api("/config/settings", {
                method: "PATCH",
                body: JSON.stringify({ appearance: Object.keys(current).length ? current : null }),
              });
              if (!result.ok) throw new Error(result.error ?? "Failed to save the instance sidebar");
              if (result.data) setOptimistic(result.data); else await refetch();
              setInstanceAppearance((result.data?.settings?.appearance as InstanceAppearance | undefined) ?? {});
              toast.success(`Instance default: the ${sidebarStyle === "classic" ? "classic" : "drill-in"} sidebar`);
            }}
          />
        )}

        {/* ═══ MEMBERS ═══ */}
        {activeSection === "members" && (
          <MembersTab />
        )}

        {/* ═══ AGENT (orchestrator config) ═══ */}
        {activeSection === "agent" && (
          <AgentTab
            settings={settings}
            primaryModel={primaryModel}
            fallbackModels={fallbackModels}
            authStatus={authStatus}
            onUpdateSettings={async (patch) => {
              const result = await api("/config/settings", {
                method: "PATCH",
                body: JSON.stringify(patch),
              });
              if (!result.ok) {
                throw new Error(result.error ?? "Failed to update settings");
              }
              // Use the updated config returned by the server directly (avoids extra fetch + loading flash)
              if (result.data) {
                setOptimistic(result.data);
              } else {
                await refetch();
              }
            }}
          />
        )}

        {/* ═══ PROVIDERS ═══ */}
        {activeSection === "providers" && (
          <ProvidersTab
            settings={settings}
            providers={providers}
            allProviderNames={allProviderNames}
            providerAgentUsage={providerAgentUsage}
            authStatus={authStatus}
            onRefresh={async () => { await refetchAuth(); await refetch(); }}
          />
        )}

        {/* ═══ CHANNELS ═══ */}
        {activeSection === "channels" && (
          <ChannelsSection channels={objectOrEmpty<NotificationChannelConfig>(objectOrEmpty(settings.notifications).channels)} onUpdateConfig={async (updater) => {
            const result = await api("/config/channels" + (updater.path ?? ""), {
              method: updater.method,
              body: updater.body ? JSON.stringify(updater.body) : undefined,
            });
            if (!result.ok) throw new Error(result.error ?? "Failed");
            if (result.data) setOptimistic(result.data);
            else await refetch();
          }} />
        )}

        {/* ═══ RULES ═══ */}
        {activeSection === "rules" && (
          <>
            <div className="flex items-center justify-between mb-3">
              <p className="text-caption text-muted-foreground">
                Trigger notifications when lifecycle events match. Persisted to <code className="font-mono text-primary">.polpo/polpo.json</code>.
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => { setRuleDialogInitial(undefined); setRuleDialogOpen(true); }}
                disabled={ruleBusy}
              >
                <Plus className="h-3.5 w-3.5 mr-1" /> New rule
              </Button>
            </div>

            {/* Event glossary — collapsible reference grouped by category */}
            <details className="mb-3 rounded-md border border-border/30 bg-muted/10 group">
              <summary className="cursor-pointer px-3 py-2 text-label text-muted-foreground hover:text-foreground select-none flex items-center gap-2">
                <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
                Event glossary
                <span className="ml-2 text-micro font-normal normal-case tracking-normal text-muted-foreground/70">
                  ({HOOK_EVENT_CATALOG.length} events, {HOOK_EVENT_GLOBS.length} glob shortcuts)
                </span>
              </summary>
              <div className="px-3 pb-3 pt-1 space-y-3">
                {(() => {
                  const byCategory = new Map<string, typeof HOOK_EVENT_CATALOG>();
                  for (const ev of HOOK_EVENT_CATALOG) {
                    const list = byCategory.get(ev.category) ?? [];
                    list.push(ev);
                    byCategory.set(ev.category, list);
                  }
                  return [...byCategory.entries()].map(([cat, evs]) => (
                    <div key={cat}>
                      <p className="text-label text-muted-foreground mb-1">
                        {cat} ({evs.length})
                      </p>
                      <ul className="space-y-0.5 pl-1">
                        {evs.map(ev => (
                          <li key={ev.name} className="text-caption leading-snug">
                            <code className="font-mono text-foreground">{ev.name}</code>
                            <span className="text-muted-foreground"> — {ev.description}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ));
                })()}
                <div>
                  <p className="text-label text-muted-foreground mb-1">
                    Glob shortcuts ({HOOK_EVENT_GLOBS.length})
                  </p>
                  <ul className="space-y-0.5 pl-1">
                    {HOOK_EVENT_GLOBS.map(g => (
                      <li key={g.pattern} className="text-caption leading-snug">
                        <code className="font-mono text-foreground">{g.pattern}</code>
                        <span className="text-muted-foreground"> — {g.description}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </details>

            {rules.length > 0 ? (
              <div className="space-y-2">
                {rules.map((rule) => (
                  <Card key={rule.id} className="py-0 gap-0">
                    <CardContent className="pt-3 pb-3">
                      <p className="text-caption leading-relaxed text-muted-foreground mb-2.5">
                        {summarizeRule(rule)}
                      </p>
                      <div className="flex items-center gap-2 mb-2">
                        <Eye className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="text-sm font-semibold">{rule.name ?? rule.id}</span>
                        {rule.severity && (
                          <Badge variant={rule.severity === "critical" ? "destructive" : rule.severity === "warning" ? "secondary" : "outline"} className="text-micro">
                            {rule.severity}
                          </Badge>
                        )}
                        <div className="ml-auto flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2"
                            onClick={() => {
                              setRuleDialogInitial({
                                id: rule.id,
                                name: rule.name,
                                events: rule.events ?? [],
                                channels: rule.channels ?? [],
                                severity: rule.severity as NotificationRuleDraft["severity"],
                                template: rule.template,
                                condition: rule.condition,
                                cooldownMs: rule.cooldownMs,
                                includeOutcomes: rule.includeOutcomes,
                                outcomeFilter: Array.isArray(rule.outcomeFilter)
                                  ? { types: rule.outcomeFilter }
                                  : (rule.outcomeFilter as { types?: string[]; tags?: string[] } | undefined),
                                maxAttachmentSize: rule.maxAttachmentSize,
                                actions: rule.actions,
                              });
                              setRuleDialogOpen(true);
                            }}
                            disabled={ruleBusy}
                          >
                            <Pencil className="h-3 w-3 mr-1" /> Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-destructive hover:text-destructive"
                            onClick={() => setDeleteRuleId(rule.id)}
                            disabled={ruleBusy}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                      {/* Events → Channels flow */}
                      <div className="flex flex-wrap items-center gap-1.5 mb-2">
                        {rule.events.map((e) => (
                          <Badge key={e} variant="secondary" className="text-micro font-mono">{e}</Badge>
                        ))}
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                        {rule.channels.map((c) => (
                          <Badge key={c} variant="outline" className="text-micro">{c}</Badge>
                        ))}
                      </div>
                      {/* Condition */}
                      {rule.condition && Object.keys(rule.condition).length > 0 && (
                        <div className="flex items-center gap-1.5 mb-2">
                          <Gauge className="h-3 w-3 text-muted-foreground shrink-0" />
                          <span className="text-micro text-muted-foreground">Condition filter active</span>
                        </div>
                      )}
                      {rule.template && (
                        <code className="text-caption text-muted-foreground block truncate bg-muted/20 rounded-xs px-2 py-1 mb-2">{rule.template}</code>
                      )}
                      {/* Meta row */}
                      {(rule.cooldownMs || rule.includeOutcomes || rule.actions?.length) && (
                        <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-border/20">
                          {rule.cooldownMs != null && rule.cooldownMs > 0 && (
                            <span className="flex items-center gap-1 text-caption text-muted-foreground">
                              <Timer className="h-3 w-3" />
                              {rule.cooldownMs >= 60000 ? `${(rule.cooldownMs / 60000).toFixed(0)}min` : `${(rule.cooldownMs / 1000).toFixed(0)}s`} cooldown
                            </span>
                          )}
                          {rule.includeOutcomes && (() => {
                            const types = Array.isArray(rule.outcomeFilter)
                              ? rule.outcomeFilter
                              : rule.outcomeFilter?.types ?? [];
                            return (
                              <span className="flex items-center gap-1 text-caption text-muted-foreground">
                                <Paperclip className="h-3 w-3" />
                                Outcomes{types.length ? ` (${types.join(", ")})` : ""}
                                {rule.maxAttachmentSize ? ` max ${(rule.maxAttachmentSize / 1048576).toFixed(0)}MB` : ""}
                              </span>
                            );
                          })()}
                          {rule.actions && rule.actions.length > 0 && (
                            <span className="flex items-center gap-1 text-caption text-muted-foreground">
                              <Zap className="h-3 w-3" />
                              {rule.actions.length} action{rule.actions.length > 1 ? "s" : ""} ({rule.actions.map(a => a.type).join(", ")})
                            </span>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <Empty text="No notification rules configured" />
            )}

            {rules.length > 0 && (
              <details className="mt-4 group">
                <summary className="text-caption text-muted-foreground cursor-pointer hover:text-foreground select-none">
                  Show raw JSON
                </summary>
                <JsonBlock
                  data={rules}
                  className="mt-2 text-caption leading-relaxed font-mono bg-muted/20 rounded-lg px-4 py-3 whitespace-pre-wrap max-h-64 overflow-auto border border-border/20"
                />
              </details>
            )}
          </>
        )}

        {/* ═══ POLICIES ═══ */}
        {activeSection === "policies" && (
              <div className="space-y-4">
                {/* Escalation Policy — structured display */}
                {escalation && (
                  <div>
                    <SectionHeader icon={AlertTriangle} title="Escalation Policy" className="mb-2" />
                    {escalation.name && (
                      <p className="text-xs text-muted-foreground mb-2">{escalation.name}</p>
                    )}
                    {escalation.levels && escalation.levels.length > 0 ? (
                      <div className="space-y-2">
                        {escalation.levels.map((level, i) => (
                          <div key={i} className="flex items-center gap-3">
                            {/* Level indicator */}
                            <div className="flex flex-col items-center shrink-0">
                              <div className={cn(
                                "flex h-8 w-8 items-center justify-center rounded-pill border-2 text-xs font-bold",
                                level.handler === "human" ? "border-destructive text-destructive bg-destructive/10" :
                                level.handler === "orchestrator" ? "border-warning text-warning bg-warning/10" :
                                "border-info text-info bg-info/10",
                              )}>
                                L{level.level}
                              </div>
                              {i < (escalation.levels?.length ?? 0) - 1 && (
                                <div className="w-px h-4 bg-border/40" />
                              )}
                            </div>
                            {/* Level details */}
                            <Card className="flex-1 py-0 gap-0">
                              <CardContent className="py-2.5 px-3">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <Badge variant={
                                    level.handler === "human" ? "destructive" :
                                    level.handler === "orchestrator" ? "secondary" : "outline"
                                  } className="text-micro">
                                    {level.handler}
                                  </Badge>
                                  {level.target && (
                                    <code className="text-caption font-mono text-muted-foreground">{level.target}</code>
                                  )}
                                  {level.timeoutMs && (
                                    <span className="flex items-center gap-1 text-micro text-muted-foreground ml-auto">
                                      <Clock className="h-2.5 w-2.5" />
                                      {level.timeoutMs >= 60000 ? `${(level.timeoutMs / 60000).toFixed(0)}min` : `${(level.timeoutMs / 1000).toFixed(0)}s`}
                                    </span>
                                  )}
                                </div>
                                {level.notifyChannels && level.notifyChannels.length > 0 && (
                                  <div className="flex items-center gap-1 mt-1.5">
                                    <Bell className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
                                    {level.notifyChannels.map((ch) => (
                                      <Badge key={ch} variant="outline" className="text-micro">{ch}</Badge>
                                    ))}
                                  </div>
                                )}
                              </CardContent>
                            </Card>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <JsonBlock data={escalation} className="text-caption leading-relaxed font-mono bg-muted/20 rounded-lg px-4 py-3 whitespace-pre-wrap max-h-64 overflow-auto border border-border/20" />
                    )}
                  </div>
                )}

                {/* SLA — structured display */}
                {sla && (
                  <section>
                    <SectionHeader icon={Timer} title="SLA Configuration" className="mb-1.5" />
                    <div className="max-w-md">
                      <Row label="Warning Threshold" value={sla.warningThreshold != null ? `${(sla.warningThreshold * 100).toFixed(0)}%` : "80% (default)"} />
                      <Row label="Check Interval" value={sla.checkIntervalMs ? `${(sla.checkIntervalMs / 1000).toFixed(0)}s` : "30s (default)"} />
                      <Row label="Violation Action" value={
                        <Badge variant={sla.violationAction === "fail" ? "destructive" : "outline"} className="text-micro">
                          {sla.violationAction ?? "notify"}
                        </Badge>
                      } />
                      {sla.warningChannels && sla.warningChannels.length > 0 && (
                        <div className="pt-1.5">
                          <span className="text-micro text-muted-foreground">Warning channels: </span>
                          {sla.warningChannels.map((ch) => (
                            <Badge key={ch} variant="secondary" className="text-micro mr-1">{ch}</Badge>
                          ))}
                        </div>
                      )}
                      {sla.violationChannels && sla.violationChannels.length > 0 && (
                        <div className="pt-1">
                          <span className="text-micro text-muted-foreground">Violation channels: </span>
                          {sla.violationChannels.map((ch) => (
                            <Badge key={ch} variant="destructive" className="text-micro mr-1">{ch}</Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  </section>
                )}

                {/* Approval Gates — structured display */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-label text-muted-foreground flex items-center gap-1.5">
                      <Shield className="h-3.5 w-3.5" /> Approval Gates
                      {gates && gates.length > 0 && (
                        <Badge variant="secondary" className="text-micro h-4 px-1.5">{gates.length}</Badge>
                      )}
                    </h3>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => { setGateDialogInitial(undefined); setGateDialogOpen(true); }}
                      disabled={gateBusy}
                    >
                      <Plus className="h-3.5 w-3.5 mr-1" /> New gate
                    </Button>
                  </div>
                  {gates && gates.length > 0 ? (
                    <div className="space-y-2">
                      {gates.map((gate) => (
                        <Card key={gate.id} className="py-0 gap-0">
                          <CardContent className="py-3 px-4">
                            <div className="flex items-center gap-2 mb-2 flex-wrap">
                              <span className="text-sm font-semibold">{gate.name}</span>
                              <Badge variant={gate.handler === "human" ? "destructive" : "secondary"} className="text-micro">
                                {gate.handler === "human" ? <Users className="h-2.5 w-2.5 mr-0.5" /> : <Bot className="h-2.5 w-2.5 mr-0.5" />}
                                {gate.handler}
                              </Badge>
                              <code className="text-micro font-mono text-muted-foreground">{gate.hook}</code>
                              {gate.priority && gate.priority !== 100 && (
                                <Badge variant="outline" className="text-micro">priority: {gate.priority}</Badge>
                              )}
                              <div className="ml-auto flex items-center gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2"
                                  onClick={() => {
                                    setGateDialogInitial({
                                      id: gate.id,
                                      name: gate.name,
                                      handler: (gate.handler === "auto" ? "auto" : "human"),
                                      hook: gate.hook as GateLifecycleHook,
                                      condition: gate.condition?.expression
                                        ? { expression: gate.condition.expression }
                                        : undefined,
                                      notifyChannels: gate.notifyChannels,
                                      timeoutMs: gate.timeoutMs,
                                      timeoutAction: gate.timeoutAction === "approve" ? "approve" : gate.timeoutAction === "reject" ? "reject" : undefined,
                                      priority: gate.priority,
                                      maxRevisions: gate.maxRevisions,
                                      includeOutcomes: gate.includeOutcomes,
                                    });
                                    setGateDialogOpen(true);
                                  }}
                                  disabled={gateBusy}
                                >
                                  <Pencil className="h-3 w-3 mr-1" /> Edit
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-destructive hover:text-destructive"
                                  onClick={() => setDeleteGateId(gate.id)}
                                  disabled={gateBusy}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-3 text-caption text-muted-foreground">
                              {gate.timeoutMs && (
                                <span className="flex items-center gap-1">
                                  <Clock className="h-2.5 w-2.5" />
                                  {gate.timeoutMs >= 60000 ? `${(gate.timeoutMs / 60000).toFixed(0)}min` : `${(gate.timeoutMs / 1000).toFixed(0)}s`}
                                  {gate.timeoutAction && (
                                    <span className="text-micro">
                                      {" "}then {gate.timeoutAction === "approve" ? (
                                        <span className="text-success">auto-approve</span>
                                      ) : (
                                        <span className="text-destructive">auto-reject</span>
                                      )}
                                    </span>
                                  )}
                                </span>
                              )}
                              {gate.maxRevisions && (
                                <span>Max {gate.maxRevisions} revision{gate.maxRevisions > 1 ? "s" : ""}</span>
                              )}
                              {gate.includeOutcomes && (
                                <span className="flex items-center gap-1">
                                  <Paperclip className="h-2.5 w-2.5" /> Include outcomes
                                </span>
                              )}
                              {gate.condition?.expression && (
                                <code className="text-micro font-mono bg-muted/30 rounded-xs px-1.5 py-0.5">{gate.condition.expression}</code>
                              )}
                            </div>
                            {gate.notifyChannels && gate.notifyChannels.length > 0 && (
                              <div className="flex items-center gap-1 mt-2">
                                <Bell className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
                                {gate.notifyChannels.map((ch) => (
                                  <Badge key={ch} variant="outline" className="text-micro">{ch}</Badge>
                                ))}
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  ) : (
                    <Empty text="No approval gates configured" />
                  )}
                </div>
              </div>
        )}

        {/* ═══ CLOUD SYNC (R2 / S3) ═══ */}
        {activeSection === "sync" && (
          <CloudSyncPanel />
        )}
      </div>

      {/* ── Notification rule dialog ── */}
      <RuleFormDialog
        open={ruleDialogOpen}
        onOpenChange={setRuleDialogOpen}
        initial={ruleDialogInitial}
        channels={channelNames}
        existingIds={rules.map((r) => r.id)}
        onSave={saveRule}
      />
      <ConfirmDialog
        open={!!deleteRuleId}
        onOpenChange={(o) => { if (!o) setDeleteRuleId(null); }}
        title="Delete notification rule"
        description={`Remove rule "${deleteRuleId ?? ""}" from polpo.json? This cannot be undone.`}
        confirmLabel="Delete"
        destructive
        loading={ruleBusy}
        onConfirm={() => deleteRuleId && removeRule(deleteRuleId)}
      />

      {/* ── Approval gate dialog ── */}
      <GateFormDialog
        open={gateDialogOpen}
        onOpenChange={setGateDialogOpen}
        initial={gateDialogInitial}
        channels={channelNames}
        existingIds={(gates ?? []).map((g) => g.id)}
        onSave={saveGate}
      />
      <ConfirmDialog
        open={!!deleteGateId}
        onOpenChange={(o) => { if (!o) setDeleteGateId(null); }}
        title="Delete approval gate"
        description={`Remove gate "${deleteGateId ?? ""}" from polpo.json? This cannot be undone.`}
        confirmLabel="Delete"
        destructive
        loading={gateBusy}
        onConfirm={() => deleteGateId && removeGate(deleteGateId)}
      />
    </div>
  );
}

// ── Cloud sync (R2 / S3) ──────────────────────────────────────────────
//
// Operator-level credentials + push/pull controls for the entire workDir.
// Backed by `<polpoDir>/sync-config.json` server-side, which shells out
// to `rclone copy --update` (non-destructive, only newer files).

type SyncR2 = {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  prefix?: string;
};
type SyncSchedule = { enabled: boolean; cron: string };
type SyncCfg = {
  r2?: SyncR2;
  lastPushedAt?: string;
  lastPulledAt?: string;
  schedule?: SyncSchedule;
  excludes?: string[];
  nextRunAt?: string | null;
  internalExcludes?: string[];
};

type ActiveSync = {
  id: string;
  direction: "push" | "pull";
  mode: "copy" | "sync";
  startedAt: string;
  bytes?: number;
  totalBytes?: number;
  transfers?: number;
  totalTransfers?: number;
  speed?: number;
  eta?: number;
  current?: string;
  recent: string[];
};

type SyncHistoryEntry = {
  id: string;
  direction: "push" | "pull";
  mode: "copy" | "sync";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  ok: boolean;
  files: number;
  bytes: number;
  error?: string;
};

type SyncProgress = {
  active: "push" | "pull" | null;
  mode: "copy" | "sync" | null;
  bytes?: number;
  totalBytes?: number;
  transfers?: number;
  totalTransfers?: number;
  speed?: number;
  eta?: number;
  current?: string;
  recent: string[]; // last few "Copied: ..." filenames
  done?: { ok: boolean; code: number };
  error?: string;
};

function CloudSyncPanel() {
  const [cfg, setCfg] = useState<SyncCfg | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<SyncProgress>({ active: null, mode: null, recent: [] });
  const [preview, setPreview] = useState<{
    kind: "push" | "pull";
    mode: "copy" | "sync";
    status: "running" | "ready";
    files: number;
    bytes: number;
    error?: string;
  } | null>(null);
  const [history, setHistory] = useState<SyncHistoryEntry[]>([]);
  const [showSecret, setShowSecret] = useState(false);
  const [draft, setDraft] = useState<SyncR2>({ endpoint: "", accessKeyId: "", secretAccessKey: "", bucket: "", prefix: "" });
  const [secretDirty, setSecretDirty] = useState(false);

  const fetchCfg = async () => {
    setLoading(true);
    try {
      const res = await apiFetch(apiUrl("/api/v1/sync/config"), { credentials: "include" });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error("config");
      setCfg(body.data as SyncCfg);
      const r2 = (body.data as SyncCfg).r2;
      setDraft({
        endpoint: r2?.endpoint ?? "",
        accessKeyId: r2?.accessKeyId ?? "",
        secretAccessKey: r2?.secretAccessKey ?? "",
        bucket: r2?.bucket ?? "",
        prefix: r2?.prefix ?? "",
      });
      setSecretDirty(false);
    } finally {
      setLoading(false);
    }
  };

  const fetchHistory = async () => {
    try {
      const res = await apiFetch(apiUrl("/api/v1/sync/history?limit=50"), { credentials: "include" });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok) setHistory(body.data as SyncHistoryEntry[]);
    } catch { /* ignore */ }
  };

  /** Re-attach to a sync that's still running on the server (e.g. user
   * navigated away mid-push). The polling stops automatically once the
   * server-side process completes (active comes back null). */
  const fetchActive = async () => {
    try {
      const res = await apiFetch(apiUrl("/api/v1/sync/active"), { credentials: "include" });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) return null;
      return body.data as ActiveSync | null;
    } catch { return null; }
  };

  useEffect(() => { void fetchCfg(); void fetchHistory(); }, []);

  // On mount + every 1.5s, ask the server whether a sync is in flight.
  // If so, surface it as a non-streaming progress block; once the server
  // reports `null` we refresh history (the run finished).
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = async () => {
      const active = await fetchActive();
      if (cancelled) return;
      if (active) {
        setProgress((p) => ({
          ...p,
          // Don't clobber a locally-streaming run — only adopt the snapshot
          // if we're not the one driving it.
          active: p.active ?? active.direction,
          mode: p.mode ?? active.mode,
          bytes: active.bytes ?? p.bytes,
          totalBytes: active.totalBytes ?? p.totalBytes,
          transfers: active.transfers ?? p.transfers,
          totalTransfers: active.totalTransfers ?? p.totalTransfers,
          speed: active.speed ?? p.speed,
          eta: active.eta ?? p.eta,
          current: active.current ?? p.current,
          recent: active.recent.length > p.recent.length ? active.recent : p.recent,
        }));
      } else {
        // Server says no active sync — clear if we were tracking one.
        setProgress((p) => (p.active ? { active: null, mode: null, recent: [], done: p.done } : p));
        void fetchHistory();
      }
    };
    void tick();
    timer = setInterval(() => void tick(), 1500);
    return () => { cancelled = true; if (timer) clearInterval(timer); };
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const res = await apiFetch(apiUrl("/api/v1/sync/config"), {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ r2: draft }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error || "save failed");
      toast.success("Sync config saved");
      notifySetupSaved();
      setCfg(body.data as SyncCfg);
      setSecretDirty(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const clearConfig = async () => {
    setSaving(true);
    try {
      const res = await apiFetch(apiUrl("/api/v1/sync/config"), {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ r2: null }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error || "clear failed");
      toast.success("Sync config cleared");
      setCfg(body.data as SyncCfg);
      setDraft({ endpoint: "", accessKeyId: "", secretAccessKey: "", bucket: "", prefix: "" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to clear");
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setSaving(true);
    try {
      const res = await apiFetch(apiUrl("/api/v1/sync/test"), { method: "POST", credentials: "include" });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error || "test failed");
      toast.success("R2 connection OK");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Connection test failed");
    } finally {
      setSaving(false);
    }
  };

  const cancelSync = async () => {
    try {
      const res = await apiFetch(apiUrl("/api/v1/sync/cancel"), { method: "POST", credentials: "include" });
      if (res.ok) toast.message("Cancelling…");
    } catch { /* ignore */ }
  };

  /** Run rclone once with the given args. `dryRun` makes rclone print
   * what it WOULD do without actually transferring/deleting. The promise
   * resolves to the parsed final stats (files, bytes) so the caller can
   * show a preview modal. */
  const runSync = async (kind: "push" | "pull", mode: "copy" | "sync", dryRun: boolean): Promise<{ ok: boolean; files: number; bytes: number; error?: string }> => {
    setProgress({ active: kind, mode, recent: [] });
    let summary = { files: 0, bytes: 0 };
    let result: { ok: boolean; error?: string } = { ok: false };
    try {
      const res = await apiFetch(apiUrl(`/api/v1/sync/${kind}`), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, dryRun }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const consume = (line: string) => {
        if (!line) return;
        try {
          const evt = JSON.parse(line);
          if (evt?.type === "done") {
            result = { ok: !!evt.ok, error: evt.error };
            if (evt.summary) summary = { files: evt.summary.files ?? 0, bytes: evt.summary.bytes ?? 0 };
          }
        } catch { /* non-JSON */ }
        handleSyncEvent(line, setProgress);
      };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          consume(line);
        }
      }
      if (buf.trim()) consume(buf.trim());
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : "failed" };
    }
    if (!dryRun) {
      await fetchCfg();
      await fetchHistory();
    } else {
      // Clear the live progress block once preview finishes — the modal
      // takes over from here.
      setProgress((p) => ({ ...p, active: null, mode: null, recent: [], done: undefined }));
    }
    return { ...result, ...summary };
  };

  /** Two-phase trigger: dry-run first, then real run on user confirm.
   * The preview modal shows the file/byte summary so the user knows
   * what's about to happen before any side effect. */
  const trigger = async (kind: "push" | "pull", mode: "copy" | "sync" = "copy") => {
    setPreview({ kind, mode, status: "running", files: 0, bytes: 0 });
    const r = await runSync(kind, mode, true);
    setPreview({ kind, mode, status: "ready", files: r.files, bytes: r.bytes, error: r.ok ? undefined : r.error });
  };

  const confirmAndRun = async () => {
    if (!preview) return;
    const { kind, mode } = preview;
    setPreview(null);
    const r = await runSync(kind, mode, false);
    if (r.ok) toast.success(`${kind === "push" ? "Pushed" : "Pulled"} ${r.files} file${r.files === 1 ? "" : "s"}`);
    else if (r.error) toast.error(r.error);
  };

  const configured = !!cfg?.r2;

  return (
    <div className="space-y-6 max-w-2xl">
      <section>
        <SectionHeader icon={CloudIcon} title="R2 / S3-compatible target" className="mb-1.5" />
        <p className="text-caption text-muted-foreground/80 mb-3">
          Sync the entire <code className="font-mono">workDir</code> to a Cloudflare R2 bucket via <code className="font-mono">rclone copy --update</code>.
          Non-destructive: only newer files are transferred, nothing on the destination is deleted.
        </p>

        {loading ? (
          <div className="flex items-center gap-2 text-small text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading config…
          </div>
        ) : (
          <div className="space-y-3">
            <SyncField label="Endpoint" placeholder="https://<account-id>.r2.cloudflarestorage.com" value={draft.endpoint}
              onChange={(v) => setDraft({ ...draft, endpoint: v })} mono />
            <SyncField label="Bucket" placeholder="my-bucket" value={draft.bucket}
              onChange={(v) => setDraft({ ...draft, bucket: v })} mono />
            <SyncField label="Prefix (optional)" placeholder="hosts/lumea" value={draft.prefix ?? ""}
              onChange={(v) => setDraft({ ...draft, prefix: v })} mono />
            <SyncField label="Access key ID" placeholder="AK..." value={draft.accessKeyId}
              onChange={(v) => setDraft({ ...draft, accessKeyId: v })} mono />
            <div>
              <label className="block text-caption text-muted-foreground mb-1">Secret access key</label>
              <div className="flex items-center gap-2">
                <input
                  type={showSecret ? "text" : "password"}
                  data-setup-field="secretAccessKey"
                  value={draft.secretAccessKey}
                  onChange={(e) => { setDraft({ ...draft, secretAccessKey: e.target.value }); setSecretDirty(true); }}
                  placeholder={configured && !secretDirty ? "(stored — click to replace)" : "raw secret"}
                  onFocus={() => { if (configured && !secretDirty) setDraft({ ...draft, secretAccessKey: "" }); }}
                  className="flex-1 h-9 rounded-md border border-border bg-card px-3 font-mono text-small focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <button
                  type="button"
                  onClick={() => setShowSecret((v) => !v)}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-card hover:bg-accent"
                  title={showSecret ? "Hide" : "Show"}
                >
                  {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button size="sm" onClick={save} disabled={saving}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Save
              </Button>
              <Button size="sm" variant="outline" onClick={test} disabled={saving || !configured}>
                Test connection
              </Button>
              {configured && (
                <Button size="sm" variant="ghost" onClick={clearConfig} disabled={saving}
                  className="text-destructive hover:text-destructive hover:bg-destructive/10">
                  Clear
                </Button>
              )}
            </div>
          </div>
        )}
      </section>

      <section>
        <SectionHeader icon={Activity} title="Sync now" className="mb-1.5" />
        <p className="text-caption text-muted-foreground/80 mb-3">
          One-shot sync of the current workDir against the configured remote. Requires <code className="font-mono">rclone</code> on the server.
          The default <strong>copy/update</strong> mode is non-destructive (newer files only). The <strong>replace</strong> mode mirrors source → destination and <em>deletes</em> extras — used for first hydration or to promote a clean snapshot.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void trigger("push", "copy")} disabled={!configured || progress.active != null}>
            {progress.active === "push" && progress.mode === "copy" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            Push (update)
          </Button>
          <Button size="sm" variant="outline" onClick={() => void trigger("pull", "copy")} disabled={!configured || progress.active != null}>
            {progress.active === "pull" && progress.mode === "copy" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            Pull (update)
          </Button>
          <div className="mx-1 h-5 w-px bg-border" />
          <Button size="sm" variant="ghost" onClick={() => void trigger("push", "sync")} disabled={!configured || progress.active != null || preview != null}
            className="text-destructive hover:text-destructive hover:bg-destructive/10">
            {progress.active === "push" && progress.mode === "sync" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            Replace remote
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void trigger("pull", "sync")} disabled={!configured || progress.active != null || preview != null}
            className="text-destructive hover:text-destructive hover:bg-destructive/10">
            {progress.active === "pull" && progress.mode === "sync" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            Replace local
          </Button>
        </div>

        {progress.active && (
          <div className="mt-4 rounded-md border border-border bg-card/40 p-3 space-y-2">
            <div className="flex items-center justify-between text-caption">
              <span className="font-medium">
                {progress.active === "push" ? "Pushing" : "Pulling"}
                {progress.mode === "sync" && <span className="ml-1 text-destructive">(replace)</span>}
              </span>
              <div className="flex items-center gap-2">
                <span className="font-mono tabular-nums text-muted-foreground">
                  {progress.transfers ?? 0} / {progress.totalTransfers ?? "?"} files
                </span>
                <button
                  type="button"
                  onClick={() => void cancelSync()}
                  className="inline-flex items-center gap-1 rounded-xs bg-destructive/15 px-2 py-0.5 text-caption font-medium text-destructive hover:bg-destructive/25"
                >
                  <X className="h-3 w-3" />
                  Cancel
                </button>
              </div>
            </div>
            <SyncProgressBar progress={progress} />
            <div className="grid grid-cols-3 gap-2 font-mono text-caption tabular-nums text-muted-foreground">
              <div>{formatBytes(progress.bytes)} / {formatBytes(progress.totalBytes)}</div>
              <div>{progress.speed != null ? `${formatBytes(progress.speed)}/s` : "—"}</div>
              <div className="text-right">ETA {formatEta(progress.eta)}</div>
            </div>
            {progress.current && (
              <div className="truncate font-mono text-caption text-foreground/80" title={progress.current}>
                ⮕ {progress.current}
              </div>
            )}
            {progress.recent.length > 0 && (
              <details className="mt-1">
                <summary className="cursor-pointer text-caption text-muted-foreground hover:text-foreground/80">Recent files ({progress.recent.length})</summary>
                <div className="mt-1 max-h-32 overflow-y-auto font-mono text-caption text-muted-foreground space-y-0.5">
                  {progress.recent.map((line, i) => <div key={i} className="truncate">{line}</div>)}
                </div>
              </details>
            )}
          </div>
        )}
        {progress.done && !progress.active && (
          <div className={cn("mt-4 rounded-md border p-3 text-caption",
            progress.done.ok ? "border-success/30 bg-success/10 text-success" : "border-destructive/30 bg-destructive/10 text-destructive")}>
            {progress.done.ok
              ? `Done — ${progress.transfers ?? 0} files transferred.`
              : (progress.error ?? `rclone exited with code ${progress.done.code}`)}
          </div>
        )}

        <div className="mt-3 grid grid-cols-2 gap-2 max-w-md text-caption text-muted-foreground">
          <div>Last push: <span className="font-mono text-foreground/80">{cfg?.lastPushedAt ? formatTime(cfg.lastPushedAt) : "—"}</span></div>
          <div>Last pull: <span className="font-mono text-foreground/80">{cfg?.lastPulledAt ? formatTime(cfg.lastPulledAt) : "—"}</span></div>
        </div>
      </section>

      <ExcludesSection cfg={cfg} reload={fetchCfg} />

      <ScheduleSection cfg={cfg} configured={configured} reload={fetchCfg} />

      <section>
        <div className="flex items-center justify-between mb-1.5">
          <SectionHeader icon={Activity} title="History" className="mb-0" />
          <button
            type="button"
            onClick={() => void fetchHistory()}
            className="text-caption text-muted-foreground hover:text-foreground/80"
          >
            Refresh
          </button>
        </div>
        <SyncHistoryTable entries={history} />
      </section>

      <SyncPreviewDialog
        preview={preview}
        onCancel={() => setPreview(null)}
        onConfirm={() => void confirmAndRun()}
      />
    </div>
  );
}

/** Exclude-pattern editor. Patterns use rclone's filter syntax:
 *
 *   node_modules/**   → any node_modules folder, recursively
 *   .git/**           → any .git
 *   *.log             → any .log file at any level
 *   /dist/**          → only the top-level dist (anchored)
 *
 * Saved as `excludes: string[]` on sync-config.json. Applied to manual
 * push/pull AND the scheduler. */
const COMMON_EXCLUDES = [
  "node_modules/**",
  ".git/**",
  ".next/**",
  "dist/**",
  "build/**",
  ".cache/**",
  "target/**",
  ".turbo/**",
  ".venv/**",
  "__pycache__/**",
  "*.log",
  ".DS_Store",
];

function ExcludesSection({ cfg, reload }: { cfg: SyncCfg | null; reload: () => Promise<void> }) {
  const product = productName(useInstanceBranding());
  const initial = (cfg?.excludes ?? []).join("\n");
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setText((cfg?.excludes ?? []).join("\n")); }, [cfg]);

  const patterns = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  const addPreset = (p: string) => {
    if (patterns.includes(p)) return;
    setText((prev) => (prev.trim() ? prev.trim() + "\n" + p : p));
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await apiFetch(apiUrl("/api/v1/sync/config"), {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ excludes: patterns }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error || "save failed");
      toast.success(`Excludes saved (${patterns.length})`);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const dirty = text.trim() !== (cfg?.excludes ?? []).join("\n").trim();

  return (
    <section>
      <SectionHeader icon={X} title="Excludes" className="mb-1.5" />
      <p className="text-caption text-muted-foreground/80 mb-3">
        rclone-style filter patterns — applied to every push and pull, and to the auto-sync scheduler. <code className="font-mono">node_modules/**</code> matches a <code className="font-mono">node_modules</code> folder at any depth. Lines starting with <code className="font-mono">#</code> are comments. Empty list means no filtering.
      </p>
      <div className="space-y-2 max-w-2xl">
        {cfg?.internalExcludes && cfg.internalExcludes.length > 0 && (
          <div className="rounded-md border border-border bg-card/40 p-2 text-caption">
            <div className="text-label text-muted-foreground/70 mb-1">
              Always excluded by {product}
            </div>
            <ul className="space-y-0.5 font-mono text-caption text-foreground/70">
              {cfg.internalExcludes.map((p) => <li key={p}>· {p}</li>)}
            </ul>
            <div className="mt-1 text-micro text-muted-foreground/60">
              These hold the R2 secret + the local sync log — sending them to R2 would defeat their purpose.
            </div>
          </div>
        )}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="node_modules/**&#10;.git/**&#10;*.log"
          rows={8}
          className="w-full rounded-md border border-border bg-card px-3 py-2 font-mono text-small focus:outline-none focus:ring-1 focus:ring-primary"
          spellCheck={false}
        />
        <div className="flex flex-wrap gap-1.5">
          {COMMON_EXCLUDES.map((p) => {
            const already = patterns.includes(p);
            return (
              <button
                key={p}
                type="button"
                disabled={already}
                onClick={() => addPreset(p)}
                className={cn(
                  "rounded-md px-2 py-0.5 font-mono text-caption border transition-colors",
                  already
                    ? "border-border bg-card/40 text-muted-foreground cursor-default"
                    : "border-border bg-card hover:bg-accent",
                )}
                title={already ? "Already in list" : `Add ${p}`}
              >
                + {p}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 pt-1">
          <Button size="sm" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save
          </Button>
          <span className="text-caption text-muted-foreground">
            {patterns.length} pattern{patterns.length === 1 ? "" : "s"} active
          </span>
        </div>
      </div>
    </section>
  );
}

/** Schedule editor — preset dropdown for the common cases plus a custom
 * cron field. Toggling `enabled` flips the server-side timer
 * immediately; the schedule itself rehydrates from sync-config.json on
 * server restart so cron jobs survive a polpo restart. */
const SCHEDULE_PRESETS: { label: string; cron: string }[] = [
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every 6 hours", cron: "0 */6 * * *" },
  { label: "Daily at 03:00", cron: "0 3 * * *" },
  { label: "Custom…", cron: "" },
];

function ScheduleSection({ cfg, configured, reload }: { cfg: SyncCfg | null; configured: boolean; reload: () => Promise<void> }) {
  const initialCron = cfg?.schedule?.cron ?? "*/15 * * * *";
  const initialEnabled = !!cfg?.schedule?.enabled;
  const matchingPreset = SCHEDULE_PRESETS.find((p) => p.cron === initialCron);
  const initialPreset = matchingPreset ? matchingPreset.cron : "";
  const [enabled, setEnabled] = useState(initialEnabled);
  const [preset, setPreset] = useState(initialPreset);
  const [cron, setCron] = useState(initialCron);
  const [saving, setSaving] = useState(false);

  // Re-hydrate from server when cfg changes (after save / mount).
  useEffect(() => {
    setEnabled(!!cfg?.schedule?.enabled);
    setCron(cfg?.schedule?.cron ?? "*/15 * * * *");
    const m = SCHEDULE_PRESETS.find((p) => p.cron === cfg?.schedule?.cron);
    setPreset(m ? m.cron : "");
  }, [cfg]);

  const onPresetChange = (v: string) => {
    setPreset(v);
    if (v) setCron(v);
  };

  const save = async (nextEnabled?: boolean) => {
    setSaving(true);
    try {
      const res = await apiFetch(apiUrl("/api/v1/sync/config"), {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schedule: { enabled: nextEnabled ?? enabled, cron },
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error || "save failed");
      toast.success(nextEnabled === undefined ? "Schedule saved" : nextEnabled ? "Auto-sync enabled" : "Auto-sync disabled");
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <SectionHeader icon={Activity} title="Auto-sync (push)" className="mb-1.5" />
      <p className="text-caption text-muted-foreground/80 mb-3">
        Schedule a recurring <strong>copy --update</strong> push from this host to R2. Replace mode is intentionally not exposed here — auto-runs are non-destructive only.
        Schedule survives server restarts.
      </p>
      <div className="space-y-3 max-w-xl">
        <div className="flex items-center gap-3">
          <Switch
            checked={enabled}
            aria-label="Auto-sync"
            disabled={!configured || saving}
            onCheckedChange={(next) => { setEnabled(next); void save(next); }}
          />
          <span className="text-small text-foreground/80">{enabled ? "Enabled" : "Disabled"}</span>
        </div>

        <div>
          <label className="block text-caption text-muted-foreground mb-1">Preset</label>
          <select
            value={preset}
            onChange={(e) => onPresetChange(e.target.value)}
            className="w-full h-9 rounded-md border border-border bg-card px-3 text-small focus:outline-none focus:ring-1 focus:ring-primary"
          >
            {SCHEDULE_PRESETS.map((p) => (
              <option key={p.label} value={p.cron}>{p.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-caption text-muted-foreground mb-1">
            Cron expression
            <span className="ml-2 text-micro text-muted-foreground/70">(5 fields: minute hour dom month dow)</span>
          </label>
          <input
            type="text"
            value={cron}
            onChange={(e) => { setCron(e.target.value); setPreset(""); }}
            className="w-full h-9 rounded-md border border-border bg-card px-3 font-mono text-small focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="*/15 * * * *"
          />
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void save()} disabled={!configured || saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save
          </Button>
          <span className="text-caption text-muted-foreground">
            Next run: <span className="font-mono text-foreground/80">{cfg?.nextRunAt ? formatTime(cfg.nextRunAt) : "—"}</span>
          </span>
        </div>
        {!configured && (
          <p className="text-caption text-warning/80">
            Configure R2 above before enabling the schedule.
          </p>
        )}
      </div>
    </section>
  );
}

function SyncHistoryTable({ entries }: { entries: SyncHistoryEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="rounded-md border border-border bg-card/40 px-3 py-4 text-center text-caption text-muted-foreground">
        No syncs yet — push or pull to start the history.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-caption">
        <thead className="bg-card/60 text-label text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 text-left font-medium">When</th>
            <th className="px-2 py-1.5 text-left font-medium">Type</th>
            <th className="px-2 py-1.5 text-right font-medium">Files</th>
            <th className="px-2 py-1.5 text-right font-medium">Size</th>
            <th className="px-2 py-1.5 text-right font-medium">Duration</th>
            <th className="px-2 py-1.5 text-left font-medium">Result</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {entries.map((e) => (
            <tr key={e.id} className="hover:bg-card/40">
              <td className="px-2 py-1.5 font-mono text-foreground/80">{formatTime(e.startedAt)}</td>
              <td className="px-2 py-1.5">
                <SyncTypeBadge direction={e.direction} mode={e.mode} />
              </td>
              <td className="px-2 py-1.5 text-right font-mono tabular-nums">{e.files}</td>
              <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatBytes(e.bytes)}</td>
              <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatDuration(e.durationMs)}</td>
              <td className="px-2 py-1.5">
                {e.ok ? (
                  <span className="inline-flex items-center gap-1 rounded-xs bg-success/15 px-1.5 py-px text-micro font-medium text-success">ok</span>
                ) : (
                  <span title={e.error} className="inline-flex items-center gap-1 rounded-xs bg-destructive/15 px-1.5 py-px text-micro font-medium text-destructive">
                    failed
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SyncTypeBadge({ direction, mode }: { direction: "push" | "pull"; mode: "copy" | "sync" }) {
  const isPush = direction === "push";
  const replace = mode === "sync";
  const arrow = isPush ? "↑" : "↓";
  const label = `${arrow} ${isPush ? "push" : "pull"}${replace ? " · replace" : ""}`;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-xs px-1.5 py-px font-mono text-micro",
        replace
          ? "bg-destructive/10 text-destructive/90"
          : isPush
            ? "bg-info/10 text-info/90"
            : "bg-success/10 text-success/90",
      )}
    >
      {label}
    </span>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m}m ${s}s` : `${m}m`;
}

/** Preview dialog — runs `rclone --dry-run` first, shows the user what
 * would change, then asks for confirmation before doing the real run. */
function SyncPreviewDialog({
  preview,
  onCancel,
  onConfirm,
}: {
  preview: { kind: "push" | "pull"; mode: "copy" | "sync"; status: "running" | "ready"; files: number; bytes: number; error?: string } | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const open = !!preview;
  const isReplace = preview?.mode === "sync";
  const dirLabel = preview?.kind === "push" ? "local → remote" : "remote → local";
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => { if (!o) onCancel(); }}
      title={preview?.status === "running"
        ? "Computing changes…"
        : `Confirm ${preview?.kind} (${preview?.mode === "sync" ? "replace" : "update"})`}
      description={
        preview?.status === "running" ? (
          <span className="flex items-center gap-2 text-small">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Running rclone in dry-run mode against {dirLabel}…
          </span>
        ) : preview?.error ? (
          <span className="text-destructive">{preview.error}</span>
        ) : (
          <div className="space-y-2 text-small">
            <div>
              About to <strong>{preview?.kind === "push" ? "push" : "pull"}</strong> ({dirLabel})
              in <strong>{isReplace ? "replace" : "update"}</strong> mode.
            </div>
            <div className="rounded-md border border-border bg-card/40 p-2 font-mono text-caption">
              <div><strong>{preview?.files ?? 0}</strong> file{preview?.files === 1 ? "" : "s"} to transfer</div>
              <div><strong>{formatBytes(preview?.bytes)}</strong> total size</div>
            </div>
            {isReplace && (
              <div className="text-destructive/90 text-caption">
                ⚠ Replace mode also DELETES files on the destination that aren't on the source.
                The dry-run preview shows transfers but the count of deletes isn't summarized — proceed with care.
              </div>
            )}
            {preview?.files === 0 && !preview?.error && (
              <div className="text-success/85 text-caption">
                Nothing to do — source and destination already match.
              </div>
            )}
          </div>
        )
      }
      confirmLabel={preview?.status === "running" ? "…" : "Run for real"}
      destructive={isReplace}
      loading={preview?.status === "running"}
      onConfirm={() => { if (preview?.status === "ready" && !preview?.error) onConfirm(); }}
    />
  );
}

function SyncProgressBar({ progress }: { progress: SyncProgress }) {
  const pct = progress.totalBytes && progress.totalBytes > 0
    ? Math.min(100, Math.round((progress.bytes ?? 0) / progress.totalBytes * 100))
    : null;
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-pill bg-muted">
      {pct != null ? (
        <div
          className="h-full rounded-pill bg-success/80 transition-[width]"
          style={{ width: `${pct}%` }}
        />
      ) : (
        <div className="absolute inset-y-0 left-0 h-full w-1/3 animate-pulse rounded-pill bg-success/40" />
      )}
    </div>
  );
}

/** Parse one NDJSON line emitted by the /sync streaming endpoints and
 * fold it into the panel's progress state. */
/** rclone --use-json-log stats payload (fields are checked before use). */
interface SyncStatsPayload {
  bytes?: unknown;
  totalBytes?: unknown;
  transfers?: unknown;
  totalTransfers?: unknown;
  speed?: unknown;
  eta?: unknown;
  transferring?: unknown;
}

/** One NDJSON line from the /sync streaming endpoints. */
interface SyncStreamEvent extends SyncStatsPayload {
  type?: string;
  ok?: unknown;
  code?: number;
  error?: string;
  source?: string;
  stats?: SyncStatsPayload;
  object?: unknown;
  msg?: string;
}

function handleSyncEvent(line: string, setProgress: React.Dispatch<React.SetStateAction<SyncProgress>>) {
  let evt: SyncStreamEvent | null;
  try { evt = JSON.parse(line); } catch { return; }
  if (evt?.type === "done") {
    setProgress((p) => ({ ...p, done: { ok: !!evt.ok, code: evt.code ?? -1 }, error: evt.error || p.error, active: null }));
    return;
  }
  if (evt?.type !== "log") return;
  // Stats payload — shape from rclone --use-json-log
  if (evt.source === "accounting/stats" || evt.stats) {
    const s: SyncStatsPayload = evt.stats ?? evt;
    const tx = Array.isArray(s.transferring) ? (s.transferring[0] as { name?: string } | undefined) : null;
    setProgress((p) => ({
      ...p,
      bytes: typeof s.bytes === "number" ? s.bytes : p.bytes,
      totalBytes: typeof s.totalBytes === "number" ? s.totalBytes : p.totalBytes,
      transfers: typeof s.transfers === "number" ? s.transfers : p.transfers,
      totalTransfers: typeof s.totalTransfers === "number" ? s.totalTransfers : p.totalTransfers,
      speed: typeof s.speed === "number" ? s.speed : p.speed,
      eta: typeof s.eta === "number" ? s.eta : p.eta,
      current: tx?.name ?? p.current,
    }));
    return;
  }
  // Per-file events: msg ~ "Copied (new)" or similar; object = filename
  if (typeof evt.object === "string" && /Copied|Updated|Deleted/i.test(evt.msg ?? "")) {
    setProgress((p) => ({
      ...p,
      recent: [`${evt.msg}: ${evt.object}`, ...p.recent].slice(0, 8),
    }));
  }
}

function formatBytes(n?: number): string {
  if (n == null) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function formatEta(s?: number): string {
  if (s == null || !Number.isFinite(s) || s < 0) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  if (m < 60) return `${m}m${r ? ` ${r}s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function SyncField({
  label, value, onChange, placeholder, mono,
}: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean;
}) {
  return (
    <div>
      <label className="block text-caption text-muted-foreground mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          "w-full h-9 rounded-md border border-border bg-card px-3 text-small focus:outline-none focus:ring-1 focus:ring-primary",
          mono && "font-mono",
        )}
      />
    </div>
  );
}

function formatTime(iso: string): string {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
