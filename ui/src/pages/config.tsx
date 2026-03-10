import { useState, useCallback } from "react";
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
   Pencil,
  X,
  type LucideIcon,
} from "lucide-react";
import { useConfig } from "@/hooks/use-polpo";
import { useAgents, useAuthStatus, useOrchestratorSkills } from "@polpo-ai/react";
import type { CustomModelDef, ProviderConfig, AuthProfileMeta, ProviderAuthInfo, SkillInfo, PolpoSettings, AuthStatusResponse, ReasoningLevel, NotificationChannelType, NotificationChannelConfig } from "@polpo-ai/react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { JsonBlock } from "@/components/json-block";
import { config as appConfig } from "@/lib/config";
import { AuthStep, OAuthFlow, ApiKeyStep } from "@/components/shared/provider-auth";
import type { Provider as AuthProvider, OAuthProvider } from "@/components/shared/provider-auth";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { ModelPicker } from "@/components/shared/model-picker";

// ── API helper (same pattern as setup.tsx) ──

const api = async (path: string, init?: RequestInit) => {
  try {
    const headers: Record<string, string> = { ...init?.headers as Record<string, string> };
    // Only set Content-Type for requests with a body
    if (init?.body) headers["Content-Type"] = "application/json";
    const res = await fetch(`${appConfig.baseUrl}/api/v1${path}`, {
      ...init,
      headers,
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

// ── Section definitions ──

const baseSections = [
  { id: "general", label: "General", icon: Hash },
  { id: "agent", label: "Agent", icon: Bot },
  { id: "providers", label: "Providers", icon: Key },
  { id: "channels", label: "Channels", icon: Send },
  { id: "rules", label: "Rules", icon: Bell },
  { id: "policies", label: "Policies", icon: Shield },
] as const;

type SectionIdBase = (typeof baseSections)[number]["id"];

type SectionId = SectionIdBase;

// ── Reusable display components ──

/** Key-value row — label left, value right, dotted filler in between */
function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
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
  const hasOAuth = (authInfo?.profiles.length ?? 0) > 0;
  const activeOAuth = authInfo?.profiles.filter((p: AuthProfileMeta) => p.status === "active").length ?? 0;
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
          "flex h-8 w-8 items-center justify-center rounded-lg shrink-0",
          isAuthenticated ? "bg-emerald-500/10" : "bg-zinc-500/10",
        )}>
          {isLocal ? <Server className="h-4 w-4 text-emerald-500" /> :
           isAuthenticated ? <Lock className="h-4 w-4 text-emerald-500" /> :
                    <Unlock className="h-4 w-4 text-zinc-500" />}
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
          {authInfo!.profiles.map((profile: AuthProfileMeta) => {
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

const CHANNEL_META: Record<string, { label: string; icon: LucideIcon; color: string; description: string }> = {
  telegram: { label: "Telegram", icon: Send, color: "border-l-sky-500", description: "Send notifications to a Telegram chat via bot" },
  slack:    { label: "Slack", icon: MessageSquare, color: "border-l-green-500", description: "Post to a Slack channel via webhook" },
  email:    { label: "Email", icon: Mail, color: "border-l-amber-500", description: "Send email via Resend, SendGrid, or SMTP" },
  webhook:  { label: "Webhook", icon: Link2, color: "border-l-violet-500", description: "POST JSON to any HTTP endpoint" },
};

const ALL_CHANNEL_TYPES: NotificationChannelType[] = ["telegram", "slack", "email", "webhook"];

/** Default empty config per channel type */
function defaultChannelConfig(type: NotificationChannelType): NotificationChannelConfig {
  switch (type) {
    case "telegram": return { type, botToken: "", chatId: "" };
    case "slack":    return { type, webhookUrl: "" };
    case "email":    return { type, provider: "resend", apiKey: "", from: "", to: [] };
    case "webhook":  return { type, url: "" };
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

/** Channel config form — renders type-specific fields */
function ChannelForm({ config, onChange }: {
  config: NotificationChannelConfig;
  onChange: (config: NotificationChannelConfig) => void;
}) {
  const set = (patch: Partial<NotificationChannelConfig>) => onChange({ ...config, ...patch });

  return (
    <div className="space-y-3">
      {config.type === "telegram" && (
        <>
          <Field label="Bot Token" hint="From @BotFather on Telegram">
            <Input className="h-8 text-xs font-mono" placeholder="123456:ABC-DEF..." value={config.botToken ?? ""} onChange={(e) => set({ botToken: e.target.value })} />
          </Field>
          <Field label="Chat ID" hint="Numeric chat or group ID">
            <Input className="h-8 text-xs font-mono" placeholder="-1001234567890" value={config.chatId ?? ""} onChange={(e) => set({ chatId: e.target.value })} />
          </Field>
        </>
      )}

      {config.type === "slack" && (
        <>
          <Field label="Webhook URL" hint="Slack Incoming Webhook URL">
            <Input className="h-8 text-xs font-mono" placeholder="https://hooks.slack.com/services/..." value={config.webhookUrl ?? ""} onChange={(e) => set({ webhookUrl: e.target.value })} />
          </Field>
          <Field label="API Key" hint="Optional — enables file uploads">
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
              onChange={(e) => set({ to: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
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
    </div>
  );
}

/** Interactive channel card with edit / delete / test */
function ChannelCard({ name, ch, onEdit, onDelete, onTest, deleting, testing, testResult }: {
  name: string;
  ch: NotificationChannelConfig;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  deleting?: boolean;
  testing?: boolean;
  testResult?: boolean | null;
}) {
  const meta = CHANNEL_META[ch.type] ?? { label: ch.type, icon: Bell, color: "border-l-zinc-500" };
  const Ic = meta.icon;
  const gateway = ch.gateway;

  return (
    <Card className={cn("bg-card/80 border-border/40 border-l-2 py-0 gap-0", meta.color)}>
      <CardContent className="pt-3 pb-3 space-y-2.5">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Ic className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-sm font-semibold flex-1 truncate">{name}</span>
          <Badge variant="outline" className="text-[10px] shrink-0">{meta.label}</Badge>
          {gateway?.enableInbound && (
            <Badge variant="secondary" className="text-[10px] shrink-0">
              <Zap className="h-2.5 w-2.5 mr-0.5" /> Inbound
            </Badge>
          )}
        </div>

        {/* Type-specific summary */}
        {ch.type === "telegram" && (
          <div className="space-y-0.5">
            <Row label="Bot Token" value={ch.botToken ? "*** configured" : "not set"} mono />
            <Row label="Chat ID" value={ch.chatId || "not set"} mono />
          </div>
        )}
        {ch.type === "slack" && (
          <div className="space-y-0.5">
            <Row label="Webhook" value={ch.webhookUrl ? "*** configured" : "not set"} mono />
            {ch.apiKey && <StatusDot ok label="File uploads enabled" />}
          </div>
        )}
        {ch.type === "email" && (
          <div className="space-y-0.5">
            <Row label="Provider" value={<Badge variant="secondary" className="text-[10px]">{ch.provider ?? "resend"}</Badge>} />
            {ch.from && <Row label="From" value={ch.from} mono />}
            {(ch.to?.length ?? 0) > 0 && (
              <Row label="To" value={`${ch.to!.length} recipient${ch.to!.length > 1 ? "s" : ""}`} />
            )}
            <StatusDot ok={!!ch.apiKey || !!ch.host} label={ch.apiKey ? "API key set" : ch.host ? "SMTP configured" : "No credentials"} />
          </div>
        )}
        {ch.type === "webhook" && (
          <div className="space-y-0.5">
            <Row label="URL" value={ch.url || "not set"} mono />
            {ch.headers && Object.keys(ch.headers).length > 0 && (
              <Row label="Headers" value={`${Object.keys(ch.headers).length} custom`} />
            )}
          </div>
        )}

        {/* Gateway */}
        {gateway && (
          <div className="pt-2 border-t border-border/20 space-y-0.5">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Gateway</span>
            <Row label="DM Policy" value={gateway.dmPolicy ?? "allowlist"} mono />
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 pt-1.5 border-t border-border/20">
          <Button variant="ghost" size="sm" className="h-7 text-[11px] gap-1 px-2" onClick={onEdit}>
            <Pencil className="h-3 w-3" /> Edit
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-[11px] gap-1 px-2" onClick={onTest} disabled={testing}>
            {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Activity className="h-3 w-3" />}
            Test
            {testResult === true && <span className="text-emerald-500 text-[10px]">OK</span>}
            {testResult === false && <span className="text-red-500 text-[10px]">Fail</span>}
          </Button>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" className="h-7 text-[11px] px-2 text-muted-foreground hover:text-destructive" onClick={onDelete} disabled={deleting}>
            {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
          </Button>
        </div>
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
  const channels = (settings.notifications?.channels ?? {}) as Record<string, NotificationChannelConfig>;

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
  const [testResults, setTestResults] = useState<Record<string, boolean | null>>({});

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
      setTestResults((prev) => ({ ...prev, [name]: data.ok ? data.data.success : false }));
    } catch {
      setTestResults((prev) => ({ ...prev, [name]: false }));
    } finally {
      setTesting(null);
    }
  };

  const configuredTypes = new Set(Object.values(channels).map((c) => c.type));
  const unconfiguredTypes = ALL_CHANNEL_TYPES.filter((t) => !configuredTypes.has(t));

  return (
    <div className="space-y-6">
      {/* Configured channels */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Bell className="h-3.5 w-3.5" /> Channels
          </h3>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => setTypePickerOpen(true)}>
            <Zap className="h-3 w-3" /> Add channel
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
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {unconfiguredTypes.map((type) => {
              const meta = CHANNEL_META[type];
              if (!meta) return null;
              const Icon = meta.icon;
              return (
                <button
                  key={type}
                  onClick={() => openAdd(type)}
                  className="flex items-center gap-2.5 rounded-lg border border-dashed border-border/40 bg-muted/10 px-3 py-2.5 hover:border-primary/30 hover:bg-accent/30 transition-colors text-left cursor-pointer"
                >
                  <Icon className="h-3.5 w-3.5 text-muted-foreground/50" />
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
        <DialogContent className="sm:max-w-md p-0 gap-0 overflow-hidden">
          <DialogHeader className="px-6 pt-6 pb-0">
            <DialogTitle className="text-base">Add Notification Channel</DialogTitle>
            <DialogDescription className="text-xs">Choose a channel type to configure.</DialogDescription>
          </DialogHeader>
          <div className="px-6 py-5 space-y-2">
            {ALL_CHANNEL_TYPES.map((type) => {
              const meta = CHANNEL_META[type];
              if (!meta) return null;
              const Icon = meta.icon;
              return (
                <button
                  key={type}
                  onClick={() => openAdd(type)}
                  className="w-full flex items-center gap-4 p-3 rounded-lg border border-border hover:border-primary/30 hover:bg-accent/50 text-left transition-all cursor-pointer"
                >
                  <div className={cn("h-10 w-10 rounded-lg flex items-center justify-center shrink-0", meta.color.replace("border-l-", "bg-").replace("500", "500/10"))}>
                    <Icon className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{meta.label}</p>
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
        <DialogContent className="sm:max-w-md p-0 gap-0 overflow-hidden">
          <DialogHeader className="px-6 pt-6 pb-0">
            <DialogTitle className="text-base">{isNew ? "Add" : "Edit"} {CHANNEL_META[editConfig.type]?.label ?? editConfig.type} Channel</DialogTitle>
            <DialogDescription className="text-xs">
              {isNew ? "Configure the channel and give it a unique name." : `Editing channel "${editName}".`}
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
  const configuredProviders = authStatus
    ? Object.entries(authStatus.providers)
        .filter(([, info]) => info.hasEnvKey || info.profiles.some((p) => p.status === "active"))
        .map(([name]) => name)
    : [];
  const providerSources = authStatus
    ? Object.fromEntries(
        Object.entries(authStatus.providers)
          .filter(([, info]) => info.hasEnvKey || info.profiles.some((p) => p.status === "active"))
          .map(([name, info]) => [name, info.hasEnvKey ? "env" : "oauth"]),
      )
    : {};

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
    id: string; name: string; events: string[]; channels: string[];
    severity?: string; template?: string; condition?: Record<string, unknown>;
    cooldownMs?: number; includeOutcomes?: boolean; outcomeFilter?: string[];
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

  // Build visible sections — hide policies when empty
  const sections = baseSections.filter(s => s.id !== "policies" || hasPolicies);

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
            {/* ── Org ── */}
            <section>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
                <Hash className="h-3.5 w-3.5" /> Org
              </h3>
              <div className="max-w-md">
                <Row label="Name" value={config.org} mono />
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
            {rules.length > 0 ? (
              <div className="space-y-2">
                {rules.map((rule) => (
                  <Card key={rule.id} className="bg-card/80 border-border/40 py-0 gap-0">
                    <CardContent className="pt-3 pb-3">
                      <div className="flex items-center gap-2 mb-2">
                        <Eye className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="text-sm font-semibold">{rule.name}</span>
                        {rule.severity && (
                          <Badge variant={rule.severity === "critical" ? "destructive" : rule.severity === "warning" ? "secondary" : "outline"} className="text-[10px]">
                            {rule.severity}
                          </Badge>
                        )}
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
                          {rule.includeOutcomes && (
                            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                              <Paperclip className="h-3 w-3" />
                              Outcomes{rule.outcomeFilter?.length ? ` (${rule.outcomeFilter.join(", ")})` : ""}
                              {rule.maxAttachmentSize ? ` max ${(rule.maxAttachmentSize / 1048576).toFixed(0)}MB` : ""}
                            </span>
                          )}
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
          </>
        )}

        {/* ═══ POLICIES ═══ */}
        {activeSection === "policies" && hasPolicies && (
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
                {gates && gates.length > 0 && (
                  <div>
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                      <Shield className="h-3.5 w-3.5" /> Approval Gates
                      <Badge variant="secondary" className="text-[9px] h-4 px-1.5">{gates.length}</Badge>
                    </h3>
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
                                <Badge variant="outline" className="text-[9px] ml-auto">priority: {gate.priority}</Badge>
                              )}
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
                  </div>
                )}
              </div>
        )}
      </div>
    </div>
  );
}
