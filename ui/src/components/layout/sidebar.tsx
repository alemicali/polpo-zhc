import { useState, useEffect } from "react";
import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  ListChecks,
  Map,
  Bot,
  MessageCircle,
  Brain,
  Columns2,
  Bell,
  ShieldCheck,
  Workflow,
  Settings2,
} from "lucide-react";
import { usePolpo } from "@lumea-labs/polpo-react";
import { useProjectInfo } from "@/hooks/use-polpo";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const nav = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Mission Control" },
  { to: "/chat", icon: MessageCircle, label: "Chat" },
  { to: "/plans", icon: Map, label: "Plans" },
  { to: "/tasks", icon: ListChecks, label: "Tasks" },
  { to: "/agents", icon: Bot, label: "Agents" },
  { to: "/memory", icon: Brain, label: "Memory" },
  { to: "/templates", icon: Workflow, label: "Templates" },
  { to: "/notifications", icon: Bell, label: "Notifications" },
  { to: "/approvals", icon: ShieldCheck, label: "Approvals" },
  { to: "/config", icon: Settings2, label: "Configuration" },
] as const;

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
          "flex-1 flex flex-col gap-0.5",
          collapsed ? "items-center py-3" : "p-3"
        )}
      >
        {nav.map(({ to, icon: Icon, label }) => {
          const linkClasses = ({ isActive }: { isActive: boolean }) =>
            cn(
              "flex items-center rounded-lg transition-all duration-200 group/link relative",
              collapsed
                ? "justify-center h-10 w-10"
                : "gap-3 px-3 py-2.5 text-[13px] font-medium",
              isActive
                ? "bg-accent text-accent-foreground shadow-sm"
                : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"
            );

          return collapsed ? (
            <Tooltip key={to} delayDuration={0}>
              <TooltipTrigger asChild>
                <NavLink to={to} className={linkClasses}>
                  {({ isActive }) => (
                    <>
                      <Icon className="h-[18px] w-[18px]" />
                      {isActive && (
                        <span className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-[2px] h-5 w-1 rounded-r-full bg-primary" />
                      )}
                    </>
                  )}
                </NavLink>
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
                </>
              )}
            </NavLink>
          );
        })}
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
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
