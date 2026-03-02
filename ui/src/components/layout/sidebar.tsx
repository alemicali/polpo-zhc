import { useState, useEffect, useCallback, memo } from "react";
import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  ListChecks,
  Target,
  Bot,
  MessageCircle,
  Brain,
  Sparkles,
  Columns2,
  Bell,
  ShieldCheck,
  Workflow,
  Settings2,
  FolderOpen,
} from "lucide-react";
import { usePolpo } from "@lumea-labs/polpo-react";
import { useProjectInfo } from "@/hooks/use-polpo";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type NavItem = { to: string; icon: typeof LayoutDashboard; label: string };
type NavSection = { section: string; items: NavItem[] };

const nav: NavSection[] = [
  {
    section: "Overview",
    items: [
      { to: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
      { to: "/chat", icon: MessageCircle, label: "Chat" },
    ],
  },
  {
    section: "Work",
    items: [
      { to: "/missions", icon: Target, label: "Missions" },
      { to: "/tasks", icon: ListChecks, label: "Tasks" },
      { to: "/approvals", icon: ShieldCheck, label: "Approvals" },
    ],
  },
  {
    section: "Knowledge",
    items: [
      { to: "/agents", icon: Bot, label: "Agents" },
      { to: "/skills", icon: Sparkles, label: "Skills" },
      { to: "/memory", icon: Brain, label: "Memory" },
      { to: "/templates", icon: Workflow, label: "Templates" },
    ],
  },
  {
    section: "System",
    items: [
      { to: "/files", icon: FolderOpen, label: "Files" },
      { to: "/notifications", icon: Bell, label: "Notifications" },
      { to: "/config", icon: Settings2, label: "Configuration" },
    ],
  },
];

const statusConfig: Record<string, { color: string; pulse: boolean; label: string }> = {
  connected: {
    color: "bg-teal-400",
    pulse: true,
    label: "Connected",
  },
  connecting: {
    color: "bg-amber-400",
    pulse: true,
    label: "Connecting...",
  },
  reconnecting: {
    color: "bg-amber-400",
    pulse: true,
    label: "Reconnecting...",
  },
  disconnected: {
    color: "bg-rose-500",
    pulse: false,
    label: "Disconnected",
  },
  error: {
    color: "bg-rose-500",
    pulse: false,
    label: "Error",
  },
};

const STORAGE_KEY = "polpo-sidebar-collapsed";

/** Lightweight pending-approval counter — fetches directly from client to avoid
 *  the useApprovals → useEvents → useSyncExternalStore re-render loop. */
const POLL_INTERVAL = 15_000;

const PendingBadge = memo(function PendingBadge({ collapsed }: { collapsed: boolean }) {
  const { client, connectionStatus } = usePolpo();
  const [count, setCount] = useState(0);

  const fetchCount = useCallback(() => {
    if (!client) return;
    client.getApprovals("pending")
      .then((list: unknown[]) => setCount(list.length))
      .catch(() => {});
  }, [client]);

  useEffect(() => {
    if (connectionStatus !== "connected") return;
    fetchCount();
    const id = setInterval(fetchCount, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [connectionStatus, fetchCount]);

  if (count === 0) return null;

  return collapsed ? (
    <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 text-[9px] font-bold text-white px-1">
      {count}
    </span>
  ) : (
    <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold text-white px-1.5">
      {count}
    </span>
  );
});

export function Sidebar() {
  const { connectionStatus } = usePolpo();
  const { info } = useProjectInfo();
  const status = statusConfig[connectionStatus];

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(collapsed));
    } catch {
      // silent
    }
  }, [collapsed]);

  return (
    <aside
      className={cn(
        "relative flex h-full flex-col border-r border-border/40 bg-muted/50 transition-all duration-300 ease-out",
        collapsed ? "w-[56px]" : "w-64"
      )}
    >
      {/* Logo area */}
      <div className="relative flex h-14 items-center border-b border-border/40 group">
        {collapsed ? (
          <div className="flex w-full items-center justify-center">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-lg">
              🐙
            </div>
            <button
              onClick={() => setCollapsed(false)}
              className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-muted/90 backdrop-blur-sm cursor-pointer"
              aria-label="Expand sidebar"
            >
              <Columns2 className="h-4 w-4 text-foreground" />
            </button>
          </div>
        ) : (
          <div className="flex w-full items-center justify-between px-5">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-lg shrink-0">
                🐙
              </div>
              <div>
                <h1 className="text-sm font-bold tracking-tight text-foreground">Polpo</h1>
                <p className="text-[10px] tracking-wide uppercase text-muted-foreground/70">Agent Wrangler</p>
              </div>
            </div>
            <button
              onClick={() => setCollapsed(true)}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-all cursor-pointer"
              aria-label="Collapse sidebar"
            >
              <Columns2 className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav
        className={cn(
          "flex-1 flex flex-col",
          collapsed ? "items-center py-3 gap-1" : "p-3 gap-1"
        )}
      >
        {nav.map(({ section, items }, sectionIdx) => (
          <div key={section} className={cn(sectionIdx > 0 && (collapsed ? "mt-2" : "mt-3"))}>
            {collapsed ? (
              <div className="mx-auto mb-1 h-px w-5 bg-border/60" />
            ) : (
              <div className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                {section}
              </div>
            )}
            <div className={cn("flex flex-col gap-0.5", collapsed && "items-center")}>
              {items.map(({ to, icon: Icon, label }) => {
                const linkClasses = ({ isActive }: { isActive: boolean }) =>
                  cn(
                    "flex items-center rounded-lg transition-all duration-200 group/link relative",
                    collapsed
                      ? "justify-center h-10 w-10"
                      : "gap-3 px-3 py-2.5 text-[13px] font-medium",
                    isActive
                      ? "bg-primary/10 text-primary shadow-sm ring-1 ring-primary/20"
                      : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                  );

                return collapsed ? (
                  <Tooltip key={to} delayDuration={0}>
                    <TooltipTrigger asChild>
                      <div>
                        <NavLink to={to} className={linkClasses}>
                          {({ isActive }) => (
                            <>
                              {isActive && (
                                <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-1 rounded-r-full bg-primary" />
                              )}
                              <Icon className="h-[18px] w-[18px]" />
                              {to === "/approvals" && <PendingBadge collapsed />}
                            </>
                          )}
                        </NavLink>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="text-xs font-medium">
                      {label}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <NavLink key={to} to={to} className={linkClasses}>
                    {({ isActive }) => (
                      <>
                        {isActive && (
                          <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-1 rounded-r-full bg-primary" />
                        )}
                        <Icon className="h-[18px] w-[18px] shrink-0" />
                        <span className="truncate">{label}</span>
                        {to === "/approvals" && <PendingBadge collapsed={false} />}
                      </>
                    )}
                  </NavLink>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer — connection + project */}
      <div
        className={cn(
          "border-t border-border/40 space-y-2",
          collapsed ? "p-0 py-3 flex flex-col items-center" : "px-4 py-3"
        )}
      >
        {collapsed ? (
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <div className="flex items-center justify-center">
                <div
                  className={cn(
                    "h-2.5 w-2.5 rounded-full",
                    status.color,
                    status.pulse && "bio-pulse"
                  )}
                />
              </div>
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              <p className="font-medium">{status.label}</p>
              {info?.project && (
                <p className="text-muted-foreground mt-0.5">{info.project}</p>
              )}
              {info?.version && (
                <p className="text-muted-foreground/60 mt-0.5 font-mono">v{info.version}</p>
              )}
            </TooltipContent>
          </Tooltip>
        ) : (
          <>
            {info?.project && (
              <div className="text-[10px] text-muted-foreground/60 truncate font-mono tracking-wider uppercase">
                {info.project}
              </div>
            )}
            <div className="flex items-center gap-2.5 text-xs text-muted-foreground">
              <div
                className={cn(
                  "h-2 w-2 rounded-full",
                  status.color,
                  status.pulse && "bio-pulse"
                )}
              />
              <span className="font-medium">{status.label}</span>
              {info?.version && (
                <span className="ml-auto text-[10px] font-mono text-muted-foreground/50">
                  v{info.version}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
