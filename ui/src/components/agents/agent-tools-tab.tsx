/**
 * AgentToolsTab — tools, skills, connectors, notification channels, paths.
 * Reads data from AgentDetailContext.
 */

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Wrench,
  Sparkles,
  FolderOpen,
  CheckCircle2,
  XCircle,
  Layers,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionHeader } from "@/components/shared/section-header";
import { useAgentDetail } from "./agent-detail-context";
import { categoryEnabled, getToolMeta, getSkillMeta, toolCategories } from "@/lib/agent-meta";
import { AgentConnectorsSection } from "@/components/connectors/agent-connectors-section";
import { AgentNotificationsSection } from "./agent-notifications-section";


export function AgentToolsTab() {
  const {
    state: {
      agent,
      skillPool,
      agentAllowedTools,
      enabledCategories,
    },
    actions: { refetch },
  } = useAgentDetail();

  return (
    <div>
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
          <SectionHeader title="Opt-in Tool Extensions" icon={Layers} count={enabledCategories.length} />
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {toolCategories.map((category) => {
              const { prefix, label, tools, icon: CategoryIcon, color: categoryColor } = category;
              const enabled = categoryEnabled(category, agentAllowedTools);
              return (
                <Tooltip key={prefix}>
                  <TooltipTrigger asChild>
                    <div className={cn(
                      "flex items-center gap-2 rounded-md border px-3 py-2 cursor-help transition-colors",
                      enabled
                        ? "border-primary/30 bg-primary/5"
                        : "border-border/30 bg-card/30"
                    )}>
                      <CategoryIcon className={cn("h-3.5 w-3.5 shrink-0", enabled ? categoryColor : "text-muted-foreground/60")} />
                      <span className={cn("text-xs font-medium", enabled ? "text-foreground" : "text-muted-foreground/60")}>
                        {label}
                      </span>
                      {enabled ? (
                        <CheckCircle2 className="h-3 w-3 text-primary shrink-0 ml-auto" />
                      ) : (
                        <XCircle className="h-3 w-3 text-muted-foreground/60 shrink-0 ml-auto" />
                      )}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs max-w-72">
                    <p className="font-medium mb-0.5">{label} tools — {enabled ? "Enabled" : "Disabled"}</p>
                    <p className="text-muted-foreground font-mono text-micro">{tools}</p>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>

          {/* Browser profile details */}
          {agentAllowedTools.some(t => t.toLowerCase().startsWith("browser_")) && agent.browserProfile && (
            <div className="mt-3 flex items-center gap-3 text-caption text-muted-foreground px-1">
              <span>Profile: <code className="font-mono text-foreground">{agent.browserProfile}</code></span>
            </div>
          )}

          {/* Email domain restrictions */}
          {agentAllowedTools.some(t => t.toLowerCase().startsWith("email_")) && agent.emailAllowedDomains && agent.emailAllowedDomains.length > 0 && (
            <div className="mt-3 px-1">
              <p className="text-micro text-muted-foreground mb-1">Allowed email domains:</p>
              <div className="flex flex-wrap gap-1">
                {agent.emailAllowedDomains.map((d) => (
                  <Badge key={d} variant="outline" className="text-micro font-mono">{d}</Badge>
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
                        <Badge variant="outline" className="text-micro px-1.5 py-0 ml-auto">{info.source}</Badge>
                      )}
                    </div>
                    {info?.description && (
                      <p className="text-xs text-muted-foreground">{info.description}</p>
                    )}
                    {info?.path && (
                      <p className="text-micro font-mono text-muted-foreground/70 truncate" title={info.path}>
                        {info.path}
                      </p>
                    )}
                    {info?.allowedTools && info.allowedTools.length > 0 && (
                      <div className="flex items-center gap-1 pt-0.5">
                        <Wrench className="h-2.5 w-2.5 text-muted-foreground" />
                        {info.allowedTools.map(t => (
                          <Badge key={t} variant="outline" className="text-micro py-0 px-1 font-mono">{String(t)}</Badge>
                        ))}
                      </div>
                    )}
                    {!info && (
                      <p className="text-micro text-muted-foreground italic">
                        Skill not found in project pool — may be installed at runtime
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Connectors */}
        <AgentConnectorsSection
          agentName={agent.name}
          allowedTools={agent.allowedTools}
          connectorTools={agent.connectorTools}
          onConnectorToolsSaved={refetch}
        />

        {/* Notification channels it may post to (send_notification) */}
        <AgentNotificationsSection />

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


      </div>
    </div>
  );
}
