import { useLocation } from "react-router-dom";
import { MessageCircle, Columns2, Menu, History, Trash2, ChevronsLeft, UsersRound } from "lucide-react";
import { useProjectInfo } from "@/hooks/use-polpo";
import { useChatActions, useChatPageSessionsOpen, useChatState, useSidebarOpen, sidebarActions, chatPageSessionActions } from "@/hooks/chat-context";
import { setLayoutMode } from "@/hooks/use-layout-mode";
import { useSidebarStyle } from "@/hooks/use-sidebar-style";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { HeaderMoreMenu, ThemeMenu } from "./header-actions";
import { BetaBadge } from "@/components/shared/beta-badge";
import { isBetaPath } from "@/lib/beta";
import { MobileNavSheet } from "./mobile-nav-sheet";
import { MobileSearchButton } from "@/components/search/sidebar-search-button";
import { ChatTabs } from "./chat-tabs";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { AgentModelWithEngine, EngineMark } from "@/components/shared/model-with-engine";
import { useAgents } from "@polpo-ai/react";
import { BrandMark } from "@/components/shared/brand-mark";
import { resolveTitle } from "@/lib/page-titles";
import { NewChatMenu } from "@/components/groups/new-chat-menu";
import { useOrchestratorName } from "@/lib/orchestrator-name";
import { requestNewGroup, setActiveChatRoom, useActiveChatRoom, useActiveChatRoomTitle } from "@/hooks/use-chat-room";

function ChatHeaderCenter() {
  const sessionsOpen = useChatPageSessionsOpen();
  // the drill-in sidebar's Chat level shows the threads (the toggle has nothing to show)
  const historyInSidebar = useSidebarStyle() === "drill-in";
  const { messages, isLoading, sessionId, sessions, selectedAgent } = useChatState();
  const { newSession, clear } = useChatActions();
  const { agents } = useAgents();
  const sessionAgent = selectedAgent ?? sessions.find((s: { id: string; agent?: string }) => s.id === sessionId)?.agent ?? null;
  const agentConfig = sessionAgent && agents ? agents.find((a) => a.name === sessionAgent) : undefined;
  const orchestratorName = useOrchestratorName();
  const agentName = agentConfig?.identity?.displayName ?? agentConfig?.name ?? orchestratorName;
  const sessionTitle = sessionId
    ? sessions.find((s: { id: string; title?: string }) => s.id === sessionId)?.title || "Session"
    : "New session";
  // A group open in the chat replaces the session in the header.
  const roomId = useActiveChatRoom();
  const roomTitle = useActiveChatRoomTitle();
  const inGroup = roomId !== null;
  const centerTitle = inGroup ? roomTitle || "Group" : sessionTitle;

  return (
    <div className="hidden w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 lg:grid">
      <div className="flex min-w-0 shrink-0 items-center gap-2">
        <div className="flex shrink-0 items-center gap-1">
          {!historyInSidebar && (
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
          )}
          <NewChatMenu
            className="h-8 w-8 rounded-lg hover:bg-accent/50"
            onNewChat={() => {
              setActiveChatRoom(null);
              newSession();
            }}
            onNewGroup={() => requestNewGroup(sessionAgent ?? undefined)}
          />
        </div>

        <div className="flex min-w-0 max-w-80 items-center gap-1.5 rounded-pill bg-muted/45 px-2 py-1">
          {inGroup ? (
            <UsersRound className="h-3.5 w-3.5 shrink-0 text-primary" />
          ) : agentConfig ? (
            <AgentAvatar
              avatar={agentConfig.identity?.avatar}
              name={agentName}
              size="xs"
            />
          ) : (
            <span className="shrink-0 text-sm leading-none">🐙</span>
          )}
          <span className="truncate text-xs font-semibold text-foreground">{inGroup ? "Group chat" : agentName}</span>
          {!inGroup && (agentConfig
            ? <AgentModelWithEngine agent={agentConfig} compact size={12} className="text-micro text-muted-foreground" testId="header-chat-model" />
            : <EngineMark engine="polpo" compact size={12} />)}
        </div>
      </div>

      <div className="min-w-0 text-center">
        <div className="truncate text-sm font-semibold leading-5 text-foreground" title={centerTitle}>
          {centerTitle}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-1">
        {!inGroup && messages.length > 0 && (
          <span className="rounded-pill bg-muted px-2 py-0.5 text-micro font-medium leading-4 text-muted-foreground">
            {messages.length}
          </span>
        )}
        {!inGroup && !isLoading && messages.length > 0 && (
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
  const { info } = useProjectInfo();
  const sidebarOpen = useSidebarOpen();
  const isOnChatPage = pathname === "/chat";

  return (
    <>
    <header className="relative flex min-h-12 shrink-0 items-center justify-between border-b border-border/50 bg-background/80 px-4 pt-0 backdrop-blur-surface max-lg:min-h-safe-head max-lg:pt-safe-head sm:px-5 lg:min-h-14 lg:px-8">
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
        <BrandMark className="h-7 w-7 rounded-md text-sm" />
        <span className="truncate text-sm font-bold tracking-tight">{title}</span>
        {isBetaPath(pathname) && <BetaBadge />}
      </div>

      {/* Desktop: page title */}
      <div className="hidden shrink-0 lg:flex items-center gap-3">
        <h2 className="font-heading text-h2">{title}</h2>
        {isBetaPath(pathname) && <BetaBadge />}
        <div className="h-4 w-px bg-border/60" />
        <span className="text-micro font-mono uppercase tracking-widest text-muted-foreground/60">
          {info?.project ?? "Polpo"}
        </span>
      </div>

      {/* Chat controls sit in the flow between the title and the actions, so
          they never overlap the title / project badge. Desktop only. */}
      {isOnChatPage && (
        <div className="hidden min-w-0 flex-1 justify-center px-4 lg:flex xl:px-6">
          <div className="w-full max-w-6xl">
            <ChatHeaderCenter />
          </div>
        </div>
      )}

      {/* Actions — the look and ⋯ (Install app, Ink Hub, GitHub, sidebar style, Log out). What's new
          lives at the bottom of the sidebar (and of the MobileNavSheet drawer); the look is
          desktop-only: on mobile it lives in the drawer. */}
      <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
        <MobileSearchButton className="lg:hidden" />
        <ThemeMenu className="hidden lg:inline-flex" />
        <HeaderMoreMenu />
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
    {isOnChatPage && <ChatTabs />}
    </>
  );
}
