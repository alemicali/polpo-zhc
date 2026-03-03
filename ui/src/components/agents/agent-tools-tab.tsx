/**
 * AgentToolsTab — tools, skills, MCP servers, vault, paths.
 * Reads data from AgentDetailContext.
 */

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Wrench,
  Sparkles,
  Globe,
  FolderOpen,
  Terminal,
  Activity,
  CheckCircle2,
  XCircle,
  Layers,
  KeyRound,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionHeader } from "@/components/shared/section-header";
import { useAgentDetail } from "./agent-detail-provider";
import { getToolMeta, getSkillMeta, toolCategories } from "@/lib/agent-meta";
import type { VaultEntryMeta } from "@lumea-labs/polpo-react";

export function AgentToolsTab() {
  const {
    state: {
      agent,
      skillPool,
      vaultEntries,
      mcpEntries,
      agentAllowedTools,
      enabledCategories,
    },
  } = useAgentDetail();

  return (
    <ScrollArea className="h-full">
      <div className="space-y-6 pr-4 pb-bottom-nav lg:pb-4">

        {/* Allowed tools */}
        {agent.allowedTools && agent.allowedTools.length > 0 && (
          <div>
            <SectionHeader title="Allowed Tools" icon={Wrench} count={agent.allowedTools.length} />
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1.5">
              {agent.allowedTools.map((t) => {
                const meta = getToolMeta(t);
                const ToolIcon = meta.icon;
                return (
                  <div
                    key={t}
                    className={cn(
                      "flex items-center gap-2 rounded-lg border border-border/30 px-3 py-2 transition-colors",
                      meta.bg,
                    )}
                  >
                    <ToolIcon className={cn("h-3.5 w-3.5 shrink-0", meta.color)} />
                    <span className="text-xs font-mono truncate">{t}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Tool categories */}
        <div>
          <SectionHeader title="Tool Extensions" icon={Layers} count={enabledCategories.length} />
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {toolCategories.map(({ prefix, label, tools }) => {
              const enabled = agentAllowedTools.some(t => t.toLowerCase().startsWith(prefix));
              return (
                <Tooltip key={prefix}>
                  <TooltipTrigger asChild>
                    <div className={cn(
                      "flex items-center gap-2 rounded-md border px-3 py-2 cursor-help transition-colors",
                      enabled
                        ? "border-teal-500/30 bg-teal-500/5"
                        : "border-border/30 bg-card/30"
                    )}>
                      {enabled ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-teal-500 shrink-0" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5 text-zinc-600 shrink-0" />
                      )}
                      <span className={cn("text-xs font-medium", enabled ? "text-foreground" : "text-muted-foreground/60")}>
                        {label}
                      </span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs max-w-72">
                    <p className="font-medium mb-0.5">{label} tools — {enabled ? "Enabled" : "Disabled"}</p>
                    <p className="text-muted-foreground font-mono text-[10px]">{tools}</p>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>

          {/* Browser profile details */}
          {agentAllowedTools.some(t => t.toLowerCase().startsWith("browser_")) && agent.browserProfile && (
            <div className="mt-3 flex items-center gap-3 text-[11px] text-muted-foreground px-1">
              <span>Profile: <code className="font-mono text-foreground">{agent.browserProfile}</code></span>
            </div>
          )}

          {/* Email domain restrictions */}
          {agentAllowedTools.some(t => t.toLowerCase().startsWith("email_")) && agent.emailAllowedDomains && agent.emailAllowedDomains.length > 0 && (
            <div className="mt-3 px-1">
              <p className="text-[10px] text-muted-foreground mb-1">Allowed email domains:</p>
              <div className="flex flex-wrap gap-1">
                {agent.emailAllowedDomains.map((d) => (
                  <Badge key={d} variant="outline" className="text-[9px] font-mono">{d}</Badge>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Skills */}
        {agent.skills && agent.skills.length > 0 && (
          <div>
            <SectionHeader title="Skills" icon={Sparkles} count={agent.skills.length} />
            <div className="space-y-2">
              {agent.skills.map((skillName) => {
                const info = skillPool.get(skillName);
                const skillMeta = getSkillMeta(skillName);
                const SkillIcon = skillMeta.icon;
                return (
                  <div
                    key={skillName}
                    className="rounded-md border border-border/30 bg-card/60 px-4 py-3 space-y-1.5"
                  >
                    <div className="flex items-center gap-2">
                      <SkillIcon className={cn("h-3.5 w-3.5 shrink-0", skillMeta.color)} />
                      <span className="text-sm font-medium">{skillName}</span>
                      {info && (
                        <Badge variant="outline" className="text-[9px] px-1.5 py-0 ml-auto">{info.source}</Badge>
                      )}
                    </div>
                    {info?.description && (
                      <p className="text-xs text-muted-foreground">{info.description}</p>
                    )}
                    {info?.path && (
                      <p className="text-[10px] font-mono text-muted-foreground/70 truncate" title={info.path}>
                        {info.path}
                      </p>
                    )}
                    {info?.allowedTools && info.allowedTools.length > 0 && (
                      <div className="flex items-center gap-1 pt-0.5">
                        <Wrench className="h-2.5 w-2.5 text-muted-foreground" />
                        {info.allowedTools.map(t => (
                          <Badge key={t} variant="outline" className="text-[9px] py-0 px-1 font-mono">{String(t)}</Badge>
                        ))}
                      </div>
                    )}
                    {!info && (
                      <p className="text-[10px] text-muted-foreground italic">
                        Skill not found in project pool — may be installed at runtime
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* MCP Servers */}
        {mcpEntries.length > 0 && (
          <div>
            <SectionHeader title="MCP Servers" icon={Globe} count={mcpEntries.length} />
            <div className="space-y-2">
              {mcpEntries.map(([serverName, cfg]) => {
                const type = "command" in (cfg as object) ? "stdio" : ("type" in (cfg as object) ? ((cfg as { type: string }).type) : "http");
                const command = "command" in (cfg as object) ? (cfg as { command: string; args?: string[] }).command : undefined;
                const args = "args" in (cfg as object) ? (cfg as { args?: string[] }).args : undefined;
                const url = "url" in (cfg as object) ? (cfg as { url: string }).url : undefined;
                const env = "env" in (cfg as object) ? (cfg as { env?: Record<string, string> }).env : undefined;
                const headers = "headers" in (cfg as object) ? (cfg as { headers?: Record<string, string> }).headers : undefined;

                return (
                  <div
                    key={serverName}
                    className="rounded-md border border-border/30 bg-card/60 px-4 py-3 space-y-2"
                  >
                    <div className="flex items-center gap-2">
                      <Activity className="h-3.5 w-3.5 text-primary shrink-0" />
                      <span className="text-sm font-medium">{serverName}</span>
                      <Badge variant="outline" className="text-[10px] ml-auto">{type}</Badge>
                    </div>
                    {command && (
                      <div className="flex items-center gap-1.5">
                        <Terminal className="h-3 w-3 text-muted-foreground shrink-0" />
                        <code className="text-xs font-mono text-muted-foreground">
                          {command}{args?.length ? ` ${args.join(" ")}` : ""}
                        </code>
                      </div>
                    )}
                    {url && (
                      <div className="flex items-center gap-1.5">
                        <Globe className="h-3 w-3 text-muted-foreground shrink-0" />
                        <code className="text-xs font-mono text-muted-foreground truncate">{url}</code>
                      </div>
                    )}
                    {env && Object.keys(env).length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        <span className="text-[10px] text-muted-foreground mr-1">env:</span>
                        {Object.keys(env).map(k => (
                          <Badge key={k} variant="secondary" className="text-[9px] font-mono">{k}</Badge>
                        ))}
                      </div>
                    )}
                    {headers && Object.keys(headers).length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        <span className="text-[10px] text-muted-foreground mr-1">headers:</span>
                        {Object.keys(headers).map(k => (
                          <Badge key={k} variant="secondary" className="text-[9px] font-mono">{k}</Badge>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Allowed Paths */}
        {agent.allowedPaths && agent.allowedPaths.length > 0 && (
          <div>
            <SectionHeader title="Allowed Paths" icon={FolderOpen} count={agent.allowedPaths.length} />
            <div className="flex flex-col gap-1">
              {agent.allowedPaths.map((p) => (
                <div key={p} className="flex items-center gap-2 rounded-md border border-border/40 bg-card/60 px-3 py-2">
                  <FolderOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <code className="text-xs font-mono text-muted-foreground">{p}</code>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Credential Vault */}
        <div>
          <SectionHeader title="Credential Vault" icon={KeyRound} count={vaultEntries.length || undefined} />
          {vaultEntries.length > 0 ? (
            <div className="space-y-2">
              {vaultEntries.map((entry: VaultEntryMeta) => (
                <div
                  key={entry.service}
                  className="rounded-md border border-border/30 bg-card/60 px-4 py-3 space-y-2"
                >
                  <div className="flex items-center gap-2">
                    <KeyRound className="h-3.5 w-3.5 text-primary shrink-0" />
                    <span className="text-sm font-medium">{entry.service}</span>
                    <Badge variant="outline" className="text-[10px] ml-auto">{entry.type}</Badge>
                  </div>
                  {entry.label && (
                    <p className="text-xs text-muted-foreground ml-5.5">{entry.label}</p>
                  )}
                  <div className="flex flex-wrap gap-1.5 ml-5.5">
                    {entry.keys.map((k: string) => (
                      <span
                        key={k}
                        className="inline-flex items-center gap-1 rounded bg-muted/50 border border-border/30 px-2 py-0.5 text-[11px] font-mono text-muted-foreground"
                      >
                        {k}: <span className="text-[10px] opacity-60">***</span>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
              <p className="text-[10px] text-muted-foreground/60 mt-1">
                Encrypted with AES-256-GCM in <code className="font-mono">.polpo/vault.enc</code>. Use the chat to manage entries.
              </p>
            </div>
          ) : (
            <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0">
              <CardContent className="pt-4 pb-4">
                <p className="text-xs text-muted-foreground leading-relaxed">
                  No credentials configured for this agent. Use the chat to add vault entries — they are encrypted with AES-256-GCM in <code className="text-[10px] font-mono">.polpo/vault.enc</code>.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </ScrollArea>
  );
}
