/**
 * "New" button for the chat: a small menu with "New chat" and "New group".
 */
import type { ReactNode } from "react";
import { MessageSquarePlus, Plus, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export function NewChatMenu({
  onNewChat,
  onNewGroup,
  newChatLabel = "New chat",
  newGroupLabel = "New group",
  className,
  iconClassName = "h-4 w-4",
  align = "start",
  children,
}: {
  onNewChat: () => void;
  onNewGroup: () => void;
  newChatLabel?: string;
  newGroupLabel?: string;
  className?: string;
  iconClassName?: string;
  align?: "start" | "center" | "end";
  /** Custom trigger content (defaults to a "+" icon). */
  children?: ReactNode;
}) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn("text-muted-foreground hover:text-foreground", className)}
              aria-label="New chat or group"
            >
              {children ?? <Plus className={iconClassName} />}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">New</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align={align} className="w-52">
        <DropdownMenuItem onSelect={onNewChat} className="gap-2 text-xs">
          <MessageSquarePlus className="h-3.5 w-3.5" />
          {newChatLabel}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onNewGroup} className="gap-2 text-xs">
          <UsersRound className="h-3.5 w-3.5" />
          {newGroupLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
