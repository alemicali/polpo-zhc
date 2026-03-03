/**
 * AgentSocialsCard — social links from agent identity.
 * Reads data from AgentDetailContext.
 */

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Globe } from "lucide-react";
import { SectionHeader } from "@/components/shared/section-header";
import { useAgentDetail } from "./agent-detail-provider";

export function AgentSocialsCard() {
  const { state: { agent } } = useAgentDetail();
  const socials = agent.identity?.socials;

  if (!socials || Object.keys(socials).length === 0) return null;

  return (
    <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0">
      <CardContent className="pt-4 pb-4 space-y-2">
        <SectionHeader title="Socials" icon={Globe} />
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(socials).map(([platform, handle]) => (
            <Badge key={platform} variant="secondary" className="text-[9px] font-mono gap-1">
              {platform}
              <span className="text-muted-foreground">{handle}</span>
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
