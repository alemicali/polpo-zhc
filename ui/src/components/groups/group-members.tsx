/**
 * Avatars for Groups members.
 *
 * Avatars reuse AgentAvatar (identity.avatar via /api/v1/files/read) and the
 * 🐙 mark the chat page uses for Polpo.
 */
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { cn } from "@/lib/utils";
import type { GroupMember } from "./use-member-directory";

type AvatarSize = "xs" | "sm" | "md";

const ORCHESTRATOR_SIZE: Record<AvatarSize, string> = {
  xs: "h-5 w-5 text-[10px]",
  sm: "h-6 w-6 text-xs",
  md: "h-8 w-8 text-base",
};

export function MemberAvatar({ member, size = "sm", className }: {
  member: GroupMember;
  size?: AvatarSize;
  className?: string;
}) {
  if (member.isOrchestrator) {
    return (
      <div className={cn("flex shrink-0 items-center justify-center rounded-full bg-primary/10", ORCHESTRATOR_SIZE[size], className)}>
        🐙
      </div>
    );
  }
  return (
    <AgentAvatar
      avatar={member.avatar}
      name={member.name}
      size={size}
      fallbackVariant="circle"
      shape="circle"
      className={cn("shrink-0", className)}
    />
  );
}

/** Overlapping avatars, capped with a "+N" chip. */
export function MemberAvatarStack({ members, max = 4, size = "xs", className }: {
  members: GroupMember[];
  max?: number;
  size?: AvatarSize;
  className?: string;
}) {
  const visible = members.slice(0, max);
  const hidden = members.length - visible.length;
  return (
    <div className={cn("flex items-center -space-x-1.5", className)}>
      {visible.map((member) => (
        <MemberAvatar key={member.id} member={member} size={size} className="ring-2 ring-background" />
      ))}
      {hidden > 0 && (
        <div className={cn(
          "flex shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-muted-foreground ring-2 ring-background tabular-nums",
          size === "xs" ? "h-5 min-w-5 px-1 text-[8px]" : size === "sm" ? "h-6 min-w-6 px-1 text-[9px]" : "h-8 min-w-8 px-1 text-[10px]",
        )}>
          +{hidden}
        </div>
      )}
    </div>
  );
}
