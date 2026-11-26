/**
 * AgentSocialsCard — social links from agent identity.
 * Reads data from AgentDetailContext.
 */

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Globe } from "lucide-react";
import { SectionHeader } from "@/components/shared/section-header";
import { useAgentDetail } from "./agent-detail-context";

export function AgentSocialsCard() {
  const { state: { agent } } = useAgentDetail();
  const socials = agent.identity?.socials;

  if (!socials || Object.keys(socials).length === 0) return null;

  return (
    <Card className="py-0 gap-0">
      <CardContent className="pt-4 pb-4 space-y-2">
        <SectionHeader title="Socials" icon={Globe} />
        {/* Long handles (full profile URLs) are cut with an ellipsis and shown whole on hover, so the
            sidebar never scrolls sideways. */}
        <div className="flex min-w-0 flex-wrap gap-1.5" data-testid="agent-socials">
          {Object.entries(socials).map(([platform, handle]) => (
            <Badge
              key={platform}
              variant="secondary"
              className="text-micro font-mono gap-1 min-w-0 max-w-full shrink justify-start"
              title={`${platform}: ${String(handle)}`}
            >
              <span className="shrink-0">{platform}</span>
              <span className="min-w-0 truncate text-muted-foreground" data-testid="agent-social-handle">{String(handle)}</span>
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
