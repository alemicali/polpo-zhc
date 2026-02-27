import { useState, useRef, useCallback } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Loader2,
  RefreshCw,
  Bot,
  Settings2,
  ChevronDown,
  ChevronRight,
  Globe,
  Key,
  Cpu,
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
} from "lucide-react";
import { useConfig } from "@/hooks/use-polpo";
import { useAgents } from "@lumea-labs/polpo-react";
import { cn } from "@/lib/utils";
import { JsonBlock } from "@/components/json-block";

// ── Section definitions ──

const sections = [
  { id: "general", label: "General", icon: Hash },
  { id: "models", label: "Models", icon: Cpu },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "providers", label: "Providers", icon: Key },
  { id: "channels", label: "Channels", icon: Send },
  { id: "rules", label: "Rules", icon: Bell },
  { id: "settings", label: "Settings", icon: Settings2 },
  { id: "policies", label: "Policies", icon: Shield },
] as const;

type SectionId = (typeof sections)[number]["id"];

// ── Helpers ──

function KV({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-[11px] text-muted-foreground shrink-0">{label}</span>
      <span className={cn("text-[11px] text-right truncate", mono && "font-mono")}>{children}</span>
    </div>
  );
}

function SectionAnchor({ id, icon: Icon, label, count, children }: {
  id: string;
  icon: React.ElementType;
  label: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section id={`cfg-${id}`} className="scroll-mt-4">
      <div className="flex items-center gap-2 mb-3 sticky top-0 bg-background/80 backdrop-blur-sm py-1.5 z-10">
        <Icon className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold tracking-tight">{label}</h3>
        {count != null && count > 0 && (
          <Badge variant="secondary" className="text-[9px] ml-auto">{count}</Badge>
        )}
      </div>
      {children}
    </section>
  );
}

function FeatureFlag({ label, enabled }: { label: string; enabled?: boolean }) {
  if (enabled == null) return null;
  return (
    <div className="flex items-center gap-2 py-0.5">
      <div className={cn("h-1.5 w-1.5 rounded-full", enabled ? "bg-emerald-500" : "bg-zinc-500")} />
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </div>
  );
}

// ── Main ──

export function ConfigPage() {
  const { config, isLoading, error, refetch } = useConfig();
  const { agents, teams } = useAgents();
  const [activeSection, setActiveSection] = useState<SectionId>("general");
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollTo = useCallback((id: SectionId) => {
    setActiveSection(id);
    const el = document.getElementById(`cfg-${id}`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

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
  const channels = (notifications?.channels ?? {}) as Record<string, { type?: string; gateway?: Record<string, unknown> }>;
  const rules = (notifications?.rules ?? []) as Array<{
    id: string; name: string; events: string[]; channels: string[];
    severity?: string; template?: string; condition?: Record<string, unknown>;
  }>;

  // Collect agent feature flags
  const agentFlags = (a: (typeof agents)[number]) => {
    const flags: { label: string; enabled: boolean }[] = [];
    if (a.enableBrowser != null) flags.push({ label: `Browser (${a.browserEngine ?? "default"})`, enabled: a.enableBrowser });
    if (a.enableHttp != null) flags.push({ label: "HTTP", enabled: a.enableHttp });
    if (a.enableGit != null) flags.push({ label: "Git", enabled: a.enableGit });
    if (a.enableMultifile != null) flags.push({ label: "Multi-file", enabled: a.enableMultifile });
    if (a.enableDeps != null) flags.push({ label: "Dependencies", enabled: a.enableDeps });
    if (a.enableExcel != null) flags.push({ label: "Excel/CSV", enabled: a.enableExcel });
    if (a.enablePdf != null) flags.push({ label: "PDF", enabled: a.enablePdf });
    if (a.enableDocx != null) flags.push({ label: "DOCX", enabled: a.enableDocx });
    if (a.enableEmail != null) flags.push({ label: "Email", enabled: a.enableEmail });
    if (a.enableAudio != null) flags.push({ label: "Audio", enabled: a.enableAudio });
    return flags;
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* ── Horizontal tab bar ── */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="flex items-center gap-1 overflow-x-auto scrollbar-none flex-1 pb-0.5">
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => scrollTo(id)}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer",
                activeSection === id
                  ? "bg-accent text-accent-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"
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

      {/* ── Content ── */}
      <div ref={scrollRef} className="flex-1 overflow-auto space-y-8 pb-bottom-nav lg:pb-2">

        {/* ═══ GENERAL ═══ */}
        <SectionAnchor id="general" icon={Hash} label="General">
          <Card className="bg-card/80 backdrop-blur-sm border-border/40">
            <CardContent className="pt-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8">
                <div className="divide-y divide-border/20">
                  <KV label="Project" mono>{config.project}</KV>
                  <KV label="Teams" mono>{teams.map(t => t.name).join(", ") || config.teams?.[0]?.name || "default"}</KV>
                  {teams[0]?.description && <KV label="Description">{teams[0].description}</KV>}
                </div>
                <div className="divide-y divide-border/20">
                  <KV label="Agents">{agents.length} configured</KV>
                  <KV label="Storage">{settings.storage ?? "file"}</KV>
                  <KV label="Log Level">{settings.logLevel}</KV>
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground mt-3 border-t border-border/20 pt-2">
                Source: <code className="font-mono text-primary">.polpo/polpo.json</code>
              </p>
            </CardContent>
          </Card>
        </SectionAnchor>

        {/* ═══ MODELS ═══ */}
        <SectionAnchor id="models" icon={Cpu} label="Models">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Orchestrator model */}
            <Card className="bg-card/80 backdrop-blur-sm border-border/40">
              <CardContent className="pt-3 pb-3">
                <div className="flex items-center gap-2 mb-2">
                  <Zap className="h-3.5 w-3.5 text-amber-400" />
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Orchestrator</span>
                </div>
                <code className="text-sm font-mono font-medium block truncate">
                  {settings.orchestratorModel ?? "not set"}
                </code>
              </CardContent>
            </Card>
            {/* Image model */}
            <Card className="bg-card/80 backdrop-blur-sm border-border/40">
              <CardContent className="pt-3 pb-3">
                <div className="flex items-center gap-2 mb-2">
                  <Monitor className="h-3.5 w-3.5 text-violet-400" />
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Image</span>
                </div>
                <code className="text-sm font-mono font-medium block truncate">
                  {settings.imageModel ?? "none"}
                </code>
              </CardContent>
            </Card>
          </div>
          {settings.modelAllowlist && Object.keys(settings.modelAllowlist).length > 0 && (
            <Card className="bg-card/80 backdrop-blur-sm border-border/40 mt-3">
              <CardContent className="pt-3 pb-3">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">Model Allowlist</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {Object.entries(settings.modelAllowlist).map(([model, opts]) => (
                    <div key={model} className="flex items-center gap-2 rounded-md bg-muted/20 px-2.5 py-1.5 min-w-0">
                      <code className="text-[10px] font-mono truncate flex-1">{model}</code>
                      {opts.alias && <Badge variant="outline" className="text-[8px] shrink-0">→ {opts.alias}</Badge>}
                      {opts.maxTokens && <span className="text-[9px] text-muted-foreground shrink-0">{(opts.maxTokens / 1000).toFixed(0)}k</span>}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </SectionAnchor>

        {/* ═══ AGENTS ═══ */}
        <SectionAnchor id="agents" icon={Bot} label="Agents" count={agents.length}>
          <div className="space-y-2">
            {agents.map((agent) => {
              const flags = agentFlags(agent);
              return (
                <Card key={agent.name} className="bg-card/80 backdrop-blur-sm border-border/40 overflow-hidden">
                  <Collapsible>
                    <CollapsibleTrigger className="flex items-center gap-3 w-full px-4 py-3 text-left transition-colors hover:bg-accent/10 cursor-pointer group">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 shrink-0">
                        <Bot className="h-4 w-4 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold">{agent.name}</span>
                          {agent.model && (
                            <code className="text-[10px] font-mono text-muted-foreground">{agent.model}</code>
                          )}
                        </div>
                        <p className="text-[11px] text-muted-foreground truncate mt-0.5">{agent.role}</p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {flags.filter(f => f.enabled).slice(0, 3).map(f => (
                          <Badge key={f.label} variant="secondary" className="text-[8px] hidden sm:inline-flex">{f.label}</Badge>
                        ))}
                        {flags.filter(f => f.enabled).length > 3 && (
                          <Badge variant="secondary" className="text-[8px] hidden sm:inline-flex">+{flags.filter(f => f.enabled).length - 3}</Badge>
                        )}
                        <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                      </div>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="px-4 pb-4 pt-1 border-t border-border/20">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-0.5">
                          {agent.identity?.displayName && <KV label="Display Name">{agent.identity.displayName}</KV>}
                          {agent.identity?.title && <KV label="Title">{agent.identity.title}</KV>}
                          {agent.maxTurns && <KV label="Max Turns">{agent.maxTurns}</KV>}
                          {agent.maxConcurrency && <KV label="Max Concurrency">{agent.maxConcurrency}</KV>}
                          {agent.reportsTo && <KV label="Reports To" mono>{agent.reportsTo}</KV>}
                          {agent.systemPrompt && <KV label="System Prompt">{agent.systemPrompt.slice(0, 60)}...</KV>}
                        </div>

                        {/* Feature flags */}
                        {flags.length > 0 && (
                          <div className="mt-3 pt-2 border-t border-border/20">
                            <div className="flex items-center gap-1.5 mb-2">
                              <ToggleRight className="h-3 w-3 text-muted-foreground" />
                              <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Capabilities</span>
                            </div>
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-0.5">
                              {flags.map(f => <FeatureFlag key={f.label} label={f.label} enabled={f.enabled} />)}
                            </div>
                          </div>
                        )}

                        {/* Tools */}
                        {agent.allowedTools && agent.allowedTools.length > 0 && (
                          <div className="mt-3 pt-2 border-t border-border/20">
                            <div className="flex items-center gap-1.5 mb-2">
                              <Wrench className="h-3 w-3 text-muted-foreground" />
                              <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Allowed Tools</span>
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {agent.allowedTools.map((t) => (
                                <Badge key={t} variant="outline" className="text-[9px] font-mono">{t}</Badge>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Skills */}
                        {agent.skills && agent.skills.length > 0 && (
                          <div className="mt-3 pt-2 border-t border-border/20">
                            <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Skills</span>
                            <div className="flex flex-wrap gap-1 mt-1.5">
                              {agent.skills.map((s: string) => (
                                <Badge key={s} variant="secondary" className="text-[9px]">{s}</Badge>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* MCP Servers */}
                        {agent.mcpServers && Object.keys(agent.mcpServers as object).length > 0 && (
                          <div className="mt-3 pt-2 border-t border-border/20">
                            <span className="text-[10px] text-muted-foreground uppercase tracking-wider">MCP Servers</span>
                            <div className="flex flex-wrap gap-1 mt-1.5">
                              {Object.keys(agent.mcpServers as object).map((s) => (
                                <Badge key={s} variant="outline" className="text-[9px] font-mono">{s}</Badge>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Link to agent detail */}
                        <div className="mt-3 pt-2 border-t border-border/20">
                          <Link
                            to={`/agents/${agent.name}`}
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                          >
                            View agent detail <ChevronRight className="h-3 w-3" />
                          </Link>
                        </div>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                </Card>
              );
            })}
          </div>
        </SectionAnchor>

        {/* ═══ PROVIDERS ═══ */}
        <SectionAnchor id="providers" icon={Key} label="Providers" count={providers ? Object.keys(providers).length : 0}>
          {providers && Object.keys(providers).length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {Object.entries(providers).map(([name, prov]) => (
                <Card key={name} className="bg-card/80 backdrop-blur-sm border-border/40">
                  <CardContent className="pt-3 pb-3">
                    <div className="flex items-center gap-2 mb-2">
                      <Globe className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-semibold">{name}</span>
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[9px] ml-auto",
                          prov.apiKey ? "text-emerald-500 border-emerald-500/30" : "text-zinc-500"
                        )}
                      >
                        {prov.apiKey ? "● key set" : "○ no key"}
                      </Badge>
                    </div>
                    {prov.baseUrl && (
                      <code className="text-[10px] font-mono text-muted-foreground block truncate bg-muted/20 rounded px-2 py-1">
                        {prov.baseUrl}
                      </code>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No providers configured.</p>
          )}
        </SectionAnchor>

        {/* ═══ NOTIFICATION CHANNELS ═══ */}
        <SectionAnchor id="channels" icon={Send} label="Notification Channels" count={Object.keys(channels).length}>
          {Object.keys(channels).length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {Object.entries(channels).map(([name, ch]) => (
                <Card key={name} className="bg-card/80 backdrop-blur-sm border-border/40">
                  <CardContent className="pt-3 pb-3">
                    <div className="flex items-center gap-2 mb-1">
                      {ch.type === "telegram" && <Send className="h-4 w-4 text-sky-400" />}
                      {ch.type === "email" && <Mail className="h-4 w-4 text-amber-400" />}
                      {ch.type !== "telegram" && ch.type !== "email" && <Bell className="h-4 w-4 text-muted-foreground" />}
                      <span className="text-sm font-semibold">{name}</span>
                      <Badge variant="outline" className="text-[9px]">{ch.type ?? "unknown"}</Badge>
                    </div>
                    <div className="flex items-center gap-2 mt-1.5">
                      {Boolean(ch.gateway?.enableInbound) && (
                        <Badge variant="secondary" className="text-[8px]">
                          <Zap className="h-2.5 w-2.5 mr-0.5" /> Inbound enabled
                        </Badge>
                      )}
                      {ch.gateway && (
                        <span className="text-[10px] text-muted-foreground">
                          DM: {String((ch.gateway as Record<string, unknown>).dmPolicy ?? "default")}
                        </span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No notification channels configured.</p>
          )}
        </SectionAnchor>

        {/* ═══ NOTIFICATION RULES ═══ */}
        <SectionAnchor id="rules" icon={Bell} label="Notification Rules" count={rules.length}>
          {rules.length > 0 ? (
            <Card className="bg-card/80 backdrop-blur-sm border-border/40">
              <CardContent className="pt-3 pb-3 space-y-0">
                {rules.map((rule, i) => (
                  <div key={rule.id} className={cn("py-2.5", i > 0 && "border-t border-border/20")}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <Eye className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="text-xs font-semibold">{rule.name}</span>
                      {rule.severity && (
                        <Badge variant={rule.severity === "critical" ? "destructive" : "outline"} className="text-[8px]">
                          {rule.severity}
                        </Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 ml-5">
                      {rule.events.map((e) => (
                        <Badge key={e} variant="secondary" className="text-[8px] font-mono">{e}</Badge>
                      ))}
                      <ChevronRight className="h-3 w-3 text-muted-foreground" />
                      {rule.channels.map((c) => (
                        <Badge key={c} variant="outline" className="text-[8px]">{c}</Badge>
                      ))}
                    </div>
                    {rule.template && (
                      <p className="text-[10px] text-muted-foreground ml-5 mt-1 font-mono truncate">{rule.template}</p>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : (
            <p className="text-xs text-muted-foreground">No notification rules configured.</p>
          )}
        </SectionAnchor>

        {/* ═══ SETTINGS ═══ */}
        <SectionAnchor id="settings" icon={Settings2} label="Settings">
          <Card className="bg-card/80 backdrop-blur-sm border-border/40">
            <CardContent className="pt-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-0 divide-y sm:divide-y-0">
                <div className="space-y-0">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">Execution</p>
                  <KV label="Max Retries">{settings.maxRetries}</KV>
                  <KV label="Max Concurrency">{settings.maxConcurrency ?? "unlimited"}</KV>
                  <KV label="Task Timeout">{settings.taskTimeout ? `${Math.round(settings.taskTimeout / 1000)}s` : "none"}</KV>
                  <KV label="Max Fix Attempts">{settings.maxFixAttempts ?? "default"}</KV>
                  <KV label="Max Question Rounds">{settings.maxQuestionRounds ?? "default"}</KV>
                  <KV label="Max Resolution Attempts">{settings.maxResolutionAttempts ?? "default"}</KV>
                </div>
                <div className="space-y-0 pt-2 sm:pt-0">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">Quality</p>
                  <KV label="Quality Threshold">{settings.defaultQualityThreshold != null ? `${(settings.defaultQualityThreshold * 100).toFixed(0)}%` : "none"}</KV>
                  <KV label="Auto-correct">{settings.autoCorrectExpectations ? "Yes" : "No"}</KV>
                  <KV label="Max Assessment Retries">{settings.maxAssessmentRetries ?? "default"}</KV>
                </div>
                <div className="space-y-0 pt-2 lg:pt-0">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">Features</p>
                  <FeatureFlag label="Scheduler" enabled={settings.enableScheduler ?? false} />
                  <FeatureFlag label="Volatile Teams" enabled={settings.enableVolatileTeams ?? false} />
                  {settings.volatileCleanup && <KV label="Volatile Cleanup">{settings.volatileCleanup}</KV>}
                  <KV label="Work Directory" mono>{settings.workDir}</KV>
                </div>
              </div>
              {/* MCP Tool Allowlist */}
              {settings.mcpToolAllowlist && Object.keys(settings.mcpToolAllowlist).length > 0 && (
                <div className="mt-4 pt-3 border-t border-border/20">
                  <div className="flex items-center gap-1.5 mb-2">
                    <Wrench className="h-3 w-3 text-muted-foreground" />
                    <span className="text-[10px] text-muted-foreground uppercase tracking-wider">MCP Tool Allowlist</span>
                  </div>
                  <div className="space-y-2">
                    {Object.entries(settings.mcpToolAllowlist).map(([server, tools]) => (
                      <div key={server} className="flex items-start gap-2">
                        <code className="text-[10px] font-mono text-muted-foreground shrink-0 mt-0.5">{server}:</code>
                        <div className="flex flex-wrap gap-1">
                          {tools.map((t) => (
                            <Badge key={t} variant="outline" className="text-[8px] font-mono">{t}</Badge>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* Email domains */}
              {settings.emailAllowedDomains && settings.emailAllowedDomains.length > 0 && (
                <div className="mt-4 pt-3 border-t border-border/20">
                  <div className="flex items-center gap-1.5 mb-2">
                    <Mail className="h-3 w-3 text-muted-foreground" />
                    <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Email Allowed Domains</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {settings.emailAllowedDomains.map((d) => (
                      <Badge key={d} variant="secondary" className="text-[9px] font-mono">{d}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </SectionAnchor>

        {/* ═══ POLICIES ═══ */}
        {(settings.escalationPolicy || settings.sla || settings.approvalGates) && (
          <SectionAnchor id="policies" icon={Shield} label="Policies">
            <Card className="bg-card/80 backdrop-blur-sm border-border/40">
              <CardContent className="pt-4 space-y-3">
                {settings.escalationPolicy && (
                  <Collapsible>
                    <CollapsibleTrigger className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer group w-full">
                      <ChevronDown className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180" />
                      <Shield className="h-3.5 w-3.5" />
                      <span className="font-medium">Escalation Policy</span>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <JsonBlock data={settings.escalationPolicy} className="text-[10px] leading-relaxed font-mono bg-muted/20 rounded-lg px-4 py-3 mt-2 whitespace-pre-wrap max-h-56 overflow-auto border border-border/20" />
                    </CollapsibleContent>
                  </Collapsible>
                )}
                {settings.sla && (
                  <Collapsible>
                    <CollapsibleTrigger className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer group w-full">
                      <ChevronDown className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180" />
                      <Zap className="h-3.5 w-3.5" />
                      <span className="font-medium">SLA</span>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <JsonBlock data={settings.sla} className="text-[10px] leading-relaxed font-mono bg-muted/20 rounded-lg px-4 py-3 mt-2 whitespace-pre-wrap max-h-56 overflow-auto border border-border/20" />
                    </CollapsibleContent>
                  </Collapsible>
                )}
                {settings.approvalGates && settings.approvalGates.length > 0 && (
                  <Collapsible>
                    <CollapsibleTrigger className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer group w-full">
                      <ChevronDown className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180" />
                      <Eye className="h-3.5 w-3.5" />
                      <span className="font-medium">Approval Gates ({settings.approvalGates.length})</span>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <JsonBlock data={settings.approvalGates} className="text-[10px] leading-relaxed font-mono bg-muted/20 rounded-lg px-4 py-3 mt-2 whitespace-pre-wrap max-h-56 overflow-auto border border-border/20" />
                    </CollapsibleContent>
                  </Collapsible>
                )}
              </CardContent>
            </Card>
          </SectionAnchor>
        )}
      </div>
    </div>
  );
}
