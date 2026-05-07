import { useLocation } from "react-router-dom";
import { Sun, Moon, Monitor, MessageCircle, Github, Columns2, Menu, Palette as PaletteIcon, Check, History, Plus, Trash2, ChevronsLeft } from "lucide-react";
import { useProjectInfo } from "@/hooks/use-polpo";
import { useChatActions, useChatPageSessionsOpen, useChatState, useSidebarOpen, sidebarActions, chatPageSessionActions } from "@/hooks/chat-context";
import { setLayoutMode } from "@/hooks/use-layout-mode";
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useTheme } from "@/hooks/use-theme";
import { usePalette, PALETTES } from "@/lib/palette";
import { PwaInstallQrButton } from "./pwa-install-qr-button";
import { LogoutButton } from "./logout-button";
import { MobileNavSheet } from "./mobile-nav-sheet";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { useAgents } from "@polpo-ai/react";

const titles: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/missions": "Missions",
  "/tasks": "Tasks",
  "/agents": "Agents",
  "/skills": "Skills",
  "/activity": "Activity",
  "/chat": "Chat",
  "/memory": "Memory",
  "/logs": "Logs",
  "/notifications": "Notifications",
  "/approvals": "Approvals",
  "/playbooks": "Playbooks",
  "/files": "Files",
  "/config": "Configuration",
};

function resolveTitle(pathname: string): string {
  if (titles[pathname]) return titles[pathname];
  if (pathname.startsWith("/missions/")) return "Mission Detail";
  if (pathname.startsWith("/tasks/")) return "Task Detail";
  if (pathname.startsWith("/agents/")) return "Agent Detail";
  if (pathname.startsWith("/skills/")) return "Skill Detail";
  return "";
}

function ChatHeaderCenter() {
  const sessionsOpen = useChatPageSessionsOpen();
  const { messages, isLoading, sessionId, sessions, selectedAgent } = useChatState();
  const { newSession, clear } = useChatActions();
  const { agents } = useAgents();
  const sessionAgent = selectedAgent ?? sessions.find((s: { id: string; agent?: string }) => s.id === sessionId)?.agent ?? null;
  const agentConfig = sessionAgent && agents ? agents.find((a) => a.name === sessionAgent) : undefined;
  const agentName = agentConfig?.identity?.displayName ?? agentConfig?.name ?? "Polpo";
  const sessionTitle = sessionId
    ? sessions.find((s: { id: string; title?: string }) => s.id === sessionId)?.title || "Session"
    : "New session";

  return (
    <div className="hidden w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 lg:grid">
      <div className="flex min-w-0 shrink-0 items-center gap-2">
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={sessionsOpen
                  ? "h-8 w-8 rounded-lg bg-primary/10 text-primary hover:bg-primary/15"
                  : "h-8 w-8 rounded-lg text-muted-foreground hover:bg-accent/50 hover:text-foreground"}
                onClick={chatPageSessionActions.toggle}
                aria-label={sessionsOpen ? "Hide threads" : "Show threads"}
              >
                {sessionsOpen ? <ChevronsLeft className="h-4 w-4" /> : <History className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {sessionsOpen ? "Hide threads" : "Threads"}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-lg text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                onClick={newSession}
                aria-label="New session"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">New session</TooltipContent>
          </Tooltip>
        </div>

        <div className="flex min-w-0 max-w-44 items-center gap-1.5 rounded-full bg-muted/45 px-2 py-1">
          {agentConfig ? (
            <AgentAvatar
              avatar={agentConfig.identity?.avatar}
              name={agentName}
              size="xs"
            />
          ) : (
            <span className="shrink-0 text-sm leading-none">🐙</span>
          )}
          <span className="truncate text-xs font-semibold text-foreground">{agentName}</span>
        </div>
      </div>

      <div className="min-w-0 text-center">
        <div className="truncate text-sm font-semibold leading-5 text-foreground" title={sessionTitle}>
          {sessionTitle}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-1">
        {messages.length > 0 && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium leading-4 text-muted-foreground">
            {messages.length}
          </span>
        )}
        {!isLoading && messages.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                onClick={clear}
                aria-label="Clear session"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">Clear session</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

/**
 * Header — used only in sidebar layout mode.
 * In chat-first mode, each panel has its own header (see ChatFirstLayout).
 */
export function Header() {
  const { pathname } = useLocation();
  const title = resolveTitle(pathname);
  const { theme, resolved, setTheme } = useTheme();
  const { palette, setPalette } = usePalette();
  const { info } = useProjectInfo();
  const sidebarOpen = useSidebarOpen();
  const isOnChatPage = pathname === "/chat";

  return (
    <header className="relative flex min-h-12 shrink-0 items-center justify-between border-b border-border/50 bg-background/80 px-4 pt-0 backdrop-blur-md max-lg:min-h-safe-head max-lg:pt-safe-head sm:px-5 lg:min-h-14 lg:px-8">
      {/* Mobile: hamburger + logo + title */}
      <div className="flex min-w-0 items-center gap-1.5 lg:hidden">
        <MobileNavSheet>
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-lg text-foreground hover:bg-accent/50 -ml-1"
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </Button>
        </MobileNavSheet>
        <span className="text-lg">🐙</span>
        <span className="truncate text-sm font-bold tracking-tight">{title}</span>
      </div>

      {/* Desktop: page title */}
      <div className="hidden lg:flex items-center gap-3">
        <h2 className="text-lg font-bold tracking-tight">{title}</h2>
        <div className="h-4 w-px bg-border/60" />
        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/60">
          {info?.project ?? "Polpo"}
        </span>
      </div>

      {isOnChatPage && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 w-[min(72rem,72vw)] -translate-x-1/2 -translate-y-1/2">
          <div className="pointer-events-auto flex justify-center">
            <ChatHeaderCenter />
          </div>
        </div>
      )}

      {/* Actions — Phone (PWA install QR), GitHub and Theme are desktop-only.
          On mobile they live inside the MobileNavSheet drawer. */}
      <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
        <div className="hidden lg:block">
          <PwaInstallQrButton />
        </div>
        <LogoutButton />
        {/* GitHub — desktop only */}
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href="https://github.com/alemicali/polpo-zhc"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden lg:inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-all"
            >
              <Github className="h-4 w-4" />
              <span className="sr-only">GitHub</span>
            </a>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">GitHub</TooltipContent>
        </Tooltip>
        {/* Theme toggle — desktop only */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="hidden lg:inline-flex h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-all"
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
            className="min-w-[220px] bg-popover/95 backdrop-blur-lg border-border/50"
          >
            <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              Mode
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setTheme("light")} className="gap-2.5 text-xs">
              <Sun className="h-3.5 w-3.5" /> Light
              {theme === "light" && <Check className="ml-auto h-3 w-3 text-primary" />}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setTheme("dark")} className="gap-2.5 text-xs">
              <Moon className="h-3.5 w-3.5" /> Dark
              {theme === "dark" && <Check className="ml-auto h-3 w-3 text-primary" />}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setTheme("system")} className="gap-2.5 text-xs">
              <Monitor className="h-3.5 w-3.5" /> System
              {theme === "system" && <Check className="ml-auto h-3 w-3 text-primary" />}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 flex items-center gap-1.5">
              <PaletteIcon className="h-3 w-3" /> Palette
            </DropdownMenuLabel>
            {PALETTES.map((p) => {
              const swatch = resolved === "dark" ? p.swatchDark : p.swatchLight;
              return (
                <DropdownMenuItem
                  key={p.id}
                  onSelect={() => setPalette(p.id)}
                  className="gap-2.5 text-xs py-1.5"
                >
                  {/* Three-stop swatch — bg, primary, accent — overlapping discs */}
                  <span className="relative inline-flex shrink-0 h-4 w-4 items-center justify-center">
                    <span className="absolute inset-0 rounded-full ring-1 ring-border/60" style={{ backgroundColor: swatch[0] }} />
                    <span className="absolute h-3 w-3 rounded-full" style={{ backgroundColor: swatch[1], left: "30%", top: "10%" }} />
                    <span className="absolute h-2 w-2 rounded-full" style={{ backgroundColor: swatch[2], left: "55%", top: "50%" }} />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block leading-tight">{p.name}</span>
                    <span className="block text-[10px] text-muted-foreground/70 leading-tight">{p.blurb}</span>
                  </span>
                  {palette === p.id && <Check className="h-3 w-3 text-primary shrink-0" />}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Layout mode toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="hidden lg:inline-flex h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-all"
              onClick={() => setLayoutMode("chat-first")}
            >
              <Columns2 className="h-4 w-4" />
              <span className="sr-only">Switch to chat-first layout</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            Switch to chat-first layout
          </TooltipContent>
        </Tooltip>
        {/* Chat sidebar toggle — hidden on /chat page and on mobile */}
        {!isOnChatPage && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={`hidden lg:inline-flex h-8 w-8 rounded-lg transition-all ${sidebarOpen ? "text-primary bg-primary/10 hover:bg-primary/15" : "text-muted-foreground hover:text-foreground hover:bg-accent/50"}`}
                onClick={sidebarActions.toggleSidebar}
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
      </div>
    </header>
  );
}
