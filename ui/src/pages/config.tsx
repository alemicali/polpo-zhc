import { useEffect, useState, useCallback, type CSSProperties } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  Wrench,
  Send,
  Hash,
  Eye,
  Zap,
  Monitor,
  Mail,
  ToggleRight,
  MessageSquare,
  Link2,
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
  Palette as PaletteIcon,
  Pencil,
  X,
  Plus,
  Trash2,
  Cloud as CloudIcon,
  Upload,
  Download,
  EyeOff,
  type LucideIcon,
} from "lucide-react";
import { useConfig } from "@/hooks/use-polpo";
import { ChannelLogo } from "@/components/shared/channel-logo";
import { ProviderIcon } from "@/components/shared/provider-icon";
import { useAgents, useAuthStatus, useOrchestratorSkills } from "@polpo-ai/react";
import type { CustomModelDef, ProviderConfig, AuthProfileMeta, ProviderAuthInfo, SkillInfo, PolpoSettings, AuthStatusResponse, ReasoningLevel, NotificationChannelType, NotificationChannelConfig } from "@polpo-ai/react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { JsonBlock } from "@/components/json-block";
import { config as appConfig, apiUrl } from "@/lib/config";
import {
  disablePushNotifications,
  enablePushNotifications,
  getCurrentPushState,
  getPushSupportState,
  type PushSubscriptionState,
} from "@/lib/push-notifications";
import { AuthStep, OAuthFlow, ApiKeyStep } from "@/components/shared/provider-auth";
import type { Provider as AuthProvider, OAuthProvider } from "@/components/shared/provider-auth";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { ModelPicker } from "@/components/shared/model-picker";
import { RuleFormDialog, type NotificationRuleDraft } from "@/components/config/rule-form-dialog";
import { GateFormDialog, type ApprovalGateDraft, type LifecycleHook as GateLifecycleHook } from "@/components/config/gate-form-dialog";
import { useAppearance } from "@/lib/appearance";
import { PALETTES, usePalette } from "@/lib/palette";
import { toast } from "sonner";

// ── API helper (same pattern as setup.tsx) ──

const api = async (path: string, init?: RequestInit) => {
  try {
    const headers: Record<string, string> = { ...init?.headers as Record<string, string> };
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

const baseSections = [
  { id: "general", label: "General", icon: Hash },
  { id: "members", label: "Members", icon: Users },
  { id: "agent", label: "Agent", icon: Bot },
  { id: "providers", label: "Providers", icon: Key },
  { id: "channels", label: "Channels", icon: Send },
  { id: "rules", label: "Rules", icon: Bell },
  { id: "policies", label: "Policies", icon: Shield },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "sync", label: "Cloud sync", icon: CloudIcon },
] as const;

type SectionIdBase = (typeof baseSections)[number]["id"];

type SectionId = SectionIdBase;

// ── Reusable display components ──

/** Key-value row — label left, value right, dotted filler in between */
function Row({ label, value, mono }: { label: React.ReactNode; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 py-1.5 min-w-0">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span className="flex-1 border-b border-dotted border-border/30 min-w-4 self-end mb-[3px]" />
      <span className={cn("text-xs text-foreground shrink-0 text-right max-w-[60%] truncate", mono && "font-mono text-[11px]")}>{value}</span>
    </div>
  );
}

/** Inline pill for enabled/disabled capabilities */
function CapPill({ label, on }: { label: string; on: boolean }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium border",
      on
        ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
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
      <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", ok ? "bg-emerald-500" : "bg-zinc-500")} />
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
          isAuthenticated ? "border-emerald-500/30" : "border-border",
        )}>
          <ProviderIcon name={name} size={20} />
          {/* Auth-state pip overlapping the brand icon */}
          <span
            className={cn(
              "absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full flex items-center justify-center ring-2 ring-background",
              isLocal ? "bg-emerald-500" : isAuthenticated ? "bg-emerald-500" : "bg-zinc-500",
            )}
          >
            {isLocal ? <Server className="h-2 w-2 text-white" /> :
             isAuthenticated ? <Lock className="h-2 w-2 text-white" /> :
                      <Unlock className="h-2 w-2 text-white" />}
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{providerLabel(name)}</span>
            <code className="text-[10px] font-mono text-muted-foreground">{name}</code>
          </div>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <StatusDot ok={isAuthenticated} label={statusLabel} />
            {prov.api && (
              <Badge variant="outline" className="text-[9px] font-mono h-4">{apiModeLabel(prov.api)}</Badge>
            )}
            {authInfo?.oauthAvailable && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Badge variant="outline" className="text-[9px] h-4 gap-0.5">
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
            className="text-[11px] text-muted-foreground hover:text-destructive hover:bg-destructive/10 h-7 px-2 shrink-0"
          >
            {disconnecting ? <Loader2 className="h-3 w-3 animate-spin" /> : "Disconnect"}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onConnect?.(name)}
            className="text-[11px] h-7 px-2.5 shrink-0"
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
              active: "bg-emerald-500", cooldown: "bg-amber-500",
              billing_disabled: "bg-red-500", expired: "bg-zinc-500",
            };
            return (
              <div key={profile.id} className="flex items-center gap-2 text-[11px] min-w-0">
                <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", dotColor[profile.status] ?? "bg-zinc-500")} />
                <span className="truncate text-muted-foreground">{profile.email ?? profile.id}</span>
                <Badge variant={profile.type === "oauth" ? "secondary" : "outline"} className="text-[9px] h-4 shrink-0">{profile.type}</Badge>
                {profile.status !== "active" && (
                  <span className="text-[10px] text-muted-foreground/60 shrink-0">{profile.status.replace("_", " ")}</span>
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
          <code className="text-[11px] font-mono text-muted-foreground truncate">{prov.baseUrl}</code>
        </div>
      )}

      {/* Custom Models */}
      {prov.models && prov.models.length > 0 && (
        <div className="space-y-2">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            Custom Models
          </span>
          {prov.models.map((m: CustomModelDef) => (
            <div key={m.id} className="rounded-md bg-muted/15 border border-border/20 px-3 py-2">
              <div className="flex items-center gap-2 flex-wrap">
                <code className="text-[11px] font-mono font-medium">{m.name}</code>
                {m.reasoning && (
                  <Tooltip>
                    <TooltipTrigger>
                      <Badge variant="secondary" className="text-[9px] h-4 gap-0.5"><Brain className="h-2.5 w-2.5" /> Reasoning</Badge>
                    </TooltipTrigger>
                    <TooltipContent className="text-xs">Supports extended thinking</TooltipContent>
                  </Tooltip>
                )}
                {m.contextWindow && (
                  <Badge variant="outline" className="text-[9px] h-4">{formatCtx(m.contextWindow)} ctx</Badge>
                )}
                {m.maxTokens && (
                  <Badge variant="outline" className="text-[9px] h-4">{formatCtx(m.maxTokens)} out</Badge>
                )}
                {m.input && m.input.includes("image") && (
                  <Badge variant="outline" className="text-[9px] h-4">Vision</Badge>
                )}
              </div>
              <div className="flex items-center gap-3 mt-1">
                <code className="text-[10px] font-mono text-muted-foreground">{m.id}</code>
                {m.cost && (
                  <span className="text-[10px] text-muted-foreground">{formatCost(m.cost)}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Agent usage */}
      {agentModels.length > 0 && (
        <div className="pt-2 border-t border-border/20">
          <span className="text-[10px] text-muted-foreground">
            Used by {agentModels.length} agent{agentModels.length > 1 ? "s" : ""}
          </span>
        </div>
      )}

      {/* Hint to login */}
      {!isAuthenticated && authInfo?.oauthAvailable && (
        <p className="text-[10px] text-muted-foreground/60 italic">
          Run <code className="font-mono text-primary">polpo auth login {name}</code>
        </p>
      )}
    </div>
  );
}

// ── Channel helpers ──

const CHANNEL_META: Record<string, { label: string; icon: LucideIcon; color: string; hue: string; description: string }> = {
  telegram: { label: "Telegram", icon: Send,            color: "border-l-sky-500",     hue: "sky",     description: "Send notifications to a Telegram chat via bot" },
  slack:    { label: "Slack",    icon: MessageSquare,   color: "border-l-green-500",   hue: "green",   description: "Post to a Slack channel via webhook" },
  whatsapp: { label: "WhatsApp", icon: MessageSquare,   color: "border-l-emerald-500", hue: "emerald", description: "Send notifications to a WhatsApp chat (unofficial)" },
  email:    { label: "Email",    icon: Mail,            color: "border-l-amber-500",   hue: "amber",   description: "Send email via Resend, SendGrid, or SMTP" },
  webhook:  { label: "Webhook",  icon: Link2,           color: "border-l-violet-500",  hue: "violet",  description: "POST JSON to any HTTP endpoint" },
  push:     { label: "Push",     icon: Monitor,         color: "border-l-fuchsia-500", hue: "fuchsia", description: "Send PWA push notifications to subscribed browsers" },
};

const ALL_CHANNEL_TYPES: NotificationChannelType[] = ["telegram", "whatsapp", "slack", "email", "webhook", "push"];

const HUE_STYLES: Record<string, { iconBg: string; iconRing: string; gradient: string; pip: string }> = {
  sky: { iconBg: "bg-sky-500/12", iconRing: "ring-sky-500/30", gradient: "from-sky-500/15", pip: "bg-sky-500" },
  green: { iconBg: "bg-green-500/12", iconRing: "ring-green-500/30", gradient: "from-green-500/15", pip: "bg-green-500" },
  amber: { iconBg: "bg-amber-500/12", iconRing: "ring-amber-500/30", gradient: "from-amber-500/15", pip: "bg-amber-500" },
  violet: { iconBg: "bg-violet-500/12", iconRing: "ring-violet-500/30", gradient: "from-violet-500/15", pip: "bg-violet-500" },
  fuchsia: { iconBg: "bg-fuchsia-500/12", iconRing: "ring-fuchsia-500/30", gradient: "from-fuchsia-500/15", pip: "bg-fuchsia-500" },
  emerald: { iconBg: "bg-emerald-500/12", iconRing: "ring-emerald-500/30", gradient: "from-emerald-500/15", pip: "bg-emerald-500" },
  zinc: { iconBg: "bg-zinc-500/12", iconRing: "ring-zinc-500/30", gradient: "from-zinc-500/15", pip: "bg-zinc-500" },
};

/** Default empty config per channel type */
function defaultChannelConfig(type: NotificationChannelType): NotificationChannelConfig {
  switch (type) {
    case "telegram": return { type, botToken: "", chatId: "", gateway: { enableInbound: false, dmPolicy: "pairing" } };
    case "whatsapp": return { type, chatId: "", profileDir: "default", gateway: { enableInbound: false, dmPolicy: "pairing" } };
    case "slack":    return { type, webhookUrl: "" };
    case "email":    return { type, provider: "resend", apiKey: "", from: "", to: [] };
    case "webhook":  return { type, url: "" };
    case "push":     return { type, vapidSubject: "mailto:hello@polpo.ai", ttl: 3600, urgency: "normal" };
    default:         return { type };
  }
}

/** Form field — label + input */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-foreground">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-muted-foreground leading-tight">{hint}</p>}
    </div>
  );
}

type GatewayConfig = NonNullable<NotificationChannelConfig["gateway"]>;
type GatewayPolicy = NonNullable<GatewayConfig["dmPolicy"]>;
type WhatsAppLoginStatus = "starting" | "qr" | "connected" | "error" | "expired" | "cancelled";

interface WhatsAppProfileInfo {
  profileDir: string;
  authenticated: boolean;
  status: string;
  path: string;
}

interface WhatsAppLoginSessionInfo {
  id: string;
  profileDir: string;
  status: WhatsAppLoginStatus;
  qr?: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
  expiresAt: string;
}

function channelSupportsInbound(type: NotificationChannelType): boolean {
  return type === "telegram" || type === "whatsapp";
}

function splitList(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function ChannelConceptPanel({ type }: { type: NotificationChannelType }) {
  const meta = CHANNEL_META[type];
  const inbound = channelSupportsInbound(type);

  return (
    <div className="rounded-lg border border-border/40 bg-muted/15 px-3 py-2.5 space-y-2">
      <div className="flex items-start gap-2">
        <Bell className="mt-0.5 h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <div className="min-w-0">
          <p className="text-xs font-medium">Notification delivery</p>
          <p className="text-[10.5px] leading-relaxed text-muted-foreground">
            Outbound path: Polpo sends alerts, task updates, approvals, or rule events through this {meta?.label ?? type} channel.
          </p>
        </div>
      </div>
      <div className="flex items-start gap-2">
        <MessageSquare className="mt-0.5 h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <div className="min-w-0">
          <p className="text-xs font-medium">Inbound gateway</p>
          <p className="text-[10.5px] leading-relaxed text-muted-foreground">
            {inbound
              ? "Inbound path: people can message Polpo from this channel and the gateway routes the text into a Polpo session."
              : "This channel is delivery-only here. It can receive notifications, but it does not expose a chat gateway."}
          </p>
        </div>
      </div>
    </div>
  );
}

function ChannelSetupGuide({ type }: { type: NotificationChannelType }) {
  if (type === "telegram") {
    return (
      <div className="rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2.5">
        <p className="text-xs font-medium">Telegram setup</p>
        <div className="mt-1 grid gap-1 text-[10.5px] leading-relaxed text-muted-foreground">
          <span>1. Create a bot with @BotFather and paste the bot token.</span>
          <span>2. Add the bot to the target chat or group and set the chat ID.</span>
          <span>3. Enable inbound only if users should talk to Polpo from Telegram.</span>
        </div>
      </div>
    );
  }

  if (type === "whatsapp") {
    return (
      <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5">
        <p className="text-xs font-medium">WhatsApp setup</p>
        <div className="mt-1 grid gap-1 text-[10.5px] leading-relaxed text-muted-foreground">
          <span>1. Pair this server as a linked device with the Connect WhatsApp button below.</span>
          <span>2. Use the same profile directory here, then set the destination phone/chat ID.</span>
          <span>3. Enable inbound only for a dedicated or trusted number. This uses WhatsApp Web connectivity.</span>
        </div>
      </div>
    );
  }

  return null;
}

function WhatsAppProfileSetup({ config, onChange }: {
  config: NotificationChannelConfig;
  onChange: (patch: Partial<NotificationChannelConfig>) => void;
}) {
  const profileDir = config.profileDir || "default";
  const [profiles, setProfiles] = useState<WhatsAppProfileInfo[]>([]);
  const [session, setSession] = useState<WhatsAppLoginSessionInfo | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeProfile = profiles.find((p) => p.profileDir === profileDir);
  const authenticated = !!activeProfile?.authenticated || session?.status === "connected";

  const loadProfiles = useCallback(async () => {
    try {
      const res = await fetch(`${appConfig.baseUrl}/api/v1/whatsapp/profiles`, { credentials: "include" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "Could not load WhatsApp profiles");
      setProfiles(data.data?.profiles ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load WhatsApp profiles");
    }
  }, []);

  useEffect(() => {
    if (config.type !== "whatsapp") return;
    void loadProfiles();
  }, [config.type, loadProfiles]);

  useEffect(() => {
    let cancelled = false;
    if (!session?.qr) {
      setQrDataUrl(null);
      return;
    }
    import("qrcode")
      .then((QRCode) => QRCode.toDataURL(session.qr!, { margin: 1, width: 260 }))
      .then((url) => { if (!cancelled) setQrDataUrl(url); })
      .catch(() => { if (!cancelled) setQrDataUrl(null); });
    return () => { cancelled = true; };
  }, [session?.qr]);

  useEffect(() => {
    if (!session || !["starting", "qr"].includes(session.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const res = await fetch(`${appConfig.baseUrl}/api/v1/whatsapp/login/${session.id}`, { credentials: "include" });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error ?? "Could not read WhatsApp login status");
        const next = data.data?.session as WhatsAppLoginSessionInfo;
        setSession(next);
        if (["connected", "error", "expired", "cancelled"].includes(next.status)) {
          window.clearInterval(timer);
          void loadProfiles();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not read WhatsApp login status");
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [session, loadProfiles]);

  const startLogin = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${appConfig.baseUrl}/api/v1/whatsapp/login/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ profileDir }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "Could not start WhatsApp login");
      setSession(data.data?.session ?? null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not start WhatsApp login";
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  const cancelLogin = async () => {
    if (!session || !["starting", "qr"].includes(session.status)) return;
    try {
      await fetch(`${appConfig.baseUrl}/api/v1/whatsapp/login/${session.id}/cancel`, {
        method: "POST",
        credentials: "include",
      });
    } finally {
      setSession(null);
      setQrDataUrl(null);
      void loadProfiles();
    }
  };

  const logout = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${appConfig.baseUrl}/api/v1/whatsapp/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ profileDir }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "Could not remove WhatsApp profile");
      setSession(null);
      setQrDataUrl(null);
      setProfiles(data.data?.profiles ?? []);
      toast.success(`WhatsApp profile "${profileDir}" removed`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not remove WhatsApp profile";
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-border/40 bg-background/50 px-3 py-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <LogIn className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold">WhatsApp profile</span>
            <Badge variant={authenticated ? "secondary" : "outline"} className={cn("h-4 text-[9px] px-1.5", authenticated && "text-emerald-600")}>
              {authenticated ? "Connected" : session?.status === "qr" ? "Scan QR" : "Not linked"}
            </Badge>
          </div>
          <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
            Pair this server as a WhatsApp linked device. The profile powers tool access; notifications and inbound stay optional.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 text-[11px] gap-1.5" onClick={() => void loadProfiles()}>
          <RefreshCw className="h-3 w-3" /> Refresh
        </Button>
      </div>

      <Field label="Profile Directory" hint="Stored under .polpo/whatsapp-profiles/<profileDir>.">
        <Input
          className="h-8 text-xs font-mono"
          placeholder="default"
          value={profileDir}
          onChange={(e) => onChange({ profileDir: e.target.value || "default" })}
        />
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          className="h-8 text-xs gap-1.5"
          onClick={startLogin}
          disabled={busy || ["starting", "qr"].includes(session?.status ?? "")}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <LogIn className="h-3 w-3" />}
          {authenticated ? "Reconnect" : "Connect WhatsApp"}
        </Button>
        {session && ["starting", "qr"].includes(session.status) && (
          <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={cancelLogin}>
            Cancel
          </Button>
        )}
        {authenticated && (
          <Button type="button" variant="ghost" size="sm" className="h-8 text-xs text-destructive hover:text-destructive" onClick={logout} disabled={busy}>
            <Trash2 className="h-3 w-3" /> Logout
          </Button>
        )}
      </div>

      {session?.status === "starting" && (
        <div className="rounded-md border border-border/30 bg-muted/15 px-2.5 py-2 text-[10.5px] text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for WhatsApp QR code...
        </div>
      )}

      {session?.status === "qr" && (
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 space-y-2">
          <p className="text-xs font-medium">Scan with WhatsApp</p>
          <p className="text-[10.5px] leading-relaxed text-muted-foreground">
            Open WhatsApp, go to Linked Devices, then scan this QR code.
          </p>
          {qrDataUrl ? (
            <img src={qrDataUrl} alt="WhatsApp login QR code" className="h-[260px] w-[260px] rounded-md border border-border/40 bg-white p-2" />
          ) : (
            <div className="flex h-[260px] w-[260px] items-center justify-center rounded-md border border-border/40 bg-muted/20">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>
      )}

      {session && ["connected", "error", "expired", "cancelled"].includes(session.status) && (
        <div className={cn(
          "rounded-md border px-2.5 py-2 text-[10.5px] leading-relaxed",
          session.status === "connected"
            ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-600"
            : "border-destructive/25 bg-destructive/10 text-destructive",
        )}>
          {session.status === "connected"
            ? "WhatsApp linked. The server will reconnect the bridge when this profile is configured."
            : session.error ?? `WhatsApp login ${session.status}.`}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/25 bg-destructive/10 px-2.5 py-2 text-[10.5px] leading-relaxed text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}

function DeliveryFields({ config, onChange }: {
  config: NotificationChannelConfig;
  onChange: (patch: Partial<NotificationChannelConfig>) => void;
}) {
  const set = onChange;

  return (
    <div className="rounded-lg border border-border/40 bg-background/50 px-3 py-3 space-y-3">
      <div className="flex items-center gap-2">
        <Bell className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold">Notification delivery</span>
      </div>

      {config.type === "telegram" && (
        <>
          <Field label="Bot Token" hint="From @BotFather on Telegram">
            <Input className="h-8 text-xs font-mono" placeholder="123456:ABC-DEF..." value={config.botToken ?? ""} onChange={(e) => set({ botToken: e.target.value })} />
          </Field>
          <Field label="Chat ID" hint="Numeric chat or group ID used for outbound notifications">
            <Input className="h-8 text-xs font-mono" placeholder="-1001234567890" value={config.chatId ?? ""} onChange={(e) => set({ chatId: e.target.value })} />
          </Field>
        </>
      )}

      {config.type === "whatsapp" && (
        <>
          <WhatsAppProfileSetup config={config} onChange={set} />
          <Field label="Notification Chat ID" hint="Optional. Only needed if notification rules should send outbound WhatsApp alerts. Leave empty for tool-only access.">
            <Input className="h-8 text-xs font-mono" placeholder="Optional: +393331234567 or 393331234567@s.whatsapp.net" value={config.chatId ?? ""} onChange={(e) => set({ chatId: e.target.value })} />
          </Field>
        </>
      )}

      {config.type === "slack" && (
        <>
          <Field label="Webhook URL" hint="Slack Incoming Webhook URL">
            <Input className="h-8 text-xs font-mono" placeholder="https://hooks.slack.com/services/..." value={config.webhookUrl ?? ""} onChange={(e) => set({ webhookUrl: e.target.value })} />
          </Field>
          <Field label="API Key" hint="Optional - enables file uploads">
            <Input className="h-8 text-xs font-mono" placeholder="xoxb-..." value={config.apiKey ?? ""} onChange={(e) => set({ apiKey: e.target.value || undefined })} />
          </Field>
        </>
      )}

      {config.type === "email" && (
        <>
          <Field label="Provider">
            <Select value={config.provider ?? "resend"} onValueChange={(v) => set({ provider: v })}>
              <SelectTrigger className="h-8 text-xs w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="resend" className="text-xs">Resend</SelectItem>
                <SelectItem value="sendgrid" className="text-xs">SendGrid</SelectItem>
                <SelectItem value="smtp" className="text-xs">SMTP</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {config.provider !== "smtp" && (
            <Field label="API Key">
              <Input className="h-8 text-xs font-mono" placeholder="re_..." value={config.apiKey ?? ""} onChange={(e) => set({ apiKey: e.target.value })} />
            </Field>
          )}
          {config.provider === "smtp" && (
            <>
              <Field label="SMTP Host">
                <Input className="h-8 text-xs font-mono" placeholder="smtp.example.com" value={config.host ?? ""} onChange={(e) => set({ host: e.target.value })} />
              </Field>
              <Field label="SMTP Port">
                <Input className="h-8 text-xs font-mono" type="number" placeholder="587" value={config.port ?? ""} onChange={(e) => set({ port: e.target.value ? Number(e.target.value) : undefined })} />
              </Field>
            </>
          )}
          <Field label="From Address">
            <Input className="h-8 text-xs font-mono" placeholder="noreply@example.com" value={config.from ?? ""} onChange={(e) => set({ from: e.target.value })} />
          </Field>
          <Field label="Recipients" hint="Comma-separated email addresses">
            <Input className="h-8 text-xs font-mono" placeholder="alice@example.com, bob@example.com"
              value={(config.to ?? []).join(", ")}
              onChange={(e) => set({ to: splitList(e.target.value) })}
            />
          </Field>
        </>
      )}

      {config.type === "webhook" && (
        <>
          <Field label="URL" hint="JSON POST endpoint">
            <Input className="h-8 text-xs font-mono" placeholder="https://example.com/webhook" value={config.url ?? ""} onChange={(e) => set({ url: e.target.value })} />
          </Field>
          <Field label="Headers" hint="key:value pairs, one per line">
            <textarea
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs font-mono min-h-[56px] resize-y focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder={"Authorization: Bearer xxx\nX-Custom: value"}
              value={Object.entries(config.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n")}
              onChange={(e) => {
                const headers: Record<string, string> = {};
                for (const line of e.target.value.split("\n")) {
                  const idx = line.indexOf(":");
                  if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
                }
                set({ headers: Object.keys(headers).length > 0 ? headers : undefined });
              }}
            />
          </Field>
        </>
      )}

      {config.type === "push" && (
        <>
          <Field label="VAPID Subject" hint="Contact URI sent to push services. Use mailto: or https:.">
            <Input className="h-8 text-xs font-mono" placeholder="mailto:ops@example.com" value={config.vapidSubject ?? ""} onChange={(e) => set({ vapidSubject: e.target.value || undefined })} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="TTL Seconds" hint="How long push services may retain the notification.">
              <Input className="h-8 text-xs font-mono" type="number" min={0} value={config.ttl ?? 3600} onChange={(e) => set({ ttl: e.target.value ? Number(e.target.value) : undefined })} />
            </Field>
            <Field label="Urgency">
              <Select value={config.urgency ?? "normal"} onValueChange={(v) => set({ urgency: v as NotificationChannelConfig["urgency"] })}>
                <SelectTrigger className="h-8 text-xs w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="very-low" className="text-xs">Very low</SelectItem>
                  <SelectItem value="low" className="text-xs">Low</SelectItem>
                  <SelectItem value="normal" className="text-xs">Normal</SelectItem>
                  <SelectItem value="high" className="text-xs">High</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <p className="text-[10px] text-muted-foreground leading-tight">
            VAPID keys are generated once and stored in .polpo/push.json. Override them with config values or env references only when you need stable keys across deployments.
          </p>
        </>
      )}
    </div>
  );
}

function InboundGatewayForm({ config, onChange }: {
  config: NotificationChannelConfig;
  onChange: (config: NotificationChannelConfig) => void;
}) {
  const gateway = config.gateway ?? {};
  const enabled = gateway.enableInbound === true;
  const policy = gateway.dmPolicy ?? "pairing";
  const updateGateway = (patch: Partial<GatewayConfig>) => {
    onChange({
      ...config,
      gateway: {
        dmPolicy: "pairing",
        ...gateway,
        ...patch,
      },
    });
  };

  return (
    <div className="rounded-lg border border-border/40 bg-background/50 px-3 py-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold">Inbound gateway</span>
          </div>
          <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
            Let people send messages to Polpo from {CHANNEL_META[config.type]?.label ?? config.type}. This is separate from outbound notifications.
          </p>
        </div>
        <Button
          type="button"
          variant={enabled ? "secondary" : "outline"}
          size="sm"
          className="h-7 shrink-0 text-[11px] gap-1.5"
          onClick={() => updateGateway({ enableInbound: !enabled })}
        >
          <ToggleRight className={cn("h-3.5 w-3.5", enabled && "text-emerald-500")} />
          {enabled ? "Enabled" : "Off"}
        </Button>
      </div>

      {enabled ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label="DM Policy" hint="Controls who can start a Polpo session.">
              <Select value={policy} onValueChange={(v) => updateGateway({ dmPolicy: v as GatewayPolicy })}>
                <SelectTrigger className="h-8 text-xs w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pairing" className="text-xs">Pairing</SelectItem>
                  <SelectItem value="allowlist" className="text-xs">Allowlist</SelectItem>
                  <SelectItem value="open" className="text-xs">Open</SelectItem>
                  <SelectItem value="disabled" className="text-xs">Disabled</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Idle Timeout" hint="Minutes before a session expires.">
              <Input
                className="h-8 text-xs font-mono"
                type="number"
                min={1}
                placeholder="60"
                value={gateway.sessionIdleMinutes ?? ""}
                onChange={(e) => updateGateway({ sessionIdleMinutes: e.target.value ? Number(e.target.value) : undefined })}
              />
            </Field>
          </div>
          <Field
            label="Allow From"
            hint={policy === "allowlist"
              ? "Comma-separated external IDs allowed to message Polpo."
              : policy === "open"
                ? "Optional. Leave empty for open access, or document expected IDs."
                : "Optional. Pairing policy normally uses /pair CODE instead."}
          >
            <Input
              className="h-8 text-xs font-mono"
              placeholder={config.type === "whatsapp" ? "+393331234567, 393331234567" : "123456789, -1001234567890"}
              value={(gateway.allowFrom ?? []).join(", ")}
              onChange={(e) => {
                const allowFrom = splitList(e.target.value);
                updateGateway({ allowFrom: allowFrom.length > 0 ? allowFrom : undefined });
              }}
            />
          </Field>
          <div className="rounded-md border border-border/30 bg-muted/15 px-2.5 py-2 text-[10.5px] leading-relaxed text-muted-foreground">
            {policy === "pairing" && "Pairing requires the user to send /pair with a valid code before free text is routed to Polpo."}
            {policy === "allowlist" && "Allowlist accepts only configured IDs. Use this for production channels with known operators."}
            {policy === "open" && "Open allows any direct message that reaches the channel. Use only for controlled or disposable endpoints."}
            {policy === "disabled" && "Disabled keeps the gateway block configured but rejects inbound messages."}
          </div>
        </>
      ) : (
        <p className="rounded-md border border-border/30 bg-muted/15 px-2.5 py-2 text-[10.5px] leading-relaxed text-muted-foreground">
          Inbound is off. This channel can still send notifications; messages from users will not become Polpo conversations.
        </p>
      )}
    </div>
  );
}

/** Channel config form — renders type-specific fields */
function ChannelForm({ config, onChange }: {
  config: NotificationChannelConfig;
  onChange: (config: NotificationChannelConfig) => void;
}) {
  const set = (patch: Partial<NotificationChannelConfig>) => onChange({ ...config, ...patch });

  return (
    <div className="space-y-3">
      <ChannelConceptPanel type={config.type} />
      <ChannelSetupGuide type={config.type} />
      <DeliveryFields config={config} onChange={set} />
      {channelSupportsInbound(config.type) && (
        <InboundGatewayForm config={config} onChange={onChange} />
      )}
    </div>
  );
}

/** Interactive channel card with edit / delete / test */
interface ChannelTestResult {
  success: boolean;
  error?: string;
}

function ChannelCard({ name, ch, onEdit, onDelete, onTest, deleting, testing, testResult }: {
  name: string;
  ch: NotificationChannelConfig;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  deleting?: boolean;
  testing?: boolean;
  testResult?: ChannelTestResult | null;
}) {
  const meta = CHANNEL_META[ch.type] ?? { label: ch.type, icon: Bell, color: "border-l-zinc-500", hue: "zinc" };
  const hue = HUE_STYLES[meta.hue] ?? HUE_STYLES.zinc;
  const gateway = ch.gateway;

  return (
    <Card className={cn(
      "relative overflow-hidden bg-card border border-border/40 py-0 gap-0 group",
      "transition-all duration-200 hover:border-border/70 hover:shadow-md",
    )}>
      {/* Brand gradient wash — diagonal soft tint, fades to nothing */}
      <div
        className={cn(
          "absolute inset-0 pointer-events-none bg-gradient-to-br via-transparent to-transparent",
          hue.gradient,
        )}
        aria-hidden
      />
      {/* Top-left brand accent strip (4px) */}
      <div
        className={cn(
          "absolute top-0 left-0 h-full w-[3px] rounded-l-xl",
          hue.pip.replace("bg-", "bg-"),
        )}
        aria-hidden
      />

      <CardContent className="relative pt-4 pb-3 px-4 space-y-3">
        {/* Hero header — big brand mark + name + meta */}
        <div className="flex items-start gap-3">
          <div className={cn(
            "h-11 w-11 rounded-xl flex items-center justify-center shrink-0 ring-1",
            hue.iconBg,
            hue.iconRing,
          )}>
            <ChannelLogo type={ch.type} size={24} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-sm font-semibold truncate">{name}</span>
              {gateway?.enableInbound && (
                <Badge variant="secondary" className="text-[9px] gap-0.5 px-1.5 py-0 h-4">
                  <Zap className="h-2 w-2" /> Inbound
                </Badge>
              )}
            </div>
            <p className="text-[10.5px] text-muted-foreground/80 mt-0.5 flex items-center gap-1.5">
              <span className={cn("inline-block h-1.5 w-1.5 rounded-full", hue.pip)} />
              <span className="capitalize">{meta.label}</span>
              <span className="text-muted-foreground/40">·</span>
              <code className="font-mono text-[10px]">{ch.type}</code>
            </p>
          </div>
          {/* Inline delete — ghost X, top-right */}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground/60 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={onDelete}
            disabled={deleting}
            aria-label="Delete channel"
          >
            {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
          </Button>
        </div>

        {/* Type-specific summary — softer styling, indented under the icon */}
        <div className="space-y-0.5 pl-[3.5rem] -mt-1">
          {ch.type === "telegram" && (
            <>
              <Row label="Bot Token" value={ch.botToken ? "*** configured" : "not set"} mono />
              <Row label="Chat ID" value={ch.chatId || "not set"} mono />
            </>
          )}
          {ch.type === "slack" && (
            <>
              <Row label="Webhook" value={ch.webhookUrl ? "*** configured" : "not set"} mono />
              {ch.apiKey && <StatusDot ok label="File uploads enabled" />}
            </>
          )}
          {ch.type === "whatsapp" && (
            <>
              <Row label="Chat ID" value={ch.chatId || "not set"} mono />
              {ch.profileDir && <Row label="Profile" value={ch.profileDir} mono />}
            </>
          )}
          {ch.type === "email" && (
            <>
              <Row label="Provider" value={<Badge variant="secondary" className="text-[10px]">{ch.provider ?? "resend"}</Badge>} />
              {ch.from && <Row label="From" value={ch.from} mono />}
              {(ch.to?.length ?? 0) > 0 && (
                <Row label="To" value={`${ch.to!.length} recipient${ch.to!.length > 1 ? "s" : ""}`} />
              )}
              <StatusDot ok={!!ch.apiKey || !!ch.host} label={ch.apiKey ? "API key set" : ch.host ? "SMTP configured" : "No credentials"} />
            </>
          )}
          {ch.type === "webhook" && (
            <>
              <Row label="URL" value={ch.url || "not set"} mono />
              {ch.headers && Object.keys(ch.headers).length > 0 && (
                <Row label="Headers" value={`${Object.keys(ch.headers).length} custom`} />
              )}
            </>
          )}
          {ch.type === "push" && (
            <>
              <Row label="VAPID" value={ch.vapidPublicKey || ch.vapidPrivateKey ? "custom keys" : "project generated"} mono />
              <Row label="TTL" value={`${ch.ttl ?? 3600}s`} mono />
              <Row label="Urgency" value={<Badge variant="secondary" className="text-[10px]">{ch.urgency ?? "normal"}</Badge>} />
            </>
          )}

          {/* Gateway — inline footnote */}
          {gateway?.enableInbound && (
            <div className="pt-1.5 mt-1.5 border-t border-border/20">
              <Row
                label={
                  <span className="flex items-center gap-1">
                    <Zap className="h-2.5 w-2.5" /> DM Policy
                  </span>
                }
                value={gateway.dmPolicy ?? "allowlist"}
                mono
              />
            </div>
          )}
        </div>

        {/* Test result error — just above actions */}
        {testResult?.success === false && testResult.error && (
          <div className="rounded-md border border-destructive/25 bg-destructive/10 px-2.5 py-1.5 text-[10.5px] leading-relaxed text-destructive">
            {testResult.error}
          </div>
        )}

        {/* Actions — separated by hairline, denser */}
        <div className="flex items-center gap-1 pt-2.5 -mx-4 px-4 border-t border-border/30">
          <Button variant="ghost" size="sm" className="h-7 text-[11px] gap-1 px-2" onClick={onEdit}>
            <Pencil className="h-3 w-3" /> Edit
          </Button>
          <Button
            variant={testResult?.success === true ? "secondary" : "ghost"}
            size="sm"
            className={cn(
              "h-7 text-[11px] gap-1 px-2 transition-colors",
              testResult?.success === true && "text-emerald-600 bg-emerald-500/10 hover:bg-emerald-500/15",
              testResult?.success === false && "text-destructive hover:bg-destructive/10",
            )}
            onClick={onTest}
            disabled={testing}
          >
            {testing ? <Loader2 className="h-3 w-3 animate-spin" /> :
             testResult?.success === true ? <Activity className="h-3 w-3 fill-current" /> :
             <Activity className="h-3 w-3" />}
            {testing ? "Testing…" : testResult?.success === true ? "Reachable" : testResult?.success === false ? "Failed" : "Test"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PushBrowserControls({ hasPushChannel }: { hasPushChannel: boolean }) {
  const [state, setState] = useState<PushSubscriptionState>(() => getPushSupportState());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getCurrentPushState()
      .then((next) => {
        if (!alive) return;
        setState(next);
        setError(null);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : "Could not load push state");
      });
    return () => { alive = false; };
  }, []);

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await enablePushNotifications();
      setState(next);
      toast.success("Push notifications enabled for this browser");
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await disablePushNotifications();
      setState(next);
      toast.success("Push notifications disabled for this browser");
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="bg-card/70 border-border/40 py-0">
      <CardContent className="p-3 space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <Monitor className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-sm font-semibold">This browser</span>
              <Badge variant={state.subscribed ? "default" : "outline"} className="text-[10px]">
                {state.subscribed ? "Subscribed" : state.permission === "denied" ? "Blocked" : "Not subscribed"}
              </Badge>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {state.supported
                ? `${state.subscriptionCount} saved browser subscription${state.subscriptionCount === 1 ? "" : "s"}`
                : "Requires HTTPS or localhost, Service Worker, Notification API, and PushManager"}
            </p>
          </div>
          <div className="flex gap-2">
            {state.subscribed ? (
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={disable} disabled={busy}>
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />} Disable
              </Button>
            ) : (
              <Button size="sm" className="h-8 text-xs" onClick={enable} disabled={busy || !state.supported || !hasPushChannel || state.permission === "denied"}>
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Bell className="h-3 w-3" />} Enable
              </Button>
            )}
          </div>
        </div>
        {error && (
          <div className="rounded-md border border-destructive/25 bg-destructive/10 px-2 py-1.5 text-[10px] leading-relaxed text-destructive">
            {error}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Channels Tab ──

interface ChannelApiAction {
  path: string;
  method: string;
  body?: unknown;
}

function ChannelsTab({ settings, onUpdateConfig }: {
  settings: PolpoSettings;
  onUpdateConfig: (action: ChannelApiAction) => Promise<void>;
}) {
  const channels = objectOrEmpty<NotificationChannelConfig>(
    objectOrEmpty(settings.notifications).channels,
  );

  // Dialog state
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editConfig, setEditConfig] = useState<NotificationChannelConfig>(defaultChannelConfig("telegram"));
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Delete
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  // Test
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ChannelTestResult | null>>({});

  // Add new channel — choose type first
  const [typePickerOpen, setTypePickerOpen] = useState(false);

  const openEdit = (name: string, config: NotificationChannelConfig) => {
    setEditName(name);
    setEditConfig({ ...config });
    setIsNew(false);
    setSaveError(null);
    setEditOpen(true);
  };

  const openAdd = (type: NotificationChannelType) => {
    setTypePickerOpen(false);
    setEditName("");
    setEditConfig(defaultChannelConfig(type));
    setIsNew(true);
    setSaveError(null);
    setEditOpen(true);
  };

  const handleSave = async () => {
    const name = editName.trim();
    if (!name) { setSaveError("Channel name is required"); return; }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) { setSaveError("Name: only letters, numbers, dashes, underscores"); return; }
    setSaving(true);
    setSaveError(null);
    try {
      await onUpdateConfig({ path: `/${encodeURIComponent(name)}`, method: "PUT", body: editConfig });
      setEditOpen(false);
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const name = deleteTarget;
    setDeleteTarget(null);
    setDeleting(name);
    try {
      await onUpdateConfig({ path: `/${encodeURIComponent(name)}`, method: "DELETE" });
    } finally {
      setDeleting(null);
    }
  };

  const handleTest = async (name: string) => {
    setTesting(name);
    setTestResults((prev) => ({ ...prev, [name]: null }));
    try {
      const res = await fetch(`${appConfig.baseUrl}/api/v1/config/channels/${encodeURIComponent(name)}/test`, { method: "POST" });
      const data = await res.json();
      setTestResults((prev) => ({
        ...prev,
        [name]: data.ok
          ? { success: !!data.data?.success, error: data.data?.error }
          : { success: false, error: data.error ?? "Channel test failed" },
      }));
    } catch {
      setTestResults((prev) => ({ ...prev, [name]: { success: false, error: "Could not connect to server" } }));
    } finally {
      setTesting(null);
    }
  };

  const configuredTypes = new Set(Object.values(channels).map((c) => c.type));
  const unconfiguredTypes = ALL_CHANNEL_TYPES.filter((t) => !configuredTypes.has(t));
  const hasPushChannel = Object.values(channels).some((ch) => ch.type === "push");

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-border/40 bg-card/50 px-4 py-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex items-start gap-2.5 min-w-0">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-muted/40 shrink-0">
              <Bell className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold">Notifications</p>
              <p className="mt-0.5 text-[10.5px] leading-relaxed text-muted-foreground">
                Outbound alerts generated by rules, tasks, approvals, and lifecycle events.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2.5 min-w-0">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-muted/40 shrink-0">
              <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold">Inbound gateway</p>
              <p className="mt-0.5 text-[10.5px] leading-relaxed text-muted-foreground">
                Optional chat entrypoint where Telegram or WhatsApp messages become Polpo sessions.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2.5 min-w-0">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-muted/40 shrink-0">
              <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold">Agent tools</p>
              <p className="mt-0.5 text-[10.5px] leading-relaxed text-muted-foreground">
                Separate capabilities an agent may use to read or send through a service.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Monitor className="h-3.5 w-3.5" /> PWA Push
          </h3>
        </div>
        <PushBrowserControls hasPushChannel={hasPushChannel} />
        {!hasPushChannel && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Add a Push channel first, then enable notifications for this browser.
          </p>
        )}
      </section>

      {/* Configured channels */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Bell className="h-3.5 w-3.5" /> Channels
          </h3>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => setTypePickerOpen(true)}>
            <Plus className="h-3 w-3" /> Add channel
          </Button>
        </div>

        {Object.keys(channels).length > 0 ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {Object.entries(channels).map(([name, ch]) => (
              <ChannelCard
                key={name}
                name={name}
                ch={ch}
                onEdit={() => openEdit(name, ch)}
                onDelete={() => setDeleteTarget(name)}
                onTest={() => handleTest(name)}
                deleting={deleting === name}
                testing={testing === name}
                testResult={testResults[name]}
              />
            ))}
          </div>
        ) : (
          <Empty text="No notification channels configured" />
        )}
      </section>

      {/* Unconfigured types — quick add */}
      {unconfiguredTypes.length > 0 && (
        <section>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
            <Zap className="h-3.5 w-3.5" /> Quick Add
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2">
            {unconfiguredTypes.map((type) => {
              const meta = CHANNEL_META[type];
              if (!meta) return null;
              return (
                <button
                  key={type}
                  onClick={() => openAdd(type)}
                  className="flex items-center gap-2.5 rounded-lg border border-dashed border-border/40 bg-muted/10 px-3 py-2.5 hover:border-primary/30 hover:bg-accent/30 transition-colors text-left cursor-pointer"
                >
                  <ChannelLogo type={type} size={16} />
                  <div>
                    <span className="text-xs text-muted-foreground/70">{meta.label}</span>
                    <p className="text-[10px] text-muted-foreground/40">Click to add</p>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Type Picker Dialog ── */}
      <Dialog open={typePickerOpen} onOpenChange={setTypePickerOpen}>
        <DialogContent className="sm:max-w-lg p-0 gap-0 overflow-hidden">
          <DialogHeader className="px-6 pt-6 pb-0">
            <DialogTitle className="text-base">Add Channel</DialogTitle>
            <DialogDescription className="text-xs">Choose a delivery channel. Telegram and WhatsApp can also expose an inbound gateway.</DialogDescription>
          </DialogHeader>
          <div className="px-6 py-5 space-y-2">
            {ALL_CHANNEL_TYPES.map((type) => {
              const meta = CHANNEL_META[type];
              if (!meta) return null;
              return (
                <button
                  key={type}
                  onClick={() => openAdd(type)}
                  className="w-full flex items-center gap-4 p-3 rounded-lg border border-border hover:border-primary/30 hover:bg-accent/50 text-left transition-all cursor-pointer"
                >
                  <div className={cn("h-10 w-10 rounded-lg flex items-center justify-center shrink-0 bg-muted/40", meta.color.replace("border-l-", "ring-1 ring-").replace("500", "500/30"))}>
                    <ChannelLogo type={type} size={22} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{meta.label}</p>
                      {channelSupportsInbound(type) && (
                        <Badge variant="secondary" className="text-[9px] h-4 px-1.5">Inbound capable</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{meta.description}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Edit/Add Channel Dialog ── */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-xl p-0 gap-0 overflow-hidden">
          <DialogHeader className="px-6 pt-6 pb-0">
            <DialogTitle className="text-base">{isNew ? "Add" : "Edit"} {CHANNEL_META[editConfig.type]?.label ?? editConfig.type} Channel</DialogTitle>
            <DialogDescription className="text-xs">
              {isNew ? "Configure delivery first, then optionally enable inbound where supported." : `Editing channel "${editName}".`}
            </DialogDescription>
          </DialogHeader>
          <div className="px-6 py-5 space-y-4 max-h-[60vh] overflow-y-auto">
            {isNew && (
              <Field label="Channel Name" hint="Unique identifier (e.g. slack-team, ops-email)">
                <Input
                  className="h-8 text-xs font-mono"
                  placeholder="my-channel"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  autoFocus
                />
              </Field>
            )}
            <ChannelForm config={editConfig} onChange={setEditConfig} />
            {saveError && (
              <p className="text-xs text-destructive">{saveError}</p>
            )}
          </div>
          <div className="flex justify-end gap-2 px-6 pb-5">
            <Button variant="outline" size="sm" onClick={() => setEditOpen(false)} className="text-xs">Cancel</Button>
            <Button size="sm" onClick={handleSave} disabled={saving} className="text-xs gap-1.5">
              {saving && <Loader2 className="h-3 w-3 animate-spin" />}
              {isNew ? "Add Channel" : "Save Changes"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Delete Confirmation ── */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={`Delete "${deleteTarget}"?`}
        description="This will remove the channel and any rules referencing it may stop working."
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
      />
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
  { value: "xhigh", label: "Extra High", description: "Maximum reasoning — slowest, highest quality" },
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
            <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight">{description}</p>
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
            className="flex items-center gap-1 text-[10px] text-muted-foreground/60 hover:text-destructive transition-colors cursor-pointer"
          >
            <X className="h-2.5 w-2.5" /> Clear
          </button>
        </div>
      )}
    </div>
  );
}

function AppearanceTab() {
  const { palette, setPalette } = usePalette();
  const { appearance, setAppearance, resetAppearance } = useAppearance();
  const [mode, setMode] = useState<"light" | "dark">("light");
  const activeTheme = appearance[mode];
  const [primaryDraft, setPrimaryDraft] = useState(activeTheme.primary);
  const [secondaryDraft, setSecondaryDraft] = useState(activeTheme.secondary);
  const [textDraft, setTextDraft] = useState(activeTheme.text);
  const [fontDraft, setFontDraft] = useState(activeTheme.fontFamily);

  const updateAppearance = (patch: Partial<typeof appearance> | { enabled: boolean }) => {
    setAppearance({ ...appearance, ...patch });
  };

  const updateTheme = (patch: Partial<typeof activeTheme>) => {
    setAppearance({
      ...appearance,
      [mode]: {
        ...activeTheme,
        ...patch,
      },
    });
  };

  useEffect(() => {
    setPrimaryDraft(activeTheme.primary);
    setSecondaryDraft(activeTheme.secondary);
    setTextDraft(activeTheme.text);
    setFontDraft(activeTheme.fontFamily);
  }, [activeTheme.fontFamily, activeTheme.primary, activeTheme.secondary, activeTheme.text]);

  const updateHexDraft = (
    value: string,
    setDraft: (value: string) => void,
    key: "primary" | "secondary" | "text",
  ) => {
    setDraft(value);
    if (/^#[0-9a-f]{6}$/i.test(value)) {
      updateTheme({ [key]: value });
    }
  };

  const fontPresets = [
    { label: "Satoshi", value: "\"Satoshi\", ui-sans-serif, system-ui, sans-serif" },
    { label: "System", value: "ui-sans-serif, system-ui, sans-serif" },
    { label: "Inter", value: "\"Inter\", ui-sans-serif, system-ui, sans-serif" },
    { label: "Serif", value: "ui-serif, Georgia, Cambria, \"Times New Roman\", Times, serif" },
    { label: "Mono", value: "\"JetBrains Mono\", ui-monospace, \"Cascadia Code\", monospace" },
  ];

  const previewStyle = {
    "--preview-primary": activeTheme.primary,
    "--preview-secondary": activeTheme.secondary,
    "--preview-text": activeTheme.text,
    "--preview-radius": `${activeTheme.radius}px`,
    "--preview-font": activeTheme.fontFamily,
  } as CSSProperties;

  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
          <PaletteIcon className="h-3.5 w-3.5" /> Palette
        </h3>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {PALETTES.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setPalette(option.id)}
              className={cn(
                "rounded-lg border p-3 text-left transition-colors",
                palette === option.id
                  ? "border-primary/60 bg-primary/5"
                  : "border-border/40 bg-card/60 hover:border-border/70 hover:bg-accent/25",
              )}
            >
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-sm font-semibold">{option.name}</span>
                {palette === option.id && <Check className="h-3.5 w-3.5 text-primary" />}
              </div>
              <div className="mb-2 flex h-5 overflow-hidden rounded-md border border-border/30">
                {option.swatchLight.map((color, index) => (
                  <span key={index} className="flex-1" style={{ background: color }} />
                ))}
              </div>
              <p className="text-[11px] leading-snug text-muted-foreground">{option.blurb}</p>
            </button>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Settings2 className="h-3.5 w-3.5" /> Overrides
          </h3>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-lg border border-border/40 bg-muted/20 p-0.5">
              {[
                { label: "No", value: false },
                { label: "Yes", value: true },
              ].map((option) => (
                <button
                  key={option.label}
                  type="button"
                  onClick={() => updateAppearance({ enabled: option.value })}
                  className={cn(
                    "h-7 rounded-md px-3 text-xs font-medium transition-colors",
                    appearance.enabled === option.value
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={resetAppearance}>
              Reset
            </Button>
          </div>
        </div>
        <div className={cn(
          "grid gap-3 lg:grid-cols-[minmax(0,1fr)_18rem]",
          !appearance.enabled && "opacity-60",
        )}>
          <div className="space-y-3">
            <div className="rounded-lg border border-border/40 bg-card/60 p-3">
              <label className="mb-2 block text-xs font-medium">Theme target</label>
              <div className="inline-flex rounded-lg border border-border/40 bg-muted/20 p-0.5">
                {[
                  { label: "Light", value: "light" as const },
                  { label: "Dark", value: "dark" as const },
                ].map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setMode(option.value)}
                    className={cn(
                      "h-7 rounded-md px-3 text-xs font-medium transition-colors",
                      mode === option.value
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-border/40 bg-card/60 p-3">
              <label className="mb-2 flex items-center justify-between gap-3 text-xs font-medium">
                Primary
                <code className="text-[11px] text-muted-foreground">{activeTheme.primary}</code>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={activeTheme.primary}
                  onChange={(event) => {
                    setPrimaryDraft(event.target.value);
                    updateTheme({ primary: event.target.value });
                  }}
                  disabled={!appearance.enabled}
                  className="h-9 w-12 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-1"
                />
                <Input
                  value={primaryDraft}
                  onChange={(event) => updateHexDraft(event.target.value, setPrimaryDraft, "primary")}
                  disabled={!appearance.enabled}
                  className="h-9 font-mono text-xs"
                />
              </div>
            </div>

            <div className="rounded-lg border border-border/40 bg-card/60 p-3">
              <label className="mb-2 flex items-center justify-between gap-3 text-xs font-medium">
                Secondary
                <code className="text-[11px] text-muted-foreground">{activeTheme.secondary}</code>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={activeTheme.secondary}
                  onChange={(event) => {
                    setSecondaryDraft(event.target.value);
                    updateTheme({ secondary: event.target.value });
                  }}
                  disabled={!appearance.enabled}
                  className="h-9 w-12 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-1"
                />
                <Input
                  value={secondaryDraft}
                  onChange={(event) => updateHexDraft(event.target.value, setSecondaryDraft, "secondary")}
                  disabled={!appearance.enabled}
                  className="h-9 font-mono text-xs"
                />
              </div>
            </div>

            <div className="rounded-lg border border-border/40 bg-card/60 p-3">
              <label className="mb-2 flex items-center justify-between gap-3 text-xs font-medium">
                Text
                <code className="text-[11px] text-muted-foreground">{activeTheme.text}</code>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={activeTheme.text}
                  onChange={(event) => {
                    setTextDraft(event.target.value);
                    updateTheme({ text: event.target.value });
                  }}
                  disabled={!appearance.enabled}
                  className="h-9 w-12 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-1"
                />
                <Input
                  value={textDraft}
                  onChange={(event) => updateHexDraft(event.target.value, setTextDraft, "text")}
                  disabled={!appearance.enabled}
                  className="h-9 font-mono text-xs"
                />
              </div>
            </div>

            <div className="rounded-lg border border-border/40 bg-card/60 p-3">
              <label className="mb-2 flex items-center justify-between gap-3 text-xs font-medium">
                Font
                <span className="text-[11px] text-muted-foreground">any CSS font stack</span>
              </label>
              <div className="grid gap-2 sm:grid-cols-[12rem_minmax(0,1fr)]">
                <Select
                  value={fontPresets.some((font) => font.value === activeTheme.fontFamily) ? activeTheme.fontFamily : "custom"}
                  onValueChange={(value) => {
                    if (value === "custom") return;
                    setFontDraft(value);
                    updateTheme({ fontFamily: value });
                  }}
                  disabled={!appearance.enabled}
                >
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue placeholder="Preset" />
                  </SelectTrigger>
                  <SelectContent>
                    {fontPresets.map((font) => (
                      <SelectItem key={font.label} value={font.value}>
                        {font.label}
                      </SelectItem>
                    ))}
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  value={fontDraft}
                  onChange={(event) => {
                    setFontDraft(event.target.value);
                    updateTheme({ fontFamily: event.target.value });
                  }}
                  disabled={!appearance.enabled}
                  className="h-9 font-mono text-xs"
                />
              </div>
            </div>

            <div className="rounded-lg border border-border/40 bg-card/60 p-3">
              <label className="mb-2 flex items-center justify-between gap-3 text-xs font-medium">
                Rounded
                <code className="text-[11px] text-muted-foreground">{activeTheme.radius}px</code>
              </label>
              <input
                type="range"
                min={0}
                max={24}
                step={1}
                value={activeTheme.radius}
                onChange={(event) => updateTheme({ radius: Number(event.target.value) })}
                disabled={!appearance.enabled}
                className="w-full accent-primary"
              />
            </div>
          </div>

          <div className="rounded-lg border border-border/40 bg-card/60 p-4" style={previewStyle}>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-semibold">Preview</span>
              <Badge variant="outline" className="text-[10px]">{mode}</Badge>
            </div>
            <div
              className="space-y-3 rounded-[var(--preview-radius)] border p-3"
              style={{
                borderColor: "color-mix(in srgb, var(--preview-primary) 28%, transparent)",
                color: "var(--preview-text)",
                fontFamily: "var(--preview-font)",
              }}
            >
              <button
                type="button"
                className="h-9 w-full rounded-[var(--preview-radius)] px-3 text-sm font-medium"
                style={{
                  background: "var(--preview-primary)",
                  color: "#fff",
                }}
              >
                Primary action
              </button>
              <div
                className="rounded-[var(--preview-radius)] p-3 text-xs"
                style={{
                  background: "var(--preview-secondary)",
                  color: "var(--preview-text)",
                }}
              >
                Secondary surface
              </div>
              <p className="text-sm" style={{ color: "var(--preview-text)" }}>
                Text color and font preview
              </p>
              <div className="flex gap-2">
                <span
                  className="inline-flex rounded-full px-2 py-0.5 text-xs font-medium"
                  style={{ background: "var(--preview-primary)", color: "#fff" }}
                >
                  Badge
                </span>
                <span
                  className="inline-flex rounded-full border px-2 py-0.5 text-xs font-medium"
                  style={{
                    borderColor: "var(--preview-primary)",
                    color: "var(--preview-text)",
                  }}
                >
                  Secondary
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

interface InstanceMember {
  email: string;
}

function MembersTab() {
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
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
          <Users className="h-3.5 w-3.5" /> Tenant Members
        </h3>
        <p className="text-xs text-muted-foreground">
          These emails can request a magic link and access this Polpo instance.
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

      <Card className="bg-card/80 border-border/40 py-0 gap-0">
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
                  <div className="h-7 w-7 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
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
  onUpdateSettings: (patch: { orchestratorModel?: string; imageModel?: string | null; reasoning?: ReasoningLevel }) => Promise<void>;
}) {
  const { skills, isLoading: skillsLoading } = useOrchestratorSkills();
  const [reasoningSaving, setReasoningSaving] = useState(false);

  // Model picker dialogs
  const [orchestratorPickerOpen, setOrchestratorPickerOpen] = useState(false);
  const [imagePickerOpen, setImagePickerOpen] = useState(false);
  const [modelSaving, setModelSaving] = useState<"orchestrator" | "image" | null>(null);

  // Active providers (have credentials) — derived from auth status
  const authProviders = objectOrEmpty<ProviderAuthInfo>(authStatus?.providers);
  const configuredProviders = Object.entries(authProviders)
    .filter(([, info]) => info.hasEnvKey || arrayOrEmpty<AuthProfileMeta>(info.profiles).some((p) => p.status === "active"))
    .map(([name]) => name);
  const providerSources = Object.fromEntries(
    Object.entries(authProviders)
      .filter(([, info]) => info.hasEnvKey || arrayOrEmpty<AuthProfileMeta>(info.profiles).some((p) => p.status === "active"))
      .map(([name, info]) => [name, info.hasEnvKey ? "env" : "oauth"]),
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
      <Badge variant="outline" className="text-[9px] h-4 font-normal">{providerLabel(parseModelSpec(primaryModel).provider)}</Badge>
    </span>
  ) : undefined;

  const imageDisplay = settings.imageModel ? (
    <span className="flex items-center gap-1.5">
      <span>{parseModelSpec(settings.imageModel).model}</span>
      <Badge variant="outline" className="text-[9px] h-4 font-normal">{providerLabel(parseModelSpec(settings.imageModel).provider)}</Badge>
    </span>
  ) : undefined;

  return (
    <div className="space-y-6">
      {/* ── Models & Reasoning ── */}
      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
          <Settings2 className="h-3.5 w-3.5" /> Orchestrator Settings
        </h3>
        <div className="space-y-2 max-w-xl">
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
              <span className="text-[10px] text-muted-foreground mr-1">Fallbacks:</span>
              {fallbackModels.map((fb) => (
                <Badge key={fb} variant="outline" className="text-[10px] font-mono">{fb}</Badge>
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
                <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight">
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
                        level.value !== "off" ? "text-emerald-500" : "text-muted-foreground",
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
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
          <Bookmark className="h-3.5 w-3.5" /> Skills
        </h3>
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
                    <Badge variant="outline" className="text-[9px] h-4">{skill.source}</Badge>
                  </div>
                  {skill.description && (
                    <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2 leading-tight">{skill.description}</p>
                  )}
                </div>
              </div>
            ))}
            {settings.orchestratorSkills && settings.orchestratorSkills.length > 0 && (
              <p className="text-[10px] text-muted-foreground mt-1 ml-11">
                Filter: <code className="font-mono text-primary">{settings.orchestratorSkills.join(", ")}</code>
              </p>
            )}
          </div>
        ) : (
          <Empty text="No orchestrator skills installed" />
        )}
        <p className="text-[10px] text-muted-foreground mt-2">
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
  const [authProviders, setAuthProviders] = useState<AuthProvider[]>([]);
  const [authProvidersLoaded, setAuthProvidersLoaded] = useState(false);

  // ── "Connect specific provider" dialog (direct flow) ──
  const [connectTarget, setConnectTarget] = useState<string | null>(null);
  const [connectMode, setConnectMode] = useState<"choose" | "oauth" | "apikey">("choose");
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
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Key className="h-3.5 w-3.5" /> Providers
          </h3>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={async () => { await ensureAuthProviders(); setAddDialogOpen(true); }}
          >
            <Key className="h-3 w-3" />
            Add provider
          </Button>
        </div>
        {allProviderNames.size > 0 ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {[...allProviderNames].sort().map((name) => {
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

      {/* ── Model Allowlist ── */}
      {settings.modelAllowlist && Object.keys(settings.modelAllowlist).length > 0 && (
        <section>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
            <Shield className="h-3.5 w-3.5" /> Model Allowlist
          </h3>
          <div className="space-y-1.5 max-w-lg">
            {Object.entries(settings.modelAllowlist).map(([model, opts]) => (
              <div key={model} className="flex items-center gap-2 rounded-md bg-muted/20 px-2.5 py-1.5 min-w-0">
                <code className="text-[11px] font-mono truncate flex-1">{model}</code>
                {opts.alias && <Badge variant="outline" className="text-[10px] shrink-0">{opts.alias}</Badge>}
                {opts.params && Object.entries(opts.params).map(([k, v]) => (
                  <Badge key={k} variant="secondary" className="text-[10px] shrink-0">{k}: {String(v)}</Badge>
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
        <DialogContent className="sm:max-w-lg p-0 gap-0 overflow-hidden">
          <DialogHeader className="px-6 pt-6 pb-0">
            <DialogTitle className="text-base">Manage providers</DialogTitle>
            <DialogDescription className="text-xs">
              Connect or disconnect LLM providers via OAuth subscription or API key.
            </DialogDescription>
          </DialogHeader>
          <div className="px-6 py-5">
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
  const [activeSection, setActiveSection] = useState<SectionId>("general");

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
  const sections = baseSections;
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
      {/* ── Tab bar ── */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="flex items-center gap-1 overflow-x-auto scrollbar-none flex-1 pb-0.5">
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveSection(id)}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer",
                activeSection === id
                  ? "bg-accent text-accent-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              {label}
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" className="h-8 shrink-0" onClick={refetch}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* ── Tab content ── */}
      <div className="flex-1 overflow-auto pb-bottom-nav lg:pb-2 space-y-3">

        {/* ═══ GENERAL (merged with Settings) ═══ */}
        {activeSection === "general" && (
          <div className="space-y-6">
            {/* ── Project ── */}
            <section>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
                <Hash className="h-3.5 w-3.5" /> Project
              </h3>
              <div className="max-w-md">
                <Row label="Name" value={config.project} mono />
              </div>
            </section>

            {/* ── Runtime ── */}
            <section>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
                <Settings2 className="h-3.5 w-3.5" /> Runtime
              </h3>
              <div className="max-w-md">
                <Row label="Storage" value={settings.storage ?? "file"} mono />
                <Row label="Log Level" value={settings.logLevel} mono />
                <Row label="Work Directory" value={settings.workDir} mono />
              </div>
              <p className="text-[10px] text-muted-foreground mt-2">
                Source: <code className="font-mono text-primary">.polpo/polpo.json</code>
              </p>
            </section>

            {/* ── Execution ── */}
            <section>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5" /> Execution
              </h3>
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
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
                <Gauge className="h-3.5 w-3.5" /> Quality
              </h3>
              <div className="max-w-md">
                <Row label="Quality Threshold" value={settings.defaultQualityThreshold != null ? `${settings.defaultQualityThreshold}/5` : "none"} />
                <Row label="Auto-correct" value={settings.autoCorrectExpectations !== false ? "Yes" : "No"} />
                <Row label="Max Assessment Retries" value={settings.maxAssessmentRetries ?? "1 (default)"} />
              </div>
            </section>

            {/* ── Features ── */}
            <section>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
                <ToggleRight className="h-3.5 w-3.5" /> Features
              </h3>
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
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
                  <RefreshCw className="h-3.5 w-3.5" /> Default Retry Policy
                </h3>
                <div className="max-w-md">
                  {settings.defaultRetryPolicy.escalateAfter != null && <Row label="Escalate After" value={`${settings.defaultRetryPolicy.escalateAfter} failures`} />}
                  {settings.defaultRetryPolicy.fallbackAgent && <Row label="Fallback Agent" value={settings.defaultRetryPolicy.fallbackAgent} mono />}
                  {settings.defaultRetryPolicy.escalateModel && <Row label="Escalate Model" value={settings.defaultRetryPolicy.escalateModel} mono />}
                </div>
              </section>
            )}

            {/* ── MCP Tool Allowlist ── */}
            {settings.mcpToolAllowlist && Object.keys(settings.mcpToolAllowlist).length > 0 && (
              <section>
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
                  <Wrench className="h-3.5 w-3.5" /> MCP Tool Allowlist
                </h3>
                <div className="space-y-2.5 max-w-lg">
                  {Object.entries(settings.mcpToolAllowlist).map(([server, tools]) => (
                    <div key={server}>
                      <code className="text-[11px] font-mono text-muted-foreground font-semibold">{server}</code>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {tools.map((t) => (
                          <Badge key={t} variant="outline" className="text-[10px] font-mono">{t}</Badge>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* ── Email Domains ── */}
            {settings.emailAllowedDomains && settings.emailAllowedDomains.length > 0 && (
              <section>
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
                  <Mail className="h-3.5 w-3.5" /> Email Allowed Domains
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {settings.emailAllowedDomains.map((d) => (
                    <Badge key={d} variant="secondary" className="text-[10px] font-mono">{d}</Badge>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {/* ═══ APPEARANCE ═══ */}
        {activeSection === "appearance" && (
          <AppearanceTab />
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
          <ChannelsTab settings={settings} onUpdateConfig={async (updater) => {
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
              <p className="text-[11px] text-muted-foreground">
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
            {rules.length > 0 ? (
              <div className="space-y-2">
                {rules.map((rule) => (
                  <Card key={rule.id} className="bg-card/80 border-border/40 py-0 gap-0">
                    <CardContent className="pt-3 pb-3">
                      <div className="flex items-center gap-2 mb-2">
                        <Eye className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="text-sm font-semibold">{rule.name ?? rule.id}</span>
                        {rule.severity && (
                          <Badge variant={rule.severity === "critical" ? "destructive" : rule.severity === "warning" ? "secondary" : "outline"} className="text-[10px]">
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
                          <Badge key={e} variant="secondary" className="text-[10px] font-mono">{e}</Badge>
                        ))}
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                        {rule.channels.map((c) => (
                          <Badge key={c} variant="outline" className="text-[10px]">{c}</Badge>
                        ))}
                      </div>
                      {/* Condition */}
                      {rule.condition && Object.keys(rule.condition).length > 0 && (
                        <div className="flex items-center gap-1.5 mb-2">
                          <Gauge className="h-3 w-3 text-muted-foreground shrink-0" />
                          <span className="text-[10px] text-muted-foreground">Condition filter active</span>
                        </div>
                      )}
                      {rule.template && (
                        <code className="text-[11px] text-muted-foreground block truncate bg-muted/20 rounded px-2 py-1 mb-2">{rule.template}</code>
                      )}
                      {/* Meta row */}
                      {(rule.cooldownMs || rule.includeOutcomes || rule.actions?.length) && (
                        <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-border/20">
                          {rule.cooldownMs != null && rule.cooldownMs > 0 && (
                            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                              <Timer className="h-3 w-3" />
                              {rule.cooldownMs >= 60000 ? `${(rule.cooldownMs / 60000).toFixed(0)}min` : `${(rule.cooldownMs / 1000).toFixed(0)}s`} cooldown
                            </span>
                          )}
                          {rule.includeOutcomes && (() => {
                            const types = Array.isArray(rule.outcomeFilter)
                              ? rule.outcomeFilter
                              : rule.outcomeFilter?.types ?? [];
                            return (
                              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                                <Paperclip className="h-3 w-3" />
                                Outcomes{types.length ? ` (${types.join(", ")})` : ""}
                                {rule.maxAttachmentSize ? ` max ${(rule.maxAttachmentSize / 1048576).toFixed(0)}MB` : ""}
                              </span>
                            );
                          })()}
                          {rule.actions && rule.actions.length > 0 && (
                            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
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
                <summary className="text-[11px] text-muted-foreground cursor-pointer hover:text-foreground select-none">
                  Show raw JSON
                </summary>
                <JsonBlock
                  data={rules}
                  className="mt-2 text-[11px] leading-relaxed font-mono bg-muted/20 rounded-lg px-4 py-3 whitespace-pre-wrap max-h-64 overflow-auto border border-border/20"
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
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5" /> Escalation Policy
                    </h3>
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
                                "flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs font-bold",
                                level.handler === "human" ? "border-red-500 text-red-500 bg-red-500/10" :
                                level.handler === "orchestrator" ? "border-amber-500 text-amber-500 bg-amber-500/10" :
                                "border-sky-500 text-sky-500 bg-sky-500/10",
                              )}>
                                L{level.level}
                              </div>
                              {i < (escalation.levels?.length ?? 0) - 1 && (
                                <div className="w-px h-4 bg-border/40" />
                              )}
                            </div>
                            {/* Level details */}
                            <Card className="flex-1 bg-card/60 border-border/30 py-0 gap-0">
                              <CardContent className="py-2.5 px-3">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <Badge variant={
                                    level.handler === "human" ? "destructive" :
                                    level.handler === "orchestrator" ? "secondary" : "outline"
                                  } className="text-[10px]">
                                    {level.handler}
                                  </Badge>
                                  {level.target && (
                                    <code className="text-[11px] font-mono text-muted-foreground">{level.target}</code>
                                  )}
                                  {level.timeoutMs && (
                                    <span className="flex items-center gap-1 text-[10px] text-muted-foreground ml-auto">
                                      <Clock className="h-2.5 w-2.5" />
                                      {level.timeoutMs >= 60000 ? `${(level.timeoutMs / 60000).toFixed(0)}min` : `${(level.timeoutMs / 1000).toFixed(0)}s`}
                                    </span>
                                  )}
                                </div>
                                {level.notifyChannels && level.notifyChannels.length > 0 && (
                                  <div className="flex items-center gap-1 mt-1.5">
                                    <Bell className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
                                    {level.notifyChannels.map((ch) => (
                                      <Badge key={ch} variant="outline" className="text-[9px]">{ch}</Badge>
                                    ))}
                                  </div>
                                )}
                              </CardContent>
                            </Card>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <JsonBlock data={escalation} className="text-[11px] leading-relaxed font-mono bg-muted/20 rounded-lg px-4 py-3 whitespace-pre-wrap max-h-64 overflow-auto border border-border/20" />
                    )}
                  </div>
                )}

                {/* SLA — structured display */}
                {sla && (
                  <section>
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
                      <Timer className="h-3.5 w-3.5" /> SLA Configuration
                    </h3>
                    <div className="max-w-md">
                      <Row label="Warning Threshold" value={sla.warningThreshold != null ? `${(sla.warningThreshold * 100).toFixed(0)}%` : "80% (default)"} />
                      <Row label="Check Interval" value={sla.checkIntervalMs ? `${(sla.checkIntervalMs / 1000).toFixed(0)}s` : "30s (default)"} />
                      <Row label="Violation Action" value={
                        <Badge variant={sla.violationAction === "fail" ? "destructive" : "outline"} className="text-[10px]">
                          {sla.violationAction ?? "notify"}
                        </Badge>
                      } />
                      {sla.warningChannels && sla.warningChannels.length > 0 && (
                        <div className="pt-1.5">
                          <span className="text-[10px] text-muted-foreground">Warning channels: </span>
                          {sla.warningChannels.map((ch) => (
                            <Badge key={ch} variant="secondary" className="text-[10px] mr-1">{ch}</Badge>
                          ))}
                        </div>
                      )}
                      {sla.violationChannels && sla.violationChannels.length > 0 && (
                        <div className="pt-1">
                          <span className="text-[10px] text-muted-foreground">Violation channels: </span>
                          {sla.violationChannels.map((ch) => (
                            <Badge key={ch} variant="destructive" className="text-[10px] mr-1">{ch}</Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  </section>
                )}

                {/* Approval Gates — structured display */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                      <Shield className="h-3.5 w-3.5" /> Approval Gates
                      {gates && gates.length > 0 && (
                        <Badge variant="secondary" className="text-[9px] h-4 px-1.5">{gates.length}</Badge>
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
                        <Card key={gate.id} className="bg-card/60 border-border/30 py-0 gap-0">
                          <CardContent className="py-3 px-4">
                            <div className="flex items-center gap-2 mb-2 flex-wrap">
                              <span className="text-sm font-semibold">{gate.name}</span>
                              <Badge variant={gate.handler === "human" ? "destructive" : "secondary"} className="text-[10px]">
                                {gate.handler === "human" ? <Users className="h-2.5 w-2.5 mr-0.5" /> : <Bot className="h-2.5 w-2.5 mr-0.5" />}
                                {gate.handler}
                              </Badge>
                              <code className="text-[10px] font-mono text-muted-foreground">{gate.hook}</code>
                              {gate.priority && gate.priority !== 100 && (
                                <Badge variant="outline" className="text-[9px]">priority: {gate.priority}</Badge>
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
                            <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                              {gate.timeoutMs && (
                                <span className="flex items-center gap-1">
                                  <Clock className="h-2.5 w-2.5" />
                                  {gate.timeoutMs >= 60000 ? `${(gate.timeoutMs / 60000).toFixed(0)}min` : `${(gate.timeoutMs / 1000).toFixed(0)}s`}
                                  {gate.timeoutAction && (
                                    <span className="text-[10px]">
                                      {" "}then {gate.timeoutAction === "approve" ? (
                                        <span className="text-emerald-500">auto-approve</span>
                                      ) : (
                                        <span className="text-red-500">auto-reject</span>
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
                                <code className="text-[10px] font-mono bg-muted/30 rounded px-1.5 py-0.5">{gate.condition.expression}</code>
                              )}
                            </div>
                            {gate.notifyChannels && gate.notifyChannels.length > 0 && (
                              <div className="flex items-center gap-1 mt-2">
                                <Bell className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
                                {gate.notifyChannels.map((ch) => (
                                  <Badge key={ch} variant="outline" className="text-[9px]">{ch}</Badge>
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
      const res = await fetch(apiUrl("/api/v1/sync/config"), { credentials: "include" });
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
      const res = await fetch(apiUrl("/api/v1/sync/history?limit=50"), { credentials: "include" });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok) setHistory(body.data as SyncHistoryEntry[]);
    } catch { /* ignore */ }
  };

  /** Re-attach to a sync that's still running on the server (e.g. user
   * navigated away mid-push). The polling stops automatically once the
   * server-side process completes (active comes back null). */
  const fetchActive = async () => {
    try {
      const res = await fetch(apiUrl("/api/v1/sync/active"), { credentials: "include" });
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
      const res = await fetch(apiUrl("/api/v1/sync/config"), {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ r2: draft }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error || "save failed");
      toast.success("Sync config saved");
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
      const res = await fetch(apiUrl("/api/v1/sync/config"), {
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
      const res = await fetch(apiUrl("/api/v1/sync/test"), { method: "POST", credentials: "include" });
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
      const res = await fetch(apiUrl("/api/v1/sync/cancel"), { method: "POST", credentials: "include" });
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
      const res = await fetch(apiUrl(`/api/v1/sync/${kind}`), {
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
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
          <CloudIcon className="h-3.5 w-3.5" /> R2 / S3-compatible target
        </h3>
        <p className="text-[11px] text-muted-foreground/80 mb-3">
          Sync the entire <code className="font-mono">workDir</code> to a Cloudflare R2 bucket via <code className="font-mono">rclone copy --update</code>.
          Non-destructive: only newer files are transferred, nothing on the destination is deleted.
        </p>

        {loading ? (
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
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
              <label className="block text-[11px] text-muted-foreground mb-1">Secret access key</label>
              <div className="flex items-center gap-2">
                <input
                  type={showSecret ? "text" : "password"}
                  value={draft.secretAccessKey}
                  onChange={(e) => { setDraft({ ...draft, secretAccessKey: e.target.value }); setSecretDirty(true); }}
                  placeholder={configured && !secretDirty ? "(stored — click to replace)" : "raw secret"}
                  onFocus={() => { if (configured && !secretDirty) setDraft({ ...draft, secretAccessKey: "" }); }}
                  className="flex-1 h-9 rounded-md border border-border bg-card px-3 font-mono text-[12px] focus:outline-none focus:ring-1 focus:ring-primary"
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
                  className="text-rose-400 hover:text-rose-300 hover:bg-rose-500/10">
                  Clear
                </Button>
              )}
            </div>
          </div>
        )}
      </section>

      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
          <Activity className="h-3.5 w-3.5" /> Sync now
        </h3>
        <p className="text-[11px] text-muted-foreground/80 mb-3">
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
            className="text-rose-400 hover:text-rose-300 hover:bg-rose-500/10">
            {progress.active === "push" && progress.mode === "sync" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            Replace remote
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void trigger("pull", "sync")} disabled={!configured || progress.active != null || preview != null}
            className="text-rose-400 hover:text-rose-300 hover:bg-rose-500/10">
            {progress.active === "pull" && progress.mode === "sync" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            Replace local
          </Button>
        </div>

        {progress.active && (
          <div className="mt-4 rounded-md border border-border bg-card/40 p-3 space-y-2">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-medium">
                {progress.active === "push" ? "Pushing" : "Pulling"}
                {progress.mode === "sync" && <span className="ml-1 text-rose-400">(replace)</span>}
              </span>
              <div className="flex items-center gap-2">
                <span className="font-mono tabular-nums text-muted-foreground">
                  {progress.transfers ?? 0} / {progress.totalTransfers ?? "?"} files
                </span>
                <button
                  type="button"
                  onClick={() => void cancelSync()}
                  className="inline-flex items-center gap-1 rounded bg-rose-500/15 px-2 py-0.5 text-[10.5px] font-medium text-rose-300 hover:bg-rose-500/25"
                >
                  <X className="h-3 w-3" />
                  Cancel
                </button>
              </div>
            </div>
            <SyncProgressBar progress={progress} />
            <div className="grid grid-cols-3 gap-2 font-mono text-[10.5px] tabular-nums text-muted-foreground">
              <div>{formatBytes(progress.bytes)} / {formatBytes(progress.totalBytes)}</div>
              <div>{progress.speed != null ? `${formatBytes(progress.speed)}/s` : "—"}</div>
              <div className="text-right">ETA {formatEta(progress.eta)}</div>
            </div>
            {progress.current && (
              <div className="truncate font-mono text-[11px] text-foreground/80" title={progress.current}>
                ⮕ {progress.current}
              </div>
            )}
            {progress.recent.length > 0 && (
              <details className="mt-1">
                <summary className="cursor-pointer text-[10.5px] text-muted-foreground hover:text-foreground/80">Recent files ({progress.recent.length})</summary>
                <div className="mt-1 max-h-32 overflow-y-auto font-mono text-[10.5px] text-muted-foreground space-y-0.5">
                  {progress.recent.map((line, i) => <div key={i} className="truncate">{line}</div>)}
                </div>
              </details>
            )}
          </div>
        )}
        {progress.done && !progress.active && (
          <div className={cn("mt-4 rounded-md border p-3 text-[11.5px]",
            progress.done.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-rose-500/30 bg-rose-500/10 text-rose-300")}>
            {progress.done.ok
              ? `Done — ${progress.transfers ?? 0} files transferred.`
              : (progress.error ?? `rclone exited with code ${progress.done.code}`)}
          </div>
        )}

        <div className="mt-3 grid grid-cols-2 gap-2 max-w-md text-[11px] text-muted-foreground">
          <div>Last push: <span className="font-mono text-foreground/80">{cfg?.lastPushedAt ? formatTime(cfg.lastPushedAt) : "—"}</span></div>
          <div>Last pull: <span className="font-mono text-foreground/80">{cfg?.lastPulledAt ? formatTime(cfg.lastPulledAt) : "—"}</span></div>
        </div>
      </section>

      <ExcludesSection cfg={cfg} reload={fetchCfg} />

      <ScheduleSection cfg={cfg} configured={configured} reload={fetchCfg} />

      <section>
        <div className="flex items-center justify-between mb-1.5">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Activity className="h-3.5 w-3.5" /> History
          </h3>
          <button
            type="button"
            onClick={() => void fetchHistory()}
            className="text-[10.5px] text-muted-foreground hover:text-foreground/80"
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
      const res = await fetch(apiUrl("/api/v1/sync/config"), {
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
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
        <X className="h-3.5 w-3.5" /> Excludes
      </h3>
      <p className="text-[11px] text-muted-foreground/80 mb-3">
        rclone-style filter patterns — applied to every push and pull, and to the auto-sync scheduler. <code className="font-mono">node_modules/**</code> matches a <code className="font-mono">node_modules</code> folder at any depth. Lines starting with <code className="font-mono">#</code> are comments. Empty list means no filtering.
      </p>
      <div className="space-y-2 max-w-2xl">
        {cfg?.internalExcludes && cfg.internalExcludes.length > 0 && (
          <div className="rounded-md border border-border bg-card/40 p-2 text-[11px]">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mb-1">
              Always excluded by Polpo
            </div>
            <ul className="space-y-0.5 font-mono text-[11px] text-foreground/70">
              {cfg.internalExcludes.map((p) => <li key={p}>· {p}</li>)}
            </ul>
            <div className="mt-1 text-[10px] text-muted-foreground/60">
              These hold the R2 secret + the local sync log — sending them to R2 would defeat their purpose.
            </div>
          </div>
        )}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="node_modules/**&#10;.git/**&#10;*.log"
          rows={8}
          className="w-full rounded-md border border-border bg-card px-3 py-2 font-mono text-[12px] focus:outline-none focus:ring-1 focus:ring-primary"
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
                  "rounded-md px-2 py-0.5 font-mono text-[10.5px] border transition-colors",
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
          <span className="text-[11px] text-muted-foreground">
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
      const res = await fetch(apiUrl("/api/v1/sync/config"), {
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
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
        <Activity className="h-3.5 w-3.5" /> Auto-sync (push)
      </h3>
      <p className="text-[11px] text-muted-foreground/80 mb-3">
        Schedule a recurring <strong>copy --update</strong> push from this host to R2. Replace mode is intentionally not exposed here — auto-runs are non-destructive only.
        Schedule survives server restarts.
      </p>
      <div className="space-y-3 max-w-xl">
        <div className="flex items-center gap-3">
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            disabled={!configured || saving}
            onClick={() => { const next = !enabled; setEnabled(next); void save(next); }}
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
              enabled ? "bg-emerald-500/70" : "bg-white/[0.12]",
              (!configured || saving) && "opacity-40 cursor-not-allowed",
            )}
          >
            <span className={cn("inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
              enabled ? "translate-x-[1.125rem]" : "translate-x-0.5")} />
          </button>
          <span className="text-[12px] text-foreground/80">{enabled ? "Enabled" : "Disabled"}</span>
        </div>

        <div>
          <label className="block text-[11px] text-muted-foreground mb-1">Preset</label>
          <select
            value={preset}
            onChange={(e) => onPresetChange(e.target.value)}
            className="w-full h-9 rounded-md border border-border bg-card px-3 text-[12px] focus:outline-none focus:ring-1 focus:ring-primary"
          >
            {SCHEDULE_PRESETS.map((p) => (
              <option key={p.label} value={p.cron}>{p.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-[11px] text-muted-foreground mb-1">
            Cron expression
            <span className="ml-2 text-[10px] text-muted-foreground/70">(5 fields: minute hour dom month dow)</span>
          </label>
          <input
            type="text"
            value={cron}
            onChange={(e) => { setCron(e.target.value); setPreset(""); }}
            className="w-full h-9 rounded-md border border-border bg-card px-3 font-mono text-[12px] focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="*/15 * * * *"
          />
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void save()} disabled={!configured || saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save
          </Button>
          <span className="text-[11px] text-muted-foreground">
            Next run: <span className="font-mono text-foreground/80">{cfg?.nextRunAt ? formatTime(cfg.nextRunAt) : "—"}</span>
          </span>
        </div>
        {!configured && (
          <p className="text-[10.5px] text-amber-300/80">
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
      <div className="rounded-md border border-border bg-card/40 px-3 py-4 text-center text-[11px] text-muted-foreground">
        No syncs yet — push or pull to start the history.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-[11px]">
        <thead className="bg-card/60 text-[10px] uppercase tracking-wider text-muted-foreground">
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
                  <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-px text-[10px] font-medium text-emerald-300">ok</span>
                ) : (
                  <span title={e.error} className="inline-flex items-center gap-1 rounded bg-rose-500/15 px-1.5 py-px text-[10px] font-medium text-rose-300">
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
        "inline-flex items-center gap-1 rounded px-1.5 py-px font-mono text-[10px]",
        replace
          ? "bg-rose-500/10 text-rose-300/90"
          : isPush
            ? "bg-sky-500/10 text-sky-300/90"
            : "bg-emerald-500/10 text-emerald-300/90",
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
          <span className="flex items-center gap-2 text-[12px]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Running rclone in dry-run mode against {dirLabel}…
          </span>
        ) : preview?.error ? (
          <span className="text-rose-300">{preview.error}</span>
        ) : (
          <div className="space-y-2 text-[12px]">
            <div>
              About to <strong>{preview?.kind === "push" ? "push" : "pull"}</strong> ({dirLabel})
              in <strong>{isReplace ? "replace" : "update"}</strong> mode.
            </div>
            <div className="rounded-md border border-border bg-card/40 p-2 font-mono text-[11.5px]">
              <div><strong>{preview?.files ?? 0}</strong> file{preview?.files === 1 ? "" : "s"} to transfer</div>
              <div><strong>{formatBytes(preview?.bytes)}</strong> total size</div>
            </div>
            {isReplace && (
              <div className="text-rose-300/90 text-[11.5px]">
                ⚠ Replace mode also DELETES files on the destination that aren't on the source.
                The dry-run preview shows transfers but the count of deletes isn't summarized — proceed with care.
              </div>
            )}
            {preview?.files === 0 && !preview?.error && (
              <div className="text-emerald-300/85 text-[11.5px]">
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
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
      {pct != null ? (
        <div
          className="h-full rounded-full bg-emerald-400/80 transition-[width]"
          style={{ width: `${pct}%` }}
        />
      ) : (
        <div className="absolute inset-y-0 left-0 h-full w-1/3 animate-pulse rounded-full bg-emerald-400/40" />
      )}
    </div>
  );
}

/** Parse one NDJSON line emitted by the /sync streaming endpoints and
 * fold it into the panel's progress state. */
function handleSyncEvent(line: string, setProgress: React.Dispatch<React.SetStateAction<SyncProgress>>) {
  let evt: any;
  try { evt = JSON.parse(line); } catch { return; }
  if (evt?.type === "done") {
    setProgress((p) => ({ ...p, done: { ok: !!evt.ok, code: evt.code ?? -1 }, error: evt.error || p.error, active: null }));
    return;
  }
  if (evt?.type !== "log") return;
  // Stats payload — shape from rclone --use-json-log
  if (evt.source === "accounting/stats" || evt.stats) {
    const s = evt.stats ?? evt;
    const tx = Array.isArray(s.transferring) ? s.transferring[0] : null;
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
      <label className="block text-[11px] text-muted-foreground mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          "w-full h-9 rounded-md border border-border bg-card px-3 text-[12px] focus:outline-none focus:ring-1 focus:ring-primary",
          mono && "font-mono",
        )}
      />
    </div>
  );
}

function formatTime(iso: string): string {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
