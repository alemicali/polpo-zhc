import { useLocation } from "react-router-dom";
import { Sun, Moon, Monitor, MessageCircle } from "lucide-react";
import { useProjectInfo } from "@/hooks/use-polpo";
import { useChatContext } from "@/hooks/chat-context";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme } from "@/hooks/use-theme";

const titles: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/missions": "Missions",
  "/tasks": "Tasks",
  "/agents": "Agents",
  "/activity": "Activity",
  "/chat": "Chat",
  "/memory": "Memory",
  "/logs": "Logs",
  "/notifications": "Notifications",
  "/approvals": "Approvals",
  "/templates": "Templates",
  "/config": "Configuration",
};

function resolveTitle(pathname: string): string {
  if (titles[pathname]) return titles[pathname];
  if (pathname.startsWith("/missions/")) return "Mission Detail";
  if (pathname.startsWith("/tasks/")) return "Task Detail";
  if (pathname.startsWith("/agents/")) return "Agent Detail";
  return "";
}

export function Header() {
  const { pathname } = useLocation();
  const title = resolveTitle(pathname);
  const { theme, resolved, setTheme } = useTheme();
  const { info } = useProjectInfo();
  const { sidebarOpen, toggleSidebar } = useChatContext();
  const isOnChatPage = pathname === "/chat";

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border/50 bg-background/80 backdrop-blur-md px-5 lg:px-8 pt-safe">
      {/* Mobile: logo + title */}
      <div className="flex items-center gap-2.5 lg:hidden">
        <span className="text-lg">🐙</span>
        <span className="text-sm font-bold tracking-tight">{title}</span>
      </div>

      {/* Desktop: page title with subtle accent underline */}
      <div className="hidden lg:flex items-center gap-3">
        <h2 className="text-lg font-bold tracking-tight">{title}</h2>
        <div className="h-4 w-px bg-border/60" />
        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/60">
          {info?.project ?? "Polpo"}
        </span>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        {/* Chat sidebar toggle — hidden on /chat page and on mobile */}
        {!isOnChatPage && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={`hidden lg:inline-flex h-8 w-8 rounded-lg transition-all ${sidebarOpen ? "text-primary bg-primary/10 hover:bg-primary/15" : "text-muted-foreground hover:text-foreground hover:bg-accent/50"}`}
                onClick={toggleSidebar}
              >
                <MessageCircle className="h-4 w-4" />
                <span className="sr-only">{sidebarOpen ? "Close chat" : "Open chat"}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {sidebarOpen ? "Close chat sidebar" : "Open chat sidebar"}
            </TooltipContent>
          </Tooltip>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-all"
            >
              {resolved === "dark" ? (
                <Moon className="h-4 w-4" />
              ) : (
                <Sun className="h-4 w-4" />
              )}
              <span className="sr-only">Toggle theme</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="min-w-[140px] bg-popover/95 backdrop-blur-lg border-border/50"
          >
            <DropdownMenuItem
              onSelect={() => setTheme("light")}
              className="gap-2.5 text-xs"
            >
              <Sun className="h-3.5 w-3.5" />
              Light
              {theme === "light" && (
                <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setTheme("dark")}
              className="gap-2.5 text-xs"
            >
              <Moon className="h-3.5 w-3.5" />
              Dark
              {theme === "dark" && (
                <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setTheme("system")}
              className="gap-2.5 text-xs"
            >
              <Monitor className="h-3.5 w-3.5" />
              System
              {theme === "system" && (
                <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />
              )}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
