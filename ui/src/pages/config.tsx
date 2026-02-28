import { useState } from "react";
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
  MessageSquare,
  Link2,
  Timer,
  Paperclip,
  FolderLock,
  Gauge,
  Sparkles,
  Activity,
} from "lucide-react";
import { useConfig } from "@/hooks/use-polpo";
import { useAgents } from "@lumea-labs/polpo-react";
import { cn } from "@/lib/utils";
import { JsonBlock } from "@/components/json-block";

// ── Helpers ──

function formatModel(model: string | { primary?: string; fallbacks?: string[] } | undefined): string {
  if (!model) return "not set";
  if (typeof model === "string") return model;
  const parts: string[] = [];
  if (model.primary) parts.push(model.primary);
  if (model.fallbacks?.length) parts.push(`+ ${model.fallbacks.length} fallback${model.fallbacks.length > 1 ? "s" : ""}`);
  return parts.join(" ") || "not set";
}

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

/** A titled subsection card with optional colored accent */
function GroupCard({ title, icon: Icon, accent, children }: {
  title: string;
  icon?: React.ElementType;
  accent?: string; // tailwind border-l color e.g. "border-l-amber-500"
  children: React.ReactNode;
}) {
  return (
    <Card className={cn("bg-card/80 border-border/40", accent && `border-l-2 ${accent}`)}>
      <CardContent className="pt-3 pb-3">
        <div className="flex items-center gap-2 mb-2.5">
          {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</span>
        </div>
        {children}
      </CardContent>
    </Card>
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

// ── Main ──

export function ConfigPage() {
  const { config, isLoading, error, refetch } = useConfig();
  const { agents, teams } = useAgents();
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
  const channels = (notifications?.channels ?? {}) as Record<string, { type?: string; gateway?: Record<string, unknown> }>;
  const rules = (notifications?.rules ?? []) as Array<{
    id: string; name: string; events: string[]; channels: string[];
    severity?: string; template?: string; condition?: Record<string, unknown>;
    cooldownMs?: number; includeOutcomes?: boolean; outcomeFilter?: string[];
    maxAttachmentSize?: number; actions?: Array<{ type: string; [key: string]: unknown }>;
  }>;

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
    if (a.enableImage != null) flags.push({ label: "Image", enabled: a.enableImage });
    return flags;
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

        {/* ═══ GENERAL ═══ */}
        {activeSection === "general" && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <GroupCard title="Project" icon={Hash} accent="border-l-sky-500">
              <Row label="Name" value={config.project} mono />
              <Row label="Teams" value={teams.map(t => t.name).join(", ") || "default"} mono />
              {teams[0]?.description && <Row label="Description" value={teams[0].description} />}
              <Row label="Agents" value={`${agents.length} configured`} />
            </GroupCard>
            <GroupCard title="Runtime" icon={Settings2} accent="border-l-violet-500">
              <Row label="Storage" value={settings.storage ?? "file"} mono />
              <Row label="Log Level" value={settings.logLevel} mono />
              <Row label="Work Directory" value={settings.workDir} mono />
              <div className="mt-2 pt-2 border-t border-border/20">
                <p className="text-[10px] text-muted-foreground">
                  Source: <code className="font-mono text-primary">.polpo/polpo.json</code>
                </p>
              </div>
            </GroupCard>
          </div>
        )}

        {/* ═══ MODELS ═══ */}
        {activeSection === "models" && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <GroupCard title="Orchestrator Model" icon={Zap} accent="border-l-amber-500">
                <code className="text-sm font-mono font-medium block truncate">{formatModel(settings.orchestratorModel)}</code>
                {typeof settings.orchestratorModel === "object" && settings.orchestratorModel?.fallbacks?.length ? (
                  <div className="flex flex-wrap gap-1 mt-2">
                    <span className="text-[10px] text-muted-foreground mr-1">Fallbacks:</span>
                    {settings.orchestratorModel.fallbacks.map((fb) => (
                      <Badge key={fb} variant="outline" className="text-[10px] font-mono">{fb}</Badge>
                    ))}
                  </div>
                ) : null}
              </GroupCard>
              <GroupCard title="Image Model" icon={Monitor} accent="border-l-violet-500">
                <code className="text-sm font-mono font-medium block truncate">{settings.imageModel ?? "none"}</code>
              </GroupCard>
            </div>
            {settings.reasoning && (
              <GroupCard title="Global Reasoning" icon={Sparkles}>
                <Row label="Level" value={settings.reasoning} mono />
              </GroupCard>
            )}
            {settings.modelAllowlist && Object.keys(settings.modelAllowlist).length > 0 && (
              <GroupCard title="Model Allowlist" icon={Shield}>
                <div className="space-y-1.5">
                  {Object.entries(settings.modelAllowlist).map(([model, opts]) => (
                    <div key={model} className="flex items-center gap-2 rounded-md bg-muted/20 px-2.5 py-1.5 min-w-0">
                      <code className="text-[11px] font-mono truncate flex-1">{model}</code>
                      {opts.alias && <Badge variant="outline" className="text-[10px] shrink-0">→ {opts.alias}</Badge>}
                      {opts.params && Object.entries(opts.params).map(([k, v]) => (
                        <Badge key={k} variant="secondary" className="text-[10px] shrink-0">{k}: {String(v)}</Badge>
                      ))}
                    </div>
                  ))}
                </div>
              </GroupCard>
            )}
          </>
        )}

        {/* ═══ AGENTS ═══ */}
        {activeSection === "agents" && (
          <div className="space-y-2">
            {agents.map((agent) => {
              const flags = agentFlags(agent);
              return (
                <Card key={agent.name} className="bg-card/80 border-border/40 overflow-hidden">
                  <Collapsible>
                    <CollapsibleTrigger className="flex items-center gap-3 w-full px-4 py-3 text-left transition-colors hover:bg-accent/10 cursor-pointer group">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 shrink-0">
                        <Bot className="h-4 w-4 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold">{agent.name}</span>
                          {agent.model && <code className="text-[11px] font-mono text-muted-foreground">{agent.model}</code>}
                        </div>
                        <p className="text-xs text-muted-foreground truncate mt-0.5">{agent.role}</p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {flags.filter(f => f.enabled).slice(0, 3).map(f => (
                          <Badge key={f.label} variant="secondary" className="text-[10px] hidden sm:inline-flex">{f.label}</Badge>
                        ))}
                        {flags.filter(f => f.enabled).length > 3 && (
                          <Badge variant="secondary" className="text-[10px] hidden sm:inline-flex">+{flags.filter(f => f.enabled).length - 3}</Badge>
                        )}
                        <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                      </div>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="px-4 pb-4 pt-2 border-t border-border/20 space-y-3">
                        {/* Identity & Config */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          {(agent.identity?.displayName || agent.identity?.title || agent.reportsTo || agent.reasoning) && (
                            <div className="space-y-0">
                              {agent.identity?.displayName && <Row label="Display Name" value={agent.identity.displayName} />}
                              {agent.identity?.title && <Row label="Title" value={agent.identity.title} />}
                              {agent.reportsTo && <Row label="Reports To" value={agent.reportsTo} mono />}
                              {agent.reasoning && <Row label="Reasoning" value={agent.reasoning} mono />}
                              {agent.volatile && <Row label="Volatile" value={agent.missionGroup ? `Yes (${agent.missionGroup})` : "Yes"} />}
                            </div>
                          )}
                          {(agent.maxTurns || agent.maxConcurrency || agent.browserProfile) && (
                            <div className="space-y-0">
                              {agent.maxTurns && <Row label="Max Turns" value={agent.maxTurns} />}
                              {agent.maxConcurrency && <Row label="Max Concurrency" value={agent.maxConcurrency} />}
                              {agent.browserProfile && <Row label="Browser Profile" value={agent.browserProfile} mono />}
                            </div>
                          )}
                        </div>

                        {/* System Prompt */}
                        {agent.systemPrompt && (
                          <div className="rounded-md bg-muted/20 border border-border/20 px-3 py-2">
                            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">System Prompt</span>
                            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{agent.systemPrompt}</p>
                          </div>
                        )}

                        {/* Capabilities */}
                        {flags.length > 0 && (
                          <div>
                            <div className="flex items-center gap-1.5 mb-2">
                              <ToggleRight className="h-3.5 w-3.5 text-muted-foreground" />
                              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Capabilities</span>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {flags.map(f => <CapPill key={f.label} label={f.label} on={f.enabled} />)}
                            </div>
                          </div>
                        )}

                        {/* Allowed Paths */}
                        {agent.allowedPaths && agent.allowedPaths.length > 0 && (
                          <div>
                            <div className="flex items-center gap-1.5 mb-2">
                              <FolderLock className="h-3.5 w-3.5 text-muted-foreground" />
                              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Allowed Paths</span>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {agent.allowedPaths.map((p) => (
                                <Badge key={p} variant="outline" className="text-[11px] font-mono">{p}</Badge>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Tools & Skills side by side */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          {agent.allowedTools && agent.allowedTools.length > 0 && (
                            <div>
                              <div className="flex items-center gap-1.5 mb-2">
                                <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Tools</span>
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {agent.allowedTools.map((t) => (
                                  <Badge key={t} variant="outline" className="text-[10px] font-mono">{t}</Badge>
                                ))}
                              </div>
                            </div>
                          )}
                          {agent.skills && agent.skills.length > 0 && (
                            <div>
                              <div className="flex items-center gap-1.5 mb-2">
                                <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Skills</span>
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {agent.skills.map((s: string) => (
                                  <Badge key={s} variant="secondary" className="text-[10px]">{s}</Badge>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>

                        {/* MCP Servers & Email Domains */}
                        {agent.mcpServers && Object.keys(agent.mcpServers as object).length > 0 && (
                          <div>
                            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">MCP Servers</span>
                            <div className="flex flex-wrap gap-1 mt-1.5">
                              {Object.keys(agent.mcpServers as object).map((s) => (
                                <Badge key={s} variant="outline" className="text-[10px] font-mono">{s}</Badge>
                              ))}
                            </div>
                          </div>
                        )}

                        {agent.emailAllowedDomains && agent.emailAllowedDomains.length > 0 && (
                          <div>
                            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Email Domains</span>
                            <div className="flex flex-wrap gap-1 mt-1.5">
                              {agent.emailAllowedDomains.map((d) => (
                                <Badge key={d} variant="secondary" className="text-[10px] font-mono">{d}</Badge>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Link */}
                        <Link
                          to={`/agents/${agent.name}`}
                          className="inline-flex items-center gap-1 text-xs text-primary hover:underline pt-1"
                        >
                          View full detail <ChevronRight className="h-3 w-3" />
                        </Link>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                </Card>
              );
            })}
          </div>
        )}

        {/* ═══ PROVIDERS ═══ */}
        {activeSection === "providers" && (
          <>
            {providers && Object.keys(providers).length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {Object.entries(providers).map(([name, prov]) => (
                  <GroupCard key={name} title={name} icon={Globe} accent={prov.apiKey ? "border-l-emerald-500" : "border-l-zinc-500"}>
                    <div className="flex items-center gap-2 mb-2">
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px]",
                          prov.apiKey ? "text-emerald-500 border-emerald-500/30" : "text-zinc-500",
                        )}
                      >
                        {prov.apiKey ? "● Key configured" : "○ No key"}
                      </Badge>
                      {prov.api && <Badge variant="secondary" className="text-[10px] font-mono">{prov.api}</Badge>}
                    </div>
                    {prov.baseUrl && (
                      <code className="text-[11px] font-mono text-muted-foreground block truncate bg-muted/20 rounded px-2 py-1">
                        {prov.baseUrl}
                      </code>
                    )}
                    {prov.models && prov.models.length > 0 && (
                      <div className="mt-2 pt-2 border-t border-border/20">
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">
                          {prov.models.length} Custom Model{prov.models.length > 1 ? "s" : ""}
                        </span>
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {prov.models.map((m) => (
                            <Badge key={m.id} variant="outline" className="text-[10px] font-mono">
                              {m.name}{m.reasoning ? " ⟡" : ""}{m.contextWindow ? ` ${(m.contextWindow / 1000).toFixed(0)}k` : ""}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </GroupCard>
                ))}
              </div>
            ) : (
              <Empty text="No providers configured" />
            )}
          </>
        )}

        {/* ═══ CHANNELS ═══ */}
        {activeSection === "channels" && (
          <>
            {Object.keys(channels).length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {Object.entries(channels).map(([name, ch]) => {
                  const typeColor: Record<string, string> = {
                    telegram: "border-l-sky-500",
                    email: "border-l-amber-500",
                    slack: "border-l-green-500",
                    webhook: "border-l-violet-500",
                  };
                  const TypeIcon: Record<string, React.ElementType> = {
                    telegram: Send,
                    email: Mail,
                    slack: MessageSquare,
                    webhook: Link2,
                  };
                  const Ic = TypeIcon[ch.type ?? ""] ?? Bell;
                  return (
                    <GroupCard key={name} title={name} icon={Ic} accent={typeColor[ch.type ?? ""]}>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[10px]">{ch.type ?? "unknown"}</Badge>
                        {Boolean(ch.gateway?.enableInbound) && (
                          <Badge variant="secondary" className="text-[10px]">
                            <Zap className="h-2.5 w-2.5 mr-0.5" /> Inbound
                          </Badge>
                        )}
                      </div>
                      {ch.gateway && (
                        <Row label="DM Policy" value={String((ch.gateway as Record<string, unknown>).dmPolicy ?? "default")} />
                      )}
                    </GroupCard>
                  );
                })}
              </div>
            ) : (
              <Empty text="No notification channels configured" />
            )}
          </>
        )}

        {/* ═══ RULES ═══ */}
        {activeSection === "rules" && (
          <>
            {rules.length > 0 ? (
              <div className="space-y-2">
                {rules.map((rule) => (
                  <Card key={rule.id} className="bg-card/80 border-border/40">
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

        {/* ═══ SETTINGS ═══ */}
        {activeSection === "settings" && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {/* Execution */}
              <GroupCard title="Execution" icon={Activity} accent="border-l-sky-500">
                <Row label="Max Retries" value={settings.maxRetries} />
                <Row label="Max Concurrency" value={settings.maxConcurrency ?? "unlimited"} />
                <Row label="Task Timeout" value={settings.taskTimeout ? `${Math.round(settings.taskTimeout / 1000)}s` : "none"} />
                <Row label="Stale Threshold" value={settings.staleThreshold ? `${Math.round(settings.staleThreshold / 1000)}s` : "5min (default)"} />
                <Row label="Max Fix Attempts" value={settings.maxFixAttempts ?? "2 (default)"} />
                <Row label="Max Question Rounds" value={settings.maxQuestionRounds ?? "2 (default)"} />
                <Row label="Max Resolution Attempts" value={settings.maxResolutionAttempts ?? "2 (default)"} />
              </GroupCard>

              {/* Quality */}
              <GroupCard title="Quality" icon={Gauge} accent="border-l-amber-500">
                <Row label="Quality Threshold" value={settings.defaultQualityThreshold != null ? `${settings.defaultQualityThreshold}/5` : "none"} />
                <Row label="Auto-correct" value={settings.autoCorrectExpectations !== false ? "Yes" : "No"} />
                <Row label="Max Assessment Retries" value={settings.maxAssessmentRetries ?? "1 (default)"} />
                <Row label="Reasoning Level" value={settings.reasoning ?? "off"} mono />
              </GroupCard>

              {/* Features */}
              <GroupCard title="Features" icon={ToggleRight} accent="border-l-emerald-500">
                <div className="space-y-2">
                  <div className="flex items-center justify-between py-1">
                    <span className="text-xs text-muted-foreground">Scheduler</span>
                    <CapPill label={settings.enableScheduler ? "Enabled" : "Disabled"} on={settings.enableScheduler ?? false} />
                  </div>
                  <div className="flex items-center justify-between py-1">
                    <span className="text-xs text-muted-foreground">Volatile Teams</span>
                    <CapPill label={settings.enableVolatileTeams !== false ? "Enabled" : "Disabled"} on={settings.enableVolatileTeams !== false} />
                  </div>
                  {settings.volatileCleanup && <Row label="Volatile Cleanup" value={settings.volatileCleanup} mono />}
                  <Row label="Work Directory" value={settings.workDir} mono />
                </div>
              </GroupCard>
            </div>

            {/* Retry Policy */}
            {settings.defaultRetryPolicy && (
              <GroupCard title="Default Retry Policy" icon={RefreshCw}>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-6">
                  {settings.defaultRetryPolicy.escalateAfter != null && <Row label="Escalate After" value={`${settings.defaultRetryPolicy.escalateAfter} failures`} />}
                  {settings.defaultRetryPolicy.fallbackAgent && <Row label="Fallback Agent" value={settings.defaultRetryPolicy.fallbackAgent} mono />}
                  {settings.defaultRetryPolicy.escalateModel && <Row label="Escalate Model" value={settings.defaultRetryPolicy.escalateModel} mono />}
                </div>
              </GroupCard>
            )}

            {/* MCP Tool Allowlist */}
            {settings.mcpToolAllowlist && Object.keys(settings.mcpToolAllowlist).length > 0 && (
              <GroupCard title="MCP Tool Allowlist" icon={Wrench}>
                <div className="space-y-2">
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
              </GroupCard>
            )}

            {/* Email Domains */}
            {settings.emailAllowedDomains && settings.emailAllowedDomains.length > 0 && (
              <GroupCard title="Email Allowed Domains" icon={Mail}>
                <div className="flex flex-wrap gap-1.5">
                  {settings.emailAllowedDomains.map((d) => (
                    <Badge key={d} variant="secondary" className="text-[10px] font-mono">{d}</Badge>
                  ))}
                </div>
              </GroupCard>
            )}
          </div>
        )}

        {/* ═══ POLICIES ═══ */}
        {activeSection === "policies" && (
          <>
            {(settings.escalationPolicy || settings.sla || settings.approvalGates) ? (
              <div className="space-y-3">
                {settings.escalationPolicy && (
                  <GroupCard title="Escalation Policy" icon={Shield} accent="border-l-red-500">
                    <Collapsible>
                      <CollapsibleTrigger className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer group w-full">
                        <ChevronDown className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180" />
                        <span className="font-medium">View JSON</span>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <JsonBlock data={settings.escalationPolicy} className="text-[11px] leading-relaxed font-mono bg-muted/20 rounded-lg px-4 py-3 mt-2 whitespace-pre-wrap max-h-64 overflow-auto border border-border/20" />
                      </CollapsibleContent>
                    </Collapsible>
                  </GroupCard>
                )}
                {settings.sla && (
                  <GroupCard title="SLA Configuration" icon={Zap} accent="border-l-amber-500">
                    <Collapsible>
                      <CollapsibleTrigger className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer group w-full">
                        <ChevronDown className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180" />
                        <span className="font-medium">View JSON</span>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <JsonBlock data={settings.sla} className="text-[11px] leading-relaxed font-mono bg-muted/20 rounded-lg px-4 py-3 mt-2 whitespace-pre-wrap max-h-64 overflow-auto border border-border/20" />
                      </CollapsibleContent>
                    </Collapsible>
                  </GroupCard>
                )}
                {settings.approvalGates && settings.approvalGates.length > 0 && (
                  <GroupCard title={`Approval Gates (${settings.approvalGates.length})`} icon={Eye} accent="border-l-violet-500">
                    <Collapsible>
                      <CollapsibleTrigger className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer group w-full">
                        <ChevronDown className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180" />
                        <span className="font-medium">View JSON</span>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <JsonBlock data={settings.approvalGates} className="text-[11px] leading-relaxed font-mono bg-muted/20 rounded-lg px-4 py-3 mt-2 whitespace-pre-wrap max-h-64 overflow-auto border border-border/20" />
                      </CollapsibleContent>
                    </Collapsible>
                  </GroupCard>
                )}
              </div>
            ) : (
              <Empty text="No policies configured" />
            )}
          </>
        )}
      </div>
    </div>
  );
}
