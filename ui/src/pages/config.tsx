import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  type LucideIcon,
} from "lucide-react";
import { useConfig } from "@/hooks/use-polpo";
import { useAgents, useAuthStatus, useOrchestratorSkills } from "@polpo-ai/react";
import type { CustomModelDef, ProviderConfig, AuthProfileMeta, ProviderAuthInfo, SkillInfo, PolpoSettings, AuthStatusResponse } from "@polpo-ai/react";
import { cn } from "@/lib/utils";
import { JsonBlock } from "@/components/json-block";

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
function ProviderCard({ name, prov, agentModels, authInfo }: {
  name: string;
  prov: ProviderConfig;
  agentModels: string[];
  authInfo?: ProviderAuthInfo;
}) {
  const hasKey = !!prov.apiKey;
  const hasEnvKey = authInfo?.hasEnvKey ?? false;
  const hasOAuth = (authInfo?.profiles.length ?? 0) > 0;
  const activeOAuth = authInfo?.profiles.filter((p: AuthProfileMeta) => p.status === "active").length ?? 0;
  const isLocal = !!prov.baseUrl && (prov.baseUrl.includes("localhost") || prov.baseUrl.includes("127.0.0.1"));
  const isAuthenticated = hasKey || hasEnvKey || hasOAuth || isLocal;

  // Build status label
  const statusLabel = isLocal ? "Local"
    : hasKey ? "API key (config)"
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

// ── Channel detail components ──

function ChannelCard({ name, ch }: {
  name: string;
  ch: Record<string, unknown>;
}) {
  const type = (ch.type as string) ?? "unknown";
  const gateway = ch.gateway as Record<string, unknown> | undefined;

  const typeColor: Record<string, string> = {
    telegram: "border-l-sky-500",
    email: "border-l-amber-500",
    slack: "border-l-green-500",
    webhook: "border-l-violet-500",
  };

  const TypeIcon: Record<string, LucideIcon> = {
    telegram: Send,
    email: Mail,
    slack: MessageSquare,
    webhook: Link2,
  };

  const Ic = TypeIcon[type] ?? Bell;
  const color = typeColor[type] ?? "border-l-zinc-500";

  return (
    <Card className={cn("bg-card/80 border-border/40 border-l-2 py-0 gap-0", color)}>
      <CardContent className="pt-3 pb-3 space-y-2.5">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Ic className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-sm font-semibold flex-1 truncate">{name}</span>
          <Badge variant="outline" className="text-[10px] shrink-0">{type}</Badge>
          {Boolean(gateway?.enableInbound) && (
            <Badge variant="secondary" className="text-[10px] shrink-0">
              <Zap className="h-2.5 w-2.5 mr-0.5" /> Inbound
            </Badge>
          )}
        </div>

        {/* Type-specific details */}
        {type === "telegram" && (
          <div className="space-y-0.5">
            <Row label="Bot Token" value={ch.botToken ? "***" : "not set"} mono />
            <Row label="Chat ID" value={(ch.chatId as string) ?? "not set"} mono />
          </div>
        )}

        {type === "slack" && (
          <div className="space-y-0.5">
            <Row label="Webhook URL" value={ch.webhookUrl ? "*** configured" : "not set"} mono />
            {Boolean(ch.apiKey) && <Row label="Bot Token" value="***" mono />}
            <StatusDot ok={!!ch.apiKey} label={ch.apiKey ? "File uploads enabled" : "No bot token (text only)"} />
          </div>
        )}

        {type === "email" && (
          <div className="space-y-0.5">
            <Row label="Provider" value={
              <Badge variant="secondary" className="text-[10px]">
                {(ch.provider as string) ?? "resend"}
              </Badge>
            } />
            {Boolean(ch.from) && <Row label="From" value={String(ch.from)} mono />}
            {(ch.to as string[])?.length > 0 && (
              <div>
                <span className="text-[10px] text-muted-foreground">Recipients:</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {(ch.to as string[]).map((email: string) => (
                    <Badge key={email} variant="outline" className="text-[10px] font-mono">{email}</Badge>
                  ))}
                </div>
              </div>
            )}
            {(ch.provider === "smtp" || Boolean(ch.host)) && (
              <>
                {Boolean(ch.host) && <Row label="SMTP Host" value={String(ch.host)} mono />}
                {Boolean(ch.port) && <Row label="SMTP Port" value={String(ch.port)} mono />}
              </>
            )}
            <StatusDot ok={!!ch.apiKey || !!ch.host} label={ch.apiKey ? "API key configured" : ch.host ? "SMTP configured" : "No credentials"} />
          </div>
        )}

        {type === "webhook" && (
          <div className="space-y-0.5">
            {Boolean(ch.url) && <Row label="URL" value={String(ch.url)} mono />}
            {Boolean(ch.headers) && Object.keys(ch.headers as object).length > 0 && (
              <div>
                <span className="text-[10px] text-muted-foreground">Headers:</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {Object.keys(ch.headers as object).map((h: string) => (
                    <Badge key={h} variant="outline" className="text-[10px] font-mono">{h}</Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Gateway config */}
        {gateway && (
          <div className="pt-2 border-t border-border/20 space-y-0.5">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Gateway</span>
            <Row label="DM Policy" value={(gateway.dmPolicy as string) ?? "default"} mono />
            {(gateway.allowFrom as string[])?.length > 0 && (
              <Row label="Allow From" value={`${(gateway.allowFrom as string[]).length} ID${(gateway.allowFrom as string[]).length > 1 ? "s" : ""}`} />
            )}
            {Number(gateway.sessionIdleMinutes) > 0 && (
              <Row label="Session Idle" value={`${String(gateway.sessionIdleMinutes)}min`} />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Available notification channel types (all supported) ──
const ALL_CHANNEL_TYPES: Array<{ type: string; label: string; icon: LucideIcon }> = [
  { type: "telegram", label: "Telegram", icon: Send },
  { type: "slack", label: "Slack", icon: MessageSquare },
  { type: "email", label: "Email", icon: Mail },
  { type: "webhook", label: "Webhook", icon: Link2 },
];

// ── Agent Tab ──

function AgentTab({ settings, primaryModel, fallbackModels }: {
  settings: PolpoSettings;
  primaryModel: string | undefined;
  fallbackModels: string[];
}) {
  const { skills, isLoading: skillsLoading } = useOrchestratorSkills();

  return (
    <div className="space-y-6">
      {/* ── Orchestrator Model ── */}
      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
          <Brain className="h-3.5 w-3.5" /> Orchestrator Model
        </h3>
        <div className="max-w-md">
          {primaryModel ? (
            <>
              <Row label="Model" value={parseModelSpec(primaryModel).model} mono />
              <Row label="Provider" value={providerLabel(parseModelSpec(primaryModel).provider)} mono />
              {fallbackModels.length > 0 && (
                <div className="pt-2 mt-1">
                  <span className="text-[10px] text-muted-foreground">Fallbacks</span>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {fallbackModels.map((fb) => (
                      <Badge key={fb} variant="outline" className="text-[10px] font-mono">{fb}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground italic py-1">Not set — auto-detect</p>
          )}
        </div>
      </section>

      {/* ── Image Model ── */}
      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
          <Monitor className="h-3.5 w-3.5" /> Image Model
        </h3>
        <div className="max-w-md">
          {settings.imageModel ? (
            <>
              <Row label="Model" value={parseModelSpec(settings.imageModel).model} mono />
              <Row label="Provider" value={providerLabel(parseModelSpec(settings.imageModel).provider)} mono />
            </>
          ) : (
            <p className="text-xs text-muted-foreground italic py-1">Not set</p>
          )}
        </div>
      </section>

      {/* ── Reasoning ── */}
      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5" /> Reasoning
        </h3>
        <div className="max-w-md">
          <Row
            label="Level"
            value={
              <span className={cn(
                "text-xs font-medium",
                settings.reasoning && settings.reasoning !== "off" ? "text-emerald-500" : "text-muted-foreground",
              )}>
                {settings.reasoning ?? "off"}
              </span>
            }
          />
          <p className="text-[10px] text-muted-foreground mt-1">
            {!settings.reasoning || settings.reasoning === "off"
              ? "Standard mode — no extended thinking"
              : "Extended thinking enabled for deeper analysis"}
          </p>
        </div>
      </section>

      {/* ── Orchestrator Skills ── */}
      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
          <Bookmark className="h-3.5 w-3.5" /> Orchestrator Skills
        </h3>
        {skillsLoading ? (
          <div className="flex items-center gap-2 py-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Loading skills...</span>
          </div>
        ) : skills.length > 0 ? (
          <div className="space-y-2 max-w-lg">
            {skills.map((skill: SkillInfo) => (
              <div key={skill.name} className="flex items-start gap-3 rounded-md bg-muted/15 border border-border/20 px-3 py-2.5">
                <Bookmark className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold truncate">{skill.name}</span>
                    <Badge variant="outline" className="text-[9px] shrink-0">{skill.source}</Badge>
                  </div>
                  {skill.description && (
                    <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{skill.description}</p>
                  )}
                </div>
              </div>
            ))}
            {settings.orchestratorSkills && settings.orchestratorSkills.length > 0 && (
              <p className="text-[10px] text-muted-foreground mt-2">
                Filter active: only <code className="font-mono text-primary">{settings.orchestratorSkills.join(", ")}</code>
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
    </div>
  );
}

// ── Providers Tab ──

function ProvidersTab({ settings, providers, allProviderNames, providerAgentUsage, authStatus }: {
  settings: PolpoSettings;
  providers: Record<string, ProviderConfig> | undefined;
  allProviderNames: Set<string>;
  providerAgentUsage: Map<string, string[]>;
  authStatus: AuthStatusResponse | null | undefined;
}) {
  return (
    <div className="space-y-6">
      {/* ── Provider Cards ── */}
      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
          <Key className="h-3.5 w-3.5" /> Providers
        </h3>
        {allProviderNames.size > 0 ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {[...allProviderNames].sort().map((name) => {
              const prov = providers?.[name] ?? {} as ProviderConfig;
              const agentUsage = providerAgentUsage.get(name) ?? [];
              const authInfo = authStatus?.providers[name];
              return (
                <ProviderCard key={name} name={name} prov={prov} agentModels={agentUsage} authInfo={authInfo} />
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
    </div>
  );
}

// ── Main ──

export function ConfigPage() {
  const { config, isLoading, error, refetch } = useConfig();
  const { agents } = useAgents();
  const { authStatus } = useAuthStatus();
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
  const channels = (notifications?.channels ?? {}) as Record<string, Record<string, unknown>>;
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

        {/* ═══ AGENT (orchestrator config) ═══ */}
        {activeSection === "agent" && (
          <AgentTab
            settings={settings}
            primaryModel={primaryModel}
            fallbackModels={fallbackModels}
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
          />
        )}

        {/* ═══ CHANNELS ═══ */}
        {activeSection === "channels" && (() => {
          const configuredTypes = new Set(
            Object.values(channels).map(ch => (ch.type as string) ?? "unknown"),
          );
          const inactiveTypes = ALL_CHANNEL_TYPES.filter(ct => !configuredTypes.has(ct.type));

          return (
            <div className="space-y-6">
              {/* Configured channels */}
              {Object.keys(channels).length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {Object.entries(channels).map(([name, ch]) => (
                    <ChannelCard key={name} name={name} ch={ch} />
                  ))}
                </div>
              ) : (
                <Empty text="No notification channels configured" />
              )}

              {/* Available / inactive channel types */}
              {inactiveTypes.length > 0 && (
                <section>
                  <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                    <Zap className="h-3.5 w-3.5" /> Available Channel Types
                  </h3>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {inactiveTypes.map(({ type, label, icon: Icon }) => (
                      <div key={type} className="flex items-center gap-2.5 rounded-lg border border-dashed border-border/40 bg-muted/10 px-3 py-2.5">
                        <Icon className="h-3.5 w-3.5 text-muted-foreground/50" />
                        <div>
                          <span className="text-xs text-muted-foreground/70">{label}</span>
                          <p className="text-[10px] text-muted-foreground/40">Not configured</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          );
        })()}

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
