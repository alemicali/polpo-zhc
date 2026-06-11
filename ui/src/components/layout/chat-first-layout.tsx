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
import { useNavigate, useLocation } from "react-router-dom";
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
  Terminal,
  Code2,
  Globe2,
  Sun,
  Moon,
  Monitor,
  Github,
  PanelLeft,
  History,
  ChevronsLeft,
  Menu,
  Plus,
  Palette as PaletteIcon,
  Check,
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { ChatPage } from "@/pages/chat";
import { useChatActions } from "@/hooks/chat-context";
import { useProjectInfo } from "@/hooks/use-polpo";
import { setLayoutMode, useChatFirstSessionsOpen, toggleChatFirstSessions } from "@/hooks/use-layout-mode";
import { useTheme } from "@/hooks/use-theme";
import { usePalette, PALETTES } from "@/lib/palette";
import { cn } from "@/lib/utils";
import { PwaInstallQrButton } from "./pwa-install-qr-button";
import { LogoutButton } from "./logout-button";
import { MobileNavSheet } from "./mobile-nav-sheet";
import { PersistentPageOutlet } from "./persistent-page-outlet";
import { ChatTabs } from "./chat-tabs";

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
  { path: "/coding", icon: Code2, label: "Coding" },
  { path: "/terminal", icon: Terminal, label: "Terminal" },
  { path: "/browser", icon: Globe2, label: "Browser" },
  { path: "/notifications", icon: Bell, label: "Notifications" },
  { path: "/config", icon: Settings2, label: "Configuration" },
];

// ── Left panel header ──

function ChatPanelHeader() {
  const { info } = useProjectInfo();
  const sessionsOpen = useChatFirstSessionsOpen();
  const chatActions = useChatActions();

  return (
    <header className="flex min-h-12 shrink-0 items-center justify-between border-b border-border/50 bg-background/80 px-4 pt-0 backdrop-blur-md max-lg:min-h-safe-head max-lg:pt-safe-head lg:min-h-14">
      <div className="flex min-w-0 items-center gap-1.5">
        {/* Mobile-only hamburger — reuses the global nav sheet. */}
        <div className="lg:hidden -ml-1">
          <MobileNavSheet>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-lg text-foreground hover:bg-accent/50"
              aria-label="Open navigation"
            >
              <Menu className="h-5 w-5" />
            </Button>
          </MobileNavSheet>
        </div>
        <span className="text-lg">🐙</span>
        <div className="min-w-0">
          <h2 className="truncate text-sm font-bold tracking-tight">{info?.project ?? "Polpo"}</h2>
          <p className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground/50 leading-none">
            AI Factory
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
  const { palette, setPalette } = usePalette();

  return (
    <header className="flex min-h-12 shrink-0 items-center gap-2 bg-background/80 px-3 pt-0 backdrop-blur-md max-lg:min-h-safe-head max-lg:pt-safe-head lg:min-h-14">
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
                "inline-flex items-center justify-center rounded-lg shrink-0 transition-colors gap-1.5",
                isActive
                  ? "h-8 px-2.5 text-primary bg-primary/8 hover:bg-primary/10"
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

      {/* Right actions — Phone/GitHub/Theme are desktop-only; mobile uses
          the MobileNavSheet drawer for these. */}
      <div className="flex items-center gap-1 shrink-0">
        <div className="hidden lg:block">
          <PwaInstallQrButton />
        </div>
        <LogoutButton />
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href="https://github.com/alemicali/polpo-zhc"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden lg:inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-all"
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
              className="hidden lg:inline-flex h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-all"
            >
              {resolved === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[220px] bg-popover/95 backdrop-blur-lg border-border/50">
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
  // /coding owns its full pane — no tab strip, no title, no padding
  const fullBleed = pathname === "/coding" || pathname.startsWith("/coding/");

  if (fullBleed) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <PersistentPageOutlet />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PagesPanelHeader />
      {title && (
        <div className="flex items-center px-5 pt-3 pb-1 shrink-0">
          <span className="text-sm font-bold tracking-tight text-foreground truncate">{title}</span>
        </div>
      )}
      <main className="flex-1 flex flex-col min-h-0 min-w-0 overflow-auto p-4 lg:p-5">
        <PersistentPageOutlet />
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
          <ChatTabs />
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
    "/coding": "Coding",
    "/terminal": "Terminal",
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
