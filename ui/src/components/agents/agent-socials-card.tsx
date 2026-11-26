/**
 * AgentSocialsCard — social links from agent identity: the platform's mark and the handle,
 * opening the profile in a new tab when it can be worked out (ui/src/lib/social-links.ts).
 * Reads data from AgentDetailContext.
 */

import { useId } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Globe, Linkedin, Mail } from "lucide-react";
import { SectionHeader } from "@/components/shared/section-header";
import { SOCIAL_VECTORS, type SocialIconName } from "@/generated/social-icons";
import { socialLink, type SocialKind } from "@/lib/social-links";
import { cn } from "@/lib/utils";
import { useAgentDetail } from "./agent-detail-context";

function SocialMark({ kind }: { kind: SocialKind }) {
  const vector = SOCIAL_VECTORS[kind as SocialIconName];
  const gradientId = `social-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  if (vector) {
    // the official colour (a gradient for Instagram); near-black marks take the text colour for dark mode
    const fill = vector.gradient ? `url(#${gradientId})` : vector.mono ? undefined : vector.hex;
    return (
      <svg viewBox="0 0 24 24" className={cn("size-3.5 shrink-0", vector.mono && "fill-current")} role="img" aria-label={vector.title} data-social={kind}>
        {vector.gradient && (
          <defs>
            <linearGradient id={gradientId} x1="0" y1="1" x2="1" y2="0">
              {vector.gradient.map((stop, i) => (
                <stop key={stop} offset={i / (vector.gradient!.length - 1)} stopColor={stop} />
              ))}
            </linearGradient>
          </defs>
        )}
        <path d={vector.path} fill={fill} />
      </svg>
    );
  }
  const Icon = kind === "linkedin" ? Linkedin : kind === "email" ? Mail : Globe;
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden data-social={kind} />;
}

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
          {Object.entries(socials).map(([platform, value]) => {
            const link = socialLink(platform, value);
            const badge = (
              <Badge
                variant="secondary"
                className="text-micro font-mono gap-1 min-w-0 max-w-full shrink justify-start"
                title={`${platform}: ${String(value)}`}
              >
                <SocialMark kind={link.kind} />
                <span className="min-w-0 truncate text-muted-foreground" data-testid="agent-social-handle">{link.text}</span>
              </Badge>
            );
            return link.href ? (
              <a
                key={platform}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="min-w-0 max-w-full rounded-md hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`${platform}: ${link.text}`}
                data-testid="agent-social-link"
              >
                {badge}
              </a>
            ) : (
              <span key={platform} className="min-w-0 max-w-full">{badge}</span>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
