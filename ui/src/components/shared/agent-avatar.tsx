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

/** Pull up to 2 letters out of an agent name: words → first letters; CamelCase → first 2 caps; otherwise → first 2 chars. */
function initialsOf(name?: string): string {
  if (!name) return "";
  const parts = name.trim().split(/[\s_\-/.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  const camel = name.match(/[A-Z][a-z]*/g);
  if (camel && camel.length >= 2) return (camel[0][0] + camel[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function AgentAvatar({
  avatar,
  name,
  size = "md",
  className,
  iconClassName,
  fallbackVariant = "icon",
  shape = "rounded",
}: {
  /** avatar path from agent.identity?.avatar */
  avatar?: string;
  /** agent name (for alt text + initials fallback) */
  name?: string;
  size?: AvatarSize;
  className?: string;
  /** Extra classes for the fallback Bot icon */
  iconClassName?: string;
  /** What to render when no avatar is configured.
   *  - "icon": just the Bot lucide icon (legacy default)
   *  - "circle": a coloured circle with the agent's initials — looks like a real avatar */
  fallbackVariant?: "icon" | "circle";
  /** Box shape — applied both to image and initials fallback so they match.
   *  - "rounded": rounded-lg square (legacy default)
   *  - "circle": rounded-full — use this when the fallback is a circle so visual sizes match */
  shape?: "rounded" | "circle";
}) {
  const radius = shape === "circle" ? "rounded-full" : "rounded-lg";
  const s = sizeMap[size];

  if (!avatar) {
    if (fallbackVariant === "circle") {
      const initials = initialsOf(name);
      return (
        <div className={cn(
          s.avatar,
          radius,
          "bg-primary/12 text-primary/85 flex items-center justify-center font-semibold tabular-nums select-none",
          // Pick a font size that matches the avatar size — initials only.
          size === "xs" && "text-[8px]",
          size === "sm" && "text-[9px]",
          size === "md" && "text-[10px]",
          size === "lg" && "text-xs",
          size === "xl" && "text-sm",
          className,
        )}>
          {initials || <Bot className={cn(s.icon, iconClassName)} />}
        </div>
      );
    }
    return <Bot className={cn(s.icon, iconClassName)} />;
  }

  const url = avatarUrl(avatar);

  const avatarEl = (
    <Avatar className={cn(s.avatar, radius, className)}>
      <AvatarImage src={url} alt={name ?? "Agent"} className="object-cover" />
      <AvatarFallback className={radius}>
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
