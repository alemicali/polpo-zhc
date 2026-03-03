/**
 * AgentOverviewTab — bio, role, personality, tone, responsibilities.
 * Reads data from AgentDetailContext.
 */

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Shield,
  Heart,
  MessageSquare,
  ListChecks,
} from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { SectionHeader } from "@/components/shared/section-header";
import { cn } from "@/lib/utils";
import { useAgentDetail } from "./agent-detail-provider";
import { responsibilityPriorityColors } from "@/lib/agent-meta";

export function AgentOverviewTab() {
  const { state: { agent } } = useAgentDetail();
  const identity = agent.identity;

  return (
    <ScrollArea className="h-full">
      <div className="space-y-6 pr-4 pb-bottom-nav lg:pb-4">

        {/* Bio */}
        {identity?.bio && (
          <div>
            <SectionHeader title="Bio" icon={MessageSquare} />
            <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0">
              <CardContent className="pt-3 pb-3">
                <p className="text-sm text-muted-foreground leading-relaxed">{identity.bio}</p>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Role */}
        <div>
          <SectionHeader title="Role" icon={Shield} />
          <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0">
            <CardContent className="pt-3 pb-3">
              {agent.role ? (
                <MessageResponse>{agent.role}</MessageResponse>
              ) : (
                <p className="text-xs text-muted-foreground/40 italic">No role configured</p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Personality & Tone */}
        <div>
          <SectionHeader title="Personality & Tone" icon={Heart} />
          <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0">
            <CardContent className="pt-3 pb-3 divide-y divide-border/20">
              <div className="pb-3">
                <div className="flex items-center gap-1.5 mb-1">
                  <Heart className="h-3 w-3 text-pink-400" />
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Personality</span>
                </div>
                {identity?.personality ? (
                  <p className="text-xs text-muted-foreground leading-relaxed">{identity.personality}</p>
                ) : (
                  <p className="text-xs text-muted-foreground/40 italic">Not configured</p>
                )}
              </div>
              <div className="pt-3">
                <div className="flex items-center gap-1.5 mb-1">
                  <MessageSquare className="h-3 w-3 text-sky-400" />
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Communication Tone</span>
                </div>
                {identity?.tone ? (
                  <p className="text-xs text-muted-foreground leading-relaxed">{identity.tone}</p>
                ) : (
                  <p className="text-xs text-muted-foreground/40 italic">Not configured</p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Responsibilities */}
        <div>
          <SectionHeader title="Responsibilities" icon={ListChecks} count={identity?.responsibilities?.length} />
          <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0">
            <CardContent className="pt-3 pb-3">
              {identity?.responsibilities && identity.responsibilities.length > 0 ? (
                <div className="space-y-2">
                  {identity.responsibilities.map((resp, i) => {
                    if (typeof resp === "string") {
                      return (
                        <div key={i} className="flex items-start gap-2 text-xs">
                          <div className="h-1.5 w-1.5 rounded-full bg-primary mt-1.5 shrink-0" />
                          <span className="text-muted-foreground">{resp}</span>
                        </div>
                      );
                    }
                    return (
                      <div key={i} className="rounded-md border border-border/30 bg-muted/10 px-3 py-2 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium">{resp.area}</span>
                          {resp.priority && (
                            <Badge
                              variant="outline"
                              className={cn("text-[8px] capitalize", responsibilityPriorityColors[resp.priority])}
                            >
                              {resp.priority}
                            </Badge>
                          )}
                        </div>
                        <p className="text-[11px] text-muted-foreground leading-relaxed">{resp.description}</p>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground/40 italic">No responsibilities configured</p>
              )}
            </CardContent>
          </Card>
        </div>

      </div>
    </ScrollArea>
  );
}
