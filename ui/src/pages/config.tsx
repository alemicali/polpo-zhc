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
  Image as ImageIcon,
  Copy,
  type LucideIcon,
  Box as SandboxIcon,
  Plug,
} from "lucide-react";
import { notifyBrandingChanged, useConfig } from "@/hooks/use-polpo";
import { ChannelLogo } from "@/components/shared/channel-logo";
import { ProviderIcon } from "@/components/shared/provider-icon";
import { useAgents, useAuthStatus, useOrchestratorSkills } from "@polpo-ai/react";
import type { CustomModelDef, ProviderConfig, AuthProfileMeta, ProviderAuthInfo, SkillInfo, PolpoSettings, AuthStatusResponse, ReasoningLevel, NotificationChannelType, NotificationChannelConfig, BrandingConfig } from "@polpo-ai/react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { ORCHESTRATOR_NAME_MAX_LENGTH, getOrchestratorName, setOrchestratorName } from "@/lib/orchestrator-name";
import { JsonBlock } from "@/components/json-block";
import { config as appConfig, apiFetch, apiUrl } from "@/lib/config";
import { focusSetupField, notifySetupSaved, readSetupParams } from "@/lib/setup-link";
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
import { summarizeRule } from "@/lib/rule-summary";
import { HOOK_EVENT_CATALOG, HOOK_EVENT_GLOBS } from "@polpo-ai/core/hook-events";
import { GateFormDialog, type ApprovalGateDraft, type LifecycleHook as GateLifecycleHook } from "@/components/config/gate-form-dialog";
import { followInstanceDefault, kit, setInstanceAppearance, useResolvedAppearance, type InstanceAppearance } from "@/lib/appearance";
import { AppearanceEditor } from "@/components/config/appearance-editor";
import { SidebarStyleSettings } from "@/components/config/sidebar-style-settings";
import type { SidebarStyle } from "@/hooks/use-sidebar-style";
import { toast } from "sonner";
import { BrandMark } from "@/components/shared/brand-mark";
import { DEFAULT_PRODUCT_NAME, DEFAULT_PRODUCT_TAGLINE, productName, useInstanceBranding } from "@/lib/branding";
import { ChannelAccessPanel, TelegramChatFinder, TelegramConnect, TelegramTokenCheck } from "@/components/config/telegram-connect";
import { AgentSessionOverrides } from "@/components/config/agent-session-overrides";
import { CustomProviderWizard, CustomProvidersSection } from "@/components/config/custom-providers";
import { useCustomProviders } from "@/hooks/use-custom-providers";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useAgentNames } from "@/hooks/use-agent-names";
import { useTelegramChannelInfo } from "@/hooks/use-telegram-channel-info";
import { SandboxSettingsSection } from "@/components/sandbox/sandbox-settings";
import { McpAccessSection } from "@/components/config/mcp-access-section";
import { HarnessesSection } from "@/components/config/harnesses-section";
import { ComputerWebhooksSection } from "@/components/config/computer-webhooks-section";
import { SectionHeader } from "@/components/shared/section-header";

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

/** Secrets come back from the API masked ("••••1234"); saving them unchanged keeps the stored value. */
function isMaskedSecret(value?: string): boolean {
  return !!value && value.includes("••••");
}

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
  { id: "sandbox", label: "Sandbox", icon: SandboxIcon },
  { id: "harnesses", label: "Harnesses", icon: Bot },
  { id: "computers", label: "Computers", icon: Monitor },
  { id: "mcp", label: "MCP access", icon: Plug },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "sync", label: "Cloud sync", icon: CloudIcon },
] as const;

type SectionIdBase = (typeof baseSections)[number]["id"];

type SectionId = SectionIdBase;

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

// ── Channel helpers ──

const CHANNEL_META: Record<string, { label: string; icon: LucideIcon; color: string; hue: string; description: string }> = {
  telegram: { label: "Telegram", icon: Send,            color: "border-l-chart-1",     hue: "chart-1",     description: "Send notifications to a Telegram chat via bot" },
  slack:    { label: "Slack",    icon: MessageSquare,   color: "border-l-chart-3",   hue: "chart-3",   description: "Post to a Slack channel via webhook" },
  whatsapp: { label: "WhatsApp", icon: MessageSquare,   color: "border-l-chart-2", hue: "chart-2", description: "Send notifications to a WhatsApp chat (unofficial)" },
  email:    { label: "Email",    icon: Mail,            color: "border-l-chart-4",   hue: "chart-4",   description: "Send email via Resend, SendGrid, or SMTP" },
  webhook:  { label: "Webhook",  icon: Link2,           color: "border-l-chart-5",  hue: "chart-5",  description: "HTTP in and out: talk to Polpo from Shortcuts or scripts, POST notifications to any endpoint" },
  push:     { label: "Push",     icon: Monitor,         color: "border-l-primary", hue: "primary", description: "Send PWA push notifications to subscribed browsers" },
};

const ALL_CHANNEL_TYPES: NotificationChannelType[] = ["telegram", "whatsapp", "slack", "email", "webhook", "push"];

/** Each channel type's colour: a categorical chart token (Configuration → Appearance), muted for unknown types. */
const HUE_STYLES: Record<string, { iconBg: string; iconRing: string; gradient: string; pip: string; text: string; glow: string; hoverBorder: string; line: string; chip: string }> = {
  "chart-1": { iconBg: "bg-chart-1/12", iconRing: "ring-chart-1/30", gradient: "from-chart-1/15", pip: "bg-chart-1", text: "text-chart-1", glow: "bg-chart-1/25", hoverBorder: "hover:border-chart-1/40", line: "via-chart-1/70", chip: "border-chart-1/25 bg-chart-1/10 text-chart-1" },
  "chart-2": { iconBg: "bg-chart-2/12", iconRing: "ring-chart-2/30", gradient: "from-chart-2/15", pip: "bg-chart-2", text: "text-chart-2", glow: "bg-chart-2/25", hoverBorder: "hover:border-chart-2/40", line: "via-chart-2/70", chip: "border-chart-2/25 bg-chart-2/10 text-chart-2" },
  "chart-3": { iconBg: "bg-chart-3/12", iconRing: "ring-chart-3/30", gradient: "from-chart-3/15", pip: "bg-chart-3", text: "text-chart-3", glow: "bg-chart-3/25", hoverBorder: "hover:border-chart-3/40", line: "via-chart-3/70", chip: "border-chart-3/25 bg-chart-3/10 text-chart-3" },
  "chart-4": { iconBg: "bg-chart-4/12", iconRing: "ring-chart-4/30", gradient: "from-chart-4/15", pip: "bg-chart-4", text: "text-chart-4", glow: "bg-chart-4/25", hoverBorder: "hover:border-chart-4/40", line: "via-chart-4/70", chip: "border-chart-4/25 bg-chart-4/10 text-chart-4" },
  "chart-5": { iconBg: "bg-chart-5/12", iconRing: "ring-chart-5/30", gradient: "from-chart-5/15", pip: "bg-chart-5", text: "text-chart-5", glow: "bg-chart-5/25", hoverBorder: "hover:border-chart-5/40", line: "via-chart-5/70", chip: "border-chart-5/25 bg-chart-5/10 text-chart-5" },
  "primary": { iconBg: "bg-primary/12", iconRing: "ring-primary/30", gradient: "from-primary/15", pip: "bg-primary", text: "text-primary", glow: "bg-primary/25", hoverBorder: "hover:border-primary/40", line: "via-primary/70", chip: "border-primary/25 bg-primary/10 text-primary" },
  "muted-foreground": { iconBg: "bg-muted-foreground/12", iconRing: "ring-muted-foreground/30", gradient: "from-muted-foreground/15", pip: "bg-muted-foreground", text: "text-muted-foreground", glow: "bg-muted-foreground/25", hoverBorder: "hover:border-muted-foreground/40", line: "via-muted-foreground/70", chip: "border-muted-foreground/25 bg-muted-foreground/10 text-muted-foreground" },
};

/** Default empty config per channel type */
function defaultChannelConfig(type: NotificationChannelType): NotificationChannelConfig {
  switch (type) {
    case "telegram": return { type, botToken: "", chatId: "", gateway: { enableInbound: false, dmPolicy: "pairing" } };
    case "whatsapp": return { type, chatId: "", profileDir: "default", gateway: { enableInbound: false, dmPolicy: "pairing" } };
    case "slack":    return { type, webhookUrl: "" };
    case "email":    return { type, provider: "resend", apiKey: "", from: "", to: [] };
    case "webhook":  return { type, gateway: { enableInbound: false, dmPolicy: "open" } };
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
      {hint && <p className="text-micro text-muted-foreground leading-tight">{hint}</p>}
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

/** "Continue web chat · never expires" / "Separate · 60 min" */
function describeSession(mode?: string, idleMinutes?: number): string {
  const conversation = mode === "shared" ? "Continue web chat" : "Separate";
  const idle = idleMinutes === 0 ? "never expires" : `${idleMinutes ?? 60} min`;
  return `${conversation} · ${idle}`;
}

/** Bot, interlocutor, conversation and menu summary on a Telegram channel card. */
function TelegramCardDetails({ name, ch }: { name: string; ch: NotificationChannelConfig }) {
  const gateway = ch.gateway;
  const info = useTelegramChannelInfo(api, name, gateway?.enableInbound ? gateway.agent : undefined);
  const overrides = Object.entries(gateway?.agentSessions ?? {});
  return (
    <>
      <Row label="Bot" value={info.botUsername ? `@${info.botUsername}` : "—"} mono wrap />
      {gateway?.enableInbound && (
        <>
          <Row label="Talks to" value={gateway.agent ?? "Polpo · /agent to switch"} mono wrap />
          {gateway.replyTo && <Row label="Replies" value={`→ ${gateway.replyTo.channel}`} mono wrap />}
          <Row label="Conversation" value={describeSession(gateway.sessionMode, gateway.sessionIdleMinutes)} wrap />
          {overrides.map(([agent, s]) => (
            <Row key={agent} label={<span className="pl-2">↳ {agent}</span>} value={describeSession(s.sessionMode ?? gateway.sessionMode, s.sessionIdleMinutes ?? gateway.sessionIdleMinutes)} wrap />
          ))}
          <Row
            label="Menu"
            value={gateway.agent
              ? `${info.suggestionCount ?? "…"} suggestion${info.suggestionCount === 1 ? "" : "s"} + /new /help`
              : "/agent /polpo /new /status … (9)"}
            wrap
          />
          <Row
            label="Groups"
            value={info.canReadAllGroupMessages === false
              ? "Privacy mode on: in groups only commands and replies reach the bot. BotFather → /setprivacy → Disable, then add the bot again."
              : "Add the bot to a group: enabled at once if you add it, or /enable"}
            wrap
          />
        </>
      )}
    </>
  );
}

function channelSupportsInbound(type: NotificationChannelType): boolean {
  return type === "telegram" || type === "whatsapp" || type === "webhook";
}

/** Random secret for inbound webhooks (64 hex chars). */
function generateInboundSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function webhookInboundUrl(channelName: string): string {
  return new URL(apiUrl(`/api/v1/channels/${encodeURIComponent(channelName)}/inbound`), window.location.origin).toString();
}

/** Endpoint, secret and a ready-to-copy example for an inbound webhook channel. */
function WebhookInboundSetup({ config, onChange, channelName }: {
  config: NotificationChannelConfig;
  onChange: (config: NotificationChannelConfig) => void;
  channelName?: string;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (label: string, value: string) => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    });
  };
  const url = channelName ? webhookInboundUrl(channelName) : "";
  const secret = config.inboundSecret ?? "";
  // The server never returns stored secrets ("••••1234"); only a freshly generated one can be copied.
  const secretHidden = isMaskedSecret(secret);
  const example = `curl -X POST '${url || "<url>"}' \\\n  -H 'Authorization: Bearer ${secret ? "<secret>" : "<generate a secret>"}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"sender":"my-iphone","text":"Hi!"}'`;

  return (
    <div className="space-y-2 rounded-md border border-chart-5/20 bg-chart-5/5 px-2.5 py-2.5">
      <Field label="Endpoint" hint={channelName ? "POST messages here. The reply comes back in the response." : "Save the channel to get its URL."}>
        <div className="flex gap-1.5">
          <Input readOnly className="h-8 text-xs font-mono" value={url || "available after saving"} />
          {url && (
            <Button type="button" variant="outline" size="sm" className="h-8 shrink-0 gap-1 text-caption" onClick={() => copy("url", url)}>
              <Copy className="h-3 w-3" /> {copied === "url" ? "Copied" : "Copy"}
            </Button>
          )}
        </div>
      </Field>
      <Field label="Secret" hint={secretHidden
        ? "Stored secret is hidden. Click New to generate (and copy) a replacement, then save."
        : "Sent as Authorization: Bearer <secret>. Anyone with it can talk to this channel."}>
        <div className="flex gap-1.5">
          <Input className="h-8 text-xs font-mono" placeholder="Generate one" value={secret}
            onChange={(e) => onChange({ ...config, inboundSecret: e.target.value || undefined })} />
          {secret && !secretHidden && (
            <Button type="button" variant="outline" size="sm" className="h-8 shrink-0 gap-1 text-caption" onClick={() => copy("secret", secret)}>
              <Copy className="h-3 w-3" /> {copied === "secret" ? "Copied" : "Copy"}
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" className="h-8 shrink-0 gap-1 text-caption"
            onClick={() => onChange({ ...config, inboundSecret: generateInboundSecret() })}>
            <RefreshCw className="h-3 w-3" /> {secret ? "New" : "Generate"}
          </Button>
        </div>
      </Field>
      <div className="grid gap-1 text-caption leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">iOS Shortcuts</span>
        <span>1. Ask for Input (text or dictation).</span>
        <span>2. Get Contents of URL: the endpoint above with <code>?format=text</code>, method POST, header <code>Authorization</code> = <code>Bearer &lt;secret&gt;</code>, request body JSON with <code>text</code> = the input and <code>sender</code> = a name for your device. Use Form with a file field to send photos or documents.</span>
        <span>3. Show Result or Speak Text — or set <b>Replies go to</b> below (or <code>replyTo</code> in the body) to get the answer on Telegram instead: the request returns at once and the reply arrives there.</span>
        <span>Commands work as on Telegram: /agent NAME, /polpo, /new, /help and the agent's suggestions. Without <code>?format=text</code> the response is JSON with messages, buttons and files (base64).</span>
      </div>
      <pre className="overflow-x-auto rounded-xs bg-muted/40 px-2 py-1.5 text-micro font-mono leading-relaxed">{example}</pre>
    </div>
  );
}

function splitList(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function ChannelConceptPanel({ type }: { type: NotificationChannelType }) {
  const product = productName(useInstanceBranding());
  const meta = CHANNEL_META[type];
  const inbound = channelSupportsInbound(type);

  return (
    <div className="rounded-lg border border-border/40 bg-muted/15 px-3 py-2.5 space-y-2">
      <div className="flex items-start gap-2">
        <Bell className="mt-0.5 h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <div className="min-w-0">
          <p className="text-xs font-medium">Notification delivery</p>
          <p className="text-caption leading-relaxed text-muted-foreground">
            Outbound path: {product} sends alerts, task updates, approvals, or rule events through this {meta?.label ?? type} channel.
          </p>
        </div>
      </div>
      <div className="flex items-start gap-2">
        <MessageSquare className="mt-0.5 h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <div className="min-w-0">
          <p className="text-xs font-medium">Inbound gateway</p>
          <p className="text-caption leading-relaxed text-muted-foreground">
            {inbound
              ? `Inbound path: people can message ${product} from this channel and the gateway routes the text into a ${product} session.`
              : "This channel is delivery-only here. It can receive notifications, but it does not expose a chat gateway."}
          </p>
        </div>
      </div>
    </div>
  );
}

function ChannelSetupGuide({ type }: { type: NotificationChannelType }) {
  const product = productName(useInstanceBranding());
  if (type === "telegram") {
    return (
      <div className="rounded-lg border border-info/20 bg-info/5 px-3 py-2.5">
        <p className="text-xs font-medium">Telegram setup</p>
        <div className="mt-1 grid gap-1 text-caption leading-relaxed text-muted-foreground">
          <span>1. In Telegram, open <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-info hover:underline">@BotFather</a>, send /newbot and paste the token below.</span>
          <span>2. Press <b>Find my chat</b> and send any message to your bot — the chat ID fills in after you confirm.</span>
          <span>3. To talk to {product} from Telegram, turn on the inbound gateway. Save.</span>
        </div>
      </div>
    );
  }

  if (type === "whatsapp") {
    return (
      <div className="rounded-lg border border-success/20 bg-success/5 px-3 py-2.5">
        <p className="text-xs font-medium">WhatsApp setup</p>
        <div className="mt-1 grid gap-1 text-caption leading-relaxed text-muted-foreground">
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
      const res = await apiFetch(`${appConfig.baseUrl}/api/v1/whatsapp/profiles`, { credentials: "include" });
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
        const res = await apiFetch(`${appConfig.baseUrl}/api/v1/whatsapp/login/${session.id}`, { credentials: "include" });
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
      const res = await apiFetch(`${appConfig.baseUrl}/api/v1/whatsapp/login/start`, {
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
      await apiFetch(`${appConfig.baseUrl}/api/v1/whatsapp/login/${session.id}/cancel`, {
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
      const res = await apiFetch(`${appConfig.baseUrl}/api/v1/whatsapp/logout`, {
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
            <Badge variant={authenticated ? "secondary" : "outline"} className={cn("h-4 text-micro px-1.5", authenticated && "text-success")}>
              {authenticated ? "Connected" : session?.status === "qr" ? "Scan QR" : "Not linked"}
            </Badge>
          </div>
          <p className="mt-1 text-caption leading-relaxed text-muted-foreground">
            Pair this server as a WhatsApp linked device. The profile powers tool access; notifications and inbound stay optional.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 text-caption gap-1.5" onClick={() => void loadProfiles()}>
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
        <div className="rounded-md border border-border/30 bg-muted/15 px-2.5 py-2 text-caption text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for WhatsApp QR code...
        </div>
      )}

      {session?.status === "qr" && (
        <div className="rounded-lg border border-success/20 bg-success/5 p-3 space-y-2">
          <p className="text-xs font-medium">Scan with WhatsApp</p>
          <p className="text-caption leading-relaxed text-muted-foreground">
            Open WhatsApp, go to Linked Devices, then scan this QR code.
          </p>
          {qrDataUrl ? (
            <img src={qrDataUrl} alt="WhatsApp login QR code" className="h-[260px] w-[260px] rounded-md border border-border/40 bg-canvas p-2" />
          ) : (
            <div className="flex h-[260px] w-[260px] items-center justify-center rounded-md border border-border/40 bg-muted/20">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>
      )}

      {session && ["connected", "error", "expired", "cancelled"].includes(session.status) && (
        <div className={cn(
          "rounded-md border px-2.5 py-2 text-caption leading-relaxed",
          session.status === "connected"
            ? "border-success/25 bg-success/10 text-success"
            : "border-destructive/25 bg-destructive/10 text-destructive",
        )}>
          {session.status === "connected"
            ? "WhatsApp linked. The server will reconnect the bridge when this profile is configured."
            : session.error ?? `WhatsApp login ${session.status}.`}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/25 bg-destructive/10 px-2.5 py-2 text-caption leading-relaxed text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}

function DeliveryFields({ config, onChange, gatewayRunning, channelName, savedBotToken }: {
  config: NotificationChannelConfig;
  onChange: (patch: Partial<NotificationChannelConfig>) => void;
  gatewayRunning: boolean;
  channelName?: string;
  /** Bot token of the saved channel; while it is unchanged the bot is already polled by the server. */
  savedBotToken?: string;
}) {
  const product = productName(useInstanceBranding());
  const botActive = !!savedBotToken && savedBotToken.trim() === (config.botToken ?? "").trim();
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
            <Input data-setup-field="botToken" className="h-8 text-xs font-mono" placeholder="123456:ABC-DEF..." value={config.botToken ?? ""} onChange={(e) => set({ botToken: e.target.value })} />
          </Field>
          <TelegramTokenCheck api={api} botToken={config.botToken} channel={gatewayRunning || isMaskedSecret(config.botToken) ? channelName : undefined} />
          <Field label="Chat ID" hint="Where notifications are sent. Use Find my chat (new bot) or Connect my Telegram (saved bot) to fill it in.">
            <Input className="h-8 text-xs font-mono" placeholder="-1001234567890" value={config.chatId ?? ""} onChange={(e) => set({ chatId: e.target.value })} />
          </Field>
          {botActive ? (
            <TelegramConnect
              api={api}
              channel={channelName}
              gatewayRunning={gatewayRunning}
              currentChatId={config.chatId}
              onPaired={(chatId) => { if (!config.chatId) set({ chatId }); }}
            />
          ) : (
            <TelegramChatFinder
              api={api}
              botToken={config.botToken}
              currentChatId={config.chatId}
              onConfirm={(chat) => set({ chatId: chat.chatId })}
            />
          )}
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
            <Input data-setup-field="webhookUrl" className="h-8 text-xs font-mono" placeholder="https://hooks.slack.com/services/..." value={config.webhookUrl ?? ""} onChange={(e) => set({ webhookUrl: e.target.value })} />
          </Field>
          <Field label="API Key" hint="Optional - enables file uploads">
            <Input data-setup-field="apiKey" className="h-8 text-xs font-mono" placeholder="xoxb-..." value={config.apiKey ?? ""} onChange={(e) => set({ apiKey: e.target.value || undefined })} />
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
              <Input data-setup-field="apiKey" className="h-8 text-xs font-mono" placeholder="re_..." value={config.apiKey ?? ""} onChange={(e) => set({ apiKey: e.target.value })} />
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
          <Field label="Notification URL" hint={`Optional: ${product} POSTs notifications here as JSON. Leave empty for an inbound-only webhook.`}>
            <Input data-setup-field="url" className="h-8 text-xs font-mono" placeholder="https://example.com/webhook" value={config.url ?? ""} onChange={(e) => set({ url: e.target.value || undefined })} />
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
          <p className="text-micro text-muted-foreground leading-tight">
            VAPID keys are generated once and stored in .polpo/push.json. Override them with config values or env references only when you need stable keys across deployments.
          </p>
        </>
      )}
    </div>
  );
}

function InboundGatewayForm({ config, onChange, channelName, otherChannels = [] }: {
  config: NotificationChannelConfig;
  onChange: (config: NotificationChannelConfig) => void;
  channelName?: string;
  otherChannels?: { name: string; type: NotificationChannelType }[];
}) {
  const product = productName(useInstanceBranding());
  const agentNames = useAgentNames(api);
  const gateway = config.gateway ?? {};
  const enabled = gateway.enableInbound === true;
  const isWebhook = config.type === "webhook";
  // A webhook is authenticated by its secret, so it defaults to open.
  const defaultPolicy: GatewayPolicy = isWebhook ? "open" : "pairing";
  const policy = gateway.dmPolicy ?? defaultPolicy;
  const updateGateway = (patch: Partial<GatewayConfig>) => {
    const next: NotificationChannelConfig = {
      ...config,
      gateway: {
        dmPolicy: defaultPolicy,
        ...gateway,
        ...patch,
      },
    };
    if (isWebhook && patch.enableInbound && !next.inboundSecret) next.inboundSecret = generateInboundSecret();
    onChange(next);
  };

  return (
    <div className="rounded-lg border border-border/40 bg-background/50 px-3 py-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold">Inbound gateway</span>
          </div>
          <p className="mt-1 text-caption leading-relaxed text-muted-foreground">
            Let people send messages to {product} from {CHANNEL_META[config.type]?.label ?? config.type}. This is separate from outbound notifications.
          </p>
        </div>
        <Button
          type="button"
          variant={enabled ? "secondary" : "outline"}
          size="sm"
          className="h-7 shrink-0 text-caption gap-1.5"
          onClick={() => updateGateway({ enableInbound: !enabled })}
        >
          <ToggleRight className={cn("h-3.5 w-3.5", enabled && "text-success")} />
          {enabled ? "Enabled" : "Off"}
        </Button>
      </div>

      {enabled ? (
        <>
          {isWebhook && <WebhookInboundSetup config={config} onChange={onChange} channelName={channelName} />}
          <div className="grid grid-cols-2 gap-2">
            <Field label="DM Policy" hint={`Controls who can start a ${product} session.`}>
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
            <Field label="Idle Timeout" hint="Minutes of inactivity before a new conversation starts. 0 = never.">
              <Input
                className="h-8 text-xs font-mono"
                type="number"
                min={0}
                placeholder="60"
                value={gateway.sessionIdleMinutes ?? ""}
                onChange={(e) => updateGateway({ sessionIdleMinutes: e.target.value ? Number(e.target.value) : undefined })}
              />
            </Field>
          </div>
          {(config.type === "telegram" || isWebhook) && (
            <Field label="Dedicated agent" hint={isWebhook
              ? "Send every message to one agent, without /agent. Leave on Polpo to talk to the orchestrator and switch with /agent."
              : "Give an important agent its own bot: every message goes to it, without /agent. Leave on Polpo for the main bot."}>
              <Select value={gateway.agent ?? "__polpo__"} onValueChange={(v) => updateGateway({ agent: v === "__polpo__" ? undefined : v })}>
                <SelectTrigger className="h-8 text-xs w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__polpo__" className="text-xs">Polpo (orchestrator, /agent to switch)</SelectItem>
                  {agentNames.map((name) => <SelectItem key={name} value={name} className="text-xs">{name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field label="Replies go to" hint="Conversation pipe: answer here, or deliver replies through another channel (e.g. in from Shortcuts, out on Telegram).">
            <Select
              value={gateway.replyTo?.channel ?? "__origin__"}
              onValueChange={(v) => updateGateway({ replyTo: v === "__origin__" ? undefined : { ...gateway.replyTo, channel: v } })}
            >
              <SelectTrigger className="h-8 text-xs w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__origin__" className="text-xs">This channel</SelectItem>
                {otherChannels.map((c) => (
                  <SelectItem key={c.name} value={c.name} className="text-xs">{c.name} ({CHANNEL_META[c.type]?.label ?? c.type})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {gateway.replyTo && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Chat ID" hint="Optional. Default: the target's chat ID, or its only paired person.">
                <Input
                  className="h-8 text-xs font-mono"
                  placeholder="auto"
                  value={gateway.replyTo.chatId ?? ""}
                  onChange={(e) => updateGateway({ replyTo: { ...gateway.replyTo!, chatId: e.target.value.trim() || undefined } })}
                />
              </Field>
              <Field label="Show the message" hint="Echo the incoming message on the target before the reply.">
                <Select
                  value={gateway.replyTo.echoInbound === false ? "no" : "yes"}
                  onValueChange={(v) => updateGateway({ replyTo: { ...gateway.replyTo!, echoInbound: v === "no" ? false : undefined } })}
                >
                  <SelectTrigger className="h-8 text-xs w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="yes" className="text-xs">Yes</SelectItem>
                    <SelectItem value="no" className="text-xs">No, only the reply</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
          )}
          <Field label="Conversation" hint="How chats from this channel relate to the web chat.">
            <Select value={gateway.sessionMode ?? "per-peer"} onValueChange={(v) => updateGateway({ sessionMode: v as GatewayConfig["sessionMode"] })}>
              <SelectTrigger className="h-8 text-xs w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="per-peer" className="text-xs">Separate from web chat</SelectItem>
                <SelectItem value="shared" className="text-xs">Continue the web chat</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <p className="-mt-1.5 text-micro leading-relaxed text-muted-foreground">
            {(gateway.sessionMode ?? "per-peer") === "shared"
              ? "Messages continue the latest conversation with the same interlocutor (Polpo or the agent chosen with /agent), the one the web chat resumes."
              : "Each person gets their own conversations here, one per interlocutor. They appear in the web chat list but are not resumed automatically."}
          </p>
          <AgentSessionOverrides
            api={api}
            value={gateway.agentSessions}
            onChange={(agentSessions) => updateGateway({ agentSessions })}
          />
          <Field
            label="Allow From"
            hint={policy === "allowlist"
              ? "Comma-separated external IDs allowed to message Polpo."
              : policy === "open"
                ? "Optional. Leave empty for open access, or document expected IDs."
                : "Optional. With pairing, connect people with an invite link or approve their requests on the channel card."}
          >
            <Input
              className="h-8 text-xs font-mono"
              placeholder={config.type === "whatsapp" ? "+393331234567, 393331234567" : isWebhook ? "my-iphone, office-script" : "123456789, -1001234567890"}
              value={(gateway.allowFrom ?? []).join(", ")}
              onChange={(e) => {
                const allowFrom = splitList(e.target.value);
                updateGateway({ allowFrom: allowFrom.length > 0 ? allowFrom : undefined });
              }}
            />
          </Field>
          <div className="rounded-md border border-border/30 bg-muted/15 px-2.5 py-2 text-caption leading-relaxed text-muted-foreground">
            {policy === "pairing" && "Unknown people receive a pairing code. Approve them from the channel card, or send them an invite link that pairs them automatically."}
            {policy === "allowlist" && "Allowlist accepts only configured IDs. Use this for production channels with known operators."}
            {policy === "open" && (isWebhook
              ? "Open accepts any caller that knows the secret. Use Allowlist to also restrict the sender names."
              : "Open allows any direct message that reaches the channel. Use only for controlled or disposable endpoints.")}
            {policy === "disabled" && "Disabled keeps the gateway block configured but rejects inbound messages."}
          </div>
        </>
      ) : (
        <p className="rounded-md border border-border/30 bg-muted/15 px-2.5 py-2 text-caption leading-relaxed text-muted-foreground">
          Inbound is off. This channel can still send notifications; messages from users will not become {product} conversations.
        </p>
      )}
    </div>
  );
}

/** Channel config form — renders type-specific fields */
function ChannelForm({ config, onChange, gatewayRunning, channelName, savedBotToken, otherChannels = [] }: {
  config: NotificationChannelConfig;
  onChange: (config: NotificationChannelConfig) => void;
  /** The saved version of this channel has inbound enabled. */
  gatewayRunning: boolean;
  channelName?: string;
  savedBotToken?: string;
  /** Other configured channels, possible targets of the conversation pipe. */
  otherChannels?: { name: string; type: NotificationChannelType }[];
}) {
  const set = (patch: Partial<NotificationChannelConfig>) => onChange({ ...config, ...patch });

  return (
    <div className="space-y-3">
      <ChannelConceptPanel type={config.type} />
      <ChannelSetupGuide type={config.type} />
      <DeliveryFields config={config} onChange={set} gatewayRunning={gatewayRunning} channelName={channelName} savedBotToken={savedBotToken} />
      {channelSupportsInbound(config.type) && (
        <InboundGatewayForm config={config} onChange={onChange} channelName={channelName} otherChannels={otherChannels} />
      )}
    </div>
  );
}

/** Interactive channel card with edit / delete / test */
interface ChannelTestResult {
  success: boolean;
  error?: string;
}

/** Is the channel ready to deliver? (what the card's status pill shows) */
function channelReadiness(ch: NotificationChannelConfig): { ok: boolean; label: string } {
  switch (ch.type) {
    case "telegram": return ch.botToken ? { ok: true, label: ch.gateway?.enableInbound ? "Live · two-way" : "Live" } : { ok: false, label: "Needs bot token" };
    case "slack": return ch.webhookUrl ? { ok: true, label: "Live" } : { ok: false, label: "Needs webhook" };
    case "whatsapp": return { ok: true, label: ch.gateway?.enableInbound ? "Live · two-way" : "Live" };
    case "email": return ch.apiKey || ch.host ? { ok: true, label: "Live" } : { ok: false, label: "Needs credentials" };
    case "webhook": return ch.url || ch.gateway?.enableInbound ? { ok: true, label: ch.gateway?.enableInbound ? (ch.url ? "Live · two-way" : "Inbound only") : "Live" } : { ok: false, label: "Needs URL" };
    default: return { ok: true, label: "Live" };
  }
}

/** The two to four facts worth seeing at a glance, per channel type. */
function channelFacts(ch: NotificationChannelConfig): Array<{ label: string; value: React.ReactNode; mono?: boolean }> {
  const gateway = ch.gateway;
  switch (ch.type) {
    case "telegram": return [
      { label: "Chat", value: ch.chatId || "—", mono: true },
      { label: "Talks to", value: gateway?.enableInbound ? (gateway.agent ?? getOrchestratorName()) : "—" },
    ];
    case "slack": return [
      { label: "Webhook", value: ch.webhookUrl ? "configured" : "—" },
      { label: "Files", value: ch.apiKey ? "uploads on" : "off" },
    ];
    case "whatsapp": return [
      { label: "Chat", value: ch.chatId || "—", mono: true },
      { label: "Profile", value: ch.profileDir || "default", mono: true },
    ];
    case "email": return [
      { label: "Provider", value: ch.provider ?? "resend" },
      { label: "Recipients", value: ch.to?.length ? String(ch.to.length) : "—" },
      ...(ch.from ? [{ label: "From", value: ch.from, mono: true }] : []),
    ];
    case "webhook": return [
      { label: "Outbound", value: ch.url ? "on" : "off" },
      { label: "Talks to", value: gateway?.enableInbound ? (gateway.agent ?? getOrchestratorName()) : "—" },
    ];
    case "push": return [
      { label: "Urgency", value: ch.urgency ?? "normal" },
      { label: "TTL", value: `${ch.ttl ?? 3600}s`, mono: true },
    ];
    default: return [];
  }
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
  const meta = CHANNEL_META[ch.type] ?? { label: ch.type, icon: Bell, color: "border-l-muted-foreground", hue: "muted-foreground" };
  const hue = HUE_STYLES[meta.hue] ?? HUE_STYLES["muted-foreground"];
  const gateway = ch.gateway;
  const ready = channelReadiness(ch);
  const facts = channelFacts(ch);
  const failed = testResult?.success === false;

  return (
    <Card className={cn(
      "group relative overflow-hidden border border-border/40 bg-card py-0 gap-0",
      "transition-all duration-300 hover:-translate-y-0.5 hover:shadow-raised",
      hue.hoverBorder,
    )}>
      {/* Brand light: a hairline across the top and a soft glow behind the mark */}
      <div className={cn("absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent to-transparent", hue.line)} aria-hidden />
      <div className={cn("absolute -top-16 -left-10 h-40 w-40 rounded-pill blur-glow opacity-60 transition-opacity duration-300 group-hover:opacity-100", hue.glow)} aria-hidden />
      <div className={cn("absolute inset-0 pointer-events-none bg-gradient-to-br via-transparent to-transparent", hue.gradient)} aria-hidden />

      <CardContent className="relative p-0">
        {/* Header */}
        <div className="flex items-start gap-3.5 px-4 pt-4">
          <div className={cn(
            "relative h-12 w-12 rounded-2xl flex items-center justify-center shrink-0 ring-1 bg-background/60 backdrop-blur-surface",
            hue.iconRing,
          )}>
            <ChannelLogo type={ch.type} size={26} />
          </div>
          <div className="flex-1 min-w-0 pt-0.5">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-h3 font-semibold tracking-tight truncate">{name}</span>
            </div>
            <p className={cn("text-caption mt-0.5 font-medium", hue.text)}>{meta.label}</p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <span className={cn(
              "inline-flex items-center gap-1.5 rounded-pill border px-2 py-0.5 text-caption font-medium",
              failed ? "border-destructive/30 bg-destructive/10 text-destructive"
                : ready.ok ? "border-success/25 bg-success/10 text-success"
                : "border-warning/25 bg-warning/10 text-warning",
            )}>
              <span className="relative flex h-1.5 w-1.5">
                {ready.ok && !failed && <span className="absolute inline-flex h-full w-full animate-ping rounded-pill bg-success opacity-60" />}
                <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-pill", failed ? "bg-destructive" : ready.ok ? "bg-success" : "bg-warning")} />
              </span>
              {failed ? "Test failed" : ready.label}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground/60 hover:text-destructive opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
              onClick={onDelete}
              disabled={deleting}
              aria-label="Delete channel"
            >
              {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </div>

        {/* Capabilities */}
        <div className="flex flex-wrap items-center gap-1.5 px-4 pt-3">
          <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-micro", hue.chip)}>
            <Send className="h-2.5 w-2.5" /> Notifications
          </span>
          {gateway?.enableInbound && (
            <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-micro", hue.chip)}>
              <Zap className="h-2.5 w-2.5" /> Inbound chat
            </span>
          )}
          {gateway?.enableInbound && (
            <span className="inline-flex items-center rounded-md border border-border/40 bg-muted/30 px-1.5 py-0.5 text-micro text-muted-foreground">
              DM · {gateway.dmPolicy ?? "allowlist"}
            </span>
          )}
          {gateway?.agent && (
            <span className="inline-flex items-center rounded-md border border-border/40 bg-muted/30 px-1.5 py-0.5 text-micro text-muted-foreground">
              → {gateway.agent}
            </span>
          )}
        </div>

        {/* Facts at a glance */}
        {facts.length > 0 && (
          <div className={cn("grid gap-px mx-4 mt-3 overflow-hidden rounded-xl border border-border/30 bg-border/30", facts.length >= 3 ? "grid-cols-3" : "grid-cols-2")}>
            {facts.map((fact) => (
              <div key={fact.label} className="bg-card/90 px-3 py-2 min-w-0">
                <div className="text-label text-muted-foreground/70">{fact.label}</div>
                <div className={cn("mt-0.5 text-small font-medium truncate", fact.mono && "font-mono text-caption")}>{fact.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Everything else, one click away */}
        <Collapsible>
          <CollapsibleTrigger className="group/details flex w-full items-center gap-1 px-4 pt-3 text-caption text-muted-foreground hover:text-foreground transition-colors">
            <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]/details:rotate-90" />
            Details
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-0.5 px-4 pt-1.5">
              {ch.type === "telegram" && (
                <>
                  <Row label="Bot Token" value={ch.botToken ? "*** configured" : "not set"} mono />
                  <TelegramCardDetails name={name} ch={ch} />
                </>
              )}
              {ch.type === "email" && (
                <>
                  {(ch.to?.length ?? 0) > 0 && <Row label="To" value={ch.to!.join(", ")} mono wrap />}
                  <StatusDot ok={!!ch.apiKey || !!ch.host} label={ch.apiKey ? "API key set" : ch.host ? "SMTP configured" : "No credentials"} />
                </>
              )}
              {ch.type === "webhook" && (
                <>
                  <Row label="Notifications" value={ch.url || "off"} mono wrap />
                  {gateway?.enableInbound && (
                    <>
                      <Row label="Inbound" value={`/api/v1/channels/${name}/inbound${ch.inboundSecret ? "" : " · no secret"}`} mono wrap />
                      <Row label="Replies" value={gateway.replyTo ? `→ ${gateway.replyTo.channel}` : "in the HTTP response"} mono wrap />
                      <Row label="Conversation" value={describeSession(gateway.sessionMode, gateway.sessionIdleMinutes)} wrap />
                      {Object.entries(gateway.agentSessions ?? {}).map(([agent, s]) => (
                        <Row key={agent} label={<span className="pl-2">↳ {agent}</span>} value={describeSession(s.sessionMode ?? gateway.sessionMode, s.sessionIdleMinutes ?? gateway.sessionIdleMinutes)} wrap />
                      ))}
                    </>
                  )}
                  {ch.headers && Object.keys(ch.headers).length > 0 && <Row label="Headers" value={`${Object.keys(ch.headers).length} custom`} />}
                </>
              )}
              {ch.type === "push" && (
                <Row label="VAPID" value={ch.vapidPublicKey || ch.vapidPrivateKey ? "custom keys" : "project generated"} mono />
              )}
              {ch.type === "whatsapp" && <Row label="Type" value={ch.type} mono />}
              {ch.type === "slack" && <Row label="Webhook" value={ch.webhookUrl ? "*** configured" : "not set"} mono />}
              {!["telegram", "email", "webhook", "push", "whatsapp", "slack"].includes(ch.type) && <Row label="Type" value={ch.type} mono />}
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* Who may talk to it — always visible when inbound is on */}
        {gateway?.enableInbound && (ch.type === "telegram" || ch.type === "whatsapp") && (
          <div className="px-4 pt-2">
            <ChannelAccessPanel api={api} channel={ch.type} />
          </div>
        )}

        {failed && testResult?.error && (
          <div className="mx-4 mt-3 rounded-lg border border-destructive/25 bg-destructive/10 px-2.5 py-1.5 text-caption leading-relaxed text-destructive">
            {testResult.error}
          </div>
        )}

        {/* Actions */}
        <div className="mt-3 flex items-center gap-1.5 border-t border-border/30 bg-muted/10 px-3 py-2">
          <Button variant="ghost" size="sm" className="h-7 rounded-pill text-caption gap-1 px-3" onClick={onEdit}>
            <Pencil className="h-3 w-3" /> Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-7 rounded-pill text-caption gap-1 px-3 transition-colors",
              testResult?.success === true && "text-success bg-success/10 hover:bg-success/15",
              failed && "text-destructive hover:bg-destructive/10",
            )}
            onClick={onTest}
            disabled={testing}
          >
            {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Activity className="h-3 w-3" />}
            {testing ? "Testing…" : testResult?.success === true ? "Reachable" : failed ? "Retry test" : "Send test"}
          </Button>
          <span className="ml-auto font-mono text-micro text-muted-foreground/50">{ch.type}</span>
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
    <Card className="py-0">
      <CardContent className="p-3 space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <Monitor className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-sm font-semibold">This browser</span>
              <Badge variant={state.subscribed ? "default" : "outline"} className="text-micro">
                {state.subscribed ? "Subscribed" : state.permission === "denied" ? "Blocked" : "Not subscribed"}
              </Badge>
            </div>
            <p className="text-caption text-muted-foreground">
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
          <div className="rounded-md border border-destructive/25 bg-destructive/10 px-2 py-1.5 text-micro leading-relaxed text-destructive">
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
  const product = productName(useInstanceBranding());
  const channels = objectOrEmpty<NotificationChannelConfig>(
    objectOrEmpty(settings.notifications).channels,
  );

  // Dialog state (a link from an assistant, ?channel=<name>, opens that channel's form)
  const [linked] = useState(() => {
    const name = readSetupParams().channel;
    return name && channels[name] ? name : undefined;
  });
  const [editOpen, setEditOpen] = useState(!!linked);
  const [editName, setEditName] = useState(linked ?? "");
  const [editConfig, setEditConfig] = useState<NotificationChannelConfig>(() => (linked ? { ...channels[linked] } : defaultChannelConfig("telegram")));
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
      notifySetupSaved();
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
      const res = await apiFetch(`${appConfig.baseUrl}/api/v1/config/channels/${encodeURIComponent(name)}/test`, { method: "POST" });
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
              <p className="mt-0.5 text-caption leading-relaxed text-muted-foreground">
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
              <p className="mt-0.5 text-caption leading-relaxed text-muted-foreground">
                Optional chat entrypoint where Telegram or WhatsApp messages become {product} sessions.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2.5 min-w-0">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-muted/40 shrink-0">
              <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold">Agent tools</p>
              <p className="mt-0.5 text-caption leading-relaxed text-muted-foreground">
                Separate capabilities an agent may use to read or send through a service.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <SectionHeader icon={Monitor} title="PWA Push" className="mb-0" />
        </div>
        <PushBrowserControls hasPushChannel={hasPushChannel} />
        {!hasPushChannel && (
          <p className="mt-2 text-caption text-muted-foreground">
            Add a Push channel first, then enable notifications for this browser.
          </p>
        )}
      </section>

      {/* Configured channels */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <SectionHeader icon={Bell} title="Channels" className="mb-0" />
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => setTypePickerOpen(true)}>
            <Plus className="h-3 w-3" /> Add channel
          </Button>
        </div>

        {Object.keys(channels).length > 0 ? (
          <div className="columns-1 lg:columns-2 gap-4 [&>*]:mb-4 [&>*]:break-inside-avoid">
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
          <SectionHeader icon={Zap} title="Quick Add" className="mb-2" />
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
                    <p className="text-micro text-muted-foreground/40">Click to add</p>
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
                  <div className={cn("h-10 w-10 rounded-lg flex items-center justify-center shrink-0 bg-muted/40 ring-1", HUE_STYLES[meta.hue]?.iconRing)}>
                    <ChannelLogo type={type} size={22} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{meta.label}</p>
                      {channelSupportsInbound(type) && (
                        <Badge variant="secondary" className="text-micro h-4 px-1.5">Inbound capable</Badge>
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
            <ChannelForm
              config={editConfig}
              onChange={setEditConfig}
              gatewayRunning={!isNew && channels[editName]?.gateway?.enableInbound === true}
              channelName={isNew ? undefined : editName}
              savedBotToken={isNew ? undefined : channels[editName]?.botToken}
              otherChannels={Object.entries(channels).filter(([n]) => n !== editName).map(([n, c]) => ({ name: n, type: c.type }))}
            />
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
  const [activeSection, setActiveSection] = useState<SectionId>(() => {
    const requested = readSetupParams().section;
    return baseSections.find((section) => section.id === requested)?.id ?? "general";
  });
  // ?section= follows the section shown (the sidebar's Settings links point at it, and highlight it)
  const [searchParams, setSearchParams] = useSearchParams();
  const sectionParam = searchParams.get("section");
  const [seenSectionParam, setSeenSectionParam] = useState(sectionParam);
  if (seenSectionParam !== sectionParam) {
    setSeenSectionParam(sectionParam);
    const linked = baseSections.find((section) => section.id === sectionParam)?.id;
    if (linked && linked !== activeSection) setActiveSection(linked);
  }
  const selectSection = (id: SectionId) => {
    setActiveSection(id);
    if (sectionParam !== id) setSearchParams({ section: id }, { replace: true });
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
              onClick={() => selectSection(id)}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer",
                activeSection === id
                  ? "bg-accent text-accent-foreground shadow-card"
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
              // classic is the built-in default: no need to store it
              if (sidebarStyle === "classic") delete current.sidebarStyle;
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
