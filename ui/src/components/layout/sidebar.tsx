import { useState, useEffect } from "react";
import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  ListChecks,
  Map,
  Bot,
  Activity,
  MessageSquare,
  Brain,
  FileText,
  FolderOpen,
  Columns2,
} from "lucide-react";
import { usePolpo } from "@openpolpo/react-sdk";
import { useProjectInfo } from "@/hooks/use-polpo";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const nav = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Mission Control" },
  { to: "/plans", icon: Map, label: "Plans" },
  { to: "/tasks", icon: ListChecks, label: "Tasks" },
  { to: "/agents", icon: Bot, label: "Agents" },
  { to: "/activity", icon: Activity, label: "Activity" },
  { to: "/chat", icon: MessageSquare, label: "Chat" },
  { to: "/memory", icon: Brain, label: "Memory" },
  { to: "/logs", icon: FileText, label: "Logs" },
] as const;

const statusConfig: Record<string, { color: string; pulse: boolean; label: string }> = {
  connected: {
    color: "bg-emerald-500",
    pulse: true,
    label: "Connected",
  },
  connecting: {
    color: "bg-amber-500",
    pulse: true,
    label: "Connecting...",
  },
  reconnecting: {
    color: "bg-amber-500",
    pulse: true,
    label: "Reconnecting...",
  },
  disconnected: {
    color: "bg-red-500",
    pulse: false,
    label: "Disconnected",
  },
  error: {
    color: "bg-red-500",
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
        "flex h-full flex-col border-r border-border bg-sidebar transition-all duration-200 ease-in-out",
        collapsed ? "w-[52px]" : "w-60"
      )}
    >
      {/* Logo area */}
      <div className="relative flex h-14 items-center border-b border-border group">
        {collapsed ? (
          <div className="flex w-full items-center justify-center">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg text-lg">
              🐙
            </div>
            <button
              onClick={() => setCollapsed(false)}
              className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-sidebar/90 cursor-pointer"
              aria-label="Expand sidebar"
            >
              <Columns2 className="h-4 w-4 text-sidebar-foreground" />
            </button>
          </div>
        ) : (
          <div className="flex w-full items-center justify-between px-4">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg text-lg shrink-0">
                🐙
              </div>
              <div>
                <h1 className="text-sm font-semibold text-sidebar-foreground">Polpo</h1>
                <p className="text-[10px] text-muted-foreground">AI Agent Wrangler</p>
              </div>
            </div>
            <button
              onClick={() => setCollapsed(true)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors cursor-pointer"
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
          "flex-1 flex flex-col gap-1",
          collapsed ? "items-center py-2" : "p-2"
        )}
      >
        {nav.map(({ to, icon: Icon, label }) => {
          const linkClasses = ({ isActive }: { isActive: boolean }) =>
            cn(
              "flex items-center rounded-md transition-colors",
              collapsed
                ? "justify-center h-9 w-9"
                : "gap-3 px-3 py-2 text-sm font-medium",
              isActive
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
            );

          return collapsed ? (
            <Tooltip key={to} delayDuration={0}>
              <TooltipTrigger asChild>
                <NavLink to={to} className={linkClasses}>
                  <Icon className="h-4 w-4" />
                </NavLink>
              </TooltipTrigger>
              <TooltipContent side="right" className="text-xs">
                {label}
              </TooltipContent>
            </Tooltip>
          ) : (
            <NavLink key={to} to={to} className={linkClasses}>
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{label}</span>
            </NavLink>
          );
        })}
      </nav>

      {/* Footer */}
      <div
        className={cn(
          "border-t border-border space-y-2",
          collapsed ? "p-0 py-3 flex flex-col items-center" : "p-3"
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
                    status.pulse && "animate-pulse"
                  )}
                />
              </div>
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              <p>{status.label}</p>
              {info?.workDir && (
                <p className="font-mono text-muted-foreground mt-0.5">{info.workDir}</p>
              )}
            </TooltipContent>
          </Tooltip>
        ) : (
          <>
            {info?.workDir && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground truncate cursor-default">
                    <FolderOpen className="h-3 w-3 shrink-0" />
                    <span className="truncate">{info.workDir}</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs max-w-xs">
                  <p className="font-medium">{info.project}</p>
                  <p className="font-mono text-muted-foreground">{info.workDir}</p>
                </TooltipContent>
              </Tooltip>
            )}
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <div
                className={cn(
                  "h-2 w-2 rounded-full",
                  status.color,
                  status.pulse && "animate-pulse"
                )}
              />
              {status.label}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
