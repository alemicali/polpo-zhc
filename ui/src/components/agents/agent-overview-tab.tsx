/**
 * AgentOverviewTab — bio, role, personality, tone, communication lines, responsibilities.
 * Reads data from AgentDetailContext.
 */

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Shield,
  Heart,
  MessageSquare,
  ListChecks,
} from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { SectionHeader } from "@/components/shared/section-header";
import { cn } from "@/lib/utils";
import { useAgentDetail } from "./agent-detail-context";
import { responsibilityPriorityColors } from "@/lib/agent-meta";
import { AgentCommunicationSection } from "./agent-communication-section";

export function AgentOverviewTab() {
  const { state: { agent } } = useAgentDetail();
  const identity = agent.identity;

  return (
    <div>
      <div className="space-y-6 pr-4 pb-bottom-nav lg:pb-4">

        {/* About — a profile: the role as the headline, then who it is and how it talks */}
        <div>
          <SectionHeader title="About" icon={Shield} />
          <Card className="py-0 gap-0">
            <CardContent className="pt-4 pb-4 space-y-4" data-testid="agent-about">
              {agent.role ? (
                <div className="text-body leading-relaxed text-foreground">
                  <MessageResponse>{agent.role}</MessageResponse>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground/40 italic">No role configured</p>
              )}
              {identity?.personality && (
                <div className="space-y-1">
                  <p className="flex items-center gap-1.5 text-caption font-medium text-muted-foreground">
                    <Heart className="h-3 w-3 text-chart-2" /> Personality
                  </p>
                  <p className="text-small leading-relaxed text-foreground">{identity.personality}</p>
                </div>
              )}
              {identity?.tone && (
                <div className="space-y-1">
                  <p className="flex items-center gap-1.5 text-caption font-medium text-muted-foreground">
                    <MessageSquare className="h-3 w-3 text-info" /> How it communicates
                  </p>
                  <p className="text-small leading-relaxed text-foreground">{identity.tone}</p>
                </div>
              )}
              {!identity?.personality && !identity?.tone && (
                <p className="text-xs text-muted-foreground/40 italic">Personality and tone not configured</p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Responsibilities */}
        <div>
          <SectionHeader title="Responsibilities" icon={ListChecks} count={identity?.responsibilities?.length} />
          <Card className="py-0 gap-0">
            <CardContent className="pt-1 pb-1">
              {identity?.responsibilities && identity.responsibilities.length > 0 ? (
                <ul className="divide-y divide-border/40" data-testid="agent-responsibilities">
                  {identity.responsibilities.map((resp, i) => (
                    <li key={i} className="py-3 space-y-1">
                      {typeof resp === "string" ? (
                        <p className="text-small leading-relaxed text-foreground">{resp}</p>
                      ) : (
                        <>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-small font-medium text-foreground">{resp.area}</span>
                            {resp.priority && (
                              <Badge
                                variant="outline"
                                className={cn("text-micro capitalize", responsibilityPriorityColors[resp.priority])}
                              >
                                {resp.priority}
                              </Badge>
                            )}
                          </div>
                          <p className="text-small leading-relaxed text-muted-foreground">{resp.description}</p>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-3 text-xs text-muted-foreground/40 italic">No responsibilities configured</p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Org chart and communication lines */}
        <AgentCommunicationSection />

      </div>
    </div>
  );
}
