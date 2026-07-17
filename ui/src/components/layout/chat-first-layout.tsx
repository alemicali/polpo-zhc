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

import { memo, useEffect, useState } from "react";
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
  AppWindow,
  MousePointerClick,
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
  ChevronDown,
  Layers3,
  MoreHorizontal,
  Rows3,
  SlidersHorizontal,
  CalendarClock,
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
import {
  setChatFirstNavMode,
  setLayoutMode,
  toggleChatFirstSessions,
  useChatFirstNavMode,
  useChatFirstSessionsOpen,
  type ChatFirstNavMode,
} from "@/hooks/use-layout-mode";
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

type TabGroup = {
  label: string;
  icon: typeof LayoutDashboard;
  tabs: TabDef[];
};

const pinnedTabs: TabDef[] = [
  { path: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { path: "/missions", icon: Target, label: "Missions" },
  { path: "/tasks", icon: ListChecks, label: "Tasks" },
  { path: "/agents", icon: Bot, label: "Agents" },
  { path: "/files", icon: FolderOpen, label: "Files" },
  { path: "/coding", icon: Code2, label: "Coding" },
  { path: "/browser", icon: AppWindow, label: "App Preview" },
  { path: "/agent-live", icon: MousePointerClick, label: "Browser Automation" },
];

const secondaryGroups: TabGroup[] = [
  {
    label: "Operations",
    icon: ShieldCheck,
    tabs: [
      { path: "/approvals", icon: ShieldCheck, label: "Approvals" },
      { path: "/notifications", icon: Bell, label: "Notifications" },
      { path: "/schedules", icon: CalendarClock, label: "Schedules" },
    ],
  },
  {
    label: "Knowledge",
    icon: Brain,
    tabs: [
      { path: "/skills", icon: Sparkles, label: "Skills" },
      { path: "/memory", icon: Brain, label: "Memory" },
      { path: "/playbooks", icon: Workflow, label: "Playbooks" },
    ],
  },
  {
    label: "Tools",
    icon: Code2,
    tabs: [
      { path: "/terminal", icon: Terminal, label: "Terminal" },
    ],
  },
  {
    label: "System",
    icon: Settings2,
    tabs: [
      { path: "/config", icon: Settings2, label: "Configuration" },
    ],
  },
];

const secondaryTabs = secondaryGroups.flatMap(group => group.tabs);
const defaultMorePath = secondaryTabs[0]?.path ?? "/approvals";
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
  { path: "/browser", icon: AppWindow, label: "App Preview" },
  { path: "/agent-live", icon: MousePointerClick, label: "Browser Automation" },
  { path: "/notifications", icon: Bell, label: "Notifications" },
  { path: "/schedules", icon: CalendarClock, label: "Schedules" },
  { path: "/config", icon: Settings2, label: "Configuration" },
];

function isTabActive(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(path + "/");
}

function isSecondaryPath(pathname: string): boolean {
  return secondaryTabs.some(tab => isTabActive(pathname, tab.path));
}

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

function HeaderTabButton({ tab, active, onSelect }: {
  tab: TabDef;
  active: boolean;
  onSelect: () => void;
}) {
  const Icon = tab.icon;
  return (
    <button
      title={tab.label}
      aria-current={active ? "page" : undefined}
      onClick={onSelect}
      className={cn(
        "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg transition-colors",
        active
          ? "px-2.5 text-primary bg-primary/8 hover:bg-primary/10"
          : "w-8 text-muted-foreground hover:text-foreground hover:bg-accent/50",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {active && <span className="text-xs font-medium">{tab.label}</span>}
    </button>
  );
}

function GroupedHeaderNavigation({ pathname, navigate }: {
  pathname: string;
  navigate: ReturnType<typeof useNavigate>;
}) {
  return (
    <>
      {pinnedTabs.map(tab => (
        <HeaderTabButton
          key={tab.path}
          tab={tab}
          active={isTabActive(pathname, tab.path)}
          onSelect={() => navigate(tab.path)}
        />
      ))}
      <span className="mx-1 h-4 w-px shrink-0 bg-border/50" />
      {secondaryGroups.map(group => {
        const activeTab = group.tabs.find(tab => isTabActive(pathname, tab.path));
        const GroupIcon = group.icon;
        return (
          <DropdownMenu key={group.label}>
            <DropdownMenuTrigger asChild>
              <button
                title={group.label}
                className={cn(
                  "inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-lg transition-colors",
                  activeTab
                    ? "px-2 text-primary bg-primary/8 hover:bg-primary/10"
                    : "w-8 text-muted-foreground hover:text-foreground hover:bg-accent/50",
                )}
              >
                <GroupIcon className="h-4 w-4 shrink-0" />
                {activeTab && <span className="text-xs font-medium">{group.label}</span>}
                {activeTab && <ChevronDown className="h-3 w-3 opacity-60" />}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-44">
              <DropdownMenuLabel className="text-[10px] font-semibold uppercase text-muted-foreground/70">
                {group.label}
              </DropdownMenuLabel>
              {group.tabs.map(tab => {
                const Icon = tab.icon;
                const active = isTabActive(pathname, tab.path);
                return (
                  <DropdownMenuItem key={tab.path} onSelect={() => navigate(tab.path)} className="text-xs">
                    <Icon className="h-3.5 w-3.5" />
                    {tab.label}
                    {active && <Check className="ml-auto h-3.5 w-3.5 text-primary" />}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      })}
    </>
  );
}

const navModeOptions: Array<{
  value: ChatFirstNavMode;
  label: string;
  description: string;
  icon: typeof Rows3;
}> = [
  { value: "more", label: "Pinned + More", description: "Core pages on top, the rest in a vertical rail", icon: MoreHorizontal },
  { value: "grouped", label: "Grouped", description: "Core pages plus compact section menus", icon: Layers3 },
  { value: "inline", label: "All inline", description: "Show every page in the top navigation", icon: Rows3 },
];

function NavigationModeMenu({ mode }: { mode: ChatFirstNavMode }) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="hidden lg:inline-flex h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/50"
              aria-label="Page navigation layout"
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">Page navigation</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-[10px] font-semibold uppercase text-muted-foreground/70">
          Chat-first navigation
        </DropdownMenuLabel>
        {navModeOptions.map(option => {
          const Icon = option.icon;
          return (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => setChatFirstNavMode(option.value)}
              className="items-start gap-2.5 py-2"
            >
              <Icon className="mt-0.5 h-4 w-4" />
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium leading-tight">{option.label}</span>
                <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">{option.description}</span>
              </span>
              {mode === option.value && <Check className="mt-0.5 h-3.5 w-3.5 text-primary" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const PagesPanelHeader = memo(function PagesPanelHeader() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { theme, resolved, setTheme } = useTheme();
  const { palette, setPalette } = usePalette();
  const navMode = useChatFirstNavMode();

  return (
    <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border bg-background/80 px-3 pt-0 backdrop-blur-md max-lg:min-h-safe-head max-lg:pt-safe-head lg:min-h-14">
      <div className="flex flex-1 min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {navMode === "inline" && tabs.map(tab => (
          <HeaderTabButton
            key={tab.path}
            tab={tab}
            active={isTabActive(pathname, tab.path)}
            onSelect={() => navigate(tab.path)}
          />
        ))}
        {navMode === "grouped" && (
          <GroupedHeaderNavigation pathname={pathname} navigate={navigate} />
        )}
        {navMode === "more" && (
          <>
            {pinnedTabs.map(tab => (
              <HeaderTabButton
                key={tab.path}
                tab={tab}
                active={isTabActive(pathname, tab.path)}
                onSelect={() => navigate(tab.path)}
              />
            ))}
            <HeaderTabButton
              tab={{ path: defaultMorePath, icon: MoreHorizontal, label: "More" }}
              active={isSecondaryPath(pathname)}
              onSelect={() => navigate(isSecondaryPath(pathname) ? pathname : defaultMorePath)}
            />
          </>
        )}
      </div>

      <div className="h-5 w-px bg-border/50 shrink-0" />

      {/* Right actions — Phone/GitHub/Theme are desktop-only; mobile uses
          the MobileNavSheet drawer for these. */}
      <div className="flex items-center gap-1 shrink-0">
        <NavigationModeMenu mode={navMode} />
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

function MoreNavigation({ pathname }: { pathname: string }) {
  const navigate = useNavigate();

  return (
    <aside className="flex w-14 shrink-0 flex-col overflow-y-auto border-r border-border/50 bg-muted/10 px-1.5 py-3 lg:w-44 lg:px-2.5">
      <div className="mb-3 hidden items-center gap-2 px-2 lg:flex">
        <MoreHorizontal className="h-4 w-4 text-primary" />
        <span className="text-xs font-semibold">More</span>
      </div>
      <nav className="space-y-3" aria-label="More pages">
        {secondaryGroups.map(group => (
          <div key={group.label}>
            <p className="mb-1 hidden px-2 text-[9px] font-semibold uppercase text-muted-foreground/55 lg:block">
              {group.label}
            </p>
            <div className="space-y-0.5">
              {group.tabs.map(tab => {
                const Icon = tab.icon;
                const active = isTabActive(pathname, tab.path);
                return (
                  <button
                    key={tab.path}
                    title={tab.label}
                    aria-current={active ? "page" : undefined}
                    onClick={() => navigate(tab.path)}
                    className={cn(
                      "flex h-9 w-full items-center justify-center gap-2 rounded-md transition-colors lg:justify-start lg:px-2",
                      active
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="hidden truncate text-xs font-medium lg:block">{tab.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
    </aside>
  );
}

function RightPanelContent() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const navMode = useChatFirstNavMode();

  // /chat route → redirect to dashboard (chat is in the left panel)
  useEffect(() => {
    if (pathname === "/chat") {
      navigate("/dashboard", { replace: true });
    }
  }, [pathname, navigate]);

  // Resolve a page title from current path
  const title = resolvePageTitle(pathname);
  // Tool surfaces keep the platform tab strip but meet its edges so their
  // dense, resizable work areas get every available pixel.
  const fullBleed = pathname === "/coding" || pathname.startsWith("/coding/") || pathname === "/browser";
  const showMoreNavigation = navMode === "more" && isSecondaryPath(pathname);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PagesPanelHeader />
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {showMoreNavigation && (
          <div className="max-lg:hidden">
            <MoreNavigation pathname={pathname} />
          </div>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {!fullBleed && title && (
            <div className="flex shrink-0 items-center px-5 pb-1 pt-3">
              <span className="truncate text-sm font-bold text-foreground">{title}</span>
            </div>
          )}
          <main className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col overflow-auto",
            fullBleed ? "p-0" : "p-4 lg:p-5",
          )}>
            <PersistentPageOutlet />
          </main>
        </div>
      </div>
    </div>
  );
}

// ── Main layout ──

export function ChatFirstLayout() {
  const { pathname } = useLocation();
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 1023px)").matches);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const update = () => setMobile(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  if (mobile) {
    if (pathname === "/chat") {
      return (
        <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
          <ChatPanelHeader />
          <ChatTabs />
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <ChatPage embedded />
          </div>
        </div>
      );
    }
    return <RightPanelContent />;
  }

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
    "/schedules": "Schedules",
    "/approvals": "Approvals",
    "/playbooks": "Playbooks",
    "/files": "Files",
    "/coding": "Coding",
    "/terminal": "Terminal",
    "/browser": "App Preview",
    "/agent-live": "Browser Automation",
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
