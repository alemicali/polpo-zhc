import { Bot } from "lucide-react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";
import { config } from "@/lib/config";

const base = config.baseUrl || "";

/** Resolve an avatar path (relative to project root) into a serveable URL. */
function avatarUrl(avatarPath: string): string {
  return `${base}/api/v1/files/read?path=${encodeURIComponent(avatarPath)}`;
}

type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

const sizeMap: Record<AvatarSize, { avatar: string; icon: string }> = {
  xs: { avatar: "size-5", icon: "h-2.5 w-2.5" },
  sm: { avatar: "size-6", icon: "h-3 w-3" },
  md: { avatar: "size-8", icon: "h-4 w-4" },
  lg: { avatar: "size-10", icon: "h-5 w-5" },
  xl: { avatar: "size-14", icon: "h-7 w-7" },
};

export function AgentAvatar({
  avatar,
  name,
  size = "md",
  className,
  iconClassName,
}: {
  /** avatar path from agent.identity?.avatar */
  avatar?: string;
  /** agent name (for alt text) */
  name?: string;
  size?: AvatarSize;
  className?: string;
  /** Extra classes for the fallback Bot icon */
  iconClassName?: string;
}) {
  const s = sizeMap[size];

  if (!avatar) {
    // No avatar configured — render just the Bot icon (same as before)
    return <Bot className={cn(s.icon, iconClassName)} />;
  }

  const url = avatarUrl(avatar);

  const avatarEl = (
    <Avatar className={cn(s.avatar, "rounded-lg", className)}>
      <AvatarImage src={url} alt={name ?? "Agent"} className="object-cover" />
      <AvatarFallback className="rounded-lg">
        <Bot className={cn(s.icon, iconClassName)} />
      </AvatarFallback>
    </Avatar>
  );

  return (
    <HoverCard openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>
        {avatarEl}
      </HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="start"
        className="w-auto p-1.5 rounded-xl"
      >
        <img
          src={url}
          alt={name ?? "Agent"}
          className="rounded-lg w-48 h-48 object-cover"
        />
        {name && (
          <p className="text-xs text-center text-muted-foreground mt-1.5 font-medium">{name}</p>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}
