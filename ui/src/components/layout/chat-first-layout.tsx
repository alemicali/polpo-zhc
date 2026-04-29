/**
 * ChatFirstLayout — alternative layout where chat is the primary view.
 *
 * Each panel has its own header:
 * - Left: chat header (logo, threads, new session) + ChatPage
 * - Right: tab-style nav bar + page content via React Router Outlet
 *
 * The right panel uses <Outlet /> so detail pages (/tasks/:id, /agents/:name, etc.)
 * work seamlessly. Tab icons call navigate() for top-level sections.
 */

import { memo, useEffect } from "react";
import { Outlet, useNavigate, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  ListChecks,
  Target,
  Bot,
  Brain,
  Sparkles,
  Bell,
  ShieldCheck,
  Workflow,
  Settings2,
  FolderOpen,
  Sun,
  Moon,
  Monitor,
  Github,
  PanelLeft,
  MessageCircle,
  ChevronsLeft,
  Plus,
} from "lucide-react";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
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
import { Button } from "@/components/ui/button";
import { ChatPage } from "@/pages/chat";
import { useChatActions } from "@/hooks/chat-context";
import { useProjectInfo } from "@/hooks/use-polpo";
import { setLayoutMode, useChatFirstSessionsOpen, toggleChatFirstSessions } from "@/hooks/use-layout-mode";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

type TabDef = {
  path: string;
  icon: typeof LayoutDashboard;
  label: string;
};

const tabs: TabDef[] = [
  { path: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { path: "/missions", icon: Target, label: "Missions" },
  { path: "/tasks", icon: ListChecks, label: "Tasks" },
  { path: "/approvals", icon: ShieldCheck, label: "Approvals" },
  { path: "/agents", icon: Bot, label: "Agents" },
  { path: "/skills", icon: Sparkles, label: "Skills" },
  { path: "/memory", icon: Brain, label: "Memory" },
  { path: "/playbooks", icon: Workflow, label: "Playbooks" },
  { path: "/files", icon: FolderOpen, label: "Files" },
  { path: "/notifications", icon: Bell, label: "Notifications" },
  { path: "/config", icon: Settings2, label: "Configuration" },
];

// ── Left panel header ──

function ChatPanelHeader() {
  const { info } = useProjectInfo();
  const sessionsOpen = useChatFirstSessionsOpen();
  const chatActions = useChatActions();

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border/50 bg-background/80 backdrop-blur-md px-4">
      <div className="flex items-center gap-2.5">
        <span className="text-lg">🐙</span>
        <div>
          <h2 className="text-sm font-bold tracking-tight">Polpo</h2>
          <p className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground/50 leading-none">
            {info?.project ?? "Agent Wrangler"}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "h-8 w-8 rounded-lg transition-all",
                sessionsOpen
                  ? "text-primary bg-primary/10 hover:bg-primary/15"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
              )}
              onClick={toggleChatFirstSessions}
            >
              {sessionsOpen ? <ChevronsLeft className="h-4 w-4" /> : <MessageCircle className="h-4 w-4" />}
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
              className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/50"
              onClick={() => chatActions.newSession()}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">New session</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}

// ── Right panel header (tabs + actions) ──

const PagesPanelHeader = memo(function PagesPanelHeader() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { theme, resolved, setTheme } = useTheme();

  return (
    <header className="flex h-14 shrink-0 items-center border-b border-border/50 bg-background/80 backdrop-blur-md px-3 gap-2">
      {/* Tab icons — plain buttons with navigate() */}
      <div className="flex items-center gap-0.5 flex-1 min-w-0">
        {tabs.map(({ path, icon: Icon, label }) => {
          const isActive = pathname === path || pathname.startsWith(path + "/");
          return (
            <button
              key={path}
              title={label}
              onClick={() => navigate(path)}
              className={cn(
                "inline-flex items-center justify-center rounded-lg shrink-0 transition-all gap-1.5",
                isActive
                  ? "h-8 px-2.5 text-primary bg-primary/10 hover:bg-primary/15"
                  : "h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-accent/50",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {isActive && <span className="text-xs font-medium">{label}</span>}
            </button>
          );
        })}
      </div>

      <div className="h-5 w-px bg-border/50 shrink-0" />

      {/* Right actions */}
      <div className="flex items-center gap-1 shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href="https://github.com/alemicali/polpo-zhc"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-all"
            >
              <Github className="h-4 w-4" />
            </a>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">GitHub</TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-all"
            >
              {resolved === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[140px] bg-popover/95 backdrop-blur-lg border-border/50">
            <DropdownMenuItem onSelect={() => setTheme("light")} className="gap-2.5 text-xs">
              <Sun className="h-3.5 w-3.5" /> Light
              {theme === "light" && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setTheme("dark")} className="gap-2.5 text-xs">
              <Moon className="h-3.5 w-3.5" /> Dark
              {theme === "dark" && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setTheme("system")} className="gap-2.5 text-xs">
              <Monitor className="h-3.5 w-3.5" /> System
              {theme === "system" && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-all"
              onClick={() => setLayoutMode("sidebar")}
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">Switch to sidebar layout</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
});

// ── Right panel content ──

function RightPanelContent() {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  // /chat route → redirect to dashboard (chat is in the left panel)
  useEffect(() => {
    if (pathname === "/chat") {
      navigate("/dashboard", { replace: true });
    }
  }, [pathname, navigate]);

  // Resolve a page title from current path
  const title = resolvePageTitle(pathname);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PagesPanelHeader />
      {title && (
        <div className="flex items-center px-5 pt-3 pb-1 shrink-0">
          <span className="text-sm font-bold tracking-tight text-foreground truncate">{title}</span>
        </div>
      )}
      <main className="flex-1 flex flex-col min-h-0 min-w-0 overflow-auto p-4 lg:p-5">
        <Outlet />
      </main>
    </div>
  );
}

// ── Main layout ──

export function ChatFirstLayout() {
  return (
    <ResizablePanelGroup orientation="horizontal" id="chat-first-group">
      {/* Left: Chat */}
      <ResizablePanel defaultSize={40} minSize={20} id="chat-panel">
        <div className="flex flex-col h-full overflow-hidden">
          <ChatPanelHeader />
          <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
            <ChatPage embedded />
          </div>
        </div>
      </ResizablePanel>

      <ResizableHandle />

      {/* Right: Pages via Outlet (supports detail routes) */}
      <ResizablePanel defaultSize={60} minSize={20} id="nav-panel">
        <RightPanelContent />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function resolvePageTitle(pathname: string): string {
  const titles: Record<string, string> = {
    "/dashboard": "Dashboard",
    "/missions": "Missions",
    "/tasks": "Tasks",
    "/agents": "Agents",
    "/skills": "Skills",
    "/memory": "Memory",
    "/notifications": "Notifications",
    "/approvals": "Approvals",
    "/playbooks": "Playbooks",
    "/files": "Files",
    "/config": "Configuration",
  };
  if (titles[pathname]) return titles[pathname];
  if (pathname.startsWith("/missions/")) return "Mission Detail";
  if (pathname.startsWith("/tasks/")) return "Task Detail";
  if (pathname.startsWith("/agents/")) return "Agent Detail";
  if (pathname.startsWith("/skills/")) return "Skill Detail";
  if (pathname.startsWith("/playbooks/")) return "Playbook Detail";
  return "";
}
